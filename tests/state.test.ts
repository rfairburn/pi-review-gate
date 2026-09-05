import assert from "node:assert/strict";
import test from "node:test";
import {
  beginAgentRun,
  buildRequestContext,
  clearReviewState,
  closeReviewWindow,
  createState,
  freezeReviewWindowConfig,
  getReviewerQuestionWindow,
  getCorrectionAttemptCount,
  markCappedFeedbackSent,
  reconcileRestoredReviewWindows,
  reconcileWindowReviewerSelection,
  recordAcceptedReviewerQuestion,
  recordReviewerFeedback,
  rememberUserRequest,
  setReviewWindowBaseline,
} from "../src/state";
import { duplicateReviewerSelectionsFor, materializeReviewConfig, normalizeConfig, unresolvedReviewerSelectionsFor } from "../src/config";
import { configDigest, reviewerSelectionDigest } from "../src/session-state";

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
  assert.equal(window.requestHistory.at(-1)?.text, "the -geolite2 needs to go back for pinterest");
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
  rememberUserRequest(state, "additional user guidance");

  assert.equal(state.reviewWindow, window);
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

test("superseded retained bundles remain owned for application shutdown cleanup", () => {
  const state = createState();
  rememberUserRequest(state, "first task");
  state.reviewWindow!.bundleDir = "/tmp/pi-review-gate-owned-bundle";
  state.reviewWindow!.retainBundleAfterClose = true;

  closeReviewWindow(state, true);
  rememberUserRequest(state, "next task");

  assert.deepEqual([...state.ownedBundleDirs], ["/tmp/pi-review-gate-owned-bundle"]);
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
  state.pendingModelDeliveries.push({
    deliveryId: "queued-old-input",
    kind: "queued_user_input",
    channel: "follow_up",
    message: "old queued input",
    status: "queued",
    createdAt: new Date().toISOString(),
  });

  clearReviewState(state);

  assert.equal(state.reviewWindow, undefined);
  assert.equal(state.lastQuestionWindow, undefined);
  assert.deepEqual(state.queuedUserInputsDuringReview, []);
  assert.equal(state.pendingModelDeliveries[0]?.status, "cancelled");

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
    disposition: "sent_at_cap",
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
  assert.match(context, /complete feedback transmitted to the implementing model with correction deferred at the cap/);
  assert.match(context, /Historical prior review feedback/);
  assert.match(context, /Do not assume they remain unresolved/);
  assert.match(context, /A guard is missing/);

  markCappedFeedbackSent(state);
  assert.match(buildRequestContext(state), /feedback held at the correction cap, then sent by \/review-continue/);
});

test("buildRequestContext can focus correction prompts on only the latest prior review", () => {
  const state = createState();
  rememberUserRequest(state, "implement the authorized task");
  for (const [sequence, summary] of [[1, "old intermediate finding"], [2, "latest unresolved finding"]] as const) {
    recordReviewerFeedback(state, {
      reviewSequence: sequence,
      source: "automatic",
      disposition: "sent_for_correction",
      result: {
        reviewerId: "reviewer",
        verdict: "needs_changes",
        summary,
        findings: [],
      },
    });
  }

  const focused = buildRequestContext(state, state.reviewWindow, { priorFeedback: "latest" });
  assert.match(focused, /implement the authorized task/);
  assert.match(focused, /latest unresolved finding/);
  assert.doesNotMatch(focused, /old intermediate finding/);
});

test("beginAgentRun preserves the review-window baseline and evidence across continuations", () => {
  const state = createState();

  assert.equal(beginAgentRun(state), "new");
  setReviewWindowBaseline(state, {
    cwd: "/tmp/project",
    capturedAt: "2026-07-01T00:00:00.000Z",
    files: new Map(),
    omissions: [],
    omissionsTruncated: false,
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

test("a review window keeps its original reviewer selection after live config changes", () => {
  const state = createState();
  beginAgentRun(state);
  const config = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["one"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
      { id: "two", adapter: "generic-cli", command: process.execPath },
    ],
  });

  const frozen = freezeReviewWindowConfig(state, config);
  config.enabledReviewerIds = ["two"];

  assert.deepEqual(frozen.enabledReviewerIds, ["one"]);
  assert.deepEqual(frozen.reviewers?.map((reviewer) => reviewer.id), ["one"]);
  assert.equal(freezeReviewWindowConfig(state, config), frozen);
});

test("a review window materializes and freezes scoped pi reviewers", () => {
  const state = createState();
  beginAgentRun(state);
  const config = normalizeConfig({
    enabled: true,
    review: {
      activeReviewers: [{ source: "pi", model: "openai-codex/gpt-5.6-sol" }],
    },
  });

  const frozen = freezeReviewWindowConfig(state, config, ["openai-codex/gpt-5.6-sol"]);

  assert.equal(frozen.enabled, true);
  assert.equal(frozen.review, undefined);
  assert.equal(frozen.reviewers?.[0]?.adapter, "pi-model");
  assert.equal(
    frozen.reviewers?.[0] && "model" in frozen.reviewers[0] ? frozen.reviewers[0].model : undefined,
    "openai-codex/gpt-5.6-sol",
  );
  assert.equal(freezeReviewWindowConfig(state, config, []), frozen);
});

test("historical review context shows internal model labels instead of encoded reviewer ids", () => {
  const state = createState();
  beginAgentRun(state);
  const frozen = freezeReviewWindowConfig(state, normalizeConfig({
    enabled: true,
    review: {
      activeReviewers: [{
        source: "pi",
        model: "ollama/deepseek-v4-flash:0731-cloud",
        thinkingLevel: "high",
      }],
    },
  }), ["ollama/deepseek-v4-flash:0731-cloud"]);
  const reviewer = frozen.reviewers?.[0];
  assert.ok(reviewer);
  // Production snapshots the running configuration's labels at record time;
  // the history entry then renders from that snapshot, never from whatever
  // configuration is current later.
  recordReviewerFeedback(state, {
    source: "automatic",
    disposition: "sent_for_observation",
    result: {
      reviewerId: reviewer.id,
      verdict: "pass",
      summary: "No issue found.",
      findings: [],
    },
    displayLabels: { [reviewer.id]: "ollama/deepseek-v4-flash:0731-cloud (high)" },
  });

  const context = buildRequestContext(state);
  assert.match(context, /ollama\/deepseek-v4-flash:0731-cloud \(high\) \(pass\)/);
  assert.doesNotMatch(context, new RegExp(reviewer.id));
});

function reconciledWindowState() {
  const state = createState();
  beginAgentRun(state);
  setReviewWindowBaseline(state, {
    cwd: "/tmp/project",
    capturedAt: "2026-07-01T00:00:00.000Z",
    files: new Map(),
    omissions: [],
    omissionsTruncated: false,
  });
  state.reviewWindow!.evidence.events.push({
    sequence: 1,
    phase: "tool_call",
    toolName: "edit",
    summary: "preserved evidence",
    candidatePaths: ["index.ts"],
    riskSignals: [],
  });
  return state;
}

test("reconcileRestoredReviewWindows re-freezes restored windows onto the current configuration", () => {
  const state = reconciledWindowState();
  const configA = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["one"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
      { id: "two", adapter: "generic-cli", command: process.execPath },
    ],
  });
  // Simulate a restored window whose frozen config was dropped by persistence
  // and which still carries the legacy blocking flag from an old version.
  state.reviewWindow!.reviewConfig = undefined;
  state.reviewWindow!.reviewConfigurationError = "Persisted review state used a different reviewer configuration; clear or reconcile the review window before continuing.";

  const configB = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["two"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
      { id: "two", adapter: "generic-cli", command: process.execPath },
    ],
  });

  const reconciliation = reconcileRestoredReviewWindows(state, {
    reviewConfigDigest: configDigest(configA),
    reviewerSelectionDigest: reviewerSelectionDigest(configA),
  }, configB);

  assert.equal(reconciliation.windows, 1);
  assert.equal(reconciliation.reviewers, 1);
  assert.equal(reconciliation.configurationChanged, true);
  assert.equal(state.reviewWindow!.reviewConfigurationError, undefined);
  const reconciledConfig = state.reviewWindow!.reviewConfig as import("../src/config").ReviewGateConfig | undefined;
  assert.deepEqual(reconciledConfig?.enabledReviewerIds, ["two"]);
  // Preserved evidence survives reconciliation untouched.
  assert.equal(state.reviewWindow!.evidence.events.length, 1);
  assert.equal(state.reviewWindow!.evidence.events[0]?.summary, "preserved evidence");
});

test("reconcileRestoredReviewWindows reports no change when the reviewer selection is identical", () => {
  const state = reconciledWindowState();
  const configA = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["one"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
      { id: "two", adapter: "generic-cli", command: process.execPath },
    ],
  });
  state.reviewWindow!.reviewConfig = undefined;

  // Only unrelated settings changed between save and restore.
  const configB = normalizeConfig({
    enabled: true,
    timeoutMs: 999999,
    maxPatchBytes: 123456,
    enabledReviewerIds: ["one"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
      { id: "two", adapter: "generic-cli", command: process.execPath },
    ],
  });

  const reconciliation = reconcileRestoredReviewWindows(state, {
    reviewConfigDigest: configDigest(configA),
    reviewerSelectionDigest: reviewerSelectionDigest(configA),
  }, configB);

  assert.equal(reconciliation.configurationChanged, false);
});

test("reconcileWindowReviewerSelection swaps only the reviewer selection of a frozen window", () => {
  const state = reconciledWindowState();
  const configA = normalizeConfig({
    enabled: true,
    reviewerTimeoutMs: 555,
    maxPatchBytes: 100,
    enabledReviewerIds: ["one"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
      { id: "two", adapter: "generic-cli", command: process.execPath },
    ],
  });
  freezeReviewWindowConfig(state, configA);
  const frozenA = state.reviewWindow!.reviewConfig!;

  // A later in-session settings change selects a different reviewer.
  const configB = normalizeConfig({
    enabled: true,
    reviewerTimeoutMs: 777,
    maxPatchBytes: 200,
    enabledReviewerIds: ["two"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
      { id: "two", adapter: "generic-cli", command: process.execPath },
    ],
  });

  assert.equal(reconcileWindowReviewerSelection(state.reviewWindow!, configB), true);
  const reconciled = state.reviewWindow!.reviewConfig!;
  assert.notEqual(reconciled, frozenA);
  // Only the reviewer selection (and enabled flag) is replaced.
  assert.deepEqual(reconciled.enabledReviewerIds, ["two"]);
  assert.equal(reconciled.reviewers?.length, 1);
  assert.equal(reconciled.reviewers?.[0]?.id, "two");
  // Evidence-affecting frozen settings and captured state are preserved.
  assert.equal(reconciled.reviewerTimeoutMs, 555);
  assert.equal(reconciled.maxPatchBytes, 100);
  assert.equal(state.reviewWindow!.evidence.events.length, 1);
  // The previous frozen config object is never mutated: an invocation that
  // already started under it keeps the exact selection it began with.
  assert.deepEqual(frozenA.enabledReviewerIds, ["one"]);
});

test("reconcileWindowReviewerSelection recovers a zero-usable frozen window without reload", () => {
  const state = reconciledWindowState();
  // Frozen while the only selection was unresolvable: nothing usable to run.
  const staleConfig = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["gone"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
    ],
  });
  freezeReviewWindowConfig(state, staleConfig);
  assert.equal(state.reviewWindow!.reviewConfig!.reviewers?.length, 0);

  // The settings are fixed in-session; the next review must be able to run.
  const fixedConfig = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["one"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
    ],
  });
  assert.equal(reconcileWindowReviewerSelection(state.reviewWindow!, fixedConfig), true);
  assert.equal(state.reviewWindow!.reviewConfig!.reviewers?.length, 1);

  // An unfrozen window needs no reconciliation.
  const fresh = createState();
  fresh.reviewWindow = {
    ...state.reviewWindow!,
    reviewConfig: undefined,
  };
  assert.equal(reconcileWindowReviewerSelection(fresh.reviewWindow!, fixedConfig), false);
});

test("unresolved reviewer selections travel with the frozen config object", () => {
  const state = reconciledWindowState();
  const staleConfig = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["one", "gone"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
    ],
  });
  freezeReviewWindowConfig(state, staleConfig);
  const frozenStale = state.reviewWindow!.reviewConfig!;
  assert.deepEqual(unresolvedReviewerSelectionsFor(frozenStale), ["gone"]);

  // Reconciling replaces the window's config object; the old one still
  // reports its own unresolved selection, so an in-flight invocation under
  // it observes exactly what it started with.
  const fixedConfig = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["one"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
    ],
  });
  assert.equal(reconcileWindowReviewerSelection(state.reviewWindow!, fixedConfig), true);
  assert.deepEqual(unresolvedReviewerSelectionsFor(frozenStale), ["gone"]);
  assert.deepEqual(unresolvedReviewerSelectionsFor(state.reviewWindow!.reviewConfig!), []);
});

test("duplicated and unresolved selections travel with the materialized config object", () => {
  const state = reconciledWindowState();
  const staleConfig = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["one", "one", "gone"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
    ],
  });
  const frozenStale = freezeReviewWindowConfig(state, staleConfig);
  assert.deepEqual(unresolvedReviewerSelectionsFor(frozenStale), ["gone"]);
  assert.deepEqual(duplicateReviewerSelectionsFor(frozenStale), ["one"]);

  // Materialization used outside review windows carries the same metadata.
  const materialized = materializeReviewConfig(staleConfig, []);
  assert.deepEqual(unresolvedReviewerSelectionsFor(materialized), ["gone"]);
  assert.deepEqual(duplicateReviewerSelectionsFor(materialized), ["one"]);

  // Reconciling replaces the window's config object; the old one keeps its
  // own selection metadata.
  const fixedConfig = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["one"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
    ],
  });
  assert.equal(reconcileWindowReviewerSelection(state.reviewWindow!, fixedConfig), true);
  assert.deepEqual(duplicateReviewerSelectionsFor(frozenStale), ["one"]);
  assert.deepEqual(duplicateReviewerSelectionsFor(state.reviewWindow!.reviewConfig!), []);
});

test("historical results without a saved identity render by raw reviewer id, not current labels", () => {
  const state = reconciledWindowState();
  // The window is frozen under a configuration where reviewer id "one" maps
  // to a codex-cli selection with model-b.
  const configB = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["one"],
    reviewers: [
      { id: "one", adapter: "codex-cli", model: "model-b" },
    ],
  });
  freezeReviewWindowConfig(state, configB);

  // A pre-migration history entry: no displayLabel was ever persisted for it.
  recordReviewerFeedback(state, {
    result: { reviewerId: "one", verdict: "pass", summary: "No defect found.", findings: [] },
    reviewerResults: [{ reviewerId: "one", verdict: "pass", summary: "No defect found.", findings: [] }],
    source: "automatic",
    disposition: "sent_for_observation",
  });

  const context = buildRequestContext(state);
  assert.match(context, /- one \(pass\): No defect found\./);
  // The current configuration's label for the same id must not be invented.
  assert.doesNotMatch(context, /model-b/);
});

test("reconcileRestoredReviewWindows falls back to the broad digest for legacy sidecars", () => {
  const state = reconciledWindowState();
  const configA = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["one"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
      { id: "two", adapter: "generic-cli", command: process.execPath },
    ],
  });
  state.reviewWindow!.reviewConfig = undefined;

  const configB = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["two"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
      { id: "two", adapter: "generic-cli", command: process.execPath },
    ],
  });

  // Legacy restore: only the broad digest is available.
  const reconciliation = reconcileRestoredReviewWindows(state, {
    reviewConfigDigest: configDigest(configA),
  }, configB);

  assert.equal(reconciliation.configurationChanged, true);
});

test("recordReviewerFeedback snapshots reviewer display labels for history attribution", () => {
  const state = reconciledWindowState();
  recordReviewerFeedback(state, {
    source: "automatic",
    disposition: "sent_for_observation",
    result: { reviewerId: "one", verdict: "pass", summary: "ok", findings: [] },
    reviewerResults: [
      { reviewerId: "one", verdict: "pass", summary: "ok", findings: [] },
      { reviewerId: "gone", verdict: "error", summary: "not available", findings: [], error: "reviewer_unavailable" },
    ],
    displayLabels: { one: "Alpha (cli)" },
  });

  const recorded = state.reviewWindow!.reviewHistory[0]?.reviewerResults;
  assert.equal(recorded?.[0]?.displayLabel, "Alpha (cli)");
  // Unknown selections keep an honest missing label rather than an invented one.
  assert.equal(recorded?.[1]?.displayLabel, undefined);

  // A later configuration rename must not re-label the completed history.
  const context = buildRequestContext(state);
  assert.match(context, /Alpha \(cli\) \(pass\)/);
  assert.doesNotMatch(context, /one \(pass\)/);
});

test("recordReviewerFeedback prefers an already-stamped display label", () => {
  const state = reconciledWindowState();
  recordReviewerFeedback(state, {
    source: "automatic",
    disposition: "sent_for_observation",
    result: { reviewerId: "one", verdict: "pass", summary: "ok", findings: [], displayLabel: "Original label" },
    displayLabels: { one: "Renamed label" },
  });

  assert.equal(state.reviewWindow!.reviewHistory[0]?.reviewerResults[0]?.displayLabel, "Original label");
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
