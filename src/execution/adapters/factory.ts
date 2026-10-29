import {
  activeExternalExecutor,
  type ExecutorSelection,
  type ReviewGateConfig,
} from "../../config";
import type { ExecutorAdapter } from "../types";
import { executorProtectionAdmission } from "../../tool-protection/coordinator";
import { ClaudeExecutorAdapter } from "./claude-cli";
import { CodexExecutorAdapter } from "./codex-cli";
import { PiExecutorAdapter } from "./pi-model";
import { RunAsBinaryExecutorAdapter } from "./run-as-binary";

export function createExecutorAdapter(config: ReviewGateConfig, selection?: ExecutorSelection): ExecutorAdapter {
  const active = selection;
  if (!active) {
    throw new Error("delegated execution is disabled; choose an executor with /review-settings");
  }
  // The shared Protection level travels with the launch, never from task text
  // or an ambient child configuration: a Pi executor receives the parent's
  // current pinned snapshot, and an external acting executor (which has no
  // proven pre-effect tool seam) is refused before it starts while the added
  // gate is enabled. Off (or no block) changes nothing else about the launch.
  const protection = executorProtectionAdmission(config, active);
  if ("blocked" in protection) {
    throw new Error(`review gate: ${protection.reason}`);
  }
  if (active.source === "pi") {
    return new PiExecutorAdapter({
      model: active.model,
      thinkingLevel: active.thinkingLevel,
      timeoutMs: config.executorTimeoutMs,
      toolProtection: protection.pin,
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
