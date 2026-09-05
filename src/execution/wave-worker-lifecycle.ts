import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { GIT_NO_LOCKS_ENV as GIT_ENV } from "./wave-validation";

const execFileAsync = promisify(execFile);

/** Reset a worktree HEAD to a specific commit. */
async function gitResetHard(worktreeRoot: string, commitSha: string): Promise<void> {
  await execFileAsync(
    "git",
    ["reset", "--hard", commitSha],
    {
      cwd: worktreeRoot,
      env: { ...process.env, ...GIT_ENV },
      timeout: 30_000,
    },
  );
}
import {
  rewriteTaskPaths,
  runWaveWorker,
  resumeWaveWorker,
  createTaskInstructionEvidenceRecorder,
  validateArtifactPath,
  type WaveWorkerInput,
  type WaveWorkerResult,
  type WaveWorkerTask,
} from "./wave-worker";
import {
  buildCandidateReviewPatch,
  pinReviewCycleCandidate,
  reviewCycleAliasRefName,
  verifyReviewCycleIdentity,
  type CandidateCommit,
  type WaveIdentityCapture,
} from "./wave-commits";
import { pinCommit } from "./wave-worktrees";
import {
  configWithReviewers,
  resolveReviewers,
  reviewerDisplayLabel,
  type DeciderConfig,
  type ReviewGateConfig,
} from "../config";
import {
  runReview,
  type ExactChangeInput,
  type ReviewRunOutput,
} from "../review";
import {
  createEvidenceState,
  rememberFinalAssistantSummaryText,
  type EvidenceState,
} from "../evidence";
import type { ReviewWindow } from "../state";
import {
  createState,
  setReviewWindowBaseline,
  recordReviewerFeedback,
  armReviewResponseExchange,
  type ReviewGateState,
} from "../state";
import type { ReviewResult } from "../schema";
import type { TokenUsage } from "../usage";
import {
  buildReviewReportFromOutputs,
  hasPartialReviewerFailure,
  type SubtaskReviewReport,
} from "../review-report";
import type { SubtaskProgressUpdate } from "./types";
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from "../capture";
import {
  createReviewTransmissionMessage,
  type ReviewTransmissionAction,
} from "../transmission";
import {
  createReattachmentBundle,
  buildOperationDiagnostics,
  createIncident,
  readOperationRecord,
  writeOperationRecord,
  type ExecutionIncident,
  type ReattachmentBundle,
  type RecoveryCheckpoint,
  type OperationDiagnostics,
} from "./operation-record";
import { DEFAULT_EXECUTION_RETRY_POLICY } from "../config";

// ── types ────────────────────────────────────────────────────────────────────

/** Status of a complete wave worker lifecycle. */
export type WaveWorkerLifecycleStatus =
  | "accepted"
  | "accepted_with_warnings"
  | "completed_unreviewed"
  | "no_changes"
  | "review_error"
  | "correction_cap"
  | "executor_error"
  | "timeout"
  | "cancelled"
  | "reviewer_blocked";

/** One review cycle within the lifecycle. */
export interface ReviewCycle {
  /** 1-based cycle number. */
  cycle: number;
  /** Wave base commit SHA (immutable). */
  baseCommit: string;
  /** Candidate commit SHA under review. */
  candidateCommit: string;
  /** Candidate tree SHA. */
  candidateTreeSha: string;
  /** Immutable per-cycle review alias ref that pins the candidate. */
  candidateRef: string;
  /** Verdict from the review. */
  verdict: ReviewResult["verdict"];
  /** Review output details. */
  reviewOutput: ReviewRunOutput;
}

/** Result of running a complete wave worker lifecycle. */
export interface WaveWorkerLifecycleResult {
  status: WaveWorkerLifecycleStatus;
  taskId: string;
  title: string;
  summary: string;
  adapter: string;
  model?: string;
  usage?: TokenUsage;
  error?: string;
  /** All review cycles that occurred. */
  reviewCycles: ReviewCycle[];
  /** The pinned worker ref (only for accepted or completed_unreviewed). */
  acceptedRef?: string;
  /** The accepted commit SHA (only for accepted or completed_unreviewed). */
  acceptedCommitSha?: string;
  /** Whether the result is explicitly unreviewed. */
  unreviewed?: boolean;
  /** Worker artifact directory. */
  artifactDir: string;
  reviewReport?: SubtaskReviewReport;
  operationRecord?: string;
  bundle?: ReattachmentBundle;
  incidents?: ExecutionIncident[];
  checkpoint?: RecoveryCheckpoint;
  attempts?: number;
  diagnostics?: OperationDiagnostics;
}

/** Input for the lifecycle. Extends WaveWorkerInput with review-specific options. */
export interface WaveWorkerLifecycleInput extends WaveWorkerInput {
  /** Maximum correction cycles before giving up. Defaults to config.maxCorrectionCycles. */
  maxCorrectionCycles?: number;
  /** Pre-existing continued executor result used when reattaching to a paused operation. */
  initialResult?: WaveWorkerResult;
}

// ── progress helpers ─────────────────────────────────────────────────────────

function reportProgress(
  input: WaveWorkerLifecycleInput,
  update: Omit<SubtaskProgressUpdate, "subtaskId">,
): void {
  input.onUpdate?.({ subtaskId: input.taskId, ...update });
}

// ── reviewer validation ──────────────────────────────────────────────────────

/**
 * Freeze and validate reviewer selection for this worker.
 * Returns a frozen config with materialized reviewers, or throws on blockage.
 */
export function reviewerProgressLabel(reviewer: DeciderConfig): string {
  if (reviewer.adapter === "pi-model") {
    return reviewerDisplayLabel(reviewer);
  }
  if ((reviewer.adapter === "codex-cli" || reviewer.adapter === "claude-cli") && reviewer.model) {
    return reviewer.model;
  }
  return reviewerDisplayLabel(reviewer);
}

function freezeReviewers(
  config: ReviewGateConfig,
  scopedModels: string[] = [],
): { frozenConfig: ReviewGateConfig; enabled: boolean } {
  const resolution = resolveReviewers(config, scopedModels);
  if (resolution.unknownIds.length > 0) {
    throw new Error(
      `Blocked reviewer selection: unknown enabled reviewer ids: ${resolution.unknownIds.join(", ")}`,
    );
  }
  if (resolution.duplicateEnabledIds.length > 0) {
    throw new Error(
      `Blocked reviewer selection: duplicate enabled reviewer ids: ${resolution.duplicateEnabledIds.join(", ")}`,
    );
  }
  const enabled = config.enabled && resolution.reviewers.length > 0;
  // Materialize a frozen config so runReview uses the exact resolved reviewers.
  const frozenConfig = configWithReviewers(config, resolution.reviewers, enabled);
  return { frozenConfig, enabled };
}

// ── worker-local review window ───────────────────────────────────────────────

/**
 * Create a worker-local ReviewWindow with a minimal ReviewGateState wrapper
 * so that state helpers (recordReviewerFeedback, armReviewResponseExchange)
 * can be used to maintain serial behavior.
 */
function createWorkerReviewState(): { state: ReviewGateState; window: ReviewWindow } {
  const state = createState();
  const window: ReviewWindow = {
    id: state.nextReviewWindowId++,
    startedAt: new Date().toISOString(),
    requestHistory: [],
    correctionCycles: 0,
    evidence: createEvidenceState(),
    reviewHistory: [],
    exchanges: [],
    nextExchangeSequence: 1,
    nextReviewSequence: 1,
    reviewerSessions: new Map(),
    retainBundleAfterClose: false,
    nextExchangeRequestIndex: 0,
  };
  state.reviewWindow = window;
  return { state, window };
}

// ── review helpers ───────────────────────────────────────────────────────────

/**
 * Build the complete review transmission message for correction or pass.
 * Uses the standard transmission format with all reviewer results.
 */
async function buildReviewTransmission(
  reviewOutput: ReviewRunOutput,
  invocationDir: string,
  bundleDir: string,
  reviewSequence: number,
  action: ReviewTransmissionAction,
): Promise<string> {
  const result = reviewOutput.result;
  if (!result) {
    return "Review feedback unavailable.";
  }
  return createReviewTransmissionMessage({
    invocationDir,
    reviewSequence,
    gateVerdict: result.verdict,
    reviewerResults: reviewOutput.reviewerResults ?? [result],
    bundleDir,
    action,
  });
}

/**
 * Build a comprehensive review request containing the full bounded task
 * definition and workspace disclosure for the reviewer.
 */
function buildReviewRequest(task: WaveWorkerTask): string {
  const lines = [
    "Review the candidate changes against the following bounded task:",
    "",
    `Subtask: ${task.title}`,
    "",
    "Task instructions:",
    task.instructions,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((c) => `- ${c}`),
  ];
  if (task.relevantContext) {
    lines.push("", "Relevant context:", task.relevantContext);
  }
  if (task.authoritativeUpdates?.length) {
    lines.push(
      "",
      "Acknowledged task updates (authoritative, in delivery order):",
      "Later updates supersede any conflicting original instruction or acceptance criterion. Review the candidate against the resulting effective request.",
      ...task.authoritativeUpdates.map((item) => `- [${item.action}:${item.instructionId}] ${item.instruction}`),
    );
  }
  lines.push(
    "",
    "Workspace snapshot disclosure:",
    "The isolated snapshot contains tracked files and non-ignored untracked files.",
    "Git-ignored files are not present in this snapshot.",
  );
  return lines.join("\n");
}

/** Run review on a candidate with exact Git patch data. */
async function runCandidateReview(
  frozenConfig: ReviewGateConfig,
  task: WaveWorkerTask,
  capture: WaveIdentityCapture,
  taskId: string,
  aliasRef: string,
  candidate: { commitSha: string; treeSha: string },
  window: ReviewWindow,
  evidence: EvidenceState,
  worktreeRoot: string,
  baseSnapshot: WorkspaceSnapshot,
  maxPatchBytes: number,
  correctionAttemptCount: number,
  signal?: AbortSignal,
  onUpdate?: (message: string) => void,
): Promise<ReviewRunOutput> {
  // Verify the immutable cycle alias still pins the exact candidate identity
  // before generating the patch the reviewers will see.
  await verifyReviewCycleIdentity(
    capture,
    taskId,
    aliasRef,
    candidate,
  );

  // Build the exact patch from Git.
  const patch = await buildCandidateReviewPatch(
    capture.repositoryPath,
    capture.baseCommit,
    candidate.commitSha,
    maxPatchBytes,
  );

  const exactChange: ExactChangeInput = {
    changedPaths: patch.changedPaths,
    patch: patch.patch,
    truncated: patch.truncated,
    omitted: patch.omitted,
  };

  return runReview({
    cwd: worktreeRoot,
    request: buildReviewRequest(task),
    before: baseSnapshot,
    config: frozenConfig,
    evidence,
    changeIdentity: { baseCommit: capture.baseCommit, candidateCommit: candidate.commitSha },
    exactChange,
    window,
    correctionAttemptCount,
    signal,
    onUpdate,
  });
}

async function runCandidateReviewWithRecovery(
  invoke: () => Promise<ReviewRunOutput>,
  artifactDir: string,
  config: ReviewGateConfig,
  signal?: AbortSignal,
): Promise<ReviewRunOutput> {
  const policy = config.execution?.retryPolicy ?? DEFAULT_EXECUTION_RETRY_POLICY;
  let retries = 0;
  let repeated = 0;
  let priorMessage: string | undefined;
  let lastMessage = "Review failed.";
  for (;;) {
    let output: ReviewRunOutput | undefined;
    let thrown: unknown;
    try {
      output = await invoke();
    } catch (error) {
      thrown = error;
    }
    if (signal?.aborted || output?.result?.error === "aborted") {
      if (thrown) throw thrown;
      return output!;
    }
    const failed = thrown !== undefined || output?.result?.verdict === "error" || Boolean(output?.error);
    if (!failed) {
      await resolveReviewIncidents(artifactDir);
      return output!;
    }
    lastMessage = thrown instanceof Error
      ? thrown.message
      : output?.result?.error ?? output?.error ?? output?.result?.summary ?? "Review failed.";
    repeated = priorMessage === lastMessage ? repeated + 1 : 1;
    priorMessage = lastMessage;
    await recordReviewIncident(artifactDir, lastMessage, retries + 1, retries < policy.maxRetries && repeated <= policy.maxSameIncidentRepeats);
    if (retries >= policy.maxRetries || repeated > policy.maxSameIncidentRepeats) {
      if (thrown) throw thrown;
      return output!;
    }
    retries += 1;
    await executionRetryDelay(policy.baseDelayMs, policy.maxDelayMs, policy.jitter, retries, signal);
  }
}

async function resolveReviewIncidents(artifactDir: string): Promise<void> {
  try {
    const operation = await readOperationRecord(join(artifactDir, "operation.json"));
    let changed = false;
    for (const incident of operation.incidents) {
      if (incident.cause === "review_error" && !incident.resolvedAt) {
        incident.resolvedAt = new Date().toISOString();
        incident.resolution = "review_recovered";
        changed = true;
      }
    }
    if (changed) await writeOperationRecord(operation);
  } catch {
    // Diagnostic augmentation is best effort; review output stays authoritative.
  }
}

async function recordReviewIncident(artifactDir: string, message: string, attempt: number, retryable: boolean): Promise<void> {
  try {
    const operation = await readOperationRecord(join(artifactDir, "operation.json"));
    operation.state = retryable ? "retrying" : "paused_recoverable";
    operation.incidents.push(createIncident({
      attempt,
      generation: operation.generation,
      cause: "review_error",
      stage: "reviewing",
      message,
      retryable,
    }));
    await writeOperationRecord(operation);
  } catch {
    // The ordinary review result remains authoritative if diagnostics cannot
    // be augmented (for example, a pre-operation validation failure).
  }
}

async function executionRetryDelay(base: number, max: number, jitter: boolean, retry: number, signal?: AbortSignal): Promise<void> {
  if (base === 0) return;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, retry - 1));
  const delay = jitter ? Math.floor(ceiling * (0.5 + Math.random() * 0.5)) : ceiling;
  await new Promise<void>((resolvePromise, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    };
    const timer = setTimeout(finish, delay);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Review retry cancelled."));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

// ── result writing ───────────────────────────────────────────────────────────

/** Write result.json to the worker artifact root. */
async function writeResult(artifactDir: string, result: WaveWorkerLifecycleResult): Promise<void> {
  try {
    const operation = await readOperationRecord(join(artifactDir, "operation.json"));
    operation.state = lifecycleOperationState(result.status);
    await writeOperationRecord(operation);
    result.operationRecord = join(artifactDir, "operation.json");
    result.bundle = createReattachmentBundle(operation, resolve(artifactDir, "..", ".."));
    result.incidents = operation.incidents;
    result.checkpoint = operation.checkpoint;
    result.attempts = operation.attempts.length;
    result.diagnostics = await buildOperationDiagnostics(operation, resolve(artifactDir, "..", ".."));
  } catch {
    // Preflight failures can occur before an operation record exists. The
    // caller still receives the ordinary lifecycle result for those cases.
  }
  result.reviewReport ??= buildReviewReportFromOutputs({
    outputs: result.reviewCycles,
    artifactDir,
  });
  await writeFile(
    join(artifactDir, "result.json"),
    JSON.stringify({
      version: 1,
      status: result.status,
      taskId: result.taskId,
      title: result.title,
      summary: result.summary,
      adapter: result.adapter,
      model: result.model,
      acceptedRef: result.acceptedRef,
      acceptedCommitSha: result.acceptedCommitSha,
      unreviewed: result.unreviewed,
      reviewCycles: result.reviewCycles.map((c) => ({
        cycle: c.cycle,
        baseCommit: c.baseCommit,
        candidateCommit: c.candidateCommit,
        candidateTreeSha: c.candidateTreeSha,
        candidateRef: c.candidateRef,
        verdict: c.verdict,
      })),
      reviewReport: result.reviewReport,
      operationRecord: result.operationRecord,
      bundle: result.bundle,
      incidents: result.incidents,
      checkpoint: result.checkpoint,
      attempts: result.attempts,
      diagnostics: result.diagnostics,
      error: result.error,
      completedAt: new Date().toISOString(),
    }, null, 2),
    "utf8",
  );
}

function lifecycleOperationState(status: WaveWorkerLifecycleStatus): import("./operation-record").OperationState {
  if (status === "cancelled") return "cancelled";
  if (status === "accepted" || status === "accepted_with_warnings" || status === "completed_unreviewed" || status === "no_changes") {
    return "completed";
  }
  return "paused_recoverable";
}

function executionMetadata(result: WaveWorkerResult): Pick<
  WaveWorkerLifecycleResult,
  "operationRecord" | "bundle" | "incidents" | "checkpoint" | "attempts"
> {
  return {
    operationRecord: result.operationRecord,
    bundle: result.bundle,
    incidents: result.incidents,
    checkpoint: result.checkpoint,
    attempts: result.attempts,
  };
}

// ── main lifecycle ───────────────────────────────────────────────────────────

/**
 * Run one complete isolated worker review/correction lifecycle.
 *
 * This function:
 * 1. Freezes/validates reviewer selection.
 * 2. Snapshots the worker worktree at the wave base.
 * 3. Runs the initial executor turn via runWaveWorker.
 * 4. For a changed candidate with review enabled, builds its exact patch and calls runReview.
 * 5. On needs_changes, resumes the same executor session via resumeWaveWorker with correction feedback.
 * 6. Honors maxCorrectionCycles and no-progress detection.
 * 7. On pass, transmits the pass for observation and resumes once; if the resulting tree is
 *    unchanged from the passed candidate tree, pins the exact passed commit under the immutable
 *    workers/<task-id> ref and accepts it. If the tree changed, the old pass is invalid and the
 *    new candidate must be reviewed.
 * 8. If review is explicitly disabled/no reviewers, pins the changed candidate and returns
 *    completed_unreviewed.
 * 9. Writes result.json in the worker artifact root.
 *
 * This function does NOT:
 * - Schedule waves or manage manifests.
 * - Checkpoint parent state.
 * - Remove worktrees or artifacts.
 * - Implement integration or landing.
 */
export async function runWaveWorkerLifecycle(
  input: WaveWorkerLifecycleInput,
): Promise<WaveWorkerLifecycleResult> {
  const {
    taskId,
    task,
    capture,
    worktree,
    artifactDir,
    config,
    scopedModels,
    signal,
  } = input;

  const resolvedArtifactDir = resolve(artifactDir);
  const steeringEvidence = createTaskInstructionEvidenceRecorder(task, resolvedArtifactDir);
  const publishLiveControl = (control: import("./types").ExecutorLiveControl | undefined): void => {
    input.onLiveControl?.(steeringEvidence.wrap(control));
  };

  // Validate maxCorrectionCycles override as a non-negative integer.
  const initialMaxCorrectionCycles = input.maxCorrectionCycles ?? config.maxCorrectionCycles;
  if (!Number.isInteger(initialMaxCorrectionCycles) || initialMaxCorrectionCycles < 0) {
    const result: WaveWorkerLifecycleResult = {
      status: "review_error",
      taskId,
      title: task.title,
      summary: `Invalid maxCorrectionCycles: ${initialMaxCorrectionCycles}. Must be a non-negative integer.`,
      adapter: "none",
      error: `Invalid maxCorrectionCycles: ${initialMaxCorrectionCycles}`,
      reviewCycles: [],
      artifactDir: resolvedArtifactDir,
    };
    return result;
  }

  // Fail fast on an invalid initial selection, but do not retain it. The
  // current /review-settings selection is resolved again when each review
  // cycle actually begins.
  try {
    freezeReviewers(config, scopedModels);
  } catch (error) {
    return {
      status: "reviewer_blocked",
      taskId,
      title: task.title,
      summary: error instanceof Error ? error.message : "Reviewer selection blocked.",
      adapter: "none",
      error: error instanceof Error ? error.message : "Reviewer selection blocked.",
      reviewCycles: [],
      artifactDir: resolvedArtifactDir,
    };
  }

  // Validate artifact path BEFORE mkdir (same canonical checks as runWaveWorker).
  await validateArtifactPath(resolvedArtifactDir, capture.waveRoot, worktree.worktreeRoot);

  // Ensure artifact dir exists after validation.
  await mkdir(resolvedArtifactDir, { recursive: true });

  // ── 2. Snapshot worktree at wave base ──
  const baseSnapshot = await createWorkspaceSnapshot(worktree.worktreeRoot, {
    maxFileBytes: config.maxFileBytes,
    maxSnapshotBytes: config.maxSnapshotBytes,
    signal,
  });

  // ── 3. Run initial executor turn ──
  reportProgress(input, {
    phase: "starting",
    message: "wave worker lifecycle starting",
    artifactDir: resolvedArtifactDir,
  });

  let initialResult: WaveWorkerResult;
  try {
    initialResult = input.initialResult ?? await runWaveWorker({ ...input, onLiveControl: publishLiveControl });
    await steeringEvidence.flush();
  } catch (error) {
    const result: WaveWorkerLifecycleResult = {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: error instanceof Error ? error.message : "Executor failed.",
      adapter: "none",
      error: error instanceof Error ? error.message : "Executor failed.",
      reviewCycles: [],
      artifactDir: resolvedArtifactDir,
    };
    await writeResult(resolvedArtifactDir, result);
    return result;
  }

  // Handle non-completed initial results.
  if (initialResult.status === "no_changes") {
    const result: WaveWorkerLifecycleResult = {
      status: "no_changes",
      taskId,
      title: task.title,
      summary: initialResult.summary,
      adapter: initialResult.adapter,
      model: initialResult.model,
      usage: initialResult.usage,
      reviewCycles: [],
      artifactDir: resolvedArtifactDir,
    };
    await writeResult(resolvedArtifactDir, result);
    return result;
  }

  if (initialResult.status === "executor_error") {
    const result: WaveWorkerLifecycleResult = {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: initialResult.summary,
      adapter: initialResult.adapter,
      model: initialResult.model,
      usage: initialResult.usage,
      error: initialResult.error,
      reviewCycles: [],
      artifactDir: resolvedArtifactDir,
      ...executionMetadata(initialResult),
    };
    await writeResult(resolvedArtifactDir, result);
    return result;
  }

  if (initialResult.status === "timeout") {
    const result: WaveWorkerLifecycleResult = {
      status: "timeout",
      taskId,
      title: task.title,
      summary: initialResult.summary,
      adapter: initialResult.adapter,
      model: initialResult.model,
      usage: initialResult.usage,
      error: initialResult.error,
      reviewCycles: [],
      artifactDir: resolvedArtifactDir,
      ...executionMetadata(initialResult),
    };
    await writeResult(resolvedArtifactDir, result);
    return result;
  }

  if (initialResult.status === "cancelled") {
    const result: WaveWorkerLifecycleResult = {
      status: "cancelled",
      taskId,
      title: task.title,
      summary: initialResult.summary,
      adapter: initialResult.adapter,
      model: initialResult.model,
      usage: initialResult.usage,
      error: initialResult.error,
      reviewCycles: [],
      artifactDir: resolvedArtifactDir,
      ...executionMetadata(initialResult),
    };
    await writeResult(resolvedArtifactDir, result);
    return result;
  }

  // Executor final responses are authoritative session evidence. Adapters
  // persist them as artifacts, but reviewers cannot inspect runtime artifacts;
  // copy the bounded, redacted text into the worker-local review evidence.
  const { state: reviewState, window } = createWorkerReviewState();
  setReviewWindowBaseline(reviewState, baseSnapshot);
  rememberFinalAssistantSummaryText(window.evidence, initialResult.summary);

  // A transport that could not steer the live command leaves the instruction
  // in the controller's durable queue. Before accepting or reviewing that
  // candidate, claim those instructions and resume the same executor session.
  let candidate = initialResult.candidate!;
  let nextExecutorTurn = (initialResult.lastExecutorTurn ?? 1) + 1;
  for (;;) {
    let deferred: Array<{ instruction: string; instructionId: string }>;
    try {
      deferred = await input.takeDeferredSteering?.() ?? [];
    } catch (error) {
      const result: WaveWorkerLifecycleResult = {
        status: "executor_error",
        taskId,
        title: task.title,
        summary: error instanceof Error ? error.message : "Could not claim deferred steering.",
        adapter: initialResult.adapter,
        model: initialResult.model,
        error: error instanceof Error ? error.message : "Could not claim deferred steering.",
        reviewCycles: [],
        artifactDir: resolvedArtifactDir,
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }
    if (deferred.length === 0) break;
    for (const item of deferred) {
      await steeringEvidence.record(item.instruction, item.instructionId);
    }
    reportProgress(input, {
      phase: "correcting",
      message: "executor turn settled — applying deferred steering before disposition",
      artifactDir: resolvedArtifactDir,
    });
    const feedback = [
      "The prior executor turn could not accept these newer steering instructions live.",
      "Apply them now before this task is reviewed, accepted, or landed; later instructions take precedence:",
      ...deferred.map((item) => `- [${item.instructionId}] ${item.instruction}`),
      "Finish the revised work and report the replacement result.",
    ].join("\n");
    let steeredResult: WaveWorkerResult;
    try {
      steeredResult = await resumeWaveWorker({
        taskId,
        task,
        capture,
        worktree,
        artifactDir,
        config,
        sourceRoot: input.sourceRoot,
        sourceRootAliases: input.sourceRootAliases,
        priorResult: initialResult,
        feedback,
        turn: nextExecutorTurn,
        signal,
        onUpdate: input.onUpdate,
        onLiveControl: publishLiveControl,
      });
      await steeringEvidence.flush();
    } catch (error) {
      const result: WaveWorkerLifecycleResult = {
        status: "executor_error",
        taskId,
        title: task.title,
        summary: error instanceof Error ? error.message : "Deferred steering executor failed.",
        adapter: initialResult.adapter,
        model: initialResult.model,
        error: error instanceof Error ? error.message : "Deferred steering executor failed.",
        reviewCycles: [],
        artifactDir: resolvedArtifactDir,
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }
    nextExecutorTurn = (steeredResult.lastExecutorTurn ?? nextExecutorTurn) + 1;
    if (["executor_error", "timeout", "cancelled", "no_changes"].includes(steeredResult.status)) {
      const status: WaveWorkerLifecycleStatus = steeredResult.status === "executor_error"
        ? "executor_error"
        : steeredResult.status === "timeout"
          ? "timeout"
          : steeredResult.status === "cancelled"
            ? "cancelled"
            : "no_changes";
      const result: WaveWorkerLifecycleResult = {
        status,
        taskId,
        title: task.title,
        summary: steeredResult.summary,
        adapter: steeredResult.adapter,
        model: steeredResult.model,
        error: steeredResult.error,
        reviewCycles: [],
        artifactDir: resolvedArtifactDir,
        ...executionMetadata(steeredResult),
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }
    rememberFinalAssistantSummaryText(window.evidence, steeredResult.summary);
    initialResult = steeredResult;
    candidate = steeredResult.candidate!;
  }

  // ── 4. Review or skip ──
  if (!candidate.differsFromBase) {
    const result: WaveWorkerLifecycleResult = {
      status: "no_changes",
      taskId,
      title: task.title,
      summary: initialResult.summary,
      adapter: initialResult.adapter,
      model: initialResult.model,
      usage: initialResult.usage,
      reviewCycles: [],
      artifactDir: resolvedArtifactDir,
    };
    await writeResult(resolvedArtifactDir, result);
    return result;
  }

  // ── 5. Review loop ──
  const reviewCycles: ReviewCycle[] = [];
  // Give reviewers the same isolated task definition that the executor sees.
  // In particular, absolute source-workspace paths (including lexical aliases)
  // must resolve to this worker rather than inviting the reviewer to inspect the
  // untouched source workspace before landing.
  let currentResult: WaveWorkerResult = initialResult;
  let currentCandidate: CandidateCommit = candidate;
  let correctionCount = 0;
  // Monotonic review cycle counter: every review attempt (including one
  // interrupted by steering before its verdict was accepted) consumes one
  // immutable cycle alias number, so steered re-reviews never collide with a
  // prior attempt's create-once alias.
  let nextReviewCycleNumber = 1;
  let lastCandidateTreeSha: string | undefined;
  // Monotonic executor turn counter was initialized after the first turn and
  // includes any deferred-steering handoff completed before review.

  for (;;) {
    await steeringEvidence.flush();
    let frozen: { frozenConfig: ReviewGateConfig; enabled: boolean };
    try {
      frozen = freezeReviewers(config, scopedModels);
    } catch (error) {
      const result: WaveWorkerLifecycleResult = {
        status: "reviewer_blocked",
        taskId,
        title: task.title,
        summary: error instanceof Error ? error.message : "Reviewer selection blocked.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: error instanceof Error ? error.message : "Reviewer selection blocked.",
        reviewCycles,
        artifactDir: resolvedArtifactDir,
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }
    if (!frozen.enabled) {
      const workerRef = await pinCommit(capture, currentCandidate.commitSha, { type: "worker", taskId }, signal);
      const result: WaveWorkerLifecycleResult = {
        status: "completed_unreviewed",
        taskId,
        title: task.title,
        summary: currentResult.summary,
        adapter: currentResult.adapter,
        model: currentResult.model,
        usage: currentResult.usage,
        acceptedRef: workerRef,
        acceptedCommitSha: currentCandidate.commitSha,
        unreviewed: true,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }
    const maxCorrectionCycles = input.maxCorrectionCycles ?? config.maxCorrectionCycles;
    const reviewTask = rewriteTaskPaths(
      task,
      [input.sourceRoot, ...(input.sourceRootAliases ?? [])],
      worktree.worktreeRoot,
    );
    // Check cancellation before each review.
    if (signal?.aborted) {
      const result: WaveWorkerLifecycleResult = {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: "Lifecycle cancelled.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: "Cancelled.",
        reviewCycles,
        artifactDir: resolvedArtifactDir,
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }

    const reviewCycle = nextReviewCycleNumber;
    nextReviewCycleNumber += 1;
    const reviewerLabels = frozen.frozenConfig.reviewers?.map(reviewerProgressLabel) ?? [];
    reportProgress(input, {
      phase: "reviewing",
      message: `review cycle ${reviewCycle}`,
      artifactDir: resolvedArtifactDir,
      reviewCycle,
      reviewers: reviewerLabels,
    });

    // A change-request steer takes precedence over review. Expose a temporary
    // control that aborts only this review invocation, then hands the collected
    // instructions to the resumed executor session below.
    const reviewAbort = new AbortController();
    const reviewSteering: Array<{ instruction: string; instructionId: string }> = [];
    const reviewSignal = signal
      ? AbortSignal.any([signal, reviewAbort.signal])
      : reviewAbort.signal;
    publishLiveControl({
      adapter: "review-gate",
      generation: nextExecutorTurn,
      protocol: "review-to-executor-handoff-v1",
      capabilities: { steer: true, interrupt: false },
      steer: async (instruction, instructionId) => {
        reviewSteering.push({ instruction, instructionId });
        if (!reviewAbort.signal.aborted) reviewAbort.abort(new Error("review_interrupted_for_steering"));
        return {
          status: "acknowledged",
          message: "Review interruption requested; steering will be applied in the next executor turn before review restarts.",
        };
      },
      interrupt: async () => ({
        status: "blocked",
        message: "Use the task interrupt action to stop the complete lifecycle, including its active review.",
      }),
    });

    // Pin the immutable per-cycle review alias before any reviewer runs. The
    // alias proves the candidate's tree/base/wave/task identity and is
    // create-once: re-pinning the same commit is idempotent, mutation fails closed.
    const reviewAliasRef = reviewCycleAliasRefName(capture.waveId, taskId, reviewCycle);
    await pinReviewCycleCandidate(capture, taskId, reviewCycle, {
      commitSha: currentCandidate.commitSha,
      treeSha: currentCandidate.treeSha,
    });

    // Run review on the current candidate (with error handling).
    let reviewOutput: ReviewRunOutput;
    try {
      reviewOutput = await runCandidateReviewWithRecovery(
        () => runCandidateReview(
          frozen.frozenConfig,
          reviewTask,
          capture,
          taskId,
          reviewAliasRef,
          { commitSha: currentCandidate.commitSha, treeSha: currentCandidate.treeSha },
          window,
          window.evidence,
          worktree.worktreeRoot,
          baseSnapshot,
          config.maxPatchBytes,
          correctionCount,
          reviewSignal,
          (message) => reportProgress(input, {
            phase: "reviewing",
            message,
            artifactDir: resolvedArtifactDir,
            reviewCycle,
            reviewers: reviewerLabels,
          }),
        ),
        resolvedArtifactDir,
        config,
        reviewSignal,
      );
    } catch (error) {
      if (reviewSteering.length > 0 && !signal?.aborted) {
        reviewOutput = {
          changed: true,
          changes: [],
          result: { reviewerId: "gate", verdict: "error", summary: "Review interrupted for steering.", findings: [], error: "aborted" },
        };
      } else {
        const result: WaveWorkerLifecycleResult = {
          status: "review_error",
          taskId,
          title: task.title,
          summary: error instanceof Error ? error.message : "Review infrastructure failed.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: error instanceof Error ? error.message : "review_error",
          reviewCycles,
          artifactDir: resolvedArtifactDir,
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }
    } finally {
      publishLiveControl(undefined);
      await steeringEvidence.flush();
    }

    if (reviewSteering.length > 0 && !signal?.aborted) {
      reportProgress(input, {
        phase: "correcting",
        message: "review interrupted — applying higher-priority steering",
        artifactDir: resolvedArtifactDir,
      });
      const feedback = [
        "The active review was interrupted because the user or orchestrator changed the requested work.",
        "Apply these newer instructions now; they take precedence over the candidate that was being reviewed:",
        ...reviewSteering.map((item) => `- [${item.instructionId}] ${item.instruction}`),
        "Finish the revised work and report it for a fresh review.",
      ].join("\n");
      let steeredResult: WaveWorkerResult;
      try {
        steeredResult = await resumeWaveWorker({
          taskId,
          task,
          capture,
          worktree,
          artifactDir,
          config,
          sourceRoot: input.sourceRoot,
          sourceRootAliases: input.sourceRootAliases,
          priorResult: currentResult,
          feedback,
          turn: nextExecutorTurn,
          signal,
          onUpdate: input.onUpdate,
          onLiveControl: publishLiveControl,
        });
        await steeringEvidence.flush();
      } catch (error) {
        const result: WaveWorkerLifecycleResult = {
          status: "executor_error",
          taskId,
          title: task.title,
          summary: error instanceof Error ? error.message : "Steered executor failed.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: error instanceof Error ? error.message : "Steered executor failed.",
          reviewCycles,
          artifactDir: resolvedArtifactDir,
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }
      nextExecutorTurn = (steeredResult.lastExecutorTurn ?? nextExecutorTurn) + 1;
      if (["executor_error", "timeout", "cancelled", "no_changes"].includes(steeredResult.status)) {
        const status: WaveWorkerLifecycleStatus = steeredResult.status === "no_changes"
          ? "correction_cap"
          : steeredResult.status === "executor_error"
            ? "executor_error"
            : steeredResult.status === "timeout"
              ? "timeout"
              : "cancelled";
        const result: WaveWorkerLifecycleResult = {
          status,
          taskId,
          title: task.title,
          summary: steeredResult.status === "no_changes"
            ? "Steering produced no candidate changes relative to base."
            : steeredResult.summary,
          adapter: steeredResult.adapter,
          model: steeredResult.model,
          error: steeredResult.error,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          ...executionMetadata(steeredResult),
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }
      rememberFinalAssistantSummaryText(window.evidence, steeredResult.summary);
      currentResult = steeredResult;
      currentCandidate = steeredResult.candidate!;
      lastCandidateTreeSha = undefined;
      continue;
    }

    // Check for reviewer abort.
    if (reviewOutput.result?.error === "aborted" || signal?.aborted) {
      const result: WaveWorkerLifecycleResult = {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: "Review was aborted.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: "aborted",
        reviewCycles,
        artifactDir: resolvedArtifactDir,
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }

    // Verify the immutable cycle alias still pins the exact reviewed
    // candidate identity before the verdict is accepted.
    try {
      await verifyReviewCycleIdentity(capture, taskId, reviewAliasRef, {
        commitSha: currentCandidate.commitSha,
        treeSha: currentCandidate.treeSha,
      });
    } catch (error) {
      const result: WaveWorkerLifecycleResult = {
        status: "review_error",
        taskId,
        title: task.title,
        summary: "Review cycle identity could not be verified.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: error instanceof Error ? error.message : "review cycle identity verification failed",
        reviewCycles,
        artifactDir: resolvedArtifactDir,
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }

    const verdict = reviewOutput.result?.verdict ?? "error";
    const cycle: ReviewCycle = {
      cycle: reviewCycle,
      baseCommit: capture.baseCommit,
      candidateCommit: currentCandidate.commitSha,
      candidateTreeSha: currentCandidate.treeSha,
      candidateRef: reviewAliasRef,
      verdict,
      reviewOutput,
    };
    reviewCycles.push(cycle);

    // Record reviewer feedback and arm the exchange for serial behavior.
    if (reviewOutput.result) {
      const disposition: import("../state").ReviewFeedbackDisposition =
        verdict === "needs_changes"
          ? "sent_for_correction"
          : verdict === "pass"
            ? "sent_for_observation"
            : "sent_review_error";
      recordReviewerFeedback(reviewState, {
        result: reviewOutput.result,
        reviewerResults: reviewOutput.reviewerResults,
        reviewSequence: reviewOutput.reviewSequence,
        source: "automatic",
        disposition,
        displayLabels: reviewOutput.reviewerDisplayLabels,
      });
      if (reviewOutput.reviewedSnapshot) {
        armReviewResponseExchange(reviewState, reviewOutput.reviewedSnapshot);
      }
    }

    // Handle review error.
    if (verdict === "error") {
      const result: WaveWorkerLifecycleResult = {
        status: "review_error",
        taskId,
        title: task.title,
        summary: reviewOutput.result?.summary ?? "Review errored.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: reviewOutput.result?.error ?? reviewOutput.error ?? "review_error",
        reviewCycles,
        artifactDir: resolvedArtifactDir,
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }

    // Handle needs_changes.
    if (verdict === "needs_changes") {
      // Check correction cap.
      if (correctionCount >= maxCorrectionCycles) {
        const result: WaveWorkerLifecycleResult = {
          status: "correction_cap",
          taskId,
          title: task.title,
          summary: `Correction cap reached after ${maxCorrectionCycles} cycle(s).`,
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: `Correction cap reached: ${maxCorrectionCycles}`,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }

      // Check no-progress: if the candidate tree is identical to the last one,
      // the executor is not making progress.
      if (lastCandidateTreeSha === currentCandidate.treeSha) {
        const result: WaveWorkerLifecycleResult = {
          status: "correction_cap",
          taskId,
          title: task.title,
          summary: "No progress: candidate tree unchanged after correction.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: "No progress detected.",
          reviewCycles,
          artifactDir: resolvedArtifactDir,
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }
      lastCandidateTreeSha = currentCandidate.treeSha;

      // Build complete correction transmission and resume executor.
      const invocationDir = reviewOutput.invocationDir ?? join(resolvedArtifactDir, "invocations");
      const bundleDir = reviewOutput.bundleDir ?? join(resolvedArtifactDir, "review-bundles");
      const feedback = await buildReviewTransmission(
        reviewOutput,
        invocationDir,
        bundleDir,
        window.nextReviewSequence - 1,
        "correction_required",
      );
      correctionCount++;

      reportProgress(input, {
        phase: "correcting",
        message: `correction ${correctionCount}/${maxCorrectionCycles}`,
        artifactDir: resolvedArtifactDir,
      });

      // Check cancellation before resume.
      if (signal?.aborted) {
        const result: WaveWorkerLifecycleResult = {
          status: "cancelled",
          taskId,
          title: task.title,
          summary: "Lifecycle cancelled during correction.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: "Cancelled.",
          reviewCycles,
          artifactDir: resolvedArtifactDir,
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }

      let correctionResult: WaveWorkerResult;
      try {
        correctionResult = await resumeWaveWorker({
          taskId,
          task,
          capture,
          worktree,
          artifactDir,
          config,
          sourceRoot: input.sourceRoot,
          sourceRootAliases: input.sourceRootAliases,
          priorResult: currentResult,
          feedback,
          turn: nextExecutorTurn,
          signal,
          onUpdate: input.onUpdate,
          onLiveControl: publishLiveControl,
        });
        await steeringEvidence.flush();
      } catch (error) {
        const result: WaveWorkerLifecycleResult = {
          status: "executor_error",
          taskId,
          title: task.title,
          summary: error instanceof Error ? error.message : "Correction executor failed.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: error instanceof Error ? error.message : "Correction executor failed.",
          reviewCycles,
          artifactDir: resolvedArtifactDir,
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }

      nextExecutorTurn = (correctionResult.lastExecutorTurn ?? nextExecutorTurn) + 1;

      // Handle correction result.
      if (correctionResult.status === "executor_error") {
        const result: WaveWorkerLifecycleResult = {
          status: "executor_error",
          taskId,
          title: task.title,
          summary: correctionResult.summary,
          adapter: correctionResult.adapter,
          model: correctionResult.model,
          error: correctionResult.error,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          ...executionMetadata(correctionResult),
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }

      if (correctionResult.status === "timeout") {
        const result: WaveWorkerLifecycleResult = {
          status: "timeout",
          taskId,
          title: task.title,
          summary: correctionResult.summary,
          adapter: correctionResult.adapter,
          model: correctionResult.model,
          error: correctionResult.error,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          ...executionMetadata(correctionResult),
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }

      if (correctionResult.status === "cancelled") {
        const result: WaveWorkerLifecycleResult = {
          status: "cancelled",
          taskId,
          title: task.title,
          summary: correctionResult.summary,
          adapter: correctionResult.adapter,
          model: correctionResult.model,
          error: correctionResult.error,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          ...executionMetadata(correctionResult),
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }

      if (correctionResult.status === "no_changes") {
        // The correction produced no changes relative to base — treat as no progress.
        const result: WaveWorkerLifecycleResult = {
          status: "correction_cap",
          taskId,
          title: task.title,
          summary: "Correction produced no changes relative to base.",
          adapter: correctionResult.adapter,
          model: correctionResult.model,
          error: "No changes after correction.",
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          ...executionMetadata(correctionResult),
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }

      // Normalize the replacement candidate and continue review loop.
      rememberFinalAssistantSummaryText(window.evidence, correctionResult.summary);
      currentResult = correctionResult;
      currentCandidate = correctionResult.candidate!;
      continue;
    }

    // ── 6. Pass: transmit for observation, resume once ──
    const passedCommitSha = currentCandidate.commitSha;
    const passedTreeSha = currentCandidate.treeSha;

    reportProgress(input, {
      phase: "confirming",
      message: "review passed — confirming unchanged tree",
      artifactDir: resolvedArtifactDir,
    });

    // Check cancellation before pass observation.
    if (signal?.aborted) {
      const result: WaveWorkerLifecycleResult = {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: "Lifecycle cancelled during pass confirmation.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: "Cancelled.",
        reviewCycles,
        artifactDir: resolvedArtifactDir,
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }

    // Build complete pass transmission.
    const passInvocationDir = reviewOutput.invocationDir ?? join(resolvedArtifactDir, "invocations");
    const passBundleDir = reviewOutput.bundleDir ?? join(resolvedArtifactDir, "review-bundles");
    const passFeedback = await buildReviewTransmission(
      reviewOutput,
      passInvocationDir,
      passBundleDir,
      window.nextReviewSequence - 1,
      "passed",
    );

    let confirmResult: WaveWorkerResult;
    try {
      confirmResult = await resumeWaveWorker({
        taskId,
        task,
        capture,
        worktree,
        artifactDir,
        config,
        sourceRoot: input.sourceRoot,
        sourceRootAliases: input.sourceRootAliases,
        priorResult: currentResult,
        feedback: passFeedback,
        turn: nextExecutorTurn,
        signal,
        onUpdate: input.onUpdate,
        onLiveControl: publishLiveControl,
      });
      await steeringEvidence.flush();
    } catch (error) {
      // Confirmation executor threw — return executor_error without pinning.
      const result: WaveWorkerLifecycleResult = {
        status: "executor_error",
        taskId,
        title: task.title,
        summary: error instanceof Error ? error.message : "Confirmation executor failed.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: error instanceof Error ? error.message : "Confirmation executor failed.",
        reviewCycles,
        artifactDir: resolvedArtifactDir,
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }

    nextExecutorTurn = (confirmResult.lastExecutorTurn ?? nextExecutorTurn) + 1;

    // Handle confirmation result.
    if (confirmResult.status === "cancelled") {
      const result: WaveWorkerLifecycleResult = {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: "Lifecycle cancelled during pass confirmation.",
        adapter: confirmResult.adapter,
        model: confirmResult.model,
        error: "Cancelled.",
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        ...executionMetadata(confirmResult),
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }

    if (confirmResult.status === "executor_error") {
      // Confirmation executor failed — return executor_error without pinning.
      const result: WaveWorkerLifecycleResult = {
        status: "executor_error",
        taskId,
        title: task.title,
        summary: confirmResult.summary,
        adapter: confirmResult.adapter,
        model: confirmResult.model,
        error: confirmResult.error,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        ...executionMetadata(confirmResult),
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }

    if (confirmResult.status === "timeout") {
      const result: WaveWorkerLifecycleResult = {
        status: "timeout",
        taskId,
        title: task.title,
        summary: confirmResult.summary,
        adapter: confirmResult.adapter,
        model: confirmResult.model,
        error: confirmResult.error,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        ...executionMetadata(confirmResult),
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }

    if (confirmResult.status === "no_changes") {
      // Confirmation reverted all changes — return no_changes without pinning.
      const result: WaveWorkerLifecycleResult = {
        status: "no_changes",
        taskId,
        title: task.title,
        summary: "Confirmation produced no changes relative to base.",
        adapter: confirmResult.adapter,
        model: confirmResult.model,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }

    rememberFinalAssistantSummaryText(window.evidence, confirmResult.summary);
    const confirmCandidate = confirmResult.candidate!;

    // If the confirmation tree is unchanged from the passed candidate tree, accept.
    if (confirmCandidate.treeSha === passedTreeSha) {
      // The pass is tied to the exact immutable cycle candidate/tree: the
      // cycle alias must still pin the passed commit before acceptance.
      const passedCycle = reviewCycles[reviewCycles.length - 1];
      if (!passedCycle || passedCycle.candidateRef !== reviewAliasRef) {
        const result: WaveWorkerLifecycleResult = {
          status: "review_error",
          taskId,
          title: task.title,
          summary: "The passing review cycle could not be identified for acceptance.",
          adapter: confirmResult.adapter,
          model: confirmResult.model,
          error: "pass cycle identity missing",
          reviewCycles,
          artifactDir: resolvedArtifactDir,
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }
      try {
        await verifyReviewCycleIdentity(capture, taskId, passedCycle.candidateRef, {
          commitSha: passedCommitSha,
          treeSha: passedTreeSha,
        });
      } catch (error) {
        const result: WaveWorkerLifecycleResult = {
          status: "review_error",
          taskId,
          title: task.title,
          summary: "The passing review cycle alias no longer pins the passed candidate.",
          adapter: confirmResult.adapter,
          model: confirmResult.model,
          error: error instanceof Error ? error.message : "pass cycle identity verification failed",
          reviewCycles,
          artifactDir: resolvedArtifactDir,
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }
      // Restore the clean worker HEAD/index to the exact passed candidate before pinning.
      await gitResetHard(worktree.worktreeRoot, passedCommitSha);
      const workerRef = await pinCommit(capture, passedCommitSha, { type: "worker", taskId }, signal);
      const acceptedWithWarnings = hasPartialReviewerFailure(reviewOutput.reviewerResults);
      const result: WaveWorkerLifecycleResult = {
        status: acceptedWithWarnings ? "accepted_with_warnings" : "accepted",
        taskId,
        title: task.title,
        summary: acceptedWithWarnings
          ? "Review passed and confirmed unchanged, with reviewer infrastructure warnings."
          : "Review passed and confirmed unchanged.",
        adapter: confirmResult.adapter,
        model: confirmResult.model,
        usage: confirmResult.usage,
        acceptedRef: workerRef,
        acceptedCommitSha: passedCommitSha,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
      };
      await writeResult(resolvedArtifactDir, result);
      return result;
    }

    // Tree changed — the old pass is invalid. Review the new candidate.
    currentResult = confirmResult;
    currentCandidate = confirmCandidate;
    lastCandidateTreeSha = undefined; // reset no-progress tracking
    continue;
  }
}
