import type { TokenUsage } from "./usage";

export type ReviewVerdict = "pass" | "needs_changes" | "error";

export interface ChangeIdentity {
  baseCommit: string;
  candidateCommit: string;
}

const COMMIT_ID_RE = /^[0-9a-f]{40,64}$/;
const REVIEW_RESULT_KEYS = new Set(["verdict", "summary", "guidance", "findings", "error"]);
const REQUIRED_REVIEW_RESULT_KEYS = new Set(["verdict", "summary", "findings"]);
const REVIEW_FINDING_KEYS = new Set(["severity", "file", "line", "issue", "recommendation"]);

export function validateChangeIdentity(identity: unknown): string | undefined {
  if (typeof identity !== "object" || identity === null || Array.isArray(identity)) {
    return "changeIdentity must be an object with baseCommit and candidateCommit strings";
  }
  const obj = identity as Record<string, unknown>;
  if (typeof obj.baseCommit !== "string") {
    return "baseCommit must be a string";
  }
  if (typeof obj.candidateCommit !== "string") {
    return "candidateCommit must be a string";
  }
  if (!COMMIT_ID_RE.test(obj.baseCommit)) {
    return `baseCommit must be a 40–64 character lowercase hex string, got: ${obj.baseCommit}`;
  }
  if (!COMMIT_ID_RE.test(obj.candidateCommit)) {
    return `candidateCommit must be a 40–64 character lowercase hex string, got: ${obj.candidateCommit}`;
  }
  return undefined;
}

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
  guidance?: string;
  findings: ReviewFinding[];
  rawOutputPath?: string;
  usage?: TokenUsage;
  error?: string;
  diagnostic?: string;
  telemetry?: ReviewerInvocationTelemetry;
}

export interface ReviewerInvocationTelemetry {
  startedAt?: string;
  durationMs?: number;
  promptBytes?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutBytesCaptured?: number;
  stderrBytesCaptured?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  streamEvents?: number;
  toolCalls?: number;
  toolResultBytes?: number;
  compactions?: number;
  sessionResumed?: boolean;
  restartedAfterResumeFailure?: boolean;
}

export const REVIEW_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // Codex Structured Outputs requires every declared property to be listed in
  // `required`. Semantically optional fields remain required-but-nullable.
  required: ["verdict", "summary", "guidance", "findings", "error"],
  properties: {
    verdict: { type: "string", enum: ["pass", "needs_changes", "error"] },
    summary: { type: "string" },
    guidance: { type: ["string", "null"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "issue", "recommendation"],
        properties: {
          severity: { type: "string", enum: ["blocking", "non_blocking"] },
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"], minimum: 1 },
          issue: { type: "string" },
          recommendation: { type: "string" },
        },
      },
    },
    error: { type: ["string", "null"] },
  },
} as const;

export function parseReviewResult(reviewerId: string, rawOutput: string, rawOutputPath?: string): ReviewResult {
  const candidates = extractJsonCandidates(rawOutput);
  let firstParseError: unknown;
  let firstReviewParseError: unknown;
  let firstSchemaError: ReviewResult | undefined;

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.value);
    } catch (error) {
      firstParseError ??= error;
      if (/['\"]verdict['\"]\s*:/.test(candidate.value)) {
        firstReviewParseError ??= error;
      }
      continue;
    }

    const validated = normalizeReviewResult(reviewerId, parsed, rawOutputPath);
    if (validated.error === "schema_error") {
      firstSchemaError ??= validated;
      continue;
    }
    // Recovery of literal control characters is useful for actionable
    // correction guidance, but a pass must come from syntactically valid JSON.
    if (candidate.repaired && validated.verdict === "pass") continue;
    if (validated.verdict !== "error" && validated.findings.some((finding) => finding.severity === "blocking")) {
      validated.verdict = "needs_changes";
    }
    return validated;
  }

  if (firstReviewParseError) {
    return {
      reviewerId,
      verdict: "error",
      summary: "Reviewer returned invalid JSON.",
      findings: [],
      rawOutputPath,
      error: "invalid_json",
    };
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
      error: "invalid_json",
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
  if (!hasAllowedKeys(value, REVIEW_RESULT_KEYS, REQUIRED_REVIEW_RESULT_KEYS)) {
    return schemaError(reviewerId, "Reviewer JSON contains missing or unsupported fields.", rawOutputPath);
  }

  const verdict = value.verdict;
  if (verdict !== "pass" && verdict !== "needs_changes" && verdict !== "error") {
    return schemaError(reviewerId, "Reviewer JSON has an invalid verdict.", rawOutputPath);
  }

  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (!summary) {
    return schemaError(reviewerId, "Reviewer JSON must include a summary string.", rawOutputPath);
  }
  if (value.guidance !== undefined && value.guidance !== null && typeof value.guidance !== "string") {
    return schemaError(reviewerId, "Reviewer JSON guidance must be a string or null when supplied.", rawOutputPath);
  }
  const guidance = typeof value.guidance === "string" ? value.guidance.trim() : "";

  if (!Array.isArray(value.findings)) {
    return schemaError(reviewerId, "Reviewer JSON must include findings array.", rawOutputPath);
  }

  const findings: ReviewFinding[] = [];
  for (const item of value.findings) {
    if (!isRecord(item)) {
      return schemaError(reviewerId, "Each finding must be an object.", rawOutputPath);
    }
    if (!hasExactKeys(item, REVIEW_FINDING_KEYS)) {
      return schemaError(reviewerId, "Each finding must contain exactly severity, file, line, issue, and recommendation.", rawOutputPath);
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

  if (value.error !== undefined && value.error !== null && typeof value.error !== "string") {
    return schemaError(reviewerId, "Reviewer JSON error must be a string or null when supplied.", rawOutputPath);
  }
  const error = typeof value.error === "string" ? value.error.trim() : "";
  if (verdict === "error" && !error) {
    return schemaError(reviewerId, "An error verdict must include a non-empty error string.", rawOutputPath);
  }
  if (verdict !== "error" && error) {
    return schemaError(reviewerId, "A non-error verdict must set error to null.", rawOutputPath);
  }

  return {
    reviewerId,
    verdict,
    summary,
    guidance: guidance || undefined,
    findings,
    rawOutputPath,
    error: error || undefined,
  };
}

export function extractJsonObject(text: string): string | null {
  return extractBalancedJsonObjects(text)[0] ?? null;
}

function extractJsonCandidates(text: string): Array<{ value: string; repaired: boolean }> {
  const candidates: Array<{ value: string; repaired: boolean }> = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      candidates.push({ value: trimmed, repaired: false });
    }
    const repaired = escapeControlCharactersInJsonStrings(trimmed);
    if (repaired && repaired !== trimmed && !seen.has(repaired)) {
      seen.add(repaired);
      candidates.push({ value: repaired, repaired: true });
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

function escapeControlCharactersInJsonStrings(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (!inString) {
      output += char;
      if (char === "\"") {
        inString = true;
      }
      continue;
    }
    if (char === "\n") {
      output += "\\n";
      escaped = false;
      continue;
    }
    if (char === "\r") {
      output += "\\r";
      escaped = false;
      continue;
    }
    if (char === "\t") {
      output += "\\t";
      escaped = false;
      continue;
    }
    if (char.charCodeAt(0) < 0x20) {
      output += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
      escaped = false;
      continue;
    }
    output += char;
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "\"") {
      inString = false;
    }
  }
  return output;
}

function extractBalancedJsonObjects(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
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
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
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

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && [...required].every((key) => key in value);
}
