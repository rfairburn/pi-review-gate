import assert from "node:assert/strict";
import test from "node:test";
import {
  beginAgentRun,
  buildRequestContext,
  closeReviewWindow,
  createState,
  getReviewerQuestionWindow,
  markCappedFeedbackSent,
  pauseReviewWindow,
  recordReviewerFeedback,
  rememberUserRequest,
  setReviewWindowBaseline,
} from "../src/state";

test("rememberUserRequest appends guidance to the active review window without clearing evidence", () => {
  const state = createState();

  rememberUserRequest(state, "update Fleet release bits");
  const window = state.reviewWindow!;
  window.correctionCycles = 1;
  window.evidence.events.push({
    sequence: 1,
    phase: "tool_call",
    toolName: "edit",
    summary: "edit shared/docker.tf",
    candidatePaths: ["shared/docker.tf"],
    riskSignals: [],
  });

  rememberUserRequest(state, "the -geolite2 needs to go back for pinterest");

  assert.equal(state.reviewWindow, window);
  assert.equal(window.latestRequest, "the -geolite2 needs to go back for pinterest");
  assert.equal(window.requestHistory.length, 2);
  assert.equal(window.requestHistory[0]?.phase, "initial");
  assert.equal(window.requestHistory[1]?.phase, "mid_run");
  assert.equal(window.correctionCycles, 1);
  assert.equal(window.evidence.events.length, 1);
});

test("normal user input at the correction cap stays in the unresolved review window", () => {
  const state = createState();
  rememberUserRequest(state, "original task");
  const window = state.reviewWindow!;
  window.lastCappedFollowUp = "Review found blocking issues.";
  window.correctionCycles = 3;
  window.evidence.events.push({
    sequence: 1,
    phase: "tool_call",
    toolName: "edit",
    summary: "old evidence",
    candidatePaths: ["old.ts"],
    riskSignals: [],
  });
  pauseReviewWindow(state, "paused_at_cap");

  rememberUserRequest(state, "additional user guidance");

  assert.equal(state.reviewWindow, window);
  assert.equal(window.status, "paused_at_cap");
  assert.equal(window.lastCappedFollowUp, "Review found blocking issues.");
  assert.deepEqual(window.requestHistory.map((item) => item.text), ["original task", "additional user guidance"]);
  assert.equal(window.correctionCycles, 3);
  assert.equal(window.evidence.events.length, 1);
});

test("closing a passed review window makes the next request start a fresh window", () => {
  const state = createState();
  rememberUserRequest(state, "first task");
  const first = state.reviewWindow!;
  first.evidence.events.push({
    sequence: 1,
    phase: "tool_call",
    toolName: "edit",
    summary: "old evidence",
    candidatePaths: ["old.ts"],
    riskSignals: [],
  });

  closeReviewWindow(state);
  rememberUserRequest(state, "second task");

  const second = state.reviewWindow!;
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.requestHistory.map((item) => item.text), ["second task"]);
  assert.equal(second.evidence.events.length, 0);
  assert.equal(second.baseline, undefined);
});

test("a no-change window can retain context for reviewer questions without remaining active", () => {
  const state = createState();
  rememberUserRequest(state, "inspect the project and propose a plan");
  const completed = state.reviewWindow!;
  completed.evidence.events.push({
    sequence: 1,
    phase: "tool_call",
    toolName: "read",
    summary: "read planning context",
    candidatePaths: ["index.ts"],
    riskSignals: [],
  });

  closeReviewWindow(state, true);

  assert.equal(state.reviewWindow, undefined);
  assert.equal(getReviewerQuestionWindow(state), completed);
  assert.match(buildRequestContext(state, getReviewerQuestionWindow(state)), /inspect the project and propose a plan/);
});

test("buildRequestContext preserves user guidance and prior capped reviewer feedback", () => {
  const state = createState();
  rememberUserRequest(state, "update Fleet release bits");
  rememberUserRequest(state, "the -geolite2 needs to go back for pinterest");
  recordReviewerFeedback(state, {
    source: "automatic",
    disposition: "held_at_cap",
    followUpMessage: "Review found blocking issues. Add the missing guard.",
    result: {
      reviewerId: "codex",
      verdict: "needs_changes",
      summary: "A guard is missing.",
      findings: [{
        severity: "blocking",
        file: "main.tf",
        line: 4,
        issue: "Missing guard.",
        recommendation: "Add it.",
      }],
    },
  });

  const context = buildRequestContext(state);

  assert.match(context, /Initial user request:\nupdate Fleet release bits/);
  assert.match(context, /Additional user guidance during the same review window:/);
  assert.match(context, /2\. the -geolite2 needs to go back for pinterest/);
  assert.match(context, /feedback held at the correction cap/);
  assert.match(context, /A guard is missing/);
  assert.match(context, /Review found blocking issues\. Add the missing guard/);

  markCappedFeedbackSent(state, "Review found blocking issues. Add the missing guard.");
  assert.match(buildRequestContext(state), /feedback held at the correction cap, then sent by \/review-continue/);
});

test("beginAgentRun preserves the review-window baseline and evidence across continuations", () => {
  const state = createState();

  assert.equal(beginAgentRun(state), "new");
  setReviewWindowBaseline(state, {
    cwd: "/tmp/project",
    capturedAt: "2026-07-01T00:00:00.000Z",
    files: new Map(),
  });
  state.reviewWindow!.evidence.events.push({
    sequence: 1,
    phase: "tool_call",
    toolName: "edit",
    summary: "edit before interrupt",
    candidatePaths: ["before.tf"],
    riskSignals: [],
  });

  assert.equal(beginAgentRun(state), "continuation");
  assert.equal(state.reviewWindow!.baseline!.files.size, 0);
  assert.equal(state.reviewWindow!.evidence.events.length, 1);
  assert.equal(state.reviewWindow!.evidence.events[0]?.summary, "edit before interrupt");
});
