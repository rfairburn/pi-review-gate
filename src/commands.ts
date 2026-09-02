import { automaticReviewEnabled, resolveReviewers, reviewerDisplayLabel, type ReviewGateConfig } from "./config";
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
import { extractSignal, isEscapeTerminalInput, onTerminalInput, sendNotice, sendFollowUp, sendSteeringPrompt, createStatusTracker } from "./pi";
import type { ActiveReviewCancellation, ReviewCancellationCoordinator } from "./review-cancellation";
import { formatTokenUsage } from "./usage";
import type { ReviewFinding, ReviewResult } from "./schema";
import { createReviewTransmissionMessage, deliverReviewTransmission, type ReviewTransmissionAction } from "./transmission";
import { dispatchModelDelivery, queueModelDelivery } from "./durable-delivery";

export interface RegisterCommandsInput {
  pi: unknown;
  cwd: () => string;
  config: ReviewGateConfig;
  getConfig?: () => ReviewGateConfig;
  state: ReviewGateState;
  isSessionActive?: () => boolean;
  sessionSignal?: AbortSignal;
  cancellation?: ReviewCancellationCoordinator;
  prepareReviewerQuestion?: (commandName: string, ctx: unknown) => Promise<void>;
  onStateChanged?: () => void | Promise<void>;
  releaseQueuedUserInputs?: () => Promise<void>;
}

export function registerCommands(input: RegisterCommandsInput): void {
  const rawRegisterCommand = getRegisterCommand(input.pi);
  if (!rawRegisterCommand) {
    return;
  }
  const registerCommand: RegisterCommand = (name, options) => rawRegisterCommand(name, {
    ...options,
    handler: async (args, ctx) => {
      try {
        return await options.handler(args, ctx);
      } finally {
        await input.onStateChanged?.();
      }
    },
  });
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
      const reviewers = resolveReviewers(currentConfig()).reviewers.map(reviewerDisplayLabel).join(", ") || "none";
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

  registerCommand("review-cancel", {
    description: "Cancel the active automatic or command-driven review and wait for reviewer processes to stop.",
    handler: async (_args: string, ctx: unknown) => {
      if (!isSessionActive()) {
        return;
      }
      const active = input.cancellation?.current();
      if (!active) {
        await sendCommandNotice(ctx, "review gate: no active review to cancel");
        return;
      }
      active.requestCancel("manual");
      await active.acknowledgeCancellation();
      // Completion is reported only once the owning run has returned, which
      // guarantees reviewer child processes are gone before quiescence is claimed.
      await active.settled;
      await active.notifyCancellation();
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
      let settleCommandReview!: () => void;
      const commandReviewSettled = new Promise<void>((resolvePromise) => { settleCommandReview = resolvePromise; });
      const reviewAbort = createCommandReviewAbort(ctx, input.sessionSignal, {
        cancellation: input.cancellation,
        isSessionActive,
        settled: commandReviewSettled,
        describe: () => "the /review-now review",
        completionMessage: "review gate: review cancelled; reviewer processes stopped",
      });
      const reviewSignal = combineAbortSignals(extractSignal([ctx]), reviewAbort.signal);
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
          signal: reviewSignal,
          notify: (message) => sendCommandNotice(ctx, message),
          onUpdate: (message) => statusTracker.update(message),
          onInvocationPrepared: () => input.onStateChanged?.(),
        });
      } finally {
        await statusTracker.clear({ immediate: reviewSignal?.aborted, signal: reviewSignal });
        reviewAbort.cleanup();
        settleCommandReview();
      }

      if (!isSessionActive()) {
        return;
      }
      if (!output.changed) {
        await sendCommandNotice(ctx, "review gate: no changes detected");
        closeReviewWindow(input.state, true);
        await input.releaseQueuedUserInputs?.();
        return;
      }
      if (reviewSignal?.aborted || output.result?.error === "aborted") {
        await reviewAbort.notifyCancellation();
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
        await sendCommandNotice(
          ctx,
          `review gate: ${output.result.error === "partial_reviewer_error" ? "passed with reviewer warnings" : "passed"} (${formatTokenUsage(output.result.usage)})`,
        );
        await deliverCommandTransmission(input, output, "passed", transmission, isSessionActive);
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
        await deliverCommandTransmission(input, output, "correction_required", transmission, isSessionActive);
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
          await deliverCommandTransmission(input, output, "review_error", transmission, isSessionActive);
        }
        await sendCommandNotice(ctx, failed);
      }
      await input.releaseQueuedUserInputs?.();
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
      await deliverDurableCommandMessage(input, {
        kind: "review_authorization",
        channel: "follow_up",
        ...(feedback && window.bundleDir ? {
          invocationDir: join(window.bundleDir, "reviews", String(feedback.sequence).padStart(4, "0")),
          action: "correction_required" as const,
        } : {}),
        message: followUp,
      }, isSessionActive);
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
      let settleCommandReview!: () => void;
      const commandReviewSettled = new Promise<void>((resolvePromise) => { settleCommandReview = resolvePromise; });
      const reviewAbort = createCommandReviewAbort(ctx, input.sessionSignal, {
        cancellation: input.cancellation,
        isSessionActive,
        settled: commandReviewSettled,
        describe: () => "the reviewer question",
        completionMessage: "review gate: reviewer question cancelled; reviewer processes stopped",
      });
      const reviewSignal = combineAbortSignals(extractSignal([ctx]), reviewAbort.signal);
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
          signal: reviewSignal,
          notify: (message) => sendCommandNotice(ctx, message),
          onUpdate: (message) => statusTracker.update(message),
          onInvocationPrepared: () => input.onStateChanged?.(),
        });
      } finally {
        await statusTracker.clear({ immediate: reviewSignal?.aborted, signal: reviewSignal });
        reviewAbort.cleanup();
        settleCommandReview();
      }

      if (!isSessionActive()) {
        return;
      }
      if (!output.result) {
        await sendCommandNotice(ctx, output.error ?? "review gate: reviewer failed");
        return;
      }
      if (reviewSignal?.aborted || output.result.error === "aborted") {
        await reviewAbort.notifyCancellation();
        return;
      }

      if (output.result.verdict === "error" && !hasUsableReviewerAnswer(output.reviewerResults)) {
        const failed = `review gate: ask-reviewer failed: ${output.result.summary} (${formatTokenUsage(output.result.usage)})`;
        await sendCommandNotice(ctx, output.bundleRetained ? `${failed}, bundle retained at ${output.bundleDir}` : failed);
        return;
      }

      const payload = formatReviewerAnswer(
        question,
        output.reviewerResults ?? [],
        output.reviewerDisplayLabels,
        output.bundleRetained ? output.bundleDir : undefined,
      );
      const submittedPayload = autoSubmit ? payload : await showPrivateReviewerAnswer(ctx, payload);
      if (!isSessionActive()) {
        return;
      }
      if (typeof submittedPayload === "string" && submittedPayload.trim()) {
        const acceptedAnswer = submittedPayload.trim();
        const accepted = recordAcceptedReviewerQuestion(input.state, contextWindow, {
          question,
          acceptedAnswer,
        });
        await deliverDurableCommandMessage(input, {
          deliveryId: `reviewer-answer:${contextWindow?.id ?? input.state.reviewWindow?.id ?? "window"}:${accepted.sequence}`,
          kind: "reviewer_answer",
          channel: "steer",
          message: acceptedAnswer,
        }, isSessionActive);
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
  input: RegisterCommandsInput,
  output: Awaited<ReturnType<typeof runReview>>,
  action: ReviewTransmissionAction,
  message: string,
  isSessionActive: () => boolean,
): Promise<void> {
  if (!output.invocationDir || !isSessionActive()) {
    if (!output.invocationDir) return;
  }
  await deliverDurableCommandMessage(input, {
    kind: "review_transmission",
    channel: "follow_up",
    invocationDir: output.invocationDir,
    action,
    message,
  }, isSessionActive);
}

async function deliverDurableCommandMessage(
  input: RegisterCommandsInput,
  pending: Parameters<typeof queueModelDelivery>[1],
  isSessionActive: () => boolean,
): Promise<void> {
  const delivery = queueModelDelivery(input.state, pending);
  await input.onStateChanged?.();
  if (!isSessionActive()) return;
  await dispatchModelDelivery({
    delivery,
    persist: () => input.onStateChanged?.(),
    deliver: () => delivery.invocationDir && delivery.action
      ? deliverReviewTransmission({
          invocationDir: delivery.invocationDir,
          action: delivery.action,
          message: delivery.message,
          idempotencyKey: delivery.deliveryId,
          deliver: () => delivery.channel === "steer"
            ? sendSteeringPrompt(input.pi, delivery.message)
            : sendFollowUp(input.pi, delivery.message),
        })
      : delivery.channel === "steer"
        ? sendSteeringPrompt(input.pi, delivery.message)
        : sendFollowUp(input.pi, delivery.message),
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

export function formatReviewerAnswer(
  question: string,
  results: ReviewResult[],
  reviewerDisplayLabels?: Record<string, string>,
  bundleDir?: string,
): string {
  const lines = [
    "Reviewer note from /ask-reviewer:",
    "",
    `Question: ${question}`,
  ];
  for (const result of results) {
    const displayLabel = reviewerDisplayLabels?.[result.reviewerId] ?? result.reviewerId;
    lines.push("", `## ${displayLabel} — ${result.verdict}`, "", `Answer: ${result.summary}`);
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

interface CommandReviewAbortOptions {
  cancellation?: ReviewCancellationCoordinator;
  isSessionActive: () => boolean;
  settled: Promise<void>;
  describe: () => string;
  completionMessage: string;
}

function createCommandReviewAbort(
  ctx: unknown,
  sessionSignal: AbortSignal | undefined,
  options: CommandReviewAbortOptions,
): { signal: AbortSignal; cleanup: () => void; acknowledgeCancellation: () => Promise<void>; notifyCancellation: () => Promise<void> } {
  const controller = new AbortController();
  let cancellationNotice: Promise<void> | undefined;
  let cancellationAcknowledgement: Promise<void> | undefined;
  const acknowledgeCancellation = () => {
    if (!options.isSessionActive()) {
      return Promise.resolve();
    }
    if (!cancellationAcknowledgement) {
      cancellationAcknowledgement = sendNotice(
        ctx,
        `review gate: cancelling ${options.describe()}; waiting for reviewer processes to stop`,
      ).catch(() => undefined);
    }
    return cancellationAcknowledgement;
  };
  const notifyCancellation = () => {
    if (!options.isSessionActive()) {
      return Promise.resolve();
    }
    if (!cancellationNotice) {
      cancellationNotice = sendNotice(ctx, options.completionMessage).catch(() => undefined);
    }
    return cancellationNotice;
  };
  const abortFromSession = () => {
    if (!controller.signal.aborted) controller.abort(sessionSignal?.reason ?? "session_shutdown");
  };
  if (sessionSignal?.aborted) abortFromSession();
  sessionSignal?.addEventListener("abort", abortFromSession, { once: true });
  const unsubscribeTerminalInput = onTerminalInput(ctx, (terminalInput) => {
    if (!isEscapeTerminalInput(terminalInput)) return undefined;
    if (!controller.signal.aborted) controller.abort("escape");
    // Immediate acknowledgement only; the completion notice is emitted after
    // the run has returned and cleanup ran.
    void acknowledgeCancellation();
    return { action: "handled", consume: true };
  });
  if (!unsubscribeTerminalInput) {
    options.cancellation?.noteTerminalInterceptionUnavailable((message) => sendNotice(ctx, message));
  }
  const cancellationHandle: ActiveReviewCancellation = {
    requestCancel: (reason = "manual") => {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    acknowledgeCancellation,
    settled: options.settled,
    describe: options.describe,
    notifyCancellation,
  };
  const unregisterCancellation = options.cancellation?.register(cancellationHandle);
  return {
    signal: controller.signal,
    cleanup: () => {
      try {
        unregisterCancellation?.();
      } catch {
        // Cancellation bookkeeping must never mask the review outcome.
      }
      try {
        sessionSignal?.removeEventListener("abort", abortFromSession);
      } catch {
        // Listener removal is best-effort during shutdown.
      }
      try {
        unsubscribeTerminalInput?.();
      } catch {
        // The UI context may already be stale; the review is settled either way.
      }
    },
    acknowledgeCancellation,
    notifyCancellation,
  };
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
