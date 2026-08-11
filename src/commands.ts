import { automaticReviewEnabled, resolveReviewers, type ReviewGateConfig } from "./config";
import { join } from "node:path";
import { removeTransientWindowBundle } from "./bundle";
import { createWorkspaceSnapshot } from "./capture";
import {
  buildRequestContext,
  armReviewResponseExchange,
  clearReviewState,
  closeReviewWindow,
  getCorrectionAttemptCount,
  getReviewerQuestionWindow,
  markCappedFeedbackSent,
  recordAcceptedReviewerQuestion,
  recordReviewerFeedbackAndArmExchange,
  type ReviewGateState,
} from "./state";
import { runAskReviewer, runReview } from "./review";
import { extractSignal, sendNotice, sendFollowUp, sendSteeringPrompt, createStatusTracker } from "./pi";
import { formatTokenUsage } from "./usage";
import type { ReviewFinding, ReviewResult } from "./schema";
import { createReviewTransmissionMessage, deliverReviewTransmission, writeReviewDeliveryReceipt, type ReviewTransmissionAction } from "./transmission";

export interface RegisterCommandsInput {
  pi: unknown;
  cwd: () => string;
  config: ReviewGateConfig;
  getConfig?: () => ReviewGateConfig;
  state: ReviewGateState;
  isSessionActive?: () => boolean;
  sessionSignal?: AbortSignal;
  prepareReviewerQuestion?: (commandName: string, ctx: unknown) => Promise<void>;
}

export function registerCommands(input: RegisterCommandsInput): void {
  const registerCommand = getRegisterCommand(input.pi);
  if (!registerCommand) {
    return;
  }
  const isSessionActive = input.isSessionActive ?? (() => true);
  const currentConfig = () => input.getConfig?.() ?? input.config;
  const sendCommandNotice = (ctx: unknown, message: string): Promise<void> =>
    isSessionActive() ? sendNotice(ctx, message) : Promise.resolve();

  registerCommand("review-gate-ping", {
    description: "Verify pi-review-gate is loaded.",
    handler: async (_args: string, ctx: unknown) => {
      if (!isSessionActive()) {
        return;
      }
      const reviewers = resolveReviewers(currentConfig()).reviewers.map((reviewer) => reviewer.id).join(", ") || "none";
      await sendCommandNotice(ctx, `review gate: loaded; reviewers=${reviewers}; paused=${input.state.reviewsPaused}`);
    },
  });

  registerCommand("review-pause", {
    description: "Pause reviewer execution while continuing to collect turn evidence.",
    handler: async (_args: string, ctx: unknown) => {
      if (!isSessionActive()) {
        return;
      }
      if (input.state.reviewsPaused) {
        await sendCommandNotice(ctx, "review gate: reviews are already paused; turn evidence is still being collected");
        return;
      }
      input.state.reviewsPaused = true;
      await sendCommandNotice(ctx, input.state.reviewInProgress
        ? "review gate: reviews paused after the active review finishes; subsequent turn evidence will still be collected"
        : "review gate: reviews paused; turn evidence will still be collected");
    },
  });

  registerCommand("review-unpause", {
    description: "Resume reviewer execution after /review-pause.",
    handler: async (_args: string, ctx: unknown) => {
      if (!isSessionActive()) {
        return;
      }
      if (!input.state.reviewsPaused) {
        await sendCommandNotice(ctx, "review gate: reviews are already unpaused");
        return;
      }
      input.state.reviewsPaused = false;
      await sendCommandNotice(ctx, "review gate: reviews unpaused; the next eligible turn will review accumulated changes and evidence");
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
        `review gate: cleared; the next prompt will start fresh from the current workspace; bundle retention remains governed by retainBundles=${currentConfig().retainBundles}; reviewer sessions from the cleared window will not be reused`,
      );
    },
  });

  registerCommand("review-now", {
    description: "Run pi-review-gate against the current turn baseline.",
    handler: async (_args: string, ctx: unknown) => {
      if (!isSessionActive()) {
        return;
      }
      if (input.state.reviewsPaused) {
        await sendCommandNotice(ctx, "review gate: reviews are paused; use /review-unpause before /review-now");
        return;
      }
      const window = input.state.reviewWindow;
      if (!window?.baseline) {
        await sendCommandNotice(ctx, "review gate: no active review window with a baseline");
        return;
      }
      const reviewConfig = window.reviewConfig ?? currentConfig();
      if (!automaticReviewEnabled(reviewConfig)) {
        await sendCommandNotice(ctx, "review gate: automatic review is disabled by settings");
        return;
      }
      const statusTracker = createStatusTracker(ctx, "review-gate", "reviewing changes");
      let output;
      try {
        output = await runReview({
          cwd: input.cwd(),
          request: buildRequestContext(input.state) || "Manual /review-now request",
          before: window.baseline,
          config: reviewConfig,
          evidence: window.evidence,
          correctionAttemptCount: getCorrectionAttemptCount(window),
          window,
          signal: combineAbortSignals(extractSignal([ctx]), input.sessionSignal),
          notify: (message) => sendCommandNotice(ctx, message),
          onUpdate: (message) => statusTracker.update(message),
        });
      } finally {
        statusTracker.clear();
      }

      if (!isSessionActive()) {
        return;
      }
      if (!output.changed) {
        await sendCommandNotice(ctx, "review gate: no changes detected");
        closeReviewWindow(input.state, true);
        return;
      }
      if (output.result?.error === "aborted") {
        await sendCommandNotice(ctx, "review gate: review cancelled");
        return;
      }
      if (output.result?.verdict === "pass") {
        const transmission = await createCommandTransmission(output, "passed");
        recordReviewerFeedbackAndArmExchange(input.state, {
          result: output.result,
          reviewerResults: output.reviewerResults,
          reviewSequence: output.reviewSequence,
          source: "manual",
          disposition: "sent_for_observation",
          reviewedSnapshot: output.reviewedSnapshot!,
        });
        await sendCommandNotice(ctx, `review gate: passed (${formatTokenUsage(output.result.usage)})`);
        await deliverCommandTransmission(input.pi, output, "passed", transmission, isSessionActive);
      } else if (output.result?.verdict === "needs_changes") {
        const transmission = await createCommandTransmission(output, "correction_required");
        await sendCommandNotice(ctx, `review gate: changes requested (${formatTokenUsage(output.result.usage)})`);
        window.correctionCycles = 0;
        window.lastCappedFollowUp = undefined;
        recordReviewerFeedbackAndArmExchange(input.state, {
          result: output.result,
          reviewerResults: output.reviewerResults,
          reviewSequence: output.reviewSequence,
          source: "manual",
          disposition: "sent_for_correction",
          reviewedSnapshot: output.reviewedSnapshot!,
        });
        await deliverCommandTransmission(input.pi, output, "correction_required", transmission, isSessionActive);
      } else {
        const failed = `review gate: reviewer failed (${formatTokenUsage(output.result?.usage)})`;
        if (output.result) {
          const transmission = await createCommandTransmission(output, "review_error");
          recordReviewerFeedbackAndArmExchange(input.state, {
            result: output.result,
            reviewerResults: output.reviewerResults,
            reviewSequence: output.reviewSequence,
            source: "manual",
            disposition: "sent_review_error",
            reviewedSnapshot: output.reviewedSnapshot!,
          });
          await deliverCommandTransmission(input.pi, output, "review_error", transmission, isSessionActive);
        }
        await sendCommandNotice(ctx, failed);
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
      const reviewConfig = window.reviewConfig ?? currentConfig();
      const feedback = markCappedFeedbackSent(input.state);
      window.lastCappedFollowUp = undefined;
      window.correctionCycles = 0;
      armReviewResponseExchange(input.state, await createWorkspaceSnapshot(input.cwd(), {
        maxFileBytes: reviewConfig.maxFileBytes,
        maxSnapshotBytes: reviewConfig.maxSnapshotBytes,
      }));
      await sendCommandNotice(ctx, `review gate: continuing review; correction budget reset to ${reviewConfig.maxCorrectionCycles}`);
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

  const askReviewerHandler = (autoSubmit: boolean, commandName: string) =>
    async (args: string, ctx: unknown) => {
      if (!isSessionActive()) {
        return;
      }
      if (input.state.reviewsPaused) {
        await sendCommandNotice(ctx, `review gate: reviews are paused; use /review-unpause before /${commandName}`);
        return;
      }
      const currentReviewConfig = getReviewerQuestionWindow(input.state)?.reviewConfig ?? currentConfig();
      if (!automaticReviewEnabled(currentReviewConfig)) {
        await sendCommandNotice(ctx, `review gate: reviewer use is disabled by settings; use /review-settings before /${commandName}`);
        return;
      }
      const question = args.trim();
      if (!question) {
        await sendCommandNotice(ctx, `review gate: usage: /${commandName} <question>`);
        return;
      }

      await sendCommandNotice(ctx, `review gate: asking reviewer\n\nQuestion: ${question}`);
      await input.prepareReviewerQuestion?.(commandName, ctx);
      if (!isSessionActive()) {
        return;
      }
      const contextWindow = getReviewerQuestionWindow(input.state);
      const reviewConfig = contextWindow?.reviewConfig ?? currentConfig();
      const statusTracker = createStatusTracker(ctx, "review-gate", "asking reviewer");
      let output;
      try {
        output = await runAskReviewer({
          cwd: input.cwd(),
          question,
          request: buildRequestContext(input.state, contextWindow),
          before: contextWindow?.baseline,
          config: reviewConfig,
          evidence: contextWindow?.evidence,
          correctionAttemptCount: getCorrectionAttemptCount(contextWindow),
          window: contextWindow,
          signal: combineAbortSignals(extractSignal([ctx]), input.sessionSignal),
          notify: (message) => sendCommandNotice(ctx, message),
          onUpdate: (message) => statusTracker.update(message),
        });
      } finally {
        statusTracker.clear();
      }

      if (!isSessionActive()) {
        return;
      }
      if (!output.result) {
        await sendCommandNotice(ctx, output.error ?? "review gate: reviewer failed");
        return;
      }
      if (output.result.error === "aborted") {
        await sendCommandNotice(ctx, "review gate: reviewer question cancelled");
        return;
      }

      if (output.result.verdict === "error" && !hasUsableReviewerAnswer(output.reviewerResults)) {
        const failed = `review gate: ask-reviewer failed: ${output.result.summary} (${formatTokenUsage(output.result.usage)})`;
        await sendCommandNotice(ctx, output.bundleRetained ? `${failed}, bundle retained at ${output.bundleDir}` : failed);
        return;
      }

      const payload = formatReviewerAnswer(question, output.reviewerResults ?? [], output.bundleRetained ? output.bundleDir : undefined);
      const submittedPayload = autoSubmit ? payload : await showPrivateReviewerAnswer(ctx, payload);
      if (!isSessionActive()) {
        return;
      }
      if (typeof submittedPayload === "string" && submittedPayload.trim()) {
        const acceptedAnswer = submittedPayload.trim();
        recordAcceptedReviewerQuestion(input.state, contextWindow, {
          question,
          acceptedAnswer,
        });
        await sendSteeringPrompt(input.pi, acceptedAnswer);
        return;
      }
      const cleared = `${formatTokenUsage(output.result.usage)}\nreview gate: reviewer answer cleared`;
      await sendCommandNotice(ctx, output.bundleRetained ? `${cleared}, bundle retained at ${output.bundleDir}` : cleared);
    };

  registerCommand("ask-reviewer", {
    description: "Ask the configured reviewer a question and steer its answer into the current turn.",
    handler: askReviewerHandler(true, "ask-reviewer"),
  });

  registerCommand("ask-reviewer-interactive", {
    description: "Ask the configured reviewer a question, edit its answer, then steer it into the current turn.",
    handler: askReviewerHandler(false, "ask-reviewer-interactive"),
  });
}

async function createCommandTransmission(
  output: Awaited<ReturnType<typeof runReview>>,
  action: ReviewTransmissionAction,
): Promise<string> {
  if (!output.result || !output.reviewerResults || !output.bundleDir || !output.invocationDir || output.reviewSequence === undefined) {
    throw new Error("review gate: cannot transmit an incomplete review pass");
  }
  return createReviewTransmissionMessage({
    invocationDir: output.invocationDir,
    reviewSequence: output.reviewSequence,
    gateVerdict: output.result.verdict,
    reviewerResults: output.reviewerResults,
    reviewerDisplayLabels: output.reviewerDisplayLabels,
    bundleDir: output.bundleDir,
    action,
  });
}

async function deliverCommandTransmission(
  pi: unknown,
  output: Awaited<ReturnType<typeof runReview>>,
  action: ReviewTransmissionAction,
  message: string,
  isSessionActive: () => boolean,
): Promise<void> {
  if (!output.invocationDir || !isSessionActive()) {
    return;
  }
  await deliverReviewTransmission({
    invocationDir: output.invocationDir,
    action,
    message,
    deliver: () => isSessionActive() ? sendFollowUp(pi, message) : Promise.resolve(false),
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

function formatReviewerAnswer(question: string, results: ReviewResult[], bundleDir?: string): string {
  const lines = [
    "Reviewer note from /ask-reviewer:",
    "",
    `Question: ${question}`,
  ];
  for (const result of results) {
    lines.push("", `## ${result.reviewerId} — ${result.verdict}`, "", `Answer: ${result.summary}`);
    if (result.guidance) {
      lines.push("", "Implementation guidance:", result.guidance);
    }
    if (result.error) {
      lines.push("", `Reviewer error: ${result.error}`);
    }
    const findings = formatFindings(result.findings);
    if (findings.length > 0) {
      lines.push("", "Relevant findings:", ...findings);
    }
  }
  if (bundleDir) {
    lines.push("", `Retained review bundle: ${bundleDir}`);
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
