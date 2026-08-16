import { loadConfig, materializeReviewConfig } from "./config";
import { removeTransientWindowBundle } from "./bundle";
import { createWorkspaceSnapshot } from "./capture";
import { registerCommands } from "./commands";
import { createCorrectionFeedbackMarker, isRepeatedNoProgressFeedback } from "./correction-feedback";
import { recordToolCallEvidence, recordToolResultEvidence, rememberFinalAssistantSummary } from "./evidence";
import { registerHook, extractContext, extractCwd, extractInputSource, extractInputText, extractSignal, extractToolArgs, extractToolName, isEscapeTerminalInput, onTerminalInput, sendFollowUp, sendNotice, sendSteeringPrompt, createStatusTracker, setStatus } from "./pi";
import { collectPausedReviewExchange, runReview, type ReviewRunOutput } from "./review";
import {
  activeExchangeHasBaseline,
  beginAgentRun,
  buildRequestContext,
  closeReviewWindow,
  createState,
  freezeReviewWindowConfig,
  getCorrectionAttemptCount,
  recordReviewerFeedbackAndArmExchange,
  rememberUserRequest,
  setReviewWindowBaseline,
  type ReviewGateState,
} from "./state";
import { registerReviewSettings } from "./settings/command";
import { scopedModelChoices } from "./settings/models";
import { ExecutionToolManager } from "./execution/tool";
import { extractPiUsageFromMessages, formatTokenUsage } from "./usage";
import { buildReviewAuthorizationMessage, createReviewTransmissionMessage, deliverReviewTransmission, hasReviewDeliveryReceipt, type ReviewTransmissionAction } from "./transmission";
import { dispatchModelDelivery, queueModelDelivery } from "./durable-delivery";
import { configDigest, replaceReviewGateState, sessionPersistenceIdentity, SessionStateStore } from "./session-state";

declare const module: {
  exports: unknown;
};

export async function activate(pi: unknown): Promise<void> {
  let loaded;
  try {
    loaded = loadConfig();
  } catch (error) {
    await sendNotice(pi, `review gate: config error: ${error instanceof Error ? error.message : "unknown error"}`);
    return;
  }

  const { config } = loaded;
  if (loaded.globallyDisabled) {
    await sendNotice(pi, `review gate: disabled (${loaded.disabledReason ?? "environment kill switch"})`);
    return;
  }

  const state = createState();
  let currentCwd = process.cwd();
  let currentScopedModels: string[] = [];
  let sessionActive = true;
  let activeReviewAbort: ReviewAbortHandle | undefined;
  let activeStatusTracker: ReturnType<typeof createStatusTracker> | undefined;
  let agentRunActive = false;
  let reviewerQuestionPausePending = false;
  let stateStore: SessionStateStore | undefined;
  const reviewerQuestionPauseWaiters = new Set<() => void>();
  const sessionAbortController = new AbortController();
  const executionTools = new ExecutionToolManager({
    pi,
    config,
    state,
    cwd: () => currentCwd,
    notify: (message) => sendNotice(pi, message),
    onAssociationsChanged: () => persistSessionState(),
  });

  const effectiveReviewConfig = () => {
    if (state.reviewWindow && !state.reviewWindow.reviewConfig) {
      freezeReviewWindowConfig(state, config, currentScopedModels);
    }
    return state.reviewWindow?.reviewConfig
      ?? state.lastQuestionWindow?.reviewConfig
      ?? materializeReviewConfig(config, currentScopedModels);
  };
  const persistSessionState = async (force = false) => {
    if (!stateStore || (!sessionActive && !force)) return;
    await stateStore.save(state, executionTools.associations(), effectiveReviewConfig());
  };

  const releaseReviewerQuestionPauseWaiters = () => {
    for (const resolve of reviewerQuestionPauseWaiters) {
      resolve();
    }
    reviewerQuestionPauseWaiters.clear();
  };

  registerHook(pi, "session_shutdown", async (...args) => {
    sessionActive = false;
    setStatus(extractContext(args) ?? pi, "review-gate", undefined);
    sessionAbortController.abort();
    activeReviewAbort?.shutdown();
    activeReviewAbort = undefined;
    await activeStatusTracker?.clear({ immediate: true });
    activeStatusTracker = undefined;
    agentRunActive = false;
    reviewerQuestionPausePending = false;
    releaseReviewerQuestionPauseWaiters();
    await persistSessionState(true);
    await stateStore?.drain();
    await executionTools.restoreAssociations({ waveRoots: [], bundles: [] });
    discardSessionState(state);
  });

  registerHook(pi, "session_start", async (...args) => {
    sessionActive = true;
    currentCwd = extractCwd(args, currentCwd);
    updateScopedModels(args);
    discardSessionState(state);
    await executionTools.restoreAssociations({ waveRoots: [], bundles: [] });
    const context = extractContext(args);
    const identity = sessionPersistenceIdentity(context, currentCwd);
    const appendEntry = typeof pi === "object" && pi !== null && "appendEntry" in pi && typeof pi.appendEntry === "function"
      ? pi.appendEntry.bind(pi) as (customType: string, data: unknown) => void
      : undefined;
    stateStore = identity && appendEntry
      ? new SessionStateStore(identity, appendEntry)
      : identity ? new SessionStateStore(identity) : undefined;
    let restoredRevision: number | undefined;
    if (stateStore) {
      try {
        const restored = await stateStore.restore(currentCwd);
        if (restored) {
          replaceReviewGateState(state, restored.state);
          await executionTools.restoreAssociations(restored.execution);
          if (state.reviewWindow) freezeReviewWindowConfig(state, config, currentScopedModels);
          const restoredConfig = state.reviewWindow?.reviewConfig ?? state.lastQuestionWindow?.reviewConfig;
          if (restored.reviewConfigDigest && restoredConfig && restored.reviewConfigDigest !== configDigest(restoredConfig)) {
            const message = "Persisted review state used a different reviewer configuration; clear or reconcile the review window before continuing.";
            if (state.reviewWindow) state.reviewWindow.reviewConfigurationError = message;
            if (state.lastQuestionWindow) state.lastQuestionWindow.reviewConfigurationError = message;
          }
          restoredRevision = restored.revision;
        } else {
          await executionTools.restoreAssociations({ waveRoots: [], bundles: [] });
        }
      } catch (error) {
        await sendNotice(context ?? pi, `review gate: persisted conversation state was not restored: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    executionTools.sync();
    if (restoredRevision !== undefined) {
      await recoverPendingModelDeliveries({
        pi,
        state,
        persist: () => persistSessionState(),
        isSessionActive: () => sessionActive,
        notify: (message) => sendNotice(context ?? pi, message),
      });
      await sendNotice(context ?? pi, `review gate: restored conversation state revision ${restoredRevision}`);
    }
    await persistSessionState();
    await sendNotice(extractContext(args) ?? pi, `review gate: loaded (${loaded.path ?? "no config path"})`);
  });

  registerHook(pi, "input", async (...args) => {
    currentCwd = extractCwd(args, currentCwd);
    if (extractInputSource(args) === "extension") {
      return;
    }
    const text = extractInputText(args);
    if (state.reviewInProgress && text.trim()) {
      const queued = text.trim();
      state.queuedUserInputsDuringReview.push(queued);
      const deliverySequence = state.pendingModelDeliveries.filter((delivery) => delivery.kind === "queued_user_input").length + 1;
      queueModelDelivery(state, {
        deliveryId: `queued-user-input:${state.reviewWindow?.id ?? "window"}:${deliverySequence}`,
        kind: "queued_user_input",
        channel: "follow_up",
        message: queued,
      });
      await persistSessionState();
      return { action: "handled" };
    }
    const expiredQuestionWindow = state.reviewWindow ? undefined : state.lastQuestionWindow;
    rememberUserRequest(state, text);
    await removeTransientWindowBundle(expiredQuestionWindow);
    await persistSessionState();
    return undefined;
  });

  registerHook(pi, "before_agent_start", async (...args) => {
    agentRunActive = true;
    currentCwd = extractCwd(args, currentCwd);
    updateScopedModels(args);
    beginAgentRun(state);
    if (activeExchangeHasBaseline(state)) {
      return;
    }
    const baseline = await createWorkspaceSnapshot(currentCwd, {
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
    });
    setReviewWindowBaseline(state, baseline);
    freezeReviewWindowConfig(state, config, currentScopedModels);
    await persistSessionState();
  });

  registerHook(pi, "tool_call", async (...args) => {
    const name = extractToolName(args);
    const toolArgs = extractToolArgs(args);
    const window = state.reviewWindow;
    if (!window) {
      return;
    }
    await recordToolCallEvidence({
      state: window.evidence,
      cwd: currentCwd,
      toolName: name,
      toolInput: toolArgs,
      snapshotOptions: {
        maxFileBytes: config.maxFileBytes,
        maxSnapshotBytes: config.maxSnapshotBytes,
      },
      exchangeSequence: window.activeExchange?.sequence,
    });
    await persistSessionState();
  });

  registerHook(pi, "tool_result", async (...args) => {
    const name = extractToolName(args);
    const toolArgs = extractToolArgs(args);
    const window = state.reviewWindow;
    if (!window) {
      return;
    }
    recordToolResultEvidence({
      state: window.evidence,
      toolName: name,
      toolInput: toolArgs,
      result: args[0],
      isError: isToolError(args[0]),
      exchangeSequence: window.activeExchange?.sequence,
    });
    await persistSessionState();
  });

  registerHook(pi, "agent_end", async (...args) => {
    try {
    agentRunActive = false;
    currentCwd = extractCwd(args, currentCwd);
    const noticeTarget = extractContext(args) ?? pi;
    const signal = extractSignal(args);
    const window = state.reviewWindow;
    const pauseForReviewerQuestion = reviewerQuestionPausePending;
    reviewerQuestionPausePending = false;
    if (!window) {
      if (pauseForReviewerQuestion) {
        releaseReviewerQuestionPauseWaiters();
      }
      return;
    }
    rememberFinalAssistantSummary(window.evidence, args);
    const actingUsage = extractPiUsageFromMessages(args);
    if (pauseForReviewerQuestion) {
      try {
        if (window.baseline && !signal?.aborted) {
          await collectPausedReviewExchange({
            cwd: currentCwd,
            config: window.reviewConfig ?? config,
            evidence: window.evidence,
            actingUsage,
            window,
          });
        }
      } finally {
        releaseReviewerQuestionPauseWaiters();
      }
      return;
    }
    if (!window.baseline) {
      closeReviewWindow(state);
      return;
    }
    const reviewConfig = window.reviewConfig ?? freezeReviewWindowConfig(state, config, currentScopedModels);
    if (window.reviewConfigurationError) {
      await sendNoticeWhileSessionActive(
        noticeTarget,
        `review gate: reviewer selection error: ${window.reviewConfigurationError}; use /review-settings`,
        () => sessionActive,
      );
      closeReviewWindow(state);
      return;
    }
    if (!reviewConfig.enabled) {
      closeReviewWindow(state, true);
      return;
    }
    if (signal?.aborted) {
      state.reviewInProgress = false;
      state.queuedUserInputsDuringReview = [];
      return;
    }
    if (state.reviewsPaused) {
      await collectPausedReviewExchange({
        cwd: currentCwd,
        config: reviewConfig,
        evidence: window.evidence,
        actingUsage,
        window,
      });
      return;
    }

    state.reviewInProgress = true;
    await persistSessionState();
    const reviewAbort = createReviewAbortController({
      signal,
      noticeTarget,
      state,
      isSessionActive: () => sessionActive,
    });
    activeReviewAbort = reviewAbort;
    const statusTracker = createStatusTracker(noticeTarget, "review-gate", "reviewing changes");
    activeStatusTracker = statusTracker;
    let output: ReviewRunOutput;
    try {
      output = await runReview({
        cwd: currentCwd,
        request: buildRequestContext(state, state.reviewWindow, { priorFeedback: "latest" }),
        before: window.baseline,
        config: reviewConfig,
        evidence: window.evidence,
        correctionAttemptCount: getCorrectionAttemptCount(window),
        actingUsage,
        window,
        signal: reviewAbort.signal,
        notify: (message) => sendNoticeWhileSessionActive(noticeTarget, message, () => sessionActive),
        onUpdate: (message) => statusTracker.update(message),
        onInvocationPrepared: persistSessionState,
      });
    } catch (error) {
      if (!sessionActive) {
        return;
      }
      await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
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
      // A resumed conversation may need the active review artifacts.
    }

    if (!sessionActive) {
      return;
    }

    if (!output.changed) {
      if (output.noReviewReason === "unchanged_deferred_response") {
        await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
        return;
      }
      closeReviewWindow(state, true);
      await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
      return;
    }

    if (reviewAbort.signal.aborted || output.result?.error === "aborted") {
      if (reviewAbort.getReason() === "escape") {
        await reviewAbort.notifyCancellation();
      }
      state.reviewInProgress = false;
      for (const delivery of state.pendingModelDeliveries) {
        if (delivery.kind === "queued_user_input" && delivery.status === "queued") {
          delivery.status = "cancelled";
          delivery.diagnostic = "The review was explicitly cancelled before this queued input was released.";
        }
      }
      state.queuedUserInputsDuringReview.splice(0);
      return;
    }

    if (output.result?.verdict === "pass") {
      const transmission = await transmitReviewPass({
        state,
        output,
        source: "automatic",
        disposition: "sent_for_observation",
        action: "passed",
      });
      await sendNoticeWhileSessionActive(
        noticeTarget,
        `review gate: ${output.result.error === "partial_reviewer_error" ? "passed with reviewer warnings" : "passed"} (${formatTokenUsage(output.result.usage)})`,
        () => sessionActive,
      );
      await deliverAutomaticTransmission(pi, state, output, "passed", transmission, () => sessionActive, persistSessionState);
      await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
      return;
    }

    if (output.result?.verdict === "needs_changes") {
      if (isRepeatedNoProgressFeedback({
        previous: window.lastCorrectionFeedback,
        result: output.result,
        changes: output.changes,
        evidenceEventCount: window.evidence.events.length,
      })) {
        const transmission = await transmitReviewPass({
          state,
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
          () => sessionActive,
        );
        await deliverAutomaticTransmission(pi, state, output, "deferred", transmission, () => sessionActive, persistSessionState);
        await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
        return;
      }

      window.lastCorrectionFeedback = createCorrectionFeedbackMarker({
        result: output.result,
        changes: output.changes,
        evidenceEventCount: window.evidence.events.length,
      });
      if (window.correctionCycles >= reviewConfig.maxCorrectionCycles) {
        const deferredTransmission = await transmitReviewPass({
          state,
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
          () => sessionActive,
        );
        await deliverAutomaticTransmission(pi, state, output, "deferred", deferredTransmission, () => sessionActive, persistSessionState);
        await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
        return;
      }
      window.lastCappedFollowUp = undefined;
      window.correctionCycles += 1;
      const transmission = await transmitReviewPass({
        state,
        output,
        source: "automatic",
        disposition: "sent_for_correction",
        action: "correction_required",
      });
      await sendNoticeWhileSessionActive(
        noticeTarget,
        `review gate: changes requested (${formatTokenUsage(output.result.usage)})`,
        () => sessionActive,
      );
      await deliverAutomaticTransmission(pi, state, output, "correction_required", transmission, () => sessionActive, persistSessionState);
      await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
      return;
    }

    const failed = `review gate: reviewer failed (${formatTokenUsage(output.result?.usage)})`;
    if (output.result) {
      const transmission = await transmitReviewPass({
        state,
        output,
        source: "automatic",
        disposition: "sent_review_error",
        action: "review_error",
      });
      await deliverAutomaticTransmission(pi, state, output, "review_error", transmission, () => sessionActive, persistSessionState);
    }
    await sendNoticeWhileSessionActive(noticeTarget, failed, () => sessionActive);
    await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
    } finally {
      await persistSessionState();
    }
  });

  registerCommands({
    pi,
    cwd: () => currentCwd,
    config,
    getConfig: () => materializeReviewConfig(config, currentScopedModels),
    state,
    isSessionActive: () => sessionActive,
    sessionSignal: sessionAbortController.signal,
    onStateChanged: persistSessionState,
    releaseQueuedUserInputs: () => releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState),
    prepareReviewerQuestion: async (commandName, ctx) => {
      if (!agentRunActive && commandContextIsIdle(ctx)) {
        return;
      }

      reviewerQuestionPausePending = true;
      const paused = new Promise<void>((resolve) => reviewerQuestionPauseWaiters.add(resolve));
      const delivered = await sendSteeringPrompt(
        pi,
        [
          `Reviewer consultation requested by /${commandName}.`,
          "Pause implementation at this steering boundary. Do not call any more tools or modify files after receiving this message.",
          "End this turn so the reviewer can inspect a stable workspace; its response will be provided next.",
        ].join(" "),
      );
      if (!delivered) {
        reviewerQuestionPausePending = false;
        releaseReviewerQuestionPauseWaiters();
        throw new Error("review gate: cannot pause the active turn because sendUserMessage is unavailable");
      }
      await paused;
    },
  });

  registerReviewSettings({
    pi,
    config,
    configPath: loaded.path,
    onSaved: () => executionTools.sync(),
    onScopedModels: (models) => {
      currentScopedModels = [...models];
    },
  });

  function updateScopedModels(args: unknown[]): void {
    const choices = scopedModelChoices(extractContext(args) ?? args.find((arg) => scopedModelChoices(arg) !== undefined));
    if (choices) currentScopedModels = choices.map((choice) => choice.model);
  }
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
    reviewerDisplayLabels: input.output.reviewerDisplayLabels,
    bundleDir: input.output.bundleDir!,
    action: input.action,
  });
  recordReviewerFeedbackAndArmExchange(input.state, {
    result: input.output.result!,
    reviewerResults: input.output.reviewerResults,
    reviewSequence: input.output.reviewSequence,
    source: input.source,
    disposition: input.disposition,
    reviewedSnapshot: input.output.reviewedSnapshot!,
  });
  return message;
}

async function deliverAutomaticTransmission(
  pi: unknown,
  state: ReviewGateState,
  output: ReviewRunOutput,
  action: ReviewTransmissionAction,
  message: string,
  isSessionActive: () => boolean,
  persist: () => void | Promise<void>,
): Promise<void> {
  if (!output.invocationDir) return;
  const delivery = queueModelDelivery(state, {
    kind: "review_transmission",
    channel: "follow_up",
    invocationDir: output.invocationDir,
    action,
    message,
  });
  await persist();
  if (!isSessionActive()) return;
  await dispatchModelDelivery({
    delivery,
    persist,
    deliver: () => deliverReviewTransmission({
      invocationDir: output.invocationDir!,
      action,
      message,
      idempotencyKey: delivery.deliveryId,
      deliver: () => isSessionActive() ? sendFollowUp(pi, message) : Promise.resolve(false),
    }),
  });
}

async function recoverPendingModelDeliveries(input: {
  pi: unknown;
  state: ReviewGateState;
  persist: () => void | Promise<void>;
  isSessionActive: () => boolean;
  notify: (message: string) => void | Promise<void>;
}): Promise<void> {
  for (const delivery of input.state.pendingModelDeliveries) {
    if (delivery.status === "delivered" || delivery.status === "cancelled") continue;
    if (delivery.kind === "queued_user_input") continue;
    if (delivery.invocationDir && await hasReviewDeliveryReceipt(delivery.invocationDir, delivery.deliveryId)) {
      delivery.status = "delivered";
      delivery.deliveredAt ??= new Date().toISOString();
      delivery.diagnostic = undefined;
      await input.persist();
      continue;
    }
    if (delivery.status === "dispatching" || delivery.status === "uncertain") {
      delivery.status = "uncertain";
      delivery.diagnostic ??= "The prior application ended after dispatch began but before a durable acknowledgement was found.";
      await input.persist();
      await input.notify(`review gate: delivery ${delivery.deliveryId} is uncertain and was not duplicated automatically; inspect ${delivery.invocationDir ?? "the resumed session"}`);
      continue;
    }
    if (!input.isSessionActive()) return;
    try {
      await dispatchModelDelivery({
        delivery,
        persist: input.persist,
        deliver: () => delivery.invocationDir && delivery.action
          ? deliverReviewTransmission({
              invocationDir: delivery.invocationDir,
              action: delivery.action,
              message: delivery.message,
              idempotencyKey: delivery.deliveryId,
              deliver: () => delivery.channel === "steer"
                ? sendSteeringPrompt(input.pi, delivery.message)
                : sendFollowUp(input.pi, delivery.message),
            })
          : delivery.channel === "steer"
            ? sendSteeringPrompt(input.pi, delivery.message)
            : sendFollowUp(input.pi, delivery.message),
      });
    } catch (error) {
      await input.notify(`review gate: pending delivery ${delivery.deliveryId} could not be recovered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (input.state.queuedUserInputsDuringReview.length > 0) {
    await input.notify(`review gate: ${input.state.queuedUserInputsDuringReview.length} user input(s) remain queued from an interrupted review and were not reordered automatically; use /review-now to finish the interrupted review and release them, or /review-clear to cancel them`);
  }
}

export default activate;

module.exports = activate;
Object.assign(module.exports as Record<string, unknown>, { activate });

function commandContextIsIdle(ctx: unknown): boolean {
  if (typeof ctx === "object" && ctx !== null && "isIdle" in ctx && typeof ctx.isIdle === "function") {
    return Boolean(ctx.isIdle());
  }
  return true;
}

function isToolError(value: unknown): boolean {
  return typeof value === "object" && value !== null && "isError" in value && Boolean((value as { isError?: unknown }).isError);
}

async function releaseQueuedUserInputs(
  pi: unknown,
  state: ReviewGateState,
  isSessionActive: () => boolean,
  persist: () => void | Promise<void>,
): Promise<void> {
  state.reviewInProgress = false;
  let queuedLegacyDelivery = false;
  const queuedOccurrences = new Map<string, number>();
  for (const message of state.queuedUserInputsDuringReview) {
    const occurrence = (queuedOccurrences.get(message) ?? 0) + 1;
    queuedOccurrences.set(message, occurrence);
    const existing = state.pendingModelDeliveries.filter((delivery) =>
      delivery.kind === "queued_user_input" && delivery.message === message && delivery.status !== "delivered").length;
    if (existing >= occurrence) continue;
    const sequence = state.pendingModelDeliveries.filter((delivery) => delivery.kind === "queued_user_input").length + 1;
    queueModelDelivery(state, {
      deliveryId: `queued-user-input:${state.reviewWindow?.id ?? "window"}:${sequence}`,
      kind: "queued_user_input",
      channel: "follow_up",
      message,
    });
    queuedLegacyDelivery = true;
  }
  if (queuedLegacyDelivery) await persist();
  for (const delivery of state.pendingModelDeliveries.filter((candidate) =>
    candidate.kind === "queued_user_input" && candidate.status !== "delivered" && candidate.status !== "cancelled")) {
    if (!isSessionActive()) return;
    rememberUserRequest(state, delivery.message);
    try {
      const delivered = await dispatchModelDelivery({
        delivery,
        persist,
        deliver: () => isSessionActive() ? sendFollowUp(pi, delivery.message) : Promise.resolve(false),
      });
      if (!delivered) return;
      const index = state.queuedUserInputsDuringReview.indexOf(delivery.message);
      if (index >= 0) state.queuedUserInputsDuringReview.splice(index, 1);
      await persist();
    } catch {
      return;
    }
  }
}

type ReviewAbortReason = "parent" | "escape" | "session_shutdown";

interface ReviewAbortHandle {
  signal: AbortSignal;
  cleanup: () => void;
  getReason: () => ReviewAbortReason | undefined;
  notifyCancellation: () => Promise<void>;
  shutdown: () => void;
}

function createReviewAbortController(input: {
  signal: AbortSignal | undefined;
  noticeTarget: unknown;
  state: ReviewGateState;
  isSessionActive: () => boolean;
}): ReviewAbortHandle {
  const controller = new AbortController();
  let abortReason: ReviewAbortReason | undefined;
  let cancellationNotice: Promise<void> | undefined;
  let cleanedUp = false;

  const abortReview = (reason: ReviewAbortReason) => {
    if (!controller.signal.aborted) {
      abortReason = reason;
      controller.abort(reason);
    }
  };
  const notifyCancellation = () => {
    if (!input.isSessionActive()) {
      return Promise.resolve();
    }
    if (!cancellationNotice) {
      cancellationNotice = sendNotice(input.noticeTarget, "review gate: review cancelled").catch(() => undefined);
    }
    return cancellationNotice;
  };
  const abortFromParent = () => abortReview("parent");

  if (input.signal?.aborted) {
    abortFromParent();
  }
  input.signal?.addEventListener("abort", abortFromParent, { once: true });

  const unsubscribeTerminalInput = onTerminalInput(input.noticeTarget, (terminalInput) => {
    if (!input.state.reviewInProgress || !isEscapeTerminalInput(terminalInput)) {
      return undefined;
    }
    abortReview("escape");
    void notifyCancellation();
    return { action: "handled", consume: true };
  });

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    input.signal?.removeEventListener("abort", abortFromParent);
    unsubscribeTerminalInput?.();
  };

  return {
    signal: controller.signal,
    cleanup,
    getReason: () => abortReason,
    notifyCancellation,
    shutdown: () => {
      abortReview("session_shutdown");
      cleanup();
    },
  };
}

async function sendNoticeWhileSessionActive(
  target: unknown,
  message: string,
  isSessionActive: () => boolean,
): Promise<void> {
  if (!isSessionActive()) {
    return;
  }
  await sendNotice(target, message);
}

function discardSessionState(state: ReviewGateState): void {
  replaceReviewGateState(state, createState());
}
