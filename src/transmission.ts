import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewFinding, ReviewResult } from "./schema";

export type ReviewTransmissionAction = "correction_required" | "passed" | "deferred" | "review_error";

export interface ReviewTransmission {
  reviewSequence: number;
  action: ReviewTransmissionAction;
  message: string;
  envelope: ReviewTransmissionEnvelope;
}

export interface ReviewTransmissionEnvelope {
  version: 1;
  reviewSequence: number;
  intendedRecipient: "implementing_model";
  action: ReviewTransmissionAction;
  gateVerdict: ReviewResult["verdict"];
  reviewerResults: Array<{
    result: ReviewResult;
    findings: Array<{ id: string; finding: ReviewFinding }>;
  }>;
}

export function buildReviewTransmission(input: {
  reviewSequence: number;
  gateVerdict: ReviewResult["verdict"];
  reviewerResults: ReviewResult[];
  bundleDir: string;
  action: ReviewTransmissionAction;
}): ReviewTransmission {
  const reviewerResults = input.reviewerResults.map((result) => ({
    result,
    findings: result.findings.map((finding, index) => ({
      id: findingId(input.reviewSequence, result.reviewerId, index + 1),
      finding,
    })),
  }));
  const envelope: ReviewTransmissionEnvelope = {
    version: 1,
    reviewSequence: input.reviewSequence,
    intendedRecipient: "implementing_model",
    action: input.action,
    gateVerdict: input.gateVerdict,
    reviewerResults,
  };

  return {
    reviewSequence: input.reviewSequence,
    action: input.action,
    envelope,
    message: renderTransmission(envelope, input.bundleDir),
  };
}

export async function writeReviewTransmission(
  invocationDir: string,
  transmission: ReviewTransmission,
): Promise<void> {
  await mkdir(invocationDir, { recursive: true });
  await Promise.all([
    writeFile(join(invocationDir, "implementing-model-transmission.md"), transmission.message, "utf8"),
    writeFile(join(invocationDir, "implementing-model-transmission.json"), JSON.stringify(transmission.envelope, null, 2), "utf8"),
  ]);
}

export async function createReviewTransmissionMessage(input: {
  invocationDir: string;
  reviewSequence: number;
  gateVerdict: ReviewResult["verdict"];
  reviewerResults: ReviewResult[];
  bundleDir: string;
  action: ReviewTransmissionAction;
}): Promise<string> {
  const transmission = buildReviewTransmission(input);
  await writeReviewTransmission(input.invocationDir, transmission);
  return transmission.message;
}

export async function writeReviewDeliveryReceipt(
  invocationDir: string,
  action: ReviewTransmissionAction,
  message: string,
): Promise<void> {
  const path = join(invocationDir, "delivery.json");
  const existing = await readFile(path, "utf8")
    .then((content) => JSON.parse(content) as { deliveries?: unknown[] })
    .catch(() => ({ deliveries: [] as unknown[] }));
  const deliveries = Array.isArray(existing.deliveries) ? existing.deliveries : [];
  const delivery: Record<string, unknown> = {
    sequence: deliveries.length + 1,
    deliveredAt: new Date().toISOString(),
    action,
  };
  if (deliveries.length === 0) {
    delivery.content = "implementing-model-transmission.md";
  } else {
    delivery.message = message;
  }
  deliveries.push(delivery);
  await writeFile(path, JSON.stringify({
    recipient: "implementing_model",
    deliveries,
  }, null, 2), "utf8");
}

export async function deliverReviewTransmission(input: {
  invocationDir: string;
  action: ReviewTransmissionAction;
  message: string;
  deliver: () => Promise<boolean>;
}): Promise<boolean> {
  const delivered = await input.deliver();
  if (delivered) {
    await writeReviewDeliveryReceipt(input.invocationDir, input.action, input.message);
  }
  return delivered;
}

function renderTransmission(envelope: ReviewTransmissionEnvelope, bundleDir: string): string {
  const lines = [
    `Review pass ${envelope.reviewSequence} transmission for the implementing model.`,
    "",
    `Gate verdict: ${envelope.gateVerdict}`,
    actionText(envelope.action),
    "",
    "Every official reviewer result from this pass is included below. Passing assessments and non-blocking notes are informational; they are not hidden and do not become required corrections unless explicitly identified as required.",
    "",
    "## Reviewer results",
  ];

  for (const reviewer of envelope.reviewerResults) {
    lines.push(
      "",
      `### ${reviewer.result.reviewerId} — ${reviewer.result.verdict}`,
      "",
      `Summary: ${reviewer.result.summary}`,
    );
    if (reviewer.result.guidance) {
      lines.push("", "Guidance:", reviewer.result.guidance);
    }
    if (reviewer.result.error) {
      lines.push("", `Reviewer error: ${reviewer.result.error}`);
    }
    if (reviewer.findings.length === 0) {
      lines.push("", "Findings: none.");
    } else {
      lines.push("", "Findings:");
      for (const entry of reviewer.findings) {
        const location = entry.finding.line === null
          ? entry.finding.file
          : `${entry.finding.file}:${entry.finding.line}`;
        lines.push(
          "",
          `- ${entry.id} [${entry.finding.severity}] ${location}`,
          `  Issue: ${entry.finding.issue}`,
          `  Recommendation: ${entry.finding.recommendation}`,
        );
      }
    }
  }

  lines.push(
    "",
    `Complete immutable pass evidence: ${join(bundleDir, "reviews", sequencePath(envelope.reviewSequence))}`,
    "",
    "This verdict applies to the workspace snapshot reviewed in this pass. If you make additional workspace or persistent side-effect changes, they will be treated as a continuation and reviewed again.",
  );
  return lines.join("\n");
}

export function buildReviewAuthorizationMessage(input: {
  reviewSequence: number;
  bundleDir: string;
}): string {
  return [
    `Review pass ${input.reviewSequence} correction authorization for the implementing model.`,
    "",
    "The complete individual reviewer results were already disclosed in the earlier deferred transmission.",
    "Action: Correction is now authorized. Address the blocking findings, run relevant tests, and report the result.",
    "",
    `Complete immutable pass evidence: ${join(input.bundleDir, "reviews", sequencePath(input.reviewSequence))}`,
  ].join("\n");
}

function actionText(action: ReviewTransmissionAction): string {
  if (action === "correction_required") {
    return "Action: Review found blocking issues. Address the blocking findings from this pass, then run relevant tests and report the result.";
  }
  if (action === "passed") {
    return "Action: No correction is required. Review the observations below; you may respond or make a useful follow-up change, but any new change will be reviewed again.";
  }
  if (action === "deferred") {
    return "Action: The findings are disclosed for context, but automatic correction is deferred. Do not make a correction solely from this transmission unless continuation is authorized.";
  }
  return "Action: Review infrastructure failed or returned an incomplete result. The available reviewer material is disclosed for context; no correction is automatically required.";
}

function findingId(reviewSequence: number, reviewerId: string, findingSequence: number): string {
  return `review-${sequencePath(reviewSequence)}/${safePathSegment(reviewerId)}/finding-${sequencePath(findingSequence)}`;
}

function sequencePath(sequence: number): string {
  return String(sequence).padStart(4, "0");
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_") || "reviewer";
}
