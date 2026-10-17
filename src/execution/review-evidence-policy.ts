import type { EffectiveReviewEvidenceSettings } from "../config";
import type { ReviewEvidencePolicy } from "../review-evidence";
import type { BackgroundTaskKind } from "./task-state";

export type WorkerReviewEvidenceScope = Exclude<ReviewEvidencePolicy["scope"], "primary">;

/** The shared policy, restricted to scopes admitted by worker tasks. */
export type WorkerReviewEvidencePolicy = Omit<ReviewEvidencePolicy, "scope"> & {
  scope: WorkerReviewEvidenceScope;
};

/** Legacy tasks without a persisted policy retain the historical snapshot path. */
export const DEFAULT_WORKER_REVIEW_EVIDENCE_POLICY: Readonly<WorkerReviewEvidencePolicy> = Object.freeze({
  toolOnly: false,
  snapshotFailureFallback: false,
  scope: "worktree",
});

export function workerReviewEvidenceScope(kind: BackgroundTaskKind | undefined): WorkerReviewEvidenceScope {
  return kind === "inplace" ? "inplace" : "worktree";
}

/** Capture only this worker's applicable evidence choice; reviewer and route settings stay live. */
export function captureWorkerReviewEvidencePolicy(
  settings: EffectiveReviewEvidenceSettings,
  kind: BackgroundTaskKind,
): WorkerReviewEvidencePolicy {
  const toolOnly = kind === "inplace"
    ? settings.inplaceToolOnly
    : kind === "execute"
      ? settings.worktreeToolOnly
      : false;
  const reviewApplies = kind === "execute" || kind === "inplace";
  return {
    toolOnly,
    snapshotFailureFallback: reviewApplies && settings.snapshotFailureFallback,
    scope: workerReviewEvidenceScope(kind),
  };
}

/** Validate durable policy without importing newer settings into legacy tasks. */
export function normalizeWorkerReviewEvidencePolicy(
  value: unknown,
  expectedScope?: WorkerReviewEvidenceScope,
): WorkerReviewEvidencePolicy {
  if (value === undefined) return { ...DEFAULT_WORKER_REVIEW_EVIDENCE_POLICY, ...(expectedScope ? { scope: expectedScope } : {}) };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Task review evidence policy is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const storedScope = candidate.scope;
  if (Object.keys(candidate).some((key) => key !== "toolOnly" && key !== "snapshotFailureFallback" && key !== "scope")
    || typeof candidate.toolOnly !== "boolean"
    || typeof candidate.snapshotFailureFallback !== "boolean"
    || (storedScope !== undefined && storedScope !== "worktree" && storedScope !== "inplace")
    || (expectedScope !== undefined && storedScope !== undefined && storedScope !== expectedScope)) {
    throw new Error("Task review evidence policy is invalid.");
  }
  return {
    toolOnly: candidate.toolOnly,
    snapshotFailureFallback: candidate.snapshotFailureFallback,
    scope: expectedScope ?? (storedScope as WorkerReviewEvidenceScope | undefined) ?? "worktree",
  };
}
