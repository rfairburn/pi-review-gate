import type { ReviewGateConfig } from "./config";
import type { ReviewGateState } from "./state";
import { runReview } from "./review";
import { sendNotice, sendFollowUp } from "./pi";

export interface RegisterCommandsInput {
  pi: unknown;
  cwd: () => string;
  config: ReviewGateConfig;
  state: ReviewGateState;
}

export function registerCommands(input: RegisterCommandsInput): void {
  const registerCommand = getRegisterCommand(input.pi);
  if (!registerCommand) {
    return;
  }

  registerCommand("/review-now", async () => {
    if (!input.state.baseline) {
      await sendNotice(input.pi, "review gate: no baseline available");
      return;
    }
    const output = await runReview({
      cwd: input.cwd(),
      request: input.state.latestRequest || "Manual /review-now request",
      before: input.state.baseline,
      config: input.config,
      notify: (message) => sendNotice(input.pi, message),
    });

    if (!output.changed) {
      await sendNotice(input.pi, "review gate: no changes detected");
      return;
    }
    if (output.result?.verdict === "pass") {
      await sendNotice(input.pi, "review gate: passed");
    } else if (output.result?.verdict === "needs_changes" && output.followUpMessage) {
      await sendNotice(input.pi, "review gate: changes requested");
      await sendFollowUp(input.pi, output.followUpMessage);
    } else {
      await sendNotice(input.pi, output.bundleRetained ? `review gate: reviewer failed, bundle retained at ${output.bundleDir}` : "review gate: reviewer failed");
    }
  });
}

type RegisterCommand = (name: string, handler: (...args: unknown[]) => unknown) => void;

function getRegisterCommand(pi: unknown): RegisterCommand | undefined {
  if (isRecord(pi) && typeof pi.registerCommand === "function") {
    return pi.registerCommand.bind(pi) as RegisterCommand;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
