import {
  activeExternalExecutor,
  type ReviewGateConfig,
} from "../../config";
import type { ExecutorAdapter } from "../types";
import { ClaudeExecutorAdapter } from "./claude-cli";
import { CodexExecutorAdapter } from "./codex-cli";
import { LittleCoderExecutorAdapter } from "./little-coder";
import { RunAsBinaryExecutorAdapter } from "./run-as-binary";

export function createExecutorAdapter(config: ReviewGateConfig): ExecutorAdapter {
  const active = config.execution?.activeExecutor;
  if (!active) {
    throw new Error("delegated execution is disabled; choose an executor with /review-settings");
  }
  if (active.source === "little-coder") {
    return new LittleCoderExecutorAdapter({ model: active.model, thinkingLevel: active.thinkingLevel });
  }
  const external = activeExternalExecutor(config);
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
