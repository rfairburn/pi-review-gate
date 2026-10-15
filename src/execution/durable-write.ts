import { randomUUID } from "node:crypto";
import { link, open, mkdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { syncDirectoryBestEffort } from "../file-publication";

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
 * Staged files are created mode 0o600. A caller whose record already published
 * with the filesystem's default mode opts in to `useDefaultFileMode` to keep
 * publishing exactly that mode; callers that do not opt in are unaffected.
 *
 * `atomicWriteExclusive` provides the same durability for exclusive-create
 * publication (atomic hard-link of fsynced staged content onto the final
 * target, e.g. lease acquisition).
 *
 * Both facades run one shared internal owned-temp publication lifecycle
 * (`publishStaged`); the commit primitive is their only mechanical difference.
 * The best-effort parent-directory sync is shared with the other publication
 * consumers in `src/file-publication.ts`. Per-writer policy — staged naming,
 * staged mode, mkdir, cleanup ownership, error precedence, serialization —
 * stays in this module and at its call sites.
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
  /**
   * Opt in to the filesystem's default file mode — `0o666` masked by the
   * process umask, exactly what a plain `fs.writeFile` produces — instead of
   * this helper's owner-only `0o600`. This exists only so a caller can keep
   * publishing a record with the mode it already used; omitting it (every
   * other caller) keeps the restrictive `0o600` default. The mode applies to
   * the staged file, so the published target carries the same mode either way.
   */
  useDefaultFileMode?: boolean;
}

/** Owner-only staged-file mode unless a caller opts in to the default mode. */
const DEFAULT_FILE_MODE = 0o600;

/**
 * Mode handed to the exclusive temp-file open. `undefined` makes the platform
 * apply `0o666` masked by the process umask, matching a plain `fs.writeFile`.
 */
function stagedFileMode(options: DurableWriteOptions): number | undefined {
  return options.useDefaultFileMode ? undefined : DEFAULT_FILE_MODE;
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
 * Which commit primitive publishes the staged file. The facade a caller chooses
 * is the only place this decision is made — never a runtime feature flag.
 */
type StagedPublication = "replace" | "exclusive";

/**
 * Atomically replace `path` with `body`, durably.
 * See the module documentation for the exact durability guarantees.
 */
export async function atomicWrite(path: string, body: string, options: DurableWriteOptions = {}): Promise<void> {
  await publishStaged(path, body, options, "replace");
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
  await publishStaged(path, body, options, "exclusive");
}

/**
 * The single owned-temp publication lifecycle behind both facades: create the
 * staged file exclusively in the target's own directory (mode 0o600, or the
 * platform default for the `useDefaultFileMode` opt-in), write, fsync and close
 * it, run the caller's hooks in their established positions, commit with the
 * facade's primitive, then best-effort fsync the parent directory.
 *
 * The `publication` parameter is the only difference between the facades:
 *   - `replace` commits with `rename` and then reports an `afterRename` hook
 *     failure. The rename consumes the staged name, so cleanup never runs.
 *   - `exclusive` commits with `link`. Once the link succeeds the write is
 *     committed, so a post-commit hook failure is swallowed and the staged-name
 *     cleanup is best-effort: neither may turn a published claim into a reported
 *     acquisition failure.
 *
 * Both keep the same ownership rule and error precedence: only a staged file
 * this invocation created (ownership begins when the exclusive create succeeds)
 * is ever unlinked, a failing close can never replace the publication error, and
 * the previous target bytes stay untouched until the commit.
 */
async function publishStaged(
  path: string,
  body: string,
  options: DurableWriteOptions,
  publication: StagedPublication,
): Promise<void> {
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
    file = await open(temporary, "wx", stagedFileMode(options));
    ownsTemp = true;
    await file.writeFile(body, "utf8");
    await runStage("after_temp_write", path, hooks, "afterTempWrite");
    await file.sync();
    await runStage("after_file_sync", path, hooks, "afterFileSync");
    await file.close();
    file = undefined;
    await runStage("before_rename", path, hooks, "beforeRename");
    if (publication === "exclusive") {
      // Atomic exclusive publication: the fully fsynced staged content becomes
      // visible at the final path in one step, or not at all.
      await link(temporary, path);
      // link() is the commit point. Do not report failure after the final claim
      // exists, and always continue to the directory fsync.
      await runStage("after_rename", path, hooks, "afterRename").catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      ownsTemp = false;
    } else {
      await rename(temporary, path);
      ownsTemp = false;
      await runStage("after_rename", path, hooks, "afterRename");
    }
  } catch (error) {
    if (file) await file.close().catch(() => undefined);
    // The temp file must never outlive a failed write; the previous target
    // contents are untouched because the commit has not happened yet (or, for
    // the replace writer, the hook fired after an already-completed rename, in
    // which case the temp path no longer exists).
    if (ownsTemp) await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectoryBestEffort(dirname(path), {
    beforeSync: () => runStage("before_dir_sync", path, hooks, "beforeDirSync"),
  });
}
