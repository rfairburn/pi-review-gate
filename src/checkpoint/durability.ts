/**
 * #233: durable record publication (extracted from git-checkpoint.ts).
 * Atomic temp-file -> fsync -> rename -> directory-fsync publication of the
 * encoded checkpoint record, plus the ancestor-chain directory syncs that
 * keep newly created scratch entries durable.
 */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { GitCheckpointError, messageOf } from "./errors";

/**
 * Atomically and durably publish the encoded record as `record.json` inside
 * this arm's owned scratch directory: write a temp file in the SAME
 * directory (so the rename is atomic on one filesystem), fsync the file,
 * rename it over the final name, then fsync the directory so the directory
 * entry itself is durable. Any step failing throws after removing ONLY this
 * arm's temp file; the caller then runs cleanupAfterFailedArm (pin + this
 * arm's scratch). A crash at any point leaves either no record or the
 * complete one — never a torn file.
 */
export async function publishRecordDurable(scratchDir: string, encoded: string): Promise<void> {
  const finalPath = join(scratchDir, "record.json");
  const tmpPath = join(scratchDir, `.record.json.tmp-${randomBytes(6).toString("hex")}`);
  let handle;
  try {
    handle = await open(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    await handle.writeFile(encoded, "utf8");
    await handle.sync(); // file contents durable before the rename
    await handle.close();
    handle = undefined;
    await rename(tmpPath, finalPath); // atomic replacement within one directory
    await syncDirectory(scratchDir); // directory entry durable
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    // Remove only THIS arm's temp file; the caller cleans up pin + scratch.
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw new GitCheckpointError(`cannot durably publish checkpoint record: ${messageOf(error)}`, "git_failed");
  }
}

/** fsync a directory so a rename into it is durable where supported. */
async function syncDirectory(dir: string): Promise<void> {
  const dirHandle = await open(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    try {
      await dirHandle.sync();
    } catch (error) {
      // Windows can reject directory fsync. File fsync remains required, but
      // without this flush a newly created directory entry may not survive a crash.
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  } finally {
    await dirHandle.close().catch(() => undefined);
  }
}

/**
 * Flush a loose Git object created for a synthetic checkpoint baseline.
 * Git's ordinary loose-object write is atomic, but an arm must not publish a
 * pin to a newly-created synthetic commit until the object bytes and their
 * directory entries have been synced. On Windows, Git's write-time fsync is
 * used instead of flushing a read-only handle; the caller must first verify
 * that its Git version supports the forced core.fsync settings. A missing
 * loose object is allowed for a shared tree object already available from a
 * pack/alternate; a synthetic commit is unique per arm and must be loose here.
 */
export async function syncLooseGitObject(objectsDir: string, oid: string, required: boolean, fileSyncByGit = false): Promise<boolean> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error("invalid Git object id for durability sync");
  const shard = join(objectsDir, oid.slice(0, 2));
  const objectPath = join(shard, oid.slice(2));
  let before;
  try {
    before = await lstat(objectPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (required) throw new Error("new synthetic checkpoint commit is missing from loose object storage");
      return false;
    }
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Git loose object is not a regular file");

  const handle = await open(objectPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    // On Windows, path lstat can report dev=0 while fstat identifies the
    // volume. Normalize only that path-stat zero; all other identity fields
    // and nonzero device comparisons remain strict.
    const openedDev = process.platform === "win32" && before.dev === 0 ? before.dev : opened.dev;
    if (!opened.isFile() || openedDev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("Git loose object changed while syncing its durability");
    }
    if (!fileSyncByGit) await handle.sync();
  } finally {
    await handle.close();
  }

  // The object bytes must reach stable storage before its pathname and any
  // newly-created two-hex shard become durable.
  await syncDirectory(shard);
  await syncDirectory(objectsDir);
  return true;
}

/**
 * Make newly created directory entries in the owned scratch chain durable:
 * an entry becomes durable only when its PARENT directory is fsynced, so
 * every ancestor of `dir` up to and including `stopAt` (the git dir) is
 * synced. Without this, a power loss could leave the arm/window directories
 * themselves half-materialized even though the record file inside them was
 * fully durable.
 */
export async function syncAncestorChain(dir: string, stopAt: string): Promise<void> {
  let current = dirname(dir);
  while (true) {
    await syncDirectory(current);
    if (current === stopAt) return;
    const parent = dirname(current);
    if (parent === current) return; // filesystem root reached
    current = parent;
  }
}
