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
 * access; and that no raw transcript content ever leaves the controller.
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
  // Ordinary new foreground work proves nothing about background membership, so
  // the last ROOT `Stop` snapshot stays published as last-reported.
  assert.equal(h.latest().activeTasks, 1);
  assert.equal(h.latest().activeShells, 0);

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
  // What the failed lane supported is withdrawn: no witness can be read, so no
  // Ready may be claimed. The ROOT `Stop` snapshot came from the hook lane, so it
  // stays published as the last thing the provider stated.
  assert.equal(after.busy, null);
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
  assert.equal(h.latest().busy, null);
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

  // A late tool close, subagent metadata, and a child snapshot with different
  // numbers are all unrelated to root background membership.
  const before = h.snapshots.length;
  h.hook("PostToolUse", { tool_name: "Read", tool_use_id: "tool-late" });
  h.hook("SubagentStart", { agent_id: "agent-9" });
  h.hook("SubagentStop", { agent_id: "agent-9", background_counts: { tasks: 0, shells: 0 } });
  await settle();
  assert.equal(h.snapshots.length, before, "unrelated hooks publish nothing about membership");
  const kept = h.latest();
  assert.equal(kept.busy, false);
  assert.deepEqual(kept.activity, ["Ready"]);
  assert.equal(kept.activeTasks, 2);
  assert.equal(kept.activeShells, 1);
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
  assert.equal(after.busy, null);
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
  assert.equal(h.latest().busy, null);
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
  assert.equal(h.latest().busy, null);
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
  assert.equal(after.busy, null);
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
    assert.equal(h.latest().busy, null);
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
