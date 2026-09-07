import type { ReviewRunOutput } from "./review";
import type { ReviewFinding, ReviewResult } from "./schema";
import type { ReviewFeedbackContext } from "./state";

export type ReviewAggregateDisposition = "pass" | "pass_with_warnings" | "needs_changes" | "error";

export interface ReviewerEvidence {
  reviewerId: string;
  displayLabel: string;
  verdict: ReviewResult["verdict"];
  summary: string;
  guidance?: string;
  findings: ReviewFinding[];
  error?: string;
  diagnostic?: string;
  errorCategory?: ReviewerErrorCategory;
  telemetry?: ReviewResult["telemetry"];
  usage?: Omit<NonNullable<ReviewResult["usage"]>, "raw">;
}

export type ReviewerErrorCategory =
  | "capacity"
  | "timeout"
  | "cancelled"
  | "process_exit"
  | "invalid_output"
  | "sandbox"
  | "infrastructure";

export interface ReviewCycleEvidence {
  reviewSequence: number;
  aggregate: ReviewAggregateDisposition;
  summary: string;
  disposition?: ReviewFeedbackContext["disposition"];
  reviewers: ReviewerEvidence[];
}

export interface SubtaskReviewReport {
  aggregate: ReviewAggregateDisposition;
  summary: string;
  reviewCycles: number;
  latestReviewSequence: number;
  reviewers: ReviewerEvidence[];
  history: ReviewCycleEvidence[];
  artifactDir?: string;
}

/**
 * Durable per-cycle review record (#50).
 *
 * Written by the gate itself — never reconstructed from transcripts or
 * caller-supplied paths — into the task's artifact directory as soon as a
 * review cycle completes, so SubtasksInspect can expose the official verdict
 * and findings while the worker is still correcting, before any final task
 * result exists. Identity mirrors the immutable per-cycle review alias
 * (waveId + taskId + cycle): one record per completed cycle, write-once.
 */
export interface ReviewCycleRecord {
  version: 1;
  taskId: string;
  waveId: string;
  /** Lifecycle review cycle number; matches the immutable per-cycle alias. */
  cycle: number;
  /** Review-window sequence of the invocation that produced this cycle. */
  reviewSequence: number;
  completedAt: string;
  candidate: {
    baseCommit: string;
    commitSha: string;
    treeSha: string;
    /** Immutable per-cycle review alias ref pinning the reviewed candidate. */
    ref: string;
  };
  /** Gate-level aggregate verdict for this cycle. */
  aggregate: ReviewAggregateDisposition;
  summary: string;
  reviewers: Array<{
    reviewerId: string;
    displayLabel?: string;
    verdict: ReviewResult["verdict"];
    summary: string;
    guidance?: string;
    error?: string;
    findings: Array<Pick<ReviewFinding, "severity" | "file" | "line" | "issue" | "recommendation">>;
  }>;
}

/**
 * Publication-failure marker for a durable review cycle record (#50).
 *
 * Written by the gate itself — next to where the record would have been
 * published (`cycle-NNNN.json.unpublished`) — when a completed cycle's record
 * could not be persisted. It carries authoritative lifecycle metadata: which
 * cycle completed, its official gate-level verdict, and why the record is
 * missing. Evidence reads index it as an explicit unavailable note so an
 * older readable cycle is never presented as the current review state merely
 * because a newer cycle's record is absent. It is never a substitute for the
 * record: per-reviewer findings exist only in the (missing) record.
 */
export interface ReviewCycleUnpublishedMarker {
  version: 1;
  taskId: string;
  waveId: string;
  /** Lifecycle review cycle number; matches the immutable per-cycle alias. */
  cycle: number;
  /** Review-window sequence of the invocation that produced this cycle. */
  reviewSequence: number;
  completedAt: string;
  /** Official gate-level aggregate verdict for the unpublished cycle. */
  aggregate: ReviewAggregateDisposition;
  summary: string;
  /** Bounded reason the record publication failed. */
  reason: string;
}

const MAX_MARKER_REASON_CHARS = 200;

/** Build the bounded publication-failure marker from the official record and the write error. */
export function buildReviewCycleUnpublishedMarker(record: ReviewCycleRecord, error: unknown): ReviewCycleUnpublishedMarker {
  const message = error instanceof Error ? error.message : String(error);
  return {
    version: 1,
    taskId: record.taskId,
    waveId: record.waveId,
    cycle: record.cycle,
    reviewSequence: record.reviewSequence,
    completedAt: record.completedAt,
    aggregate: record.aggregate,
    summary: record.summary,
    reason: message.length > MAX_MARKER_REASON_CHARS ? `${message.slice(0, MAX_MARKER_REASON_CHARS - 1)}…` : message,
  };
}

/** Build the durable record for one completed review cycle from official gate outputs. */
export function buildReviewCycleRecord(input: {
  taskId: string;
  waveId: string;
  cycle: number;
  reviewSequence?: number;
  candidate: ReviewCycleRecord["candidate"];
  result?: ReviewResult;
  reviewerResults?: ReviewResult[];
}): ReviewCycleRecord {
  const gate = input.result;
  const reviewers = (input.reviewerResults ?? (gate ? [gate] : [])).map((reviewer) => ({
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
    waveId: input.waveId,
    cycle: input.cycle,
    reviewSequence: input.reviewSequence ?? input.cycle,
    completedAt: new Date().toISOString(),
    candidate: { ...input.candidate },
    aggregate: gate?.verdict === "pass" || gate?.verdict === "needs_changes" || gate?.verdict === "error"
      ? gate.verdict
      : "error",
    summary: gate?.summary ?? "Review completed without a gate result.",
    reviewers,
  };
}

export function aggregateReviewDisposition(results: ReviewResult[]): ReviewAggregateDisposition {
  if (results.some((result) => result.verdict === "needs_changes")) {
    return "needs_changes";
  }
  const passes = results.filter((result) => result.verdict === "pass").length;
  const errors = results.filter((result) => result.verdict === "error").length;
  if (passes > 0) {
    return errors > 0 ? "pass_with_warnings" : "pass";
  }
  return "error";
}

export function hasPartialReviewerFailure(results: ReviewResult[] | undefined): boolean {
  return Boolean(results?.some((result) => result.verdict === "pass")
    && results.some((result) => result.verdict === "error")
    && !results.some((result) => result.verdict === "needs_changes"));
}

export function buildReviewReportFromOutputs(input: {
  outputs: Array<{ reviewOutput: ReviewRunOutput }>;
  artifactDir?: string;
}): SubtaskReviewReport | undefined {
  const cycles = input.outputs.flatMap(({ reviewOutput }, index) => {
    if (!reviewOutput.result || !reviewOutput.reviewerResults) return [];
    return [buildCycleEvidence({
      sequence: reviewOutput.reviewSequence ?? index + 1,
      gateSummary: reviewOutput.result.summary,
      reviewerResults: reviewOutput.reviewerResults,
    })];
  });
  return reportFromCycles(cycles, input.artifactDir);
}

function buildCycleEvidence(input: {
  sequence: number;
  gateSummary: string;
  reviewerResults: ReviewResult[];
  disposition?: ReviewFeedbackContext["disposition"];
}): ReviewCycleEvidence {
  return {
    reviewSequence: input.sequence,
    aggregate: aggregateReviewDisposition(input.reviewerResults),
    summary: input.gateSummary,
    disposition: input.disposition,
    reviewers: input.reviewerResults.map((result) => ({
      reviewerId: result.reviewerId,
      // Results carry the label of the configuration that ran them; results
      // without a saved identity (legacy or synthesized) render with their
      // raw reviewer id rather than an invented current-configuration label.
      displayLabel: result.displayLabel ?? result.reviewerId,
      verdict: result.verdict,
      summary: result.summary,
      guidance: result.guidance,
      findings: result.findings.map((finding) => ({ ...finding })),
      error: result.error,
      diagnostic: result.diagnostic,
      errorCategory: result.verdict === "error" ? classifyReviewerError(result) : undefined,
      telemetry: result.telemetry ? { ...result.telemetry } : undefined,
      usage: result.usage ? withoutRawUsage(result.usage) : undefined,
    })),
  };
}

function reportFromCycles(cycles: ReviewCycleEvidence[], artifactDir?: string): SubtaskReviewReport | undefined {
  const latest = cycles.at(-1);
  if (!latest) return undefined;
  return {
    aggregate: latest.aggregate,
    summary: latest.summary,
    reviewCycles: cycles.length,
    latestReviewSequence: latest.reviewSequence,
    reviewers: latest.reviewers,
    history: cycles,
    artifactDir,
  };
}

function classifyReviewerError(result: ReviewResult): ReviewerErrorCategory {
  const text = `${result.error ?? ""} ${result.summary} ${result.diagnostic ?? ""}`.toLowerCase();
  if (/overload|capacity|rate.?limit|too many requests/.test(text)) return "capacity";
  if (/timeout|timed out/.test(text)) return "timeout";
  if (/abort|cancel/.test(text)) return "cancelled";
  if (/sandbox/.test(text)) return "sandbox";
  if (/invalid_json|missing_json|schema_error|output_truncated|missing_final_text/.test(text)) return "invalid_output";
  if (/exit_\d+|exited with status/.test(text)) return "process_exit";
  return "infrastructure";
}

function withoutRawUsage(usage: NonNullable<ReviewResult["usage"]>): Omit<NonNullable<ReviewResult["usage"]>, "raw"> {
  const { raw: _raw, ...summary } = usage;
  return summary;
}
