import assert from "node:assert/strict";
import test from "node:test";
import { buildFollowUpMessage, buildReviewerPrompt, buildReviewerQuestionPrompt } from "../src/prompts";

test("reviewer prompt treats sentinel-only flags as terminal notes", () => {
  const prompt = buildReviewerPrompt({
    request: "write hello world and flag review-gate instead of passing",
    changes: [],
    patch: "",
    cwd: "/tmp/project",
  });

  assert.match(prompt, /Return "needs_changes" only when the primary agent can take a concrete follow-up action/);
  assert.match(prompt, /sentinel\/status flag/);
  assert.match(prompt, /return "pass" with a non_blocking finding/);
});

test("every review prompt requests implementation-ready Markdown guidance", () => {
  const common = {
    request: "fix the behavior",
    changes: [],
    patch: "",
    cwd: "/tmp/project",
  };
  const automatic = buildReviewerPrompt(common);
  const question = buildReviewerQuestionPrompt({
    ...common,
    question: "How should it be fixed?",
  });

  for (const prompt of [automatic, question]) {
    assert.match(prompt, /Put actionable explanation in "guidance" as Markdown/);
    assert.match(prompt, /concise fenced code snippet or minimal diff/);
    assert.match(prompt, /do not defer useful concrete guidance/);
  }
});

test("every review prompt conditionally requires concrete guidance after correction attempts", () => {
  const common = {
    request: "fix the behavior",
    changes: [],
    patch: "",
    cwd: "/tmp/project",
    requireConcreteGuidance: true,
  };
  const automatic = buildReviewerPrompt(common);
  const question = buildReviewerQuestionPrompt({
    ...common,
    question: "How should it be fixed?",
  });

  for (const prompt of [automatic, question]) {
    assert.match(prompt, /One or more correction attempts have occurred/);
    assert.match(prompt, /First determine from the current workspace whether each historical finding is resolved/);
    assert.match(prompt, /MUST provide a concrete implementation example or minimal diff/);
    assert.match(prompt, /Do not infer that a problem remains merely because it appears in prior feedback/);
    assert.doesNotMatch(prompt, /correction attempt has not resolved/);
  }
});

test("review prompts require current evidence before repeating historical findings", () => {
  const prompt = buildReviewerPrompt({
    request: [
      "Historical prior review feedback:",
      "Replace unsafe() with safe().",
    ].join("\n"),
    changes: [],
    patch: "+safe();",
    cwd: "/tmp/project",
    requireConcreteGuidance: true,
  });

  assert.match(prompt, /Prior review feedback .* is historical evidence/);
  assert.match(prompt, /Do not repeat a prior finding when its requested correction is present/);
  assert.match(prompt, /cite current file\/line or current session evidence/);
  assert.match(prompt, /\+safe\(\);/);
});

test("automatic correction feedback preserves Markdown guidance and fenced diffs", () => {
  const message = buildFollowUpMessage({
    reviewerId: "reviewer",
    verdict: "needs_changes",
    summary: "Guard the update.",
    guidance: "Apply this change:\n\n```diff\n-run()\n+runSafely()\n```",
    findings: [{
      severity: "blocking",
      file: "index.ts",
      line: 4,
      issue: "The unsafe call remains.",
      recommendation: "Use `runSafely()`.",
    }],
  });

  assert.match(message, /Implementation guidance:/);
  assert.match(message, /```diff\n-run\(\)\n\+runSafely\(\)\n```/);
  assert.match(message, /Recommendation: Use `runSafely\(\)`/);
});
