/**
 * #233: checkpoint arm orchestration (extracted from git-checkpoint.ts).
 * Arms the durable baseline: window-id gate, pin CAS before capture, the
 * read-only capture-consistency window, untracked capture, dual audit, and
 * durable publication of the record plus compact descriptor.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { GitCheckpointError, messageOf, resultFromError, throwIfAborted, truncateDetail, type GitCheckpointResult } from "./errors";
import { GIT_CHECKPOINT_DESCRIPTOR_FORMAT, GIT_CHECKPOINT_RECORD_FORMAT, SCRATCH_SUBDIR, checkpointRefForWindow, encodeGitCheckpointRecord, isSafeWindowId, type GitCheckpointArmStats, type GitCheckpointDescriptor, type GitCheckpointObjectFormat, type GitCheckpointRecord, type GitCheckpointUntrackedEntry } from "./record";
import { DEFAULT_MAX_PATCH_BYTES, DEFAULT_MAX_UNTRACKED_BYTES, DEFAULT_TIMEOUT_MS, ZERO_OID_SHA1, ZERO_OID_SHA256, runGit, type GitRunOutput, type GitRunSpec } from "./run-git";
import { assertAuditProofStable, auditRepository, resolveRepo, runAfterInitialAuditHook } from "./audit";
import { acquireWindowPinLock, cleanupAfterFailedArm, createPinIfMissing } from "./pin";
import { captureDiff, captureUntrackedEntry, listUntrackedPaths, snapshotIndexTree } from "./capture";
import { publishRecordDurable, syncAncestorChain } from "./durability";
import type { GitCheckpointOptions } from "./types";

// ── Arm ──────────────────────────────────────────────────────────────────────

export interface GitCheckpointArmOutcome {
  record: GitCheckpointRecord;
  /**
   * Encoded durable record — already published atomically in this arm's
   * owned scratch directory; kept for callers that persist it themselves.
   * restore/compare verify the pin's generation proof against this record's
   * armId before acting on it, so a persisted record can never be applied
   * over a newer same-base arm; the descriptor remains the compact artifact
   * for fresh-process reloads.
   */
  encoded: string;
  /**
   * Compact descriptor of this arm generation — the only thing a sidecar
   * must store. `loadGitCheckpoint(root, descriptor)` reloads and verifies
   * the full record from it in a fresh process.
   */
  descriptor: GitCheckpointDescriptor;
  stats: GitCheckpointArmStats;
}

/**
 * Arm a durable Git-backed baseline for `root`. See module docs for the
 * record layout and fail-closed contract. The pin ref is created with a
 * compare-and-set expecting it to be missing, so an existing same-id
 * checkpoint is never overwritten: a duplicate arm fails with
 * `pin_ref_exists` before any scratch or capture work begins. Before
 * publishing, the two captured patches are verified read-only to describe one
 * consistent (index, worktree) pair (see module docs); an interleaved index
 * or tracked-worktree change fails with `capture_inconsistent`. On failure
 * only this arm's own pin — conditionally, and only while THIS generation
 * still owns it per the pin reflog — and its own scratch subdirectory are
 * removed, so a failed arm never destroys another same-id checkpoint's state.
 */
export async function armGitCheckpoint(
  root: string,
  windowId: string,
  options: GitCheckpointOptions = {},
): Promise<GitCheckpointResult<GitCheckpointArmOutcome>> {
  try {
    if (!isSafeWindowId(windowId)) {
      throw new GitCheckpointError(`unsafe checkpoint window id ${JSON.stringify(windowId)}`, "unsafe_window_id");
    }
    const gitPath = options.gitPath ?? "git";
    const spec: GitRunSpec = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: 1024 * 1024,
      signal: options.signal,
    };

    const resolved = await resolveRepo(gitPath, root, spec);
    if (resolved.status !== "ok") return resolved;
    const repo = resolved.value;
    throwIfAborted(spec.signal);

    // Canonical repository identity for the descriptor (real path: tmp dirs
    // may sit behind symlinks). Fail closed before any pin/scratch work.
    let gitDirReal: string;
    try {
      gitDirReal = await realpath(repo.gitDir);
    } catch (error) {
      return resultFromError(error);
    }

    const audit = await auditRepository(gitPath, repo.root, spec);
    if (audit.status !== "ok") return audit;
    const initialAuditProof = audit.value;
    // Freeze the probed EOL semantics for every capture command below.
    spec.frozenAutocrlf = audit.value.effectiveAutocrlf;
    await runAfterInitialAuditHook(options);
    throwIfAborted(spec.signal);

    let headOut: GitRunOutput;
    try {
      headOut = await runGit(gitPath, repo.root, ["rev-parse", "--verify", "HEAD^{commit}"], spec);
    } catch (error) {
      return resultFromError(error);
    }
    if (headOut.code !== 0) {
      return { status: "unsupported", reason: "unborn_head", detail: truncateDetail(headOut.stderr || "HEAD does not name a commit") };
    }
    const base = headOut.stdout.toString("utf8").trim();

    // Derive the object format from the full base oid length (40 hex = sha1,
    // 64 hex = sha256). This matches every oid Git emits in this repository.
    const objectFormat: GitCheckpointObjectFormat | undefined = base.length === 40 ? "sha1" : base.length === 64 ? "sha256" : undefined;
    if (objectFormat === undefined) {
      return { status: "failed", reason: "git_failed", detail: `unexpected object id length for HEAD: ${base.length}` };
    }

    // Pin the base commit in an owned ref BEFORE capturing anything, so the
    // baseline is GC-safe from this point on. The create is a compare-and-set
    // expecting the ref to be MISSING (zero OID for the repository's object
    // format): an existing same-id checkpoint is never overwritten, and the
    // refusal happens before any scratch or capture work begins. The update
    // is reflog-annotated with this arm's generation nonce so release can
    // later prove which generation owns the pin (see release docs).
    const armId = randomBytes(8).toString("hex");
    const ref = checkpointRefForWindow(windowId);
    const zeroOid = objectFormat === "sha1" ? ZERO_OID_SHA1 : ZERO_OID_SHA256;
    // Serialize ref creation against release's generation proof, deletion,
    // and scratch cleanup. Git's base-only CAS cannot distinguish same-base
    // generations once the old ref has been deleted.
    const unlockPin = await acquireWindowPinLock(repo.gitDir, windowId, spec, options.faultHooks?.onPinLockContended);
    let pinCreated: GitCheckpointResult<"created">;
    try {
      pinCreated = await createPinIfMissing(gitPath, repo.root, ref, base, zeroOid, armId, spec);
    } finally {
      await unlockPin();
    }
    if (pinCreated.status !== "ok") return pinCreated;

    // Owned scratch for this arm: a per-arm subdirectory inside the shared
    // window dir, so a failed arm removes exactly what it created and can
    // never destroy another same-id arm's files. Created before any capture
    // so partial work is always inside the owned dir. The nonce names the
    // directory and doubles as the arm's generation identity (descriptor
    // `armId`, pin reflog entry).
    const scratchDir = join(repo.gitDir, SCRATCH_SUBDIR, windowId, `arm-${armId}`);
    try {
      await mkdir(scratchDir, { recursive: true });
      // Make the newly created directory entries durable in their parents
      // (window dir, checkpoints dir, git dir) so a power loss cannot leave
      // the record path half-materialized; publishRecordDurable then fsyncs
      // the arm dir itself around the rename.
      await syncAncestorChain(scratchDir, repo.gitDir);
    } catch (error) {
      await cleanupAfterFailedArm(gitPath, repo, windowId, base, armId, scratchDir, spec);
      return resultFromError(error);
    }

    const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
    let stagedPatch: Buffer;
    let unstagedPatch: Buffer;
    try {
      // Consistency verification (read-only, fail-closed). The two patches
      // must describe ONE consistent (index, worktree) pair. Without this
      // check a `git add` or tracked edit landing between the two diffs can
      // yield two empty patches that replay as a clean base although an old
      // edit existed throughout. Exact checks:
      //   1. Index stability — the tree id of a snapshot copy of the live
      //      index (`git write-tree` against an alternate index file in this
      //      arm's scratch; the live index is never written) is identical
      //      before and after both patch captures. The tree id is a content
      //      hash of every index entry, so equality proves the entries were
      //      equal.
      //   2. Tracked-worktree stability — a full binary `git diff` (index →
      //      worktree) taken BEFORE the staged capture must be byte-identical
      //      to the captured unstaged patch; with check 1 holding, any
      //      tracked worktree change in the window changes that output.
      // Residual limit (documented): a change that lands and fully reverts
      // inside the capture window is undetectable by sampling, like any
      // snapshot. Changes landing after the unstaged capture are outside the
      // verified window; untracked entries carry their own pre/post stat
      // identity checks below.
      const indexTreeBefore = await snapshotIndexTree(gitPath, repo, join(scratchDir, "index-pre"), spec);
      const preUnstagedDiff = await captureDiff(gitPath, repo.root, [], spec, maxPatchBytes, {
        repo,
        copyPath: join(scratchDir, "index-pre-diff"),
      });
      stagedPatch = await captureDiff(gitPath, repo.root, ["--cached", base], spec, maxPatchBytes, {
        repo,
        copyPath: join(scratchDir, "index-staged-diff"),
      });
      throwIfAborted(spec.signal);
      // Deterministic fault seam between the two patch captures (tests only).
      try {
        await options.faultHooks?.betweenPatchCaptures?.();
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) {
          throw new GitCheckpointError(`capture consistency hook failed: ${messageOf(error)}`, "git_failed");
        }
        throw error;
      }
      unstagedPatch = await captureDiff(gitPath, repo.root, [], spec, maxPatchBytes, {
        repo,
        copyPath: join(scratchDir, "index-unstaged-diff"),
      });
      const indexTreeAfter = await snapshotIndexTree(gitPath, repo, join(scratchDir, "index-post"), spec);
      if (indexTreeBefore !== indexTreeAfter) {
        throw new GitCheckpointError(
          `live index changed during checkpoint capture (tree ${indexTreeBefore} → ${indexTreeAfter}); the staged and unstaged patches would describe different indexes`,
          "capture_inconsistent",
        );
      }
      if (!preUnstagedDiff.equals(unstagedPatch)) {
        throw new GitCheckpointError(
          "tracked worktree changed during checkpoint capture; the captured patches would not describe one consistent state",
          "capture_inconsistent",
        );
      }
    } catch (error) {
      await cleanupAfterFailedArm(gitPath, repo, windowId, base, armId, scratchDir, spec);
      return resultFromError(error);
    }

    let untracked: GitCheckpointUntrackedEntry[];
    try {
      const paths = await listUntrackedPaths(gitPath, repo.root, spec);
      await options.faultHooks?.afterUntrackedList?.();
      untracked = [];
      let totalBytes = 0;
      for (const path of paths) {
        throwIfAborted(spec.signal);
        const entry = await captureUntrackedEntry(repo.root, path, options.faultHooks?.beforeUntrackedRead);
        if (entry.kind === "file" && entry.contentB64 !== undefined) {
          totalBytes += Buffer.byteLength(entry.contentB64, "base64");
          if (totalBytes > (options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES)) {
            throw new GitCheckpointError("captured untracked bytes exceeded the cap", "untracked_too_large");
          }
        }
        untracked.push(entry);
        throwIfAborted(spec.signal);
      }
    } catch (error) {
      await cleanupAfterFailedArm(gitPath, repo, windowId, base, armId, scratchDir, spec);
      return resultFromError(error);
    }

    try {
      const finalAudit = await auditRepository(gitPath, repo.root, spec);
      assertAuditProofStable(initialAuditProof, finalAudit);
    } catch (error) {
      await cleanupAfterFailedArm(gitPath, repo, windowId, base, armId, scratchDir, spec);
      return resultFromError(error);
    }

    const record: GitCheckpointRecord = {
      format: GIT_CHECKPOINT_RECORD_FORMAT,
      armId,
      base,
      ref,
      objectFormat,
      stagedPatchB64: stagedPatch.toString("base64"),
      unstagedPatchB64: unstagedPatch.toString("base64"),
      untracked,
    };
    const encoded = encodeGitCheckpointRecord(record);
    try {
      // Atomic durable publication: temp file in this arm's owned scratch
      // dir, file fsync, rename over record.json, directory fsync. A crash
      // at any point leaves either no record or the complete one — never a
      // torn file that load could trust.
      await publishRecordDurable(scratchDir, encoded);
    } catch (error) {
      await cleanupAfterFailedArm(gitPath, repo, windowId, base, armId, scratchDir, spec);
      return resultFromError(error);
    }

    // Compact descriptor: identity + integrity only, never record content.
    // This is the only thing a sidecar must persist; loadGitCheckpoint
    // reloads the full record from the owned scratch and verifies it.
    const descriptor: GitCheckpointDescriptor = {
      format: GIT_CHECKPOINT_DESCRIPTOR_FORMAT,
      windowId,
      armId,
      gitDir: gitDirReal,
      base,
      ref,
      objectFormat,
      digest: createHash("sha256").update(encoded, "utf8").digest("hex"),
    };

    const stats: GitCheckpointArmStats = {
      baseCommit: base,
      stagedPatchBytes: stagedPatch.length,
      unstagedPatchBytes: unstagedPatch.length,
      untrackedFileCount: untracked.length,
      untrackedRawBytes: untracked.reduce((sum, e) => sum + (e.kind === "file" ? e.size : 0), 0),
      recordBytes: Buffer.byteLength(encoded, "utf8"),
    };
    return { status: "ok", value: { record, encoded, descriptor, stats } };
  } catch (error) {
    return resultFromError(error);
  }
}
