/**
 * #233: frozen checkpoint-to-checkpoint comparison (extracted from
 * git-checkpoint.ts). Compares the net worktree states of two independently
 * verified checkpoints by rebuilding both worktree trees in disposable
 * alternate indexes and comparing exact untracked bytes/modes/types.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { GitCheckpointError, messageOf, resultFromError, throwIfAborted, truncateDetail, type GitCheckpointResult } from "./errors";
import { SCRATCH_SUBDIR, isCanonicalBase64, isSafeRelativePath, oidMatchesFormat, type GitCheckpointDescriptor, type GitCheckpointObjectFormat, type GitCheckpointRecord, type GitCheckpointUntrackedEntry } from "./record";
import { DEFAULT_MAX_UNTRACKED_BYTES, DEFAULT_TIMEOUT_MS, runGit, runGitWithInput, type GitRunSpec } from "./run-git";
import { resolveRepo } from "./audit";
import { loadGitCheckpoint } from "./load";
import { assertNoTreePathConflicts, assertNoUntrackedPathConflicts, buildArmedTrees } from "./trees";
import { catFileBlob } from "./content";
import type { GitCheckpointComparisonReport, GitCheckpointOptions, GitCheckpointTrackedChange, GitCheckpointUntrackedChange, GitCheckpointUntrackedState } from "./types";

// ── Frozen checkpoint-to-checkpoint comparison ───────────────────────────────

interface CheckpointTreeEntry {
  mode: string;
  blob: string;
}

/** Read and strictly validate the reconstructed tracked worktree tree. */
async function checkpointTreeEntries(
  gitPath: string,
  root: string,
  tree: string,
  objectFormat: GitCheckpointObjectFormat,
  spec: GitRunSpec,
): Promise<Map<string, CheckpointTreeEntry>> {
  if (!oidMatchesFormat(tree, objectFormat)) {
    throw new GitCheckpointError(`reconstruction produced an invalid tree id ${JSON.stringify(tree)}`, "patch_apply_failed");
  }
  const out = await runGit(gitPath, root, ["ls-tree", "-r", "-z", tree], { ...spec, maxBytes: 64 * 1024 * 1024 });
  if (out.code !== 0 || out.stderr.trim().length > 0) {
    throw new GitCheckpointError(`cannot enumerate reconstructed tree: ${out.stderr || `exit ${out.code}`}`, "git_failed");
  }
  const entries = new Map<string, CheckpointTreeEntry>();
  for (const record of out.stdout.subarray(0).toString("binary").split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new GitCheckpointError("unparseable reconstructed ls-tree record", "git_failed");
    const fields = record.slice(0, tab).split(" ");
    const mode = fields[0] ?? "";
    const type = fields[1] ?? "";
    const blob = fields[2] ?? "";
    let path: string;
    try {
      path = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(record.slice(tab + 1), "binary"));
    } catch {
      throw new GitCheckpointError("reconstructed tree contains a path that is not valid UTF-8", "malformed_record");
    }
    if (!isSafeRelativePath(path)) {
      throw new GitCheckpointError(`unsafe path in reconstructed tree: ${JSON.stringify(path)}`, "git_failed");
    }
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
      throw new GitCheckpointError(`unsupported reconstructed tree entry ${mode} ${type} at ${path}`, "malformed_record");
    }
    if (!oidMatchesFormat(blob, objectFormat)) {
      throw new GitCheckpointError(`invalid blob id for reconstructed path ${path}`, "git_failed");
    }
    if (entries.has(path)) throw new GitCheckpointError(`duplicate reconstructed tree path ${path}`, "git_failed");
    entries.set(path, { mode, blob });
  }
  return entries;
}

/** Verify object presence without reading or retaining any blob contents. */
async function verifyCheckpointTreeBlobs(
  gitPath: string,
  root: string,
  entries: ReadonlyMap<string, CheckpointTreeEntry>,
  spec: GitRunSpec,
): Promise<void> {
  const blobs = [...new Set([...entries.values()].map((entry) => entry.blob))].sort();
  if (blobs.length === 0) return;
  const input = Buffer.from(`${blobs.join("\n")}\n`, "ascii");
  const out = await runGitWithInput(
    gitPath,
    root,
    ["cat-file", "--batch-check"],
    input,
    { ...spec, maxBytes: 128 * 1024 * 1024 },
    {},
  );
  if (out.code !== 0 || out.stderr.trim().length > 0) {
    throw new GitCheckpointError(`cannot verify reconstructed blobs: ${out.stderr || `exit ${out.code}`}`, "git_failed");
  }
  const lines = out.stdout.toString("ascii").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== blobs.length) {
    throw new GitCheckpointError("blob verification returned an incomplete object list", "git_failed");
  }
  for (let i = 0; i < blobs.length; i += 1) {
    const [oid, type, size, extra] = (lines[i] ?? "").split(" ");
    if (oid !== blobs[i] || type !== "blob" || !/^\d+$/.test(size ?? "") || extra !== undefined) {
      throw new GitCheckpointError(`reconstructed blob ${blobs[i]} is missing or has an invalid object type`, "git_failed");
    }
  }
}

/** Validate disjoint tracked/untracked state and representable untracked modes. */
function checkpointUntrackedMap(
  record: GitCheckpointRecord,
  tracked: ReadonlyMap<string, CheckpointTreeEntry>,
): Map<string, GitCheckpointUntrackedEntry> {
  const untracked = new Map<string, GitCheckpointUntrackedEntry>();
  for (const entry of record.untracked) {
    if (!isSafeRelativePath(entry.path) || Buffer.from(entry.path, "utf8").toString("utf8") !== entry.path) {
      throw new GitCheckpointError(`unsafe untracked checkpoint path ${JSON.stringify(entry.path)}`, "malformed_record");
    }
    const kindBits = entry.mode & 0o170000;
    const expectedKindBits = entry.kind === "file" ? 0o100000 : 0o120000;
    if (kindBits !== expectedKindBits || (entry.mode & ~0o177777) !== 0) {
      throw new GitCheckpointError(`unsupported untracked mode ${entry.mode.toString(8)} at ${entry.path}`, "malformed_record");
    }
    if (entry.kind === "file") {
      if (typeof entry.contentB64 !== "string" || !isCanonicalBase64(entry.contentB64)) {
        throw new GitCheckpointError(`non-canonical or missing untracked bytes for ${entry.path}`, "malformed_record");
      }
      if (Buffer.byteLength(entry.contentB64, "base64") !== entry.size) {
        throw new GitCheckpointError(`untracked byte count is inconsistent for ${entry.path}`, "malformed_record");
      }
    } else if (typeof entry.target !== "string" || Buffer.byteLength(entry.target, "utf8") !== entry.size) {
      throw new GitCheckpointError(`untracked symlink target is inconsistent for ${entry.path}`, "malformed_record");
    }
    if (untracked.has(entry.path)) throw new GitCheckpointError(`duplicate untracked path ${entry.path}`, "malformed_record");
    untracked.set(entry.path, entry);
  }
  try {
    assertNoUntrackedPathConflicts(new Set(untracked.keys()));
    assertNoTreePathConflicts(new Set(tracked.keys()), new Set(untracked.keys()), false);
  } catch (error) {
    throw new GitCheckpointError(`checkpoint tracked/untracked states overlap: ${messageOf(error)}`, "malformed_record");
  }
  return untracked;
}

function sameCheckpointUntrackedState(a: GitCheckpointUntrackedEntry, b: GitCheckpointUntrackedEntry): boolean {
  if (a.kind !== b.kind || a.mode !== b.mode) return false;
  return a.kind === "file"
    ? a.contentB64 === b.contentB64
    : a.target === b.target;
}

function checkpointUntrackedState(
  entry: GitCheckpointUntrackedEntry,
  includeContents: boolean,
  accountBytes: (size: number) => void,
): GitCheckpointUntrackedState {
  const state: GitCheckpointUntrackedState = { kind: entry.kind, mode: entry.mode };
  if (includeContents) {
    if (entry.kind === "file") {
      accountBytes(entry.size);
      state.content = Buffer.from(entry.contentB64!, "base64");
    } else {
      state.target = entry.target;
    }
  }
  return state;
}

/**
 * Compare the net worktree states captured by two independently verified
 * checkpoints. This intentionally does not inspect the current HEAD, index,
 * worktree, or ignore results: both worktree trees are rebuilt from their
 * durable patches in disposable alternate indexes, and untracked states are
 * compared from the exact bytes/modes/types in the verified records. Staged
 * and unstaged deltas therefore remain complete in storage while review sees
 * only their net worktree result. Pins and published records are never
 * released or modified.
 */
export async function compareGitCheckpoints(
  root: string,
  beforeDescriptor: GitCheckpointDescriptor,
  afterDescriptor: GitCheckpointDescriptor,
  options: GitCheckpointOptions = {},
  includeContents = false,
): Promise<GitCheckpointResult<GitCheckpointComparisonReport>> {
  const gitPath = options.gitPath ?? "git";
  const spec: GitRunSpec = { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: 1024 * 1024, signal: options.signal };
  let scratchDir: string | undefined;
  let result: GitCheckpointResult<GitCheckpointComparisonReport> | undefined;
  let cleanupError: unknown;
  try {
    throwIfAborted(spec.signal);
    // loadGitCheckpoint verifies both descriptors, repository associations,
    // record digests/contents, pin targets, and pin-generation ownership.
    const [beforeLoaded, afterLoaded] = await Promise.all([
      loadGitCheckpoint(root, beforeDescriptor, options),
      loadGitCheckpoint(root, afterDescriptor, options),
    ]);
    if (beforeLoaded.status !== "ok") return beforeLoaded;
    if (afterLoaded.status !== "ok") return afterLoaded;
    const before = beforeLoaded.value.record;
    const after = afterLoaded.value.record;
    if (before.objectFormat !== after.objectFormat) {
      return { status: "failed", reason: "descriptor_record_mismatch", detail: "checkpoint object formats differ" };
    }

    const resolved = await resolveRepo(gitPath, root, spec);
    if (resolved.status !== "ok") return resolved;
    const repo = resolved.value;
    throwIfAborted(spec.signal);

    // A unique private directory lets the finally block remove every
    // disposable index (including a partial reconstruction failure) without
    // touching either checkpoint's durable arm directory.
    const checkpointDir = join(repo.gitDir, SCRATCH_SUBDIR);
    await mkdir(checkpointDir, { recursive: true });
    scratchDir = await mkdtemp(join(checkpointDir, "compare-"));
    const beforeTrees = await buildArmedTrees(gitPath, repo, before, beforeDescriptor.windowId, spec, scratchDir);
    const afterTrees = await buildArmedTrees(gitPath, repo, after, afterDescriptor.windowId, spec, scratchDir);
    throwIfAborted(spec.signal);

    const beforeTracked = await checkpointTreeEntries(gitPath, repo.root, beforeTrees.armedWorktreeTree, before.objectFormat, spec);
    const afterTracked = await checkpointTreeEntries(gitPath, repo.root, afterTrees.armedWorktreeTree, after.objectFormat, spec);
    await Promise.all([
      verifyCheckpointTreeBlobs(gitPath, repo.root, beforeTracked, spec),
      verifyCheckpointTreeBlobs(gitPath, repo.root, afterTracked, spec),
    ]);
    const beforeUntracked = checkpointUntrackedMap(before, beforeTracked);
    const afterUntracked = checkpointUntrackedMap(after, afterTracked);

    const trackedChanges: GitCheckpointTrackedChange[] = [];
    const trackedPaths = [...new Set([...beforeTracked.keys(), ...afterTracked.keys()])].sort();
    for (const path of trackedPaths) {
      throwIfAborted(spec.signal);
      const oldEntry = beforeTracked.get(path);
      const newEntry = afterTracked.get(path);
      if (oldEntry !== undefined && newEntry !== undefined && oldEntry.mode === newEntry.mode && oldEntry.blob === newEntry.blob) continue;
      const change: GitCheckpointTrackedChange = {
        path,
        status: oldEntry === undefined ? "added" : newEntry === undefined ? "deleted" : "modified",
      };
      if (oldEntry !== undefined) {
        change.oldKind = oldEntry.mode === "120000" ? "symlink" : "file";
        change.oldMode = parseInt(oldEntry.mode, 8) & 0o777;
      }
      if (newEntry !== undefined) {
        change.newKind = newEntry.mode === "120000" ? "symlink" : "file";
        if (newEntry.mode !== "120000") change.newMode = parseInt(newEntry.mode, 8) & 0o777;
      }
      if (includeContents) {
        if (oldEntry !== undefined) change.oldBytes = await catFileBlob(gitPath, repo.root, oldEntry.blob, spec);
        if (newEntry !== undefined) change.newBytes = await catFileBlob(gitPath, repo.root, newEntry.blob, spec);
      }
      trackedChanges.push(change);
    }

    const untrackedAdded: string[] = [];
    const untrackedRemoved: string[] = [];
    const untrackedModified: string[] = [];
    const untrackedChanges: GitCheckpointUntrackedChange[] = [];
    const maxUntrackedBytes = options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES;
    let materializedUntrackedBytes = 0;
    const accountUntrackedBytes = (size: number): void => {
      materializedUntrackedBytes += size;
      if (materializedUntrackedBytes > maxUntrackedBytes) {
        throw new GitCheckpointError("compared checkpoint untracked bytes exceeded the cap", "untracked_too_large");
      }
    };
    const untrackedPaths = [...new Set([...beforeUntracked.keys(), ...afterUntracked.keys()])].sort();
    for (const path of untrackedPaths) {
      throwIfAborted(spec.signal);
      const oldEntry = beforeUntracked.get(path);
      const newEntry = afterUntracked.get(path);
      if (oldEntry !== undefined && newEntry !== undefined && sameCheckpointUntrackedState(oldEntry, newEntry)) continue;
      if (oldEntry === undefined) {
        untrackedAdded.push(path);
        untrackedChanges.push({
          path,
          change: "added",
          new: checkpointUntrackedState(newEntry!, includeContents, accountUntrackedBytes),
        });
      } else if (newEntry === undefined) {
        untrackedRemoved.push(path);
        untrackedChanges.push({
          path,
          change: "removed",
          old: checkpointUntrackedState(oldEntry, includeContents, accountUntrackedBytes),
        });
      } else {
        untrackedModified.push(path);
        untrackedChanges.push({
          path,
          change: "modified",
          old: checkpointUntrackedState(oldEntry, includeContents, accountUntrackedBytes),
          new: checkpointUntrackedState(newEntry, includeContents, accountUntrackedBytes),
        });
      }
    }
    result = {
      status: "ok",
      value: { trackedChanges, untrackedAdded, untrackedRemoved, untrackedModified, untrackedChanges },
    };
  } catch (error) {
    result = resultFromError(error);
  } finally {
    if (scratchDir !== undefined) {
      try {
        await rm(scratchDir, { recursive: true, force: true });
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (cleanupError !== undefined) {
    return {
      status: "failed",
      reason: "git_failed",
      detail: truncateDetail(`cannot remove disposable comparison indexes: ${messageOf(cleanupError)}`),
    };
  }
  return result ?? { status: "failed", reason: "git_failed", detail: "comparison completed without a result" };
}
