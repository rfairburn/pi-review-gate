import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectEvidenceChanges,
  buildEvidenceBundle,
  createEvidenceState,
  extractCandidatePaths,
  recordAcceptedReviewerQuestion,
  recordToolCallEvidence,
  rememberFinalAssistantSummary,
  rememberFinalAssistantSummaryText,
  shouldRecordToolCallEvidence,
  shouldRecordToolResultEvidence,
} from "../src/evidence";

const snapshotOptions = {
  maxFileBytes: 1024 * 1024,
  maxSnapshotBytes: 10 * 1024 * 1024,
};

test("extractCandidatePaths finds shell redirection and tee targets", () => {
  const result = extractCandidatePaths("bash", {
    command: "cat > /tmp/review-gate-a.txt <<EOF\nhello\nEOF\nprintf x | tee -a logs/out.txt",
  });

  assert.deepEqual(result.paths.map((item) => item.path), [
    "/tmp/review-gate-a.txt",
    "logs/out.txt",
  ]);
  assert.ok(result.riskSignals.includes("shell_redirection"));
  assert.ok(result.riskSignals.includes("tee_write"));
  assert.ok(result.riskSignals.includes("heredoc"));
});

test("successful discovery tools are transient while their failures remain review evidence", () => {
  for (const toolName of ["read", "grep", "glob", "find", "ls", "Read", "GREP", "BrowserScreenshot"]) {
    assert.equal(shouldRecordToolCallEvidence(toolName), false, toolName);
    assert.equal(shouldRecordToolResultEvidence(toolName, false), false, toolName);
    assert.equal(shouldRecordToolResultEvidence(toolName, true), true, toolName);
  }
  assert.equal(shouldRecordToolCallEvidence("write"), true);
  assert.equal(shouldRecordToolResultEvidence("bash", false), true);
});

test("browser form tool-call evidence structurally removes exact values and selections", async () => {
  const state = createEvidenceState();
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ["BrowserFill", { session: "s", tab: "t", ref: "r", value: "ordinary private prose" }, ["ordinary private prose"]],
    ["BrowserType", { session: "s", tab: "t", ref: "r", text: "password=hunter2" }, ["hunter2"]],
    ["BrowserSelect", { session: "s", tab: "t", ref: "r", values: ["private-a", "private-b"] }, ["private-a", "private-b"]],
  ];
  for (const [toolName, toolInput, secrets] of cases) {
    await recordToolCallEvidence({ state, cwd: process.cwd(), toolName, toolInput, snapshotOptions });
    const event = state.events.at(-1)!;
    const rendered = `${event.summary}\n${event.detail}`;
    for (const secret of secrets) assert.equal(rendered.includes(secret), false);
    assert.match(rendered, /\[REDACTED\]/);
  }
});

test("candidate extraction follows mutation semantics instead of generic path arguments", () => {
  for (const toolName of ["read", "grep", "glob", "find", "ls", "SubtasksInspect"]) {
    assert.deepEqual(extractCandidatePaths(toolName, { path: "server/hosts.go" }).paths, [], toolName);
  }

  assert.deepEqual(extractCandidatePaths("write", { path: "server/hosts.go" }).paths, [{
    path: "server/hosts.go",
    source: "write:path",
  }]);
  assert.deepEqual(extractCandidatePaths("edit", { file_path: "server/hosts.go" }).paths, [{
    path: "server/hosts.go",
    source: "edit:file_path",
  }]);

  const copied = extractCandidatePaths("bash", { command: "cp source.txt generated/dest.txt" });
  assert.deepEqual(copied.paths.map((entry) => entry.path), ["generated/dest.txt"]);
  const moved = extractCandidatePaths("bash", { command: "mv source.txt generated/dest.txt" });
  assert.deepEqual(moved.paths.map((entry) => entry.path), ["source.txt", "generated/dest.txt"]);
});

test("evidence pre-captures a missing outside-worktree file before creation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-gate-evidence-cwd-"));
  const outside = join(tmpdir(), `pi-review-gate-outside-${Date.now()}.txt`);
  const state = createEvidenceState();
  try {
    await recordToolCallEvidence({
      state,
      cwd,
      toolName: "write",
      toolInput: { path: outside },
      snapshotOptions,
    });
    await writeFile(outside, "created\n", "utf8");

    const changes = await collectEvidenceChanges(state, cwd, snapshotOptions);

    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.path, outside);
    assert.equal(changes[0]?.status, "added");
    assert.equal(changes[0]?.newContent, undefined);
    assert.equal(changes[0]?.diffOmittedReason, "outside_workspace");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("evidence pre-captures an existing outside-worktree file before modification", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-gate-evidence-cwd-"));
  const outside = join(tmpdir(), `pi-review-gate-outside-existing-${Date.now()}.txt`);
  const state = createEvidenceState();
  try {
    await writeFile(outside, "before\n", "utf8");
    await recordToolCallEvidence({
      state,
      cwd,
      toolName: "bash",
      toolInput: { command: `printf after > ${outside}` },
      snapshotOptions,
    });
    await writeFile(outside, "after\n", "utf8");

    const changes = await collectEvidenceChanges(state, cwd, snapshotOptions);

    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.path, outside);
    assert.equal(changes[0]?.status, "modified");
    assert.equal(changes[0]?.oldContent, undefined);
    assert.equal(changes[0]?.newContent, undefined);
    assert.equal(changes[0]?.diffOmittedReason, "outside_workspace");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("outside-worktree evidence keeps an independent baseline for each exchange", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-gate-evidence-exchanges-cwd-"));
  const outside = join(tmpdir(), `pi-review-gate-outside-exchanges-${Date.now()}.txt`);
  const state = createEvidenceState();
  try {
    await writeFile(outside, "original\n", "utf8");
    await recordToolCallEvidence({
      state,
      cwd,
      toolName: "write",
      toolInput: { path: outside },
      snapshotOptions,
      exchangeSequence: 1,
    });
    await writeFile(outside, "incorrect\n", "utf8");

    await recordToolCallEvidence({
      state,
      cwd,
      toolName: "write",
      toolInput: { path: outside },
      snapshotOptions,
      exchangeSequence: 2,
    });
    await writeFile(outside, "original\n", "utf8");

    const cumulative = await collectEvidenceChanges(state, cwd, snapshotOptions);
    const correction = await collectEvidenceChanges(state, cwd, snapshotOptions, 2);

    assert.equal(cumulative.length, 0);
    assert.equal(correction.length, 1);
    assert.equal(correction[0]?.oldContent, undefined);
    assert.equal(correction[0]?.newContent, undefined);
    assert.equal(state.events[0]?.exchangeSequence, 1);
    assert.equal(state.events[1]?.exchangeSequence, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("rememberFinalAssistantSummary extracts the last assistant text", () => {
  const state = createEvidenceState();

  rememberFinalAssistantSummary(state, [
    {
      messages: [
        { role: "assistant", content: "older" },
        { role: "user", content: "thanks" },
        { role: "assistant", content: [{ type: "text", text: "final summary" }] },
      ],
    },
  ]);

  assert.equal(state.finalAssistantSummaries.at(-1), "final summary");
});

test("rememberFinalAssistantSummary keeps multiple turn summaries for continued review", () => {
  const state = createEvidenceState();

  rememberFinalAssistantSummary(state, [{ messages: [{ role: "assistant", content: "first summary" }] }]);
  rememberFinalAssistantSummary(state, [{ messages: [{ role: "assistant", content: "second summary" }] }]);

  const bundle = buildEvidenceBundle(state, []);

  assert.deepEqual(state.finalAssistantSummaries, ["first summary", "second summary"]);
  assert.match(bundle.markdown, /Summary 1/);
  assert.match(bundle.markdown, /first summary/);
  assert.match(bundle.markdown, /Summary 2/);
  assert.match(bundle.markdown, /second summary/);
});

test("rememberFinalAssistantSummaryText bounds and redacts adapter-extracted responses", () => {
  const state = createEvidenceState();

  rememberFinalAssistantSummaryText(
    state,
    `  Completion reported with api_key=${"x".repeat(48)}. ${"a".repeat(5000)}  `,
  );

  assert.equal(state.finalAssistantSummaries.length, 1);
  assert.ok(state.finalAssistantSummaries[0]!.length <= 4020);
  assert.match(state.finalAssistantSummaries[0]!, /\[\.\.\. truncated \.\.\.\]$/);
  assert.doesNotMatch(state.finalAssistantSummaries[0]!, /x{48}/);
  assert.match(state.finalAssistantSummaries[0]!, /Completion reported/);
});

test("review-window evidence does not discard older assistant summaries", () => {
  const state = createEvidenceState();
  for (let index = 1; index <= 12; index += 1) {
    rememberFinalAssistantSummary(state, [{ messages: [{ role: "assistant", content: `summary ${index}` }] }]);
  }

  const bundle = buildEvidenceBundle(state, []);

  assert.equal(state.finalAssistantSummaries.length, 12);
  assert.match(bundle.markdown, /Summary 1\n\nsummary 1/);
  assert.match(bundle.markdown, /Summary 12\n\nsummary 12/);
});

test("evidence markdown preserves every tool event in the review window", () => {
  const state = createEvidenceState();
  for (let index = 1; index <= 200; index += 1) {
    state.events.push({
      sequence: index,
      phase: "tool_call",
      toolName: "bash",
      summary: `event ${index}`,
      candidatePaths: [],
      riskSignals: [],
    });
  }

  const bundle = buildEvidenceBundle(state, []);

  assert.match(bundle.markdown, /#1 tool_call bash: event 1/);
  assert.match(bundle.markdown, /#40 tool_call bash: event 40/);
  assert.match(bundle.markdown, /#41 tool_call bash: event 41/);
  assert.match(bundle.markdown, /#80 tool_call bash: event 80/);
  assert.match(bundle.markdown, /#81 tool_call bash: event 81/);
  assert.match(bundle.markdown, /#200 tool_call bash: event 200/);
  assert.doesNotMatch(bundle.markdown, /events omitted/);
});

test("accepted reviewer questions and edited answers become structured evidence", () => {
  const state = createEvidenceState();

  recordAcceptedReviewerQuestion(state, {
    question: "How should this be fixed?",
    acceptedAnswer: "Use this exact edit:\n\n```diff\n-old\n+new\n```",
    acceptedAt: "2026-07-29T00:00:00.000Z",
  });

  const bundle = buildEvidenceBundle(state, []);

  assert.deepEqual(bundle.acceptedReviewerQuestions, [{
    sequence: 1,
    question: "How should this be fixed?",
    acceptedAnswer: "Use this exact edit:\n\n```diff\n-old\n+new\n```",
    acceptedAt: "2026-07-29T00:00:00.000Z",
  }]);
  assert.match(bundle.markdown, /Accepted reviewer questions and answers/);
  assert.match(bundle.markdown, /```diff\n-old\n\+new\n```/);
});

test("evidence candidate baselines distinguish unreadable existing paths and surface in markdown", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-evidence-unreadable-"));
  try {
    await writeFile(join(dir, "candidate.txt"), "candidate content\n", "utf8");
    await chmod(join(dir, "candidate.txt"), 0o000);
    const state = createEvidenceState();
    await recordToolCallEvidence({
      state,
      cwd: dir,
      toolName: "write",
      toolInput: { path: "candidate.txt" },
      snapshotOptions,
    });
    const bundle = buildEvidenceBundle(state, []);
    const candidate = bundle.candidates.find((entry) => entry.path === "candidate.txt");
    assert.equal(candidate?.baseline, "unreadable");
    assert.equal(candidate?.baselineSnapshot?.omittedReason, "unreadable");
    assert.match(bundle.markdown, /candidate\.txt \(unreadable;/);
  } finally {
    await chmod(join(dir, "candidate.txt"), 0o644).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});
