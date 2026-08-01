import type { ReviewGateConfig } from "./config";
import { join } from "node:path";
import { removeTransientWindowBundle } from "./bundle";
import {
  buildRequestContext,
  clearReviewState,
  closeReviewWindow,
  getCorrectionAttemptCount,
  getReviewerQuestionWindow,
  markCappedFeedbackSent,
  pauseReviewWindow,
  recordAcceptedReviewerQuestion,
  recordReviewerFeedback,
  type ReviewGateState,
} from "./state";
import { runAskReviewer, runReview } from "./review";
import { extractSignal, sendNotice, sendFollowUp, sendUserPrompt } from "./pi";
import { buildReviewerResultsNotice } from "./prompts";
import { formatTokenUsage } from "./usage";
import type { ReviewFinding, ReviewResult } from "./schema";
import { buildReviewTransmission, writeReviewDeliveryReceipt, writeReviewTransmission, type ReviewTransmissionAction } from "./transmission";

export interface RegisterCommandsInput {
  pi: unknown;
  cwd: () => string;
  config: ReviewGateConfig;
  state: ReviewGateState;
  isSessionActive?: () => boolean;
  sessionSignal?: AbortSignal;
}

export function registerCommands(input: RegisterCommandsInput): void {
  const registerCommand = getRegisterCommand(input.pi);
  if (!registerCommand) {
    return;
  }
  const isSessionActive = input.isSessionActive ?? (() => true);
  const sendCommandNotice = (ctx: unknown, message: string): Promise<void> =>
    isSessionActive() ? sendNotice(ctx, message) : Promise.resolve();

  registerCommand("review-gate-ping", {
    description: "Verify pi-review-gate is loaded.",
    handler: async (_args: string, ctx: unknown) => {
      if (!isSessionActive()) {
        return;
      }
      const reviewers = input.config.reviewers?.map((reviewer) => reviewer.id).join(", ") ?? input.config.decider?.id ?? "none";
      await sendCommandNotice(ctx, `review gate: loaded; mode=${input.config.mode}; reviewers=${reviewers}`);
    },
  });

  registerCommand("review-clear", {
    description: "Clear review-gate context so the next prompt starts a fresh review window.",
    handler: async (_args: string, ctx: unknown) => {
      if (!isSessionActive()) {
        return;
      }
      if (input.state.reviewInProgress) {
        await sendCommandNotice(ctx, "review gate: cannot clear while a review is in progress; cancel the review first, then retry /review-clear");
        return;
      }
      const windows = [input.state.reviewWindow, input.state.lastQuestionWindow];
      clearReviewState(input.state);
      await Promise.all(windows.map((window) => removeTransientWindowBundle(window)));
      await sendCommandNotice(
        ctx,
        `review gate: cleared; the next prompt will start fresh from the current workspace; bundle retention remains governed by retainBundles=${input.config.retainBundles}; reviewer sessions from the cleared window will not be reused`,
      );
    },
  });

  registerCommand("review-now", {
    description: "Run pi-review-gate against the current turn baseline.",
    handler: async (_args: string, ctx: unknown) => {
      if (!isSessionActive()) {
        return;
      }
      const window = input.state.reviewWindow;
      if (!window?.baseline) {
        await sendCommandNotice(ctx, "review gate: no active review window with a baseline");
        return;
      }
      const output = await runReview({
        cwd: input.cwd(),
        request: buildRequestContext(input.state) || "Manual /review-now request",
        before: window.baseline,
        config: input.config,
        evidence: window.evidence,
        correctionAttemptCount: getCorrectionAttemptCount(window),
        window,
        signal: combineAbortSignals(extractSignal([ctx]), input.sessionSignal),
        notify: (message) => sendCommandNotice(ctx, message),
      });

      if (!isSessionActive()) {
        return;
      }
      if (!output.changed) {
        await sendCommandNotice(ctx, "review gate: no changes detected");
        closeReviewWindow(input.state, true);
        return;
      }
      if (output.result?.verdict === "pass") {
        const transmission = await createCommandTransmission(output, "passed");
        recordReviewerFeedback(input.state, {
          result: output.result,
          reviewerResults: output.reviewerResults,
          reviewSequence: output.reviewSequence,
          source: "manual",
          disposition: "sent_for_observation",
          followUpMessage: transmission,
        });
        await sendCommandNotice(ctx, withReviewDetails(`review gate: passed (${formatTokenUsage(output.result.usage)})`, output));
        if (isSessionActive()) {
          if (await sendFollowUp(input.pi, transmission)) {
            await writeReviewDeliveryReceipt(output.invocationDir!, "passed", transmission);
          }
        }
      } else if (output.result?.verdict === "needs_changes" && output.followUpMessage) {
        const transmission = await createCommandTransmission(output, "correction_required");
        await sendCommandNotice(ctx, withReviewDetails(`review gate: changes requested (${formatTokenUsage(output.result.usage)})`, output));
        window.correctionCycles = 0;
        window.lastCappedFollowUp = undefined;
        window.status = "active";
        recordReviewerFeedback(input.state, {
          result: output.result,
          reviewerResults: output.reviewerResults,
          reviewSequence: output.reviewSequence,
          source: "manual",
          disposition: "sent_for_correction",
          followUpMessage: transmission,
        });
        if (isSessionActive()) {
          if (await sendFollowUp(input.pi, transmission)) {
            await writeReviewDeliveryReceipt(output.invocationDir!, "correction_required", transmission);
          }
        }
      } else {
        const failed = `review gate: reviewer failed (${formatTokenUsage(output.result?.usage)})`;
        if (output.result) {
          const transmission = await createCommandTransmission(output, "review_error");
          recordReviewerFeedback(input.state, {
            result: output.result,
            reviewerResults: output.reviewerResults,
            reviewSequence: output.reviewSequence,
            source: "manual",
            disposition: "sent_review_error",
            followUpMessage: transmission,
          });
          if (isSessionActive()) {
            if (await sendFollowUp(input.pi, transmission)) {
              await writeReviewDeliveryReceipt(output.invocationDir!, "review_error", transmission);
            }
          }
        }
        pauseReviewWindow(input.state, "paused");
        await sendCommandNotice(ctx, withReviewDetails(failed, output));
      }
    },
  });

  registerCommand("review-continue", {
    description: "Send the last capped reviewer feedback and reset the correction budget.",
    handler: async (_args: string, ctx: unknown) => {
      if (!isSessionActive()) {
        return;
      }
      const window = input.state.reviewWindow;
      if (!window?.lastCappedFollowUp) {
        await sendCommandNotice(ctx, "review gate: no capped reviewer feedback available");
        return;
      }
      const followUp = window.lastCappedFollowUp;
      const feedback = markCappedFeedbackSent(input.state, followUp);
      window.lastCappedFollowUp = undefined;
      window.status = "active";
      window.correctionCycles = 0;
      await sendCommandNotice(ctx, `review gate: continuing review; correction budget reset to ${input.config.maxCorrectionCycles}`);
      if (isSessionActive()) {
        if (await sendFollowUp(input.pi, followUp) && feedback && window.bundleDir) {
          await writeReviewDeliveryReceipt(
            join(window.bundleDir, "reviews", String(feedback.sequence).padStart(4, "0")),
            "correction_required",
            followUp,
          );
        }
      }
    },
  });

  registerCommand("ask-reviewer", {
    description: "Ask the configured reviewer a question about the current work.",
    handler: async (args: string, ctx: unknown) => {
      if (!isSessionActive()) {
        return;
      }
      const question = args.trim();
      if (!question) {
        await sendCommandNotice(ctx, "review gate: usage: /ask-reviewer <question>");
        return;
      }

      await sendCommandNotice(ctx, `review gate: asking reviewer\n\nQuestion: ${question}`);
      const contextWindow = getReviewerQuestionWindow(input.state);
      const output = await runAskReviewer({
        cwd: input.cwd(),
        question,
        request: buildRequestContext(input.state, contextWindow),
        before: contextWindow?.baseline,
        config: input.config,
        evidence: contextWindow?.evidence,
        correctionAttemptCount: getCorrectionAttemptCount(contextWindow),
        window: contextWindow,
        signal: combineAbortSignals(extractSignal([ctx]), input.sessionSignal),
        notify: (message) => sendCommandNotice(ctx, message),
      });

      if (!isSessionActive()) {
        return;
      }
      if (!output.result) {
        await sendCommandNotice(ctx, output.error ?? "review gate: reviewer failed");
        return;
      }

      if (output.result.verdict === "error" && !hasUsableReviewerAnswer(output.reviewerResults)) {
        const failed = `review gate: ask-reviewer failed: ${output.result.summary} (${formatTokenUsage(output.result.usage)})`;
        await sendCommandNotice(ctx, output.bundleRetained ? `${failed}, bundle retained at ${output.bundleDir}` : failed);
        return;
      }

      const payload = formatReviewerAnswer(question, output.result, output.bundleRetained ? output.bundleDir : undefined);
      const submittedPayload = await showPrivateReviewerAnswer(ctx, payload);
      if (!isSessionActive()) {
        return;
      }
      if (typeof submittedPayload === "string" && submittedPayload.trim()) {
        const acceptedAnswer = submittedPayload.trim();
        recordAcceptedReviewerQuestion(input.state, contextWindow, {
          question,
          acceptedAnswer,
        });
        await sendUserPrompt(input.pi, acceptedAnswer);
        return;
      }
      const cleared = `${formatTokenUsage(output.result.usage)}\nreview gate: reviewer answer cleared`;
      await sendCommandNotice(ctx, output.bundleRetained ? `${cleared}, bundle retained at ${output.bundleDir}` : cleared);
    },
  });
}

async function createCommandTransmission(
  output: Awaited<ReturnType<typeof runReview>>,
  action: ReviewTransmissionAction,
): Promise<string> {
  if (!output.result || !output.reviewerResults || !output.bundleDir || !output.invocationDir || output.reviewSequence === undefined) {
    throw new Error("review gate: cannot transmit an incomplete review pass");
  }
  const transmission = buildReviewTransmission({
    reviewSequence: output.reviewSequence,
    result: output.result,
    reviewerResults: output.reviewerResults,
    bundleDir: output.bundleDir,
    action,
  });
  await writeReviewTransmission(output.invocationDir, transmission);
  return transmission.message;
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
  if (result.guidance) {
    lines.push("", "Implementation guidance:", result.guidance);
  }
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
    return [
      `${index + 1}. ${location}`,
      `Issue: ${finding.issue}`,
      `Recommendation: ${finding.recommendation}`,
    ].join("\n");
  });
}

function hasUsableReviewerAnswer(results: ReviewResult[] | undefined): boolean {
  return Boolean(results?.some((result) => result.verdict !== "error"));
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  return AbortSignal.any(activeSignals);
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
