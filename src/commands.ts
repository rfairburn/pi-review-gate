import type { ReviewGateConfig } from "./config";
import {
  buildRequestContext,
  closeReviewWindow,
  getReviewerQuestionWindow,
  markCappedFeedbackSent,
  pauseReviewWindow,
  recordReviewerFeedback,
  type ReviewGateState,
} from "./state";
import { runAskReviewer, runReview } from "./review";
import { extractSignal, sendNotice, sendFollowUp, sendUserPrompt } from "./pi";
import { buildReviewerResultsNotice } from "./prompts";
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
      const reviewers = input.config.reviewers?.map((reviewer) => reviewer.id).join(", ") ?? input.config.decider?.id ?? "none";
      await sendNotice(ctx, `review gate: loaded; mode=${input.config.mode}; reviewers=${reviewers}`);
    },
  });

  registerCommand("review-now", {
    description: "Run pi-review-gate against the current turn baseline.",
    handler: async (_args: string, ctx: unknown) => {
      const window = input.state.reviewWindow;
      if (!window?.baseline) {
        await sendNotice(ctx, "review gate: no active review window with a baseline");
        return;
      }
      const output = await runReview({
        cwd: input.cwd(),
        request: buildRequestContext(input.state) || "Manual /review-now request",
        before: window.baseline,
        config: input.config,
        evidence: window.evidence,
        signal: extractSignal([ctx]),
        notify: (message) => sendNotice(ctx, message),
      });

      if (!output.changed) {
        await sendNotice(ctx, "review gate: no changes detected");
        closeReviewWindow(input.state, true);
        return;
      }
      if (output.result?.verdict === "pass") {
        await sendNotice(ctx, withReviewDetails(`review gate: passed (${formatTokenUsage(output.result.usage)})`, output));
        closeReviewWindow(input.state);
      } else if (output.result?.verdict === "needs_changes" && output.followUpMessage) {
        await sendNotice(ctx, withReviewDetails(`review gate: changes requested (${formatTokenUsage(output.result.usage)})`, output));
        window.correctionCycles = 0;
        window.lastCappedFollowUp = undefined;
        window.status = "active";
        recordReviewerFeedback(input.state, {
          result: output.result,
          source: "manual",
          disposition: "sent_for_correction",
          followUpMessage: output.followUpMessage,
        });
        await sendFollowUp(input.pi, output.followUpMessage);
      } else {
        const failed = `review gate: reviewer failed (${formatTokenUsage(output.result?.usage)})`;
        if (output.result) {
          recordReviewerFeedback(input.state, {
            result: output.result,
            source: "manual",
            disposition: "reported_only",
          });
        }
        pauseReviewWindow(input.state, "paused");
        await sendNotice(ctx, withReviewDetails(failed, output));
      }
    },
  });

  registerCommand("review-continue", {
    description: "Send the last capped reviewer feedback and reset the correction budget.",
    handler: async (_args: string, ctx: unknown) => {
      const window = input.state.reviewWindow;
      if (!window?.lastCappedFollowUp) {
        await sendNotice(ctx, "review gate: no capped reviewer feedback available");
        return;
      }
      const followUp = window.lastCappedFollowUp;
      markCappedFeedbackSent(input.state, followUp);
      window.lastCappedFollowUp = undefined;
      window.status = "active";
      window.correctionCycles = 0;
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
      const activeWindow = input.state.reviewWindow;
      const contextWindow = getReviewerQuestionWindow(input.state);
      const output = await runAskReviewer({
        cwd: input.cwd(),
        question,
        request: buildRequestContext(input.state, contextWindow),
        before: activeWindow?.baseline,
        config: input.config,
        evidence: contextWindow?.evidence,
        signal: extractSignal([ctx]),
        notify: (message) => sendNotice(ctx, message),
      });

      if (!output.result) {
        await sendNotice(ctx, output.error ?? "review gate: reviewer failed");
        return;
      }

      if (output.result.verdict === "error" && !hasUsableReviewerAnswer(output.reviewerResults)) {
        const failed = `review gate: ask-reviewer failed: ${output.result.summary} (${formatTokenUsage(output.result.usage)})`;
        await sendNotice(ctx, output.bundleRetained ? `${failed}, bundle retained at ${output.bundleDir}` : failed);
        return;
      }

      const payload = formatReviewerAnswer(question, output.result, output.bundleRetained ? output.bundleDir : undefined);
      const submittedPayload = await showPrivateReviewerAnswer(ctx, payload);
      if (typeof submittedPayload === "string" && submittedPayload.trim()) {
        await sendUserPrompt(input.pi, submittedPayload.trim());
        return;
      }
      const cleared = `${formatTokenUsage(output.result.usage)}\nreview gate: reviewer answer cleared`;
      await sendNotice(ctx, output.bundleRetained ? `${cleared}, bundle retained at ${output.bundleDir}` : cleared);
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

function withReviewDetails(header: string, output: { reviewerResults?: ReviewResult[]; bundleRetained?: boolean; bundleDir?: string }): string {
  const details = buildReviewerResultsNotice(output.reviewerResults, output.bundleRetained ? output.bundleDir : undefined);
  return details ? `${header}\n${details}` : header;
}

function formatReviewerAnswer(question: string, result: ReviewResult, bundleDir?: string): string {
  const lines = [
    "Reviewer note from /ask-reviewer:",
    "",
    `Question: ${question}`,
    "",
    `Answer: ${result.summary}`,
  ];
  if (bundleDir) {
    lines.push("", `Retained review bundle: ${bundleDir}`);
  }
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

function hasUsableReviewerAnswer(results: ReviewResult[] | undefined): boolean {
  return Boolean(results?.some((result) => result.verdict !== "error"));
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
