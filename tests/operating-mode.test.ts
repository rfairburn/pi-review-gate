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
  assert.doesNotMatch(segments.execute, /including a single bounded phase/);
  assert.doesNotMatch(segments["plan-research"], /including a single bounded phase/);
});

test("the explicit per-request subtask opt-out stays confined to the orchestration segment", () => {
  // Issue 616: honoring an explicit user opt-out is Prefer-orchestration posture
  // guidance. The other mode prompts keep their own unchanged instructions, and the
  // orchestration segment still states the default mandatory routing.
  const segments = loadOperatingModeSegments(join(__dirname, "..", "..", "scripts"));
  assert.match(segments.orchestrate, /not to use a subtask for a specific request/);
  assert.match(segments.orchestrate, /Absent that explicit per-request opt-out, route substantive implementation/);
  for (const mode of ["execute", "plan-research"] as const) {
    assert.doesNotMatch(segments[mode], /per-request opt-out|not to use a subtask/);
  }
});
