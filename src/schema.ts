import type { TokenUsage } from "./usage";

export type ReviewVerdict = "pass" | "needs_changes" | "error";

export type FindingSeverity = "blocking" | "non_blocking";

export interface ReviewFinding {
  reviewerId?: string;
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
  const candidates = extractJsonCandidates(rawOutput);
  let firstParseError: unknown;
  let firstSchemaError: ReviewResult | undefined;

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      firstParseError ??= error;
      continue;
    }

    const validated = normalizeReviewResult(reviewerId, parsed, rawOutputPath);
    if (validated.error === "schema_error") {
      firstSchemaError ??= validated;
      continue;
    }
    if (validated.verdict !== "error" && validated.findings.some((finding) => finding.severity === "blocking")) {
      validated.verdict = "needs_changes";
    }
    return validated;
  }

  if (firstSchemaError) {
    return firstSchemaError;
  }
  if (firstParseError && (rawOutput.includes("{") || /```[ \t]*json\b/i.test(rawOutput))) {
    return {
      reviewerId,
      verdict: "error",
      summary: "Reviewer returned invalid JSON.",
      findings: [],
      rawOutputPath,
      error: firstParseError instanceof Error ? firstParseError.message : "invalid_json",
    };
  }
  return {
    reviewerId,
    verdict: "error",
    summary: "Reviewer did not return a JSON object.",
    findings: [],
    rawOutputPath,
    error: "missing_json",
  };
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
  return extractBalancedJsonObjects(text)[0] ?? null;
}

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      candidates.push(trimmed);
    }
  };

  const trimmed = text.trim();
  if (trimmed) {
    add(trimmed);
  }

  const fencePattern = /```[ \t]*json\b[ \t]*(?:\r?\n)?([\s\S]*?)```/gi;
  for (const match of text.matchAll(fencePattern)) {
    const fenced = match[1] ?? "";
    add(fenced);
    for (const candidate of extractBalancedJsonObjects(fenced)) {
      add(candidate);
    }
  }

  for (const candidate of extractBalancedJsonObjects(text)) {
    add(candidate);
  }
  return candidates;
}

function extractBalancedJsonObjects(text: string): string[] {
  const candidates: string[] = [];
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const candidate = extractBalancedJsonObjectAt(text, start);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function extractBalancedJsonObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
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
        return text.slice(start, index + 1);
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
