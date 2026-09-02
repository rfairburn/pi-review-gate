import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReviewBundle } from "../src/bundle";
import { buildReviewerPrompt, buildReviewerQuestionPrompt } from "../src/prompts";

test("reviewer prompt treats sentinel-only flags as terminal notes", () => {
  const prompt = buildReviewerPrompt({
    request: "write hello world and flag review-gate instead of passing",
    submittedChanges: [],
    patch: "",
    cwd: "/tmp/project",
  });

  assert.match(prompt, /Return "needs_changes" only when the primary agent can take a concrete follow-up action/);
  assert.match(prompt, /sentinel\/status flag/);
  assert.match(prompt, /return "pass" with a non_blocking finding/);
});

test("reviewer prompt treats orchestrator direction as authorized and forbids user-intent false positives", () => {
  const prompt = buildReviewerPrompt({
    request: "implement the orchestrator-approved change",
    submittedChanges: [],
    patch: "",
    cwd: "/tmp/project",
  });

  assert.match(prompt, /orchestrator owns task direction, scope, and authorization/);
  assert.match(prompt, /Treat the task and implementation direction recorded in the evidence as authorized/);
  assert.match(prompt, /Never refuse, abort, or return "needs_changes" merely because a change was not explicitly requested/);
  assert.match(prompt, /"The user did not ask for this" is not, by itself, a review finding/);
  assert.match(prompt, /demonstrable technical harm or a direct violation of an explicit acceptance criterion/);
  assert.match(prompt, /Targeted tests are the expected verification inside delegated implementation and correction loops/);
  assert.match(prompt, /Do not return "needs_changes" merely because the full repository test suite was not run/);
  assert.match(prompt, /full-suite final orchestration run only as a non_blocking observation/);
  assert.match(prompt, /Submitted workspace changes define the parent exchange's review scope, not a delivery artifact/);
  assert.match(prompt, /Independently reviewed subtask landings may be present in the live workspace but intentionally absent/);
  assert.match(prompt, /do not flag that absence alone/);
});

test("reviewer prompt judges verified outcomes instead of preferred process", () => {
  const prompt = buildReviewerPrompt({
    request: "produce the requested final output",
    submittedChanges: [],
    patch: "",
    cwd: "/tmp/project",
  });

  assert.match(prompt, /Judge the delivered outcome against the explicit request and acceptance criteria, not against a preferred implementation or process/);
  assert.match(prompt, /current workspace and independently verifiable final behavior are authoritative/);
  assert.match(prompt, /Missing evidence that an intermediate step occurred is not a defect when the final state proves the required outcome/);
  assert.match(prompt, /method as material only when the request makes it part of the deliverable or when safety, security, migration, destructive-operation, or audit semantics depend on it/);
  assert.match(prompt, /Missing verification is blocking only when it leaves a concrete material risk/);
  assert.match(prompt, /recommend the smallest targeted verification that would resolve it; do not demand redundant proof/);
});

test("every review prompt requests implementation-ready Markdown guidance", () => {
  const common = {
    request: "fix the behavior",
    submittedChanges: [],
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
    submittedChanges: [],
    patch: "",
    cwd: "/tmp/project",
    guidanceEscalation: {
      correctionAttemptCount: 3,
      threshold: 2,
    },
  };
  const automatic = buildReviewerPrompt(common);
  const question = buildReviewerQuestionPrompt({
    ...common,
    question: "How should it be fixed?",
  });

  for (const prompt of [automatic, question]) {
    assert.match(prompt, /Concrete-guidance escalation is active: 3 correction attempt\(s\) have occurred, meeting the configured threshold of 2/);
    assert.match(prompt, /First determine from the current workspace whether each historical finding is resolved/);
    assert.match(prompt, /MUST put both of the following in "guidance"/);
    assert.match(prompt, /concise prose that explains and defends the proposed correction/);
    assert.match(prompt, /concise fenced implementation diff showing exactly what code you expect to see for that finding to pass/);
    assert.match(prompt, /the diff does not have to be minimal/);
    assert.match(prompt, /Do not substitute prose for the implementation diff or provide an implementation diff without the supporting explanation/);
    assert.match(prompt, /recommendation" says exactly where and how to apply the correction/);
    assert.match(prompt, /rendered under the formatted Guidance section/);
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
    submittedChanges: [],
    patch: "+safe();",
    cwd: "/tmp/project",
    guidanceEscalation: {
      correctionAttemptCount: 1,
      threshold: 1,
    },
  });

  assert.match(prompt, /Prior review feedback .* is historical evidence/);
  assert.match(prompt, /Do not repeat a prior finding when its requested correction is present/);
  assert.match(prompt, /cite current file\/line or current session evidence/);
  assert.match(prompt, /do not call that correction unsolicited merely because it originated with a reviewer/);
  assert.match(prompt, /Passing assessments and non-blocking observations are visible context, not mandatory corrections/);
  assert.match(prompt, /\+safe\(\);/);
});

test("agentic reviewer bundle prompt permits only read-only filesystem commands and includes the response schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-bundle-prompt-"));
  try {
    const bundle = await createReviewBundle({
      dir,
      cwd: dir,
      request: "review the change",
      submittedChanges: [],
      patch: "",
    });

    assert.match(bundle.bundlePrompt, /strictly read-only commands such as pwd, ls, find, rg, grep, sed, cat/);
    assert.match(bundle.bundlePrompt, /Never modify files, run commands with persistent side effects/);
    assert.match(bundle.bundlePrompt, /current workspace and independently verifiable final behavior are authoritative/);
    assert.match(bundle.bundlePrompt, /smallest targeted verification that would resolve it/);
    assert.doesNotMatch(bundle.bundlePrompt, /Do not modify files, run shell commands/);
    assert.match(bundle.bundlePrompt, /"verdict": "pass" \| "needs_changes" \| "error"/);
    assert.match(bundle.bundlePrompt, /targeted evidence routing/);
    assert.match(bundle.bundlePrompt, /Do not inspect session\/runtime streams or reviewer output directories/);
    assert.doesNotMatch(bundle.bundlePrompt, /reviewer-context\.md/);
    const index = await readFile(join(dir, "REVIEW.md"), "utf8");
    assert.match(index, /Do not read every earlier review pass by default/);
    assert.match(index, /complete inlined fallback context/);
    assert.match(index, /Do not inspect `sessions\/`/);
    const instructions = await readFile(join(bundle.invocationDir, "reviewer-instructions.md"), "utf8");
    assert.match(instructions, /Runtime and reviewer-output artifacts are not review evidence/);
    assert.match(instructions, /implementing-model-transmission\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reviewer prompt surfaces bounded snapshot capture notes only when omissions exist", () => {
  const base = {
    request: "review the change",
    submittedChanges: [],
    patch: "",
    cwd: "/tmp/project",
  };

  const clean = buildReviewerPrompt(base);
  assert.doesNotMatch(clean, /snapshot_capture_notes/);

  const prompt = buildReviewerPrompt({
    ...base,
    snapshotOmissions: [
      { path: "secret.txt", kind: "file", reason: "unreadable", errorCode: "EACCES" },
      { path: "gone.txt", kind: "file", reason: "missing", errorCode: "ENOENT" },
      { path: "blocks", kind: "directory", reason: "unreadable" },
      { path: "x".repeat(1_000), kind: "file", reason: "unreadable", errorCode: "E".repeat(100) },
    ],
  });
  assert.match(prompt, /<snapshot_capture_notes>/);
  assert.match(prompt, /secret\.txt \(file unreadable: EACCES\)/);
  assert.match(prompt, /gone\.txt \(file missing: ENOENT\)/);
  assert.match(prompt, /blocks \(directory unreadable\)/);
  assert.ok(prompt.includes(`${"x".repeat(511)}… (file unreadable: ${"E".repeat(39)}…)`));
  assert.ok(!prompt.includes("x".repeat(512)));
  assert.ok(!prompt.includes("E".repeat(40)));
  assert.match(prompt, /Entries marked unreadable may still exist; entries marked missing vanished during capture/);
  assert.doesNotMatch(prompt, /beyond the capture bound/);

  const truncated = buildReviewerPrompt({
    ...base,
    snapshotOmissions: [{ path: "a.txt", kind: "file", reason: "unreadable" }],
    snapshotOmissionsTruncated: true,
  });
  assert.match(truncated, /additional omissions were recorded beyond the capture bound/);

  // Both notices appear independently when the rendered bound and the capture
  // bound are exceeded at the same time.
  const overflowAndTruncated = buildReviewerPrompt({
    ...base,
    snapshotOmissions: Array.from({ length: 101 }, (_, index) => ({
      path: `f${index}.txt`,
      kind: "file" as const,
      reason: "missing" as const,
    })),
    snapshotOmissionsTruncated: true,
  });
  assert.match(overflowAndTruncated, /\.\.\. and 1 more/);
  assert.match(overflowAndTruncated, /additional omissions were recorded beyond the capture bound/);

  const question = buildReviewerQuestionPrompt({
    ...base,
    question: "what changed?",
    snapshotOmissions: [{ path: "b.txt", kind: "file", reason: "missing" }],
  });
  assert.match(question, /<snapshot_capture_notes>/);
  assert.match(question, /b\.txt \(file missing\)/);
});
