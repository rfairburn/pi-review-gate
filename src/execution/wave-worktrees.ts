import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { WaveCaptureResult } from "./wave-repository";
import { GIT_NO_LOCKS_ENV as GIT_ENV, validateSafeId } from "./wave-validation";

const execFileAsync = promisify(execFile);

/** All-zero object name used as the expected-old-value for create-only ref updates. */
const SHA1_ZERO_SHA = "0000000000000000000000000000000000000000";
const SHA256_ZERO_SHA = "0".repeat(64);

const zeroShaCache = new Map<string, string>();

/** Resolve the all-zero object name for a repository's object format. */
async function zeroShaFor(repoPath: string): Promise<string> {
  const cached = zeroShaCache.get(repoPath);
  if (cached) return cached;
  const format = await gitOut(["rev-parse", "--show-object-format"], repoPath).catch(() => "sha1");
  const zero = format.trim() === "sha256" ? SHA256_ZERO_SHA : SHA1_ZERO_SHA;
  zeroShaCache.set(repoPath, zero);
  return zero;
}

// ── types ────────────────────────────────────────────────────────────────────

/** Result of creating a worker worktree. */
export interface WorkerWorktree {
  /** Absolute path to the worktree root directory. */
  worktreeRoot: string;
  /** Absolute path to the effective working directory (relativeCwd resolved). */
  effectiveCwd: string;
}

/** Result of creating an integration worktree. */
export interface IntegrationWorktree {
  /** Absolute path to the worktree root directory. */
  worktreeRoot: string;
  /** Absolute path to the effective working directory (relativeCwd resolved). */
  effectiveCwd: string;
}

/** Validate that a path stays under the wave root (using resolved real paths). */
async function assertUnderWaveRoot(path: string, waveRoot: string): Promise<void> {
  const resolvedPath = await fs.realpath(path);
  const resolvedRoot = await fs.realpath(waveRoot);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === ".." || rel.startsWith(".." + sep) || rel === "") {
    throw new Error(
      `Path "${path}" is not under wave root "${waveRoot}".`,
    );
  }
}

/** Lexical containment check: reject absolute or traversal paths before mkdir. */
function assertPathWithin(path: string, root: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) {
    throw new Error(`Path "${path}" is not within "${root}".`);
  }
}

/**
 * Preflight containment check before mkdir: resolve the nearest existing
 * ancestor and verify it stays under waveRoot. This prevents mkdir from
 * following symlinks outside the wave root before the post-check can reject.
 */
async function assertCreationPathUnderWaveRoot(path: string, waveRoot: string): Promise<void> {
  assertPathWithin(path, waveRoot);
  const resolvedRoot = await fs.realpath(waveRoot);
  let existing = resolve(path);
  for (;;) {
    try {
      const resolved = await fs.realpath(existing);
      const rel = relative(resolvedRoot, resolved);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) {
        throw new Error(`Path "${path}" is not under wave root "${waveRoot}".`);
      }
      return;
    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr.code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

// ── git helpers ──────────────────────────────────────────────────────────────

/** Run a git command (shell-free, via execFile). */
async function gitCmd(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<void> {
  await execFileAsync(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, ...GIT_ENV, ...envOverrides },
      timeout: 30_000,
      signal,
    },
  );
}

/** Run a git command and return stdout. */
async function gitOut(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, ...GIT_ENV, ...envOverrides },
      timeout: 30_000,
      signal,
    },
  );
  return stdout.trim();
}

// ── shared Git administration coordination ───────────────────────────────────

/**
 * Resolve the canonical key for a repository's shared Git worktree
 * administration: the repository's common Git directory.
 *
 * Managed worktrees of one captured repository are registered under
 * `<common-dir>/worktrees`, so that directory is the coordination unit and two
 * different repositories produce two independent keys. The captured repository
 * is the private bare repository itself, and the repository's existing
 * worktree identity checks (worker/candidate/salvage validation compare
 * `rev-parse --git-common-dir` against it) establish that its canonical real
 * path already is that common directory. Resolving the path locally therefore
 * needs no extra Git command, no environment override, and no configuration
 * change; Git keeps enforcing its own on-disk locking.
 */
async function repositoryAdministrationKey(repoPath: string): Promise<string> {
  const resolved = resolve(repoPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Process-local serialization for operations on one repository's shared Git
 * worktree administration (`worktrees/` and the registration entries inside
 * it).
 *
 * Git publishes a new worktree's registration files in place and non-atomically
 * (`gitdir` before `commondir`, each created then written), while any command
 * that enumerates worktrees reads every entry's `commondir` and head. A
 * concurrent `git worktree add` in the same repository can therefore scan the
 * administration directory while another is still publishing the entry it
 * reads — Git reports `failed to read worktrees/<id>/commondir` and worker
 * startup fails (#451). The hazard is reader-side as well as writer-side, so
 * every operation that enumerates or mutates this administration — creation,
 * removal, and failed-creation cleanup — runs under this per-repository lease.
 *
 * Only Git administration is serialized. Capture, executor and reviewer work,
 * and any operation on a different repository stay concurrent, so the
 * logical worker pool keeps its capacity. The lease is process-local: it
 * coordinates concurrent startups inside one process, and it neither replaces
 * nor weakens Git's own on-disk locking.
 *
 * A waiter cancelled while queued never runs its operation, so it mutates no
 * repository metadata or worktree directory, and it leaves the queue without
 * consuming the lease. An operation that already started keeps its existing
 * cancellation behavior and cleanup, and the lease is released — including
 * after a failure — only once that operation has settled.
 */
export class GitWorktreeCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly keys = new Map<string, string>();

  /**
   * Optional observer run inside the lease, immediately before the leased
   * operation starts — the administration invocation boundary. Production
   * leaves it unset; deterministic tests install a barrier here to hold one
   * repository's administration operation while another attempt is made.
   */
  beforeOperation?: (repoPath: string) => Promise<void> | void;

  constructor(
    private readonly resolveKey: (repoPath: string) => Promise<string> = repositoryAdministrationKey,
  ) {}

  /** Run one shared-administration operation under the repository's lease. */
  async run<T>(
    repoPath: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(repoPath, signal);
    try {
      await this.beforeOperation?.(repoPath);
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Acquire the repository's administration lease. The returned release is
   * idempotent; waiting is abortable, and an aborted waiter never starts work.
   */
  async acquire(repoPath: string, signal?: AbortSignal): Promise<() => void> {
    const key = await this.administrationKey(repoPath);
    throwIfAborted(signal);

    let releaseLease!: () => void;
    const lease = new Promise<void>((resolveLease) => {
      releaseLease = resolveLease;
    });
    const previous = this.tails.get(key) ?? Promise.resolve();
    // The tail always settles: it resolves only after this waiter's own lease
    // is released, so a later caller queues behind the actual holder.
    const tail = previous.then(() => lease);
    this.tails.set(key, tail);
    const prune = () => {
      if (this.tails.get(key) !== tail) return;
      void tail.then(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    };

    try {
      await waitForSettled(previous, signal);
    } catch (error) {
      // A cancelled waiter must not retain its lease, block later callers, or
      // admit its own operation.
      releaseLease();
      prune();
      throw error;
    }

    // Cancellation that arrived while the lease was being granted still must
    // not admit work: fail closed without running the operation.
    if (signal?.aborted) {
      releaseLease();
      prune();
      throwIfAborted(signal);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseLease();
      prune();
    };
  }

  /**
   * Resolve (once per repository path) the administration key. A repository's
   * administration path is stable for the process lifetime, so later
   * operations for the same repository need no repeated filesystem
   * resolution; queue and grant ordering therefore depend only on lease state.
   */
  private async administrationKey(repoPath: string): Promise<string> {
    const cached = this.keys.get(repoPath);
    if (cached !== undefined) return cached;
    const key = await this.resolveKey(repoPath);
    this.keys.set(repoPath, key);
    return key;
  }
}

export const gitWorktreeCoordinator = new GitWorktreeCoordinator();

async function waitForSettled(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await promise;
    return;
  }
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolveWait, rejectWait) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      rejectWait(abortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(() => {
      signal.removeEventListener("abort", abort);
      resolveWait();
    }, (error) => {
      signal.removeEventListener("abort", abort);
      rejectWait(error);
    });
  });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  return error;
}

// ── worktree creation ────────────────────────────────────────────────────────

/**
 * Create a detached worker worktree at the capture base.
 *
 * The worktree is rooted under the wave root directory and checked out
 * at the base commit. The effective cwd preserves the original
 * discovery.relativeCwd (creating the directory if needed).
 */
export async function createWorkerWorktree(
  capture: WaveCaptureResult,
  taskId: string,
  signal?: AbortSignal,
): Promise<WorkerWorktree> {
  throwIfAborted(signal);
  validateSafeId(taskId, "taskId");

  const waveRoot = capture.waveRoot;
  const repoPath = capture.repositoryPath;
  const baseCommit = capture.baseCommit;
  const relativeCwd = capture.discovery.relativeCwd;

  // Worktree directory under wave root.
  const worktreeRoot = join(waveRoot, "workers", taskId);

  // Serialize with every other administration mutation of this repository.
  // The whole preparation is inside the lease so a queued (cancelled) caller
  // never touches the filesystem, and a failed creation cleans up before
  // another caller mutates the same shared metadata.
  return gitWorktreeCoordinator.run(repoPath, signal, async () => {
    // Preflight: verify existing path components stay under waveRoot.
    await assertCreationPathUnderWaveRoot(repoPath, waveRoot);
    await assertCreationPathUnderWaveRoot(worktreeRoot, waveRoot);

    // Create the worktree directory.
    await fs.mkdir(worktreeRoot, { recursive: true });

    // Ensure the worktree path stays under waveRoot (resolved real paths).
    await assertUnderWaveRoot(worktreeRoot, waveRoot);

    // Create a detached worktree at the base commit.
    try {
      await gitCmd(
        ["worktree", "add", "--detach", worktreeRoot, baseCommit],
        repoPath,
        {},
        signal,
      );
      throwIfAborted(signal);

      // Resolve and create the effective cwd.
      const effectiveCwd = relativeCwd !== "."
        ? join(worktreeRoot, relativeCwd)
        : worktreeRoot;
      assertPathWithin(effectiveCwd, worktreeRoot);
      assertPathWithin(effectiveCwd, waveRoot);
      await assertCreationPathUnderWaveRoot(effectiveCwd, waveRoot);
      await fs.mkdir(effectiveCwd, { recursive: true });
      throwIfAborted(signal);
      await assertUnderWaveRoot(effectiveCwd, waveRoot);
      return { worktreeRoot, effectiveCwd };
    } catch (error) {
      await cleanupIncompleteWorktree(repoPath, worktreeRoot);
      throw error;
    }
  });
}

/**
 * Create a detached integration worktree at the capture base.
 *
 * Similar to createWorkerWorktree but for integration tasks.
 */
export async function createIntegrationWorktree(
  capture: WaveCaptureResult,
  signal?: AbortSignal,
): Promise<IntegrationWorktree> {
  throwIfAborted(signal);
  const waveRoot = capture.waveRoot;
  const repoPath = capture.repositoryPath;
  const baseCommit = capture.baseCommit;
  const relativeCwd = capture.discovery.relativeCwd;

  // Worktree directory under wave root.
  const worktreeRoot = join(waveRoot, "integration");

  // Serialize with every other administration mutation of this repository
  // (see createWorkerWorktree).
  return gitWorktreeCoordinator.run(repoPath, signal, async () => {
    // Preflight: verify existing path components stay under waveRoot.
    await assertCreationPathUnderWaveRoot(repoPath, waveRoot);
    await assertCreationPathUnderWaveRoot(worktreeRoot, waveRoot);

    // Create the worktree directory.
    await fs.mkdir(worktreeRoot, { recursive: true });

    // Ensure the worktree path stays under waveRoot (resolved real paths).
    await assertUnderWaveRoot(worktreeRoot, waveRoot);

    // Create a detached worktree at the base commit.
    try {
      await gitCmd(
        ["worktree", "add", "--detach", worktreeRoot, baseCommit],
        repoPath,
        {},
        signal,
      );
      throwIfAborted(signal);

      const effectiveCwd = relativeCwd !== "."
        ? join(worktreeRoot, relativeCwd)
        : worktreeRoot;
      assertPathWithin(effectiveCwd, worktreeRoot);
      assertPathWithin(effectiveCwd, waveRoot);
      await assertCreationPathUnderWaveRoot(effectiveCwd, waveRoot);
      await fs.mkdir(effectiveCwd, { recursive: true });
      throwIfAborted(signal);
      await assertUnderWaveRoot(effectiveCwd, waveRoot);
      return { worktreeRoot, effectiveCwd };
    } catch (error) {
      await cleanupIncompleteWorktree(repoPath, worktreeRoot);
      throw error;
    }
  });
}

/**
 * Remove a failed or cancelled creation. The caller already holds this
 * repository's worktree administration lease, so this helper must not acquire
 * it again (that would deadlock) and must not be called elsewhere. Under that
 * lease the forced removal targets only this failed creation's own path, and
 * the prune cannot delete another in-process preparation's still-initializing
 * registration.
 */
async function cleanupIncompleteWorktree(repoPath: string, worktreeRoot: string): Promise<void> {
  await gitCmd(["worktree", "remove", "--force", worktreeRoot], repoPath).catch(() => {});
  await fs.rm(worktreeRoot, { recursive: true, force: true }).catch(() => {});
  await gitCmd(["worktree", "prune"], repoPath).catch(() => {});
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  throw error;
}

// ── worktree inspection ──────────────────────────────────────────────────────

/**
 * Check whether a worktree is clean (no staged, unstaged, or untracked changes).
 */
export async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  try {
    // Include ignored files so recovery data in ignored paths is detected.
    const status = await gitOut(
      ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"],
      worktreePath,
    );
    return status === "";
  } catch {
    // If git status fails, treat as not clean.
    return false;
  }
}

// ── worktree removal ─────────────────────────────────────────────────────────

/**
 * Conservatively remove a managed worktree.
 *
 * Only removes if the worktree is clean. Refuses dirty or untracked worktrees
 * and leaves recovery data intact. No force-remove option.
 */
export async function removeWorktree(
  worktreePath: string,
  repoPath: string,
): Promise<void> {
  // Removal deregisters the worktree in the repository's shared
  // administration, so it is serialized with concurrent registration and
  // cleanup for the same repository. The cleanliness revalidation runs inside
  // the lease, immediately before the removal: while a removal waits, ignored
  // recovery data can appear in the worktree, and Git's own non-force removal
  // does not protect ignored files.
  await gitWorktreeCoordinator.run(repoPath, undefined, async () => {
    // Check if the worktree is clean.
    const clean = await isWorktreeClean(worktreePath);
    if (!clean) {
      throw new Error(
        `Refusing to remove dirty worktree at "${worktreePath}". ` +
        `Worktree has uncommitted changes.`,
      );
    }

    // No --force: git itself refuses worktrees with untracked/modified files.
    await gitCmd(["worktree", "remove", worktreePath], repoPath);
  });
}

// ── ref pinning ──────────────────────────────────────────────────────────────

/**
 * Pin a verified commit under a stable private ref.
 *
 * For worker commits: refs/pi-review-gate/waves/<wave-id>/workers/<task-id>
 * For integration commits: refs/pi-review-gate/waves/<wave-id>/integrated
 *
 * Verifies the object is a commit before updating the ref.
 */
export async function pinCommit(
  capture: WaveCaptureResult,
  commitSha: string,
  options: { type: "worker"; taskId: string } | { type: "integration" },
  signal?: AbortSignal,
): Promise<string> {
  const waveId = capture.waveId;
  const repoPath = capture.repositoryPath;

  // Validate waveId before constructing ref.
  validateSafeId(waveId, "waveId");

  // Verify the object is a commit.
  const objectType = await gitOut(
    ["cat-file", "-t", commitSha],
    repoPath,
    {},
    signal,
  );
  if (objectType !== "commit") {
    throw new Error(
      `Refusing to pin "${commitSha}": object is a "${objectType}", not a commit.`,
    );
  }

  let refName: string;
  if (options.type === "worker") {
    validateSafeId(options.taskId, "taskId");
    refName = `refs/pi-review-gate/waves/${waveId}/workers/${options.taskId}`;
  } else {
    refName = `refs/pi-review-gate/waves/${waveId}/integrated`;
  }

  // Stable refs are create-once / idempotent-same: refuse replacing an existing
  // ref with a different SHA. Creation uses atomic create-only update-ref
  // semantics (expected old value is the all-zero object name) so concurrent
  // pinners cannot overwrite each other; a raced loser must find the same SHA
  // or fail closed. This prevents accidental or malicious ref overwrite.
  const existingSha = await gitOut(
    ["rev-parse", "--verify", refName],
    repoPath,
    {},
    signal,
  ).catch(() => "");
  if (existingSha !== "") {
    if (existingSha === commitSha) {
      // Idempotent: same SHA already pinned — no-op.
      return refName;
    }
    throw new Error(
      `Refusing to replace stable ref "${refName}": currently at ${existingSha}, ` +
      `requested ${commitSha}. Stable refs are immutable once set.`,
    );
  }

  try {
    await gitCmd(["update-ref", refName, commitSha, await zeroShaFor(repoPath)], repoPath, {}, signal);
  } catch (error) {
    // Another writer may have created the ref concurrently; accept only the
    // exact same SHA, otherwise fail closed (or rethrow when the ref was
    // never created, e.g. a lock or permission failure).
    const racedSha = await gitOut(
      ["rev-parse", "--verify", refName],
      repoPath,
      {},
      signal,
    ).catch(() => "");
    if (racedSha === "") {
      throw error;
    }
    if (racedSha !== commitSha) {
      throw new Error(
        `Refusing to replace stable ref "${refName}": currently at ${racedSha}, ` +
        `requested ${commitSha}. Stable refs are immutable once set.`,
      );
    }
  }

  return refName;
}

// ── managed worktree tracking ────────────────────────────────────────────────

/**
 * Resolve the ref name for a worker worktree.
 */
export function workerRefName(waveId: string, taskId: string): string {
  validateSafeId(waveId, "waveId");
  validateSafeId(taskId, "taskId");
  return `refs/pi-review-gate/waves/${waveId}/workers/${taskId}`;
}

/**
 * Resolve the ref name for an integration worktree.
 */
export function integrationRefName(waveId: string): string {
  validateSafeId(waveId, "waveId");
  return `refs/pi-review-gate/waves/${waveId}/integrated`;
}
