import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promises as fs } from "node:fs";
import { createExecutorAdapter } from "./adapters/factory";
import { normalizeCandidate, pinRecoveryCandidate, type CandidateCommit } from "./wave-commits";
import type { WorkerWorktree } from "./wave-worktrees";
import type { WaveCaptureResult } from "./wave-repository";
import {
  DEFAULT_EXECUTION_RETRY_POLICY,
  executorSelectionKey,
  resolvedExecutorPool,
  type ReviewGateConfig,
} from "../config";
import type { ExecutorAdapter, ExecutorLiveControl, ExecutorSession, ExecutorTurn, SubtaskProgressUpdate } from "./types";
import type { TokenUsage } from "../usage";
import { GIT_NO_LOCKS_ENV as GIT_ENV } from "./wave-validation";
import { runExecutorWithRecovery, type RecoveredExecutorRun } from "./executor-recovery";
import type { ExecutorPoolAssignment } from "./executor-pool";
import {
  createOperationRecord,
  createIncident,
  createReattachmentBundle,
  operationRecordPath,
  readOperationRecord,
  writeOperationRecord,
  type ExecutionIncident,
  type ExecutorAssignmentRecord,
  type OperationRecord,
  type ReattachmentBundle,
  type RecoveryCheckpoint,
} from "./operation-record";

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
  operationRecord?: string;
  bundle?: ReattachmentBundle;
  incidents?: ExecutionIncident[];
  checkpoint?: RecoveryCheckpoint;
  attempts?: number;
  lastExecutorTurn?: number;
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
  /** Register live steering/interruption for the current executor turn. */
  onLiveControl?: (control: ExecutorLiveControl | undefined) => void;
  /** Capacity lease selected by the wave scheduler. */
  executorAssignment?: ExecutorPoolAssignment;
  /** Acquire the next lower-priority executor after verified recovery fails. */
  acquireFailover?: (currentPriority: number) => Promise<ExecutorPoolAssignment | undefined>;
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
  /** Register live steering/interruption for the current executor turn. */
  onLiveControl?: (control: ExecutorLiveControl | undefined) => void;
  /** Capacity lease selected by the wave scheduler. */
  executorAssignment?: ExecutorPoolAssignment;
  /** Acquire the next lower-priority executor after verified recovery fails. */
  acquireFailover?: (currentPriority: number) => Promise<ExecutorPoolAssignment | undefined>;
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

interface PoolRunResult {
  adapter?: ExecutorAdapter;
  recovered: RecoveredExecutorRun;
}

function configuredAssignment(config: ReviewGateConfig): ExecutorPoolAssignment | undefined {
  const entry = resolvedExecutorPool(config)[0];
  return entry ? { entry, priority: 0 } : undefined;
}

function assignmentFromOperation(operation: OperationRecord, config: ReviewGateConfig): ExecutorPoolAssignment | undefined {
  if (!operation.executorSelection || operation.executorEntryId === undefined || operation.executorPriority === undefined) {
    return undefined;
  }
  const configured = resolvedExecutorPool(config);
  const configuredPriority = configured.findIndex((entry) =>
    executorSelectionKey(entry.selection) === executorSelectionKey(operation.executorSelection!));
  if (configuredPriority >= 0) {
    return { entry: configured[configuredPriority]!, priority: configuredPriority };
  }
  return {
    entry: {
      entryId: operation.executorEntryId,
      selection: operation.executorSelection,
      maxConcurrent: 1,
    },
    priority: operation.executorPriority,
  };
}

function beginAssignment(
  operation: OperationRecord,
  assignment: ExecutorPoolAssignment,
  reason: ExecutorAssignmentRecord["reason"],
): ExecutorAssignmentRecord {
  operation.executorEntryId = assignment.entry.entryId;
  operation.executorPriority = assignment.priority;
  operation.executorSelection = assignment.entry.selection;
  const record: ExecutorAssignmentRecord = {
    entryId: assignment.entry.entryId,
    priority: assignment.priority,
    selection: assignment.entry.selection,
    generation: operation.generation,
    reason,
    startedAt: new Date().toISOString(),
  };
  operation.assignments.push(record);
  return record;
}

function finishAssignment(
  assignment: ExecutorAssignmentRecord,
  outcome: NonNullable<ExecutorAssignmentRecord["outcome"]>,
): void {
  assignment.endedAt = new Date().toISOString();
  assignment.outcome = outcome;
}

function checkpointHandoffPrompt(
  originalPrompt: string,
  recovered: RecoveredExecutorRun,
): string {
  const checkpoint = recovered.checkpoint;
  return [
    "Executor handoff (authoritative):",
    "A prior executor exhausted its recovery attempts. Continue this same task in the existing isolated worktree.",
    "Inspect and preserve useful work already present. Do not reset, discard, or recreate changes merely because the native conversation changed.",
    checkpoint
      ? `Verified checkpoint: ${checkpoint.commitSha} (${checkpoint.ref}); changed paths: ${checkpoint.changedPaths.join(", ") || "none"}.`
      : "No prior file changes were produced before executor initialization failed.",
    `Prior executor failure: ${recovered.error ?? "unknown executor failure"}`,
    "",
    "Original task and current instructions:",
    originalPrompt,
  ].join("\n");
}

async function runWithPoolFailover(input: {
  worker: WaveWorkerInput | WaveWorkerContinuationInput;
  operation: OperationRecord;
  assignment: ExecutorPoolAssignment;
  prompt: string;
  handoffPrompt: string;
  startingTurn: number;
  session?: ExecutorSession;
  reason: ExecutorAssignmentRecord["reason"];
  resolvedArtifactDir: string;
}): Promise<PoolRunResult> {
  let assignment = input.assignment;
  let prompt = input.prompt;
  let session = input.session;
  let startingTurn = input.startingTurn;
  let reason = input.reason;

  for (;;) {
    const assignmentRecord = beginAssignment(input.operation, assignment, reason);
    let adapter: ExecutorAdapter | undefined;
    try {
      adapter = createExecutorAdapter(input.worker.config, assignment.entry.selection);
      input.operation.adapter = adapter.kind;
      input.operation.model = adapter.model;
      await writeOperationRecord(input.operation);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create executor adapter.";
      const incident = createIncident({
        attempt: input.operation.attempts.length,
        generation: input.operation.generation,
        cause: "provider_error",
        stage: "adapter_initialization",
        message,
        retryable: true,
      });
      input.operation.incidents.push(incident);
      finishAssignment(assignmentRecord, "failed");
      let checkpoint = input.operation.checkpoint;
      try {
        const candidate = await normalizeCandidate(
          input.worker.capture,
          input.worker.worktree.worktreeRoot,
          input.worker.taskId,
          input.worker.task.title,
        );
        checkpoint = await checkpointCandidate(input.worker.capture, input.worker.taskId, candidate);
        input.operation.checkpoint = checkpoint;
      } catch (checkpointError) {
        incident.retryable = false;
        incident.terminalCode = "recovery_state_corrupt_or_unverifiable";
        incident.message = `${message}; the recovery checkpoint could not be created or verified. ${checkpointError instanceof Error ? checkpointError.message : String(checkpointError)}`;
        input.operation.state = "failed_critical";
        await writeOperationRecord(input.operation);
        return {
          recovered: {
            status: "critical",
            error: incident.message,
            lastTurnNumber: Math.max(0, startingTurn - 1),
            checkpoint,
            incidents: [incident],
          },
        };
      }
      await writeOperationRecord(input.operation);
      const recovered: RecoveredExecutorRun = {
        status: "failed",
        error: message,
        lastTurnNumber: Math.max(0, startingTurn - 1),
        checkpoint,
        incidents: [incident],
      };
      const next = await input.worker.acquireFailover?.(assignment.priority);
      if (!next) {
        input.operation.state = "paused_recoverable";
        await writeOperationRecord(input.operation);
        return { recovered };
      }
      incident.resolvedAt = new Date().toISOString();
      incident.resolution = "executor_pool_failover";
      input.operation.generation += 1;
      input.operation.session = undefined;
      assignment = next;
      prompt = checkpointHandoffPrompt(input.handoffPrompt, recovered);
      session = undefined;
      reason = "failover";
      continue;
    }

    reportProgress(input.worker, {
      phase: "executing",
      message: `executor turn ${startingTurn} running`,
      artifactDir: input.resolvedArtifactDir,
      adapter: adapter.kind,
      model: adapter.model,
      executorTurn: startingTurn,
    });

    const recovered = await runExecutorWithRecovery({
      adapter,
      request: {
        cwd: input.worker.worktree.effectiveCwd,
        artifactDir: input.resolvedArtifactDir,
        signal: input.worker.signal,
        onUpdate: (message) => reportProgress(input.worker, {
          phase: "executing",
          message,
          artifactDir: input.resolvedArtifactDir,
          adapter: adapter!.kind,
          model: adapter!.model,
        }),
        onLiveControl: input.worker.onLiveControl,
      },
      prompt,
      startingTurn,
      session,
      capture: input.worker.capture,
      worktree: input.worker.worktree,
      taskId: input.worker.taskId,
      title: input.worker.task.title,
      retryPolicy: input.worker.config.execution?.retryPolicy ?? DEFAULT_EXECUTION_RETRY_POLICY,
      operation: input.operation,
      onRetry: (message, executorTurn) => reportProgress(input.worker, {
        phase: "executing",
        message,
        artifactDir: input.resolvedArtifactDir,
        adapter: adapter!.kind,
        model: adapter!.model,
        executorTurn,
      }),
    });

    if (recovered.status === "completed") {
      finishAssignment(assignmentRecord, "completed");
      await writeOperationRecord(input.operation);
      return { adapter, recovered };
    }
    if (recovered.status === "cancelled") {
      finishAssignment(assignmentRecord, "cancelled");
      await writeOperationRecord(input.operation);
      return { adapter, recovered };
    }
    finishAssignment(assignmentRecord, "failed");
    if (recovered.status === "critical" || !recovered.checkpoint?.verified) {
      await writeOperationRecord(input.operation);
      return { adapter, recovered };
    }

    const next = await input.worker.acquireFailover?.(assignment.priority);
    if (!next) {
      await writeOperationRecord(input.operation);
      return { adapter, recovered };
    }
    for (const incident of recovered.incidents) {
      if (!incident.resolvedAt) {
        incident.resolvedAt = new Date().toISOString();
        incident.resolution = "verified_checkpoint_failover";
      }
    }
    input.operation.generation += 1;
    input.operation.session = undefined;
    assignment = next;
    prompt = checkpointHandoffPrompt(input.handoffPrompt, recovered);
    session = undefined;
    startingTurn = recovered.lastTurnNumber + 1;
    reason = "failover";
    await writeOperationRecord(input.operation);
  }
}

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
  const { taskId, task, capture, worktree, artifactDir, config, sourceRoot, sourceRootAliases } = input;

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

  const assignment = input.executorAssignment ?? configuredAssignment(config);
  if (!assignment) {
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: "No executor pool is configured.",
      adapter: "none",
      error: "No executor pool is configured.",
    };
  }

  reportProgress(input, {
    phase: "starting",
    message: "wave worker starting executor",
    artifactDir: resolvedArtifactDir,
  });

  // ── Write task metadata ──
  await writeFile(
    join(resolvedArtifactDir, "task.json"),
    JSON.stringify({
      version: 1,
      taskId,
      task,
      executorEntryId: assignment.entry.entryId,
      executorPriority: assignment.priority,
      executorSelection: assignment.entry.selection,
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

  const operation = createOperationRecord({
    waveId: capture.waveId,
    taskId,
    title: task.title,
    worktreeRoot: worktree.worktreeRoot,
    effectiveCwd: worktree.effectiveCwd,
    artifactDir: resolvedArtifactDir,
    retryBudget: config.execution?.retryPolicy?.maxRetries ?? DEFAULT_EXECUTION_RETRY_POLICY.maxRetries,
  });
  await writeOperationRecord(operation);

  const poolRun = await runWithPoolFailover({
    worker: input,
    operation,
    assignment,
    prompt,
    handoffPrompt: prompt,
    startingTurn: 1,
    reason: "initial",
    resolvedArtifactDir,
  });
  const { recovered } = poolRun;
  const adapter = poolRun.adapter;
  const adapterKind = adapter?.kind ?? "none";
  const commonFailure = {
    taskId,
    title: task.title,
    summary: recovered.error ?? "Executor failed.",
    session: recovered.turn?.session,
    turn: recovered.turn,
    adapter: adapterKind,
    model: adapter?.model,
    usage: recovered.turn?.usage,
    error: recovered.error ?? "Executor failed.",
    operationRecord: operationRecordPath(resolvedArtifactDir),
    bundle: createReattachmentBundle(operation, capture.waveRoot),
    incidents: operation.incidents,
    checkpoint: recovered.checkpoint,
    attempts: operation.attempts.length,
    lastExecutorTurn: recovered.lastTurnNumber,
  };
  if (recovered.status !== "completed" || !recovered.turn) {
    return {
      status: recovered.status === "cancelled" ? "cancelled" : recovered.error?.includes("timed out") ? "timeout" : "executor_error",
      ...commonFailure,
    };
  }
  if (!adapter) {
    return { status: "executor_error", ...commonFailure, adapter: "none", error: "Executor completed without an adapter record." };
  }
  const turn = recovered.turn;

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
    const message = error instanceof Error ? error.message : "Candidate normalization failed.";
    operation.state = "failed_critical";
    operation.incidents.push(createIncident({
      attempt: operation.attempts.length,
      generation: operation.generation,
      cause: "workspace_error",
      stage: "checkpointing",
      message,
      retryable: false,
      terminalCode: "recovery_state_corrupt_or_unverifiable",
    }));
    await writeOperationRecord(operation);
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
      operationRecord: operationRecordPath(resolvedArtifactDir),
      bundle: createReattachmentBundle(operation, capture.waveRoot),
      incidents: operation.incidents,
      checkpoint: operation.checkpoint,
      attempts: operation.attempts.length,
      lastExecutorTurn: recovered.lastTurnNumber,
    };
  }

  operation.checkpoint = await checkpointCandidate(capture, taskId, candidate);
  operation.session = turn.session;
  operation.state = "completed";
  await writeOperationRecord(operation);

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
      operationRecord: operationRecordPath(resolvedArtifactDir),
      bundle: createReattachmentBundle(operation, capture.waveRoot),
      incidents: operation.incidents,
      checkpoint: operation.checkpoint,
      attempts: operation.attempts.length,
      lastExecutorTurn: recovered.lastTurnNumber,
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
      operationRecord: operationRecordPath(resolvedArtifactDir),
      bundle: createReattachmentBundle(operation, capture.waveRoot),
      incidents: operation.incidents,
      checkpoint: operation.checkpoint,
      attempts: operation.attempts.length,
      lastExecutorTurn: recovered.lastTurnNumber,
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
 * WaveWorkerResult with a candidate checkpoint, prompt text, and turn number >= 2,
 * this function:
 * 1. Revalidates the isolated paths/worktree.
 * 2. Recreates the configured adapter.
 * 3. Resumes the exact executor session when available, or hands the verified
 *    checkpoint and full task context to a fresh executor session.
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
  const { taskId, task, capture, worktree, artifactDir, config, sourceRoot, sourceRootAliases, priorResult, feedback, turn } = input;

  // ── Validate prior result ──
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

  const operation = await readOperationRecord(operationRecordPath(resolvedArtifactDir));
  operation.state = "running";
  const assignment = input.executorAssignment ?? (config.execution?.executorPool !== undefined
    ? assignmentFromOperation(operation, config) ?? configuredAssignment(config)
    : configuredAssignment(config));
  if (!assignment) {
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: "No executor pool is configured.",
      adapter: "none",
      error: "No executor pool is configured.",
    };
  }

  reportProgress(input, {
    phase: "correcting",
    message: `resuming executor turn ${turn}`,
    artifactDir: resolvedArtifactDir,
  });

  // ── Resume the exact executor session ──
  const rewrittenFeedback = buildWaveWorkerContinuationPrompt(
    feedback,
    [sourceRoot, ...(sourceRootAliases ?? [])],
    worktree.worktreeRoot,
  );

  const handoffPrompt = [
    buildWaveWorkerPrompt(task, [sourceRoot, ...(sourceRootAliases ?? [])], worktree.worktreeRoot),
    "",
    "Current continuation instructions:",
    rewrittenFeedback,
  ].join("\n");
  const poolRun = await runWithPoolFailover({
    worker: input,
    operation,
    assignment,
    prompt: priorResult.session ? rewrittenFeedback : handoffPrompt,
    handoffPrompt,
    startingTurn: turn,
    session: priorResult.session,
    reason: "continuation",
    resolvedArtifactDir,
  });
  const { recovered } = poolRun;
  const adapter = poolRun.adapter;
  if (recovered.status !== "completed" || !recovered.turn) {
    return {
      status: recovered.status === "cancelled" ? "cancelled" : recovered.error?.includes("timed out") ? "timeout" : "executor_error",
      taskId,
      title: task.title,
      summary: recovered.error ?? "Executor continuation failed.",
      session: recovered.turn?.session ?? priorResult.session,
      turn: recovered.turn,
      adapter: adapter?.kind ?? "none",
      model: adapter?.model,
      usage: recovered.turn?.usage,
      error: recovered.error ?? "Executor continuation failed.",
      operationRecord: operationRecordPath(resolvedArtifactDir),
      bundle: createReattachmentBundle(operation, capture.waveRoot),
      incidents: operation.incidents,
      checkpoint: recovered.checkpoint,
      attempts: operation.attempts.length,
      lastExecutorTurn: recovered.lastTurnNumber,
    };
  }
  if (!adapter) {
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: "Executor completed without an adapter record.",
      adapter: "none",
      error: "Executor completed without an adapter record.",
      operationRecord: operationRecordPath(resolvedArtifactDir),
      bundle: createReattachmentBundle(operation, capture.waveRoot),
      incidents: operation.incidents,
      checkpoint: operation.checkpoint,
      attempts: operation.attempts.length,
      lastExecutorTurn: recovered.lastTurnNumber,
    };
  }
  const turnResult = recovered.turn;

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
    const message = error instanceof Error ? error.message : "Candidate normalization failed.";
    operation.state = "failed_critical";
    operation.incidents.push(createIncident({
      attempt: operation.attempts.length,
      generation: operation.generation,
      cause: "workspace_error",
      stage: "checkpointing",
      message,
      retryable: false,
      terminalCode: "recovery_state_corrupt_or_unverifiable",
    }));
    await writeOperationRecord(operation);
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
      operationRecord: operationRecordPath(resolvedArtifactDir),
      bundle: createReattachmentBundle(operation, capture.waveRoot),
      incidents: operation.incidents,
      checkpoint: operation.checkpoint,
      attempts: operation.attempts.length,
      lastExecutorTurn: recovered.lastTurnNumber,
    };
  }

  operation.checkpoint = await checkpointCandidate(capture, taskId, candidate);
  operation.session = turnResult.session;
  operation.state = "completed";
  await writeOperationRecord(operation);

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
    operationRecord: operationRecordPath(resolvedArtifactDir),
    bundle: createReattachmentBundle(operation, capture.waveRoot),
    incidents: operation.incidents,
    checkpoint: operation.checkpoint,
    attempts: operation.attempts.length,
    lastExecutorTurn: recovered.lastTurnNumber,
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

async function checkpointCandidate(
  capture: WaveCaptureResult,
  taskId: string,
  candidate: CandidateCommit,
): Promise<RecoveryCheckpoint> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const output = await promisify(execFile)("git", ["diff", "--name-only", "-z", capture.baseCommit, candidate.commitSha], {
    cwd: capture.repositoryPath,
    timeout: 30_000,
  });
  return {
    checkpointId: `${capture.waveId}/${taskId}:${candidate.commitSha.slice(0, 12)}`,
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    ref: await pinRecoveryCandidate(capture, taskId, candidate),
    differsFromBase: candidate.differsFromBase,
    createdAt: new Date().toISOString(),
    verified: true,
    changedPaths: output.stdout.split("\0").filter(Boolean),
  };
}
