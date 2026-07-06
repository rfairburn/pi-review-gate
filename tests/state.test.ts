import assert from "node:assert/strict";
import test from "node:test";
import { beginAgentRun, buildRequestContext, createState, rememberUserRequest, resetRunEvidence } from "../src/state";

test("resetRunEvidence clears per-run evidence without resetting correction cycles", () => {
  const state = createState();
  state.latestRequest = "original";
  state.correctionCycles = 1;
  state.touchedPaths.add("a.txt");
  state.evidence.events.push({
    sequence: 1,
    phase: "tool_call",
    toolName: "write",
    summary: "write a.txt",
    candidatePaths: ["a.txt"],
    riskSignals: [],
  });

  resetRunEvidence(state);

  assert.equal(state.latestRequest, "original");
  assert.equal(state.requestHistory.length, 0);
  assert.equal(state.correctionCycles, 1);
  assert.equal(state.touchedPaths.size, 0);
  assert.equal(state.evidence.events.length, 0);
});

test("rememberUserRequest appends mid-run guidance without clearing evidence", () => {
  const state = createState();

  rememberUserRequest(state, "update Fleet release bits");
  state.runActive = true;
  state.correctionCycles = 1;
  state.touchedPaths.add("shared/docker.tf");
  state.evidence.events.push({
    sequence: 1,
    phase: "tool_call",
    toolName: "edit",
    summary: "edit shared/docker.tf",
    candidatePaths: ["shared/docker.tf"],
    riskSignals: [],
  });

  rememberUserRequest(state, "the -geolite2 needs to go back for pinterest");

  assert.equal(state.latestRequest, "the -geolite2 needs to go back for pinterest");
  assert.equal(state.requestHistory.length, 2);
  assert.equal(state.requestHistory[0]?.phase, "initial");
  assert.equal(state.requestHistory[1]?.phase, "mid_run");
  assert.equal(state.correctionCycles, 1);
  assert.equal(state.touchedPaths.has("shared/docker.tf"), true);
  assert.equal(state.evidence.events.length, 1);
});

test("rememberUserRequest after capped pause starts a fresh request", () => {
  const state = createState();
  rememberUserRequest(state, "original task");
  state.runActive = false;
  state.reviewPausedAtCap = true;
  state.lastCappedFollowUp = "Review found blocking issues.";
  state.correctionCycles = 3;
  state.evidence.events.push({
    sequence: 1,
    phase: "tool_call",
    toolName: "edit",
    summary: "old evidence",
    candidatePaths: ["old.ts"],
    riskSignals: [],
  });

  rememberUserRequest(state, "new task");

  assert.equal(state.reviewPausedAtCap, false);
  assert.equal(state.lastCappedFollowUp, undefined);
  assert.equal(state.latestRequest, "new task");
  assert.deepEqual(state.requestHistory.map((item) => item.text), ["new task"]);
  assert.equal(state.correctionCycles, 0);
  assert.equal(state.evidence.events.length, 0);
});

test("buildRequestContext preserves initial request and later user guidance", () => {
  const state = createState();

  rememberUserRequest(state, "update Fleet release bits");
  state.runActive = true;
  rememberUserRequest(state, "the -geolite2 needs to go back for pinterest");

  const context = buildRequestContext(state);

  assert.match(context, /Initial user request:\nupdate Fleet release bits/);
  assert.match(context, /Additional user guidance during the same agent run:/);
  assert.match(context, /2\. the -geolite2 needs to go back for pinterest/);
});

test("beginAgentRun preserves baseline and evidence across active continuations", () => {
  const state = createState();

  assert.equal(beginAgentRun(state), "new");
  state.baseline = { cwd: "/tmp/project", capturedAt: "2026-07-01T00:00:00.000Z", files: new Map() };
  state.evidence.events.push({
    sequence: 1,
    phase: "tool_call",
    toolName: "edit",
    summary: "edit before interrupt",
    candidatePaths: ["before.tf"],
    riskSignals: [],
  });

  assert.equal(beginAgentRun(state), "continuation");
  assert.equal(state.baseline.files.size, 0);
  assert.equal(state.evidence.events.length, 1);
  assert.equal(state.evidence.events[0]?.summary, "edit before interrupt");
});
