/**
 * #233: checkpoint restore (extracted from git-checkpoint.ts). Reconstructs
 * the armed state exactly — lazy changed-content materialization, baseline
 * untracked restoration under stat identity, and the atomic live-index swap
 * with a scratch backup — after pin and generation proof.
 */

import { chmod, copyFile, lstat, mkdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GitCheckpointError, fsCodeOf, messageOf, resultFromError, throwIfAborted, truncateDetail, type GitCheckpointResult } from "./errors";
import { blobObjectId, decodeGitCheckpointRecord, isSafeRelativePath, sameStatIdentity, statIdentityOf, windowIdFromRef, type GitCheckpointObjectFormat, type GitCheckpointRecord, type GitCheckpointUntrackedEntry } from "./record";
import { DEFAULT_TIMEOUT_MS, type GitRunSpec } from "./run-git";
import { auditRepository, resolveRepo, runAfterInitialAuditHook } from "./audit";
import { verifyGitCheckpointPin, verifyPinGeneration } from "./pin";
import { listUntrackedPaths, snapshotLiveIndexTree } from "./capture";
import { buildArmedTrees, diffTreePaths, lsTreeMap, worktreeDeltaPaths } from "./trees";
import { assertContainedParents, catFileBlob, readWorktreeFile } from "./content";
import type { GitCheckpointOptions, GitCheckpointRestoreReport } from "./types";

// ── Restore ──────────────────────────────────────────────────────────────────

/**
 * Reconstruct the armed state exactly: worktree converges on the armed
 * worktree tree, and the live index is atomically replaced by the armed
 * index. Only paths that deviate from the armed state are materialized (lazy
 * changed-content materialization — clean tracked files are never read).
 * The current live index is backed up into owned scratch before the swap.
 * Baseline untracked entries are recreated/rewritten only when their stat
 * identity has drifted; new non-ignored untracked paths are reported in
 * `leftBehind` and never deleted.
 * The pin must also be owned by this record's generation (its latest reflog
 * entry names the record's armId) — a stale same-base record, including one
 * persisted by the caller, cannot be restored over a newer arm's state
 * (`pin_generation_mismatch`). Failures after materialization begins may
 * leave the worktree and/or index partially or fully changed; callers must
 * not treat those failures as a no-mutation signal for fallback to another
 * restore strategy.
 */
export async function restoreGitCheckpoint(
  root: string,
  encodedRecord: string,
  options: GitCheckpointOptions = {},
): Promise<GitCheckpointResult<GitCheckpointRestoreReport>> {
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

    // Generation binding: the pin's latest reflog entry must name this
    // record's arm, so a caller-persisted stale same-base record cannot be
    // restored over a newer arm's state (same proof as load gate 5b).
    const genCheck = await verifyPinGeneration(gitPath, repo.root, record.ref, record.armId, spec);
    if (genCheck !== undefined) return genCheck;

    // Re-audit: the repository may have gained external filters since arm.
    const audit = await auditRepository(gitPath, repo.root, spec);
    if (audit.status !== "ok") return audit;
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

    // Changed set C = paths where armed worktree tree ≠ live index ∪ live worktree.
    // Git write-tree may rewrite its input index even with optional locks off;
    // snapshot a disposable copy before taking the real index's byte backup.
    const liveIndexTree = await snapshotLiveIndexTree(gitPath, repo, trees.scratchDir, spec);

    const [deltaVsIndex, deltaVsWorktree] = await Promise.all([
      diffTreePaths(gitPath, repo.root, trees.armedWorktreeTree, liveIndexTree, spec),
      worktreeDeltaPaths(gitPath, repo, trees.armedWorktreeTree, spec, join(trees.scratchDir, "restore-index-diff")),
    ]);
    const changed = new Set<string>([...deltaVsIndex, ...deltaVsWorktree]);

    // Materialize every deviating tracked path from the armed worktree tree.
    const materializedPaths: string[] = [];
    const entries = await lsTreeMap(gitPath, repo.root, trees.armedWorktreeTree, spec);
    for (const path of [...changed].sort()) {
      throwIfAborted(spec.signal);
      if (!isSafeRelativePath(path)) {
        return { status: "failed", reason: "git_warning", detail: `unsafe path in changed set: ${JSON.stringify(path)}` };
      }
      const armed = entries.get(path);
      const absolute = join(repo.root, ...path.split("/"));
      await materializeTrackedPath(gitPath, repo.root, record.objectFormat, path, armed, spec, absolute);
      materializedPaths.push(path);
    }
    // Restore baseline untracked entries (exact bytes / symlink targets).
    const untrackedRestored: string[] = [];
    let untrackedVerified = 0;
    for (const entry of record.untracked) {
      throwIfAborted(spec.signal);
      const state = await restoreUntrackedEntry(repo.root, entry);
      if (state === "restored") untrackedRestored.push(entry.path);
      else untrackedVerified += 1;
    }

    // Snapshot the untracked set BEFORE the index swap: a path that is
    // untracked now but becomes tracked by the armed index would vanish from
    // the post-swap listing and be silently absorbed, so both listings count.
    let preSwapUntracked: string[];
    try {
      preSwapUntracked = await listUntrackedPaths(gitPath, repo.root, spec);
    } catch (error) {
      return resultFromError(error);
    }

    // Atomic live-index swap: back up the current index into owned scratch,
    // then rename the armed temp index over it. Same filesystem (both under
    // the git directory) makes the rename atomic.
    let indexStat;
    try {
      indexStat = await lstat(repo.liveIndexPath);
    } catch (error) {
      if (fsCodeOf(error) === "ENOENT") {
        // No live index yet: nothing to back up, just place the armed one.
      } else {
        return { status: "failed", reason: "git_failed", detail: truncateDetail(`cannot stat live index: ${messageOf(error)}`) };
      }
    }
    if (indexStat !== undefined) {
      try {
        await copyFile(repo.liveIndexPath, join(trees.scratchDir, "index-backup"));
      } catch (error) {
        return { status: "failed", reason: "git_failed", detail: truncateDetail(`cannot back up live index: ${messageOf(error)}`) };
      }
    }
    try {
      await rename(trees.tempIndexPath, repo.liveIndexPath);
    } catch (error) {
      return { status: "failed", reason: "git_failed", detail: truncateDetail(`cannot place armed index: ${messageOf(error)}`) };
    }

    // Report new non-ignored untracked paths without deleting anything.
    // Union of pre-swap and post-swap listings so leftovers that the swap
    // re-tracks are still surfaced to the caller.
    let leftBehind: string[];
    try {
      const postSwapUntracked = await listUntrackedPaths(gitPath, repo.root, spec);
      const baseline = new Set(record.untracked.map((e) => e.path));
      leftBehind = [...new Set([...preSwapUntracked, ...postSwapUntracked])].filter((p) => !baseline.has(p)).sort();
    } catch (error) {
      return resultFromError(error);
    }

    // Restore may materialize Git-normalized tracked bytes, so require a
    // final security/index audit rather than comparing worktree EOL state.
    const postRestoreAudit = await auditRepository(gitPath, repo.root, spec);
    if (postRestoreAudit.status === "unsupported") {
      return {
        status: "failed",
        reason: "capture_inconsistent",
        detail: postRestoreAudit.detail ?? "post-restore repository audit was unsupported",
      };
    }
    if (postRestoreAudit.status === "failed") return postRestoreAudit;

    return {
      status: "ok",
      value: {
        armedIndexTree: trees.armedIndexTree,
        armedWorktreeTree: trees.armedWorktreeTree,
        materializedPaths,
        untrackedRestored,
        untrackedVerified,
        leftBehind,
        scratchDir: trees.scratchDir,
      },
    };
  } catch (error) {
    return resultFromError(error);
  }
}

/** Restore one baseline untracked entry; "verified" means stat identity matched. */
async function restoreUntrackedEntry(
  root: string,
  entry: GitCheckpointUntrackedEntry,
): Promise<"restored" | "verified"> {
  const absolute = join(root, ...entry.path.split("/"));
  let current;
  try {
    current = await lstat(absolute);
  } catch (error) {
    if (fsCodeOf(error) !== "ENOENT") {
      throw new GitCheckpointError(`cannot stat ${entry.path} during restore: ${messageOf(error)}`, "git_failed");
    }
  }
  const unchanged = current !== undefined && sameStatIdentity(statIdentityOf(current), statIdentityOf(entry));
  if (unchanged) return "verified";

  // Refuse symlinked parent components before touching anything.
  await assertContainedParents(root, absolute);
  // Ensure the parent directory exists (it may have been removed with a dir).
  await mkdir(join(root, ...entry.path.split("/").slice(0, -1)), { recursive: true });
  if (current !== undefined) {
    try {
      await rm(absolute, { force: true });
    } catch (error) {
      throw new GitCheckpointError(`cannot remove ${entry.path} before restore: ${messageOf(error)}`, "restore_path_conflict");
    }
  }
  if (entry.kind === "symlink") {
    try {
      await symlink(entry.target!, absolute);
    } catch (error) {
      throw new GitCheckpointError(`cannot recreate symlink ${entry.path}: ${messageOf(error)}`, "restore_path_conflict");
    }
  } else {
    const bytes = Buffer.from(entry.contentB64 ?? "", "base64");
    try {
      await writeFile(absolute, bytes);
      await chmod(absolute, entry.mode & 0o7777);
    } catch (error) {
      throw new GitCheckpointError(`cannot restore ${entry.path}: ${messageOf(error)}`, "restore_path_conflict");
    }
  }
  return "restored";
}

/**
 * Make one tracked path in the worktree exactly match its armed state:
 * delete it when absent from the armed tree, otherwise write the exact blob
 * bytes with the armed mode, or recreate a symlink with the armed target.
 * Existing content is only read to decide whether writing is needed at all —
 * the fast path skips both the object-store read and the write when the
 * current file already hashes to the armed blob AND carries the armed mode.
 */
async function materializeTrackedPath(
  gitPath: string,
  root: string,
  objectFormat: GitCheckpointObjectFormat,
  path: string,
  armed: { mode: string; blob: string } | undefined,
  spec: GitRunSpec,
  absolute: string,
): Promise<void> {
  if (armed === undefined) {
    // Path not in the armed worktree tree → it must be gone.
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if (fsCodeOf(error) === "ENOENT") return;
      throw new GitCheckpointError(`cannot stat ${path} during restore: ${messageOf(error)}`, "git_failed");
    }
    if (stat.isDirectory()) {
      // A directory in the way of a deletion is a conflict we must not guess at.
      throw new GitCheckpointError(`cannot delete ${path}: it is a directory, not a file`, "restore_path_conflict");
    }
    await assertContainedParents(root, absolute);
    try {
      await rm(absolute, { force: true });
    } catch (error) {
      throw new GitCheckpointError(`cannot delete ${path} during restore: ${messageOf(error)}`, "restore_path_conflict");
    }
    return;
  }

  const armedBlob = armed.blob;
  const wantMode = parseInt(armed.mode, 8) & 0o7777;
  const isSymlink = armed.mode === "120000";

  let currentStat;
  try {
    currentStat = await lstat(absolute);
  } catch (error) {
    if (fsCodeOf(error) !== "ENOENT") {
      throw new GitCheckpointError(`cannot stat ${path} during restore: ${messageOf(error)}`, "git_failed");
    }
  }

  // Fast path: current entry already exactly matches the armed state.
  if (currentStat !== undefined) {
    if (isSymlink && currentStat.isSymbolicLink()) {
      const target = await readlink(absolute).catch(() => undefined);
      if (target !== undefined && blobObjectId(objectFormat, Buffer.from(target, "utf8")) === armedBlob) return;
    } else if (!isSymlink && currentStat.isFile()) {
      const bytes = await readWorktreeFile(absolute, path);
      if (blobObjectId(objectFormat, bytes) === armedBlob && (currentStat.mode & 0o7777) === wantMode) return;
    }
  }

  // Materialize from the object store — only after proving the write cannot
  // escape the repository through a symlinked parent component.
  await assertContainedParents(root, absolute);
  const blobBytes = await catFileBlob(gitPath, root, armedBlob, spec);
  try {
    // Missing parent directories are recreated for both symlinks and files.
    await mkdir(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    if (isSymlink) {
      if (currentStat !== undefined) await rm(absolute, { force: true });
      // Symlink targets are raw object bytes: write the blob directly so a
      // non-UTF-8 target is restored exactly instead of being re-encoded
      // through a lossy UTF-8 decode.
      await symlink(blobBytes, absolute);
      return;
    }
    if (currentStat !== undefined && !currentStat.isFile()) await rm(absolute, { force: true });
    await writeFile(absolute, blobBytes);
    await chmod(absolute, wantMode);
  } catch (error) {
    throw new GitCheckpointError(`cannot write ${path} during restore: ${messageOf(error)}`, "restore_path_conflict");
  }
}
