/**
 * #233: checkpoint capture primitives (extracted from git-checkpoint.ts).
 * Complete binary patch capture through disposable index copies, live-index
 * tree snapshots, non-ignored untracked enumeration, and exact no-follow
 * untracked entry capture with pre/post stat identity checks.
 */

import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { copyFile, lstat, open, readlink, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

import { GitCheckpointError, fsCodeOf, messageOf } from "./errors";
import { OID_RE_40, OID_RE_64, isSafeRelativePath, sameStatIdentity, statIdentityOf, type GitCheckpointUntrackedEntry, type StatIdentity } from "./record";
import { runGit, type GitRunOutput, type GitRunSpec } from "./run-git";
import type { ResolvedRepo } from "./audit";

/**
 * Git's racy-clean test hashes a stat-matching entry only if its mtime is at
 * least the index file's mtime. A freshly copied index has a NEW mtime, so a
 * same-size edit made just after staging can be mistaken for clean on the
 * copy even when the live index would have rehashed it. Backdate only the
 * disposable copy (one second before the live index, covering coarse clock
 * granularity); Git rehashes recently staged entries, but old clean entries
 * retain its normal stat fast path. This cannot detect deliberately forged
 * stat identities older than the live index; it is not a filesystem snapshot.
 */
export async function copyIndexForWorktreeDiff(repo: ResolvedRepo, copyPath: string): Promise<void> {
  let source: Stats;
  try {
    source = await stat(repo.liveIndexPath);
  } catch (error) {
    if (fsCodeOf(error) === "ENOENT") return; // Git's empty index.
    throw new GitCheckpointError(`cannot stat the live index for worktree diff: ${messageOf(error)}`, "git_failed");
  }
  try {
    await copyFile(repo.liveIndexPath, copyPath);
    // A second of slack also covers Git/filesystems with second-resolution
    // timestamps and floating-point rounding when setting the copy's mtime.
    await utimes(copyPath, source.atime, new Date(source.mtimeMs - 1000));
  } catch (error) {
    throw new GitCheckpointError(`cannot snapshot the live index for worktree diff: ${messageOf(error)}`, "git_failed");
  }
}

/**
 * Capture a COMPLETE binary patch with Git's own diff. `--no-ext-diff`
 * forbids external diff programs, `--no-textconv` forbids textconv drivers,
 * and the audit rejects external filters and non-EOL conversions. Tracked
 * line endings follow Git's normalization rules. When the
 * diff reads the live index, it uses a private copy because Git may refresh
 * that index's stat cache even when optional locks are disabled.
 */
export async function captureDiff(
  gitPath: string,
  root: string,
  extraArgs: readonly string[],
  spec: GitRunSpec,
  maxBytes: number,
  indexSnapshot?: { repo: ResolvedRepo; copyPath: string },
): Promise<Buffer> {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--binary", ...extraArgs];
  let diffSpec = { ...spec, maxBytes, overflowReason: "patch_too_large" as const };
  if (indexSnapshot !== undefined) {
    try {
      await copyIndexForWorktreeDiff(indexSnapshot.repo, indexSnapshot.copyPath);
    } catch (error) {
      await rm(indexSnapshot.copyPath, { force: true }).catch(() => undefined);
      throw error;
    }
    diffSpec = {
      ...diffSpec,
      extraEnv: { ...spec.extraEnv, GIT_INDEX_FILE: indexSnapshot.copyPath },
    };
  }
  let out: GitRunOutput;
  try {
    out = await runGit(gitPath, root, args, diffSpec);
  } catch (error) {
    throw error instanceof GitCheckpointError ? error : new GitCheckpointError(messageOf(error), "git_failed");
  } finally {
    if (indexSnapshot !== undefined) {
      await rm(indexSnapshot.copyPath, { force: true }).catch(() => undefined);
      await rm(`${indexSnapshot.copyPath}.lock`, { force: true }).catch(() => undefined);
    }
  }
  if (out.code !== 0 && out.code !== 1) {
    throw new GitCheckpointError(`git diff exited ${out.code}: ${out.stderr}`, "git_failed");
  }
  if (out.stderr.trim().length > 0) {
    // Any warning during capture is uncertainty — fail closed.
    throw new GitCheckpointError(`git diff produced a warning: ${out.stderr}`, "git_warning");
  }
  return out.stdout;
}

/**
 * Read the tree object id of the live index WITHOUT writing the live index
 * file. `git write-tree` may rewrite the index it reads — refreshing stale
 * stat-cache entries and updating the TREE_CACHE extension even with
 * GIT_OPTIONAL_LOCKS=0 (observed on git 2.50) — so it must never run
 * directly against the live index. Instead the live index is copied into
 * this arm's owned scratch and the COPY is written: Git rewrites its index
 * only via atomic rename, so the copy is either the complete pre-change or
 * the complete post-change file, never a torn read, and any refresh lands in
 * our own throwaway file. The emitted tree id depends only on entries'
 * (mode, path, blob) content — never on stat-cache data or index extensions
 * — so it is an exact content hash of the index entries at snapshot time.
 * A missing live index file means the empty index.
 */
export async function snapshotIndexTree(
  gitPath: string,
  repo: ResolvedRepo,
  copyPath: string,
  spec: GitRunSpec,
): Promise<string> {
  // Distinguish "no live index file yet" (the empty index) from a failed
  // copy: key the fallback on the SOURCE, not on the error code alone, so a
  // missing or unwritable destination fails closed instead of running
  // write-tree against a nonexistent GIT_INDEX_FILE.
  let srcMissing = false;
  try {
    await lstat(repo.liveIndexPath);
  } catch (error) {
    if (fsCodeOf(error) !== "ENOENT") {
      throw new GitCheckpointError(`cannot stat the live index for consistency checking: ${messageOf(error)}`, "git_failed");
    }
    srcMissing = true;
  }
  if (!srcMissing) {
    try {
      await copyFile(repo.liveIndexPath, copyPath);
    } catch (error) {
      // The source vanished between the stat and the copy, or the
      // destination is unwritable: either way, fail closed.
      throw new GitCheckpointError(`cannot snapshot the live index for consistency checking: ${messageOf(error)}`, "git_failed");
    }
  }
  let out: GitRunOutput;
  try {
    out = await runGit(gitPath, repo.root, ["write-tree"], { ...spec, extraEnv: { GIT_INDEX_FILE: copyPath } });
  } catch (error) {
    throw error instanceof GitCheckpointError ? error : new GitCheckpointError(messageOf(error), "git_failed");
  }
  if (out.code !== 0 || out.stderr.trim().length > 0) {
    // Any warning during capture is uncertainty — fail closed.
    throw new GitCheckpointError(`git write-tree failed or warned: ${out.stderr || `exit ${out.code}`}`, "git_warning");
  }
  const treeId = out.stdout.toString("utf8").trim();
  // An empty or malformed id would make both snapshots trivially equal and
  // silently disable the index-stability check — fail closed instead.
  if (!OID_RE_40.test(treeId) && !OID_RE_64.test(treeId)) {
    throw new GitCheckpointError(`git write-tree did not emit a valid object id: ${JSON.stringify(out.stdout.toString("utf8"))}`, "git_failed");
  }
  return treeId;
}

/** Read the live index tree through a uniquely named, disposable index copy. */
export async function snapshotLiveIndexTree(
  gitPath: string,
  repo: ResolvedRepo,
  scratchDir: string,
  spec: GitRunSpec,
): Promise<string> {
  const copyPath = join(scratchDir, `index-live-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    return await snapshotIndexTree(gitPath, repo, copyPath, spec);
  } finally {
    await rm(copyPath, { force: true });
    await rm(`${copyPath}.lock`, { force: true });
  }
}

/** Non-ignored untracked paths (files, symlinks, and special entries). */
export async function listUntrackedPaths(gitPath: string, root: string, spec: GitRunSpec): Promise<string[]> {
  let out: GitRunOutput;
  try {
    out = await runGit(gitPath, root, ["ls-files", "-o", "--exclude-standard", "-z"], {
      ...spec,
      maxBytes: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw error instanceof GitCheckpointError ? error : new GitCheckpointError(messageOf(error), "git_failed");
  }
  if (out.code !== 0 || out.stderr.trim().length > 0) {
    // stderr on ls-files -o means unreadable directories — a silent gap.
    throw new GitCheckpointError(`git ls-files -o failed or warned: ${out.stderr || `exit ${out.code}`}`, "git_warning");
  }
  const paths = out.stdout.toString("utf8").split("\0").filter((p) => p.length > 0);
  for (const path of paths) {
    if (!isSafeRelativePath(path)) {
      throw new GitCheckpointError(`unsafe untracked path from ls-files: ${JSON.stringify(path)}`, "git_warning");
    }
  }
  return paths;
}

/**
 * Sample the existing directory chain for a listed untracked path. A leaf
 * O_NOFOLLOW does not protect against a parent redirected outside the root.
 * Recheck identities around raw reads so a persistent rename/symlink swap
 * cannot publish bytes reached through a different directory chain.
 */
async function assertUntrackedParents(root: string, path: string, expected?: readonly StatIdentity[]): Promise<StatIdentity[]> {
  const parents = path.split("/").slice(0, -1);
  const identities: StatIdentity[] = [];
  let absolute = root;
  for (let i = 0; i < parents.length; i += 1) {
    absolute = join(absolute, parents[i]!);
    let info: Stats;
    try {
      info = await lstat(absolute);
    } catch (error) {
      throw untrackedCaptureError(path, error, "could not stat parent of");
    }
    const identity = statIdentityOf(info);
    if (!info.isDirectory() || (expected !== undefined && !sameStatIdentity(identity, expected[i]!))) {
      throw new GitCheckpointError(`untracked parent of ${path} changed or is not a directory`, "untracked_capture_race");
    }
    identities.push(identity);
  }
  return identities;
}

/**
 * Capture one untracked path exactly: no-follow stat, pre/post identity
 * check around the read, raw bytes or symlink target. Special entries
 * (fifos, sockets, devices) are refused — they cannot be represented in a
 * checkpoint and silently skipping them would be a gap.
 */
export async function captureUntrackedEntry(
  root: string,
  path: string,
  beforeRead?: (absolutePath: string) => void | Promise<void>,
  maxFileBytes?: number,
): Promise<GitCheckpointUntrackedEntry> {
  const absolute = join(root, ...path.split("/"));
  const parents = await assertUntrackedParents(root, path);
  let pre;
  try {
    pre = await lstat(absolute);
  } catch (error) {
    throw untrackedCaptureError(path, error, "could not stat");
  }
  if (pre.isSymbolicLink()) {
    try {
      await beforeRead?.(absolute);
    } catch (error) {
      throw untrackedCaptureError(path, error, "capture hook failed for");
    }
    await assertUntrackedParents(root, path, parents);
    let target: string;
    try {
      target = await readlink(absolute);
    } catch (error) {
      throw untrackedCaptureError(path, error, "could not read symlink target for");
    }
    // readlink decodes target bytes as UTF-8 (lossy): an invalid sequence
    // becomes U+FFFD and cannot be written back byte-for-byte. Refuse it
    // instead of storing a mangled target that restore would reproduce
    // while still reporting ok.
    if (target.includes("\uFFFD")) {
      throw new GitCheckpointError(
        `untracked symlink ${path} has a target that is not valid UTF-8; its bytes cannot be preserved`,
        "unsupported_untracked_entry",
      );
    }
    // A symlink target cannot be rewritten in place, so a stable inode means
    // the target just read is the one the pre-stat described. A symlink
    // replaced between the lstat and the readlink (new inode/timestamps) is a
    // capture race and must fail closed like the regular-file branch.
    let post;
    try {
      post = await lstat(absolute);
    } catch (error) {
      throw untrackedCaptureError(path, error, "could not re-stat after reading the symlink target for");
    }
    await assertUntrackedParents(root, path, parents);
    if (!sameStatIdentity(statIdentityOf(post), statIdentityOf(pre))) {
      throw new GitCheckpointError(`untracked path ${path} changed while being captured`, "untracked_capture_race");
    }
    return { path, kind: "symlink", mode: pre.mode, dev: pre.dev, ino: pre.ino, size: pre.size, mtimeMs: pre.mtimeMs, ctimeMs: pre.ctimeMs, target };
  }
  if (!pre.isFile()) {
    throw new GitCheckpointError(`untracked path ${path} is a special file; only regular files and symlinks are checkpointable`, "unsupported_untracked_entry");
  }
  try {
    await beforeRead?.(absolute);
  } catch (error) {
    throw untrackedCaptureError(path, error, "capture hook failed for");
  }
  await assertUntrackedParents(root, path, parents);
  let bytes: Buffer;
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error): never => {
    throw untrackedCaptureError(path, error, "could not open");
  });
  try {
    const stat = await handle.stat();
    const openedIdentity = statIdentityOf(stat);
    // Windows path lstat may report dev=0 while fstat of the same inode
    // reports a volume ID. Keep every other field and the path re-stat check.
    if (process.platform === "win32" && pre.dev === 0) openedIdentity.dev = 0;
    if (!sameStatIdentity(openedIdentity, statIdentityOf(pre))) {
      throw new GitCheckpointError(`untracked path ${path} changed while being captured`, "untracked_capture_race");
    }
    await assertUntrackedParents(root, path, parents);
    // Fail before allocating: a single file over the cap can never fit in
    // the bounded capture budget.
    if (maxFileBytes !== undefined && stat.size > maxFileBytes) {
      throw new GitCheckpointError(
        `untracked path ${path} is ${stat.size} bytes, exceeding the ${maxFileBytes}-byte cap`,
        "untracked_too_large",
      );
    }
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(bytes, offset, stat.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) {
      throw new GitCheckpointError(`untracked path ${path} changed while being captured`, "untracked_capture_race");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  let post;
  try {
    post = await lstat(absolute);
  } catch (error) {
    throw untrackedCaptureError(path, error, "could not re-stat after read");
  }
  await assertUntrackedParents(root, path, parents);
  if (!sameStatIdentity(statIdentityOf(post), statIdentityOf(pre))) {
    throw new GitCheckpointError(`untracked path ${path} changed while being captured`, "untracked_capture_race");
  }
  return { path, kind: "file", mode: pre.mode, dev: pre.dev, ino: pre.ino, size: pre.size, mtimeMs: pre.mtimeMs, ctimeMs: pre.ctimeMs, contentB64: bytes.toString("base64") };
}

export function untrackedCaptureError(path: string, error: unknown, verb: string): GitCheckpointError {
  const code = fsCodeOf(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new GitCheckpointError(`${verb} ${path}: path disappeared during capture`, "untracked_capture_race");
  }
  return new GitCheckpointError(`${verb} ${path}: ${messageOf(error)}`, "untracked_unreadable");
}
