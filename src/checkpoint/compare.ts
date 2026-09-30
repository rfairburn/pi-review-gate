/**
 * #233: live worktree comparison against an armed checkpoint (extracted from
 * git-checkpoint.ts). Read-only object-space diff of the current state
 * against the armed baseline, with lazy changed-content materialization and
 * exact untracked deltas.
 */

import { type Stats } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";

import { GitCheckpointError, fsCodeOf, messageOf, resultFromError, throwIfAborted, truncateDetail, type GitCheckpointResult } from "./errors";
import { decodeGitCheckpointRecord, isSafeRelativePath, sameStatIdentity, statIdentityOf, windowIdFromRef, type GitCheckpointRecord, type GitCheckpointUntrackedEntry } from "./record";
import { DEFAULT_MAX_UNTRACKED_BYTES, DEFAULT_TIMEOUT_MS, type GitRunSpec } from "./run-git";
import { assertAuditProofStable, auditRepository, resolveRepo, runAfterInitialAuditHook } from "./audit";
import { verifyGitCheckpointPin, verifyPinGeneration } from "./pin";
import { captureUntrackedEntry, listUntrackedPaths, snapshotLiveIndexTree, untrackedCaptureError } from "./capture";
import { buildArmedTrees, diffTreePaths, lsTreeMap, worktreeDeltaPaths } from "./trees";
import { MAX_BLOB_BYTES, catFileBlob, cleanTrackedComparisonBytes, readWorktreeFile } from "./content";
import type { GitCheckpointComparisonReport, GitCheckpointOptions, GitCheckpointTrackedChange, GitCheckpointUntrackedChange, GitCheckpointUntrackedState } from "./types";

// ── Compare (lazy changed-content materialization) ───────────────────────────

/**
 * Diff the current repository state against the armed baseline without
 * mutating anything. Tracked changes are computed in object space; blob
 * contents are materialized only for paths that actually changed, and only
 * when `includeContents` is requested. New-side changed regular-file bytes
 * pass through Git's clean pipeline in disposable scratch so review content
 * follows the normalized old-side blobs; unchanged tracked paths are not read.
 * Every tracked change also carries
 * armed/current kind and mode, so a mode-only change or a symlink retarget
 * stays reviewable even when the bytes are equal (symlink content is its
 * exact target, read no-follow). Untracked deltas are reported by path
 * (modified = stat identity drift from the captured entry) AND as typed
 * `untrackedChanges` with exact old/new bytes or symlink targets: new-side
 * content is captured no-follow with pre/post stat identity, only for paths
 * that actually changed, only with includeContents, and bounded by
 * maxUntrackedBytes; the old side reuses the bytes already captured at arm
 * time. Ignored untracked paths stay excluded (the ordinary baseline never
 * includes them); tracked-but-ignored paths remain tracked changes.
 * The pin must also be owned by this record's generation (its latest reflog
 * entry names the record's armId) — a stale same-base record cannot be
 * compared against as if it were the current arm (`pin_generation_mismatch`).
 */
export async function compareToGitCheckpoint(
  root: string,
  encodedRecord: string,
  options: GitCheckpointOptions = {},
  includeContents = false,
): Promise<GitCheckpointResult<GitCheckpointComparisonReport>> {
  let record: GitCheckpointRecord;
  try {
    record = decodeGitCheckpointRecord(encodedRecord);
  } catch (error) {
    return resultFromError(error);
  }
  const gitPath = options.gitPath ?? "git";
  const spec: GitRunSpec = { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: 1024 * 1024, signal: options.signal };

  try {
    throwIfAborted(spec.signal);
    const resolved = await resolveRepo(gitPath, root, spec);
    if (resolved.status !== "ok") return resolved;
    const repo = resolved.value;

    const pinCheck = await verifyGitCheckpointPin(repo.root, record, options);
    if (pinCheck.status !== "ok") return pinCheck;
    throwIfAborted(spec.signal);

    // Generation binding: same proof as load gate 5b — a caller-persisted
    // stale same-base record cannot be compared against as if it were the
    // current arm.
    const genCheck = await verifyPinGeneration(gitPath, repo.root, record.ref, record.armId, spec);
    if (genCheck !== undefined) return genCheck;

    const audit = await auditRepository(gitPath, repo.root, spec);
    if (audit.status !== "ok") return audit;
    const initialAuditProof = audit.value;
    // Freeze the probed EOL semantics for the worktree-diff commands below.
    spec.frozenAutocrlf = audit.value.effectiveAutocrlf;
    await runAfterInitialAuditHook(options);
    throwIfAborted(spec.signal);

    const windowId = windowIdFromRef(record.ref);
    if (windowId === undefined) {
      return { status: "failed", reason: "malformed_record", detail: "record ref does not encode a safe window id" };
    }
    const trees = await buildArmedTrees(gitPath, repo, record, windowId, spec);
    throwIfAborted(spec.signal);

    // A comparison is read-only, including index metadata: write-tree only
    // the owned disposable copy, never the live index.
    const liveIndexTree = await snapshotLiveIndexTree(gitPath, repo, trees.scratchDir, spec);

    const [deltaVsIndex, deltaVsWorktree] = await Promise.all([
      diffTreePaths(gitPath, repo.root, trees.armedWorktreeTree, liveIndexTree, spec),
      worktreeDeltaPaths(gitPath, repo, trees.armedWorktreeTree, spec, join(trees.scratchDir, "compare-index-diff")),
    ]);
    const changed = [...new Set([...deltaVsIndex, ...deltaVsWorktree])].sort();

    const entries = await lsTreeMap(gitPath, repo.root, trees.armedWorktreeTree, spec);
    const trackedChanges: GitCheckpointTrackedChange[] = [];
    for (const path of changed) {
      throwIfAborted(spec.signal);
      if (!isSafeRelativePath(path)) {
        return { status: "failed", reason: "git_warning", detail: `unsafe path in changed set: ${JSON.stringify(path)}` };
      }
      const armed = entries.get(path);
      const absolute = join(repo.root, ...path.split("/"));
      let currentStat;
      try {
        currentStat = await lstat(absolute);
      } catch (error) {
        if (fsCodeOf(error) !== "ENOENT") {
          return { status: "failed", reason: "git_failed", detail: truncateDetail(`cannot stat ${path}: ${messageOf(error)}`) };
        }
      }
      const existsNow = currentStat !== undefined && !currentStat.isDirectory();
      let status: GitCheckpointTrackedChange["status"];
      if (armed === undefined) status = "added";
      else if (!existsNow) status = "deleted";
      else status = "modified";
      const change: GitCheckpointTrackedChange = { path, status };
      // Armed-side type/mode from the armed tree. Always reported — a
      // mode-only change must stay reviewable even when the bytes are equal.
      if (armed !== undefined) {
        change.oldKind = armed.mode === "120000" ? "symlink" : "file";
        change.oldMode = parseInt(armed.mode, 8) & 0o777;
      }
      // Current-side type/mode. Special files are not representable in the
      // report — fail closed rather than mislabel them.
      if (existsNow) {
        if (currentStat!.isSymbolicLink()) {
          change.newKind = "symlink";
        } else if (currentStat!.isFile()) {
          change.newKind = "file";
          change.newMode = currentStat!.mode & 0o777;
        } else {
          return {
            status: "failed",
            reason: "git_failed",
            detail: truncateDetail(`path ${path} is a special file in the worktree; comparison cannot represent it`),
          };
        }
      }
      if (includeContents) {
        if (armed !== undefined) {
          change.oldBytes = await catFileBlob(gitPath, repo.root, armed.blob, spec);
        }
        if (existsNow) {
          if (change.newKind === "symlink") {
            // Symlink content IS its target: read it no-follow. A lossy
            // UTF-8 decode (U+FFFD) cannot be represented byte-for-byte.
            let target: string;
            try {
              target = await readlink(absolute);
            } catch (error) {
              return { status: "failed", reason: "git_failed", detail: truncateDetail(`cannot read symlink target for ${path}: ${messageOf(error)}`) };
            }
            if (target.includes("\uFFFD")) {
              return { status: "failed", reason: "git_failed", detail: truncateDetail(`symlink ${path} has a target that is not valid UTF-8; its bytes cannot be represented`) };
            }
            change.newBytes = Buffer.from(target, "utf8");
          } else {
            // Bound the new-side worktree read like the old-side blob read
            // (MAX_BLOB_BYTES: a single blob materialized during compare).
            const raw = await readWorktreeFile(absolute, path, MAX_BLOB_BYTES, options.faultHooks?.afterTrackedRead);
            change.newBytes = await cleanTrackedComparisonBytes(gitPath, repo, path, raw, trees.scratchDir, spec);
          }
        }
      }
      trackedChanges.push(change);
    }

    // Untracked deltas against the baseline. Ignored untracked paths are
    // excluded by --exclude-standard (the ordinary baseline never includes
    // them); tracked-but-ignored paths stay tracked and surface through
    // trackedChanges above.
    const nowUntracked = await listUntrackedPaths(gitPath, repo.root, spec);
    const baseline = new Map(record.untracked.map((e) => [e.path, e]));
    const untrackedAdded: string[] = [];
    const untrackedRemoved: string[] = [];
    const untrackedModified: string[] = [];
    const untrackedChanges: GitCheckpointUntrackedChange[] = [];

    // Old (baseline) side of a changed entry. Exact bytes/target only with
    // includeContents — the content was already captured at arm time.
    const baselineState = (entry: GitCheckpointUntrackedEntry): GitCheckpointUntrackedState => {
      const state: GitCheckpointUntrackedState = { kind: entry.kind, mode: entry.mode };
      if (includeContents) {
        if (entry.kind === "file") state.content = Buffer.from(entry.contentB64 ?? "", "base64");
        else state.target = entry.target;
      }
      return state;
    };

    const maxUntrackedBytes = options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES;
    let newUntrackedBytes = 0;
    // Current-side state for a changed path: exact no-follow capture with
    // pre/post stat identity when content is requested, otherwise kind/mode
    // from the classification stat. Special files are not representable.
    const currentStateOf = async (path: string, knownStat?: Stats): Promise<GitCheckpointUntrackedState> => {
      if (includeContents) {
        const captured = await captureUntrackedEntry(repo.root, path, options.faultHooks?.beforeUntrackedRead, maxUntrackedBytes);
        if (captured.kind === "file") {
          newUntrackedBytes += captured.size;
          if (newUntrackedBytes > maxUntrackedBytes) {
            throw new GitCheckpointError("compared untracked bytes exceeded the cap", "untracked_too_large");
          }
        }
        const state: GitCheckpointUntrackedState = { kind: captured.kind, mode: captured.mode };
        if (captured.kind === "file") state.content = Buffer.from(captured.contentB64 ?? "", "base64");
        else state.target = captured.target;
        return state;
      }
      const current = knownStat ?? await lstat(join(repo.root, ...path.split("/"))).catch((error): never => {
        throw untrackedCaptureError(path, error, "could not stat");
      });
      if (current.isSymbolicLink()) return { kind: "symlink", mode: current.mode };
      if (current.isFile()) return { kind: "file", mode: current.mode };
      throw new GitCheckpointError(
        `untracked path ${path} is a special file; only regular files and symlinks are checkpointable`,
        "unsupported_untracked_entry",
      );
    };

    for (const path of nowUntracked.sort()) {
      throwIfAborted(spec.signal);
      const expected = baseline.get(path);
      if (expected === undefined) {
        untrackedAdded.push(path);
        untrackedChanges.push({ path, change: "added", new: await currentStateOf(path) });
        continue;
      }
      const absolute = join(repo.root, ...path.split("/"));
      let current;
      try {
        current = await lstat(absolute);
      } catch (error) {
        // Vanished between listing and stat — treat as removed.
        untrackedRemoved.push(path);
        untrackedChanges.push({ path, change: "removed", old: baselineState(expected) });
        continue;
      }
      if (!sameStatIdentity(statIdentityOf(current), statIdentityOf(expected))) {
        untrackedModified.push(path);
        untrackedChanges.push({ path, change: "modified", old: baselineState(expected), new: await currentStateOf(path, current) });
      }
    }
    const nowUntrackedSet = new Set(nowUntracked);
    for (const entry of record.untracked) {
      if (!nowUntrackedSet.has(entry.path)) {
        untrackedRemoved.push(entry.path);
        untrackedChanges.push({ path: entry.path, change: "removed", old: baselineState(entry) });
      }
    }
    untrackedRemoved.sort();
    untrackedChanges.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const finalAudit = await auditRepository(gitPath, repo.root, spec);
    assertAuditProofStable(initialAuditProof, finalAudit);

    return {
      status: "ok",
      value: { trackedChanges, untrackedAdded, untrackedRemoved, untrackedModified, untrackedChanges },
    };
  } catch (error) {
    return resultFromError(error);
  }
}
