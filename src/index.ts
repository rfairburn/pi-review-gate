import { loadConfig } from "./config";
import { createWorkspaceSnapshot } from "./capture";
import { registerCommands } from "./commands";
import { recordToolCallEvidence, recordToolResultEvidence, rememberFinalAssistantSummary } from "./evidence";
import { registerHook, extractContext, extractCwd, extractInputSource, extractInputText, extractToolArgs, extractToolName, sendFollowUp, sendNotice } from "./pi";
import { runReview } from "./review";
import { createState, recordTouchedPath, rememberUserRequest, resetRunEvidence } from "./state";
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
    rememberUserRequest(state, extractInputText(args));
  });

  registerHook(pi, "before_agent_start", async (...args) => {
    currentCwd = extractCwd(args, currentCwd);
    resetRunEvidence(state);
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
    rememberFinalAssistantSummary(state.evidence, args);
    const actingUsage = extractPiUsageFromMessages(args);
    if (!state.baseline) {
      return;
    }

    const output = await runReview({
      cwd: currentCwd,
      request: state.latestRequest || "No original request captured.",
      before: state.baseline,
      config,
      evidence: state.evidence,
      actingUsage,
      notify: (message) => sendNotice(noticeTarget, message),
    });

    if (!output.changed) {
      return;
    }

    if (output.result?.verdict === "pass") {
      await sendNotice(noticeTarget, `review gate: passed (${formatTokenUsage(output.result.usage)})`);
      return;
    }

    if (output.result?.verdict === "needs_changes" && output.followUpMessage) {
      if (state.correctionCycles >= config.maxCorrectionCycles) {
        await sendNotice(noticeTarget, `review gate: changes requested, automatic correction cap reached (${formatTokenUsage(output.result.usage)})`);
        return;
      }
      state.correctionCycles += 1;
      await sendNotice(noticeTarget, `review gate: changes requested (${formatTokenUsage(output.result.usage)})`);
      await sendFollowUp(pi, output.followUpMessage);
      return;
    }

    const failed = `review gate: reviewer failed (${formatTokenUsage(output.result?.usage)})`;
    await sendNotice(noticeTarget, output.bundleRetained ? `${failed}, bundle retained at ${output.bundleDir}` : failed);
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
