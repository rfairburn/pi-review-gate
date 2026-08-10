import type { TokenUsage } from "./usage";

export type ReviewVerdict = "pass" | "needs_changes" | "error";

export interface ChangeIdentity {
  baseCommit: string;
  candidateCommit: string;
}

const COMMIT_ID_RE = /^[0-9a-f]{40,64}$/;

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
}

export const REVIEW_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
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
      parsed = JSON.parse(candidate);
    } catch (error) {
      firstParseError ??= error;
      if (/['\"]verdict['\"]\s*:/.test(candidate)) {
        firstReviewParseError ??= error;
      }
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

  const loose = extractLooseReviewResult(rawOutput);
  if (loose) {
    const validated = normalizeReviewResult(reviewerId, loose, rawOutputPath);
    if (validated.error !== "schema_error") {
      if (validated.verdict !== "error" && validated.findings.some((finding) => finding.severity === "blocking")) {
        validated.verdict = "needs_changes";
      }
      return validated;
    }
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

  const verdict = value.verdict;
  if (verdict !== "pass" && verdict !== "needs_changes" && verdict !== "error") {
    return schemaError(reviewerId, "Reviewer JSON has an invalid verdict.", rawOutputPath);
  }

  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (!summary) {
    return schemaError(reviewerId, "Reviewer JSON must include a summary string.", rawOutputPath);
  }
  if (value.guidance !== undefined && value.guidance !== null && typeof value.guidance !== "string") {
    return schemaError(reviewerId, "Reviewer JSON guidance must be a string when supplied.", rawOutputPath);
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
    guidance: guidance || undefined,
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
    const repaired = escapeControlCharactersInJsonStrings(trimmed);
    if (repaired && repaired !== trimmed && !seen.has(repaired)) {
      seen.add(repaired);
      candidates.push(repaired);
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

function extractLooseReviewResult(text: string): Record<string, unknown> | undefined {
  const verdictMatches = [...text.matchAll(/"verdict"\s*:\s*"(pass|needs_changes|error)"/g)];
  const verdictMatch = verdictMatches.at(-1);
  if (!verdictMatch || verdictMatch.index === undefined) {
    return undefined;
  }
  const candidate = text.slice(verdictMatch.index);
  const summaryMatch = /"summary"\s*:\s*"([\s\S]*?)"\s*,\s*"(?:guidance|findings)"\s*:/.exec(candidate);
  if (!summaryMatch) {
    return undefined;
  }
  const guidanceNull = /"guidance"\s*:\s*null\s*,\s*"findings"\s*:/.test(candidate);
  const guidanceMatch = /"guidance"\s*:\s*"([\s\S]*?)"\s*,\s*"findings"\s*:/.exec(candidate);
  const findingsMarker = /"findings"\s*:\s*\[/.exec(candidate);
  if (!findingsMarker) {
    return undefined;
  }
  const findingsText = candidate.slice(findingsMarker.index + findingsMarker[0].length);
  const findingPattern = /\{\s*"severity"\s*:\s*"(blocking|non_blocking)"\s*,\s*"file"\s*:\s*(null|"([^"\\]*(?:\\.[^"\\]*)*)")\s*,\s*"line"\s*:\s*(null|\d+)\s*,\s*"issue"\s*:\s*"([\s\S]*?)"\s*,\s*"recommendation"\s*:\s*"([\s\S]*?)"\s*\}/g;
  const findings: Record<string, unknown>[] = [];
  for (const match of findingsText.matchAll(findingPattern)) {
    findings.push({
      severity: match[1],
      file: match[2] === "null" ? null : decodeLooseJsonString(match[3] ?? ""),
      line: match[4] === "null" ? null : Number(match[4]),
      issue: decodeLooseJsonString(match[5] ?? ""),
      recommendation: decodeLooseJsonString(match[6] ?? ""),
    });
  }
  if (findings.length === 0 && !/"findings"\s*:\s*\[\s*\]/.test(candidate)) {
    return undefined;
  }
  const errorNull = /"error"\s*:\s*null/.test(candidate);
  const errorMatch = /"error"\s*:\s*"([\s\S]*?)"\s*[,}]/.exec(candidate);
  return {
    verdict: verdictMatch[1],
    summary: decodeLooseJsonString(summaryMatch[1] ?? ""),
    guidance: guidanceMatch ? decodeLooseJsonString(guidanceMatch[1] ?? "") : guidanceNull ? null : undefined,
    findings,
    error: errorMatch ? decodeLooseJsonString(errorMatch[1] ?? "") : errorNull ? null : undefined,
  };
}

function decodeLooseJsonString(value: string): string {
  let quoted = "\"";
  let escaped = false;
  for (const char of value) {
    if (char === "\n") {
      quoted += "\\n";
      escaped = false;
      continue;
    }
    if (char === "\r") {
      quoted += "\\r";
      escaped = false;
      continue;
    }
    if (char === "\t") {
      quoted += "\\t";
      escaped = false;
      continue;
    }
    if (char === "\"" && !escaped) {
      quoted += "\\\"";
    } else {
      quoted += char;
    }
    if (char === "\\") {
      escaped = !escaped;
    } else {
      escaped = false;
    }
  }
  quoted += "\"";
  try {
    return JSON.parse(quoted) as string;
  } catch {
    return value;
  }
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
