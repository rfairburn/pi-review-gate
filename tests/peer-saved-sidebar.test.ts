/**
 * Pure selected-host Saved picker tests.
 *
 * Everything here is a controlled DTO: no coordinator, transport, owner, file,
 * process, or clock is involved, and no remote request is ever performed. The
 * tests pin the UI contract a later Main integration consumes: Local-by-default
 * opening, actual-Host-change clearing, exact owner rows through the shared
 * local formatter, bounded windows over a result larger than one transfer,
 * non-actionable loading placeholders, actual-written frame fences for Resume
 * and Delete, owner-policy (never local-setting) delete exposure, and request
 * lifetime fences for late completions. They claim nothing about real network,
 * owner, or native behavior.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";
import {
  REMOTE_SAVED_DELETE_OFF_NOTICE,
  REMOTE_SAVED_UNSUPPORTED_NOTICE,
  REMOTE_SAVED_UNWRITTEN_NOTICE,
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  SidebarController,
  type SidebarAction,
  type SidebarRemoteSavedWindowFacts,
} from "../src/session-host/sidebar";
import type { PeerUiHost, PeerUiSettings, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import type { OwnerSavedEntry } from "../src/session-host/network/peer-saved";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const SHIFT_TAB = "\x1b[Z";
const CTRL_D = "\x04";
const KITTY_ENTER_REPEAT = "\x1b[13;1:2u";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const TOGGLE = "\x1b[1;3D";
const COLS = 70;
const ROWS = 30;

const SETTINGS: PeerUiSettings = {
  hostingEnabled: false,
  bindHost: "127.0.0.1",
  bindPort: 8443,
  autoReconnect: false,
  bellEnabled: true,
  viewerNativeInputEnabled: true,
  remoteHistoryDeleteEnabled: true,
};

function host(overrides: Partial<PeerUiHost> & { id: string }): PeerUiHost {
  return {
    label: `host-${overrides.id}`,
    host: "10.0.0.5",
    port: 8443,
    state: "connected",
    fingerprint: `SHA256:${overrides.id}`,
    message: null,
    reconnectSuppressed: false,
    previouslyConnected: true,
    // An EMPTY owner roster still reports its exact owner run.
    roster: { state: "current", rows: [], hostRunId: `run-${overrides.id}` },
    saved: { supported: true, deleteExposed: true },
    ...overrides,
  };
}

function snapshot(hosts: readonly PeerUiHost[], overrides: Partial<PeerUiSnapshot> = {}): PeerUiSnapshot {
  return {
    revision: 1,
    status: "ready",
    settings: { ...SETTINGS },
    identityFingerprint: "SHA256:local",
    listener: { state: "off", host: null, port: null, message: null },
    hosts,
    trustedPeers: [],
    consents: [],
    notice: null,
    ...overrides,
  };
}

function entry(index: number, overrides: Partial<OwnerSavedEntry> = {}): OwnerSavedEntry {
  return {
    entryId: `e-${index}`,
    sessionId: `s-${index}`,
    file: `/owner/sessions/${index}.jsonl`,
    caption: `caption ${index}`,
    cwd: `/owner/ws/${index}`,
    ...overrides,
  };
}

function windowFacts(
  offset: number,
  count: number,
  total: number,
  ids: { readonly hostRunId?: string; readonly catalogId?: string; readonly resultId?: string } = {},
  make: (index: number) => OwnerSavedEntry = (index) => entry(index),
): SidebarRemoteSavedWindowFacts {
  const entries: OwnerSavedEntry[] = [];
  for (let index = offset; index < Math.min(total, offset + count); index += 1) entries.push(make(index));
  return {
    kind: "window",
    hostRunId: ids.hostRunId ?? "run-A",
    catalogId: ids.catalogId ?? "cat-1",
    resultId: ids.resultId ?? "res-1",
    total,
    issueCount: 0,
    offset,
    entries,
  };
}

interface Harness {
  readonly controller: SidebarController;
  readonly actions: SidebarAction[];
  baseline: number;
  send(data: string): void;
  commands(): SidebarAction[];
}

function makeHarness(peer: PeerUiSnapshot): Harness {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    initialVisible: false,
    now: () => 1_700_000_000_000,
    onAction: (action) => actions.push(action),
  });
  controller.setPeerUiSnapshot(peer);
  const harness: Harness = {
    controller,
    actions,
    baseline: actions.length,
    send: (data) => controller.handleInput(data),
    commands: () => actions.slice(harness.baseline).filter((action) => action.type !== "forward"),
  };
  return harness;
}

function mark(harness: Harness): void {
  harness.baseline = harness.actions.length;
}

function lastOf<T extends SidebarAction["type"]>(
  harness: Harness,
  type: T,
): Extract<SidebarAction, { type: T }> | undefined {
  const found = [...harness.actions].reverse().find((action) => action.type === type);
  return found as Extract<SidebarAction, { type: T }> | undefined;
}

function text(lines: readonly string[], cols: number, rows?: number): string[] {
  for (const line of lines) {
    for (const sgr of line.match(SGR_PATTERN) ?? []) {
      assert.ok(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)), `unexpected SGR ${JSON.stringify(sgr)}`);
    }
    const plain = line.replace(SGR_PATTERN, "");
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(plain), `control byte in ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(plain) <= cols, `row wider than pane: ${JSON.stringify(plain)}`);
  }
  if (rows !== undefined) assert.equal(lines.length, rows);
  return lines.map((line) => line.replace(SGR_PATTERN, ""));
}

function pane(harness: Harness, cols = COLS, rows = ROWS): string[] {
  return text(harness.controller.renderForm(cols, rows).lines, cols, rows);
}

/** The pane text with wrapped notice rows rejoined. */
function flat(lines: readonly string[]): string {
  return lines.join(" ").replace(/\s+/g, " ");
}

/** Opens the Saved picker through the ordinary roster entry and returns its picker id. */
function openSaved(harness: Harness): number {
  if (!harness.controller.visible) harness.send(TOGGLE);
  assert.equal(harness.controller.focus, "sidebar");
  let found = false;
  for (let step = 0; step < 12 && !found; step += 1) {
    const roster = text(harness.controller.render(60, 30).lines, 60, 30);
    found = roster.some((line) => line.startsWith("> Saved conversations"));
    if (!found) harness.send(UP);
  }
  assert.ok(found, "the Saved conversations entry is the drawn highlight");
  mark(harness);
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  const pickerId = harness.controller.savedPickerRequestId;
  assert.ok(pickerId !== undefined, "the picker owns the pane");
  assert.deepEqual(harness.commands(), [{ type: "saved-list", requestId: pickerId }],
    "opening still emits exactly the unchanged local listing");
  return pickerId;
}

/** Shift+Tab to the Host line, then cycle it `steps` times with Down. */
function chooseHost(harness: Harness, steps: number): void {
  harness.send(SHIFT_TAB);
  for (let step = 0; step < steps; step += 1) harness.send(DOWN);
  harness.send(SHIFT_TAB); // back to the query
}

/** Opens Saved, chooses remote host A, and answers its first listing. */
function openRemote(harness: Harness, total: number, first = 32): Extract<SidebarAction, { type: "saved-remote-list" }> {
  openSaved(harness);
  void pane(harness);
  mark(harness);
  chooseHost(harness, 1);
  const list = lastOf(harness, "saved-remote-list");
  assert.ok(list !== undefined, "choosing the owner emits one remote listing");
  assert.equal(harness.controller.completeRemoteSavedWindow(list.requestId, windowFacts(0, first, total)), true);
  mark(harness);
  return list;
}

function settlePicker(harness: Harness, cols = COLS, rows = ROWS): number {
  void pane(harness, cols, rows);
  const presentation = harness.controller.captureSavedPickerPresentation();
  assert.ok(presentation !== undefined, "a complete remote frame was drawn");
  assert.equal(harness.controller.settleSavedPickerRender(presentation.renderToken), true);
  return presentation.renderToken;
}

// ---------------------------------------------------------------------------
// Local parity and Host selection
// ---------------------------------------------------------------------------

test("without a Saved-capable destination the Local picker is exactly unchanged", () => {
  // A connected destination whose DTO carries no Saved description (an older
  // coordinator) is never offered, so today's Main exposes nothing remote.
  const { saved: _saved, ...legacy } = host({ id: "L" });
  const harness = makeHarness(snapshot([legacy]));
  const pickerId = openSaved(harness);
  harness.controller.completeSavedList(pickerId, [
    { id: "local-1", file: "/local/one.jsonl", caption: "local one", cwd: "/local/ws" },
  ], 0);
  const lines = pane(harness);
  assert.ok(!lines.some((line) => line.includes("Host:")), "no Host line without a Saved-capable destination");
  assert.ok(!lines.some((line) => line.includes("shift+tab host")), "no Host hint either");
  assert.ok(lines[2]?.includes("local one"), "the first list row keeps its exact legacy pane row");
  mark(harness);
  harness.send(SHIFT_TAB);
  assert.ok(!harness.commands().some((action) => action.type.startsWith("saved-remote")),
    "Shift+Tab never reaches a remote choice");
  assert.equal(harness.controller.savedPickerHost.kind, "local");
  void pane(harness);
  mark(harness);
  harness.send(ENTER);
  const open = lastOf(harness, "saved-open");
  assert.ok(open !== undefined);
  assert.deepEqual(harness.commands(), [{
    type: "saved-open", requestId: open.requestId, file: "/local/one.jsonl", sessionId: "local-1",
  }], "local open keeps its exact action shape");
});

test("the picker opens on Local, every actual Host change clears query and results, and reopening resets", () => {
  const harness = makeHarness(snapshot([
    host({ id: "A" }),
    host({ id: "B", saved: { supported: false, deleteExposed: null } }),
  ], { settings: { ...SETTINGS, viewerNativeInputEnabled: false, remoteHistoryDeleteEnabled: false } }));
  const localPicker = openSaved(harness);
  harness.controller.completeSavedList(localPicker, [
    { id: "l-1", file: "/local/1.jsonl", caption: "local first" },
  ], 0);
  let lines = pane(harness);
  assert.ok(lines[1]?.includes("Host: [ Local ]"), "Local is the default choice");
  assert.equal(harness.controller.savedPickerHost.kind, "local");
  harness.send("a");
  harness.send("b");
  assert.equal(harness.controller.savedQuery, "ab");
  assert.equal(lastOf(harness, "saved-search")?.pickerId, localPicker, "Local search is unchanged");

  mark(harness);
  harness.send(SHIFT_TAB);
  lines = pane(harness);
  assert.ok(lines[1]?.startsWith("> Host:"), "Shift+Tab focuses the Host line");
  harness.send(DOWN); // Local -> A
  const remoteList = lastOf(harness, "saved-remote-list");
  assert.ok(remoteList !== undefined);
  const remotePicker = remoteList.pickerId;
  assert.deepEqual(harness.commands(), [
    { type: "saved-dismiss", pickerId: localPicker },
    {
      type: "saved-remote-list", pickerId: remotePicker, requestId: remoteList.requestId, revision: 0,
      hostId: "A", hostRunId: "run-A", query: "", offset: 0, count: 32,
    },
  ], "an actual change retires Local and lists the owner with a blank query (viewer input Off is irrelevant)");
  assert.notEqual(remotePicker, localPicker, "the picker identity is re-minted");
  assert.equal(harness.controller.savedQuery, "", "the query is cleared");
  lines = pane(harness);
  assert.ok(!lines.some((line) => line.includes("local first")), "Local results are cleared");
  assert.ok(lines.some((line) => line.includes("Loading saved conversations")));

  mark(harness);
  harness.send(DOWN); // A -> B (honest unsupported legacy owner)
  assert.deepEqual(harness.commands(), [{ type: "saved-remote-dismiss", pickerId: remotePicker, hostId: "A" }],
    "an unsupported owner is never asked anything");
  lines = pane(harness);
  assert.ok(lines.some((line) => line.includes(REMOTE_SAVED_UNSUPPORTED_NOTICE)));

  mark(harness);
  harness.send(DOWN); // B -> Local
  const relist = lastOf(harness, "saved-list");
  assert.ok(relist !== undefined);
  assert.equal(harness.commands().length, 2);
  assert.equal(harness.commands()[0]?.type, "saved-remote-dismiss");
  assert.deepEqual(harness.commands()[1], { type: "saved-list", requestId: relist.requestId });
  assert.equal(harness.controller.savedPickerRequestId, relist.requestId, "Main's local listing guard matches");
  assert.equal(harness.controller.savedQuery, "");

  // Leave the Host line, dismiss, and reopen: Local with a blank query again.
  harness.send(ESC);
  harness.send(ESC);
  assert.equal(harness.controller.focus, "sidebar");
  openSaved(harness);
  assert.equal(harness.controller.savedPickerHost.kind, "local");
  assert.equal(harness.controller.savedQuery, "");
});

test("an unchanged re-observation of the chosen owner changes nothing", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, 5, 5);
  harness.send("q");
  const search = lastOf(harness, "saved-remote-search");
  assert.ok(search !== undefined);
  assert.equal(harness.controller.completeRemoteSavedWindow(search.requestId,
    windowFacts(0, 5, 5, { resultId: "res-2" })), true);
  const before = harness.controller.savedRemoteContext();
  mark(harness);
  harness.controller.setPeerUiSnapshot(snapshot([host({ id: "A" })], { revision: 2 }));
  assert.deepEqual(harness.commands(), [], "no relist, retry, or rebind on a re-observation");
  assert.deepEqual(harness.controller.savedRemoteContext(), before);
  assert.equal(harness.controller.savedQuery, "q");
});

// ---------------------------------------------------------------------------
// Exact owner rows and the closed local/remote discriminator
// ---------------------------------------------------------------------------

test("remote rows show the exact owner strings (Windows paths on POSIX) and never share local authority", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  const windowsFile = "C:\\Users\\Me\\.pi\\sessions\\one.jsonl";
  openSaved(harness);
  void pane(harness, 100);
  mark(harness);
  chooseHost(harness, 1);
  const list = lastOf(harness, "saved-remote-list");
  assert.ok(list !== undefined);
  assert.equal(harness.controller.completeRemoteSavedWindow(list.requestId, windowFacts(0, 1, 1, {}, () => entry(0, {
    sessionId: "same-id", file: windowsFile, caption: "Same caption", cwd: "C:\\Users\\Me\\proj",
  }))), true);
  const lines = pane(harness, 100);
  assert.ok(lines.some((line) => line.startsWith("> Same caption") && line.includes(" | C:\\Users\\Me\\proj")),
    "the shared row formatter shows caption and exact owner workspace");
  assert.ok(lines.some((line) => line.trim() === "C:\\Users\\Me\\proj"), "details show the exact workspace");

  // Enter on a merely rendered frame sends nothing.
  mark(harness);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), []);
  assert.ok(pane(harness, 100).some((line) => line.includes(REMOTE_SAVED_UNWRITTEN_NOTICE)));

  const token = settlePicker(harness, 100);
  mark(harness);
  harness.send(ENTER);
  harness.send(KITTY_ENTER_REPEAT);
  const resume = lastOf(harness, "saved-remote-resume");
  assert.ok(resume !== undefined);
  assert.deepEqual(harness.commands(), [{
    type: "saved-remote-resume", pickerId: list.pickerId, requestId: resume.requestId, revision: 0,
    hostId: "A", hostRunId: "run-A", catalogId: "cat-1", resultId: "res-1", entryId: "e-0", renderToken: token,
  }], "exactly one remote intent naming opaque owner handles; the held repeat adds nothing");
  assert.equal(harness.controller.remoteSavedIntentStillCurrent(resume), true);
  assert.ok(!harness.actions.some((action) => action.type === "saved-open" || action.type === "saved-delete"
    || action.type === "saved-delete-prepare"), "a remote row never reaches a local route");

  // The same id/file/caption on LOCAL takes only the local route.
  mark(harness);
  chooseHost(harness, 1); // A -> Local
  const local = lastOf(harness, "saved-list");
  assert.ok(local !== undefined);
  harness.controller.completeSavedList(local.requestId, [
    { id: "same-id", file: windowsFile, caption: "Same caption" },
  ], 0);
  void pane(harness, 100);
  mark(harness);
  harness.send(ENTER);
  const commands = harness.commands();
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.type, "saved-open");
  assert.equal(harness.controller.remoteSavedIntentStillCurrent(resume), false,
    "the remote intent's authority ended with its picker");
});

// ---------------------------------------------------------------------------
// Windows: full results beyond one transfer, bounded retention
// ---------------------------------------------------------------------------

test("a result larger than 4096 wraps absolutely through bounded windows with non-actionable placeholders", () => {
  const total = 10_000;
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, total);
  harness.send(UP); // 0 -> 9999 (absolute wrap over the FULL total)
  const first = lastOf(harness, "saved-remote-window");
  assert.ok(first !== undefined);
  assert.equal(first.offset, 9984, "an aligned bounded window containing the selection");
  assert.equal(first.count, 32);
  assert.equal(first.catalogId, "cat-1");
  assert.equal(first.resultId, "res-1");

  let lines = pane(harness);
  const selectedRow = lines.findIndex((line) => line.startsWith("> loading..."));
  assert.ok(selectedRow > 0, "the uncached selection is a loading placeholder");
  assert.ok(!lines.some((line) => line.includes("caption 9999")), "details stay blank until cached");
  const presentation = harness.controller.captureMousePresentation();
  assert.equal(presentation.activateSavedAt(4, selectedRow, COLS, ROWS), false, "a placeholder is never a hit target");
  assert.deepEqual(harness.controller.captureSavedPickerPresentation()?.drawn, [], "no placeholder is a drawn row");

  // A shorter honest prefix never repeats the same aligned window.
  mark(harness);
  assert.equal(harness.controller.completeRemoteSavedWindow(first.requestId, windowFacts(9984, 5, total)), true);
  const second = lastOf(harness, "saved-remote-window");
  assert.ok(second !== undefined && second.requestId !== first.requestId);
  assert.equal(second.offset, 9999, "the next read starts at the wanted index");
  assert.equal(harness.controller.completeRemoteSavedWindow(second.requestId, windowFacts(9999, 1, total)), true);
  lines = pane(harness);
  assert.ok(lines.some((line) => line.startsWith("> caption 9999")), "the selection is reached");

  // Answer any bounded follow-ups; retention never exceeds three windows.
  for (let step = 0; step < 8; step += 1) {
    const context = harness.controller.savedRemoteContext();
    assert.ok(context !== undefined);
    assert.ok(context.windows.length <= 3, "at most three windows are retained");
    assert.ok(context.windows.every((window) => window.length <= 4096));
    const pending = context.pendingReads[0];
    if (pending === undefined) break;
    const read = harness.actions.find((action) => action.type === "saved-remote-window"
      && action.requestId === pending) as Extract<SidebarAction, { type: "saved-remote-window" }> | undefined;
    assert.ok(read !== undefined && read.offset >= 0 && read.offset < total && read.count === 32);
    harness.controller.completeRemoteSavedWindow(read.requestId, windowFacts(read.offset, read.count, total));
    void pane(harness);
  }
  assert.ok((harness.controller.savedRemoteContext()?.windows.length ?? 0) <= 3);

  harness.send(DOWN); // 9999 -> 0
  assert.equal(harness.controller.savedRemoteContext()?.selectedIndex, 0, "Down wraps back to the first row");
  for (let step = 0; step < 4; step += 1) {
    const pending = harness.controller.savedRemoteContext()?.pendingReads[0];
    if (pending === undefined) break;
    const read = harness.actions.find((action) => action.type === "saved-remote-window"
      && action.requestId === pending) as Extract<SidebarAction, { type: "saved-remote-window" }> | undefined;
    assert.ok(read !== undefined);
    harness.controller.completeRemoteSavedWindow(read.requestId, windowFacts(read.offset, read.count, total));
  }
  assert.ok(pane(harness).some((line) => line.startsWith("> caption 0")), "row 0 is reachable again");
  assert.ok((harness.controller.savedRemoteContext()?.windows.length ?? 0) <= 3);
});

test("a new query keeps the absolute selection, clamps it, and retires older reads", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, 10_000);
  harness.send(UP); // 9999, window read outstanding
  const stale = lastOf(harness, "saved-remote-window");
  assert.ok(stale !== undefined);
  mark(harness);
  harness.send("x");
  const search = lastOf(harness, "saved-remote-search");
  assert.ok(search !== undefined);
  assert.deepEqual(harness.commands(), [{
    type: "saved-remote-search", pickerId: search.pickerId, requestId: search.requestId, revision: 1,
    hostId: "A", hostRunId: "run-A", catalogId: "cat-1", query: "x", offset: 0, count: 32,
  }], "the owner matches the exact query inside the same catalog");
  assert.deepEqual(harness.controller.savedRemoteContext()?.pendingReads, [search.requestId]);
  assert.equal(harness.controller.completeRemoteSavedWindow(stale.requestId, windowFacts(9984, 32, 10_000)), false,
    "a superseded window can never be applied");

  mark(harness);
  assert.equal(harness.controller.completeRemoteSavedWindow(search.requestId,
    windowFacts(0, 32, 50, { resultId: "res-2" })), true);
  assert.equal(harness.controller.savedRemoteContext()?.selectedIndex, 49, "kept and clamped, not reset to 0");
  const follow = lastOf(harness, "saved-remote-window");
  assert.ok(follow !== undefined);
  assert.equal(follow.offset, 32);
  assert.equal(follow.resultId, "res-2");
  // An empty owner result is the only empty state.
  harness.send("y");
  const empty = lastOf(harness, "saved-remote-search");
  assert.ok(empty !== undefined);
  assert.equal(harness.controller.completeRemoteSavedWindow(empty.requestId,
    windowFacts(0, 32, 0, { resultId: "res-3" })), true);
  assert.ok(pane(harness).some((line) => line.includes("No matching saved conversations")));
});

// ---------------------------------------------------------------------------
// Written frame, geometry, mouse, and request-lifetime fences
// ---------------------------------------------------------------------------

test("a resize, window change, or unsettled frame withdraws Resume authority", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, 3, 3);
  const oldToken = settlePicker(harness);
  void pane(harness, COLS + 2, ROWS); // resize
  assert.equal(harness.controller.settleSavedPickerRender(oldToken), false, "an old receipt cannot be revived");
  mark(harness);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "the resized frame is not written yet");

  const token = settlePicker(harness, COLS + 2, ROWS);
  harness.send(DOWN); // a new selection is a new frame
  mark(harness);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), []);
  assert.notEqual(settlePicker(harness, COLS + 2, ROWS), token);
  mark(harness);
  harness.send(ENTER);
  assert.equal(harness.commands()[0]?.type, "saved-remote-resume");
});

test("a press on a written drawn row resumes that exact owner entry", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, 3, 3);
  settlePicker(harness);
  const frame = harness.controller.captureSavedPickerPresentation();
  assert.ok(frame !== undefined);
  const target = frame.drawn.find((row) => row.index === 2);
  assert.ok(target !== undefined);
  const mouse = harness.controller.captureMousePresentation();
  mark(harness);
  assert.equal(mouse.activateSavedAt(4, target.paneRow, COLS, ROWS), true);
  const resume = lastOf(harness, "saved-remote-resume");
  assert.equal(resume?.entryId, "e-2");
  assert.equal(resume?.renderToken, frame.renderToken);
});

test("a Resume selects the owner row only while its exact request still owns the picker", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  const list = openRemote(harness, 3, 3);
  settlePicker(harness);
  harness.send(ENTER);
  const late = lastOf(harness, "saved-remote-resume");
  assert.ok(late !== undefined);
  harness.send(DOWN); // the operator moved on
  mark(harness);
  assert.equal(harness.controller.completeRemoteSavedResume(late.requestId, { hostRunId: "run-A", rowId: "row-1" }), false);
  assert.deepEqual(harness.commands(), [], "a late completion never steals the pane or focus");
  assert.equal(harness.controller.focus, "form");

  settlePicker(harness);
  harness.send(ENTER);
  const other = lastOf(harness, "saved-remote-resume");
  assert.ok(other !== undefined && other.requestId !== late.requestId);
  mark(harness);
  assert.equal(harness.controller.completeRemoteSavedResume(other.requestId, { hostRunId: "run-B", rowId: "row-2" }), false,
    "another owner run is never selected");
  assert.deepEqual(harness.commands(), []);

  settlePicker(harness);
  harness.send(ENTER);
  const owned = lastOf(harness, "saved-remote-resume");
  assert.ok(owned !== undefined);
  mark(harness);
  assert.equal(harness.controller.completeRemoteSavedResume(owned.requestId, { hostRunId: "run-A", rowId: "row-3" }), true);
  assert.deepEqual(harness.commands(), [
    { type: "saved-remote-dismiss", pickerId: list.pickerId, hostId: "A" },
    { type: "select-remote", hostId: "A", hostRunId: "run-A", rowId: "row-3" },
  ]);
  assert.equal(harness.controller.focus, "main");
});

test("a written frame never regains authority after Down then Up", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, 3, 3);
  const token = settlePicker(harness);
  harness.send(DOWN);
  harness.send(UP); // back on the same row and the same values
  assert.equal(harness.controller.captureSavedPickerPresentation(), undefined, "the written frame was retired");
  assert.equal(harness.controller.isSavedPickerRenderCurrent(token), false);
  assert.equal(harness.controller.settleSavedPickerRender(token), false, "the old receipt cannot be revived");
  mark(harness);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "a reversed selection change is still a change");
  void pane(harness);
  const fresh = harness.controller.captureSavedPickerPresentation();
  assert.ok(fresh !== undefined);
  assert.notEqual(fresh.renderToken, token, "an identical redraw is a NEW frame needing its own receipt");
  assert.ok(fresh.viewEpoch > 0);
  harness.controller.settleSavedPickerRender(fresh.renderToken);
  harness.send(ENTER);
  assert.equal(harness.commands()[0]?.type, "saved-remote-resume");
});

test("a pending Resume or Delete-prepare never completes after Down then Up", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, 3, 3);
  settlePicker(harness);
  harness.send(ENTER);
  const resume = lastOf(harness, "saved-remote-resume");
  assert.ok(resume !== undefined);
  harness.send(DOWN);
  harness.send(UP);
  assert.equal(harness.controller.remoteSavedIntentStillCurrent(resume), false);
  mark(harness);
  assert.equal(harness.controller.completeRemoteSavedResume(resume.requestId, { hostRunId: "run-A", rowId: "row-1" }), false,
    "a late reply never selects a row once its selection ownership was retired");
  assert.deepEqual(harness.commands(), []);
  assert.equal(harness.controller.focus, "form");

  settlePicker(harness);
  harness.send(CTRL_D);
  const prepare = lastOf(harness, "saved-remote-delete-prepare");
  assert.ok(prepare !== undefined);
  harness.send(DOWN);
  harness.send(UP);
  assert.equal(harness.controller.remoteSavedIntentStillCurrent(prepare), false);
  assert.equal(harness.controller.completeRemoteSavedDeletePrepare(prepare.requestId, true), false,
    "a late prepare never opens a confirmation");
  assert.equal(harness.controller.focus, "form");
  assert.equal(harness.controller.savedDeleteConfirmationActive, false);
});

test("the last-instant re-proof requires the current written picker frame", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, 3, 3);
  settlePicker(harness);
  harness.send(ENTER);
  const resume = lastOf(harness, "saved-remote-resume");
  assert.ok(resume !== undefined);
  assert.equal(harness.controller.remoteSavedIntentStillCurrent(resume), true);
  void pane(harness); // an identical repaint keeps the same written frame
  assert.equal(harness.controller.remoteSavedIntentStillCurrent(resume), true);
  harness.controller.invalidateSavedPickerPresentation();
  assert.equal(harness.controller.remoteSavedIntentStillCurrent(resume), false, "withdrawal revokes the intent");
  void pane(harness);
  assert.equal(harness.controller.remoteSavedIntentStillCurrent(resume), false, "a new frame is not that receipt");

  const resized = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(resized, 3, 3);
  settlePicker(resized);
  resized.send(CTRL_D);
  const prepare = lastOf(resized, "saved-remote-delete-prepare");
  assert.ok(prepare !== undefined);
  assert.equal(resized.controller.remoteSavedIntentStillCurrent(prepare), true);
  void pane(resized, COLS + 4, ROWS);
  assert.equal(resized.controller.remoteSavedIntentStillCurrent(prepare), false, "a resize revokes the intent");
});

test("a confirmed Delete's re-proof requires the current written confirmation but keeps its completion", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, 1, 1);
  settlePicker(harness);
  harness.send(CTRL_D);
  const prepare = lastOf(harness, "saved-remote-delete-prepare");
  assert.ok(prepare !== undefined);
  harness.controller.completeRemoteSavedDeletePrepare(prepare.requestId, true);
  void harness.controller.renderSavedDeleteConfirmation(COLS, 20);
  const confirmToken = harness.controller.savedDeleteConfirmationRenderTokenNumber;
  assert.ok(confirmToken !== undefined);
  harness.controller.settleSavedDeleteConfirmationRender(confirmToken);
  harness.send(ENTER);
  const remove = lastOf(harness, "saved-remote-delete");
  assert.ok(remove !== undefined);
  assert.equal(harness.controller.remoteSavedIntentStillCurrent(remove), true);
  harness.controller.invalidateSavedDeleteConfirmationDisplay();
  assert.equal(harness.controller.remoteSavedIntentStillCurrent(remove), false,
    "an invalidated confirmation can no longer send the delete");
  void harness.controller.renderSavedDeleteConfirmation(COLS, 20);
  const reminted = harness.controller.savedDeleteConfirmationRenderTokenNumber;
  assert.ok(reminted !== undefined && reminted !== confirmToken);
  harness.controller.settleSavedDeleteConfirmationRender(reminted);
  assert.equal(harness.controller.remoteSavedIntentStillCurrent(remove), false, "a re-minted dialog is not that receipt");
  assert.equal(harness.controller.completeRemoteSavedDelete(remove.requestId, "Saved conversation moved to trash", true), true,
    "completion ownership of submitted work is kept");
});

// ---------------------------------------------------------------------------
// Delete: OWNER policy, prepare vs confirmation, written dialog, paste opacity
// ---------------------------------------------------------------------------

test("remote delete follows the OWNER's live exposure, never this viewer's own setting", () => {
  const off = host({ id: "A", saved: { supported: true, deleteExposed: false } });
  const harness = makeHarness(snapshot([off], { settings: { ...SETTINGS, remoteHistoryDeleteEnabled: true } }));
  openRemote(harness, 2, 2);
  let lines = pane(harness);
  assert.ok(!lines.some((line) => line.includes("delete")), "owner Off hides the delete hints");
  settlePicker(harness);
  harness.send(CTRL_D);
  assert.deepEqual(harness.commands(), [], "owner Off refuses without a request");
  assert.ok(flat(pane(harness)).includes(REMOTE_SAVED_DELETE_OFF_NOTICE));

  // Owner On, while THIS viewer's own owner-side setting is Off: hints return
  // with no relist, and the new frame needs its own written receipt.
  mark(harness);
  harness.controller.setPeerUiSnapshot(snapshot([host({ id: "A" })], {
    revision: 2, settings: { ...SETTINGS, remoteHistoryDeleteEnabled: false },
  }));
  assert.deepEqual(harness.commands(), [], "a policy change relists nothing");
  lines = pane(harness);
  assert.ok(lines.some((line) => line.includes("delete")), "owner On restores the hints");
  harness.send(CTRL_D);
  assert.deepEqual(harness.commands(), [], "the newly drawn frame is not written yet");
  const token = settlePicker(harness);
  mark(harness);
  harness.send(CTRL_D);
  const prepare = lastOf(harness, "saved-remote-delete-prepare");
  assert.ok(prepare !== undefined);
  assert.deepEqual(harness.commands(), [{
    type: "saved-remote-delete-prepare", pickerId: prepare.pickerId, requestId: prepare.requestId, revision: 0,
    hostId: "A", hostRunId: "run-A", catalogId: "cat-1", resultId: "res-1", entryId: "e-0", renderToken: token,
  }]);
  assert.equal(harness.controller.focus, "form", "a prepare is not a confirmation");
});

test("the remote delete dialog reuses the local text, needs its written frame, and ignores pasted bodies", () => {
  const windowsFile = "C:\\Users\\Me\\.pi\\sessions\\gone.jsonl";
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openSaved(harness);
  void pane(harness);
  chooseHost(harness, 1);
  const list = lastOf(harness, "saved-remote-list");
  assert.ok(list !== undefined);
  harness.controller.completeRemoteSavedWindow(list.requestId, windowFacts(0, 1, 1, {}, () => entry(0, {
    file: windowsFile, caption: "Doomed",
  })));
  settlePicker(harness);
  harness.send(CTRL_D);
  const prepare = lastOf(harness, "saved-remote-delete-prepare");
  assert.ok(prepare !== undefined);
  assert.equal(harness.controller.completeRemoteSavedDeletePrepare(prepare.requestId, true), true);
  assert.equal(harness.controller.focus, "confirm");
  assert.equal(harness.controller.savedDeleteConfirmationActive, true, "the same right-pane placement signal");

  const dialog = text(harness.controller.renderSavedDeleteConfirmation(COLS, 20).lines, COLS, 20);
  assert.ok(dialog.some((line) => line.includes("Delete saved conversation?")));
  assert.ok(dialog.some((line) => line.includes("Conversation: Doomed")));
  assert.ok(dialog.some((line) => line.includes("Host: host-A")), "annotated with the selected owner");
  assert.ok(dialog.some((line) => line.includes(`Saved file: ${windowsFile}`)), "the full owner path, unclipped");
  assert.ok(dialog.some((line) => line.includes("If trash fails, this file is permanently unlinked.")));

  mark(harness);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "an unwritten dialog confirms nothing");
  const confirmToken = harness.controller.savedDeleteConfirmationRenderTokenNumber;
  assert.ok(confirmToken !== undefined);
  assert.equal(harness.controller.settleSavedDeleteConfirmationRender(confirmToken), true);
  harness.send(`${PASTE_START}\r${PASTE_END}`);
  harness.send(PASTE_START);
  harness.send(ENTER);
  harness.send("y");
  harness.send(ESC);
  harness.send(PASTE_END);
  assert.deepEqual(harness.commands(), [], "pasted Enter/y/Escape bodies neither confirm nor cancel");
  assert.equal(harness.controller.focus, "confirm");

  harness.send(ENTER);
  harness.send(ENTER);
  const deletes = harness.commands().filter((action) => action.type === "saved-remote-delete");
  assert.equal(deletes.length, 1, "a confirmed delete is never sent twice");
  const remove = deletes[0] as Extract<SidebarAction, { type: "saved-remote-delete" }>;
  assert.equal(remove.entryId, "e-0");
  assert.equal(remove.renderToken, confirmToken);
  assert.equal(harness.controller.remoteSavedIntentStillCurrent(remove), true);

  // Policy turning Off after submission keeps truthful completion ownership.
  harness.controller.setPeerUiSnapshot(snapshot([host({ id: "A", saved: { supported: true, deleteExposed: false } })], { revision: 3 }));
  assert.equal(harness.controller.focus, "confirm");
  mark(harness);
  assert.equal(harness.controller.completeRemoteSavedDelete(remove.requestId, "Saved conversation moved to trash", true), true);
  assert.equal(harness.controller.focus, "form");
  const relist = lastOf(harness, "saved-remote-list");
  assert.ok(relist !== undefined && relist.requestId !== list.requestId, "a deletion relists the owner catalog");
  assert.ok(pane(harness).some((line) => line.includes("Saved conversation moved to trash")));
});

test("transient owner policy Off preserves an unsubmitted confirmation and leaves Local untouched", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, 1, 1);
  settlePicker(harness);
  harness.send(CTRL_D);
  const prepare = lastOf(harness, "saved-remote-delete-prepare");
  assert.ok(prepare !== undefined);
  harness.controller.completeRemoteSavedDeletePrepare(prepare.requestId, true);
  assert.equal(harness.controller.focus, "confirm");
  mark(harness);
  assert.equal(harness.controller.updateRemoteSavedDeleteExposure("A", "run-A", false), true);
  assert.equal(harness.controller.focus, "confirm", "policy publication alone never discards the confirmation");
  assert.deepEqual(harness.commands(), [], "nothing was sent or cancelled");
  assert.equal(harness.controller.updateRemoteSavedDeleteExposure("A", "run-A", true), true);
  void harness.controller.renderSavedDeleteConfirmation(COLS, 20);
  const token = harness.controller.savedDeleteConfirmationRenderTokenNumber;
  assert.ok(token !== undefined);
  assert.equal(harness.controller.settleSavedDeleteConfirmationRender(token), true);
  harness.send(ENTER);
  assert.equal(lastOf(harness, "saved-remote-delete")?.entryId, "e-0", "the original prepared target can be confirmed");
  const remove = lastOf(harness, "saved-remote-delete");
  assert.ok(remove !== undefined);
  harness.controller.completeRemoteSavedDelete(remove.requestId, "Not deleted", false);
  void pane(harness);

  // Local Saved actions are unaffected by any owner policy.
  mark(harness);
  chooseHost(harness, 1); // A -> Local
  const local = lastOf(harness, "saved-list");
  assert.ok(local !== undefined);
  harness.controller.completeSavedList(local.requestId, [{ id: "l-1", file: "/local/1.jsonl", caption: "local" }], 0);
  void pane(harness);
  harness.send(CTRL_D);
  assert.equal(lastOf(harness, "saved-delete-prepare")?.id, "l-1", "the local delete route is unchanged");
});

test("an outstanding prepare retains its exact target across a policy publication and reply", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, 1, 1);
  settlePicker(harness);
  harness.send(CTRL_D);
  const prepare = lastOf(harness, "saved-remote-delete-prepare");
  assert.ok(prepare !== undefined);
  mark(harness);
  harness.controller.updateRemoteSavedDeleteExposure("A", "run-A", false);
  assert.equal(harness.controller.completeRemoteSavedDeletePrepare(prepare.requestId, true), true);
  assert.equal(harness.controller.focus, "confirm", "the allowed reply is not discarded solely for current exposure");
  assert.deepEqual(harness.commands(), [], "the reply never sends a confirmed Delete");
  harness.controller.updateRemoteSavedDeleteExposure("A", "run-A", true);
  void harness.controller.renderSavedDeleteConfirmation(COLS, 20);
  const token = harness.controller.savedDeleteConfirmationRenderTokenNumber;
  assert.ok(token !== undefined);
  assert.equal(harness.controller.settleSavedDeleteConfirmationRender(token), true);
  harness.send(ENTER);
  assert.equal(lastOf(harness, "saved-remote-delete")?.entryId, prepare.entryId);
});

test("a confirmation attempted while currently Off is refused once, with no automatic reopen on On", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, 1, 1);
  settlePicker(harness);
  harness.send(CTRL_D);
  const prepare = lastOf(harness, "saved-remote-delete-prepare");
  assert.ok(prepare !== undefined);
  harness.controller.completeRemoteSavedDeletePrepare(prepare.requestId, true);
  harness.controller.updateRemoteSavedDeleteExposure("A", "run-A", false);
  void harness.controller.renderSavedDeleteConfirmation(COLS, 20);
  const token = harness.controller.savedDeleteConfirmationRenderTokenNumber;
  assert.ok(token !== undefined);
  assert.equal(harness.controller.settleSavedDeleteConfirmationRender(token), true);
  mark(harness);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "current Off emits no Delete");
  assert.equal(harness.controller.focus, "form");
  assert.ok(flat(pane(harness)).includes(REMOTE_SAVED_DELETE_OFF_NOTICE));
  harness.controller.updateRemoteSavedDeleteExposure("A", "run-A", true);
  assert.equal(harness.controller.focus, "form", "On never reopens the refused attempt");
  assert.deepEqual(harness.commands(), []);
});

// ---------------------------------------------------------------------------
// Main integration helpers: admitted-intent re-proof and silent read retirement
// ---------------------------------------------------------------------------

test("Main's admitted-intent re-proof ignores only per-render tokens and never admits on its own", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, 3, 3);
  settlePicker(harness);
  const drawn = harness.controller.captureSavedPickerPresentation();
  assert.ok(drawn !== undefined);
  const forged = {
    type: "saved-remote-resume" as const, pickerId: drawn.pickerId, requestId: 999_999, revision: drawn.revision,
    hostId: "A", hostRunId: "run-A", catalogId: "cat-1", resultId: "res-1", entryId: "e-0",
    renderToken: drawn.renderToken,
  };
  assert.equal(harness.controller.remoteSavedAdmittedIntentStillOwned(forged), false,
    "with no pending operation nothing is ever admitted by this helper");

  harness.send(ENTER);
  const resume = lastOf(harness, "saved-remote-resume");
  assert.ok(resume !== undefined);
  assert.equal(harness.controller.remoteSavedAdmittedIntentStillOwned(resume), true);
  assert.equal(harness.controller.remoteSavedAdmittedIntentStillOwned({ ...resume, entryId: "e-1" }), false,
    "another opaque entry handle is never the admitted operation");
  // A withdrawn and re-minted frame fails the strict receipt check, but the
  // already-admitted operation still owns exactly the same semantic context.
  harness.controller.invalidateSavedPickerPresentation();
  void pane(harness);
  assert.equal(harness.controller.remoteSavedIntentStillCurrent(resume), false);
  assert.equal(harness.controller.remoteSavedAdmittedIntentStillOwned(resume), true);
  harness.send(DOWN);
  harness.send(UP);
  assert.equal(harness.controller.remoteSavedAdmittedIntentStillOwned(resume), false,
    "a selection A -> B -> A retires the admitted operation for good");

  const del = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(del, 1, 1);
  settlePicker(del);
  del.send(CTRL_D);
  const prepare = lastOf(del, "saved-remote-delete-prepare");
  assert.ok(prepare !== undefined);
  assert.equal(del.controller.remoteSavedAdmittedIntentStillOwned(prepare), true);
  assert.equal(del.controller.completeRemoteSavedDeletePrepare(prepare.requestId, true), true);
  void del.controller.renderSavedDeleteConfirmation(COLS, 20);
  const confirmToken = del.controller.savedDeleteConfirmationRenderTokenNumber;
  assert.ok(confirmToken !== undefined);
  assert.equal(del.controller.settleSavedDeleteConfirmationRender(confirmToken), true);
  del.send(ENTER);
  const remove = lastOf(del, "saved-remote-delete");
  assert.ok(remove !== undefined);
  assert.equal(del.controller.remoteSavedAdmittedIntentStillOwned(remove), true);
  // Every confirmation render re-mints its token: the strict check dies on an
  // identical repaint, the admitted operation does not.
  void del.controller.renderSavedDeleteConfirmation(COLS, 20);
  assert.notEqual(del.controller.savedDeleteConfirmationRenderTokenNumber, confirmToken);
  assert.equal(del.controller.remoteSavedIntentStillCurrent(remove), false);
  assert.equal(del.controller.remoteSavedAdmittedIntentStillOwned(remove), true);
  // The OWNER's current exposure is re-read: Off refuses. On before an actual
  // send permits the same still-owned intent; no transition history is kept.
  del.controller.setPeerUiSnapshot(snapshot([host({ id: "A", saved: { supported: true, deleteExposed: false } })],
    { revision: 2 }));
  assert.equal(del.controller.remoteSavedAdmittedIntentStillOwned(remove), false);
  del.controller.setPeerUiSnapshot(snapshot([host({ id: "A" })], { revision: 3 }));
  assert.equal(del.controller.remoteSavedAdmittedIntentStillOwned(remove), true);
  // A different owner run retires the operation for good, even after it returns.
  del.controller.setPeerUiSnapshot(snapshot([host({ id: "A", roster: { state: "current", rows: [], hostRunId: "run-B" } })],
    { revision: 4 }));
  del.controller.setPeerUiSnapshot(snapshot([host({ id: "A" })], { revision: 5 }));
  assert.equal(del.controller.remoteSavedAdmittedIntentStillOwned(remove), false);
});

test("Main's silent retirement of an unsent read forgets only that request", () => {
  const harness = makeHarness(snapshot([host({ id: "A" })]));
  openRemote(harness, 10_000);
  harness.send(UP); // 0 -> 9999: one window read for the uncached selection
  const read = lastOf(harness, "saved-remote-window");
  assert.ok(read !== undefined);
  const before = pane(harness);
  mark(harness);
  assert.equal(harness.controller.retireUnsentRemoteSavedRead(read.requestId), true);
  assert.deepEqual(harness.commands(), [], "no follow-up read, retry, or other intent is emitted");
  assert.deepEqual(harness.controller.savedRemoteContext()?.pendingReads, []);
  assert.deepEqual(pane(harness), before, "no notice or other visible change");
  assert.equal(harness.controller.retireUnsentRemoteSavedRead(read.requestId), false, "not outstanding: a no-op");
  assert.equal(harness.controller.completeRemoteSavedWindow(read.requestId, windowFacts(9984, 32, 10_000)), false,
    "a retired read can never be applied");

  // The range is not a permanent loading hole: the next coverage pass asks again.
  harness.send(DOWN);
  harness.send(UP);
  const again = lastOf(harness, "saved-remote-window");
  assert.ok(again !== undefined && again.requestId !== read.requestId);
  assert.equal(again.offset, read.offset);
});
