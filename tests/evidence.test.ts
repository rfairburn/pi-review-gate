import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectEvidenceChanges,
  createEvidenceState,
  extractCandidatePaths,
  recordToolCallEvidence,
  rememberFinalAssistantSummary,
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
    assert.equal(changes[0]?.newContent, "created\n");
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
    assert.equal(changes[0]?.oldContent, "before\n");
    assert.equal(changes[0]?.newContent, "after\n");
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

  assert.equal(state.finalAssistantSummary, "final summary");
});
