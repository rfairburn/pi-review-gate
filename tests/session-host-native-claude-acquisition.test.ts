/**
 * Focused tests for the owned-run Claude native completion + count acquisition
 * controller.
 *
 * Every transcript here is a synthetic JSONL file this test wrote in its own
 * temporary directory, in the row shapes Claude Code 2.1.325 persists. No
 * provider, model, auth, config, session store, clipboard, network, or real
 * transcript is touched, and no provider process runs.
 *
 * What the assertions pin: Ready only from a positively read ROOT terminal row
 * (never from this observer's own `Stop` hook, never from a child/labelled row,
 * never from a row that predates the read barrier); POSITION and closed row kind
 * inside one append-ordered window — the closing turn's own trailing rows (its
 * final `assistant` row, its `user` tool-result row carrying BOTH `message` and
 * `toolUseResult`) may land after the size barrier and before the summary, and a
 * sufficient summary after them still confirms Ready even when an intervening
 * read saw them first, while a root row that starts after that summary or a
 * persisted root PROMPT row still spends the pass and leaves no Ready; a
 * published `Ready` withdrawn to unknown when the monitored transcript shows a
 * NEW ROOT model row — even when no hook ever arrives for that work — while
 * sidechain, agent-scoped, foreign-session, and non-work rows never claim root
 * work; the observed-0 versus absent-unknown distinction on real ROOT `Stop`
 * snapshots, those numbers kept as last-reported state across unrelated hooks,
 * ordinary new foreground work, and a transcript this controller cannot read, and
 * the refusal to use a `SubagentStop` subset; withdrawal to unknown (never zero,
 * never a stale Ready) of the transcript-derived claims on truncation,
 * replacement, malformed or oversized records, and a window too small to cover
 * the barrier, while a genuine hook-lane loss or scope change still withdraws the
 * counts too; the refusal to reconstruct a count from activity or to read an
 * unreadable snapshot as zero; a summary this run cannot use (child, sidechain,
 * agent-scoped, or
 * labelled for another event) never sets the positional completion boundary; and
 * count-only monitoring reads the file for membership transitions without ever
 * erasing a healthy hook-derived foreground or question census; one-file-only
 * access; and that no raw transcript content ever leaves the controller. Two rows
 * the provider appends only after the fact they describe are already observed are
 * pinned too: the persisted invocation of a question request this run's own
 * `PreToolUse` accepted is the same observed work — the pause, the pending census,
 * the live counts, and the activity label all hold, while every other root row (an
 * unseen identity, a mixed row, prose, a child question's identity, or a real
 * prompt) still ends the pause — and a task-origin delivery of a member this run's
 * ledger already settled asserts no new membership change — however its opaque body
 * is marked up — while an unknown,
 * still-active, reactivated, malformed, ambiguous, or non-task-origin delivery
 * keeps its existing unattributable hole and a delivery is never an agent's fresh
 * completion.
 */

import assert from "node:assert/strict";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { afterEach } from "node:test";

import type { NativeHookEvent } from "../src/session-host/native-hook-protocol";
import { MAX_NATIVE_CLAUDE_BACKGROUND_TOMBSTONES } from "../src/session-host/native-claude-background";
import {
  NATIVE_CLAUDE_ACQUISITION_SUPPORT,
  NativeClaudeAcquisitionController,
  type NativeClaudeAcquisitionGapReason,
  type NativeClaudeAcquisitionSnapshot,
  type NativeClaudeWatchFactory,
  type NativeClaudeWatchHandlers,
} from "../src/session-host/native-claude-acquisition";
import type { NativeStatusObservation } from "../src/session-host/native-status";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const SECRET_HOOK_COMMAND = "rm -rf /secret/working-directory --hook-command";
const SECRET_STOP_REASON = "stop-reason-secret-text";
const SECRET_TASK_DESCRIPTION = "secret-background-task-description";
const SECRET_OUTPUT_FILE = "/secret/output-file-path";

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
  readonly controller: NativeClaudeAcquisitionController;
  readonly snapshots: NativeClaudeAcquisitionSnapshot[];
  readonly gaps: NativeClaudeAcquisitionGapReason[];
  hook(name: string, extra?: Record<string, unknown>): void;
  append(row: string): Promise<void>;
  latest(): NativeClaudeAcquisitionSnapshot;
  readySnapshots(): NativeClaudeAcquisitionSnapshot[];
}

async function createHarness(options: {
  seed?: string;
  /** Bind a transcript path that does not exist yet, as a fresh native run does. */
  createEmpty?: boolean;
  maxTailBytes?: number;
  maxLineBytes?: number;
  bindTranscript?: boolean;
  watchFile?: NativeClaudeWatchFactory;
} = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prg-native-claude-acq-"));
  dirs.push(dir);
  const transcript = path.join(dir, "transcript.jsonl");
  // A seeded history stands in for an older turn: prior rows exist, and prior
  // Ready is never replayed from them.
  if (options.createEmpty !== true) {
    await fs.writeFile(transcript, options.seed ?? priorHistory(), "utf8");
  }
  const snapshots: NativeClaudeAcquisitionSnapshot[] = [];
  const gaps: NativeClaudeAcquisitionGapReason[] = [];
  const controller = new NativeClaudeAcquisitionController({
    rowId: "row-1",
    backend: "claude",
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onSourceGap: (reason) => gaps.push(reason),
    ...(options.maxTailBytes === undefined ? {} : { maxTailBytes: options.maxTailBytes }),
    ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
    ...(options.watchFile === undefined ? {} : { watchFile: options.watchFile }),
  });
  const bind = options.bindTranscript !== false;
  return {
    dir,
    transcript,
    controller,
    snapshots,
    gaps,
    hook: (name, extra = {}) => controller.acceptHook({
      backend: "claude",
      hook_event_name: name as NativeHookEvent["hook_event_name"],
      session_id: SESSION,
      ...(bind ? { transcript_path: transcript } : {}),
      ...extra,
    }),
    append: (row) => fs.appendFile(transcript, row, "utf8"),
    latest: () => snapshots[snapshots.length - 1] as NativeClaudeAcquisitionSnapshot,
    // Any published `busy: false`, which in a trace with an open question also
    // includes the stopped-on-input projection — not only the idle claim. Tests
    // that need the idle claim itself check `activity` for `Ready`.
    readySnapshots: () => snapshots.filter((snapshot) => snapshot.busy === false),
  };
}

function priorHistory(): string {
  return jsonRow({ type: "user", message: { content: `older prompt ${"p".repeat(160)}` } })
    + jsonRow({ type: "assistant", message: { content: `older answer ${"a".repeat(160)}` } });
}

function jsonRow(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

function summaryRow(extra: Record<string, unknown> = {}): string {
  return jsonRow({
    type: "system",
    subtype: "stop_hook_summary",
    hookCount: 1,
    hookInfos: [{ command: SECRET_HOOK_COMMAND, durationMs: 7 }],
    hookErrors: [],
    preventedContinuation: true,
    stopReason: SECRET_STOP_REASON,
    hasOutput: true,
    level: "info",
    uuid: "summary-row-1",
    toolUseID: "tool-use-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...extra,
  });
}

function turnDurationRow(extra: Record<string, unknown> = {}): string {
  return jsonRow({
    type: "system",
    subtype: "turn_duration",
    durationMs: 812,
    messageCount: 4,
    pendingBackgroundAgentCount: 1,
    isMeta: false,
    uuid: "turn-duration-row-1",
    ...extra,
  });
}

function backgroundTasks(count: number): unknown[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `b${index}`,
    type: index % 2 === 0 ? "shell" : "subagent",
    status: "running",
    description: SECRET_TASK_DESCRIPTION,
    command: SECRET_OUTPUT_FILE,
  }));
}

// Persisted ROOT model rows, in the shapes Claude Code 2.1.325 writes for the
// root conversation. They carry the structural markers the controller is allowed
// to judge (`type`, `isSidechain`, `agentId`, `sessionId`, and the presence of a
// `message` object); their content is only there to prove nothing is read.
function rootUserRow(): string {
  return jsonRow({
    type: "user",
    sessionId: SESSION,
    isSidechain: false,
    message: { role: "user", content: `next root prompt ${"n".repeat(64)}` },
    uuid: "root-user-row-1",
    timestamp: "2026-01-01T00:01:00.000Z",
  });
}

function rootAssistantToolUseRow(): string {
  return jsonRow({
    type: "assistant",
    sessionId: SESSION,
    isSidechain: false,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu-root-new", name: "Bash", input: { command: SECRET_OUTPUT_FILE } }],
    },
    uuid: "root-assistant-tool-use-row-1",
  });
}

function rootAssistantTextRow(): string {
  return jsonRow({
    type: "assistant",
    sessionId: SESSION,
    isSidechain: false,
    message: { role: "assistant", content: [{ type: "text", text: `root answer ${"a".repeat(64)}` }] },
    uuid: "root-assistant-text-row-1",
  });
}

/**
 * The persisted tool-result row of the CLOSING turn, in the shape the provider
 * writes it: a `user` row carrying BOTH a `message` (the tool_result content) and
 * its own `toolUseResult`. It flushes after this observer's Stop barrier and
 * before the summary, so it is a finishing-turn row and not proof of a new turn.
 */
function rootUserToolResultRow(): string {
  return jsonRow({
    type: "user",
    sessionId: SESSION,
    isSidechain: false,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu-root-close", content: `root tool output ${"o".repeat(64)}` }],
    },
    toolUseResult: {
      stdout: `root tool output ${"o".repeat(64)}`,
      stderr: "",
      interrupted: false,
      isImage: false,
      returnCodeInterpretation: "Success",
    },
    toolUseID: "toolu-root-close",
    uuid: "root-user-tool-result-row-1",
    timestamp: "2026-01-01T00:01:30.000Z",
  });
}

/** A watch seam that reads only when the test says so, so batch order is exact. */
function manualWatch(received: NativeClaudeWatchHandlers[]): NativeClaudeWatchFactory {
  return (_path, handlers) => {
    received.push(handlers);
    return { close: () => {} };
  };
}

/** Drive one read through the most recently attached manual watch. */
function readNow(received: NativeClaudeWatchHandlers[]): void {
  const handlers = received.at(-1);
  assert.ok(handlers !== undefined, "a watch must have been attached to drive a read");
  handlers.onChange();
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A pause long enough that any real watcher/read would already have landed. */
async function settle(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Start one owned turn: root SessionStart then the accepted root prompt. */
async function beginTurn(h: Harness, promptId = "prompt-1"): Promise<void> {
  h.hook("SessionStart");
  h.hook("UserPromptSubmit", { prompt_id: promptId });
}

test("confirms root Ready from a persisted root summary and carries the real Stop snapshot", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 2 } });
  await h.append(summaryRow({ preventedContinuation: true }));

  await waitFor(() => h.readySnapshots().length > 0, "root summary should confirm Ready");
  const ready = h.latest();
  assert.equal(ready.busy, false);
  assert.deepEqual(ready.activity, ["Ready"]);
  assert.equal(ready.activeTasks, 1);
  assert.equal(ready.activeShells, 2);
  assert.deepEqual(ready.support, NATIVE_CLAUDE_ACQUISITION_SUPPORT);
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();
});

test("confirms Ready when continuation was not prevented and nothing blocked or continued", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop");
  await h.append(summaryRow({
    preventedContinuation: false,
    hookErrors: [],
    hookAdditionalContext: [],
  }));

  await waitFor(() => h.readySnapshots().length > 0, "sufficient summary should confirm Ready");
  h.controller.dispose();
});

test("a nonempty hookErrors summary is undecidable: never Ready, never busy, snapshot kept", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 3, shells: 0 } });
  await h.append(summaryRow({ preventedContinuation: false, hookErrors: ["hook stderr"] }));

  await settle();
  assert.deepEqual(h.readySnapshots(), []);
  const latest = h.latest();
  assert.equal(latest.busy, null);
  assert.deepEqual(latest.activity, []);
  assert.equal(latest.activeTasks, 3);
  assert.equal(latest.activeShells, 0);
  h.controller.dispose();
});

test("additional context continues the same turn, so it is not terminal", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop");
  await h.append(summaryRow({
    preventedContinuation: false,
    hookErrors: [],
    hookAdditionalContext: [{ hidden: true }],
  }));

  await settle();
  assert.deepEqual(h.readySnapshots(), []);
  assert.equal(h.latest().busy, null);
  h.controller.dispose();
});

test("a child, agent-scoped, sidechain, or non-Stop-labelled summary never closes the root turn", async () => {
  const rejections: Array<Record<string, unknown>> = [
    { hookLabel: "SubagentStop" },
    { agentId: "agent-9" },
    { isSidechain: true },
    { hookLabel: "PreToolUse" },
  ];
  for (const extra of rejections) {
    const h = await createHarness();
    await beginTurn(h);
    h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
    await h.append(summaryRow(extra));
    await settle();
    assert.deepEqual(h.readySnapshots(), [], `summary variant ${JSON.stringify(extra)} must not close root`);
    // Unclosed means unclosed: the turn this source observed running is still
    // running, and a rejected row neither completes it nor withdraws it.
    assert.equal(h.latest().busy, true);
    h.controller.dispose();
  }
});

test("a turn_duration row is never a terminal witness, because it can be deferred", async () => {
  // The source defers `turn_duration` while background work is outstanding, and
  // the row carries no prompt or turn correlation, so a duration row that appears
  // behind this barrier cannot be shown to belong to the armed turn.
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 0, shells: 0 } });
  await h.append(turnDurationRow());
  await h.append(turnDurationRow({ uuid: "turn-duration-row-2", pendingBackgroundAgentCount: 3 }));

  await settle();
  assert.deepEqual(h.readySnapshots(), [], "a deferred runner row must not close the turn");
  // With no witness the turn stays the running turn this source observed.
  assert.equal(h.latest().busy, true);
  h.controller.dispose();
});

test("a sidechain or agent-scoped turn_duration is never a witness either", async () => {
  for (const extra of [{ isSidechain: true }, { agentId: "agent-9" }]) {
    const h = await createHarness();
    await beginTurn(h);
    h.hook("Stop");
    await h.append(turnDurationRow(extra));
    await settle();
    assert.deepEqual(h.readySnapshots(), [], `turn_duration variant ${JSON.stringify(extra)} must not close root`);
    h.controller.dispose();
  }
});

test("a Stop hook by itself is a boundary this observer cannot prove final", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 2, shells: 1 } });

  await settle();
  assert.deepEqual(h.readySnapshots(), []);
  const stopped = h.latest();
  // Still never Ready from this observer's own Stop. And because the boundary
  // proves no end, it does not erase what this source positively observed: the
  // accepted turn stays running with its activity, and the snapshot numbers from
  // that same trusted edge stay exact.
  assert.equal(stopped.busy, true);
  assert.deepEqual(stopped.activity, ["Working"]);
  assert.equal(stopped.activeTasks, 2);
  assert.equal(stopped.activeShells, 1);
  h.controller.dispose();
});

test("an answered turn keeps its observed foreground and counts across an unproven Stop", async () => {
  // The shape native evidence actually showed: a real AskUserQuestion round trip
  // answered, the turn underneath running again, the census empty, one shell
  // active — then this observer's root `Stop` arrives, and the ordered terminal
  // record has not landed yet.
  const h = await createHarness();
  await beginTurn(h);
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_q", prompt_id: "prompt-1" });
  h.hook("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "toolu_q", prompt_id: "prompt-1" });
  h.hook("Stop", { background_counts: { tasks: 0, shells: 1 } });

  await settle();
  const held = h.latest();
  // Not Ready (no terminal witness yet), and not an unknown gap either: the
  // observed working projection, the answered census, and both exact counts
  // stand through the candidate boundary.
  assert.equal(held.busy, true);
  assert.notDeepEqual(held.activity, []);
  assert.equal(held.pendingInput, false);
  assert.equal(held.activeTasks, 0);
  assert.equal(held.activeShells, 1);
  // No snapshot carried the idle claim. The only `busy: false` publish in this
  // trace was the stopped-on-input projection while the request was open.
  assert.equal(h.snapshots.some((snapshot) => snapshot.activity.includes("Ready")), false);
  assert.deepEqual(h.gaps, []);

  await h.append(summaryRow({ preventedContinuation: true }));
  await waitFor(() => h.latest().activity.includes("Ready"), "the terminal record confirms Ready");
  const ready = h.latest();
  assert.equal(ready.busy, false);
  assert.deepEqual(ready.activity, ["Ready"]);
  assert.equal(ready.pendingInput, false);
  assert.equal(ready.activeTasks, 0);
  assert.equal(ready.activeShells, 1);
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();
});

test("a genuine loss while the terminal witness is awaited still withdraws what it owns", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 0, shells: 1 } });
  await settle();
  assert.equal(h.latest().busy, true);

  // A real authenticated hook-lane loss is not an unproven boundary: everything
  // that lane vouched goes unknown — never a retained running row and never zero.
  h.controller.acceptFailure({ backend: "claude", reason: "input-malformed" });
  await settle();
  const withdrawn = h.latest();
  assert.equal(withdrawn.busy, null);
  assert.equal(withdrawn.pendingInput, null);
  assert.equal(withdrawn.activeTasks, null);
  assert.equal(withdrawn.activeShells, null);
  assert.deepEqual(h.gaps, ["hook-failure"]);
  h.controller.dispose();
});

test("a stale, foreign, or child Stop has no power over a retained projection", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-2");
  h.hook("Stop", { background_counts: { tasks: 0, shells: 1 }, prompt_id: "prompt-2" });
  await settle();
  const held = h.latest();
  assert.equal(held.busy, true);
  const published = h.snapshots.length;

  // An older prompt's Stop, another session's Stop, and a child's own boundary
  // are all outside this run: they neither complete it, unknown it, nor move its
  // counts.
  h.hook("Stop", { prompt_id: "prompt-1" });
  h.hook("Stop", { session_id: OTHER_SESSION });
  h.hook("SubagentStop", {
    agent_id: "agent-1",
    background_counts: { tasks: 9, shells: 9 },
    background_tasks: [{ id: "b9", type: "shell", status: "running" }],
  });
  await settle();
  assert.deepEqual(h.latest(), held);
  assert.equal(h.snapshots.length, published);
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();
});

test("a persisted summary that predates the barrier is never a witness", async () => {
  const h = await createHarness({ seed: priorHistory() + summaryRow({ preventedContinuation: true }) });
  await beginTurn(h);
  h.hook("Stop");

  await settle();
  assert.deepEqual(h.readySnapshots(), []);
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();
});

test("a new prompt is not closed by the previous turn's summary", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { background_counts: { tasks: 1, shells: 0 } });
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "first turn should close");
  const readyCount = h.readySnapshots().length;

  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  assert.equal(h.latest().busy, true);
  assert.deepEqual(h.latest().activity, ["Working"]);
  // Ordinary new foreground work proves nothing about background membership, so
  // the last ROOT `Stop` snapshot stays published as last-reported.
  assert.equal(h.latest().activeTasks, 1);
  assert.equal(h.latest().activeShells, 0);

  h.hook("Stop", { prompt_id: "prompt-2" });
  await settle();
  assert.equal(h.readySnapshots().length, readyCount, "the older summary must not close the new turn");
  // The new turn is not closed, and "not closed" keeps its observed shape: still
  // running, never an invented Ready and never a gratuitous unknown.
  assert.equal(h.latest().busy, true);
  h.controller.dispose();
});

test("a summary whose turn was already superseded by newer observed work never closes it", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  // Newer accepted work: the prompt this run positively observed has advanced.
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  // A boundary carrying the OLD prompt correlation, and a fresh row behind it.
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 1 } });
  await h.append(summaryRow());

  await settle();
  assert.deepEqual(h.readySnapshots(), [], "a superseded prompt cannot close the newer turn");
  assert.equal(h.latest().busy, true);

  // The same file closes only for its own current prompt correlation.
  h.hook("Stop", { prompt_id: "prompt-2" });
  await h.append(summaryRow({ uuid: "summary-row-current" }));
  await waitFor(() => h.readySnapshots().length > 0, "the current prompt's boundary should close the turn");
  h.controller.dispose();
});

test("new accepted root work retires an armed read even when the Stop carried no prompt_id", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  // A newer accepted prompt, with no prompt correlation on either edge.
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  await h.append(summaryRow());

  await settle();
  assert.deepEqual(h.readySnapshots(), [], "the retired arm must not overwrite newer work");
  assert.equal(h.latest().busy, true);
  h.controller.dispose();
});

test("same-prompt continuation work retires the armed pass too", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1" });
  // Positively observed tool work for the same prompt: the pass is over.
  h.hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tool-cont", prompt_id: "prompt-1" });
  await h.append(summaryRow());

  await settle();
  assert.deepEqual(h.readySnapshots(), []);
  assert.equal(h.latest().busy, true);
  h.controller.dispose();
});

test("a record straddling the barrier is dropped without a spurious source gap", async () => {
  // The seed ends INSIDE a record, so this Stop's barrier sits mid-row: the row
  // that completes after it began before the barrier and is never a witness, and
  // it must not be mis-framed as a malformed record either.
  const seed = `${priorHistory()}{"type":"system","subtype":"stop_hook_summary","preventedContinuation":true`;
  const h = await createHarness({ seed });
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await h.append(',"hookErrors":[]}\n');

  await settle();
  assert.deepEqual(h.readySnapshots(), [], "a pre-barrier row must not close the turn");
  assert.ok(!h.gaps.includes("malformed"), `straddling row must be dropped, not mis-framed: ${h.gaps.join(",")}`);

  // The next turn's own fully-post-barrier row still closes it.
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  h.hook("Stop", { prompt_id: "prompt-2" });
  await h.append(summaryRow({ uuid: "summary-row-after" }));
  await waitFor(() => h.readySnapshots().length > 0, "a fully post-barrier row should still close the turn");
  h.controller.dispose();
});

test("a malformed row after a sufficient summary withdraws instead of publishing Ready", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  // One append: the witness and the unreadable row land in the same window.
  await h.append(`${summaryRow()}this is not json\n`);

  await waitFor(() => h.gaps.includes("malformed"), "a malformed row anywhere in the window must be reported");
  assert.deepEqual(h.readySnapshots(), [], "Ready must never be published from a window that is not fully valid");
  // The running projection came from the hook lane, so a window this controller
  // cannot parse neither completes it nor withdraws it.
  assert.equal(h.latest().busy, true);
  // The unreadable file is the transcript lane. The snapshot came from the ROOT
  // `Stop` hook payload, so it survives as last-reported instead of being nulled.
  assert.equal(h.latest().activeTasks, 1);
  assert.equal(h.latest().activeShells, 1);
  h.controller.dispose();
});

test("a transcript path change resets the source epoch and ignores the old file", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });

  const next = path.join(h.dir, "transcript-after-clear.jsonl");
  await fs.writeFile(next, priorHistory(), "utf8");
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2", transcript_path: next });
  await h.append(summaryRow());
  await settle();
  assert.deepEqual(h.readySnapshots(), [], "the retired transcript must not close anything");

  h.hook("Stop", { prompt_id: "prompt-2", transcript_path: next });
  await fs.appendFile(next, summaryRow(), "utf8");
  await waitFor(() => h.readySnapshots().length > 0, "the newly bound transcript should close the turn");
  h.controller.dispose();
});

test("a root SessionStart for a new session and path rebinds acquisition and drops the old facts", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { background_counts: { tasks: 3, shells: 3 } });
  assert.equal(h.latest().activeTasks, 3);

  const next = path.join(h.dir, "transcript-new-session.jsonl");
  await fs.writeFile(next, priorHistory(), "utf8");
  // A new owned session with no intervening SessionEnd: the reducer adopts it, so
  // acquisition must rebind with it rather than keep watching the old transcript.
  h.hook("SessionStart", { session_id: OTHER_SESSION, transcript_path: next });
  assert.equal(h.latest().activeTasks, null);
  assert.equal(h.latest().activeShells, null);
  assert.equal(h.latest().busy, null);

  await h.append(summaryRow());
  await settle();
  assert.deepEqual(h.readySnapshots(), [], "the retired transcript must not close anything");

  h.hook("UserPromptSubmit", { session_id: OTHER_SESSION, prompt_id: "prompt-b", transcript_path: next });
  h.hook("Stop", {
    session_id: OTHER_SESSION,
    prompt_id: "prompt-b",
    transcript_path: next,
    background_counts: { tasks: 1, shells: 0 },
  });
  await fs.appendFile(next, summaryRow(), "utf8");
  await waitFor(() => h.readySnapshots().length > 0, "the newly bound transcript must provide completion");
  assert.equal(h.latest().activeTasks, 1);
  h.controller.dispose();
});

test("a stale-prompt tool edge cannot retire the armed read", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 1 } });
  // An older prompt's tool edge: the reducer refuses it, so it changes nothing.
  h.hook("PreToolUse", { prompt_id: "prompt-older", tool_name: "Bash", tool_use_id: "tool-stale" });
  await h.append(summaryRow());

  await waitFor(() => h.readySnapshots().length > 0, "the armed read must still complete the current turn");
  h.controller.dispose();
});

test("a stale-prompt Stop cannot publish counts and a stale edge cannot rebind the transcript", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 0, shells: 0 } });
  assert.equal(h.latest().activeTasks, null);
  assert.equal(h.latest().activeShells, null);

  const elsewhere = path.join(h.dir, "elsewhere.jsonl");
  await fs.writeFile(elsewhere, priorHistory(), "utf8");
  h.hook("PostToolUse", {
    prompt_id: "prompt-1",
    tool_name: "Read",
    tool_use_id: "tool-old",
    transcript_path: elsewhere,
  });

  await h.append(summaryRow());
  await settle();
  assert.deepEqual(h.readySnapshots(), [], "no stale edge may arm or close anything");

  // The current prompt's own boundary still closes the turn on the original path.
  h.hook("Stop", { prompt_id: "prompt-2" });
  await h.append(summaryRow({ uuid: "summary-current" }));
  await waitFor(() => h.readySnapshots().length > 0, "the current turn must still be closable");
  h.controller.dispose();
});

test("a watcher that cannot be created withdraws published state instead of leaving it unmonitored", async () => {
  const h = await createHarness({ watchFile: () => { throw new Error("cannot watch"); } });
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 2, shells: 2 } });

  assert.ok(h.gaps.includes("watch-unavailable"), `expected a watch-unavailable gap: ${h.gaps.join(",")}`);
  const after = h.latest();
  // No witness can be read, so no Ready may ever be claimed here. What the hook
  // lane positively stated survives a transcript lane that cannot watch: both the
  // ROOT `Stop` snapshot and the running turn it was observing.
  assert.equal(after.busy, true);
  assert.equal(after.activeTasks, 2, "a transcript lane that cannot watch never nulls a hook-payload count");
  assert.equal(after.activeShells, 2);

  await h.append(summaryRow());
  await settle();
  assert.deepEqual(h.readySnapshots(), []);
  h.controller.dispose();
});

test("callbacks from a retired watcher cannot read or withdraw the current scope", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const relay: NativeClaudeWatchFactory = (watchPath, handlers) => {
    received.push(handlers);
    const watcher = watch(watchPath, { persistent: false }, () => handlers.onChange());
    watcher.on("error", (error) => handlers.onError(error));
    return { close: () => watcher.close() };
  };
  const h = await createHarness({ watchFile: relay });
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  assert.equal(received.length, 1);
  const retired = received[0]!;

  const next = path.join(h.dir, "transcript-next.jsonl");
  await fs.writeFile(next, priorHistory(), "utf8");
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2", transcript_path: next });
  h.hook("Stop", { prompt_id: "prompt-2", transcript_path: next });
  assert.equal(received.length, 2, "the new transcript gets its own watcher");

  const snapshotsBefore = h.snapshots.length;
  const gapsBefore = h.gaps.length;
  retired.onChange();
  retired.onError(new Error("late failure"));
  await settle();
  assert.equal(h.gaps.length, gapsBefore, "a retired watcher error must not withdraw the current scope");
  assert.equal(h.snapshots.length, snapshotsBefore, "a retired watcher callback must not publish anything");

  await fs.appendFile(next, summaryRow(), "utf8");
  await waitFor(() => h.readySnapshots().length > 0, "the current watcher must still complete the turn");
  h.controller.dispose();
});

test("invalid UTF-8 bytes in the window withdraw rather than publishing Ready", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  // Corrupt bytes inside a complete record: only a permissive decoder would turn
  // them into a parseable string. The sufficient summary lands in the same window.
  await fs.appendFile(h.transcript, Buffer.concat([
    Buffer.from('{"type":"system","text":"bad'),
    Buffer.from([0xc3, 0x28, 0xe2, 0x82]),
    Buffer.from('plain"}\n'),
    Buffer.from(summaryRow()),
  ]));

  await waitFor(() => h.gaps.includes("unreadable"), "corrupt bytes must be reported as unreadable");
  assert.deepEqual(h.readySnapshots(), [], "a window with corrupt bytes must not publish Ready");
  // Corrupt bytes say nothing about the hook-observed foreground: it stays the
  // running turn, and Ready is never inferred from the unreadable window.
  assert.equal(h.latest().busy, true);
  // A transcript this controller cannot decode says nothing about background
  // membership: the hook-payload snapshot stays as last-reported.
  assert.equal(h.latest().activeTasks, 1);
  assert.equal(h.latest().activeShells, 1);
  h.controller.dispose();
});

test("native counts keep the observed-zero and unknown distinction, and never take a child subset", async () => {
  const h = await createHarness();
  await beginTurn(h);
  assert.equal(h.latest().activeTasks, null);
  assert.equal(h.latest().activeShells, null);

  h.hook("Stop", { background_counts: { tasks: 0, shells: 0 } });
  assert.equal(h.latest().activeTasks, 0);
  assert.equal(h.latest().activeShells, 0);

  // A SubagentStop snapshot is that subagent's array, never root scope: it neither
  // replaces the root snapshot nor erases it.
  h.hook("SubagentStop", { background_counts: { tasks: 0, shells: 0 }, agent_id: "agent-9" });
  assert.equal(h.latest().activeTasks, 0);
  assert.equal(h.latest().activeShells, 0);

  // A valid root Stop that carried no snapshot is unknown, never a retained
  // number and never a fabricated zero.
  h.hook("Stop");
  assert.equal(h.latest().activeTasks, null);
  assert.equal(h.latest().activeShells, null);
  h.controller.dispose();
});

test("ordinary foreground work keeps the last snapshot; a newer snapshot replaces it", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 2, shells: 2 } });
  assert.equal(h.latest().activeShells, 2);

  // A new prompt and tool work are foreground facts. They prove nothing about
  // whether a background task or shell is still running, so the last reported
  // numbers stay published until a real transition, snapshot, or scope change.
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  h.hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tool-a", prompt_id: "prompt-2" });
  h.hook("PostToolUse", { tool_name: "Bash", tool_use_id: "tool-a", prompt_id: "prompt-2" });
  assert.equal(h.latest().busy, true);
  assert.equal(h.latest().activeTasks, 2);
  assert.equal(h.latest().activeShells, 2);

  // The next root Stop's own snapshot replaces them, including with a real 0/1.
  h.hook("Stop", { prompt_id: "prompt-2", background_counts: { tasks: 0, shells: 1 } });
  assert.equal(h.latest().activeTasks, 0);
  assert.equal(h.latest().activeShells, 1);
  h.controller.dispose();
});

test("count-only monitoring reads the file without erasing a healthy running foreground", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 2, shells: 1 } });
  assert.equal(h.latest().activeTasks, 2);

  // Ordinary new foreground work while counts stay published: running state and
  // an open question request now come from the hook lane. The tool opens AFTER
  // the request, so real root work is running and the row is never made to look
  // paused while the provider is doing something else.
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-2" });
  assert.equal(h.latest().busy, false, "a standing question request is stopped on input");
  assert.equal(h.latest().pendingInput, true);
  assert.equal(h.latest().activeTasks, 2);
  h.hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tool-a", prompt_id: "prompt-2" });
  assert.equal(h.latest().busy, true, "root tool work after the request runs, it is not a pause");
  assert.equal(h.latest().pendingInput, true, "the open request is still open");
  assert.deepEqual(h.latest().activity, ["bash"]);

  // The monitor really is live on this file. Reading plain root rows of the
  // running turn must not regress the hook-derived foreground or the census.
  await h.append(rootAssistantToolUseRow());
  readNow(received);
  await settle();
  let kept = h.latest();
  assert.equal(kept.busy, true, "a plain root row is not evidence that a running turn stopped");
  assert.deepEqual(kept.activity, ["bash"], "a plain root row claims no activity change");
  assert.equal(kept.pendingInput, true, "an observed question request survives an unrelated read");
  assert.equal(kept.activeTasks, 2);
  assert.equal(kept.activeShells, 1);

  await h.append(rootUserToolResultRow());
  readNow(received);
  await settle();
  kept = h.latest();
  assert.equal(kept.busy, true);
  assert.equal(kept.pendingInput, true);
  assert.equal(kept.activeTasks, 2);

  // Proven membership change still corrects the counts, and only the counts.
  await h.append(jsonRow({
    type: "attachment",
    attachment: { type: "task_status", taskId: "b1", taskType: "local_bash", status: "completed" },
  }));
  readNow(received);
  await waitFor(() => h.latest().activeTasks === null, "the transition must still correct the counts");
  assert.equal(h.latest().busy, true, "a membership transition does not erase the foreground");
  assert.equal(h.latest().pendingInput, true);
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();
});

test("unrelated hook activity keeps the last-reported counts, including a published Ready", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 2, shells: 1 } });
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "Ready should land");

  // A late tool close and a child boundary for an identity this run never saw
  // start are unrelated to root background membership: neither is a live agent of
  // this run, so the last-reported pair stands and nothing is published.
  const before = h.snapshots.length;
  h.hook("PostToolUse", { tool_name: "Read", tool_use_id: "tool-late" });
  h.hook("SubagentStop", { agent_id: "agent-9", background_counts: { tasks: 0, shells: 0 } });
  await settle();
  assert.equal(h.snapshots.length, before, "unrelated hooks publish nothing about membership");
  const kept = h.latest();
  assert.equal(kept.busy, false);
  assert.deepEqual(kept.activity, ["Ready"]);
  assert.equal(kept.activeTasks, 2);
  assert.equal(kept.activeShells, 1);

  // A `SubagentStart` is NOT unrelated activity. It positively establishes a live
  // agent of this run, and a provider total counts only work currently in flight,
  // so this observer can no longer say whether that total already contains the
  // agent. The task axis is withdrawn on that uncertainty; the shell total, the
  // published `Ready`, and the foreground are untouched.
  h.hook("SubagentStart", { agent_id: "agent-9" });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 1 });
  assert.equal(h.latest().busy, false, "a live agent never erases the foreground");
  h.controller.dispose();
});

test("a transcript this controller cannot read never nulls a hook-payload count", async () => {
  const h = await createHarness();
  await beginTurn(h);
  // The bound transcript is gone before this boundary: the terminal claim cannot
  // be read, and that is reported as a gap on the transcript lane.
  await fs.rm(h.transcript);
  h.hook("Stop", { background_counts: { tasks: 2, shells: 1 } });
  assert.ok(h.gaps.includes("unavailable"), `expected an unavailable gap: ${h.gaps.join(",")}`);
  const after = h.latest();
  // The terminal claim cannot be read, so nothing closes; the running turn this
  // source observed is untouched by a missing file.
  assert.equal(after.busy, true);
  assert.equal(after.activeTasks, 2, "a transcript gap must not silently null a hook-reported count");
  assert.equal(after.activeShells, 1);
  await settle();
  assert.deepEqual(h.readySnapshots(), []);
  h.controller.dispose();
});

test("a withdrawn count is never reconstructed from later activity", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 2, shells: 1 } });
  assert.equal(h.latest().activeTasks, 2);

  // Proven membership change makes the snapshot unknown...
  await h.append(jsonRow({
    type: "attachment",
    attachment: { type: "task_status", taskId: "b1", taskType: "local_bash", status: "running" },
  }));
  await waitFor(() => h.latest().activeTasks === null, "the transition should invalidate the snapshot");

  // ...and nothing about later foreground work may put a number back: no
  // reconstruction from tool use, model output, quietness, or a child snapshot.
  h.hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tool-x", prompt_id: "prompt-1" });
  h.hook("PostToolUse", { tool_name: "Bash", tool_use_id: "tool-x", prompt_id: "prompt-1" });
  h.hook("SubagentStop", { agent_id: "agent-9", background_counts: { tasks: 1, shells: 1 } });
  await h.append(rootAssistantTextRow());
  await settle();
  assert.equal(h.latest().activeTasks, null, "activity is never a count");
  assert.equal(h.latest().activeShells, null, "activity is never a count");
  h.controller.dispose();
});

test("an unreadable ROOT Stop snapshot is unknown, never a zero or a hold-over", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 2, shells: 1 } });
  assert.equal(h.latest().activeTasks, 2);

  // A root Stop whose own snapshot cannot be read is unknown: not 0/0, not the
  // previous number carried forward, and not a partial of the unreadable shape.
  h.controller.acceptHook({
    backend: "claude",
    hook_event_name: "Stop",
    session_id: SESSION,
    transcript_path: h.transcript,
    background_counts: { tasks: "two", shells: null },
  } as unknown as NativeHookEvent);
  assert.equal(h.latest().activeTasks, null);
  assert.equal(h.latest().activeShells, null);
  h.controller.dispose();
});

test("truncation of the bound transcript withdraws instead of producing Ready", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await fs.truncate(h.transcript, 0);
  await h.append(summaryRow());

  await waitFor(() => h.gaps.includes("truncated"), "a shrink should be reported as a gap");
  assert.deepEqual(h.readySnapshots(), []);
  // A shrunk file cannot witness an end, and it never contradicts the observed
  // running turn either: no Ready, no invented unknown.
  assert.equal(h.latest().busy, true);
  // The hook-payload snapshot is not a claim about this file: it survives.
  assert.equal(h.latest().activeTasks, 1);
  assert.equal(h.latest().activeShells, 1);
  h.controller.dispose();
});

test("replacing the bound transcript file is a gap, not a witness", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 0 } });

  const replacement = path.join(h.dir, "replacement.jsonl");
  await fs.writeFile(replacement, summaryRow(), "utf8");
  await fs.rename(replacement, h.transcript);
  // A non-work event is the bounded second chance after a lost watch callback.
  h.hook("PostToolUse", { tool_name: "Read", tool_use_id: "tool-b" });

  await waitFor(() => h.gaps.includes("replaced"), "a replacement should be reported as a gap");
  assert.deepEqual(h.readySnapshots(), []);
  assert.equal(h.latest().activeTasks, 1, "a lost file never nulls a hook-reported count");
  assert.equal(h.latest().activeShells, 0);
  h.controller.dispose();
});

test("a malformed record in the scanned window withdraws the supported state", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await h.append("this is not json\n");
  await h.append(summaryRow());

  await waitFor(() => h.gaps.includes("malformed"), "an unreadable record should be reported");
  assert.deepEqual(h.readySnapshots(), []);
  assert.equal(h.latest().busy, true, "the hook lane still holds the observed running turn");
  assert.equal(h.latest().activeShells, 1, "the transcript lane failed, not the hook lane");
  h.controller.dispose();
});

test("an oversized record in the scanned window withdraws the supported state", async () => {
  const h = await createHarness({ maxLineBytes: 256 });
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await h.append(jsonRow({ type: "assistant", message: { content: "x".repeat(4000) } }));
  await h.append(summaryRow());

  await waitFor(() => h.gaps.includes("oversized"), "an oversized record should be reported");
  assert.deepEqual(h.readySnapshots(), []);
  h.controller.dispose();
});

test("a window too small to cover the barrier is an honest gap, never a guess", async () => {
  const h = await createHarness({ maxTailBytes: 128 });
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await h.append(jsonRow({ type: "assistant", message: { content: "y".repeat(600) } }));
  await h.append(summaryRow());

  await waitFor(() => h.gaps.includes("skipped-window"), "an uncovered barrier should be reported");
  assert.deepEqual(h.readySnapshots(), []);
  h.controller.dispose();
});

test("only the positively bound transcript path is ever read", async () => {
  const h = await createHarness();
  const sibling = path.join(h.dir, "someone-elses-session.jsonl");
  await fs.writeFile(sibling, summaryRow(), "utf8");
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 0, shells: 0 } });
  await fs.appendFile(sibling, summaryRow(), "utf8");

  await settle();
  assert.deepEqual(h.readySnapshots(), [], "another native conversation's rows are never a witness");
  h.controller.dispose();
});

test("a child event's transcript path never rebinds the root binding", async () => {
  const h = await createHarness();
  await beginTurn(h);
  const childPath = path.join(h.dir, "subagent-transcript.jsonl");
  await fs.writeFile(childPath, priorHistory(), "utf8");
  h.hook("PreToolUse", {
    agent_id: "agent-9",
    tool_name: "Bash",
    tool_use_id: "tool-child",
    transcript_path: childPath,
  });
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await fs.appendFile(childPath, summaryRow(), "utf8");

  await settle();
  assert.deepEqual(h.readySnapshots(), [], "a child transcript is never the root binding");

  await h.append(summaryRow({ uuid: "root-row" }));
  await waitFor(() => h.readySnapshots().length > 0, "the root transcript still closes the turn");
  h.controller.dispose();
});

test("a foreign session's SessionEnd never resets this run's scope", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("SessionEnd", { session_id: "22222222-2222-4222-8222-222222222222" });
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await h.append(summaryRow());

  await waitFor(() => h.readySnapshots().length > 0, "a stale SessionEnd must not disarm the owned run");
  h.controller.dispose();
});

test("a genuine path rebind withdraws reducer-derived state even with an ignored event", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 2, shells: 2 } });
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "Ready should land");

  const forked = path.join(h.dir, "transcript-after-fork.jsonl");
  await fs.writeFile(forked, priorHistory(), "utf8");
  // A close for a request this run never opened: the reducer ignores the edge
  // itself, but the real file change still withdraws every derived observation.
  h.hook("PostToolUse", { tool_name: "Read", tool_use_id: "never-opened", transcript_path: forked });

  const after = h.latest();
  assert.equal(after.busy, null);
  assert.deepEqual(after.activity, []);
  assert.equal(after.activeTasks, null);
  assert.equal(after.activeShells, null);
  h.controller.dispose();
});

test("a structured task transition after Ready invalidates the published counts", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 2, shells: 3 } });
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "Ready should land");
  assert.equal(h.latest().activeTasks, 2);
  assert.equal(h.latest().activeShells, 3);

  await h.append(jsonRow({
    type: "attachment",
    attachment: { type: "task_status", taskId: "b1", taskType: "local_bash", status: "completed" },
  }));
  await waitFor(() => h.latest().activeTasks === null, "a task_status row must invalidate the snapshot");
  assert.equal(h.latest().activeShells, null);
  // Ready is a foreground claim the settlement does not contradict.
  assert.equal(h.latest().busy, false);
  h.controller.dispose();
});

test("a task-notification settlement and an async launch edge also invalidate published counts", async () => {
  const rows = [
    jsonRow({
      type: "attachment",
      attachment: { type: "queued_command", origin: { kind: "task-notification", producer: "session-task", runId: "r1" } },
    }),
    jsonRow({ type: "user", toolUseResult: { status: "async_launched", agentId: "a1", outputFile: "/x" } }),
  ];
  for (const row of rows) {
    const h = await createHarness();
    await beginTurn(h);
    h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
    await h.append(summaryRow());
    await waitFor(() => h.readySnapshots().length > 0, "Ready should land");
    assert.equal(h.latest().activeTasks, 1);

    await h.append(row);
    await waitFor(() => h.latest().activeTasks === null, `transition row must invalidate: ${row.slice(0, 40)}`);
    h.controller.dispose();
  }
});

test("a task transition observed before the terminal row leaves the counts unknown", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 4, shells: 4 } });
  assert.equal(h.latest().activeTasks, 4);

  await h.append(jsonRow({ type: "attachment", attachment: { type: "task_status", taskId: "b2", status: "running" } }));
  await waitFor(() => h.latest().activeTasks === null, "the transition should invalidate before the witness lands");
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "the terminal row should still close the turn");
  assert.equal(h.latest().activeTasks, null);
  assert.equal(h.latest().activeShells, null);
  h.controller.dispose();
});

test("new root transcript work after Ready withdraws Ready, keeping the last-reported counts", async () => {
  for (const counts of [{ tasks: 0, shells: 0 }, { tasks: 2, shells: 3 }]) {
    const h = await createHarness();
    await beginTurn(h);
    h.hook("Stop", { background_counts: counts });
    await h.append(summaryRow());
    await waitFor(() => h.readySnapshots().length > 0, "Ready should land");
    assert.equal(h.latest().activeTasks, counts.tasks);
    assert.equal(h.latest().activeShells, counts.shells);

    // The provider now runs a whole new root turn whose hook deliveries never
    // reach this observer: only the transcript says the conversation moved on.
    const publishedBefore = h.snapshots.length;
    await h.append(rootUserRow());
    await waitFor(() => h.latest().busy === null, "a new root user row must withdraw the published Ready");
    assert.deepEqual(h.latest().activity, [], "a withdrawn row claims no activity label");
    // New foreground work contradicts the foreground, not background membership:
    // the last reported numbers survive as last-reported, still monitored.
    assert.equal(h.latest().activeTasks, counts.tasks, "last-reported, not erased by foreground work");
    assert.equal(h.latest().activeShells, counts.shells);
    assert.deepEqual(h.gaps, [], "observed new work is knowledge, not a source gap");
    assert.deepEqual(h.latest().support, NATIVE_CLAUDE_ACQUISITION_SUPPORT, "no category becomes unsupported");

    // The rest of that silent turn keeps the foreground unknown: nothing may
    // restore Ready, and no count is invented or reconstructed.
    await h.append(rootAssistantToolUseRow());
    await h.append(rootAssistantTextRow());
    await settle();
    assert.equal(h.readySnapshots().length, 1, "no later row may restore Ready");
    assert.equal(h.latest().busy, null);
    assert.equal(h.latest().activeTasks, counts.tasks);
    assert.equal(h.latest().activeShells, counts.shells);
    for (const snapshot of h.snapshots.slice(publishedBefore)) {
      assert.notStrictEqual(snapshot.busy, true, "a withdrawal never claims busy instead");
      assert.equal(snapshot.activeTasks, counts.tasks, "a withdrawal never invents or erases a count");
      assert.equal(snapshot.activeShells, counts.shells);
    }

    const leaked = JSON.stringify({ snapshots: h.snapshots, gaps: h.gaps });
    for (const secret of [SECRET_OUTPUT_FILE, SECRET_TASK_DESCRIPTION, h.transcript]) {
      assert.ok(!leaked.includes(secret), `observation surface leaked ${secret}`);
    }
    h.controller.dispose();
  }
});

test("a root user row, an assistant tool_use row, and a plain assistant row each withdraw on their own", async () => {
  for (const row of [rootUserRow(), rootAssistantToolUseRow(), rootAssistantTextRow()]) {
    const h = await createHarness();
    await beginTurn(h);
    h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
    await h.append(summaryRow());
    await waitFor(() => h.readySnapshots().length > 0, "Ready should land");

    await h.append(row);
    await waitFor(() => h.latest().busy === null, `the root row must withdraw: ${row.slice(0, 24)}`);
    // The foreground went unknown; the last ROOT `Stop` snapshot is untouched.
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 1);
    h.controller.dispose();
  }
});

test("a sidechain, agent-scoped, foreign-session, or non-work row never claims root work", async () => {
  const nonRootRows = [
    jsonRow({
      type: "assistant",
      sessionId: SESSION,
      isSidechain: true,
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu-child", name: "Bash" }] },
    }),
    jsonRow({ type: "user", sessionId: SESSION, agentId: "agent-9", message: { role: "user", content: "child prompt" } }),
    jsonRow({ type: "user", sessionId: OTHER_SESSION, message: { role: "user", content: "another conversation's prompt" } }),
    jsonRow({
      type: "assistant",
      sessionId: OTHER_SESSION,
      message: { role: "assistant", content: [{ type: "text", text: "another conversation's answer" }] },
    }),
    turnDurationRow(),
    jsonRow({ type: "summary", summary: "a compaction summary", leafUuid: "leaf-1" }),
    jsonRow({ type: "system", subtype: "stop_hook_summary", isSidechain: true, preventedContinuation: true, uuid: "child-summary" }),
    jsonRow({ type: "user", toolUseResult: { status: "completed", taskId: "b7" }, uuid: "settlement-row" }),
  ];
  for (const row of nonRootRows) {
    const received: NativeClaudeWatchHandlers[] = [];
    const h = await createHarness({ watchFile: manualWatch(received) });
    await beginTurn(h);
    h.hook("Stop", { background_counts: { tasks: 2, shells: 2 } });
    await h.append(summaryRow());
    readNow(received);
    await waitFor(() => h.readySnapshots().length > 0, "Ready should land");

    await h.append(row);
    readNow(received);
    await settle();
    const kept = h.latest();
    assert.equal(kept.busy, false, `a known non-root row must not withdraw: ${row.slice(0, 24)}`);
    assert.deepEqual(kept.activity, ["Ready"]);
    assert.equal(kept.activeTasks, 2, `a known non-root row must not invalidate counts: ${row.slice(0, 24)}`);
    assert.equal(kept.activeShells, 2);
    assert.deepEqual(h.gaps, []);

    // The monitor really is live on this file: the next ROOT row still withdraws.
    await h.append(rootUserRow());
    readNow(received);
    await waitFor(() => h.latest().busy === null, "the live monitor must still see real root work");
    h.controller.dispose();
  }
});

test("a turn's own rows before the barrier never withdraw, and its summary still closes it", async () => {
  const h = await createHarness();
  await beginTurn(h);
  // The whole turn's model work lands BEFORE this observer's Stop barrier.
  await h.append(rootUserRow());
  await h.append(rootAssistantToolUseRow());
  await h.append(rootAssistantTextRow());
  await settle();
  assert.deepEqual(h.readySnapshots(), [], "nothing is published before any boundary");

  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "pre-barrier rows must not block the current end");
  assert.equal(h.latest().activeTasks, 1);
  assert.equal(h.latest().activeShells, 1);
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();
});

test("root work that starts after the summary spends the batch, in either kind", async () => {
  for (const row of [rootUserRow(), rootAssistantToolUseRow(), rootAssistantTextRow()]) {
    const received: NativeClaudeWatchHandlers[] = [];
    const h = await createHarness({ watchFile: manualWatch(received) });
    await beginTurn(h);
    h.hook("Stop", { background_counts: { tasks: 2, shells: 1 } });
    // One read covers the whole batch: a sufficient summary, then a newer root
    // turn's rows. Newer work outranks a witness that came before it.
    await h.append(summaryRow() + row);
    readNow(received);
    await settle();
    assert.deepEqual(h.readySnapshots(), [], `a root row after the summary must not leave Ready: ${row.slice(0, 24)}`);
    assert.equal(h.latest().busy, null);
    assert.deepEqual(h.latest().activity, []);
    // The batch is spent on withdrawing: a later summary for that same pass can
    // no longer republish it.
    await h.append(summaryRow({ uuid: "summary-row-later" }));
    readNow(received);
    await settle();
    assert.deepEqual(h.readySnapshots(), [], "the spent pass must not close anything");
    // What the withdrawal contradicts is the foreground, not the last-reported
    // ROOT Stop snapshot.
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, 1);
    assert.deepEqual(h.gaps, [], "observed work is knowledge, not a source gap");
    h.controller.dispose();
  }
});

test("the closing turn's own trailing rows before its summary still confirm Ready", async () => {
  // The real turn-end append order: the final assistant row and the tool-result
  // row are written first, and the provider appends `stop_hook_summary` only once
  // the whole Stop pass has answered. Each shape is read both in one batch and in
  // two batches, because the watcher fires on the earlier append too.
  const trailingRows: Array<readonly [string, string]> = [
    ["final assistant row", rootAssistantTextRow()],
    ["tool-result row with message AND toolUseResult", rootUserToolResultRow()],
    ["tool_use row then its tool-result row", rootAssistantToolUseRow() + rootUserToolResultRow()],
  ];
  for (const [label, rows] of trailingRows) {
    for (const separateBatches of [false, true]) {
      const received: NativeClaudeWatchHandlers[] = [];
      const h = await createHarness({ watchFile: manualWatch(received) });
      await beginTurn(h);
      h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 2, shells: 1 } });
      if (separateBatches) {
        await h.append(rows);
        readNow(received);
        await settle();
        assert.deepEqual(h.readySnapshots(), [], "no witness has been read yet");
        // The arm stays open, and the last-reported snapshot stays useful, while
        // the summary is still on its way.
        assert.equal(h.latest().activeTasks, 2);
        assert.equal(h.latest().activeShells, 1);
        assert.deepEqual(h.gaps, []);
        await h.append(summaryRow());
        readNow(received);
      } else {
        await h.append(rows + summaryRow());
        readNow(received);
      }
      await waitFor(() => h.readySnapshots().length > 0, `Ready should land for ${label}`);
      const ready = h.latest();
      assert.equal(ready.busy, false);
      assert.deepEqual(ready.activity, ["Ready"]);
      assert.equal(ready.activeTasks, 2);
      assert.equal(ready.activeShells, 1);
      assert.deepEqual(h.gaps, []);
      h.controller.dispose();
    }
  }
});

test("a rejected summary shape before the trailing rows cannot displace the completion boundary", async () => {
  const rejected: Array<Record<string, unknown>> = [
    { hookLabel: "SubagentStop" },
    { agentId: "agent-9" },
    { isSidechain: true },
    { hookLabel: "PreToolUse" },
  ];
  for (const extra of rejected) {
    const received: NativeClaudeWatchHandlers[] = [];
    const h = await createHarness({ watchFile: manualWatch(received) });
    await beginTurn(h, "prompt-1");
    h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 2, shells: 1 } });
    // One window: a summary this run cannot use, then the closing turn's own
    // trailing rows, then its real root summary. The unusable row must not set
    // the positional boundary and spend the pass on ordering alone.
    await h.append(
      summaryRow({ ...extra, uuid: "rejected-summary" })
      + rootAssistantTextRow()
      + rootUserToolResultRow()
      + summaryRow({ uuid: "root-summary" }),
    );
    readNow(received);
    await waitFor(
      () => h.readySnapshots().length > 0,
      `the valid root summary must still close: ${JSON.stringify(extra)}`,
    );
    const ready = h.latest();
    assert.deepEqual(ready.activity, ["Ready"]);
    assert.equal(ready.activeTasks, 2);
    assert.equal(ready.activeShells, 1);
    assert.deepEqual(h.gaps, []);
    h.controller.dispose();
  }
});

test("a retained snapshot stays monitored after a root-work withdrawal", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 3, shells: 1 } });
  await h.append(summaryRow());
  readNow(received);
  await waitFor(() => h.readySnapshots().length > 0, "Ready should land");

  // A silent new root turn withdraws the published foreground. The count snapshot
  // survives it, so the monitoring it depends on must survive too: the controller
  // re-attaches on the same file and a later transition row still invalidates.
  const watchersBefore = received.length;
  await h.append(rootUserRow());
  readNow(received);
  await waitFor(() => h.latest().busy === null, "new root work must withdraw the published Ready");
  assert.equal(h.latest().activeTasks, 3);
  assert.ok(received.length > watchersBefore, "a retained published count stays monitored");

  await h.append(jsonRow({
    type: "attachment",
    attachment: { type: "task_status", taskId: "b1", taskType: "local_bash", status: "completed" },
  }));
  readNow(received);
  await waitFor(() => h.latest().activeTasks === null, "the retained snapshot must still be correctable");
  assert.equal(h.latest().busy, null);
  h.controller.dispose();
});

test("a new root prompt row retires the armed pass, so that turn's later summary cannot restore Ready", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 1 } });
  // A NEW root prompt lands while the terminal read is still armed for the old
  // turn: that is proof of newer work wherever it sits, so the pass is spent.
  await h.append(rootUserRow());
  readNow(received);
  await settle();
  assert.deepEqual(h.readySnapshots(), [], "the withdrawal itself must not publish Ready");

  await h.append(summaryRow());
  readNow(received);
  await settle();
  assert.deepEqual(h.readySnapshots(), [], "the retired pass must not close anything");
  assert.equal(h.latest().busy, null);
  // The foreground claim went unknown; the last-reported ROOT Stop snapshot stays,
  // because a new prompt says nothing about background membership.
  assert.equal(h.latest().activeTasks, 1);
  assert.equal(h.latest().activeShells, 1);
  h.controller.dispose();
});

test("a later fresh boundary and its own summary recover after a root-work withdrawal", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 0 } });
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "Ready should land");

  await h.append(rootUserRow());
  await waitFor(() => h.latest().busy === null, "new root work must withdraw Ready");
  await h.append(rootAssistantToolUseRow());
  await settle();
  assert.equal(h.readySnapshots().length, 1, "the silent turn is not closable from its own rows");

  // The new turn's own boundary and its own persisted summary publish again.
  h.hook("Stop", { prompt_id: "prompt-2", background_counts: { tasks: 0, shells: 0 } });
  await h.append(summaryRow({ uuid: "summary-row-prompt-2" }));
  await waitFor(() => h.readySnapshots().length > 1, "a fresh boundary must be able to publish Ready again");
  assert.equal(h.latest().activeTasks, 0);
  assert.equal(h.latest().activeShells, 0);
  h.controller.dispose();
});

test("replacement of the bound file after Ready withdraws published state", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "Ready should land");

  const replacement = path.join(h.dir, "replacement.jsonl");
  await fs.writeFile(replacement, priorHistory(), "utf8");
  await fs.rename(replacement, h.transcript);
  // The run's own next event is a bounded second chance after a lost watch callback.
  h.hook("PostToolUse", { tool_name: "Read", tool_use_id: "tool-after-replace" });

  await waitFor(() => h.gaps.includes("replaced"), "a replacement after Ready should be reported");
  assert.equal(h.latest().busy, null, "a transcript-derived Ready cannot survive its file");
  assert.deepEqual(h.latest().activity, []);
  assert.equal(h.latest().activeTasks, 1, "the hook-payload count is not a transcript claim");
  h.controller.dispose();
});

test("truncation of the bound file after Ready withdraws published state", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "Ready should land");

  await fs.truncate(h.transcript, 0);
  h.hook("PostToolUse", { tool_name: "Read", tool_use_id: "tool-after-truncate" });

  await waitFor(() => h.gaps.includes("truncated"), "a shrink after Ready should be reported");
  assert.equal(h.latest().busy, null, "a transcript-derived Ready cannot survive its file");
  assert.deepEqual(h.latest().activity, []);
  assert.equal(h.latest().activeTasks, 1, "the hook-payload count is not a transcript claim");
  h.controller.dispose();
});

test("a re-arm while a read is in flight still drains for the new barrier", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  // Re-arm immediately, while the first read is still outstanding.
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await h.append(summaryRow());

  await waitFor(() => h.readySnapshots().length > 0, "the current arm must still be read");
  h.controller.dispose();
});

test("without a positively bound transcript path there is no terminal claim", async () => {
  const h = await createHarness({ bindTranscript: false });
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });

  assert.ok(h.gaps.includes("unbound-transcript"));
  // Arming against an unbound file withdraws the terminal claim this Stop would
  // have made. The counts this Stop carried came from the hook payload, not from
  // that missing file, so they stay published as the last thing that was stated.
  const after = h.latest();
  // There is no file to read a terminal record from, so nothing closes. The
  // foreground stays what the hook lane observed, and the counts stay published.
  assert.equal(after.busy, true);
  assert.equal(after.activeTasks, 1);
  assert.equal(after.activeShells, 1);
  await settle();
  assert.deepEqual(h.readySnapshots(), []);
  h.controller.dispose();
});

test("no raw transcript content, hook command, stop reason, or task text crosses the boundary", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await h.append(jsonRow({
    type: "system",
    subtype: "stop_hook_summary",
    hookInfos: [{ command: SECRET_HOOK_COMMAND }],
    hookErrors: [SECRET_STOP_REASON],
    preventedContinuation: false,
  }));
  await waitFor(() => h.latest().busy === null, "the undecidable row should withdraw the foreground");
  await h.append(jsonRow({ type: "attachment", attachment: { type: "task_status", description: SECRET_TASK_DESCRIPTION } }));
  await waitFor(() => h.latest().activeTasks === null, "the structured transition should invalidate the snapshot");

  // The continued pass ends with its own boundary and its own summary row.
  h.hook("Stop", { prompt_id: "prompt-1" });
  await h.append(summaryRow({ preventedContinuation: true }));
  await waitFor(() => h.readySnapshots().length > 0, "the root summary should still close the turn");

  const leaked = JSON.stringify({ snapshots: h.snapshots, gaps: h.gaps });
  for (const secret of [SECRET_HOOK_COMMAND, SECRET_STOP_REASON, SECRET_TASK_DESCRIPTION, SECRET_OUTPUT_FILE, h.transcript]) {
    assert.ok(!leaked.includes(secret), `observation surface leaked ${secret}`);
  }
  // The row content that decided Ready is not retained anywhere in the snapshot.
  assert.deepEqual(h.readySnapshots().at(-1)?.activity, ["Ready"]);
  h.controller.dispose();
});

test("the observation carries no ownership counts and matches the shared observation shape", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 4, shells: 5 } });
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "Ready should land");

  const ready = h.latest();
  const observation: NativeStatusObservation = ready;
  assert.deepEqual(
    Object.keys(ready).sort(),
    ["activeShells", "activeTasks", "activity", "busy", "pendingInput", "support"],
  );
  assert.equal(observation.activeTasks, 4);
  assert.equal(observation.activeShells, 5);
  for (const forbidden of ["backgroundTasks", "backgroundShells", "inputSurface", "nativeSession"]) {
    assert.ok(!(forbidden in ready), `${forbidden} must never appear on a native observation`);
  }
  h.controller.dispose();
});

test("an event naming another native conversation never arms a transcript read", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { session_id: "22222222-2222-4222-8222-222222222222", background_counts: { tasks: 1, shells: 1 } });
  await h.append(summaryRow());
  await settle();
  assert.deepEqual(h.readySnapshots(), [], "a foreign conversation's Stop must not read or decide");
  assert.equal(h.latest().activeTasks, null);

  // This run's own boundary still closes its own turn, from its own rows only.
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await h.append(summaryRow({ uuid: "summary-row-owned" }));
  await waitFor(() => h.readySnapshots().length > 0, "the owned run's own summary should close the turn");
  h.controller.dispose();
});

test("invalidate withdraws everything and a later callback cannot restore it", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "Ready should land");

  h.controller.invalidate();
  const after = h.latest();
  assert.equal(after.busy, null);
  assert.deepEqual(after.activity, []);
  assert.equal(after.activeTasks, null);
  assert.equal(after.activeShells, null);

  await h.append(summaryRow({ uuid: "summary-row-late" }));
  await settle();
  assert.equal(h.readySnapshots().length, 1, "a retired generation must not restore Ready");
  h.controller.dispose();
});

test("dispose closes the watcher, stops later work, and is idempotent", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 1, shells: 0 } });
  const before = h.snapshots.length;
  h.controller.dispose();
  h.controller.dispose();

  await h.append(summaryRow());
  h.hook("UserPromptSubmit", { prompt_id: "prompt-9" });
  await settle();
  assert.deepEqual(h.readySnapshots(), []);
  assert.equal(h.snapshots.length, before, "a disposed controller emits nothing");
});

test("events for another backend are ignored without effect", async () => {
  const h = await createHarness();
  await beginTurn(h);
  const before = h.snapshots.length;
  h.controller.acceptHook({
    backend: "codex",
    hook_event_name: "Stop",
    session_id: SESSION,
  } as NativeHookEvent);
  h.controller.acceptFailure({ backend: "codex", reason: "input-malformed" });
  assert.equal(h.snapshots.length, before);
  assert.deepEqual(h.gaps, []);

  h.hook("Stop", { background_counts: { tasks: 1, shells: 1 } });
  assert.equal(h.latest().activeTasks, 1);
  h.controller.dispose();
});

test("an authenticated hook-lane failure collapses supported values to unknown", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 2, shells: 2 } });
  assert.equal(h.latest().activeTasks, 2);

  h.controller.acceptFailure({ backend: "claude", reason: "input-too-large" });
  const after = h.latest();
  assert.ok(h.gaps.includes("hook-failure"));
  assert.equal(after.busy, null);
  assert.equal(after.activeTasks, null);
  assert.equal(after.activeShells, null);
  h.controller.dispose();
});

test("invalidation keeps this run's session admission, so a foreign prompt cannot poison it", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { background_counts: { tasks: 2, shells: 2 } });
  assert.equal(h.latest().activeTasks, 2);

  h.controller.invalidate();
  assert.equal(h.latest().busy, null);

  // The reducer released its scope, but this run's conversation did not change.
  // Another native conversation's edges must not be adopted as this run's state.
  const snapshotsBefore = h.snapshots.length;
  h.hook("UserPromptSubmit", { session_id: OTHER_SESSION, prompt_id: "foreign-prompt" });
  h.hook("PreToolUse", {
    session_id: OTHER_SESSION,
    prompt_id: "foreign-prompt",
    tool_name: "Bash",
    tool_use_id: "tool-foreign",
  });
  assert.equal(h.snapshots.length, snapshotsBefore, "a foreign conversation publishes nothing here");
  assert.equal(h.latest().busy, null);

  // This run's own boundary is still admissible and still completes.
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 1 } });
  assert.equal(h.latest().activeTasks, 1);
  await h.append(summaryRow({ uuid: "summary-after-invalidate" }));
  await waitFor(() => h.readySnapshots().length > 0, "this run's completion must still be observable");
  assert.equal(h.latest().busy, false);
  h.controller.dispose();
});

test("a hook-lane failure keeps this run's session admission too", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { background_counts: { tasks: 2, shells: 2 } });
  h.controller.acceptFailure({ backend: "claude", reason: "input-malformed" });
  assert.ok(h.gaps.includes("hook-failure"));

  const snapshotsBefore = h.snapshots.length;
  h.hook("UserPromptSubmit", { session_id: OTHER_SESSION, prompt_id: "foreign-prompt" });
  assert.equal(h.snapshots.length, snapshotsBefore, "a foreign conversation publishes nothing here");
  assert.equal(h.latest().busy, null);

  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  h.hook("Stop", { prompt_id: "prompt-2", background_counts: { tasks: 0, shells: 0 } });
  assert.equal(h.latest().activeTasks, 0);
  await h.append(summaryRow({ uuid: "summary-after-failure" }));
  await waitFor(() => h.readySnapshots().length > 0, "completion must still be observable after a lane failure");
  assert.equal(h.latest().busy, false);
  h.controller.dispose();
});

test("a root SessionStart rebinds the scope so prior Ready and counts do not survive", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 3, shells: 1 } });
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "Ready should land");

  // A genuine new conversation: the boundary names a conversation this run never
  // observed, so everything the old one published is released with it.
  h.hook("SessionStart", { session_id: OTHER_SESSION });
  const rebound = h.latest();
  assert.equal(rebound.busy, null);
  assert.deepEqual(rebound.activity, []);
  assert.equal(rebound.activeTasks, null);
  h.controller.dispose();
});

test("work in one conversation never blocks a genuinely new session's empty baseline", async () => {
  const h = await createHarness();
  // Conversation A runs a real turn and ends it, reporting background work.
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 2 } });
  await h.append(summaryRow({ preventedContinuation: true }));
  await waitFor(() => h.latest().busy === false, "conversation A's turn ends on its witness");
  assert.equal(h.latest().activeTasks, 1);

  // The user clears into a brand-new conversation whose OWN transcript is empty.
  const nextPath = path.join(h.dir, "next-transcript.jsonl");
  await fs.writeFile(nextPath, "", "utf8");
  h.hook("SessionStart", { session_id: OTHER_SESSION, source: "clear", transcript_path: nextPath });

  await waitFor(() => {
    const snapshot = h.latest();
    return snapshot.busy === false
      && snapshot.pendingInput === false
      && snapshot.activeTasks === 0
      && snapshot.activeShells === 0;
  }, "the new session's empty transcript corroborates its own baseline");
  const fresh = h.latest();
  assert.deepEqual(fresh.activity, ["Ready"]);
  assert.equal(fresh.activeTasks, 0, "A's background numbers are not carried into B");
  assert.equal(fresh.activeShells, 0);
  assert.deepEqual(h.gaps, []);

  // B then behaves normally: a prompt moves it, and its own Stop replaces the
  // corroborated zeros.
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2", session_id: OTHER_SESSION });
  assert.equal(h.latest().busy, true);
  h.hook("Stop", {
    prompt_id: "prompt-2",
    session_id: OTHER_SESSION,
    background_counts: { tasks: 3, shells: 0 },
  });
  assert.equal(h.latest().activeTasks, 3);
  h.controller.dispose();
});

test("a delayed same-session SessionStart cannot idle a live turn with an empty source", async () => {
  // An empty source stands in for a provider that has not persisted this turn
  // yet: a whole-file read would still say "nothing recorded".
  const h = await createHarness({ seed: "" });
  h.hook("SessionStart", { source: "startup" });
  await waitFor(() => h.latest().busy === false, "the fresh start corroborates from the empty source");
  assert.deepEqual(h.latest().activity, ["Ready"]);
  assert.equal(h.latest().activeTasks, 0);

  // Real work now runs on the hook lane while the transcript stays empty: an open
  // question request is the live turn, and it publishes stopped-on-input.
  h.hook("UserPromptSubmit", { prompt_id: "prompt-1" });
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  const running = h.latest();
  assert.equal(running.busy, false);
  assert.equal(running.pendingInput, true);
  assert.deepEqual(running.activity, ["Working"]);

  // Two late or repeated `startup` notices for this same conversation then
  // arrive. Neither is a new boundary: acquisition returns before rebinding the
  // transcript, retiring the generation, or arming a corroboration read, so the
  // live turn, its open request, and its counts all stay. The corroboration read
  // is asynchronous, so the whole window is drained before asserting.
  const mark = h.snapshots.length;
  for (let attempt = 0; attempt < 2; attempt += 1) h.hook("SessionStart", { source: "startup" });
  await settle();
  const after = h.latest();
  assert.equal(
    h.snapshots.slice(mark).some((snapshot) => snapshot.activity.includes("Ready") || snapshot.pendingInput !== true),
    false,
    "a duplicate start never becomes Ready, not even from its own empty-source read",
  );
  assert.equal(after.busy, false, "the live turn's stopped-on-input foreground survives both duplicates");
  assert.equal(after.pendingInput, true, "the open question survives both duplicates");
  assert.deepEqual(after.activity, ["Working"]);
  assert.equal(after.activeTasks, 0, "the scope's own counts are untouched");
  assert.equal(after.activeShells, 0);

  // The request the duplicates would have deleted still closes on its own edge,
  // and a later turn still ends on its own witness.
  h.hook("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  assert.equal(h.latest().pendingInput, false, "the still-tracked request still closes");
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  h.hook("Stop", { prompt_id: "prompt-2" });
  await h.append(summaryRow({ preventedContinuation: true }));
  await waitFor(() => h.latest().busy === false, "a later turn still ends on its own witness");
  h.controller.dispose();
});

/* ------------------------------------------------- fresh owned-start baseline */

test("the host's own launch states the fresh baseline before any provider hook arrives", async () => {
  const h = await createHarness();
  assert.deepEqual(h.snapshots, [], "nothing is published before the host or the provider says anything");

  // The host owns this spawn: the process exists, nothing has run in it, and no
  // input has reached it. That is the whole evidence for the baseline.
  h.controller.observeOwnedStartup();
  const baseline = h.latest();
  assert.equal(baseline.busy, false);
  assert.equal(baseline.pendingInput, false);
  assert.deepEqual(baseline.activity, ["Ready"]);
  assert.equal(baseline.activeTasks, 0);
  assert.equal(baseline.activeShells, 0);
  assert.deepEqual(h.gaps, [], "an owned start is knowledge, not a source gap");

  // A real turn then moves every axis normally, and the provider's own snapshot
  // replaces the launch-time zeros.
  await beginTurn(h, "prompt-1");
  assert.equal(h.latest().busy, true);
  assert.deepEqual(h.latest().activity, ["Working"]);
  h.hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tool-a", prompt_id: "prompt-1" });
  assert.deepEqual(h.latest().activity, ["bash"]);
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 2, shells: 1 } });
  assert.equal(h.latest().activeTasks, 2);
  assert.equal(h.latest().activeShells, 1);
  h.controller.dispose();
});

test("a late launch baseline never idles observed work or invents counts", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  const snapshotsBefore = h.snapshots.length;

  h.controller.observeOwnedStartup();
  await settle();
  assert.equal(h.snapshots.length, snapshotsBefore, "a refused baseline publishes nothing");
  assert.equal(h.latest().busy, true, "a live turn is never reset to idle");
  assert.equal(h.latest().activeTasks, null, "the launch zeros are not claimed retroactively");

  // Invalidation withdraws the run; a later baseline call cannot restate it.
  h.controller.invalidate();
  h.controller.observeOwnedStartup();
  await settle();
  assert.deepEqual(h.readySnapshots(), []);
  h.controller.dispose();
});

test("a fresh root SessionStart idles the row only when its own transcript holds no conversation", async () => {
  // The provider's own new transcript, read from byte 0 and holding no turn row:
  // the scope is positively empty, so the row is idle with an observed 0/0.
  const fresh = await createHarness({ seed: "" });
  fresh.hook("SessionStart", { source: "startup" });
  await waitFor(() => fresh.readySnapshots().length > 0, "a corroborated fresh start should idle the row");
  const idle = fresh.latest();
  assert.deepEqual(idle.activity, ["Ready"]);
  assert.equal(idle.pendingInput, false);
  assert.equal(idle.activeTasks, 0);
  assert.equal(idle.activeShells, 0);
  assert.deepEqual(fresh.gaps, []);
  fresh.controller.dispose();

  // The same boundary over recorded conversation is not fresh: the read says so,
  // and the foreground stays unknown instead of being zeroed by the label.
  const recorded = await createHarness();
  recorded.hook("SessionStart", { source: "startup" });
  await settle();
  assert.deepEqual(recorded.readySnapshots(), [], "prerecorded work cannot be an empty baseline");
  assert.equal(recorded.latest().busy, null);
  assert.equal(recorded.latest().activeTasks, null);
  assert.deepEqual(recorded.gaps, [], "an unremarkable read is not a source gap");
  recorded.controller.dispose();

  // `resume`, `compact`, `fork`, and a missing source all continue history: the
  // file's contents never enter into it.
  for (const source of ["resume", "compact", "fork", undefined]) {
    const continuing = await createHarness({ seed: "" });
    continuing.hook("SessionStart", source === undefined ? {} : { source });
    await settle();
    assert.deepEqual(continuing.readySnapshots(), [], `source ${String(source)} is never a fresh baseline`);
    assert.equal(continuing.latest().activeTasks, null);
    continuing.controller.dispose();
  }
});

/* -------------------------------------------------- declined question closure */

/**
 * The persisted root tool-result row of a question the user DECLINED: the shape
 * that carries no top-level `toolUseResult` envelope at all, only the structured
 * `tool_result` block inside `message.content`.
 */
function rootDeclinedToolResultRow(requestId: string, secret: string): string {
  return jsonRow({
    type: "user",
    sessionId: SESSION,
    isSidechain: false,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: requestId, content: secret, is_error: true }],
    },
    uuid: "declined-tool-result-row",
    timestamp: "2026-01-01T00:02:00.000Z",
  });
}

/** A provider task-notification injection: a `user` row the human never typed. */
function rootTaskNotificationRow(secret: string): string {
  return jsonRow({
    type: "user",
    sessionId: SESSION,
    isSidechain: false,
    isMeta: true,
    commandMode: "task-notification",
    origin: { kind: "task-notification", producer: "session-task", runId: "r-1" },
    message: { role: "user", content: secret },
    uuid: "task-notification-row",
  });
}

test("a declined question closes on its persisted tool_result, with no Post hook and no answer text", async () => {
  const DECLINE_TEXT = "declined-question-secret-result-text";
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  assert.equal(h.latest().pendingInput, true, "the request is open on the hook lane");

  await h.append(rootDeclinedToolResultRow("q-1", DECLINE_TEXT));
  readNow(received);
  await waitFor(() => h.latest().pendingInput === false, "the persisted tool_result must close the request");
  const closed = h.latest();
  assert.equal(closed.pendingInput, false);
  assert.equal(closed.busy, true, "closing a question is not a turn end");
  assert.deepEqual(h.gaps, []);
  assert.ok(!JSON.stringify(h.snapshots).includes(DECLINE_TEXT), "no result text crosses the observation");

  // A row for a different identity re-reads as nothing: the census stays as it is.
  const before = h.snapshots.length;
  await h.append(rootDeclinedToolResultRow("q-some-other-tool", DECLINE_TEXT));
  readNow(received);
  await settle();
  assert.equal(h.snapshots.length, before, "an unrelated tool's result is not news");
  assert.equal(h.latest().pendingInput, false);

  // A request in another conversation is never closed from this file: a row
  // naming a foreign session, or an agent-scoped row, is refused outright.
  const foreign = await createHarness({ watchFile: manualWatch([]) });
  await beginTurn(foreign, "prompt-1");
  foreign.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-9", prompt_id: "prompt-1" });
  await foreign.append(jsonRow({
    type: "user",
    sessionId: OTHER_SESSION,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "q-9", content: "x" }] },
  }));
  await foreign.append(jsonRow({
    type: "user",
    sessionId: SESSION,
    agentId: "agent-9",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "q-9", content: "x" }] },
  }));
  await waitFor(() => foreign.snapshots.length > 0, "the harness read ran");
  await settle();
  assert.equal(foreign.latest().pendingInput, true, "a foreign or agent-scoped row closes nothing");
  h.controller.dispose();
  foreign.controller.dispose();
});

test("a tool-result row without its envelope and a task-notification row are not a new prompt", async () => {
  const rows: Array<[string, string]> = [
    ["tool_result with no toolUseResult envelope", rootDeclinedToolResultRow("toolu-root-close", "output")],
    ["provider task-notification user row", rootTaskNotificationRow("background work settled")],
  ];
  for (const [label, row] of rows) {
    const received: NativeClaudeWatchHandlers[] = [];
    const h = await createHarness({ watchFile: manualWatch(received) });
    await beginTurn(h, "prompt-1");
    h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 1 } });
    // The row lands before the summary, as it really does: a terminal pass armed
    // for the closing turn must stay open through it, not be spent on it.
    await h.append(row);
    readNow(received);
    await settle();
    assert.deepEqual(h.readySnapshots(), [], `no witness has been read for ${label}`);
    // The pass stays armed and the turn stays the observed running turn.
    assert.equal(h.latest().busy, true);
    assert.deepEqual(h.gaps, []);

    await h.append(summaryRow());
    readNow(received);
    await waitFor(() => h.readySnapshots().length > 0, `the pass must stay armed for ${label}`);
    assert.deepEqual(h.latest().activity, ["Ready"]);
    h.controller.dispose();
  }
});

/* ------------------------------------------- per-lane withdrawal of one claim */

test("a transcript gap withdraws only the claim it supported, keeping the hook census", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  h.hook("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  assert.equal(h.latest().pendingInput, false, "the hook lane vouched the census");

  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 1 } });
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "Ready should land");
  assert.equal(h.latest().pendingInput, false);

  // The bound file is replaced: the Ready was READ from it, so it goes; the
  // question census and the run's foreground lane came from elsewhere and stay.
  const replacement = path.join(h.dir, "replacement.jsonl");
  await fs.writeFile(replacement, priorHistory(), "utf8");
  await fs.rename(replacement, h.transcript);
  h.hook("PostToolUse", { tool_name: "Read", tool_use_id: "tool-after-replace" });

  await waitFor(() => h.gaps.includes("replaced"), "a replacement should be reported");
  const after = h.latest();
  assert.equal(after.busy, null, "a transcript-derived Ready cannot survive its file");
  assert.deepEqual(after.activity, []);
  assert.equal(after.pendingInput, false, "an unreadable transcript never voids the hook census");
  assert.equal(after.activeTasks, 1, "a hook-payload count is not a transcript claim");

  // And the same live observer recovers on fresh evidence of its own.
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  assert.equal(h.latest().busy, true);
  assert.equal(h.latest().pendingInput, false);
  h.controller.dispose();
});

/* ------------------------- idle claims contradicted by the monitored file */

test("a corroborated fresh-start Ready is withdrawn by a root prompt row no hook ever reported", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ seed: "", watchFile: manualWatch(received) });
  h.hook("SessionStart", { source: "startup" });
  await waitFor(() => h.latest().busy === false, "the fresh start corroborates from the empty source");
  const fresh = h.latest();
  assert.deepEqual(fresh.activity, ["Ready"]);
  assert.equal(fresh.activeTasks, 0);

  // The human typed their first prompt. The provider persisted the row and no
  // hook ever reached this observer for it: the monitored file is the only thing
  // left that can say this idle claim stopped being true.
  await h.append(rootUserRow());
  readNow(received);
  await waitFor(() => h.latest().busy === null, "the appended root prompt withdraws the fresh Ready");
  const withdrawn = h.latest();
  assert.equal(withdrawn.busy, null, "withdrawn to unknown, never a fabricated busy");
  assert.deepEqual(withdrawn.activity, []);

  // The same holds for the host's launch baseline once the provider's own start
  // bound this run's transcript: the baseline is not a permanent idle claim.
  const owned = await createHarness({ seed: "", watchFile: manualWatch(received) });
  owned.controller.observeOwnedStartup();
  assert.equal(owned.latest().busy, false);
  owned.hook("SessionStart", { source: "startup" });
  assert.equal(owned.latest().busy, false, "the provider's own start keeps the known baseline idle");
  await owned.append(rootUserRow());
  readNow(received);
  await waitFor(() => owned.latest().busy === null, "the appended root prompt withdraws the launch baseline");
  assert.deepEqual(owned.latest().activity, []);

  for (const one of [h, owned]) one.controller.dispose();
});

test("a background notification or a persisted result after Ready costs the foreground nothing", async () => {
  const NOTIFICATION_TEXT = "background-task-notification-secret-text";
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 0 } });
  await h.append(summaryRow({ preventedContinuation: true }));
  readNow(received);
  await waitFor(() => h.latest().busy === false, "the summary confirms Ready");
  const ready = h.latest();
  assert.equal(ready.activeTasks, 1);

  // A background task told the conversation something, and a call's result landed.
  // Neither started a turn: the idle foreground, its census, and the last-reported
  // numbers all stay.
  const before = h.snapshots.length;
  await h.append(rootTaskNotificationRow(NOTIFICATION_TEXT) + rootUserToolResultRow());
  readNow(received);
  await settle();
  assert.equal(h.snapshots.length, before, "a signal row contradicts no published idle claim");
  const kept = h.latest();
  assert.equal(kept.busy, false);
  assert.deepEqual(kept.activity, ["Ready"]);
  assert.equal(kept.activeTasks, 1);

  // A real model row still contradicts, immediately after the same window.
  await h.append(rootAssistantTextRow());
  readNow(received);
  await waitFor(() => h.latest().busy === null, "a root model row still withdraws a published Ready");
  assert.ok(!JSON.stringify(h.snapshots).includes(NOTIFICATION_TEXT));
  h.controller.dispose();
});

test("a notification landing after its own turn's summary still confirms Ready and keeps a child question pending", async () => {
  const NOTIFICATION_TEXT = "late-notification-secret-text";
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  // A subagent's own question is open on the hook lane while this root turn ends.
  h.hook("PreToolUse", {
    tool_name: "AskUserQuestion", tool_use_id: "q-child", prompt_id: "prompt-1", agent_id: "agent-1",
  });
  assert.equal(h.latest().pendingInput, true);
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 2, shells: 0 } });

  // One window: the closing turn's summary, then a provider notification for
  // background work. The summary confirms this turn; the notification is a
  // signal, not newer foreground, and it must not spend the pass.
  await h.append(summaryRow({ preventedContinuation: true }) + rootTaskNotificationRow(NOTIFICATION_TEXT));
  readNow(received);
  await waitFor(() => h.latest().busy === false, "the summary in the same window confirms Ready");
  const ready = h.latest();
  assert.deepEqual(ready.activity, ["Ready"]);
  assert.equal(ready.activeTasks, 2, "the root snapshot stays published");
  assert.equal(ready.pendingInput, true, "the child's own open request survives its parent's turn end");
  assert.ok(!JSON.stringify(h.snapshots).includes(NOTIFICATION_TEXT));
  h.controller.dispose();
});

/* ------------------------------------------------ live background membership */

/*
 * The membership lane: a confirmed launch identity, a matching structured
 * settlement, and a complete root census. These tests pin the LIVE counts — the
 * exact shell/task axes a row shows between turn boundaries — alongside the
 * foreground, the pending-question census, and the refusal to let any of them
 * borrow authority from another.
 */

// Provider-shaped opaque member ids: a one-character type prefix plus 8 base36
// characters, the same namespace a launch result and a snapshot member share.
const SHELL_1 = "b8k3n1p4q";
const SHELL_2 = "b2s3h4e5l6";
const TASK_1 = "a1a2b3c4d";
const TASK_2 = "a5e6f7g8h";

/** The published count pair, as one value, so an assertion reads as a census. */
function countsOf(snapshot: NativeClaudeAcquisitionSnapshot): { tasks: number | null; shells: number | null } {
  return { tasks: snapshot.activeTasks, shells: snapshot.activeShells };
}

/**
 * A persisted provider `task_status` attachment row naming one native task's own
 * id and status. The description and command fields are here only to prove that
 * nothing but the two discriminators is read, and that none of it crosses.
 */
function taskStatusRow(taskId: string, status: string): string {
  return jsonRow({
    type: "attachment",
    attachment: {
      type: "task_status",
      taskId,
      taskType: "local_bash",
      status,
      description: SECRET_TASK_DESCRIPTION,
      command: SECRET_OUTPUT_FILE,
    },
  });
}

test("a confirmed launch moves the live counts and its own settlement returns them", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });
  await beginTurn(h, "prompt-1");

  // A `run_in_background` INTENT is not membership: `PreToolUse` carries the
  // argument, and nothing is projected from it.
  h.hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tool-a", prompt_id: "prompt-1" });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 }, "an intent launches nothing");

  // The successful result names the provider's own background id: the shell axis
  // moves on that event, not at the next turn boundary.
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // Async agents move the task axis independently of the running shell.
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-b",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  h.hook("PostToolUse", {
    tool_name: "Agent",
    tool_use_id: "tool-c",
    prompt_id: "prompt-1",
    background_started: { id: TASK_2, kind: "task" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 2, shells: 1 });

  // A duplicate delivery of the same launch id is not a second member.
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 2, shells: 1 }, "a repeated launch id is one member");

  // The provider's own structured settlement for one task returns exactly that
  // axis, while the shell keeps running.
  await h.append(taskStatusRow(TASK_1, "completed"));
  readNow(received);
  await waitFor(() => h.latest().activeTasks === 1, "the settled task leaves the count");
  assert.equal(h.latest().activeShells, 1, "settling one member says nothing about another");

  // A complete root census resyncs the whole set, including a real empty set.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 0 },
    background_members: [],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });

  // Ids are ledger keys, never observation content.
  const leaked = JSON.stringify(h.snapshots);
  for (const id of [SHELL_1, TASK_1, TASK_2]) {
    assert.ok(!leaked.includes(id), `member id ${id} never crosses the observation`);
  }
  assert.ok(!leaked.includes(SECRET_TASK_DESCRIPTION) && !leaked.includes(SECRET_OUTPUT_FILE));
  h.controller.dispose();
});

test("membership stays live across a source-confirmed Ready and settles on its own event", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // The turn ends on its own witness while the shell is still running: `Ready`
  // and a live background count legitimately coexist, and the count grants no
  // stop or idle authority anywhere.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 1 },
    background_members: [{ id: SHELL_1, kind: "shell" }],
  });
  await h.append(summaryRow({ preventedContinuation: true }));
  readNow(received);
  await waitFor(() => h.latest().busy === false, "the root summary confirms Ready");
  const resting = h.latest();
  assert.deepEqual(resting.activity, ["Ready"]);
  assert.deepEqual(countsOf(resting), { tasks: 0, shells: 1 }, "Ready never zeroes a live count");

  // The shell finishes on its own while the row sits Ready. The structured
  // settlement in this run's own transcript is the same-session event that moves
  // the count: no next prompt, no later snapshot, no reconstruction.
  await h.append(taskStatusRow(SHELL_1, "completed"));
  readNow(received);
  await waitFor(() => h.latest().activeShells === 0, "the settlement moves the shell count");
  const after = h.latest();
  assert.deepEqual(countsOf(after), { tasks: 0, shells: 0 });
  assert.equal(after.busy, false, "a background settlement does not touch the foreground");
  assert.deepEqual(after.activity, ["Ready"]);
  h.controller.dispose();
});

test("a declined question closes independently while background membership stays counted", async () => {
  const DECLINE_TEXT = "declined-while-background-runs-secret";
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  assert.equal(h.latest().pendingInput, true);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });

  // The DECLINE lands as that request's own persisted tool_result. The question
  // closes on its identity; the running task, the census, and the foreground are
  // separate facts and stay exactly as they were.
  await h.append(rootDeclinedToolResultRow("q-1", DECLINE_TEXT));
  readNow(received);
  await waitFor(() => h.latest().pendingInput === false, "the persisted tool_result closes the request");
  const kept = h.latest();
  assert.equal(kept.pendingInput, false);
  assert.deepEqual(countsOf(kept), { tasks: 1, shells: 0 }, "a question closure says nothing about membership");
  assert.equal(kept.busy, true, "closing a question is not a turn end");
  assert.ok(!JSON.stringify(h.snapshots).includes(DECLINE_TEXT));
  h.controller.dispose();
});

test("a child, foreign, or intent-only edge never becomes this run's membership", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // A `SubagentStop` snapshot is that child's whole array, never root scope: it
  // neither replaces the root census nor erases the running shell.
  h.hook("SubagentStop", {
    agent_id: "agent-9",
    background_counts: { tasks: 0, shells: 0 },
    background_members: [],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // A launch inside a child context is not this run's root launch either.
  h.hook("PostToolUse", {
    agent_id: "agent-9",
    tool_name: "Task",
    tool_use_id: "tool-child",
    background_started: { id: TASK_1, kind: "task" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // Another native conversation's root census cannot replace or zero this run's.
  h.hook("Stop", {
    session_id: OTHER_SESSION,
    background_counts: { tasks: 0, shells: 0 },
    background_members: [],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // A foreground agent that ran to completion carries no launch projection, so it
  // is not membership, and neither does a tool result that merely looks similar.
  h.hook("PostToolUse", { tool_name: "Task", tool_use_id: "tool-foreground", prompt_id: "prompt-1" });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // This run's own complete census still resyncs it exactly.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 0 },
    background_members: [],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });
  h.controller.dispose();
});

test("an unobserved settlement withdraws the census and the next complete snapshot resyncs it", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");

  // A completion for a member this run never launched: its launch edge went
  // unobserved, so the census has a hole. Unknown — never a 0, never a 1.
  await h.append(taskStatusRow("bneverlaunched", "completed"));
  readNow(received);
  await waitFor(() => h.latest().activeShells === null, "an unobserved settle withdraws the census");

  // Edges alone cannot rebuild a withdrawn census: the launch is tracked, not
  // published, and no number is invented for the rest of the set.
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.equal(h.latest().activeShells, null);

  // The next complete root census states the whole set, and exactness returns.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 1 },
    background_members: [{ id: SHELL_1, kind: "shell" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });
  h.controller.dispose();
});

test("a mid-stream observer tracks members but publishes nothing until a complete census", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  // No owned-startup baseline and no snapshot yet: this observer joined
  // mid-stream, so a confirmed launch is tracked but not counted, and the absent
  // axes stay unknown rather than becoming a fabricated zero.
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.equal(h.latest().activeShells, null);
  assert.equal(h.latest().activeTasks, null);

  // The provider's own complete census is what makes the set publishable.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 1 },
    background_members: [{ id: SHELL_1, kind: "shell" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });
  h.controller.dispose();
});

test("a scope boundary with live membership withdraws the census instead of zeroing it", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // A genuinely new conversation in the same process: this observer cannot see
  // through the boundary, so a live set becomes unknown — never a 0/0 the
  // provider never stated, and never a claim carried into the new conversation.
  h.hook("SessionStart", { session_id: OTHER_SESSION });
  const after = h.latest();
  assert.equal(after.activeShells, null);
  assert.equal(after.activeTasks, null);

  // That conversation's own complete census re-anchors the run.
  h.hook("Stop", {
    session_id: OTHER_SESSION,
    background_counts: { tasks: 0, shells: 0 },
    background_members: [],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });
  h.controller.dispose();
});

test("a hook-lane loss withdraws membership that a later census recovers", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // Every membership edge arrives on this lane, so a loss of it is a real hole:
  // the census withdraws rather than holding a number that may already be wrong.
  h.controller.acceptFailure({ backend: "claude", reason: "input-too-large" });
  assert.equal(h.latest().activeShells, null);

  // The provider's next complete census rebuilds it exactly, with no restart.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 1 },
    background_members: [{ id: SHELL_1, kind: "shell" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });
  h.controller.dispose();
});

test("a completion history past the memory bound keeps publishing exact counts", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");

  // A normal long run: more distinct background completions than the ledger's
  // settled-id memory can hold. Each cycle stays exact, and nothing about crossing
  // the bound turns the row into a permanent unknown.
  const cycles = MAX_NATIVE_CLAUDE_BACKGROUND_TOMBSTONES + 8;
  for (let index = 0; index < cycles; index += 1) {
    h.hook("PostToolUse", {
      tool_name: "Bash",
      tool_use_id: `tool-${index}`,
      prompt_id: "prompt-1",
      background_started: { id: `b${index}`, kind: "shell" },
    });
    assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 }, `launch ${index} stays exact`);
    h.hook("Stop", {
      prompt_id: "prompt-1",
      background_counts: { tasks: 0, shells: 0 },
      background_members: [],
    });
    assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 }, `settle ${index} stays exact`);
  }

  // Still publishable, and a fresh launch still moves the axis immediately.
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-final",
    prompt_id: "prompt-1",
    background_started: { id: "bfinal0000", kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });
  h.controller.dispose();
});

test("identity-free totals confirm a matching census and withdraw a contradicting one", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // A root snapshot whose totals cannot describe this census: at least one
  // membership edge went unobserved. The provider's own stated totals publish, and
  // the exact census withdraws instead of pretending the difference away.
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 1 } });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-b",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  assert.equal(h.latest().activeTasks, null, "edges alone cannot rebuild a withdrawn census");

  // The next complete census states the whole set, and exactness returns.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 1, shells: 1 },
    background_members: [{ id: SHELL_1, kind: "shell" }, { id: TASK_1, kind: "task" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  // Totals that AGREE with the live census confirm it: nothing was missed, so the
  // exact set stays live and keeps moving on its own edges.
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 1 } });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-c",
    prompt_id: "prompt-1",
    background_started: { id: TASK_2, kind: "task" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 2, shells: 1 });
  h.controller.dispose();
});

/* ------------------------------------------- provider queue completion rows */

/*
 * The provider persists its own completion record the moment a background job
 * finishes — before the notification is ever handed to the model, and therefore
 * while a question is still awaiting the human. The row is a `queue-operation`
 * `enqueue` naming this run's own session, whose `content` carries the native
 * `task-notification` tag block. Only the finished member's id and its terminal
 * status are read out of that block; the summary, the output-file path, and the
 * surrounding body are never read into a value.
 */

/** The provider's own completion envelope: tags, two read values, and a body. */
function taskNotificationEnvelope(taskId: string, status: string, toolUseId: string): string {
  return "<task-notification>"
    + `<task-id>${taskId}</task-id>`
    + `<status>${status}</status>`
    + `<tool-use-id>${toolUseId}</tool-use-id>`
    + `<output-file>${SECRET_OUTPUT_FILE}</output-file>`
    + `<summary>${SECRET_TASK_DESCRIPTION}</summary>`
    + "</task-notification>";
}

function queueOperationRow(operation: string, extra: Record<string, unknown> = {}): string {
  return jsonRow({
    type: "queue-operation",
    operation,
    timestamp: "2026-11-15T03:32:48.399Z",
    sessionId: SESSION,
    ...extra,
  });
}

test("a queued completion settles its member while the question is still open", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });
  assert.equal(h.latest().busy, false, "the row is stopped on input");
  assert.equal(h.latest().pendingInput, true);

  // The job finishes while the human has not answered. The provider's own
  // persisted record settles it exactly: no answer, no decline, no next prompt.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", "tool-a"),
  }));
  await waitFor(() => h.latest().activeShells === 0, "the enqueue settles the finished shell");
  const settled = h.latest();
  assert.deepEqual(countsOf(settled), { tasks: 0, shells: 0 });
  assert.equal(settled.pendingInput, true, "only the count moved: the question still stands");
  assert.equal(settled.busy, false, "waiting for a human is not an idle claim");

  // A `dequeue` only says the queued text was handed over: it is neither new work
  // nor a second settlement, and it changes nothing.
  const before = h.snapshots.length;
  await h.append(queueOperationRow("dequeue"));
  await settle();
  assert.equal(h.snapshots.length, before, "a dequeue claims nothing about membership");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });

  // Another native conversation's completion is not this run's fact, and a queue
  // payload with no completion envelope says nothing about membership either.
  await h.append(queueOperationRow("enqueue", {
    sessionId: OTHER_SESSION,
    content: taskNotificationEnvelope(SHELL_1, "completed", "tool-a"),
  }));
  await h.append(queueOperationRow("enqueue", { content: "some other queued payload" }));
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 }, "foreign and envelope-free rows change nothing");

  // A completion for a member this run never launched is a hole, not a number:
  // unknown, never a zero and never a held count, until a complete census lands.
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-b",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope("bzzzzzzzz", "completed", "tool-z"),
  }));
  await waitFor(() => h.latest().activeTasks === null, "an unobserved member's end withdraws the census");
  assert.equal(h.latest().activeShells, null);

  // The provider's own complete root census re-anchors the set exactly.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 0 },
    background_members: [],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });

  // Neither the summary, the output path, nor any of the envelope body crosses.
  const leaked = h.snapshots.filter((snapshot) => JSON.stringify(snapshot).includes(SECRET_TASK_DESCRIPTION)
    || JSON.stringify(snapshot).includes(SECRET_OUTPUT_FILE));
  assert.deepEqual(leaked, []);
  h.controller.dispose();
});

test("a queued completion in an unreadable shape withdraws instead of guessing", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  for (const content of [
    // An envelope whose id tag is missing entirely.
    "<task-notification><status>completed</status></task-notification>",
    // Two ids in one envelope: which member ended cannot be decided.
    `<task-notification><task-id>${SHELL_1}</task-id><task-id>${TASK_1}</task-id><status>completed</status></task-notification>`,
    // A status the provider does not state as ended, in a form nothing can read.
    `<task-notification><task-id>${SHELL_1}</task-id><status>completed or so</status></task-notification>`,
  ]) {
    await h.append(queueOperationRow("enqueue", { content }));
    await waitFor(() => h.latest().activeShells === null, `an unreadable envelope must withdraw: ${content.slice(0, 24)}`);
    // The next complete census states the whole set again.
    h.hook("Stop", {
      prompt_id: "prompt-1",
      background_counts: { tasks: 0, shells: 1 },
      background_members: [{ id: SHELL_1, kind: "shell" }],
    });
    assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });
  }
  h.controller.dispose();
});

/* ------------------------------- coverage, fences, and the paused foreground */

/*
 * Four boundaries this lane must hold at once: rows already written are still
 * read even when an unrelated foreground edge retires the previous turn's
 * witness; a census cannot stay "exact" across a lost settlement source; only
 * this run's own root rows may move its numbers; and a paused foreground is a
 * claim about one request, never a question census that newer work may delete.
 */

/** The persisted result of one open question request, identity only. */
function questionToolResultRow(requestId: string): string {
  return jsonRow({
    type: "user",
    sessionId: SESSION,
    isSidechain: false,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: requestId, content: `declined ${"d".repeat(64)}` }],
    },
    uuid: `question-result-${requestId}`,
  });
}

test("a completion written before a later foreground hook is still read, not skipped past", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // The completion lands in the file, and this observer's watch callback never
  // fires for it. Then an unrelated foreground edge arrives: it ends the previous
  // turn's terminal-witness authority, and must not skip the row already there.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", "tool-a"),
  }));
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });

  await waitFor(() => h.latest().activeShells === 0, "the unread completion is still read");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });
  assert.equal(h.latest().pendingInput, true, "the question is still open");
  assert.equal(h.latest().busy, false, "and the row still reports stopped on input");
  h.controller.dispose();
});

test("lost transcript settlement coverage withdraws an exact census a later census restores", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // The bound file is replaced: any completion it held can never be read again,
  // so an exact active set can no longer claim to be one.
  const replacement = path.join(h.dir, "replacement.jsonl");
  await fs.writeFile(replacement, "", "utf8");
  await fs.rename(replacement, h.transcript);
  h.hook("PostToolUse", { tool_name: "Read", tool_use_id: "tool-after-replace" });

  await waitFor(() => h.gaps.includes("replaced"), "the replacement is reported");
  const lost = h.latest();
  assert.equal(lost.activeShells, null, "an exact set cannot stay exact across lost settlement coverage");
  assert.equal(lost.activeTasks, null);
  assert.equal(lost.pendingInput, true, "the hook lane's question census survives");
  assert.equal(lost.busy, false, "the hook lane's stopped-on-input foreground survives");

  // The provider's own complete root census re-anchors exactness.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 1 },
    background_members: [{ id: SHELL_1, kind: "shell" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });
  h.controller.dispose();
});

test("a child or foreign row naming a member cannot settle or withdraw this run's census", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-b",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  // Sidechain, agent-scoped, and foreign-conversation rows are refused whichever
  // membership source they use — naming a tracked member, an unknown member, or no
  // member at all, because none of them may open a hole here either.
  const refused: readonly Record<string, unknown>[] = [
    { type: "attachment", isSidechain: true, attachment: { type: "task_status", taskId: SHELL_1, status: "completed" } },
    { type: "attachment", agentId: "agent-9", attachment: { type: "task_status", taskId: SHELL_1, status: "completed" } },
    { type: "attachment", sessionId: OTHER_SESSION, attachment: { type: "task_status", taskId: SHELL_1, status: "completed" } },
    { type: "attachment", isSidechain: true, attachment: { type: "task_status", taskId: "bzzzzzzzz", status: "completed" } },
    { type: "attachment", sessionId: OTHER_SESSION, attachment: { type: "queued_command", origin: { kind: "task-notification", producer: "session-task", runId: "r9" } } },
    { type: "queue-operation", operation: "enqueue", sessionId: OTHER_SESSION, content: taskNotificationEnvelope(SHELL_1, "completed", "tool-a") },
    { type: "queue-operation", operation: "enqueue", isSidechain: true, sessionId: SESSION, content: taskNotificationEnvelope(TASK_1, "completed", "tool-b") },
    { type: "queue-operation", operation: "enqueue", agent_id: "agent-9", sessionId: SESSION, content: taskNotificationEnvelope(TASK_1, "completed", "tool-b") },
  ];
  for (const row of refused) {
    await h.append(jsonRow(row));
    await settle();
    assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, `must not move counts: ${JSON.stringify(row).slice(0, 48)}`);
  }

  // This run's own root row still settles exactly.
  await h.append(taskStatusRow(SHELL_1, "completed"));
  await waitFor(() => h.latest().activeShells === 0, "this run's own settlement still lands");
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });
  h.controller.dispose();
});

test("a root model row while a question is open ends the pause without erasing the census", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 0, shells: 0 } });
  await h.append(summaryRow());
  await waitFor(() => h.readySnapshots().length > 0, "Ready should land");

  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  assert.equal(h.latest().busy, false);
  assert.equal(h.latest().pendingInput, true);

  // A newer root model row proves the provider moved on. It does NOT prove the
  // request closed: the pause ends, the foreground becomes unverifiable, and the
  // request keeps its identity.
  await h.append(rootAssistantToolUseRow());
  await settle();
  const kept = h.latest();
  assert.equal(kept.pendingInput, true, "a newer root row does not prove the request closed");
  assert.equal(kept.busy, null, "the pause is over, and nothing states what replaced it");
  assert.deepEqual(kept.activity, []);

  // Its own persisted result still closes it definitively.
  await h.append(questionToolResultRow("q-1"));
  await waitFor(() => h.latest().pendingInput === false, "its own result still closes it");
  h.controller.dispose();
});

test("rows written before a question hook settle the member without ending the pause", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // Two rows land with no watch callback delivered: a root model row of the turn
  // that is already under way, and the completion of the shell it launched.
  await h.append(rootAssistantToolUseRow());
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", "tool-a"),
  }));

  // The question hook arrives. It retires the previous turn's witness and keeps
  // the unread rows in reach — and those rows describe the turn the hook lane
  // just reported, so they settle the member without claiming the conversation
  // moved past the question.
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  await waitFor(() => h.latest().activeShells === 0, "the unread completion is consumed");
  const blocked = h.latest();
  assert.deepEqual(countsOf(blocked), { tasks: 0, shells: 0 });
  assert.equal(blocked.pendingInput, true, "the question is open");
  assert.equal(blocked.busy, false, "and the row still reports stopped on input");

  // Its own result closes it, and the running turn underneath comes back: the
  // observation the older rows did not discard is the one that returns.
  await h.append(questionToolResultRow("q-1"));
  readNow(received);
  await settle();
  assert.equal(h.latest().pendingInput, false, "its own result closes it");
  assert.equal(h.latest().busy, true, "the observed turn resumes");

  // A row written AFTER a question hook is different: it is newer root work, and
  // it ends that pause while the request itself stays counted.
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-2", prompt_id: "prompt-1" });
  assert.equal(h.latest().busy, false);
  await h.append(rootAssistantTextRow());
  readNow(received);
  await settle();
  assert.equal(h.latest().busy, null, "newer root work beyond the hook does end the pause");
  assert.equal(h.latest().pendingInput, true, "and the open request survives it");
  h.controller.dispose();
});

/* ---- the same question's own row, and a delivery of an already-settled end ---- */

/*
 * Two rows the provider appends only AFTER the fact they describe has already
 * been observed on this run's own lanes, each of which used to withdraw facts the
 * row contradicts nothing about:
 *
 * - the persisted INVOCATION of a question request this run's own `PreToolUse`
 *   already accepted. It lands past the floor that hook established, but it is
 *   the same tool call: the stopped-on-input foreground, the pending census, the
 *   live counts, and the activity label all stand, and the request still closes
 *   on its own edge and the turn still ends on its own witness.
 * - the DELIVERY of a background completion whose structured record this run's
 *   ledger already applied. It states no new membership fact, so it neither moves
 *   a count nor opens a hole — and it is never an agent's fresh completion, since
 *   a delivery can replay an old end long after that agent's own window reopened.
 *
 * Every row these two readings do not positively cover keeps its existing
 * fail-closed outcome, and every genuine hole still withdraws what it reaches.
 */

const QUESTION_1 = "toolu-ask-q1";
const QUESTION_ARG_SECRET = "secret-question-argument-text-never-read";

/**
 * The persisted ROOT `assistant` row of the question request itself: exactly one
 * `tool_use` block whose identity is the request the hook lane already accepted.
 * The tool name and arguments are here only to prove neither is ever read.
 */
function rootQuestionInvocationRow(requestId: string): string {
  return jsonRow({
    type: "assistant",
    sessionId: SESSION,
    isSidechain: false,
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: requestId,
        name: "AskUserQuestion",
        input: { questions: [{ question: QUESTION_ARG_SECRET }] },
      }],
    },
    uuid: "root-question-invocation-row",
    timestamp: "2026-01-01T00:01:10.000Z",
  });
}

/** One ROOT `assistant` row carrying arbitrary `message.content`. */
function rootAssistantContentRow(content: unknown): string {
  return jsonRow({
    type: "assistant",
    sessionId: SESSION,
    isSidechain: false,
    message: { role: "assistant", content },
    uuid: "root-assistant-content-row",
    timestamp: "2026-01-01T00:01:10.000Z",
  });
}

/**
 * The provider's persisted DELIVERY of a background completion into this run's own
 * root conversation: a `queued_command` attachment whose `prompt` carries the
 * machine envelope. The delivery metadata and the envelope body are here only to
 * prove none of them is read into state.
 */
function queuedCommandDeliveryRow(
  prompt: string,
  origin: Record<string, unknown> = { kind: "task-notification", producer: "session-task" },
): string {
  return jsonRow({
    type: "attachment",
    sessionId: SESSION,
    isSidechain: false,
    attachment: {
      type: "queued_command",
      origin,
      prompt,
      commandMode: "task-notification",
      delivery_id: "delivery-1",
      runId: "run-1",
      source_uuid: "source-uuid-1",
      timestamp: "2026-01-01T00:03:00.000Z",
      toolsUsedDelta: 3,
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  });
}

/**
 * A run stopped on an open ROOT question with live membership: one task and two
 * shells counted, the row published as waiting for a human.
 */
async function pausedWithMembership(received: NativeClaudeWatchHandlers[]): Promise<Harness> {
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Task", tool_use_id: "tool-a", prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  h.hook("PostToolUse", {
    tool_name: "Bash", tool_use_id: "tool-b", prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  h.hook("PostToolUse", {
    tool_name: "Bash", tool_use_id: "tool-c", prompt_id: "prompt-1",
    background_started: { id: SHELL_2, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 2 });
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: QUESTION_1, prompt_id: "prompt-1" });
  const paused = h.latest();
  assert.equal(paused.busy, false, "the row is stopped on input");
  assert.equal(paused.pendingInput, true);
  assert.deepEqual(paused.activity, ["Working"]);
  return h;
}

test("a question's own persisted invocation row holds the pause, the census, and the counts", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await pausedWithMembership(received);

  // The provider appends the invocation of the SAME request, seconds after the
  // `PreToolUse` that established this window's floor. One read consumes it.
  const mark = h.snapshots.length;
  await h.append(rootQuestionInvocationRow(QUESTION_1));
  readNow(received);
  await settle();
  assert.deepEqual(h.snapshots.slice(mark), [], "the same question's own row publishes nothing at all");
  const held = h.latest();
  assert.equal(held.busy, false, "its own request's row contradicts no foreground claim");
  assert.equal(held.pendingInput, true, "the request stays open");
  assert.deepEqual(held.activity, ["Working"], "the activity label stands");
  assert.deepEqual(countsOf(held), { tasks: 1, shells: 2 }, "live membership is untouched");
  assert.deepEqual(h.gaps, [], "a row this run read is knowledge, not a source gap");
  const leaked = JSON.stringify(h.snapshots);
  for (const secret of [QUESTION_ARG_SECRET, h.transcript]) {
    assert.ok(!leaked.includes(secret), `observation surface leaked ${secret}`);
  }

  // The read really consumed that window: a settlement appended behind the same
  // kind of row still lands, and the pause still stands beside it.
  await h.append(rootQuestionInvocationRow(QUESTION_1) + taskStatusRow(SHELL_1, "completed"));
  readNow(received);
  await waitFor(() => countsOf(h.latest()).shells === 1, "the settlement behind the row still settles");
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });
  assert.equal(h.latest().busy, false);
  assert.equal(h.latest().pendingInput, true);
  assert.deepEqual(h.latest().activity, ["Working"]);

  // Its own Post edge still closes the request, and the observed turn returns.
  h.hook("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: QUESTION_1, prompt_id: "prompt-1" });
  assert.equal(h.latest().pendingInput, false, "its own close edge still lands");
  assert.equal(h.latest().busy, true, "the turn underneath the pause comes back");

  // And that turn still ends on its own witness, with its counts intact.
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 1 } });
  await h.append(summaryRow());
  readNow(received);
  await waitFor(() => h.latest().activity.includes("Ready"), "the turn's own summary still confirms Ready");
  assert.deepEqual(h.latest().activity, ["Ready"]);
  assert.equal(h.latest().busy, false);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });
  assert.deepEqual(h.gaps, [], "nothing on this path is a source gap");
  h.controller.dispose();
});

test("every other root row still ends the pause, and the open request still survives it", async () => {
  const own = { type: "tool_use", id: QUESTION_1, name: "AskUserQuestion", input: {} };
  const unseen = { type: "tool_use", id: "toolu-root-new-9", name: "Bash", input: { command: SECRET_OUTPUT_FILE } };
  const cases: Array<[string, string]> = [
    ["a tool_use row for an identity this run never opened", rootAssistantContentRow([unseen])],
    ["a row mixing the open request with an unseen tool", rootAssistantContentRow([own, unseen])],
    ["a tool_use row with model prose beside it", rootAssistantContentRow([own, { type: "text", text: `root answer ${"a".repeat(64)}` }])],
    ["a thinking row", rootAssistantContentRow([{ type: "thinking", thinking: `root reasoning ${"r".repeat(64)}` }])],
    ["an assistant row whose content is plain text", rootAssistantContentRow(`root answer ${"a".repeat(64)}`)],
    ["a tool_use block with no readable identity", rootAssistantContentRow([{ type: "tool_use", name: "Bash", input: {} }])],
    ["a persisted new root prompt row", rootUserRow()],
  ];
  for (const [label, row] of cases) {
    const received: NativeClaudeWatchHandlers[] = [];
    const h = await pausedWithMembership(received);
    await h.append(row);
    readNow(received);
    await settle();
    const after = h.latest();
    assert.equal(after.busy, null, `newer root work must still end the pause: ${label}`);
    assert.deepEqual(after.activity, [], `a withdrawal claims no label: ${label}`);
    assert.equal(after.pendingInput, true, `the open request survives newer work: ${label}`);
    assert.deepEqual(countsOf(after), { tasks: 1, shells: 2 }, `foreground work contradicts no count: ${label}`);
    assert.deepEqual(h.gaps, [], `observed work is knowledge, not a gap: ${label}`);

    // The request it did not erase still closes on its own persisted result.
    await h.append(questionToolResultRow(QUESTION_1));
    readNow(received);
    await waitFor(() => h.latest().pendingInput === false, `its own result still closes it: ${label}`);
    h.controller.dispose();
  }
});

test("a child question's identity in a root row is newer root work, never its own invocation", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await pausedWithMembership(received);
  // A SUBAGENT's question request: pending on its own edges, never part of this
  // run's ROOT question census.
  h.hook("PreToolUse", {
    tool_name: "AskUserQuestion", tool_use_id: "q-child", agent_id: "agent-1", prompt_id: "prompt-1",
  });
  await h.append(rootAssistantContentRow([{ type: "tool_use", id: "q-child", name: "AskUserQuestion", input: {} }]));
  readNow(received);
  await settle();
  assert.equal(h.latest().busy, null, "a root row naming a child's request is not this run's open question");
  assert.equal(h.latest().pendingInput, true, "this run's own open request still counts as pending");
  h.controller.dispose();
});

test("a sidechain, agent-scoped, or foreign row naming the open request is never this run's root work", async () => {
  for (const marker of [
    { isSidechain: true },
    { agentId: "agent-9" },
    { sessionId: OTHER_SESSION },
  ]) {
    const received: NativeClaudeWatchHandlers[] = [];
    const h = await pausedWithMembership(received);
    const mark = h.snapshots.length;
    await h.append(jsonRow({
      type: "assistant",
      sessionId: SESSION,
      ...marker,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: QUESTION_1, name: "AskUserQuestion", input: {} }],
      },
    }));
    readNow(received);
    await settle();
    assert.deepEqual(h.snapshots.slice(mark), [], `must publish nothing: ${JSON.stringify(marker)}`);
    const held = h.latest();
    assert.equal(held.busy, false, `someone else's row cannot end this pause: ${JSON.stringify(marker)}`);
    assert.equal(held.pendingInput, true);
    assert.deepEqual(countsOf(held), { tasks: 1, shells: 2 });
    h.controller.dispose();
  }
});

test("a delivery of a member this run's ledger already settled states no new membership change", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Task", tool_use_id: "tool-a", prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  h.hook("PostToolUse", {
    tool_name: "Bash", tool_use_id: "tool-c", prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  // The provider's structured record settles the task exactly. The ledger now
  // remembers that identity as ended.
  await h.append(taskStatusRow(TASK_1, "completed"));
  readNow(received);
  await waitFor(() => countsOf(h.latest()).tasks === 0, "the structured record settles the task");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // A question is open, so the foreground axes are pinned alongside the counts.
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: QUESTION_1, prompt_id: "prompt-1" });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });
  assert.equal(h.latest().busy, false, "stopped on input");
  assert.equal(h.latest().pendingInput, true);

  // The provider now DELIVERS that same completion into the root conversation.
  const mark = h.snapshots.length;
  await h.append(queuedCommandDeliveryRow(taskNotificationEnvelope(TASK_1, "completed", "tool-a")));
  readNow(received);
  await settle();
  assert.deepEqual(h.snapshots.slice(mark), [], "a known-settled delivery publishes nothing at all");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 }, "no hole, and no new zero");
  assert.equal(h.latest().busy, false, "the foreground is untouched by a restated end");
  assert.equal(h.latest().pendingInput, true, "the question census is untouched too");
  assert.deepEqual(h.gaps, [], "a row this run read is knowledge, not a source gap");

  // The read really consumed that window: a live settlement appended behind the
  // same delivery still lands, and the known-settled one still moves nothing.
  await h.append(
    queuedCommandDeliveryRow(taskNotificationEnvelope(TASK_1, "completed", "tool-a"))
      + taskStatusRow(SHELL_1, "completed"),
  );
  readNow(received);
  await waitFor(() => countsOf(h.latest()).shells === 0, "the live settlement behind it still settles");
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: 0, shells: 0 },
    "the settled delivery opened no hole in the very window that proves it",
  );

  // Neither the envelope body, the output path, nor the description crosses.
  const leaked = JSON.stringify(h.snapshots);
  for (const secret of [SECRET_OUTPUT_FILE, SECRET_TASK_DESCRIPTION, h.transcript]) {
    assert.ok(!leaked.includes(secret), `observation surface leaked ${secret}`);
  }
  h.controller.dispose();
});

test("an unknown, active, malformed, or ambiguous delivery still withdraws both categories", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Task", tool_use_id: "tool-a", prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  h.hook("PostToolUse", {
    tool_name: "Bash", tool_use_id: "tool-c", prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  const cases: Array<[string, string]> = [
    ["an id this run never launched", taskNotificationEnvelope("bzzzzzzzz", "completed", "tool-z")],
    ["an id this run still counts active", taskNotificationEnvelope(SHELL_1, "completed", "tool-c")],
    ["a status the provider does not state as ended", taskNotificationEnvelope(TASK_1, "running", "tool-a")],
    ["an envelope that never closes", `<task-notification><task-id>${TASK_1}</task-id><status>completed</status>`],
    [
      "two envelopes in one delivery",
      taskNotificationEnvelope(TASK_1, "completed", "tool-a") + taskNotificationEnvelope(SHELL_1, "completed", "tool-c"),
    ],
    ["no envelope at all", "a queued command with no completion envelope"],
    ["no readable id", "<task-notification><status>completed</status></task-notification>"],
    ["an id past the value bound", taskNotificationEnvelope("a".repeat(200), "completed", "tool-a")],
    [
      "a payload past the envelope bound",
      taskNotificationEnvelope(TASK_1, "completed", "tool-a") + "x".repeat(9 * 1024),
    ],
  ];
  for (const [label, prompt] of cases) {
    await h.append(queuedCommandDeliveryRow(prompt));
    await waitFor(() => h.latest().activeTasks === null, `must withdraw both categories: ${label}`);
    assert.equal(h.latest().activeShells, null, `must withdraw both categories: ${label}`);
    // The provider's own complete root census states the whole set again.
    h.hook("Stop", {
      prompt_id: "prompt-1",
      background_counts: { tasks: 1, shells: 1 },
      background_members: [{ id: TASK_1, kind: "task" }, { id: SHELL_1, kind: "shell" }],
    });
    assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, `resync restores the exact census: ${label}`);
  }
  h.controller.dispose();
});

test("a malformed delivery naming an already-settled member still withdraws both categories", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Task", tool_use_id: "tool-a", prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  h.hook("PostToolUse", {
    tool_name: "Bash", tool_use_id: "tool-c", prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  // The task settles on the provider's own structured record, and a shell stays
  // LIVE. Every payload below names that POSITIVELY SETTLED id: a delivery this
  // lane cannot read cleanly must still withdraw both categories, because "I could
  // not read it" is never evidence that nothing changed.
  await h.append(taskStatusRow(TASK_1, "completed"));
  await waitFor(() => countsOf(h.latest()).tasks === 0, "the structured record settles the task");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // Only the CLOSED machine metadata decides anything: the two machine tags must
  // read as one unambiguous terminal identity and status, and the envelope itself
  // must be exactly one ordered block inside the byte bound. The body around them
  // is OPAQUE (pinned by the next test), so no case below turns on the markup of a
  // description or an output path.
  const cases: Array<[string, string]> = [
    [
      "a repeated identity tag: which member ended cannot be decided",
      `<task-notification><task-id>${TASK_1}</task-id><task-id>${TASK_1}</task-id><status>completed</status></task-notification>`,
    ],
    [
      "a repeated status tag: which status was stated cannot be decided",
      `<task-notification><task-id>${TASK_1}</task-id><status>completed</status><status>completed</status></task-notification>`,
    ],
    [
      "an identity tag that never closes",
      `<task-notification><task-id>${TASK_1}<status>completed</status></task-notification>`,
    ],
    [
      "a status tag that never closes",
      `<task-notification><task-id>${TASK_1}</task-id><status>completed</task-notification>`,
    ],
    [
      "a crossed identity tag whose value never terminates",
      `<task-notification><task-id>${TASK_1}</status><status>completed</status></task-notification>`,
    ],
    [
      "a crossed status tag whose value is not one opaque token",
      `<task-notification><task-id>${TASK_1}</task-id><status>completed</task-id></status></task-notification>`,
    ],
    ["a stray envelope closing tag behind the envelope", `${taskNotificationEnvelope(TASK_1, "completed", "tool-a")}</task-notification>`],
    ["a stray envelope closing tag before the envelope", `</task-notification>${taskNotificationEnvelope(TASK_1, "completed", "tool-a")}`],
    [
      "two envelopes in one delivery",
      taskNotificationEnvelope(TASK_1, "completed", "tool-a") + taskNotificationEnvelope(SHELL_1, "completed", "tool-c"),
    ],
  ];
  for (const [label, prompt] of cases) {
    await h.append(queuedCommandDeliveryRow(prompt));
    await waitFor(() => h.latest().activeTasks === null, `a malformed delivery must withdraw: ${label}`);
    assert.equal(h.latest().activeShells, null, `a malformed delivery withdraws both categories: ${label}`);
    // The provider's complete census states the set again: the task stays settled
    // because it really ended, and the shell stays live.
    h.hook("Stop", {
      prompt_id: "prompt-1",
      background_counts: { tasks: 0, shells: 1 },
      background_members: [{ id: SHELL_1, kind: "shell" }],
    });
    assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 }, `resync keeps the real set: ${label}`);
  }

  // The CANONICAL restated end of that same settled member stays inert, so the
  // metadata strictness above costs the actual producer shape nothing.
  const before = h.snapshots.length;
  await h.append(queuedCommandDeliveryRow(taskNotificationEnvelope(TASK_1, "completed", "tool-a")));
  await settle();
  assert.deepEqual(h.snapshots.slice(before), [], "the canonical restated end still publishes nothing");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 }, "and still moves no count");
  assert.deepEqual(h.gaps, [], "none of this is a source gap");
  h.controller.dispose();
});

test("a settled member's restated end stays inert however its opaque body is marked up", async () => {
  const BODY_CANARY = "secret-delivery-body-text-never-read";
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Task", tool_use_id: "tool-a", prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  h.hook("PostToolUse", {
    tool_name: "Bash", tool_use_id: "tool-c", prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  await h.append(taskStatusRow(TASK_1, "completed"));
  await waitFor(() => countsOf(h.latest()).tasks === 0, "the structured record settles the task");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // The machine tags are canonical in every case below; only the OPAQUE body
  // around them varies — repeated, unclosed, custom, or crossed markup of the kind
  // a description or an output path can legitimately carry. None of that is a
  // membership fact, so none of it may open a census hole or publish anything.
  const machine = `<task-id>${TASK_1}</task-id><status>completed</status>`;
  const bodies: Array<[string, string]> = [
    ["repeated HTML-like tags", `<summary>${BODY_CANARY} <code>a</code> and <code>b</code> and <code>c</code></summary>`],
    ["a literal unclosed tag", `<summary>${BODY_CANARY} while writing <b>the report</summary>`],
    ["custom nested tags", `<output-file><path>${BODY_CANARY}</path><note>anything</note></output-file>`],
    ["crossed unrelated tags", `<summary><output-file>${BODY_CANARY}</summary></output-file>`],
    ["a stray duplicate closing tag beside the machine tags", "</status>"],
  ];
  for (const [label, body] of bodies) {
    const before = h.snapshots.length;
    await h.append(queuedCommandDeliveryRow(`<task-notification>${machine}${body}</task-notification>`));
    await settle();
    assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 }, `opaque body markup moves nothing: ${label}`);
    assert.deepEqual(h.snapshots.slice(before), [], `an inert restated end publishes nothing: ${label}`);
  }
  assert.deepEqual(h.gaps, [], "none of this is a source gap");

  // The body never crosses into state, however it is marked up.
  const leaked = JSON.stringify(h.snapshots);
  for (const secret of [BODY_CANARY, SECRET_OUTPUT_FILE, SECRET_TASK_DESCRIPTION, h.transcript]) {
    assert.ok(!leaked.includes(secret), `observation surface leaked ${secret}`);
  }

  // And the positives above did not soften a real metadata failure: the same
  // settled id with an ambiguous machine tag still withdraws both categories.
  await h.append(queuedCommandDeliveryRow(
    `<task-notification><task-id>${TASK_1}</task-id><status>completed</status><status>completed</status></task-notification>`,
  ));
  await waitFor(() => h.latest().activeTasks === null, "an ambiguous machine tag still withdraws both categories");
  assert.equal(h.latest().activeShells, null, "both categories, as an unattributed hole always did");
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 1 },
    background_members: [{ id: SHELL_1, kind: "shell" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 }, "the complete census states the set again");
  h.controller.dispose();
});

test("a settled member's delivery never becomes a fresh terminal for a resumed agent", async () => {
  const AGENT_L = "aa0liveagent";
  const CHILD_TOOL = "21e7310361";
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");

  // A is live and owns one background shell; its turn ends while the shell runs.
  h.hook("SubagentStart", { agent_id: AGENT_L });
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 1, shells: 0 },
    background_members: [{ id: AGENT_L, kind: "task" }],
  });
  h.hook("PostToolUse", {
    agent_id: AGENT_L, tool_name: "Bash", tool_use_id: CHILD_TOOL,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });
  h.hook("SubagentStop", {
    agent_id: AGENT_L,
    background_counts: { tasks: 1, shells: 1 },
    background_members: [{ id: AGENT_L, kind: "task" }, { id: SHELL_1, kind: "shell" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, "parking keeps A counted");

  // The shell settles on its own record, A wakes and resumes, and its final clean
  // boundary lands: one conjunct of an end, still not an end.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", CHILD_TOOL),
  }));
  await waitFor(() => countsOf(h.latest()).shells === 0, "the shell settles on its own record");
  h.hook("SubagentStart", { agent_id: AGENT_L });
  h.hook("SubagentStop", {
    agent_id: AGENT_L,
    background_counts: { tasks: 0, shells: 0 },
    background_members: [{ id: AGENT_L, kind: "task" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "a clean boundary alone never ends A");

  // A's OWN fresh completion lands in that same execution window: that is its
  // actual end, and the census goes empty.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(AGENT_L, "completed", "tool-final"),
  }));
  await waitFor(() => countsOf(h.latest()).tasks === 0, "A's own completion closes A");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });

  // A resumes once more and its clean boundary lands again: one live task.
  h.hook("SubagentStart", { agent_id: AGENT_L });
  h.hook("SubagentStop", {
    agent_id: AGENT_L,
    background_counts: { tasks: 0, shells: 0 },
    background_members: [{ id: AGENT_L, kind: "task" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "a clean boundary alone never ends A");

  // The provider now delivers A's OLD completion into the root conversation, in
  // this new window. It restates an end this ledger already applied: it is never
  // handed to the live-agent lifetime, so A stays live and the count is never a
  // fabricated zero.
  const mark = h.snapshots.length;
  await h.append(queuedCommandDeliveryRow(taskNotificationEnvelope(AGENT_L, "completed", "tool-final")));
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "a delivery is never an agent's fresh completion");
  assert.deepEqual(h.snapshots.slice(mark), [], "the restated end publishes nothing at all");
  assert.equal(h.latest().activeShells, 0);

  // The same restated end with OPAQUE markup around its canonical machine tags is
  // equally inert: body shape never becomes lifetime authority either.
  await h.append(queuedCommandDeliveryRow(
    `<task-notification><task-id>${AGENT_L}</task-id><status>completed</status>`
      + "<summary><code>x</code> and <b>y</summary></task-notification>",
  ));
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "opaque body markup never ends a live agent either");

  // Once a complete census positively REACTIVATES that identity, the ledger can no
  // longer claim it is already settled. The same delivery then keeps the existing
  // unattributable hole for both categories — and still ends nothing.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 1, shells: 0 },
    background_members: [{ id: AGENT_L, kind: "task" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });
  await h.append(queuedCommandDeliveryRow(taskNotificationEnvelope(AGENT_L, "completed", "tool-final")));
  await waitFor(() => h.latest().activeTasks === null, "a reactivated member's delivery still withdraws");
  assert.equal(h.latest().activeShells, null, "and it withdraws both, as an unattributed hole always did");
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 1, shells: 0 },
    background_members: [{ id: AGENT_L, kind: "task" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "the delivery ended nothing: A is still live");
  h.controller.dispose();
});

test("a peer delivery and a queue removal claim nothing, however their payload looks", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Task", tool_use_id: "tool-a", prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  h.hook("PostToolUse", {
    tool_name: "Bash", tool_use_id: "tool-c", prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  const envelope = taskNotificationEnvelope(TASK_1, "completed", "tool-a");
  const before = h.snapshots.length;
  // A peer's queued command carrying a completion envelope is not this run's
  // background lane's fact at all, and a queue removal only says queued text left
  // the queue — neither is a terminal record.
  await h.append(queuedCommandDeliveryRow(envelope, { kind: "peer", producer: "peer-session" }));
  await h.append(queueOperationRow("remove", { content: envelope }));
  // A foreign conversation's delivery is not this run's fact either.
  await h.append(jsonRow({
    type: "attachment",
    sessionId: OTHER_SESSION,
    isSidechain: false,
    attachment: { type: "queued_command", origin: { kind: "task-notification", producer: "session-task" }, prompt: envelope },
  }));
  await settle();
  assert.deepEqual(h.snapshots.slice(before), [], "none of these rows claims anything");
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();
});

/* -------------------------------------------------------------------------- */
/*  The order native actually delivers, against the file's real lifecycle.     */
/* -------------------------------------------------------------------------- */

/**
 * The callback order native 2.1.325 was observed to accept: the root
 * `SessionStart`, the accepted prompt, the backgrounded command's `PreToolUse`,
 * the question's `PreToolUse` while that command is still running, and only then
 * the command's own `PostToolUse` carrying the confirmed launch. The provider
 * creates its root JSONL when the conversation begins, so these tests drive that
 * file's real lifecycle instead of assuming it was there first.
 */
function liveOrderHooks(h: Harness): void {
  h.hook("SessionStart", { source: "startup" });
  h.hook("UserPromptSubmit", { prompt_id: "prompt-1" });
  h.hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tool-a", prompt_id: "prompt-1" });
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
}

function liveLaunch(h: Harness): void {
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
}

test("a transcript the provider has not created yet is not a coverage hole", async () => {
  const h = await createHarness({ createEmpty: true });
  h.controller.observeOwnedStartup();
  assert.equal(h.latest().activeShells, 0, "the host's own spawn states a known-empty census");

  // The whole live order arrives while the bound root JSONL still does not exist.
  liveOrderHooks(h);
  await settle();
  assert.deepEqual(h.gaps, [], "a source with nothing recorded in it states no gap");
  liveLaunch(h);
  await settle();

  const launched = h.latest();
  assert.equal(launched.activeShells, 1, "a confirmed launch counts on a run whose file has not appeared");
  assert.equal(launched.activeTasks, 0, "and the other axis keeps its own observed zero");
  assert.equal(launched.pendingInput, true);
  assert.equal(launched.busy, false, "the standing root request is what this row waits on");
  h.controller.dispose();
});

test("the live order counts, settles from the queue, and unstrands the root as the file appears", async () => {
  const h = await createHarness({ createEmpty: true });
  h.controller.observeOwnedStartup();
  h.hook("SessionStart", { source: "startup" });
  h.hook("UserPromptSubmit", { prompt_id: "prompt-1" });
  // The conversation begins, and with it the provider's own root file.
  await h.append(jsonRow({
    type: "user",
    sessionId: SESSION,
    isSidechain: false,
    message: { role: "user", content: "the prompt the operator submitted" },
  }));
  h.hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tool-a", prompt_id: "prompt-1" });
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  await settle();
  assert.deepEqual(h.gaps, [], "a file that appears mid-run is not a gap either");
  liveLaunch(h);
  assert.equal(h.latest().activeShells, 1, "0 to 1 on the confirmed launch, with the question open");
  assert.equal(h.latest().busy, false);

  // The provider's own queued completion, persisted while the question stands.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", "tool-a"),
  }));
  await waitFor(() => h.latest().activeShells === 0, "the queued completion settles the member");
  const settled = h.latest();
  assert.equal(settled.pendingInput, true, "settlement says nothing about the human's answer");
  assert.equal(settled.busy, false, "and the row is still stopped on that request");

  // The operator declines: the persisted tool_result for that identity is the
  // only close edge, and it restores the turn observed underneath the pause.
  await h.append(rootDeclinedToolResultRow("q-1", SECRET_TASK_DESCRIPTION));
  await waitFor(() => h.latest().pendingInput === false, "the declined request closes on its own edge");
  const restored = h.latest();
  assert.equal(restored.busy, true, "the observed turn returns; nothing fabricated a Ready or a turn end");
  assert.equal(restored.activeShells, 0, "the settled census survives it");
  assert.deepEqual(h.gaps, [], "a healthy run's file lifecycle never became a coverage hole");
  h.controller.dispose();
});

test("a transcript this controller has read from is a real hole the moment it disappears", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h);
  liveLaunch(h);
  await settle();
  assert.equal(h.latest().activeShells, 1);

  // This file existed, was read, and is now gone: rows this run may still need
  // are genuinely unreachable, so the exact census withdraws and says so.
  await fs.rm(h.transcript);
  h.hook("PreToolUse", { tool_name: "Read", tool_use_id: "tool-b", prompt_id: "prompt-1" });
  await waitFor(() => h.latest().activeShells === null, "a file once read and now missing withdraws the census");
  assert.ok(h.gaps.length > 0, `expected the loss to be reported on the transcript lane: ${h.gaps.join(",")}`);
  assert.equal(h.latest().busy, true, "the hook lane's own foreground claim is untouched");
  h.controller.dispose();
});

test("the file's own creation wakes the read, and a completion written before it still settles", async () => {
  const h = await createHarness({ createEmpty: true });
  h.controller.observeOwnedStartup();
  // Every hook — the question and the confirmed launch included — arrives while the
  // provider's root JSONL still does not exist.
  liveOrderHooks(h);
  liveLaunch(h);
  assert.equal(h.latest().activeShells, 1, "the launch counts on the hook lane");
  await settle();
  assert.equal(h.latest().activeShells, 1, "and there is nothing yet to settle it");

  // The conversation's file finally appears, and it already holds this run's rows,
  // completion included. NO further hook is delivered: the creation itself, and
  // the append, are all the notice this run gets.
  await h.append(jsonRow({
    type: "user",
    sessionId: SESSION,
    isSidechain: false,
    message: { role: "user", content: "the prompt the operator submitted" },
  }));
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", "tool-a"),
  }));

  await waitFor(() => h.latest().activeShells === 0,
    "a brand-new file is scanned from its first record, so its completion is never skipped");
  assert.equal(h.latest().pendingInput, true, "settling the member still says nothing about the question");
  assert.equal(h.latest().busy, false, "and the row stays stopped on that standing request");

  // The first successful read gave this file a real size, so the foreground floor
  // that a missing file forced is finite again: a newer root row no hook ever
  // reported still ends the published waiting state.
  await h.append(rootAssistantTextRow());
  await waitFor(() => h.latest().busy === null, "a root model row beyond the first read ends the pause");
  assert.equal(h.latest().pendingInput, true, "without erasing the open request");
  assert.equal(h.latest().activeShells, 0, "or touching the settled census");
  h.controller.dispose();
});

test("a creation watch that cannot be built is reported and fails closed", async () => {
  const h = await createHarness({
    createEmpty: true,
    watchFile: () => { throw new Error("cannot watch"); },
  });
  h.controller.observeOwnedStartup();
  liveOrderHooks(h);
  liveLaunch(h);
  await settle();

  assert.ok(h.gaps.includes("watch-unavailable"),
    `losing the only creation watch is reported: ${h.gaps.join(",")}`);
  assert.equal(h.latest().activeShells, null, "exact membership cannot be defended without it");
  assert.equal(h.latest().pendingInput, true, "the hook lane's question census is untouched");

  // The file shows up afterwards with its completion: nothing observed it, so the
  // answer stays unknown rather than becoming a known count.
  await h.append(jsonRow({
    type: "user",
    sessionId: SESSION,
    isSidechain: false,
    message: { role: "user", content: "the prompt the operator submitted" },
  }));
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", "tool-a"),
  }));
  await settle();
  assert.equal(h.latest().activeShells, null, "an unobserved creation never becomes a known count");
  h.controller.dispose();
});

test("a creation watch that dies after arming withdraws exact counts, not the question", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ createEmpty: true, watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  liveOrderHooks(h);
  liveLaunch(h);
  assert.equal(h.latest().activeShells, 1, "the launch counts while the file is still absent");
  assert.equal(h.latest().busy, false, "with the question standing, the row is published as waiting");
  assert.ok(received.length > 0, "the creation watch was armed");

  // The one mechanism that could learn this file was created is gone.
  received.at(-1)?.onError(new Error("creation watch failed"));
  await settle();

  assert.ok(h.gaps.includes("watch-unavailable"),
    `the dead watch is reported on the transcript lane: ${h.gaps.join(",")}`);
  assert.equal(h.latest().activeShells, null, "a known 1 with no way to observe its end is not kept");
  assert.equal(h.latest().pendingInput, true, "the hook lane's question census survives");
  assert.equal(h.latest().busy, false, "and so does its own foreground claim");

  // Its rows may still land later; none of them may put a number back.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", "tool-a"),
  }));
  await settle();
  assert.equal(h.latest().activeShells, null, "no reconstruction from a lane this controller lost");
  h.controller.dispose();
});

test("a later hook that first notices the created file still reads its completion", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ createEmpty: true, watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  liveOrderHooks(h);
  liveLaunch(h);
  assert.equal(h.latest().activeShells, 1);

  // The file appears with the completion already inside it, and the first thing to
  // act on it is an ordinary hook: no watch callback is delivered at all in this
  // harness, so the hook lane alone must still reach the row that was written
  // before anyone could watch the file.
  await h.append(jsonRow({
    type: "user",
    sessionId: SESSION,
    isSidechain: false,
    message: { role: "user", content: "the prompt the operator submitted" },
  }));
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", "tool-a"),
  }));
  h.hook("PreToolUse", { tool_name: "Read", tool_use_id: "tool-b", prompt_id: "prompt-1" });

  await waitFor(() => h.latest().activeShells === 0,
    "the floor for a file this run waited for starts before its first row");
  h.controller.dispose();
});

test("a launch confirmed during an in-flight read is still resolved against its own row", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  await beginTurn(h);

  // The provider persists the async launch first...
  await h.append(jsonRow({
    type: "user",
    sessionId: SESSION,
    isSidechain: false,
    toolUseResult: { status: "async_launched", agentId: TASK_1, outputFile: SECRET_OUTPUT_FILE },
  }));
  // ...this read starts...
  readNow(received);
  // ...and the confirmation lands while that read is still in flight.
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });

  await waitFor(() => h.latest().activeTasks === 1, "the confirmed launch counts");
  assert.equal(h.latest().activeTasks, 1, "the row read against the older membership set must not withdraw it");
  await settle();
  assert.equal(h.latest().activeTasks, 1, "and no drained reread may withdraw it either");

  // The member's own completion then moves the axis back on its own event.
  await h.append(taskStatusRow(TASK_1, "completed"));
  readNow(received);
  await waitFor(() => h.latest().activeTasks === 0, "the tracked member settles on its own row");
  h.controller.dispose();
});

/* --------------------- independent evidence axes (issue #277 native slice) */

/*
 * Each published category stands or falls on its own evidence. A payload this
 * observer could not read degrades exactly the axes the reducer declares — the
 * root foreground claim and/or the pending-input census — and nothing else: this
 * run's session admission, its live background membership, its last-reported
 * count snapshot, and the transcript lane all survive, because the unreadable
 * field contradicted none of them. A background category is likewise withdrawn at
 * the width its own hole proves: a task-side hole leaves a known shell census
 * exact, and only a hole nobody can attribute (or a genuine lane or scope loss)
 * takes both.
 */

/** A persisted async agent launch for an id this run's census never saw. */
function asyncLaunchRow(agentId: string, extra: Record<string, unknown> = {}): string {
  return jsonRow({
    type: "user",
    sessionId: SESSION,
    isSidechain: false,
    toolUseResult: { status: "async_launched", agentId, outputFile: SECRET_OUTPUT_FILE },
    ...extra,
  });
}

test("a question close hole costs the pending census alone, never the whole lane", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  assert.equal(h.latest().pendingInput, true);
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // The answer arrives and closes its own request: the turn underneath returns.
  h.hook("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  assert.equal(h.latest().pendingInput, false);
  assert.equal(h.latest().busy, true);
  const before = h.latest();
  assert.deepEqual(countsOf(before), { tasks: 0, shells: 1 });

  // A second close edge for a request this run never opened (the identity it
  // carried did not match this scope's open request). That is a hole in the
  // pending-input census and NOTHING else.
  h.hook("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-never-opened", prompt_id: "prompt-1" });
  const after = h.latest();
  assert.equal(after.pendingInput, null, "the census is unknown, as the reducer declared");
  assert.equal(after.busy, true, "the observed turn underneath is untouched");
  assert.deepEqual(after.activity, before.activity, "no activity claim is withdrawn");
  assert.deepEqual(countsOf(after), { tasks: 0, shells: 1 }, "a question edge is not a membership edge");
  assert.deepEqual(h.gaps, [], "no source lane was lost, so no lane gap is reported");

  // The run's own session admission survives: another native conversation still
  // cannot publish foreign state here.
  const snapshotsBefore = h.snapshots.length;
  h.hook("UserPromptSubmit", { session_id: OTHER_SESSION, prompt_id: "foreign-prompt" });
  h.hook("Stop", { session_id: OTHER_SESSION, background_counts: { tasks: 9, shells: 9 } });
  assert.equal(h.snapshots.length, snapshotsBefore, "a foreign conversation publishes nothing here");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // And the lane still works: a fresh membership edge still moves its own axis,
  // while the unknown input answer stays unknown (no fabricated `false`).
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-b",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  const moved = h.latest();
  assert.deepEqual(countsOf(moved), { tasks: 1, shells: 1 });
  assert.equal(moved.pendingInput, null, "a membership edge does not re-vouch the census");
  h.controller.dispose();
});

test("a typed root foreground invalidation taints only its genuinely proven axes", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tool-a", prompt_id: "prompt-1" });
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });
  assert.deepEqual(h.latest().activity, ["bash"]);

  // A root tool edge whose own tool name cannot be read: the foreground claim and
  // the pending census are what that payload would have supported, so those go
  // unknown. Membership, scope, and the transcript lane are not in its reach.
  h.hook("PreToolUse", { tool_name: "Bash rm -rf /secret-working-directory", tool_use_id: "tool-x" });
  const after = h.latest();
  assert.equal(after.busy, null, "the foreground claim the payload would have supported is unknown");
  assert.deepEqual(after.activity, []);
  assert.equal(after.pendingInput, null);
  assert.deepEqual(countsOf(after), { tasks: 0, shells: 1 }, "the payload said nothing about membership");
  assert.ok(!h.gaps.includes("hook-failure"), "an unreadable field is not an authenticated lane loss");

  // Trusted membership edges are still consumed under the same root/scope guards.
  h.hook("PostToolUse", {
    tool_name: "Agent",
    tool_use_id: "tool-b",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  // Foreign and child edges still cannot touch this run.
  const snapshotsBefore = h.snapshots.length;
  h.hook("UserPromptSubmit", { session_id: OTHER_SESSION, prompt_id: "foreign-prompt" });
  h.hook("PostToolUse", {
    agent_id: "agent-9",
    tool_name: "Bash",
    tool_use_id: "tool-child",
    background_started: { id: "bneverlaun", kind: "shell" },
  });
  assert.equal(h.snapshots.length, snapshotsBefore);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  // This run's own complete census still resyncs it exactly.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 0 },
    background_members: [],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });
  h.controller.dispose();
});

test("an unresolvable task-side transition leaves an independently known shell census", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  for (const [toolUseId, id] of [["tool-a", SHELL_1], ["tool-b", "b0zzzzzzzz"]] as const) {
    h.hook("PostToolUse", {
      tool_name: "Bash",
      tool_use_id: toolUseId,
      prompt_id: "prompt-1",
      background_started: { id, kind: "shell" },
    });
  }
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-c",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 2 });

  // The provider persisted an async agent launch this run's hook lane never
  // reported. That positively names a TASK-side hole: the shells it says nothing
  // about keep their exact number.
  await h.append(asyncLaunchRow("a9z9z9z9z"));
  await waitFor(() => h.latest().activeTasks === null, "the task category withdraws on its own hole");
  const after = h.latest();
  assert.equal(after.activeTasks, null);
  assert.equal(after.activeShells, 2, "a task-side hole never erases a known shell census");
  assert.equal(after.busy, true, "nor the foreground the hook lane observed");

  // A complete authoritative census repairs the affected category.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 1, shells: 2 },
    background_members: [
      { id: SHELL_1, kind: "shell" },
      { id: "b0zzzzzzzz", kind: "shell" },
      { id: TASK_1, kind: "task" },
    ],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 2 });
  h.controller.dispose();
});

test("an unkeyable shell in the provider snapshot leaves the task census exact", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  for (const [toolUseId, id] of [["tool-b", SHELL_1], ["tool-c", "b0zzzzzzzz"]] as const) {
    h.hook("PostToolUse", {
      tool_name: "Bash",
      tool_use_id: toolUseId,
      prompt_id: "prompt-1",
      background_started: { id, kind: "shell" },
    });
  }
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 2 });

  // The provider's own root snapshot held an active shell it could not key, and
  // named the SHELL category. Tasks are stated identically, so they stand; the
  // shell category loses both its ledger coverage and its last-reported number,
  // because an unkeyable member cannot be settled by any later shell edge.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 1, shells: 3 },
    background_unidentified_kinds: ["shell"],
  });
  const after = h.latest();
  assert.equal(after.activeTasks, 1, "the category the gap does not name keeps its exact number");
  assert.equal(after.activeShells, null, "the unkeyable category is unknown, never a stale 2 or a 3");

  // The surviving category is still a LIVE exact census, not a frozen number:
  // its own next edge moves it, while the gapped category stays unknown.
  h.hook("PostToolUse", {
    tool_name: "Agent",
    tool_use_id: "tool-d",
    prompt_id: "prompt-1",
    background_started: { id: TASK_2, kind: "task" },
  });
  const moved = h.latest();
  assert.deepEqual(countsOf(moved), { tasks: 2, shells: null });

  // The next complete census states the whole set again.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 1, shells: 3 },
    background_members: [
      { id: TASK_1, kind: "task" },
      { id: SHELL_1, kind: "shell" },
      { id: "b0zzzzzzzz", kind: "shell" },
      { id: "b3k3n1p4q", kind: "shell" },
    ],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 3 });
  h.controller.dispose();
});

test("a genuine whole-lane loss still withdraws both categories", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-b",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  // Half the census already unknown from a task-side hole...
  await h.append(asyncLaunchRow("a9z9z9z9z"));
  await waitFor(() => h.latest().activeTasks === null, "the task category withdraws first");
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 1 });

  // ...and a real authenticated lane loss still takes everything the lane
  // supported. Per-category independence never weakens a genuine loss.
  h.controller.acceptFailure({ backend: "claude", reason: "input-too-large" });
  const after = h.latest();
  assert.ok(h.gaps.includes("hook-failure"));
  assert.deepEqual(countsOf(after), { tasks: null, shells: null });
  assert.equal(after.busy, null);
  assert.equal(after.pendingInput, null);

  // The provider's next complete census rebuilds both categories exactly.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 1 },
    background_members: [{ id: SHELL_1, kind: "shell" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });
  h.controller.dispose();
});

test("duplicate, stale, foreign, and child edges never contradict the other category", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  for (const [toolUseId, id] of [["tool-a", SHELL_1], ["tool-b", "b0zzzzzzzz"]] as const) {
    h.hook("PostToolUse", {
      tool_name: "Bash",
      tool_use_id: toolUseId,
      prompt_id: "prompt-1",
      background_started: { id, kind: "shell" },
    });
  }
  await h.append(asyncLaunchRow("a9z9z9z9z"));
  await waitFor(() => h.latest().activeTasks === null, "a proven task-side hole opens");
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 2 });

  // One tracked shell settles exactly; the unknown category stays unknown and the
  // known one moves on its own evidence.
  await h.append(taskStatusRow(SHELL_1, "completed"));
  await waitFor(() => h.latest().activeShells === 1, "the tracked member settles on its own row");
  assert.equal(h.latest().activeTasks, null);

  // The same settlement again: idempotent. A duplicate of a settlement this run
  // positively observed must never become a hole, in either category.
  await h.append(taskStatusRow(SHELL_1, "completed"));
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 1 }, "a duplicate settle opens no hole");

  // A child snapshot, a foreign conversation's census, and a stale-prompt edge are
  // not this run's membership evidence at all.
  const snapshotsBefore = h.snapshots.length;
  h.hook("SubagentStop", {
    agent_id: "agent-9",
    background_counts: { tasks: 0, shells: 0 },
    background_members: [],
  });
  h.hook("Stop", {
    session_id: OTHER_SESSION,
    background_counts: { tasks: 0, shells: 0 },
    background_members: [],
  });
  h.hook("PreToolUse", { tool_name: "Read", tool_use_id: "tool-old", prompt_id: "prompt-older" });
  assert.equal(h.snapshots.length, snapshotsBefore, "none of them publishes anything here");
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 1 });

  // A complete authoritative census repairs BOTH categories at once.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 1, shells: 1 },
    background_members: [{ id: TASK_1, kind: "task" }, { id: "b0zzzzzzzz", kind: "shell" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });
  h.controller.dispose();
});

/* ------------------- axis-scoped invalid edges keep their own evidence (pass 1) */

/*
 * A payload this observer could not read degrades the reducer's own axes and
 * nothing else. These pin the three ways that boundary was still leaking: a
 * membership projection carried by the same degraded payload was dropped with it;
 * a foreground hole left a previously armed terminal pass alive, so a summary that
 * surfaced later could publish `Ready` over the newer root edge; and a proven
 * membership edge cleared the last-reported totals of the category it never
 * touched. A degraded payload is still not a licence: an event that cannot be
 * attributed, or a projection that cannot be read, still advances nothing.
 */

test("an unreadable tool identity still consumes the launch that same payload states", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });

  // One real background launch projection with a request identity this observer
  // cannot read. The reducer degrades the axes that identity supported; the launch
  // it positively states is still this run's fact, and a census that stayed
  // known-empty would now be a lie.
  h.hook("PostToolUse", {
    tool_name: "Bash",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  const after = h.latest();
  assert.deepEqual(countsOf(after), { tasks: 0, shells: 1 }, "the positively stated shell launch counts");
  assert.equal(after.busy, null, "the foreground the unreadable identity supported degrades");
  assert.equal(after.pendingInput, null, "and so does the census that identity supported");

  // A projection this run cannot read is not consumed on the strength of the
  // payload around it: no category moves, and nothing is invented.
  h.hook("PostToolUse", {
    tool_name: "Bash",
    prompt_id: "prompt-1",
    background_started: { id: " ", kind: "not-a-kind" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // A child's own launch is not this run's root membership, degraded or not.
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-child",
    agent_id: "agent-9",
    background_started: { id: TASK_1, kind: "task" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 }, "a child edge never joins the root census");
  assert.deepEqual(h.gaps, [], "a degraded payload is not a lane loss");
  h.controller.dispose();
});

test("a foreground hole retires the armed terminal pass before a later summary can close the turn", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 0, shells: 0 } });
  await settle();
  assert.equal(h.latest().busy, true, "the observed turn stands at the unproven boundary");

  // A root tool edge whose own name this observer cannot read: the foreground
  // axis degrades, and with it this run's authority to treat a summary read later
  // as that turn's terminal record. The membership snapshot this Stop carried is
  // not part of that judgement.
  h.hook("PreToolUse", { tool_name: `Bash ${SECRET_OUTPUT_FILE}`, tool_use_id: "tool-x", prompt_id: "prompt-1" });
  await settle();
  assert.equal(h.latest().busy, null);
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 }, "the hook census survives the foreground hole");

  await h.append(summaryRow());
  await settle();
  assert.equal(
    h.snapshots.some((snapshot) => snapshot.activity.includes("Ready")),
    false,
    "a summary cannot publish Ready over the newer root boundary",
  );
  assert.equal(h.latest().busy, null);
  h.controller.dispose();
});

test("a confirmed launch clears the last-reported totals of its own category only", async () => {
  // Totals that disagree with what this ledger can state put the hole exactly on
  // the category they disagree about, and become that category's last-reported
  // number.
  const taskFirst = await createHarness();
  taskFirst.controller.observeOwnedStartup();
  await beginTurn(taskFirst, "prompt-1");
  taskFirst.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 0, shells: 2 } });
  assert.deepEqual(countsOf(taskFirst.latest()), { tasks: 0, shells: 2 });

  // A confirmed TASK launch is a task-side membership edge. The ledger carries
  // tasks from here; the shells this edge says nothing about keep their number.
  taskFirst.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-t",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  assert.deepEqual(countsOf(taskFirst.latest()), { tasks: 1, shells: 2 },
    "a task launch never erases an independently known shell census");

  // The same holds for a task-side hole read from the transcript rather than a
  // hook: the fallback-backed shell number is not collateral.
  await taskFirst.append(asyncLaunchRow("a9z9z9z9z"));
  await waitFor(() => taskFirst.latest().activeTasks === null, "the task category withdraws on its own hole");
  assert.equal(taskFirst.latest().activeShells, 2, "and the fallback-backed shells stay published");
  taskFirst.controller.dispose();

  // The mirror image: a shell-side hole with an exact task total behind it, then
  // a confirmed SHELL launch.
  const shellFirst = await createHarness();
  shellFirst.controller.observeOwnedStartup();
  await beginTurn(shellFirst, "prompt-1");
  shellFirst.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 2, shells: 0 } });
  assert.deepEqual(countsOf(shellFirst.latest()), { tasks: 2, shells: 0 });
  shellFirst.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-s",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(shellFirst.latest()), { tasks: 2, shells: 1 },
    "a shell launch never erases an independently known task census");
  shellFirst.controller.dispose();
});

test("a partial census never rides a scope boundary as if it were whole", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  // An async launch this run's hook lane never reported: the TASK category loses
  // its coverage, and only that one.
  await h.append(asyncLaunchRow("a9z9z9z9z"));
  await waitFor(() => h.latest().activeTasks === null, "the task category withdraws");
  assert.equal(h.latest().activeShells, 1);

  // The tracked shell settles on its own row, so the member map is now EMPTY and
  // shells reads exactly 0 — a partial pair, not a census.
  await h.append(taskStatusRow(SHELL_1, "completed"));
  await waitFor(() => h.latest().activeShells === 0, "the tracked shell settles on its own row");
  assert.equal(h.latest().activeTasks, null, "and the task hole is still there");

  // A genuine boundary this observer cannot see through withdraws BOTH categories.
  // Carrying the surviving exact zero into the new scope would present a hole in
  // the old one as a census in the new one.
  h.hook("SessionStart", { session_id: OTHER_SESSION, source: "clear" });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null });
  h.controller.dispose();
});

/* ---------------- settlement and launch evidence, derived from the ledger (pass 2) */

/*
 * Whether a membership edge contradicts a last-reported totals snapshot is decided
 * by what the ledger actually did with it. A settlement the ledger applied is
 * membership change in that member's own category; a settlement it cannot
 * attribute to one of its members proves a launch this run missed, which no row
 * names, so it reaches both categories; and a repeat of an edge already applied is
 * not news at all and may not delete a snapshot the provider stated afterwards.
 * A present-but-unreadable agent identity is malformed scope, not root.
 */

test("a settlement this ledger cannot attribute reaches both categories beside a named one", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  // A shell total this run can only hold as a last-reported number: it disagrees
  // with the exact ledger census, so shells lose their ledger coverage and 2 is the
  // fallback. A confirmed task launch then makes the task side exact again.
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 0, shells: 2 } });
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-t",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 2 });

  // One window carries BOTH the tracked task's own completion and a completion for
  // an id this run never saw start. The second proves a lost launch nobody can
  // attribute, so the fallback-backed shells go with the tasks rather than
  // republishing a number that hole could contradict.
  await h.append(taskStatusRow(TASK_1, "completed") + taskStatusRow("bzzzzzzzz", "completed"));
  readNow(received);
  await waitFor(
    () => h.latest().activeTasks === null && h.latest().activeShells === null,
    "an unattributable settlement reaches both categories",
  );
  h.controller.dispose();
});

test("a duplicate settlement is not membership change and never clears a fallback census", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 0, shells: 2 } });
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-t",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 2 });

  // The tracked task settles on its own row: the task side moves to the ledger's
  // exact 0, and the shell fallback is untouched because nothing about shells
  // changed.
  await h.append(taskStatusRow(TASK_1, "completed"));
  readNow(received);
  await waitFor(() => h.latest().activeTasks === 0, "the tracked task settles on its own row");
  assert.equal(h.latest().activeShells, 2);

  // The same completion surfacing again repeats an edge already applied. It is not
  // membership change, so the provider's last-reported shell number stands.
  await h.append(taskStatusRow(TASK_1, "completed"));
  readNow(received);
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 2 });
  assert.equal(
    h.snapshots.some((snapshot) => snapshot.activeShells === null),
    false,
    "no snapshot ever published an unknown shell census",
  );
  h.controller.dispose();
});

test("a replayed launch never deletes a totals snapshot that arrived after it", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-t",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });

  // A newer provider snapshot restates the task side. The ledger's exact 1
  // disagrees, so the task category loses ledger coverage and 5 becomes this run's
  // last-reported task number.
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 5, shells: 0 } });
  assert.deepEqual(countsOf(h.latest()), { tasks: 5, shells: 0 });

  // The same member's launch edge arriving again is idempotent evidence: the ledger
  // refuses it as a duplicate, and a refusal is not membership change.
  h.hook("PostToolUse", {
    tool_name: "Task",
    tool_use_id: "tool-t",
    prompt_id: "prompt-1",
    background_started: { id: TASK_1, kind: "task" },
  });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 5, shells: 0 });
  assert.equal(
    h.snapshots.some((snapshot) => snapshot.activeTasks === null),
    false,
    "no snapshot ever published an unknown task census",
  );
  h.controller.dispose();
});

test("a present-but-unreadable agent identity is not root scope: no membership, no rebinding", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });

  const elsewhere = path.join(h.dir, "other-transcript.jsonl");
  await fs.writeFile(elsewhere, priorHistory(), "utf8");
  // A whitespace agent identity is malformed scope to the landed reducer, and
  // acquisition agrees: only an ABSENT identity is this run's root. So this event
  // neither joins the root census nor moves this run's transcript binding.
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-m",
    prompt_id: "prompt-1",
    agent_id: " ",
    background_started: { id: TASK_1, kind: "task" },
    transcript_path: elsewhere,
  });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 }, "no membership admission");

  // The binding is still the original file: a completion persisted there settles
  // this run's shell, which a rebound scope could not do.
  await h.append(taskStatusRow(SHELL_1, "completed"));
  await waitFor(() => h.latest().activeShells === 0, "the original transcript is still this run's source");
  h.controller.dispose();
});

/* ---------------------------------- live Claude agent lifetime in the counts */

/*
 * The published task figure answers "which agents of this run are alive", not
 * "which ids does the provider currently list as in flight". Claude Code 2.1.325
 * excludes an agent whose own model turn has ended while it still owns background
 * work from EVERY `background_tasks` array it emits — on `Stop` and on
 * `SubagentStop` alike — so an in-flight-only census drops a live agent at its
 * park edge and never brings it back. These tests replay the observed native
 * child lifecycle in the closed shapes the provider actually produces, and pin
 * the corrected outcome: one agent is one task from its own start edge until its
 * own end is positively established; the shell it launched is a shell and never a
 * second task; the wake and the same-id resume never duplicate it; and one
 * agent's end never touches an unrelated root shell, another live agent, or the
 * run's independent foreground and question axes.
 */

const AGENT_A = "aaacc46163";
const AGENT_D = "dd00agent04";
const CHILD_TOOL_USE = "21e731036d";

/** One child-scoped agent edge, as the provider emits it for this run's root. */
function childHook(h: Harness, name: string, agentId: string, extra: Record<string, unknown> = {}): void {
  h.hook(name, { agent_id: agentId, ...extra });
}

test("one live agent is one task from its start through park, wake, and its own end", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 }, "fresh owned run");

  // The provider launches A and its own start edge lands: A is live.
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "a positive agent start is one task");
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 1, shells: 0 },
    background_members: [{ id: AGENT_A, kind: "task" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });

  // A starts ONE background shell. The shell is a shell: one task, one shell —
  // never two tasks.
  childHook(h, "PreToolUse", AGENT_A, { tool_name: "Bash", tool_use_id: CHILD_TOOL_USE });
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, "A owns B; B is not a second task");

  // A's turn ends while B is still running. That is a park, not a death.
  childHook(h, "SubagentStop", AGENT_A, {
    background_counts: { tasks: 1, shells: 1 },
    background_members: [{ id: AGENT_A, kind: "task" }, { id: SHELL_1, kind: "shell" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, "parking keeps A counted");

  // The next ROOT snapshot is session-wide and lists B only. Absence from an
  // in-flight census is never evidence of death.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 1 },
    background_members: [{ id: SHELL_1, kind: "shell" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, "A stays counted while its shell runs");

  // B finishes. The provider persists its own completion record in this run's
  // root journal, and it is routed back into A: A becomes a pending wake.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", CHILD_TOOL_USE),
  }));
  await waitFor(() => countsOf(h.latest()).shells === 0, "B settles on its own record");
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "a pending wake is still one live agent");

  // The SAME id resumes. One agent, still one task.
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "reentry never duplicates the agent");

  // A's final turn ends with only A's own self-membership in the payload, so it
  // owns nothing pending. One conjunct is not an end: A is still counted.
  childHook(h, "SubagentStop", AGENT_A, {
    background_counts: { tasks: 0, shells: 0 },
    background_members: [{ id: AGENT_A, kind: "task" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "a clean boundary alone never ends A");

  // A's own fresh completion is emitted in the same execution window. That is the
  // end of A, and of the census.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(AGENT_A, "completed", "tool-a-final"),
  }));
  await waitFor(() => countsOf(h.latest()).tasks === 0, "A's own completion closes A");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });
  h.controller.dispose();
});

test("an agent ends on its own child evidence even while no root turn ever returns", async () => {
  // The observed panel-open trace: exactly one root `Stop` exists (the root's
  // initial turn), and after that the root is never woken again — A's two
  // completions are enqueued and never delivered, and there is no later root
  // snapshot. An agent's end must not be gated on the root noticing.
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 1, shells: 0 },
    background_members: [{ id: AGENT_A, kind: "task" }],
  });
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  childHook(h, "SubagentStop", AGENT_A, {
    background_members: [{ id: AGENT_A, kind: "task" }, { id: SHELL_1, kind: "shell" }],
  });
  // A's park-edge completion is enqueued and never delivered. It belongs to the
  // first execution window, so it can neither end A nor later close the resumed
  // window.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(AGENT_A, "completed", "tool-a-park"),
  }));
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, "A parks on its own shell");

  // B settles and is routed back into A; A wakes with the same id.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", CHILD_TOOL_USE),
  }));
  await waitFor(() => countsOf(h.latest()).shells === 0, "B settles");
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "A wakes on its own evidence");
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });

  // A's final completion is enqueued and, like the first, never delivered to the
  // root. Its emission is enough: no root delivery, root Stop, or empty session
  // snapshot is required, and none of them ever arrives.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(AGENT_A, "completed", "tool-a-final"),
  }));
  await waitFor(() => countsOf(h.latest()).tasks === 0, "A's own emission closes A with no root turn");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });
  h.controller.dispose();
});

test("one agent's end removes only that agent, never a root shell or a sibling", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  // A root-launched shell, a second live agent, and A all coexist.
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-root-shell",
    prompt_id: "prompt-1",
    background_started: { id: "brootshell", kind: "shell" },
  });
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "SubagentStart", AGENT_D);
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 2, shells: 2 });

  // A's own shell settles. A is still live (a pending wake is a counted state),
  // and nothing else moved.
  await h.append(taskStatusRow(SHELL_1, "completed"));
  await waitFor(() => countsOf(h.latest()).shells === 1, "A's shell settles on its own row");
  assert.deepEqual(countsOf(h.latest()), { tasks: 2, shells: 1 });

  // A ends cleanly. D never reached a turn boundary and the root shell never
  // settled, so both stay counted, exactly as they were.
  childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
  await h.append(taskStatusRow(AGENT_A, "completed"));
  await waitFor(() => countsOf(h.latest()).tasks === 1, "only A leaves the count");
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, "D and the root shell are untouched");

  // D's own end is D's own evidence, and it lands independently.
  childHook(h, "SubagentStop", AGENT_D, { background_members: [{ id: AGENT_D, kind: "task" }] });
  await h.append(taskStatusRow(AGENT_D, "cancelled"));
  await waitFor(() => countsOf(h.latest()).tasks === 0, "D closes on its own record");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 }, "the root shell outlives both agents");
  h.controller.dispose();
});

test("a root question and a live agent stay independent in both directions", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  assert.equal(h.latest().pendingInput, true);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  // A parks while the human still has not answered. A waiting question is not a
  // death, and a death is not a waiting question.
  childHook(h, "SubagentStop", AGENT_A, {
    background_members: [{ id: AGENT_A, kind: "task" }, { id: SHELL_1, kind: "shell" }],
  });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });
  assert.equal(h.latest().pendingInput, true, "the open request still stands");

  // The child's own evidence closes it without waiting for the question, the
  // answer, or a new prompt.
  await h.append(taskStatusRow(SHELL_1, "completed"));
  await waitFor(() => countsOf(h.latest()).shells === 0, "the shell settles with the question open");
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
  await h.append(taskStatusRow(AGENT_A, "failed"));
  await waitFor(() => countsOf(h.latest()).tasks === 0, "a typed failure closes A on its own axis");
  const after = h.latest();
  assert.equal(after.pendingInput, true, "the question the child says nothing about still stands");
  assert.deepEqual(countsOf(after), { tasks: 0, shells: 0 });
  h.controller.dispose();
});

test("a delayed or replayed completion for an earlier turn cannot close a resumed one", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  childHook(h, "SubagentStop", AGENT_A, {
    background_members: [{ id: AGENT_A, kind: "task" }, { id: SHELL_1, kind: "shell" }],
  });

  // The park-edge completion and the shell's completion both land while A is
  // parked: neither can end it.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(AGENT_A, "completed", "tool-a-park"),
  }));
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", CHILD_TOOL_USE),
  }));
  await waitFor(() => countsOf(h.latest()).shells === 0, "B settles");
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "A is a pending wake, not an end");

  // A resumes. Its clean boundary alone is not an end, because the completion
  // this observer already read belonged to the superseded window.
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "the old completion cannot close A");

  // Only a typed root-queue EMISSION is a completion witness. A `dequeue` (the
  // queued text was merely handed over), a provider request-replay row, and a
  // queue record written under the CHILD conversation all claim nothing, so one
  // completion is never inflated into several and a child-scoped record can never
  // close this run's agent.
  await h.append(queueOperationRow("dequeue"));
  await h.append(jsonRow({
    type: "queue-operation",
    operation: "enqueue",
    agentId: AGENT_A,
    sessionId: SESSION,
    content: taskNotificationEnvelope(AGENT_A, "completed", "tool-a-child"),
  }));
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "none of those is a completion");

  // The resumed window's own emission, at its own distinct journal offset, is
  // what closes it.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(AGENT_A, "completed", "tool-a-final"),
  }));
  await waitFor(() => countsOf(h.latest()).tasks === 0, "the resumed window's own emission closes it");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });
  h.controller.dispose();
});

test("child edges that are not this run's known agent are inert, and never a hole", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-root-shell",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });
  const published = h.snapshots.length;

  // An identity this run's own start evidence never named, another native
  // conversation's child, and a child naming a child transcript are all
  // unattributable here: they add no agent, erase no census, and open no hole.
  childHook(h, "SubagentStop", "agent-unknown", { background_members: [] });
  childHook(h, "PostToolUse", "agent-unknown", {
    tool_name: "Bash",
    tool_use_id: "tool-x",
    background_started: { id: "bneverseen", kind: "shell" },
  });
  h.hook("SubagentStart", { agent_id: AGENT_A, session_id: OTHER_SESSION });
  h.hook("PostToolUse", {
    agent_id: AGENT_A,
    tool_name: "Bash",
    tool_use_id: "tool-y",
    transcript_path: `${h.transcript}.child`,
    background_started: { id: "balsonever", kind: "shell" },
  });
  await settle();
  assert.equal(h.snapshots.length, published, "none of them publishes anything here");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 });
  assert.deepEqual(h.gaps, [], "an unattributable child edge is not a source hole");

  // Once the provider names A's start, its own launch edge on this run's root
  // session and file is admitted, and it is admitted once.
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });
  for (const toolUseId of ["tool-a1", "tool-a2"]) {
    childHook(h, "PostToolUse", AGENT_A, {
      tool_name: "Bash",
      tool_use_id: toolUseId,
      background_started: { id: "bchildshell", kind: "shell" },
    });
  }
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 2 }, "one launch edge per member");
  h.controller.dispose();
});

test("a live agent never borrows a withdrawn category, and never loses the other", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  for (const [toolUseId, id] of [["tool-a", SHELL_1], ["tool-b", "b0zzzzzzzz"]] as const) {
    h.hook("PostToolUse", {
      tool_name: "Bash",
      tool_use_id: toolUseId,
      prompt_id: "prompt-1",
      background_started: { id, kind: "shell" },
    });
  }
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 2 });

  // A task-side hole the provider itself names withdraws TASKS only. The live
  // agent is a task, so it goes unknown with the category — and the exact shell
  // census keeps standing.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 1, shells: 2 },
    background_unidentified_kinds: ["task"],
  });
  const taskHoled = h.latest();
  assert.equal(taskHoled.activeTasks, null);
  assert.equal(taskHoled.activeShells, 2, "a task-side hole never erases a known shell census");

  // The inverse: a shell-side hole leaves the live-agent task count exact.
  const shellFirst = await createHarness();
  shellFirst.controller.observeOwnedStartup();
  await beginTurn(shellFirst, "prompt-1");
  childHook(shellFirst, "SubagentStart", AGENT_A);
  shellFirst.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-c",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(shellFirst.latest()), { tasks: 1, shells: 1 });
  shellFirst.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 3 },
    background_unidentified_kinds: ["shell"],
  });
  const shellHoled = shellFirst.latest();
  assert.equal(shellHoled.activeTasks, 1, "the agent this run positively started stays one task");
  assert.equal(shellHoled.activeShells, null);

  // A genuine whole-lane loss still takes both.
  shellFirst.controller.acceptFailure({ backend: "claude", reason: "input-too-large" });
  assert.deepEqual(countsOf(shellFirst.latest()), { tasks: null, shells: null });
  h.controller.dispose();
  shellFirst.controller.dispose();
});

test("a scope boundary clears the live agent census it cannot carry across", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  // A brand-new conversation inherits no agent lifetime. Carrying A over would
  // present a hole in the old scope as a census in the new one.
  h.hook("SessionStart", { session_id: OTHER_SESSION, source: "clear" });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null });

  // The provider's own complete empty census rebuilds the pair exactly, with no
  // ghost of the previous conversation's agent.
  h.hook("Stop", {
    session_id: OTHER_SESSION,
    background_counts: { tasks: 0, shells: 0 },
    background_members: [],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });
  h.controller.dispose();
});

/**
 * Review regressions: the four ways a live-agent count can be WRONG rather than
 * merely coarse, each replayed as a deterministic manual watch — evidence that
 * arrives late, evidence that arrives twice, a provider total that cannot contain
 * the agent it is published beside, and a source that goes away while an agent is
 * still counted. Plus the named child transcript the provider hands over on a
 * child's own boundary, and the scope boundary that must not clear a live agent as
 * though the census had been empty.
 *
 * None of these turns on a timer, a quiet interval, or prose in a transcript: each
 * one is decided by file position, request identity, or a positively stated
 * provider total.
 */

test("a completion read late cannot close the execution window that did not produce it", async () => {
  // Nothing reads the journal until this test says so, which is what lets rows
  // written long before an agent's resumed window be consumed long after it.
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  childHook(h, "SubagentStop", AGENT_A, {
    background_members: [{ id: AGENT_A, kind: "task" }, { id: SHELL_1, kind: "shell" }],
  });

  // Two rows are appended while no read happens: A's PARK-edge completion, then
  // B's. Both were produced by the first execution window.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(AGENT_A, "completed", "tool-a-park"),
  }));
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", CHILD_TOOL_USE),
  }));
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, "nothing has been read yet");

  // The SAME agent resumes. Its new window's floor is where this file stands at
  // this instant — past both rows above.
  childHook(h, "SubagentStart", AGENT_A);
  readNow(received);
  await waitFor(() => countsOf(h.latest()).shells === 0, "B settles from its own row");
  // B's row settles B. A's park-edge completion was written before this window
  // opened, so consuming it now is not evidence that this window ended: A is a
  // pending wake, and the count is never the premature 0/0.
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "a late old completion never ends a resumed agent");

  // A's final turn ends owning nothing. One conjunct is still not an end.
  childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "a clean boundary alone never ends A");

  // A's FINAL completion, written after this window opened, closes it.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(AGENT_A, "completed", "tool-a-final"),
  }));
  readNow(received);
  await waitFor(() => countsOf(h.latest()).tasks === 0, "the completion from this window closes A");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });
  h.controller.dispose();
});

test("a replayed child tool result resurrects no agent and re-owns no settled member", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  childHook(h, "SubagentStop", AGENT_A, {
    background_members: [{ id: AGENT_A, kind: "task" }, { id: SHELL_1, kind: "shell" }],
  });
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(SHELL_1, "completed", CHILD_TOOL_USE),
  }));
  await waitFor(() => countsOf(h.latest()).shells === 0, "B settles");
  childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(AGENT_A, "completed", "tool-a-final"),
  }));
  await waitFor(() => countsOf(h.latest()).tasks === 0, "A ends on its own completion");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });

  // A's ORIGINAL Bash result arrives a second time, long after both the agent and
  // the member it launched are done. One request identity, already consumed: it is
  // not a newer execution edge, so it reopens no window, resurrects no agent, and
  // hands ownership of a long-settled member to nobody.
  const before = h.snapshots.length;
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  childHook(h, "PreToolUse", AGENT_A, { tool_name: "Bash", tool_use_id: CHILD_TOOL_USE });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 }, "a replayed result resurrects nothing");
  assert.equal(h.snapshots.length, before, "a replayed result states nothing new about membership");
  h.controller.dispose();
});

test("a totals snapshot is not published beside a live agent it cannot be reconciled with", async () => {
  // A mid-stream observer: it adopted this run, so it cannot state exact
  // membership, and the provider's own totals are all it has.
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { background_counts: { tasks: 0, shells: 0 } });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 }, "an adopted scope publishes the provider's own totals");

  // A positively observed agent start. The provider's total counts work currently
  // in flight, and this run now holds an agent no later snapshot has ever shown
  // ending. Whether that total already contains it is not knowable from the number,
  // so the task axis is withdrawn while the shell total stands.
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: null, shells: 0 },
    "an unreconcilable total is withdrawn on the task axis only",
  );
  h.controller.dispose();

  // Numerical capacity is not membership evidence. A total large enough to CONTAIN
  // the agent proves nothing about whether it does: the two agents already counted
  // may or may not include A, and an observer that published 2 here would be
  // asserting an overlap it never saw.
  const bigger = await createHarness();
  await beginTurn(bigger, "prompt-1");
  bigger.hook("Stop", { background_counts: { tasks: 2, shells: 2 } });
  assert.deepEqual(countsOf(bigger.latest()), { tasks: 2, shells: 2 });
  childHook(bigger, "SubagentStart", AGENT_A);
  assert.deepEqual(
    countsOf(bigger.latest()),
    { tasks: null, shells: 2 },
    "a total that could contain the agent still cannot be reconciled with it",
  );
  bigger.controller.dispose();
});

test("a source gap keeps a live agent counted but never restores it as an exact count", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });

  // The authenticated lane is lost. Whether A ended, parked, or was woken during
  // the hole is unknowable, so nothing publishes.
  h.controller.acceptFailure({ backend: "claude", reason: "input-malformed" });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null });

  // A complete root census repairs the LEDGER — the provider positively states that
  // nothing is in flight. It says nothing about an agent this observer stopped
  // seeing mid-gap, so A is neither deleted nor republished as a stale exact 1.
  h.hook("Stop", { background_counts: { tasks: 0, shells: 0 }, background_members: [] });
  await settle();
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: null, shells: 0 },
    "a preserved identity across a gap is not an exact live census",
  );

  // That agent's OWN lane arriving again is the agent-specific recovery evidence:
  // its lifetime is observable from here, and the count becomes exact again.
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });
  h.controller.dispose();
});

test("a scope boundary never clears a lone live agent as an empty census", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  // A live agent and NOTHING in the ledger's own map: the ledger alone would call
  // this census whole and empty.
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });

  h.hook("SessionStart", { session_id: OTHER_SESSION, source: "clear" });
  await settle();
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: null, shells: null },
    "a live agent is part of the census the boundary cannot carry",
  );
  h.controller.dispose();
});

test("a named child transcript routes a completion the root journal never records", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  const childFile = path.join(h.dir, "agent-child.jsonl");
  await fs.writeFile(childFile, "", "utf8");
  childHook(h, "SubagentStop", AGENT_A, {
    background_members: [{ id: AGENT_A, kind: "task" }, { id: SHELL_1, kind: "shell" }],
    agent_transcript_path: childFile,
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, "A parks on its own shell");

  // The provider delivers B's completion into A's OWN transcript as a conversation
  // record — the envelope lives inside `message.content` — and never writes the
  // root journal's row for it. A root append is what reaches the child lane.
  await fs.appendFile(childFile, jsonRow({
    type: "user",
    isMeta: true,
    sessionId: SESSION,
    agentId: AGENT_A,
    message: { role: "user", content: taskNotificationEnvelope(SHELL_1, "completed", CHILD_TOOL_USE) },
  }), "utf8");
  await h.append(queueOperationRow("remove", { reason: "delivered_to_agent" }));
  await waitFor(() => countsOf(h.latest()).shells === 0, "the child lane settles the routed work");
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "a routed delivery wakes A, it never ends A");
  h.controller.dispose();
});

test("a child transcript record that is not this agent's delivery settles nothing", async () => {
  // The same lane, shown refusing the shapes that merely LOOK like a delivery. A
  // real delivery in `text` blocks still settles, so the refusals below are scope
  // and shape, not a lane that never works.
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  const childFile = path.join(h.dir, "agent-child.jsonl");
  await fs.writeFile(childFile, "", "utf8");
  childHook(h, "SubagentStop", AGENT_A, {
    background_members: [{ id: AGENT_A, kind: "task" }, { id: SHELL_1, kind: "shell" }],
    agent_transcript_path: childFile,
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  const envelope = taskNotificationEnvelope(SHELL_1, "completed", CHILD_TOOL_USE);
  const noise = [
    // A row from another conversation entirely.
    jsonRow({
      type: "user",
      isMeta: true,
      sessionId: OTHER_SESSION,
      message: { role: "user", content: envelope },
    }),
    // A delivery belonging to a different agent of the same session.
    jsonRow({
      type: "user",
      isMeta: true,
      sessionId: SESSION,
      agentId: AGENT_D,
      message: { role: "user", content: envelope },
    }),
    // A replayed request body that mentions a task but is not a provider
    // injection at all.
    jsonRow({
      type: "user",
      commandMode: "api-request",
      sessionId: SESSION,
      message: { role: "user", content: `earlier request ${envelope}` },
    }),
    // The envelope sitting in a top-level field, which is not where the producer
    // ever writes it.
    jsonRow({ type: "user", isMeta: true, sessionId: SESSION, content: envelope }),
  ];
  for (const row of noise) {
    await fs.appendFile(childFile, row, "utf8");
  }
  await h.append(queueOperationRow("remove", { reason: "unrelated" }));
  await settle();
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: 1, shells: 1 },
    "none of these records is this agent's delivery, so nothing settles",
  );

  // A genuine delivery carried in `text` blocks settles the same work.
  await fs.appendFile(childFile, jsonRow({
    type: "user",
    isMeta: true,
    sessionId: SESSION,
    agentId: AGENT_A,
    message: {
      role: "user",
      content: [
        { type: "text", text: "" },
        { type: "text", text: envelope },
      ],
    },
  }), "utf8");
  await h.append(queueOperationRow("remove", { reason: "delivered_to_agent" }));
  await waitFor(() => countsOf(h.latest()).shells === 0, "a text-block delivery settles the routed work");
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });
  h.controller.dispose();
});

test("a lost child transcript degrades only its own agent's task coverage", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  // An unrelated root shell, so the loss can be shown not to reach the shells.
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-root-shell",
    background_started: { id: "b9rootshell", kind: "shell" },
  });
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  const childFile = path.join(h.dir, "agent-child.jsonl");
  await fs.writeFile(childFile, "", "utf8");
  childHook(h, "SubagentStop", AGENT_A, {
    background_members: [{ id: AGENT_A, kind: "task" }, { id: SHELL_1, kind: "shell" }],
    agent_transcript_path: childFile,
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 2 });

  // The bind-time read lands first, so the identity the lane holds is the one the
  // replacement is measured against.
  await settle();

  // The file behind the bound path is replaced. A cursor into the old file says
  // nothing about the new one, so this lane's coverage is gone.
  await fs.rm(childFile);
  await fs.writeFile(childFile, "", "utf8");
  await h.append(queueOperationRow("remove", { reason: "unrelated" }));
  await waitFor(() => h.gaps.includes("replaced"), "the child lane reports its own loss");
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: null, shells: 2 },
    "one agent's lost lane costs that agent's exactness, and nothing else",
  );
  h.controller.dispose();
});

test("an explicit invalidation is never repaired by an empty in-flight snapshot", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  // A live agent beside a root shell, so the two axes can be told apart.
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-root-shell",
    background_started: { id: "b9rootshell", kind: "shell" },
  });
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  // The caller takes back every claim. That is a hole in this run's evidence: A may
  // have parked, woken, or ended while nothing was observed.
  h.controller.invalidate();
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null });

  // The provider's next complete census says nothing is IN FLIGHT. It repairs the
  // ledger — the shell is positively gone — and says nothing whatsoever about an
  // agent the provider excludes from an in-flight array by design. So the shell
  // axis recovers exactly while the task axis stays unknown.
  h.hook("Stop", { background_counts: { tasks: 0, shells: 0 }, background_members: [] });
  await settle();
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: null, shells: 0 },
    "a complete census repairs membership, never a lifetime",
  );

  // A's own edge is the only thing that restores the task axis.
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });
  h.controller.dispose();
});

test("deleting an already-read root transcript is lost evidence, not an absent file", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-root-shell",
    background_started: { id: "b9rootshell", kind: "shell" },
  });
  childHook(h, "SubagentStart", AGENT_A);
  // The file has been read, so it is a source with recorded history.
  await waitFor(() => h.readySnapshots().length > 0 || h.snapshots.length > 0, "the transcript is read");
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  // The transcript disappears mid-run. Unlike a file that never existed, whatever
  // it held can no longer be read: A's own completion may have been in it.
  await fs.rm(h.transcript);
  h.hook("Stop", { background_counts: { tasks: 0, shells: 0 }, background_members: [] });
  await waitFor(() => h.gaps.includes("unavailable"), "the vanished transcript is reported");
  // This hole strands a tracked member whose end can never be read again, so BOTH
  // axes are holes: a transcript gap that loses rows reaches further than one
  // agent's own lifetime does.
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null });

  // The provider's next complete in-flight census is refused as a repair of either
  // axis, and it re-arms a read of a file that is still not there. The point this
  // test pins is the one that matters: an empty `background_tasks` array never
  // resurrects a stale A as an exact task count.
  h.hook("Stop", { background_counts: { tasks: 0, shells: 0 }, background_members: [] });
  await settle();
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: null, shells: null },
    "a complete in-flight census never republishes a stale agent as an exact count",
  );

  // A's own edge would make its lifetime observable again, but the census itself is
  // still unreadable, so neither axis is published from a hole: each recovers on
  // its own evidence and neither borrows the other's.
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null });
  h.controller.dispose();
});

test("a deleted child transcript degrades its agent even when nothing replaces it", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  // An open root question, so the independent foreground/input axis can be shown
  // untouched by this agent's lost source.
  h.hook("PreToolUse", {
    tool_name: "AskUserQuestion",
    tool_use_id: "tool-q1",
    prompt_id: "prompt-1",
  });
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-root-shell",
    background_started: { id: "b9rootshell", kind: "shell" },
  });
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  const childFile = path.join(h.dir, "agent-child.jsonl");
  await fs.writeFile(childFile, "", "utf8");
  childHook(h, "SubagentStop", AGENT_A, {
    background_members: [{ id: AGENT_A, kind: "task" }, { id: SHELL_1, kind: "shell" }],
    agent_transcript_path: childFile,
  });
  // The bind-time read establishes the file's identity: this lane HAS read it.
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 2 });

  // Deleted, with nothing behind it. An agent whose one speaking source was removed
  // is not the same case as a transcript the provider has not created yet.
  await fs.rm(childFile);
  await h.append(queueOperationRow("remove", { reason: "unrelated" }));
  await waitFor(() => h.gaps.includes("unavailable"), "the deleted child lane reports its loss");
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: null, shells: 2 },
    "only that agent's exactness goes; the known shell census stands",
  );
  assert.equal(
    h.latest().pendingInput,
    true,
    "a lost child lane never touches the independent pending-input axis",
  );
  assert.notEqual(h.latest().activity, null, "nor the hook-derived foreground");

  // That agent's own edge resumes its lifetime.
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 2 });
  h.controller.dispose();
});

test("two completions for one id in one window keep their own positions", async () => {
  // A read window can hold BOTH an agent's superseded completion and its fresh
  // one. Collapsing them by identity would keep whichever record came first — the
  // one the resumed window's floor fences out — and an agent that really ended
  // would stay counted forever, because the record that says otherwise was already
  // consumed. Every record has to arrive with its own position.
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });

  // The first window's completion is written, and nothing reads it.
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(AGENT_A, "completed", "tool-a-first"),
  }));

  // The same agent resumes: the new window's floor sits after that record. Its
  // final turn ends owning nothing, and its fresh completion is appended after.
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(AGENT_A, "completed", "tool-a-second"),
  }));

  // One read consumes both rows at once. The older one is refused by the floor;
  // the newer one closes A — with no further append and no second read.
  readNow(received);
  await waitFor(() => countsOf(h.latest()).tasks === 0, "the fresh emission ends A from the same window");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });
  h.controller.dispose();
});

test("a named child transcript that appears late is still retried", async () => {
  // A provider creates its child transcript when the child writes, which can be
  // after the boundary that named it. That first absence costs nothing — but the
  // binding came from the provider and stays true, so the lane must survive to be
  // read by the root events that already exist.
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "PostToolUse", AGENT_A, {
    tool_name: "Bash",
    tool_use_id: CHILD_TOOL_USE,
    background_started: { id: SHELL_1, kind: "shell" },
  });
  const childFile = path.join(h.dir, "agent-child.jsonl");
  childHook(h, "SubagentStop", AGENT_A, {
    background_members: [{ id: AGENT_A, kind: "task" }, { id: SHELL_1, kind: "shell" }],
    agent_transcript_path: childFile,
  });
  // The file is not there yet.
  await waitFor(() => h.gaps.includes("unavailable"), "the absent child file is reported");
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, "a late file is not a coverage hole");

  // It materializes with B's native delivery inside, and the root journal has no
  // row for B at all. An ordinary root append reaches the retained lane.
  await fs.writeFile(childFile, jsonRow({
    type: "user",
    isMeta: true,
    sessionId: SESSION,
    agentId: AGENT_A,
    message: { role: "user", content: taskNotificationEnvelope(SHELL_1, "completed", CHILD_TOOL_USE) },
  }), "utf8");
  await h.append(queueOperationRow("remove", { reason: "unrelated" }));
  await waitFor(() => countsOf(h.latest()).shells === 0, "the retried lane settles the routed work");
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "A wakes; it is not ended by the delivery");
  h.controller.dispose();
});

test("two child launches with no tool_use_id are two members, and replays stay inert", async () => {
  // Omitting `tool_use_id` is permitted by the protocol, so it cannot be read as
  // "one request per agent per event". Two distinct launches that happen to arrive
  // without one must both reach membership and ownership, or the shell count is not
  // merely coarse — it is simply wrong.
  const SHELL_2 = "b7secondshell";
  const launchOf = (id: string) => ({
    tool_name: "Bash",
    background_started: { id, kind: "shell" as const },
  });
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });

  childHook(h, "PostToolUse", AGENT_A, launchOf(SHELL_1));
  childHook(h, "PostToolUse", AGENT_A, launchOf(SHELL_2));
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 2 }, "one agent, two distinct shells");

  // Replays of both launch results are the same results arriving twice: no new
  // member, and nothing published about membership.
  const before = h.snapshots.length;
  childHook(h, "PostToolUse", AGENT_A, launchOf(SHELL_1));
  childHook(h, "PostToolUse", AGENT_A, launchOf(SHELL_2));
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 2 }, "replayed launches add nothing");
  assert.equal(h.snapshots.length, before, "a replayed launch states nothing new");

  // Both shells settle on their own records; A becomes a pending wake.
  for (const id of [SHELL_1, SHELL_2]) {
    await h.append(queueOperationRow("enqueue", {
      content: taskNotificationEnvelope(id, "completed", `tool-${id}`),
    }));
  }
  await waitFor(() => countsOf(h.latest()).shells === 0, "both shells settle");
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });

  // A's actual end: a clean boundary owning nothing, then its own completion.
  childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
  await h.append(queueOperationRow("enqueue", {
    content: taskNotificationEnvelope(AGENT_A, "completed", "tool-a-final"),
  }));
  await waitFor(() => countsOf(h.latest()).tasks === 0, "A ends on its own completion");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });

  // Both launch results arrive a third time, long after the agent and both members
  // are gone. Neither resurrects the agent nor re-owns a settled member.
  childHook(h, "PostToolUse", AGENT_A, launchOf(SHELL_1));
  childHook(h, "PostToolUse", AGENT_A, launchOf(SHELL_2));
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 }, "late replays resurrect nothing");
  h.controller.dispose();
});
