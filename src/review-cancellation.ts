export type ReviewCancelReason = "escape" | "manual";

/**
 * A currently-running review registered with the session-wide cancellation
 * coordinator. Exactly one handle exists per active review run (automatic or
 * command-driven); it becomes visible to /review-cancel for the whole window
 * between review startup and post-run cleanup.
 */
export interface ActiveReviewCancellation {
  /**
   * Abort the review. Safe to call repeatedly; later calls are no-ops.
   * `reason` is recorded on the underlying AbortSignal.
   */
  requestCancel: (reason?: ReviewCancelReason) => void;
  /**
   * Immediate cancellation-request feedback ("cancelling … waiting for
   * reviewer processes to stop"). Deliberately does not claim that reviewer
   * processes have stopped; quiescence is claimed only by `notifyCancellation`
   * after the owning run returned.
   */
  acknowledgeCancellation: () => Promise<void>;
  /**
   * Resolves only after the owning runReview/runAskReviewer call has returned
   * (reviewer child processes terminated or reaped) and the terminal-input
   * listener was removed. Completion feedback must wait for this.
   */
  settled: Promise<void>;
  /** Human-readable description, e.g. "automatic review" or "/review-now". */
  describe: () => string;
  /** Final completion notice; idempotent and safe to call from multiple paths. */
  notifyCancellation: () => Promise<void>;
}

export interface ReviewCancellationCoordinator {
  register(handle: ActiveReviewCancellation): () => void;
  /** The most recently registered still-active review, if any. */
  current(): ActiveReviewCancellation | undefined;
  /**
   * Sends the actionable /review-cancel fallback diagnostic exactly once per
   * session when terminal Escape interception could not be installed.
   */
  noteTerminalInterceptionUnavailable(notify: (message: string) => unknown): void;
}

export const terminalInterceptionFallbackMessage =
  "review gate: Escape cannot cancel reviews in this terminal context (terminal input interception is unavailable); use /review-cancel to stop an active review";

export function createReviewCancellationCoordinator(): ReviewCancellationCoordinator {
  const active: ActiveReviewCancellation[] = [];
  let fallbackAdvised = false;
  return {
    register(handle: ActiveReviewCancellation): () => void {
      active.push(handle);
      return () => {
        const index = active.indexOf(handle);
        if (index >= 0) {
          active.splice(index, 1);
        }
      };
    },
    current(): ActiveReviewCancellation | undefined {
      return active.at(-1);
    },
    noteTerminalInterceptionUnavailable(notify: (message: string) => unknown): void {
      if (fallbackAdvised) {
        return;
      }
      fallbackAdvised = true;
      try {
        void Promise.resolve(notify(terminalInterceptionFallbackMessage)).catch(() => undefined);
      } catch {
        // Notification channels may be stale during shutdown; the /review-cancel
        // command remains available regardless.
      }
    },
  };
}