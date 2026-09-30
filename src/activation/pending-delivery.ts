import { dispatchModelDelivery, queueModelDelivery } from "../durable-delivery";
import { sendFollowUp, sendNotice, sendSteeringPrompt } from "../pi";
import { type ReviewRunOutput } from "../review";
import { deliverReviewTransmission, hasReviewDeliveryReceipt, type ReviewTransmissionAction } from "../transmission";
import { rememberUserRequest, type ReviewGateState } from "../state";
import { boundDeliveryDiagnostic, sendNoticeWhileSessionActive } from "./diagnostics";

export async function deliverAutomaticTransmission(
  pi: unknown,
  noticeTarget: unknown,
  state: ReviewGateState,
  output: ReviewRunOutput,
  action: ReviewTransmissionAction,
  message: string,
  isSessionActive: () => boolean,
  persist: () => boolean | Promise<boolean>,
): Promise<void> {
  if (!output.invocationDir) return;
  const delivery = queueModelDelivery(state, {
    kind: "review_transmission",
    channel: "follow_up",
    invocationDir: output.invocationDir,
    action,
    message,
  });
  await persist();
  if (!isSessionActive()) return;
  // dispatchModelDelivery mutates the in-memory status to uncertain before
  // awaiting persistence, so only a persist that resolves while the record is
  // uncertain proves this dispatch durably established the uncertain state.
  // Without that proof the exception must keep propagating: queue/persist
  // failures and pre-existing uncertain records are never masked as
  // transport uncertainty, never noticed as a new uncertainty, and never
  // retried or reverted to queued.
  let durablyUncertain = false;
  try {
    await dispatchModelDelivery({
      delivery,
      persist: async () => {
        const persisted = await persist();
        if (persisted && delivery.status === "uncertain") durablyUncertain = true;
      },
      deliver: () => deliverReviewTransmission({
        invocationDir: output.invocationDir!,
        action,
        message,
        idempotencyKey: delivery.deliveryId,
        deliver: () => isSessionActive() ? sendFollowUp(pi, message) : Promise.resolve(false),
      }),
    });
  } catch (error) {
    if (!durablyUncertain) {
      throw error;
    }
    await sendNoticeWhileSessionActive(
      noticeTarget,
      `review gate: delivery ${delivery.deliveryId} is uncertain and was not retried automatically: ${boundDeliveryDiagnostic(error)}; inspect ${delivery.invocationDir ?? "the resumed session"}`,
      isSessionActive,
    );
  }
}

export async function recoverPendingModelDeliveries(input: {
  pi: unknown;
  state: ReviewGateState;
  persist: () => void | Promise<void>;
  isSessionActive: () => boolean;
  notify: (message: string) => void | Promise<void>;
}): Promise<void> {
  for (const delivery of input.state.pendingModelDeliveries) {
    if (delivery.status === "delivered" || delivery.status === "cancelled") continue;
    if (delivery.kind === "queued_user_input") continue;
    if (delivery.invocationDir && await hasReviewDeliveryReceipt(delivery.invocationDir, delivery.deliveryId)) {
      delivery.status = "delivered";
      delivery.deliveredAt ??= new Date().toISOString();
      delivery.diagnostic = undefined;
      await input.persist();
      continue;
    }
    if (delivery.status === "dispatching" || delivery.status === "uncertain") {
      delivery.status = "uncertain";
      delivery.diagnostic ??= "The prior application ended after dispatch began but before a durable acknowledgement was found.";
      await input.persist();
      await input.notify(`review gate: delivery ${delivery.deliveryId} is uncertain and was not duplicated automatically; inspect ${delivery.invocationDir ?? "the resumed session"}`);
      continue;
    }
    if (!input.isSessionActive()) return;
    try {
      await dispatchModelDelivery({
        delivery,
        persist: input.persist,
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
    } catch (error) {
      await input.notify(`review gate: pending delivery ${delivery.deliveryId} could not be recovered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (input.state.queuedUserInputsDuringReview.length > 0) {
    // Occurrence-aware split: only ledger occurrences backed by an active
    // (non-terminal) durable delivery record can be released when the review
    // finishes; old-only occurrences without one must never be promised a
    // release — they stay preserved until explicitly cancelled.
    const total = input.state.queuedUserInputsDuringReview.length;
    const { releasable, unreleasable } = splitReleasableQueuedInputs(input.state);
    if (unreleasable === 0) {
      await input.notify(`review gate: ${total} user input(s) remain queued from an interrupted review and were not reordered automatically; use /review-now to finish the interrupted review and release them, or /review-clear to cancel them`);
    } else if (releasable === 0) {
      await input.notify(`review gate: ${total} user input(s) remain queued from an interrupted review and were not reordered automatically; none can be released by /review-now because no active durable delivery record exists for them; they stay preserved until cancelled with /review-clear`);
    } else {
      await input.notify(`review gate: ${total} user input(s) remain queued from an interrupted review and were not reordered automatically; ${releasable} of them can be released by finishing the interrupted review with /review-now, but ${unreleasable} cannot be released automatically because no active durable delivery record exists for them; all of them stay preserved until cancelled with /review-clear`);
    }
  }
}

/**
 * Split queued-input ledger occurrences into those backed by an active
 * (non-terminal) durable delivery record — releasable when the review
 * finishes — and old-only occurrences without one, which can never be
 * dispatched. Occurrence-based so repeated texts count correctly.
 */
function splitReleasableQueuedInputs(state: ReviewGateState): { releasable: number; unreleasable: number } {
  const activeByMessage = new Map<string, number>();
  for (const delivery of state.pendingModelDeliveries) {
    if (delivery.kind === "queued_user_input" && delivery.status !== "delivered" && delivery.status !== "cancelled") {
      activeByMessage.set(delivery.message, (activeByMessage.get(delivery.message) ?? 0) + 1);
    }
  }
  let releasable = 0;
  for (const message of state.queuedUserInputsDuringReview) {
    const active = activeByMessage.get(message) ?? 0;
    if (active > 0) {
      activeByMessage.set(message, active - 1);
      releasable += 1;
    }
  }
  return { releasable, unreleasable: state.queuedUserInputsDuringReview.length - releasable };
}

export async function releaseQueuedUserInputs(
  pi: unknown,
  state: ReviewGateState,
  isSessionActive: () => boolean,
  persist: () => void | Promise<void>,
): Promise<void> {
  state.reviewInProgress = false;
  // Old-only ledger occurrences without an active durable delivery record can
  // never be dispatched; identify them explicitly instead of silently
  // skipping — their contents stay preserved until the user cancels them.
  if (isSessionActive()) {
    const { unreleasable } = splitReleasableQueuedInputs(state);
    if (unreleasable > 0) {
      await sendNotice(
        pi,
        `review gate: ${unreleasable} queued user input(s) were not released because no active durable delivery record exists for them; they stay preserved and can be cancelled with /review-clear`,
      );
    }
  }
  for (const delivery of state.pendingModelDeliveries.filter((candidate) =>
    candidate.kind === "queued_user_input" && candidate.status !== "delivered" && candidate.status !== "cancelled")) {
    if (!isSessionActive()) return;
    rememberUserRequest(state, delivery.message);
    try {
      const delivered = await dispatchModelDelivery({
        delivery,
        persist,
        deliver: () => isSessionActive() ? sendFollowUp(pi, delivery.message) : Promise.resolve(false),
      });
      if (!delivered) return;
      const index = state.queuedUserInputsDuringReview.indexOf(delivery.message);
      if (index >= 0) state.queuedUserInputsDuringReview.splice(index, 1);
      await persist();
    } catch {
      return;
    }
  }
}
