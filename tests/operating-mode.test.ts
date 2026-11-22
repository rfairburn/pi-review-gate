import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { normalizeConfig, recoverConfig, OPERATING_MODES } from "../src/config";
import { loadOperatingModeSegments } from "../src/operating-mode";

test("operating modes use one validated config field and preserve sibling settings on recovery", () => {
  assert.equal(normalizeConfig({}).operatingMode, "orchestrate");
  for (const operatingMode of OPERATING_MODES) {
    assert.equal(normalizeConfig({ operatingMode }).operatingMode, operatingMode);
  }
  assert.throws(() => normalizeConfig({ operatingMode: "invalid" }), /operatingMode/);
  const recovered = recoverConfig({ operatingMode: "invalid", reviewerTimeoutMs: 12345 });
  assert.equal(recovered.config.operatingMode, "orchestrate");
  assert.equal(recovered.config.reviewerTimeoutMs, 12345);
  assert.ok(recovered.warnings?.length);
});

test("all three packaged operating-mode segments load independently", () => {
  const segments = loadOperatingModeSegments(join(__dirname, "..", "..", "scripts"));
  assert.match(segments.orchestrate, /# Orchestrator role/);
  assert.match(segments.execute, /# Execution posture/);
  assert.match(segments["plan-research"], /# Planning and research posture/);
  // Issue 408: the "prefer orchestration is a preference" direct-work rule is
  // orchestration posture only; the other prompts keep their own unchanged
  // instructions and gain no direct-work exception.
  for (const mode of ["execute", "plan-research"] as const) {
    assert.doesNotMatch(segments[mode], /clearly simpler to carry out directly|Prefer orchestration is (a preference|not a mandate)/);
  }
});

test("the explicit per-request subtask opt-out stays confined to the orchestration segment", () => {
  // Issue 616: honoring an explicit user opt-out is Prefer-orchestration posture
  // guidance. The other mode prompts keep their own unchanged instructions. The
  // default delegation preference and its conditional routing are checked
  // separately below (#408).
  const segments = loadOperatingModeSegments(join(__dirname, "..", "..", "scripts"));
  assert.match(segments.orchestrate, /not to use a subtask for a specific request/);
  for (const mode of ["execute", "plan-research"] as const) {
    assert.doesNotMatch(segments[mode], /per-request opt-out|not to use a subtask/);
  }
});

test("the orchestration segment separates the delegation preference from delegated routing (#408)", () => {
  // The decision to delegate and the routing of work that is delegated are two
  // distinct instructions: substantive work favors bounded delegation, and only
  // delegated work goes through `SubtasksStart` with a capability-chosen role.
  const segments = loadOperatingModeSegments(join(__dirname, "..", "..", "scripts"));
  assert.match(segments.orchestrate, /Absent that explicit per-request opt-out, substantive implementation, workspace-writing, and runtime or process diagnosis work — including report-only diagnosis that changes no files — favors bounded delegation in bounded phases/);
  assert.match(segments.orchestrate, /When delegating, use `SubtasksStart` and choose the delegate role by the capabilities the work needs/);
  for (const mode of ["execute", "plan-research"] as const) {
    assert.doesNotMatch(segments[mode], /favors bounded delegation|When delegating, use `SubtasksStart`/);
  }
});
