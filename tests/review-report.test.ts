import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewReportFromOutputs } from "../src/review-report";
import type { ReviewResult } from "../src/schema";

test("review reports classify surfaced provider overloads as capacity errors", () => {
  const providerError: ReviewResult = {
    reviewerId: "luna",
    verdict: "error",
    summary: "Reviewer provider failed before producing a final response.",
    findings: [],
    error: "provider_error",
    diagnostic: "Codex error: Our servers are currently overloaded. Please try again later.",
  };
  const report = buildReviewReportFromOutputs({
    outputs: [{
      reviewOutput: {
        changed: true,
        changes: [],
        reviewSequence: 1,
        result: providerError,
        reviewerResults: [providerError],
      },
    }],
  });

  assert.equal(report?.aggregate, "error");
  assert.equal(report?.reviewers[0]?.errorCategory, "capacity");
  assert.match(report?.reviewers[0]?.diagnostic ?? "", /servers are currently overloaded/);
});

test("review reports render results without a saved identity by raw reviewer id", () => {
  // Pre-migration results carry no displayLabel. A replaced reviewer that
  // kept its id must not re-label them with the current configuration's
  // label; the honest rendering is the raw stored identity.
  const legacyResult: ReviewResult = {
    reviewerId: "one",
    verdict: "pass",
    summary: "No defect found.",
    findings: [],
  };
  const report = buildReviewReportFromOutputs({
    outputs: [{
      reviewOutput: {
        changed: true,
        changes: [],
        reviewSequence: 1,
        result: legacyResult,
        reviewerResults: [legacyResult],
      },
    }],
  });

  assert.equal(report?.reviewers[0]?.displayLabel, "one");

  const stampedResult: ReviewResult = {
    ...legacyResult,
    displayLabel: "one [codex-cli/model-a]",
  };
  const stampedReport = buildReviewReportFromOutputs({
    outputs: [{
      reviewOutput: {
        changed: true,
        changes: [],
        reviewSequence: 1,
        result: stampedResult,
        reviewerResults: [stampedResult],
      },
    }],
  });

  assert.equal(stampedReport?.reviewers[0]?.displayLabel, "one [codex-cli/model-a]");
});
