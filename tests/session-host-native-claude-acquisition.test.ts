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
import { appendFileSync, promises as fsPromises, watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { afterEach, mock } from "node:test";

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
import { NativeClaudeStatusReducer } from "../src/session-host/native-claude-status";
import type { NativeStatusObservation } from "../src/session-host/native-status";
import { MAX_NATIVE_SESSION_NAME_LENGTH } from "../src/session-host/protocol";

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
  workspace?: string;
  resumeConversationId?: string;
  onConversationIdentity?: (conversationId: string | null) => boolean | void;
  onConversationTitle?: (conversationId: string, title: string) => boolean | void;
  onRootToolRequest?: (conversationId: string, toolUseId: string, toolName: string) => void;
  onRootTranscriptRebound?: (conversationId: string) => void;
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
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.resumeConversationId === undefined ? {} : { resumeConversationId: options.resumeConversationId }),
    ...(options.onConversationIdentity === undefined ? {} : { onConversationIdentity: options.onConversationIdentity }),
    ...(options.onConversationTitle === undefined ? {} : { onConversationTitle: options.onConversationTitle }),
    ...(options.onRootToolRequest === undefined ? {} : { onRootToolRequest: options.onRootToolRequest }),
    ...(options.onRootTranscriptRebound === undefined ? {} : { onRootTranscriptRebound: options.onRootTranscriptRebound }),
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

/** One open the tail reader made of an observed path. */
interface ObservedOpen {
  /** Resolves once the reader has asked to close this handle, its window already read. */
  readonly closing: Promise<void>;
  /** Resolves once the handle is closed (or the open failed): the read's last I/O. */
  readonly released: Promise<void>;
  /** Lets a held close proceed. A no-op for an open that was not held. */
  release(): void;
}

/**
 * Observe the tail reader's opens through the shared `fs.promises` binding it
 * calls, with no delay and no timer. Each open is recorded the moment the reader
 * asks for it; `released` says when that read did its last I/O, after which its
 * commit is synchronous. The FIRST open of each path in `holdFirstOf` keeps its
 * close pending until the test releases it, parking that read after it has sized
 * and read its window and before it commits. Nothing is read or changed here.
 */
function observeOpens(holdFirstOf: readonly string[] = []): {
  of(target: string): ObservedOpen[];
  restore(): void;
} {
  const opens = new Map<string, ObservedOpen[]>();
  const original = fsPromises.open;
  const tracked = mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    const target = String(args[0]);
    const list = opens.get(target) ?? [];
    opens.set(target, list);
    const held = holdFirstOf.includes(target) && list.length === 0;
    let release = (): void => {};
    const gate = held ? new Promise<void>((resolve) => { release = () => resolve(); }) : Promise.resolve();
    let markClosing = (): void => {};
    const closing = new Promise<void>((resolve) => { markClosing = () => resolve(); });
    let markReleased = (): void => {};
    const released = new Promise<void>((resolve) => { markReleased = () => resolve(); });
    list.push({ closing, released, release: () => release() });
    let handle: Awaited<ReturnType<typeof fsPromises.open>>;
    try {
      handle = await original(...args);
    } catch (error) {
      markClosing();
      markReleased();
      throw error;
    }
    const close = handle.close.bind(handle);
    handle.close = async () => {
      markClosing();
      await gate;
      try {
        await close();
      } finally {
        markReleased();
      }
    };
    return handle;
  });
  return {
    of: (target) => opens.get(target) ?? [],
    restore: () => tracked.mock.restore(),
  };
}

/**
 * Wait until every listed read has done its last I/O, then let the synchronous
 * commit that follows it run to completion: one macrotask turn drains every
 * microtask the read's continuation queued, so this is ordering, not a delay.
 */
async function committed(reads: readonly ObservedOpen[]): Promise<void> {
  await Promise.all(reads.map((read) => read.released));
  await new Promise((resolve) => setImmediate(resolve));
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

test("a nonempty hookErrors summary with no failed-index field is undecidable: never Ready, never busy, snapshot kept", async () => {
  // Deliberately undecidable: without `failedHookErrorIndexes` (a summary in the
  // pre-index shape) nothing separates a blocking decision from a nonblocking or
  // exec failure, so neither a turn end nor a continuation is proven. The root
  // foreground withdraws to unknown; the hook-reported counts are not root
  // terminal evidence and stand.
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

test("additional context alone proves neither a turn end nor a continuation", async () => {
  // Deliberately undecidable: the producer may filter additional context before
  // it queues anything, so a nonempty array alone is not a continuation, and it
  // is not a clean end either. Never Ready, and the foreground goes unknown.
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

/* ------------------------------------------- Stop-hook block and continuation */

/*
 * The shipped 2.1.332 root Stop producer records a normal blocking decision in
 * `hookErrors` WITHOUT adding a `failedHookErrorIndexes` entry and queues a
 * continuation of the same turn; a nonblocking or exec failure gets an index.
 * These rows are synthetic, in that shape: a blocking-error attachment, the
 * summary, then the continued turn's own root model output.
 */
function blockedSummaryRow(extra: Record<string, unknown> = {}): string {
  return summaryRow({
    uuid: "summary-row-blocked",
    preventedContinuation: false,
    hookErrors: [SECRET_STOP_REASON],
    failedHookErrorIndexes: [],
    ...extra,
  });
}

function blockingErrorAttachmentRow(): string {
  return jsonRow({
    type: "attachment",
    sessionId: SESSION,
    isSidechain: false,
    attachment: { type: "hook_blocking_error", hookName: "Stop", blockingError: { blockingError: SECRET_STOP_REASON, command: SECRET_HOOK_COMMAND } },
    uuid: "blocking-attachment-1",
  });
}

function cleanSummaryRow(extra: Record<string, unknown> = {}): string {
  return summaryRow({
    uuid: "summary-row-clean",
    preventedContinuation: false,
    hookErrors: [],
    failedHookErrorIndexes: [],
    ...extra,
  });
}

function assertNoLeak(h: Harness): void {
  const leaked = JSON.stringify({ snapshots: h.snapshots, gaps: h.gaps });
  for (const secret of [SECRET_HOOK_COMMAND, SECRET_STOP_REASON, h.transcript]) {
    assert.ok(!leaked.includes(secret), `observation surface leaked ${secret}`);
  }
}

test("block: a blocked summary with the continued turn's model output in the SAME window keeps Running, and the next clean Stop is Ready", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 0 } });
  const before = h.latest();
  assert.equal(before.busy, true);

  // One append-ordered window: the blocking decision, its summary, then the
  // continuation's own root `assistant` rows. Those rows start AFTER the
  // window's first root summary, but that summary completed nothing.
  await h.append(blockingErrorAttachmentRow() + blockedSummaryRow() + rootAssistantTextRow() + rootAssistantToolUseRow());
  readNow(received);
  await settle();
  const held = h.latest();
  assert.equal(held.busy, true, "a blocked Stop pass is never Ready and never unknown");
  assert.deepEqual(held.activity, before.activity, "the observed activity stands");
  assert.equal(held.pendingInput, before.pendingInput);
  assert.equal(held.activeTasks, 1);
  assert.equal(held.activeShells, 0);
  assert.equal(h.snapshots.some((snapshot) => snapshot.activity.includes("Ready")), false);
  assert.deepEqual(h.gaps, []);

  // The continued turn's own next Stop pass is the next authoritative boundary.
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 0 } });
  await h.append(cleanSummaryRow());
  readNow(received);
  await waitFor(() => h.latest().activity.includes("Ready"), "the clean summary of the next own Stop confirms Ready");
  const ready = h.latest();
  assert.equal(ready.busy, false);
  assert.equal(ready.pendingInput, false, "a clean root turn end proves no input pending");
  assert.equal(ready.activeTasks, 1);
  assertNoLeak(h);
  h.controller.dispose();
});

test("block: the continuation's model output in a LATER window is not a contradiction of that block either", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1" });
  await h.append(blockedSummaryRow());
  readNow(received);
  await settle();
  assert.equal(h.latest().busy, true);

  await h.append(rootAssistantTextRow());
  readNow(received);
  await settle();
  assert.equal(h.latest().busy, true, "continuation output after the decided block keeps Running");
  assert.deepEqual(h.latest().activity, ["Working"]);

  h.hook("Stop", { prompt_id: "prompt-1" });
  await h.append(cleanSummaryRow());
  readNow(received);
  await waitFor(() => h.latest().activity.includes("Ready"), "the next own clean Stop confirms Ready");
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();
});

test("block: continuation output ends a root question pause without freeing its prompt binding, in either read order", async () => {
  for (const sameWindow of [true, false]) {
    const received: NativeClaudeWatchHandlers[] = [];
    const h = await createHarness({ watchFile: manualWatch(received) });
    await beginTurn(h, "prompt-2");
    // A root question this run accepted and never saw close (a declined
    // question can bypass its Post hook), so the row is stopped on input.
    h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-root", prompt_id: "prompt-2" });
    h.hook("Stop", { prompt_id: "prompt-2" });
    assert.equal(h.latest().busy, false, `${sameWindow}: stopped on input`);
    await h.append(blockedSummaryRow() + (sameWindow ? rootAssistantTextRow() : ""));
    readNow(received);
    if (!sameWindow) {
      await settle();
      assert.equal(h.latest().busy, false, "the block alone changes nothing");
      await h.append(rootAssistantTextRow());
      readNow(received);
    }
    await waitFor(() => h.latest().busy === true, `${sameWindow}: same-turn output ends the pause`);
    assert.equal(h.latest().pendingInput, true, "the request is still open");

    // An older prompt's delayed Stop stays stale: the binding was kept.
    h.hook("Stop", { prompt_id: "prompt-1" });
    await h.append(cleanSummaryRow({ promptId: "prompt-1", uuid: "summary-row-stale" }));
    readNow(received);
    await settle();
    assert.equal(h.snapshots.some((snapshot) => snapshot.activity.includes("Ready")), false,
      `${sameWindow}: an older prompt's Stop never publishes Ready`);
    assert.equal(h.latest().pendingInput, true, "the still-open request is not retired by it");

    h.hook("Stop", { prompt_id: "prompt-2" });
    await h.append(cleanSummaryRow({ promptId: "prompt-2" }));
    readNow(received);
    await waitFor(() => h.latest().activity.includes("Ready"), `${sameWindow}: the current prompt's Stop still decides`);
    h.controller.dispose();
  }
});

test("block: pre-summary model rows neither end a root question pause nor release its prompt, read split or together", async () => {
  for (const split of [false, true]) {
    const received: NativeClaudeWatchHandlers[] = [];
    const h = await createHarness({ watchFile: manualWatch(received) });
    await beginTurn(h, "prompt-2");
    h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-root", prompt_id: "prompt-2" });
    h.hook("Stop", { prompt_id: "prompt-2" });
    if (split) {
      await h.append(rootAssistantTextRow());
      readNow(received);
      await settle();
      assert.equal(h.latest().busy, false, "trailing output alone does not end the pause");
    }
    await h.append((split ? "" : rootAssistantTextRow()) + blockedSummaryRow());
    readNow(received);
    await settle();
    assert.equal(h.latest().busy, false, `${split}: output before the block is not continuation output`);
    assert.equal(h.latest().pendingInput, true);

    h.hook("Stop", { prompt_id: "prompt-1" });
    await h.append(cleanSummaryRow({ promptId: "prompt-1", uuid: "summary-row-stale" }));
    readNow(received);
    await settle();
    assert.equal(h.snapshots.some((snapshot) => snapshot.activity.includes("Ready")), false,
      `${split}: an older prompt's Stop never publishes Ready`);
    assert.equal(h.latest().pendingInput, true);

    h.hook("Stop", { prompt_id: "prompt-2" });
    await h.append(cleanSummaryRow({ promptId: "prompt-2" }));
    readNow(received);
    await waitFor(() => h.latest().activity.includes("Ready"), `${split}: the current prompt's own Stop still decides`);
    h.controller.dispose();
  }
});

test("block: a summary behind a continuation in the same window belongs to a later Stop pass and is never accepted under this arm", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1" });
  // This run's hook for the second pass never arrived, so only the first arm
  // exists: its block decides it, and the clean row after it is unarmed.
  await h.append(blockedSummaryRow() + rootAssistantTextRow() + cleanSummaryRow());
  readNow(received);
  await settle();
  assert.equal(h.snapshots.some((snapshot) => snapshot.activity.includes("Ready")), false);
  assert.equal(h.latest().busy, true);
  h.controller.dispose();
});

test("block: a root PROMPT row after a blocked summary is still newer work and withdraws", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 1 } });
  await h.append(blockedSummaryRow() + rootUserRow());
  readNow(received);
  await waitFor(() => h.latest().busy === null, "a persisted root prompt is not continuation output");
  assert.equal(h.snapshots.some((snapshot) => snapshot.activity.includes("Ready")), false);
  assert.equal(h.latest().activeTasks, 1, "newer foreground work says nothing about background membership");
  h.controller.dispose();
});

test("block: a clean summary followed by root model output in the same window still spends the pass", async () => {
  // The positive control for the continuation exemption: only a PROVEN
  // continuation anchor excuses later rows; a completion anchor does not.
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { prompt_id: "prompt-1" });
  await h.append(cleanSummaryRow() + rootAssistantTextRow());
  readNow(received);
  await waitFor(() => h.latest().busy === null, "newer root work after a completion withdraws");
  assert.equal(h.snapshots.some((snapshot) => snapshot.activity.includes("Ready")), false);
  h.controller.dispose();
});

test("failed index: a summary carrying a failed-hook index is inconclusive at its own edge, keeps background and a child question, and a later prompt plus clean Stop is Ready", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  h.hook("PreToolUse", {
    tool_name: "AskUserQuestion", tool_use_id: "q-child", prompt_id: "prompt-1", agent_id: "agent-1",
  });
  h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 2, shells: 1 } });
  // A nonblocking/exec failure is indexed. Index values are opaque here: only
  // emptiness is ever read, so a nonempty array cannot rule out a blocking
  // decision beside the failure, and the edge proves neither outcome.
  await h.append(summaryRow({
    preventedContinuation: false,
    hookErrors: [SECRET_STOP_REASON],
    failedHookErrorIndexes: [0],
  }));
  readNow(received);
  await waitFor(() => h.latest().busy === null, "the root foreground goes unknown at the failed edge");
  const failed = h.latest();
  assert.deepEqual(failed.activity, []);
  assert.equal(failed.activeTasks, 2, "an invalid terminal record withdraws no background count");
  assert.equal(failed.activeShells, 1);
  assert.equal(failed.pendingInput, true, "a child's own open question is not root terminal evidence");
  assert.equal(h.snapshots.some((snapshot) => snapshot.activity.includes("Ready")), false);
  assert.deepEqual(h.gaps, [], "a decided record is not a source gap");

  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  assert.equal(h.latest().busy, true, "the next accepted prompt is observed running again");
  h.hook("Stop", { prompt_id: "prompt-2", background_counts: { tasks: 2, shells: 1 } });
  await h.append(cleanSummaryRow());
  readNow(received);
  await waitFor(() => h.latest().activity.includes("Ready"), "the later clean Stop confirms Ready");
  const ready = h.latest();
  assert.equal(ready.activeTasks, 2);
  assert.equal(ready.activeShells, 1);
  assert.equal(ready.pendingInput, true, "the child's question survives its parent's turn end");
  assertNoLeak(h);
  h.controller.dispose();
});

test("unreadable: malformed decisive or correlation fields are inconclusive under the bound arm, never clean and never a continuation", async () => {
  const unreadable: ReadonlyArray<Record<string, unknown>> = [
    { preventedContinuation: false, hookErrors: [], failedHookErrorIndexes: "0" },
    { preventedContinuation: false, hookErrors: [SECRET_STOP_REASON], failedHookErrorIndexes: null },
    { preventedContinuation: false, hookErrors: [SECRET_STOP_REASON], failedHookErrorIndexes: [], hookLabel: 42 },
    { preventedContinuation: true, hookEventName: { name: "Stop" } },
    { preventedContinuation: true, isSidechain: "false" },
    { preventedContinuation: true, agentId: 7 },
    { preventedContinuation: true, sessionId: "   " },
    { preventedContinuation: true, promptId: null },
    { preventedContinuation: true, session_id: 7 },
    { preventedContinuation: true, is_sidechain: "false" },
    { preventedContinuation: true, agent_id: false },
    { preventedContinuation: true, prompt_id: "  " },
  ];
  for (const extra of unreadable) {
    const received: NativeClaudeWatchHandlers[] = [];
    const h = await createHarness({ watchFile: manualWatch(received) });
    await beginTurn(h, "prompt-1");
    h.hook("Stop", { prompt_id: "prompt-1", background_counts: { tasks: 1, shells: 1 } });
    await h.append(summaryRow(extra));
    readNow(received);
    await waitFor(() => h.latest().busy === null, `unreadable ${JSON.stringify(extra)} must go unknown`);
    assert.equal(h.snapshots.some((snapshot) => snapshot.activity.includes("Ready")), false,
      `unreadable ${JSON.stringify(extra)} must never be Ready`);
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 1);

    // A later accepted prompt and a valid clean summary restore Ready.
    h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
    h.hook("Stop", { prompt_id: "prompt-2" });
    await h.append(cleanSummaryRow());
    readNow(received);
    await waitFor(() => h.latest().activity.includes("Ready"), `recovery after ${JSON.stringify(extra)}`);
    assertNoLeak(h);
    h.controller.dispose();
  }
});

test("foreign: a summary naming another session or another prompt is inert, and this run's own summary after it still decides", async () => {
  const foreign: ReadonlyArray<Record<string, unknown>> = [
    { sessionId: OTHER_SESSION },
    { promptId: "prompt-0" },
    { session_id: OTHER_SESSION },
    { sessionId: SESSION, session_id: OTHER_SESSION },
    { prompt_id: "prompt-0" },
    { promptId: "prompt-1", prompt_id: "prompt-0" },
  ];
  for (const extra of foreign) {
    const received: NativeClaudeWatchHandlers[] = [];
    const h = await createHarness({ watchFile: manualWatch(received) });
    await beginTurn(h, "prompt-1");
    h.hook("Stop", { prompt_id: "prompt-1" });
    await h.append(cleanSummaryRow(extra));
    readNow(received);
    await settle();
    assert.equal(h.snapshots.some((snapshot) => snapshot.activity.includes("Ready")), false,
      `foreign ${JSON.stringify(extra)} must never be Ready`);
    assert.equal(h.latest().busy, true, "an inert summary neither completes nor withdraws");

    // It never set the positional boundary: the own summary after it decides.
    await h.append(cleanSummaryRow({ sessionId: SESSION, promptId: "prompt-1" }));
    readNow(received);
    await waitFor(() => h.latest().activity.includes("Ready"), "this run's own summary confirms Ready");
    h.controller.dispose();
  }
});

test("foreign: with a promptless Stop, a summary tagged for an older prompt neither anchors the window nor blocks this turn's own summary", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  // The Stop hook omits its optional prompt_id: the reducer's own binding to
  // prompt-1 is what fences the conflicting row.
  h.hook("Stop");
  assert.equal(h.latest().busy, true);
  const afterStop = h.snapshots.length;
  await h.append(
    cleanSummaryRow({ promptId: "prompt-0" })
    + rootAssistantTextRow()
    + cleanSummaryRow({ promptId: "prompt-1" }),
  );
  readNow(received);
  await waitFor(() => h.latest().activity.includes("Ready"), "this turn's own summary confirms Ready");
  assert.equal(h.snapshots.slice(afterStop).some((snapshot) => snapshot.busy === null), false,
    "the conflicting row never set the boundary, so the trailing row withdrew nothing");
  h.controller.dispose();
});

test("foreign: a summary tagged for an older prompt stays inert even when another of its fields is unreadable", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  h.hook("Stop");
  await h.append(cleanSummaryRow({ promptId: "prompt-0", hookLabel: 42 }));
  readNow(received);
  await settle();
  assert.equal(h.latest().busy, true, "a stale row with an unreadable label is not this turn's inconclusive record");
  await h.append(cleanSummaryRow());
  readNow(received);
  await waitFor(() => h.latest().activity.includes("Ready"), "this turn's own summary still decides");
  h.controller.dispose();
});

test("failed index: root model output after an inconclusive summary keeps the prompt binding, so an older prompt's delayed Stop cannot publish Ready", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  await beginTurn(h, "prompt-1");
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  h.hook("Stop", { prompt_id: "prompt-2", background_counts: { tasks: 1, shells: 0 } });
  await h.append(summaryRow({
    preventedContinuation: false,
    hookErrors: [SECRET_STOP_REASON],
    failedHookErrorIndexes: [0],
  }) + rootAssistantTextRow());
  readNow(received);
  await waitFor(() => h.latest().busy === null, "the inconclusive record withdraws the root foreground");
  assert.equal(h.latest().activeTasks, 1);

  // A delayed Stop for the OLDER prompt, then a clean summary: refused as stale,
  // exactly as it would be had the inconclusive summary arrived alone.
  h.hook("Stop", { prompt_id: "prompt-1" });
  await h.append(cleanSummaryRow());
  readNow(received);
  await settle();
  assert.equal(h.snapshots.some((snapshot) => snapshot.activity.includes("Ready")), false,
    "an older prompt's Stop never publishes Ready");

  // This turn's own next Stop is still the authoritative boundary.
  h.hook("Stop", { prompt_id: "prompt-2" });
  await h.append(cleanSummaryRow({ uuid: "summary-row-clean-2" }));
  readNow(received);
  await waitFor(() => h.latest().activity.includes("Ready"), "the own prompt's clean summary confirms Ready");
  assertNoLeak(h);
  h.controller.dispose();
});

test("foreign: a genuine sidechain or child summary stays inert even with an unreadable label", async () => {
  for (const extra of [
    { isSidechain: true, hookLabel: 42 },
    { agentId: "agent-9", sessionId: 5 },
    { is_sidechain: true, hookLabel: 42 },
    { agent_id: "agent-9", sessionId: 5 },
  ]) {
    const received: NativeClaudeWatchHandlers[] = [];
    const h = await createHarness({ watchFile: manualWatch(received) });
    await beginTurn(h, "prompt-1");
    h.hook("Stop", { prompt_id: "prompt-1" });
    await h.append(cleanSummaryRow(extra));
    readNow(received);
    await settle();
    assert.equal(h.latest().busy, true, `non-root ${JSON.stringify(extra)} must stay inert`);
    assert.deepEqual(h.gaps, []);
    h.controller.dispose();
  }
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
  // The census still lands on the axis it can state. The task axis stays withdrawn:
  // the caller took back every claim, and totals cannot show that an agent which
  // parked inside the withdrawn span is gone.
  assert.equal(h.latest().activeShells, 1, "this run's own census still lands");
  assert.equal(h.latest().activeTasks, null, "an explicit withdrawal is not repaired by totals");
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
  // This run's own edges are still admissible and its census still lands on the axis
  // the provider states. The task axis waits for a boundary that starts the run's
  // agent census over: the lost lane is the one that names agents.
  assert.equal(h.latest().activeShells, 0, "this run's own census still lands");
  assert.equal(h.latest().activeTasks, null, "a lost identity lane is not repaired by totals");
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

  // The provider's next complete census rebuilds the SHELL axis exactly, with no
  // restart. The task axis is a different provider statement and a different hole:
  // the lost lane is the one that names agents, so an agent that started and parked
  // inside it is absent from every in-flight census this run will ever be given. It
  // waits for a boundary that starts this run's agent census over.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 1 },
    background_members: [{ id: SHELL_1, kind: "shell" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 1 });
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

/** One owned run with one tracked task and one tracked shell, watched manually. */
async function launchedTaskAndShell(received: NativeClaudeWatchHandlers[]): Promise<Harness> {
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
  return h;
}

test("a delivery read in the same window as its own settlement keeps the counts exact", async () => {
  // The provider persists a completion and, when the run is free, delivers it
  // moments later. Whether one read or two picks those rows up is timing, not
  // evidence: the delivery restates the settlement just before it either way.
  for (const [label, id, expected] of [
    ["a shell", SHELL_1, { tasks: 1, shells: 0 }],
    ["a task", TASK_1, { tasks: 0, shells: 1 }],
  ] as const) {
    for (const split of [true, false]) {
      const received: NativeClaudeWatchHandlers[] = [];
      // Observed from the start, so the reads the setup hooks begin are seen too.
      const opens = observeOpens();
      let h: Harness | undefined;
      try {
        h = await launchedTaskAndShell(received);
        const transcript = h.transcript;
        const where = `${label}, ${split ? "two reads" : "one read"}`;
        // Wait until every read, including one drained behind another, committed.
        const quiesce = async (): Promise<void> => {
          for (;;) {
            const seen = opens.of(transcript).length;
            await committed(opens.of(transcript));
            if (opens.of(transcript).length === seen) return;
          }
        };
        await quiesce();
        // Each read is awaited through its own commit, so an assertion below can
        // never pass merely because a read had not landed yet.
        const readCommitted = async (): Promise<void> => {
          const before = opens.of(transcript).length;
          readNow(received);
          assert.equal(opens.of(transcript).length, before + 1, `one read started: ${where}`);
          await quiesce();
        };
        const mark = h.snapshots.length;
        const settlement = queueOperationRow("enqueue", { content: taskNotificationEnvelope(id, "completed", "tool-x") });
        const delivery = queuedCommandDeliveryRow(taskNotificationEnvelope(id, "completed", "tool-x"));
        if (split) {
          await h.append(settlement);
          await readCommitted();
          assert.deepEqual(countsOf(h.latest()), expected, `the settlement lands alone: ${where}`);
          await h.append(delivery);
        } else {
          await h.append(settlement + delivery);
        }
        await readCommitted();
        assert.deepEqual(countsOf(h.latest()), expected, `the settled member alone leaves the count: ${where}`);
        assert.deepEqual(
          h.snapshots.slice(mark).map(countsOf),
          [expected],
          `no read publishes an unknown in between: ${where}`,
        );
        assert.deepEqual(h.gaps, [], `nothing here is a source gap: ${where}`);
      } finally {
        opens.restore();
        h?.controller.dispose();
      }
    }
  }
});

test("a same-window delivery that the window does not settle first still withdraws both categories", async () => {
  const unlaunched = "bzzzzzzzz";
  const enqueue = (id: string): string =>
    queueOperationRow("enqueue", { content: taskNotificationEnvelope(id, "completed", "tool-x") });
  const deliver = (id: string): string => queuedCommandDeliveryRow(taskNotificationEnvelope(id, "completed", "tool-x"));
  const cases: Array<[string, string]> = [
    ["a delivery written before its own settlement", deliver(SHELL_1) + enqueue(SHELL_1)],
    ["a delivery of another member the census still counts", enqueue(SHELL_1) + deliver(TASK_1)],
    ["a delivery of a settlement this run never launched", enqueue(unlaunched) + deliver(unlaunched)],
  ];
  for (const [label, rows] of cases) {
    const received: NativeClaudeWatchHandlers[] = [];
    const h = await launchedTaskAndShell(received);
    await h.append(rows);
    readNow(received);
    await waitFor(() => h.latest().activeTasks === null, `must withdraw tasks: ${label}`);
    assert.equal(h.latest().activeShells, null, `must withdraw shells too: ${label}`);
    await settle();
    assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null }, `nothing restores it: ${label}`);
    h.controller.dispose();
  }

  // An agent this run counts only through its lifetime is not a ledger settlement,
  // so its delivery is judged exactly as it would be in a later window.
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("SubagentStart", { agent_id: TASK_2 });
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });
  await h.append(enqueue(TASK_2) + deliver(TASK_2));
  readNow(received);
  await waitFor(() => h.latest().activeTasks === null, "a lifetime-only settlement does not vouch its delivery");
  assert.equal(h.latest().activeShells, null);
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

for (const [label, firstBytes] of [
  ["an empty", (_row: string) => ""],
  ["a partial first-record", (row: string) => row.slice(0, 24)],
] as const) {
  test(`${label} materialization read keeps the missing file's foreground fence until a record is consumed`, async () => {
    const received: NativeClaudeWatchHandlers[] = [];
    const h = await createHarness({ createEmpty: true, watchFile: manualWatch(received) });
    const opens = observeOpens();
    try {
      h.controller.observeOwnedStartup();
      // Every hook — the question and the confirmed launch included — arrives while
      // the provider's root JSONL still does not exist, so no position can fence it.
      liveOrderHooks(h);
      liveLaunch(h);
      await committed(opens.of(h.transcript));
      assert.equal(h.latest().busy, false, "stopped on the standing request");
      assert.equal(h.latest().activeShells, 1, "the launch counts on the hook lane");

      // The provider creates the file before it writes its first record, and the
      // creation wakes a read that finds no whole record in it.
      const prompt = jsonRow({
        type: "user",
        sessionId: SESSION,
        isSidechain: false,
        message: { role: "user", content: "the prompt the operator submitted" },
      });
      const early = firstBytes(prompt);
      await fs.writeFile(h.transcript, early, "utf8");
      const before = opens.of(h.transcript).length;
      readNow(received);
      assert.equal(opens.of(h.transcript).length, before + 1, "the creation itself woke one read");
      await committed(opens.of(h.transcript));
      assert.equal(h.latest().busy, false, "a read that consumed no record changes nothing");

      // The rest of the turn the hooks already described lands: its prompt, its own
      // model row, and the completion. None of it is newer than those hooks.
      await h.append(prompt.slice(early.length) + rootAssistantToolUseRow() + queueOperationRow("enqueue", {
        content: taskNotificationEnvelope(SHELL_1, "completed", "tool-a"),
      }));
      readNow(received);
      await committed(opens.of(h.transcript));
      assert.equal(h.latest().activeShells, 0, "the completion settles its member");
      assert.equal(h.latest().pendingInput, true, "the request is still open");
      assert.equal(h.latest().busy, false, "and the turn's own rows never ended the pause");

      // The first window that consumed records gave the fence a real position, so a
      // root row appended after it — work no hook reported — still ends the pause.
      await h.append(rootAssistantTextRow());
      readNow(received);
      await committed(opens.of(h.transcript));
      assert.equal(h.latest().busy, null, "genuine newer root work ends the pause");
      assert.equal(h.latest().pendingInput, true, "without erasing the open request");
      assert.equal(h.latest().activeShells, 0, "or touching the settled census");
      assert.deepEqual(h.gaps, [], "a file that appeared late was never a coverage hole");
    } finally {
      opens.restore();
      h.controller.dispose();
    }
  });
}

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

  // The provider's next complete census rebuilds the shell category exactly. The task
  // category does not come back on it: a whole-lane loss is a hole no agent can be
  // attributed to, and the agent it may hide is exactly what an in-flight census
  // leaves out. Independence still holds — one axis is exact beside the other.
  h.hook("Stop", {
    prompt_id: "prompt-1",
    background_counts: { tasks: 0, shells: 1 },
    background_members: [{ id: SHELL_1, kind: "shell" }],
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 1 });
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

  const before = h.latest();

  // One real background launch projection with a request identity this observer
  // cannot read. The reducer degrades the axes that identity supported; the launch
  // it positively states is still this run's fact, and a census that stayed
  // known-empty would now be a lie.
  const unreadable = {
    tool_name: "Bash",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  };
  h.hook("PostToolUse", unreadable);
  const after = h.latest();
  assert.deepEqual(countsOf(after), { tasks: 0, shells: 1 }, "the positively stated shell launch counts");

  // WHICH axes that payload contradicted is the reducer's declaration, not this
  // controller's: acquisition must publish exactly the degraded snapshot the
  // reducer returns — never a wider withdrawal and never a stale value for an
  // axis it declared. The same events through a standalone reducer state that
  // declaration, so this pins the publication exactly without restating the
  // reducer's own width (which its own tests own).
  const reference = new NativeClaudeStatusReducer();
  reference.observeOwnedStartup();
  const envelope = { backend: "claude", session_id: SESSION, transcript_path: h.transcript };
  reference.reduce({ ...envelope, hook_event_name: "SessionStart" });
  reference.reduce({ ...envelope, hook_event_name: "UserPromptSubmit", prompt_id: "prompt-1" });
  const declared = reference.reduce({ ...envelope, hook_event_name: "PostToolUse", ...unreadable });
  assert.equal(declared.outcome, "invalid", "the reducer refuses the unreadable identity");
  if (declared.outcome !== "invalid") return;
  assert.ok(declared.affects.includes("foreground"), "the foreground the unreadable identity supported degrades");
  assert.equal(after.busy, null);
  assert.deepEqual(after.activity, []);
  assert.equal(after.busy, declared.snapshot.busy);
  assert.equal(after.pendingInput, declared.snapshot.pendingInput,
    "the published input census is exactly the reducer's declared one");
  assert.equal(
    after.pendingInput,
    declared.affects.includes("questionCensus") ? null : before.pendingInput,
    "a declared census hole is unknown; an undeclared census keeps its value",
  );

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

/*
 * A child's question census hole is THAT child's. A question a child asked without
 * a request identity can never be closed exactly, so what ends the hole is the
 * child's own DEFINITIVE execution end — reported from the run's own lifetime seam,
 * where only this run's own scoped, positioned evidence can establish it. A turn
 * boundary that merely parked the child, another child's end, and every root-side
 * recovery clear nothing; a keyed child request keeps closing exactly, as before.
 */

test("a definitively ended child restores the input census its own gap cost it", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  assert.equal(h.latest().pendingInput, false, "the host's own run states its census from its beginning");

  // Two live children, so the task count can show which of them is still counted.
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "SubagentStart", AGENT_D);
  assert.deepEqual(countsOf(h.latest()), { tasks: 2, shells: 0 });

  // Two children each ask something this observer can never key: no `tool_use_id`,
  // so no exact close can ever consume the request. Each gap belongs to the child
  // that spoke, and each has to be ended by that child's own evidence.
  childHook(h, "PreToolUse", AGENT_A, { tool_name: "AskUserQuestion" });
  assert.equal(h.latest().pendingInput, null, "an unkeyable child question makes the census unknown");
  childHook(h, "PreToolUse", AGENT_D, { tool_name: "AskUserQuestion" });
  assert.equal(h.latest().pendingInput, null);

  // Negative control 1: A's turn ends owning nothing. That is a candidate boundary
  // with no completion record in the same window — one conjunct, not an end — so
  // A's gap stands.
  childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
  await settle();
  assert.equal(h.latest().pendingInput, null, "a plain SubagentStop is not an end and clears nothing");

  // Negative control 2: the ROOT recovers. An accepted root prompt ends a ROOT
  // census hole; a child's conversation is not its business.
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  await settle();
  assert.equal(h.latest().pendingInput, null, "root-only recovery clears nothing of a child's gap");

  // Negative control 3: D ends DEFINITIVELY — its own clean boundary and its own
  // terminal record. D's gap goes; A's is untouched, and the census stays unknown.
  childHook(h, "SubagentStop", AGENT_D, { background_members: [{ id: AGENT_D, kind: "task" }] });
  await h.append(taskStatusRow(AGENT_D, "completed"));
  await waitFor(() => countsOf(h.latest()).tasks === 1, "D closes on its own record");
  assert.equal(h.latest().pendingInput, null, "another child's end leaves this child's gap unresolved");

  // The first definitive end of the named child is the first thing that can
  // restore the census: A has actually ended, so it cannot still hold a request.
  await h.append(taskStatusRow(AGENT_A, "completed"));
  await waitFor(() => countsOf(h.latest()).tasks === 0, "A closes on its own record");
  await settle();
  assert.equal(
    h.latest().pendingInput,
    false,
    "the ended child's own gap is gone, and no other child's coverage was needed",
  );

  // Existing exact-request semantics are untouched: a keyed child request is
  // positively pending input, and its own exact close consumes it outright — no
  // hole is opened, so nothing needs an end to recover.
  childHook(h, "PreToolUse", AGENT_A, { tool_name: "AskUserQuestion", tool_use_id: "toolu-child-q" });
  assert.equal(h.latest().pendingInput, true, "a keyed child request is observed pending input");
  childHook(h, "PostToolUse", AGENT_A, { tool_name: "AskUserQuestion", tool_use_id: "toolu-child-q" });
  assert.equal(h.latest().pendingInput, false, "its own exact close recovers the census with no gap behind it");
  h.controller.dispose();
});

test("a completion this run cannot place never ends the child or restores its input gap", async () => {
  // The watcher is driven by hand so the terminal row is consumed only when this
  // test says so: a read that ran earlier would place the row inside the window it
  // really belongs to, which is a different fact from the one under test.
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  try {
    h.controller.observeOwnedStartup();
    await beginTurn(h, "prompt-1");
    childHook(h, "SubagentStart", AGENT_A);
    childHook(h, "PreToolUse", AGENT_A, { tool_name: "AskUserQuestion" });
    assert.equal(h.latest().pendingInput, null, "the child's unkeyable question opened its own gap");

    // A terminal row for the window that is about to be superseded, written before
    // the next execution edge gives the new window its floor.
    await h.append(taskStatusRow(AGENT_A, "completed"));
    childHook(h, "SubagentStart", AGENT_A);

    // Stale evidence: the row sits BELOW the current window's floor, and this
    // window's own boundary is clean. Reading the row is not evidence that this
    // window ended, so A is not ended and its gap cannot be restored on it.
    childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
    readNow(received);
    await settle();
    assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "a completion below the floor closes nothing");
    assert.equal(h.latest().pendingInput, null, "an unplaced end restores no child's census");

    // A genuine current-window boundary, and a completion written after its own
    // floor, is what ends A — and that is when its gap finally goes.
    childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
    await h.append(taskStatusRow(AGENT_A, "cancelled"));
    readNow(received);
    await waitFor(() => countsOf(h.latest()).tasks === 0, "A closes on a record its own window can hold");
    await settle();
    assert.equal(h.latest().pendingInput, false, "the properly placed end is the first that restores the census");
  } finally {
    h.controller.dispose();
  }
});

test("a newer unkeyable question outranks an older window's completion for the same child", async () => {
  // Driven by hand: the whole finding is about a row that is WRITTEN before the
  // newer question and READ only after it. An automatic read in between would place
  // it inside the window it really belongs to and hide the path under test.
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  try {
    h.controller.observeOwnedStartup();
    await beginTurn(h, "prompt-1");
    childHook(h, "SubagentStart", AGENT_A);

    // A opens a question no request identity can key, its turn then ends cleanly,
    // and the provider appends the completion row for THAT window — all before this
    // observer next reads the file, so the row is still live end evidence.
    childHook(h, "PreToolUse", AGENT_A, { tool_name: "AskUserQuestion" });
    childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
    await h.append(taskStatusRow(AGENT_A, "completed"));

    // Then the same child speaks again, with no `SubagentStart` and no other edge in
    // between. Its tool name is unreadable, which can hide a question exactly as an
    // unkeyable `AskUserQuestion` can — so it is the reducer's own attribution of the
    // hole to this child, not a hand-picked list of reasons, that reopens the window
    // and retires the older window's end candidate.
    childHook(h, "PreToolUse", AGENT_A, {});

    // The older row is read now, and it closes nothing: it sits below the floor of
    // the window the newer question opened, and an end this run cannot attribute to
    // the current execution recovers no census.
    readNow(received);
    await settle();
    assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "an older window's completion closes nothing");
    assert.equal(h.latest().pendingInput, null, "the newer hole stands: a stale end restores no child's census");

    // The current window's own boundary and its own record are the first end that
    // can settle this child — and that is when its hole finally goes.
    childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
    await h.append(taskStatusRow(AGENT_A, "cancelled"));
    readNow(received);
    await waitFor(() => countsOf(h.latest()).tasks === 0, "A closes inside the window that saw the question");
    await settle();
    assert.equal(h.latest().pendingInput, false, "only the current window's end restores the child's census");
  } finally {
    h.controller.dispose();
  }
});

test("a replayed child request the reducer no longer remembers is refused before it can strand any hole", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  try {
    h.controller.observeOwnedStartup();
    await beginTurn(h, "prompt-1");
    childHook(h, "SubagentStart", AGENT_A);

    // More keyed child requests than the reducer's closed-request memory holds, each
    // opened and closed exactly once. By the end of this loop the FIRST of them is
    // outside that cache, while this controller's own settled-request fence still
    // names it — the asymmetry a late replay is judged against.
    for (let index = 0; index < 40; index += 1) {
      const requestId = `toolu-child-q${index}`;
      childHook(h, "PreToolUse", AGENT_A, { tool_name: "AskUserQuestion", tool_use_id: requestId });
      childHook(h, "PostToolUse", AGENT_A, { tool_name: "AskUserQuestion", tool_use_id: requestId });
    }
    assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "the child is still the only task");

    // A NEW unkeyable hole for that child, then its clean boundary, then the terminal
    // record the provider appends for that very window — written, and not yet read.
    childHook(h, "PreToolUse", AGENT_A, { tool_name: "AskUserQuestion" });
    assert.equal(h.latest().pendingInput, null, "the child's current hole stands");
    childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
    // The manual watcher cannot stop direct hook-triggered reads. Do not yield
    // between writing the terminal row and replaying the close.
    appendFileSync(h.transcript, taskStatusRow(AGENT_A, "completed"), "utf8");
    assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "the child is still counted before replay");

    // That first close arrives again. The reducer evicted the request long ago, so it
    // declares an attributed census hole for it; this controller remembers settling
    // that request, so the replay cannot move the child's execution window and make
    // the record it just wrote look like evidence from an older turn.
    childHook(h, "PostToolUse", AGENT_A, { tool_name: "AskUserQuestion", tool_use_id: "toolu-child-q0" });

    // The first read therefore retires the task on its own record and clears that
    // child's own hole.
    readNow(received);
    await waitFor(() => countsOf(h.latest()).tasks === 0, "the current window's own record still ends the child");
    await settle();
    assert.equal(h.latest().pendingInput, false, "and the current hole goes with it");

    // The SAME settled request now replays again, after this child definitively
    // ended. Its close first: the reducer evicted this request long ago, so an
    // unfenced replay is a close it never saw open — an attributed hole on a child
    // with no later end left to clear it. The settled-request fence is longer than
    // that cache, so the replay is refused before the question census is touched.
    childHook(h, "PostToolUse", AGENT_A, { tool_name: "AskUserQuestion", tool_use_id: "toolu-child-q0" });
    assert.equal(h.latest().pendingInput, false, "a replay after definitive end cannot open an orphaned hole");
    // Then its open: a request this run already answered cannot be re-staged as a
    // pending question either.
    childHook(h, "PreToolUse", AGENT_A, { tool_name: "AskUserQuestion", tool_use_id: "toolu-child-q0" });
    assert.equal(h.latest().pendingInput, false, "the settled request cannot reopen either");

    // What the fence refuses is a KEYED settled request and nothing else. The same
    // child's next unkeyable question still declares its hole — a missing request
    // identity is never proof of a replay, and deduplicating child edges by agent
    // would silently swallow a genuinely new question. It is still that child's own
    // resumed execution edge, so its counted window reopens with it.
    childHook(h, "PreToolUse", AGENT_A, { tool_name: "AskUserQuestion" });
    assert.equal(h.latest().pendingInput, null, "an unkeyable current edge is still unknown, not deduplicated");
    assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "and a current edge still counts as the child working again");
  } finally {
    h.controller.dispose();
  }
});

test("a settled request replayed on an unreadable child identity is not fenced, so its scope damage stands", async () => {
  const h = await createHarness();
  try {
    h.controller.observeOwnedStartup();
    await beginTurn(h, "prompt-1");
    childHook(h, "SubagentStart", AGENT_A);

    // One keyed child question, opened and closed exactly once: its request identity
    // is now settled, and this run's input claim is positively known-closed.
    childHook(h, "PreToolUse", AGENT_A, { tool_name: "AskUserQuestion", tool_use_id: "toolu-child-q0" });
    assert.equal(h.latest().pendingInput, true, "the keyed child question is pending");
    childHook(h, "PostToolUse", AGENT_A, { tool_name: "AskUserQuestion", tool_use_id: "toolu-child-q0" });
    assert.equal(h.latest().pendingInput, false, "its own close settles it");

    // The same request replayed on THIS child is the settled replay the fence exists
    // for: it states nothing, and the known-closed claim survives it.
    childHook(h, "PostToolUse", AGENT_A, { tool_name: "AskUserQuestion", tool_use_id: "toolu-child-q0" });
    assert.equal(h.latest().pendingInput, false, "a valid owned replay still states nothing");

    // The same request identity arriving on a child identity nobody can read is a
    // different edge. Its provenance is unusable, so the reducer — not this fence —
    // states what it could have contradicted, and a question edge of an unreadable
    // provenance could have been this run's own standing close. The input claim goes
    // unknown instead of being preserved as falsely known.
    h.hook("PostToolUse", {
      agent_id: " ",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu-child-q0",
    });
    assert.equal(h.latest().pendingInput, null, "an unreadable child identity is never a settled replay");
  } finally {
    h.controller.dispose();
  }
});

test("a child edge naming another transcript leaves a provenance hole and never moves the child's window", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  try {
    h.controller.observeOwnedStartup();
    await beginTurn(h, "prompt-1");
    childHook(h, "SubagentStart", AGENT_A);

    // A's clean boundary and the completion row the provider wrote for THIS window:
    // live end evidence, not yet read.
    childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
    await h.append(taskStatusRow(AGENT_A, "completed"));

    // A child edge from this same session naming a DIFFERENT transcript file. This
    // run does not own that source — the child's own terminal record will not appear
    // in the one transcript this controller watches — so the hole it declares stays
    // provenance-wide, and it has no standing to move A's execution window either.
    const other = path.join(h.dir, "other-conversation.jsonl");
    await fs.writeFile(other, "", "utf8");
    h.hook("PreToolUse", {
      agent_id: AGENT_A,
      tool_name: "AskUserQuestion",
      transcript_path: other,
    });
    assert.equal(h.latest().pendingInput, null, "the hole is still declared, provenance-wide");

    // So the untouched window still ends on its own record: the mismatched edge left
    // A's lifetime exactly where it was, instead of stranding a healthy agent.
    readNow(received);
    await waitFor(() => countsOf(h.latest()).tasks === 0, "the untouched window still ends on its own record");

    // And the hole outlives that end. No child's end clears a provenance-wide hole,
    // which is precisely the hole this transcript cannot settle — so it is never
    // offered as one a child's own completion could recover.
    await settle();
    assert.equal(h.latest().pendingInput, null, "a provenance hole outlives every child's end");
  } finally {
    h.controller.dispose();
  }
});

test("a known child's own hole is a reason to watch the transcript when nothing else asks", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  try {
    // No owned count baseline, no root `Stop`, no published counts, no root question:
    // this run has a bound transcript and not one reason to read it.
    await beginTurn(h, "prompt-1");
    assert.equal(received.length, 0, "nothing asks for the transcript watch yet");

    childHook(h, "SubagentStart", AGENT_A);
    assert.equal(received.length, 0, "a live agent alone is not a reason to read the file");

    // The child opens a question no request identity can key. The hole is attributed
    // to A, and A is an agent this run positively established, so the only row that
    // can settle it is A's own terminal record — which lives in the ONE transcript
    // this controller already knows how to watch.
    childHook(h, "PreToolUse", AGENT_A, { tool_name: "AskUserQuestion" });
    assert.equal(h.latest().pendingInput, null, "the child's unkeyable question opened its own hole");
    assert.ok(
      received.length > 0,
      "the attributed hole of a known child keeps the existing transcript watch alive",
    );

    // Its turn ends cleanly and the provider appends the record. Without that watch
    // this row would sit unread until some unrelated event started monitoring.
    childHook(h, "SubagentStop", AGENT_A, { background_members: [{ id: AGENT_A, kind: "task" }] });
    await h.append(taskStatusRow(AGENT_A, "completed"));
    readNow(received);
    await waitFor(() => h.latest().pendingInput === false, "the child's own appended record settles its own hole");
  } finally {
    h.controller.dispose();
  }
});

test("a lost completion source strands an agent's end, and never widens into an identity hole", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  try {
    h.controller.observeOwnedStartup();
    await beginTurn(h, "prompt-1");
    childHook(h, "SubagentStart", AGENT_A);
    assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 });

    // The observer of the one bound transcript reports its own failure. This file is
    // one of the two places an agent's own completion is read, so A's END is now
    // unprovable. Identity edges arrive on the hook lane, which is healthy, so no
    // agent could have gone unnamed inside this hole — the width of the hole is what
    // the caller states, and this one is the completion source.
    const watch = received.at(-1);
    assert.ok(watch !== undefined, "the bound transcript is being watched");
    watch.onError(new Error("the watched transcript reported a failure"));
    await settle();
    assert.deepEqual(
      countsOf(h.latest()),
      { tasks: null, shells: 0 },
      "A is preserved across the hole, and the shell axis is untouched",
    );

    // The provider's next complete census keys A as an in-flight task. A's lifetime
    // is still unresolved, and every identity is still one this observer met, so the
    // exact union stands: a completion-source hole never widens past what it names.
    h.hook("Stop", {
      background_counts: { tasks: 1, shells: 0 },
      background_members: [{ id: AGENT_A, kind: "task" }],
    });
    assert.deepEqual(
      countsOf(h.latest()),
      { tasks: 1, shells: 0 },
      "a known agent's stranded end never becomes an unattributable identity hole",
    );
  } finally {
    h.controller.dispose();
  }
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

  // A's own lane arriving again is the agent-specific recovery for A: its lifetime is
  // observable from here. It is not evidence about an agent this observer never met —
  // a whole-lane loss names nobody — so the task axis stays withdrawn where an
  // attributable gap would have recovered on this edge.
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 0 }, "one agent's edge cannot account for an unnamed one");

  // The boundary that does end it is one that positively states a new conversation
  // began: from there every agent of this run has to arrive on a start edge this
  // observer actually receives, so the counted set is the whole set again.
  h.hook("SessionStart", { source: "clear" });
  await settle();
  h.hook("Stop", { background_counts: { tasks: 0, shells: 0 }, background_members: [] });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 }, "a positively fresh conversation can be counted again");
  h.controller.dispose();
});

test("an exact root census that keys an agent whose OWN lane was lost states the task count without trusting its lifetime", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  // A root shell, so the shell axis can be shown independent of the task axis.
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
  // The bind-time read lands first, so the identity the lane holds is the one the
  // replacement is measured against.
  await settle();
  // A's named child transcript is replaced by a distinct file: a cursor into the
  // old one says nothing about the new one, so A's OWN evidence is gone. This is
  // the scoped kind of uncertainty — the identity is positively established, and
  // every other agent's coverage is intact.
  const original = await fs.lstat(childFile, { bigint: true });
  await fs.rename(childFile, path.join(h.dir, "agent-child.retained-original.jsonl"));
  await fs.writeFile(childFile, "", { encoding: "utf8", flag: "wx" });
  const replacement = await fs.lstat(childFile, { bigint: true });
  assert.ok(
    replacement.dev !== original.dev || replacement.ino !== original.ino,
    "the fixture really replaced the bound file with a distinct dev/ino",
  );
  await h.append(queueOperationRow("remove", { reason: "unrelated" }));
  await waitFor(() => h.gaps.includes("replaced"), "A's own lane reports its own loss");
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: null, shells: 2 },
    "one agent's lost lane costs that agent's exactness, and nothing else",
  );

  // A complete root census that positively KEYS A as an in-flight task: A is
  // counted exactly once through that membership whatever its lifetime is, so
  // the union's size is known immediately. A's lifetime stays unresolved.
  h.hook("Stop", {
    background_counts: { tasks: 1, shells: 1 },
    background_members: [{ id: AGENT_A, kind: "task" }, { id: "b9rootshell", kind: "shell" }],
  });
  await settle();
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: 1, shells: 1 },
    "a keyed unresolved agent is one exact task, and the shell census stands beside it",
  );

  // A later complete root census that omits A: an in-flight omission is not A's
  // death, and A's lifetime is still unresolved, so the axis is unknown again.
  h.hook("Stop", { background_counts: { tasks: 0, shells: 1 }, background_members: [{ id: "b9rootshell", kind: "shell" }] });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 1 }, "an omission never reads as death");

  // A's own child edge is the agent-specific recovery.
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });
  h.controller.dispose();
});

test("a census keying every tracked agent still cannot state the task count across a hole no agent can be attributed to", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  // Two tracked agents and one root shell: the census below can key EVERY identity
  // this run holds, and still be an incomplete list of this run's agents.
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "SubagentStart", AGENT_D);
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-root-shell",
    background_started: { id: "b9rootshell", kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 2, shells: 1 });

  // The authenticated lane is lost. Every edge inside the hole is gone, and the
  // lane that carries `SubagentStart` — the one edge that makes an agent known —
  // is part of it, so a THIRD agent may have started and parked in there. A parked
  // agent is absent from every in-flight snapshot the provider ever emits, so no
  // later census can show that it does not exist.
  h.controller.acceptFailure({ backend: "claude", reason: "input-malformed" });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null });

  // The first complete root census keys both tracked agents and the shell. That is
  // a complete list of the agents this observer happens to hold — which is the
  // claim that is not defensible. The task axis stays unknown; the SHELL axis is a
  // separate provider statement and recovers immediately, independently.
  h.hook("Stop", {
    background_counts: { tasks: 2, shells: 1 },
    background_members: [
      { id: AGENT_A, kind: "task" },
      { id: AGENT_D, kind: "task" },
      { id: "b9rootshell", kind: "shell" },
    ],
  });
  await settle();
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: null, shells: 1 },
    "a keyed census never manufactures a complete agent set",
  );

  // An empty census is the same claim in the other direction: the provider's
  // in-flight array excludes parked agents by design.
  h.hook("Stop", { background_counts: { tasks: 0, shells: 1 }, background_members: [{ id: "b9rootshell", kind: "shell" }] });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 1 }, "an empty in-flight census proves nothing about identity coverage");

  // An unrelated root prompt repairs nothing either: it is not this axis's evidence.
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 1 }, "root-only recovery restores no task count");

  // Each tracked agent's own edge is the shipped AGENT-SPECIFIC recovery, and it is
  // still applied: every identity this observer holds is resolved again. That is not
  // the same claim as a complete agent set — an identity never named is untouched by
  // it — so the task axis stays withdrawn even now, while the shell axis stays
  // numeric beside it.
  childHook(h, "SubagentStart", AGENT_A);
  childHook(h, "SubagentStart", AGENT_D);
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 1 }, "resolved agents are not proof of a complete agent set");

  // Only a boundary that starts this run's agent census from its beginning
  // restores identity coverage: after it, every agent of the new conversation must
  // have arrived on its own start edge this observer actually received.
  h.hook("SessionStart", { source: "clear" });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null }, "the boundary itself withdraws rather than zeroes");
  h.hook("Stop", {
    background_counts: { tasks: 1, shells: 1 },
    background_members: [{ id: AGENT_A, kind: "task" }, { id: "b9rootshell", kind: "shell" }],
  });
  await settle();
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: 1, shells: 1 },
    "a fresh census over a census this run has watched from its start is exact again",
  );
  h.controller.dispose();
});

test("a hole no agent can be attributed to withdraws tasks even while nothing is tracked", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  h.hook("Stop", { background_counts: { tasks: 0, shells: 0 }, background_members: [] });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 }, "an owned run with nothing running");

  // The identity lane is lost BEFORE any agent was ever tracked. There is no
  // unresolved agent for a guard to key on, which is exactly why the guard cannot
  // live in the unresolved-agent branch: what this hole can hide is an agent this
  // run has no record of at all.
  h.controller.acceptFailure({ backend: "claude", reason: "input-malformed" });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null }, "the hole itself withdraws both axes");

  // A complete root census now keys everything the provider can list. The shell axis
  // is that provider statement and recovers at once. The task axis cannot: a parked
  // agent is precisely what an in-flight census leaves out, so an exact zero over an
  // empty agent set is still a total over a set this run cannot show is complete.
  h.hook("Stop", {
    background_counts: { tasks: 0, shells: 1 },
    background_members: [{ id: "b9rootshell", kind: "shell" }],
  });
  await settle();
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: null, shells: 1 },
    "an exact census beside an empty agent set is not a complete agent set",
  );
  h.controller.dispose();
});

test("a same-session compaction carries a hole no agent can be attributed to, and only a positively fresh conversation ends it", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-root-shell",
    background_started: { id: "b9rootshell", kind: "shell" },
  });
  h.hook("Stop", {
    background_counts: { tasks: 1, shells: 1 },
    background_members: [{ id: AGENT_A, kind: "task" }, { id: "b9rootshell", kind: "shell" }],
  });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, "one agent and one shell, both counted");

  // The lane that names agents is lost: a third agent may have started and parked
  // inside the hole without this run ever learning it existed.
  h.controller.acceptFailure({ backend: "claude", reason: "input-malformed" });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null });

  // The SAME conversation is compacted in place. This is a real scope boundary: the
  // agents this observer held belong to the history being rewritten, so they are
  // retired, and its own fences still apply. But a compaction describes PRIOR
  // history — it says nothing about whether an agent hidden inside the hole went
  // away — so the hole is carried, and a census that keys everything afterwards is
  // still an incomplete list. Only the task axis stays withdrawn; the shell axis is
  // the provider's own statement and recovers here.
  h.hook("SessionStart", { source: "compact" });
  await settle();
  h.hook("Stop", {
    background_counts: { tasks: 1, shells: 1 },
    background_members: [{ id: AGENT_A, kind: "task" }, { id: "b9rootshell", kind: "shell" }],
  });
  await settle();
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: null, shells: 1 },
    "a compaction retires the agents it held and restores no identity coverage",
  );

  // The provider's own fresh-start value is different evidence: it positively states
  // that a new conversation began, whose every agent has to arrive on a start edge
  // this observer actually receives. Only there does the task axis become statable
  // again — and it is stated from the census, not guessed.
  h.hook("SessionStart", { source: "clear" });
  await settle();
  h.hook("Stop", {
    background_counts: { tasks: 1, shells: 1 },
    background_members: [{ id: AGENT_A, kind: "task" }, { id: "b9rootshell", kind: "shell" }],
  });
  await settle();
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: 1, shells: 1 },
    "a positively established fresh conversation can be counted again",
  );
  h.controller.dispose();
});

test("a replayed startup for the still-bound session is not a fresh census", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  // The run's own positive fresh start, admitted because nothing was bound yet.
  h.hook("SessionStart", { source: "startup" });
  h.hook("UserPromptSubmit", { prompt_id: "prompt-1" });
  childHook(h, "SubagentStart", AGENT_A);
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-root-shell",
    background_started: { id: "b9rootshell", kind: "shell" },
  });
  h.hook("Stop", {
    background_counts: { tasks: 1, shells: 1 },
    background_members: [{ id: AGENT_A, kind: "task" }, { id: "b9rootshell", kind: "shell" }],
  });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, "one agent and one shell, both counted");

  // The lane is lost. The reducer releases its binding; this controller does not
  // release the conversation it positively proved.
  h.controller.acceptFailure({ backend: "claude", reason: "input-malformed" });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null });

  // The very same `startup` arrives again, naming the session this run is still
  // running. It is a replay over a conversation that never changed, not a new
  // conversation, so it cannot restart the agent census it would otherwise clear.
  h.hook("SessionStart", { source: "startup" });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null }, "the replay states nothing");

  // The next keyed root snapshot therefore states the shell it names, and still
  // cannot state the task axis: the agent that may have parked inside the lost lane
  // is unaccounted for, replay or no replay.
  h.hook("Stop", {
    background_counts: { tasks: 1, shells: 1 },
    background_members: [{ id: AGENT_A, kind: "task" }, { id: "b9rootshell", kind: "shell" }],
  });
  await settle();
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: null, shells: 1 },
    "a replayed startup restores no identity coverage",
  );

  // A boundary without a session releases the binding without proving a replacement.
  // The start this run already ran is still not a new conversation: the retained
  // binding rejects its replay, while nothing else about the released binding is
  // used to admit ordinary hooks or restore a count.
  h.controller.acceptFailure({ backend: "claude", reason: "input-malformed" });
  h.hook("SessionStart", { session_id: undefined, source: "clear" });
  h.hook("SessionStart", { source: "startup" });
  h.hook("Stop", {
    background_counts: { tasks: 0, shells: 1 },
    background_members: [{ id: "b9rootshell", kind: "shell" }],
  });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 1 }, "an unidentified boundary does not make the old startup fresh");
  h.controller.dispose();
});

test("a fresh-labeled start that names no session restores no identity coverage", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-root-shell",
    background_started: { id: "b9rootshell", kind: "shell" },
  });
  h.hook("Stop", {
    background_counts: { tasks: 1, shells: 1 },
    background_members: [{ id: AGENT_A, kind: "task" }, { id: "b9rootshell", kind: "shell" }],
  });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 });

  h.controller.acceptFailure({ backend: "claude", reason: "input-malformed" });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: null });

  // A start carrying the provider's own fresh value but naming no session at all:
  // there is no conversation behind the label, so it cannot be the proof that a
  // census began. It retires what was held and carries the hole.
  h.hook("SessionStart", { session_id: "", source: "clear" });
  await settle();
  h.hook("Stop", {
    background_counts: { tasks: 0, shells: 1 },
    background_members: [{ id: "b9rootshell", kind: "shell" }],
  });
  await settle();
  assert.deepEqual(
    countsOf(h.latest()),
    { tasks: null, shells: 1 },
    "a fresh label with no identity behind it proves nothing",
  );
  h.controller.dispose();
});

test("an unresolved agent the exact census lists as a shell, or a census that is not exact, keeps tasks unknown", async () => {
  const h = await createHarness();
  h.controller.observeOwnedStartup();
  await beginTurn(h, "prompt-1");
  childHook(h, "SubagentStart", AGENT_A);
  h.controller.acceptFailure({ backend: "claude", reason: "input-malformed" });
  await settle();
  // Membership positively contradicts the agent identity: unknown, never a guess.
  h.hook("Stop", { background_counts: { tasks: 0, shells: 1 }, background_members: [{ id: AGENT_A, kind: "shell" }] });
  await settle();
  assert.equal(countsOf(h.latest()).tasks, null, "a shell-keyed agent identity is a conflict");
  h.controller.dispose();

  // Totals alone are not membership: no exact census, no derived count.
  const totalsOnly = await createHarness();
  totalsOnly.controller.observeOwnedStartup();
  await beginTurn(totalsOnly, "prompt-1");
  childHook(totalsOnly, "SubagentStart", AGENT_A);
  totalsOnly.controller.acceptFailure({ backend: "claude", reason: "input-malformed" });
  await settle();
  totalsOnly.hook("Stop", { background_counts: { tasks: 1, shells: 0 } });
  await settle();
  assert.equal(countsOf(totalsOnly.latest()).tasks, null, "a total that could contain the agent proves nothing");
  totalsOnly.controller.dispose();
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

/** A run with A parked on its own shell, its named child transcript bound and empty. */
async function parkedAgentWithChildLane(
  h: Harness,
  childFile: string,
): Promise<void> {
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
    agent_transcript_path: childFile,
  });
}

function childDeliveryRow(): string {
  return jsonRow({
    type: "user",
    isMeta: true,
    sessionId: SESSION,
    agentId: AGENT_A,
    message: { role: "user", content: taskNotificationEnvelope(SHELL_1, "completed", CHILD_TOOL_USE) },
  });
}

test("a child-lane read requested while one is in flight is drained after it commits", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  const childFile = path.join(h.dir, "agent-child.jsonl");
  await fs.writeFile(childFile, "", "utf8");
  const opens = observeOpens([childFile]);
  try {
    await parkedAgentWithChildLane(h, childFile);
    // The binding's own read has sized and read the still-empty file and is parked
    // before it commits.
    const [first] = opens.of(childFile);
    assert.ok(first !== undefined, "the binding read the child lane");
    await first.closing;
    await committed(opens.of(h.transcript));
    assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, "A parks on its own shell");

    // The provider delivers into A's own transcript and records the root row. The
    // root read that append wakes asks for a child read while the first is still in
    // flight: one read at a time, so it must be remembered, not run concurrently.
    await fs.appendFile(childFile, childDeliveryRow(), "utf8");
    await h.append(queueOperationRow("remove", { reason: "delivered_to_agent" }));
    readNow(received);
    await committed(opens.of(h.transcript));
    assert.equal(opens.of(childFile).length, 1, "no second read runs beside the first");
    assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 1 }, "nothing has read the delivery yet");

    // The first read commits what it saw — nothing — and the remembered request is
    // drained after it. No further root append is needed.
    first.release();
    await committed([first]);
    assert.equal(opens.of(childFile).length, 2, "the request made during the first read is drained after it");
    await committed(opens.of(childFile));
    assert.deepEqual(countsOf(h.latest()), { tasks: 1, shells: 0 }, "the routed work settles; A is woken, never ended");
    assert.equal(opens.of(childFile).length, 2, "one drain for one request: nothing spins");
    assert.deepEqual(h.gaps, []);
  } finally {
    opens.restore();
    h.controller.dispose();
  }
});

test("a child-lane request queued behind a read never resurrects a lane replaced meanwhile", async () => {
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({ watchFile: manualWatch(received) });
  const childFile = path.join(h.dir, "agent-child.jsonl");
  const reboundFile = path.join(h.dir, "agent-child-rebound.jsonl");
  await fs.writeFile(childFile, "", "utf8");
  await fs.writeFile(reboundFile, "", "utf8");
  const opens = observeOpens([childFile]);
  try {
    await parkedAgentWithChildLane(h, childFile);
    const [first] = opens.of(childFile);
    assert.ok(first !== undefined, "the binding read the child lane");
    await first.closing;
    await committed(opens.of(h.transcript));

    // A request is queued behind the parked read, and then the provider names a
    // different transcript for A: the old lane is discarded, not re-pointed.
    await fs.appendFile(childFile, childDeliveryRow(), "utf8");
    await h.append(queueOperationRow("remove", { reason: "delivered_to_agent" }));
    readNow(received);
    await committed(opens.of(h.transcript));
    childHook(h, "SubagentStop", AGENT_A, {
      background_members: [{ id: AGENT_A, kind: "task" }, { id: SHELL_1, kind: "shell" }],
      agent_transcript_path: reboundFile,
    });
    await committed([...opens.of(h.transcript), ...opens.of(reboundFile)]);
    await committed(opens.of(reboundFile));
    const reboundReads = opens.of(reboundFile).length;
    assert.ok(reboundReads > 0, "the replacement lane is read on its own binding");

    first.release();
    await committed([first]);
    assert.equal(opens.of(childFile).length, 1, "the discarded lane's queued request dies with it");
    assert.equal(opens.of(reboundFile).length, reboundReads,
      "and is not spent on the replacement lane, which owns its own requests");
    assert.equal(countsOf(h.latest()).shells, 1, "nothing read from the discarded file settles work");
  } finally {
    opens.restore();
    h.controller.dispose();
  }
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
  //
  // Fixture precondition: the replacement must be a genuinely DISTINCT file. An
  // unlink followed by a fresh create lets the filesystem hand the freed inode
  // straight back, which would make the "replacement" indistinguishable from
  // the bound file. The original is therefore moved to a reserved fixture path
  // (keeping its inode allocated) before the new file is created exclusively.
  const original = await fs.lstat(childFile, { bigint: true });
  await fs.rename(childFile, path.join(h.dir, "agent-child.retained-original.jsonl"));
  await fs.writeFile(childFile, "", { encoding: "utf8", flag: "wx" });
  const replacement = await fs.lstat(childFile, { bigint: true });
  assert.ok(
    replacement.dev !== original.dev || replacement.ino !== original.ino,
    "the fixture really replaced the bound file with a distinct dev/ino",
  );
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

  // A's own edge re-establishes A. It cannot repair the hole the withdrawal opened:
  // that claim named no agent, so an agent that started and parked inside it is just
  // as unaccounted for now as it was before, and a task total would be a guess.
  childHook(h, "SubagentStart", AGENT_A);
  assert.deepEqual(countsOf(h.latest()), { tasks: null, shells: 0 }, "one agent's edge proves one agent");

  // Only a boundary that positively starts this run's agent census over restores the
  // axis: the provider's own fresh-start value. From there every agent of this run
  // has to arrive on a start edge this observer receives.
  h.hook("SessionStart", { source: "clear" });
  await settle();
  h.hook("Stop", { background_counts: { tasks: 0, shells: 0 }, background_members: [] });
  await settle();
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 }, "a positively fresh conversation can be counted again");
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

/* ------------------------------------- conversation identity and restoration */

/** A real selected workspace directory this test owns; nothing else is created. */
async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prg-native-claude-ws-"));
  dirs.push(dir);
  return dir;
}

interface IdentityRecorder {
  readonly calls: (string | null)[];
  accept: boolean;
  readonly report: (conversationId: string | null) => boolean;
}

/** The owner's private identity channel: records every report, accepts on demand. */
function identityRecorder(accept = true): IdentityRecorder {
  const recorder: IdentityRecorder = {
    calls: [],
    accept,
    report: (conversationId) => {
      recorder.calls.push(conversationId);
      return recorder.accept;
    },
  };
  return recorder;
}

async function restoredHarness(
  workspace: string,
  identity: IdentityRecorder,
  extra: Parameters<typeof createHarness>[0] = {},
): Promise<Harness> {
  return createHarness({
    workspace,
    resumeConversationId: SESSION,
    onConversationIdentity: identity.report,
    ...extra,
  });
}

function isAllUnknown(snapshot: NativeClaudeAcquisitionSnapshot): boolean {
  return snapshot.busy === null
    && snapshot.activity.length === 0
    && snapshot.activeTasks === null
    && snapshot.activeShells === null;
}

/** The owner's ordinary launch baseline: idle, nothing pending, Ready, 0/0. */
function isOwnedBaseline(snapshot: NativeClaudeAcquisitionSnapshot | undefined): boolean {
  return snapshot !== undefined
    && snapshot.busy === false
    && snapshot.pendingInput === false
    && snapshot.activity.length === 1
    && snapshot.activity[0] === "Ready"
    && snapshot.activeTasks === 0
    && snapshot.activeShells === 0;
}

test("restoration: activation, then the run's own root resume of the expected id, confirms identity and states the launch baseline without a prompt", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const h = await restoredHarness(workspace, identity);
  h.controller.observeOwnedStartup();
  assert.deepEqual(h.snapshots, [], "activation alone states nothing for an unproved restored run");
  assert.deepEqual(identity.calls, [], "the persisted id is an expectation, never reported unproved");

  // The provider reports its cwd as the canonical directory; the owner selected
  // the same directory through another spelling. One exact directory either way.
  h.hook("SessionStart", { source: "resume", cwd: await fs.realpath(workspace) });
  assert.deepEqual(identity.calls, [SESSION], "proved once, with no model prompt");
  assert.ok(isOwnedBaseline(h.latest()), "activation plus exact proof: idle, none, Ready, 0/0 before any prompt");
  assert.ok(h.snapshots.slice(0, -1).every(isAllUnknown), "nothing was stated before the proof");
  assert.deepEqual(h.gaps, []);

  // A repeat of the same boundary re-proves the same id: never a duplicate report,
  // and it neither resets nor re-mints the baseline. A repeated activation is inert.
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  h.controller.observeOwnedStartup();
  await settle(30);
  assert.deepEqual(identity.calls, [SESSION]);
  assert.ok(isOwnedBaseline(h.latest()));
  h.controller.dispose();
});

test("restoration: the proof, then activation, states the same launch baseline; anything of the run in between forfeits it", async () => {
  const workspace = await makeWorkspace();

  const identity = identityRecorder();
  const h = await restoredHarness(workspace, identity);
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.deepEqual(identity.calls, [SESSION]);
  assert.ok(isAllUnknown(h.latest()), "proof alone is not the owner's baseline");
  h.controller.observeOwnedStartup();
  assert.ok(isOwnedBaseline(h.latest()), "proof plus activation: idle, none, Ready, 0/0 before any prompt");
  h.controller.observeOwnedStartup();
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  await settle(30);
  assert.ok(isOwnedBaseline(h.latest()), "a late repeat of either half changes nothing");
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();

  // A prompt between the proof and activation: activation never idles it.
  const prompted = await restoredHarness(workspace, identityRecorder());
  prompted.hook("SessionStart", { source: "resume", cwd: workspace });
  prompted.hook("UserPromptSubmit", { prompt_id: "prompt-1" });
  prompted.controller.observeOwnedStartup();
  await settle(30);
  assert.equal(prompted.latest().busy, true);
  assert.equal(prompted.latest().activeTasks, null, "no launch zeros claimed over unseen work");
  assert.ok(prompted.snapshots.every((snapshot) => !isOwnedBaseline(snapshot)));
  prompted.controller.dispose();

  // Any other hook of the run in between — even a non-work Stop snapshot or a
  // child edge — also forfeits it: the late baseline could not stand over it.
  for (const between of [
    (r: Harness) => r.hook("Stop", { background_counts: { tasks: 2, shells: 1 } }),
    (r: Harness) => childHook(r, "SubagentStart", AGENT_A),
  ]) {
    const r = await restoredHarness(workspace, identityRecorder());
    r.hook("SessionStart", { source: "resume", cwd: workspace });
    between(r);
    r.controller.observeOwnedStartup();
    await settle(30);
    assert.ok(r.snapshots.every((snapshot) => !isOwnedBaseline(snapshot)), "a forfeited baseline is never minted");
    r.controller.dispose();
  }

  // A lane loss, a session end, or an unproved switch between the proof and
  // activation leaves nothing for activation to vouch.
  for (const between of [
    (r: Harness) => r.controller.acceptFailure({ backend: "claude", reason: "input-too-large" }),
    (r: Harness) => r.hook("SessionEnd", { reason: "other" }),
    (r: Harness) => r.hook("SessionStart", { source: "clear", session_id: OTHER_SESSION }),
  ]) {
    const r = await restoredHarness(workspace, identityRecorder());
    r.hook("SessionStart", { source: "resume", cwd: workspace });
    between(r);
    r.controller.observeOwnedStartup();
    await settle(30);
    assert.ok(r.snapshots.every((snapshot) => !isOwnedBaseline(snapshot)), "no baseline after a loss or switch");
    r.controller.dispose();
  }

  // A wrong proof followed by activation states nothing at all.
  const wrong = await restoredHarness(workspace, identityRecorder());
  wrong.hook("SessionStart", { source: "resume", session_id: OTHER_SESSION, cwd: workspace });
  wrong.controller.observeOwnedStartup();
  await settle(30);
  assert.deepEqual(wrong.snapshots, []);
  wrong.controller.dispose();
});

test("restoration: work of the resumed conversation seen before the proof forfeits the baseline in either order; foreign or unattributable hooks do not", async () => {
  const workspace = await makeWorkspace();
  const preProofWork: readonly { readonly label: string; readonly send: (r: Harness) => void }[] = [
    { label: "prompt", send: (r) => r.hook("UserPromptSubmit", { prompt_id: "prompt-1" }) },
    {
      label: "question",
      send: (r) => r.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" }),
    },
    {
      label: "background launch",
      send: (r) => r.hook("PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "tool-a",
        prompt_id: "prompt-1",
        background_started: { id: SHELL_1, kind: "shell" },
      }),
    },
    { label: "child edge", send: (r) => childHook(r, "SubagentStart", AGENT_A) },
  ];
  for (const work of preProofWork) {
    for (const activationFirst of [true, false]) {
      const identity = identityRecorder();
      const r = await restoredHarness(workspace, identity);
      if (activationFirst) r.controller.observeOwnedStartup();
      work.send(r);
      assert.deepEqual(r.snapshots, [], `${work.label}: nothing is admitted before the proof`);
      assert.deepEqual(identity.calls, [], `${work.label}: nothing confirms the identity before the proof`);
      r.hook("SessionStart", { source: "resume", cwd: workspace });
      r.controller.observeOwnedStartup();
      r.controller.observeOwnedStartup();
      await settle(30);
      assert.deepEqual(identity.calls, [SESSION], `${work.label}: the proof still confirms the identity`);
      assert.ok(
        r.snapshots.every((snapshot) => !isOwnedBaseline(snapshot)),
        `${work.label} (activation ${activationFirst ? "first" : "last"}): the baseline is never minted over unseen work`,
      );
      r.controller.dispose();
    }
  }

  // Another conversation's hooks, and a hook naming no session, are not the
  // resumed conversation's work and leave the baseline to the proof.
  for (const send of [
    (r: Harness) => r.hook("UserPromptSubmit", { session_id: OTHER_SESSION, prompt_id: "prompt-9" }),
    (r: Harness) => r.hook("UserPromptSubmit", { session_id: undefined, prompt_id: "prompt-9" }),
  ]) {
    const r = await restoredHarness(workspace, identityRecorder());
    r.controller.observeOwnedStartup();
    send(r);
    r.hook("SessionStart", { source: "resume", cwd: workspace });
    assert.ok(isOwnedBaseline(r.latest()), "a hook that is not this conversation's does not forfeit it");
    r.controller.dispose();
  }
});

test("restoration: foreign hooks between an early proof and activation do not forfeit the baseline", async () => {
  const workspace = await makeWorkspace();
  for (const name of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    const r = await restoredHarness(workspace, identityRecorder());
    try {
      r.hook("SessionStart", { source: "resume", cwd: workspace });
      const before = r.snapshots.length;
      r.hook(name, { session_id: OTHER_SESSION, prompt_id: "prompt-9" });
      assert.equal(r.snapshots.length, before, `${name}: a foreign hook is refused without effect`);
      r.controller.observeOwnedStartup();
      assert.ok(isOwnedBaseline(r.latest()), `${name}: foreign evidence cannot poison eligibility`);
    } finally {
      r.controller.dispose();
    }
  }

  // The same hooks naming THIS conversation still forfeit it.
  for (const name of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    const r = await restoredHarness(workspace, identityRecorder());
    try {
      r.hook("SessionStart", { source: "resume", cwd: workspace });
      r.hook(name, { prompt_id: "prompt-1" });
      r.controller.observeOwnedStartup();
      await settle(30);
      assert.ok(r.snapshots.every((snapshot) => !isOwnedBaseline(snapshot)), `${name}: this conversation's hook forfeits it`);
    } finally {
      r.controller.dispose();
    }
  }
});

test("restoration: transcript rows appended between an early proof and activation are never skipped as history", async () => {
  const workspace = await makeWorkspace();
  for (const row of [rootUserRow(), taskStatusRow("current-task", "completed"), summaryRow({ uuid: "current-summary" })]) {
    const r = await restoredHarness(workspace, identityRecorder());
    r.hook("SessionStart", { source: "resume", cwd: workspace });
    await r.append(row);
    r.controller.observeOwnedStartup();
    await settle(30);
    assert.ok(
      r.snapshots.every((snapshot) => !isOwnedBaseline(snapshot)),
      "a row the provider wrote after the proof is current evidence the late baseline cannot stand over",
    );
    r.controller.dispose();
  }

  // A replaced, shorter transcript between the proof and activation is not
  // vouched for either.
  const replaced = await restoredHarness(workspace, identityRecorder());
  replaced.hook("SessionStart", { source: "resume", cwd: workspace });
  await fs.rm(replaced.transcript);
  await fs.writeFile(replaced.transcript, jsonRow({ type: "system" }), "utf8");
  replaced.controller.observeOwnedStartup();
  await settle(30);
  assert.ok(replaced.snapshots.every((snapshot) => !isOwnedBaseline(snapshot)));
  replaced.controller.dispose();

  // An unchanged file still gets the baseline, and monitoring starts at the
  // position fixed by the proof: a later current row withdraws the idle claim.
  const quiet = await restoredHarness(workspace, identityRecorder());
  quiet.hook("SessionStart", { source: "resume", cwd: workspace });
  quiet.controller.observeOwnedStartup();
  assert.ok(isOwnedBaseline(quiet.latest()));
  await quiet.append(rootUserRow());
  await waitFor(() => quiet.latest().busy === null, "a current root row after the baseline still withdraws it");
  quiet.controller.dispose();
});

test("restoration: two restored rows in one workspace keep independent baselines and live status", async () => {
  const workspace = await makeWorkspace();
  const firstIdentity = identityRecorder();
  const secondIdentity = identityRecorder();
  const first = await restoredHarness(workspace, firstIdentity);
  const second = await createHarness({
    workspace,
    resumeConversationId: OTHER_SESSION,
    onConversationIdentity: secondIdentity.report,
  });
  const secondHook = (name: string, extra: Record<string, unknown> = {}): void =>
    second.hook(name, { session_id: OTHER_SESSION, ...extra });

  // Opposite orderings: the first row activates before its proof, the second
  // proves before activation.
  first.controller.observeOwnedStartup();
  secondHook("SessionStart", { source: "resume", cwd: workspace });
  assert.deepEqual(first.snapshots, [], "the other row's proof is nothing to this row");
  assert.ok(isAllUnknown(second.latest()), "the second row's proof waits for its own activation");

  first.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.ok(isOwnedBaseline(first.latest()));
  assert.ok(isAllUnknown(second.latest()), "the first row's baseline is not the second row's");
  second.controller.observeOwnedStartup();
  assert.ok(isOwnedBaseline(second.latest()));
  assert.deepEqual(firstIdentity.calls, [SESSION]);
  assert.deepEqual(secondIdentity.calls, [OTHER_SESSION]);

  // Live work on one row moves that row only.
  first.hook("UserPromptSubmit", { prompt_id: "prompt-1" });
  assert.equal(first.latest().busy, true);
  assert.ok(isOwnedBaseline(second.latest()), "another row's prompt leaves this row idle");
  secondHook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-9" });
  assert.equal(second.latest().pendingInput, true);
  assert.equal(first.latest().pendingInput, false, "another row's question is not this row's input");
  await settle(30);
  assert.equal(first.latest().busy, true);
  first.controller.dispose();
  second.controller.dispose();
});

test("restoration: wrong source, session, workspace, scope, or shape can neither confirm the id nor publish status", async () => {
  const workspace = await makeWorkspace();
  const elsewhere = await makeWorkspace();
  const variants: { readonly label: string; readonly event: Record<string, unknown> }[] = [
    { label: "startup source", event: { source: "startup", cwd: workspace } },
    { label: "clear source", event: { source: "clear", cwd: workspace } },
    { label: "compact source", event: { source: "compact", cwd: workspace } },
    { label: "no source", event: { cwd: workspace } },
    { label: "fork/different id", event: { source: "resume", session_id: OTHER_SESSION, cwd: workspace } },
    { label: "another workspace", event: { source: "resume", cwd: elsewhere } },
    { label: "missing workspace dir", event: { source: "resume", cwd: path.join(workspace, "absent") } },
    { label: "relative cwd", event: { source: "resume", cwd: "." } },
    { label: "no cwd", event: { source: "resume" } },
    { label: "child scope", event: { source: "resume", cwd: workspace, agent_id: "agent-1" } },
  ];
  for (const variant of variants) {
    const identity = identityRecorder();
    const h = await restoredHarness(workspace, identity);
    h.controller.observeOwnedStartup();
    h.hook("SessionStart", variant.event);
    // Nothing that follows is admitted either: these are not this conversation's hooks.
    h.hook("UserPromptSubmit", { prompt_id: "prompt-1" });
    h.hook("Stop", { prompt_id: "prompt-1", background_members: [], background_counts: { tasks: 0, shells: 0 } });
    await h.append(summaryRow());
    await settle(30);
    assert.deepEqual(identity.calls, [], `${variant.label} never confirms the restoration`);
    assert.deepEqual(h.snapshots, [], `${variant.label} publishes no status for this row`);
    h.controller.dispose();
  }

  // A malformed expectation can never be proved, whatever arrives.
  const identity = identityRecorder();
  const latest = await createHarness({ workspace, resumeConversationId: "latest", onConversationIdentity: identity.report });
  latest.hook("SessionStart", { source: "resume", session_id: "latest", cwd: workspace });
  latest.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.deepEqual(identity.calls, []);
  assert.deepEqual(latest.snapshots, []);
  latest.controller.dispose();

  // The expectation is the exact id spelling: another spelling of it is not it.
  const hexId = "abcdef12-3456-4789-8abc-def123456789";
  const spelled = identityRecorder();
  const upper = await createHarness({ workspace, resumeConversationId: hexId, onConversationIdentity: spelled.report });
  upper.hook("SessionStart", { source: "resume", session_id: hexId.toUpperCase(), cwd: workspace });
  assert.deepEqual(spelled.calls, []);
  assert.deepEqual(upper.snapshots, []);
  upper.hook("SessionStart", { source: "resume", session_id: hexId, cwd: workspace });
  assert.deepEqual(spelled.calls, [hexId]);
  upper.controller.dispose();

  // Without a selected workspace nothing is provable either.
  const unscoped = identityRecorder();
  const blind = await createHarness({ resumeConversationId: SESSION, onConversationIdentity: unscoped.report });
  blind.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.deepEqual(unscoped.calls, []);
  assert.deepEqual(blind.snapshots, []);
  blind.controller.dispose();

  // Refused events leave the expectation intact: the genuine proof still lands.
  const later = identityRecorder();
  const h = await restoredHarness(workspace, later);
  h.hook("SessionStart", { source: "startup", session_id: OTHER_SESSION, cwd: workspace });
  h.hook("SessionStart", { source: "resume", cwd: workspace, agent_id: "agent-1" });
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.deepEqual(later.calls, [SESSION]);
  h.controller.dispose();
});

test("restoration: a missing proof keeps every axis unknown and a lane loss before proof reports no identity loss", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const h = await restoredHarness(workspace, identity);
  h.controller.observeOwnedStartup();
  h.controller.observeOwnedStartup();
  await settle(30);
  assert.deepEqual([...h.snapshots], [], "activation without proof states no idle, none-pending, or 0/0 baseline");

  h.controller.acceptFailure({ backend: "claude", reason: "input-too-large" });
  assert.deepEqual(identity.calls, [], "nothing was proved, so nothing is withdrawn: the owner keeps its retry id");
  assert.ok(h.snapshots.every(isAllUnknown), "a failure before proof never states a value");
  assert.ok(h.snapshots.every((snapshot) => snapshot.pendingInput === null));

  // The proof can still confirm the identity afterwards, but the gap before it
  // forfeits the launch baseline: the row is not idled over a hole.
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.deepEqual(identity.calls, [SESSION]);
  assert.ok(h.snapshots.every((snapshot) => !isOwnedBaseline(snapshot)));
  h.controller.dispose();
});

test("restoration: old history neither grants nor disturbs the baseline, and this run's own prompt, Stop snapshot, and summary move every axis", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  // The resumed conversation's file already holds a completed turn, a settled
  // task, a running task, and summaries: none of it is a live fact about the new
  // run — it neither replaces the owner's baseline nor stands in for this run's
  // own turn-end witness.
  const h = await restoredHarness(workspace, identity, {
    seed: priorHistory()
      + summaryRow({ uuid: "old-summary" })
      + taskStatusRow("old-task", "completed")
      + taskStatusRow("old-running", "running")
      + summaryRow({ uuid: "old-summary-2" }),
  });
  h.controller.observeOwnedStartup();
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  await settle();
  assert.deepEqual(identity.calls, [SESSION]);
  assert.ok(isOwnedBaseline(h.latest()), "the owner's baseline, not anything read from history");
  assert.ok(h.snapshots.every((snapshot) => snapshot.busy !== false || isOwnedBaseline(snapshot)));
  assert.deepEqual(h.gaps, []);

  h.hook("UserPromptSubmit", { prompt_id: "prompt-1" });
  assert.equal(h.latest().busy, true);
  assert.deepEqual(h.latest().activity, ["Working"]);
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 }, "foreground work is not a membership edge");
  h.hook("Stop", { prompt_id: "prompt-1", background_members: [], background_counts: { tasks: 0, shells: 0 } });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 }, "the run's own complete snapshot is the census");
  await settle(30);
  assert.equal(h.latest().busy, true, "the Stop hook alone is not a witness");
  await h.append(summaryRow({ uuid: "new-summary" }));
  await waitFor(() => h.latest().activity[0] === "Ready", "this run's own summary confirms Ready");
  assert.equal(h.latest().busy, false);
  assert.equal(h.latest().pendingInput, false);
  assert.deepEqual(identity.calls, [SESSION], "status progress never re-reports the identity");
  assert.deepEqual(h.gaps, []);
  h.controller.dispose();
});

test("restoration: current work after the restored baseline keeps its own authority and late halves never re-mint", async () => {
  const workspace = await makeWorkspace();

  // A question, a background launch, and a lane loss each move the axes they own.
  const h = await restoredHarness(workspace, identityRecorder());
  h.controller.observeOwnedStartup();
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.ok(isOwnedBaseline(h.latest()));
  h.hook("UserPromptSubmit", { prompt_id: "prompt-1" });
  h.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  assert.equal(h.latest().pendingInput, true, "a live question supersedes the empty baseline");
  h.hook("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q-1", prompt_id: "prompt-1" });
  h.hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "tool-a",
    prompt_id: "prompt-1",
    background_started: { id: SHELL_1, kind: "shell" },
  });
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 1 }, "a launch moves the census from the baseline");
  // A late repeat of either half restates nothing over live work.
  h.controller.observeOwnedStartup();
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  await settle(30);
  assert.ok(!isOwnedBaseline(h.latest()), "a duplicate start or activation never re-mints the baseline");
  h.controller.acceptFailure({ backend: "claude", reason: "input-too-large" });
  assert.ok(isAllUnknown(h.latest()), "a lane loss withdraws to unknown, never to the baseline");
  h.controller.observeOwnedStartup();
  await settle(30);
  assert.ok(isAllUnknown(h.latest()));
  h.controller.dispose();

  // A new root row this run's own provider appends past the scan floor withdraws
  // the idle claim, exactly as for a fresh run.
  const watched = await restoredHarness(workspace, identityRecorder());
  watched.controller.observeOwnedStartup();
  watched.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.ok(isOwnedBaseline(watched.latest()));
  await watched.append(rootUserRow());
  await waitFor(() => watched.latest().busy === null, "newer root work withdraws the idle baseline");
  assert.deepEqual(watched.latest().activity, []);
  watched.controller.dispose();

  // A root session end closes the restored scope: the baseline does not survive it.
  const ended = await restoredHarness(workspace, identityRecorder());
  ended.controller.observeOwnedStartup();
  ended.hook("SessionStart", { source: "resume", cwd: workspace });
  ended.hook("SessionEnd", { reason: "other" });
  ended.controller.observeOwnedStartup();
  await settle(30);
  assert.ok(!isOwnedBaseline(ended.latest()), "an ended scope is never idled again");
  ended.controller.dispose();
});

test("fresh capture: a root SessionStart in the selected workspace reports identity with the baseline unchanged", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const h = await createHarness({ workspace, onConversationIdentity: identity.report });
  h.controller.observeOwnedStartup();
  const baseline = h.latest();
  assert.equal(baseline.busy, false);
  assert.equal(baseline.pendingInput, false);
  assert.deepEqual(countsOf(baseline), { tasks: 0, shells: 0 });
  assert.deepEqual(identity.calls, []);

  h.hook("SessionStart", { source: "startup", cwd: workspace });
  assert.deepEqual(identity.calls, [SESSION], "no prompt is needed to state the identity");
  assert.equal(h.latest().busy, false, "the owned baseline survives its own start notice");
  assert.deepEqual(countsOf(h.latest()), { tasks: 0, shells: 0 });
  h.hook("SessionStart", { source: "startup", cwd: workspace });
  assert.deepEqual(identity.calls, [SESSION], "a duplicate start is not a second report");
  h.controller.dispose();

  // The same run with no usable cwd keeps its status behaviour and proves nothing.
  const unproved = identityRecorder();
  const plain = await createHarness({ workspace, onConversationIdentity: unproved.report });
  plain.controller.observeOwnedStartup();
  plain.hook("SessionStart", { source: "startup" });
  assert.equal(plain.latest().busy, false);
  assert.deepEqual(unproved.calls, []);
  plain.controller.dispose();
});

test("activation: a refused identity is offered again from activation, only as the current candidate", async () => {
  const workspace = await makeWorkspace();

  const identity = identityRecorder(false);
  const h = await createHarness({ workspace, onConversationIdentity: identity.report });
  h.hook("SessionStart", { source: "startup", cwd: workspace });
  assert.deepEqual(identity.calls, [SESSION], "offered once; the owner was not activated yet");
  identity.accept = true;
  h.controller.observeOwnedStartup();
  assert.deepEqual(identity.calls, [SESSION, SESSION], "the same current candidate, offered from activation");
  h.controller.observeOwnedStartup();
  assert.deepEqual(identity.calls, [SESSION, SESSION], "accepted once, never replayed");
  h.controller.dispose();

  // A refused candidate that a later boundary replaced is never offered again.
  const replaced = identityRecorder(false);
  const r = await createHarness({ workspace, onConversationIdentity: replaced.report });
  r.hook("SessionStart", { source: "startup", cwd: workspace });
  r.hook("SessionStart", { source: "clear", session_id: OTHER_SESSION, cwd: workspace });
  replaced.accept = true;
  r.controller.observeOwnedStartup();
  assert.deepEqual(replaced.calls, [SESSION, OTHER_SESSION, OTHER_SESSION]);
  r.controller.dispose();

  // A refused candidate withdrawn by an unproved boundary leaves nothing to offer.
  const withdrawn = identityRecorder(false);
  const w = await createHarness({ workspace, onConversationIdentity: withdrawn.report });
  w.hook("SessionStart", { source: "startup", cwd: workspace });
  w.hook("SessionStart", { source: "clear", session_id: OTHER_SESSION });
  withdrawn.accept = true;
  w.controller.observeOwnedStartup();
  assert.deepEqual(withdrawn.calls, [SESSION], "no historical replay, and no null for something never accepted");
  w.controller.dispose();

  // A restored run's proof refused before activation is offered at activation,
  // and activation then states that proved run's launch baseline.
  const restored = identityRecorder(false);
  const rr = await restoredHarness(workspace, restored);
  rr.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.ok(isAllUnknown(rr.latest()), "proof without activation states no baseline");
  restored.accept = true;
  rr.controller.observeOwnedStartup();
  assert.deepEqual(restored.calls, [SESSION, SESSION]);
  assert.ok(isOwnedBaseline(rr.latest()), "activation after the proof states the launch baseline");

  // A disposed controller offers nothing.
  restored.accept = false;
  rr.hook("SessionStart", { source: "clear", session_id: OTHER_SESSION, cwd: workspace });
  rr.controller.dispose();
  restored.accept = true;
  rr.controller.observeOwnedStartup();
  assert.deepEqual(restored.calls, [SESSION, SESSION, OTHER_SESSION]);
});

test("switches: a proved root boundary after the restored id follows it; an unproved one or a replacement end withdraws it", async () => {
  const workspace = await makeWorkspace();
  const elsewhere = await makeWorkspace();
  const identity = identityRecorder();
  const h = await restoredHarness(workspace, identity);
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.deepEqual(identity.calls, [SESSION]);

  // Child and foreign events never touch the root identity.
  h.hook("SessionStart", { source: "startup", session_id: OTHER_SESSION, cwd: workspace, agent_id: "agent-1" });
  h.hook("UserPromptSubmit", { session_id: OTHER_SESSION, prompt_id: "foreign" });
  assert.deepEqual(identity.calls, [SESSION]);

  // A genuine `/clear` in the same workspace follows the provider's new conversation.
  const next = path.join(h.dir, "next.jsonl");
  h.hook("SessionStart", { source: "clear", session_id: OTHER_SESSION, transcript_path: next, cwd: workspace });
  assert.deepEqual(identity.calls, [SESSION, OTHER_SESSION]);
  // And a `/resume` back to the first one is followed too.
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.deepEqual(identity.calls, [SESSION, OTHER_SESSION, SESSION]);

  // A root boundary that replaces the binding without proof withdraws the old id.
  h.hook("SessionStart", { source: "clear", session_id: OTHER_SESSION, transcript_path: next, cwd: elsewhere });
  assert.deepEqual(identity.calls, [SESSION, OTHER_SESSION, SESSION, null]);
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.deepEqual(identity.calls, [SESSION, OTHER_SESSION, SESSION, null, SESSION]);
  h.hook("SessionStart", { source: "clear", session_id: "not-a-uuid", cwd: workspace });
  assert.deepEqual(identity.calls.at(-1), null, "a non-UUID boundary is unproved");
  h.hook("SessionStart", { source: "resume", cwd: workspace });

  // An exit ends the process's session, not the conversation's standing.
  h.hook("SessionEnd", { reason: "prompt_input_exit" });
  const beforeEnd = identity.calls.length;
  assert.deepEqual(identity.calls.at(-1), SESSION);
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.equal(identity.calls.length, beforeEnd, "the same conversation again is no new report");
  // A clear's end states the conversation is being replaced in this live process.
  h.hook("SessionEnd", { reason: "clear" });
  assert.deepEqual(identity.calls.at(-1), null);
  h.controller.dispose();
});

test("loss: a lane loss withdraws the identity, unreadable status does not, and the bound conversation's own hook restores it", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const h = await restoredHarness(workspace, identity);
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  h.hook("UserPromptSubmit", { prompt_id: "prompt-1" });
  assert.deepEqual(identity.calls, [SESSION]);

  // An unreadable transcript is a status gap, not an identity loss.
  await fs.rm(h.transcript, { force: true });
  await fs.mkdir(h.transcript);
  h.hook("Stop", { prompt_id: "prompt-1" });
  assert.ok(h.gaps.length > 0, "the transcript lane reported its own gap");
  // Nor is an unreadable recognized payload.
  h.hook("PreToolUse", { prompt_id: "prompt-1", tool_name: "Bash", tool_use_id: "" });
  assert.deepEqual(identity.calls, [SESSION]);

  // An authenticated loss of the lane may have hidden a conversation switch.
  h.controller.acceptFailure({ backend: "claude", reason: "delivery-refused" });
  assert.deepEqual(identity.calls, [SESSION, null]);
  // Another session's hook is refused and restores nothing.
  h.hook("UserPromptSubmit", { session_id: OTHER_SESSION, prompt_id: "foreign" });
  assert.deepEqual(identity.calls, [SESSION, null]);
  // This run's own root hook naming the bound conversation is new evidence for it.
  h.hook("UserPromptSubmit", { prompt_id: "prompt-2" });
  assert.deepEqual(identity.calls, [SESSION, null, SESSION]);
  h.hook("UserPromptSubmit", { prompt_id: "prompt-3" });
  assert.deepEqual(identity.calls, [SESSION, null, SESSION], "no duplicate report");
  h.controller.dispose();
});

test("retirement: invalidation and disposal never withdraw the identity, and nothing reports after disposal", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const h = await restoredHarness(workspace, identity);
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  assert.deepEqual(identity.calls, [SESSION]);
  h.controller.invalidate();
  h.controller.dispose();
  h.hook("SessionStart", { source: "clear", session_id: OTHER_SESSION, cwd: workspace });
  h.controller.acceptFailure({ backend: "claude", reason: "input-timeout" });
  h.controller.observeOwnedStartup();
  assert.deepEqual(identity.calls, [SESSION], "the owner's remembered id survives normal retirement");
});

test("shutdown: an ordinary native SessionEnd, the hook losses racing it, and disposal keep the proved id", async () => {
  const workspace = await makeWorkspace();
  // Every ordinary end reason the provider uses for a process exit, plus an
  // unknown and an absent one: none of them states the conversation was replaced.
  for (const reason of ["prompt_input_exit", "other", "logout", "bypass_permissions_disabled", "made-up-reason", undefined]) {
    const identity = identityRecorder();
    const h = await restoredHarness(workspace, identity);
    h.controller.observeOwnedStartup();
    h.hook("SessionStart", { source: "resume", cwd: workspace });
    h.hook("UserPromptSubmit", { prompt_id: "prompt-1" });
    assert.deepEqual(identity.calls, [SESSION]);

    // The end lands while the owner still sees a live PTY (it would accept a null).
    h.hook("SessionEnd", reason === undefined ? {} : { reason });
    // Hooks racing the closing process fail; late hooks of the ended scope arrive.
    h.controller.acceptFailure({ backend: "claude", reason: "input-timeout" });
    h.controller.acceptFailure({ backend: "claude", reason: "input-unavailable" });
    h.hook("Stop", { prompt_id: "prompt-1" });
    // Then the PTY exits and the owner retires the run.
    h.controller.invalidate();
    h.controller.dispose();
    h.controller.acceptFailure({ backend: "claude", reason: "delivery-refused" });
    assert.deepEqual(identity.calls, [SESSION], `an ordinary end (${String(reason)}) never erases the saved id`);
  }

  // The same holds for a fresh run whose identity was captured from its startup.
  const fresh = identityRecorder();
  const f = await createHarness({ workspace, onConversationIdentity: fresh.report });
  f.controller.observeOwnedStartup();
  f.hook("SessionStart", { source: "startup", cwd: workspace });
  f.hook("SessionEnd", { reason: "prompt_input_exit" });
  f.controller.acceptFailure({ backend: "claude", reason: "input-timeout" });
  f.controller.dispose();
  assert.deepEqual(fresh.calls, [SESSION]);
});

test("shutdown: a replacement end, or a new unproved root after an ordinary end, still withdraws the stale id", async () => {
  const workspace = await makeWorkspace();
  const elsewhere = await makeWorkspace();

  // `/clear` (and an in-session `/resume`) end the conversation by REPLACING it.
  for (const reason of ["clear", "resume"]) {
    const identity = identityRecorder();
    const h = await restoredHarness(workspace, identity);
    h.hook("SessionStart", { source: "resume", cwd: workspace });
    h.hook("SessionEnd", { reason });
    assert.deepEqual(identity.calls, [SESSION, null], `a ${reason} end withdraws the replaced id`);
    h.controller.dispose();
    assert.deepEqual(identity.calls, [SESSION, null]);
  }

  // After an ordinary end, a new root binding decides afresh: unproved withdraws...
  const unproved = identityRecorder();
  const u = await restoredHarness(workspace, unproved);
  u.hook("SessionStart", { source: "resume", cwd: workspace });
  u.hook("SessionEnd", { reason: "other" });
  u.hook("SessionStart", { source: "startup", session_id: OTHER_SESSION, cwd: elsewhere });
  assert.deepEqual(unproved.calls, [SESSION, null]);
  u.controller.dispose();

  // ...a proved one follows, and a lane loss in that live new binding withdraws again.
  const proved = identityRecorder();
  const p = await restoredHarness(workspace, proved);
  p.hook("SessionStart", { source: "resume", cwd: workspace });
  p.hook("SessionEnd", { reason: "other" });
  p.hook("SessionStart", { source: "startup", session_id: OTHER_SESSION, cwd: workspace });
  assert.deepEqual(proved.calls, [SESSION, OTHER_SESSION]);
  p.controller.acceptFailure({ backend: "claude", reason: "input-too-large" });
  assert.deepEqual(proved.calls, [SESSION, OTHER_SESSION, null]);
  p.controller.dispose();

  // A foreign session's end is not this conversation's end and changes nothing.
  const foreign = identityRecorder();
  const g = await restoredHarness(workspace, foreign);
  g.hook("SessionStart", { source: "resume", cwd: workspace });
  g.hook("SessionEnd", { session_id: OTHER_SESSION, reason: "clear" });
  g.controller.acceptFailure({ backend: "claude", reason: "input-timeout" });
  assert.deepEqual(foreign.calls, [SESSION, null], "only the lane loss withdrew, not the foreign end");
  g.controller.dispose();
});

test("shutdown: another root adopted without its own SessionStart after an ordinary end withdraws the stale id", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const h = await restoredHarness(workspace, identity);
  h.hook("SessionStart", { source: "resume", cwd: workspace });
  h.hook("SessionEnd", { reason: "other" });
  // A lane loss after the ordinary end keeps B: it is the closing process.
  h.controller.acceptFailure({ backend: "claude", reason: "input-timeout" });
  assert.deepEqual(identity.calls, [SESSION]);

  // An authenticated root hook of ANOTHER conversation is admitted and adopted
  // with no proving SessionStart: B no longer names the current conversation.
  h.hook("UserPromptSubmit", { session_id: OTHER_SESSION, prompt_id: "prompt-c" });
  assert.equal(h.latest().busy, true, "the adopted root's own status is published as before");
  assert.deepEqual(identity.calls, [SESSION, null], "the stale id is withdrawn, never left saved beside C");
  h.hook("Stop", { session_id: OTHER_SESSION, prompt_id: "prompt-c" });
  h.controller.dispose();
  assert.deepEqual(identity.calls, [SESSION, null]);

  // Late hooks of B itself, after the same end and loss, re-adopt the same
  // conversation and keep B; its own later disposal keeps it too.
  const late = identityRecorder();
  const l = await restoredHarness(workspace, late);
  l.hook("SessionStart", { source: "resume", cwd: workspace });
  l.hook("SessionEnd", { reason: "prompt_input_exit" });
  l.controller.acceptFailure({ backend: "claude", reason: "input-timeout" });
  l.hook("UserPromptSubmit", { prompt_id: "late-b" });
  l.hook("Stop", { prompt_id: "late-b" });
  l.controller.acceptFailure({ backend: "claude", reason: "input-unavailable" });
  l.controller.dispose();
  assert.deepEqual(late.calls, [SESSION]);

  // A child hook naming another session never counts as a root binding.
  const child = identityRecorder();
  const c = await restoredHarness(workspace, child);
  c.hook("SessionStart", { source: "resume", cwd: workspace });
  c.hook("SessionEnd", { reason: "other" });
  c.controller.acceptFailure({ backend: "claude", reason: "input-timeout" });
  c.hook("PreToolUse", { session_id: OTHER_SESSION, agent_id: "agent-1", tool_name: "Bash", tool_use_id: "t-1" });
  c.controller.dispose();
  assert.deepEqual(child.calls, [SESSION]);
});

/* ---------------------------------- provider conversation TITLE (issue #690) */

interface TitleRecorder {
  readonly calls: { readonly conversationId: string; readonly title: string }[];
  accept: boolean;
  readonly report: (conversationId: string, title: string) => boolean;
}

/** The owner's private title channel: records every report, accepts on demand. */
function titleRecorder(accept = true): TitleRecorder {
  const recorder: TitleRecorder = {
    calls: [],
    accept,
    report: (conversationId, title) => {
      recorder.calls.push({ conversationId, title });
      return recorder.accept;
    },
  };
  return recorder;
}

/**
 * One persisted title row, in the shape the provider records its own title claim:
 * the title is a top-level field of the row, and the row's `type` is not what makes
 * it a title — only the two title fields themselves are ever read. `customTitle` is
 * the title the operator gave the conversation inside the provider, `aiTitle` the one
 * the provider generated for it.
 */
function titleRow(field: "customTitle" | "aiTitle", title: unknown, extra: Record<string, unknown> = {}): string {
  return jsonRow({
    type: "system",
    subtype: field === "customTitle" ? "custom-title" : "ai-title",
    sessionId: SESSION,
    uuid: `title-row-${field}`,
    timestamp: "2026-01-01T00:02:00.000Z",
    [field]: title,
    ...extra,
  });
}

/**
 * A host-owned run whose exact root conversation is proved and whose transcript lane
 * is live (the launch baseline keeps counts published, which is what keeps the one
 * watcher armed). This is the ordinary shape of a row this host started.
 */
async function titledHarness(workspace: string, identity: IdentityRecorder, titles: TitleRecorder, seed?: string): Promise<Harness> {
  const h = await createHarness({
    workspace,
    ...(seed === undefined ? {} : { seed }),
    onConversationIdentity: identity.report,
    onConversationTitle: titles.report,
  });
  h.controller.observeOwnedStartup();
  h.hook("SessionStart", { source: "startup", cwd: workspace });
  await settle(30);
  assert.deepEqual(identity.calls, [SESSION], "the fixture's identity is proved");
  return h;
}

test("title: a root custom title this run's own transcript names is reported once for the proved conversation, and a rename updates it", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const titles = titleRecorder();
  const h = await titledHarness(workspace, identity, titles);
  assert.equal(titles.calls.length, 0, "nothing is claimed before the provider names a title");

  await h.append(titleRow("customTitle", "Ship the release notes"));
  await settle();
  assert.deepEqual(titles.calls, [{ conversationId: SESSION, title: "Ship the release notes" }]);

  // The same row read again (a re-scan, a duplicate append) never re-reports.
  await h.append(titleRow("customTitle", "Ship the release notes"));
  await settle();
  assert.equal(titles.calls.length, 1, "an unchanged title is never published twice");

  // The provider's own rename is a new fact about the SAME conversation.
  await h.append(titleRow("customTitle", "Ship the release notes, take two"));
  await settle();
  assert.deepEqual(titles.calls.map((call) => call.title), [
    "Ship the release notes",
    "Ship the release notes, take two",
  ]);

  // A title is never a status value: nothing about the row's foreground, counts, or
  // activity changed, and the text never reaches an observation.
  assert.equal(JSON.stringify(h.snapshots).includes("release notes"), false,
    "the title travels on its own channel, never inside a status snapshot");
  h.controller.dispose();
});

test("title: a provider-generated title is reported, and a custom title outranks it as the provider's own fold ranks them", async () => {
  const workspace = await makeWorkspace();
  const titles = titleRecorder();
  const h = await titledHarness(workspace, identityRecorder(), titles);

  await h.append(titleRow("aiTitle", "Debug flaky session host tests"));
  await settle();
  assert.deepEqual(titles.calls, [{ conversationId: SESSION, title: "Debug flaky session host tests" }]);

  // A custom title outranks the generated one, whenever either arrived.
  await h.append(titleRow("customTitle", "Named by hand"));
  await settle();
  assert.deepEqual(titles.calls.at(-1), { conversationId: SESSION, title: "Named by hand" });

  // A LATER generated title does not outrank a custom title the provider still
  // reports: the fold ranks custom over generated, not newest over newest.
  await h.append(titleRow("aiTitle", "A newer generated title"));
  await settle();
  assert.equal(titles.calls.length, 2, "the custom title still stands");
  h.controller.dispose();
});

test("title: nothing is invented — prompts, summaries, first lines, and previews are never titles", async () => {
  const workspace = await makeWorkspace();
  const titles = titleRecorder();
  const h = await titledHarness(workspace, identityRecorder(), titles);

  await h.append(jsonRow({
    type: "system",
    subtype: "summary",
    sessionId: SESSION,
    summary: "a summary line that is not a title",
    lastPrompt: "the last prompt, which is not a title either",
    firstPrompt: "the first prompt, never a title",
    preview: "a preview, never a title",
    uuid: "not-a-title-row",
    timestamp: "2026-01-01T00:03:00.000Z",
  }));
  await h.append(rootUserRow());
  await h.append(summaryRow());
  await settle();
  assert.equal(titles.calls.length, 0, "the two title fields are the only source, and neither is present");
  h.controller.dispose();
});

test("title: a sidechain, agent-scoped, or other-conversation title row can never name this run", async () => {
  const workspace = await makeWorkspace();
  const titles = titleRecorder();
  const h = await titledHarness(workspace, identityRecorder(), titles);

  await h.append(titleRow("customTitle", "A child agent's title", { agentId: "agent-1" }));
  await h.append(titleRow("customTitle", "A sidechain's title", { isSidechain: true }));
  await h.append(titleRow("customTitle", "Another conversation's title", { sessionId: OTHER_SESSION }));
  await h.append(titleRow("aiTitle", "Another conversation's generated title", { sessionId: OTHER_SESSION }));
  await settle();
  assert.equal(titles.calls.length, 0, "no foreign title is attributed to this row's conversation");
  h.controller.dispose();
});

test("title: an unusable title is refused whole, never clipped, and a later valid one still lands", async () => {
  const workspace = await makeWorkspace();
  const titles = titleRecorder();
  const h = await titledHarness(workspace, identityRecorder(), titles);

  for (const unusable of ["", "   ", "padded ", "two\nlines", "a\ttab", `nul\u0000`,
    "a".repeat(MAX_NATIVE_SESSION_NAME_LENGTH + 1), 42, true, {}, []]) {
    await h.append(titleRow("customTitle", unusable));
    await h.append(titleRow("aiTitle", unusable));
  }
  await settle();
  assert.equal(titles.calls.length, 0, "a provider string this host cannot display is refused, never clipped or coerced");

  await h.append(titleRow("customTitle", "A title that fits the rule"));
  await settle();
  assert.deepEqual(titles.calls, [{ conversationId: SESSION, title: "A title that fits the rule" }]);
  h.controller.dispose();
});

test("title: nothing is offered before the owner accepted a conversation identity", async () => {
  const titles = titleRecorder();
  // No workspace: the conversation can never be proved, so nothing can be attributed.
  const h = await createHarness({ onConversationTitle: titles.report });
  h.controller.observeOwnedStartup();
  h.hook("SessionStart", { source: "startup" });
  await h.append(titleRow("customTitle", "An unattributable title"));
  await settle();
  assert.equal(titles.calls.length, 0, "a title with no proved conversation is never reported");
  h.controller.dispose();
});

test("title: a refused report is retried by a later window, never by a timer of its own", async () => {
  const workspace = await makeWorkspace();
  const titles = titleRecorder(false);
  const h = await titledHarness(workspace, identityRecorder(), titles);

  await h.append(titleRow("customTitle", "Offered and refused"));
  await settle();
  assert.deepEqual(titles.calls, [{ conversationId: SESSION, title: "Offered and refused" }]);
  await settle(120);
  assert.equal(titles.calls.length, 1, "a refused title is not retried while nothing new arrives");

  titles.accept = true;
  await h.append(titleRow("customTitle", "Offered and accepted"));
  await settle();
  assert.deepEqual(titles.calls.map((call) => call.title), ["Offered and refused", "Offered and accepted"],
    "the next window carrying the title is what retries it");
  h.controller.dispose();
});

test("title: a genuine conversation rebind withdraws the title, and the old conversation's rows can never name the new one", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const titles = titleRecorder();
  const h = await titledHarness(workspace, identity, titles);

  await h.append(titleRow("customTitle", "First conversation"));
  await settle();
  assert.deepEqual(titles.calls, [{ conversationId: SESSION, title: "First conversation" }]);

  // The provider replaces the conversation in the live process.
  h.hook("SessionStart", { source: "clear", session_id: OTHER_SESSION, cwd: workspace });
  await settle();
  assert.deepEqual(identity.calls, [SESSION, OTHER_SESSION]);
  assert.equal(titles.calls.length, 1, "the previous conversation's title is never re-offered for the new one");

  // The new conversation's own row names its own title.
  await h.append(titleRow("customTitle", "Second conversation", { sessionId: OTHER_SESSION }));
  await settle();
  assert.deepEqual(titles.calls.at(-1), { conversationId: OTHER_SESSION, title: "Second conversation" });

  // A late row of the PREVIOUS conversation cannot move the new one's title.
  await h.append(titleRow("customTitle", "Stale first conversation"));
  await settle();
  assert.equal(titles.calls.length, 2, "a foreign conversation's row is not this row's evidence");
  h.controller.dispose();
});

test("title: a title the provider recorded before this host started watching hydrates for the proved conversation while its prior status rows still never replay", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const titles = titleRecorder();
  // A synthetic transcript of a conversation that already happened — model rows, a
  // tool row, the provider's own title, and a completed turn's summary — every byte
  // of it written before this host ever opened the file.
  const h = await createHarness({
    workspace,
    seed: priorHistory()
      + rootAssistantToolUseRow()
      + titleRow("customTitle", "Already named by the provider")
      + rootAssistantTextRow()
      + summaryRow(),
    onConversationIdentity: identity.report,
    onConversationTitle: titles.report,
  });
  h.controller.observeOwnedStartup();
  await settle(30);
  assert.equal(titles.calls.length, 0, "nothing is claimed before this run proves which conversation it runs");

  h.hook("SessionStart", { source: "startup", cwd: workspace });
  await settle(30);
  assert.deepEqual(identity.calls, [SESSION], "the fixture's identity is proved");
  assert.deepEqual(titles.calls, [{ conversationId: SESSION, title: "Already named by the provider" }],
    "the title already in the one bound transcript reaches the row: no new title record, no prompt, no rename");

  // The read that produced it is metadata-only. The status floor still sits past
  // every prior row, so none of them closed a turn, moved a count, named a tool, or
  // published anything.
  const snapshotsAfterProof = h.snapshots.length;
  const state = h.latest();
  assert.deepEqual([state.busy, state.pendingInput, state.activeTasks, state.activeShells],
    [false, false, 0, 0], "the row states exactly the host's own launch baseline");
  await settle(150);
  assert.equal(h.snapshots.length, snapshotsAfterProof, "the title read publishes no status snapshot at all");
  assert.deepEqual(h.gaps, [], "reading the title metadata is not a source gap");
  assert.equal(h.snapshots.some((s) => s.busy === true || s.busy === null), false,
    "no prior prompt or turn boundary was replayed into the foreground");
  assert.equal(h.snapshots.some((s) => s.activity.includes("Bash")), false,
    "no prior tool row was replayed into activity");
  assert.equal(h.snapshots.some((s) => s.activeTasks !== 0 || s.activeShells !== 0), false,
    "no prior row moved a published count");
  assert.equal(JSON.stringify(h.snapshots).includes("Already named by the provider"), false,
    "the title travels on its own channel, never inside a status snapshot");

  // A rename of the SAME conversation is still noticed afterwards, on the watched file.
  await h.append(titleRow("customTitle", "Renamed after the host started watching"));
  await settle();
  assert.deepEqual(titles.calls.at(-1), { conversationId: SESSION, title: "Renamed after the host started watching" });
  h.controller.dispose();
});

test("title: an existing custom title outranks a generated title the provider recorded after it", async () => {
  const workspace = await makeWorkspace();
  const titles = titleRecorder();
  // The file's own order: the operator's custom title first, a generated title
  // recorded later. The provider's fold ranks custom over generated, and this host
  // reads that ranking, not an arrival order of its own.
  const h = await titledHarness(workspace, identityRecorder(), titles,
    priorHistory()
    + titleRow("customTitle", "Named by the operator")
    + titleRow("aiTitle", "Generated after the custom title"));
  await settle(120);
  assert.deepEqual(titles.calls, [{ conversationId: SESSION, title: "Named by the operator" }]);

  await h.append(titleRow("aiTitle", "A newer generated title"));
  await settle();
  assert.equal(titles.calls.length, 1, "a later generated row still does not outrank the existing custom title");
  h.controller.dispose();
});

test("title: a resumed conversation's already-recorded title reaches the row on its own resume proof, with no prior status replay", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const titles = titleRecorder();
  const h = await restoredHarness(workspace, identity, {
    seed: priorHistory()
      + rootAssistantToolUseRow()
      + titleRow("aiTitle", "Restored conversation")
      + summaryRow(),
    onConversationTitle: titles.report,
  });
  h.controller.observeOwnedStartup();
  await settle(60);
  assert.deepEqual(identity.calls, [], "a restored run proves nothing before its own resume");
  assert.equal(titles.calls.length, 0, "and claims no title for a conversation it has not proved");

  h.hook("SessionStart", { source: "resume", cwd: workspace });
  await settle(150);
  assert.deepEqual(identity.calls, [SESSION], "the exact expected conversation is proved");
  assert.deepEqual(titles.calls, [{ conversationId: SESSION, title: "Restored conversation" }],
    "the restored row shows the title that conversation already has, without a new title row");
  assert.equal(h.snapshots.some((s) => s.busy === true || s.busy === null), false,
    "the resumed conversation's older rows replay no foreground state");
  assert.equal(h.snapshots.some((s) => s.activity.includes("Bash")), false, "or its older tool activity");
  h.controller.dispose();
});

test("title: a hydration read that finishes after the conversation was replaced names nothing", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const titles = titleRecorder();
  const h = await createHarness({
    createEmpty: true,
    workspace,
    onConversationIdentity: identity.report,
    onConversationTitle: titles.report,
  });
  await h.append(titleRow("customTitle", "Conversation A's recorded title"));

  // Arm A's metadata read...
  h.hook("SessionStart", { source: "startup", cwd: workspace });
  // ...and replace the conversation in the SAME synchronous stretch, before that
  // read's continuation can run. The read of A is still in flight.
  h.hook("SessionStart", { source: "clear", session_id: OTHER_SESSION, cwd: workspace });
  await settle(150);

  assert.ok(identity.calls.includes(OTHER_SESSION),
    `the run is now proved to be conversation B: ${JSON.stringify(identity.calls)}`);
  assert.equal(titles.calls.length, 0,
    "A's late read cannot name B, and B's own read refuses A's rows by their own session");

  // B's own recorded title still lands, which proves the lane is alive rather than
  // merely silent.
  await h.append(titleRow("customTitle", "Conversation B's recorded title", { sessionId: OTHER_SESSION }));
  await settle();
  assert.deepEqual(titles.calls, [{ conversationId: OTHER_SESSION, title: "Conversation B's recorded title" }]);
  h.controller.dispose();
});

test("title: hydration never guesses — a recorded foreign or unusable title publishes nothing", async () => {
  const workspace = await makeWorkspace();
  const titles = titleRecorder();
  const h = await titledHarness(workspace, identityRecorder(), titles,
    priorHistory()
    + titleRow("customTitle", "A child agent's title", { agentId: "agent-1" })
    + titleRow("customTitle", "A sidechain's title", { isSidechain: true })
    + titleRow("customTitle", "Another conversation's title", { sessionId: OTHER_SESSION })
    + titleRow("aiTitle", "Another conversation's generated title", { sessionId: OTHER_SESSION })
    + titleRow("customTitle", "   ")
    + titleRow("aiTitle", "padded ")
    + titleRow("customTitle", "two\nlines")
    + titleRow("aiTitle", "a".repeat(MAX_NATIVE_SESSION_NAME_LENGTH + 1))
    + jsonRow({
      type: "system",
      subtype: "summary",
      sessionId: SESSION,
      summary: "a summary line that is not a title",
      lastPrompt: "the last prompt, which is not a title either",
      firstPrompt: "the first prompt, never a title",
      uuid: "not-a-title-row",
    }));
  await settle(150);
  assert.equal(titles.calls.length, 0,
    "a foreign, sidechain, agent-scoped, unusable, or non-title row is never turned into this row's title");
  h.controller.dispose();
});

test("title: a bound transcript that is not there yet is not guessed at, and a missing file claims nothing", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const titles = titleRecorder();
  const h = await createHarness({
    createEmpty: true,
    workspace,
    onConversationIdentity: identity.report,
    onConversationTitle: titles.report,
  });
  h.controller.observeOwnedStartup();
  h.hook("SessionStart", { source: "startup", cwd: workspace });
  await settle(150);
  assert.deepEqual(identity.calls, [SESSION], "the conversation is proved even with no file yet");
  assert.equal(titles.calls.length, 0, "an absent source states no title, and nothing is invented for it");
  assert.deepEqual(h.gaps, [], "a root JSONL the provider has not created is not reported as a gap");
  h.controller.dispose();
});

test("title: a window that cannot reach the file's first record hydrates a last custom title and never a generated one", async () => {
  const workspace = await makeWorkspace();
  const filler = jsonRow({
    type: "system",
    subtype: "keep-alive",
    uuid: "filler-row-1",
    padding: "x".repeat(512),
  });
  // Small enough that the one bounded window cannot start at byte 0.
  const seedHead = priorHistory() + filler + filler;

  // Only a GENERATED title in the window, with the file's CUSTOM title sitting in the
  // unread head: this read proves nothing, and the custom-title ceiling it leaves
  // unknown also stops a LATER generated append from outranking that custom title.
  const generatedOnly = titleRecorder();
  const g = await createHarness({
    workspace,
    seed: titleRow("customTitle", "A custom title no window reached") + seedHead
      + titleRow("aiTitle", "A generated title in the tail window"),
    maxTailBytes: 600,
    onConversationIdentity: identityRecorder().report,
    onConversationTitle: generatedOnly.report,
  });
  g.controller.observeOwnedStartup();
  g.hook("SessionStart", { source: "startup", cwd: workspace });
  await settle(150);
  assert.equal(generatedOnly.calls.length, 0,
    "a generated title read over an unread head is not proof, and nothing is guessed");

  await g.append(titleRow("aiTitle", "A generated title appended afterwards"));
  await settle();
  assert.equal(generatedOnly.calls.length, 0,
    "an incremental generated row cannot outrank a custom title this host never read");
  g.controller.dispose();

  // A CUSTOM title in the window is proof on its own terms: the window reaches the
  // end of the file, so nothing after it went unread, and a custom title outranks
  // anything the unread head could hold.
  const customFound = titleRecorder();
  const c = await createHarness({
    workspace,
    seed: seedHead + titleRow("customTitle", "The file's last custom title"),
    maxTailBytes: 600,
    onConversationIdentity: identityRecorder().report,
    onConversationTitle: customFound.report,
  });
  c.controller.observeOwnedStartup();
  c.hook("SessionStart", { source: "startup", cwd: workspace });
  await settle(150);
  assert.deepEqual(customFound.calls, [{ conversationId: SESSION, title: "The file's last custom title" }],
    "the last custom row in the file is inside any window that reaches the end of the file");
  c.controller.dispose();
});

/**
 * A host-owned run with a proved conversation whose ONE title hydration read is
 * parked just before it commits, with every transcript read driven by the test rather
 * than by a real file watch. The FIRST open of the bound transcript is that parked
 * title read (the identity proof arms it before anything else can open the file), so
 * a test can hold it across a lane loss, a reset, a replacement, a truncation, or a
 * newer rename, and then let it land.
 */
async function parkedTitleHarness(seed: string, maxTailBytes?: number): Promise<{
  readonly h: Harness;
  readonly workspace: string;
  readonly titles: TitleRecorder;
  readonly received: NativeClaudeWatchHandlers[];
  readonly first: ObservedOpen;
  readonly opens: ReturnType<typeof observeOpens>;
}> {
  const workspace = await makeWorkspace();
  const titles = titleRecorder();
  const received: NativeClaudeWatchHandlers[] = [];
  const h = await createHarness({
    workspace,
    seed,
    ...(maxTailBytes === undefined ? {} : { maxTailBytes }),
    watchFile: manualWatch(received),
    onConversationIdentity: identityRecorder().report,
    onConversationTitle: titles.report,
  });
  const opens = observeOpens([h.transcript]);
  h.controller.observeOwnedStartup();
  h.hook("SessionStart", { source: "startup", cwd: workspace });
  const [first] = opens.of(h.transcript);
  assert.ok(first !== undefined, "the identity proof armed a title read");
  // The identity proof arms the title read BEFORE this run's ordinary monitoring read
  // of the same file is issued, so the parked FIRST open is the hydration read. Every
  // test below is self-checking on that: an un-parked hydration read would already
  // have published the seed's title by the time it asserts.
  return { h, workspace, titles, received, first, opens };
}

test("title: a hydration read that lands after a hook-lane loss publishes nothing, and only the same conversation's own recovery reads again", async () => {
  const f = await parkedTitleHarness(priorHistory() + titleRow("customTitle", "The name recorded before the gap"));
  try {
    // The authenticated lane fails while that read is in flight. This source can no
    // longer state which conversation the row runs, and metadata captured BEFORE that
    // boundary is not evidence about anything after it — even though the conversation,
    // the path, and the session all match again the moment the gap closes.
    f.h.controller.acceptFailure({ backend: "claude", reason: "input-timeout" });
    f.first.release();
    await settle(150);
    assert.equal(f.titles.calls.length, 0, "the read parked before the gap publishes nothing when it lands after it");

    // This run's own admitted ROOT hook names the SAME conversation again. That is a
    // fresh boundary, and it takes a fresh read of the file bound now.
    f.h.hook("UserPromptSubmit", { prompt_id: "after-the-gap" });
    await settle(150);
    assert.deepEqual(f.titles.calls, [{ conversationId: SESSION, title: "The name recorded before the gap" }],
      "the title returns from a read taken AFTER the recovery, never from the parked one");
  } finally {
    f.opens.restore();
    f.h.controller.dispose();
  }
});

test("title: a rename consumed before a hook-lane gap is recovered from a bounded window that starts inside a record, with no new title row", async () => {
  const workspace = await makeWorkspace();
  const titles = titleRecorder();
  const filler = jsonRow({
    type: "system",
    subtype: "keep-alive",
    uuid: "filler-row-5",
    padding: "z".repeat(400),
  });
  // Deliberately larger than the ONE bounded window this host may read, so the read
  // recovery takes cannot start on a record boundary: the window cuts a row in half,
  // and the discarded leading partial's bytes still count inside what the reader
  // actually consumed. A title's position must therefore be derived from the records
  // returned, exactly as the watched read derives it, or the same row would be given
  // two different positions in the same file.
  const h = await createHarness({
    workspace,
    seed: priorHistory() + filler + filler + filler + filler,
    maxTailBytes: 600,
    onConversationIdentity: identityRecorder().report,
    onConversationTitle: titles.report,
  });
  h.controller.observeOwnedStartup();
  h.hook("SessionStart", { source: "startup", cwd: workspace });
  await settle(60);
  assert.equal(titles.calls.length, 0, "nothing is named before the provider names anything");

  // The provider renames this conversation and this host's watched read consumes that
  // row, so the row's name reaches the sidebar row.
  await h.append(titleRow("customTitle", "Renamed before the gap"));
  await settle();
  assert.deepEqual(titles.calls, [{ conversationId: SESSION, title: "Renamed before the gap" }]);

  // The authenticated lane fails and this run's own ROOT hook proves the SAME
  // conversation again, with NO new title row anywhere: recovery takes one fresh
  // metadata read of the bound file and must re-find the custom row that is still the
  // file's last one, rather than rejecting it over a position that no longer applies.
  h.controller.acceptFailure({ backend: "claude", reason: "input-timeout" });
  await settle(60);
  h.hook("UserPromptSubmit", { prompt_id: "after-the-gap" });
  await settle();
  assert.deepEqual(titles.calls, [
    { conversationId: SESSION, title: "Renamed before the gap" },
    { conversationId: SESSION, title: "Renamed before the gap" },
  ], "the same conversation is titled again by a fresh bounded read, with no new append");
  h.controller.dispose();
});

test("title: a transcript rewritten at smaller offsets during a hook-lane gap is retitled by recovery, not rejected by positions from before the gap", async () => {
  const workspace = await makeWorkspace();
  const titles = titleRecorder();
  const filler = jsonRow({
    type: "system",
    subtype: "keep-alive",
    uuid: "filler-row-6",
    padding: "w".repeat(400),
  });
  const h = await createHarness({
    workspace,
    seed: priorHistory() + filler + filler + filler + filler,
    maxTailBytes: 600,
    onConversationIdentity: identityRecorder().report,
    onConversationTitle: titles.report,
  });
  h.controller.observeOwnedStartup();
  h.hook("SessionStart", { source: "startup", cwd: workspace });
  await settle(60);
  await h.append(titleRow("customTitle", "Renamed deep in a long transcript"));
  await settle();
  assert.deepEqual(titles.calls, [{ conversationId: SESSION, title: "Renamed deep in a long transcript" }]);

  h.controller.acceptFailure({ backend: "claude", reason: "input-timeout" });
  await settle(60);

  // The provider rewrites THIS transcript — the same file behind the same path — and
  // this conversation's current custom title now sits far earlier in it.
  const before = await fs.stat(h.transcript);
  await fs.writeFile(h.transcript,
    priorHistory() + titleRow("customTitle", "Rewritten while the lane was dark"), "utf8");
  const after = await fs.stat(h.transcript);
  assert.equal(after.ino, before.ino, "the same file behind the same path, rewritten smaller");
  assert.ok(after.size < before.size, "and its title row now starts at a smaller offset");

  // Recovery of the SAME conversation takes one fresh read of the file as it is now.
  // Positions that belonged to the file before the gap cannot outweigh it: the row is
  // named by the transcript that exists, at the position it exists at.
  h.hook("UserPromptSubmit", { prompt_id: "after-the-gap" });
  await settle();
  assert.deepEqual(titles.calls.at(-1), { conversationId: SESSION, title: "Rewritten while the lane was dark" },
    "recovery accepts the fresh title at its new, smaller position");
  assert.equal(titles.calls.length, 2, JSON.stringify(titles.calls));
  h.controller.dispose();
});

test("title: a hydration read that lands after the conversation was replaced and then restored names nothing from before those resets", async () => {
  const f = await parkedTitleHarness(priorHistory() + titleRow("customTitle", "Conversation A's recorded title"));
  try {
    // Conversation B replaces A while A's read is parked. B's own read of the same
    // file refuses A's rows by their own session, so nothing is claimed.
    f.h.hook("SessionStart", { source: "clear", session_id: OTHER_SESSION, cwd: f.workspace });
    await settle(150);
    assert.equal(f.titles.calls.length, 0, "A's parked read cannot name B");

    // A is proved again in this same process: a new boundary, a new read.
    f.h.hook("SessionStart", { source: "startup", session_id: SESSION, cwd: f.workspace });
    f.first.release();
    await settle(150);
    assert.deepEqual(f.titles.calls, [{ conversationId: SESSION, title: "Conversation A's recorded title" }],
      "A's own new proof reads A's title afresh; the parked read contributed nothing");
  } finally {
    f.opens.restore();
    f.h.controller.dispose();
  }
});

test("title: a file replaced or truncated behind an in-flight hydration read publishes nothing", async () => {
  // A replacement: the bound PATH still exists and still names this run, but the file
  // behind it is gone. The tail reader verified the identity it OPENED and never looks
  // at the path again, so only a revalidation at commit can catch this.
  const replaced = await parkedTitleHarness(priorHistory() + titleRow("customTitle", "The first file's title"));
  try {
    const elsewhere = path.join(replaced.h.dir, "replacement.jsonl");
    await fs.writeFile(elsewhere,
      priorHistory() + titleRow("customTitle", "A different file's title"), "utf8");
    await fs.rename(elsewhere, replaced.h.transcript);
    replaced.first.release();
    await settle(150);
    assert.equal(replaced.titles.calls.length, 0,
      "bytes read from a file that is no longer behind the bound path name nothing");
  } finally {
    replaced.opens.restore();
    replaced.h.controller.dispose();
  }

  // A truncation: the same inode, but the bytes this read took are no longer there.
  const truncated = await parkedTitleHarness(priorHistory() + titleRow("customTitle", "A title in the truncated file"));
  try {
    await fs.truncate(truncated.h.transcript, 0);
    truncated.first.release();
    await settle(150);
    assert.equal(truncated.titles.calls.length, 0,
      "bytes the file no longer holds are not evidence, and nothing is claimed");
  } finally {
    truncated.opens.restore();
    truncated.h.controller.dispose();
  }
});

test("title: a generated title appended while initial coverage is still pending never outranks a custom title in the unread head", async () => {
  const filler = jsonRow({
    type: "system",
    subtype: "keep-alive",
    uuid: "filler-row-2",
    padding: "y".repeat(512),
  });
  const f = await parkedTitleHarness(
    titleRow("customTitle", "A custom title no window reached") + priorHistory() + filler
    + titleRow("aiTitle", "A generated title in the tail window"),
    600,
  );
  try {
    // The rename of the STATUS lane's own read runs while the title read is still
    // parked, so an incremental generated row lands FIRST. The provider ranks a custom
    // title over a generated one, and this host has not established what this file's
    // last custom row is, so the generated row stays unpublished rather than becoming
    // the row's name.
    await f.h.append(titleRow("aiTitle", "A generated title appended during the pending read"));
    readNow(f.received);
    // The watched read is issued for real (a busy lane defers it, it does not drop
    // it), and it completes: only then does "nothing was published" mean anything.
    await waitFor(() => f.opens.of(f.h.transcript).length >= 3, "the watched read of the appended row was issued");
    await committed(f.opens.of(f.h.transcript).filter((read) => read !== f.first));
    await settle(150);
    assert.equal(f.titles.calls.length, 0, "no generated title is published while custom-title coverage is pending");

    // The parked read lands: its window cannot reach the custom title either, so it
    // establishes nothing and the row still keeps its provider label.
    f.first.release();
    await settle(150);
    assert.equal(f.titles.calls.length, 0, "and the pending read did not quietly settle the ceiling either");
  } finally {
    f.opens.restore();
    f.h.controller.dispose();
  }
});

test("title: a whole-file title read that lands after a newer rename was consumed never rolls the title back", async () => {
  const f = await parkedTitleHarness(priorHistory() + titleRow("customTitle", "The name recorded first"));
  try {
    // The watched read consumes a rename while the whole-file title read is parked.
    await f.h.append(titleRow("customTitle", "Renamed while the title read was in flight"));
    readNow(f.received);
    await waitFor(() => f.titles.calls.length > 0, "the rename reaches the row on its own read");
    assert.deepEqual(f.titles.calls, [{ conversationId: SESSION, title: "Renamed while the title read was in flight" }],
      "the rename reaches the row on its own read");

    // The parked read lands now. It saw only the older row, and that row sits at a
    // lower offset in the same file, so it cannot roll the row back — and the cursor
    // has already consumed the rename, so a rollback would be permanent.
    f.first.release();
    await settle(200);
    assert.deepEqual(f.titles.calls, [{ conversationId: SESSION, title: "Renamed while the title read was in flight" }],
      "an older row's title never overwrites a newer one this host already applied");
  } finally {
    f.opens.restore();
    f.h.controller.dispose();
  }
});

test("title: a brand-new conversation's first records are read once from the start, and its first title lands", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const titles = titleRecorder();
  const h = await createHarness({
    createEmpty: true,
    workspace,
    onConversationIdentity: identity.report,
    onConversationTitle: titles.report,
  });
  // The provider writes the title row as part of starting the conversation, before
  // the fresh-start corroboration read runs.
  await h.append(titleRow("customTitle", "Named at creation"));
  h.hook("SessionStart", { source: "startup", cwd: workspace });
  await settle();
  assert.deepEqual(identity.calls, [SESSION]);
  assert.deepEqual(titles.calls, [{ conversationId: SESSION, title: "Named at creation" }],
    "the one whole-file read this scope makes also sees its title");
  h.controller.dispose();
});

test("title: a title row moves no status axis and never reaches an observation", async () => {
  const workspace = await makeWorkspace();
  const titles = titleRecorder();
  const h = await titledHarness(workspace, identityRecorder(), titles);
  const before = { ...h.latest() };

  await h.append(titleRow("customTitle", "Silent to the status lane"));
  await h.append(titleRow("aiTitle", "Also silent"));
  await settle();
  assert.deepEqual(titles.calls.map((call) => call.title), ["Silent to the status lane"]);
  const after = h.latest();
  assert.equal(after.busy, before.busy);
  assert.equal(after.pendingInput, before.pendingInput);
  assert.equal(after.activeTasks, before.activeTasks);
  assert.equal(after.activeShells, before.activeShells);
  assert.deepEqual(after.activity, before.activity);
  assert.equal(JSON.stringify(h.snapshots).includes("Silent to the status lane"), false);
  h.controller.dispose();
});

test("title: a whole-file read that finishes after the conversation was rebound names nothing", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const titles = titleRecorder();
  const h = await createHarness({
    createEmpty: true,
    workspace,
    onConversationIdentity: identity.report,
    onConversationTitle: titles.report,
  });
  await h.append(titleRow("customTitle", "The first conversation's title"));

  // Start the one whole-file read of conversation A...
  h.hook("SessionStart", { source: "startup", cwd: workspace });
  // ...and replace the conversation in the SAME synchronous stretch, before that
  // read's continuation can run. The read of A is still in flight.
  h.hook("SessionStart", { source: "clear", session_id: OTHER_SESSION, cwd: workspace });
  await settle(120);

  assert.ok(identity.calls.includes(OTHER_SESSION),
    `the run is now proved to be conversation B: ${JSON.stringify(identity.calls)}`);
  assert.equal(titles.calls.length, 0,
    "A's late read cannot leave its title in the ledger for B to publish");

  // B's own title still lands normally, which proves the lane is alive rather than
  // merely silent.
  await h.append(titleRow("customTitle", "The second conversation's title", { sessionId: OTHER_SESSION }));
  await settle();
  assert.deepEqual(titles.calls, [{ conversationId: OTHER_SESSION, title: "The second conversation's title" }]);
  h.controller.dispose();
});

test("title: an identity gap is closed by a fresh read of the bound transcript, not by a new title row", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const titles = titleRecorder();
  const h = await titledHarness(workspace, identity, titles);

  await h.append(titleRow("customTitle", "Ship the release notes"));
  await settle();
  assert.deepEqual(titles.calls, [{ conversationId: SESSION, title: "Ship the release notes" }]);

  // The authenticated hook lane fails. This source can no longer state which
  // conversation the row runs, so it reports the loss — and the owner withdraws the
  // title with the identity it was proved for.
  h.controller.acceptFailure({ backend: "claude", reason: "input-timeout" });
  await settle();
  assert.deepEqual(identity.calls.at(-1), null, "the gap is reported as identity loss");
  assert.equal(titles.calls.length, 1, "nothing about the title is claimed while nothing is proved");

  // The provider renames this SAME conversation while this host's lane is dark, and
  // nothing is read or claimed for it: with no proved conversation there is nothing
  // a title could be attributed to.
  await h.append(titleRow("customTitle", "Renamed while the lane was dark"));
  await settle(120);
  assert.equal(titles.calls.length, 1, "still nothing is claimed while nothing is proved");

  // This run's own admitted ROOT hook names the SAME conversation again: the gap
  // closed. Recovery takes one FRESH metadata read of the transcript this scope is
  // bound to now — the text cached before the gap was thrown away with the identity,
  // and it is not what arrives, which is what makes this a new observation of the
  // current source rather than a replay. No new title row is needed for the row to
  // be titled again.
  h.hook("UserPromptSubmit", { prompt_id: "after-the-gap" });
  await settle();
  assert.deepEqual(identity.calls.at(-1), SESSION, "the same conversation is proved again");
  assert.deepEqual(titles.calls.at(-1), { conversationId: SESSION, title: "Renamed while the lane was dark" },
    "the title reacquired after the gap comes from a fresh read of the bound file");
  assert.equal(titles.calls.length, 2, JSON.stringify(titles.calls));

  // A later row repeating that same title restates a fact this host already has.
  // (The gap closed the one watcher, exactly as it closes every other transcript
  // claim; this run's own published counts arm it again, as they always do.)
  h.hook("Stop", { background_counts: { tasks: 0, shells: 0 }, background_members: [] });
  await settle();
  await h.append(titleRow("customTitle", "Renamed while the lane was dark"));
  await settle();
  assert.equal(titles.calls.length, 2, "an unchanged title is never published twice");
  h.controller.dispose();
});

test("title: a provider title longer than the operator's caption bound is read and reported whole", async () => {
  const workspace = await makeWorkspace();
  const titles = titleRecorder();
  const h = await titledHarness(workspace, identityRecorder(), titles);

  // The operator's own caption bound is not a provider limit and must not silently
  // discard a title this host can publish: this text is far over the caption bound
  // and well inside the published-label bound a row's label actually travels under.
  const long = "Investigating the census read that raced the " + "generation".repeat(8) + " boundary";
  assert.ok(long.length > 80, "the fixture really is over the manual caption bound");
  assert.ok(Array.from(long).length <= MAX_NATIVE_SESSION_NAME_LENGTH);

  await h.append(titleRow("customTitle", long));
  await settle();
  assert.deepEqual(titles.calls, [{ conversationId: SESSION, title: long }],
    "a valid provider title is never discarded, clipped, or truncated for its length");

  // What the published label cannot carry at all is still refused whole.
  await h.append(titleRow("customTitle", "z".repeat(MAX_NATIVE_SESSION_NAME_LENGTH + 1)));
  await settle();
  assert.equal(titles.calls.length, 1, "an unpublishable title is refused, never clipped into one");

  const atTheBound = String.fromCodePoint(0xe9).repeat(MAX_NATIVE_SESSION_NAME_LENGTH);
  await h.append(titleRow("customTitle", atTheBound));
  await settle();
  assert.deepEqual(titles.calls.at(-1), { conversationId: SESSION, title: atTheBound },
    "the bound is measured the way the published label measures it, in code points");
  h.controller.dispose();
});

test("title: a captioned row keeps its caption — a refused hydrated title is offered on real source events and never on a timer", async () => {
  const workspace = await makeWorkspace();
  const titles = titleRecorder(false);
  const h = await titledHarness(workspace, identityRecorder(), titles,
    priorHistory() + titleRow("customTitle", "A title this row no longer shows"));
  await settle(150);
  const offered = titles.calls.length;
  assert.ok(offered > 0, "the recorded title reaches the owner, which is where a caption is honored");
  assert.ok(titles.calls.every((call) => call.title === "A title this row no longer shows"
    && call.conversationId === SESSION), JSON.stringify(titles.calls));
  // Every offer came from a read of this run's own source. With no new source event
  // there is nothing to retry, so the row simply keeps the caption its owner chose.
  await settle(250);
  assert.equal(titles.calls.length, offered,
    "a refused title is never re-offered on a timer of its own, so a captioned row keeps its caption");
  h.controller.dispose();
});

test("#682: the root tool-request verdict names only applied root work of the proved conversation, never a stale-prompt edge", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const reported: Array<readonly [string, string, string]> = [];
  const h = await createHarness({
    workspace,
    onConversationIdentity: identity.report,
    onRootToolRequest: (conversationId, toolUseId, toolName) => { reported.push([conversationId, toolUseId, toolName]); },
  });
  const tool = `mcp__pi_review_gate_${"a1".repeat(16)}__SubtasksInspect`;
  h.hook("SessionStart", { source: "startup", cwd: await fs.realpath(workspace) });
  assert.deepEqual(identity.calls, [SESSION]);
  h.hook("UserPromptSubmit", { prompt_id: "p2" });
  h.hook("PreToolUse", { prompt_id: "p1", tool_name: tool, tool_use_id: "toolu_stale" });
  assert.deepEqual(reported, [], "a PreToolUse of an older prompt is refused by the reducer and never reported");
  h.hook("PreToolUse", { prompt_id: "p2", tool_name: tool, tool_use_id: "toolu_child", agent_id: "child-agent" });
  h.hook("PreToolUse", { prompt_id: "p2", tool_name: tool, tool_use_id: "toolu_other", session_id: OTHER_SESSION });
  assert.deepEqual(reported, [], "a child's or another session's tool request is never reported");
  h.hook("PreToolUse", { prompt_id: "p2", tool_name: tool, tool_use_id: "toolu_live" });
  assert.deepEqual(reported, [[SESSION, "toolu_live", tool]], "applied current root work is reported once, synchronously");
});

test("#682: a same-session transcript rebind is reported, synchronously, before the boundary hook reports fresh tool work", async () => {
  const workspace = await makeWorkspace();
  const identity = identityRecorder();
  const events: string[] = [];
  const h = await createHarness({
    workspace,
    onConversationIdentity: identity.report,
    onRootToolRequest: (_conversationId, toolUseId) => { events.push(`tool:${toolUseId}`); },
    onRootTranscriptRebound: (conversationId) => { events.push(`rebound:${conversationId}`); },
  });
  const tool = `mcp__pi_review_gate_${"a1".repeat(16)}__SubtasksInspect`;
  h.hook("SessionStart", { source: "startup", cwd: await fs.realpath(workspace) });
  h.hook("PreToolUse", { tool_name: tool, tool_use_id: "toolu_a" });
  assert.deepEqual(events, ["tool:toolu_a"], "no rebind on the bound transcript");
  const other = path.join(h.dir, "rebound.jsonl");
  await fs.writeFile(other, "", "utf8");
  h.hook("PreToolUse", { tool_name: tool, tool_use_id: "toolu_b", transcript_path: other });
  assert.deepEqual(events, ["tool:toolu_a", `rebound:${SESSION}`, "tool:toolu_b"],
    "the reset is reported before the boundary hook's own fresh tool work");
  h.hook("PreToolUse", { tool_name: tool, tool_use_id: "toolu_c", transcript_path: other });
  assert.deepEqual(events.slice(3), ["tool:toolu_c"], "the same transcript again is no rebind");
});
