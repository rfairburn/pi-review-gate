import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { WaveCaptureResult } from "./wave-repository";

const execFileAsync = promisify(execFile);

const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0" };

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

/** Describes a managed worktree tracked by this module. */
export interface ManagedWorktree {
  /** Absolute path to the worktree root. */
  path: string;
  /** The wave ID this worktree belongs to. */
  waveId: string;
  /** The task ID (worker) or "integration". */
  taskId: string;
  /** Whether this is a worker or integration worktree. */
  type: "worker" | "integration";
}

// ── validation ───────────────────────────────────────────────────────────────

/** Validate that an ID is a single safe ref/path segment (used for waveId and taskId). */
function validateSafeId(id: string, label: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Invalid ${label}: must be a non-empty string.`);
  }
  // Reject git ref-injection characters.
  if (
    /[~^:?*[\\@{}\/]/.test(id) ||
    /[\x00-\x20\x7F]/.test(id) ||
    id === "." || id === ".." || id === "@" ||
    id.startsWith(".") || id.endsWith(".") ||
    id.endsWith(".lock") || id.includes("..") ||
    id.includes("@{")
  ) {
    throw new Error(
      `Invalid ${label}: "${id}". Must be a single safe ref/path segment.`,
    );
  }
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
async function gitCmd(args: string[], cwd: string, envOverrides: Record<string, string> = {}): Promise<void> {
  await execFileAsync(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, ...GIT_ENV, ...envOverrides },
      timeout: 30_000,
    },
  );
}

/** Run a git command and return stdout. */
async function gitOut(args: string[], cwd: string, envOverrides: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, ...GIT_ENV, ...envOverrides },
      timeout: 30_000,
    },
  );
  return stdout.trim();
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
): Promise<WorkerWorktree> {
  validateSafeId(taskId, "taskId");

  const waveRoot = capture.waveRoot;
  const repoPath = capture.repositoryPath;
  const baseCommit = capture.baseCommit;
  const relativeCwd = capture.discovery.relativeCwd;

  // Worktree directory under wave root.
  const worktreeRoot = join(waveRoot, "workers", taskId);

  // Preflight: verify existing path components stay under waveRoot.
  await assertCreationPathUnderWaveRoot(repoPath, waveRoot);
  await assertCreationPathUnderWaveRoot(worktreeRoot, waveRoot);

  // Create the worktree directory.
  await fs.mkdir(worktreeRoot, { recursive: true });

  // Ensure the worktree path stays under waveRoot (resolved real paths).
  await assertUnderWaveRoot(worktreeRoot, waveRoot);

  // Create a detached worktree at the base commit.
  await gitCmd(
    ["worktree", "add", "--detach", worktreeRoot, baseCommit],
    repoPath,
  );

  // Resolve and create the effective cwd.
  const effectiveCwd = relativeCwd !== "."
    ? join(worktreeRoot, relativeCwd)
    : worktreeRoot;
  // Lexical containment check before mkdir.
  assertPathWithin(effectiveCwd, worktreeRoot);
  assertPathWithin(effectiveCwd, waveRoot);
  // Preflight: verify existing path components stay under waveRoot.
  await assertCreationPathUnderWaveRoot(effectiveCwd, waveRoot);
  await fs.mkdir(effectiveCwd, { recursive: true });
  // Realpath containment check after mkdir.
  await assertUnderWaveRoot(effectiveCwd, waveRoot);

  return { worktreeRoot, effectiveCwd };
}

/**
 * Create a detached integration worktree at the capture base.
 *
 * Similar to createWorkerWorktree but for integration tasks.
 */
export async function createIntegrationWorktree(
  capture: WaveCaptureResult,
): Promise<IntegrationWorktree> {
  const waveRoot = capture.waveRoot;
  const repoPath = capture.repositoryPath;
  const baseCommit = capture.baseCommit;
  const relativeCwd = capture.discovery.relativeCwd;

  // Worktree directory under wave root.
  const worktreeRoot = join(waveRoot, "integration");

  // Preflight: verify existing path components stay under waveRoot.
  await assertCreationPathUnderWaveRoot(repoPath, waveRoot);
  await assertCreationPathUnderWaveRoot(worktreeRoot, waveRoot);

  // Create the worktree directory.
  await fs.mkdir(worktreeRoot, { recursive: true });

  // Ensure the worktree path stays under waveRoot (resolved real paths).
  await assertUnderWaveRoot(worktreeRoot, waveRoot);

  // Create a detached worktree at the base commit.
  await gitCmd(
    ["worktree", "add", "--detach", worktreeRoot, baseCommit],
    repoPath,
  );

  // Resolve and create the effective cwd.
  const effectiveCwd = relativeCwd !== "."
    ? join(worktreeRoot, relativeCwd)
    : worktreeRoot;
  // Lexical containment check before mkdir.
  assertPathWithin(effectiveCwd, worktreeRoot);
  assertPathWithin(effectiveCwd, waveRoot);
  // Preflight: verify existing path components stay under waveRoot.
  await assertCreationPathUnderWaveRoot(effectiveCwd, waveRoot);
  await fs.mkdir(effectiveCwd, { recursive: true });
  // Realpath containment check after mkdir.
  await assertUnderWaveRoot(effectiveCwd, waveRoot);

  return { worktreeRoot, effectiveCwd };
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
): Promise<string> {
  const waveId = capture.waveId;
  const repoPath = capture.repositoryPath;

  // Validate waveId before constructing ref.
  validateSafeId(waveId, "waveId");

  // Verify the object is a commit.
  const objectType = await gitOut(
    ["cat-file", "-t", commitSha],
    repoPath,
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
  // ref with a different SHA. This prevents accidental or malicious ref overwrite.
  const existingSha = await gitOut(
    ["rev-parse", "--verify", refName],
    repoPath,
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

  // Update the ref.
  await gitCmd(["update-ref", refName, commitSha], repoPath);

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
