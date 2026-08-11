import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promises as fs } from "node:fs";
import { createExecutorAdapter } from "./adapters/factory";
import { normalizeCandidate, type CandidateCommit } from "./wave-commits";
import type { WorkerWorktree } from "./wave-worktrees";
import type { WaveCaptureResult } from "./wave-repository";
import type { ReviewGateConfig } from "../config";
import type { ExecutorAdapter, ExecutorSession, ExecutorTurn, SubtaskProgressUpdate } from "./types";
import type { TokenUsage } from "../usage";
import { GIT_NO_LOCKS_ENV as GIT_ENV } from "./wave-validation";

// ── path rewriting for workspace isolation ───────────────────────────────────

/**
 * Rewrite absolute paths rooted at sourceRoot to equivalent paths rooted at
 * workerRoot. Only matches the exact sourceRoot or a descendant boundary
 * (e.g., /repo-other is NOT rewritten when sourceRoot is /repo).
 *
 * This prevents the executor from following absolute source paths and writing
 * directly to the source workspace instead of the isolated worktree.
 */
export function rewriteSourcePaths(
  text: string,
  sourceRoot: string | readonly string[],
  workerRoot: string,
): string {
  const trimTrailingSeparators = (value: string): string => {
    const rootLength = parse(value).root.length;
    return value.length > rootLength ? value.replace(/[\\/]+$/, "") : value;
  };
  const escapePath = (value: string): string =>
    [...value].map((char) =>
      char === "/" || char === "\\"
        ? "[\\\\/]"
        : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ).join("");

  const worker = trimTrailingSeparators(workerRoot);
  const roots = [...new Set(
    (typeof sourceRoot === "string" ? [sourceRoot] : sourceRoot)
      .map(trimTrailingSeparators),
  )].sort((a, b) => b.length - a.length);

  return roots.reduce((rewritten, source) => {
    const flags = process.platform === "win32" ? "gi" : "g";
    const pattern = new RegExp(
      `(^|[^A-Za-z0-9._~\\\\/-])${escapePath(source)}(?=$|[\\\\/])`,
      flags,
    );
    return rewritten.replace(pattern, (_match, prefix: string) => `${prefix}${worker}`);
  }, text);
}

/**
 * Rewrite a WaveWorkerTask, translating absolute source-root paths to worker-root paths.
 */
export function rewriteTaskPaths(
  task: WaveWorkerTask,
  sourceRoot: string | readonly string[],
  workerRoot: string,
): WaveWorkerTask {
  return {
    title: rewriteSourcePaths(task.title, sourceRoot, workerRoot),
    instructions: rewriteSourcePaths(task.instructions, sourceRoot, workerRoot),
    acceptanceCriteria: task.acceptanceCriteria.map((c) =>
      rewriteSourcePaths(c, sourceRoot, workerRoot),
    ),
    relevantContext: task.relevantContext
      ? rewriteSourcePaths(task.relevantContext, sourceRoot, workerRoot)
      : undefined,
  };
}

/**
 * Isolation directive appended to the worker prompt to reinforce that all
 * writes must remain under the worker root. Placed AFTER task text so it
 * cannot be overridden by later task content.
 */
function isolationDirective(workerRoot: string): string {
  return [
    "",
    "Workspace isolation (authoritative):",
    `All reads, writes, commands, and verification must remain under the worker root: ${workerRoot}`,
    "The original source workspace is outside this boundary and must be treated as read-only.",
    "Absolute source-workspace paths in the request were mapped to this worker root.",
    "Never write outside the worker root, even if earlier task text names another absolute path.",
  ].join("\n");
}

export function buildWaveWorkerContinuationPrompt(
  feedback: string,
  sourceRoot: string | readonly string[],
  workerRoot: string,
): string {
  return rewriteSourcePaths(feedback, sourceRoot, workerRoot)
    + isolationDirective(workerRoot);
}

// ── types ────────────────────────────────────────────────────────────────────

/** Task input for a wave worker turn. */
export interface WaveWorkerTask {
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  relevantContext?: string;
}

/** Status of a wave worker turn result. */
export type WaveWorkerStatus =
  | "completed"
  | "no_changes"
  | "executor_error"
  | "timeout"
  | "cancelled";

/** Result of running one wave worker turn. */
export interface WaveWorkerResult {
  status: WaveWorkerStatus;
  taskId: string;
  title: string;
  summary: string;
  session?: ExecutorSession;
  turn?: ExecutorTurn;
  candidate?: CandidateCommit;
  adapter: string;
  model?: string;
  usage?: TokenUsage;
  error?: string;
}

/** Input for running a single wave worker turn. */
export interface WaveWorkerInput {
  /** The task identifier. */
  taskId: string;
  /** The task definition. */
  task: WaveWorkerTask;
  /** Wave capture result (base commit, wave root, etc.). */
  capture: WaveCaptureResult;
  /** Worker worktree (checked out at base commit). */
  worktree: WorkerWorktree;
  /** Per-worker artifact directory (must be under waveRoot, outside worktree). */
  artifactDir: string;
  /** Review gate configuration. */
  config: ReviewGateConfig;
  /** Canonical source root for path rewriting. */
  sourceRoot: string;
  /** Lexical aliases for the source root (for example macOS /tmp vs /private/tmp). */
  sourceRootAliases?: string[];
  /** Scoped model identifiers for reviewer resolution. Unused in the initial-turn primitive; reserved for the review/correction lifecycle. */
  scopedModels?: string[];
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Progress callback. */
  onUpdate?: (update: SubtaskProgressUpdate) => void;
}

/** Input for resuming a wave worker turn (continuation). */
export interface WaveWorkerContinuationInput {
  /** The task identifier. */
  taskId: string;
  /** The task definition. */
  task: WaveWorkerTask;
  /** Wave capture result (base commit, wave root, etc.). */
  capture: WaveCaptureResult;
  /** Worker worktree (checked out at base commit). */
  worktree: WorkerWorktree;
  /** Per-worker artifact directory (must be under waveRoot, outside worktree). */
  artifactDir: string;
  /** Review gate configuration. */
  config: ReviewGateConfig;
  /** Canonical source root for path rewriting. */
  sourceRoot: string;
  /** Lexical aliases for the source root (for example macOS /tmp vs /private/tmp). */
  sourceRootAliases?: string[];
  /** Prior successful result containing session and candidate. */
  priorResult: WaveWorkerResult;
  /** Feedback / correction text to supply to the resumed session. */
  feedback: string;
  /** Turn number (must be >= 2). */
  turn: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Progress callback. */
  onUpdate?: (update: SubtaskProgressUpdate) => void;
}

// ── validation ───────────────────────────────────────────────────────────────

/**
 * Validate an artifact directory path against wave root and worktree
 * BEFORE creating it. This is the canonical preflight used by both
 * runWaveWorker and the lifecycle.
 */
export async function validateArtifactPath(
  artifactDir: string,
  waveRoot: string,
  worktreeRoot: string,
): Promise<void> {
  const resolved = resolve(artifactDir);
  assertPathWithin(resolved, waveRoot);
  await assertCreationPathUnderWaveRoot(resolved, waveRoot);
  await assertCreationPathOutsideWorktree(resolved, worktreeRoot);
}

/** Validate that a path stays under the wave root. */
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

/**
 * Lexical containment check: reject absolute or traversal paths before mkdir.
 */
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

/**
 * Preflight: verify the artifact path stays outside the worktree before mkdir.
 * Uses lexical check + nearest-existing-ancestor realpath to prevent mkdir
 * from creating directories inside the worktree via symlinks.
 */
async function assertCreationPathOutsideWorktree(path: string, worktreeRoot: string): Promise<void> {
  const root = await fs.realpath(worktreeRoot);
  const lexical = relative(resolve(worktreeRoot), resolve(path));
  if (!isAbsolute(lexical) && lexical !== ".." && !lexical.startsWith(".." + sep)) {
    throw new Error(`Artifact directory "${path}" must be outside the worktree "${worktreeRoot}".`);
  }
  let existing = resolve(path);
  for (;;) {
    try {
      const resolved = await fs.realpath(existing);
      const rel = relative(root, resolved);
      if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) {
        throw new Error(`Artifact directory "${path}" must be outside the worktree "${worktreeRoot}".`);
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

/** Validate that the artifact directory is outside the worktree (strict: not a parent either). */
async function assertArtifactOutsideWorktree(artifactDir: string, worktreeRoot: string): Promise<void> {
  const resolvedArtifact = await fs.realpath(artifactDir);
  const resolvedWorktree = await fs.realpath(worktreeRoot);
  const rel = relative(resolvedWorktree, resolvedArtifact);
  if (rel === ".." || (!rel.startsWith(".." + sep) && !rel.startsWith("/"))) {
    throw new Error(
      `Artifact directory "${artifactDir}" must be outside the worktree "${worktreeRoot}".`,
    );
  }
}

/** Validate that the worktree belongs to the captured private repository. */
async function assertWorktreeBelongsToRepo(worktreeRoot: string, capture: WaveCaptureResult): Promise<void> {
  // Verify worktree is under waveRoot.
  await assertUnderWaveRoot(worktreeRoot, capture.waveRoot);

  const resolvedRepoPath = await fs.realpath(capture.repositoryPath);
  const resolvedWorktreeRoot = await fs.realpath(worktreeRoot);

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const gitOut = async (args: string[]) => (await execFileAsync("git", args, {
    cwd: worktreeRoot,
    env: { ...process.env, ...GIT_ENV },
    timeout: 30_000,
  })).stdout.trim();

  // Verify the supplied path is the Git top-level.
  const topLevel = await gitOut(["rev-parse", "--show-toplevel"]);
  if (await fs.realpath(resolve(worktreeRoot, topLevel)) !== resolvedWorktreeRoot) {
    throw new Error(`Worker path "${worktreeRoot}" is not a Git top-level.`);
  }

  // Verify HEAD is detached.
  const headRef = await gitOut(["symbolic-ref", "--short", "HEAD"]).catch(() => "");
  if (headRef !== "") {
    throw new Error(`Worker must use detached HEAD (on branch "${headRef}").`);
  }

  // Verify base commit ancestry.
  const head = await gitOut(["rev-parse", "HEAD"]);
  if (head !== capture.baseCommit) {
    const mergeBase = await gitOut(["merge-base", "HEAD", capture.baseCommit]);
    if (mergeBase !== capture.baseCommit) {
      throw new Error(`Worker is not based on the captured base commit.`);
    }
  }

  // Verify the common dir is exactly the private bare repository.
  const commonDir = await gitOut(["rev-parse", "--git-common-dir"]);
  const resolvedCommonDir = await fs.realpath(resolve(worktreeRoot, commonDir));
  if (resolvedCommonDir !== resolvedRepoPath) {
    throw new Error(
      `Worktree at "${worktreeRoot}" does not belong to the private repository "${capture.repositoryPath}".`,
    );
  }
}

/** Validate that effectiveCwd is inside worktreeRoot (canonical check). */
async function assertEffectiveCwdInsideWorktree(effectiveCwd: string, worktreeRoot: string): Promise<void> {
  const [root, cwd] = await Promise.all([fs.realpath(worktreeRoot), fs.realpath(effectiveCwd)]);
  const rel = relative(root, cwd);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) {
    throw new Error(
      `Effective cwd "${effectiveCwd}" is not inside worktree root "${worktreeRoot}".`,
    );
  }
}

// ── prompt construction ──────────────────────────────────────────────────────

/**
 * Build the initial executor prompt for a wave worker turn.
 *
 * The prompt discloses that the isolated snapshot contains tracked and
 * non-ignored untracked files but no Git-ignored files, and tells the
 * model not to manage commits.
 *
 * Absolute source-root paths in the task are rewritten to worker-root paths
 * to prevent the executor from writing directly to the source workspace.
 */
export function buildWaveWorkerPrompt(
  task: WaveWorkerTask,
  sourceRoot: string | readonly string[],
  workerRoot: string,
): string {
  // Rewrite absolute source-root paths to worker-root paths.
  const rewrittenTask = rewriteTaskPaths(task, sourceRoot, workerRoot);

  return [
    "You are the isolated implementation executor for one bounded phase.",
    "Work directly in the current workspace. Inspect the repository, implement the requested change, and run relevant verification.",
    "Do not broaden the task, commit, push, or modify unrelated files.",
    "Do not manage Git commits — the workspace will be committed automatically after your changes.",
    "",
    "Workspace snapshot disclosure:",
    "The isolated snapshot you are working from contains tracked files and non-ignored untracked files.",
    "Git-ignored files are not present in this snapshot.",
    "",
    renderWaveWorkerTask(rewrittenTask),
    "",
    "When finished, summarize changed files, verification performed, and remaining risks.",
    isolationDirective(workerRoot),
  ].join("\n");
}

function renderWaveWorkerTask(task: WaveWorkerTask): string {
  return [
    `Subtask: ${task.title}`,
    "",
    task.instructions,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    ...(task.relevantContext ? ["", "Relevant context:", task.relevantContext] : []),
  ].join("\n");
}

// ── progress helpers ─────────────────────────────────────────────────────────

function reportProgress(
  input: WaveWorkerInput,
  update: Omit<SubtaskProgressUpdate, "subtaskId">,
): void {
  input.onUpdate?.({ subtaskId: input.taskId, ...update });
}

// ── main execution ───────────────────────────────────────────────────────────

/**
 * Run exactly one initial wave executor turn.
 *
 * This function:
 * 1. Validates and creates the artifact directory (under waveRoot, outside worktree).
 * 2. Creates the configured executor adapter.
 * 3. Runs one executor turn in the worker's effective cwd.
 * 4. Writes task/executor artifacts in the worker-only artifact root.
 * 5. Normalizes the final tree with normalizeCandidate.
 * 6. Returns a typed result with executor session/turn, candidate, adapter/model,
 *    summary, and explicit status.
 *
 * This function does NOT:
 * - Review or pin accepted refs.
 * - Mutate parent state.
 * - Clean the worktree.
 * - Implement scheduling.
 */
export async function runWaveWorker(input: WaveWorkerInput): Promise<WaveWorkerResult> {
  const { taskId, task, capture, worktree, artifactDir, config, sourceRoot, sourceRootAliases, signal } = input;

  // ── Validate artifact directory (before mkdir) ──
  const resolvedArtifactDir = resolve(artifactDir);

  // Lexical containment check before mkdir.
  assertPathWithin(resolvedArtifactDir, capture.waveRoot);

  // Preflight: verify existing path components stay under waveRoot.
  await assertCreationPathUnderWaveRoot(resolvedArtifactDir, capture.waveRoot);

  // Preflight: verify artifact stays outside worktree before mkdir.
  await assertCreationPathOutsideWorktree(resolvedArtifactDir, worktree.worktreeRoot);

  // Ensure artifact directory exists.
  await mkdir(resolvedArtifactDir, { recursive: true });

  // Post-mkdir: verify canonical paths.
  await assertUnderWaveRoot(resolvedArtifactDir, capture.waveRoot);
  await assertArtifactOutsideWorktree(resolvedArtifactDir, worktree.worktreeRoot);

  // ── Validate worktree ownership (before executor) ──
  await assertEffectiveCwdInsideWorktree(worktree.effectiveCwd, worktree.worktreeRoot);
  await assertWorktreeBelongsToRepo(worktree.worktreeRoot, capture);

  // ── Create executor adapter ──
  let adapter: ExecutorAdapter;
  try {
    adapter = createExecutorAdapter(config);
  } catch (error) {
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: error instanceof Error ? error.message : "Failed to create executor adapter.",
      adapter: "none",
      error: error instanceof Error ? error.message : "Failed to create executor adapter.",
    };
  }

  reportProgress(input, {
    phase: "starting",
    message: "wave worker starting executor",
    artifactDir: resolvedArtifactDir,
    adapter: adapter.kind,
    model: adapter.model,
  });

  // ── Write task metadata ──
  await writeFile(
    join(resolvedArtifactDir, "task.json"),
    JSON.stringify({
      version: 1,
      taskId,
      task,
      adapter: adapter.kind,
      model: adapter.model,
      startedAt: new Date().toISOString(),
    }, null, 2),
    "utf8",
  );

  // ── Build prompt with path rewriting and isolation directive ──
  const prompt = buildWaveWorkerPrompt(
    task,
    [sourceRoot, ...(sourceRootAliases ?? [])],
    worktree.worktreeRoot,
  );

  // ── Run one executor turn ──
  reportProgress(input, {
    phase: "executing",
    message: "executor turn 1 running",
    artifactDir: resolvedArtifactDir,
    adapter: adapter.kind,
    model: adapter.model,
    executorTurn: 1,
  });

  let turn: ExecutorTurn;
  try {
    turn = await adapter.run({
      cwd: worktree.effectiveCwd,
      prompt,
      artifactDir: resolvedArtifactDir,
      turn: 1,
      signal,
      onUpdate: (message) => reportProgress(input, {
        phase: "executing",
        message,
        artifactDir: resolvedArtifactDir,
        adapter: adapter.kind,
        model: adapter.model,
        executorTurn: 1,
      }),
    });
  } catch (error) {
    // Prioritize cancellation over generic executor error.
    if (signal?.aborted) {
      return {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: "Executor was cancelled.",
        adapter: adapter.kind,
        model: adapter.model,
        error: "Executor was cancelled.",
      };
    }
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: error instanceof Error ? error.message : "Executor process failed.",
      adapter: adapter.kind,
      model: adapter.model,
      error: error instanceof Error ? error.message : "Executor process failed.",
    };
  }

  // ── Check for cancellation ──
  if (turn.aborted || signal?.aborted) {
    return {
      status: "cancelled",
      taskId,
      title: task.title,
      summary: "Executor was cancelled.",
      session: turn.session,
      turn,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turn.usage,
      error: "Executor was cancelled.",
    };
  }

  // ── Check for timeout ──
  if (turn.timedOut) {
    return {
      status: "timeout",
      taskId,
      title: task.title,
      summary: "Executor timed out.",
      session: turn.session,
      turn,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turn.usage,
      error: "Executor timed out.",
    };
  }

  if (turn.failure) {
    const message = `Executor ${turn.failure.category} error: ${turn.failure.message}`;
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: message,
      session: turn.session,
      turn,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turn.usage,
      error: message,
    };
  }

  // ── Check for executor error ──
  if (turn.code !== 0) {
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: `Executor exited with status ${turn.code}.`,
      session: turn.session,
      turn,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turn.usage,
      error: `Executor exited with status ${turn.code}.`,
    };
  }

  // ── Check for empty response ──
  if (!turn.text.trim()) {
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: "Executor did not produce a usable final response.",
      session: turn.session,
      turn,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turn.usage,
      error: "Executor did not produce a usable final response.",
    };
  }

  // ── Normalize the candidate ──
  reportProgress(input, {
    phase: "completing",
    message: "normalizing candidate",
    artifactDir: resolvedArtifactDir,
    adapter: adapter.kind,
    model: adapter.model,
  });

  let candidate: CandidateCommit;
  try {
    candidate = await normalizeCandidate(
      capture,
      worktree.worktreeRoot,
      taskId,
      task.title,
    );
  } catch (error) {
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: error instanceof Error ? error.message : "Candidate normalization failed.",
      session: turn.session,
      turn,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turn.usage,
      error: error instanceof Error ? error.message : "Candidate normalization failed.",
    };
  }

  // ── Write completion artifact ──
  const result: WaveWorkerResult = candidate.differsFromBase
    ? {
      status: "completed",
      taskId,
      title: task.title,
      summary: turn.text,
      session: turn.session,
      turn,
      candidate,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turn.usage,
    }
    : {
      status: "no_changes",
      taskId,
      title: task.title,
      summary: turn.text,
      session: turn.session,
      turn,
      candidate,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turn.usage,
    };

  await writeFile(
    join(resolvedArtifactDir, "completion.json"),
    JSON.stringify({
      version: 1,
      status: result.status,
      taskId,
      title: task.title,
      summary: result.summary,
      adapter: adapter.kind,
      model: adapter.model,
      candidateRef: candidate.candidateRef,
      commitSha: candidate.commitSha,
      differsFromBase: candidate.differsFromBase,
      completedAt: new Date().toISOString(),
    }, null, 2),
    "utf8",
  );

  reportProgress(input, {
    phase: "completing",
    message: result.status === "completed"
      ? "wave worker completed with changes"
      : "wave worker completed with no changes",
    artifactDir: resolvedArtifactDir,
    adapter: adapter.kind,
    model: adapter.model,
  });

  return result;
}

// ── continuation (resume) ───────────────────────────────────────────────────

/**
 * Resume a wave worker turn with feedback from a prior review.
 *
 * Given the same capture/worktree/task/artifact/config plus a prior successful
 * WaveWorkerResult (session and candidate), prompt text, and turn number >= 2,
 * this function:
 * 1. Revalidates the isolated paths/worktree.
 * 2. Recreates the configured adapter.
 * 3. Resumes the exact executor session in worker.effectiveCwd.
 * 4. Handles cancellation/timeout/nonzero/empty response with typed statuses.
 * 5. Re-normalizes the final tree against the immutable base using the prior candidate.
 * 6. Returns the same WaveWorkerResult shape with the new turn/session/candidate.
 *
 * This function does NOT:
 * - Make review decisions.
 * - Generate transmission.
 * - Pin accepted refs.
 * - Implement scheduling.
 */
export async function resumeWaveWorker(input: WaveWorkerContinuationInput): Promise<WaveWorkerResult> {
  const { taskId, task, capture, worktree, artifactDir, config, sourceRoot, sourceRootAliases, priorResult, feedback, turn, signal } = input;

  // ── Validate prior result ──
  if (!priorResult.session) {
    throw new Error("Continuation requires a prior result with a session.");
  }
  if (!priorResult.candidate) {
    throw new Error("Continuation requires a prior result with a candidate.");
  }
  if (turn < 2) {
    throw new Error(`Continuation turn must be >= 2, got ${turn}.`);
  }

  // ── Validate artifact directory (reuse same checks) ──
  const resolvedArtifactDir = resolve(artifactDir);
  assertPathWithin(resolvedArtifactDir, capture.waveRoot);
  await assertCreationPathUnderWaveRoot(resolvedArtifactDir, capture.waveRoot);
  await assertCreationPathOutsideWorktree(resolvedArtifactDir, worktree.worktreeRoot);
  await mkdir(resolvedArtifactDir, { recursive: true });
  await assertUnderWaveRoot(resolvedArtifactDir, capture.waveRoot);
  await assertArtifactOutsideWorktree(resolvedArtifactDir, worktree.worktreeRoot);

  // ── Validate worktree ownership ──
  await assertEffectiveCwdInsideWorktree(worktree.effectiveCwd, worktree.worktreeRoot);
  await assertWorktreeBelongsToRepo(worktree.worktreeRoot, capture);

  // ── Create executor adapter ──
  let adapter: ExecutorAdapter;
  try {
    adapter = createExecutorAdapter(config);
  } catch (error) {
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: error instanceof Error ? error.message : "Failed to create executor adapter.",
      adapter: "none",
      error: error instanceof Error ? error.message : "Failed to create executor adapter.",
    };
  }

  reportProgress(input, {
    phase: "correcting",
    message: `resuming executor turn ${turn}`,
    artifactDir: resolvedArtifactDir,
    adapter: adapter.kind,
    model: adapter.model,
  });

  // ── Resume the exact executor session ──
  const rewrittenFeedback = buildWaveWorkerContinuationPrompt(
    feedback,
    [sourceRoot, ...(sourceRootAliases ?? [])],
    worktree.worktreeRoot,
  );

  reportProgress(input, {
    phase: "executing",
    message: `executor turn ${turn} running (resumed)`,
    artifactDir: resolvedArtifactDir,
    adapter: adapter.kind,
    model: adapter.model,
    executorTurn: turn,
  });

  let turnResult: ExecutorTurn;
  try {
    turnResult = await adapter.run({
      cwd: worktree.effectiveCwd,
      prompt: rewrittenFeedback,
      artifactDir: resolvedArtifactDir,
      turn,
      signal,
      session: priorResult.session, // resume exact prior session
      onUpdate: (message) => reportProgress(input, {
        phase: "executing",
        message,
        artifactDir: resolvedArtifactDir,
        adapter: adapter.kind,
        model: adapter.model,
        executorTurn: turn,
      }),
    });
  } catch (error) {
    if (signal?.aborted) {
      return {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: "Executor was cancelled.",
        adapter: adapter.kind,
        model: adapter.model,
        error: "Executor was cancelled.",
      };
    }
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: error instanceof Error ? error.message : "Executor process failed.",
      adapter: adapter.kind,
      model: adapter.model,
      error: error instanceof Error ? error.message : "Executor process failed.",
    };
  }

  // ── Check for cancellation ──
  if (turnResult.aborted || signal?.aborted) {
    return {
      status: "cancelled",
      taskId,
      title: task.title,
      summary: "Executor was cancelled.",
      session: turnResult.session,
      turn: turnResult,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turnResult.usage,
      error: "Executor was cancelled.",
    };
  }

  // ── Check for timeout ──
  if (turnResult.timedOut) {
    return {
      status: "timeout",
      taskId,
      title: task.title,
      summary: "Executor timed out.",
      session: turnResult.session,
      turn: turnResult,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turnResult.usage,
      error: "Executor timed out.",
    };
  }

  if (turnResult.failure) {
    const message = `Executor ${turnResult.failure.category} error: ${turnResult.failure.message}`;
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: message,
      session: turnResult.session,
      turn: turnResult,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turnResult.usage,
      error: message,
    };
  }

  // ── Check for executor error ──
  if (turnResult.code !== 0) {
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: `Executor exited with status ${turnResult.code}.`,
      session: turnResult.session,
      turn: turnResult,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turnResult.usage,
      error: `Executor exited with status ${turnResult.code}.`,
    };
  }

  // ── Check for empty response ──
  if (!turnResult.text.trim()) {
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: "Executor did not produce a usable final response.",
      session: turnResult.session,
      turn: turnResult,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turnResult.usage,
      error: "Executor did not produce a usable final response.",
    };
  }

  // ── Re-normalize the candidate against the immutable base ──
  reportProgress(input, {
    phase: "completing",
    message: "re-normalizing candidate",
    artifactDir: resolvedArtifactDir,
    adapter: adapter.kind,
    model: adapter.model,
  });

  let candidate: CandidateCommit;
  try {
    candidate = await normalizeCandidate(
      capture,
      worktree.worktreeRoot,
      taskId,
      task.title,
      { commitSha: priorResult.candidate.commitSha },
    );
  } catch (error) {
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: error instanceof Error ? error.message : "Candidate normalization failed.",
      session: turnResult.session,
      turn: turnResult,
      adapter: adapter.kind,
      model: adapter.model,
      usage: turnResult.usage,
      error: error instanceof Error ? error.message : "Candidate normalization failed.",
    };
  }

  // ── Determine status based on candidate vs base ──
  const status: WaveWorkerStatus = candidate.differsFromBase ? "completed" : "no_changes";

  // ── Write completion artifact ──
  const result: WaveWorkerResult = {
    status,
    taskId,
    title: task.title,
    summary: turnResult.text,
    session: turnResult.session,
    turn: turnResult,
    candidate,
    adapter: adapter.kind,
    model: adapter.model,
    usage: turnResult.usage,
  };

  await writeFile(
    join(resolvedArtifactDir, "completion.json"),
    JSON.stringify({
      version: 1,
      status: result.status,
      taskId,
      title: task.title,
      summary: result.summary,
      adapter: adapter.kind,
      model: adapter.model,
      candidateRef: candidate.candidateRef,
      commitSha: candidate.commitSha,
      differsFromBase: candidate.differsFromBase,
      completedAt: new Date().toISOString(),
    }, null, 2),
    "utf8",
  );

  reportProgress(input, {
    phase: "completing",
    message: status === "completed"
      ? `wave worker turn ${turn} completed with changes`
      : `wave worker turn ${turn} completed with no changes`,
    artifactDir: resolvedArtifactDir,
    adapter: adapter.kind,
    model: adapter.model,
  });

  return result;
}
