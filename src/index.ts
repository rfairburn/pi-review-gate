import { loadConfig } from "./config";
import { createWorkspaceSnapshot } from "./capture";
import { registerCommands } from "./commands";
import { createCorrectionFeedbackMarker, isRepeatedNoProgressFeedback } from "./correction-feedback";
import { recordToolCallEvidence, recordToolResultEvidence, rememberFinalAssistantSummary } from "./evidence";
import { registerHook, extractContext, extractCwd, extractInputSource, extractInputText, extractSignal, extractToolArgs, extractToolName, onTerminalInput, sendFollowUp, sendNotice } from "./pi";
import { buildReviewerResultsNotice } from "./prompts";
import { runReview, type ReviewRunOutput } from "./review";
import {
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
  const sessionAbortController = new AbortController();

  registerHook(pi, "session_shutdown", () => {
    sessionActive = false;
    sessionAbortController.abort();
    activeReviewAbort?.shutdown();
    activeReviewAbort = undefined;
    discardSessionState(state);
  });

  registerHook(pi, "session_start", async (...args) => {
    await sendNotice(extractContext(args) ?? pi, `review gate: loaded (${loaded.path ?? "no config path"})`);
  });

  registerHook(pi, "input", (...args) => {
    currentCwd = extractCwd(args, currentCwd);
    if (extractInputSource(args) === "extension") {
      return;
    }
    const text = extractInputText(args);
    if (state.reviewInProgress && text.trim()) {
      state.queuedUserInputsDuringReview.push(text.trim());
      return { action: "handled" };
    }
    rememberUserRequest(state, text);
  });

  registerHook(pi, "before_agent_start", async (...args) => {
    currentCwd = extractCwd(args, currentCwd);
    const runKind = beginAgentRun(state);
    if (runKind === "continuation") {
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
    });
  });

  registerHook(pi, "agent_end", async (...args) => {
    currentCwd = extractCwd(args, currentCwd);
    const noticeTarget = extractContext(args) ?? pi;
    const signal = extractSignal(args);
    const window = state.reviewWindow;
    if (!window) {
      return;
    }
    rememberFinalAssistantSummary(window.evidence, args);
    const actingUsage = extractPiUsageFromMessages(args);
    if (!window.baseline) {
      closeReviewWindow(state);
      return;
    }
    if (signal?.aborted) {
      state.reviewInProgress = false;
      state.queuedUserInputsDuringReview = [];
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
    }

    if (!sessionActive) {
      return;
    }

    if (!output.changed) {
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
      await sendNoticeWhileSessionActive(
        noticeTarget,
        withReviewDetails(`review gate: passed (${formatTokenUsage(output.result.usage)})`, output),
        () => sessionActive,
      );
      closeReviewWindow(state, true);
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
        recordReviewerFeedback(state, {
          result: output.result,
          source: "automatic",
          disposition: "reported_only",
          followUpMessage: output.followUpMessage,
        });
        await sendNoticeWhileSessionActive(
          noticeTarget,
          [
            `review gate: repeated changes requested with no new correction evidence (${formatTokenUsage(output.result.usage)})`,
            ...reviewDetailsLines(output),
            "Reviewer feedback matched the previous blocking feedback, and the correction turn produced no new tool evidence or file-change fingerprint.",
            "Stopping automatic correction to avoid a loop.",
            "",
            output.followUpMessage,
          ].join("\n"),
          () => sessionActive,
        );
        pauseReviewWindow(state, "paused");
        await releaseQueuedUserInputs(pi, state, () => sessionActive);
        return;
      }

      window.lastCorrectionFeedback = createCorrectionFeedbackMarker({
        result: output.result,
        changes: output.changes,
        evidenceEventCount: window.evidence.events.length,
      });
      if (window.correctionCycles >= config.maxCorrectionCycles) {
        window.lastCappedFollowUp = output.followUpMessage;
        recordReviewerFeedback(state, {
          result: output.result,
          source: "automatic",
          disposition: "held_at_cap",
          followUpMessage: output.followUpMessage,
        });
        pauseReviewWindow(state, "paused_at_cap");
        await sendNoticeWhileSessionActive(
          noticeTarget,
          [
            `review gate: changes requested, automatic correction cap reached (${formatTokenUsage(output.result.usage)})`,
            ...reviewDetailsLines(output),
            "Reviewer feedback was not sent to the primary model.",
            `Use /review-continue to send this feedback and allow another ${config.maxCorrectionCycles} automatic correction cycle(s).`,
            "",
            output.followUpMessage,
          ].join("\n"),
          () => sessionActive,
        );
        await releaseQueuedUserInputs(pi, state, () => sessionActive);
        return;
      }
      window.lastCappedFollowUp = undefined;
      window.correctionCycles += 1;
      recordReviewerFeedback(state, {
        result: output.result,
        source: "automatic",
        disposition: "sent_for_correction",
        followUpMessage: output.followUpMessage,
      });
      await sendNoticeWhileSessionActive(
        noticeTarget,
        withReviewDetails(`review gate: changes requested (${formatTokenUsage(output.result.usage)})`, output),
        () => sessionActive,
      );
      if (sessionActive) {
        await sendFollowUp(pi, output.followUpMessage);
      }
      await releaseQueuedUserInputs(pi, state, () => sessionActive);
      return;
    }

    const failed = `review gate: reviewer failed (${formatTokenUsage(output.result?.usage)})`;
    if (output.result) {
      recordReviewerFeedback(state, {
        result: output.result,
        source: "automatic",
        disposition: "reported_only",
      });
    }
    await sendNoticeWhileSessionActive(noticeTarget, withReviewDetails(failed, output), () => sessionActive);
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
  });
}

export default activate;

module.exports = activate;
Object.assign(module.exports as Record<string, unknown>, { activate });

function withReviewDetails(header: string, output: ReviewRunOutput): string {
  const [details] = reviewDetailsLines(output);
  return details ? `${header}\n${details}` : header;
}

function reviewDetailsLines(output: ReviewRunOutput): string[] {
  const details = buildReviewerResultsNotice(output.reviewerResults, output.bundleRetained ? output.bundleDir : undefined);
  return details ? [details] : [];
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
      controller.abort();
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
