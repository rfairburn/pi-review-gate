import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewTransmission } from "../src/transmission";

test("review transmissions preserve formatted findings and fenced implementation guidance", () => {
  const transmission = buildReviewTransmission({
    reviewSequence: 2,
    gateVerdict: "needs_changes",
    bundleDir: "/tmp/review-bundle",
    action: "correction_required",
    reviewerDisplayLabels: { codex: "openai-codex/gpt-5.6-luna (max)" },
    reviewerResults: [{
      reviewerId: "codex",
      verdict: "needs_changes",
      summary: "The null case still fails.",
      guidance: "Apply this targeted guard:\n\n```diff\n-run(value)\n+if (value !== null) run(value)\n```",
      findings: [{
        severity: "blocking",
        file: "src/index.ts",
        line: 14,
        issue: "A null value reaches run().",
        recommendation: "Apply the guard shown above at the call site.",
      }],
    }],
  });

  assert.match(transmission.message, /## Reviewer results/);
  assert.match(transmission.message, /### openai-codex\/gpt-5\.6-luna \(max\) — needs_changes/);
  assert.equal(transmission.envelope.reviewerResults[0]?.displayLabel, "openai-codex/gpt-5.6-luna (max)");
  assert.equal(transmission.envelope.reviewerResults[0]?.result.reviewerId, "codex");
  assert.equal(transmission.envelope.reviewerResults[0]?.findings[0]?.id, "review-0002/codex/finding-0001");
  assert.match(transmission.message, /Summary: The null case still fails\./);
  assert.match(transmission.message, /Guidance:\nApply this targeted guard:/);
  assert.match(transmission.message, /```diff\n-run\(value\)\n\+if \(value !== null\) run\(value\)\n```/);
  assert.match(transmission.message, /Issue: A null value reaches run\(\)\./);
  assert.match(transmission.message, /Recommendation: Apply the guard shown above at the call site\./);
});

test("review transmissions disclose provider diagnostics to the implementing model", () => {
  const transmission = buildReviewTransmission({
    reviewSequence: 1,
    gateVerdict: "pass",
    bundleDir: "/tmp/review-bundle",
    action: "passed",
    reviewerResults: [
      { reviewerId: "passing", verdict: "pass", summary: "No defect found.", findings: [] },
      {
        reviewerId: "luna",
        verdict: "error",
        summary: "Reviewer provider failed before producing a final response.",
        findings: [],
        error: "provider_error",
        diagnostic: "Codex error: servers currently overloaded.",
      },
    ],
  });

  assert.match(transmission.message, /Reviewer error: provider_error/);
  assert.match(transmission.message, /Reviewer diagnostic:\nCodex error: servers currently overloaded\./);
});
