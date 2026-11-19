/**
 * Focused regressions for the New form's default-off "Create missing workspace
 * directory" checkbox (#493 terminal UI slice).
 *
 * The checkbox is a request-specific operator intent: it is OFF at every form
 * opening, drawn directly below the workspace editor for a Host that supports
 * creation (always Local; a remote destination only while its coordinator reports
 * `createWorkspaceSupported`), and kept — visible, clearable, and refused at
 * submit — when a Host change lands on a destination that cannot honor it. A
 * checked box rides the exact written frame that drew it into the local create,
 * the remote Pi create, and the remote native create; an unchecked submission
 * keeps every existing action shape byte for byte.
 *
 * These tests drive the real `SidebarController` with the real pinned native
 * field (or a deterministic budget stand-in where a full-budget field is needed),
 * and settle writer receipts exactly the way Main does.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";

import type { SessionHostFieldRender, SessionHostFieldSubmission } from "../src/session-host/field-editor";
import type { PeerUiHost, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import {
  CREATE_ON_PEER_UNCERTAIN_NOTICE,
  CREATE_ON_PEER_UNWRITTEN_NOTICE,
  CREATE_WORKSPACE_NOT_DRAWN_NOTICE,
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  createWorkspaceUnsupportedNotice,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarFieldFactoryOptions,
  type SidebarFieldFactoryResult,
  type SidebarItem,
  type SidebarNativeCliTarget,
  SidebarController,
} from "../src/session-host/sidebar";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const ENTER = "\r";
const ALT_LEFT = "\x1b[1;3D";
const SHIFT_TAB = "\x1b[Z";
const TAB = "\t";
const DOWN = "\x1b[B";
const SPACE = " ";
const ESCAPE = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const COLS = 48;
const ROWS = 14;
const CHECKBOX_OFF = "  [ ] Create missing workspace directory";
const CHECKBOX_ON = "  [x] Create missing workspace directory";
const CHECKBOX_OFF_FOCUSED = "> [ ] Create missing workspace directory";
const CHECKBOX_ON_FOCUSED = "> [x] Create missing workspace directory";
const CHECKBOX_CAPTION = "Create missing workspace directory";

const TARGETS: readonly SidebarNativeCliTarget[] = [
  { id: "claude", backend: "claude", label: "Claude Code (default)" },
];

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  baseline: number;
  send(data: string): void;
  focusedActions(): SidebarAction[];
}

function makeItem(id: string): SidebarItem {
  return {
    id,
    label: `label-${id}`,
    workspace: `/ws/${id}`,
    agentDir: `/agents/${id}`,
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
  };
}

function makeController(options: SidebarControllerOptions = {}): Harness {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    workspaceBasePath: join(process.cwd(), ".pi-session-host-test-missing-workspace"),
    initialVisible: false,
    ...options,
    onAction: (action: SidebarAction) => actions.push(action),
  });
  const harness: Harness = {
    controller,
    actions,
    baseline: 0,
    send: (data: string) => controller.handleInput(data),
    focusedActions: () => actions.slice(harness.baseline).filter((action) => action.type !== "forward"),
  };
  return harness;
}

/** Open the ordinary New form (the roster's default New row) and draw it once. */
function newForm(options: SidebarControllerOptions = {}): Harness {
  const harness = makeController(options);
  harness.controller.updateItems([makeItem("a")]);
  harness.send(ALT_LEFT);
  void harness.controller.render(40, 20);
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  void paneTexts(harness);
  harness.baseline = harness.actions.length;
  return harness;
}

function paneTexts(harness: Harness, cols = COLS, rows = ROWS): string[] {
  const rendered = harness.controller.render(cols, rows);
  for (const line of rendered.lines) {
    for (const sgr of line.match(SGR_PATTERN) ?? []) {
      assert.ok(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
        `unexpected generated SGR ${JSON.stringify(sgr)} in ${JSON.stringify(line)}`);
    }
    const text = line.replace(SGR_PATTERN, "");
    assert.ok(!text.includes("\x1b"), `raw ESC outside generated SGR: ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(text) <= cols, `rendered row wider than the pane: ${JSON.stringify(line)}`);
  }
  return rendered.lines.map((line) => line.replace(SGR_PATTERN, "").replace(/\s+$/u, ""));
}

function rowOf(texts: readonly string[], predicate: (line: string) => boolean): number {
  return texts.findIndex(predicate);
}

function checkboxRow(texts: readonly string[]): number {
  return rowOf(texts, (line) => line.includes(CHECKBOX_CAPTION));
}

/** The labelled workspace row and the Editor's bottom rule directly below it. */
function workspaceRow(texts: readonly string[]): number {
  return rowOf(texts, (line) => line.startsWith("> Workspace:"));
}

/** Give the currently drawn New form the writer receipt Main would report. */
function settleNewForm(harness: Harness, cols = COLS, rows = ROWS): void {
  void paneTexts(harness, cols, rows);
  const drawn = harness.controller.captureCreateFormPresentation();
  assert.ok(drawn !== undefined, "the drawn New form must be capturable");
  assert.equal(harness.controller.settleCreateFormRender(drawn!.renderToken), true);
}

function showsNotice(texts: readonly string[], fragment: string): boolean {
  return texts.join(" ").replace(/\s+/gu, " ").includes(fragment.slice(0, 30));
}

function peerHost(id: string, label: string, overrides: Partial<PeerUiHost> = {}): PeerUiHost {
  return {
    id, label, host: "10.0.0.5", port: 8443, state: "connected", fingerprint: null,
    message: null, reconnectSuppressed: false, previouslyConnected: true,
    roster: { state: "current", rows: [], hostRunId: "run-a" },
    ...overrides,
  };
}

function peerSnapshot(hosts: readonly PeerUiHost[]): PeerUiSnapshot {
  return {
    revision: 1, status: "ready", settings: null, identityFingerprint: null,
    listener: { state: "off", host: null, port: null, message: null },
    hosts, trustedPeers: [], consents: [], notice: null,
  };
}

/** A connected destination whose owner negotiated workspace creation (#493). */
function creatingHost(id = "lab-a", label = "Lab Alpha", overrides: Partial<PeerUiHost> = {}): PeerUiHost {
  return peerHost(id, label, { createWorkspaceSupported: true, ...overrides });
}

/** Walk Shift+Tab from the workspace editor to the checkbox (Host, then the wrap). */
function focusCheckbox(harness: Harness, providerDrawn = false): void {
  harness.send(SHIFT_TAB); // Provider (when drawn) or Host
  if (providerDrawn) harness.send(SHIFT_TAB); // Host
  harness.send(SHIFT_TAB); // wraps to the bottom of the drawn order: the checkbox
  const texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("> [")), `the checkbox did not take the focus: ${JSON.stringify(texts)}`);
}

/** Select the n-th remote destination on the Host line and return to the editor. */
function chooseRemoteHost(harness: Harness, steps = 1): void {
  harness.send(SHIFT_TAB);
  const texts = paneTexts(harness);
  if (!texts.some((line) => line.startsWith("> Host:"))) harness.send(SHIFT_TAB);
  for (let step = 0; step < steps; step += 1) harness.send(DOWN);
  harness.send(TAB);
  if (paneTexts(harness).some((line) => line.startsWith("> Provider:"))) harness.send(TAB);
  void paneTexts(harness);
}

// ---------------------------------------------------------------------------
// Default off, request specific, drawn directly below the workspace editor.
// ---------------------------------------------------------------------------

test("every New form opens with the checkbox off, drawn directly below the workspace editor", () => {
  const harness = newForm();
  const texts = paneTexts(harness);
  const field = workspaceRow(texts);
  assert.ok(field > 0, JSON.stringify(texts));
  // The real Editor draws its own bottom rule directly below the labelled row; the
  // checkbox is the next row, unfocused and unchecked.
  assert.equal(texts[field + 2], CHECKBOX_OFF, JSON.stringify(texts));
  // The workspace editor — not the checkbox — owns the caret.
  const rendered = harness.controller.render(COLS, ROWS);
  assert.deepEqual(rendered.cursor, { column: 13, row: field });

  // Check it, abandon the form, and reopen: the intent is never remembered.
  focusCheckbox(harness);
  harness.send(SPACE);
  assert.equal(paneTexts(harness)[checkboxRow(paneTexts(harness))], CHECKBOX_ON_FOCUSED);
  harness.send(ESCAPE); // leaves the checkbox for the editor (no cancel)
  assert.equal(harness.controller.focus, "form", "Escape on the checkbox only leaves the control");
  harness.send(ESCAPE); // a fresh Escape in the editor cancels the form
  assert.notEqual(harness.controller.focus, "form");
  void harness.controller.render(40, 20);
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  const reopened = paneTexts(harness);
  assert.equal(reopened[checkboxRow(reopened)], CHECKBOX_OFF, "a reopened New form is off again");
  assert.deepEqual(harness.focusedActions().filter((action) => action.type !== "visibility"), [],
    "toggling and leaving the checkbox emitted nothing");
});

test("an unchecked Local submission keeps the exact existing create action", () => {
  const harness = newForm();
  harness.send("/workspace");
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{ type: "create", requestId: 1, workspace: "/workspace" }],
    "no createWorkspace, formGeneration, or renderToken travels for an unchecked box");
});

// ---------------------------------------------------------------------------
// Keyboard: the ring follows the drawn order; the editor's own keys are intact.
// ---------------------------------------------------------------------------

test("Shift+Tab walks Host then the checkbox, Space toggles it, and nothing reaches the hidden editor", () => {
  const harness = newForm();
  harness.send("/draft");
  harness.send(SHIFT_TAB);
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Host: [ Local ]")));
  harness.send(SHIFT_TAB);
  let texts = paneTexts(harness);
  assert.equal(texts[checkboxRow(texts)], CHECKBOX_OFF_FOCUSED, JSON.stringify(texts));
  // The caret belongs to the drawn control while it owns the focus.
  const cursor = harness.controller.render(COLS, ROWS).cursor;
  assert.equal(cursor?.row, checkboxRow(texts));

  harness.send(SPACE);
  texts = paneTexts(harness);
  assert.equal(texts[checkboxRow(texts)], CHECKBOX_ON_FOCUSED);
  // Typing, a paste, and arrows are consumed by the focused control: the
  // workspace underneath is never edited.
  harness.send("zz");
  harness.send(`${PASTE_START}/pasted${PASTE_END}`);
  harness.send(DOWN);
  texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("> Workspace: /draft") && !line.includes("zz") && !line.includes("pasted")),
    JSON.stringify(texts));
  harness.send(SPACE);
  texts = paneTexts(harness);
  assert.equal(texts[checkboxRow(texts)], CHECKBOX_OFF_FOCUSED, "a second Space clears it");
  harness.send(SPACE);

  // Tab wraps forward to the Host line; Shift+Tab from the checkbox steps back up
  // into the workspace editor drawn directly above it.
  harness.send(TAB);
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Host: [ Local ]")));
  harness.send(SHIFT_TAB); // Host -> checkbox
  harness.send(SHIFT_TAB); // checkbox -> workspace editor
  texts = paneTexts(harness);
  assert.equal(texts.some((line) => line.startsWith("> [") || line.startsWith("> Host:")), false);
  assert.equal(texts[checkboxRow(texts)], CHECKBOX_ON, "leaving the control keeps the checked intent");
  harness.send("/x");
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Workspace: /draft/x")),
    "the editor owns typing again");
  assert.deepEqual(harness.focusedActions(), [], "focus moves and toggles never submit anything");
});

test("with a Provider line the ring is Workspace, Provider, Host, checkbox, Workspace", () => {
  const harness = newForm({ nativeCliTargets: TARGETS });
  harness.send(SHIFT_TAB);
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider:")));
  harness.send(SHIFT_TAB);
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Host:")));
  harness.send(SHIFT_TAB);
  let texts = paneTexts(harness);
  assert.equal(texts[checkboxRow(texts)], CHECKBOX_OFF_FOCUSED, JSON.stringify(texts));
  harness.send(SHIFT_TAB);
  texts = paneTexts(harness);
  assert.equal(texts.some((line) => line.startsWith("> [") || line.startsWith("> Host:")
    || line.startsWith("> Provider:")), false, "the ring returned to the workspace editor");
  // Forward Tab from the Host line still steps to the Provider line, unchanged.
  harness.send(SHIFT_TAB);
  harness.send(SHIFT_TAB);
  harness.send(TAB);
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider:")));
});

// ---------------------------------------------------------------------------
// Local checked submission rides the exact written frame.
// ---------------------------------------------------------------------------

test("a checked Local submission carries createWorkspace only with the written frame that drew it", () => {
  const harness = newForm();
  focusCheckbox(harness);
  harness.send(SPACE);
  harness.send(SHIFT_TAB); // back to the editor
  harness.send("/srv/new");
  // Not yet written: the drawn checked frame has no receipt, so nothing is sent
  // and the request is never quietly sent as an ordinary create.
  void paneTexts(harness);
  harness.send(ENTER);
  let texts = paneTexts(harness);
  assert.deepEqual(harness.focusedActions(), [], "an unwritten checked frame sends nothing");
  assert.ok(showsNotice(texts, CREATE_ON_PEER_UNWRITTEN_NOTICE), JSON.stringify(texts));
  assert.equal(texts[checkboxRow(texts)], CHECKBOX_ON, "the refusal keeps the checked intent");

  settleNewForm(harness);
  const drawn = harness.controller.captureCreateFormPresentation();
  assert.equal(drawn?.hostKind, "local");
  assert.equal(drawn?.createWorkspace, true, "the written frame records the drawn checked box");
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{
    type: "create",
    requestId: 1,
    workspace: "/srv/new",
    createWorkspace: true,
    formGeneration: drawn!.formGeneration,
    renderToken: drawn!.renderToken,
  }]);
  assert.equal(harness.controller.createStillCurrent({
    requestId: 1, formGeneration: drawn!.formGeneration, workspace: "/srv/new", createWorkspace: true,
  }), true, "the pending checked request owns the form");
  assert.equal(harness.controller.createStillCurrent({
    requestId: 1, formGeneration: drawn!.formGeneration, workspace: "/srv/new",
  }), false, "a proof for the other intent never holds");
  texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.includes("Starting (request 1)")), JSON.stringify(texts));
});

test("an unchecked Local form captures no receipt candidate and adds no writer boundary", () => {
  const harness = newForm();
  void paneTexts(harness);
  assert.equal(harness.controller.captureCreateFormPresentation(), undefined);
  focusCheckbox(harness);
  harness.send(SPACE);
  void paneTexts(harness);
  const checked = harness.controller.captureCreateFormPresentation();
  assert.equal(checked?.createWorkspace, true, "checking the box mints a Local candidate");
  harness.send(SPACE);
  void paneTexts(harness);
  assert.equal(harness.controller.captureCreateFormPresentation(), undefined,
    "clearing it returns to the unchanged receipt-free Local path");
});

// ---------------------------------------------------------------------------
// Pointer: only the drawn row, its drawn state, and its drawn geometry.
// ---------------------------------------------------------------------------

test("a press on the drawn checkbox toggles exactly the drawn state; anything else refuses", () => {
  const harness = newForm();
  const texts = paneTexts(harness);
  const row = checkboxRow(texts);
  const shown = harness.controller.captureMousePresentation();
  assert.equal(shown.activateFormCreateWorkspaceAt?.(2, row + 1, COLS, ROWS), false, "another row refuses");
  assert.equal(shown.activateFormCreateWorkspaceAt?.(2, row, COLS - 1, ROWS), false, "another geometry refuses");
  assert.equal(shown.activateFormCreateWorkspaceAt?.(2, row, COLS, ROWS + 1), false);
  assert.equal(shown.activateFormCreateWorkspaceAt?.(2, row, COLS, ROWS), true, "the drawn box toggles");
  assert.equal(paneTexts(harness)[row], CHECKBOX_ON);
  // The same captured presentation drew the box UNCHECKED; replaying it can never
  // flip the opposite of what that frame showed.
  assert.equal(shown.activateFormCreateWorkspaceAt?.(2, row, COLS, ROWS), false,
    "a stale presentation whose drawn state changed refuses");
  assert.equal(shown.activateFormRowAt(2, row, COLS, ROWS), false, "the form-row dispatcher refuses it too");
  // A fresh presentation of the checked frame toggles through the form-row
  // dispatcher Main uses, and a press on the prefix only focuses the control.
  const fresh = harness.controller.captureMousePresentation();
  assert.equal(fresh.activateFormRowAt(2, row, COLS, ROWS), true);
  assert.equal(paneTexts(harness)[row], CHECKBOX_OFF);
  const again = harness.controller.captureMousePresentation();
  assert.equal(again.activateFormRowAt(0, row, COLS, ROWS), true, "a prefix press focuses");
  assert.equal(paneTexts(harness)[row], CHECKBOX_OFF_FOCUSED);
  // The authorization identity changes with the drawn state, so Main needs a new
  // written boundary before a press can act on the toggled row.
  harness.send(SPACE);
  void paneTexts(harness);
  assert.notEqual(harness.controller.captureMousePresentation().authorizationKey, again.authorizationKey);
  assert.deepEqual(harness.focusedActions(), [], "pointer toggles submit nothing");
});

// ---------------------------------------------------------------------------
// Remote: supported owners show it; a Host change keeps the intent.
// ---------------------------------------------------------------------------

test("an unsupported destination shows no checkbox; a supporting one shows it off", () => {
  const harness = newForm();
  harness.controller.setPeerUiSnapshot(peerSnapshot([
    peerHost("lab-a", "Lab Alpha"),
    creatingHost("lab-b", "Lab Beta"),
    peerHost("lab-c", "Lab Gamma", { createWorkspaceSupported: false }),
  ]));
  chooseRemoteHost(harness, 1);
  let texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.includes("Host: [ Lab Alpha ]")), JSON.stringify(texts));
  assert.equal(checkboxRow(texts), -1, "an owner that never reported support (legacy) offers no checkbox");
  harness.send(SHIFT_TAB); // Host
  harness.send(SHIFT_TAB); // no checkbox to wrap to: straight back to the editor
  assert.equal(paneTexts(harness).some((line) => line.startsWith("> ")
    && !line.startsWith("> Workspace:")), false, "the ring never stops on an absent checkbox");

  chooseRemoteHost(harness, 1);
  texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.includes("Host: [ Lab Beta ]")), JSON.stringify(texts));
  assert.equal(texts[checkboxRow(texts)], CHECKBOX_OFF);

  chooseRemoteHost(harness, 1);
  texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.includes("Host: [ Lab Gamma ]")), JSON.stringify(texts));
  assert.equal(checkboxRow(texts), -1, "an owner that reports false offers no checkbox");
});

test("a Host change keeps a checked box: unsupported stays visible, refuses, and is clearable", () => {
  const harness = newForm();
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHost("lab-a", "Lab Alpha")]));
  focusCheckbox(harness);
  harness.send(SPACE); // checked on Local
  harness.send(SHIFT_TAB); // back to the editor
  chooseRemoteHost(harness, 1);
  let texts = paneTexts(harness);
  const row = checkboxRow(texts);
  assert.ok(row > 0, `a checked box was silently dropped by a Host change: ${JSON.stringify(texts)}`);
  // The row itself says why it cannot be honored (clipped to this narrow pane).
  assert.ok(texts[row]!.startsWith(`${CHECKBOX_ON} (uns`), JSON.stringify(texts));
  assert.ok(showsNotice(texts, createWorkspaceUnsupportedNotice("Lab Alpha")), JSON.stringify(texts));

  // Submission refuses, and is never sent without the intent.
  harness.send("/srv/owner/new");
  settleNewForm(harness);
  harness.send(ENTER);
  texts = paneTexts(harness);
  assert.deepEqual(harness.focusedActions(), [], "an unsupported checked box sends nothing");
  assert.ok(showsNotice(texts, createWorkspaceUnsupportedNotice("Lab Alpha")), JSON.stringify(texts));
  assert.ok(texts.some((line) => line.includes("/srv/owner/new")), "the draft survives the refusal");

  // The operator clears it with the drawn control; the row then leaves the screen
  // and takes the keyboard back to the editor, and an ordinary create proceeds.
  focusCheckbox(harness);
  harness.send(SPACE);
  texts = paneTexts(harness);
  assert.equal(checkboxRow(texts), -1, "an unchecked box on a Host that cannot create is not shown");
  assert.equal(showsNotice(texts, createWorkspaceUnsupportedNotice("Lab Alpha")), false,
    "clearing the box clears its notice");
  harness.send("x");
  assert.ok(paneTexts(harness).some((line) => line.includes("/srv/owner/newx")),
    "the released focus belongs to the editor again");
  settleNewForm(harness);
  harness.send(ENTER);
  const actions = harness.focusedActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "create-on-peer");
  assert.equal(Object.hasOwn(actions[0]!, "createWorkspace"), false, "an unchecked remote create keeps its shape");
});

test("checked remote Pi and native submissions carry createWorkspace; unchecked ones never do", () => {
  for (const native of [false, true]) {
    const harness = newForm({ nativeCliTargets: TARGETS });
    const host = creatingHost("lab-a", "Lab Alpha", native
      ? { nativeCli: { supported: true, targets: [{ id: "claude", backend: "claude", label: "Claude (owner)" }] } }
      : {});
    harness.controller.setPeerUiSnapshot(peerSnapshot([host]));
    harness.send(SHIFT_TAB); // Provider
    harness.send(SHIFT_TAB); // Host
    harness.send(DOWN); // -> Lab Alpha
    harness.send(TAB); // Host -> Provider when the owner offers one, else editor
    if (native) {
      assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider:")));
      harness.send(DOWN); // -> the owner's advertised target
      harness.send(TAB);
    }
    harness.send("/srv/owner/new");
    // Unchecked first: the exact existing shapes.
    settleNewForm(harness);
    harness.send(ENTER);
    let actions = harness.focusedActions();
    assert.equal(actions.length, 1, JSON.stringify(actions));
    assert.equal(actions[0]?.type, native ? "create-native-on-peer" : "create-on-peer");
    assert.equal(Object.hasOwn(actions[0]!, "createWorkspace"), false);
    harness.controller.failCreateOnPeer((actions[0] as { requestId: number }).requestId, "refused");
    harness.baseline = harness.actions.length;

    // Checked: the intent rides the written frame that drew it.
    focusCheckbox(harness, native);
    harness.send(SPACE);
    harness.send(SHIFT_TAB);
    settleNewForm(harness);
    const drawn = harness.controller.captureCreateFormPresentation();
    assert.equal(drawn?.createWorkspace, true);
    harness.send(ENTER);
    actions = harness.focusedActions();
    assert.equal(actions.length, 1, JSON.stringify(actions));
    const submitted = actions[0] as Extract<SidebarAction, { type: "create-on-peer" | "create-native-on-peer" }>;
    assert.equal(submitted.type, native ? "create-native-on-peer" : "create-on-peer");
    assert.equal(submitted.createWorkspace, true, `the ${native ? "native" : "Pi"} lane carries the checked intent`);
    assert.equal(submitted.renderToken, drawn!.renderToken);
    const proof = (createWorkspace?: boolean): boolean => harness.controller.createOnPeerStillCurrent({
      requestId: submitted.requestId,
      formGeneration: submitted.formGeneration,
      hostId: submitted.hostId,
      hostRunId: submitted.hostRunId,
      workspace: submitted.workspace,
      ...(createWorkspace === undefined ? {} : { createWorkspace }),
    });
    assert.equal(proof(true), true, "the creating request owns the form");
    assert.equal(proof(), false, "a proof that dropped the intent never holds");
    assert.equal(proof(false), false);
  }
});

test("a written frame that did not draw the checked box never authorizes a creating remote submit", () => {
  const harness = newForm();
  harness.controller.setPeerUiSnapshot(peerSnapshot([creatingHost()]));
  chooseRemoteHost(harness, 1);
  harness.send("/srv/owner/new");
  settleNewForm(harness); // the UNCHECKED frame is written
  focusCheckbox(harness);
  harness.send(SPACE);
  harness.send(SHIFT_TAB);
  // Re-render (a new unwritten token for the checked frame), but do not settle.
  void paneTexts(harness);
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), []);
  assert.ok(showsNotice(paneTexts(harness), CREATE_ON_PEER_UNWRITTEN_NOTICE));
});

// ---------------------------------------------------------------------------
// Capability changes retire receipts; a legitimate identical redraw keeps one.
// ---------------------------------------------------------------------------

test("a support change retires the written receipt even when it returns before any paint", () => {
  const harness = newForm();
  harness.controller.setPeerUiSnapshot(peerSnapshot([creatingHost()]));
  chooseRemoteHost(harness, 1);
  focusCheckbox(harness);
  harness.send(SPACE);
  harness.send(SHIFT_TAB);
  harness.send("/srv/owner/new");
  settleNewForm(harness);
  const written = harness.controller.captureCreateFormPresentation()!;
  // An identical redraw keeps the earned receipt (same token, still current).
  void paneTexts(harness);
  assert.equal(harness.controller.captureCreateFormPresentation()?.renderToken, written.renderToken);
  assert.equal(harness.controller.isCreateFormRenderCurrent(written.renderToken), true);

  // Support disappears and returns with nothing painted in between.
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHost("lab-a", "Lab Alpha")]));
  harness.controller.setPeerUiSnapshot(peerSnapshot([creatingHost()]));
  assert.equal(harness.controller.isCreateFormRenderCurrent(written.renderToken), false,
    "the frame written under the earlier observation is retired");
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [], "nothing is sent from the retired receipt");
  assert.ok(showsNotice(paneTexts(harness), CREATE_ON_PEER_UNWRITTEN_NOTICE));

  // The destination disappearing from the snapshot entirely and returning is the
  // same transition.
  settleNewForm(harness);
  const rewritten = harness.controller.captureCreateFormPresentation()!;
  harness.controller.setPeerUiSnapshot(peerSnapshot([]));
  harness.controller.setPeerUiSnapshot(peerSnapshot([creatingHost()]));
  assert.equal(harness.controller.isCreateFormRenderCurrent(rewritten.renderToken), false);
});

test("a support change fails an in-flight creating request as uncertain; an ordinary one is untouched", () => {
  const harness = newForm();
  harness.controller.setPeerUiSnapshot(peerSnapshot([creatingHost()]));
  chooseRemoteHost(harness, 1);
  harness.send("/srv/owner/plain");
  settleNewForm(harness);
  harness.send(ENTER);
  const ordinary = harness.focusedActions()[0] as Extract<SidebarAction, { type: "create-on-peer" }>;
  assert.equal(ordinary.type, "create-on-peer");
  harness.controller.setPeerUiSnapshot(peerSnapshot([creatingHost("lab-a", "Lab Alpha", { createWorkspaceSupported: false })]));
  assert.equal(harness.controller.createOnPeerStillCurrent(ordinary), true,
    "an ordinary request is not retired by a creation-support change");
  harness.controller.failCreateOnPeer(ordinary.requestId, "refused");
  harness.controller.setPeerUiSnapshot(peerSnapshot([creatingHost()]));
  harness.baseline = harness.actions.length;

  focusCheckbox(harness);
  harness.send(SPACE);
  harness.send(SHIFT_TAB);
  settleNewForm(harness);
  harness.send(ENTER);
  const creating = harness.focusedActions()[0] as Extract<SidebarAction, { type: "create-on-peer" }>;
  assert.equal(creating.createWorkspace, true);
  assert.equal(harness.controller.createOnPeerStillCurrent(creating), true);
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHost("lab-a", "Lab Alpha")]));
  harness.controller.setPeerUiSnapshot(peerSnapshot([creatingHost()]));
  assert.equal(harness.controller.createOnPeerStillCurrent(creating), false,
    "a creating request loses its last-instant proof even if support comes straight back");
  const texts = paneTexts(harness);
  assert.ok(showsNotice(texts, CREATE_ON_PEER_UNCERTAIN_NOTICE), JSON.stringify(texts));
  assert.equal(texts[checkboxRow(texts)], CHECKBOX_ON, "the intent is kept for an explicit retry");
});

// ---------------------------------------------------------------------------
// Tiny layouts: the field budget and footer win; an undrawn box has no authority.
// ---------------------------------------------------------------------------

/** A deterministic field that fills its whole render budget when `full` is set. */
class BudgetField {
  readonly budgets: string[] = [];
  full = false;
  private text: string;
  constructor(initialText: string, private readonly onSubmit: (submission: SessionHostFieldSubmission) => void) {
    this.text = initialText;
  }
  handleInput(data: string): void {
    if (data === ENTER) {
      this.onSubmit({ text: this.text, value: this.text, source: "typed" });
      return;
    }
    if (!data.startsWith("\x1b") && data !== "\t") this.text += data;
  }
  getValue(): string { return this.text; }
  dispose(): void { /* owns nothing */ }
  render(cols: number, rows: number): SessionHostFieldRender {
    this.budgets.push(`${cols}x${rows}`);
    const count = this.full ? Math.max(3, rows) : 3;
    const lines = ["─".repeat(cols), `${this.text}`.padEnd(cols).slice(0, cols)];
    while (lines.length < count - 1) lines.push(" ".repeat(cols));
    lines.push("─".repeat(cols));
    return { lines, cursor: { column: 1, row: 1, visible: true }, contentRow: 1 };
  }
}

function budgetNewForm(): { harness: Harness; field: () => BudgetField } {
  let field: BudgetField | undefined;
  const harness = newForm({
    createTextField: (options: SidebarFieldFactoryOptions): SidebarFieldFactoryResult => {
      field = new BudgetField(options.initialText ?? "", options.onSubmit);
      return { field: field as unknown as SidebarFieldFactoryResult["field"] };
    },
  });
  return { harness, field: () => field! };
}

test("the checkbox never changes the field budget and yields to the status and footer", () => {
  const { harness, field } = budgetNewForm();
  harness.send("/workspace");
  const before = paneTexts(harness, 87, 47);
  assert.equal(before[checkboxRow(before)], CHECKBOX_OFF);
  assert.equal(field().budgets.at(-1), `${87 - 13}x${47 - 4}`, "the pre-checkbox native field budget");
  assert.equal(before.length, 47);
  assert.ok(before.at(-1)!.includes("enter create"));

  // A real status plus a field that fills its whole budget leaves nothing to give:
  // no checkbox row, the status and footer stay, and the budget is unchanged.
  harness.send(ENTER);
  harness.controller.failCreate(1, "workspace could not be opened");
  field().full = true; // the reopened field now fills its budget
  const full = paneTexts(harness, 87, 47);
  assert.equal(checkboxRow(full), -1, `a checkbox was drawn into a full pane: ${JSON.stringify(full)}`);
  assert.ok(full.some((line) => line.includes("! workspace could not be opened")));
  assert.equal(full.length, 47);
  assert.ok(full.at(-1)!.includes("enter create"));
  assert.equal(field().budgets.at(-1), `${87 - 13}x${47 - 4}`);
  const presentation = harness.controller.captureMousePresentation();
  assert.equal(presentation.activateFormCreateWorkspaceAt?.(2, checkboxRow(before), 87, 47), false,
    "no drawn checkbox, no pointer target");
  assert.equal(presentation.activateFormRowAt(2, checkboxRow(before), 87, 47), false);
});

test("losing the checkbox row releases its focus, and a checked undrawn box never submits", () => {
  const { harness, field } = budgetNewForm();
  harness.send("/workspace");
  harness.send(ENTER);
  harness.controller.failCreate(1, "workspace could not be opened"); // a status row now exists
  let texts = paneTexts(harness, 87, 47);
  assert.equal(texts[checkboxRow(texts)], CHECKBOX_OFF, "an ordinary field leaves a filler row for it");
  harness.send(SHIFT_TAB); // Host
  void paneTexts(harness, 87, 47);
  harness.send(SHIFT_TAB); // the checkbox
  void paneTexts(harness, 87, 47);
  harness.send(SPACE);
  texts = paneTexts(harness, 87, 47);
  assert.equal(texts[checkboxRow(texts)], CHECKBOX_ON_FOCUSED);

  // The field now fills its budget: the row is gone, and so is the keyboard
  // ownership it held — in the same render.
  field().full = true;
  texts = paneTexts(harness, 87, 47);
  assert.equal(checkboxRow(texts), -1, `the checkbox survived a full pane: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((line) => line.includes("! workspace could not be opened")), "the status keeps its row");
  harness.send(SPACE); // reaches the editor, never toggles an invisible box
  assert.equal(field().getValue(), "/workspace ", "Space belongs to the workspace editor");
  harness.send(SHIFT_TAB); // editor -> Host
  void paneTexts(harness, 87, 47);
  harness.send(SHIFT_TAB); // Host: no drawn checkbox to wrap to, so back to the editor
  texts = paneTexts(harness, 87, 47);
  assert.equal(texts.some((line) => line.startsWith("> ") && !line.startsWith("> Workspace:")), false,
    `an undrawn checkbox took the focus ring: ${JSON.stringify(texts)}`);

  // The written frame drew no checkbox, so the checked intent cannot ride it, and
  // it is never sent as an ordinary create either.
  const drawn = harness.controller.captureCreateFormPresentation();
  assert.ok(drawn !== undefined, "a checked Local form is captured even when the row is suppressed");
  assert.equal(Object.hasOwn(drawn!, "createWorkspace"), false, "the receipt records no drawn checkbox");
  assert.equal(harness.controller.settleCreateFormRender(drawn!.renderToken), true);
  harness.baseline = harness.actions.length;
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [], "an undrawn checked box never submits, and never as unchecked");
  texts = paneTexts(harness, 87, 47);
  assert.ok(showsNotice(texts, CREATE_WORKSPACE_NOT_DRAWN_NOTICE), JSON.stringify(texts));
});

test("a too-small fallback retires the checked Local receipt and the checkbox focus", () => {
  const harness = newForm();
  focusCheckbox(harness);
  harness.send(SPACE);
  settleNewForm(harness);
  const written = harness.controller.captureCreateFormPresentation()!;
  assert.equal(written.createWorkspace, true);
  void paneTexts(harness, 20, 4); // too small to draw the form at all
  assert.equal(harness.controller.captureCreateFormPresentation(), undefined);
  assert.equal(harness.controller.isCreateFormRenderCurrent(written.renderToken), false);
  harness.send(SPACE); // the hidden checkbox is not toggled by an invisible control
  const texts = paneTexts(harness);
  assert.equal(texts[checkboxRow(texts)], CHECKBOX_ON, "the checked intent is unchanged");
});
