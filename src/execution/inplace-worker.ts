/**
 * Compatibility facade for the in-place worker API. Implementation details
 * live in the cohesive internal modules under ./inplace.
 */
export { createInPlaceBaseline, computeInPlaceAttribution, inPlaceDeltaIdentity } from "./inplace/basis";
export type { InPlaceBaseline, InPlaceAttribution } from "./inplace/basis";
export { INPLACE_BASELINE_FILE, persistInPlaceBaseline, loadInPlaceBaseline } from "./inplace/baseline-store";
export { buildInPlaceReviewRequest, buildInPlacePrompt, buildInPlaceContinuationDisclosure } from "./inplace/prompts";
export { assertInPlaceArtifactOutsideWorkspace } from "./inplace/containment";
export { nextInPlaceReviewCycle } from "./inplace/review-records";
export type { InPlaceReviewCycleRecord } from "./inplace/review-records";
export { runInplaceLifecycle } from "./inplace/coordinator";
export type {
  InPlaceRunInput,
  InPlaceWorkerResult,
  InPlaceLifecycleStatus,
  InPlaceReviewCycle,
  InPlaceLifecycleResult,
  InPlaceLifecycleInput,
} from "./inplace/contracts";
