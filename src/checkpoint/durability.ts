/**
 * #233: durable record publication (extracted from git-checkpoint.ts).
 * Atomic temp-file -> fsync -> rename -> directory-fsync publication of the
 * encoded checkpoint record, plus the ancestor-chain directory syncs that
 * keep newly created scratch entries durable.
 */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
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
  const dirHandle = await open(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
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
