import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewRunOutput } from "../../review";
import { atomicWrite, atomicWriteExclusive } from "../durable-write";
import type { InPlaceAttribution } from "./basis";

// ── durable in-place review cycle records ────────────────────────────────────

/** Shape of the per-reviewer record inside a durable in-place review cycle. */
export interface InPlaceReviewCycleRecord {
  version: 1;
  taskId: string;
  waveId: "inplace";
  cycle: number;
  reviewSequence: number;
  /** Tool-observation identity, independent of the exact workspace delta identity. */
  toolObservationRevision: number;
  completedAt: string;
  /** Identity marker: distinguishes in-place records from wave candidate records. */
  inPlace: true;
  attribution: {
    workspaceRoot: string;
    baseline: {
      mode: "git" | "non_git" | "tool";
      gitHead?: string;
      capturedAt: string;
    };
    changedSinceLaunch: Array<{ status: string; path: string }>;
    /** SHA-256 of the content-anchored delta identity that was under review. */
    deltaIdentitySha256: string;
  };
  evidenceMethod?: import("../../review-evidence").ReviewEvidenceMethod;
  evidenceCoverageNotice?: string;
  aggregate: import("../../review-report").ReviewAggregateDisposition;
  summary: string;
  reviewers: import("../../review-report").ReviewCycleRecord["reviewers"];
}

export function buildInPlaceReviewCycleRecord(input: {
  taskId: string;
  cycle: number;
  reviewSequence: number;
  attribution: InPlaceAttribution;
  deltaIdentitySha256: string;
  toolObservationRevision: number;
  reviewOutput: ReviewRunOutput;
}): InPlaceReviewCycleRecord {
  const gate = input.reviewOutput.result;
  const reviewers = (input.reviewOutput.reviewerResults ?? (gate ? [gate] : [])).map((reviewer) => ({
    reviewerId: reviewer.reviewerId,
    ...(reviewer.displayLabel !== undefined ? { displayLabel: reviewer.displayLabel } : {}),
    verdict: reviewer.verdict,
    summary: reviewer.summary,
    ...(reviewer.guidance !== undefined ? { guidance: reviewer.guidance } : {}),
    ...(reviewer.verdict === "error" && reviewer.error !== undefined ? { error: reviewer.error } : {}),
    findings: reviewer.findings.map((finding) => ({
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      issue: finding.issue,
      recommendation: finding.recommendation,
    })),
  }));
  return {
    version: 1,
    taskId: input.taskId,
    waveId: "inplace",
    cycle: input.cycle,
    reviewSequence: input.reviewSequence ?? input.cycle,
    toolObservationRevision: input.toolObservationRevision,
    completedAt: new Date().toISOString(),
    inPlace: true,
    evidenceMethod: input.reviewOutput.evidenceMethod ?? input.attribution.evidenceMethod ?? "snapshot",
    evidenceCoverageNotice: input.reviewOutput.evidenceCoverageNotice ?? input.attribution.evidenceCoverageNotice,
    attribution: {
      workspaceRoot: input.attribution.baseline.workspaceRoot,
      baseline: {
        mode: input.attribution.baseline.mode,
        ...(input.attribution.baseline.gitHead ? { gitHead: input.attribution.baseline.gitHead } : {}),
        capturedAt: input.attribution.baseline.capturedAt,
      },
      changedSinceLaunch: input.attribution.changes.map((change) => ({ status: change.status, path: change.path })),
      deltaIdentitySha256: input.deltaIdentitySha256,
    },
    aggregate: gate?.verdict === "pass" || gate?.verdict === "needs_changes" || gate?.verdict === "error"
      ? gate.verdict
      : "error",
    summary: gate?.summary ?? "Review completed without a gate result.",
    reviewers,
  };
}

/**
 * Write-once publication of one in-place cycle record, mirroring the #50
 * wave policy: an existing record is never overwritten, and a failed
 * publication leaves an explicit `.unpublished` marker instead of a silent
 * gap that would present an older readable cycle as current.
 */
/**
 * Allocate the next in-place review cycle number from the task's DURABLE
 * review artifacts (#220 pass-2, finding 2): both cycle records and their
 * unpublished markers count, so a resumed lifecycle never restarts at 1 and
 * never collides with a settled cycle's write-once record.
 */
export async function nextInPlaceReviewCycle(artifactDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(join(artifactDir, "reviews", "inplace"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return 1;
    throw error;
  }
  return 1 + names.reduce((highest, name) => {
    const match = /^cycle-(\d{6})\.json(?:\.unpublished)?$/.exec(name);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
}

export async function persistInPlaceReviewCycleRecord(artifactDir: string, record: InPlaceReviewCycleRecord): Promise<void> {
  const path = join(artifactDir, "reviews", record.waveId, `cycle-${String(record.cycle).padStart(6, "0")}.json`);
  try {
    await atomicWriteExclusive(path, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    // #220 pass-2 (finding 2): an existing cycle file is a NUMBERING
    // collision for a NEW cycle — never successful publication. The caller
    // fails closed; the write-once semantics are enforced by the caller being
    // unable to skip or overwrite the prior record. Publication failures for
    // a genuinely-new cycle still leave the bounded unpublished marker.
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") throw error;
    try {
      await atomicWriteExclusive(
        `${path}.unpublished`,
        `${JSON.stringify({
          version: 1,
          taskId: record.taskId,
          waveId: record.waveId,
          cycle: record.cycle,
          reviewSequence: record.reviewSequence,
          completedAt: record.completedAt,
          inPlace: true,
          aggregate: record.aggregate,
          summary: record.summary,
          reason: error instanceof Error ? `${error.message}`.slice(0, 200) : "publication failed",
        }, null, 2)}\n`,
      );
    } catch {
      // Both writes failed: readers report the newest readable cycle as latest
      // available with unknown completeness, never definitively current.
    }
  }
}

// ── durable review-activity boundary (automatic review gating) ──────────────

export const INPLACE_REVIEW_ACTIVITY_FILE = "review-activity.json";

/** The last completed (pass/needs_changes) review and what happened since it. */
export interface InPlaceReviewActivity {
  version: 1;
  taskId: string;
  /** Work is in progress, or the retained review boundary remains unverifiable. */
  inFlight: boolean;
  /** Some turn since the last review ran on an adapter without a structured tool stream. */
  unobservedSinceReview: boolean;
  qualifyingSinceReview: boolean;
  lastReview?: {
    cycle: number;
    verdict: "pass" | "needs_changes";
    toolObservationsTruncated: boolean;
    requiresReview: boolean;
    identity: string;
    changedSinceLaunch: Array<{ status: string; path: string }>;
  };
}

export async function persistInPlaceReviewActivity(artifactDir: string, activity: InPlaceReviewActivity): Promise<void> {
  await atomicWrite(join(artifactDir, INPLACE_REVIEW_ACTIVITY_FILE), `${JSON.stringify(activity, null, 2)}\n`);
}

/** Undefined when absent, unreadable, malformed, or foreign: callers treat that as unknown, never as no activity. */
export async function loadInPlaceReviewActivity(artifactDir: string, taskId: string): Promise<InPlaceReviewActivity | undefined> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(artifactDir, INPLACE_REVIEW_ACTIVITY_FILE), "utf8")); }
  catch { return undefined; }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.taskId !== taskId || typeof record.inFlight !== "boolean"
    || typeof record.unobservedSinceReview !== "boolean" || typeof record.qualifyingSinceReview !== "boolean") return undefined;
  const last = record.lastReview as Record<string, unknown> | undefined;
  if (last !== undefined && (!last || typeof last !== "object"
    || !Number.isSafeInteger(last.cycle) || (last.verdict !== "pass" && last.verdict !== "needs_changes")
    || typeof last.toolObservationsTruncated !== "boolean" || typeof last.requiresReview !== "boolean"
    || typeof last.identity !== "string" || !Array.isArray(last.changedSinceLaunch)
    || !last.changedSinceLaunch.every((change: unknown) => !!change && typeof change === "object"
      && typeof (change as Record<string, unknown>).status === "string" && typeof (change as Record<string, unknown>).path === "string"))) {
    return undefined;
  }
  return record as unknown as InPlaceReviewActivity;
}
