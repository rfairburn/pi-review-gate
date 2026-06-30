import { loadConfig } from "./config";
import { createWorkspaceSnapshot } from "./capture";
import { registerCommands } from "./commands";
import { registerHook, extractCwd, extractInputText, extractToolArgs, extractToolName, sendFollowUp, sendNotice } from "./pi";
import { runReview } from "./review";
import { createState, recordTouchedPath, rememberUserRequest } from "./state";

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

  registerHook(pi, "input", (...args) => {
    currentCwd = extractCwd(args, currentCwd);
    rememberUserRequest(state, extractInputText(args));
  });

  registerHook(pi, "before_agent_start", async (...args) => {
    currentCwd = extractCwd(args, currentCwd);
    state.baseline = await createWorkspaceSnapshot(currentCwd, {
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
    });
  });

  registerHook(pi, "tool_call", (...args) => {
    const name = extractToolName(args);
    if (!["write", "Write", "edit", "Edit"].includes(name)) {
      return;
    }
    const toolArgs = extractToolArgs(args);
    recordTouchedPath(state, toolArgs?.path ?? toolArgs?.file_path ?? toolArgs?.filePath);
  });

  registerHook(pi, "tool_result", (...args) => {
    const name = extractToolName(args);
    if (!["write", "Write", "edit", "Edit"].includes(name)) {
      return;
    }
    const toolArgs = extractToolArgs(args);
    recordTouchedPath(state, toolArgs?.path ?? toolArgs?.file_path ?? toolArgs?.filePath);
  });

  registerHook(pi, "agent_end", async (...args) => {
    currentCwd = extractCwd(args, currentCwd);
    if (!state.baseline) {
      return;
    }

    const output = await runReview({
      cwd: currentCwd,
      request: state.latestRequest || "No original request captured.",
      before: state.baseline,
      config,
      notify: (message) => sendNotice(pi, message),
    });

    if (!output.changed) {
      return;
    }

    if (output.result?.verdict === "pass") {
      await sendNotice(pi, "review gate: passed");
      return;
    }

    if (output.result?.verdict === "needs_changes" && output.followUpMessage) {
      if (state.correctionCycles >= config.maxCorrectionCycles) {
        await sendNotice(pi, "review gate: changes requested, automatic correction cap reached");
        return;
      }
      state.correctionCycles += 1;
      await sendNotice(pi, "review gate: changes requested");
      await sendFollowUp(pi, output.followUpMessage);
      return;
    }

    await sendNotice(pi, output.bundleRetained ? `review gate: reviewer failed, bundle retained at ${output.bundleDir}` : "review gate: reviewer failed");
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
