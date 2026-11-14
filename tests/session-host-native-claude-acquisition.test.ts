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
 * never from a row that predates the read barrier); a published `Ready` and count
 * snapshot withdrawn to unknown when the monitored transcript shows a NEW ROOT
 * model row — even when no hook ever arrives for that work — while sidechain,
 * agent-scoped, foreign-session, and non-work rows never claim root work; and that
 * a whole batch containing both an old summary and newer root work fails closed;
 * the observed-0 versus absent-unknown distinction on real ROOT `Stop` snapshots
 * and the refusal to use
 * a `SubagentStop` subset; withdrawal to unknown (never zero, never a stale Ready)
 * on truncation, replacement, malformed or oversized records, and a window too
 * small to cover the barrier; one-file-only access; and that no raw transcript
 * content ever leaves the controller.
 */

import assert from "node:assert/strict";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { afterEach } from "node:test";

import type { NativeHookEvent } from "../src/session-host/native-hook-protocol";
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
  await fs.writeFile(transcript, options.seed ?? priorHistory(), "utf8");
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
    assert.equal(h.latest().busy, null);
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
  assert.equal(h.latest().busy, null);
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
  assert.equal(stopped.busy, null);
  assert.deepEqual(stopped.activity, []);
  assert.equal(stopped.activeTasks, 2);
  assert.equal(stopped.activeShells, 1);
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
  // New work makes the last native snapshot unknown rather than stale.
  assert.equal(h.latest().activeTasks, null);
  assert.equal(h.latest().activeShells, null);

  h.hook("Stop", { prompt_id: "prompt-2" });
  await settle();
  assert.equal(h.readySnapshots().length, readyCount, "the older summary must not close the new turn");
  assert.equal(h.latest().busy, null);
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
  assert.equal(h.latest().busy, null);
  assert.equal(h.latest().activeTasks, null);
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
  assert.equal(after.activeTasks, null, "a positive count with no monitoring is not defensible");
  assert.equal(after.activeShells, null);
  assert.equal(after.busy, null);

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
  assert.equal(h.latest().busy, null);
  assert.equal(h.latest().activeTasks, null);
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

  // A SubagentStop snapshot is that subagent's array, never root scope.
  h.hook("SubagentStop", { background_counts: { tasks: 0, shells: 0 }, agent_id: "agent-9" });
  assert.equal(h.latest().activeTasks, null);
  assert.equal(h.latest().activeShells, null);

  // Absent is unverifiable, not zero.
  h.hook("Stop");
  assert.equal(h.latest().activeTasks, null);
  assert.equal(h.latest().activeShells, null);
  h.controller.dispose();
});

test("a launch edge and tool work invalidate the last native snapshot", async () => {
  const h = await createHarness();
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 2, shells: 2 } });
  assert.equal(h.latest().activeShells, 2);

  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  h.hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tool-a", prompt_id: "prompt-2" });
  assert.equal(h.latest().activeTasks, null);
  assert.equal(h.latest().activeShells, null);
  assert.equal(h.latest().busy, true);
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
  assert.equal(h.latest().busy, null);
  assert.equal(h.latest().activeTasks, null);
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
  assert.equal(h.latest().activeTasks, null);
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
  assert.equal(h.latest().busy, null);
  assert.equal(h.latest().activeShells, null);
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

test("new root transcript work after Ready withdraws Ready and counts to unknown with no hook ever arriving", async () => {
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
    assert.equal(h.latest().activeTasks, null, "unknown, never a reconstruction");
    assert.equal(h.latest().activeShells, null);
    assert.deepEqual(h.gaps, [], "observed new work is knowledge, not a source gap");
    assert.deepEqual(h.latest().support, NATIVE_CLAUDE_ACQUISITION_SUPPORT, "no category becomes unsupported");

    // The rest of that silent turn keeps the row unknown: nothing may restore it.
    await h.append(rootAssistantToolUseRow());
    await h.append(rootAssistantTextRow());
    await settle();
    assert.equal(h.readySnapshots().length, 1, "no later row may restore Ready");
    assert.equal(h.latest().busy, null);
    assert.equal(h.latest().activeTasks, null);
    assert.equal(h.latest().activeShells, null);
    for (const snapshot of h.snapshots.slice(publishedBefore)) {
      assert.notStrictEqual(snapshot.busy, true, "a withdrawal never claims busy instead");
      assert.equal(snapshot.activeTasks, null, "a withdrawal never publishes a count");
      assert.equal(snapshot.activeShells, null);
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
    assert.equal(h.latest().activeTasks, null);
    assert.equal(h.latest().activeShells, null);
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

test("an old summary and newer root work in one window fail closed instead of recreating Ready", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h);
  h.hook("Stop", { background_counts: { tasks: 2, shells: 1 } });
  // One read covers the whole batch: a sufficient summary, then a newer root
  // turn's rows. The newer work outranks the witness for the entire batch.
  await h.append(summaryRow() + rootUserRow() + rootAssistantToolUseRow());
  readNow(received);

  await waitFor(() => h.latest().activeTasks === null, "the batch must withdraw the published snapshot");
  assert.deepEqual(h.readySnapshots(), [], "no witness in a batch with newer root work may publish Ready");
  assert.equal(h.latest().busy, null);
  assert.deepEqual(h.latest().activity, []);
  assert.equal(h.latest().activeShells, null);
  h.controller.dispose();
});

test("a root-work withdrawal retires the armed pass, so that turn's later summary cannot restore Ready", async () => {
  const h = await createHarness();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 1 } });
  // New root work lands while the terminal read is still armed for the old turn.
  await h.append(rootUserRow());
  await waitFor(() => h.latest().activeTasks === null, "new root work must withdraw the published snapshot");
  await h.append(summaryRow());
  await settle();
  assert.deepEqual(h.readySnapshots(), [], "the retired pass must not close anything");
  assert.equal(h.latest().busy, null);
  assert.equal(h.latest().activeTasks, null);
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
  assert.equal(h.latest().busy, null);
  assert.equal(h.latest().activeTasks, null);
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
  assert.equal(h.latest().busy, null);
  assert.equal(h.latest().activeTasks, null);
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
  // Arming against an unbound file is a source failure, not a bare report: the
  // counts this Stop carried must not stay published with nothing to monitor them.
  const after = h.latest();
  assert.equal(after.activeTasks, null);
  assert.equal(after.activeShells, null);
  assert.equal(after.busy, null);
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

  h.hook("SessionStart");
  const rebound = h.latest();
  assert.equal(rebound.busy, null);
  assert.deepEqual(rebound.activity, []);
  assert.equal(rebound.activeTasks, null);
  h.controller.dispose();
});
