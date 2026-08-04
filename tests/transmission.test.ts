import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewTransmission } from "../src/transmission";

test("review transmissions preserve formatted findings and fenced implementation guidance", () => {
  const transmission = buildReviewTransmission({
    reviewSequence: 2,
    gateVerdict: "needs_changes",
    bundleDir: "/tmp/review-bundle",
    action: "correction_required",
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
  assert.match(transmission.message, /### codex — needs_changes/);
  assert.match(transmission.message, /Summary: The null case still fails\./);
  assert.match(transmission.message, /Guidance:\nApply this targeted guard:/);
  assert.match(transmission.message, /```diff\n-run\(value\)\n\+if \(value !== null\) run\(value\)\n```/);
  assert.match(transmission.message, /Issue: A null value reaches run\(\)\./);
  assert.match(transmission.message, /Recommendation: Apply the guard shown above at the call site\./);
});
