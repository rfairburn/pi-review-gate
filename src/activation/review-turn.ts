import { randomUUID } from "node:crypto";
import { effectiveReviewSettings, type ReviewGateConfig } from "../config";
import { createCorrectionFeedbackMarker, isRepeatedNoProgressFeedback } from "../correction-feedback";
import { rememberFinalAssistantSummary } from "../evidence";
import { BackgroundProcessReadiness } from "../background-process-readiness";
import { type BackgroundShellController, type BackgroundShellLifecycleEvent } from "../background-shell";
import {
  createStatusTracker,
  extractContext,
  extractSignal,
  sendNotice,
  sendSteeringPrompt,
  sendTriggeredFollowUp,
  type StatusTracker,
} from "../pi";
import { collectPausedReviewExchange, runReview, type ReviewRunOutput } from "../review";
import { captureReviewCheckpoint, releaseReviewCheckpoint } from "../review-checkpoint";
import { type ReviewCancellationCoordinator } from "../review-cancellation";
import { buildReviewAuthorizationMessage, createReviewTransmissionMessage, type ReviewTransmissionAction } from "../transmission";
import {
  activeExchangeHasBaseline,
  beginAgentRun,
  buildRequestContext,
  closeReviewWindow,
  freezeReviewWindowConfig,
  getCorrectionAttemptCount,
  recordReviewerFeedbackAndArmExchange,
  rememberUserRequest,
  setReviewWindowCheckpointBaseline,
  type ReviewGateState,
} from "../state";
import { combineTokenUsage, extractPiUsageFromMessages, formatTokenUsage, type TokenUsage } from "../usage";
import { findTriggeringCustomMessage, type ScheduledOrchestratorTurnTracker } from "../scheduling/orchestrator-turn";
import { sendNoticeUnlessItThrows, sendNoticeWhileSessionActive } from "./diagnostics";
import { deliverAutomaticTransmission, releaseQueuedUserInputs } from "./pending-delivery";
import { createReviewAbortController, type ReviewAbortHandle } from "./review-abort";

const orchestratorBackgroundCompletionPrompt = [
  "[pi-review-background-ready] ShellStart work that previously blocked review reached an idle transition.",
  "Automatic review was deliberately deferred while they were active.",
  "Re-check ShellList because a newer job may have started after this event was queued.",
  "Inspect the completed results and workspace, address any failure, and finish the original request when current background readiness permits.",
  "Do not claim success from process exit alone; verify the requested outcome before completing this turn.",
].join(" ");

/** Live background-subtask readiness rows as reported by the execution manager. */
interface ExecutionReadinessTask {
  readonly taskId: string;
  readonly kind: string;
  readonly title: string;
  readonly state: string;
}

export interface ReviewTurnBackgroundReadiness {
  revision: number;
  running: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  unverifiable: string[];
}

export interface ReviewTurnDependencies {
  /** Host object for notices, follow-ups, and steering prompts. */
  pi: unknown;
  /** Canonical review-gate state (windows, evidence, delivery records). */
  state: ReviewGateState;
  /** Live config object (mutated in place by settings saves). */
  config: ReviewGateConfig;
  /** Current scoped-model choices, updated at the root's hook points. */
  scopedModels: () => string[];
  isSessionActive: () => boolean;
  /** Root-owned cwd update point for a hook argument list (no recapture elsewhere). */
  observeCwd: (args: unknown[]) => void;
  /** Live cwd fact, read at each original use point. */
  cwd: () => string;
  /** Root-owned scoped-model/UI-context sync for the execution manager. */
  syncExecutionContext: (args: unknown[]) => void;
  checkpointRestartBlocked: () => string | undefined;
  effectiveReviewConfig: () => ReviewGateConfig;
  /** Ordinary save (may resolve without writing). */
  persist: () => Promise<void>;
  /** Durable-boolean save for the automatic-delivery uncertainty gate. */
  persistAutomaticDelivery: () => Promise<boolean>;
  /** Live background-shell controller binding (undefined on hosts without it). */
  backgroundShell: () => BackgroundShellController | undefined;
  reviewReadiness: () => ReadonlyArray<ExecutionReadinessTask>;
  /** Reassert the captured deferred-tool authorization boundary. */
  reapplyDeferredTools: () => void;
  cancellation: ReviewCancellationCoordinator;
  orchestratorTurns: Pick<ScheduledOrchestratorTurnTracker,
    "hasRunsInFlight" | "noteMessageObserved" | "noteMessageArmingFailed">;
}

export interface ReviewTurnCoordinator {
  /** Shared fail-closed run-arming body (before_agent_start and message_start). */
  armAgentRun(args: unknown[]): Promise<"armed" | "blocked">;
  /** Scheduled trigger-message observation handler body. */
  onMessageStart(args: unknown[]): Promise<void>;
  /** agent_end accrual handler body (never finalizes). */
  onAgentEnd(args: unknown[]): Promise<void>;
  /** Automatic review settlement handler body (agent_settled only). */
  onAgentSettled(args: unknown[]): Promise<void>;
  trackEvidenceCapture(operation: Promise<void>): Promise<void>;
  drainEvidenceCaptures(): Promise<void>;
  /** Fallback ShellStart readiness observation when no shell controller exists. */
  observeBackgroundToolResult(toolName: string, result: unknown): void;
  currentBackgroundReadiness(): ReviewTurnBackgroundReadiness;
  /** Construction-time background-lifecycle subscription (exact original slot). */
  attachBackgroundLifecycle(): void;
  /** Session-start background-state reset and guarded re-subscription. */
  resetForSessionStart(): void;
  prepareReviewerQuestion(commandName: string, ctx: unknown): Promise<void>;
  isSettlementInputHoldActive(): boolean;
  triggeringFailure(): string | undefined;
  clearTriggeringFailure(): void;
  /** Shutdown: abort the active review and await its settlement. */
  shutdownReview(): Promise<void>;
  /** Shutdown: clear the active status tracker. */
  clearStatusTracker(): Promise<void>;
  /** Shutdown: reset review/background state and release question waiters. */
  resetForShutdown(): void;
}

export function isToolError(value: unknown): boolean {
  return typeof value === "object" && value !== null && "isError" in value && Boolean((value as { isError?: unknown }).isError);
}

function commandContextIsIdle(ctx: unknown): boolean {
  if (typeof ctx === "object" && ctx !== null && "isIdle" in ctx && typeof ctx.isIdle === "function") {
    return Boolean(ctx.isIdle());
  }
  return true;
}

export function createReviewTurnCoordinator(deps: ReviewTurnDependencies): ReviewTurnCoordinator {
  let activeReviewAbort: ReviewAbortHandle | undefined;
  let activeReviewSettled: Promise<void> | undefined;
  let activeStatusTracker: StatusTracker | undefined;
  let agentRunActive = false;
  let agentSettlementInputHold = false;
  // Records accumulated from each low-level run's agent_end until Pi confirms
  // via agent_settled that no automatic retry, compaction retry, or queued
  // continuation remains. Finalization must not happen at agent_end: Pi can
  // still mutate the workspace after it (e.g. a retried provider overload),
  // so closing or reviewing the window there would race the real outcome.
  let pendingSettlementUsage: TokenUsage | undefined;
  let pendingSettlementAborted = false;
  let pendingSettlementPausedForQuestion = false;
  let reviewerQuestionPausePending = false;
  /**
   * A message_start-triggered run cannot be cancelled by this host after the
   * message is admitted. If review/auth re-arming fails, fail closed at the
   * native tool boundary for the rest of this session and refuse later
   * scheduled orchestrator turns rather than allowing an unreviewed change.
   */
  let triggeringMessageReviewFailure: string | undefined;
  let backgroundCompletionMonitor: Promise<void> | undefined;
  let backgroundMonitorGeneration = 0;
  let backgroundReviewDeferred = false;
  let pendingNativeCompletionRevision: number | undefined;
  let unsubscribeBackgroundLifecycle: (() => void) | undefined;
  const pendingEvidenceCaptures = new Set<Promise<void>>();
  const orchestratorBackgroundReadiness = new BackgroundProcessReadiness();
  const reviewerQuestionPauseWaiters = new Set<(error?: Error) => void>();

  const trackEvidenceCapture = async (operation: Promise<void>): Promise<void> => {
    pendingEvidenceCaptures.add(operation);
    try {
      await operation;
    } finally {
      pendingEvidenceCaptures.delete(operation);
    }
  };

  const drainEvidenceCaptures = async (): Promise<void> => {
    while (pendingEvidenceCaptures.size > 0) {
      await Promise.allSettled([...pendingEvidenceCaptures]);
    }
  };

  const releaseReviewerQuestionPauseWaiters = (error?: Error) => {
    for (const resolve of reviewerQuestionPauseWaiters) {
      resolve(error);
    }
    reviewerQuestionPauseWaiters.clear();
  };

  const currentBackgroundReadiness = (): ReviewTurnBackgroundReadiness => {
    const shell = deps.backgroundShell();
    if (!shell) return orchestratorBackgroundReadiness.snapshot();
    const snapshot = shell.snapshot();
    return { revision: snapshot.revision, running: snapshot.running, unverifiable: [] as string[] };
  };

  const scheduleBackgroundCompletion = (noticeTarget: unknown) => {
    if (backgroundCompletionMonitor) return;
    const generation = backgroundMonitorGeneration;
    backgroundCompletionMonitor = (async () => {
      while (deps.isSessionActive() && generation === backgroundMonitorGeneration) {
        const readiness = currentBackgroundReadiness();
        if (readiness.unverifiable.length > 0 || readiness.running.length === 0) break;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      if (!deps.isSessionActive() || generation !== backgroundMonitorGeneration) return;
      const readiness = currentBackgroundReadiness();
      if (readiness.unverifiable.length > 0) {
        await sendNotice(
          noticeTarget,
          `review gate: review remains blocked because ShellStart background readiness could not be verified: ${readiness.unverifiable.join("; ")}`,
        );
        return;
      }
      if (deps.reviewReadiness().length > 0) return;
      const idleRevision = readiness.revision;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250));
      const confirmed = currentBackgroundReadiness();
      if (
        !deps.isSessionActive()
        || generation !== backgroundMonitorGeneration
        || confirmed.revision !== idleRevision
        || confirmed.running.length > 0
        || confirmed.unverifiable.length > 0
        || agentRunActive
        || deps.state.reviewInProgress
        || !deps.state.reviewWindow
        || deps.reviewReadiness().length > 0
      ) return;
      const delivered = await sendTriggeredFollowUp(deps.pi, orchestratorBackgroundCompletionPrompt);
      if (!delivered) {
        await sendNotice(noticeTarget, "review gate: background work completed, but the orchestrator could not be resumed automatically; review remains deferred until the next turn");
      }
    })().finally(() => {
      backgroundCompletionMonitor = undefined;
    });
  };

  const handleBackgroundLifecycle = (event: BackgroundShellLifecycleEvent) => {
    if (event.type === "started") {
      pendingNativeCompletionRevision = undefined;
      return;
    }
    if (
      !deps.isSessionActive()
      || !backgroundReviewDeferred
      || event.running.length > 0
      || event.exitWakeScheduled
    ) return;

    const revision = event.revision;
    pendingNativeCompletionRevision = revision;
    queueMicrotask(() => {
      void (async () => {
        if (!deps.isSessionActive() || pendingNativeCompletionRevision !== revision) return;
        const current = deps.backgroundShell()?.snapshot();
        if (!current || current.revision !== revision || current.running.length > 0) return;
        if (!deps.state.reviewWindow || deps.state.reviewInProgress || deps.reviewReadiness().length > 0) return;
        const delivered = await sendTriggeredFollowUp(deps.pi, orchestratorBackgroundCompletionPrompt);
        if (!delivered) {
          await sendNotice(deps.pi, "review gate: background work completed, but the orchestrator could not be resumed automatically; review remains deferred until the next turn");
        }
      })();
    });
  };

  /**
   * Issue #222 (corrected lifecycle): the shared fail-closed run-arming body
   * for every agent run this extension observes. The review gate's
   * before_agent_start calls it for every normal user turn; the scheduled
   * custom-message observation (message_start) calls it for the idle and
   * queued scheduled runs whose submit path on real Pi hosts bypasses
   * before_agent_start entirely. Idempotent for an already-armed run (a busy
   * queued turn shares the exchange window the running cycle armed) and
   * capturing a fresh checkpoint baseline for an idle run. It cannot modify
   * the system prompt (message_start has no prompt result): the model-facing
   * injection stays on the before_agent_start path only.
   */
  const armAgentRun = async (args: unknown[]): Promise<"armed" | "blocked"> => {
    // Pi may auto-activate tools registered after session_start. Reassert the
    // captured boundary immediately before every new agent request.
    deps.reapplyDeferredTools();
    if (deps.checkpointRestartBlocked()) return "blocked";
    agentRunActive = true;
    deps.observeCwd(args);
    deps.syncExecutionContext(args);
    beginAgentRun(deps.state);
    if (activeExchangeHasBaseline(deps.state)) return "armed";
    const existing = deps.state.reviewWindow?.baseline;
    if (existing && existing.kind !== "checkpoint") {
      // Restored legacy windows retain their own typed baseline and settle
      // through their existing fail-closed path until that window closes.
      if (deps.state.reviewWindow?.activeExchange) deps.state.reviewWindow.activeExchange.baseline = existing;
      freezeReviewWindowConfig(deps.state, deps.config, deps.scopedModels());
      await deps.persist();
      return "armed";
    }
    const captured = existing ? undefined : await captureReviewCheckpoint(deps.cwd(), `window-${deps.state.reviewWindow?.id ?? 0}-${randomUUID()}`, { scope: deps.state.checkpointScope });
    if (captured && captured.status !== "ok") throw new Error(`review gate: baseline capture failed (${captured.reason}): ${captured.detail}`);
    const baseline = existing ?? (captured?.status === "ok"
      ? { kind: "checkpoint" as const, descriptor: captured.value, cwd: deps.cwd(), capturedAt: new Date().toISOString() }
      : undefined);
    if (!baseline) throw new Error("review gate: checkpoint capture unavailable");
    // Once the descriptor enters state, retain it on save failure: a future
    // successful save can still recover the referenced checkpoint.
    try {
      setReviewWindowCheckpointBaseline(deps.state, baseline);
      freezeReviewWindowConfig(deps.state, deps.config, deps.scopedModels());
      await deps.persist();
    } catch (error) {
      if (captured?.status === "ok" && deps.state.reviewWindow?.baseline !== baseline && deps.state.reviewWindow?.activeExchange?.baseline !== baseline) {
        const released = await releaseReviewCheckpoint(deps.cwd(), captured.value, { scope: deps.state.checkpointScope });
        if (released.status !== "ok") throw new Error(`review gate: baseline setup failed; orphan release failed (${released.reason}): ${released.detail}`);
      }
      throw error;
    }
    return "armed";
  };

  const onMessageStart = async (args: unknown[]): Promise<void> => {
    const message = findTriggeringCustomMessage(args);
    if (!message) return;
    const occurrenceId = message.customType === "pi-review-scheduled-orchestrator-turn"
      ? message.details?.occurrenceId
      : undefined;
    if (!deps.orchestratorTurns.hasRunsInFlight()) {
      // Real Pi emits agent_start before consuming a trigger-turn custom
      // message. If that contract is absent at runtime, do not arm or
      // attribute the message as though a real consuming run existed.
      triggeringMessageReviewFailure ??= "a triggering custom message arrived without an observable agent run";
      deps.orchestratorTurns.noteMessageArmingFailed(occurrenceId);
      await sendNoticeUnlessItThrows(extractContext(args) ?? deps.pi,
        "review gate: a triggering custom message could not be correlated with an agent run; all Pi tool calls are blocked for this session, and scheduled orchestrator turns are disabled until a new session");
      return;
    }
    // Attribute FIRST (cheap and synchronous): a send promise may reject
    // while the async review baseline is being persisted. This identity is
    // the host's exact message_start, never an unrelated before_agent_start.
    const observed = occurrenceId !== undefined && deps.orchestratorTurns.noteMessageObserved(occurrenceId);
    try {
      // The scheduled instructions are the request the reviewer must
      // evaluate, not merely an unattributed custom message in the session.
      // A busy follow-up adds them to the current exchange; an idle custom
      // turn opens a new review window before its baseline is captured.
      if (observed) {
        if (!message.content?.trim()) throw new Error("scheduled request text is unavailable");
        rememberUserRequest(deps.state, message.content);
      }
      // Fail-closed arming: this model request starts work this extension
      // initiated outside the normal prompt path. For a busy queued turn the
      // run already has an armed exchange baseline (shared window, no
      // re-capture); for an idle run this captures the baseline HERE, before
      // that message's model request.
      const armed = await armAgentRun(args);
      if (armed === "blocked") {
        throw new Error("the review gate's checkpoint restart is blocked");
      }
      if (observed) await deps.persist();
    } catch (error) {
      // Pi may continue the provider request after a message_start handler
      // fails. Do not count this occurrence, block every native tool call
      // before execution, and refuse later scheduled turns until a new
      // session restores a trustworthy review/auth boundary.
      triggeringMessageReviewFailure ??= "a triggering custom message could not reassert its review baseline and deferred-tool authorization";
      deps.orchestratorTurns.noteMessageArmingFailed(occurrenceId);
      console.warn(`review gate: ${triggeringMessageReviewFailure}: ${error instanceof Error ? error.message : String(error)}`);
      await sendNoticeUnlessItThrows(extractContext(args) ?? deps.pi,
        "review gate: a triggering custom message could not reassert the review baseline and deferred-tool authorization; all Pi tool calls are blocked for this session, and scheduled orchestrator turns are disabled until a new session");
    }
  };

  const onAgentEnd = async (args: unknown[]): Promise<void> => {
    try {
      // Pi emits agent_end for every low-level run and may still auto-retry,
      // auto-compact and retry, or continue with queued follow-up messages
      // afterwards. This hook therefore only records what the finished run
      // produced; review finalization happens once at agent_settled, where Pi
      // guarantees no automatic continuation remains (docs/extensions.md).
      // Detecting "this end is retryable" from provider error strings would be
      // brittle — the lifecycle boundary is the source of truth.
      deps.observeCwd(args);
      const signal = extractSignal(args);
      const window = deps.state.reviewWindow;
      if (window) {
        rememberFinalAssistantSummary(window.evidence, args);
      }
      pendingSettlementUsage = combineTokenUsage(pendingSettlementUsage, extractPiUsageFromMessages(args));
      if (signal?.aborted) {
        pendingSettlementAborted = true;
      }

      // The consultation can be identified here, but cannot be reviewed or
      // released until agent_settled has run the browser ownership barrier.
      const pauseForReviewerQuestion = reviewerQuestionPausePending;
      reviewerQuestionPausePending = false;
      if (pauseForReviewerQuestion) pendingSettlementPausedForQuestion = true;
    } finally {
      await deps.persist();
    }
  };

  const onAgentSettled = async (args: unknown[]): Promise<void> => {
    try {
      // agent_settled is the only point where Pi guarantees that no automatic
      // retry, compaction retry, or queued continuation remains for this turn,
      // so the review window may be finalized here and only here. Consume this
      // cycle's accumulated records first: running a review can queue follow-up
      // runs, whose before_agent_start resets the accumulators.
      const actingUsage = pendingSettlementUsage;
      const runAborted = pendingSettlementAborted;
      const pausedForReviewerQuestion = pendingSettlementPausedForQuestion;
      pendingSettlementUsage = undefined;
      pendingSettlementAborted = false;
      pendingSettlementPausedForQuestion = false;
      agentRunActive = false;
      deps.observeCwd(args);
      const noticeTarget = extractContext(args) ?? deps.pi;
      if (deps.checkpointRestartBlocked()) {
        await sendNoticeUnlessItThrows(noticeTarget,
          `review gate: review blocked (${deps.checkpointRestartBlocked()}); repair and restart before review`);
        return;
      }
      const prospectiveWindow = deps.state.reviewWindow;
      // Issue #175: automatic primary review is a stored per-layer toggle. It
      // suppresses the settlement-time automatic review only; manual
      // /review-now and /ask-reviewer stay gated by the selected reviewers and
      // the master setting. The hold must track whether an automatic review
      // will actually run, so queued user input is never stranded behind a
      // review that was switched off.
      const primaryEnabled = effectiveReviewSettings(deps.config).primaryEnabled;
      agentSettlementInputHold = Boolean(
        prospectiveWindow?.baseline
        && !runAborted
        && !pausedForReviewerQuestion
        && !deps.state.reviewsPaused
        && primaryEnabled
        && (prospectiveWindow.reviewConfig?.enabled ?? deps.config.enabled),
      );
      // Reviews settle model work, not the live browser. Page scripts and
      // authenticated broker traffic may continue throughout a review.
      if (pausedForReviewerQuestion) {
        // /ask-reviewer waits for this exact model settlement boundary, without
        // closing or suspending the browser. Web effects may continue.
        const window = deps.state.reviewWindow;
        try {
          if (window?.baseline && !runAborted) {
            await collectPausedReviewExchange({
              cwd: deps.cwd(),
              checkpointScope: deps.state.checkpointScope,
              config: window.reviewConfig ?? deps.config,
              evidence: window.evidence,
              actingUsage,
              window,
            });
          }
          releaseReviewerQuestionPauseWaiters();
        } catch (error) {
          releaseReviewerQuestionPauseWaiters(error instanceof Error ? error : new Error("Reviewer consultation settlement failed."));
          throw error;
        }
        return;
      }
      const window = deps.state.reviewWindow;
      if (!window) {
        return;
      }
      if (!primaryEnabled) {
        // Automatic primary review is off (issue #175): no reviewer runs at
        // settlement. Nothing is deferred on background readiness — there is no
        // automatic review for active background work to block — and the window
        // stays open so the baseline, exchanges, evidence, and history keep
        // accumulating across quick turns for a manual /review-now. The turn's
        // exchange is settled without any verdict, so no synthetic PASS ever
        // enters the persisted review history.
        // A background-completion wake armed by an earlier deferral while
        // automatic review was on may still resume the model after the toggle:
        // it finishes the original request, and this same off path settles that
        // resumed turn without running reviewers.
        backgroundReviewDeferred = false;
        pendingNativeCompletionRevision = undefined;
        if (!window.baseline) {
          closeReviewWindow(deps.state);
          return;
        }
        if (!deps.config.enabled) {
          // Master setting off keeps its existing settlement semantics: the
          // window is preserved for reviewer questions but not kept open.
          closeReviewWindow(deps.state, true);
          return;
        }
        if (runAborted) {
          // A user abort of the run supersedes automatic review; the window and
          // its baseline survive for the next turn, exactly as before.
          deps.state.reviewInProgress = false;
          deps.state.queuedUserInputsDuringReview = [];
          return;
        }
        await collectPausedReviewExchange({
          cwd: deps.cwd(),
          checkpointScope: deps.state.checkpointScope,
          config: window.reviewConfig ?? freezeReviewWindowConfig(deps.state, deps.config, deps.scopedModels()),
          evidence: window.evidence,
          actingUsage,
          window,
        });
        await deps.persist();
        return;
      }
      const backgroundReadiness = currentBackgroundReadiness();
      const executionReadiness = deps.reviewReadiness();
      if (backgroundReadiness.unverifiable.length > 0) {
        await sendNotice(
          noticeTarget,
          `review gate: automatic review blocked because ShellStart background readiness could not be verified: ${backgroundReadiness.unverifiable.join("; ")}`,
        );
        await deps.persist();
        return;
      }
      if (backgroundReadiness.running.length > 0 || executionReadiness.length > 0) {
        if (backgroundReadiness.running.length > 0) backgroundReviewDeferred = true;
        const blockers = [
          backgroundReadiness.running.length > 0
            ? `${backgroundReadiness.running.length} background process group(s) remain active (${backgroundReadiness.running.map((job) => `${job.id}: ${job.label}`).join(", ")})`
            : undefined,
          executionReadiness.length > 0
            ? `${executionReadiness.length} background subtask(s) remain active (${executionReadiness.map((task) => `${task.taskId}: ${task.kind} · ${task.title} [${task.state}]`).join(", ")})`
            : undefined,
        ].filter((value): value is string => Boolean(value));
        await sendNotice(
          noticeTarget,
          `review gate: automatic review deferred while ${blockers.join(" and ")}`,
        );
        if (backgroundReadiness.running.length > 0 && !deps.backgroundShell()) {
          scheduleBackgroundCompletion(noticeTarget);
        }
        await deps.persist();
        return;
      }
      backgroundReviewDeferred = false;
      pendingNativeCompletionRevision = undefined;
      if (!window.baseline) {
        closeReviewWindow(deps.state);
        return;
      }
      // #193 slice D: pass the typed baseline through. A Git checkpoint
      // variant settles inside runReview through one frozen after-checkpoint
      // (frozen-to-frozen compare, changed-only delta); a legacy snapshot keeps
      // the existing settle semantics.
      const reviewBefore = window.baseline;
      const reviewConfig = window.reviewConfig ?? freezeReviewWindowConfig(deps.state, deps.config, deps.scopedModels());
      if (!reviewConfig.enabled) {
        if (deps.config.enabled) {
          // The gate is enabled but no configured reviewer is currently
          // resolvable. Fail closed without clearing the preserved window: the
          // evidence stays open until a reviewer can run.
          await sendNoticeWhileSessionActive(
            noticeTarget,
            "review gate: automatic review deferred because no configured reviewer is currently available; the preserved review window stays open until a reviewer can run; use /review-settings",
            () => deps.isSessionActive(),
          );
          await deps.persist();
          return;
        }
        closeReviewWindow(deps.state, true);
        return;
      }
      if (runAborted) {
        // A user abort of the run supersedes automatic review; the window and
        // its baseline survive for the next turn, exactly as before.
        deps.state.reviewInProgress = false;
        deps.state.queuedUserInputsDuringReview = [];
        return;
      }
      if (deps.state.reviewsPaused) {
        await collectPausedReviewExchange({
          cwd: deps.cwd(),
          checkpointScope: deps.state.checkpointScope,
          config: reviewConfig,
          evidence: window.evidence,
          actingUsage,
          window,
        });
        return;
      }

      deps.state.reviewInProgress = true;
      let settleReview!: () => void;
      const reviewSettled = new Promise<void>((resolvePromise) => { settleReview = resolvePromise; });
      activeReviewSettled = reviewSettled;
      // The terminal-input listener must be installed before any await so Escape
      // (and /review-cancel) can abort while evidence drains or state persists;
      // the handler itself gates on reviewInProgress.
      const reviewAbort = createReviewAbortController({
        signal: undefined,
        noticeTarget,
        state: deps.state,
        isSessionActive: () => deps.isSessionActive(),
        cancellation: deps.cancellation,
        settled: reviewSettled,
        describe: () => "the automatic review",
      });
      activeReviewAbort = reviewAbort;
      try {
        await drainEvidenceCaptures();
        await deps.persist();
      } catch (error) {
        // Any failure after listener/coordinator registration must still
        // unregister, settle the review, and clear active references so session
        // shutdown and /review-cancel never observe stale state.
        deps.state.reviewInProgress = false;
        reviewAbort.cleanup();
        if (activeReviewAbort === reviewAbort) activeReviewAbort = undefined;
        settleReview();
        if (activeReviewSettled === reviewSettled) activeReviewSettled = undefined;
        throw error;
      }
      if (!deps.isSessionActive()) {
        deps.state.reviewInProgress = false;
        reviewAbort.cleanup();
        if (activeReviewAbort === reviewAbort) activeReviewAbort = undefined;
        settleReview();
        if (activeReviewSettled === reviewSettled) activeReviewSettled = undefined;
        return;
      }
      // No run signal exists at settlement time (the last low-level run has
      // already finished); cancellation still flows through escape terminal
      // input, /review-cancel, and session shutdown.
      const statusTracker = createStatusTracker(noticeTarget, "review-gate", "reviewing changes");
      activeStatusTracker = statusTracker;
      let output: ReviewRunOutput;
      try {
        output = await runReview({
          cwd: deps.cwd(),
          checkpointScope: deps.state.checkpointScope,
          request: buildRequestContext(deps.state, deps.state.reviewWindow, { priorFeedback: "latest" }),
          before: reviewBefore,
          config: reviewConfig,
          evidence: window.evidence,
          correctionAttemptCount: getCorrectionAttemptCount(window),
          actingUsage,
          window,
          signal: reviewAbort.signal,
          notify: (message) => sendNoticeWhileSessionActive(noticeTarget, message, () => deps.isSessionActive()),
          onUpdate: (message) => statusTracker.update(message),
          onInvocationPrepared: () => deps.persist(),
        });
      } catch (error) {
        if (!deps.isSessionActive()) {
          return;
        }
        await releaseQueuedUserInputs(deps.pi, deps.state, () => deps.isSessionActive(), () => deps.persist());
        throw error;
      } finally {
        await statusTracker.clear({ immediate: reviewAbort.signal.aborted, signal: reviewAbort.signal });
        if (activeStatusTracker === statusTracker) {
          activeStatusTracker = undefined;
        }
        reviewAbort.cleanup();
        if (activeReviewAbort === reviewAbort) {
          activeReviewAbort = undefined;
        }
        settleReview();
        if (activeReviewSettled === reviewSettled) {
          activeReviewSettled = undefined;
        }
        // A resumed conversation may need the active review artifacts.
      }

      if (!deps.isSessionActive()) {
        await output.releaseReviewedBaseline?.();
        return;
      }

      if (!output.changed) {
        if (output.noReviewReason === "unchanged_deferred_response") {
          await releaseQueuedUserInputs(deps.pi, deps.state, () => deps.isSessionActive(), () => deps.persist());
          return;
        }
        closeReviewWindow(deps.state, true);
        await releaseQueuedUserInputs(deps.pi, deps.state, () => deps.isSessionActive(), () => deps.persist());
        return;
      }

      if (reviewAbort.signal.aborted || output.result?.error === "aborted") {
        if (reviewAbort.getReason() === "escape" || reviewAbort.getReason() === "manual") {
          await reviewAbort.notifyCancellation();
        }
        deps.state.reviewInProgress = false;
        // Count the queued user inputs that are deliberately dropped with this
        // cancellation so the notice below never invents or leaks content. The
        // ledger is the source of truth for what is cleared: every reachable
        // current entry carries its durable delivery record, old-only entries
        // without one are still counted (never silently dropped), and ledger
        // occurrences whose only record is an in-flight delivery
        // (dispatching/uncertain) may still land and are never counted as
        // definitely dropped. The count is computed before the deliveries below
        // are cancelled and the queued-input ledger is cleared.
        const inFlightByMessage = new Map<string, number>();
        for (const delivery of deps.state.pendingModelDeliveries) {
          if (delivery.kind === "queued_user_input" && (delivery.status === "dispatching" || delivery.status === "uncertain")) {
            inFlightByMessage.set(delivery.message, (inFlightByMessage.get(delivery.message) ?? 0) + 1);
          }
        }
        let droppedInputCount = 0;
        for (const message of deps.state.queuedUserInputsDuringReview) {
          const inFlight = inFlightByMessage.get(message) ?? 0;
          if (inFlight > 0) {
            inFlightByMessage.set(message, inFlight - 1);
            continue;
          }
          droppedInputCount += 1;
        }
        for (const delivery of deps.state.pendingModelDeliveries) {
          if (delivery.kind === "queued_user_input" && delivery.status === "queued") {
            delivery.status = "cancelled";
            delivery.diagnostic = "The review was explicitly cancelled before this queued input was released.";
          }
        }
        deps.state.queuedUserInputsDuringReview.splice(0);
        // Make the cancellation durable immediately: cancelled deliveries must
        // never be re-dispatched by a later restore, and the cleared ledger must
        // not be resurrected.
        await deps.persist();
        if (droppedInputCount > 0) {
          // Explicit count-only notice: dropped input is never resent
          // automatically and its content is never echoed.
          await sendNoticeWhileSessionActive(
            noticeTarget,
            `review gate: ${droppedInputCount} queued user input(s) were dropped when the review was cancelled and will not be sent automatically; resend them if still needed`,
            () => deps.isSessionActive(),
          );
        }
        return;
      }

      const transmit = async (details: Parameters<typeof transmitReviewPass>[0]): Promise<string> => {
        try {
          const message = await transmitReviewPass(details);
          // The new after descriptor is reachable from state; save before
          // retiring the previous response baseline. On save failure retain both.
          await deps.persist();
          return message;
        } catch (error) {
          // A transmission that fails before recording feedback never hands off
          // the after descriptor. Once reachable from state, retain on any save
          // failure rather than deleting an in-memory or persisted reference.
          if (window.activeExchange?.baseline !== output.reviewedBaseline) await output.releaseReviewedBaseline?.();
          throw error;
        }
      };
      if (output.result?.verdict === "pass") {
        const transmission = await transmit({
          state: deps.state,
          output,
          source: "automatic",
          disposition: "sent_for_observation",
          action: "passed",
        });
        await sendNoticeWhileSessionActive(
          noticeTarget,
          `review gate: ${output.result.error === "partial_reviewer_error" ? "passed with reviewer warnings" : "passed"} (${formatTokenUsage(output.result.usage)})`,
          () => deps.isSessionActive(),
        );
        await deliverAutomaticTransmission(deps.pi, noticeTarget, deps.state, output, "passed", transmission, () => deps.isSessionActive(), deps.persistAutomaticDelivery);
        await releaseQueuedUserInputs(deps.pi, deps.state, () => deps.isSessionActive(), () => deps.persist());
        return;
      }

      if (output.result?.verdict === "needs_changes") {
        if (isRepeatedNoProgressFeedback({
          previous: window.lastCorrectionFeedback,
          result: output.result,
          changes: output.changes,
          evidenceEventCount: window.evidence.events.length,
        })) {
          const transmission = await transmit({
            state: deps.state,
            output,
            source: "automatic",
            disposition: "sent_at_cap",
            action: "deferred",
          });
          await sendNoticeWhileSessionActive(
            noticeTarget,
            [
              `review gate: repeated changes requested with no new correction evidence (${formatTokenUsage(output.result.usage)})`,
              "Reviewer feedback matched the previous blocking feedback, and the correction turn produced no new tool evidence or file-change fingerprint.",
              "Stopping automatic correction to avoid a loop.",
            ].join("\n"),
            () => deps.isSessionActive(),
          );
          await deliverAutomaticTransmission(deps.pi, noticeTarget, deps.state, output, "deferred", transmission, () => deps.isSessionActive(), deps.persistAutomaticDelivery);
          await releaseQueuedUserInputs(deps.pi, deps.state, () => deps.isSessionActive(), () => deps.persist());
          return;
        }

        window.lastCorrectionFeedback = createCorrectionFeedbackMarker({
          result: output.result,
          changes: output.changes,
          evidenceEventCount: window.evidence.events.length,
        });
        if (window.correctionCycles >= reviewConfig.maxCorrectionCycles) {
          const deferredTransmission = await transmit({
            state: deps.state,
            output,
            source: "automatic",
            disposition: "sent_at_cap",
            action: "deferred",
          });
          window.lastCappedFollowUp = buildReviewAuthorizationMessage({
            reviewSequence: output.reviewSequence!,
            bundleDir: output.bundleDir!,
          });
          await sendNoticeWhileSessionActive(
            noticeTarget,
            [
              `review gate: changes requested, automatic correction cap reached (${formatTokenUsage(output.result.usage)})`,
              "Complete reviewer feedback was transmitted to the implementing model, but automatic correction is deferred.",
              `Use /review-continue to authorize another ${reviewConfig.maxCorrectionCycles} automatic correction cycle(s).`,
            ].join("\n"),
            () => deps.isSessionActive(),
          );
          await deliverAutomaticTransmission(deps.pi, noticeTarget, deps.state, output, "deferred", deferredTransmission, () => deps.isSessionActive(), deps.persistAutomaticDelivery);
          await releaseQueuedUserInputs(deps.pi, deps.state, () => deps.isSessionActive(), () => deps.persist());
          return;
        }
        window.lastCappedFollowUp = undefined;
        window.correctionCycles += 1;
        const transmission = await transmit({
          state: deps.state,
          output,
          source: "automatic",
          disposition: "sent_for_correction",
          action: "correction_required",
        });
        await sendNoticeWhileSessionActive(
          noticeTarget,
          `review gate: changes requested (${formatTokenUsage(output.result.usage)})`,
          () => deps.isSessionActive(),
        );
        await deliverAutomaticTransmission(deps.pi, noticeTarget, deps.state, output, "correction_required", transmission, () => deps.isSessionActive(), deps.persistAutomaticDelivery);
        await releaseQueuedUserInputs(deps.pi, deps.state, () => deps.isSessionActive(), () => deps.persist());
        return;
      }

      const failed = `review gate: reviewer failed (${formatTokenUsage(output.result?.usage)})`;
      if (output.result) {
        const transmission = await transmit({
          state: deps.state,
          output,
          source: "automatic",
          disposition: "sent_review_error",
          action: "review_error",
        });
        await deliverAutomaticTransmission(deps.pi, noticeTarget, deps.state, output, "review_error", transmission, () => deps.isSessionActive(), deps.persistAutomaticDelivery);
      }
      await sendNoticeWhileSessionActive(noticeTarget, failed, () => deps.isSessionActive());
      await releaseQueuedUserInputs(deps.pi, deps.state, () => deps.isSessionActive(), () => deps.persist());
    } finally {
      agentSettlementInputHold = false;
      await deps.persist();
    }
  };

  const prepareReviewerQuestion = async (commandName: string, ctx: unknown): Promise<void> => {
    if (!agentRunActive && commandContextIsIdle(ctx)) {
      return;
    }

    reviewerQuestionPausePending = true;
    const paused = new Promise<void>((resolve, reject) => reviewerQuestionPauseWaiters.add((error) => error ? reject(error) : resolve()));
    const delivered = await sendSteeringPrompt(
      deps.pi,
      [
        `Reviewer consultation requested by /${commandName}.`,
        "Pause implementation at this steering boundary. Do not call any more tools or modify files after receiving this message.",
        "End this turn so the reviewer can inspect the workspace; its response will be provided next. The browser remains live during review and page effects may continue.",
      ].join(" "),
    );
    if (!delivered) {
      reviewerQuestionPausePending = false;
      releaseReviewerQuestionPauseWaiters();
      throw new Error("review gate: cannot pause the active turn because sendUserMessage is unavailable");
    }
    await paused;
  };

  return {
    armAgentRun,
    onMessageStart,
    onAgentEnd,
    onAgentSettled,
    trackEvidenceCapture,
    drainEvidenceCaptures,
    observeBackgroundToolResult(toolName: string, result: unknown) {
      if (deps.backgroundShell()) return;
      orchestratorBackgroundReadiness.observeToolResult(toolName, result, isToolError(result));
    },
    currentBackgroundReadiness,
    attachBackgroundLifecycle() {
      const shell = deps.backgroundShell();
      unsubscribeBackgroundLifecycle = shell ? shell.subscribe(handleBackgroundLifecycle) : undefined;
    },
    resetForSessionStart() {
      backgroundMonitorGeneration += 1;
      backgroundCompletionMonitor = undefined;
      backgroundReviewDeferred = false;
      pendingNativeCompletionRevision = undefined;
      orchestratorBackgroundReadiness.clear();
      const shell = deps.backgroundShell();
      if (shell && !unsubscribeBackgroundLifecycle) {
        unsubscribeBackgroundLifecycle = shell.subscribe(handleBackgroundLifecycle);
      }
    },
    prepareReviewerQuestion,
    isSettlementInputHoldActive() {
      return agentSettlementInputHold;
    },
    triggeringFailure() {
      return triggeringMessageReviewFailure;
    },
    clearTriggeringFailure() {
      triggeringMessageReviewFailure = undefined;
    },
    async shutdownReview() {
      const reviewSettled = activeReviewSettled;
      activeReviewAbort?.shutdown();
      activeReviewAbort = undefined;
      await reviewSettled;
    },
    async clearStatusTracker() {
      await activeStatusTracker?.clear({ immediate: true });
      activeStatusTracker = undefined;
    },
    resetForShutdown() {
      agentRunActive = false;
      reviewerQuestionPausePending = false;
      backgroundMonitorGeneration += 1;
      backgroundReviewDeferred = false;
      pendingNativeCompletionRevision = undefined;
      orchestratorBackgroundReadiness.clear();
      unsubscribeBackgroundLifecycle?.();
      unsubscribeBackgroundLifecycle = undefined;
      releaseReviewerQuestionPauseWaiters();
    },
  };
}

async function transmitReviewPass(input: {
  state: ReviewGateState;
  output: ReviewRunOutput;
  source: "automatic" | "manual";
  disposition: "sent_for_correction" | "sent_for_observation" | "sent_at_cap" | "sent_review_error";
  action: ReviewTransmissionAction;
}): Promise<string> {
  const message = await createReviewTransmissionMessage({
    invocationDir: input.output.invocationDir!,
    reviewSequence: input.output.reviewSequence!,
    gateVerdict: input.output.result!.verdict,
    reviewerResults: input.output.reviewerResults!,
    bundleDir: input.output.bundleDir!,
    action: input.action,
  });
  recordReviewerFeedbackAndArmExchange(input.state, {
    result: input.output.result!,
    reviewerResults: input.output.reviewerResults,
    reviewSequence: input.output.reviewSequence,
    source: input.source,
    disposition: input.disposition,
    reviewedBaseline: input.output.reviewedBaseline!,
    displayLabels: input.output.reviewerDisplayLabels,
  });
  return message;
}
