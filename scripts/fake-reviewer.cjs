#!/usr/bin/env node
"use strict";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});

process.stdin.on("end", () => {
  const mode = normalizeMode(process.env.PI_REVIEW_GATE_FAKE_VERDICT);
  const findingFile = process.env.PI_REVIEW_GATE_FAKE_FILE || inferFirstChangedFile(prompt) || "unknown";
  const findingIssue = process.env.PI_REVIEW_GATE_FAKE_ISSUE || "Fake reviewer requested a retry.";
  const findingRecommendation = process.env.PI_REVIEW_GATE_FAKE_RECOMMENDATION || "Make a small follow-up edit so the review gate retry path can be tested.";

  if (mode === "retry") {
    writeJson({
      verdict: "needs_changes",
      summary: "Fake reviewer requested changes.",
      findings: [
        {
          severity: "blocking",
          file: findingFile,
          line: null,
          issue: findingIssue,
          recommendation: findingRecommendation,
        },
      ],
    });
    return;
  }

  writeJson({
    verdict: "pass",
    summary: "Fake reviewer approved the changes.",
    findings: [],
  });
});

function normalizeMode(value) {
  if (value === "retry" || value === "needs_changes" || value === "fail") {
    return "retry";
  }
  return "pass";
}

function inferFirstChangedFile(text) {
  const match = text.match(/"path":\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
