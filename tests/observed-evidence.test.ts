import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  captureObservedToolPathAfterStates,
  createEvidenceState,
  EVIDENCE_TEXT_TRUNCATION_MARKER,
  MAX_OBSERVED_PATHS_PER_EVENT,
  recordAcceptedReviewerQuestion,
  recordObservedToolEventEvidence,
  recordReviewEvidenceNote,
  recordToolEventObservability,
  rememberFinalAssistantSummaryText,
} from "../src/evidence";
import { OBSERVED_TOOL_EVIDENCE_FILE, persistObservedToolEvidence, restoreObservedToolEvidence } from "../src/execution/observed-evidence";
import type { InPlaceLifecycleInput, InPlaceLifecycleResult } from "../src/execution/inplace/contracts";
import { settleInPlace } from "../src/execution/inplace/settlement";

test("corrupt persisted tool evidence blocks restoration even when optional", async () => {
  const scratch = await mkdtemp(join(process.cwd(), ".pi-review-observed-evidence-"));
  const artifacts = join(scratch, "artifacts");
  const workspace = join(scratch, "workspace");
  await mkdir(artifacts, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    await writeFile(join(artifacts, OBSERVED_TOOL_EVIDENCE_FILE), JSON.stringify({
      version: 1,
      nextSequence: 2,
      externalObservationRevision: 0,
      toolObservationRevision: 0,
      events: [{ sequence: 1, phase: "tool_call" }],
      candidates: [],
      finalAssistantSummaries: [],
      acceptedReviewerQuestions: [],
      toolObservabilityNotes: [],
      toolObservationsTruncated: false,
      requiresReview: false,
    }), "utf8");

    for (const required of [false, true]) {
      await assert.rejects(
        restoreObservedToolEvidence(createEvidenceState(), artifacts, workspace, { required }),
        /Persisted tool evidence could not be restored/,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("missing optional tool evidence remains compatible while a required basis fails closed", async () => {
  const scratch = await mkdtemp(join(process.cwd(), ".pi-review-observed-evidence-missing-"));
  const artifacts = join(scratch, "artifacts");
  const workspace = join(scratch, "workspace");
  await mkdir(artifacts, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    await restoreObservedToolEvidence(createEvidenceState(), artifacts, workspace);
    await assert.rejects(
      restoreObservedToolEvidence(createEvidenceState(), artifacts, workspace, { required: true }),
      /Persisted tool evidence .* is missing/,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a legacy external marker that points inside the selected root still fails closed", async () => {
  const scratch = await mkdtemp(join(process.cwd(), ".pi-review-observed-scope-"));
  const artifacts = join(scratch, "artifacts");
  const workspace = join(scratch, "workspace");
  const inside = join(workspace, "inside.txt");
  await mkdir(artifacts, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    await writeFile(join(artifacts, OBSERVED_TOOL_EVIDENCE_FILE), JSON.stringify({
      version: 1,
      nextSequence: 1,
      events: [],
      candidates: [{ path: inside, absolutePath: inside, sources: ["legacy"], externalSideEffect: true }],
      finalAssistantSummaries: [],
      acceptedReviewerQuestions: [],
      toolObservabilityNotes: [],
      toolObservationsTruncated: false,
      requiresReview: true,
    }), "utf8");
    await assert.rejects(
      restoreObservedToolEvidence(createEvidenceState(), artifacts, workspace),
      /malformed or out-of-scope/,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("serializer output with truncation markers round-trips and remains valid for InPlace settlement", async () => {
  const scratch = await mkdtemp(join(process.cwd(), ".pi-review-observed-roundtrip-"));
  const artifacts = join(scratch, "artifacts");
  const workspace = join(scratch, "workspace");
  await mkdir(artifacts, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    const state = createEvidenceState();
    rememberFinalAssistantSummaryText(state, "executor summary ".repeat(500));
    state.events.push({
      sequence: 1,
      phase: "tool_call",
      toolName: "w".repeat(250),
      adapter: "a".repeat(120),
      observationId: "o".repeat(250),
      summary: "s".repeat(1200),
      detail: "d".repeat(51_000),
      candidatePaths: Array.from({ length: MAX_OBSERVED_PATHS_PER_EVENT + 2 }, () => "p".repeat(2100)),
      riskSignals: ["r".repeat(250)],
    });
    state.nextSequence = 2;
    recordToolEventObservability(state, "adapter", { mode: "unavailable", description: "u".repeat(2000) });
    recordReviewEvidenceNote(state, "n".repeat(2000));
    recordAcceptedReviewerQuestion(state, {
      question: "q".repeat(21_000),
      acceptedAnswer: "answer ".repeat(3000),
      acceptedAt: "t".repeat(120),
    });

    await persistObservedToolEvidence(state, artifacts);
    const persisted = JSON.parse(await readFile(join(artifacts, OBSERVED_TOOL_EVIDENCE_FILE), "utf8")) as {
      events: Array<{ toolName: string; summary: string; detail?: string; candidatePaths: string[] }>;
      finalAssistantSummaries: string[];
      toolObservabilityNotes: string[];
      reviewEvidenceNotes?: string[];
      acceptedReviewerQuestions: Array<{ question: string; acceptedAnswer: string; acceptedAt: string }>;
      toolObservationsTruncated: boolean;
    };
    assert.ok(persisted.finalAssistantSummaries[0]?.endsWith(EVIDENCE_TEXT_TRUNCATION_MARKER));
    assert.ok(persisted.events[0]?.toolName.endsWith(EVIDENCE_TEXT_TRUNCATION_MARKER));
    assert.ok(persisted.events[0]?.summary.endsWith(EVIDENCE_TEXT_TRUNCATION_MARKER));
    assert.ok(persisted.events[0]?.detail?.endsWith(EVIDENCE_TEXT_TRUNCATION_MARKER));
    assert.equal(persisted.events[0]?.candidatePaths.length, MAX_OBSERVED_PATHS_PER_EVENT);
    assert.ok(persisted.toolObservabilityNotes[0]?.endsWith(EVIDENCE_TEXT_TRUNCATION_MARKER));
    assert.ok(persisted.reviewEvidenceNotes?.[0]?.endsWith(EVIDENCE_TEXT_TRUNCATION_MARKER));
    assert.ok(persisted.acceptedReviewerQuestions[0]?.question.endsWith(EVIDENCE_TEXT_TRUNCATION_MARKER));
    assert.ok(persisted.acceptedReviewerQuestions[0]?.acceptedAnswer.endsWith(EVIDENCE_TEXT_TRUNCATION_MARKER));
    assert.ok(persisted.acceptedReviewerQuestions[0]?.acceptedAt.endsWith(EVIDENCE_TEXT_TRUNCATION_MARKER));
    assert.equal(persisted.toolObservationsTruncated, true);

    const restored = createEvidenceState();
    await restoreObservedToolEvidence(restored, artifacts, workspace, { required: true });
    assert.ok(restored.finalAssistantSummaries[0]?.endsWith(EVIDENCE_TEXT_TRUNCATION_MARKER));
    assert.ok(restored.events[0]?.detail?.endsWith(EVIDENCE_TEXT_TRUNCATION_MARKER));
    assert.ok(restored.reviewEvidenceNotes?.[0]?.endsWith(EVIDENCE_TEXT_TRUNCATION_MARKER));
    assert.ok(restored.acceptedReviewerQuestions[0]?.acceptedAnswer.endsWith(EVIDENCE_TEXT_TRUNCATION_MARKER));
    assert.equal(restored.toolObservationsTruncated, true);

    const baseline = {
      workspaceRoot: workspace,
      mode: "non_git" as const,
      capturedAt: new Date().toISOString(),
      snapshot: { cwd: workspace, capturedAt: new Date().toISOString(), files: new Map(), omissions: [], omissionsTruncated: false },
    } as unknown as InPlaceLifecycleResult["baseline"];
    const result: InPlaceLifecycleResult = {
      status: "reviewed",
      taskId: "task-long-evidence",
      title: "long evidence",
      summary: "settled summary",
      adapter: "adapter",
      workspaceRoot: workspace,
      baseline,
      changedSinceLaunch: [],
      reviewCycles: [],
      artifactDir: artifacts,
      operationRecord: join(artifacts, "operation.json"),
    };
    const input = { taskId: result.taskId, task: {}, workspaceRoot: workspace, artifactDir: artifacts, config: {} } as unknown as InPlaceLifecycleInput;
    const settled = await settleInPlace(input, result);
    assert.equal(settled.status, "reviewed");
    assert.equal(JSON.parse(await readFile(join(artifacts, "result.json"), "utf8")).status, "reviewed");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a legacy version-1 external candidate restores and survives a continuation", async () => {
  const scratch = await mkdtemp(join(process.cwd(), ".pi-review-observed-legacy-"));
  const artifacts = join(scratch, "artifacts");
  const workspace = join(scratch, "workspace");
  const external = join(scratch, "external.txt");
  await mkdir(artifacts, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    await writeFile(external, "legacy observed content\n", "utf8");
    await writeFile(join(artifacts, OBSERVED_TOOL_EVIDENCE_FILE), JSON.stringify({
      version: 1,
      nextSequence: 2,
      externalObservationRevision: 1,
      events: [{ sequence: 1, phase: "tool_call", toolName: "write", adapter: "codex-cli", summary: "write external file", candidatePaths: [external], riskSignals: [] }],
      candidates: [{
        path: external,
        absolutePath: external,
        sources: ["write:path"],
        prestateUnverified: true,
        externalSideEffect: true,
      }],
      finalAssistantSummaries: [],
      acceptedReviewerQuestions: [],
      toolObservabilityNotes: [],
      toolObservationsTruncated: false,
      requiresReview: true,
    }), "utf8");

    const continued = createEvidenceState();
    await restoreObservedToolEvidence(continued, artifacts, workspace, { required: true });
    const legacyCandidate = [...continued.candidates.values()][0];
    assert.equal(legacyCandidate?.toolObserved, true, "legacy external candidates normalize to the canonical observed form");
    assert.equal(legacyCandidate?.externalSideEffect, true);

    recordObservedToolEventEvidence({
      state: continued,
      cwd: workspace,
      selectedRoot: workspace,
      adapter: "codex-cli",
      stage: "start",
      toolName: "write",
      toolInput: { path: external },
    });
    await captureObservedToolPathAfterStates(continued, workspace, { maxFileBytes: 1024 * 1024, maxSnapshotBytes: 1024 * 1024 });
    await persistObservedToolEvidence(continued, artifacts);

    const restoredAgain = createEvidenceState();
    await restoreObservedToolEvidence(restoredAgain, artifacts, workspace, { required: true });
    assert.equal(restoredAgain.events.length, 2);
    assert.equal([...restoredAgain.candidates.values()][0]?.toolObserved, true);
    assert.equal([...restoredAgain.candidates.values()][0]?.externalSideEffect, true);
    assert.equal(restoredAgain.externalObservationRevision, 2);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
