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
  NATIVE_CLAUDE_OBSERVATION_AXES,
  NativeClaudeStatusReducer,
  type NativeClaudeObservationAxis,
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

/**
 * An `invalid` outcome and the closed axes it declares, in one assertion: the
 * declared width is part of the outcome contract, not an afterthought a caller
 * may widen or re-derive from the reason name.
 */
function expectDegraded(
  result: NativeClaudeReduceResult,
  reason: string,
  affects: readonly NativeClaudeObservationAxis[],
): Extract<NativeClaudeReduceResult, { outcome: "invalid" }> {
  expectOutcome(result, "invalid", reason);
  if (result.outcome !== "invalid") assert.fail("expected an invalid outcome");
  assert.deepEqual(result.affects, affects, `declared axes for ${reason}`);
  return result;
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
  // The provider stopped mid-turn for a human: the foreground reports waiting.
  assert.deepEqual(snapshotOf(opened), { busy: false, pendingInput: true, activity: ["Working"] });

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

test("root question work establishes a live turn whose foreground reports stopped-on-input", () => {
  // Observation beginning with a question request still proves root tool work.
  const adopted = new NativeClaudeStatusReducer();
  adopted.reduce(questionOpen("first"));
  assert.deepEqual(adopted.snapshot(), { busy: false, pendingInput: true, activity: ["Working"] });

  // A blocked Stop continuation that runs straight into a question request.
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("Stop", { prompt_id: "p1", stop_hook_active: true }));
  reducer.reduce(questionOpen("continued", { prompt_id: "p1" }));
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: true, activity: ["Working"] });

  // An established last-tool label is preserved, not overwritten.
  const labeled = boundReducer();
  labeled.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  labeled.reduce(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_read", prompt_id: "p1" }));
  labeled.reduce(hook("PostToolUse", { tool_name: "Read", tool_use_id: "toolu_read", prompt_id: "p1" }));
  labeled.reduce(questionOpen("ask", { prompt_id: "p1" }));
  assert.deepEqual(labeled.snapshot(), { busy: false, pendingInput: true, activity: ["read"] });

  // ...and the turn underneath the request is restored, not a stale Ready, when
  // the request closes: the model resumes the work it was interrupted for.
  labeled.reduce(questionClose("ask", { prompt_id: "p1" }));
  assert.deepEqual(labeled.snapshot(), { busy: true, pendingInput: false, activity: ["read"] });
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
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: true, activity: ["Working"] });
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
  // An unprovable boundary touches neither the still-open request nor the work
  // this source positively observed running under this turn.
  assert.deepEqual(snapshotOf(candidate), { busy: true, pendingInput: true, activity: ["bash"] });
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
  // The boundary proves no end, so it leaves this source's observed running root
  // turn and the subagent request exactly as they were.
  assert.deepEqual(snapshotOf(rootStop), { busy: true, pendingInput: true, activity: ["read"] });

  const subClose = reducer.reduce(subagentHook("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_subq" }));
  expectOutcome(subClose, "applied", "question-request-closed");
  assert.deepEqual(snapshotOf(subClose), { busy: true, pendingInput: false, activity: ["read"] });
});

test("Stop is only a candidate boundary; a confirmed terminal record is what yields Ready", () => {
  const reducer = boundReducer();
  expectOutcome(reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" })), "applied", "turn-submitted");
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["Working"] });

  const candidate = reducer.reduce(hook("Stop", { stop_hook_active: false, last_assistant_message: "private reply text" }));
  expectOutcome(candidate, "applied", "turn-end-candidate");
  // Another operator's Stop hook can block and continue this same turn, so the
  // arrival of this observer's Stop proves nothing: never Ready — and not unknown
  // either. This source watched the turn begin and never saw it end, so the
  // observed working projection stands until the source's own terminal record.
  // The question census is a separate observation: no request opened or closed
  // here, so the vouched "none pending" baseline survives the boundary.
  assert.deepEqual(snapshotOf(candidate), { busy: true, pendingInput: false, activity: ["Working"] });
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

test("an unproven Stop never invents a running row and never keeps an idle claim as a completion", () => {
  // A foreground this source never observed running stays unverifiable, and
  // repeating the boundary invents nothing.
  const neverRan = boundReducer();
  assert.deepEqual(neverRan.snapshot(), { busy: null, pendingInput: false, activity: [] });
  for (const _ of [0, 1]) {
    expectOutcome(
      neverRan.reduce(hook("Stop", { stop_hook_active: false })),
      "applied",
      "turn-end-candidate",
    );
    assert.equal(neverRan.snapshot().busy, null);
  }

  // A confirmed Ready is an IDLE claim, not an observed active turn: the next
  // boundary makes the foreground unverifiable again instead of retaining
  // `busy: false` as though the Stop had proved it.
  const idle = boundReducer();
  expectOutcome(idle.confirmTurnEnd(), "applied", "turn-ended-confirmed");
  assert.deepEqual(idle.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });
  expectOutcome(idle.reduce(hook("Stop", { stop_hook_active: false })), "applied", "turn-end-candidate");
  assert.deepEqual(idle.snapshot(), { busy: null, pendingInput: false, activity: [] });

  // Repeating the boundary on an observed running turn retains the SAME observed
  // fact: it is not a fresh claim of work, and it is still never Ready.
  const twice = boundReducer();
  twice.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  const first = snapshotOf(twice.reduce(hook("Stop", { stop_hook_active: false, prompt_id: "p1" })));
  const second = snapshotOf(twice.reduce(hook("Stop", { stop_hook_active: false, prompt_id: "p1" })));
  assert.deepEqual(first, { busy: true, pendingInput: false, activity: ["Working"] });
  assert.deepEqual(second, first);
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
  // The unproven boundary keeps the observed bash turn standing; it is not a
  // completion, and it is not a withdrawal of a fact this source observed.
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["bash"] });

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

  // The close keeps the last observed tool TYPE; only a confirmed terminal
  // record yields Ready.
  const done = reducer.reduce(hook("PostToolUse", { tool_name: "Read", tool_use_id: "toolu_read", tool_response: { stdout: "private output" } }));
  expectOutcome(done, "applied", "tool-completed");
  assert.deepEqual(snapshotOf(done), { busy: true, pendingInput: false, activity: ["read"] });

  const serialized = JSON.stringify(reducer.snapshot());
  assert.equal(serialized.includes(COMMAND_TEXT), false);
  assert.equal(serialized.includes(PATH_TEXT), false);
  assert.equal(serialized.includes("private output"), false);

  const stop = reducer.reduce(hook("Stop", { stop_hook_active: false }));
  expectOutcome(stop, "applied", "turn-end-candidate");
  // The Stop left the observed turn standing, so only a record bound to that turn
  // can confirm it over.
  expectOutcome(reducer.confirmTurnEnd({ promptId: "p1" }), "applied", "turn-ended-confirmed");
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
  // cannot relabel the foreground, and Ready arrives only from a confirmed end
  // bound to the turn that is still positively observed running.
  expectOutcome(reducer.reduce(hook("Stop", { stop_hook_active: false })), "applied", "turn-end-candidate");
  for (const event of [
    hook("PostToolUse", { tool_name: "Read", tool_use_id: "toolu_a" }),
    hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_b" }),
  ]) {
    expectOutcome(reducer.reduce(event), "ignored", "tool-close-unobserved");
  }
  // The tool ledger is gone, while the observed running turn and the vouched
  // none-pending census are separate observations that survive it.
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["bash"] });
  expectOutcome(reducer.confirmTurnEnd({ promptId: "p1" }), "applied", "turn-ended-confirmed");
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });
});

test("Claude's qualified Review Gate MCP tool names preserve known agent and input state", () => {
  const reducer = boundReducer();
  for (const [index, name] of ["SubtasksStart", "SubtasksInspect"].entries()) {
    const promptId = `p${index + 1}`;
    const tool_name = `mcp__pi_review_gate_${"0".repeat(32)}__${name}`;
    const tool_use_id = `toolu_mcp_${index}`;
    reducer.reduce(hook("UserPromptSubmit", { prompt_id: promptId }));
    assert.equal(reducer.snapshot().busy, true);
    assert.equal(reducer.snapshot().pendingInput, false);
    for (const edge of ["PreToolUse", "PostToolUse"] as const) {
      const result = reducer.reduce(hook(edge, { prompt_id: promptId, tool_name, tool_use_id }));
      assert.equal(result.outcome, "applied");
      assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: [tool_name.toLowerCase()] });
    }
    expectOutcome(reducer.reduce(hook("Stop", { prompt_id: promptId })), "applied", "turn-end-candidate");
    expectOutcome(reducer.confirmTurnEnd({ promptId }), "applied", "turn-ended-confirmed");
    assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });
  }
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
    `mcp__${"a".repeat(110)}__SubtasksStart`,
    `mcp__${"a".repeat(64)}__not/a/tool`,
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

/*
 * The width of a degradation belongs to the reducer that made it. An unreadable
 * payload states which of the two axes it owns it contradicted, and everything
 * outside that declaration is preserved ON PURPOSE. A caller that re-derives the
 * blast radius from reason names — or that treats any `invalid` as a whole-lane
 * loss — withdraws facts the payload never touched, which is exactly how an
 * answered question once erased a healthy foreground, a live background census,
 * and a run's own session binding at once.
 */

test("an invalid outcome declares exactly the axes its unreadable field contradicted", () => {
  // The closed axis set is the reducer's own vocabulary, and it owns both.
  assert.deepEqual([...NATIVE_CLAUDE_OBSERVATION_AXES], ["foreground", "questionCensus"]);

  // Census-only: a close for a request this reducer never opened proves an
  // observation hole in the pending-input answer and NOTHING about what is
  // running, so busy and the tool label stand beside the unknown input.
  const unobserved = boundReducer();
  unobserved.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  unobserved.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_b" }));
  assert.deepEqual(unobserved.snapshot(), { busy: true, pendingInput: false, activity: ["bash"] });

  const closeHole = expectDegraded(
    unobserved.reduce(questionClose("toolu_never_opened", { prompt_id: "p1" })),
    "question-close-unobserved",
    ["questionCensus"],
  );
  assert.deepEqual(snapshotOf(closeHole), { busy: true, pendingInput: null, activity: ["bash"] });

  // Same width for a question close that carries no request identity at all.
  const unidentified = boundReducer();
  unidentified.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  unidentified.reduce(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_r" }));
  const noId = expectDegraded(
    unidentified.reduce(hook("PostToolUse", { tool_name: "AskUserQuestion" })),
    "question-close-unidentified",
    ["questionCensus"],
  );
  assert.deepEqual(snapshotOf(noId), { busy: true, pendingInput: null, activity: ["read"] });

  // Root-attributable and unattributable payloads are the ones that also own the
  // foreground: both axes, and the snapshot withdraws both.
  const foreground = boundReducer();
  foreground.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  foreground.reduce(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_r" }));
  const unreadableTool = expectDegraded(
    foreground.reduce(hook("PreToolUse", { tool_name: `Bash ${COMMAND_TEXT}`, tool_use_id: "toolu_x" })),
    "tool-name-unavailable",
    ["foreground", "questionCensus"],
  );
  expectUnknown(snapshotOf(unreadableTool));

  const unattributable = boundReducer();
  unattributable.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  const badScope = expectDegraded(
    unattributable.reduce(hook("Stop", { agent_id: 7 })),
    "malformed-scope",
    ["foreground", "questionCensus"],
  );
  expectUnknown(snapshotOf(badScope));

  // A subagent's own unreadable tool name is not root foreground evidence: the
  // census is all it can reach.
  const child = boundReducer();
  child.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  child.reduce(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_r" }));
  const childHole = expectDegraded(
    child.reduce(subagentHook("PreToolUse", { tool_name: `Bash ${COMMAND_TEXT}`, tool_use_id: "toolu_c" })),
    "tool-name-unavailable",
    ["questionCensus"],
  );
  assert.deepEqual(snapshotOf(childHole), { busy: true, pendingInput: null, activity: ["read"] });
});

test("a declared census-only hole never re-vouches a cleared census and never fakes an answer", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  assert.equal(reducer.snapshot().pendingInput, false);

  const degraded = expectDegraded(
    reducer.reduce(questionClose("toolu_never_opened", { prompt_id: "p1" })),
    "question-close-unobserved",
    ["questionCensus"],
  );
  assert.equal(snapshotOf(degraded).pendingInput, null);

  // A definitive close of a DIFFERENT request does not launder the hole away:
  // the unknown answer stays unknown, and no `false` is rebuilt on top of it.
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  const closed = reducer.reduce(questionClose("toolu_q1", { prompt_id: "p1" }));
  expectOutcome(closed, "applied", "question-request-closed");
  assert.equal(reducer.snapshot().pendingInput, null, "no false is rebuilt on top of a census hole");

  // The hole is a boundary fact, not a permanent one: a genuine root
  // `SessionStart` — the only boundary that shows a census from its beginning —
  // is what clears it. Nothing short of that re-vouches an answer.
  const fresh = new NativeClaudeStatusReducer();
  expectOutcome(fresh.reduce(hook("SessionStart", { source: "startup" })), "applied", "scope-rebound");
  expectOutcome(fresh.reduce(hook("UserPromptSubmit", { prompt_id: "p2" })), "applied", "turn-submitted");
  expectDegraded(
    fresh.reduce(questionClose("toolu_never_opened", { prompt_id: "p2" })),
    "question-close-unobserved",
    ["questionCensus"],
  );
  assert.equal(fresh.snapshot().pendingInput, null);
  const rebound = fresh.reduce(hook("SessionStart", { session_id: OTHER_SESSION, source: "clear" }));
  expectOutcome(rebound, "applied", "scope-rebound");
  assert.equal(
    fresh.snapshot().pendingInput,
    false,
    "a genuine root SessionStart is the boundary that shows a census from its beginning",
  );
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
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: true, activity: ["Working"] });
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
  // The root's own Read is still open, so root work is demonstrably in flight:
  // the standing question cannot make this row look paused.
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
    // Never a fabricated cleared/none/Ready outcome from a broken payload. The
    // open request may publish `busy: false`, but that is stopped-on-input beside
    // a pending request, never the idle claim this assertion is about.
    assert.equal(snapshot.busy === false && snapshot.pendingInput !== true, false);
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
  // An unproven boundary neither completes nor withdraws the observed bash turn.
  assert.deepEqual(snapshotOf(stop), { busy: true, pendingInput: false, activity: ["bash"] });
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
  // The candidate proves no end, so the observed read stays observed and the
  // vouched empty census is untouched; only the confirmed record moves it.
  assert.deepEqual(snapshotOf(candidate), { busy: true, pendingInput: false, activity: ["read"] });
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
  assert.deepEqual(running, { busy: false, pendingInput: true, activity: ["Working"] });

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

/* --------------------------------------- stopped-on-input foreground mapping */

/*
 * A root question request is the provider stopping mid-turn to wait for a human,
 * so the published foreground says exactly that — the shared stopped-on-input
 * fact the host uses for any session awaiting input — while the observed turn
 * underneath it is kept intact and returns when the request closes. These tests
 * pin which facts can and cannot end that claim, and which cannot.
 */

test("a root question blocks the foreground while a child's question stays foreground-neutral", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", prompt_id: "p1" }));
  reducer.reduce(hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", prompt_id: "p1" }));
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["bash"] });

  // A child asking something inside its own conversation says nothing about the
  // root foreground: the root keeps its observed running claim.
  reducer.reduce(subagentHook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_child" }));
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: true, activity: ["bash"] });

  // The root's own request is the provider stopped on input.
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: true, activity: ["bash"] });

  // The child's own closure leaves the root block untouched...
  reducer.reduce(subagentHook("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_child" }));
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: true, activity: ["bash"] });

  // ...and closing the root request restores the foreground observed underneath
  // it: the same last-tool TYPE and a running turn, never a stale Ready.
  reducer.reduce(questionClose("toolu_q1", { prompt_id: "p1" }));
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["bash"] });
});

test("a request from an older prompt cannot keep the row waiting once the current one closes", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(questionOpen("toolu_old", { prompt_id: "p1" }));
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: true, activity: ["Working"] });

  // A newer accepted turn is newer root work: the row runs again, and the older
  // request is still counted as pending input.
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p2" }));
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: true, activity: ["Working"] });

  // The newer turn's own request is what it is stopped on now.
  reducer.reduce(questionOpen("toolu_new", { prompt_id: "p2" }));
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: true, activity: ["Working"] });

  // Closing the CURRENT request returns the running foreground even though the
  // older-prompt request is still open: that older request cannot hold the row
  // paused, and its own close edge still owns it.
  reducer.reduce(questionClose("toolu_new", { prompt_id: "p2" }));
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: true, activity: ["Working"] });

  // Its own correlated close still lands definitively.
  expectOutcome(
    reducer.reduce(questionClose("toolu_old", { prompt_id: "p1" })),
    "applied",
    "question-request-closed",
  );
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["Working"] });
});

test("newer root work ends the stopped-on-input claim; an unproven boundary leaves it standing", () => {
  // A new accepted prompt is newer root work: the row runs again.
  const prompt = boundReducer();
  prompt.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  prompt.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  assert.equal(prompt.snapshot().busy, false);
  prompt.reduce(hook("UserPromptSubmit", { prompt_id: "p2" }));
  assert.equal(prompt.snapshot().busy, true, "a new accepted turn is running, not waiting");

  // Observed root tool work after a standing block is in flight, so the row is
  // never made to look paused while the provider is doing something else — and a
  // request that opens once nothing else is running blocks.
  const tool = boundReducer();
  tool.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  tool.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  tool.reduce(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_read", prompt_id: "p1" }));
  assert.equal(tool.snapshot().busy, true, "root tool work is never a pause");
  assert.equal(tool.snapshot().pendingInput, true, "the earlier request is still open");
  // While that Read is still open, a further question cannot make the row look
  // paused either: the block is only ever armed for the provider's current stop.
  tool.reduce(questionOpen("toolu_q2", { prompt_id: "p1" }));
  assert.equal(tool.snapshot().busy, true, "a request opening over in-flight tool work does not block");
  tool.reduce(hook("PostToolUse", { tool_name: "Read", tool_use_id: "toolu_read", prompt_id: "p1" }));
  tool.reduce(questionOpen("toolu_q3", { prompt_id: "p1" }));
  assert.equal(tool.snapshot().busy, false, "with nothing else running, the new request blocks");

  // A `Stop` boundary proves neither a finished turn nor a still-standing answer,
  // so it retires neither observation: a request the source never saw closing
  // stays waiting, and the turn it stands in stays the turn this source saw run.
  const stopped = boundReducer();
  stopped.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  stopped.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  stopped.reduce(hook("Stop", { prompt_id: "p1", stop_hook_active: true }));
  assert.deepEqual(stopped.snapshot(), { busy: false, pendingInput: true, activity: ["Working"] });
  // The source's own ordered terminal record is what owns both: it ends the turn
  // and retires the unresolved request with it.
  expectOutcome(
    stopped.confirmTurnEnd({ promptId: "p1" }),
    "applied",
    "turn-ended-confirmed",
  );
  assert.deepEqual(stopped.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });

  // A request whose identity cannot be read can never be matched to a close, so
  // nothing is claimed as waiting either: the foreground withdraws to unknown.
  const untracked = boundReducer();
  untracked.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  expectOutcome(
    untracked.reduce(hook("PreToolUse", { tool_name: "AskUserQuestion" })),
    "invalid",
    "question-request-unidentified",
  );
  assert.deepEqual(untracked.snapshot(), { busy: null, pendingInput: null, activity: [] });

  // Only the source-read terminal record states an idle foreground, and it ends
  // the block together with the turn it closed.
  const ended = boundReducer();
  ended.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  ended.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  assert.deepEqual(ended.snapshot(), { busy: false, pendingInput: true, activity: ["Working"] });
  expectOutcome(ended.confirmTurnEnd({ promptId: "p1" }), "applied", "turn-ended-confirmed");
  assert.deepEqual(ended.snapshot(), { busy: false, pendingInput: false, activity: ["Ready"] });
});

test("the row keeps waiting until the last root request closes, and a replayed open adds nothing", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  reducer.reduce(questionOpen("toolu_q2", { prompt_id: "p1" }));
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: true, activity: ["Working"] });
  expectOutcome(
    reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" })),
    "ignored",
    "duplicate-question-open",
  );
  expectOutcome(
    reducer.reduce(questionClose("toolu_q1", { prompt_id: "p1" })),
    "applied",
    "question-request-closed",
  );
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: true, activity: ["Working"] });
  expectOutcome(
    reducer.reduce(questionClose("toolu_q2", { prompt_id: "p1" })),
    "applied",
    "question-request-closed",
  );
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["Working"] });
});

test("an unreadable payload withdraws a standing stopped-on-input claim too", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: true, activity: ["Working"] });

  // A root payload whose tool name cannot be read could itself be that request's
  // own close, so the waiting claim goes with the rest of the foreground:
  // unknown, never a stale waiting or Ready claim. The request is not consumed by
  // an unreadable edge, so the row still reports input pending.
  expectOutcome(
    reducer.reduce(hook("PostToolUse", { tool_use_id: "toolu_q1" })),
    "invalid",
    "tool-name-unavailable",
  );
  assert.deepEqual(reducer.snapshot(), { busy: null, pendingInput: true, activity: [] });

  // The request's own readable close still lands and is never counted as answered.
  // What it cannot do is rebuild what the unreadable payload withdrew: the
  // foreground stays unverifiable until newer work or a confirmed turn end states
  // it, and a census with a hole never claims a definitive none again.
  expectOutcome(
    reducer.reduce(questionClose("toolu_q1", { prompt_id: "p1" })),
    "applied",
    "question-request-closed",
  );
  assert.deepEqual(reducer.snapshot(), { busy: null, pendingInput: null, activity: [] });

  // Newer root work is what re-establishes the foreground — and it is running,
  // not an idle claim carried over from the withdrawn state.
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p2" }));
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: null, activity: ["Working"] });
});

test("a paused foreground is never reported as an idle claim", () => {
  const reducer = boundReducer();
  // Nothing observed yet: no idle claim, and no pause.
  assert.equal(reducer.idleForegroundPublished(), false);
  assert.equal(reducer.questionBlocksForeground(), false);

  // A running turn is neither.
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  assert.equal(reducer.idleForegroundPublished(), false);
  assert.equal(reducer.questionBlocksForeground(), false);

  // A standing root request publishes `busy: false`, but it is a pause in a live
  // turn: only the question accessor says so.
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  assert.equal(reducer.snapshot().busy, false);
  assert.equal(reducer.idleForegroundPublished(), false);
  assert.equal(reducer.questionBlocksForeground(), true);

  // A source-read terminal record is the real idle claim, and it ends the pause.
  const ended = reducer.confirmTurnEnd({ promptId: "p1" });
  expectOutcome(ended, "applied", "turn-ended-confirmed");
  assert.equal(reducer.idleForegroundPublished(), true);
  assert.equal(reducer.questionBlocksForeground(), false);

  // Newer root work beyond the claims withdraws both: unknown, which is neither.
  const paused = boundReducer();
  paused.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  paused.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  assert.equal(paused.questionBlocksForeground(), true);
  paused.noteRootWorkBeyondClaims();
  assert.equal(paused.snapshot().busy, null);
  assert.equal(paused.idleForegroundPublished(), false);
  assert.equal(paused.questionBlocksForeground(), false);
  assert.equal(paused.snapshot().pendingInput, true, "the open request survives it");
});

test("every independently open root tool keeps the row running, and an older close only records", () => {
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_a", prompt_id: "p1" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_b", prompt_id: "p1" }));

  // The newest request closes: its label stands, and the older request is still
  // demonstrably running.
  const closedB = reducer.reduce(hook("PostToolUse", { tool_name: "Read", tool_use_id: "toolu_b", prompt_id: "p1" }));
  expectOutcome(closedB, "applied", "tool-completed");
  assert.deepEqual(snapshotOf(closedB), { busy: true, pendingInput: false, activity: ["read"] });

  // A question cannot look paused while A is still open.
  reducer.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: true, activity: ["read"] });

  // A's own close is recorded — it is no longer work in flight — and it still does
  // not relabel the current activity, which belongs to B. But it is the close that
  // empties the field, and the standing request is what the provider is left
  // waiting on, so that much IS published about this row.
  expectOutcome(
    reducer.reduce(hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_a", prompt_id: "p1" })),
    "applied",
    "question-block-resumed",
  );
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: true, activity: ["read"] });

  // A replayed close of the older request is still just a duplicate, and the
  // pause keeps standing on the one request identity it was armed for.
  expectOutcome(
    reducer.reduce(hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_a", prompt_id: "p1" })),
    "ignored",
    "duplicate-tool-close",
  );
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: true, activity: ["read"] });
});

test("the late close of the tool a question opened over hands the pause to it", () => {
  // The order native 2.1.325 actually delivers: the backgrounded Bash request is
  // still open when the question opens, and that command's own PostToolUse lands
  // afterwards, while the question is still unanswered.
  const reducer = boundReducer();
  reducer.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  reducer.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", prompt_id: "p1" }));
  reducer.reduce(questionOpen("toolu_ask", { prompt_id: "p1" }));

  // A pending question never hides root work that is demonstrably still running.
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: true, activity: ["bash"] });

  // The close of the last other root request is the fact that leaves the provider
  // with nothing to do but wait: the row is stopped on the standing request, and
  // the tool TYPE observed underneath the pause is untouched.
  expectOutcome(
    reducer.reduce(hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", prompt_id: "p1" })),
    "applied",
    "tool-completed",
  );
  assert.deepEqual(reducer.snapshot(), { busy: false, pendingInput: true, activity: ["bash"] });

  // Closing that request restores the turn observed underneath it: running, not a
  // fabricated Ready and not a turn end.
  expectOutcome(
    reducer.reduce(questionClose("toolu_ask", { prompt_id: "p1" })),
    "applied",
    "question-request-closed",
  );
  assert.deepEqual(reducer.snapshot(), { busy: true, pendingInput: false, activity: ["bash"] });
});

test("only a current root request is handed the pause, and only by a real close", () => {
  // A request from the previous prompt cannot be armed by this turn's tool close:
  // the new prompt dropped the claim, and nothing re-arms an older identity.
  const older = boundReducer();
  older.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  older.reduce(questionOpen("toolu_q1", { prompt_id: "p1" }));
  older.reduce(hook("UserPromptSubmit", { prompt_id: "p2" }));
  older.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", prompt_id: "p2" }));
  expectOutcome(
    older.reduce(hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", prompt_id: "p2" })),
    "applied",
    "tool-completed",
  );
  assert.deepEqual(older.snapshot(), { busy: true, pendingInput: true, activity: ["bash"] },
    "a stale turn's request does not make this turn look paused");

  // A child's question is foreground-neutral and is never the root's pause, even
  // after every root request has closed.
  const child = boundReducer();
  child.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  child.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", prompt_id: "p1" }));
  child.reduce(subagentHook("PreToolUse", {
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu_child_ask",
    prompt_id: "p1",
  }));
  expectOutcome(
    child.reduce(hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", prompt_id: "p1" })),
    "applied",
    "tool-completed",
  );
  assert.deepEqual(child.snapshot(), { busy: true, pendingInput: true, activity: ["bash"] },
    "a child's question is not the root's pause");

  // With no close ever arriving for the tool the question opened over, nothing is
  // claimed as waiting: the row keeps reporting the work this source observed.
  const never = boundReducer();
  never.reduce(hook("UserPromptSubmit", { prompt_id: "p1" }));
  never.reduce(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", prompt_id: "p1" }));
  never.reduce(questionOpen("toolu_ask", { prompt_id: "p1" }));
  assert.deepEqual(never.snapshot(), { busy: true, pendingInput: true, activity: ["bash"] });
});
