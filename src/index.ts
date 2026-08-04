import { loadConfig } from "./config";
import { removeTransientWindowBundle } from "./bundle";
import { createWorkspaceSnapshot } from "./capture";
import { registerCommands } from "./commands";
import { createCorrectionFeedbackMarker, isRepeatedNoProgressFeedback } from "./correction-feedback";
import { recordToolCallEvidence, recordToolResultEvidence, rememberFinalAssistantSummary } from "./evidence";
import { registerHook, extractContext, extractCwd, extractInputSource, extractInputText, extractSignal, extractToolArgs, extractToolName, onTerminalInput, sendFollowUp, sendNotice, sendSteeringPrompt } from "./pi";
import { collectPausedReviewExchange, runReview, type ReviewRunOutput } from "./review";
import {
  activeExchangeHasBaseline,
  armReviewResponseExchange,
  beginAgentRun,
  buildRequestContext,
  closeReviewWindow,
  createState,
  getCorrectionAttemptCount,
  pauseReviewWindow,
  recordReviewerFeedback,
  rememberUserRequest,
  setReviewWindowBaseline,
  type ReviewGateState,
} from "./state";
import { extractPiUsageFromMessages, formatTokenUsage } from "./usage";
import { buildReviewAuthorizationMessage, buildReviewTransmission, writeReviewDeliveryReceipt, writeReviewTransmission, type ReviewTransmissionAction } from "./transmission";

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
  if (!config.enabled) {
    if (loaded.disabledReason) {
      await sendNotice(pi, `review gate: disabled (${loaded.disabledReason})`);
    }
    return;
  }

  const state = createState();
  let currentCwd = process.cwd();
  let sessionActive = true;
  let activeReviewAbort: ReviewAbortHandle | undefined;
  let agentRunActive = false;
  let reviewerQuestionPausePending = false;
  const reviewerQuestionPauseWaiters = new Set<() => void>();
  const sessionAbortController = new AbortController();

  const releaseReviewerQuestionPauseWaiters = () => {
    for (const resolve of reviewerQuestionPauseWaiters) {
      resolve();
    }
    reviewerQuestionPauseWaiters.clear();
  };

  registerHook(pi, "session_shutdown", async () => {
    sessionActive = false;
    sessionAbortController.abort();
    const reviewWasActive = Boolean(activeReviewAbort);
    activeReviewAbort?.shutdown();
    activeReviewAbort = undefined;
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
  });

  registerHook(pi, "before_agent_start", async (...args) => {
    agentRunActive = true;
    currentCwd = extractCwd(args, currentCwd);
    beginAgentRun(state);
    if (activeExchangeHasBaseline(state)) {
      return;
    }
    const baseline = await createWorkspaceSnapshot(currentCwd, {
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
    });
    setReviewWindowBaseline(state, baseline);
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
            config,
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
    if (signal?.aborted) {
      state.reviewInProgress = false;
      state.queuedUserInputsDuringReview = [];
      return;
    }
    if (state.reviewsPaused) {
      await collectPausedReviewExchange({
        cwd: currentCwd,
        config,
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
    let output: ReviewRunOutput;
    try {
      output = await runReview({
        cwd: currentCwd,
        request: buildRequestContext(state),
        before: window.baseline,
        config,
        evidence: window.evidence,
        correctionAttemptCount: getCorrectionAttemptCount(window),
        actingUsage,
        window,
        signal: reviewAbort.signal,
        notify: (message) => sendNoticeWhileSessionActive(noticeTarget, message, () => sessionActive),
      });
    } catch (error) {
      if (!sessionActive) {
        return;
      }
      pauseReviewWindow(state, "paused");
      await releaseQueuedUserInputs(pi, state, () => sessionActive);
      throw error;
    } finally {
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
        pauseReviewWindow(state, "paused");
        await releaseQueuedUserInputs(pi, state, () => sessionActive);
        return;
      }
      closeReviewWindow(state, true);
      await releaseQueuedUserInputs(pi, state, () => sessionActive);
      return;
    }

    if (output.result?.error === "aborted") {
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
        `review gate: passed (${formatTokenUsage(output.result.usage)})`,
        () => sessionActive,
      );
      if (sessionActive) {
        if (await sendFollowUp(pi, transmission)) {
          await writeReviewDeliveryReceipt(output.invocationDir!, "passed", transmission);
        }
      }
      await releaseQueuedUserInputs(pi, state, () => sessionActive);
      return;
    }

    if (output.result?.verdict === "needs_changes" && output.followUpMessage) {
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
        pauseReviewWindow(state, "paused");
        if (sessionActive) {
          if (await sendFollowUp(pi, transmission)) {
            await writeReviewDeliveryReceipt(output.invocationDir!, "deferred", transmission);
          }
        }
        await releaseQueuedUserInputs(pi, state, () => sessionActive);
        return;
      }

      window.lastCorrectionFeedback = createCorrectionFeedbackMarker({
        result: output.result,
        changes: output.changes,
        evidenceEventCount: window.evidence.events.length,
      });
      if (window.correctionCycles >= config.maxCorrectionCycles) {
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
        pauseReviewWindow(state, "paused_at_cap");
        await sendNoticeWhileSessionActive(
          noticeTarget,
          [
            `review gate: changes requested, automatic correction cap reached (${formatTokenUsage(output.result.usage)})`,
            "Complete reviewer feedback was transmitted to the implementing model, but automatic correction is deferred.",
            `Use /review-continue to authorize another ${config.maxCorrectionCycles} automatic correction cycle(s).`,
          ].join("\n"),
          () => sessionActive,
        );
        if (sessionActive) {
          if (await sendFollowUp(pi, deferredTransmission)) {
            await writeReviewDeliveryReceipt(output.invocationDir!, "deferred", deferredTransmission);
          }
        }
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
      if (sessionActive) {
        if (await sendFollowUp(pi, transmission)) {
          await writeReviewDeliveryReceipt(output.invocationDir!, "correction_required", transmission);
        }
      }
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
      if (sessionActive) {
        if (await sendFollowUp(pi, transmission)) {
          await writeReviewDeliveryReceipt(output.invocationDir!, "review_error", transmission);
        }
      }
    }
    await sendNoticeWhileSessionActive(noticeTarget, failed, () => sessionActive);
    pauseReviewWindow(state, "paused");
    await releaseQueuedUserInputs(pi, state, () => sessionActive);
  });

  registerCommands({
    pi,
    cwd: () => currentCwd,
    config,
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
}

async function transmitReviewPass(input: {
  state: ReviewGateState;
  output: ReviewRunOutput;
  source: "automatic" | "manual";
  disposition: "sent_for_correction" | "sent_for_observation" | "sent_at_cap" | "sent_review_error";
  action: ReviewTransmissionAction;
}): Promise<string> {
  const transmission = buildReviewTransmission({
    reviewSequence: input.output.reviewSequence!,
    gateVerdict: input.output.result!.verdict,
    reviewerResults: input.output.reviewerResults!,
    bundleDir: input.output.bundleDir!,
    action: input.action,
  });
  const message = transmission.message;
  await writeReviewTransmission(input.output.invocationDir!, transmission);
  recordReviewerFeedback(input.state, {
    result: input.output.result!,
    reviewerResults: input.output.reviewerResults,
    reviewSequence: input.output.reviewSequence,
    source: input.source,
    disposition: input.disposition,
  });
  armReviewResponseExchange(input.state, input.output.reviewedSnapshot!);
  return message;
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

function isEscapeTerminalInput(input: unknown): boolean {
  if (input === "\x1b" || input === "Escape" || input === "escape") {
    return true;
  }
  if (!isRecord(input)) {
    return false;
  }
  if (input.name === "escape" || input.key === "Escape" || input.key === "escape") {
    return true;
  }
  if (isRecord(input.key) && input.key.name === "escape") {
    return true;
  }
  return input.sequence === "\x1b";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
