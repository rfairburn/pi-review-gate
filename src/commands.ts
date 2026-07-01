import type { ReviewGateConfig } from "./config";
import { buildRequestContext, type ReviewGateState } from "./state";
import { runAskReviewer, runReview } from "./review";
import { sendNotice, sendFollowUp, sendNextTurnMessage } from "./pi";
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

  registerCommand("ask-reviewer", {
    description: "Ask the configured reviewer a question about the current work.",
    handler: async (args: string, ctx: unknown) => {
      const parsed = parseAskReviewerArgs(args);
      if (parsed.error) {
        await sendNotice(ctx, `review gate: ${parsed.error}`);
        return;
      }
      if (!parsed.question) {
        await sendNotice(ctx, "review gate: usage: /ask-reviewer [--private|--public] <question>");
        return;
      }

      await sendNotice(ctx, `review gate: asking reviewer\n\nQuestion: ${parsed.question}`);
      const output = await runAskReviewer({
        cwd: input.cwd(),
        question: parsed.question,
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

      const answer = formatReviewerAnswer(parsed.question, output.result);
      await sendNotice(ctx, `${answer}\n\n${formatTokenUsage(output.result.usage)}`);

      if (parsed.visibility === "public") {
        const queued = await sendNextTurnMessage(input.pi, formatPublicReviewerNote(parsed.question, output.result), {
          command: "ask-reviewer",
          question: parsed.question,
          reviewerId: output.result.reviewerId,
          verdict: output.result.verdict,
        });
        await sendNotice(ctx, queued
          ? "review gate: reviewer answer queued for the next primary-model turn"
          : "review gate: could not queue reviewer answer for next turn; host does not expose sendMessage");
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

type AskReviewerVisibility = "private" | "public";

function parseAskReviewerArgs(args: string): { visibility: AskReviewerVisibility; question: string; error?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let visibility: AskReviewerVisibility = "private";
  const questionParts: string[] = [];
  let passthrough = false;

  for (const part of parts) {
    if (passthrough) {
      questionParts.push(part);
      continue;
    }
    if (part === "--") {
      passthrough = true;
    } else if (part === "--private") {
      visibility = "private";
    } else if (part === "--public") {
      visibility = "public";
    } else if (part.startsWith("--")) {
      return { visibility, question: "", error: `unsupported /ask-reviewer flag: ${part}` };
    } else {
      questionParts.push(part);
    }
  }

  return {
    visibility,
    question: questionParts.join(" ").trim(),
  };
}

function formatReviewerAnswer(question: string, result: ReviewResult): string {
  const lines = [
    "review gate: reviewer answer",
    "",
    `Question: ${question}`,
    "",
    result.summary,
  ];
  const findings = formatFindings(result.findings);
  if (findings.length > 0) {
    lines.push("", "Findings:", ...findings);
  }
  return lines.join("\n");
}

function formatPublicReviewerNote(question: string, result: ReviewResult): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
