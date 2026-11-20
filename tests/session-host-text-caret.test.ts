/**
 * Session-host sidebar text caret routing (#714).
 *
 * Every sidebar text-entry family — the New form's Workspace, the Edit rename,
 * Host shortcuts, the Network field editors, and the Saved query — places its
 * native caret through the SAME captured, written-frame press route Main
 * already uses for form rows (`SidebarMousePresentation.activateFormRowAt`).
 * These tests drive the real `SidebarController` and the real pinned field
 * components; each accepted press is proven by where the following keystroke
 * lands, and each refusal leaves the next keystroke where it was.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";
import {
  SidebarController,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarItem,
} from "../src/session-host/sidebar";
import type { PeerUiHost, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const ALT_LEFT = "\x1b[1;3D";
const ENTER = "\r";
const ESCAPE = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SHIFT_TAB = "\x1b[Z";
const CTRL_C = "\x03";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const COLS = 60;
const ROWS = 18;

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  send(data: string): void;
}

function makeItem(overrides: Partial<SidebarItem> & { id: string }): SidebarItem {
  return {
    label: `label-${overrides.id}`,
    workspace: `/ws/${overrides.id}`,
    agentDir: `/agents/${overrides.id}`,
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
    ...overrides,
  };
}

function makeHarness(options: SidebarControllerOptions = {}): Harness {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    initialVisible: false,
    workspaceBasePath: join(process.cwd(), ".pi-session-host-test-missing-workspace"),
    ...options,
    onAction: (action) => actions.push(action),
  });
  return { controller, actions, send: (data) => controller.handleInput(data) };
}

function texts(harness: Harness, cols = COLS, rows = ROWS): string[] {
  return harness.controller.render(cols, rows).lines.map((line) => line.replace(SGR_PATTERN, "").replace(/\s+$/u, ""));
}

function rowStarting(lines: readonly string[], prefix: string): number {
  const row = lines.findIndex((line) => line.startsWith(prefix));
  assert.ok(row >= 0, `no row starting ${JSON.stringify(prefix)} in:\n${lines.join("\n")}`);
  return row;
}

/** Press at a text cell of the labelled field row through the written presentation. */
function pressText(harness: Harness, prefix: string, valueColumn: number): boolean {
  const lines = texts(harness);
  const row = rowStarting(lines, prefix);
  const presentation = harness.controller.captureMousePresentation();
  return presentation.activateFormRowAt(visibleWidth(prefix) + valueColumn, row, COLS, ROWS);
}

function rowValue(harness: Harness, prefix: string): string {
  const lines = texts(harness);
  return (lines[rowStarting(lines, prefix)] ?? "").slice(prefix.length);
}

function openNewForm(): Harness {
  const harness = makeHarness();
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.send(ALT_LEFT);
  void harness.controller.render(40, 20);
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  harness.send(CTRL_C); // clear the prefill through the native clear action
  harness.send(`${PASTE_START}/srv/example${PASTE_END}`);
  return harness;
}

const WORKSPACE = "> Workspace: ";

test("New form Workspace: a press after /srv/ then X yields /srv/Xexample", () => {
  const harness = openNewForm();
  assert.equal(rowValue(harness, WORKSPACE), "/srv/example");
  assert.equal(pressText(harness, WORKSPACE, 5), true, "the written field accepted the caret press");
  harness.send("X");
  assert.equal(rowValue(harness, WORKSPACE), "/srv/Xexample");
  harness.send(ENTER);
  const create = harness.actions.find((action) => action.type === "create");
  assert.ok(create !== undefined && "workspace" in create && create.workspace === "/srv/Xexample",
    `the submitted workspace carries the edit: ${JSON.stringify(create)}`);
});

test("a stale or unwritten frame, a resize, and labels/borders never place the caret", () => {
  const harness = openNewForm();
  const lines = texts(harness);
  const row = rowStarting(lines, WORKSPACE);
  const written = harness.controller.captureMousePresentation();
  const x = visibleWidth(WORKSPACE) + 5;

  harness.send("Z"); // typed after the written frame, not yet redrawn
  assert.equal(written.activateFormRowAt(x, row, COLS, ROWS), false, "an undrawn edit refuses the old frame");
  void texts(harness);
  const fresh = harness.controller.captureMousePresentation();
  assert.notEqual(fresh.authorizationKey, written.authorizationKey, "the field frame is part of the authorization");
  assert.equal(written.activateFormRowAt(x, row, COLS, ROWS), false, "the old capture stays refused after a redraw");
  assert.equal(fresh.activateFormRowAt(x, row, COLS + 1, ROWS), false, "geometry the frame did not use");
  assert.equal(fresh.activateFormRowAt(2, row, COLS, ROWS), false, "the label is not editable text");
  assert.equal(fresh.activateFormRowAt(x, row - 1, COLS, ROWS), false, "the Editor's own top border");
  harness.send("Y");
  assert.equal(rowValue(harness, WORKSPACE), "/srv/exampleZY", "no refused press moved the caret");

  assert.equal(pressText(harness, WORKSPACE, 0), true);
  harness.send("<");
  assert.equal(rowValue(harness, WORKSPACE), "</srv/exampleZY");

  void harness.controller.render(COLS, 3); // too small: no form is drawn
  assert.equal(harness.controller.captureMousePresentation().activateFormRowAt(x, row, COLS, 3), false);
});

test("a paste in flight, a pending create, or a closed form refuses; a focused Host line hands focus back on a field press", () => {
  const harness = openNewForm();
  harness.send(`${PASTE_START}ab`);
  assert.equal(pressText(harness, WORKSPACE, 1), false, "no caret move while a paste is assembled");
  harness.send(`cd${PASTE_END}`);
  assert.equal(rowValue(harness, WORKSPACE), "/srv/exampleabcd", "the paste landed at the unmoved caret");

  harness.send(SHIFT_TAB); // the Host line takes the form's focus
  assert.ok(texts(harness).some((line) => line.startsWith("> Host: ")), "the Host line owns the form's focus");
  assert.equal(pressText(harness, WORKSPACE, 1), true, "the drawn Workspace text accepts the press from the Host line");
  assert.ok(texts(harness).some((line) => line.startsWith("  Host: ")), "the press handed the focus to the Workspace");

  const lines = texts(harness);
  const row = rowStarting(lines, WORKSPACE);
  harness.send(ENTER); // local create is now pending
  assert.ok(harness.actions.some((action) => action.type === "create"));
  void texts(harness);
  assert.equal(harness.controller.captureMousePresentation()
    .activateFormRowAt(visibleWidth(WORKSPACE) + 3, row, COLS, ROWS), false, "a pending create refuses");

  const closed = openNewForm();
  void texts(closed);
  const shown = closed.controller.captureMousePresentation();
  const closedRow = rowStarting(texts(closed), WORKSPACE);
  closed.send(ESCAPE);
  assert.notEqual(closed.controller.focus, "form");
  assert.equal(shown.activateFormRowAt(visibleWidth(WORKSPACE) + 3, closedRow, COLS, ROWS), false,
    "a replaced/closed field refuses the captured press");
});

test("Edit rename: a press places the native caret before the typed replacement text", () => {
  const harness = makeHarness();
  const tuple = { sessionId: "session-123", epoch: 7, name: "Observed title" };
  harness.controller.updateItems([makeItem({ id: "a", nativeSession: tuple })]);
  harness.send(ALT_LEFT);
  harness.controller.select("a");
  void harness.controller.render(40, 30);
  assert.equal(harness.controller.openEdit({ id: "a", nativeSession: tuple, currentName: tuple.name }), true);
  const prefix = "> New name: ";
  harness.send(CTRL_C);
  harness.send(`${PASTE_START}Observed title${PASTE_END}`);
  assert.equal(pressText(harness, prefix, 9), true);
  harness.send("X");
  assert.equal(rowValue(harness, prefix), "Observed Xtitle");
});

async function settings(harness: Harness, label: string): Promise<void> {
  for (let step = 0; step < 20; step += 1) {
    const highlighted = texts(harness).find((line) => line.startsWith("> ")) ?? "";
    if (highlighted.includes(label)) {
      harness.send(ENTER);
      return;
    }
    harness.send(DOWN);
  }
  assert.fail(`no ${label} row`);
}

test("Host shortcuts: only the active field's drawn text accepts a caret press", async () => {
  const harness = makeHarness({ settingsAvailable: true });
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.send(ALT_LEFT);
  await settings(harness, "Settings");
  await settings(harness, "Host shortcuts");
  assert.equal(harness.controller.focus, "form");
  const active = "> Toggle (stored): ";
  harness.send(CTRL_C);
  harness.send(`${PASTE_START}alt+left${PASTE_END}`);
  assert.equal(pressText(harness, active, 4), true);
  harness.send("X");
  assert.equal(rowValue(harness, active), "alt+Xleft");
  // The inactive sibling row is display text, never an editor.
  const lines = texts(harness);
  const inactiveRow = rowStarting(lines, "  Return to Main: ");
  assert.equal(harness.controller.captureMousePresentation()
    .activateFormRowAt(visibleWidth("  Return to Main: ") + 1, inactiveRow, COLS, ROWS), false);
});

function peerSnapshot(): PeerUiSnapshot {
  return {
    revision: 1,
    status: "ready",
    settings: {
      hostingEnabled: false,
      bindHost: "127.0.0.1",
      bindPort: 8443,
      autoReconnect: false,
      bellEnabled: true,
      viewerNativeInputEnabled: true,
      remoteHistoryDeleteEnabled: true,
    },
    identityFingerprint: "SHA256:local-identity",
    listener: { state: "off", host: null, port: null, message: null },
    hosts: [],
    trustedPeers: [],
    consents: [],
    notice: null,
  };
}

test("Network listen address: the field editor places the caret and keeps its local draft semantics", () => {
  const harness = makeHarness();
  harness.controller.setPeerUiSnapshot(peerSnapshot());
  harness.send(ALT_LEFT);
  harness.controller.openPeerMenu();
  for (let step = 0; step < 40; step += 1) {
    const highlighted = texts(harness).find((line) => line.startsWith("> ")) ?? "";
    if (highlighted.includes("Listen address:")) break;
    harness.send(DOWN);
  }
  harness.send(ENTER);
  const prefix = "> Listen address: ";
  assert.equal(rowValue(harness, prefix), "127.0.0.1");
  harness.actions.length = 0;
  assert.equal(pressText(harness, prefix, 4), true);
  harness.send("9");
  assert.equal(rowValue(harness, prefix), "127.90.0.1");
  assert.equal(harness.actions.filter((action) => action.type !== "forward").length, 0,
    "a caret press and an edit emit no network command");
});

test("Saved query: the native Input press places the caret; a pending open refuses", () => {
  const harness = makeHarness();
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.send(ALT_LEFT);
  void harness.controller.render(40, 30);
  harness.send(UP);
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  const list = harness.actions.at(-1);
  assert.ok(list !== undefined && list.type === "saved-list");
  for (const character of "/srv/example") harness.send(character);
  const lines = texts(harness);
  const queryRow = rowStarting(lines, "> /srv/example");
  assert.equal(harness.controller.captureMousePresentation().activateFormRowAt(2 + 5, queryRow, COLS, ROWS), true);
  harness.send("X");
  assert.equal(harness.controller.savedQuery, "/srv/Xexample");

  // A press during a bracketed paste is refused.
  harness.send(`${PASTE_START}q`);
  void texts(harness);
  assert.equal(harness.controller.captureMousePresentation().activateFormRowAt(2, queryRow, COLS, ROWS), false);
  harness.send(PASTE_END);

  // A pending open owns the picker: no caret press.
  harness.controller.completeSavedList(list.requestId, [
    { id: "conv-1", file: "/agents/a/sessions/proj/one.jsonl", caption: "/srv/Xexampleq caption" },
  ], 0);
  void texts(harness);
  harness.send(ENTER);
  assert.ok(harness.actions.some((action) => action.type === "saved-open"), "the open is pending");
  void texts(harness);
  const before = harness.controller.savedQuery;
  assert.equal(harness.controller.captureMousePresentation().activateFormRowAt(2, queryRow, COLS, ROWS), false);
  assert.equal(harness.controller.savedQuery, before);
});

/** The New form with a Provider line (one native target) and the create checkbox drawn. */
function openFullNewForm(): Harness {
  const harness = makeHarness({
    nativeCliTargets: [{ id: "claude", backend: "claude", label: "Claude Code (default)" }],
  });
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.send(ALT_LEFT);
  void harness.controller.render(40, 20);
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  harness.send(CTRL_C);
  harness.send(`${PASTE_START}/srv/example${PASTE_END}`);
  return harness;
}

/** The drawn rows that carry the New form's Host/Provider/checkbox choices and focus markers. */
function controlRows(harness: Harness): string[] {
  return texts(harness).filter((line) => /^[> ] (Host: |Provider: |\[[ x]\] )/u.test(line));
}

test("New form: a Workspace text press while Host, Provider, or the checkbox has focus only moves focus and caret", () => {
  const harness = openFullNewForm();
  const unfocused = controlRows(harness);
  assert.equal(unfocused.length, 3, `Host, Provider, and the checkbox are drawn:\n${texts(harness).join("\n")}`);
  assert.ok(unfocused.every((line) => line.startsWith("  ")), "the Workspace starts with the focus");
  const baseline = harness.actions.length;
  const nonForward = (): SidebarAction[] => harness.actions.slice(baseline).filter((action) => action.type !== "forward");

  const focusCases: Array<{ name: string; keys: string[]; marker: RegExp; column: number; insert: string; expected: string }> = [
    // Shift+Tab from the Workspace enters the Provider line drawn above it.
    { name: "Provider", keys: [SHIFT_TAB], marker: /^> Provider: /u, column: 5, insert: "X", expected: "/srv/Xexample" },
    // A second Shift+Tab steps up to the Host line.
    { name: "Host", keys: [SHIFT_TAB, SHIFT_TAB], marker: /^> Host: /u, column: 0, insert: "<", expected: "</srv/Xexample" },
    // The backward wrap from the Host line lands on the checkbox at the bottom.
    { name: "checkbox", keys: [SHIFT_TAB, SHIFT_TAB, SHIFT_TAB], marker: /^> \[ \] /u, column: 14, insert: ">", expected: "</srv/Xexample>" },
  ];
  for (const focusCase of focusCases) {
    for (const key of focusCase.keys) harness.send(key);
    const focused = controlRows(harness);
    assert.ok(focused.some((line) => focusCase.marker.test(line)),
      `${focusCase.name} owns the form's focus:\n${focused.join("\n")}`);
    assert.equal(pressText(harness, WORKSPACE, focusCase.column), true, `${focusCase.name}: the drawn Workspace text accepts the press`);
    // Focus only: every control is drawn unfocused with its exact prior choice.
    assert.deepEqual(controlRows(harness), unfocused, `${focusCase.name}: no Host/Provider/checkbox choice changed`);
    harness.send(focusCase.insert);
    assert.equal(rowValue(harness, WORKSPACE), focusCase.expected, `${focusCase.name}: the next key edits the Workspace at the clicked caret`);
    assert.deepEqual(controlRows(harness), unfocused, `${focusCase.name}: the key went to the Workspace, not to a control`);
  }
  assert.deepEqual(nonForward(), [], "no press emitted a create, host, provider, or checkbox action");

  // The control rows themselves keep their own meaning: a press on a control
  // row's label is still that control's own focus gesture, never a caret.
  const lines = texts(harness);
  const hostRow = lines.findIndex((line) => line.startsWith("  Host: "));
  assert.ok(hostRow >= 0);
  assert.equal(harness.controller.captureMousePresentation().activateFormRowAt(0, hostRow, COLS, ROWS), true);
  assert.ok(controlRows(harness).some((line) => line.startsWith("> Host: ")), "a Host label press still focuses Host");
  harness.send("Z");
  assert.equal(rowValue(harness, WORKSPACE), "</srv/Xexample>", "a focused Host consumes a typed key as before");

  // The ordinary Enter still submits the Workspace with the untouched choices.
  harness.send("\t"); // Host -> Provider
  harness.send("\t"); // Provider -> Workspace
  harness.send(ENTER);
  const create = harness.actions.slice(baseline).find((action) => action.type === "create");
  assert.ok(create !== undefined && "workspace" in create && create.workspace === "</srv/Xexample>",
    `the create carries the clicked edits: ${JSON.stringify(create)}`);
  assert.ok(!("createWorkspace" in create) || create.createWorkspace !== true, "the checkbox stayed unchecked");
});

test("New form: with a focused sibling control, a paste in flight and a stale written frame still refuse", () => {
  const harness = openFullNewForm();
  harness.send(SHIFT_TAB);
  harness.send(SHIFT_TAB); // Host
  const lines = texts(harness);
  const row = rowStarting(lines, WORKSPACE);
  const written = harness.controller.captureMousePresentation();
  harness.send(`${PASTE_START}q`);
  void texts(harness);
  assert.equal(harness.controller.captureMousePresentation()
    .activateFormRowAt(visibleWidth(WORKSPACE) + 1, row, COLS, ROWS), false, "a paste in flight refuses while Host is focused");
  harness.send(PASTE_END);
  assert.ok(controlRows(harness).some((line) => line.startsWith("> Host: ")), "the refused press left Host focused");
  // A capture taken before later redraws is still fenced by the field's own frame.
  harness.send("\t");
  harness.send("\t"); // back to the Workspace
  harness.send("Y");
  assert.equal(written.activateFormRowAt(visibleWidth(WORKSPACE) + 1, row, COLS, ROWS), false, "the old written frame refuses");
});

test("Saved query: a query text press while the Host line has focus returns focus without changing the Host", () => {
  const harness = makeHarness();
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.controller.setPeerUiSnapshot({
    ...peerSnapshot(),
    hosts: [{
      id: "peer-1",
      label: "Peer one",
      host: "192.0.2.1",
      port: 8443,
      state: "connected",
      fingerprint: "SHA256:peer-1",
      message: null,
      reconnectSuppressed: false,
      previouslyConnected: true,
      roster: { state: "current", rows: [], hostRunId: "run-peer-1" },
      saved: { supported: true, deleteExposed: true },
    } as PeerUiHost],
  });
  harness.send(ALT_LEFT);
  void harness.controller.render(40, 30);
  harness.send(UP);
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  for (const character of "/srv/example") harness.send(character);
  let lines = texts(harness);
  assert.ok(lines.some((line) => /^[> ] Host: /u.test(line)), `the Saved picker draws a Host line:\n${lines.join("\n")}`);
  assert.equal(harness.controller.savedPickerHost.kind, "local");
  harness.send(SHIFT_TAB);
  lines = texts(harness);
  const hostBefore = lines.find((line) => line.startsWith("> Host: "));
  assert.ok(hostBefore !== undefined, `the Saved Host line owns focus:\n${lines.join("\n")}`);
  const baseline = harness.actions.length;
  const queryRow = lines.findIndex((line) => line.includes("/srv/example") && !line.includes("Host:"));
  assert.ok(queryRow >= 0);
  const queryStart = lines[queryRow]!.indexOf("/srv/example");
  assert.equal(harness.controller.captureMousePresentation().activateFormRowAt(queryStart + 5, queryRow, COLS, ROWS), true,
    "the drawn query text accepts the press from the Host line");
  lines = texts(harness);
  assert.equal(lines.find((line) => /^[> ] Host: /u.test(line)), `  ${hostBefore.slice(2)}`,
    "the Host choice is unchanged and no longer focused");
  assert.equal(harness.controller.savedPickerHost.kind, "local", "the Host choice was not cycled");
  harness.send("X");
  assert.equal(harness.controller.savedQuery, "/srv/Xexample", "the next key edits the query at the clicked caret");
  assert.deepEqual(harness.actions.slice(baseline).filter((action) => action.type !== "forward"
    && action.type !== "saved-search"), [],
    "no host change, open, delete, or remote request was emitted by the press or the edit");
  assert.ok(!harness.actions.slice(baseline).some((action) => action.type === "saved-remote-dismiss"
    || action.type === "saved-dismiss"), "the Host choice was not cycled");
});
