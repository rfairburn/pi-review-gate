/**
 * Native Codex foreground/tool-activity reducer acceptance (pure, synthetic).
 *
 * Every input here is a hand-built synthetic that reproduces the REAL wire
 * shapes read from the pinned Codex source (`rust-v0.167.2`): rollout records
 * are flattened (`{"timestamp":…,"ordinal":…,"type":"event_msg","payload":{…}}`),
 * the payload tag is snake_case (`task_started`, `task_complete`,
 * `turn_aborted`, `item_completed`, and the legacy-history `patch_apply_end`,
 * `mcp_tool_call_end`, `web_search_end`), `TurnItem` tags are the native
 * variant names (`CommandExecution`, `FileChange`, `McpToolCall`, …), and hook
 * metadata uses the real hook stdin field names (`hook_event_name`, `turn_id`,
 * `agent_id`, `tool_name`, `source`).
 *
 * These tests prove the mapping contract only. They are not evidence that a
 * live Codex delivery works: the hook installer, the rollout tail reader,
 * question/approval detection, and native background counts are separate
 * acquisition work and are intentionally absent here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ACTIVITY_LINES } from "../src/session-host/protocol";
import type { InstanceStatusUpdate } from "../src/session-host/instances";
import {
  NATIVE_CODEX_MAX_CANDIDATE_CHARS,
  NATIVE_CODEX_MAX_TRACKED_TURNS,
  classifyNativeCodexCandidate,
  createNativeCodexStatusState,
  parseNativeCodexHookMetadata,
  projectNativeCodexStatus,
  reduceNativeCodexStatus,
  type NativeCodexEvidence,
  type NativeCodexSourceSignal,
  type NativeCodexStatusState,
} from "../src/session-host/native-codex-status";

const ROOT_THREAD = "11111111-2222-3333-4444-555555555555";
const LINEAGE = "99999999-8888-7777-6666-555555555555";
const CHILD_THREAD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/* ------------------------------------------------------------ wire helpers */

function rolloutLine(ordinal: number, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-01-02T00:00:00.000Z",
    ordinal,
    type: "event_msg",
    payload,
  });
}

function taskStarted(turnId: string, rootTurnId?: string): string {
  return rolloutLine(1, {
    type: "task_started",
    turn_id: turnId,
    ...(rootTurnId === undefined ? {} : { root_turn_id: rootTurnId }),
    model_context_window: null,
    collaboration_mode_kind: "default",
  });
}

function taskComplete(turnId: string, lastAgentMessage = "all done"): string {
  return rolloutLine(2, {
    type: "task_complete",
    turn_id: turnId,
    last_agent_message: lastAgentMessage,
  });
}

function turnAborted(turnId: string | null, reason = "interrupted"): string {
  return rolloutLine(2, { type: "turn_aborted", turn_id: turnId, reason });
}

function commandItem(turnId: string, threadId: string, marker: string): string {
  return rolloutLine(3, {
    type: "item_completed",
    thread_id: threadId,
    turn_id: turnId,
    completed_at_ms: 1,
    item: {
      type: "CommandExecution",
      id: "item-exec",
      command: ["/bin/bash", "-lc", `echo ${marker}`],
      cwd: "file:///workspace",
      parsed_cmd: [],
      source: "agent",
      status: "completed",
      aggregated_output: `${marker} stdout`,
    },
  });
}

/**
 * Caller provenance for one evidence item. Tests pass `currentRootTurnId` only
 * where they are modelling a caller that has actually verified currentness —
 * never automatically from the terminal record's own id.
 */
interface EvidenceOptions {
  readonly generation?: string;
  readonly currentRootTurnId?: string | null;
}

function feed(state: NativeCodexStatusState, line: string, options: EvidenceOptions = {}): NativeCodexStatusState {
  const candidate = classifyNativeCodexCandidate(line);
  if (candidate.status !== "record") {
    assert.fail(`synthetic wire line must classify as a record, got ${candidate.status}`);
  }
  return reduceNativeCodexStatus(state, { kind: "rollout", record: candidate.record, ...options });
}

function feedHook(
  state: NativeCodexStatusState,
  event: Record<string, unknown>,
  options: EvidenceOptions = {},
): NativeCodexStatusState {
  return reduceNativeCodexStatus(state, { kind: "hook", event, ...options });
}

function feedSource(
  state: NativeCodexStatusState,
  signal: NativeCodexSourceSignal,
  options: EvidenceOptions = {},
): NativeCodexStatusState {
  return reduceNativeCodexStatus(state, { kind: "source", signal, ...options });
}

function userPrompt(turnId: string, prompt = "SECRET PROMPT TEXT"): Record<string, unknown> {
  return {
    session_id: LINEAGE,
    turn_id: turnId,
    transcript_path: `/root/.codex/sessions/${ROOT_THREAD}.jsonl`,
    cwd: "/workspace",
    hook_event_name: "UserPromptSubmit",
    model: "gpt-5-codex",
    permission_mode: "on-request",
    prompt,
  };
}

function preToolUse(turnId: string, toolName: string, marker = "SECRET TOOL INPUT"): Record<string, unknown> {
  return {
    session_id: LINEAGE,
    turn_id: turnId,
    transcript_path: `/root/.codex/sessions/${ROOT_THREAD}.jsonl`,
    cwd: "/workspace",
    hook_event_name: "PreToolUse",
    model: "gpt-5-codex",
    permission_mode: "on-request",
    tool_name: toolName,
    tool_input: { command: `echo ${marker}`, path: `/secret/${marker}` },
    tool_use_id: "call-1",
  };
}

function stopHook(turnId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: LINEAGE,
    turn_id: turnId,
    transcript_path: `/root/.codex/sessions/${ROOT_THREAD}.jsonl`,
    cwd: "/workspace",
    hook_event_name: "Stop",
    model: "gpt-5-codex",
    permission_mode: "on-request",
    stop_hook_active: false,
    last_assistant_message: "SECRET LAST ASSISTANT MESSAGE",
    ...extra,
  };
}

function sessionStart(source: string | undefined): Record<string, unknown> {
  return {
    session_id: LINEAGE,
    transcript_path: `/root/.codex/sessions/${ROOT_THREAD}.jsonl`,
    cwd: "/workspace",
    hook_event_name: "SessionStart",
    model: "gpt-5-codex",
    permission_mode: "on-request",
    ...(source === undefined ? {} : { source }),
  };
}

function busy(state: NativeCodexStatusState): boolean | null {
  return projectNativeCodexStatus(state).busy;
}

/** Running from a real durable start witness, ready to be terminated by its own id. */
function runningTurn(turnId = "turn-1"): NativeCodexStatusState {
  return feed(createNativeCodexStatusState({ rootThreadId: ROOT_THREAD }), taskStarted(turnId));
}

function readyTurn(turnId = "turn-1"): NativeCodexStatusState {
  // The fixture models a caller that verified this turn is the current root turn
  // and attests it, which is what authorizes the Ready claim.
  return feed(runningTurn(turnId), taskComplete(turnId), { currentRootTurnId: turnId });
}

/* ------------------------------------------------------------- the contract */

test("foreground starts unknown with no activity", () => {
  const state = createNativeCodexStatusState({ rootThreadId: ROOT_THREAD });
  assert.equal(state.phase, "unknown");
  assert.deepEqual(projectNativeCodexStatus(state), { busy: null, pendingInput: null, activity: [] });
});

test("flattened task_started then task_complete drives running then Ready", () => {
  let state = createNativeCodexStatusState({ rootThreadId: ROOT_THREAD });
  state = feed(state, taskStarted("turn-1"));
  assert.equal(state.phase, "running");
  assert.equal(busy(state), true);
  // The terminal alone does not attest that its turn is still current.
  state = feed(state, taskComplete("turn-1"));
  assert.equal(state.phase, "unknown", "an unattested terminal grants no Ready claim");
  // With the caller's verified current root turn, the same unconsumed terminal lands.
  state = feed(state, taskComplete("turn-1"), { currentRootTurnId: "turn-1" });
  assert.equal(state.phase, "ready");
  assert.equal(busy(state), false);
});

test("turn_aborted bound to the attested current turn is Ready; unbindable or unattested degrades", () => {
  let state = feed(runningTurn("turn-1"), turnAborted("turn-1", "interrupted"));
  assert.equal(state.phase, "unknown", "no current-turn provenance, no Ready");
  state = feed(state, turnAborted("turn-1", "interrupted"), { currentRootTurnId: "turn-1" });
  assert.equal(state.phase, "ready");
  assert.equal(busy(state), false);
  // `turn_aborted` may carry a null turn id: not proof that THIS turn ended.
  state = feed(runningTurn("turn-1"), turnAborted(null));
  assert.equal(state.phase, "unknown");
  assert.equal(busy(state), null);
});

test("a terminal with no observed start never fabricates idle", () => {
  // Partial old replay / mid-file tail that only yields a terminal record.
  let state = createNativeCodexStatusState({ rootThreadId: ROOT_THREAD });
  // Even attested currentness cannot ready a row that never held the turn.
  state = feed(state, taskComplete("turn-9"), { currentRootTurnId: "turn-9" });
  assert.equal(state.phase, "unknown");
  assert.equal(busy(state), null);
  state = feed(state, turnAborted("turn-9"));
  assert.equal(busy(state), null);
});

test("a terminal for another turn while running degrades instead of claiming Ready", () => {
  let state = feed(runningTurn("turn-1"), taskComplete("turn-2"));
  assert.equal(state.phase, "unknown");
  assert.equal(busy(state), null);
  // The still-held terminal for the observed turn can then land, attested.
  state = feed(state, taskComplete("turn-1"), { currentRootTurnId: "turn-1" });
  assert.equal(state.phase, "ready");
});

test("question and permission tool hooks update foreground without inferring input", () => {
  // A scoped root tool attempt is processing evidence even when its activity
  // line is suppressed, so a completed turn A must not stay Ready while the
  // verified current turn B is working on a question or approval tool.
  for (const tool of ["request_user_input", "request_permissions"]) {
    for (const hook_event_name of ["PreToolUse", "PostToolUse"]) {
      const state = feedHook(readyTurn("turn-A"), {
        ...preToolUse("turn-B", tool),
        hook_event_name,
      }, { currentRootTurnId: "turn-B" });
      assert.equal(state.observedTurnId, "turn-B");
      assert.deepEqual(projectNativeCodexStatus(state), {
        busy: true, pendingInput: null, activity: [],
      });
    }
  }
});

test("Stop hooks never mark Ready, before or after the durable terminal", () => {
  let state = feedHook(runningTurn("turn-1"), stopHook("turn-1"));
  assert.equal(state.phase, "running", "a Stop hook is not a turn terminal");
  assert.equal(busy(state), true);
  state = feedHook(readyTurn("turn-1"), stopHook("turn-1"));
  assert.equal(state.phase, "ready", "a Stop hook changes nothing about a bound terminal");
});

test("a blocking Stop hook keeps the turn working until the true terminal", () => {
  let state = feedHook(runningTurn("turn-1"), preToolUse("turn-1", "Bash"));
  assert.deepEqual(state.activity, ["Exec"]);
  // The native Stop handler blocks and the same turn continues working.
  state = feedHook(state, stopHook("turn-1", { stop_hook_active: true }));
  assert.equal(busy(state), true, "a blocking Stop hook must not read as idle");
  state = feedHook(state, preToolUse("turn-1", "apply_patch"));
  assert.equal(busy(state), true);
  assert.deepEqual(state.activity, ["Exec", "Edit"]);
  state = feed(state, taskComplete("turn-1"), { currentRootTurnId: "turn-1" });
  assert.equal(busy(state), false);
});

test("SubagentStop on the parent's transcript path cannot reset the root", () => {
  // SubagentStop carries the parent's transcript_path and the shared lineage id,
  // so only agent_id identifies it as a descendant.
  const descendantStop = {
    session_id: LINEAGE,
    turn_id: "turn-1",
    transcript_path: `/root/.codex/sessions/${ROOT_THREAD}.jsonl`,
    agent_transcript_path: `/root/.codex/sessions/${CHILD_THREAD}.jsonl`,
    cwd: "/workspace",
    hook_event_name: "SubagentStop",
    model: "gpt-5-codex",
    permission_mode: "on-request",
    stop_hook_active: false,
    agent_id: "agent-7",
    agent_type: "worker",
    last_assistant_message: "SECRET CHILD OUTPUT",
  };
  let state = feedHook(runningTurn("turn-1"), descendantStop);
  assert.equal(state.phase, "running", "a descendant stop never ends the root turn");
  assert.equal(busy(state), true);
  state = feedHook(state, { ...descendantStop, hook_event_name: "Stop" });
  assert.equal(busy(state), true);
});

test("a descendant terminal with a different root_turn_id never marks the root Ready", () => {
  // Root turns carry root_turn_id == turn_id; a nested turn carries its parent's.
  const descendantTerminal = rolloutLine(2, {
    type: "task_complete",
    turn_id: "child-turn",
    root_turn_id: "turn-1",
    last_agent_message: "CHILD TURN COMPLETE",
  });
  let state = feed(runningTurn("turn-1"), descendantTerminal);
  assert.equal(state.phase, "running", "a descendant terminal is irrelevant to the root row");
  assert.equal(busy(state), true);
  // A nested turn's own start is not root processing evidence either.
  state = feed(createNativeCodexStatusState({ rootThreadId: ROOT_THREAD }), taskStarted("child-turn", "turn-1"));
  assert.equal(state.phase, "unknown");
  // Shared lineage plus a descendant terminal still cannot ready a fresh row.
  state = feed(state, rolloutLine(3, { type: "task_complete", turn_id: "child-turn", root_turn_id: "child-turn" }));
  assert.equal(state.phase, "unknown");
});

test("descendant tool hooks add neither activity nor foreground state", () => {
  let state = feedHook(runningTurn("turn-1"), { ...preToolUse("turn-1", "Bash"), agent_id: "agent-7", agent_type: "worker" });
  assert.deepEqual(state.activity, []);
  assert.equal(busy(state), true);
  state = feedHook(createNativeCodexStatusState({ rootThreadId: ROOT_THREAD }), {
    ...preToolUse("orphan-turn", "Bash"),
    agent_id: "agent-7",
  });
  assert.equal(busy(state), null, "a sub-agent tool cannot start the root row");
  assert.deepEqual(state.activity, []);
});

test("records from another thread's stream are refused", () => {
  const bound = createNativeCodexStatusState({ rootThreadId: ROOT_THREAD });
  const state = feed(bound, commandItem("turn-1", CHILD_THREAD, "CHILD_MARKER"));
  assert.deepEqual(state.activity, []);
  assert.equal(state.phase, "unknown");
});

test("duplicate terminals are idempotent and a reversed old start cannot resurrect a turn", () => {
  let state = readyTurn("turn-1");
  state = feed(state, taskComplete("turn-1"));
  assert.equal(state.phase, "ready");
  // Reversed delivery: the start of an already-terminated turn arrives late.
  state = feed(state, taskStarted("turn-1"));
  assert.equal(state.phase, "ready", "a terminated turn cannot be resurrected as running");
  assert.equal(busy(state), false);
  // A start for a turn this row never observed is taken as a new turn only
  // because the held turn already reached its durable terminal, so there is no
  // live turn that an ambiguous newcomer could clobber.
  state = feed(state, taskStarted("turn-0"));
  assert.equal(state.phase, "running");
  assert.equal(state.observedTurnId, "turn-0");
});

test("a rollout start for an unfamiliar turn cannot take over a live hook-established turn", () => {
  // Cross-stream replay: a hook establishes turn B live, then a delayed root
  // rollout start for an older turn A arrives.
  let state = feedHook(createNativeCodexStatusState({ rootThreadId: ROOT_THREAD }), userPrompt("turn-B"));
  assert.equal(state.phase, "running");
  state = feed(state, taskStarted("turn-A"));
  assert.equal(state.phase, "unknown", "arrival order alone cannot prove A is the newer turn");
  assert.equal(state.observedTurnId, "turn-B", "the held live turn keeps its correlation");
  // A's terminal therefore has no Ready authority while B may still be running.
  state = feed(state, taskComplete("turn-A"));
  assert.equal(state.phase, "unknown");
  assert.equal(busy(state), null);
  // B's own durable terminal still lands correctly, once attested as current.
  state = feed(state, taskComplete("turn-B"), { currentRootTurnId: "turn-B" });
  assert.equal(state.phase, "ready");
  assert.equal(busy(state), false);
});

test("replay beyond the tombstone bound cannot take over a live turn", () => {
  let state = createNativeCodexStatusState({ rootThreadId: ROOT_THREAD });
  // Cycle enough turns to evict the oldest tombstones entirely.
  for (let index = 0; index <= NATIVE_CODEX_MAX_TRACKED_TURNS + 2; index += 1) {
    const turnId = `cycled-${index}`;
    state = feed(state, taskStarted(turnId));
    state = feed(state, taskComplete(turnId), { currentRootTurnId: turnId });
  }
  assert.equal(state.terminatedTurnIds.length, NATIVE_CODEX_MAX_TRACKED_TURNS);
  assert.ok(!state.terminatedTurnIds.includes("cycled-0"), "the oldest tombstone was evicted");
  state = feed(state, taskStarted("turn-live"));
  assert.equal(state.phase, "running");
  // Its start and terminal are now unremembered, yet the replay still cannot
  // take over the live turn or claim Ready.
  state = feed(state, taskStarted("cycled-0"));
  assert.equal(state.phase, "unknown");
  assert.equal(state.observedTurnId, "turn-live");
  state = feed(state, taskComplete("cycled-0"));
  assert.equal(state.phase, "unknown");
});

test("recognized status records whose required scope is lost clear Ready to unknown", () => {
  const lostScope = [
    // `turn_id` is required on the wire for a start.
    rolloutLine(4, { type: "task_started", model_context_window: null }),
    rolloutLine(4, { type: "task_started", turn_id: "   " }),
    rolloutLine(4, { type: "task_started", turn_id: 7 }),
    // A persisted root tool item is processing evidence too.
    rolloutLine(4, {
      type: "item_completed",
      thread_id: ROOT_THREAD,
      completed_at_ms: 1,
      item: { type: "CommandExecution", id: "i", command: ["x"], status: "completed" },
    }),
  ];
  for (const line of lostScope) {
    const ready = feed(readyTurn("turn-1"), line);
    assert.equal(ready.phase, "unknown", `recognized malformed record must degrade: ${line.slice(0, 56)}`);
    assert.equal(busy(ready), null);
    const fresh = feed(createNativeCodexStatusState({ rootThreadId: ROOT_THREAD }), line);
    assert.equal(fresh.phase, "unknown", `malformed evidence never claims running: ${line.slice(0, 56)}`);
  }
  // A positively identified descendant with a broken scope stays irrelevant.
  const descendant = rolloutLine(4, {
    type: "task_started",
    turn_id: "child-1",
    root_turn_id: "turn-1",
    model_context_window: null,
  });
  assert.equal(feed(readyTurn("turn-1"), descendant).phase, "ready");
});

test("evidence tagged to another binding generation is dropped, including after a reset", () => {
  let state = createNativeCodexStatusState({ rootThreadId: ROOT_THREAD, generation: "gen-2" });
  // A complete old turn from the previous binding cannot re-adopt the row.
  state = feed(state, taskStarted("turn-1"), { generation: "gen-1" });
  assert.equal(state.phase, "unknown");
  state = feed(state, taskComplete("turn-1"), { generation: "gen-1", currentRootTurnId: "turn-1" });
  assert.equal(state.phase, "unknown");
  state = feedHook(state, userPrompt("turn-1"), { generation: "gen-1" });
  assert.equal(state.phase, "unknown");
  assert.deepEqual(state.activity, []);
  // Current-generation evidence still drives the row.
  state = feed(state, taskStarted("turn-1"), { generation: "gen-2" });
  assert.equal(state.phase, "running");
  // A rebind resets the correlation and adopts the caller's new generation.
  state = feedSource(state, "rebind", { generation: "gen-3" });
  assert.equal(state.generation, "gen-3");
  assert.equal(state.phase, "unknown");
  state = feed(state, taskStarted("turn-1"), { generation: "gen-2" });
  assert.equal(state.phase, "unknown", "the previous generation stays out of scope after the reset");
  state = feed(state, taskStarted("turn-1"), { generation: "gen-3" });
  state = feed(state, taskComplete("turn-1"), { generation: "gen-3", currentRootTurnId: "turn-1" });
  assert.equal(state.phase, "ready");
  // Untagged evidence keeps working when the caller does not tag at all.
  const untagged = createNativeCodexStatusState({ rootThreadId: ROOT_THREAD });
  assert.equal(feed(untagged, taskStarted("turn-1")).phase, "running");
});

test("a steering prompt that arrives before the previous turn's terminal keeps the row unknown", () => {
  // The new prompt's hook can land before the running turn's durable
  // `turn_aborted`. While B is the current work, A's terminal must NOT produce
  // Ready, because matching the older held turn proves nothing about currentness.
  let state = runningTurn("turn-1");
  state = feedHook(state, userPrompt("turn-2"));
  assert.equal(state.phase, "unknown", "the live turn is still held, so the newcomer gains no authority");
  assert.equal(state.observedTurnId, "turn-1");
  state = feed(state, turnAborted("turn-1", "replaced"));
  assert.equal(state.phase, "unknown", "B is being processed, so A's terminal cannot claim Ready");
  assert.equal(busy(state), null);
  // The caller then verifies B as the current root turn and attests it.
  state = feed(state, taskStarted("turn-2"), { currentRootTurnId: "turn-2" });
  assert.equal(state.phase, "running");
  assert.equal(state.observedTurnId, "turn-2");
  state = feed(state, taskComplete("turn-2"), { currentRootTurnId: "turn-2" });
  assert.equal(state.phase, "ready");
});

test("a delayed terminal from an older turn cannot clobber a newer turn", () => {
  let state = readyTurn("turn-1");
  state = feed(state, taskStarted("turn-2"));
  assert.equal(busy(state), true);
  // The old turn's terminal is replayed after the new turn began.
  state = feed(state, taskComplete("turn-1"));
  assert.equal(busy(state), true, "the older terminal is stale and must not mark Ready");
  state = feed(state, taskComplete("turn-2"), { currentRootTurnId: "turn-2" });
  assert.equal(busy(state), false);
});

test("a delayed old processing record cannot regress the observed turn", () => {
  let state = readyTurn("turn-1");
  state = feed(state, taskStarted("turn-2"));
  state = feedHook(state, userPrompt("turn-1"));
  assert.equal(state.observedTurnId, "turn-2", "an old prompt cannot move the row back a turn");
  assert.equal(busy(state), true);
});

test("post-turn compaction never invents a new idle and mid-turn compaction keeps running", () => {
  const ready = readyTurn("turn-1");
  let state = feed(ready, rolloutLine(4, { type: "context_compacted" }));
  state = reduceNativeCodexStatus(state, {
    kind: "rollout",
    record: { timestamp: "2026-01-02T00:00:05.000Z", ordinal: 5, type: "compacted", payload: { message: "COMPACTED TEXT" } },
  });
  state = feedHook(state, { ...sessionStart("compact"), hook_event_name: "PostCompact" });
  assert.deepEqual(projectNativeCodexStatus(state), projectNativeCodexStatus(ready));
  // Compaction inside a live turn does not end it either.
  state = feedHook(feedHook(runningTurn("turn-1"), sessionStart("compact")), {
    ...sessionStart("compact"),
    hook_event_name: "PreCompact",
  });
  assert.equal(busy(state), true);
  state = feed(state, rolloutLine(4, { type: "context_compacted" }));
  assert.equal(busy(state), true);
});

test("activity is tool TYPE only, never args, input, results, or prompts", () => {
  let state = feed(runningTurn("turn-1"), commandItem("turn-1", ROOT_THREAD, "LEAKY_COMMAND_MARKER"));
  assert.deepEqual(state.activity, ["Exec"]);
  state = feed(state, rolloutLine(4, {
    type: "item_completed",
    thread_id: ROOT_THREAD,
    turn_id: "turn-1",
    completed_at_ms: 2,
    item: {
      type: "McpToolCall",
      id: "item-mcp",
      server: "leaky_server_marker",
      tool: "leaky_tool_marker",
      arguments: { path: "/secret/LEAKY_ARGUMENT" },
      status: "completed",
      result: "LEAKY_RESULT",
    },
  }));
  assert.deepEqual(state.activity, ["Exec", "MCP tool"]);
  state = feedHook(state, preToolUse("turn-1", "apply_patch", "LEAKY_TOOL_INPUT"));
  assert.deepEqual(state.activity, ["MCP tool", "Edit"]);
  const serialized = JSON.stringify({ state, fields: projectNativeCodexStatus(state) });
  for (const marker of [
    "LEAKY_COMMAND_MARKER",
    "LEAKY_ARGUMENT",
    "LEAKY_RESULT",
    "LEAKY_TOOL_INPUT",
    "leaky_server_marker",
    "leaky_tool_marker",
    "SECRET TOOL INPUT",
    "/workspace",
    "/bin/bash",
  ]) {
    assert.ok(!serialized.includes(marker), `activity and state must not contain ${marker}`);
  }
});

test("legacy-history tool witnesses map to the same vocabulary", () => {
  let state = feed(runningTurn("turn-1"), rolloutLine(4, {
    type: "patch_apply_end",
    turn_id: "turn-1",
    call_id: "patch-1",
    stdout: "LEAKY PATCH STDOUT",
    stderr: "LEAKY PATCH STDERR",
    success: true,
    status: "completed",
  }));
  state = feed(state, rolloutLine(5, {
    type: "mcp_tool_call_end",
    turn_id: "turn-1",
    call_id: "mcp-1",
    invocation: { server: "LEAKY_SERVER", tool: "LEAKY_TOOL", arguments: {} },
    result: { content: [{ type: "text", text: "LEAKY MCP TEXT" }] },
    status: "completed",
  }));
  state = feed(state, rolloutLine(6, {
    type: "web_search_end",
    call_id: "ws-1",
    query: "LEAKY QUERY",
    action: { type: "search", queries: ["LEAKY QUERY"] },
  }));
  assert.deepEqual(state.activity, ["Edit", "MCP tool", "Web search"].slice(-MAX_ACTIVITY_LINES));
  const serialized = JSON.stringify(state);
  for (const marker of ["LEAKY PATCH STDOUT", "LEAKY_SERVER", "LEAKY TOOL", "LEAKY MCP TEXT", "LEAKY QUERY"]) {
    assert.ok(!serialized.includes(marker), `state must not contain ${marker}`);
  }
});

test("activity stays bounded and sanitized", () => {
  let state = runningTurn("turn-1");
  for (const [index, toolName] of ["Bash", "apply_patch", "view_image", "web_search", "Bash"].entries()) {
    state = feedHook(state, { ...preToolUse("turn-1", toolName), tool_use_id: `call-${index}` });
  }
  assert.equal(state.activity.length, MAX_ACTIVITY_LINES);
  assert.deepEqual(state.activity, ["Web search", "Exec"]);
  // Consecutive repeats are not re-emitted, and a new turn owns new lines.
  state = feedHook(state, preToolUse("turn-1", "Bash"));
  assert.deepEqual(state.activity, ["Web search", "Exec"]);
  // A new turn owns new lines once the previous turn reached its attested terminal.
  state = feed(state, taskComplete("turn-1"), { currentRootTurnId: "turn-1" });
  state = feed(state, taskStarted("turn-2"));
  assert.deepEqual(state.activity, []);
  // Control characters cannot survive into an activity line.
  state = reduceNativeCodexStatus(runningTurn("turn-2"), {
    kind: "rollout",
    record: {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: ROOT_THREAD,
        turn_id: "turn-2",
        item: { type: "CommandExecution", id: "x", command: ["\u001b[31mESC\u0007"], status: "completed" },
      },
    },
  });
  assert.deepEqual(state.activity, ["Exec"]);
});

test("invalid candidate records clear Ready to unknown", () => {
  const ready = readyTurn("turn-1");
  for (const record of [
    "not json at all",
    "[1,2,3]",
    JSON.stringify({ timestamp: "2026-01-02T00:00:00Z" }),
    JSON.stringify({ timestamp: "2026-01-02T00:00:00Z", type: "event_msg" }),
    JSON.stringify({ timestamp: "2026-01-02T00:00:00Z", type: "event_msg", payload: { type: "task_complete", turn_id: 42 } }),
    JSON.stringify({
      timestamp: "2026-01-02T00:00:00Z",
      type: "event_msg",
      payload: { type: "item_completed", thread_id: ROOT_THREAD, turn_id: "turn-1" },
    }),
  ]) {
    const candidate = classifyNativeCodexCandidate(record);
    let state = ready;
    state = candidate.status === "record"
      ? reduceNativeCodexStatus(state, { kind: "rollout", record: candidate.record })
      : feedSource(state, candidate.status === "oversized" ? "oversized" : "malformed");
    assert.equal(state.phase, "unknown", `candidate must degrade the row: ${record.slice(0, 40)}`);
    assert.equal(busy(state), null);
  }
});

test("oversized candidate lines are refused by the classifier", () => {
  const oversized = `${"x".repeat(NATIVE_CODEX_MAX_CANDIDATE_CHARS + 1)}`;
  assert.deepEqual(classifyNativeCodexCandidate(oversized), { status: "oversized" });
  assert.deepEqual(classifyNativeCodexCandidate("   "), { status: "blank" });
  assert.equal(classifyNativeCodexCandidate(taskComplete("turn-1")).status, "record");
});

test("a gap invalidates unattested terminals, and an attested current turn recovers", () => {
  // `start(A) -> gap -> delayed complete(A)`: the gap may hide A's completion
  // and a newer turn's start, so first consumption of A's terminal proves
  // nothing about currentness and the row must stay unknown.
  let state = runningTurn("turn-A");
  state = feedSource(state, "gap");
  assert.equal(state.phase, "unknown");
  state = feed(state, taskComplete("turn-A"));
  assert.equal(state.phase, "unknown", "no verified continuity, no Ready");
  // The caller verifies B as the current root turn and attests it on its own
  // start and terminal, which recovers the row.
  state = feed(state, taskStarted("turn-B"), { currentRootTurnId: "turn-B" });
  assert.equal(state.phase, "running");
  assert.equal(state.observedTurnId, "turn-B");
  state = feed(state, taskComplete("turn-B"), { currentRootTurnId: "turn-B" });
  assert.equal(state.phase, "ready");
  assert.equal(busy(state), false);
});

test("gap and source-failure degrade, and only attested unconsumed evidence can re-establish Ready", () => {
  for (const signal of ["gap", "source-failure", "malformed", "oversized"] as const) {
    // Recovery of the still-held turn requires the caller's currentness proof.
    let state = feedSource(runningTurn("turn-1"), signal);
    assert.equal(state.phase, "unknown", `${signal} degrades a running row`);
    state = feed(state, taskComplete("turn-1"));
    assert.equal(state.phase, "unknown", `${signal}: an unattested terminal grants no Ready`);
    state = feed(state, taskComplete("turn-1"), { currentRootTurnId: "turn-1" });
    assert.equal(state.phase, "ready", `${signal} must not make the unknown permanent`);

    // Replay of a consumed terminal: the same durable record is not fresh
    // evidence even with provenance, because the gap could have hidden a newer
    // live turn.
    state = feedSource(readyTurn("turn-1"), signal);
    assert.equal(state.phase, "unknown", `${signal} clears a Ready row instead of keeping it stale`);
    state = feed(state, taskComplete("turn-1"), { currentRootTurnId: "turn-1" });
    assert.equal(state.phase, "unknown", `${signal}: a consumed terminal cannot restore Ready`);

    // A turn started and completed entirely after the gap is fresh again.
    state = feed(state, taskStarted("turn-2"));
    assert.equal(state.phase, "running");
    state = feed(state, taskComplete("turn-2"), { currentRootTurnId: "turn-2" });
    assert.equal(state.phase, "ready");
  }
});

test("rebind clears the turn correlation so an old terminal cannot restore Ready", () => {
  let state = feedSource(readyTurn("turn-1"), "rebind");
  assert.equal(state.phase, "unknown");
  assert.equal(state.observedTurnId, null);
  assert.deepEqual(state.activity, []);
  state = feed(state, taskComplete("turn-1"));
  assert.equal(state.phase, "unknown", "a rebound row cannot be readied by the previous thread");
});

test("scope-changing SessionStart clears state while compact does not", () => {
  for (const source of ["startup", "clear", "fork", "resume", "unrecognized-future-source"]) {
    const state = feedHook(readyTurn("turn-1"), sessionStart(source));
    assert.equal(state.phase, "unknown", `${source} puts old observations out of scope`);
    assert.equal(state.observedTurnId, null);
    assert.deepEqual(state.activity, []);
  }
  const compacted = feedHook(readyTurn("turn-1"), sessionStart("compact"));
  assert.equal(compacted.phase, "ready", "compaction keeps the same thread and turn");
  assert.equal(compacted.observedTurnId, "turn-1");
});

test("irrelevant record text never leaks and produces no state change", () => {
  const ready = readyTurn("turn-1");
  const irrelevant = [
    rolloutLine(4, { type: "user_message", message: "IRRELEVANT USER TEXT MARKER" }),
    rolloutLine(5, { type: "agent_message", message: "IRRELEVANT AGENT TEXT MARKER" }),
    rolloutLine(6, { type: "agent_reasoning", message: "IRRELEVANT REASONING MARKER" }),
    rolloutLine(7, { type: "token_count", info: { total_tokens: 1234 } }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: { command: "RESPONSE ITEM MARKER" } },
    }),
    JSON.stringify({ type: "session_meta", payload: { id: CHILD_THREAD, session_id: LINEAGE } }),
    JSON.stringify({ type: "turn_context", payload: { nickname: "TURN CONTEXT MARKER" } }),
  ];
  let state = ready;
  for (const line of irrelevant) state = feed(state, line);
  assert.deepEqual(projectNativeCodexStatus(state), projectNativeCodexStatus(ready));
  const serialized = JSON.stringify(state);
  for (const marker of ["IRRELEVANT USER TEXT MARKER", "IRRELEVANT AGENT TEXT MARKER", "IRRELEVANT REASONING MARKER", "RESPONSE ITEM MARKER", "TURN CONTEXT MARKER"]) {
    assert.ok(!serialized.includes(marker), `state must not contain ${marker}`);
  }
});

test("mid-turn tail start converges from a persisted tool item", () => {
  let state = createNativeCodexStatusState({ rootThreadId: ROOT_THREAD });
  state = feed(state, commandItem("turn-3", ROOT_THREAD, "MID_TURN"));
  assert.equal(state.phase, "running", "a persisted root tool item is real processing evidence");
  assert.deepEqual(state.activity, ["Exec"]);
  state = feed(state, taskComplete("turn-3"), { currentRootTurnId: "turn-3" });
  assert.equal(busy(state), false);
});

test("unbound hook events cannot start a row and recognized scoped events degrade", () => {
  // A prompt or tool event without its required turn scope is a malformed
  // status record: it may describe real processing whose scope was lost.
  const promptWithoutTurn = { ...userPrompt("turn-2") };
  delete promptWithoutTurn.turn_id;
  const toolWithoutTurn = { ...preToolUse("turn-2", "Bash") };
  delete toolWithoutTurn.turn_id;
  const malformed = [promptWithoutTurn, { ...userPrompt("turn-2"), turn_id: 42 }, toolWithoutTurn];
  for (const event of malformed) {
    let state = feedHook(createNativeCodexStatusState({ rootThreadId: ROOT_THREAD }), event);
    assert.equal(state.phase, "unknown", "unscoped evidence never claims the row is running");
    assert.deepEqual(state.activity, []);
    state = feedHook(readyTurn("turn-1"), event);
    assert.equal(state.phase, "unknown", "unscoped recognized processing cannot keep Ready");
  }
  // A positively identified descendant stays ignored even with a broken scope.
  const descendantBadScope = { ...preToolUse("turn-1", "Bash"), agent_id: "agent-7", turn_id: 42 };
  assert.equal(feedHook(readyTurn("turn-1"), descendantBadScope).phase, "ready");
});

test("hook metadata extraction keeps prompt, tool input, and results out of state", () => {
  const meta = parseNativeCodexHookMetadata(preToolUse("turn-1", "Bash", "PARSER LEAK MARKER"));
  assert.deepEqual(meta, {
    event: "PreToolUse",
    turnId: "turn-1",
    scopeInvalid: false,
    agentId: null,
    toolName: "Bash",
    source: null,
  });
  assert.equal(parseNativeCodexHookMetadata({ cwd: "/workspace" }), null);
  assert.equal(parseNativeCodexHookMetadata("PreToolUse"), null);
  // A recognized event with an unusable scope stays visible as malformed.
  assert.equal(parseNativeCodexHookMetadata({ hook_event_name: "PreToolUse", turn_id: 42 })?.scopeInvalid, true);
  assert.equal(JSON.stringify(meta).includes("PARSER LEAK MARKER"), false);
});

test("no counts or fabricated pending input are produced, and fields stay assignable", () => {
  const state = feedHook(readyTurn("turn-1"), preToolUse("turn-1", "Bash"));
  const fields = projectNativeCodexStatus(state);
  assert.deepEqual(Object.keys(fields).sort(), ["activity", "busy", "pendingInput"]);
  assert.equal(fields.pendingInput, null, "question detection is separate acquisition work");
  for (const value of Object.values(fields)) {
    assert.notEqual(typeof value, "number", "no numeric work counts are produced here");
  }
  // The snapshot's supported subset must stay assignable to a status update.
  const asUpdate: Pick<InstanceStatusUpdate, "busy" | "pendingInput" | "activity"> = fields;
  assert.equal(asUpdate.busy, false);
  // pendingInput is only an explicit caller passthrough, never inferred.
  assert.equal(projectNativeCodexStatus(state, { pendingInput: true }).pendingInput, true);
  assert.equal(projectNativeCodexStatus(state, { pendingInput: undefined }).pendingInput, null);
});

test("reducer input kinds are exhaustive and never mutate the input state", () => {
  const before = readyTurn("turn-1");
  const frozen = structuredClone(before);
  const evidence: NativeCodexEvidence[] = [
    { kind: "rollout", record: { type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } } },
    { kind: "hook", event: stopHook("turn-1") },
    { kind: "source", signal: "gap" },
  ];
  let state = before;
  for (const item of evidence) state = reduceNativeCodexStatus(state, item);
  assert.deepEqual(before, frozen, "the reducer never mutates the state it was given");
  assert.equal(state.phase, "unknown");
});
