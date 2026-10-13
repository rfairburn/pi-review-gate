import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, renameSync, rmSync, rmdirSync, type BigIntStats } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Track helpers as well as their I/O: a rejected helper can leave nested writes running. */
export class BundleInitialization {
  private readonly pending = new Set<Promise<unknown>>();

  run<T>(operation: () => Promise<T>): Promise<T> {
    // A synchronous setup exception retains its original precedence; previously started
    // operations are already tracked and the caller will drain them in its catch path.
    const promise = operation();
    this.pending.add(promise);
    // Attach a rejection handler immediately, including during synchronous array setup.
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  mkdir(...args: Parameters<typeof mkdir>) { return this.run(() => mkdir(...args)); }
  writeFile(...args: Parameters<typeof writeFile>) { return this.run(() => writeFile(...args)); }
  rm(...args: Parameters<typeof rm>) { return this.run(() => rm(...args)); }
  access(...args: Parameters<typeof access>) { return this.run(() => access(...args)); }

  async drain(): Promise<void> {
    // Helpers may schedule more work after an awaited mkdir/access. Do not take just one snapshot.
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

type Identity = { dev: bigint; ino: bigint };
interface OwnedDirectory {
  path: string;
  descriptor?: number;
  identity?: Identity;
  uncertainty?: unknown;
}

function identity(stats: BigIntStats): Identity {
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || typeof stats.dev !== "bigint" || stats.dev < 0n
    || typeof stats.ino !== "bigint" || stats.ino <= 0n) {
    throw new Error("directory identity unavailable or unsafe");
  }
  return { dev: stats.dev, ino: stats.ino };
}

function same(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Exclusive allocation + immediate no-follow identity capture. Synchronous calls prevent
 * in-process interleaving, not external process races. Ownership assumes no hostile
 * external same-UID mutation during allocation/capture (for bundle and cleanup roots)
 * or private cleanup. Public Node APIs lack an atomic creation-bound directory handle:
 * substitution between mkdtempSync and the first lstatSync can be captured as owned
 * and later recursively deleted. Detected substitutions, symlinks, or failed capture
 * instead leave identity uncertain and refuse recursive deletion.
 */
export function allocateBundleRoot(prefix: string): OwnedDirectory {
  const owned: OwnedDirectory = { path: mkdtempSync(prefix) };
  try {
    const created = identity(lstatSync(owned.path, { bigint: true }));
    // Pin the inode against reuse until cleanup/initialization finishes. If directory handles
    // are unsupported, initialization can still succeed, but deletion must refuse uncertainty.
    owned.descriptor = openSync(owned.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
    const opened = identity(fstatSync(owned.descriptor, { bigint: true }));
    if (!same(created, opened)) throw new Error("directory changed during ownership capture");
    owned.identity = created;
    assertOwned(owned);
  } catch (error) {
    owned.identity = undefined;
    owned.uncertainty = error;
  }
  return owned;
}

function assertOwned(owned: OwnedDirectory, path = owned.path): void {
  if (!owned.identity || owned.descriptor === undefined) {
    throw new Error("creation ownership is uncertain", { cause: owned.uncertainty });
  }
  if (!same(owned.identity, identity(fstatSync(owned.descriptor, { bigint: true })))
    || !same(owned.identity, identity(lstatSync(path, { bigint: true })))) {
    throw new Error("directory was replaced; cleanup refused");
  }
}

function warn(path: string, error: unknown, relocatedPath?: string): void {
  // Diagnostics must never replace the initialization error, even with a failing log sink.
  try {
    console.warn("Review bundle initialization cleanup unconfirmed; preserving remaining resources", {
      path, ...(relocatedPath ? { relocationTarget: relocatedPath } : {}), error,
    });
  } catch { /* preserve the original initialization error */ }
}

export function releaseBundleRoot(owned: OwnedDirectory): void {
  if (owned.descriptor !== undefined) {
    try { closeSync(owned.descriptor); } catch (error) { warn(owned.path, error); }
    owned.descriptor = undefined;
  }
}

/**
 * Never recursively delete the public temp pathname after a check. Move it into a
 * fresh private directory and verify the moved inode first: detected substitution
 * between the check and rename is preserved, not recursively removed. Ownership
 * assumes no hostile external same-UID mutation during allocation/identity capture
 * of either root or private cleanup, as described by allocateBundleRoot above.
 * All final proof and deletion steps are synchronous: they prevent in-process
 * interleaving, not external races. Public Node APIs lack an atomic creation-bound
 * directory handle and fd-relative recursive deletion; this fence cannot protect
 * against pre-capture substitution or private-directory mutation during cleanup.
 * Detected substitutions, symlinks, and uncertain capture still preserve/refuse;
 * callers still settle all started work and retain the original initialization error.
 */
export function cleanupFailedBundleRoot(owned: OwnedDirectory): void {
  let quarantine: OwnedDirectory | undefined;
  let relocatedPath: string | undefined;
  try {
    assertOwned(owned);
    quarantine = allocateBundleRoot(join(dirname(owned.path), ".pi-review-gate-init-cleanup-"));
    assertOwned(quarantine);
    assertOwned(owned);
    relocatedPath = join(quarantine.path, "bundle");
    renameSync(owned.path, relocatedPath);
    assertOwned(quarantine);
    assertOwned(owned, relocatedPath);
    rmSync(relocatedPath, { recursive: true, force: false });
    // rm success alone is not an absence oracle.
    try {
      lstatSync(relocatedPath);
      throw new Error("bundle still exists after removal");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    relocatedPath = undefined;
  } catch (error) {
    warn(owned.path, error, relocatedPath);
  } finally {
    if (quarantine) {
      try {
        assertOwned(quarantine);
        // Nonrecursive: a substituted or uncertain moved root must survive intact.
        rmdirSync(quarantine.path);
      } catch (error) {
        warn(quarantine.path, error, relocatedPath);
      }
      releaseBundleRoot(quarantine);
    }
  }
}
