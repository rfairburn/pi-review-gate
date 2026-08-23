import {
  activeExternalExecutor,
  type ExecutorSelection,
  type ReviewGateConfig,
} from "../../config";
import type { ExecutorAdapter } from "../types";
import { ClaudeExecutorAdapter } from "./claude-cli";
import { CodexExecutorAdapter } from "./codex-cli";
import { PiExecutorAdapter } from "./pi-model";
import { RunAsBinaryExecutorAdapter } from "./run-as-binary";

export function createExecutorAdapter(config: ReviewGateConfig, selection?: ExecutorSelection): ExecutorAdapter {
  const active = selection ?? config.execution?.activeExecutor;
  if (!active) {
    throw new Error("delegated execution is disabled; choose an executor with /review-settings");
  }
  if (active.source === "pi") {
    return new PiExecutorAdapter({
      model: active.model,
      thinkingLevel: active.thinkingLevel,
      timeoutMs: config.executorTimeoutMs,
    });
  }
  const external = activeExternalExecutor(config, active);
  if (!external) {
    throw new Error(`external executor definition is unavailable: ${active.id}`);
  }
  if (external.adapter === "codex-cli") {
    return new CodexExecutorAdapter(external);
  }
  if (external.adapter === "claude-cli") {
    return new ClaudeExecutorAdapter(external);
  }
  return new RunAsBinaryExecutorAdapter(external);
}
