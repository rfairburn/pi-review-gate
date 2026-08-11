import type { DeciderConfig } from "./config";
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

export function buildReviewReportFromHistory(input: {
  history: ReviewFeedbackContext[];
  reviewers: DeciderConfig[];
  artifactDir?: string;
  currentOutput?: ReviewRunOutput;
}): SubtaskReviewReport | undefined {
  const labels = new Map(input.reviewers.map((reviewer) => [reviewer.id, reviewerLabel(reviewer)]));
  const cycles = input.history.map((feedback) => buildCycleEvidence({
    sequence: feedback.sequence,
    gateSummary: verdictSummary(feedback.reviewerResults),
    reviewerResults: feedback.reviewerResults,
    labels,
    disposition: feedback.disposition,
  }));

  if (input.currentOutput?.result && input.currentOutput.reviewerResults && input.currentOutput.reviewSequence !== undefined
    && !cycles.some((cycle) => cycle.reviewSequence === input.currentOutput?.reviewSequence)) {
    cycles.push(buildCycleEvidence({
      sequence: input.currentOutput.reviewSequence,
      gateSummary: input.currentOutput.result.summary,
      reviewerResults: input.currentOutput.reviewerResults,
      labels,
    }));
  }
  return reportFromCycles(cycles, input.artifactDir);
}

export function buildReviewReportFromOutputs(input: {
  outputs: Array<{ reviewOutput: ReviewRunOutput }>;
  artifactDir?: string;
}): SubtaskReviewReport | undefined {
  const cycles = input.outputs.flatMap(({ reviewOutput }, index) => {
    if (!reviewOutput.result || !reviewOutput.reviewerResults) return [];
    const labels = new Map(Object.entries(reviewOutput.reviewerDisplayLabels ?? {}));
    return [buildCycleEvidence({
      sequence: reviewOutput.reviewSequence ?? index + 1,
      gateSummary: reviewOutput.result.summary,
      reviewerResults: reviewOutput.reviewerResults,
      labels,
    })];
  });
  return reportFromCycles(cycles, input.artifactDir);
}

function buildCycleEvidence(input: {
  sequence: number;
  gateSummary: string;
  reviewerResults: ReviewResult[];
  labels: Map<string, string>;
  disposition?: ReviewFeedbackContext["disposition"];
}): ReviewCycleEvidence {
  return {
    reviewSequence: input.sequence,
    aggregate: aggregateReviewDisposition(input.reviewerResults),
    summary: input.gateSummary,
    disposition: input.disposition,
    reviewers: input.reviewerResults.map((result) => ({
      reviewerId: result.reviewerId,
      displayLabel: input.labels.get(result.reviewerId) ?? result.reviewerId,
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

function verdictSummary(results: ReviewResult[]): string {
  const counts = new Map<ReviewResult["verdict"], number>();
  for (const result of results) counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
  return (["needs_changes", "pass", "error"] as const)
    .filter((verdict) => counts.has(verdict))
    .map((verdict) => `${counts.get(verdict)} ${verdict}`)
    .join(", ");
}

function withoutRawUsage(usage: NonNullable<ReviewResult["usage"]>): Omit<NonNullable<ReviewResult["usage"]>, "raw"> {
  const { raw: _raw, ...summary } = usage;
  return summary;
}

function reviewerLabel(reviewer: DeciderConfig): string {
  if (reviewer.adapter === "little-coder-model") {
    return reviewer.thinkingLevel ? `${reviewer.model} (${reviewer.thinkingLevel})` : reviewer.model;
  }
  if ((reviewer.adapter === "codex-cli" || reviewer.adapter === "claude-cli") && reviewer.model) {
    return `${reviewer.id} [${reviewer.adapter}/${reviewer.model}]`;
  }
  return reviewer.id;
}
