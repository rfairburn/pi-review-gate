import { loadConfig } from "./config";
import { createWorkspaceSnapshot } from "./capture";
import { registerCommands } from "./commands";
import { recordToolCallEvidence, recordToolResultEvidence, rememberFinalAssistantSummary } from "./evidence";
import { registerHook, extractContext, extractCwd, extractInputSource, extractInputText, extractSignal, extractToolArgs, extractToolName, onTerminalInput, sendFollowUp, sendNotice } from "./pi";
import { runReview, type ReviewRunOutput } from "./review";
import { beginAgentRun, buildRequestContext, createState, recordTouchedPath, rememberUserRequest, type ReviewGateState } from "./state";
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
    rememberUserRequest(state, text);
    if (state.reviewInProgress && text.trim()) {
      state.queuedUserInputsDuringReview.push(text.trim());
      return { action: "handled" };
    }
  });

  registerHook(pi, "before_agent_start", async (...args) => {
    currentCwd = extractCwd(args, currentCwd);
    const runKind = beginAgentRun(state);
    if (runKind === "continuation") {
      return;
    }
    state.baseline = await createWorkspaceSnapshot(currentCwd, {
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
    });
  });

  registerHook(pi, "tool_call", async (...args) => {
    const name = extractToolName(args);
    const toolArgs = extractToolArgs(args);
    await recordToolCallEvidence({
      state: state.evidence,
      cwd: currentCwd,
      toolName: name,
      toolInput: toolArgs,
      snapshotOptions: {
        maxFileBytes: config.maxFileBytes,
        maxSnapshotBytes: config.maxSnapshotBytes,
      },
    });
    if (["write", "Write", "edit", "Edit"].includes(name)) {
      recordTouchedPath(state, toolArgs?.path ?? toolArgs?.file_path ?? toolArgs?.filePath);
    }
  });

  registerHook(pi, "tool_result", (...args) => {
    const name = extractToolName(args);
    const toolArgs = extractToolArgs(args);
    recordToolResultEvidence({
      state: state.evidence,
      toolName: name,
      toolInput: toolArgs,
      result: args[0],
      isError: isToolError(args[0]),
    });
    if (["write", "Write", "edit", "Edit"].includes(name)) {
      recordTouchedPath(state, toolArgs?.path ?? toolArgs?.file_path ?? toolArgs?.filePath);
    }
  });

  registerHook(pi, "agent_end", async (...args) => {
    currentCwd = extractCwd(args, currentCwd);
    const noticeTarget = extractContext(args) ?? pi;
    const signal = extractSignal(args);
    rememberFinalAssistantSummary(state.evidence, args);
    const actingUsage = extractPiUsageFromMessages(args);
    if (!state.baseline) {
      state.runActive = false;
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
        before: state.baseline,
        config,
        evidence: state.evidence,
        actingUsage,
        signal: reviewAbort.signal,
        notify: (message) => sendNotice(noticeTarget, message),
      });
    } catch (error) {
      state.runActive = false;
      await releaseQueuedUserInputs(pi, state);
      throw error;
    } finally {
      reviewAbort.cleanup();
    }

    if (!output.changed) {
      state.runActive = false;
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
      await sendNotice(noticeTarget, `review gate: passed (${formatTokenUsage(output.result.usage)})`);
      state.runActive = false;
      await releaseQueuedUserInputs(pi, state);
      return;
    }

    if (output.result?.verdict === "needs_changes" && output.followUpMessage) {
      if (state.correctionCycles >= config.maxCorrectionCycles) {
        state.lastCappedFollowUp = output.followUpMessage;
        await sendNotice(
          noticeTarget,
          [
            `review gate: changes requested, automatic correction cap reached (${formatTokenUsage(output.result.usage)})`,
            "Reviewer feedback was not sent to the primary model.",
            `Use /review-continue to send this feedback and allow another ${config.maxCorrectionCycles} automatic correction cycle(s).`,
            "",
            output.followUpMessage,
          ].join("\n"),
        );
        state.runActive = false;
        await releaseQueuedUserInputs(pi, state);
        return;
      }
      state.lastCappedFollowUp = undefined;
      state.correctionCycles += 1;
      await sendNotice(noticeTarget, `review gate: changes requested (${formatTokenUsage(output.result.usage)})`);
      state.runActive = false;
      await sendFollowUp(pi, output.followUpMessage);
      await releaseQueuedUserInputs(pi, state);
      return;
    }

    const failed = `review gate: reviewer failed (${formatTokenUsage(output.result?.usage)})`;
    await sendNotice(noticeTarget, output.bundleRetained ? `${failed}, bundle retained at ${output.bundleDir}` : failed);
    state.runActive = false;
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

function isToolError(value: unknown): boolean {
  return typeof value === "object" && value !== null && "isError" in value && Boolean((value as { isError?: unknown }).isError);
}

async function releaseQueuedUserInputs(pi: unknown, state: ReviewGateState): Promise<void> {
  state.reviewInProgress = false;
  const queuedInputs = state.queuedUserInputsDuringReview.splice(0);
  for (const input of queuedInputs) {
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
