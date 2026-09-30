/**
 * #233: worktree content access for checkpoints (extracted from
 * git-checkpoint.ts). Symlink-parent containment refusal, no-follow worktree
 * file reads with post-read identity checks, capped object-store blob reads,
 * and Git-cleaned comparison bytes in a disposable object directory.
 */

import { constants, type Stats } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { GitCheckpointError, fsCodeOf, messageOf } from "./errors";
import { sameStatIdentity, statIdentityOf } from "./record";
import { runGit, runGitWithInput, type GitRunSpec } from "./run-git";
import type { ResolvedRepo } from "./audit";

/** Cap for a single blob materialized during restore/compare. */
export const MAX_BLOB_BYTES = 512 * 1024 * 1024;

/**
 * Refuse to create or replace anything whose parent chain would leave the
 * repository through a symlinked component. Git's own checkout refuses
 * leading-symlink paths; direct fs writes would otherwise follow the link
 * and clobber files outside repo.root while still reporting success.
 */
export async function assertContainedParents(root: string, absolute: string): Promise<void> {
  const rel = relative(root, absolute);
  // Only genuine parent traversal is refused: a top-level name that merely
  // begins with dots ("..env", "...") is legal and stays contained.
  if (rel.length === 0 || isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    throw new GitCheckpointError(`path ${absolute} escapes the repository root`, "restore_path_conflict");
  }
  const parts = rel.split("/");
  let prefix = root;
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = join(prefix, parts[i]!);
    let stat;
    try {
      stat = await lstat(prefix);
    } catch (error) {
      if (fsCodeOf(error) === "ENOENT") break; // created later by mkdir -p
      throw new GitCheckpointError(`cannot stat parent of ${absolute}: ${messageOf(error)}`, "git_failed");
    }
    if (stat.isSymbolicLink()) {
      throw new GitCheckpointError(
        `parent component '${parts.slice(0, i + 1).join("/")}' of ${absolute} is a symlink; refusing to write through it`,
        "restore_path_conflict",
      );
    }
  }
}

/** Read a worktree file no-follow, failing closed on races. */
export async function readWorktreeFile(
  absolute: string,
  path: string,
  maxBytes?: number,
  afterRead?: (absolutePath: string) => void | Promise<void>,
): Promise<Buffer> {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error): never => {
    throw new GitCheckpointError(`cannot open ${path} for comparison: ${messageOf(error)}`, "git_failed");
  });
  let pre: Stats;
  let bytes: Buffer;
  try {
    pre = await handle.stat();
    // Fail before allocating (at the allocation site, so a concurrent grow
    // cannot slip past a caller-side size check): a file over the cap can
    // never be materialized in the bounded review budget.
    if (maxBytes !== undefined && pre.size > maxBytes) {
      throw new GitCheckpointError(
        `worktree file ${path} is ${pre.size} bytes, exceeding the ${maxBytes}-byte cap`,
        "git_failed",
      );
    }
    bytes = Buffer.alloc(pre.size);
    let offset = 0;
    while (offset < pre.size) {
      const { bytesRead } = await handle.read(bytes, offset, pre.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // A short read means the file shrank under us: the buffer would be
    // zero-padded garbage, so fail closed instead of returning it.
    if (offset !== pre.size) {
      throw new GitCheckpointError(`worktree file ${path} changed while being read`, "git_failed");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  // Deterministic fault seam (tests only): a mutation landing here must be
  // caught by the post-read identity check below.
  try {
    await afterRead?.(absolute);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new GitCheckpointError(`tracked-read hook failed for ${path}: ${messageOf(error)}`, "git_failed");
  }
  // Post-read identity check: a concurrent rewrite that preserved the
  // open-time size (grow, truncate+rewrite) would otherwise yield stale
  // bytes with no detectable gap.
  let post: Stats;
  try {
    post = await lstat(absolute);
  } catch (error) {
    if (fsCodeOf(error) === "ENOENT") {
      throw new GitCheckpointError(`worktree file ${path} vanished while being read`, "git_failed");
    }
    throw new GitCheckpointError(`cannot re-stat ${path} after reading: ${messageOf(error)}`, "git_failed");
  }
  const preIdentity = statIdentityOf(pre);
  // Windows path lstat may report dev=0 while fstat of the same inode
  // reports a volume ID (the NTFS quirk already normalized for untracked
  // capture): zero the open-time dev when the path re-stat sees 0, keeping
  // every other identity field strict. POSIX behavior is unchanged.
  if (process.platform === "win32" && post.dev === 0) preIdentity.dev = 0;
  if (!sameStatIdentity(statIdentityOf(post), preIdentity)) {
    throw new GitCheckpointError(`worktree file ${path} changed while being read`, "git_failed");
  }
  return bytes;
}

/** Read one blob from the object store, capped. */
export async function catFileBlob(gitPath: string, root: string, oid: string, spec: GitRunSpec): Promise<Buffer> {
  const out = await runGit(gitPath, root, ["cat-file", "blob", oid], { ...spec, maxBytes: MAX_BLOB_BYTES, overflowReason: "git_failed" });
  if (out.code !== 0) throw new GitCheckpointError(`cat-file blob ${oid} failed: ${out.stderr}`, "git_failed");
  return out.stdout;
}

/** Clean changed tracked bytes with Git, without writing into the repository's object store. */
export async function cleanTrackedComparisonBytes(
  gitPath: string, repo: ResolvedRepo, path: string, bytes: Buffer, scratchDir: string, spec: GitRunSpec,
): Promise<Buffer> {
  // Git's text=auto binary detection and EOL rules cannot safely be
  // duplicated by a blanket CRLF replacement. Write the filtered blob only
  // to an owned, disposable object directory; never to the live object store
  // or index. Unchanged paths never enter this function.
  const objects = await mkdtemp(join(scratchDir, "compare-clean-"));
  try {
    const objectSpec = { ...spec, extraEnv: { ...spec.extraEnv, GIT_OBJECT_DIRECTORY: objects } };
    const out = await runGitWithInput(
      gitPath, repo.root, ["hash-object", "-w", "--stdin", `--path=${path}`], bytes,
      { ...objectSpec, maxBytes: 1024 }, {},
    );
    const oid = out.stdout.toString("ascii").trim();
    if (out.code !== 0 || out.stderr.trim() || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
      throw new GitCheckpointError(`cannot clean tracked path ${path}: ${out.stderr || `hash-object exit ${out.code}`}`, "git_failed");
    }
    return await catFileBlob(gitPath, repo.root, oid, objectSpec);
  } finally {
    await rm(objects, { recursive: true, force: true });
  }
}
