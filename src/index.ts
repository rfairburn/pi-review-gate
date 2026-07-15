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
    });
    let output: ReviewRunOutput;
    try {
      output = await runReview({
        cwd: currentCwd,
        request: buildRequestContext(state),
        before: window.baseline,
        config,
        evidence: window.evidence,
        actingUsage,
        signal: reviewAbort.signal,
        notify: (message) => sendNotice(noticeTarget, message),
      });
    } catch (error) {
      pauseReviewWindow(state, "paused");
      await releaseQueuedUserInputs(pi, state);
      throw error;
    } finally {
      reviewAbort.cleanup();
    }

    if (!output.changed) {
      closeReviewWindow(state, true);
      await releaseQueuedUserInputs(pi, state);
      return;
    }

    if (output.result?.error === "aborted") {
      reviewAbort.notifyCancellation();
      state.reviewInProgress = false;
      state.queuedUserInputsDuringReview.splice(0);
      return;
    }

    if (output.result?.verdict === "pass") {
      await sendNotice(noticeTarget, withReviewDetails(`review gate: passed (${formatTokenUsage(output.result.usage)})`, output));
      closeReviewWindow(state);
      await releaseQueuedUserInputs(pi, state);
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
        await sendNotice(
          noticeTarget,
          [
            `review gate: repeated changes requested with no new correction evidence (${formatTokenUsage(output.result.usage)})`,
            ...reviewDetailsLines(output),
            "Reviewer feedback matched the previous blocking feedback, and the correction turn produced no new tool evidence or file-change fingerprint.",
            "Stopping automatic correction to avoid a loop.",
            "",
            output.followUpMessage,
          ].join("\n"),
        );
        pauseReviewWindow(state, "paused");
        await releaseQueuedUserInputs(pi, state);
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
        await sendNotice(
          noticeTarget,
          [
            `review gate: changes requested, automatic correction cap reached (${formatTokenUsage(output.result.usage)})`,
            ...reviewDetailsLines(output),
            "Reviewer feedback was not sent to the primary model.",
            `Use /review-continue to send this feedback and allow another ${config.maxCorrectionCycles} automatic correction cycle(s).`,
            "",
            output.followUpMessage,
          ].join("\n"),
        );
        await releaseQueuedUserInputs(pi, state);
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
      await sendNotice(noticeTarget, withReviewDetails(`review gate: changes requested (${formatTokenUsage(output.result.usage)})`, output));
      await sendFollowUp(pi, output.followUpMessage);
      await releaseQueuedUserInputs(pi, state);
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
    await sendNotice(noticeTarget, withReviewDetails(failed, output));
    pauseReviewWindow(state, "paused");
    await releaseQueuedUserInputs(pi, state);
  });

  registerCommands({
    pi,
    cwd: () => currentCwd,
    config,
    state,
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

async function releaseQueuedUserInputs(pi: unknown, state: ReviewGateState): Promise<void> {
  state.reviewInProgress = false;
  const queuedInputs = state.queuedUserInputsDuringReview.splice(0);
  for (const input of queuedInputs) {
    rememberUserRequest(state, input);
    await sendFollowUp(pi, input);
  }
}

function createReviewAbortController(input: {
  signal: AbortSignal | undefined;
  noticeTarget: unknown;
  state: ReviewGateState;
}): { signal: AbortSignal; cleanup: () => void; notifyCancellation: () => void } {
  const controller = new AbortController();
  let cancellationNoticeSent = false;

  const abortReview = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  const notifyCancellation = () => {
    if (cancellationNoticeSent) {
      return;
    }
    cancellationNoticeSent = true;
    void sendNotice(input.noticeTarget, "review gate: review cancelled");
  };

  if (input.signal?.aborted) {
    abortReview();
  }
  input.signal?.addEventListener("abort", abortReview, { once: true });

  const unsubscribeTerminalInput = onTerminalInput(input.noticeTarget, (terminalInput) => {
    if (!input.state.reviewInProgress || !isEscapeTerminalInput(terminalInput)) {
      return undefined;
    }
    abortReview();
    notifyCancellation();
    return { action: "handled", consume: true };
  });

  return {
    signal: controller.signal,
    cleanup: () => {
      input.signal?.removeEventListener("abort", abortReview);
      unsubscribeTerminalInput?.();
    },
    notifyCancellation,
  };
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
