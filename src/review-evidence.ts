import { effectiveReviewEvidenceSettings, type ReviewGateConfig } from "./config";
import { compareFileSnapshots, createPathSnapshot, type ChangedFile } from "./capture";
import { extractCandidatePaths, type EvidenceState } from "./evidence";
import { expandHomePath } from "./apply-patch/paths";
import { resolve } from "node:path";
import { redactSensitiveText } from "./redaction";

/** Per-invocation policy. Worker callers must pass their captured scope explicitly. */
export interface ReviewEvidencePolicy {
  toolOnly: boolean;
  snapshotFailureFallback: boolean;
  scope: "primary" | "worktree" | "inplace";
}
export type ReviewEvidenceMethod = "snapshot" | "tool-only" | "tool-only-fallback";
export const TOOL_ONLY_HISTORY_NOTICE = "Earlier work has tool-only evidence: no pre-work snapshot covers that interval. A new snapshot baseline covers subsequent work only; earlier actions and claims are not exact-snapshot certification.";
export function primaryEvidencePolicy(config: ReviewGateConfig): ReviewEvidencePolicy {
  const settings = effectiveReviewEvidenceSettings(config);
  return { toolOnly: settings.primaryToolOnly, snapshotFailureFallback: settings.snapshotFailureFallback, scope: "primary" };
}
export function evidenceMethodNotice(method: ReviewEvidenceMethod): string {
  return method === "snapshot" ? "Review evidence method: snapshot."
    : `WARNING: Review evidence method: ${method}. ${method === "tool-only-fallback" ? "Automatic snapshot capture failed; CURRENT tool evidence was preserved, not reset. " : ""}Available observed tool evidence and supplied claims/context are assessed with their disclosed limits; missing observations are not proof of no effects. This is NOT certification of an exact workspace snapshot. Unobserved external edits are outside this review.`;
}

/** Raised only by acquisition stages, never baseline verification/comparison/cleanup. */
export class ReviewEvidenceCaptureFailure extends Error {}

/** Call only on an actual capture/arm outcome, never load/compare/cleanup. */
export function isEligibleReviewCaptureFailure(result: { status: string; reason?: string; evidenceCaptureFailure?: unknown }): boolean {
  return result.status === "failed" && result.evidenceCaptureFailure === true
    && ["raw_checkpoint_failed", "patch_too_large", "untracked_too_large", "untracked_unreadable"].includes(result.reason ?? "");
}

/** Retain post-tool observations on the canonical candidates, not a mirrored dataset.
 * No settlement-time filesystem reads: later external writes cannot alter this evidence. */
export async function retainPrimaryToolAfter(input: {
  state: EvidenceState; cwd: string; toolName: string; toolInput?: Record<string, unknown>; config: ReviewGateConfig;
}): Promise<void> {
  for (const { path } of extractCandidatePaths(input.toolName, input.toolInput).paths) {
    const candidate = input.state.candidates.get(resolve(input.cwd, expandHomePath(path)));
    if (!candidate) continue;
    try {
      const after = await createPathSnapshot(input.cwd, candidate.absolutePath, {
        maxFileBytes: input.config.maxFileBytes, maxSnapshotBytes: input.config.maxSnapshotBytes,
      });
      const retainedBytes = [...input.state.candidates.values()].reduce((bytes, other) =>
        bytes + (other === candidate ? 0 : Buffer.byteLength(other.afterSnapshot?.content ?? "", "utf8")), 0);
      const content = after.content === undefined ? undefined : redactSensitiveText(after.content);
      const omitted = content !== undefined && Buffer.byteLength(content, "utf8") > Math.max(0, input.config.maxSnapshotBytes - retainedBytes);
      candidate.afterSnapshot = { ...after,
        ...(omitted ? { content: undefined, omittedReason: "snapshot_limit" as const }
          : content !== undefined ? { content } : {}),
      };
      candidate.afterContentTruncated = omitted ? true : undefined;
      candidate.afterError = undefined;
      if (!candidate.baseline || candidate.baselineError) input.state.requiresReview = true;
    } catch {
      candidate.afterSnapshot = undefined;
      candidate.afterError = "Post-tool content could not be retained; observed tool events remain available.";
      input.state.requiresReview = true;
    }
  }
}

/** Consume retained canonical before/after observations only. */
export function retainedToolChanges(evidence: EvidenceState | undefined, exchangeSequence?: number): ChangedFile[] {
  const changes: ChangedFile[] = [];
  for (const candidate of evidence?.candidates.values() ?? []) {
    const before = exchangeSequence === undefined ? candidate.baseline : candidate.exchangeBaselines.get(exchangeSequence)?.snapshot;
    if (!before || !candidate.afterSnapshot) continue;
    const change = compareFileSnapshots(before, candidate.afterSnapshot);
    if (change) changes.push({ ...change,
      ...(change.oldContent !== undefined ? { oldContent: redactSensitiveText(change.oldContent) } : {}),
      ...(change.newContent !== undefined ? { newContent: redactSensitiveText(change.newContent) } : {}),
    });
  }
  return changes;
}
