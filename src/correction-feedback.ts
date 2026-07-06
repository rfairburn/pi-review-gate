import { createHash } from "node:crypto";
import type { ChangedFile } from "./capture";
import type { ReviewFinding, ReviewResult } from "./schema";

export interface CorrectionFeedbackMarker {
  changeSignature: string;
  evidenceEventCount: number;
  findings: CorrectionFeedbackFinding[];
}

export interface CorrectionFeedbackFinding {
  reviewerId?: string;
  severity: string;
  file: string;
  line: number | null;
  text: string;
}

export function isRepeatedNoProgressFeedback(input: {
  previous?: CorrectionFeedbackMarker;
  result?: ReviewResult;
  changes: ChangedFile[];
  evidenceEventCount: number;
}): boolean {
  if (!input.previous || !input.result) {
    return false;
  }
  if (input.previous.changeSignature !== fingerprintChanges(input.changes)) {
    return false;
  }
  if (input.evidenceEventCount > input.previous.evidenceEventCount) {
    return false;
  }
  return isSimilarFeedback(
    input.previous.findings,
    normalizeFeedbackFindings(input.result),
  );
}

export function createCorrectionFeedbackMarker(input: {
  result: ReviewResult;
  changes: ChangedFile[];
  evidenceEventCount: number;
}): CorrectionFeedbackMarker {
  return {
    changeSignature: fingerprintChanges(input.changes),
    evidenceEventCount: input.evidenceEventCount,
    findings: normalizeFeedbackFindings(input.result),
  };
}

function normalizeFeedbackFindings(result: ReviewResult): CorrectionFeedbackFinding[] {
  const blocking = result.findings.filter((finding) => finding.severity === "blocking");
  const findings = blocking.length > 0 ? blocking : result.findings;
  return findings
    .map((finding) => ({
      reviewerId: finding.reviewerId,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      text: normalizeFindingText(finding),
    }))
    .sort((a, b) => feedbackLocationKey(a).localeCompare(feedbackLocationKey(b)));
}

function isSimilarFeedback(
  previous: CorrectionFeedbackFinding[],
  current: CorrectionFeedbackFinding[],
): boolean {
  if (previous.length === 0 || previous.length !== current.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = current[index];
    if (!left || !right || feedbackLocationKey(left) !== feedbackLocationKey(right)) {
      return false;
    }
  }
  return tokenSetSimilarity(
    previous.map((finding) => finding.text).join(" "),
    current.map((finding) => finding.text).join(" "),
  ) >= 0.55;
}

function fingerprintChanges(changes: ChangedFile[]): string {
  const compact = changes
    .map((change) => ({
      path: change.path,
      status: change.status,
      binary: change.binary,
      oversized: change.oversized,
      diffOmittedReason: change.diffOmittedReason ?? "",
      oldContent: hashString(change.oldContent),
      newContent: hashString(change.newContent),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return hashString(JSON.stringify(compact));
}

function normalizeFindingText(finding: ReviewFinding): string {
  return `${finding.issue} ${finding.recommendation}`.replace(/\s+/g, " ").trim().toLowerCase();
}

function feedbackLocationKey(finding: CorrectionFeedbackFinding): string {
  return `${finding.reviewerId ?? ""}\0${finding.severity}\0${finding.file}\0${finding.line ?? ""}`;
}

function tokenSetSimilarity(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return left === right ? 1 : 0;
  }
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.min(leftTokens.size, rightTokens.size);
}

function tokenSet(value: string): Set<string> {
  return new Set(value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 2));
}

function hashString(value: string | undefined): string {
  return value === undefined
    ? ""
    : createHash("sha256").update(value).digest("hex");
}
