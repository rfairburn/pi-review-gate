/**
 * Focused tests for the owned-run Codex native foreground + tool-activity
 * acquisition controller.
 *
 * Every rollout here is a synthetic JSONL file this test wrote in its own
 * temporary directory OUTSIDE the repository, in the flattened record shapes the
 * pinned Codex source (`rust-v0.167.2`) persists:
 * `{"timestamp":…,"ordinal":…,"type":"event_msg","payload":{"type":"task_started"|
 * "task_complete"|"turn_aborted"|"item_completed",…}}`, plus the
 * `{"type":"session_meta","payload":{…flattened SessionMeta…}}` head record and
 * the canonical `rollout-<timestamp>-<thread-uuid>.jsonl` basename. No provider,
 * model, auth, config, session store, network, or real transcript is touched, and
 * no provider process runs.
 *
 * What the assertions pin: the row binds only the ONE rollout path its own root
 * hook named, and only to the thread that name and the file's own `session_meta`
 * corroborate; running/Ready come only from ordered ROOT records, so a descendant
 * terminal, an un-started terminal, a replay, and completed pre-bind history never
 * grant Ready, while a fresh root start in the current ordered stream is what makes
 * a turn current and closes; the provider's own record `ordinal` must stay
 * contiguous, so a jump or reversal is a history gap even though the bytes were
 * contiguous; a status envelope with no usable scope rejects its whole window even
 * though it parses, including a persisted tool item whose turn scope the reducer
 * requires, so malformed pre-bind history cannot seed Ready; a completion appended
 * after the bind floor is fresh evidence rather than discarded history; a gap, a
 * malformed/oversized/skipped record, a replaced or truncated file, and a watcher
 * failure all collapse the supported values to unknown and WITHHOLD already-observed
 * activity until a record or this run's own bound root tool hook the reducer itself
 * accepts as fresh tool activity restores it — the hook in the very snapshot it
 * publishes (a text item, a non-tool or question-tool hook, a descendant's tool, an
 * unheld turn, or a tombstoned turn's replay cannot); `input`/`tasks`/`shells` stay declared not-applicable with null
 * values (never a fabricated zero); and no record text ever reaches the observation.
 */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { afterEach } from "node:test";

import type { NativeHookEvent } from "../src/session-host/native-hook-protocol";
import {
  NATIVE_CODEX_ACQUISITION_SUPPORT,
  NativeCodexAcquisitionController,
  type NativeCodexAcquisitionGapReason,
  type NativeCodexAcquisitionSnapshot,
  type NativeCodexWatchFactory,
  type NativeCodexWatchHandlers,
} from "../src/session-host/native-codex-acquisition";
import type { NativeStatusObservation } from "../src/session-host/native-status";

const LINEAGE = "99999999-8888-7777-6666-555555555555";
const ROOT_THREAD = "11111111-2222-3333-4444-555555555555";
const OTHER_THREAD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const FOREIGN_LINEAGE = "12121212-3434-4545-8686-787878787878";
const TURN_1 = "019a1111-1111-7111-8111-111111111111";
const TURN_2 = "019a2222-2222-7222-8222-222222222222";

const SECRET_PROMPT = "SECRET-PROMPT-TEXT-do-not-surface";
const SECRET_ANSWER = "SECRET-ANSWER-TEXT-do-not-surface";
const SECRET_COMMAND = "rm -rf /secret/working-directory && echo SECRET";
const SECRET_CWD = "/secret/working-directory";
const SECRET_TOOL_INPUT = "SECRET-TOOL-INPUT-JSON";
const SECRET_REASONING = "SECRET-REASONING-TEXT";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    // Only directories this test created are removed; nothing provider-owned is.
    await fs.rm(dir, { recursive: true, force: true });
  }
});

interface Harness {
  readonly dir: string;
  readonly transcript: string;
  readonly controller: NativeCodexAcquisitionController;
  readonly snapshots: NativeCodexAcquisitionSnapshot[];
  readonly gaps: NativeCodexAcquisitionGapReason[];
  /** Delivers this owned run's root `SessionStart` for `transcript`. */
  bind(target?: string, source?: string): void;
  hook(name: string, extra?: Record<string, unknown>): void;
  append(row: string): Promise<void>;
  /** Fires the watched file's change callback, as a real append would. */
  change(): void;
  latest(): NativeCodexAcquisitionSnapshot;
  ready(): NativeCodexAcquisitionSnapshot[];
  running(): NativeCodexAcquisitionSnapshot[];
}

/**
 * The watch seam stands in for `fs.watch` so a read is driven exactly when the
 * test has finished writing a whole batch. `useRealWatch: true` exercises the
 * controller's own default factory instead.
 */
async function createHarness(options: {
  seed?: string;
  transcriptName?: string;
  maxTailBytes?: number;
  maxLineBytes?: number;
  watchFile?: NativeCodexWatchFactory;
  useRealWatch?: boolean;
} = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prg-native-codex-acq-"));
  dirs.push(dir);
  const transcript = path.join(
    dir,
    options.transcriptName ?? `rollout-2026-01-02T03-04-05-${ROOT_THREAD}.jsonl`,
  );
  await fs.writeFile(transcript, options.seed ?? "", "utf8");
  const snapshots: NativeCodexAcquisitionSnapshot[] = [];
  const gaps: NativeCodexAcquisitionGapReason[] = [];
  let handlers: NativeCodexWatchHandlers | null = null;
  const factory = options.watchFile ?? ((_watchedPath, _given) => ({ close: () => undefined }));
  const watchFile: NativeCodexWatchFactory | undefined = options.useRealWatch
    ? undefined
    : (watchedPath, given) => {
      // The seam deliberately keeps the callbacks after `close`: the controller
      // must fence a callback that a detached watcher already queued.
      handlers = given;
      return factory(watchedPath, given);
    };
  const controller = new NativeCodexAcquisitionController({
    rowId: "row-1",
    backend: "codex",
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onSourceGap: (reason) => gaps.push(reason),
    ...(options.maxTailBytes === undefined ? {} : { maxTailBytes: options.maxTailBytes }),
    ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
    ...(watchFile === undefined ? {} : { watchFile }),
  });
  return {
    dir,
    transcript,
    controller,
    snapshots,
    gaps,
    bind: (target = transcript, source = "startup") => controller.acceptHook({
      backend: "codex",
      hook_event_name: "SessionStart",
      session_id: LINEAGE,
      transcript_path: target,
      source,
    } as NativeHookEvent),
    hook: (name, extra = {}) => controller.acceptHook({
      backend: "codex",
      hook_event_name: name as NativeHookEvent["hook_event_name"],
      session_id: LINEAGE,
      transcript_path: transcript,
      ...extra,
    } as NativeHookEvent),
    append: async (row) => {
      await fs.appendFile(transcript, row, "utf8");
      handlers?.onChange();
    },
    change: () => handlers?.onChange(),
    latest: () => snapshots[snapshots.length - 1] as NativeCodexAcquisitionSnapshot,
    ready: () => snapshots.filter((snapshot) => snapshot.busy === false),
    running: () => snapshots.filter((snapshot) => snapshot.busy === true),
  };
}

/* ------------------------------------------------------- pinned wire shapes */

/**
 * Fixtures mirror how the provider really persists a rollout: one `ordinal` per
 * record, incremented by one, so the controller's continuity check sees the same
 * shape it sees in production.
 */
let recordOrdinal = 0;
function nextOrdinal(): number {
  recordOrdinal += 1;
  return recordOrdinal;
}

function rolloutLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({
    timestamp: "2026-01-02T03:04:05.000Z",
    ordinal: nextOrdinal(),
    type: "event_msg",
    payload,
  })}\n`;
}

function taskStarted(turnId: string, extra: Record<string, unknown> = {}): string {
  return rolloutLine({
    type: "task_started",
    turn_id: turnId,
    root_turn_id: turnId,
    trace_id: "trace-1",
    started_at: 1,
    model_context_window: null,
    collaboration_mode_kind: "default",
    ...extra,
  });
}

function taskComplete(turnId: string, extra: Record<string, unknown> = {}): string {
  return rolloutLine({
    type: "task_complete",
    turn_id: turnId,
    root_turn_id: turnId,
    last_agent_message: SECRET_ANSWER,
    started_at: 1,
    completed_at: 2,
    duration_ms: 1000,
    ...extra,
  });
}

function turnAborted(turnId: string | null, extra: Record<string, unknown> = {}): string {
  return rolloutLine({ type: "turn_aborted", turn_id: turnId, reason: "interrupted", ...extra });
}

function itemCompleted(
  threadId: string,
  turnId: string,
  item: Record<string, unknown>,
): string {
  return rolloutLine({
    type: "item_completed",
    thread_id: threadId,
    turn_id: turnId,
    completed_at_ms: 1,
    item,
  });
}

function sessionMeta(threadId: string, sessionId: string = LINEAGE): string {
  return `${JSON.stringify({
    timestamp: "2026-01-02T03:04:05.000Z",
    ordinal: nextOrdinal(),
    type: "session_meta",
    payload: {
      session_id: sessionId,
      id: threadId,
      timestamp: "2026-01-02T03:04:05",
      cwd: SECRET_CWD,
      originator: "test-harness",
      cli_version: "0.167.2",
      source: "cli",
      model_provider: null,
      base_instructions: null,
    },
  })}\n`;
}

/** A persisted command item: the tool TYPE is all this row may ever show. */
function commandItem(turnId: string, threadId: string = ROOT_THREAD): string {
  return itemCompleted(threadId, turnId, {
    type: "CommandExecution",
    id: "item-exec",
    command: ["/bin/bash", "-lc", SECRET_COMMAND],
    cwd: `file://${SECRET_CWD}`,
    parsed_cmd: [],
    source: "agent",
    status: "completed",
    aggregated_output: `${SECRET_ANSWER} stdout`,
  });
}

/** A persisted function-call item, i.e. the native `FunctionCallOutput` TurnItem. */
function functionCallItem(turnId: string, threadId: string = ROOT_THREAD): string {
  return itemCompleted(threadId, turnId, {
    type: "FunctionCallOutput",
    id: "item-call",
    name: "shell",
    output: SECRET_TOOL_INPUT,
  });
}

/** A `response_item` record: real history, zero foreground authority. */
function responseItem(text: string): string {
  return `${JSON.stringify({
    timestamp: "2026-01-02T03:04:05.000Z",
    ordinal: nextOrdinal(),
    type: "response_item",
    payload: { type: "reasoning", summary: [{ type: "summary_text", text }] },
  })}\n`;
}

/** A `turn_context` record: real per-turn settings, zero foreground authority. */
function turnContext(turnId: string): string {
  return `${JSON.stringify({
    timestamp: "2026-01-02T03:04:05.000Z",
    ordinal: nextOrdinal(),
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd: SECRET_CWD,
      approval_policy: "on-request",
      sandbox_policy: { type: "workspace-write" },
      model: "gpt-5-codex",
    },
  })}\n`;
}

/**
 * One raw rollout record with an EXPLICIT ordinal. Only the discontinuity tests
 * use it: every other fixture goes through `rolloutLine`, which increments the
 * same way the provider does.
 */
function rawRollout(ordinal: number, payload: Record<string, unknown>): string {
  return `${JSON.stringify({
    timestamp: "2026-01-02T03:04:05.000Z",
    ordinal,
    type: "event_msg",
    payload,
  })}\n`;
}

/** A syntactically perfect status record whose envelope carries no usable scope. */
function scopelessTerminal(): string {
  return rolloutLine({ type: "task_complete", last_agent_message: SECRET_ANSWER });
}

/* ------------------------------------------------------------- test helpers */

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A pause long enough that any real watcher/read would already have landed. */
async function settle(ms = 200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bind the owned run, then open one root turn in the bound rollout. */
async function beginTurn(h: Harness, turnId: string = TURN_1): Promise<void> {
  h.bind();
  await waitFor(() => h.snapshots.length > 0, "the bind should publish a first snapshot");
  await h.append(taskStarted(turnId));
  await waitFor(() => h.running().length > 0, "the persisted root task_started should be running");
}

/* ------------------------------------------------------------------- tests */

test("malformed pre-bind tool scope cannot seed Ready", async () => {
  // A persisted tool item is processing evidence, so `reduceItemCompleted` needs
  // its turn scope: without `turn_id` the reducer degrades rather than ignores.
  // Seeding past it would let a later completion grant Ready across evidence the
  // source itself could not vouch for.
  const h = await createHarness({
    seed: sessionMeta(ROOT_THREAD) + taskStarted(TURN_1) + rolloutLine({
      type: "item_completed",
      thread_id: ROOT_THREAD,
      completed_at_ms: 1,
      item: { type: "CommandExecution" },
    }),
  });
  h.bind();
  appendFileSync(h.transcript, taskComplete(TURN_1), "utf8");

  await settle();
  assert.ok(h.gaps.includes("malformed"), "a tool item with no turn scope is a malformed candidate");
  assert.deepEqual(h.ready(), [], "no Ready may be granted across malformed scope");
  assert.equal(h.latest().busy, null);
  h.controller.dispose();
});

test("non-tool items do not restore activity withdrawn by a gap", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await h.append(commandItem(TURN_1));
  await waitFor(() => h.latest().activity.length > 0, "observe Exec first");

  h.controller.acceptFailure({ backend: "codex", reason: "input-malformed" });
  assert.deepEqual(h.latest().activity, [], "the gap withdraws the observed label");

  // A text item is returned unchanged by the reducer, so it is not fresh tool
  // observation and must not resurrect the withheld label.
  await h.append(itemCompleted(ROOT_THREAD, TURN_1, { type: "AgentMessage", text: SECRET_ANSWER }));
  await settle();
  assert.deepEqual(h.latest().activity, [], "a non-tool item restores nothing");

  // A nested turn's tool item describes a descendant, never this row.
  await h.append(rolloutLine({
    type: "item_completed",
    thread_id: ROOT_THREAD,
    turn_id: TURN_2,
    root_turn_id: TURN_1,
    completed_at_ms: 1,
    item: { type: "CommandExecution", id: "item-desc", command: ["ls"], cwd: "/x", parsed_cmd: [], source: "agent", status: "completed", aggregated_output: "ok" },
  }));
  await settle();
  assert.deepEqual(h.latest().activity, [], "a descendant tool item restores nothing");

  // Only a fresh tool item the reducer accepts makes activity observable again.
  await h.append(commandItem(TURN_1));
  await waitFor(() => h.latest().activity.at(-1) === "Exec", "fresh tool activity must restore it");
  h.controller.dispose();
});

test("a tool replay for a tombstoned turn does not restore withheld activity", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await h.append(commandItem(TURN_1));
  await waitFor(() => h.latest().activity.length > 0, "observe Exec first");
  await h.append(taskComplete(TURN_1));
  await waitFor(() => h.ready().length > 0, "the turn closes and is tombstoned");

  h.controller.acceptFailure({ backend: "codex", reason: "input-malformed" });
  assert.deepEqual(h.latest().activity, [], "the gap withdraws the observed label");

  // The reducer refuses processing for a turn whose terminal it already consumed,
  // so this record carries no fresh activity either.
  await h.append(commandItem(TURN_1));
  await settle();
  assert.deepEqual(h.latest().activity, [], "a tombstoned turn's tool record is not fresh activity");
  h.controller.dispose();
});

test("a fresh bound tool hook restores withheld activity at once, and unrelated or stale traffic does not", async () => {
  for (const [toolName, label] of [["Bash", "Exec"], ["apply_patch", "Edit"]] as const) {
    const h = await createHarness();
    await beginTurn(h);
    await h.append(commandItem(TURN_1));
    await waitFor(() => h.latest().activity.at(-1) === "Exec", `${toolName}: observe Exec first`);

    h.controller.acceptFailure({ backend: "codex", reason: "input-malformed" });
    assert.deepEqual(h.latest().activity, [], `${toolName}: the gap withdraws the observed label`);
    await settle();

    // Traffic that is not this row's fresh tool TYPE restores nothing: another
    // conversation, a descendant, a non-tool hook, a suppressed question tool, a
    // tool hook for a turn this row does not hold, and a tool hook with no scope.
    const inert: Array<readonly [string, Record<string, unknown>]> = [
      ["PreToolUse", { session_id: FOREIGN_LINEAGE, turn_id: TURN_1, tool_name: toolName }],
      ["PreToolUse", { agent_id: "agent-9", turn_id: TURN_1, tool_name: toolName }],
      ["UserPromptSubmit", { turn_id: TURN_1, prompt: SECRET_PROMPT }],
      ["Stop", { turn_id: TURN_1 }],
      ["SessionStart", { source: "compact" }],
      ["PreToolUse", { turn_id: TURN_1, tool_name: "request_user_input" }],
      ["PreToolUse", { turn_id: TURN_2, tool_name: toolName }],
      ["PostToolUse", { tool_name: toolName }],
      ["PostToolUse", { turn_id: TURN_1, tool_name: 42 }],
      // The reducer's generic fallback label names no TYPE: a hook with no tool
      // name, or one the reducer does not recognize, cannot pay recovery.
      ["PreToolUse", { turn_id: TURN_1 }],
      ["PostToolUse", { turn_id: TURN_1, tool_name: "some_dynamic_tool" }],
    ];
    for (const [name, extra] of inert) {
      h.hook(name, extra);
      assert.deepEqual(h.latest().activity, [], `${toolName}: ${name} ${JSON.stringify(extra)} restores nothing`);
    }
    await settle();
    assert.deepEqual(h.latest().activity, [], `${toolName}: no inert hook restored activity later either`);

    // This run's own bound tool hook for the held turn is fresh tool activity the
    // reducer accepts — including the SAME type it held before the gap — so the
    // snapshot this very call publishes carries it, with no rollout append needed.
    const before = h.snapshots.length;
    h.hook("PreToolUse", { turn_id: TURN_1, tool_name: toolName, tool_input: SECRET_TOOL_INPUT });
    const published = h.snapshots.slice(before);
    assert.equal(published.length, 1, `${toolName}: the hook publishes exactly one snapshot`);
    assert.equal(published[0]?.activity.at(-1), label, `${toolName}: the hook's own TYPE is observable at once`);
    assert.deepEqual(
      published[0]?.activity,
      label === "Exec" ? ["Exec"] : ["Exec", label],
      `${toolName}: no line from the inert traffic is republished as fresh`,
    );
    assert.equal(published[0]?.busy, true);
    assert.ok(!JSON.stringify(published).includes(SECRET_TOOL_INPUT), "no tool input crosses the boundary");
    assert.deepEqual(h.gaps, ["hook-failure"]);
    h.controller.dispose();
  }
});

test("hook recovery publishes the same activity a durable rollout recovery would", async () => {
  const viaRollout = await createHarness();
  await beginTurn(viaRollout);
  await viaRollout.append(commandItem(TURN_1));
  await waitFor(() => viaRollout.latest().activity.length > 0, "observe Exec first");
  viaRollout.controller.acceptFailure({ backend: "codex", reason: "input-malformed" });
  await viaRollout.append(itemCompleted(ROOT_THREAD, TURN_1, { type: "FileChange", id: "item-edit" }));
  await waitFor(() => viaRollout.latest().activity.length > 0, "the persisted tool item recovers first");

  const viaHook = await createHarness();
  await beginTurn(viaHook);
  await viaHook.append(commandItem(TURN_1));
  await waitFor(() => viaHook.latest().activity.length > 0, "observe Exec first");
  viaHook.controller.acceptFailure({ backend: "codex", reason: "input-malformed" });
  viaHook.hook("PostToolUse", { turn_id: TURN_1, tool_name: "apply_patch" });

  assert.deepEqual(viaHook.latest().activity, viaRollout.latest().activity, "one canonical activity representation");
  assert.deepEqual(viaRollout.latest().activity, ["Exec", "Edit"]);
  viaRollout.controller.dispose();
  viaHook.controller.dispose();
});

test("a tool hook for a tombstoned turn does not restore withheld activity", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await h.append(commandItem(TURN_1));
  await waitFor(() => h.latest().activity.length > 0, "observe Exec first");
  await h.append(taskComplete(TURN_1));
  await waitFor(() => h.ready().length > 0, "the turn closes and is tombstoned");

  h.controller.acceptFailure({ backend: "codex", reason: "input-malformed" });
  assert.deepEqual(h.latest().activity, [], "the gap withdraws the observed label");

  h.hook("PreToolUse", { turn_id: TURN_1, tool_name: "Bash" });
  h.hook("PostToolUse", { turn_id: TURN_1, tool_name: "apply_patch" });
  await settle();
  assert.deepEqual(h.latest().activity, [], "a finished turn's late tool hook is not fresh activity");
  assert.equal(h.latest().busy, null);
  h.controller.dispose();
});

test("legacy tool witnesses contribute activity, and an unusable scope is a gap", async () => {
  // `noteLegacyTool` tolerates the empty turn id older records default to, so a
  // scope-free legacy tool still contributes its label; only an unusable scope is
  // a defect. Both halves are pinned here.
  const contributing = await createHarness();
  await beginTurn(contributing);
  await contributing.append(rolloutLine({ type: "patch_apply_end", turn_id: "", applied: 1 }));
  await waitFor(() => contributing.latest().activity.at(-1) === "Edit", "a legacy tool witness contributes");
  assert.deepEqual(contributing.gaps, [], "an empty legacy turn id is not a defect");
  contributing.controller.dispose();

  const defective = await createHarness();
  await beginTurn(defective);
  const held = defective.snapshots.length;
  await defective.append(rolloutLine({ type: "mcp_tool_call_end", turn_id: 42 }));
  await settle();
  assert.deepEqual(defective.gaps, ["malformed"], "a non-string legacy turn id is a malformed candidate");
  assert.equal(defective.latest().busy, null);
  assert.equal(defective.snapshots.length, held + 1, "the withdrawal is the only publication");
  defective.controller.dispose();
});

test("a terminal begun before binding remains pre-bind history", async () => {
  // Built in file order on purpose: the fixture counter follows construction order,
  // and these three records must stay contiguous so the window is judged on its
  // history boundary rather than on an ordinal discontinuity.
  const head = sessionMeta(ROOT_THREAD);
  const start = taskStarted(TURN_1);
  const terminal = taskComplete(TURN_1);
  // Exactly one byte of the terminal exists when the hook binds and captures the
  // floor; the rest arrives afterwards. The record STARTED below the floor, so it
  // is history — completed history that must not grant Ready.
  const h = await createHarness({ seed: head + start + terminal.slice(0, 1) });
  h.bind();
  appendFileSync(h.transcript, terminal.slice(1), "utf8");
  h.change();

  await settle();
  assert.deepEqual(h.ready(), [], "a record that began below the floor is not fresh evidence");
  assert.equal(h.latest().busy, null, "completed pre-bind history is not a live turn either");
  assert.deepEqual(h.gaps, [], "history that cannot decide is unknown, not a reported failure");
  h.controller.dispose();
});

test("a pre-bind partial terminal remains history across separate reads", async () => {
  // The other timing: here the first read FINISHES while the terminal is still
  // partial, so the bind floor sits inside an unfinished historical record. Seeding
  // from the `task_started` and consuming the floor at that point would let the next
  // steady read treat that same historical terminal as fresh evidence and grant
  // Ready. Seeding waits for the record to complete.
  const head = sessionMeta(ROOT_THREAD);
  const start = taskStarted(TURN_1);
  const terminal = taskComplete(TURN_1);
  const h = await createHarness({ seed: head + start + terminal.slice(0, 1) });
  h.bind();
  await settle();
  await h.append(terminal.slice(1));
  await settle();

  assert.deepEqual(h.ready(), [], "a historical terminal cannot become fresh across two reads");
  assert.equal(h.latest().busy, null, "seeding waits, so no turn is claimed from it either");
  assert.deepEqual(h.gaps, [], "waiting for an append is not a source failure");
  h.controller.dispose();
});

test("running comes from a persisted root task_started, with no second conversation", async () => {
  const h = await createHarness();
  await beginTurn(h);

  const running = h.latest();
  assert.equal(running.busy, true);
  assert.deepEqual(running.activity, []);
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();
});

test("Ready comes only from the durable root task_complete for the held turn", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await h.append(taskComplete(TURN_1));

  await waitFor(() => h.ready().length > 0, "the durable root terminal should confirm Ready");
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();
});

test("turn_aborted for the held turn is a durable terminal too", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await h.append(turnAborted(TURN_1));

  await waitFor(() => h.ready().length > 0, "turn_aborted should confirm the turn ended");
  h.controller.dispose();
});

test("a terminal for a turn this row never saw start never grants Ready", async () => {
  const h = await createHarness();
  h.bind();
  await h.append(taskComplete(TURN_2));

  await settle();
  assert.deepEqual(h.ready(), [], "an un-started terminal is not proof this row went idle");
  assert.equal(h.latest().busy, null);
  h.controller.dispose();
});

test("a descendant terminal in the same file never closes the root turn", async () => {
  const h = await createHarness();
  await beginTurn(h);
  // A nested (sub-agent) turn: `root_turn_id` differs from its own `turn_id`.
  await h.append(taskComplete(TURN_2, { root_turn_id: TURN_1 }));
  await h.append(turnAborted(TURN_2, { root_turn_id: TURN_1 }));

  await settle();
  assert.deepEqual(h.ready(), [], "a descendant terminal is never the root row's terminal");
  assert.equal(h.latest().busy, true);

  await h.append(taskComplete(TURN_1));
  await waitFor(() => h.ready().length > 0, "the root's own terminal still closes the turn");
  h.controller.dispose();
});

test("a replayed terminal cannot restore Ready once the attestation was withdrawn", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await h.append(taskComplete(TURN_1));
  await waitFor(() => h.ready().length > 0, "the first attested terminal should close the turn");

  // A gap means a newer turn may be hiding, so the held attestation is withdrawn.
  h.controller.acceptFailure({ backend: "codex", reason: "input-malformed" });
  assert.equal(h.latest().busy, null);

  await h.append(taskComplete(TURN_1, { last_agent_message: "replay" }));
  await settle();
  assert.equal(h.ready().length, 1, "a replay of a consumed terminal is not fresh evidence");
  assert.equal(h.latest().busy, null);
  h.controller.dispose();
});

test("a newer root start takes over a held turn that never reached a durable terminal", async () => {
  const h = await createHarness();
  await beginTurn(h, TURN_1);
  // Turn A never got its terminal (a crash, or an abort the provider did not
  // record). B's start is read FORWARD in the current ordered stream with
  // contiguous ordinals, so B is what is running now — and its own terminal must
  // be able to close it without any extra record reacquiring B.
  await h.append(taskStarted(TURN_2));
  await waitFor(() => h.latest()?.busy === true, "the newer root turn should be running");
  await h.append(taskComplete(TURN_2));
  await waitFor(() => h.ready().length > 0, "the newer turn's own terminal should grant Ready");
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();
});

test("recovery after a source gap needs only a fresh start and its own terminal", async () => {
  const h = await createHarness();
  await beginTurn(h, TURN_1);
  // The gap withdraws the held attestation and the ordinal floor.
  h.controller.acceptFailure({ backend: "codex", reason: "input-malformed" });
  assert.equal(h.latest().busy, null);

  // No tool record and no second terminal are needed: the fresh ordered start
  // re-attests the current turn, and its durable terminal closes it.
  await h.append(taskStarted(TURN_2));
  await waitFor(() => h.running().length > 1, "the fresh root start should be running again");
  await h.append(taskComplete(TURN_2));
  await waitFor(() => h.ready().length > 0, "the fresh terminal should grant Ready");
  h.controller.dispose();
});

test("a Legacy history whose records carry no ordinal still decides normally", async () => {
  // `RolloutOrdinalState::Legacy` persists no ordinal at all, so continuity cannot
  // be judged and must NOT be invented: the row still runs and closes on the same
  // ordered root records, and reports no history gap.
  const legacy = (payload: Record<string, unknown>): string =>
    `${JSON.stringify({ timestamp: "2026-01-02T03:04:05.000Z", type: "event_msg", payload })}\n`;
  const h = await createHarness({
    seed: `${JSON.stringify({
      timestamp: "2026-01-02T03:04:05.000Z",
      type: "session_meta",
      payload: { session_id: LINEAGE, id: ROOT_THREAD },
    })}\n${legacy({ type: "task_started", turn_id: TURN_1, root_turn_id: TURN_1 })}`,
  });
  h.bind();

  await waitFor(() => h.running().length > 0, "an un-ordinated root start still seeds running");
  await h.append(legacy({ type: "item_completed", thread_id: ROOT_THREAD, turn_id: TURN_1, completed_at_ms: 1, item: { type: "CommandExecution", id: "i", command: ["ls"], cwd: "/x", parsed_cmd: [], source: "agent", status: "completed", aggregated_output: "ok" } }));
  await waitFor(() => h.latest().activity.length > 0, "an un-ordinated item still carries its type");
  await h.append(legacy({ type: "task_complete", turn_id: TURN_1, root_turn_id: TURN_1 }));
  await waitFor(() => h.ready().length > 0, "an un-ordinated terminal still closes the turn");
  assert.deepEqual(h.gaps, [], "absent ordinals are a mode, not a discontinuity");
  h.controller.dispose();
});

test("a start that arrives out of ordinal order is a history gap, not a takeover", async () => {
  const h = await createHarness();
  await beginTurn(h, TURN_1);
  const held = h.snapshots.length;
  // A replay, an eviction, or a second writer: the bytes are contiguous but the
  // provider's own ordinals are not, so records this row never read sit between.
  await h.append(rawRollout(9_999, {
    type: "task_started",
    turn_id: TURN_2,
    root_turn_id: TURN_2,
    started_at: 1,
  }));
  await settle();
  assert.deepEqual(h.gaps, ["history-gap"]);
  assert.equal(h.latest().busy, null, "a discontinuous window proves an incomplete view");

  await h.append(taskComplete(TURN_2));
  await settle();
  assert.deepEqual(h.ready(), [], "no terminal may be vouched for across a history gap");
  assert.equal(h.snapshots.length, held + 1, "the withdrawal is the only publication");
  h.controller.dispose();
});

test("a syntactically valid status record with no usable scope rejects the whole window", async () => {
  const h = await createHarness();
  await beginTurn(h);
  const held = h.snapshots.length;
  // Valid JSON, a recognized status type, and no `turn_id`: the scope this record
  // is about is unknowable, so it cannot be skipped past either.
  await h.append(scopelessTerminal());
  await settle();
  assert.deepEqual(h.gaps, ["malformed"]);
  assert.equal(h.latest().busy, null);

  // A later, well-formed terminal for the held turn must NOT decide anyway: the
  // window it arrived in proved the view incomplete.
  await h.append(taskComplete(TURN_1));
  await settle();
  assert.deepEqual(h.ready(), [], "a witness after malformed scope proves nothing");
  assert.equal(h.snapshots.length, held + 1, "malformed scope withdraws once, not repeatedly");
  h.controller.dispose();
});

test("malformed status scope in the first window is a gap, not a seed", async () => {
  const h = await createHarness({ seed: scopelessTerminal() });
  h.bind();
  await settle();
  assert.deepEqual(h.gaps, ["malformed"]);
  assert.deepEqual(h.ready(), [], "a window that cannot be classified cannot decide");
  assert.equal(h.latest().busy, null);
  h.controller.dispose();
});

test("tool activity carries the TYPE only, for every pinned item kind", async () => {
  const h = await createHarness();
  await beginTurn(h);
  const cases: Array<[string, string]> = [
    ["CommandExecution", "Exec"],
    ["FileChange", "Edit"],
    ["McpToolCall", "MCP tool"],
    ["FunctionCallOutput", "Tool"],
    ["WebSearch", "Web search"],
    ["ImageView", "Image view"],
  ];
  for (const [itemType, label] of cases) {
    await h.append(itemCompleted(ROOT_THREAD, TURN_1, { type: itemType, id: `item-${itemType}`, text: SECRET_TOOL_INPUT }));
    await waitFor(() => h.latest().activity.at(-1) === label, `${itemType} should show as ${label}`);
  }
  // A text/lifecycle item is not tool activity and adds no line.
  const before = h.latest().activity.length;
  await h.append(itemCompleted(ROOT_THREAD, TURN_1, { type: "AgentMessage", id: "item-msg", text: SECRET_ANSWER }));
  await settle();
  assert.equal(h.latest().activity.length, before);
  h.controller.dispose();
});

test("turn_context and response_item records carry no foreground authority", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await h.append(turnContext(TURN_2) + responseItem(SECRET_REASONING));

  await settle();
  assert.deepEqual(h.ready(), [], "settings and history records never end a turn");
  assert.equal(h.latest().busy, true);
  assert.deepEqual(h.latest().activity, []);
  h.controller.dispose();
});

test("the initial bind seeds an in-flight turn the provider persisted before the hook", async () => {
  // Source order: `RegularTask::run` emits `task_started` inline, and the pending
  // SessionStart hooks run later inside `run_turn`, so the current turn's start is
  // already persisted when this run's own SessionStart arrives.
  const h = await createHarness({ seed: sessionMeta(ROOT_THREAD) + taskStarted(TURN_1) });
  h.bind();

  await waitFor(() => h.running().length > 0, "the newest unterminated root start should seed running");
  await h.append(taskComplete(TURN_1));
  await waitFor(() => h.ready().length > 0, "the seeded turn is the current turn, so it can close");
  h.controller.dispose();
});

test("a completion appended while the first read is in flight is fresh, not history", async () => {
  // The provider persisted the current turn's start before its SessionStart hooks
  // ran. The hook binds the scope and captures the floor synchronously; this append
  // lands AFTER that floor but BEFORE the first bounded read has even opened the
  // file, so the whole turn appears in one window. The floor is what separates the
  // pre-hook start from the post-hook completion — discarding both as history
  // would leave the row unknown forever.
  const h = await createHarness({ seed: sessionMeta(ROOT_THREAD) + taskStarted(TURN_1) });
  h.bind();
  appendFileSync(h.transcript, taskComplete(TURN_1), "utf8");

  await waitFor(() => h.ready().length > 0, "a completion above the bind floor must close the turn");
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();
});

test("the initial bind never adopts completed history as Ready", async () => {
  const h = await createHarness({
    seed: sessionMeta(ROOT_THREAD) + taskStarted(TURN_1) + taskComplete(TURN_1) + commandItem(TURN_1),
  });
  h.bind();

  await settle();
  assert.deepEqual(h.ready(), [], "completed pre-bind history is never this row's Ready");
  assert.deepEqual(h.running(), [], "a completed pre-bind turn is not a live turn either");
  assert.equal(h.latest().busy, null);
  assert.deepEqual(h.latest().activity, [], "pre-bind tool history is not replayed as activity");
  assert.deepEqual(h.gaps, [], "history that cannot decide is unknown, not a reported failure");

  // Fresh owned evidence is what establishes this row's foreground again.
  await h.append(taskStarted(TURN_2));
  await waitFor(() => h.running().length > 0, "a fresh root start is current evidence");
  h.controller.dispose();
});

test("a brand-new rollout with no records stays unknown until the first record", async () => {
  const h = await createHarness();
  h.bind();
  await settle();
  assert.deepEqual(h.snapshots.filter((s) => s.busy !== null), []);

  await h.append(sessionMeta(ROOT_THREAD) + taskStarted(TURN_1));
  await waitFor(() => h.running().length > 0, "the first persisted root start is evidence");
  h.controller.dispose();
});

test("clear, resume, and fork rebind the scope and the private source generation", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await h.append(taskComplete(TURN_1));
  await waitFor(() => h.ready().length > 0, "Ready should land before the rebind");

  for (const source of ["clear", "resume", "fork"]) {
    const forked = path.join(h.dir, `rollout-2026-01-02T03-04-06-${OTHER_THREAD}.jsonl`);
    await fs.writeFile(forked, "", "utf8");
    h.controller.acceptHook({
      backend: "codex",
      hook_event_name: "SessionStart",
      session_id: LINEAGE,
      transcript_path: forked,
      source,
    } as NativeHookEvent);
    const after = h.latest();
    assert.equal(after.busy, null, `${source} must not inherit ${source === "clear" ? "Ready" : "any claim"}`);
    assert.deepEqual(after.activity, []);

    // The new file's own records drive the row; the old rollout's do not.
    await fs.appendFile(forked, taskStarted(TURN_2), "utf8");
    h.change();
    await waitFor(() => h.latest().busy === true, `${source} should follow the newly bound rollout`);

    await fs.appendFile(h.transcript, taskComplete(TURN_2), "utf8");
    h.change();
    await settle();
    assert.equal(h.latest().busy, true, "the unbound rollout can no longer close the new scope");
  }
  h.controller.dispose();
});

test("compaction is not a new thread, a new turn, or Ready", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await h.append(commandItem(TURN_1));
  await waitFor(() => h.latest().activity.at(-1) === "Exec", "the tool line should be present");

  h.hook("SessionStart", { source: "compact" });
  const after = h.latest();
  assert.equal(after.busy, true, "compaction keeps the live turn");
  assert.deepEqual(after.activity, ["Exec"]);
  assert.deepEqual(h.ready(), [], "compaction never claims Ready");

  // And the same turn can still close normally afterwards.
  await h.append(taskComplete(TURN_1));
  await waitFor(() => h.ready().length > 0, "the turn still closes after a compaction");
  h.controller.dispose();
});

test("a descendant event never binds or replaces the root transcript", async () => {
  const h = await createHarness();
  await beginTurn(h);
  const childPath = path.join(h.dir, `rollout-2026-01-02T03-04-07-${OTHER_THREAD}.jsonl`);
  await fs.writeFile(childPath, sessionMeta(OTHER_THREAD) + taskComplete(TURN_1), "utf8");

  // Root and descendant share the lineage id, and `SubagentStop` can name the
  // PARENT's transcript, so `agent_id` alone decides: this event is not root.
  h.controller.acceptHook({
    backend: "codex",
    hook_event_name: "SubagentStop",
    session_id: LINEAGE,
    agent_id: "agent-9",
    transcript_path: childPath,
  } as NativeHookEvent);
  await settle();
  assert.deepEqual(h.ready(), [], "a descendant terminal never closes the root turn");

  await fs.appendFile(childPath, taskStarted(TURN_2), "utf8");
  await settle();
  assert.equal(h.latest().busy, true, "the root binding is unchanged and still its own");
  h.controller.dispose();
});

test("an event naming another native conversation publishes nothing", async () => {
  const h = await createHarness();
  await beginTurn(h);
  const before = h.snapshots.length;
  h.hook("PreToolUse", { session_id: FOREIGN_LINEAGE, turn_id: TURN_2, tool_name: "Bash" });
  assert.equal(h.snapshots.length, before, "a foreign conversation publishes nothing here");
  assert.equal(h.latest().busy, true, "this run's own claim is untouched");

  // This run's own lane failure is still a real gap for this run.
  h.controller.acceptFailure({ backend: "codex", reason: "input-timeout" });
  assert.ok(h.gaps.includes("hook-failure"));
  assert.equal(h.latest().busy, null);
  h.controller.dispose();
});

test("a malformed record after a terminal withdraws instead of publishing Ready", async () => {
  const h = await createHarness();
  h.bind();
  await waitFor(() => h.snapshots.length > 0, "the bind publishes a snapshot");
  // One batch: the start and terminal are followed by a row that is not a record.
  await fs.appendFile(h.transcript, taskStarted(TURN_1) + taskComplete(TURN_1) + "{not json\n", "utf8");
  h.change();

  await waitFor(() => h.gaps.includes("malformed"), "the batch must be reported as malformed");
  assert.deepEqual(h.ready(), [], "a later malformed row invalidates the earlier witness");
  assert.equal(h.latest().busy, null);
  h.controller.dispose();
});

test("an oversized record collapses the supported values to unknown", async () => {
  const h = await createHarness({ maxLineBytes: 512 });
  await beginTurn(h);
  const padding = "x".repeat(4096);
  await h.append(`${JSON.stringify({ timestamp: "t", ordinal: nextOrdinal(), type: "event_msg", payload: { type: "token_count", padding } })}\n`);

  await waitFor(() => h.gaps.includes("oversized"), "an over-bound record must be reported");
  assert.equal(h.latest().busy, null, "a supported value is unknown after a bound, never held or zero");
  h.controller.dispose();
});

test("a source loss withdraws observed activity, and only fresh activity restores it", async () => {
  /** A fresh tool record that continues the surviving stream's own numbering. */
  const continuingItem = async (h: Harness): Promise<void> => {
    const kept = await fs.readFile(h.transcript, "utf8");
    const surviving = JSON.parse(kept.trim().split("\n").at(-1) ?? "{}") as { ordinal?: number };
    await h.append(rawRollout((surviving.ordinal ?? 0) + 1, {
      type: "item_completed",
      thread_id: ROOT_THREAD,
      turn_id: TURN_1,
      completed_at_ms: 1,
      item: { type: "CommandExecution", id: "item-exec-2", command: ["ls"], cwd: "/x", parsed_cmd: [], source: "agent", status: "completed", aggregated_output: "ok" },
    }));
  };
  const losses: Array<readonly [string, (h: Harness) => void | Promise<void>, (h: Harness) => Promise<void>]> = [
    [
      "hook failure",
      (h) => h.controller.acceptFailure({ backend: "codex", reason: "input-malformed" }),
      async (h) => { await h.append(commandItem(TURN_1)); },
    ],
    [
      "malformed record",
      async (h) => { await h.append("{not json\n"); },
      async (h) => { await h.append(commandItem(TURN_1)); },
    ],
    [
      "replacement",
      async (h) => {
        await fs.writeFile(h.transcript, sessionMeta(ROOT_THREAD) + taskStarted(TURN_1), "utf8");
        h.change();
      },
      async (h) => { await h.append(commandItem(TURN_1)); },
    ],
    [
      // A truncation removes a record the provider already numbered, so the
      // surviving numbering proves a hole: the row stays unknown until a record
      // that continues the surviving stream arrives.
      "truncation",
      async (h) => {
        const content = await fs.readFile(h.transcript, "utf8");
        await fs.truncate(h.transcript, content.indexOf("\n") + 1);
        h.change();
      },
      continuingItem,
    ],
  ];
  for (const [name, cause, restore] of losses) {
    const h = await createHarness();
    await beginTurn(h);
    await h.append(commandItem(TURN_1));
    await waitFor(() => h.latest().activity.length > 0, `${name}: activity should be observed first`);

    await cause(h);
    await settle();
    assert.deepEqual(
      h.latest().activity,
      [],
      `${name}: a supported category the source cannot vouch for is unknown, not stale`,
    );

    // The loss degrades the view; it does not retire the scope. Fresh valid evidence
    // is what makes activity observable again.
    await restore(h);
    await waitFor(() => h.latest().activity.length > 0, `${name}: fresh activity must restore it`);
    h.controller.dispose();
  }

  // A watcher error is the same withdrawal: published state with nothing monitoring
  // it is not a defensible observation.
  const thrown: NativeCodexWatchHandlers[] = [];
  const failing = await createHarness({
    watchFile: (_watchedPath, handlers) => {
      thrown.push(handlers);
      return { close: () => undefined };
    },
  });
  await beginTurn(failing);
  await failing.append(commandItem(TURN_1));
  await waitFor(() => failing.latest().activity.length > 0, "activity should be observed first");
  thrown[0]?.onError(new Error("watch failed"));
  assert.deepEqual(failing.latest().activity, [], "a watcher error withdraws activity too");
  failing.controller.dispose();
});

test("a window that cannot cover the cursor is a gap, not a partial claim", async () => {
  // The bind's first snapshot is published synchronously, before the seeding read
  // commits a cursor; an overflow appended before that read would just be the
  // initial tail. A compact pre-bind root start that fits the 128-byte window makes
  // the seeding read publish running only AFTER it committed a steady cursor, so
  // the overflow below is a steady-state append that must skip past that cursor.
  const TURN_0 = "019a0000-0000-7000-8000-000000000000";
  const seed = `${JSON.stringify({ ordinal: nextOrdinal(), type: "event_msg", payload: { type: "task_started", turn_id: TURN_0 } })}\n`;
  assert.ok(Buffer.byteLength(seed, "utf8") <= 128, "the seed must fit the window it proves");
  const h = await createHarness({ maxTailBytes: 128, seed });
  h.bind();
  await waitFor(() => h.running().length > 0, "the seeding read committed a steady cursor");
  await h.append(taskStarted(TURN_1) + taskComplete(TURN_1) + responseItem(SECRET_REASONING) + taskStarted(TURN_2));

  await waitFor(() => h.gaps.includes("skipped-window"), "records between the cursor and the window went unread");
  assert.deepEqual(h.ready(), [], "an incomplete read cannot decide Ready");
  assert.equal(h.latest().busy, null);
  h.controller.dispose();
});

test("a partial trailing record waits for the append instead of deciding anything", async () => {
  const h = await createHarness();
  await beginTurn(h);
  // The provider is mid-append: the terminal row has no newline yet.
  const partial = `{"timestamp":"2026-01-02T03:04:05.000Z","ordinal":${nextOrdinal()},"type":"event_msg","pay`;
  await fs.appendFile(h.transcript, partial, "utf8");
  h.change();
  await settle();
  assert.deepEqual(h.ready(), [], "a partial row is not a terminal witness");
  assert.equal(h.latest().busy, true);
  assert.deepEqual(h.gaps, [], "a partial row is not a source failure");

  await fs.appendFile(h.transcript, 'load":{"type":"task_complete","turn_id":"' + TURN_1 + '","root_turn_id":"' + TURN_1 + '"}}\n', "utf8");
  h.change();
  await waitFor(() => h.ready().length > 0, "the completed row closes the turn");
  h.controller.dispose();
});

test("replacement of the bound file withdraws every derived value", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await h.append(taskComplete(TURN_1));
  await waitFor(() => h.ready().length > 0, "Ready should land");

  const staging = path.join(h.dir, "staging.jsonl");
  await fs.writeFile(staging, sessionMeta(ROOT_THREAD) + taskStarted(TURN_2), "utf8");
  await fs.rename(staging, h.transcript);
  h.change();

  await waitFor(() => h.gaps.includes("replaced"), "a swapped inode must be reported");
  assert.equal(h.latest().busy, null, "a replacement never keeps the old Ready");
  h.controller.dispose();
});

test("truncation of the bound file is a source failure, not idle", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await fs.truncate(h.transcript, 0);
  h.change();

  await waitFor(() => h.gaps.includes("truncated"), "a shrink must be reported");
  assert.equal(h.latest().busy, null);
  assert.deepEqual(h.ready(), []);
  h.controller.dispose();
});

test("a missing bound file is reported as unavailable and never as zero work", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await fs.rm(h.transcript);
  h.change();

  await waitFor(() => h.gaps.includes("unavailable"), "a vanished rollout must be reported");
  assert.equal(h.latest().busy, null);
  h.controller.dispose();
});

test("a watcher that cannot be created or that errors withdraws published state", async () => {
  const unavailable = await createHarness({ watchFile: () => { throw new Error("cannot watch"); } });
  unavailable.bind();
  await settle();
  assert.ok(unavailable.gaps.includes("watch-unavailable"), "no monitor means no positive claim");
  assert.equal(unavailable.latest().busy, null);
  unavailable.controller.dispose();

  const thrown: NativeCodexWatchHandlers[] = [];
  const failing = await createHarness({
    watchFile: (_watchedPath, handlers) => {
      thrown.push(handlers);
      return { close: () => undefined };
    },
  });
  await beginTurn(failing);
  assert.equal(failing.latest().busy, true);
  assert.equal(thrown.length, 1, "the seam supplied its handlers");
  thrown[0]?.onError(new Error("watch failed"));
  assert.ok(failing.gaps.includes("watch-error"));
  assert.equal(failing.latest().busy, null);
  failing.controller.dispose();
});

test("the bound thread is corroborated by the file's own session_meta", async () => {
  // A non-canonical basename yields no thread identity, so the `session_meta`
  // record read from the same file supplies it.
  const h = await createHarness({ transcriptName: "rollout-imported.jsonl", seed: sessionMeta(ROOT_THREAD) });
  h.bind();
  await h.append(taskStarted(TURN_1));
  await waitFor(() => h.running().length > 0, "the owned rollout still drives the row");

  // A persisted item naming a different thread is not this thread's activity.
  await h.append(itemCompleted(OTHER_THREAD, TURN_1, { type: "CommandExecution", id: "elsewhere" }));
  await settle();
  assert.deepEqual(h.latest().activity, [], "another thread's item is not this row's tool");

  await h.append(commandItem(TURN_1, ROOT_THREAD));
  await waitFor(() => h.latest().activity.at(-1) === "Exec", "this thread's item still shows");
  h.controller.dispose();
});

test("a session_meta that contradicts the rollout name is a source failure", async () => {
  const h = await createHarness({ seed: sessionMeta(OTHER_THREAD) });
  h.bind();
  await waitFor(() => h.gaps.includes("thread-identity-conflict"), "the two thread ids must agree");
  assert.equal(h.latest().busy, null);
  h.controller.dispose();
});

test("a rebind while a read is in flight fences the older read", async () => {
  const first = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "prg-native-codex-acq-a-")).then((dir) => { dirs.push(dir); return dir; }),
    `rollout-2026-01-02T03-04-05-${ROOT_THREAD}.jsonl`,
  );
  await fs.writeFile(first, sessionMeta(ROOT_THREAD) + taskStarted(TURN_1), "utf8");
  const h = await createHarness();
  // Two binds in the same tick: the first read is still outstanding when the
  // second rebinds, so nothing the first read returns may be published.
  h.controller.acceptHook({
    backend: "codex",
    hook_event_name: "SessionStart",
    session_id: LINEAGE,
    transcript_path: first,
    source: "startup",
  } as NativeHookEvent);
  h.bind();
  await settle();

  assert.equal(h.latest().busy, null, "the fenced read must not publish the older scope's turn");
  await fs.appendFile(first, taskComplete(TURN_1), "utf8");
  h.change();
  await settle();
  assert.deepEqual(h.ready(), [], "a read of an unbound file decides nothing");
  h.controller.dispose();
});

test("invalidate withdraws everything and a later callback cannot restore it", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await h.append(taskComplete(TURN_1));
  await waitFor(() => h.ready().length > 0, "Ready should land");

  h.controller.invalidate();
  assert.equal(h.latest().busy, null);

  await h.append(taskComplete(TURN_1, { last_agent_message: "late" }));
  h.change();
  await settle();
  assert.equal(h.ready().length, 1, "a retired generation restores nothing");
  h.controller.dispose();
});

test("dispose closes the watcher, stops later work, and deletes no provider history", async () => {
  const h = await createHarness();
  await beginTurn(h);
  const before = h.snapshots.length;
  h.controller.dispose();
  h.controller.dispose();

  await h.append(taskComplete(TURN_1));
  h.hook("SessionStart", { source: "clear" });
  await settle();
  assert.deepEqual(h.ready(), []);
  assert.equal(h.snapshots.length, before, "a disposed controller emits nothing");
  // Disposal touches no provider file: the rollout is still there for its owner.
  assert.ok((await fs.stat(h.transcript)).size > 0);
  h.controller.dispose();
});

test("the declared matrix keeps input, tasks, and shells not-applicable, never zero", async () => {
  const h = await createHarness();
  await beginTurn(h);
  await h.append(commandItem(TURN_1) + taskComplete(TURN_1));
  await waitFor(() => h.ready().length > 0, "Ready should land");

  for (const snapshot of h.snapshots) {
    assert.deepEqual(snapshot.support, NATIVE_CODEX_ACQUISITION_SUPPORT);
    assert.equal(snapshot.pendingInput, null, "pending input is never asserted on this route");
    assert.equal(snapshot.activeTasks, null, "a native task count is never fabricated");
    assert.equal(snapshot.activeShells, null, "a native shell count is never fabricated");
  }
  const observation: NativeStatusObservation = h.latest();
  assert.deepEqual(
    Object.keys(h.latest()).sort(),
    ["activeShells", "activeTasks", "activity", "busy", "pendingInput", "support"],
  );
  for (const forbidden of ["backgroundTasks", "backgroundShells", "inputSurface", "nativeSession"]) {
    assert.ok(!(forbidden in h.latest()), `${forbidden} must never appear on a native observation`);
  }
  assert.equal(observation.busy, false);
  h.controller.dispose();
});

test("no prompt, answer, command, path, or reasoning text crosses the boundary", async () => {
  const h = await createHarness({ seed: sessionMeta(ROOT_THREAD) });
  h.bind();
  await h.append(taskStarted(TURN_1, { turn_attribution: { prompt: SECRET_PROMPT } }));
  await waitFor(() => h.running().length > 0, "the persisted root start should be running");
  await h.append(commandItem(TURN_1) + functionCallItem(TURN_1) + responseItem(SECRET_REASONING));
  await waitFor(() => h.latest().activity.at(-1) === "Tool", "both persisted tool types should show");
  await h.append(taskComplete(TURN_1));
  await waitFor(() => h.ready().length > 0, "the turn should still close");

  const leaked = JSON.stringify({ snapshots: h.snapshots, gaps: h.gaps });
  for (const secret of [
    SECRET_PROMPT, SECRET_ANSWER, SECRET_COMMAND, SECRET_CWD, SECRET_TOOL_INPUT, SECRET_REASONING,
    h.transcript, ROOT_THREAD, TURN_1, TURN_2, LINEAGE,
  ]) {
    assert.ok(!leaked.includes(secret), `the observation surface leaked ${secret}`);
  }
  assert.deepEqual(h.latest().activity, ["Exec", "Tool"]);
  h.controller.dispose();
});

test("the default watcher picks up appends without any hook event", async () => {
  const h = await createHarness({ useRealWatch: true });
  h.bind();
  await waitFor(() => h.snapshots.length > 0, "the bind publishes a snapshot");
  const afterBind = h.snapshots.length;

  await fs.appendFile(h.transcript, taskStarted(TURN_1), "utf8");
  await waitFor(() => h.latest().busy === true, "the one file watch wakes the read on its own");
  assert.ok(h.snapshots.length > afterBind);
  await fs.appendFile(h.transcript, taskComplete(TURN_1), "utf8");
  await waitFor(() => h.ready().length > 0, "the watch still delivers the terminal row");
  h.controller.dispose();
});

test("a SessionStart with no transcript path is reported as an unbound source", async () => {
  const h = await createHarness();
  h.controller.acceptHook({
    backend: "codex",
    hook_event_name: "SessionStart",
    session_id: LINEAGE,
    transcript_path: null as unknown as string,
    source: "startup",
  } as NativeHookEvent);
  await settle();

  assert.ok(h.gaps.includes("unbound-transcript"), "nothing can be observed without a bound path");
  assert.equal(h.latest().busy, null);
  assert.deepEqual(h.snapshots.filter((s) => s.busy !== null), []);

  // A lost hook in that unbound scope withholds activity, and a pathless tool hook
  // cannot vouch for it again: no rollout is bound to corroborate anything.
  const pathless = (name: string, extra: Record<string, unknown>): void => h.controller.acceptHook({
    backend: "codex",
    hook_event_name: name as NativeHookEvent["hook_event_name"],
    session_id: LINEAGE,
    ...extra,
  } as NativeHookEvent);
  pathless("PreToolUse", { turn_id: TURN_1, tool_name: "Bash" });
  h.controller.acceptFailure({ backend: "codex", reason: "input-malformed" });
  assert.deepEqual(h.latest().activity, [], "the gap withholds activity");
  pathless("PreToolUse", { turn_id: TURN_1, tool_name: "Bash" });
  pathless("PostToolUse", { turn_id: TURN_1, tool_name: "apply_patch" });
  await settle();
  assert.deepEqual(h.latest().activity, [], "a pathless tool hook in an unbound scope restores nothing");
  h.controller.dispose();
});

test("events for another backend are ignored without effect", async () => {
  const h = await createHarness();
  await beginTurn(h);
  const before = h.snapshots.length;
  h.controller.acceptHook({
    backend: "claude",
    hook_event_name: "SessionStart",
    session_id: LINEAGE,
    transcript_path: path.join(h.dir, "claude-transcript.jsonl"),
  } as NativeHookEvent);
  h.controller.acceptFailure({ backend: "claude", reason: "input-malformed" });
  assert.equal(h.snapshots.length, before);
  assert.deepEqual(h.gaps, []);

  await h.append(taskComplete(TURN_1));
  await waitFor(() => h.ready().length > 0, "this run's own terminal still closes the turn");
  h.controller.dispose();
});
