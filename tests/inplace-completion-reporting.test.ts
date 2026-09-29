// #220/PR226 regression: in-place completion reporting names the recorded
// workspace delta and the observed external paths as separate bounded
// categories with the actual review disposition, and carries no repeated
// rollback/unknown/concurrent-writer/observability narrative. The detailed
// baseline, observation evidence, limits, and review context stay durable in
// result.json, the review cycle records, and the reviewer request — they are
// not re-quoted into routine model-facing prose.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInPlaceCompletionLines,
  formatInPlaceChangedPaths,
  formatInPlaceExternalPaths,
  INPLACE_COMPLETION_MAX_NAMED_PATHS,
  inPlaceFailureError,
  inPlaceLimitLines,
  inPlaceReviewDisposition,
} from "../src/execution/background-controller";
import type { InPlaceLifecycleResult } from "../src/execution/inplace-worker";

/** Narrative omitted from routine in-place completion prose (#220/PR226). */
const REJECTED_NARRATIVE = [
  "cannot prove which post-launch changes",
  "no verdict was fabricated",
  "Missing events do not establish",
  "nothing was gated, rolled back, or landed",
  "Attribution (authoritative)",
  "Attribution remains bounded",
];

function settledResult(overrides: Partial<InPlaceLifecycleResult> = {}): InPlaceLifecycleResult {
  return {
    status: "reviewed",
    taskId: "task-hello",
    title: "hello in place",
    summary: "worker summary text",
    adapter: "run-as-binary",
    workspaceRoot: "/workspace",
    baseline: {} as InPlaceLifecycleResult["baseline"],
    changedSinceLaunch: [{ status: "added", path: "hello.txt" }],
    reviewCycles: [],
    artifactDir: "/artifacts/task-hello",
    operationRecord: "/artifacts/task-hello/operation.json",
    ...overrides,
  };
}

test("settled completion names the root delta and external paths as separate categories with the actual verdict", () => {
  // Regression evidence shape: root hello.txt recorded as the delta, an
  // observed /dev/null candidate kept in its own category (constructed here;
  // e2e runs must not depend on a real /dev/null candidate surviving).
  const lines = buildInPlaceCompletionLines(settledResult({ observedExternalPaths: ["/dev/null"] }));
  assert.deepEqual(lines, [
    "In-place task task-hello finished in place in /workspace. Review: passed.",
    "Workspace changes since launch: added hello.txt",
    "Additional observed paths outside workspace: /dev/null",
  ]);
  const text = lines.join("\n");
  assert.doesNotMatch(text, /1 path\(s\) changed/i, "the delta is named, not counted");
  for (const rejected of REJECTED_NARRATIVE) {
    assert.doesNotMatch(text, new RegExp(rejected, "i"), `no rejected narrative: ${rejected}`);
  }
});

test("no delta reports no recorded workspace changes without claiming no external effects", () => {
  const lines = buildInPlaceCompletionLines(settledResult({ status: "no_changes", changedSinceLaunch: [] }));
  assert.deepEqual(lines, [
    "In-place task task-hello finished in place in /workspace. Review: not run.",
    "Workspace changes since launch: no recorded workspace changes",
  ]);
  const text = lines.join("\n");
  assert.doesNotMatch(text, /no external/i, "does not claim the absence of external effects");
});

test("review-disabled settlement reports disabled, never a fabricated pass", () => {
  const lines = buildInPlaceCompletionLines(settledResult({ status: "unreviewed" }));
  assert.match(lines[0]!, /^In-place task task-hello finished in place in \/workspace\. Review: disabled\.$/);
  assert.doesNotMatch(lines.join("\n"), /Review: passed/i);
});

test("an uninspected delta reports the inspection error as a short fact", () => {
  const lines = buildInPlaceCompletionLines(settledResult({ status: "unreviewed", attributionError: "scan failed: EACCES" }));
  assert.equal(lines[1], "Workspace changes since launch: could not be verified (scan failed: EACCES)");
});

test("named lists are bounded with visible overflow and truncation counts", () => {
  const many = Array.from({ length: INPLACE_COMPLETION_MAX_NAMED_PATHS + 3 }, (_unused, index) => ({ status: "added", path: `f${index}.txt` }));
  assert.equal(
    formatInPlaceChangedPaths(many),
    `${many.slice(0, INPLACE_COMPLETION_MAX_NAMED_PATHS).map((change) => `added ${change.path}`).join(", ")} (+3 more)`,
  );
  const external = Array.from({ length: INPLACE_COMPLETION_MAX_NAMED_PATHS + 2 }, (_unused, index) => `/tmp/other-${index}.txt`);
  assert.equal(
    formatInPlaceExternalPaths(external),
    `${external.slice(0, INPLACE_COMPLETION_MAX_NAMED_PATHS).join(", ")} (+2 more)`,
  );
  assert.equal(formatInPlaceExternalPaths(["/dev/null"]), "/dev/null");
  assert.equal(formatInPlaceExternalPaths([]), undefined, "no observations produce no external line");
  assert.equal(formatInPlaceChangedPaths([]), "no recorded workspace changes");
});

test("a passing aggregate with partial reviewer failure keeps its warning", () => {
  const lines = buildInPlaceCompletionLines(settledResult({
    reviewReport: { aggregate: "pass_with_warnings" } as InPlaceLifecycleResult["reviewReport"],
  }));
  assert.match(lines[0]!, / Review: passed with reviewer infrastructure warnings\.$/);
});

function cycle(verdict: "pass" | "needs_changes" | "error", cycleNumber = 1): InPlaceLifecycleResult["reviewCycles"][number] {
  return {
    cycle: cycleNumber,
    verdict,
    reviewOutput: {} as InPlaceLifecycleResult["reviewCycles"][number]["reviewOutput"],
    changedSinceLaunch: [],
    identity: `identity-${cycleNumber}`,
  };
}

test("no delta after earlier cycles names those verdicts instead of claiming the final state passed", () => {
  const lines = buildInPlaceCompletionLines(settledResult({
    status: "no_changes",
    changedSinceLaunch: [],
    reviewCycles: [cycle("needs_changes")],
  }));
  assert.deepEqual(lines, [
    "In-place task task-hello finished in place in /workspace. Review: not run on the final empty delta (earlier cycle verdicts: needs_changes).",
    "Workspace changes since launch: no recorded workspace changes",
  ]);
});

test("tool-observation truncation is reported even with no observed external paths", () => {
  const lines = buildInPlaceCompletionLines(settledResult({ status: "unreviewed", toolObservationsTruncated: true }));
  assert.deepEqual(lines, [
    "In-place task task-hello finished in place in /workspace. Review: disabled.",
    "Workspace changes since launch: added hello.txt",
    "Tool-event observations truncated.",
  ]);
});

test("recorded snapshot omissions and omission-list truncation stay short actual facts", () => {
  const baseline = {
    workspaceRoot: "/workspace",
    mode: "non_git" as const,
    capturedAt: "2024-01-01T00:00:00.000Z",
    snapshot: { cwd: "/workspace", capturedAt: "2024-01-01T00:00:00.000Z", files: new Map(), omissions: ["a", "b", "c"], omissionsTruncated: true },
  } as unknown as InPlaceLifecycleResult["baseline"];
  const lines = buildInPlaceCompletionLines(settledResult({ status: "no_changes", changedSinceLaunch: [], baseline }));
  assert.equal(lines.at(-1), "Snapshot omissions recorded: 3 (omission list truncated)");
  // Zero omissions produce no limit line.
  const clean = buildInPlaceCompletionLines(settledResult({
    status: "no_changes",
    changedSinceLaunch: [],
    baseline: { ...baseline, snapshot: { ...baseline.snapshot, omissions: [], omissionsTruncated: false } },
  }));
  assert.deepEqual(inPlaceLimitLines({ baseline }), ["Snapshot omissions recorded: 3 (omission list truncated)"]);
  assert.deepEqual(inPlaceLimitLines({}), []);
});

test("stopped-task error retains both the lifecycle failure reason and the undelivered-steering count", () => {
  const combined = inPlaceFailureError(2, { status: "timeout", error: "executor turn timed out after 30000ms", summary: "unused when error is set" });
  assert.equal(combined, "2 queued steering instruction(s) were not applied.; executor turn timed out after 30000ms");
  const reasonOnly = inPlaceFailureError(0, { status: "review_error", error: "reviewer exited 1", summary: "fallback text" });
  assert.equal(reasonOnly, "reviewer exited 1");
  const steeringOnly = inPlaceFailureError(1, { status: "timeout", summary: "" });
  assert.equal(steeringOnly, "1 queued steering instruction(s) were not applied.");
});

test("review dispositions are the actual settled verdicts", () => {
  const base = { reviewCycles: [] as InPlaceLifecycleResult["reviewCycles"] };
  assert.equal(inPlaceReviewDisposition({ status: "reviewed", ...base }), "passed");
  assert.equal(inPlaceReviewDisposition({ status: "unreviewed", ...base }), "disabled");
  assert.equal(inPlaceReviewDisposition({ status: "no_changes", ...base }), "not run");
});
