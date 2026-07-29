import assert from "node:assert/strict";
import test from "node:test";
import {
  beginAgentRun,
  buildRequestContext,
  clearReviewState,
  closeReviewWindow,
  createState,
  getReviewerQuestionWindow,
  getCorrectionAttemptCount,
  markCappedFeedbackSent,
  pauseReviewWindow,
  recordAcceptedReviewerQuestion,
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

test("clearReviewState discards every review context and queued input", () => {
  const state = createState();
  rememberUserRequest(state, "old task");
  const oldWindow = state.reviewWindow!;
  oldWindow.lastCappedFollowUp = "old held feedback";
  oldWindow.correctionCycles = 2;
  oldWindow.evidence.events.push({
    sequence: 1,
    phase: "tool_call",
    toolName: "edit",
    summary: "old evidence",
    candidatePaths: ["old.ts"],
    riskSignals: [],
  });
  state.lastQuestionWindow = oldWindow;
  state.queuedUserInputsDuringReview.push("old queued input");

  clearReviewState(state);

  assert.equal(state.reviewWindow, undefined);
  assert.equal(state.lastQuestionWindow, undefined);
  assert.deepEqual(state.queuedUserInputsDuringReview, []);

  rememberUserRequest(state, "fresh task");
  const freshWindow = state.reviewWindow!;
  assert.notEqual(freshWindow.id, oldWindow.id);
  assert.deepEqual(freshWindow.requestHistory.map((item) => item.text), ["fresh task"]);
  assert.equal(freshWindow.baseline, undefined);
  assert.equal(freshWindow.evidence.events.length, 0);
  assert.equal(freshWindow.reviewHistory.length, 0);
  assert.equal(freshWindow.correctionCycles, 0);
});

test("a passed window remains available only until the next regular request", () => {
  const state = createState();
  rememberUserRequest(state, "first task");
  const passed = state.reviewWindow!;
  passed.evidence.events.push({
    sequence: 1,
    phase: "tool_call",
    toolName: "edit",
    summary: "passed-window evidence",
    candidatePaths: ["old.ts"],
    riskSignals: [],
  });

  closeReviewWindow(state, true);

  assert.equal(state.reviewWindow, undefined);
  assert.equal(getReviewerQuestionWindow(state), passed);

  rememberUserRequest(state, "second task");

  const fresh = state.reviewWindow!;
  assert.notEqual(fresh, passed);
  assert.equal(getReviewerQuestionWindow(state), fresh);
  assert.deepEqual(fresh.requestHistory.map((item) => item.text), ["second task"]);
  assert.equal(fresh.evidence.events.length, 0);
  assert.equal(state.lastQuestionWindow, undefined);
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
  assert.match(context, /Historical prior review feedback/);
  assert.match(context, /Do not assume they remain unresolved/);
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

test("an accepted answer after a passed review seeds the next review window evidence", () => {
  const state = createState();
  rememberUserRequest(state, "first task");
  const passed = state.reviewWindow!;
  closeReviewWindow(state, true);

  recordAcceptedReviewerQuestion(state, passed, {
    question: "show the exact fix",
    acceptedAnswer: "Apply:\n\n```diff\n-old\n+new\n```",
  });

  assert.equal(passed.evidence.acceptedReviewerQuestions.length, 1);
  assert.equal(state.pendingAcceptedReviewerQuestions.length, 1);

  beginAgentRun(state);

  assert.notEqual(state.reviewWindow, passed);
  assert.equal(state.reviewWindow!.evidence.acceptedReviewerQuestions.length, 1);
  assert.match(
    state.reviewWindow!.evidence.acceptedReviewerQuestions[0]?.acceptedAnswer ?? "",
    /```diff/,
  );
  assert.equal(state.pendingAcceptedReviewerQuestions.length, 0);
});

test("correction attempt count survives correction-cap budget resets", () => {
  const state = createState();
  rememberUserRequest(state, "fix it");
  recordReviewerFeedback(state, {
    source: "automatic",
    disposition: "sent_for_correction",
    result: {
      reviewerId: "codex",
      verdict: "needs_changes",
      summary: "first correction",
      findings: [],
    },
  });
  recordReviewerFeedback(state, {
    source: "automatic",
    disposition: "held_then_sent",
    result: {
      reviewerId: "codex",
      verdict: "needs_changes",
      summary: "continued correction",
      findings: [],
    },
  });
  state.reviewWindow!.correctionCycles = 0;

  assert.equal(getCorrectionAttemptCount(state.reviewWindow), 2);
});
