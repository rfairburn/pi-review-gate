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
  validateArtifactPath,
  type WaveWorkerInput,
  type WaveWorkerResult,
  type WaveWorkerTask,
} from "./wave-worker";
import {
  buildCandidateReviewPatch,
  type CandidateCommit,
} from "./wave-commits";
import { pinCommit } from "./wave-worktrees";
import {
  configWithReviewers,
  resolveReviewers,
  type DeciderConfig,
  type ReviewGateConfig,
} from "../config";
import {
  reviewerDisplayLabel,
  runReview,
  type ExactChangeInput,
  type ReviewRunOutput,
} from "../review";
import { createEvidenceState, type EvidenceState } from "../evidence";
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
}

/** Input for the lifecycle. Extends WaveWorkerInput with review-specific options. */
export interface WaveWorkerLifecycleInput extends WaveWorkerInput {
  /** Maximum correction cycles before giving up. Defaults to config.maxCorrectionCycles. */
  maxCorrectionCycles?: number;
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
  if (reviewer.adapter === "little-coder-model") {
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
    reviewerDisplayLabels: reviewOutput.reviewerDisplayLabels,
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
  repoPath: string,
  baseCommit: string,
  candidateCommit: string,
  window: ReviewWindow,
  evidence: EvidenceState,
  worktreeRoot: string,
  baseSnapshot: WorkspaceSnapshot,
  maxPatchBytes: number,
  correctionAttemptCount: number,
  signal?: AbortSignal,
): Promise<ReviewRunOutput> {
  // Build the exact patch from Git.
  const patch = await buildCandidateReviewPatch(
    repoPath,
    baseCommit,
    candidateCommit,
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
    changeIdentity: { baseCommit, candidateCommit },
    exactChange,
    window,
    correctionAttemptCount,
    signal,
  });
}

// ── result writing ───────────────────────────────────────────────────────────

/** Write result.json to the worker artifact root. */
async function writeResult(artifactDir: string, result: WaveWorkerLifecycleResult): Promise<void> {
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
        verdict: c.verdict,
      })),
      reviewReport: result.reviewReport,
      error: result.error,
      completedAt: new Date().toISOString(),
    }, null, 2),
    "utf8",
  );
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

  // Validate maxCorrectionCycles override as a non-negative integer.
  const maxCorrectionCycles = input.maxCorrectionCycles ?? config.maxCorrectionCycles;
  if (!Number.isInteger(maxCorrectionCycles) || maxCorrectionCycles < 0) {
    const result: WaveWorkerLifecycleResult = {
      status: "review_error",
      taskId,
      title: task.title,
      summary: `Invalid maxCorrectionCycles: ${maxCorrectionCycles}. Must be a non-negative integer.`,
      adapter: "none",
      error: `Invalid maxCorrectionCycles: ${maxCorrectionCycles}`,
      reviewCycles: [],
      artifactDir: resolvedArtifactDir,
    };
    return result;
  }

  // ── 1. Freeze/validate reviewer selection (before artifact dir creation) ──
  let frozen: { frozenConfig: ReviewGateConfig; enabled: boolean };
  try {
    frozen = freezeReviewers(config, scopedModels);
  } catch (error) {
    const result: WaveWorkerLifecycleResult = {
      status: "reviewer_blocked",
      taskId,
      title: task.title,
      summary: error instanceof Error ? error.message : "Reviewer selection blocked.",
      adapter: "none",
      error: error instanceof Error ? error.message : "Reviewer selection blocked.",
      reviewCycles: [],
      artifactDir: resolvedArtifactDir,
    };
    return result;
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
    initialResult = await runWaveWorker(input);
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
    };
    await writeResult(resolvedArtifactDir, result);
    return result;
  }

  // ── 4. Review or skip ──
  const candidate = initialResult.candidate!;
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

  // Review disabled or no reviewers — pin and return completed_unreviewed.
  if (!frozen.enabled) {
    const workerRef = await pinCommit(capture, candidate.commitSha, { type: "worker", taskId }, signal);
    const result: WaveWorkerLifecycleResult = {
      status: "completed_unreviewed",
      taskId,
      title: task.title,
      summary: initialResult.summary,
      adapter: initialResult.adapter,
      model: initialResult.model,
      usage: initialResult.usage,
      acceptedRef: workerRef,
      acceptedCommitSha: candidate.commitSha,
      unreviewed: true,
      reviewCycles: [],
      artifactDir: resolvedArtifactDir,
    };
    await writeResult(resolvedArtifactDir, result);
    return result;
  }

  // ── 5. Review loop ──
  const { state: reviewState, window } = createWorkerReviewState();
  // Set the baseline snapshot for the review window.
  setReviewWindowBaseline(reviewState, baseSnapshot);
  const reviewCycles: ReviewCycle[] = [];
  // Give reviewers the same isolated task definition that the executor sees.
  // In particular, absolute source-workspace paths (including lexical aliases)
  // must resolve to this worker rather than inviting the reviewer to inspect the
  // untouched source workspace before landing.
  const reviewTask = rewriteTaskPaths(
    task,
    [input.sourceRoot, ...(input.sourceRootAliases ?? [])],
    worktree.worktreeRoot,
  );
  let currentResult: WaveWorkerResult = initialResult;
  let currentCandidate: CandidateCommit = candidate;
  let correctionCount = 0;
  let lastCandidateTreeSha: string | undefined;
  // Monotonic executor turn counter: starts at 2 (after initial turn 1).
  let nextExecutorTurn = 2;

  for (;;) {
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

    reportProgress(input, {
      phase: "reviewing",
      message: `review cycle ${reviewCycles.length + 1}`,
      artifactDir: resolvedArtifactDir,
      reviewCycle: reviewCycles.length + 1,
      reviewers: frozen.frozenConfig.reviewers?.map(reviewerProgressLabel) ?? [],
    });

    // Run review on the current candidate (with error handling).
    let reviewOutput: ReviewRunOutput;
    try {
      reviewOutput = await runCandidateReview(
        frozen.frozenConfig,
        reviewTask,
        capture.repositoryPath,
        capture.baseCommit,
        currentCandidate.commitSha,
        window,
        window.evidence,
        worktree.worktreeRoot,
        baseSnapshot,
        config.maxPatchBytes,
        correctionCount,
        signal,
      );
    } catch (error) {
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

    const verdict = reviewOutput.result?.verdict ?? "error";
    const cycle: ReviewCycle = {
      cycle: reviewCycles.length + 1,
      baseCommit: capture.baseCommit,
      candidateCommit: currentCandidate.commitSha,
      candidateTreeSha: currentCandidate.treeSha,
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
          turn: nextExecutorTurn++,
          signal,
          onUpdate: input.onUpdate,
        });
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
        };
        await writeResult(resolvedArtifactDir, result);
        return result;
      }

      // Normalize the replacement candidate and continue review loop.
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
        turn: nextExecutorTurn++,
        signal,
        onUpdate: input.onUpdate,
      });
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

    const confirmCandidate = confirmResult.candidate!;

    // If the confirmation tree is unchanged from the passed candidate tree, accept.
    if (confirmCandidate.treeSha === passedTreeSha) {
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
