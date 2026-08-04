import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReviewBundle } from "../src/bundle";
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
    assert.match(prompt, /Do not wrap it in a Markdown fence/);
    assert.match(prompt, /literal, unescaped newlines/);
    assert.match(prompt, /"verdict": "pass" \| "needs_changes" \| "error"/);
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
  assert.match(prompt, /do not call that correction unsolicited merely because it originated with a reviewer/);
  assert.match(prompt, /Passing assessments and non-blocking observations are visible context, not mandatory corrections/);
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

test("agentic reviewer bundle prompt permits only read-only filesystem commands and includes the response schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-bundle-prompt-"));
  try {
    const bundle = await createReviewBundle({
      dir,
      cwd: dir,
      request: "review the change",
      changes: [],
      patch: "",
    });

    assert.match(bundle.bundlePrompt, /strictly read-only commands such as pwd, ls, find, rg, grep, sed, cat/);
    assert.match(bundle.bundlePrompt, /Never modify files, run commands with persistent side effects/);
    assert.doesNotMatch(bundle.bundlePrompt, /Do not modify files, run shell commands/);
    assert.match(bundle.bundlePrompt, /"verdict": "pass" \| "needs_changes" \| "error"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
