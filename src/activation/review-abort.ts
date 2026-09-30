import { isEscapeTerminalInput, onTerminalInput, sendNotice } from "../pi";
import { type ActiveReviewCancellation, type ReviewCancelReason, type ReviewCancellationCoordinator } from "../review-cancellation";
import { type ReviewGateState } from "../state";

type ReviewAbortReason = "parent" | "escape" | "manual" | "session_shutdown";

export interface ReviewAbortHandle {
  signal: AbortSignal;
  cleanup: () => void;
  getReason: () => ReviewAbortReason | undefined;
  notifyCancellation: () => Promise<void>;
  shutdown: () => void;
}

export function createReviewAbortController(input: {
  signal: AbortSignal | undefined;
  noticeTarget: unknown;
  state: ReviewGateState;
  isSessionActive: () => boolean;
  cancellation: ReviewCancellationCoordinator;
  settled: Promise<void>;
  describe: () => string;
}): ReviewAbortHandle {
  const controller = new AbortController();
  let abortReason: ReviewAbortReason | undefined;
  let cancellationNotice: Promise<void> | undefined;
  let cancellationAcknowledgement: Promise<void> | undefined;
  let cleanedUp = false;

  const abortReview = (reason: ReviewAbortReason) => {
    if (!controller.signal.aborted) {
      abortReason = reason;
      controller.abort(reason);
    }
  };
  const acknowledgeCancellation = () => {
    if (!input.isSessionActive()) {
      return Promise.resolve();
    }
    if (!cancellationAcknowledgement) {
      cancellationAcknowledgement = sendNotice(
        input.noticeTarget,
        `review gate: cancelling ${input.describe()}; waiting for reviewer processes to stop`,
      ).catch(() => undefined);
    }
    return cancellationAcknowledgement;
  };
  const notifyCancellation = () => {
    if (abortReason !== "escape" && abortReason !== "manual") {
      return Promise.resolve();
    }
    if (!input.isSessionActive()) {
      return Promise.resolve();
    }
    if (!cancellationNotice) {
      cancellationNotice = sendNotice(input.noticeTarget, "review gate: review cancelled; reviewer processes stopped").catch(() => undefined);
    }
    return cancellationNotice;
  };
  const abortFromParent = () => abortReview("parent");

  if (input.signal?.aborted) {
    abortFromParent();
  }
  input.signal?.addEventListener("abort", abortFromParent, { once: true });

  const unsubscribeTerminalInput = onTerminalInput(input.noticeTarget, (terminalInput) => {
    if (!input.state.reviewInProgress || !isEscapeTerminalInput(terminalInput)) {
      return undefined;
    }
    abortReview("escape");
    // Immediate acknowledgement only; the completion notice claims reviewer
    // quiescence only after runReview has returned and cleanup ran.
    void acknowledgeCancellation();
    return { action: "handled", consume: true };
  });
  if (!unsubscribeTerminalInput) {
    input.cancellation.noteTerminalInterceptionUnavailable((message) => sendNotice(input.noticeTarget, message));
  }

  const cancellationHandle: ActiveReviewCancellation = {
    requestCancel: (reason: ReviewCancelReason = "manual") => abortReview(reason),
    acknowledgeCancellation,
    settled: input.settled,
    describe: input.describe,
    notifyCancellation,
  };
  const unregisterCancellation = input.cancellation.register(cancellationHandle);

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    unregisterCancellation();
    try {
      input.signal?.removeEventListener("abort", abortFromParent);
    } catch {
      // Listener removal must never mask the review outcome.
    }
    try {
      unsubscribeTerminalInput?.();
    } catch {
      // The UI context may already be stale; the review is settled either way.
    }
  };

  return {
    signal: controller.signal,
    cleanup,
    getReason: () => abortReason,
    notifyCancellation,
    shutdown: () => {
      abortReview("session_shutdown");
      cleanup();
    },
  };
}
