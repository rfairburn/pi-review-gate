import type { ReviewGateConfig } from "./config";
import { buildRequestContext, type ReviewGateState } from "./state";
import { runAskReviewer, runReview } from "./review";
import { sendNotice, sendFollowUp, sendUserPrompt } from "./pi";
import { formatTokenUsage } from "./usage";
import type { ReviewFinding, ReviewResult } from "./schema";

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
        request: buildRequestContext(input.state) || "Manual /review-now request",
        before: input.state.baseline,
        config: input.config,
        evidence: input.state.evidence,
        notify: (message) => sendNotice(ctx, message),
      });

      if (!output.changed) {
        await sendNotice(ctx, "review gate: no changes detected");
        return;
      }
      if (output.result?.verdict === "pass") {
        await sendNotice(ctx, `review gate: passed (${formatTokenUsage(output.result.usage)})`);
      } else if (output.result?.verdict === "needs_changes" && output.followUpMessage) {
        await sendNotice(ctx, `review gate: changes requested (${formatTokenUsage(output.result.usage)})`);
        input.state.correctionCycles = 0;
        await sendFollowUp(input.pi, output.followUpMessage);
      } else {
        const failed = `review gate: reviewer failed (${formatTokenUsage(output.result?.usage)})`;
        await sendNotice(ctx, output.bundleRetained ? `${failed}, bundle retained at ${output.bundleDir}` : failed);
      }
    },
  });

  registerCommand("review-continue", {
    description: "Send the last capped reviewer feedback and reset the correction budget.",
    handler: async (_args: string, ctx: unknown) => {
      if (!input.state.lastCappedFollowUp) {
        await sendNotice(ctx, "review gate: no capped reviewer feedback available");
        return;
      }
      const followUp = input.state.lastCappedFollowUp;
      input.state.lastCappedFollowUp = undefined;
      input.state.correctionCycles = 0;
      await sendNotice(ctx, `review gate: continuing review; correction budget reset to ${input.config.maxCorrectionCycles}`);
      await sendFollowUp(input.pi, followUp);
    },
  });

  registerCommand("ask-reviewer", {
    description: "Ask the configured reviewer a question about the current work.",
    handler: async (args: string, ctx: unknown) => {
      const question = args.trim();
      if (!question) {
        await sendNotice(ctx, "review gate: usage: /ask-reviewer <question>");
        return;
      }

      await sendNotice(ctx, `review gate: asking reviewer\n\nQuestion: ${question}`);
      const output = await runAskReviewer({
        cwd: input.cwd(),
        question,
        request: buildRequestContext(input.state),
        before: input.state.baseline,
        config: input.config,
        evidence: input.state.evidence,
        notify: (message) => sendNotice(ctx, message),
      });

      if (!output.result) {
        await sendNotice(ctx, output.error ?? "review gate: reviewer failed");
        return;
      }

      if (output.result.verdict === "error") {
        const failed = `review gate: ask-reviewer failed: ${output.result.summary} (${formatTokenUsage(output.result.usage)})`;
        await sendNotice(ctx, output.bundleRetained ? `${failed}, bundle retained at ${output.bundleDir}` : failed);
        return;
      }

      const payload = formatReviewerAnswer(question, output.result);
      const submittedPayload = await showPrivateReviewerAnswer(ctx, payload);
      if (typeof submittedPayload === "string" && submittedPayload.trim()) {
        await sendUserPrompt(input.pi, submittedPayload.trim());
        return;
      }
      await sendNotice(ctx, `${formatTokenUsage(output.result.usage)}\nreview gate: reviewer answer cleared`);
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

function formatReviewerAnswer(question: string, result: ReviewResult): string {
  const lines = [
    "Reviewer note from /ask-reviewer:",
    "",
    `Question: ${question}`,
    "",
    `Answer: ${result.summary}`,
  ];
  const findings = formatFindings(result.findings);
  if (findings.length > 0) {
    lines.push("", "Relevant findings:", ...findings);
  }
  return lines.join("\n");
}

function formatFindings(findings: ReviewFinding[]): string[] {
  return findings.map((finding, index) => {
    const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
    return `${index + 1}. ${location} - ${finding.issue} ${finding.recommendation}`;
  });
}

async function showPrivateReviewerAnswer(ctx: unknown, message: string): Promise<string | undefined> {
  if (isRecord(ctx) && isRecord(ctx.ui) && typeof ctx.ui.editor === "function") {
    const result = await ctx.ui.editor("review gate: reviewer answer", message);
    return typeof result === "string" ? result : undefined;
  }
  await sendNotice(ctx, message);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
