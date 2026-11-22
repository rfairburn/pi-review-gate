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
import { admittedPiCommandOrUndefined } from "../../pi-invocation";

/** Trusted, nonpersisted runtime launch inputs for one executor launch. */
export interface ExecutorLaunchOptions {
  /**
   * #682: host-admitted Pi executable for a canonical Pi worker. Absent keeps
   * the existing default `pi` resolution; external executors ignore it.
   */
  admittedPiCommand?: string;
}

export function createExecutorAdapter(
  config: ReviewGateConfig,
  selection?: ExecutorSelection,
  launch: ExecutorLaunchOptions = {},
): ExecutorAdapter {
  const active = selection;
  if (!active) {
    throw new Error("delegated execution is disabled; choose an executor with /review-settings");
  }
  if (active.source === "pi") {
    // The shared Protection level travels with the launch, never from task text
    // or an ambient child configuration: a Pi executor receives the parent's
    // current pinned snapshot, and an unvalidated stored block fails that
    // launch closed. Off (or no block) changes nothing else about the launch.
    const protection = executorProtectionAdmission(config);
    if ("blocked" in protection) {
      throw new Error(`review gate: ${protection.reason}`);
    }
    const command = admittedPiCommandOrUndefined(launch.admittedPiCommand);
    return new PiExecutorAdapter({
      model: active.model,
      ...(command !== undefined ? { admittedCommand: command } : {}),
      thinkingLevel: active.thinkingLevel,
      timeoutMs: config.executorTimeoutMs,
      toolProtection: protection.pin,
    });
  }
  // Non-Pi acting workers are outside this added gate, including when its
  // configuration is unavailable. Keep their normal resolution and launch path.
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
