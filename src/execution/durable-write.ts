import { randomUUID } from "node:crypto";
import { link, open, mkdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Durable atomic write policy for recovery-critical execution records.
 *
 * Guarantees, in order:
 *   1. Write the full body to a same-directory exclusive temp file (mode 0o600).
 *   2. fsync the temp file so its content survives power loss.
 *   3. Close the temp file.
 *   4. Atomically rename the temp file over the target.
 *   5. Best-effort fsync of the parent directory so the rename itself survives
 *      power loss (some filesystems refuse directory fsync; the rename still
 *      protects readers from partially written content).
 *
 * Temp files are removed on any failure before the rename completes (and only
 * when this invocation created them), so a failed write never litters the
 * directory and never damages the previous target contents. Callers keep
 * ownership of serialization and write ordering; this helper only strengthens
 * the durability of each individual write.
 *
 * `atomicWriteExclusive` provides the same durability for exclusive-create
 * publication (atomic hard-link of fsynced staged content onto the final
 * target, e.g. lease acquisition).
 */

/** Stages at which a fault may be injected for deterministic testing. */
export type DurableWriteStage =
  | "after_temp_write"
  | "after_file_sync"
  | "before_rename"
  | "after_rename"
  | "before_dir_sync";

export interface DurableWriteHooks {
  afterTempWrite?: () => void | Promise<void>;
  afterFileSync?: () => void | Promise<void>;
  beforeRename?: () => void | Promise<void>;
  afterRename?: () => void | Promise<void>;
  beforeDirSync?: () => void | Promise<void>;
}

export interface DurableWriteOptions {
  /** Per-call fault-injection hooks; run after the global test hook at the same stage. */
  hooks?: DurableWriteHooks;
  /**
   * Test-only override for the temp-file suffix (replaces the random UUID).
   * Lets deterministic tests pre-create the exact temp path to prove that a
   * collision never deletes a file this invocation does not own.
   */
  tempSuffixForTesting?: string;
}

type GlobalFaultInjection = (stage: DurableWriteStage, path: string) => void | Promise<void>;

let globalFaultInjectionForTesting: GlobalFaultInjection | undefined;

/**
 * Test-only global fault injection applied to every durable write.
 * Pass undefined to clear. Never call from production code.
 */
export function setDurableWriteFaultInjectionForTesting(injection: GlobalFaultInjection | undefined): void {
  globalFaultInjectionForTesting = injection;
}

async function runStage(
  stage: DurableWriteStage,
  path: string,
  hooks: DurableWriteHooks | undefined,
  key: keyof DurableWriteHooks,
): Promise<void> {
  const injected = globalFaultInjectionForTesting;
  if (injected) await injected(stage, path);
  const hook = hooks?.[key];
  if (hook) await hook();
}

/**
 * Atomically replace `path` with `body`, durably.
 * See the module documentation for the exact durability guarantees.
 */
export async function atomicWrite(path: string, body: string, options: DurableWriteOptions = {}): Promise<void> {
  const hooks = options.hooks;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = options.tempSuffixForTesting !== undefined
    ? `${path}.tmp.${options.tempSuffixForTesting}`
    : `${path}.tmp.${randomUUID()}`;
  let file: FileHandle | undefined;
  // Only unlink a temp file this invocation actually created; a pre-existing
  // collision at the temp path belongs to someone else and must be preserved.
  let ownsTemp = false;
  try {
    file = await open(temporary, "wx", 0o600);
    ownsTemp = true;
    await file.writeFile(body, "utf8");
    await runStage("after_temp_write", path, hooks, "afterTempWrite");
    await file.sync();
    await runStage("after_file_sync", path, hooks, "afterFileSync");
    await file.close();
    file = undefined;
    await runStage("before_rename", path, hooks, "beforeRename");
    await rename(temporary, path);
    ownsTemp = false;
    await runStage("after_rename", path, hooks, "afterRename");
  } catch (error) {
    if (file) await file.close().catch(() => undefined);
    // The temp file must never outlive a failed write; the previous target
    // contents are untouched because the rename has not happened yet (or the
    // hook fired after an already-completed rename, in which case the temp
    // path no longer exists).
    if (ownsTemp) await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await bestEffortDirectorySync(path, hooks);
}

/**
 * Durably publish `path` exclusively. The complete body is staged and fsynced
 * in an owned same-directory temp file before an atomic hard-link creates the
 * final name; `link` supplies EEXIST semantics (fails when the target exists)
 * without ever exposing partial final-file contents to readers or leaving an
 * invalid final record behind on abrupt termination. The temp file is removed
 * after publication on a best-effort basis, and the parent directory is
 * best-effort fsynced.
 *
 * Failure semantics: before publication, failures clean only the owned temp
 * file and leave the final path absent; a pre-existing target is someone
 * else's claim and must be left untouched (EEXIST). `link()` requires
 * hard-link support on the target filesystem (available on local
 * worktree/tmp filesystems; may fail with EPERM/ENOTSUP on exFAT or some
 * network mounts).
 * After `link` succeeds the write is committed: later temp-name cleanup never
 * fails the call, so callers never see "acquisition failed" while a published
 * claim naming their own identity already exists.
 */
export async function atomicWriteExclusive(path: string, body: string, options: DurableWriteOptions = {}): Promise<void> {
  const hooks = options.hooks;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = options.tempSuffixForTesting !== undefined
    ? `${path}.tmp.${options.tempSuffixForTesting}`
    : `${path}.tmp.${randomUUID()}`;
  let file: FileHandle | undefined;
  // Only unlink a temp file this invocation actually created; a pre-existing
  // collision at the temp path belongs to someone else and must be preserved.
  let ownsTemp = false;
  try {
    file = await open(temporary, "wx", 0o600);
    ownsTemp = true;
    await file.writeFile(body, "utf8");
    await runStage("after_temp_write", path, hooks, "afterTempWrite");
    await file.sync();
    await runStage("after_file_sync", path, hooks, "afterFileSync");
    await file.close();
    file = undefined;
    // Atomic exclusive publication: the fully fsynced staged content becomes
    // visible at the final path in one step, or not at all.
    await runStage("before_rename", path, hooks, "beforeRename");
    await link(temporary, path);
    // link() is the commit point. Do not report failure after the final claim
    // exists, and always continue to the directory fsync.
    await runStage("after_rename", path, hooks, "afterRename").catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    ownsTemp = false;
  } catch (error) {
    if (file) await file.close().catch(() => undefined);
    if (ownsTemp) await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await bestEffortDirectorySync(path, hooks);
}

/** fsync the parent directory so the rename is durable; best-effort only. */
async function bestEffortDirectorySync(path: string, hooks: DurableWriteHooks | undefined): Promise<void> {
  try {
    await runStage("before_dir_sync", path, hooks, "beforeDirSync");
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Some filesystems do not permit directory fsync; the atomic rename still
    // protects readers from partial content.
  }
}
