import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveReviewers, type ReviewGateConfig } from "../../config";
import { runReview, type ReviewRunOutput } from "../../review";
import { hasPartialReviewerFailure } from "../../review-report";
import { rememberFinalAssistantSummaryText } from "../../evidence";
import type { SubtaskProgressUpdate } from "../types";
import {
  buildReviewTransmission,
  createWorkerReviewState,
  freezeReviewers,
  reviewerProgressLabel,
  runCandidateReviewWithRecovery,
} from "../wave-worker-lifecycle";
import {
  computeInPlaceAttribution,
  createInPlaceBaseline,
  inPlaceDeltaIdentity,
  type InPlaceAttribution,
} from "./basis";
import { loadInPlaceBaseline, persistInPlaceBaseline } from "./baseline-store";
import type { InPlaceLifecycleInput, InPlaceLifecycleResult, InPlaceLifecycleStatus, InPlaceReviewCycle, InPlaceWorkerResult } from "./contracts";
import { ensureArtifactDir } from "./containment";
import { runInplaceTurnWorker } from "./adapter-workflow";
import { persistInPlaceObservedEvidence, restoreInPlaceObservedEvidence } from "./observed-evidence";
import { buildInPlaceReviewRequest } from "./prompts";
import { buildInPlaceReviewCycleRecord, nextInPlaceReviewCycle, persistInPlaceReviewCycleRecord } from "./review-records";
import { settleInPlace } from "./settlement";

function reportLifecycleProgress(input: InPlaceLifecycleInput, update: Omit<SubtaskProgressUpdate, "subtaskId">): void {
  input.onUpdate?.({ subtaskId: input.taskId, ...update });
}

// ── main in-place lifecycle ──────────────────────────────────────────────────

/**
 * Run one complete in-place worker review/correction lifecycle (#220).
 *
 * 1. Freezes/validates the subtask reviewer selection (no-op unreviewed path
 *    when the automatic subtask-review toggle is off — issue #175).
 * 2. Captures the launch-time workspace baseline (bounded content snapshot
 *    plus the observed Git HEAD when the root is inside a repository).
 * 3. Runs the initial executor turn directly in the workspace.
 * 4. Computes the recorded workspace delta since launch; an empty in-root
 *    delta settles as no_changes only when no external tool-observed write
 *    evidence requires the own reviewer.
 * 5. Reviews that delta (snapshot scope, truthful attribution) and resumes
 *    the same executor session in the same workspace for correction on
 *    needs_changes, honoring maxCorrectionCycles and no-progress detection.
 * 6. On pass, transmits the pass for observation and resumes once; only an
 *    unchanged delta versus the passed cycle settles as reviewed; any new
 *    workspace change re-enters review.
 * 7. Writes result.json with the truthful status and attribution data.
 *
 * A verdict never represents a pre-write gate or a rollback: writes already
 * happened where performed, and concurrent third-party changes are never
 * attributed to the worker — reviewers are instructed to disclose uncertain
 * attribution instead.
 */
export async function runInplaceLifecycle(input: InPlaceLifecycleInput): Promise<InPlaceLifecycleResult> {
  const { taskId, task, workspaceRoot, config, scopedModels, signal } = input;
  const resolvedArtifactDir = await ensureArtifactDir(input.artifactDir, workspaceRoot);

  // Fail fast on an invalid subtask selection before any baseline is captured.
  try {
    freezeReviewers(config, scopedModels ?? []);
  } catch (error) {
    const blockedBaseline = await createInPlaceBaseline(workspaceRoot, config, signal);
    await persistInPlaceBaseline(blockedBaseline, taskId, resolvedArtifactDir);
    return await settleInPlace(input, {
      status: "reviewer_blocked",
      taskId,
      title: task.title,
      summary: error instanceof Error ? error.message : "Reviewer selection blocked.",
      adapter: "none",
      error: error instanceof Error ? error.message : "Reviewer selection blocked.",
      workspaceRoot,
      baseline: blockedBaseline,
      changedSinceLaunch: [],
      reviewCycles: [],
      artifactDir: resolvedArtifactDir,
      operationRecord: join(resolvedArtifactDir, "operation.json"),
    });
  }

  reportLifecycleProgress(input, {
    phase: "starting",
    message: "in-place worker lifecycle starting",
    artifactDir: resolvedArtifactDir,
  });

  // #220 pass-1 correction: the launch baseline is durable and restored, never
  // re-captured per lifecycle invocation. A fresh dispatch (or a direct
  // lifecycle use) captures and persists the basis before the executor runs;
  // a continuation with a prior turn must load and verify the original basis
  // and fails closed when that is impossible — writes made before a pause
  // remain part of the original attribution window instead of silently
  // becoming the new baseline. A continuation without any prior turn is the
  // task's first effective dispatch and captures the basis now.
  const restoredBaseline = input.baseline ?? (
    input.continuation
      ? (input.initialResult
        ? await loadInPlaceBaseline(taskId, resolvedArtifactDir, workspaceRoot)
        : await (async () => {
          const captured = await createInPlaceBaseline(workspaceRoot, config, signal);
          await persistInPlaceBaseline(captured, taskId, resolvedArtifactDir);
          return captured;
        })())
      : await (async () => {
        const captured = await createInPlaceBaseline(workspaceRoot, config, signal);
        await persistInPlaceBaseline(captured, taskId, resolvedArtifactDir);
        return captured;
      })()
  );
  const baseline = restoredBaseline;
  // The review window exists from the very first turn so corrections, steering
  // evidence, and pass observation share one serial state like execute runs.
  const { window } = createWorkerReviewState();
  await restoreInPlaceObservedEvidence(window.evidence, resolvedArtifactDir, workspaceRoot);
  let effectiveAssignment = input.executorAssignment;
  type InPlaceTurnInput = Omit<Parameters<typeof runInplaceTurnWorker>[0], "executorAssignment" | "evidence" | "baseline">;
  const runTurn = async (turnInput: InPlaceTurnInput): Promise<InPlaceWorkerResult> => {
    try {
      const result = await runInplaceTurnWorker({
        ...turnInput,
        executorAssignment: effectiveAssignment,
        evidence: window.evidence,
        baseline,
      });
      effectiveAssignment = result.effectiveAssignment ?? effectiveAssignment;
      return result;
    } finally {
      await persistInPlaceObservedEvidence(window.evidence, resolvedArtifactDir);
    }
  };

  let currentResult: InPlaceWorkerResult;
  let lastExecutorTurn: number;
  // #220 pass-1 correction (finding 3): an admitted continuation is the
  // AUTHORITATIVE turn for its dispatch. Any retained prior result is
  // prior-turn context only — even a failed, timed-out, or cancelled one —
  // and is never treated as the continuation's outcome.
  if (input.continuation) {
    const prior = input.initialResult;
    const priorSession = prior?.session;
    const priorTurn = prior?.lastExecutorTurn ?? 0;
    if (!priorSession) {
      reportLifecycleProgress(input, {
        phase: "correcting",
        message: "no resumable executor session survived the prior run; dispatching the admitted continuation with a fresh session disclosure",
        artifactDir: resolvedArtifactDir,
      });
    } else if (prior && prior.status !== "completed") {
      reportLifecycleProgress(input, {
        phase: "correcting",
        message: `the retained prior turn ended in ${prior.status}; it is prior-turn context only, and the requested continuation is dispatched now`,
        artifactDir: resolvedArtifactDir,
      });
    }
    let resumed: InPlaceWorkerResult;
    try {
      resumed = await runTurn({
        ...input,
        mode: "continuation",
        startingTurn: priorTurn + 1,
        feedback: input.continuation.instructions,
        ...(priorSession ? { priorSession } : {}),
      });
      lastExecutorTurn = resumed.lastExecutorTurn ?? priorTurn + 1;
    } catch (error) {
      return await settleInPlace(input, {
        status: "executor_error",
        taskId,
        title: task.title,
        summary: error instanceof Error ? error.message : "Continued executor failed.",
        adapter: "none",
        error: error instanceof Error ? error.message : "Continued executor failed.",
        workspaceRoot,
        baseline,
        changedSinceLaunch: [],
        reviewCycles: [],
        artifactDir: resolvedArtifactDir,
        operationRecord: join(resolvedArtifactDir, "operation.json"),
        lastExecutorTurn: priorTurn,
        session: priorSession,
      });
    }
    if (resumed.status === "executor_error" && priorSession && !signal?.aborted && !resumed.failoverExhausted) {
      // One bounded fresh-session handoff: the retained session could not be
      // resumed, so the continuation re-runs in the same workspace with the
      // explicit fresh-session disclosure instead of staying bricked on a
      // dead session. Never retried further; failures settle paused.
      reportLifecycleProgress(input, {
        phase: "correcting",
        message: "the retained executor session could not be resumed; retrying once with a fresh session in the same workspace",
        artifactDir: resolvedArtifactDir,
      });
      try {
        const retried = await runTurn({
          ...input,
          mode: "continuation",
          startingTurn: priorTurn + 2,
          feedback: input.continuation.instructions,
          priorSession: undefined,
        });
        if (retried.status !== "completed") {
          if (retried.status === "cancelled" || signal?.aborted) {
            return await settleInPlace(input, {
              status: "cancelled",
              taskId,
              title: task.title,
              summary: retried.summary ?? "Continued in-place worker was cancelled.",
              adapter: retried.adapter,
              model: retried.model,
              usage: retried.usage,
              error: retried.error,
              workspaceRoot,
              baseline,
              changedSinceLaunch: [],
              reviewCycles: [],
              artifactDir: resolvedArtifactDir,
              operationRecord: retried.operationRecord,
              lastExecutorTurn: retried.lastExecutorTurn ?? priorTurn + 2,
              session: retried.session,
            });
          }
          return await settleInPlace(input, {
            status: retried.status === "timeout" ? "timeout" : "executor_error",
            taskId,
            title: task.title,
            summary: retried.summary ?? "Continued in-place worker stopped.",
            adapter: retried.adapter,
            model: retried.model,
            usage: retried.usage,
            error: retried.error,
            workspaceRoot,
            baseline,
            changedSinceLaunch: [],
            reviewCycles: [],
            artifactDir: resolvedArtifactDir,
            operationRecord: retried.operationRecord,
            lastExecutorTurn: retried.lastExecutorTurn ?? priorTurn + 2,
            session: retried.session,
          });
        }
        resumed = retried;
        lastExecutorTurn = retried.lastExecutorTurn ?? priorTurn + 2;
      } catch (error) {
        return await settleInPlace(input, {
          status: "executor_error",
          taskId,
          title: task.title,
          summary: error instanceof Error ? error.message : "Fresh-session continuation failed.",
          adapter: "none",
          error: error instanceof Error ? error.message : "Fresh-session continuation failed.",
          workspaceRoot,
          baseline,
          changedSinceLaunch: [],
          reviewCycles: [],
          artifactDir: resolvedArtifactDir,
          operationRecord: join(resolvedArtifactDir, "operation.json"),
          lastExecutorTurn: priorTurn + 2,
          session: priorSession,
        });
      }
    }
    if (resumed.status !== "completed") {
      if (resumed.status === "cancelled" || signal?.aborted) {
        return await settleInPlace(input, {
          status: "cancelled",
          taskId,
          title: task.title,
          summary: resumed.summary ?? "Continued in-place worker was cancelled.",
          adapter: resumed.adapter,
          model: resumed.model,
          usage: resumed.usage,
          error: resumed.error,
          workspaceRoot,
          baseline,
          changedSinceLaunch: [],
          reviewCycles: [],
          artifactDir: resolvedArtifactDir,
          operationRecord: resumed.operationRecord,
          lastExecutorTurn,
          session: resumed.session,
        });
      }
      return await settleInPlace(input, {
        status: resumed.status === "timeout" ? "timeout" : "executor_error",
        taskId,
        title: task.title,
        summary: resumed.summary ?? "Continued in-place worker stopped.",
        adapter: resumed.adapter,
        model: resumed.model,
        usage: resumed.usage,
        error: resumed.error,
        workspaceRoot,
        baseline,
        changedSinceLaunch: [],
        reviewCycles: [],
        artifactDir: resolvedArtifactDir,
        operationRecord: resumed.operationRecord,
        lastExecutorTurn,
        session: resumed.session,
      });
    }
    rememberFinalAssistantSummaryText(window.evidence, resumed.summary);
    currentResult = resumed;
  } else {
    if (input.initialResult) {
      // A retained result without continuation instructions has no
      // authoritative turn to run: admitting it as an outcome would
      // misattribute prior work as this run's result (fail closed).
      throw new Error(
        `An initialResult without continuation instructions has no authoritative turn; refusing to relabel prior context as a lifecycle outcome.`,
      );
    }
    try {
      currentResult = await runTurn({ ...input, mode: "initial", startingTurn: 1 });
    } catch (error) {
      return await settleInPlace(input, {
        status: "executor_error",
        taskId,
        title: task.title,
        summary: error instanceof Error ? error.message : "Executor failed.",
        adapter: "none",
        error: error instanceof Error ? error.message : "Executor failed.",
        workspaceRoot,
        baseline,
        changedSinceLaunch: [],
        reviewCycles: [],
        artifactDir: resolvedArtifactDir,
        operationRecord: join(resolvedArtifactDir, "operation.json"),
      });
    }
    lastExecutorTurn = currentResult.lastExecutorTurn ?? 1;
    // Non-completed initial turn: nothing is attributed or reviewed. Writes
    // the worker already performed were NOT rolled back and are disclosed.
    if (currentResult.status !== "completed") {
      if (currentResult.status === "cancelled" || signal?.aborted) {
        return await settleInPlace(input, {
          status: "cancelled",
          taskId,
          title: task.title,
          summary: currentResult.summary ?? "In-place worker was cancelled.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          usage: currentResult.usage,
          error: currentResult.error,
          workspaceRoot,
          baseline,
          changedSinceLaunch: [],
          reviewCycles: [],
          artifactDir: resolvedArtifactDir,
          operationRecord: currentResult.operationRecord,
          lastExecutorTurn,
          session: currentResult.session,
        });
      }
      return await settleInPlace(input, {
        status: currentResult.status === "timeout" ? "timeout" : "executor_error",
        taskId,
        title: task.title,
        summary: currentResult.summary ?? "In-place worker stopped.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        usage: currentResult.usage,
        error: currentResult.error,
        workspaceRoot,
        baseline,
        changedSinceLaunch: [],
        reviewCycles: [],
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }
  }

  // ── review loop over recorded workspace deltas ──
  const reviewCycles: InPlaceReviewCycle[] = [];
  let nextReviewCycle = await nextInPlaceReviewCycle(resolvedArtifactDir);
  let correctionCount = 0;
  const baselineFor = async (): Promise<InPlaceAttribution> => await computeInPlaceAttribution(baseline, config, signal);

  // Attribution so far; refreshed after every executor turn.
  let attribution = await baselineFor();

  for (;;) {
    // Claim deferred steering that could not reach the completed live turn,
    // exactly like the execute lifecycle: each claimed instruction resumes
    // the executor before review.
    if (input.takeDeferredSteering) {
      const deferred = await input.takeDeferredSteering();
      for (const item of deferred) {
        reportLifecycleProgress(input, {
          phase: "correcting",
          message: `applying deferred steering before review: ${item.instructionId}`,
          artifactDir: resolvedArtifactDir,
        });
        const resumed = await runTurn({
          ...input,
          mode: "continuation",
          startingTurn: lastExecutorTurn + 1,
          feedback: [
            "The prior executor turn could not accept these newer steering instructions live.",
            "Apply them now before this task is reviewed; later instructions take precedence:",
            `- [${item.instructionId}] ${item.instruction}`,
            "Finish the revised work and report the replacement result.",
          ].join("\n"),
          priorSession: currentResult.session,
        });
        lastExecutorTurn = resumed.lastExecutorTurn ?? lastExecutorTurn + 1;
        if (resumed.status !== "completed") {
          const status: InPlaceLifecycleStatus =
            resumed.status === "cancelled" || signal?.aborted ? "cancelled"
              : resumed.status === "timeout" ? "timeout" : "executor_error";
          return await settleInPlace(input, {
            status,
            taskId,
            title: task.title,
            summary: resumed.summary ?? "Deferred-steering executor failed.",
            adapter: resumed.adapter,
            model: resumed.model,
            usage: resumed.usage,
            error: resumed.error,
            workspaceRoot,
            baseline,
            changedSinceLaunch: attribution.changes.map((change) => ({ status: change.status, path: change.path })),
            reviewCycles,
            artifactDir: resolvedArtifactDir,
            operationRecord: resumed.operationRecord,
            lastExecutorTurn,
            session: resumed.session,
          });
        }
        rememberFinalAssistantSummaryText(window.evidence, resumed.summary);
        currentResult = resumed;
        attribution = await baselineFor();
      }
    }

    const changedPaths = attribution.changes.map((change) => ({ status: change.status, path: change.path }));
    const currentDeltaIdentity = inPlaceDeltaIdentity(attribution);
    if (changedPaths.length === 0 && !window.evidence.requiresReview) {
      return await settleInPlace(input, {
        status: "no_changes",
        taskId,
        title: task.title,
        summary: currentResult.summary,
        adapter: currentResult.adapter,
        model: currentResult.model,
        usage: currentResult.usage,
        workspaceRoot,
        baseline,
        changedSinceLaunch: [],
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    let frozen: { frozenConfig: ReviewGateConfig; enabled: boolean };
    try {
      frozen = freezeReviewers(config, scopedModels ?? []);
    } catch (error) {
      return await settleInPlace(input, {
        status: "reviewer_blocked",
        taskId,
        title: task.title,
        summary: error instanceof Error ? error.message : "Reviewer selection blocked.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: error instanceof Error ? error.message : "Reviewer selection blocked.",
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    if (!frozen.enabled) {
      // Automatic subtask review is off: the writes remain in place with no
      // verdict. Settled as reviewed by nobody, never as "accepted".
      return await settleInPlace(input, {
        status: "unreviewed",
        taskId,
        title: task.title,
        summary: currentResult.summary,
        adapter: currentResult.adapter,
        model: currentResult.model,
        usage: currentResult.usage,
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    if (signal?.aborted) {
      return await settleInPlace(input, {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: "In-place lifecycle cancelled.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: "Cancelled.",
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    const reviewCycle = nextReviewCycle++;
    const reviewerLabels = resolveReviewers(frozen.frozenConfig).reviewers.map(reviewerProgressLabel);
    reportLifecycleProgress(input, {
      phase: "reviewing",
      message: `review cycle ${reviewCycle} over the recorded workspace delta`,
      artifactDir: resolvedArtifactDir,
      reviewCycle,
      reviewers: reviewerLabels,
    });

    // Review-interruption steers behave exactly like the execute lifecycle:
    // the in-flight review aborts, the executor resumes with the changed
    // request, and the replacement delta is freshly attributed and reviewed.
    const reviewAbort = new AbortController();
    const reviewSteering: Array<{ instruction: string; instructionId: string }> = [];
    const reviewSignal = signal ? AbortSignal.any([signal, reviewAbort.signal]) : reviewAbort.signal;
    input.onLiveControl?.({
      adapter: "review-gate",
      generation: Math.max(1, lastExecutorTurn),
      protocol: "review-to-executor-handoff-v1",
      capabilities: { steer: true, interrupt: false },
      steer: async (instruction: string, instructionId: string) => {
        reviewSteering.push({ instruction, instructionId });
        if (!reviewAbort.signal.aborted) reviewAbort.abort(new Error("review_interrupted_for_steering"));
        return {
          status: "acknowledged" as const,
          message: "Review interruption requested; steering will be applied in the next executor turn before review restarts.",
        };
      },
      interrupt: async () => ({
        status: "blocked" as const,
        message: "Use the task interrupt action to stop the complete task, including its active review.",
      }),
    });

    let reviewOutput: ReviewRunOutput;
    try {
      reviewOutput = await runCandidateReviewWithRecovery(
        () => runReview({
          cwd: workspaceRoot,
          request: buildInPlaceReviewRequest(task, attribution, window.evidence),
          before: baseline.snapshot,
          config: frozen.frozenConfig,
          evidence: window.evidence,
          window,
          correctionAttemptCount: correctionCount,
          signal: reviewSignal,
          onUpdate: (message: string) => {
            if (message) {
              reportLifecycleProgress(input, {
                phase: "reviewing",
                message,
                artifactDir: resolvedArtifactDir,
                reviewCycle,
                reviewers: reviewerLabels,
              });
            }
          },
        }),
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
        return await settleInPlace(input, {
          status: "review_error",
          taskId,
          title: task.title,
          summary: error instanceof Error ? error.message : "Review infrastructure failed.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: error instanceof Error ? error.message : "review_error",
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: currentResult.operationRecord,
          lastExecutorTurn,
          session: currentResult.session,
        });
      }
    } finally {
      input.onLiveControl?.(undefined);
    }

    if (reviewSteering.length > 0 && !signal?.aborted) {
      reportLifecycleProgress(input, {
        phase: "correcting",
        message: "review interrupted — applying higher-priority steering",
        artifactDir: resolvedArtifactDir,
      });
      if (signal?.aborted) {
        return await settleInPlace(input, {
          status: "cancelled",
          taskId,
          title: task.title,
          summary: "In-place lifecycle cancelled before applying review-interrupting steering.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: "Cancelled.",
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: currentResult.operationRecord,
          lastExecutorTurn,
          session: currentResult.session,
        });
      }
      const steered = await runTurn({
        ...input,
        mode: "continuation",
        startingTurn: lastExecutorTurn + 1,
        feedback: [
          "The active review was interrupted because the user or orchestrator changed the requested work.",
          "Apply these newer instructions now; they take precedence over the workspace state that was being reviewed:",
          ...reviewSteering.map((item) => `- [${item.instructionId}] ${item.instruction}`),
          "Finish the revised work in place and report it for a fresh review.",
        ].join("\n"),
        priorSession: currentResult.session,
      });
      lastExecutorTurn = steered.lastExecutorTurn ?? lastExecutorTurn + 1;
      if (steered.status !== "completed") {
        const status: InPlaceLifecycleStatus =
          steered.status === "cancelled" || signal?.aborted ? "cancelled"
            : steered.status === "timeout" ? "timeout" : "executor_error";
        return await settleInPlace(input, {
          status,
          taskId,
          title: task.title,
          summary: steered.summary ?? "Steered executor failed.",
          adapter: steered.adapter,
          model: steered.model,
          usage: steered.usage,
          error: steered.error,
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: steered.operationRecord,
          lastExecutorTurn,
          session: steered.session,
        });
      }
      rememberFinalAssistantSummaryText(window.evidence, steered.summary);
      currentResult = steered;
      attribution = await baselineFor();
      continue;
    }

    if (reviewOutput.result?.error === "aborted" || signal?.aborted) {
      return await settleInPlace(input, {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: "Review was aborted.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: "aborted",
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    const verdict = reviewOutput.result?.verdict ?? "error";
    const cycle: InPlaceReviewCycle = {
      cycle: reviewCycle,
      externalObservationRevision: window.evidence.externalObservationRevision ?? 0,
      verdict,
      reviewOutput,
      changedSinceLaunch: attribution.changes,
      identity: currentDeltaIdentity,
    };
    reviewCycles.push(cycle);

    try {
      await persistInPlaceReviewCycleRecord(resolvedArtifactDir, buildInPlaceReviewCycleRecord({
        taskId,
        cycle: reviewCycle,
        reviewSequence: reviewOutput.reviewSequence ?? reviewCycle,
        attribution,
        deltaIdentitySha256: createHash("sha256").update(currentDeltaIdentity).digest("hex"),
        reviewOutput,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return await settleInPlace(input, {
        status: "review_error",
        taskId,
        title: task.title,
        summary: `Persisting the durable in-place review cycle record failed (review cycle ${reviewCycle}); the review verdict is not trusted for a new cycle. ${message}`,
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: error instanceof Error ? error.message : message,
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    if (verdict === "error") {
      return await settleInPlace(input, {
        status: "review_error",
        taskId,
        title: task.title,
        summary: reviewOutput.result?.summary ?? "Review errored.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: reviewOutput.result?.error ?? reviewOutput.error ?? "review_error",
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    if (verdict === "needs_changes") {
      const maxCorrectionCycles = input.maxCorrectionCycles ?? config.maxCorrectionCycles;
      if (correctionCount >= maxCorrectionCycles) {
        return await settleInPlace(input, {
          status: "correction_cap",
          taskId,
          title: task.title,
          summary: `Correction cap reached after ${maxCorrectionCycles} cycle(s); the workspace keeps the current state with no passing review.`,
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: `Correction cap reached: ${maxCorrectionCycles}`,
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: currentResult.operationRecord,
          lastExecutorTurn,
          session: currentResult.session,
        });
      }
      const priorCycle = reviewCycles[reviewCycles.length - 2];
      if (priorCycle?.identity === currentDeltaIdentity
        && (priorCycle.externalObservationRevision ?? 0) === (window.evidence.externalObservationRevision ?? 0)) {
        return await settleInPlace(input, {
          status: "correction_cap",
          taskId,
          title: task.title,
          summary: "No progress: the recorded workspace delta is unchanged after correction.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: "No progress detected.",
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: currentResult.operationRecord,
          lastExecutorTurn,
          session: currentResult.session,
        });
      }

      correctionCount += 1;
      reportLifecycleProgress(input, {
        phase: "correcting",
        message: `correction ${correctionCount}/${maxCorrectionCycles}`,
        artifactDir: resolvedArtifactDir,
      });
      if (signal?.aborted) {
        return await settleInPlace(input, {
          status: "cancelled",
          taskId,
          title: task.title,
          summary: "In-place lifecycle cancelled during correction.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: "Cancelled.",
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: currentResult.operationRecord,
          lastExecutorTurn,
          session: currentResult.session,
        });
      }
      const feedback = await buildReviewTransmission(
        reviewOutput,
        reviewOutput.invocationDir ?? join(resolvedArtifactDir, "invocations"),
        reviewOutput.bundleDir ?? join(resolvedArtifactDir, "review-bundles"),
        window.nextReviewSequence - 1,
        "correction_required",
      );
      const corrected = await runTurn({
        ...input,
        mode: "continuation",
        startingTurn: lastExecutorTurn + 1,
        feedback,
        priorSession: currentResult.session,
      });
      lastExecutorTurn = corrected.lastExecutorTurn ?? lastExecutorTurn + 1;
      if (corrected.status !== "completed") {
        const status: InPlaceLifecycleStatus =
          corrected.status === "cancelled" || signal?.aborted ? "cancelled"
            : corrected.status === "timeout" ? "timeout" : "executor_error";
        return await settleInPlace(input, {
          status,
          taskId,
          title: task.title,
          summary: corrected.summary ?? "Correction executor failed.",
          adapter: corrected.adapter,
          model: corrected.model,
          usage: corrected.usage,
          error: corrected.error,
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: corrected.operationRecord,
          lastExecutorTurn,
          session: corrected.session,
        });
      }
      rememberFinalAssistantSummaryText(window.evidence, corrected.summary);
      currentResult = corrected;
      attribution = await baselineFor();
      continue;
    }

    // ── pass: transmit for observation, resume once (mirrors execute) ──
    reportLifecycleProgress(input, {
      phase: "confirming",
      message: "review passed — confirming the workspace delta is unchanged",
      artifactDir: resolvedArtifactDir,
    });
    if (signal?.aborted) {
      return await settleInPlace(input, {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: "In-place lifecycle cancelled during pass confirmation.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: "Cancelled.",
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }
    const passedDeltaIdentity = currentDeltaIdentity;
    const passedExternalRevision = window.evidence.externalObservationRevision ?? 0;
    const passedObservationsTruncated = window.evidence.toolObservationsTruncated === true;
    const passFeedback = await buildReviewTransmission(
      reviewOutput,
      reviewOutput.invocationDir ?? join(resolvedArtifactDir, "invocations"),
      reviewOutput.bundleDir ?? join(resolvedArtifactDir, "review-bundles"),
      window.nextReviewSequence - 1,
      "passed",
    );
    const confirmed = await runTurn({
      ...input,
      mode: "continuation",
      startingTurn: lastExecutorTurn + 1,
      feedback: passFeedback,
      priorSession: currentResult.session,
    });
    lastExecutorTurn = confirmed.lastExecutorTurn ?? lastExecutorTurn + 1;
    if (confirmed.status === "cancelled" || signal?.aborted) {
      return await settleInPlace(input, {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: confirmed.summary ?? "In-place lifecycle cancelled during pass confirmation.",
        adapter: confirmed.adapter,
        model: confirmed.model,
        usage: confirmed.usage,
        error: confirmed.error ?? "Cancelled.",
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: confirmed.operationRecord,
        lastExecutorTurn,
        session: confirmed.session,
      });
    }
    if (confirmed.status !== "completed") {
      return await settleInPlace(input, {
        status: confirmed.status === "timeout" ? "timeout" : "executor_error",
        taskId,
        title: task.title,
        summary: confirmed.summary ?? "Confirmation executor failed.",
        adapter: confirmed.adapter,
        model: confirmed.model,
        usage: confirmed.usage,
        error: confirmed.error,
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: confirmed.operationRecord,
        lastExecutorTurn,
        session: confirmed.session,
      });
    }
    const confirmAttribution = await baselineFor();
    if (inPlaceDeltaIdentity(confirmAttribution) === passedDeltaIdentity
      && (window.evidence.externalObservationRevision ?? 0) === passedExternalRevision
      && (window.evidence.toolObservationsTruncated === true) === passedObservationsTruncated) {
      // The pass is tied to the exact reviewed workspace delta and the same
      // bounded external-observation state; neither new root changes nor new
      // external observations appeared during confirmation.
      const passedCycle = reviewCycles[reviewCycles.length - 1];
      if (!passedCycle || passedCycle.cycle !== reviewCycle) {
        return await settleInPlace(input, {
          status: "review_error",
          taskId,
          title: task.title,
          summary: "The passing review cycle could not be identified for settlement.",
          adapter: confirmed.adapter,
          model: confirmed.model,
          error: "pass cycle identity missing",
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: confirmed.operationRecord,
          lastExecutorTurn,
          session: confirmed.session,
        });
      }
      const withWarnings = hasPartialReviewerFailure(reviewOutput.reviewerResults);
      return await settleInPlace(input, {
        status: "reviewed",
        taskId,
        title: task.title,
        summary: withWarnings
          ? `${confirmed.summary}\n\nReview passed with reviewer infrastructure warnings. The reviewed workspace delta is unchanged since the passed review; the changes remain in place.`
          : `${confirmed.summary}\n\nReview passed and the reviewed workspace delta is unchanged since the passed review; the changes remain in place.`,
        adapter: confirmed.adapter,
        model: confirmed.model,
        usage: confirmed.usage,
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: confirmed.operationRecord,
        lastExecutorTurn,
        session: confirmed.session,
      });
    }
    // The workspace changed after the pass: the old pass is invalid and the
    // new delta must be reviewed (the review verdict is post-hoc; the writes
    // that produced this new delta were already performed either way).
    rememberFinalAssistantSummaryText(window.evidence, confirmed.summary);
    currentResult = confirmed;
    attribution = confirmAttribution;
    continue;
  }
}
