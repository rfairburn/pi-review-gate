/**
 * Synthetic contract tests for the pure Claude native foreground/question/
 * activity reducer (native Claude sidebar status source phase).
 *
 * Every payload here is a hand-written synthetic hook envelope in the shape the
 * installed Claude Code 2.1.325 binary documents: no provider, model, network,
 * process, filesystem, or transcript data is involved. The assertions pin the
 * honesty properties that matter: unknown stays unknown, a definitive question
 * closure is the only source of a false, stale session/prompt/tool and
 * subagent edges never clear newer state, a malformed payload withdraws rather
 * than preserving a stale claim, activity carries a tool TYPE only, and no
 * count is synthesized.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { InstanceStatusUpdate } from "../src/session-host/instances";
import {
  NativeClaudeStatusReducer,
  type NativeClaudeForegroundObservation,
  type NativeClaudeReduceResult,
  type NativeClaudeTerminalRecord,
} from "../src/session-host/native-claude-status";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const QUESTION_TEXT = "which-secret-question-text";
const ANSWER_TEXT = "which-secret-answer-label";
const COMMAND_TEXT = "rm -rf /secret-working-directory";
const PATH_TEXT = "/secret/repo/path/file.ts";

/** The host sink's future observation shape, restated only for a compile-time assignability check. */
interface FutureNativeStatusObservation {
  busy?: boolean | null;
  pendingInput?: boolean | null;
  activity?: readonly string[];
  activeTasks?: number | null;
  activeShells?: number | null;
  support?: {
    agent?: "supported" | "unsupported";
    input?: "supported" | "unsupported";
    tasks?: "supported" | "unsupported";
    shells?: "supported" | "unsupported";
    activity?: "supported" | "unsupported";
  };
}

function hook(hook_event_name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { hook_event_name, session_id: SESSION, cwd: "/work", ...extra };
}

/** One event in an actual observed subagent context (a real non-empty `agent_id`). */
function subagentHook(hook_event_name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return hook(hook_event_name, { agent_id: "agent-1", ...extra });
}

function questionOpen(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return hook("PreToolUse", {
    tool_name: "AskUserQuestion",
    tool_use_id: id,
    tool_input: { questions: [{ question: QUESTION_TEXT, options: [{ label: ANSWER_TEXT }] }] },
    ...extra,
  });
}

function questionClose(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return hook("PostToolUse", {
    tool_name: "AskUserQuestion",
    tool_use_id: id,
    tool_response: { answers: { [QUESTION_TEXT]: ANSWER_TEXT }, annotations: {}, metadata: {} },
    ...extra,
  });
}

/** A reducer already bound to a fully observed root scope from a real SessionStart. */
function boundReducer(): NativeClaudeStatusReducer {
  const reducer = new NativeClaudeStatusReducer();
  expectOutcome(reducer.reduce(hook("SessionStart", { source: "startup" })), "applied", "scope-rebound");
  return reducer;
}

function expectOutcome(result: NativeClaudeReduceResult, outcome: string, reason: string): void {
  assert.equal(result.outcome, outcome, `outcome for ${reason}`);
  assert.equal(result.reason, reason);
}

/** Narrow a non-ignored result to its snapshot; an ignored event carries none. */
function snapshotOf(result: NativeClaudeReduceResult): NativeClaudeForegroundObservation {
  if (result.outcome === "ignored") {
    throw new Error(`expected a snapshot, got ignored (${result.reason})`);
  }
  return result.snapshot;
}

function expectUnknown(observation: NativeClaudeForegroundObservation): void {
  assert.deepEqual(observation, { busy: null, pendingInput: null, activity: [] });
}

test("unknown is the initial state and the snapshot stays inside the shared status Pick", () => {
  const reducer = new NativeClaudeStatusReducer();
  expectUnknown(reducer.snapshot());
  // An unrelated first event claims nothing at all.
  expectOutcome(
    reducer.reduce(hook("Notification", { message: "idle", notification_type: "idle_prompt" })),
    "ignored",
    "unsupported-event",
  );
  expectUnknown(reducer.snapshot());

  // Compile-time proof that this slice is assignable to the host sink's
  // observation without a parallel all-fields framework.
  const observation: FutureNativeStatusObservation = reducer.snapshot();
  const sharedPick: Pick<InstanceStatusUpdate, "busy" | "pendingInput" | "activity"> = reducer.snapshot();
  assert.deepEqual(observation, sharedPick);
  assert.deepEqual(Object.keys(reducer.snapshot()).sort(), ["activity", "busy", "pendingInput"]);
});

test("a question request opens pending input and closes definitively on its matching Post", () => {
  const reducer = boundReducer();
  expectOutcome(reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" })), "applied", "turn-submitted");
  // A fully observed fresh scope vouches its empty question census before any
  // request has ever opened and closed.
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["Working"] });

  const opened = reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  expectOutcome(opened, "applied", "question-request-open");
  assert.deepEqual(snapshotOf(opened), { busy: true, pendingInput: true, activity: ["Working"] });

  const closed = reducer.reduce(questionClose("toolu_q1", { prompt_id: "p1" }));
  expectOutcome(closed, "applied", "question-request-closed");
  assert.deepEqual(snapshotOf(closed), { busy: true, pendingInput: false, activity: ["Working"] });

  // No question text, answer text, or annotation survives anywhere in state.
  assert.equal(JSON.stringify(reducer.snapshot()).includes(QUESTION_TEXT), false);
  assert.equal(JSON.stringify(reducer.snapshot()).includes(ANSWER_TEXT), false);
});

test("closure is definitive with answers, without them, and on the failure edge", () => {
  for (const close of [
    questionClose("toolu_q1"),
    hook("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_q1" }),
    hook("PostToolUseFailure", {
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_q1",
      error: "dismissed",
      tool_response: { answers: {} },
    }),
  ]) {
    const reducer = boundReducer();
    reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
    reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
    assert.equal(reducer.snapshot().pendingInput, true);
    const result = reducer.reduce(close);
    expectOutcome(result, "applied", "question-request-closed");
    // Closed, outcome unknown: never an "answered" claim, never stuck pending.
    assert.deepEqual(snapshotOf(result), { busy: true, pendingInput: false, activity: ["Working"] });
  }
});

test("root question work establishes running initially and after a Stop candidate", () => {
  // Observation beginning with a question request still proves root tool work.
  const adopted = new NativeClaudeStatusReducer();
  adopted.reduce(questionOpen("first"));
  assert.deepEqual(adopted.snapshot(), { busy: true, pendingInput: true, activity: ["Working"] });

  // A blocked Stop continuation that runs straight into a question request.
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("Stop", { prompt_id: "p1", stop_hook_active: true }));
  reducer.reduce(questionOpen("continued", { prompt_id: "p1" }));
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: true, activity: ["Working"] });

  // An established last-tool label is preserved, not overwritten.
  const labeled = boundReducer();
  labeled.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  labeled.reduce(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_read", prompt_id: "p1" }));
  labeled.reduce(questionOpen("ask", { prompt_id: "p1" }));
  assert.deepEqual(labeled.snapshot(), { busy: true, pendingInput: true, activity: ["read"] });
});

test("untrackable root question work withdraws an established Ready", () => {
  for (const overflow of [false, true]) {
    const reducer = boundReducer();
    reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
    if (overflow) {
      for (let i = 0; i < 32; i++) {
        reducer.reduce(subagentHook("PreToolUse", {
          tool_name: "AskUserQuestion", tool_use_id: `sub-${i}`,
        }));
      }
    }
    reducer.confirmTurnEnd({ promptId: "p1" });
    assert.equal(reducer.snapshot().busy, false);
    const result = reducer.reduce(hook("PreToolUse", {
      tool_name: "AskUserQuestion",
      ...(overflow ? { tool_use_id: "overflow" } : {}),
    }));
    expectOutcome(result, "invalid", overflow
      ? "question-census-capacity" : "question-request-unidentified");
    assert.deepEqual(snapshotOf(result), {
      busy: null, pendingInput: overflow ? true : null, activity: [],
    });
  }
});

test("overlapping question requests stay pending until every observed request closes", () => {
  const reducer = boundReducer();
  reducer.reduce(questionOpen("toolu_a"));
  reducer.reduce(questionOpen("toolu_b"));
  assert.equal(reducer.snapshot().pendingInput, true);

  const first = reducer.reduce(questionClose("toolu_b"));
  expectOutcome(first, "applied", "question-request-closed");
  assert.equal(snapshotOf(first).pendingInput, true);

  const second = reducer.reduce(questionClose("toolu_a"));
  expectOutcome(second, "applied", "question-request-closed");
  assert.equal(snapshotOf(second).pendingInput, false);
});

test("question closure uses request correlation across root prompt boundaries", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(questionOpen("old", { prompt_id: "p1" }));
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p2" }));
  reducer.reduce(questionOpen("new", { prompt_id: "p2" }));

  // A close carrying the newer prompt is not the older request's own edge.
  expectOutcome(reducer.reduce(questionClose("old", { prompt_id: "p2" })), "ignored", "stale-prompt");
  // Its own definitive closure still lands, without disturbing the newer turn.
  expectOutcome(reducer.reduce(questionClose("old", { prompt_id: "p1" })), "applied", "question-request-closed");
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: true, activity: ["Working"] });
  expectOutcome(reducer.reduce(questionClose("new", { prompt_id: "p2" })), "applied", "question-request-closed");
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["Working"] });
});

test("the same request identity in root and subagent scope is tracked separately", () => {
  const reducer = boundReducer();
  reducer.reduce(questionOpen("toolu_shared"));
  const subOpen = reducer.reduce(subagentHook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_shared" }));
  expectOutcome(subOpen, "applied", "question-request-open");
  assert.equal(snapshotOf(subOpen).pendingInput, true);

  const subClose = reducer.reduce(subagentHook("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_shared" }));
  expectOutcome(subClose, "applied", "question-request-closed");
  // The root request is still open, so the row is still waiting.
  assert.equal(snapshotOf(subClose).pendingInput, true);

  const rootClose = reducer.reduce(questionClose("toolu_shared"));
  expectOutcome(rootClose, "applied", "question-request-closed");
  assert.equal(snapshotOf(rootClose).pendingInput, false);
});

test("duplicate and out-of-order close edges never fabricate a cleared census", () => {
  const reducer = boundReducer();
  reducer.reduce(questionOpen("toolu_q1"));
  expectOutcome(reducer.reduce(questionOpen("toolu_q1")), "ignored", "duplicate-question-open");
  expectOutcome(reducer.reduce(questionClose("toolu_q1")), "applied", "question-request-closed");
  // A replayed open edge cannot resurrect a definitively closed request.
  expectOutcome(reducer.reduce(questionOpen("toolu_q1")), "ignored", "duplicate-question-open");
  assert.equal(reducer.snapshot().pendingInput, false);
  const duplicate = reducer.reduce(questionClose("toolu_q1"));
  expectOutcome(duplicate, "ignored", "duplicate-question-close");
  assert.equal("snapshot" in duplicate, false, "an ignored event carries no snapshot to submit");

  // A close for a request this reducer never opened is an observation gap.
  const gap = reducer.reduce(questionClose("toolu_never_opened"));
  expectOutcome(gap, "invalid", "question-close-unobserved");
  assert.equal(snapshotOf(gap).pendingInput, null);
});

test("a definitive none-remain claim needs a genuine root scope boundary", () => {
  // Scope adopted mid-stream: a request may already have opened unobserved.
  const reducer = new NativeClaudeStatusReducer();
  reducer.reduce(questionOpen("toolu_q1"));
  const adoptedClose = reducer.reduce(questionClose("toolu_q1"));
  expectOutcome(adoptedClose, "applied", "question-request-closed");
  assert.equal(snapshotOf(adoptedClose).pendingInput, null);

  // The same holds after caller invalidation, which releases the scope.
  expectUnknown(reducer.invalidate());
  reducer.reduce(questionOpen("toolu_q2"));
  const afterInvalidate = reducer.reduce(questionClose("toolu_q2"));
  expectOutcome(afterInvalidate, "applied", "question-request-closed");
  assert.equal(snapshotOf(afterInvalidate).pendingInput, null);

  // Only a real root SessionStart shows the census from its beginning.
  expectOutcome(reducer.reduce(hook("SessionStart", { source: "clear" })), "applied", "scope-rebound");
  reducer.reduce(questionOpen("toolu_q3"));
  const bounded = reducer.reduce(questionClose("toolu_q3"));
  expectOutcome(bounded, "applied", "question-request-closed");
  assert.equal(snapshotOf(bounded).pendingInput, false);
});

test("a conflicting close never consumes an open question request", () => {
  // Root: the prompt correlation fence rejects the older close, the request
  // stays pending, and the properly correlated close is the one that wins.
  const root = boundReducer();
  root.reduce(hook("UserPromptSubmit", { prompt_id: "p2" }));
  root.reduce(questionOpen("toolu_q1", { prompt_id: "p2" }));
  const rejected = root.reduce(questionClose("toolu_q1", { prompt_id: "p1" }));
  expectOutcome(rejected, "ignored", "stale-prompt");
  assert.equal(root.snapshot().pendingInput, true);
  const closed = root.reduce(questionClose("toolu_q1", { prompt_id: "p2" }));
  expectOutcome(closed, "applied", "question-request-closed");
  assert.equal(snapshotOf(closed).pendingInput, false);

  // Subagent scope has no root prompt to fence against, so the request's own
  // recorded correlation guards it: the conflicting close leaves it pending.
  const sub = boundReducer();
  sub.reduce(subagentHook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_q1", prompt_id: "p2" }));
  const mismatch = sub.reduce(subagentHook("PostToolUse", {
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu_q1",
    prompt_id: "p1",
  }));
  expectOutcome(mismatch, "invalid", "question-close-prompt-mismatch");
  assert.equal(snapshotOf(mismatch).pendingInput, true);
  const subClosed = sub.reduce(subagentHook("PostToolUse", {
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu_q1",
    prompt_id: "p2",
  }));
  expectOutcome(subClosed, "applied", "question-request-closed");
  // The correlation hole survives, so no definitive none-remain claim follows.
  assert.equal(snapshotOf(subClosed).pendingInput, null);
});

test("a delayed event from an older root prompt cannot move the foreground or consume a question", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_p1", prompt_id: "p1" }));
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p2" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_p2", prompt_id: "p2" }));
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: true, activity: ["bash"] });

  for (const event of [
    hook("Stop", { stop_hook_active: false, prompt_id: "p1" }),
    hook("StopFailure", { error: "boom", prompt_id: "p1" }),
    hook("PreToolUse", { tool_name: "Edit", tool_use_id: "toolu_p1b", prompt_id: "p1" }),
    hook("PostToolUse", { tool_name: "Read", tool_use_id: "toolu_p1", prompt_id: "p1" }),
  ]) {
    expectOutcome(reducer.reduce(event), "ignored", "stale-prompt");
  }
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: true, activity: ["bash"] });

  // The current turn still settles, and only on a confirmed terminal record.
  const candidate = reducer.reduce(hook("Stop", { stop_hook_active: false, prompt_id: "p2" }));
  expectOutcome(candidate, "applied", "turn-end-candidate");
  // The still-open request is untouched by an unprovable boundary.
  assert.deepEqual(snapshotOf(candidate), { busy: null, pendingInput: true, activity: [] });
  expectOutcome(reducer.confirmTurnEnd({ promptId: "p1" }), "ignored", "stale-prompt");
  const confirmed = reducer.confirmTurnEnd({ promptId: "p2" });
  expectOutcome(confirmed, "applied", "turn-ended-confirmed");
  // The source stated the root turn ENDED, so the still-open root request ended
  // with it: nothing awaits input any more. It is never reported as answered —
  // only as no longer pending — and the census is not stranded as unknown.
  assert.deepEqual(snapshotOf(confirmed), { busy: false, pendingInput: false, activity: ["Ready"] });
});

test("subagent edges never mark the root foreground Ready or replace its tool activity", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_read", tool_input: { file_path: PATH_TEXT } }));
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["read"] });

  for (const event of [
    subagentHook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_sub" }),
    subagentHook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_sub" }),
    subagentHook("Stop", { background_tasks: [] }),
    subagentHook("StopFailure", { error: "subagent failed" }),
  ]) {
    expectOutcome(reducer.reduce(event), "ignored", "subagent-scope");
  }
  // A subagent's own lifecycle boundary is not a root foreground edge either.
  expectOutcome(
    reducer.reduce(subagentHook("SubagentStop", { agent_type: "general" })),
    "ignored",
    "unsupported-event",
  );
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["read"] });

  // A question observed in an actual subagent context stays pending across the
  // root turn end instead of being silently answered away.
  reducer.reduce(subagentHook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_subq" }));
  assert.equal(reducer.snapshot().pendingInput, true);
  const rootStop = reducer.reduce(hook("Stop", { stop_hook_active: false }));
  expectOutcome(rootStop, "applied", "turn-end-candidate");
  // The root boundary is unverifiable and leaves the subagent request untouched.
  assert.deepEqual(snapshotOf(rootStop), { busy: null, pendingInput: true, activity: [] });

  const subClose = reducer.reduce(subagentHook("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_subq" }));
  expectOutcome(subClose, "applied", "question-request-closed");
  assert.deepEqual(snapshotOf(subClose), { busy: null, pendingInput: false, activity: [] });
});

test("Stop is only a candidate boundary; a confirmed terminal record is what yields Ready", () => {
  const reducer = boundReducer();
  expectOutcome(reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" })), "applied", "turn-submitted");
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["Working"] });

  const candidate = reducer.reduce(hook("Stop", { stop_hook_active: false, last_assistant_message: "private reply text" }));
  expectOutcome(candidate, "applied", "turn-end-candidate");
  // Another operator's Stop hook can block and continue this same turn, so the
  // arrival of this observer's Stop proves nothing: unverifiable, never Ready.
  // The question census is a separate observation: no request opened or closed
  // here, so the vouched "none pending" baseline survives the boundary.
  assert.deepEqual(snapshotOf(candidate), { busy: null, pendingInput: false, activity: [] });
  assert.equal(JSON.stringify(snapshotOf(candidate)).includes("private reply text"), false);

  const confirmed = reducer.confirmTurnEnd({ sessionId: SESSION, promptId: "p1" });
  expectOutcome(confirmed, "applied", "turn-ended-confirmed");
  assert.deepEqual(snapshotOf(confirmed), { busy: false, pendingInput: false, activity: ["Ready"] });

  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p2" }));
  const failed = reducer.reduce(hook("StopFailure", { error: "upstream failure" }));
  expectOutcome(failed, "applied", "turn-failed");
  // Unsuccessful or unverifiable: unknown foreground, never a Ready/idle claim.
  assert.deepEqual(snapshotOf(failed), { busy: null, pendingInput: false, activity: [] });

  expectOutcome(reducer.confirmTurnEnd({ promptId: "p2" }), "applied", "turn-ended-confirmed");
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });
});

test("a blocked continuation after a Stop candidate is never falsely Ready", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", prompt_id: "p1" }));
  expectOutcome(
    reducer.reduce(hook("Stop", { stop_hook_active: true, prompt_id: "p1" })),
    "applied",
    "turn-end-candidate",
  );
  assert.deepEqual(reducer.snapshot(), { busy: null, pendingInput: false, activity: [] });

  // A blocking operator hook continues the same turn: new work is observed
  // again, and the row stays non-Ready until the source confirms the end.
  const continued = reducer.reduce(hook("PreToolUse", { tool_name: "Edit", tool_use_id: "toolu_edit", prompt_id: "p1" }));
  expectOutcome(continued, "applied", "tool-type-observed");
  assert.deepEqual(snapshotOf(continued), { busy: true, pendingInput: false, activity: ["edit"] });
  expectOutcome(
    reducer.reduce(hook("Stop", { stop_hook_active: true, prompt_id: "p1" })),
    "applied",
    "turn-end-candidate",
  );
  assert.notEqual(reducer.snapshot().busy, false);

  const confirmed = reducer.confirmTurnEnd({ promptId: "p1" });
  expectOutcome(confirmed, "applied", "turn-ended-confirmed");
  assert.deepEqual(snapshotOf(confirmed), { busy: false, pendingInput: false, activity: ["Ready"] });
});

test("a stale or ended-scope terminal confirmation cannot overwrite current work", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p2" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_b", prompt_id: "p2" }));

  expectOutcome(reducer.confirmTurnEnd({ sessionId: OTHER_SESSION }), "ignored", "stale-session");
  expectOutcome(reducer.confirmTurnEnd({ promptId: "p1" }), "ignored", "stale-prompt");
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["bash"] });

  // An ended scope never accepts a late confirmation, and a fresh scope does
  // not inherit the old prompt correlation.
  expectOutcome(reducer.reduce(hook("SessionEnd", { reason: "prompt_input_exit" })), "applied", "scope-ended");
  expectUnknown(reducer.snapshot());
  expectOutcome(reducer.confirmTurnEnd({ promptId: "p2" }), "ignored", "scope-closed");
  expectOutcome(reducer.reduce(hook("SessionStart", { source: "resume" })), "applied", "scope-rebound");
  expectOutcome(reducer.confirmTurnEnd({ promptId: "p2" }), "applied", "turn-ended-confirmed");
});

test("a persisted root stop-hook summary is terminal only on its documented shape", () => {
  const sufficient: readonly NativeClaudeTerminalRecord[] = [
    { hookLabel: "Stop", preventedContinuation: true, hookErrors: [] },
    { hookEventName: "Stop", preventedContinuation: true, hookErrors: [], hookAdditionalContext: [] },
    { preventedContinuation: false, hookErrors: [] },
    { hookEventName: "Stop", preventedContinuation: false, hookErrors: [], hookAdditionalContext: [] },
  ];
  for (const summary of sufficient) {
    const reducer = boundReducer();
    reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
    reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_b", prompt_id: "p1" }));
    expectOutcome(
      reducer.reduce(hook("Stop", { stop_hook_active: true, prompt_id: "p1" })),
      "applied",
      "turn-end-candidate",
    );
    const confirmed = reducer.confirmTurnEnd({ promptId: "p1", sourceToken: "read-1", summary });
    expectOutcome(confirmed, "applied", "turn-ended-confirmed");
    assert.deepEqual(snapshotOf(confirmed), { busy: false, pendingInput: false, activity: ["Ready"] });
  }

  const undecidable: readonly NativeClaudeTerminalRecord[] = [
    { preventedContinuation: false, hookErrors: [], hookAdditionalContext: ["extra context"] },
    { preventedContinuation: false, hookErrors: ["hook blocked the turn"] },
    { preventedContinuation: false },
    { hookErrors: [], hookAdditionalContext: [] },
    { preventedContinuation: null, hookErrors: [] },
  ];
  for (const summary of undecidable) {
    const reducer = boundReducer();
    reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
    reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_b", prompt_id: "p1" }));
    const result = reducer.confirmTurnEnd({ promptId: "p1", sourceToken: "read-1", summary });
    expectOutcome(result, "invalid", "terminal-record-inconclusive");
    // Neither outcome is invented: the running claim becomes unverifiable.
    assert.deepEqual(snapshotOf(result), { busy: null, pendingInput: null, activity: [] });
    assert.equal(JSON.stringify(reducer.snapshot()).includes("hook blocked the turn"), false);
  }
});

test("only the root stop-hook summary can close the root foreground", () => {
  const nonRoot: readonly NativeClaudeTerminalRecord[] = [
    { isSidechain: true, preventedContinuation: true, hookErrors: [] },
    { agentId: "agent-1", preventedContinuation: true, hookErrors: [] },
    { hookLabel: "SubagentStop", preventedContinuation: true, hookErrors: [] },
    { hookLabel: "PreToolUse", preventedContinuation: true, hookErrors: [] },
    { hookEventName: "SubagentStop", preventedContinuation: true, hookErrors: [] },
  ];
  for (const summary of nonRoot) {
    const reducer = boundReducer();
    reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
    reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_b", prompt_id: "p1" }));
    expectOutcome(
      reducer.confirmTurnEnd({ promptId: "p1", sourceToken: "read-1", summary }),
      "ignored",
      "non-root-terminal-record",
    );
    assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["bash"] });
  }
});

test("a late summary from an older root prompt never overwrites newer hook work", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("Stop", { stop_hook_active: true, prompt_id: "p1" }));
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p2" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_b", prompt_id: "p2" }));

  expectOutcome(
    reducer.confirmTurnEnd({
      promptId: "p1",
      sourceToken: "read-old",
      summary: { preventedContinuation: true, hookErrors: [] },
    }),
    "ignored",
    "stale-prompt",
  );
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["bash"] });

  const confirmed = reducer.confirmTurnEnd({
    promptId: "p2",
    sourceToken: "read-new",
    summary: { preventedContinuation: true, hookErrors: [] },
  });
  expectOutcome(confirmed, "applied", "turn-ended-confirmed");
  assert.deepEqual(snapshotOf(confirmed), { busy: false, pendingInput: false, activity: ["Ready"] });
});

test("an unbound terminal claim cannot overwrite live work, and a repeated read is idempotent", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_b", prompt_id: "p1" }));

  expectOutcome(reducer.confirmTurnEnd(), "ignored", "unbound-terminal-record");
  expectOutcome(
    reducer.confirmTurnEnd({ summary: { preventedContinuation: true, hookErrors: [] } }),
    "ignored",
    "unbound-terminal-record",
  );
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["bash"] });

  expectOutcome(
    reducer.confirmTurnEnd({ sourceToken: "read-1", summary: { preventedContinuation: true, hookErrors: [] } }),
    "applied",
    "turn-ended-confirmed",
  );
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });

  // Re-reading the same persisted record is never a fresh Ready edge.
  expectOutcome(
    reducer.confirmTurnEnd({ sourceToken: "read-1", summary: { preventedContinuation: true, hookErrors: [] } }),
    "ignored",
    "duplicate-terminal-record",
  );
});

test("a confirmed root turn end ENDS its unresolved root request, never a child's", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  assert.equal(reducer.snapshot().pendingInput, true);

  const candidate = reducer.reduce(hook("Stop", { stop_hook_active: true }));
  expectOutcome(candidate, "applied", "turn-end-candidate");
  // A continuation may still be waiting on the request: it is never answered
  // away by a boundary this observer cannot prove final.
  assert.equal(snapshotOf(candidate).pendingInput, true);

  const closed = reducer.reduce(questionClose("toolu_q1"));
  expectOutcome(closed, "applied", "question-request-closed");
  assert.equal(snapshotOf(closed).pendingInput, false);

  // A request still open at a CONFIRMED terminal record ended with that turn: the
  // provider stated the turn over, so nothing awaits input. It is retired as no
  // longer pending — never as answered — and the census keeps its definitive
  // answer instead of being stranded as unknown for the rest of the scope.
  reducer.reduce(questionOpen("toolu_q2"));
  const confirmed = reducer.confirmTurnEnd({ promptId: "p1" });
  expectOutcome(confirmed, "applied", "turn-ended-confirmed");
  assert.deepEqual(snapshotOf(confirmed), { busy: false, pendingInput: false, activity: ["Ready"] });
  expectOutcome(reducer.reduce(questionClose("toolu_q2")), "ignored", "duplicate-question-close");
  assert.equal(reducer.snapshot().pendingInput, false);

  // A subagent's still-open request survives a root completion: it lives in
  // another conversation, and its own definitive close edge owns it.
  const child = boundReducer();
  child.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  child.reduce(subagentHook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_child" }));
  assert.equal(child.snapshot().pendingInput, true);
  const childEnded = child.confirmTurnEnd({ promptId: "p1" });
  expectOutcome(childEnded, "applied", "turn-ended-confirmed");
  assert.deepEqual(snapshotOf(childEnded), { busy: false, pendingInput: true, activity: ["Ready"] });
  expectOutcome(
    child.reduce(subagentHook("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_child" })),
    "applied",
    "question-request-closed",
  );
  assert.equal(child.snapshot().pendingInput, false);
});

test("activity keeps the current/last tool TYPE only, with no payload text", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));

  const bash = reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", tool_input: { command: COMMAND_TEXT } }));
  expectOutcome(bash, "applied", "tool-type-observed");
  assert.deepEqual(snapshotOf(bash), { busy: true, pendingInput: false, activity: ["bash"] });

  const read = reducer.reduce(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_read", tool_input: { file_path: PATH_TEXT } }));
  assert.deepEqual(snapshotOf(read).activity, ["read"]);

  // The close keeps the last observed tool TYPE; only a root Stop yields Ready.
  const done = reducer.reduce(hook("PostToolUse", { tool_name: "Read", tool_use_id: "toolu_read", tool_response: { stdout: "private output" } }));
  expectOutcome(done, "applied", "tool-completed");
  assert.deepEqual(snapshotOf(done), { busy: true, pendingInput: false, activity: ["read"] });

  const serialized = JSON.stringify(reducer.snapshot());
  assert.equal(serialized.includes(COMMAND_TEXT), false);
  assert.equal(serialized.includes(PATH_TEXT), false);
  assert.equal(serialized.includes("private output"), false);

  const stop = reducer.reduce(hook("Stop", { stop_hook_active: false }));
  expectOutcome(stop, "applied", "turn-end-candidate");
  expectOutcome(reducer.confirmTurnEnd(), "applied", "turn-ended-confirmed");
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });
});

test("an older or late tool close never relabels newer tool state or Ready", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_a" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_b" }));
  expectOutcome(
    reducer.reduce(hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_b" })),
    "applied",
    "tool-completed",
  );
  // The older request finishing must not replace the newer tool TYPE.
  expectOutcome(
    reducer.reduce(hook("PostToolUse", { tool_name: "Read", tool_use_id: "toolu_a" })),
    "ignored",
    "stale-tool-close",
  );
  assert.deepEqual(reducer.snapshot().activity, ["bash"]);
  expectOutcome(
    reducer.reduce(hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_b" })),
    "ignored",
    "duplicate-tool-close",
  );

  // After a turn-end boundary its whole ledger is gone, so a delayed close
  // cannot relabel the foreground, and Ready arrives only from a confirmed end.
  expectOutcome(reducer.reduce(hook("Stop", { stop_hook_active: false })), "applied", "turn-end-candidate");
  for (const event of [
    hook("PostToolUse", { tool_name: "Read", tool_use_id: "toolu_a" }),
    hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_b" }),
  ]) {
    expectOutcome(reducer.reduce(event), "ignored", "tool-close-unobserved");
  }
  // The tool ledger is gone, but the question census is a separate observation:
  // the vouched none-pending baseline survives an unverifiable boundary.
  assert.deepEqual(reducer.snapshot(), { busy: null, pendingInput: false, activity: [] });
  expectOutcome(reducer.confirmTurnEnd(), "applied", "turn-ended-confirmed");
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });
});

test("a tool name that is not an identifier earns no label and withdraws the foreground claim", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_read" }));
  assert.deepEqual(reducer.snapshot().activity, ["read"]);

  for (const tool_name of [
    `Bash ${COMMAND_TEXT}`,
    `Read\n${PATH_TEXT}`,
    "Read\u001b[31m",
    "way-too-long".repeat(8),
  ]) {
    const result = reducer.reduce(hook("PreToolUse", { tool_name, tool_use_id: `toolu_${tool_name.length}` }));
    expectOutcome(result, "invalid", "tool-name-unavailable");
    // Nothing trustworthy survives: unknown, never a stale label or Ready.
    expectUnknown(snapshotOf(result));
    assert.equal(JSON.stringify(snapshotOf(result)).includes(COMMAND_TEXT), false);
    reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  }
  expectOutcome(
    reducer.reduce(hook("PostToolUse", { tool_name: "Read 2", tool_use_id: "toolu_read" })),
    "invalid",
    "tool-name-unavailable",
  );
});

test("a malformed payload withdraws an established Ready or cleared-pending claim", () => {
  const malformed: readonly [unknown, "malformed-envelope" | "malformed-scope"][] = [
    [hook("UserPromptSubmit", { session_id: "" }), "malformed-envelope"],
    [hook("Stop", { agent_id: 7 }), "malformed-scope"],
    [null, "malformed-envelope"],
  ];
  for (const [event, reason] of malformed) {
    const reducer = boundReducer();
    reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
    expectOutcome(reducer.confirmTurnEnd({ promptId: "p1" }), "applied", "turn-ended-confirmed");
    assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });

    const result = reducer.reduce(event);
    expectOutcome(result, "invalid", reason);
    expectUnknown(snapshotOf(result));
  }

  // A vouched pendingInput=false cannot survive an unreadable question edge.
  const cleared = boundReducer();
  cleared.reduce(questionOpen("toolu_q1"));
  cleared.reduce(questionClose("toolu_q1"));
  assert.equal(cleared.snapshot().pendingInput, false);
  const degraded = cleared.reduce(hook("PreToolUse", { tool_name: "AskUserQuestion" }));
  expectOutcome(degraded, "invalid", "question-request-unidentified");
  assert.equal(snapshotOf(degraded).pendingInput, null);
});

test("a genuine SessionStart rebinds scope, clears stale claims, and vouches the fresh census empty", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  reducer.reduce(hook("Stop", { stop_hook_active: false }));
  reducer.confirmTurnEnd({ promptId: "p1" });
  // The still-unresolved request ended with that confirmed turn, so the Ready the
  // scope now carries is a definitive none-pending, not an unknown.
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });

  // A source that describes a new or resumed conversation rebinds this scope:
  // no inherited Ready, no inherited pending request, and no fake Ready from the
  // boundary itself; the fully observed fresh scope vouches its census empty.
  for (const source of ["resume", "clear", "compact", "fork"]) {
    const rebound = reducer.reduce(hook("SessionStart", { source, model: "private-model-name" }));
    expectOutcome(rebound, "applied", "scope-rebound");
    assert.deepEqual(snapshotOf(rebound), { busy: null, pendingInput: false, activity: [] });
    reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
    reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  }
  // A `startup` notice naming this same already-bound conversation is not a new
  // boundary at all: it is refused, and the live turn and its request survive.
  expectOutcome(
    reducer.reduce(hook("SessionStart", { source: "startup", model: "private-model-name" })),
    "ignored",
    "duplicate-session-start",
  );
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: true, activity: ["Working"] });
  // The same conversation id arriving as a genuinely new conversation still
  // rebinds, and that new scope is armed for its own corroboration.
  expectOutcome(
    reducer.reduce(hook("SessionStart", { session_id: OTHER_SESSION, source: "startup" })),
    "applied",
    "scope-rebound",
  );
  expectOutcome(reducer.confirmFreshStart({ sessionId: OTHER_SESSION }), "applied", "fresh-start-confirmed");
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });
});

test("events from another native session cannot close current questions or overwrite tool state", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_read" }));
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));

  for (const event of [
    hook("PostToolUse", { tool_name: "Read", tool_use_id: "toolu_read", session_id: OTHER_SESSION }),
    questionClose("toolu_q1", { session_id: OTHER_SESSION }),
    hook("Stop", { stop_hook_active: false, session_id: OTHER_SESSION }),
    hook("SessionEnd", { reason: "other", session_id: OTHER_SESSION }),
  ]) {
    expectOutcome(reducer.reduce(event), "ignored", "stale-session");
  }
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: true, activity: ["read"] });
});

test("ignored events never establish the root session binding", () => {
  const firstEvents: readonly [Record<string, unknown>, string][] = [
    [subagentHook("Stop", { session_id: OTHER_SESSION, stop_hook_active: false }), "subagent-scope"],
    [subagentHook("PreToolUse", {
      session_id: OTHER_SESSION,
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_other",
    }), "subagent-scope"],
    [hook("Notification", { session_id: OTHER_SESSION, notification_type: "idle_prompt" }), "unsupported-event"],
    [hook("SessionEnd", { session_id: OTHER_SESSION, reason: "prompt_input_exit" }), "unbound-session"],
  ];
  for (const [event, reason] of firstEvents) {
    const reducer = new NativeClaudeStatusReducer();
    expectOutcome(reducer.reduce(event), "ignored", reason);
    expectUnknown(reducer.snapshot());
    // The real row's first event is still adopted, not rejected as stale.
    const applied = reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
    expectOutcome(applied, "applied", "turn-submitted");
    assert.deepEqual(snapshotOf(applied), { busy: true, pendingInput: null, activity: ["Working"] });
  }
});

test("SessionEnd invalidates the scope and only a new SessionStart reopens it", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));

  const ended = reducer.reduce(hook("SessionEnd", { reason: "clear" }));
  expectOutcome(ended, "applied", "scope-ended");
  // Stale Ready and stale pending questions are gone; nothing is claimed as idle or clear.
  expectUnknown(snapshotOf(ended));

  for (const event of [hook("Stop", { stop_hook_active: false }), questionClose("toolu_q1")]) {
    expectOutcome(reducer.reduce(event), "ignored", "scope-closed");
  }

  expectOutcome(reducer.reduce(hook("SessionStart", { source: "resume" })), "applied", "scope-rebound");
  expectOutcome(reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p2" })), "applied", "turn-submitted");
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["Working"] });
});

test("caller invalidation withdraws every supported observation as unknown", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  expectUnknown(reducer.invalidate());
  // A genuinely new session is adopted on its next eligible event.
  expectOutcome(
    reducer.reduce(hook("Stop", { session_id: OTHER_SESSION, stop_hook_active: false })),
    "applied",
    "turn-end-candidate",
  );
  expectUnknown(reducer.snapshot());
  expectOutcome(reducer.confirmTurnEnd({ sessionId: OTHER_SESSION }), "applied", "turn-ended-confirmed");
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: null, activity: ["Ready"] });
});

test("malformed recognized payloads degrade instead of claiming zero, none, or Ready", () => {
  const cases: readonly [unknown, "malformed-envelope" | "malformed-scope" | "question-request-unidentified" | "question-close-unidentified" | "tool-name-unavailable" | "tool-close-unidentified"][] = [
    [null, "malformed-envelope"],
    ["not-a-payload", "malformed-envelope"],
    [[{ hook_event_name: "Stop" }], "malformed-envelope"],
    [{ cwd: "/work" }, "malformed-envelope"],
    [{ hook_event_name: "  " }, "malformed-envelope"],
    [hook("Stop", { agent_id: 7 }), "malformed-scope"],
    [hook("PreToolUse", { tool_use_id: "toolu_x" }), "tool-name-unavailable"],
    [hook("PreToolUse", { tool_name: "AskUserQuestion" }), "question-request-unidentified"],
    [hook("PostToolUse", { tool_name: "AskUserQuestion" }), "question-close-unidentified"],
    [hook("PostToolUse", { tool_name: "Read" }), "tool-close-unidentified"],
    [hook("UserPromptSubmit", { session_id: "" }), "malformed-envelope"],
  ];
  for (const [event, reason] of cases) {
    const reducer = boundReducer();
    reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
    reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
    const result = reducer.reduce(event);
    expectOutcome(result, "invalid", reason);
    const snapshot = snapshotOf(result);
    // Never a fabricated cleared/none/Ready outcome from a broken payload.
    assert.notEqual(snapshot.busy, false);
    assert.equal(snapshot.activity.includes("Ready"), false);
  }
});

test("unrelated event kinds are ignored and never synthesize counts or Ready", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash" }));
  const before = reducer.snapshot();

  const unrelated = [
    hook("Notification", { message: "idle", notification_type: "idle_prompt" }),
    hook("Notification", { message: "needs input", notification_type: "agent_needs_input" }),
    hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: COMMAND_TEXT } }),
    hook("PermissionDenied", { tool_name: "Bash" }),
    hook("Elicitation", { message: "private elicitation" }),
    hook("ElicitationResult"),
    hook("SubagentStart", { agent_id: "agent-1", agent_type: "general" }),
    hook("SubagentStop", { agent_id: "agent-1" }),
    hook("PostToolBatch"),
    hook("TaskCreated", { task_id: "task-1", task_subject: "private subject" }),
    hook("TaskCompleted", { task_id: "task-1" }),
    hook("TeammateIdle"),
    hook("PreCompact"),
    hook("FileChanged", { file_path: PATH_TEXT }),
    hook("CwdChanged", { cwd: "/elsewhere" }),
    hook("MessageDisplay"),
    hook("SomeFutureEvent"),
  ];
  for (const event of unrelated) {
    expectOutcome(reducer.reduce(event), "ignored", "unsupported-event");
  }
  assert.deepEqual(reducer.snapshot(), before);

  // Even a Stop that carries native background-task and cron snapshots yields
  // foreground labels only: this reducer never turns them into counts.
  const stop = reducer.reduce(hook("Stop", {
    stop_hook_active: false,
    background_tasks: [
      { id: "b1", type: "shell", status: "running", command: COMMAND_TEXT },
      { id: "a1", type: "subagent", status: "running", agent_type: "general" },
    ],
    session_crons: [{ id: "c1", schedule: "0 9 * * 1-5", recurring: true, prompt: "private prompt" }],
  }));
  expectOutcome(stop, "applied", "turn-end-candidate");
  assert.deepEqual(snapshotOf(stop), { busy: null, pendingInput: false, activity: [] });
  assert.equal(JSON.stringify(snapshotOf(stop)).includes(COMMAND_TEXT), false);
  assert.equal(JSON.stringify(snapshotOf(stop)).includes("private prompt"), false);

  const confirmed = reducer.confirmTurnEnd({ promptId: "p1" });
  expectOutcome(confirmed, "applied", "turn-ended-confirmed");
  assert.deepEqual(snapshotOf(confirmed), { busy: false, pendingInput: false, activity: ["Ready"] });
  assert.deepEqual(Object.keys(snapshotOf(confirmed)).sort(), ["activity", "busy", "pendingInput"]);
  assert.equal(JSON.stringify(snapshotOf(confirmed)).includes(COMMAND_TEXT), false);
  assert.equal(JSON.stringify(snapshotOf(confirmed)).includes("private prompt"), false);
});

test("a fresh root SessionStart vouches the empty question census before any question", () => {
  const reducer = new NativeClaudeStatusReducer();
  expectUnknown(reducer.snapshot());

  const started = reducer.reduce(hook("SessionStart", { source: "startup" }));
  expectOutcome(started, "applied", "scope-rebound");
  // Nothing is open and no request can have opened before this boundary, so the
  // census is positively empty: none pending, while the foreground itself stays
  // unknown (startup alone is never a Ready claim).
  assert.deepEqual(snapshotOf(started), { busy: null, pendingInput: false, activity: [] });

  // A SessionStart with no readable identity establishes no baseline: the scope
  // is new but uncorrelatable, so pending stays unknown rather than a blanket
  // initial none.
  const unidentified = new NativeClaudeStatusReducer();
  const unbound = unidentified.reduce(hook("SessionStart", { source: "startup", session_id: "" }));
  expectOutcome(unbound, "invalid", "scope-rebound-unidentified");
  assert.equal(snapshotOf(unbound).pendingInput, null);
});

test("a healthy question-free turn preserves none pending from SessionStart through Ready", () => {
  const reducer = boundReducer();
  assert.equal(reducer.snapshot().pendingInput, false);

  const healthyTurn: readonly Record<string, unknown>[] = [
    hook("UserPromptSubmit", { prompt_id: "p1" }),
    hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", prompt_id: "p1" }),
    hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", prompt_id: "p1" }),
    hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_read", prompt_id: "p1" }),
    hook("PostToolUseFailure", { tool_name: "Read", tool_use_id: "toolu_read", prompt_id: "p1", error: "denied" }),
  ];
  for (const event of healthyTurn) {
    const snapshot = snapshotOf(reducer.reduce(event));
    assert.equal(snapshot.pendingInput, false, `pendingInput after ${String(event.hook_event_name)}`);
  }

  // A Stop candidate and a confirmed end move the foreground only: normal work
  // never strands the vouched empty census back to unknown.
  const candidate = reducer.reduce(hook("Stop", { stop_hook_active: false, prompt_id: "p1" }));
  expectOutcome(candidate, "applied", "turn-end-candidate");
  assert.deepEqual(snapshotOf(candidate), { busy: null, pendingInput: false, activity: [] });
  const confirmed = reducer.confirmTurnEnd({ promptId: "p1" });
  expectOutcome(confirmed, "applied", "turn-ended-confirmed");
  assert.deepEqual(snapshotOf(confirmed), { busy: false, pendingInput: false, activity: ["Ready"] });
});

test("the none baseline becomes pending only for an actual open question request", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  assert.equal(reducer.snapshot().pendingInput, false);

  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  assert.equal(reducer.snapshot().pendingInput, true);

  // A second real request keeps the row pending until every open request closes.
  reducer.reduce(questionOpen("toolu_q2", { prompt_id: "p1" }));
  assert.equal(reducer.snapshot().pendingInput, true);
  expectOutcome(
    reducer.reduce(questionClose("toolu_q1", { prompt_id: "p1" })),
    "applied",
    "question-request-closed",
  );
  assert.equal(reducer.snapshot().pendingInput, true);
  expectOutcome(
    reducer.reduce(questionClose("toolu_q2", { prompt_id: "p1" })),
    "applied",
    "question-request-closed",
  );
  assert.equal(reducer.snapshot().pendingInput, false);

  // Invalidation releases the scope and its baseline: unknown again, never a
  // blanket none for an unbound row.
  expectUnknown(reducer.invalidate());
  assert.equal(reducer.snapshot().pendingInput, null);
});

test("the host's own launch states a fresh idle baseline before any prompt or hook", () => {
  const reducer = new NativeClaudeStatusReducer();
  expectUnknown(reducer.snapshot());

  // The evidence is the spawn itself: this controller's owner started the process
  // and has sent it nothing, so nothing has run in it and nothing awaits input.
  const baseline = reducer.observeOwnedStartup();
  expectOutcome(baseline, "applied", "startup-baseline");
  assert.deepEqual(snapshotOf(baseline), { busy: false, pendingInput: false, activity: ["Ready"] });

  // Repeating the statement is not news and changes nothing.
  expectOutcome(reducer.observeOwnedStartup(), "applied", "startup-baseline");
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });

  // Once real work has been observed the launch baseline is refused outright: a
  // late call can never idle a live turn, and it leaves the running state intact.
  const running = new NativeClaudeStatusReducer();
  running.observeOwnedStartup();
  running.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  expectOutcome(running.observeOwnedStartup(), "ignored", "startup-baseline-superseded");
  // The census began with the process, so the accepted turn still knows nothing is
  // pending — while the idle claim itself is not restorable over it.
  assert.deepEqual(running.snapshot(), { busy: true, pendingInput: false, activity: ["Working"] });

  // An open question request is observed work too, and an ended scope is closed.
  const asked = new NativeClaudeStatusReducer();
  asked.observeOwnedStartup();
  asked.reduce(questionOpen("toolu_q1"));
  expectOutcome(asked.observeOwnedStartup(), "ignored", "startup-baseline-superseded");
  assert.equal(asked.snapshot().pendingInput, true);

  const ended = new NativeClaudeStatusReducer();
  ended.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  expectOutcome(ended.reduce(hook("SessionEnd", { reason: "prompt_input_exit" })), "applied", "scope-ended");
  expectOutcome(ended.observeOwnedStartup(), "ignored", "scope-closed");
  expectUnknown(ended.snapshot());

  // The baseline states no native conversation, so it never invents a binding: a
  // real event for the run's own session is still adopted normally.
  const adopted = new NativeClaudeStatusReducer();
  adopted.observeOwnedStartup();
  expectOutcome(
    adopted.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_b" })),
    "applied",
    "tool-type-observed",
  );
  assert.deepEqual(adopted.snapshot(), { busy: true, pendingInput: false, activity: ["bash"] });
});

test("a launch baseline survives its own SessionStart but never crosses observed work", () => {
  for (const source of ["startup", "clear", "resume", "compact", "fork", undefined]) {
    const reducer = new NativeClaudeStatusReducer();
    reducer.observeOwnedStartup();
    // The provider restating this process's boundary — or the user clearing or
    // resuming into an idle row — says nothing that contradicts "nothing has run
    // yet", so the row does not blink through unknown.
    const rebound = reducer.reduce(hook("SessionStart", { source }));
    expectOutcome(rebound, "applied", "scope-rebound");
    assert.deepEqual(snapshotOf(rebound), { busy: false, pendingInput: false, activity: ["Ready"] });
  }

  // After real work, a SessionStart for a conversation it does not already name
  // rebinds to unknown exactly as before: the idle claim is never carried across
  // a turn. A `startup` naming the SAME conversation is refused instead (below).
  const worked = new NativeClaudeStatusReducer();
  worked.observeOwnedStartup();
  worked.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  const rebound = worked.reduce(hook("SessionStart", { session_id: OTHER_SESSION, source: "startup" }));
  expectOutcome(rebound, "applied", "scope-rebound");
  assert.deepEqual(snapshotOf(rebound), { busy: null, pendingInput: false, activity: [] });

  expectOutcome(
    worked.reduce(hook("SessionStart", { session_id: OTHER_SESSION, source: "startup" })),
    "ignored",
    "duplicate-session-start",
  );
  assert.deepEqual(worked.snapshot(), { busy: null, pendingInput: false, activity: [] });
});

test("a fresh root SessionStart idles only once the caller's read found no prerecorded work", () => {
  const fresh = new NativeClaudeStatusReducer();
  // The boundary alone still claims no foreground: the provider's `source` says
  // this is a new conversation, but only the caller can read its own source.
  expectOutcome(fresh.reduce(hook("SessionStart", { source: "startup" })), "applied", "scope-rebound");
  assert.deepEqual(fresh.snapshot(), { busy: null, pendingInput: false, activity: [] });

  const confirmed = fresh.confirmFreshStart({ sessionId: SESSION, sourceToken: "read-1" });
  expectOutcome(confirmed, "applied", "fresh-start-confirmed");
  assert.deepEqual(snapshotOf(confirmed), { busy: false, pendingInput: false, activity: ["Ready"] });

  // The corroboration is one-shot, and a foreign conversation cannot supply it.
  expectOutcome(fresh.confirmFreshStart({ sessionId: SESSION, sourceToken: "read-2" }), "ignored", "fresh-start-superseded");
  expectOutcome(fresh.confirmFreshStart({ sessionId: OTHER_SESSION }), "ignored", "stale-session");

  // `resume`, `compact`, `fork`, and an unreadable source all continue recorded
  // work, so there is nothing to corroborate and no idle claim follows.
  for (const source of ["resume", "compact", "fork", "", 7]) {
    const resumed = new NativeClaudeStatusReducer();
    expectOutcome(resumed.reduce(hook("SessionStart", { source })), "applied", "scope-rebound");
    expectOutcome(resumed.confirmFreshStart({ sessionId: SESSION }), "ignored", "fresh-start-superseded");
    assert.deepEqual(resumed.snapshot(), { busy: null, pendingInput: false, activity: [] });
  }

  // A start whose work arrived before the corroboration is never idled late.
  const late = new NativeClaudeStatusReducer();
  late.reduce(hook("SessionStart", { source: "startup" }));
  late.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  expectOutcome(late.confirmFreshStart({ sessionId: SESSION }), "ignored", "fresh-start-superseded");
  assert.deepEqual(late.snapshot(), { busy: true, pendingInput: false, activity: ["Working"] });

  // A child's start never establishes a root fresh scope at all.
  const child = new NativeClaudeStatusReducer();
  expectOutcome(
    child.reduce(subagentHook("SessionStart", { source: "startup" })),
    "ignored",
    "subagent-scope",
  );
  expectOutcome(child.confirmFreshStart({ sessionId: SESSION }), "ignored", "fresh-start-superseded");
  expectUnknown(child.snapshot());
});

test("a persisted tool_result closes an open root question without any answer content", () => {
  const ANSWER_BODY = "the-user-picked-this-option-secret";
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  assert.equal(reducer.snapshot().pendingInput, true);

  // The declined/cancelled shape: the provider persisted the tool_result for this
  // exact request identity even though no Post hook ever reached this observer.
  const closed = reducer.observeQuestionToolResult({ requestId: "toolu_q1", sessionId: SESSION });
  expectOutcome(closed, "applied", "question-request-closed");
  assert.deepEqual(snapshotOf(closed), { busy: true, pendingInput: false, activity: ["Working"] });

  // The identities offered for matching are ROOT request identities only, and
  // nothing about the question itself is among them.
  const offered = new NativeClaudeStatusReducer();
  offered.reduce(questionOpen("toolu_offer", { question: QUESTION_TEXT }));
  offered.reduce(subagentHook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_sub" }));
  assert.deepEqual(offered.openQuestionRequestIds(), ["toolu_offer"]);
  assert.equal(JSON.stringify(offered.openQuestionRequestIds()).includes(QUESTION_TEXT), false);

  // A replay of the same evidence is a duplicate, never a fresh closure.
  expectOutcome(reducer.observeQuestionToolResult({ requestId: "toolu_q1" }), "ignored", "duplicate-question-close");

  // Some other tool's result is not this census's business: an identity this
  // reducer never opened as a root question changes nothing, not even the census.
  expectOutcome(reducer.observeQuestionToolResult({ requestId: "toolu_bash" }), "ignored", "question-tool-result-unobserved");
  assert.equal(reducer.snapshot().pendingInput, false);

  // A request observed in a subagent context is never closed from the root
  // conversation, and a foreign session cannot close anything at all.
  const scoped = boundReducer();
  scoped.reduce(subagentHook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_shared" }));
  scoped.reduce(questionOpen("toolu_shared"));
  expectOutcome(scoped.observeQuestionToolResult({ requestId: "toolu_shared" }), "applied", "question-request-closed");
  assert.equal(scoped.snapshot().pendingInput, true, "only the root request closed");
  expectOutcome(
    scoped.observeQuestionToolResult({ requestId: "toolu_shared", sessionId: OTHER_SESSION }),
    "ignored",
    "stale-session",
  );

  // No identity, no closure — and nothing about the result was ever needed.
  expectOutcome(reducer.observeQuestionToolResult({ requestId: "  " }), "ignored", "question-close-unidentified");
  expectOutcome(
    reducer.observeQuestionToolResult({} as { requestId: string }),
    "ignored",
    "question-close-unidentified",
  );
  assert.equal(JSON.stringify(reducer.snapshot()).includes(ANSWER_BODY), false);

  // With the root request closed, nothing is offered for the root conversation:
  // a subagent's still-open request is never matched against a root row.
  assert.deepEqual(scoped.openQuestionRequestIds(), []);
});

test("duplicate same-session startup notices change nothing and never arm an idle corroboration", () => {
  const reducer = new NativeClaudeStatusReducer();
  reducer.reduce(hook("SessionStart", { source: "startup" }));
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  const running = reducer.snapshot();
  assert.deepEqual(running, { busy: true, pendingInput: true, activity: ["Working"] });

  // Two late or repeated `startup` notices for the very conversation already at
  // work, whose source has not persisted this turn yet. Neither is a new
  // boundary: the foreground, the activity line, and above all the live question
  // request stay exactly as they were.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    expectOutcome(
      reducer.reduce(hook("SessionStart", { source: "startup" })),
      "ignored",
      "duplicate-session-start",
    );
    assert.deepEqual(reducer.snapshot(), running, "a duplicate start changes nothing at all");
  }

  // With the scope untouched, the corroboration a later empty-source read would
  // supply is still refused: the live turn is never idled or zeroed.
  expectOutcome(reducer.confirmFreshStart({ sessionId: SESSION }), "ignored", "fresh-start-superseded");
  assert.deepEqual(reducer.snapshot(), running);

  // The request the duplicate would have deleted is still tracked, and closes on
  // its own matching edge afterwards.
  expectOutcome(
    reducer.reduce(questionClose("toolu_q1", { prompt_id: "p1" })),
    "applied",
    "question-request-closed",
  );
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["Working"] });

  // A start naming a conversation this reducer has NOT bound is a genuine new
  // boundary even though the conversation it replaces ran work: it rebinds, and
  // its own empty source may corroborate its own baseline.
  expectOutcome(
    reducer.reduce(hook("SessionStart", { session_id: OTHER_SESSION, source: "clear" })),
    "applied",
    "scope-rebound",
  );
  expectOutcome(reducer.confirmFreshStart({ sessionId: OTHER_SESSION }), "applied", "fresh-start-confirmed");
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });
});
