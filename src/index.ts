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
import { buildReviewAuthorizationMessage, createReviewTransmissionMessage, deliverReviewTransmission, type ReviewTransmissionAction } from "./transmission";

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
  const reviewerQuestionPauseWaiters = new Set<() => void>();
  const sessionAbortController = new AbortController();
  const executionTools = new ExecutionToolManager({
    pi,
    config,
    state,
    cwd: () => currentCwd,
    notify: (message) => sendNotice(pi, message),
  });

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
    const reviewWasActive = Boolean(activeReviewAbort);
    activeReviewAbort?.shutdown();
    activeReviewAbort = undefined;
    await activeStatusTracker?.clear({ immediate: true });
    activeStatusTracker = undefined;
    agentRunActive = false;
    reviewerQuestionPausePending = false;
    releaseReviewerQuestionPauseWaiters();
    const windows = [state.reviewWindow, state.lastQuestionWindow];
    discardSessionState(state);
    await Promise.all(windows.map((window, index) =>
      reviewWasActive && index === 0 ? Promise.resolve() : removeTransientWindowBundle(window)
    ));
  });

  registerHook(pi, "session_start", async (...args) => {
    updateScopedModels(args);
    executionTools.sync();
    await sendNotice(extractContext(args) ?? pi, `review gate: loaded (${loaded.path ?? "no config path"})`);
  });

  registerHook(pi, "input", async (...args) => {
    currentCwd = extractCwd(args, currentCwd);
    if (extractInputSource(args) === "extension") {
      return;
    }
    const text = extractInputText(args);
    if (state.reviewInProgress && text.trim()) {
      state.queuedUserInputsDuringReview.push(text.trim());
      return { action: "handled" };
    }
    const expiredQuestionWindow = state.reviewWindow ? undefined : state.lastQuestionWindow;
    rememberUserRequest(state, text);
    await removeTransientWindowBundle(expiredQuestionWindow);
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
  });

  registerHook(pi, "tool_result", (...args) => {
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
  });

  registerHook(pi, "agent_end", async (...args) => {
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
      });
    } catch (error) {
      if (!sessionActive) {
        return;
      }
      await releaseQueuedUserInputs(pi, state, () => sessionActive);
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
      if (!sessionActive) {
        await removeTransientWindowBundle(window);
      }
    }

    if (!sessionActive) {
      return;
    }

    if (!output.changed) {
      if (output.noReviewReason === "unchanged_deferred_response") {
        await releaseQueuedUserInputs(pi, state, () => sessionActive);
        return;
      }
      closeReviewWindow(state, true);
      await releaseQueuedUserInputs(pi, state, () => sessionActive);
      return;
    }

    if (reviewAbort.signal.aborted || output.result?.error === "aborted") {
      if (reviewAbort.getReason() === "escape") {
        await reviewAbort.notifyCancellation();
      }
      state.reviewInProgress = false;
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
      await deliverAutomaticTransmission(pi, output, "passed", transmission, () => sessionActive);
      await releaseQueuedUserInputs(pi, state, () => sessionActive);
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
        await deliverAutomaticTransmission(pi, output, "deferred", transmission, () => sessionActive);
        await releaseQueuedUserInputs(pi, state, () => sessionActive);
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
        await deliverAutomaticTransmission(pi, output, "deferred", deferredTransmission, () => sessionActive);
        await releaseQueuedUserInputs(pi, state, () => sessionActive);
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
      await deliverAutomaticTransmission(pi, output, "correction_required", transmission, () => sessionActive);
      await releaseQueuedUserInputs(pi, state, () => sessionActive);
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
      await deliverAutomaticTransmission(pi, output, "review_error", transmission, () => sessionActive);
    }
    await sendNoticeWhileSessionActive(noticeTarget, failed, () => sessionActive);
    await releaseQueuedUserInputs(pi, state, () => sessionActive);
  });

  registerCommands({
    pi,
    cwd: () => currentCwd,
    config,
    getConfig: () => materializeReviewConfig(config, currentScopedModels),
    state,
    isSessionActive: () => sessionActive,
    sessionSignal: sessionAbortController.signal,
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
  output: ReviewRunOutput,
  action: ReviewTransmissionAction,
  message: string,
  isSessionActive: () => boolean,
): Promise<void> {
  if (!output.invocationDir || !isSessionActive()) {
    return;
  }
  await deliverReviewTransmission({
    invocationDir: output.invocationDir,
    action,
    message,
    deliver: () => isSessionActive() ? sendFollowUp(pi, message) : Promise.resolve(false),
  });
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
): Promise<void> {
  state.reviewInProgress = false;
  const queuedInputs = state.queuedUserInputsDuringReview.splice(0);
  for (const input of queuedInputs) {
    if (!isSessionActive()) {
      return;
    }
    rememberUserRequest(state, input);
    await sendFollowUp(pi, input);
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
  state.reviewInProgress = false;
  state.queuedUserInputsDuringReview.splice(0);
  state.reviewWindow = undefined;
  state.lastQuestionWindow = undefined;
  state.pendingAcceptedReviewerQuestions.splice(0);
}
