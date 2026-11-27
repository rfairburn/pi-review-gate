/**
 * The recording steps a completed review shares between every host that runs
 * one.
 *
 * A finished {@link runReview} has already produced its verdict, its immutable
 * bundle, and its reviewed after-baseline descriptor. What is left is a single
 * host-shaped act: render the model-visible transmission from the bundle, and
 * record the reviewer's feedback into the review window so the next turn is
 * reviewed against what was just reviewed. Both halves have to happen together
 * and in this order — recording before the message exists would arm a response
 * exchange the model was never told about, and messaging before recording would
 * arm it against a baseline that is not owned yet.
 *
 * They are exposed separately as well as composed, because a host may have to
 * do work with the rendered message BEFORE the feedback counts as delivered.
 * A native row's review travels as a bounded transport field, so its
 * coordinator renders, normalizes and bounds the text, and confirms the request
 * is still alive, and only then records; a host that persists its state has
 * nothing to check in between and uses the composed call.
 *
 * This module exists so a second host (the native row coordinator in
 * ./session-host/native-review-coordinator) performs exactly this step without
 * importing the Pi activation path, and so the Pi path and that host can never
 * drift apart on what "the review was transmitted" means. It carries no Pi
 * import: everything here is state, transmission rendering, and the run output.
 *
 * Durability is deliberately NOT part of this step. A caller that persists
 * state owns when the save happens and what a failed save means; the release
 * rule a caller must apply when this rejects is documented at the call site,
 * because it depends on whether the caller ever made the new descriptor
 * reachable from its own state.
 */

import type { ReviewRunOutput } from "./review";
import { recordReviewerFeedbackAndArmExchange, type ReviewGateState } from "./state";
import { createReviewTransmissionMessage, type ReviewTransmissionAction } from "./transmission";

/** One transmission's recording intent: who asked, and what the verdict does. */
export interface ReviewTransmissionPass {
  state: ReviewGateState;
  output: ReviewRunOutput;
  source: "automatic" | "manual";
  disposition: "sent_for_correction" | "sent_for_observation" | "sent_at_cap" | "sent_review_error";
  action: ReviewTransmissionAction;
}

/**
 * Render the exact model-visible transmission for one finished review, without
 * recording anything. A rejection means the review produced no deliverable
 * message and nothing was recorded.
 */
export function renderReviewTransmissionMessage(input: {
  output: ReviewRunOutput;
  action: ReviewTransmissionAction;
}): Promise<string> {
  return createReviewTransmissionMessage({
    evidenceMethod: input.output.evidenceMethod,
    evidenceCoverageNotice: input.output.evidenceCoverageNotice,
    invocationDir: input.output.invocationDir!,
    reviewSequence: input.output.reviewSequence!,
    gateVerdict: input.output.result!.verdict,
    reviewerResults: input.output.reviewerResults!,
    bundleDir: input.output.bundleDir!,
    action: input.action,
  });
}

/**
 * Record the reviewer's feedback into the window and arm the response exchange
 * the reviewed baseline belongs to. Call this only once the rendered message is
 * genuinely going to its reader: arming a response exchange for feedback that
 * was never delivered makes the next turn look like an answered correction.
 */
export function recordReviewTransmissionPass(input: {
  state: ReviewGateState;
  output: ReviewRunOutput;
  source: "automatic" | "manual";
  disposition: ReviewTransmissionPass["disposition"];
}): void {
  recordReviewerFeedbackAndArmExchange(input.state, {
    result: input.output.result!,
    reviewerResults: input.output.reviewerResults,
    reviewSequence: input.output.reviewSequence,
    source: input.source,
    disposition: input.disposition,
    reviewedBaseline: input.output.reviewedBaseline!,
    displayLabels: input.output.reviewerDisplayLabels,
  });
}

/**
 * Render the transmission for one finished review, then record its feedback and
 * arm the response exchange. Returns the exact message the model is shown, so
 * the caller can deliver the same text it recorded.
 *
 * A rejection means nothing was recorded, and the run output's
 * `releaseReviewedBaseline` is still the caller's to call — unless the caller
 * already made that descriptor reachable from its own state, in which case it
 * must retain it instead of deleting a live reference.
 */
export async function transmitReviewPass(input: ReviewTransmissionPass): Promise<string> {
  const message = await renderReviewTransmissionMessage({ output: input.output, action: input.action });
  recordReviewTransmissionPass(input);
  return message;
}
