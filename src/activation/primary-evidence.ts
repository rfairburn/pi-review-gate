import { randomUUID } from "node:crypto";
import { type ReviewGateConfig } from "../config";
import { createEvidenceState } from "../evidence";
import { captureReviewCheckpoint, releaseReviewCheckpoint } from "../review-checkpoint";
import { primaryEvidencePolicy, evidenceMethodNotice, evidenceMethodLabel, TOOLS_ONLY_LABEL, WORKSPACE_CHANGES_LABEL, isEligibleReviewCaptureFailure } from "../review-evidence";
import type { ReviewBaseline, ReviewGateState } from "../state";
import { sendNotice } from "../pi";

/** Always-on native UI and model channels, never an optional notice tool. */
export async function sendPrimaryEvidenceWarning(pi: unknown, target: unknown, message: string): Promise<void> {
  await sendNotice(target, message);
  if (typeof pi === "object" && pi !== null && "sendMessage" in pi && typeof pi.sendMessage === "function") {
    await pi.sendMessage({ customType: "pi-review-evidence-policy", content: message, display: true }, { triggerTurn: false });
  }
}

/** Settings application only: menu navigation/cancel never invokes this path. */
export function createPrimaryEvidenceSettings(input: {
  config: ReviewGateConfig; state: ReviewGateState; cwd: () => string;
  persist: () => Promise<void>; warn: (message: string) => Promise<void>;
  reviewActive?: () => boolean;
}) {
  let applied = primaryEvidencePolicy(input.config).toolOnly;
  let deferredNotice = false;
  let pendingCompletion: { persisted: boolean; warning: string } | undefined;
  let applyTail: Promise<void> = Promise.resolve();
  const deferForReview = async (): Promise<void> => {
    if (!deferredNotice) await input.warn(`WARNING: Primary evidence method change ${evidenceMethodLabel(applied)} → ${evidenceMethodLabel(primaryEvidencePolicy(input.config).toolOnly)} is pending until the running review settles. Its captured policy and evidence remain unchanged; the transition will apply before the next Primary run or manual review.`);
    deferredNotice = true;
  };
  const completeTransition = async (): Promise<void> => {
    const pending = pendingCompletion;
    if (!pending) return;
    if (!pending.persisted) {
      await input.persist();
      pending.persisted = true;
    }
    await input.warn(pending.warning);
    pendingCompletion = undefined;
  };
  const apply = async (): Promise<void> => {
    // Mutation and completion are distinct: failure here blocks work, but a
    // retry must never discard observations collected after the original reset.
    await completeTransition();
    const policy = primaryEvidencePolicy(input.config);
    const next = policy.toolOnly;
    if (next === applied) { deferredNotice = false; return; }
    if (input.state.reviewInProgress || input.reviewActive?.()) {
      await deferForReview();
      return;
    }
    const windows = [...new Set([input.state.reviewWindow, input.state.lastQuestionWindow].filter((window) => window !== undefined))];
    const captureCwd = input.cwd();
    const captureScope = { scope: input.state.checkpointScope };
    let baseline: ReviewBaseline;
    let disableFellBack = false;
    if (next) baseline = { kind: "tool", cwd: captureCwd, capturedAt: new Date().toISOString() };
    else {
      const captured = await captureReviewCheckpoint(captureCwd, `policy-${randomUUID()}`, captureScope);
      // Review ownership can begin while capture yields. Never publish this
      // now-unused basis into the window owned by that invocation.
      if (input.state.reviewInProgress || input.reviewActive?.()) {
        if (captured.status === "ok") {
          const released = await releaseReviewCheckpoint(captureCwd, captured.value, captureScope);
          if (released.status !== "ok") throw new Error(`review gate: deferred policy baseline cleanup failed (${released.reason}): ${released.detail}`);
        }
        await deferForReview();
        return;
      }
      if (captured.status !== "ok") {
        if (!policy.snapshotFailureFallback || !isEligibleReviewCaptureFailure(captured)) throw new Error(`review gate: Primary ${TOOLS_ONLY_LABEL} → ${WORKSPACE_CHANGES_LABEL} could not establish a new snapshot baseline (${captured.reason}); prior evidence retained; repair and retry before further work`);
        // Apply the snapshot preference without inventing a pre-work snapshot.
        // A later review retries capture; this is actual fallback, never reset.
        baseline = { kind: "tool", cwd: captureCwd, capturedAt: new Date().toISOString(), fallback: true };
        disableFellBack = true;
      } else baseline = { kind: "checkpoint", descriptor: captured.value, cwd: captureCwd, capturedAt: new Date().toISOString(), toolOnlyHistory: true };
    }
    for (const window of windows) {
      if (next) {
        // Keep task direction and delivery bookkeeping; old review material is
        // not reusable as certification for the explicitly reset window.
        const acceptedReviewerQuestions = window.evidence.acceptedReviewerQuestions;
        window.evidence = createEvidenceState();
        window.evidence.acceptedReviewerQuestions = acceptedReviewerQuestions;
        window.exchanges = [];
        // Review findings, correction budgets/authorizations, accepted direction,
        // invocation numbering, immutable prior artifacts and delivery ledgers
        // are authority/history, not disposable collected tool evidence.
      }
      window.baseline = baseline;
      if (window.activeExchange) {
        window.activeExchange.baseline = baseline;
        if (next) {
          window.activeExchange.evidenceEventStart = 0;
          window.activeExchange.assistantSummaryStart = 0;
        }
      }
    }
    // No window needs a checkpoint when disabling before any work exists.
    // Reuse the captured basis by opening a window only when one already exists;
    // otherwise release its positively owned descriptor.
    if (!windows.length && baseline.kind === "checkpoint") {
      const released = await releaseReviewCheckpoint(captureCwd, baseline.descriptor, captureScope);
      if (released.status !== "ok") throw new Error("review gate: unused policy baseline cleanup failed");
    }
    applied = next;
    deferredNotice = false;
    pendingCompletion = { persisted: false, warning: next
      ? `WARNING: Primary evidence method changed: ${WORKSPACE_CHANGES_LABEL} → ${TOOLS_ONLY_LABEL}. CURRENT Primary collected evidence was RESET; outstanding reviewer findings, correction requirements and pending deliveries remain in force. Existing files are not retrospectively reviewed. ${evidenceMethodNotice("tool-only")}`
      : disableFellBack
        ? `Primary evidence preference changed: ${TOOLS_ONLY_LABEL} → ${WORKSPACE_CHANGES_LABEL}, but a new snapshot baseline could not be acquired; snapshot capture will be retried. ${evidenceMethodNotice("tool-only-fallback")}`
        : `Primary evidence method changed: ${TOOLS_ONLY_LABEL} → ${WORKSPACE_CHANGES_LABEL}. Existing tool evidence was retained and a NEW snapshot baseline established; subsequent workspace changes will be reviewed with snapshots. Earlier ${TOOLS_ONLY_LABEL} reviews do not certify that baseline.` };
    await completeTransition();
  };
  const enqueue = (action: () => Promise<void>): Promise<void> => {
    const operation = applyTail.then(action);
    applyTail = operation.catch(() => undefined);
    return operation;
  };
  return Object.assign(() => enqueue(apply), {
    // Existing runs can issue another tool without before_agent_start. Admit
    // it only after an already-mutated transition's mandatory completion; do
    // not apply a new/deferred preference from this tool-admission seam.
    completePending: () => pendingCompletion ? enqueue(completeTransition) : undefined,
  });
}
