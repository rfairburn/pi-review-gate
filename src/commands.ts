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

  registerCommand("review-gate-ping", {
    description: "Verify pi-review-gate is loaded.",
    handler: async (_args: string, ctx: unknown) => {
      await sendNotice(ctx, `review gate: loaded; mode=${input.config.mode}; decider=${input.config.decider?.id ?? "none"}`);
    },
  });

  registerCommand("review-now", {
    description: "Run pi-review-gate against the current turn baseline.",
    handler: async (_args: string, ctx: unknown) => {
    if (!input.state.baseline) {
      await sendNotice(ctx, "review gate: no baseline available");
      return;
    }
    const output = await runReview({
      cwd: input.cwd(),
      request: input.state.latestRequest || "Manual /review-now request",
      before: input.state.baseline,
      config: input.config,
      notify: (message) => sendNotice(ctx, message),
    });

    if (!output.changed) {
      await sendNotice(ctx, "review gate: no changes detected");
      return;
    }
    if (output.result?.verdict === "pass") {
      await sendNotice(ctx, "review gate: passed");
    } else if (output.result?.verdict === "needs_changes" && output.followUpMessage) {
      await sendNotice(ctx, "review gate: changes requested");
      await sendFollowUp(input.pi, output.followUpMessage);
    } else {
      await sendNotice(ctx, output.bundleRetained ? `review gate: reviewer failed, bundle retained at ${output.bundleDir}` : "review gate: reviewer failed");
    }
    },
  });
}

type RegisterCommand = (
  name: string,
  options: {
    description?: string;
    handler: (args: string, ctx: unknown) => unknown;
  },
) => void;

function getRegisterCommand(pi: unknown): RegisterCommand | undefined {
  if (isRecord(pi) && typeof pi.registerCommand === "function") {
    return pi.registerCommand.bind(pi) as RegisterCommand;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
