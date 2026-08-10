import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ReviewGateConfig } from "../config";
import type { WaveCaptureResult } from "./wave-repository";
import { captureWaveBase, WaveCaptureError } from "./wave-repository";
import {
  createWorkerWorktree,
  removeWorktree,
  isWorktreeClean,
} from "./wave-worktrees";
import type {
  WaveWorkerLifecycleResult,
  WaveWorkerLifecycleStatus,
} from "./wave-worker-lifecycle";
import { runWaveWorkerLifecycle } from "./wave-worker-lifecycle";
import type { WaveWorkerTask } from "./wave-worker";
import type {
  WaveIntegrationResult,
  WaveIntegrationSuccess,
  SelectedWorker,
} from "./wave-integration";
import { integrateWave } from "./wave-integration";
import type {
  LandingPlan,
  LandingExecutionResult,
} from "./wave-landing";
import { planWaveLanding, executeWaveLanding } from "./wave-landing";
import type { SubtaskProgressUpdate } from "./types";

// ── public input / result contract ───────────────────────────────────────────

/** Phase of the wave controller execution. */
export type WavePhase =
  | "capturing"
  | "working"
  | "settling"
  | "integrating"
  | "planning"
  | "landing"
  | "completed"
  | "aborted";

/** Progress update emitted by the controller. */
export interface WaveProgressUpdate {
  /** Current wave phase. */
  phase: WavePhase;
  /** Human-readable message. */
  message: string;
  /** Wave identifier. */
  waveId?: string;
  /** Wave root directory. */
  waveRoot?: string;
  /** Base commit SHA. */
  baseCommit?: string;
  /** Configured max concurrency. */
  maxWorkers?: number;
  /** Aggregate task counts by status. */
  counts?: { queued: number; running: number; reviewing: number; correcting: number; accepted: number; failed: number; completed: number };
  /** Per-task latest status. */
  taskStatuses?: Array<{
    taskId: string;
    phase: string;
    reviewer?: string;
    artifactDir?: string;
    executorAdapter?: string;
    executorModel?: string;
    reviewCycle?: number;
    candidateCommitSha?: string;
    acceptedCommitSha?: string;
  }>;
  /** Recent activity log (bounded). */
  activity?: string[];
  /** Per-worker progress (when available). */
  subtask?: SubtaskProgressUpdate;
}

/** Per-task result inside a wave result. */
export interface WaveTaskResult {
  /** Controller-generated task identifier. */
  taskId: string;
  /** Task title. */
  title: string;
  /** Lifecycle status. */
  status: WaveWorkerLifecycleStatus;
  /** Summary. */
  summary: string;
  /** Error detail (if any). */
  error?: string;
  /** Pinned worker ref (accepted or completed_unreviewed). */
  acceptedRef?: string;
  /** Accepted commit SHA. */
  acceptedCommitSha?: string;
  /** Whether explicitly unreviewed. */
  unreviewed?: boolean;
}

/** Integration result embedded in the wave result. */
export interface WaveIntegrationOutcome {
  /** Integration status. */
  status: WaveIntegrationResult["status"] | "error" | "worker_failure";
  /** Validation status (always 'not_run'). */
  validationStatus?: "not_run";
  /** Integrated ref (if integrated). */
  integratedRef?: string;
  /** Final integrated commit SHA. */
  finalCommitSha?: string;
  /** Worker mappings (when integrated). */
  workerMappings?: Array<{ taskId: string; originalCommitSha: string; integratedCommitSha: string; order: number }>;
  /** Conflict details. */
  conflictingTaskId?: string;
  conflictingCommitSha?: string;
  conflictingPaths?: string[];
  gitDiagnostics?: string;
  /** Error diagnostics (when status is "error"). */
  error?: string;
  /** Preserved integration worktree path (when status is "error" or "conflicted"). */
  worktree?: string;
  /** Successfully integrated worker mappings (when status is "conflicted"). */
  successfullyIntegrated?: Array<{ taskId: string; originalCommitSha: string; integratedCommitSha: string; order: number }>;
}

/** Landing result embedded in the wave result. */
export interface WaveLandingOutcome {
  /** Landing execution status. */
  status: LandingExecutionResult["status"] | "aborted";
  /** Applied paths. */
  appliedPaths?: string[];
  /** Already-applied paths. */
  alreadyAppliedPaths?: string[];
  /** Conflict details. */
  conflicts?: Array<{ path: string; reason: string }>;
  /** Failure details. */
  failedAtPath?: string | null;
  failureReason?: string;
  /** Recovery manifest path. */
  manifestPath?: string;
  /** Source HEAD drift provenance. */
  headDrift?: { drifted: boolean; capturedHead?: string; currentHead?: string };
  /** Rollback/recovery diagnostics. */
  rollbackError?: string;
}

/** Result of executing a bounded wave. */
export interface WaveResult {
  /** Wave identifier. */
  waveId: string;
  /** Wave root directory. */
  waveRoot: string;
  /** Canonical source root (Git top-level) used for landing. */
  sourceRoot: string;
  /** Final phase. */
  phase: WavePhase;
  /** Per-task results in declared order. */
  taskResults: WaveTaskResult[];
  /** Integration outcome (if integration was attempted). */
  integration?: WaveIntegrationOutcome;
  /** Landing outcome (if landing was attempted). */
  landing?: WaveLandingOutcome;
}

/** Input for the bounded wave controller. */
export interface WaveControllerInput {
  /** Working directory (source root). */
  cwd: string;
  /** Tasks to execute in declared order. */
  tasks: WaveWorkerTask[];
  /** Review gate configuration. */
  config: ReviewGateConfig;
  /** Scoped model identifiers for reviewer resolution in every worker lifecycle. */
  scopedModels?: string[];
  /** Maximum concurrent workers (1..4, default 2). */
  maxWorkers?: number;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Progress callback. */
  onProgress?: (update: WaveProgressUpdate) => void;
  /** Artifact parent directory (outside source). */
  artifactDir?: string;
  /** Wave identifier (generated if omitted). */
  waveId?: string;
  /**
   * When true, integrate eligible workers (accepted / completed_unreviewed)
   * in original declared order despite failed workers.
   * Default is false (all-or-nothing: any non-eligible worker blocks integration).
   */
  integratePartial?: boolean;
}

// ── manifest types ───────────────────────────────────────────────────────────

/** Runtime status for tasks that are still in-flight in the manifest. */
export type WaveManifestTaskRuntimeStatus =
  | "queued"
  | "starting"
  | "executing"
  | "reviewing"
  | "correcting"
  | "confirming";

/** Per-task state in the wave manifest. */
export interface WaveManifestTask {
  taskId: string;
  title: string;
  status: WaveWorkerLifecycleStatus | WaveManifestTaskRuntimeStatus;
  summary: string;
  error?: string;
  acceptedRef?: string;
  acceptedCommitSha?: string;
  unreviewed?: boolean;
  /** Executor adapter used (when known). */
  executorAdapter?: string;
  /** Executor model used (when known). */
  executorModel?: string;
  /** Latest review cycle (when in review). */
  reviewCycle?: number;
  /** Worktree path (when active). */
  worktree?: string;
  /** Artifact directory (when known). */
  artifactDir?: string;
  /** Candidate commit SHA (when executor produced changes). */
  candidateCommitSha?: string;
}

/** The wave manifest written atomically under waveRoot. */
export interface WaveManifest {
  version: 1;
  waveId: string;
  phase: WavePhase;
  /** Base capture provenance. */
  baseCommit: string;
  baseRef: string;
  repositoryPath: string;
  /** Source discovery type. */
  sourceType: string;
  /** Captured source root. */
  sourceRoot: string;
  /** Whether non-ignored untracked files are included. */
  includesUntracked: boolean;
  /** Whether ignored files are excluded. */
  excludesIgnored: boolean;
  /** Snapshot policy disclosure. */
  snapshotPolicy: string;
  /** Total bytes captured. */
  totalBytes: number;
  /** Per-task state in declared order. */
  tasks: WaveManifestTask[];
  /** Integration status (if attempted). */
  integrationStatus?: WaveIntegrationResult["status"] | "error" | "worker_failure";
  /** Integration validation status. */
  integrationValidationStatus?: "not_run";
  /** Integration worktree path (when created/preserved). */
  integrationWorktree?: string;
  /** Worker mappings (when integrated). */
  integrationWorkerMappings?: Array<{ taskId: string; originalCommitSha: string; integratedCommitSha: string; order: number }>;
  /** Successfully integrated worker mappings (when conflicted). */
  integrationSuccessfullyIntegrated?: Array<{ taskId: string; originalCommitSha: string; integratedCommitSha: string; order: number }>;
  /** Conflict details. */
  integrationConflictingTaskId?: string;
  integrationConflictingPaths?: string[];
  /** Integration error diagnostics. */
  integrationError?: string;
  integrationGitDiagnostics?: string;
  /** Landing status (if attempted). */
  landingStatus?: LandingExecutionResult["status"] | "aborted";
  /** Landing applied paths. */
  landingAppliedPaths?: string[];
  /** Landing already-applied paths. */
  landingAlreadyAppliedPaths?: string[];
  /** Landing conflicts. */
  landingConflicts?: Array<{ path: string; reason: string }>;
  /** Landing failure details. */
  landingFailedAtPath?: string | null;
  landingFailureReason?: string;
  /** Landing recovery manifest path. */
  landingManifestPath?: string;
  /** Landing rollback error. */
  landingRollbackError?: string;
  /** Landing source HEAD drift. */
  landingHeadDrift?: { drifted: boolean; capturedHead?: string; currentHead?: string };
  /** Timestamp. */
  updatedAt: string;
}

// ── validation ───────────────────────────────────────────────────────────────

const MIN_WORKERS = 1;
const MAX_WORKERS = 4;
const DEFAULT_WORKERS = 2;

function validateMaxWorkers(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_WORKERS;
  }
  if (!Number.isInteger(value) || value < MIN_WORKERS || value > MAX_WORKERS) {
    throw new Error(
      `Invalid maxWorkers: ${value}. Must be an integer between ${MIN_WORKERS} and ${MAX_WORKERS}.`,
    );
  }
  return value;
}

// ── manifest helpers ─────────────────────────────────────────────────────────

/** Write the wave manifest atomically (temp file + rename). */
async function writeWaveManifest(waveRoot: string, manifest: WaveManifest): Promise<void> {
  const manifestPath = join(waveRoot, "wave-manifest.json");
  const tmpPath = `${manifestPath}.tmp.${randomUUID()}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), "utf8");
    await fs.rename(tmpPath, manifestPath);
  } catch (err) {
    // Clean up temp file on failure.
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function buildManifest(
  waveId: string,
  phase: WavePhase,
  capture: WaveCaptureResult,
  taskResults: WaveTaskResult[],
  integrationStatus?: WaveIntegrationResult["status"] | "error" | "worker_failure",
  landingStatus?: LandingExecutionResult["status"] | "aborted",
  integrationOutcome?: WaveIntegrationOutcome,
  landingOutcome?: WaveLandingOutcome,
  handles?: WorkerHandle[],
  taskExecutorInfo?: Map<string, { adapter: string; model?: string }>,
  taskReviewCycles?: Map<string, number>,
  taskCandidateCommits?: Map<string, string>,
): WaveManifest {
  return {
    version: 1,
    waveId,
    phase,
    baseCommit: capture.baseCommit,
    baseRef: capture.baseRef,
    repositoryPath: capture.repositoryPath,
    sourceType: capture.discovery.sourceType,
    sourceRoot: capture.discovery.captureRoot,
    includesUntracked: true,
    excludesIgnored: true,
    snapshotPolicy: "non-ignored untracked included; ignored files excluded",
    totalBytes: capture.totalBytes,
    tasks: taskResults.map((tr) => {
      const executorInfo = taskExecutorInfo?.get(tr.taskId);
      const reviewCycle = taskReviewCycles?.get(tr.taskId);
      const candidateCommit = taskCandidateCommits?.get(tr.taskId);
      const handle = handles?.find((h) => h.taskId === tr.taskId);
      return {
        taskId: tr.taskId,
        title: tr.title,
        status: tr.status,
        summary: tr.summary,
        error: tr.error,
        acceptedRef: tr.acceptedRef,
        acceptedCommitSha: tr.acceptedCommitSha,
        unreviewed: tr.unreviewed,
        executorAdapter: executorInfo?.adapter,
        executorModel: executorInfo?.model,
        reviewCycle,
        worktree: handle?.worktreeRoot,
        artifactDir: handle?.artifactDir,
        candidateCommitSha: candidateCommit,
      };
    }),
    integrationStatus,
    ...(integrationOutcome?.validationStatus ? { integrationValidationStatus: integrationOutcome.validationStatus } : {}),
    ...(integrationOutcome?.worktree ? { integrationWorktree: integrationOutcome.worktree } : {}),
    ...(integrationOutcome?.workerMappings ? { integrationWorkerMappings: integrationOutcome.workerMappings } : {}),
    ...(integrationOutcome?.successfullyIntegrated ? { integrationSuccessfullyIntegrated: integrationOutcome.successfullyIntegrated } : {}),
    ...(integrationOutcome?.conflictingTaskId ? { integrationConflictingTaskId: integrationOutcome.conflictingTaskId } : {}),
    ...(integrationOutcome?.conflictingPaths ? { integrationConflictingPaths: integrationOutcome.conflictingPaths } : {}),
    ...(integrationOutcome?.error ? { integrationError: integrationOutcome.error } : {}),
    ...(integrationOutcome?.gitDiagnostics ? { integrationGitDiagnostics: integrationOutcome.gitDiagnostics } : {}),
    landingStatus,
    ...(landingOutcome?.appliedPaths ? { landingAppliedPaths: landingOutcome.appliedPaths } : {}),
    ...(landingOutcome?.alreadyAppliedPaths ? { landingAlreadyAppliedPaths: landingOutcome.alreadyAppliedPaths } : {}),
    ...(landingOutcome?.conflicts ? { landingConflicts: landingOutcome.conflicts } : {}),
    ...(landingOutcome?.failedAtPath !== undefined ? { landingFailedAtPath: landingOutcome.failedAtPath } : {}),
    ...(landingOutcome?.failureReason ? { landingFailureReason: landingOutcome.failureReason } : {}),
    ...(landingOutcome?.manifestPath ? { landingManifestPath: landingOutcome.manifestPath } : {}),
    ...(landingOutcome?.rollbackError ? { landingRollbackError: landingOutcome.rollbackError } : {}),
    ...(landingOutcome?.headDrift ? { landingHeadDrift: landingOutcome.headDrift } : {}),
    updatedAt: new Date().toISOString(),
  };
}

// ── progress helpers ─────────────────────────────────────────────────────────

function emitProgress(
  onProgress: ((update: WaveProgressUpdate) => void) | undefined,
  phase: WavePhase,
  message: string,
  subtask?: SubtaskProgressUpdate,
  extra?: Omit<WaveProgressUpdate, "phase" | "message" | "subtask">,
): void {
  onProgress?.({ phase, message, subtask, ...extra });
}

/** Compute aggregate counts from the results map, active slots, and per-task phase tracker. */
function computeCounts(
  taskItems: Array<{ taskId: string }>,
  results: Map<string, WaveWorkerLifecycleResult>,
  activeSlots: Set<number>,
  taskPhases: Map<string, string>,
): { queued: number; running: number; reviewing: number; correcting: number; accepted: number; failed: number; completed: number } {
  const queued = taskItems.length - results.size - activeSlots.size;
  let running = 0;
  let reviewing = 0;
  let correcting = 0;
  // Count active slots by their current phase.
  for (const slot of activeSlots) {
    const taskId = taskItems[slot]?.taskId;
    if (taskId) {
      const phase = taskPhases.get(taskId);
      if (phase === "reviewing") reviewing++;
      else if (phase === "correcting") correcting++;
      else running++;
    } else {
      running++;
    }
  }
  let accepted = 0;
  let failed = 0;
  let completed = 0;
  for (const r of results.values()) {
    if (r.status === "accepted") { accepted++; completed++; }
    else if (r.status === "completed_unreviewed") { accepted++; completed++; }
    else if (r.status === "no_changes") { accepted++; completed++; }
    else failed++;
  }
  return { queued, running, reviewing, correcting, accepted, failed, completed };
}

/** Build per-task status entries from handles, results, and per-task phase tracker. */
function buildTaskStatuses(
  handles: WorkerHandle[],
  results: Map<string, WaveWorkerLifecycleResult>,
  taskPhases: Map<string, string>,
  taskReviewers: Map<string, string[]>,
  taskExecutorInfo: Map<string, { adapter: string; model?: string }>,
  taskReviewCycles: Map<string, number>,
  taskCandidateCommits: Map<string, string>,
): Array<{
  taskId: string;
  phase: string;
  reviewer?: string;
  artifactDir?: string;
  executorAdapter?: string;
  executorModel?: string;
  reviewCycle?: number;
  candidateCommitSha?: string;
  acceptedCommitSha?: string;
}> {
  const statuses: Array<{
    taskId: string;
    phase: string;
    reviewer?: string;
    artifactDir?: string;
    executorAdapter?: string;
    executorModel?: string;
    reviewCycle?: number;
    candidateCommitSha?: string;
    acceptedCommitSha?: string;
  }> = [];
  for (const handle of handles) {
    const r = results.get(handle.taskId);
    const latestPhase = r ? r.status : (taskPhases.get(handle.taskId) ?? "starting");
    const reviewers = taskReviewers.get(handle.taskId);
    const executorInfo = taskExecutorInfo.get(handle.taskId);
    const reviewCycle = taskReviewCycles.get(handle.taskId);
    const candidateCommit = taskCandidateCommits.get(handle.taskId);
    statuses.push({
      taskId: handle.taskId,
      phase: latestPhase,
      reviewer: reviewers?.join(", "),
      artifactDir: handle.artifactDir,
      executorAdapter: executorInfo?.adapter,
      executorModel: executorInfo?.model,
      reviewCycle,
      candidateCommitSha: candidateCommit,
      acceptedCommitSha: r?.acceptedCommitSha,
    });
  }
  return statuses;
}

// ── worktree cleanup ─────────────────────────────────────────────────────────

/**
 * Conservatively remove a clean worktree.
 * Preserves dirty/conflicted worktrees for diagnosis.
 */
async function cleanupWorktree(
  worktreeRoot: string,
  repoPath: string,
): Promise<void> {
  try {
    const clean = await isWorktreeClean(worktreeRoot);
    if (clean) {
      await removeWorktree(worktreeRoot, repoPath);
    }
    // If not clean, preserve for diagnosis.
  } catch {
    // Cleanup failure — preserve worktree for diagnosis.
  }
}

// ── worker handle ────────────────────────────────────────────────────────────

interface WorkerHandle {
  taskId: string;
  task: WaveWorkerTask;
  worktreeRoot: string;
  artifactDir: string;
  promise: Promise<WaveWorkerLifecycleResult>;
  settled: boolean;
  executorAdapter?: string;
  executorModel?: string;
  candidateCommitSha?: string;
}

// ── worker eligibility ───────────────────────────────────────────────────────

/**
 * Check if a worker result is eligible for integration.
 * Only accepted or completed_unreviewed with a pinned exact commit are eligible.
 * no_changes is successful but contributes no commit.
 */
function isEligibleForIntegration(result: WaveTaskResult): boolean {
  return (
    (result.status === "accepted" || result.status === "completed_unreviewed") &&
    !!result.acceptedCommitSha &&
    !!result.acceptedRef
  );
}

// ── main controller ──────────────────────────────────────────────────────────

/**
 * Execute a bounded parallel wave: capture once, run workers concurrently
 * (up to maxWorkers), integrate eligible results, plan and execute landing.
 *
 * This is the controller-owned orchestrator. It:
 * 1. Validates input (maxWorkers 1..4, tasks >= 1).
 * 2. Generates deterministic task IDs (task-0, task-1, ...).
 * 3. Captures the source exactly once via captureWaveBase.
 * 4. Starts at most maxWorkers isolated worktrees/lifecycles concurrently.
 * 5. Stops dequeuing on abort; passes signal to active lifecycles; awaits settlement.
 * 6. Emits aggregate/per-worker progress via onProgress callback.
 * 7. Writes an atomically-replaced wave manifest under waveRoot.
 * 8. Selects eligible workers for integration (accepted / completed_unreviewed with pinned commit).
 * 9. Integrates in original declared order (all-or-nothing by default, integratePartial for partial).
 * 10. Plans and executes landing.
 * 11. Returns structured results.
 * 12. Never mutates source through Git operations.
 * 13. Conservatively removes clean worktrees; preserves dirty/conflicted ones.
 */
export async function executeWave(input: WaveControllerInput): Promise<WaveResult> {
  const {
    cwd,
    tasks,
    config,
    scopedModels,
    signal,
    onProgress,
    artifactDir,
    waveId: givenWaveId,
    integratePartial = false,
  } = input;

  // ── Validate input ──
  if (!tasks || tasks.length < 1) {
    throw new Error("Wave requires at least 1 task.");
  }
  const maxWorkers = validateMaxWorkers(input.maxWorkers);

  // Generate deterministic task IDs.
  const taskItems = tasks.map((task, index) => ({
    taskId: `task-${index}`,
    task,
  }));

  const waveId = givenWaveId ?? randomUUID().replace(/-/g, "").slice(0, 12);

  // Declare tracking structures before first emitProgress.
  const handles: WorkerHandle[] = [];
  const results: Map<string, WaveWorkerLifecycleResult> = new Map();
  // Per-task latest phase tracker (updated from worker progress callbacks).
  const taskPhases: Map<string, string> = new Map();
  // Per-task latest reviewer labels.
  const taskReviewers: Map<string, string[]> = new Map();
  // Per-task executor info (adapter, model).
  const taskExecutorInfo: Map<string, { adapter: string; model?: string }> = new Map();
  // Per-task latest review cycle.
  const taskReviewCycles: Map<string, number> = new Map();
  // Per-task candidate commit SHA.
  const taskCandidateCommits: Map<string, string> = new Map();
  let nextTaskIndex = 0;

  // Semaphore-based concurrency control.
  const activeSlots = new Set<number>();

  // ── Phase: capturing ──
  emitProgress(onProgress, "capturing", "Capturing wave base from source", undefined, {
    waveId, waveRoot: undefined, maxWorkers,
    counts: computeCounts(taskItems, results, activeSlots, taskPhases),
    taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
    activity: ["Capturing wave base from source"],
  });

  let capture: WaveCaptureResult;
  try {
    capture = await captureWaveBase({
      cwd,
      maxSnapshotBytes: config.maxSnapshotBytes,
      waveId,
      artifactDir,
    });
  } catch (err) {
    // Preserve typed WaveCaptureError; wrap other errors as capture_failed.
    if (err instanceof WaveCaptureError) {
      throw err;
    }
    const captureError = err instanceof Error ? err.message : "Capture failed.";
    throw new WaveCaptureError(`Wave capture failed: ${captureError}`, "capture_failed", waveId, "capturing");
  }

  const waveRoot = capture.waveRoot;

  // Write initial manifest with all tasks in queued status.
  const initialTaskResults: WaveTaskResult[] = taskItems.map((ti) => ({
    taskId: ti.taskId,
    title: ti.task.title,
    status: "queued" as WaveWorkerLifecycleStatus,
    summary: "Queued for execution.",
  }));
  await writeWaveManifest(waveRoot, buildManifest(waveId, "capturing", capture, initialTaskResults, undefined, undefined, undefined, undefined, handles, taskExecutorInfo, taskReviewCycles, taskCandidateCommits));

  // ── Phase: working ──
  emitProgress(onProgress, "working", `Starting ${taskItems.length} worker(s) with max ${maxWorkers} concurrent`, undefined, {
    waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
    counts: computeCounts(taskItems, results, activeSlots, taskPhases),
    taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
    activity: [`Starting ${taskItems.length} worker(s) with max ${maxWorkers} concurrent`],
  });

  // Serialize manifest writes to avoid stale write races.
  let manifestWriteQueue: Promise<void> = Promise.resolve();
  const queueManifestWrite = async (manifest: WaveManifest): Promise<void> => {
    const prev = manifestWriteQueue;
    manifestWriteQueue = prev.then(
      () => writeWaveManifest(waveRoot, manifest),
      () => writeWaveManifest(waveRoot, manifest),
    );
    return manifestWriteQueue;
  };

  const startWorker = async (taskIndex: number): Promise<void> => {
    if (signal?.aborted) return;

    const item = taskItems[taskIndex];
    if (!item) return;

    const slot = taskIndex;
    activeSlots.add(slot);

    try {
      // Create isolated worktree.
      const worktree = await createWorkerWorktree(capture, item.taskId);
      const artifactDir = join(waveRoot, "artifacts", item.taskId);

      const handle: WorkerHandle = {
        taskId: item.taskId,
        task: item.task,
        worktreeRoot: worktree.worktreeRoot,
        artifactDir,
        promise: runWaveWorkerLifecycle({
          taskId: item.taskId,
          task: item.task,
          capture,
          worktree,
          artifactDir,
          config,
          scopedModels,
          signal,
          onUpdate: (subtaskUpdate) => {
            // Track per-task latest phase and reviewers.
            taskPhases.set(item.taskId, subtaskUpdate.phase);
            if (subtaskUpdate.reviewers?.length) {
              taskReviewers.set(item.taskId, subtaskUpdate.reviewers);
            }
            if (subtaskUpdate.adapter) {
              taskExecutorInfo.set(item.taskId, {
                adapter: subtaskUpdate.adapter,
                model: subtaskUpdate.model,
              });
            }
            if (subtaskUpdate.reviewCycle !== undefined) {
              taskReviewCycles.set(item.taskId, subtaskUpdate.reviewCycle);
            }
            emitProgress(onProgress, "working", `${item.taskId}: ${subtaskUpdate.message}`, subtaskUpdate, {
              waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
              counts: computeCounts(taskItems, results, activeSlots, taskPhases),
              taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
              activity: [`${item.taskId}: ${subtaskUpdate.message}`],
            });

            // Serialize manifest at meaningful progress transitions.
            if (subtaskUpdate.phase === "executing" || subtaskUpdate.phase === "reviewing" || subtaskUpdate.phase === "correcting") {
              const taskResults: WaveTaskResult[] = taskItems.map((ti) => {
                const r = results.get(ti.taskId);
                if (r) {
                  return {
                    taskId: ti.taskId,
                    title: ti.task.title,
                    status: r.status,
                    summary: r.summary,
                    error: r.error,
                    acceptedRef: r.acceptedRef,
                    acceptedCommitSha: r.acceptedCommitSha,
                    unreviewed: r.unreviewed,
                  };
                }
                const activeHandle = handles.find((h) => h.taskId === ti.taskId && !h.settled);
                if (activeHandle) {
                  const phase = taskPhases.get(ti.taskId) ?? "starting";
                  return {
                    taskId: ti.taskId,
                    title: ti.task.title,
                    status: phase as WaveWorkerLifecycleStatus,
                    summary: `Currently ${phase}.`,
                  };
                }
                return {
                  taskId: ti.taskId,
                  title: ti.task.title,
                  status: "queued" as WaveWorkerLifecycleStatus,
                  summary: "Queued for execution.",
                };
              });
              queueManifestWrite(buildManifest(waveId, "working", capture, taskResults, undefined, undefined, undefined, undefined, handles, taskExecutorInfo, taskReviewCycles, taskCandidateCommits));
            }
          },
        }),
        settled: false,
      };

      handles.push(handle);

      // Write manifest at task start with truthful "starting" status.
      const taskResultsAtStart: WaveTaskResult[] = taskItems.map((ti) => {
        const r = results.get(ti.taskId);
        if (r) {
          return {
            taskId: ti.taskId,
            title: ti.task.title,
            status: r.status,
            summary: r.summary,
            error: r.error,
            acceptedRef: r.acceptedRef,
            acceptedCommitSha: r.acceptedCommitSha,
            unreviewed: r.unreviewed,
          };
        }
        const activeHandle = handles.find((h) => h.taskId === ti.taskId && !h.settled);
        if (activeHandle) {
          const phase = taskPhases.get(ti.taskId) ?? "starting";
          return {
            taskId: ti.taskId,
            title: ti.task.title,
            status: phase as WaveWorkerLifecycleStatus,
            summary: `Currently ${phase}.`,
          };
        }
        return {
          taskId: ti.taskId,
          title: ti.task.title,
          status: "queued" as WaveWorkerLifecycleStatus,
          summary: "Queued for execution.",
        };
      });
      await queueManifestWrite(buildManifest(waveId, "working", capture, taskResultsAtStart, undefined, undefined, undefined, undefined, handles, taskExecutorInfo, taskReviewCycles, taskCandidateCommits));

      // Await the worker lifecycle.
      const result = await handle.promise;
      handle.settled = true;
      results.set(item.taskId, result);

      // Track executor info and candidate commit from the settled result.
      if (result.adapter) {
        taskExecutorInfo.set(item.taskId, {
          adapter: result.adapter,
          model: result.model,
        });
      }
      // Use acceptedCommitSha or last review cycle candidate commit.
      if (result.acceptedCommitSha) {
        taskCandidateCommits.set(item.taskId, result.acceptedCommitSha);
      } else if (result.reviewCycles.length > 0) {
        const lastCycle = result.reviewCycles[result.reviewCycles.length - 1];
        taskCandidateCommits.set(item.taskId, lastCycle.candidateCommit);
      }

      // Update manifest with current results — use truthful statuses.
      // Tasks that have a result use the result status.
      // Tasks currently running in active slots use their current phase.
      // Tasks not yet started use "queued".
      const taskResults: WaveTaskResult[] = taskItems.map((ti) => {
        const r = results.get(ti.taskId);
        if (r) {
          return {
            taskId: ti.taskId,
            title: ti.task.title,
            status: r.status,
            summary: r.summary,
            error: r.error,
            acceptedRef: r.acceptedRef,
            acceptedCommitSha: r.acceptedCommitSha,
            unreviewed: r.unreviewed,
          };
        }
        // Check if this task is currently running in an active slot.
        const activeHandle = handles.find((h) => h.taskId === ti.taskId && !h.settled);
        if (activeHandle) {
          const phase = taskPhases.get(ti.taskId) ?? "starting";
          return {
            taskId: ti.taskId,
            title: ti.task.title,
            status: phase as WaveWorkerLifecycleStatus,
            summary: `Currently ${phase}.`,
            acceptedRef: undefined,
            acceptedCommitSha: undefined,
          };
        }
        // Not yet started — queued.
        return {
          taskId: ti.taskId,
          title: ti.task.title,
          status: "queued" as WaveWorkerLifecycleStatus,
          summary: "Queued for execution.",
        };
      });
      await writeWaveManifest(waveRoot, buildManifest(waveId, "working", capture, taskResults, undefined, undefined, undefined, undefined, handles, taskExecutorInfo, taskReviewCycles, taskCandidateCommits));
    } catch (err) {
      // Worker threw unexpectedly — record as executor_error.
      const result: WaveWorkerLifecycleResult = {
        status: "executor_error",
        taskId: item.taskId,
        title: item.task.title,
        summary: err instanceof Error ? err.message : "Worker failed.",
        adapter: "none",
        error: err instanceof Error ? err.message : "Worker failed.",
        reviewCycles: [],
        artifactDir: join(waveRoot, "artifacts", item.taskId),
      };
      results.set(item.taskId, result);
    } finally {
      activeSlots.delete(slot);
    }
  };

  // Dispatch workers respecting maxWorkers concurrency.
  // Refill a free slot immediately when any worker settles rather than waiting
  // for a whole batch to complete.
  const running: Array<Promise<void>> = [];

  while (nextTaskIndex < taskItems.length) {
    // Check abort before starting new workers.
    if (signal?.aborted) {
      emitProgress(onProgress, "settling", "Abort signal received — stopping new workers");
      break;
    }

    // Wait for a slot to open if at capacity.
    if (activeSlots.size >= maxWorkers) {
      // Check abort while waiting.
      if (signal?.aborted) break;
      // Await the first worker to settle so we can refill the slot immediately.
      // Wrap each promise with its index so we know which one settled.
      const settledIndex = await Promise.race(
        running.map((p, i) => p.then(() => i)),
      );
      if (settledIndex >= 0 && settledIndex < running.length) {
        running.splice(settledIndex, 1);
      }
    }

    if (signal?.aborted) break;

    // Start as many workers as we have slots for.
    while (activeSlots.size < maxWorkers && nextTaskIndex < taskItems.length) {
      if (signal?.aborted) break;
      const taskIndex = nextTaskIndex++;
      const p = startWorker(taskIndex);
      running.push(p);
    }
  }

  // Await all running workers to settle.
  if (running.length > 0) {
    await Promise.allSettled(running);
  }

  // ── Phase: settling (if aborted) ──
  if (signal?.aborted) {
    emitProgress(onProgress, "settling", "Awaiting active worker settlement", undefined, {
      waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
      counts: computeCounts(taskItems, results, activeSlots, taskPhases),
      taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
      activity: ["Awaiting active worker settlement"],
    });
    // Workers already have the abort signal; they will settle on their own.
    // The Promise.allSettled above already waited for them.
  }

  // ── Determine if integration should proceed ──
  const taskResultsArray: WaveTaskResult[] = taskItems.map((ti) => {
    const r = results.get(ti.taskId);
    // Tasks that never started (e.g., due to abort) are reported as cancelled,
    // not no_changes (which means the worker ran and produced no changes).
    // Tasks still in active slots (shouldn't happen after settle, but be safe)
    // use their current phase.
    if (r) {
      return {
        taskId: ti.taskId,
        title: ti.task.title,
        status: r.status,
        summary: r.summary,
        error: r.error,
        acceptedRef: r.acceptedRef,
        acceptedCommitSha: r.acceptedCommitSha,
        unreviewed: r.unreviewed,
      };
    }
    const activeHandle = handles.find((h) => h.taskId === ti.taskId && !h.settled);
    if (activeHandle) {
      const phase = taskPhases.get(ti.taskId) ?? "starting";
      return {
        taskId: ti.taskId,
        title: ti.task.title,
        status: phase as WaveWorkerLifecycleStatus,
        summary: `Currently ${phase}.`,
      };
    }
    return {
      taskId: ti.taskId,
      title: ti.task.title,
      status: "cancelled" as WaveWorkerLifecycleStatus,
      summary: "Task was not started.",
    };
  });

  // Check if any worker failed (not accepted, completed_unreviewed, or no_changes).
  const hasFailedWorker = taskResultsArray.some(
    (tr) => !isEligibleForIntegration(tr) && tr.status !== "no_changes",
  );

  // Select eligible workers in declared order.
  const eligibleWorkers: SelectedWorker[] = taskResultsArray
    .filter((tr) => isEligibleForIntegration(tr))
    .map((tr) => ({
      taskId: tr.taskId,
      commitSha: tr.acceptedCommitSha!,
    }));

  // ── Abort: skip integration/landing ──
  if (signal?.aborted) {
    emitProgress(onProgress, "aborted", "Wave aborted — skipping integration and landing", undefined, {
      waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
      counts: computeCounts(taskItems, results, activeSlots, taskPhases),
      taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
      activity: ["Wave aborted — skipping integration and landing"],
    });

    // Update manifest.
    await writeWaveManifest(waveRoot, buildManifest(waveId, "aborted", capture, taskResultsArray, undefined, undefined, undefined, undefined, handles, taskExecutorInfo, taskReviewCycles, taskCandidateCommits));

    // Cleanup clean worktrees.
    await cleanupWorktrees(handles, capture);

    return {
      waveId,
      waveRoot,
      sourceRoot: capture.discovery.captureRoot,
      phase: "aborted",
      taskResults: taskResultsArray,
    };
  }

  // ── Integration eligibility check ──
  if (!integratePartial && hasFailedWorker) {
    emitProgress(onProgress, "completed", "Integration skipped: failed worker(s) present (all-or-nothing policy)", undefined, {
      waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
      counts: computeCounts(taskItems, results, activeSlots, taskPhases),
      taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
      activity: ["Integration skipped: failed worker(s) present (all-or-nothing policy)"],
    });

    await writeWaveManifest(waveRoot, buildManifest(waveId, "completed", capture, taskResultsArray, undefined, undefined, undefined, undefined, handles, taskExecutorInfo, taskReviewCycles, taskCandidateCommits));

    // Cleanup clean worktrees.
    await cleanupWorktrees(handles, capture);

    return {
      waveId,
      waveRoot,
      sourceRoot: capture.discovery.captureRoot,
      phase: "completed",
      taskResults: taskResultsArray,
    };
  }

  // ── Partial mode: all workers failed — skip integration/landing ──
  if (integratePartial && hasFailedWorker && eligibleWorkers.length === 0) {
    emitProgress(onProgress, "completed", "Integration skipped: all workers failed (partial mode)", undefined, {
      waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
      counts: computeCounts(taskItems, results, activeSlots, taskPhases),
      taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
      activity: ["Integration skipped: all workers failed (partial mode)"],
    });

    const workerFailureOutcome: WaveIntegrationOutcome = {
      status: "worker_failure",
    };

    await writeWaveManifest(waveRoot, buildManifest(waveId, "completed", capture, taskResultsArray, "worker_failure", undefined, undefined, undefined, handles, taskExecutorInfo, taskReviewCycles, taskCandidateCommits));

    // Cleanup clean worktrees.
    await cleanupWorktrees(handles, capture);

    return {
      waveId,
      waveRoot,
      sourceRoot: capture.discovery.captureRoot,
      phase: "completed",
      taskResults: taskResultsArray,
      integration: workerFailureOutcome,
    };
  }

  // ── Phase: integrating ──
  emitProgress(onProgress, "integrating", `Integrating ${eligibleWorkers.length} eligible worker(s)`, undefined, {
    waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
    counts: computeCounts(taskItems, results, activeSlots, taskPhases),
    taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
    activity: [`Integrating ${eligibleWorkers.length} eligible worker(s)`],
  });

  let integrationOutcome: WaveIntegrationOutcome | undefined;
  let integrationResult: WaveIntegrationResult | undefined;

  try {
    integrationResult = await integrateWave(capture, eligibleWorkers);

    if (integrationResult.status === "integrated") {
      integrationOutcome = {
        status: "integrated",
        validationStatus: "not_run",
        integratedRef: integrationResult.integratedRef,
        finalCommitSha: integrationResult.finalCommitSha,
        workerMappings: integrationResult.workerMappings.map((m) => ({
          taskId: m.taskId,
          originalCommitSha: m.originalCommitSha,
          integratedCommitSha: m.integratedCommitSha,
          order: m.order,
        })),
        worktree: integrationResult.worktree,
      };
    } else if (integrationResult.status === "conflicted") {
      integrationOutcome = {
        status: "conflicted",
        conflictingTaskId: integrationResult.conflictingTaskId,
        conflictingCommitSha: integrationResult.conflictingCommitSha,
        conflictingPaths: integrationResult.conflictingPaths,
        gitDiagnostics: integrationResult.gitDiagnostics,
        worktree: integrationResult.worktree,
        successfullyIntegrated: integrationResult.successfullyIntegrated.map((m) => ({
          taskId: m.taskId,
          originalCommitSha: m.originalCommitSha,
          integratedCommitSha: m.integratedCommitSha,
          order: m.order,
        })),
      };
    } else {
      // no_changes
      integrationOutcome = {
        status: "no_changes",
        validationStatus: "not_run",
        worktree: integrationResult.worktree,
        workerMappings: [],
      };
    }
  } catch (err) {
    // Infrastructure error — distinct from conflicts.
    // Never mislabel as conflict; always "error".
    // Detect the deterministic integration worktree path without following symlinks.
    const integrationWorktreePath = join(waveRoot, "integration");
    let worktreeExists = false;
    try {
      await fs.lstat(integrationWorktreePath);
      worktreeExists = true;
    } catch {
      worktreeExists = false;
    }
    integrationOutcome = {
      status: "error",
      error: err instanceof Error ? err.message : "Integration failed.",
      gitDiagnostics: err instanceof Error ? err.stack : undefined,
      ...(worktreeExists ? { worktree: integrationWorktreePath } : {}),
    };
  }

  // Update manifest with integration status.
  await writeWaveManifest(waveRoot, buildManifest(
    waveId, "integrating", capture, taskResultsArray,
    integrationResult?.status,
    undefined,
    integrationOutcome,
    undefined,
    handles,
    taskExecutorInfo,
    taskReviewCycles,
    taskCandidateCommits,
  ));

  // ── Abort check after integration ──
  if (signal?.aborted) {
    emitProgress(onProgress, "aborted", "Wave aborted after integration — skipping landing", undefined, {
      waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
      counts: computeCounts(taskItems, results, activeSlots, taskPhases),
      taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
      activity: ["Wave aborted after integration — skipping landing"],
    });

    const abortIntegrationStatus = integrationOutcome?.status ?? integrationResult?.status;
    await writeWaveManifest(waveRoot, buildManifest(waveId, "aborted", capture, taskResultsArray,
      abortIntegrationStatus,
      undefined,
      integrationOutcome,
      undefined,
      handles,
      taskExecutorInfo,
      taskReviewCycles,
      taskCandidateCommits,
    ));

    // Cleanup clean worktrees.
    await cleanupWorktrees(handles, capture, integrationResult?.worktree);

    return {
      waveId,
      waveRoot,
      sourceRoot: capture.discovery.captureRoot,
      phase: "aborted",
      taskResults: taskResultsArray,
      integration: integrationOutcome,
    };
  }

  // If integration conflicted or errored, skip landing.
  if (integrationResult?.status === "conflicted" || integrationOutcome?.status === "error") {
    const integrationStatusLabel = integrationOutcome?.status === "error"
      ? "error"
      : integrationResult?.status;
    const message = integrationOutcome?.status === "error"
      ? "Integration infrastructure error — skipping landing"
      : "Integration conflicted — skipping landing";
    emitProgress(onProgress, "completed", message, undefined, {
      waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
      counts: computeCounts(taskItems, results, activeSlots, taskPhases),
      taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
      activity: [message],
    });

    await writeWaveManifest(waveRoot, buildManifest(
      waveId, "completed", capture, taskResultsArray,
      integrationStatusLabel,
      undefined,
      integrationOutcome,
      undefined,
      handles,
      taskExecutorInfo,
      taskReviewCycles,
      taskCandidateCommits,
    ));

    // Cleanup clean worktrees (preserve integration worktree for conflict diagnosis).
    await cleanupWorktrees(handles, capture);

    return {
      waveId,
      waveRoot,
      sourceRoot: capture.discovery.captureRoot,
      phase: "completed",
      taskResults: taskResultsArray,
      integration: integrationOutcome,
    };
  }

  // Determine the commit SHA for landing.
  // For "integrated" use the finalCommitSha; for "no_changes" use the baseCommit.
  if (!integrationResult) {
    // Should not be reached, but handle defensively.
    await cleanupWorktrees(handles, capture);
    return {
      waveId,
      waveRoot,
      sourceRoot: capture.discovery.captureRoot,
      phase: "completed",
      taskResults: taskResultsArray,
      integration: integrationOutcome,
    };
  }

  const landingCommitSha = integrationResult.status === "integrated"
    ? (integrationResult as WaveIntegrationSuccess).finalCommitSha
    : capture.baseCommit;
  const integrationWorktree = integrationResult.worktree;

  // ── Phase: planning ──
  emitProgress(onProgress, "planning", "Planning wave landing", undefined, {
    waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
    counts: computeCounts(taskItems, results, activeSlots, taskPhases),
    taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
    activity: ["Planning wave landing"],
  });

  let landingPlan: LandingPlan;
  try {
    landingPlan = await planWaveLanding(
      capture,
      landingCommitSha,
      capture.discovery.captureRoot,
    );
  } catch (err) {
    emitProgress(onProgress, "completed", `Landing planning failed: ${err instanceof Error ? err.message : "unknown"}`, undefined, {
      waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
      counts: computeCounts(taskItems, results, activeSlots, taskPhases),
      taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
      activity: [`Landing planning failed: ${err instanceof Error ? err.message : "unknown"}`],
    });

    await writeWaveManifest(waveRoot, buildManifest(
      waveId, "completed", capture, taskResultsArray,
      integrationResult.status,
      undefined,
      integrationOutcome,
      undefined,
      handles,
      taskExecutorInfo,
      taskReviewCycles,
      taskCandidateCommits,
    ));

    await cleanupWorktrees(handles, capture, integrationWorktree);

    return {
      waveId,
      waveRoot,
      sourceRoot: capture.discovery.captureRoot,
      phase: "completed",
      taskResults: taskResultsArray,
      integration: integrationOutcome,
    };
  }

  // ── Abort check after planning ──
  if (signal?.aborted) {
    emitProgress(onProgress, "aborted", "Wave aborted after planning — skipping landing", undefined, {
      waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
      counts: computeCounts(taskItems, results, activeSlots, taskPhases),
      taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
      activity: ["Wave aborted after planning — skipping landing"],
    });

    await writeWaveManifest(waveRoot, buildManifest(waveId, "aborted", capture, taskResultsArray,
      integrationResult?.status,
      "aborted",
      integrationOutcome,
      { status: "aborted" },
      handles,
      taskExecutorInfo,
      taskReviewCycles,
      taskCandidateCommits,
    ));

    await cleanupWorktrees(handles, capture, integrationWorktree);

    return {
      waveId,
      waveRoot,
      sourceRoot: capture.discovery.captureRoot,
      phase: "aborted",
      taskResults: taskResultsArray,
      integration: integrationOutcome,
      landing: { status: "aborted" },
    };
  }

  // If plan has conflicts, skip landing.
  if (landingPlan.conflicts.length > 0) {
    emitProgress(onProgress, "completed", `Landing planning found ${landingPlan.conflicts.length} conflict(s)`, undefined, {
      waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
      counts: computeCounts(taskItems, results, activeSlots, taskPhases),
      taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
      activity: [`Landing planning found ${landingPlan.conflicts.length} conflict(s)`],
    });

    await writeWaveManifest(waveRoot, buildManifest(
      waveId, "completed", capture, taskResultsArray,
      integrationResult.status,
      undefined,
      integrationOutcome,
      { status: "conflicted", conflicts: landingPlan.conflicts },
      handles,
      taskExecutorInfo,
      taskReviewCycles,
      taskCandidateCommits,
    ));

    await cleanupWorktrees(handles, capture, integrationWorktree);

    return {
      waveId,
      waveRoot,
      sourceRoot: capture.discovery.captureRoot,
      phase: "completed",
      taskResults: taskResultsArray,
      integration: integrationOutcome,
      landing: {
        status: "conflicted",
        conflicts: landingPlan.conflicts,
      },
    };
  }

  // ── Phase: landing ──
  emitProgress(onProgress, "landing", "Executing wave landing", undefined, {
    waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
    counts: computeCounts(taskItems, results, activeSlots, taskPhases),
    taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
    activity: ["Executing wave landing"],
  });

  let landingResult: LandingExecutionResult;
  try {
    landingResult = await executeWaveLanding(landingPlan, capture, signal);
  } catch (err) {
    landingResult = {
      status: "rolled_back",
      appliedPaths: [],
      failedAtPath: null,
      failureReason: err instanceof Error ? err.message : "Landing failed.",
    };
  }

  // Build landing outcome with HEAD drift provenance.
  const landingOutcome: WaveLandingOutcome = buildLandingOutcome(landingResult, landingPlan.headDrift);

  // Await queued writes before terminal write.
  await manifestWriteQueue;

  // Update manifest with landing status.
  await writeWaveManifest(waveRoot, buildManifest(
    waveId, "completed", capture, taskResultsArray,
    integrationResult.status,
    landingResult.status,
    integrationOutcome,
    landingOutcome,
    handles,
    taskExecutorInfo,
    taskReviewCycles,
    taskCandidateCommits,
  ));

  // Cleanup clean worktrees including integration worktree.
  await cleanupWorktrees(handles, capture, integrationWorktree);

  emitProgress(onProgress, "completed", `Wave completed: landing ${landingResult.status}`, undefined, {
    waveId, waveRoot, baseCommit: capture.baseCommit, maxWorkers,
    counts: computeCounts(taskItems, results, activeSlots, taskPhases),
    taskStatuses: buildTaskStatuses(handles, results, taskPhases, taskReviewers, taskExecutorInfo, taskReviewCycles, taskCandidateCommits),
    activity: [`Wave completed: landing ${landingResult.status}`],
  });

  return {
    waveId,
    waveRoot,
    sourceRoot: capture.discovery.captureRoot,
    phase: "completed",
    taskResults: taskResultsArray,
    integration: integrationOutcome,
    landing: landingOutcome,
  };
}

// ── landing outcome builder ──────────────────────────────────────────────────

function buildLandingOutcome(
  result: LandingExecutionResult,
  headDrift?: { drifted: boolean; capturedHead?: string; currentHead?: string },
): WaveLandingOutcome {
  switch (result.status) {
    case "landed":
      return {
        status: "landed",
        appliedPaths: result.appliedPaths,
        alreadyAppliedPaths: result.alreadyAppliedPaths,
        manifestPath: result.manifestPath,
        ...(headDrift ? { headDrift } : {}),
      };
    case "conflicted":
      return {
        status: "conflicted",
        conflicts: result.conflicts,
        ...(headDrift ? { headDrift } : {}),
      };
    case "rolled_back":
      return {
        status: "rolled_back",
        appliedPaths: result.appliedPaths,
        failedAtPath: result.failedAtPath,
        failureReason: result.failureReason,
        ...(headDrift ? { headDrift } : {}),
      };
    case "recovery_required":
      return {
        status: "recovery_required",
        manifestPath: result.diagnostics.manifestPath,
        failedAtPath: result.diagnostics.failedAtPath,
        failureReason: result.diagnostics.failureReason,
        rollbackError: result.diagnostics.rollbackError,
        ...(headDrift ? { headDrift } : {}),
      };
  }
}

// ── worktree cleanup helper ──────────────────────────────────────────────────

async function cleanupWorktrees(
  handles: WorkerHandle[],
  capture: WaveCaptureResult,
  integrationWorktree?: string,
): Promise<void> {
  for (const handle of handles) {
    await cleanupWorktree(handle.worktreeRoot, capture.repositoryPath);
  }
  // Clean integration worktree if provided and clean.
  if (integrationWorktree) {
    await cleanupWorktree(integrationWorktree, capture.repositoryPath);
  }
}
