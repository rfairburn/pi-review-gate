import type { TokenUsage } from "./usage";

export type ReviewVerdict = "pass" | "needs_changes" | "error";

export type FindingSeverity = "blocking" | "non_blocking";

export interface ReviewFinding {
  severity: FindingSeverity;
  file: string;
  line: number | null;
  issue: string;
  recommendation: string;
}

export interface ReviewResult {
  reviewerId: string;
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  rawOutputPath?: string;
  usage?: TokenUsage;
  error?: string;
}

export function parseReviewResult(reviewerId: string, rawOutput: string, rawOutputPath?: string): ReviewResult {
  const jsonText = extractJsonObject(rawOutput);
  if (!jsonText) {
    return {
      reviewerId,
      verdict: "error",
      summary: "Reviewer did not return a JSON object.",
      findings: [],
      rawOutputPath,
      error: "missing_json",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return {
      reviewerId,
      verdict: "error",
      summary: "Reviewer returned invalid JSON.",
      findings: [],
      rawOutputPath,
      error: error instanceof Error ? error.message : "invalid_json",
    };
  }

  const validated = normalizeReviewResult(reviewerId, parsed, rawOutputPath);
  if (validated.verdict !== "error" && validated.findings.some((finding) => finding.severity === "blocking")) {
    validated.verdict = "needs_changes";
  }
  return validated;
}

export function normalizeReviewResult(
  reviewerId: string,
  value: unknown,
  rawOutputPath?: string,
): ReviewResult {
  if (!isRecord(value)) {
    return schemaError(reviewerId, "Reviewer JSON must be an object.", rawOutputPath);
  }

  const verdict = value.verdict;
  if (verdict !== "pass" && verdict !== "needs_changes" && verdict !== "error") {
    return schemaError(reviewerId, "Reviewer JSON has an invalid verdict.", rawOutputPath);
  }

  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (!summary) {
    return schemaError(reviewerId, "Reviewer JSON must include a summary string.", rawOutputPath);
  }

  if (!Array.isArray(value.findings)) {
    return schemaError(reviewerId, "Reviewer JSON must include findings array.", rawOutputPath);
  }

  const findings: ReviewFinding[] = [];
  for (const item of value.findings) {
    if (!isRecord(item)) {
      return schemaError(reviewerId, "Each finding must be an object.", rawOutputPath);
    }
    const severity = item.severity;
    if (severity !== "blocking" && severity !== "non_blocking") {
      return schemaError(reviewerId, "Each finding must include a valid severity.", rawOutputPath);
    }
    if ((item.file !== null && typeof item.file !== "string") || typeof item.issue !== "string" || typeof item.recommendation !== "string") {
      return schemaError(reviewerId, "Each finding must include issue and recommendation strings, with file as a string or null.", rawOutputPath);
    }
    const line = item.line;
    if (line !== null && !(typeof line === "number" && Number.isInteger(line) && line > 0)) {
      return schemaError(reviewerId, "Finding line must be a positive integer or null.", rawOutputPath);
    }
    findings.push({
      severity,
      file: normalizeFindingFile(item.file),
      line,
      issue: item.issue.trim(),
      recommendation: item.recommendation.trim(),
    });
  }

  return {
    reviewerId,
    verdict,
    summary,
    findings,
    rawOutputPath,
    error: typeof value.error === "string" ? value.error : undefined,
  };
}

export function extractJsonObject(text: string): string | null {
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = firstBrace; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(firstBrace, index + 1);
      }
    }
  }

  return null;
}

function normalizeFindingFile(value: unknown): string {
  if (typeof value !== "string") {
    return "session";
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "session";
}

function schemaError(reviewerId: string, summary: string, rawOutputPath?: string): ReviewResult {
  return {
    reviewerId,
    verdict: "error",
    summary,
    findings: [],
    rawOutputPath,
    error: "schema_error",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
