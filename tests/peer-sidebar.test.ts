/**
 * Pure network-sidebar tests (issue #482).
 *
 * Everything here is a controlled DTO: no coordinator, transport, key store,
 * file, process, bell, or real clock is involved. The tests pin the behavior
 * the parent-owned Main integration relies on — no focus/selection change on
 * arrival, a prominent and persistent consent alert, honest remote metadata
 * that never becomes a local session action, separated commands, latched
 * consent identity/choice/geometry, and an actual-written receipt fence for
 * every decision. They deliberately claim nothing about real network, native
 * Windows UI, or bell readiness: no such surface is exercised.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";
import {
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  SidebarController,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarItem,
} from "../src/session-host/sidebar";
import type { RemoteSessionMetadata } from "../src/session-host/network/roster-metadata";
import type {
  PeerUiConsent,
  PeerUiHost,
  PeerUiSettings,
  PeerUiSnapshot,
  PeerUiTrustedPeer,
} from "../src/session-host/peer-ui-protocol";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";
const KITTY_ENTER_REPEAT = "\x1b[13;1:2u";
const KITTY_ENTER_RELEASE = "\x1b[13;1:3u";
/** Fixed wall-clock origin; the sidebar only ever uses the injected clock. */
const NOW = 1_700_000_000_000;
const WINDOW_MS = 120_000;

const DEFAULT_SETTINGS: PeerUiSettings = {
  hostingEnabled: false,
  bindHost: "127.0.0.1",
  bindPort: 8443,
  autoReconnect: false,
  bellEnabled: true,
};

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

function makeConsent(overrides: Partial<PeerUiConsent> & { id: string }): PeerUiConsent {
  return {
    kind: "incoming",
    label: `peer-${overrides.id}`,
    fingerprint: `SHA256:${overrides.id}`,
    endpoint: "192.0.2.10:51234",
    requestedAt: NOW,
    expiresAt: NOW + WINDOW_MS,
    ...overrides,
  };
}

function makeHost(overrides: Partial<PeerUiHost> & { id: string }): PeerUiHost {
  return {
    label: `host-${overrides.id}`,
    host: "10.0.0.5",
    port: 8443,
    state: "disconnected",
    fingerprint: null,
    message: null,
    reconnectSuppressed: false,
    previouslyConnected: false,
    roster: { state: "never", rows: null },
    ...overrides,
  };
}

function makeTrustedPeer(overrides: Partial<PeerUiTrustedPeer> & { id: string }): PeerUiTrustedPeer {
  return {
    label: `trusted-${overrides.id}`,
    fingerprint: `SHA256:${overrides.id}`,
    hasInboundGrant: true,
    ...overrides,
  };
}

function makeRemoteRow(overrides: Partial<RemoteSessionMetadata> & { id: string }): RemoteSessionMetadata {
  return {
    label: `remote-${overrides.id}`,
    workspace: `/remote/ws/${overrides.id}`,
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession: null,
    backgroundTasks: null,
    backgroundShells: null,
    activeTasks: null,
    activeShells: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<PeerUiSnapshot> = {}): PeerUiSnapshot {
  return {
    revision: 1,
    status: "ready",
    settings: { ...DEFAULT_SETTINGS },
    identityFingerprint: "SHA256:local-identity",
    listener: { state: "off", host: null, port: null, message: null },
    hosts: [],
    trustedPeers: [],
    consents: [],
    notice: null,
    ...overrides,
  };
}

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  baseline: number;
  clock: { value: number };
  send(data: string): void;
  since(): SidebarAction[];
  /** Actions other than raw native forwarding. */
  commands(): SidebarAction[];
}

function makeHarness(snapshot: PeerUiSnapshot | undefined, options: SidebarControllerOptions = {}): Harness {
  const actions: SidebarAction[] = [];
  const clock = { value: NOW };
  const controller = new SidebarController({
    initialVisible: false,
    ...options,
    now: options.now ?? (() => clock.value),
    onAction: (action) => {
      actions.push(action);
      options.onAction?.(action);
    },
  });
  const harness: Harness = {
    controller,
    actions,
    baseline: 0,
    clock,
    send: (data) => controller.handleInput(data),
    since: () => actions.slice(harness.baseline),
    commands: () => actions.slice(harness.baseline).filter((action) => action.type !== "forward"),
  };
  if (snapshot !== undefined) controller.setPeerUiSnapshot(snapshot);
  harness.baseline = actions.length;
  return harness;
}

/** Shows the pane and focuses the sidebar picker (reserved toggle). */
function show(harness: Harness): void {
  if (!harness.controller.visible) harness.send("\x1b[1;3D");
  assert.equal(harness.controller.visible, true);
  assert.equal(harness.controller.focus, "sidebar");
  harness.baseline = harness.actions.length;
}

/** Moves the network-pane highlight to the row whose drawn line contains `text`. */
function focusPeerEntry(harness: Harness, text: string): void {
  for (let step = 0; step < 40; step += 1) {
    const highlighted = peerPaneText(harness).find((line) => line.startsWith("> ")) ?? "";
    if (highlighted.includes(text)) return;
    harness.send(DOWN);
  }
  assert.fail(`network row ${JSON.stringify(text)} could not be focused`);
}

function assertPaneSafe(lines: string[], cols: number, rows?: number): string[] {
  for (const line of lines) {
    for (const sgr of line.match(SGR_PATTERN) ?? []) {
      assert.ok(
        SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
        `unexpected generated SGR ${JSON.stringify(sgr)} in ${JSON.stringify(line)}`,
      );
    }
    const text = line.replace(SGR_PATTERN, "");
    assert.ok(!text.includes("\x1b"), `raw ESC outside generated SGR: ${JSON.stringify(line)}`);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(text), `control byte in ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(text) <= cols, `row wider than pane: ${visibleWidth(text)} > ${cols}`);
  }
  if (rows !== undefined) assert.equal(lines.length, rows, "pane fills the supplied geometry");
  return lines.map((line) => line.replace(SGR_PATTERN, ""));
}

/**
 * Real-native-field alignment proof. The field's own cursor DTO names the pane
 * row that carries the editable content, so the pane must label exactly that
 * row: the value is read from the same row between the label and the native
 * caret, and the caret must stay inside the value's cells on that row. A label
 * beside a border row, a help row, or a label with no content behind it fails.
 */
function assertLabeledInputRow(
  frame: { lines: string[]; cursor?: { column: number; row: number } },
  cols: number,
  rows: number,
  label: string,
  value: string,
): void {
  const lines = assertPaneSafe(frame.lines, cols, rows);
  assert.ok(frame.cursor !== undefined, `${label} editor exposes its actual native input cursor`);
  const cursor = frame.cursor;
  const inputRow = lines[cursor.row] ?? "";
  assert.ok(inputRow.startsWith(label),
    `the label sits beside the editable content row, not a border row: ${JSON.stringify(inputRow)}`);
  assert.equal(inputRow.slice(label.length).trimEnd(), value,
    `the labeled input row carries the field's real value: ${JSON.stringify(inputRow)}`);
  assert.ok(cursor.column >= label.length && cursor.column <= label.length + visibleWidth(value),
    `the native caret stays inside the labeled row's value cells: ${JSON.stringify({ cursor, inputRow })}`);
  assert.equal(lines.filter((line) => line.includes(label.trimEnd())).length, 1,
    `the pane labels ${label.trimEnd()} exactly once, on its editable content row`);
}

function rosterText(harness: Harness, cols = 60, rows = 30): string[] {
  return assertPaneSafe(harness.controller.render(cols, rows).lines, cols, rows);
}

function peerPaneText(harness: Harness, cols = 70, rows = 26): string[] {
  return assertPaneSafe(harness.controller.renderForm(cols, rows).lines, cols, rows);
}

/** The form-pane text with wrapped notice and error lines rejoined. */
function peerPaneFlat(harness: Harness, cols = 70, rows = 26): string {
  return peerPaneText(harness, cols, rows).join(" ");
}

function confirmText(harness: Harness, cols = 60, rows = 22): string[] {
  return assertPaneSafe(harness.controller.render(cols, rows).lines, cols, rows);
}

/** Opens the network pane through the exact public operator entry point. */
function openNetworkPane(harness: Harness): void {
  show(harness);
  harness.controller.openPeerMenu();
  assert.equal(harness.controller.focus, "form");
  peerPaneText(harness);
  harness.baseline = harness.actions.length;
}

/** Moves the network-pane highlight relative to its current row. */
function movePeerRow(harness: Harness, delta: number, rows = 26): void {
  // Every action needs the row drawn by the current complete render.
  peerPaneText(harness, 70, rows);
  const key = delta >= 0 ? DOWN : UP;
  for (let step = 0; step < Math.abs(delta); step += 1) harness.send(key);
  peerPaneText(harness, 70, rows);
}

/**
 * Reviews the oldest pending consent. The multiline alert is a reserved,
 * non-scrolling roster band (notification only), so the operator opens the
 * network pane and activates the pending-request row.
 */
function openConsentFromAlert(harness: Harness): void {
  show(harness);
  assert.ok(rosterText(harness).some((line) => line.includes("Incoming connection request")),
    "the pending alert band is visible in the roster");
  harness.controller.openPeerMenu();
  focusPeerEntry(harness, "approval window");
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "confirm");
  harness.baseline = harness.actions.length;
}

/** Re-opens the oldest pending review after the view was closed. */
function reopenConsentReview(harness: Harness): void {
  openConsentFromAlert(harness);
}

// ---------------------------------------------------------------------------
// Isolation: no snapshot, no network UI
// ---------------------------------------------------------------------------

test("a sidebar without an attached snapshot grows no network entries at all", () => {
  const harness = makeHarness(undefined);
  show(harness);
  const text = rosterText(harness);
  assert.ok(!text.some((line) => line.includes("Network")), "no Network menu without a snapshot");
  assert.ok(!text.some((line) => line.includes("connection request")), "no consent alert without a snapshot");

  // The explicit operator entry point is inert while nothing is attached.
  harness.controller.openPeerMenu();
  assert.equal(harness.controller.focus, "sidebar");
  assert.deepEqual(harness.commands(), []);

  // Legacy navigation is unchanged: New -> Quit host.
  harness.send(DOWN);
  const afterDown = rosterText(harness);
  assert.ok(afterDown.some((line) => line.startsWith("> ") && line.includes("Quit host")),
    "the unchanged Quit host row is still the next entry");
});

test("an attached snapshot adds the Network menu and the alert without stealing focus", () => {
  const harness = makeHarness(makeSnapshot({ consents: [makeConsent({ id: "A" })] }));
  harness.controller.updateItems([makeItem("a")]);
  show(harness);
  harness.controller.setActiveMainOwner("native-a");
  rosterText(harness);
  harness.send(UP); // New -> Saved
  harness.send(UP); // -> the local session row
  rosterText(harness);
  assert.equal(harness.controller.selectedId, "a", "a local row is deliberately highlighted");
  harness.baseline = harness.actions.length;

  harness.controller.setPeerUiSnapshot(makeSnapshot({
    revision: 2,
    consents: [makeConsent({ id: "A" }), makeConsent({ id: "B", requestedAt: NOW + 1 })],
    hosts: [makeHost({ id: "one" })],
    notice: "incoming request pending",
  }));

  assert.equal(harness.controller.visible, true, "arrival never changes visibility");
  assert.equal(harness.controller.focus, "sidebar", "arrival never steals focus");
  assert.equal(harness.controller.selectedId, "a", "arrival never changes the highlighted entry");
  assert.ok(rosterText(harness).some((line) => line.includes("label-a")), "the local row is still rendered");
  assert.equal(harness.controller.activeMainOwnerID, "native-a", "arrival never retargets native content");
  assert.deepEqual(harness.commands(), [], "arrival emits no action at all");

  const text = rosterText(harness);
  assert.ok(text.some((line) => line.includes("Network")), "the menu appears once attached");
  assert.ok(text.some((line) => line.includes("Incoming connection request")), "the alert is rendered");
});

// ---------------------------------------------------------------------------
// Network pane: explicit, honest controls that emit commands only
// ---------------------------------------------------------------------------

test("a known fresh snapshot prefills the approved editable defaults and starts nothing", () => {
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bindHost: "", bindPort: null },
    listener: { state: "off", host: null, port: null, message: null },
  }));
  assert.deepEqual(harness.commands(), [], "attaching a snapshot emits nothing at all");
  openNetworkPane(harness);
  const text = peerPaneText(harness);
  assert.ok(text.some((line) => line.includes("Network")));
  assert.ok(text.some((line) => line.includes("hosting: disabled")), "hosting stays off until enabled");
  assert.ok(text.some((line) => line.includes("listener: off")));
  assert.ok(text.some((line) => line.includes("auto: off")), "Auto reconnect is displayed from the snapshot");
  assert.ok(text.some((line) => line.includes("bell: on")));
  assert.ok(text.some((line) => line.includes("Listen address: * (enter to edit)")),
    "the dual-stack suggestion is prefilled and stays editable");
  assert.ok(text.some((line) => line.includes("Listen port: 8088 (enter to edit)")),
    "the approved port is prefilled instead of leaving the row blank");
  assert.deepEqual(harness.commands(), [], "rendering the prefilled draft emits nothing");

  // Both editors open prefilled with the same local draft text.
  focusPeerEntry(harness, "Listen address:");
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  const addressEditor = harness.controller.renderForm(70, 26);
  assertLabeledInputRow(addressEditor, 70, 26, "> Listen address: ", "*");
  harness.send(ESC);
  focusPeerEntry(harness, "Listen port:");
  harness.send(ENTER);
  const portEditor = harness.controller.renderForm(70, 26);
  assertLabeledInputRow(portEditor, 70, 26, "> Listen port: ", "8088");
  harness.send(ESC);
  assert.deepEqual(harness.commands(), [], "opening and cancelling the prefilled editors emits nothing");
  assert.equal(harness.controller.visible, true);
});

test("the explicit Enable gesture sends the prefilled defaults exactly", () => {
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bindHost: "", bindPort: null },
  }));
  openNetworkPane(harness);

  // The operator can now enable without typing first: the draft is sent as shown.
  harness.send(ENTER); // highlighted row 0 = Hosting
  assert.deepEqual(harness.commands(), [{ type: "peer-listener", enabled: true, host: "*", port: "8088" }],
    "the exact approved dual-stack request is what the unchanged command carries");
  assert.ok(peerPaneFlat(harness).includes("Listen request sent"),
    "the notice reports a request, never a completed bind");
});

test("Apply on a fresh known snapshot keeps the disabled semantics and sends nothing else", () => {
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bindHost: "", bindPort: null },
  }));
  openNetworkPane(harness);
  focusPeerEntry(harness, "Apply listen address/port");
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [{ type: "peer-listener", enabled: false, host: "*", port: "8088" }],
    "Apply still requests the disabled state; it never starts a listener");
  assert.ok(peerPaneFlat(harness).includes("Hosting disable requested"));
});

test("stored address/port and dirty drafts are never replaced by the defaults", () => {
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bindHost: "0.0.0.0", bindPort: 8443 },
  }));
  openNetworkPane(harness);
  const text = peerPaneText(harness);
  assert.ok(text.some((line) => line.includes("Listen address: 0.0.0.0 (enter to edit)")),
    "an explicit IPv4 choice stays shown exactly as stored");
  assert.ok(text.some((line) => line.includes("Listen port: 8443 (enter to edit)")));
  assert.ok(!text.some((line) => line.includes("8088")), "an explicit port is never defaulted");

  // A local edit stays the operator's draft across an unrelated refresh.
  focusPeerEntry(harness, "Listen port:");
  harness.send(ENTER);
  harness.send("\x15"); // clear the retained text, then edit it
  harness.send("9099");
  harness.send(ENTER);
  peerPaneText(harness);
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    revision: 2,
    settings: { ...DEFAULT_SETTINGS, bindHost: "0.0.0.0", bindPort: 8443 },
    notice: "Unrelated metadata update",
  }));
  const refreshed = peerPaneText(harness);
  assert.ok(refreshed.some((line) => line.includes("Listen port: 9099 (enter to edit)")),
    "the unsaved draft survives a snapshot refresh instead of reverting to the default");
  assert.ok(refreshed.some((line) => line.includes("Apply listen address/port (unsaved changes)")));
  harness.baseline = harness.actions.length;

  focusPeerEntry(harness, "Hosting:");
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [{ type: "peer-listener", enabled: true, host: "0.0.0.0", port: "9099" }],
    "the edited IPv4 request is sent exactly as the operator left it");
});

test("a stored port of 0 stays stored and is refused locally instead of defaulted", () => {
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bindHost: "127.0.0.1", bindPort: 0 },
  }));
  openNetworkPane(harness);
  const text = peerPaneText(harness);
  assert.ok(text.some((line) => line.includes("Listen port: 0 (enter to edit)")),
    "a stored 0 is a stored value, never treated as unset and rewritten to the default");
  assert.ok(!text.some((line) => line.includes("8088")));

  harness.send(ENTER); // highlighted row 0 = Hosting
  assert.deepEqual(harness.commands(), [], "an unusable stored port emits no command");
  assert.ok(peerPaneFlat(harness).includes("Listen port must be between 1 and 65535"),
    "the local shape error explains the stored value rather than silently fixing it");
});

test("a stored address that sanitizes away stays empty instead of taking the suggestion", () => {
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bindHost: "\u0007", bindPort: 8443 },
  }));
  openNetworkPane(harness);
  const text = peerPaneText(harness);
  assert.ok(text.some((line) => line.includes("Listen address: (not set)")),
    "an unusable stored address is never replaced by the dual-stack suggestion");
  assert.ok(text.some((line) => line.includes("Listen port: 8443 (enter to edit)")),
    "the usable stored port stays exactly as stored");
  harness.send(ENTER); // highlighted row 0 = Hosting
  assert.deepEqual(harness.commands(), [], "nothing is sent for an address the pane cannot show");
});

test("unknown settings stay unknown: no fresh default is substituted and Enable stays refused", () => {
  const harness = makeHarness(makeSnapshot({ settings: null }));
  openNetworkPane(harness);
  const text = peerPaneText(harness);
  assert.ok(text.some((line) => line.includes("hosting: unknown (settings unavailable)")));
  assert.ok(text.some((line) => line.includes("Listen address: (not set)")),
    "an unavailable document is never filled in with the suggestion");
  assert.ok(text.some((line) => line.includes("Listen port: (not set)")));
  assert.ok(!text.some((line) => line.includes("8088")), "no default is substituted for unknown settings");

  harness.send(ENTER); // highlighted row 0 = Hosting
  assert.deepEqual(harness.commands(), [], "unknown settings cannot enable hosting");
  assert.ok(peerPaneFlat(harness).includes("no hosting change was sent"),
    "the refusal names the unavailable settings document");

  focusPeerEntry(harness, "Listen address:");
  harness.send(ENTER);
  const editorFrame = harness.controller.renderForm(70, 26);
  assert.ok(editorFrame.cursor, "the unavailable-settings editor still exposes its actual input row");
  const editorLines = assertPaneSafe(editorFrame.lines, 70, 26);
  assert.ok(!(editorLines[editorFrame.cursor.row] ?? "").includes("*"),
    "the actual input row, not just the label, has no wildcard while settings are unknown");
  assert.ok(!peerPaneText(harness).some((line) => line.includes("8088")));
  harness.send(ESC);
  assert.deepEqual(harness.commands(), [], "reading the empty editor sends nothing");
});

test("a valid dirty draft is never authority when settings become unavailable", () => {
  // A known fresh snapshot: the operator edits one prefilled field locally.
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bindHost: "", bindPort: null },
  }));
  openNetworkPane(harness);
  focusPeerEntry(harness, "Listen port:");
  harness.send(ENTER);
  harness.send("\x15");
  harness.send("9099");
  harness.send(ENTER);
  peerPaneText(harness);
  harness.baseline = harness.actions.length;

  // The settings document then becomes unavailable. The retained draft stays
  // visible as display text, but it grants no listener authority.
  harness.controller.setPeerUiSnapshot(makeSnapshot({ revision: 2, settings: null }));
  const text = peerPaneText(harness);
  assert.ok(text.some((line) => line.includes("hosting: unknown (settings unavailable)")));
  assert.ok(text.some((line) => line.includes("Listen port: 9099 (enter to edit)")),
    "the unsaved draft is retained instead of being discarded");

  focusPeerEntry(harness, "Hosting:");
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "a retained valid draft authorizes no Enable");
  assert.ok(peerPaneFlat(harness).includes("no hosting change was sent"),
    "the refusal names the unavailable settings document");

  // The disabled Apply gesture is refused by the same availability guard.
  focusPeerEntry(harness, "Apply listen address/port");
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "Apply is refused while settings are unavailable");
  assert.ok(peerPaneFlat(harness).includes("no hosting change was sent"));
});

test("typing both listen fields while settings stay unknown emits no listener command", () => {
  const harness = makeHarness(makeSnapshot({ settings: null }));
  openNetworkPane(harness);

  focusPeerEntry(harness, "Listen address:");
  harness.send(ENTER);
  harness.send("0.0.0.0");
  harness.send(ENTER);
  focusPeerEntry(harness, "Listen port:");
  harness.send(ENTER);
  harness.send("8443");
  harness.send(ENTER);
  const text = peerPaneText(harness);
  assert.ok(text.some((line) => line.includes("Listen address: 0.0.0.0 (enter to edit)")),
    "the local drafts stay editable data");
  assert.ok(text.some((line) => line.includes("Listen port: 8443 (enter to edit)")));
  assert.deepEqual(harness.commands(), [], "filling the fields emits nothing");

  focusPeerEntry(harness, "Hosting:");
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "typed values are not authority while settings are unknown");
  assert.ok(peerPaneFlat(harness).includes("no hosting change was sent"));
});

test("listen copy explains the dual-stack request and an IPv6 endpoint renders as [host]:port", () => {
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, hostingEnabled: true, bindHost: "", bindPort: null },
    listener: { state: "listening", host: "::", port: 8088, message: null },
  }));
  openNetworkPane(harness);
  const pane = peerPaneText(harness);
  assert.ok(pane.some((line) => line.includes("listener: listening on [::]:8088")),
    "a bound IPv6 endpoint is bracketed so it reads unambiguously");
  assert.ok(!pane.some((line) => line.includes(":::")), "the ambiguous :::port form is never rendered");

  // The listen editor explains the request instead of making it look forbidden.
  // Trimming each wrapped line and rejoining reconstructs the copy exactly:
  // wrapping only ever breaks at spaces.
  focusPeerEntry(harness, "Listen address:");
  harness.send(ENTER);
  const flat = peerPaneText(harness).map((line) => line.trim()).join(" ");
  assert.ok(flat.includes("dual-stack"), "the copy explains what * asks for");
  assert.ok(flat.includes("IPv4 and IPv6"), "dual-stack means both families on one handle");
  assert.ok(flat.includes("0.0.0.0") && flat.includes("IPv4 only"), "an explicit IPv4-only request stays available");
  assert.ok(flat.includes("Address and port are separate"), "the two fields stay separate");
  assert.ok(flat.includes("New hosts start with Hosting off"), "the off default is described as an initial state");
  assert.ok(!flat.includes("Hosting stays off until"), "editing an already enabled listener must not claim hosting is off");
  assert.ok(flat.includes("Edits stay local until Apply or Enable"), "editing alone does not change the current listener");
  assert.ok(flat.includes("no other address or port is substituted"), "no silent fallback");
  assert.ok(!/no wildcard/i.test(flat), "the copy never makes the wildcard look forbidden");
  harness.send(ESC);

  // A hostile bound address stays display-safe and the pane still fills its grid.
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    revision: 2,
    settings: { ...DEFAULT_SETTINGS, bindHost: "", bindPort: null },
    listener: { state: "listening", host: "\x1b[31m::\x1b[0m\u0007", port: 8088, message: null },
  }));
  const sanitized = peerPaneText(harness);
  assert.ok(sanitized.some((line) => line.includes("listener: listening on [::]:8088")),
    "sanitizing removes the controls without losing the endpoint");
});

test("explicit address/port, hosting, Auto, and bell controls emit exact commands", () => {
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bindHost: "", bindPort: null },
  }));
  openNetworkPane(harness);

  // Edit the explicit listen address (row 1). The editor opens prefilled with
  // the approved suggestion, so the operator clears it before typing their own.
  movePeerRow(harness, 1);
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  harness.send("\x15");
  harness.send("127.0.0.1");
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  peerPaneText(harness);

  // Edit the explicit listen port (row 2).
  movePeerRow(harness, 1);
  harness.send(ENTER);
  harness.send("\x15");
  harness.send("8443");
  harness.send(ENTER);
  assert.ok(peerPaneText(harness).some((line) => line.includes("Listen port: 8443")));
  assert.deepEqual(harness.commands(), [], "editing drafts emits nothing");

  // Apply the remembered settings while hosting is off (row 3).
  movePeerRow(harness, 1);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [{ type: "peer-listener", enabled: false, host: "127.0.0.1", port: "8443" }]);
  harness.baseline = harness.actions.length;

  // Enable hosting with the explicit endpoint.
  movePeerRow(harness, -3);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [{ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "8443" }]);
  harness.baseline = harness.actions.length;

  // Auto reconnect and bell are independent remembered toggles.
  movePeerRow(harness, 4);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [{ type: "peer-auto-reconnect", enabled: true }]);
  harness.baseline = harness.actions.length;

  movePeerRow(harness, 1);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [{ type: "peer-bell", enabled: false }]);
});

/** Opens the Add-destination field menu through the actual network row. */
function openAddMenu(harness: Harness): void {
  focusPeerEntry(harness, "Add destination");
  harness.send(ENTER);
  const text = peerPaneText(harness);
  assert.ok(text.some((line) => line.includes("Add destination (enter to add)")),
    "the Add destination entry opens its own field menu");
  assert.deepEqual(harness.commands(), [], "opening the menu sends nothing");
  harness.baseline = harness.actions.length;
}

/** Types into the open single-field editor and submits with Enter. */
function submitField(harness: Harness, value: string): void {
  harness.send(value);
  harness.send(ENTER);
  peerPaneText(harness);
}

test("Add destination opens a navigable field menu with one Add action and no wizard", () => {
  const harness = makeHarness(makeSnapshot());
  openNetworkPane(harness);
  focusPeerEntry(harness, "Add destination");
  harness.send(ENTER);
  const text = peerPaneText(harness);
  assert.equal(harness.controller.focus, "form", "the menu stays in the same form-pane route");
  assert.ok(text.some((line) => line.trim() === "Add destination"), "the menu names itself");
  assert.ok(text.some((line) => line.includes("Name: (not set) (enter to edit)")));
  assert.ok(text.some((line) => line.includes("Host: (not set) (enter to edit)")));
  assert.ok(text.some((line) => line.includes("Port: (not set) (enter to edit)")));
  assert.ok(text.some((line) => line.includes("Add destination (enter to add)")));
  assert.ok(!text.some((line) => line.includes("Hosting:")), "the menu replaces the network rows");
  assert.ok(!text.some((line) => line.includes("tab")), "there is no Tab-to-cycle wizard left");
  assert.deepEqual(harness.commands(), [], "opening and reading the menu sends nothing");

  // Up/Down reach every row, in both directions and in any order.
  focusPeerEntry(harness, "Port:");
  harness.send(UP);
  assert.ok((peerPaneText(harness).find((line) => line.startsWith("> ")) ?? "").includes("Host:"));
  harness.send(UP);
  assert.ok((peerPaneText(harness).find((line) => line.startsWith("> ")) ?? "").includes("Name:"));
  harness.send(DOWN);
  harness.send(DOWN);
  harness.send(DOWN);
  assert.ok((peerPaneText(harness).find((line) => line.startsWith("> ")) ?? "").includes("enter to add"));
  assert.deepEqual(harness.commands(), [], "navigating the menu sends nothing");

  // Tab no longer cycles fields: one editor holds exactly one field, and an
  // unsubmitted editor value never reaches the draft.
  focusPeerEntry(harness, "Host:");
  harness.send(ENTER);
  harness.send(TAB);
  harness.send("10.1.2.3");
  const typed = peerPaneText(harness);
  assert.ok(typed.some((line) => line.startsWith("> Host:")), "Tab advanced to no other field");
  assert.ok(peerPaneFlat(harness).includes("10.1.2.3"), "Tab inserted nothing into the value");
  assert.deepEqual(harness.commands(), [], "typing in an editor sends nothing");
  harness.send(ESC);
  assert.ok(peerPaneText(harness).some((line) => line.includes("Host: (not set)")),
    "the abandoned value stays out of the draft");
});

test("each Add field stores only a local draft, in any order, and one Add emits the exact payload", () => {
  const harness = makeHarness(makeSnapshot());
  openNetworkPane(harness);
  openAddMenu(harness);

  // Host is chosen first: the fields are independent, not a fixed sequence.
  focusPeerEntry(harness, "Host:");
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  const editor = peerPaneText(harness);
  assert.ok(editor.some((line) => line.startsWith("> Host:")), "the editor holds exactly the chosen field");
  assert.ok(!editor.some((line) => line.includes("Destination name:"))
    && !editor.some((line) => line.includes("Port:")),
    "the editor renders only the chosen field; its sibling drafts stay on the menu");
  assert.ok(!editor.some((line) => line.includes("tab next field")), "the editor offers no field cycling");
  submitField(harness, "10.1.2.3");
  assert.equal(harness.controller.focus, "form", "a saved field returns to the Add menu");
  let menu = peerPaneText(harness);
  assert.ok(menu.some((line) => line.includes("Host: 10.1.2.3 (enter to edit)")));
  assert.ok(peerPaneFlat(harness).includes("Host updated locally; choose Add destination to request it"));
  assert.deepEqual(harness.commands(), [], "a stored field emits no command");
  harness.baseline = harness.actions.length;

  // Then Port, then the name, then the host again — prefilled and revisited.
  focusPeerEntry(harness, "Port:");
  harness.send(ENTER);
  submitField(harness, "7000");
  menu = peerPaneText(harness);
  assert.ok(menu.some((line) => line.includes("Port: 7000 (enter to edit)")));
  focusPeerEntry(harness, "Name:");
  harness.send(ENTER);
  submitField(harness, "studio");
  menu = peerPaneText(harness);
  assert.ok(menu.some((line) => line.includes("Name: studio (enter to edit)")));
  assert.deepEqual(harness.commands(), [], "three stored fields still emit nothing");

  focusPeerEntry(harness, "Host:");
  harness.send(ENTER);
  const reopened = peerPaneText(harness);
  assert.ok(reopened.some((line) => line.startsWith("> Host:")), "the editor still holds the Host field");
  assert.ok(peerPaneFlat(harness).includes("10.1.2.3"), "the editor opens prefilled with the stored draft");
  harness.send("\x15"); // clear the retained text, then type the corrected host
  submitField(harness, "10.9.9.9");
  menu = peerPaneText(harness);
  assert.ok(menu.some((line) => line.includes("Host: 10.9.9.9 (enter to edit)")));
  assert.deepEqual(harness.commands(), []);
  harness.baseline = harness.actions.length;

  // The single Add action sends the whole draft once, then returns to Network.
  focusPeerEntry(harness, "enter to add");
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [
    { type: "peer-add", label: "studio", host: "10.9.9.9", port: "7000" },
  ]);
  const back = peerPaneText(harness);
  assert.ok(back.some((line) => line.trim() === "Network"), "a successful Add returns to the network pane");
  assert.ok(peerPaneFlat(harness).includes("Destination add requested"));
  assert.ok((back.find((line) => line.startsWith("> ")) ?? "").includes("Add destination"),
    "the network pane still highlights the row the operator came from");
  harness.baseline = harness.actions.length;

  // A sent destination clears the draft for the next visit.
  focusPeerEntry(harness, "Add destination");
  harness.send(ENTER);
  const again = peerPaneText(harness);
  assert.ok(again.some((line) => line.includes("Name: (not set)"))
    && again.some((line) => line.includes("Host: (not set)"))
    && again.some((line) => line.includes("Port: (not set)")), "the sent draft is cleared");
  assert.deepEqual(harness.commands(), []);
});

/** Asserts the Add menu still shows all three stored draft values. */
function assertAddDraftRows(menu: readonly string[]): void {
  assert.ok(menu.some((line) => line.includes("Name: studio-mac (enter to edit)")),
    "the stored name is still on the menu");
  assert.ok(menu.some((line) => line.includes("Host: 10.1.2.3 (enter to edit)")),
    "the stored host is still on the menu");
  assert.ok(menu.some((line) => line.includes("Port: 7000 (enter to edit)")),
    "the stored port is still on the menu");
}

/** Fills a complete, distinct Name/Host/Port draft through the real menu and editors. */
function seedFullAddDraft(harness: Harness): void {
  openNetworkPane(harness);
  openAddMenu(harness);
  focusPeerEntry(harness, "Name:");
  harness.send(ENTER);
  submitField(harness, "studio-mac");
  focusPeerEntry(harness, "Host:");
  harness.send(ENTER);
  submitField(harness, "10.1.2.3");
  focusPeerEntry(harness, "Port:");
  harness.send(ENTER);
  submitField(harness, "7000");
  assert.deepEqual(harness.commands(), [], "seeding three draft values emits nothing");
  harness.baseline = harness.actions.length;
}

const SELECTED_ADD_FIELDS = [
  {
    menuRow: "Name:",
    label: "Destination name",
    value: "studio-mac",
    siblings: [{ label: "Host", value: "10.1.2.3" }, { label: "Port", value: "7000" }],
  },
  {
    menuRow: "Host:",
    label: "Host",
    value: "10.1.2.3",
    siblings: [{ label: "Destination name", value: "studio-mac" }, { label: "Port", value: "7000" }],
  },
  {
    menuRow: "Port:",
    label: "Port",
    value: "7000",
    siblings: [{ label: "Destination name", value: "studio-mac" }, { label: "Host", value: "10.1.2.3" }],
  },
] as const;

for (const selected of SELECTED_ADD_FIELDS) {
  test(`choosing ${selected.label} renders only that Add field and keeps the other drafts on the menu`, () => {
    const harness = makeHarness(makeSnapshot());
    seedFullAddDraft(harness);

    focusPeerEntry(harness, selected.menuRow);
    harness.send(ENTER);
    assert.equal(harness.controller.focus, "form", "the chosen field opened its own editor");
    const frame = harness.controller.renderForm(70, 26);
    assertLabeledInputRow(frame, 70, 26, `> ${selected.label}: `, selected.value);
    const editor = assertPaneSafe(frame.lines, 70, 26);
    for (const sibling of selected.siblings) {
      assert.ok(!editor.some((line) => line.includes(`${sibling.label}:`)),
        `the unselected ${sibling.label} field renders no read-only row in this editor`);
      assert.ok(!editor.join(" ").includes(sibling.value),
        `the unselected ${sibling.label} draft value stays out of this editor`);
    }
    assert.deepEqual(harness.commands(), [], "opening and reading one Add editor sends nothing");

    // Escape closes the editor and the menu still carries all three drafts.
    harness.send(ESC);
    assert.ok(peerPaneText(harness).some((line) => line.includes("Add destination (enter to add)")),
      "Escape returns from the editor to the Add menu");
    assertAddDraftRows(peerPaneText(harness));
    assert.deepEqual(harness.commands(), [], "Escape from an Add editor emits nothing");

    // Enter saves the unchanged value, returns the same way, and still emits nothing.
    focusPeerEntry(harness, selected.menuRow);
    harness.send(ENTER);
    harness.send(ENTER);
    assert.equal(harness.controller.focus, "form", "Enter returns from the editor to the Add menu");
    assert.ok(peerPaneText(harness).some((line) => line.includes("Add destination (enter to add)")),
      "Enter on an unchanged field lands on the menu, not on another field");
    assertAddDraftRows(peerPaneText(harness));
    assert.deepEqual(harness.commands(), [], "a saved field emits no command");

    // The single unchanged Add action still sends the whole draft exactly once.
    focusPeerEntry(harness, "enter to add");
    harness.send(ENTER);
    assert.deepEqual(harness.commands(), [
      { type: "peer-add", label: "studio-mac", host: "10.1.2.3", port: "7000" },
    ], "the final Add payload is unchanged by selected-only rendering");
  });
}

test("Escape abandons only the current Add edit and Escape in the menu adds nothing", () => {
  const harness = makeHarness(makeSnapshot());
  openNetworkPane(harness);
  openAddMenu(harness);

  focusPeerEntry(harness, "Host:");
  harness.send(ENTER);
  submitField(harness, "10.1.2.3");
  assert.deepEqual(harness.commands(), []);

  // Reopen the host field, type over it, and cancel that one edit.
  focusPeerEntry(harness, "Host:");
  harness.send(ENTER);
  harness.send("\x15");
  harness.send("typo-host");
  harness.send(ESC);
  assert.equal(harness.controller.focus, "form");
  const menu = peerPaneText(harness);
  assert.ok(menu.some((line) => line.includes("Add destination (enter to add)")),
    "Escape returns from the editor to the Add menu");
  assert.ok(menu.some((line) => line.includes("Host: 10.1.2.3 (enter to edit)")),
    "the abandoned edit left the previously stored draft value alone");
  assert.deepEqual(harness.commands(), [], "an abandoned edit emits nothing");

  // Escape in the menu returns to the network pane without adding.
  harness.send(ESC);
  const network = peerPaneText(harness);
  assert.ok(network.some((line) => line.trim() === "Network"));
  assert.ok(network.some((line) => line.includes("Hosting:")), "the network rows are back");
  assert.deepEqual(harness.commands(), [], "leaving the menu sends nothing");
  harness.baseline = harness.actions.length;

  // The half-edited draft is still there for a later visit.
  focusPeerEntry(harness, "Add destination");
  harness.send(ENTER);
  assert.ok(peerPaneText(harness).some((line) => line.includes("Host: 10.1.2.3 (enter to edit)")),
    "leaving the menu keeps the local draft, exactly as the listen drafts persist");
});

test("Add refuses an incomplete or invalid draft with the fixed local error and sends nothing", () => {
  const harness = makeHarness(makeSnapshot());
  openNetworkPane(harness);
  openAddMenu(harness);

  // Nothing typed yet: the name is missing first, exactly as before.
  focusPeerEntry(harness, "enter to add");
  harness.send(ENTER);
  assert.ok(peerPaneFlat(harness).includes("A destination name is required"));
  assert.deepEqual(harness.commands(), []);

  // A name alone cannot be sent.
  focusPeerEntry(harness, "Name:");
  harness.send(ENTER);
  submitField(harness, "studio");
  focusPeerEntry(harness, "enter to add");
  harness.send(ENTER);
  assert.ok(peerPaneFlat(harness)
    .includes("Destination host is required (no default is chosen for you)"));
  assert.deepEqual(harness.commands(), []);

  // An unusable host keeps the editor open with its fixed message and is
  // never stored in the draft.
  focusPeerEntry(harness, "Host:");
  harness.send(ENTER);
  harness.send("10.1.2. 3");
  harness.send(ENTER);
  assert.ok(peerPaneFlat(harness).includes("Destination host cannot contain whitespace"));
  assert.equal(harness.controller.focus, "form", "an invalid field stays in its editor");
  harness.send(ESC);
  assert.ok(peerPaneText(harness).some((line) => line.includes("Host: (not set)")),
    "a rejected value never reaches the draft");
  assert.deepEqual(harness.commands(), []);

  // A valid host with no port still cannot be added: no partial destination.
  focusPeerEntry(harness, "Host:");
  harness.send(ENTER);
  submitField(harness, "10.1.2.3");
  focusPeerEntry(harness, "enter to add");
  harness.send(ENTER);
  assert.ok(peerPaneFlat(harness)
    .includes("Port is required (no default port is chosen for you)"));
  assert.deepEqual(harness.commands(), []);

  // An out-of-range port is refused in its editor and stays unset.
  focusPeerEntry(harness, "Port:");
  harness.send(ENTER);
  harness.send("0");
  harness.send(ENTER);
  assert.ok(peerPaneFlat(harness).includes("Port must be between 1 and 65535"));
  harness.send(ESC);
  focusPeerEntry(harness, "enter to add");
  harness.send(ENTER);
  assert.ok(peerPaneFlat(harness).includes("Port is required"));
  assert.deepEqual(harness.commands(), [], "an out-of-range port was never stored or sent");

  // Completing the draft emits exactly one command with the stored values.
  focusPeerEntry(harness, "Port:");
  harness.send(ENTER);
  submitField(harness, "7000");
  harness.baseline = harness.actions.length;
  focusPeerEntry(harness, "enter to add");
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [
    { type: "peer-add", label: "studio", host: "10.1.2.3", port: "7000" },
  ]);
});

test("the Add menu is a distinct pointer target and returns to the same network row", () => {
  const harness = makeHarness(makeSnapshot());
  show(harness);
  rosterText(harness);
  harness.controller.openPeerMenu();
  peerPaneText(harness);
  const networkKey = harness.controller.captureMousePresentation().authorizationKey;

  openAddMenu(harness);
  assert.notEqual(harness.controller.captureMousePresentation().authorizationKey, networkKey,
    "the Add menu is its own drawn target mapping");

  harness.send(ESC);
  peerPaneText(harness);
  assert.equal(harness.controller.captureMousePresentation().authorizationKey, networkKey,
    "returning restores the exact network target mapping");
  assert.ok((peerPaneText(harness).find((line) => line.startsWith("> ")) ?? "").includes("Add destination"),
    "the stable network selection is where the operator left it");
});

test("an arrival while the Add menu or its field editor is open keeps alert, focus, and ownership", () => {
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bellEnabled: false },
  }));
  openNetworkPane(harness);
  harness.controller.setActiveMainOwner("native-a");
  openAddMenu(harness);
  const selection = harness.controller.selectedId;
  harness.baseline = harness.actions.length;

  // A muted request arrives while the menu is open.
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bellEnabled: false },
    consents: [makeConsent({ id: "A", label: "studio" })],
  }));
  const band = assertPaneSafe(harness.controller.renderPeerAlert(60, 6).lines, 60, 6).join("\n");
  assert.ok(band.includes("Incoming connection request"), "the alert band still renders with the menu open");
  const menu = peerPaneText(harness);
  assert.ok(menu.some((line) => line.includes("Add destination (enter to add)")),
    "the open menu survives the arrival");
  assert.equal(harness.controller.focus, "form", "arrival never takes focus from the open menu");
  assert.equal(harness.controller.selectedId, selection, "arrival never changes the roster selection");
  assert.equal(harness.controller.activeMainOwnerID, "native-a", "arrival never changes the native owner");
  assert.equal(harness.controller.capturePeerConsentPresentation(), undefined,
    "the menu grants no approval authority");
  assert.deepEqual(harness.commands(), [], "an arrival emits nothing from the menu");

  // And while one field editor is open.
  focusPeerEntry(harness, "Host:");
  harness.send(ENTER);
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bellEnabled: false },
    consents: [makeConsent({ id: "A", label: "studio" }), makeConsent({ id: "B", label: "laptop" })],
  }));
  const editor = peerPaneText(harness);
  assert.ok(editor.some((line) => line.startsWith("> Host:")), "the open editor survives the arrival");
  assert.equal(harness.controller.focus, "form", "arrival never takes focus from the open editor");
  assert.equal(harness.controller.selectedId, selection);
  assert.equal(harness.controller.activeMainOwnerID, "native-a");
  assert.equal(harness.controller.capturePeerConsentPresentation(), undefined);
  harness.send(ESC);
  harness.send(ESC);
  const network = peerPaneText(harness);
  assert.ok(network.some((line) => line.includes("approval window")),
    "the still-pending request stays reviewable from the network pane");
  assert.deepEqual(harness.commands(), [], "nothing was approved, denied, or added on the way out");
});

test("per-host connect, disconnect, remove-confirmation and revoke-confirmation emit commands", () => {
  const host = makeHost({
    id: "studio",
    label: "studio",
    state: "connected",
    fingerprint: "SHA256:studio",
    previouslyConnected: true,
    roster: { state: "current", rows: [makeRemoteRow({ id: "r1" })] },
  });
  const harness = makeHarness(makeSnapshot({
    hosts: [host],
    trustedPeers: [makeTrustedPeer({ id: "p1", label: "laptop" })],
  }));
  openNetworkPane(harness);

  // The host row follows the 7 fixed control rows.
  movePeerRow(harness, 7);
  harness.send("x");
  assert.deepEqual(harness.commands(), [{ type: "peer-disconnect", hostId: "studio" }]);
  harness.baseline = harness.actions.length;

  harness.send("c");
  assert.ok(
    harness.commands().length === 0,
    "an already-connected destination is not asked to connect again",
  );
  harness.baseline = harness.actions.length;

  // Remove requires a fully drawn, frozen confirmation.
  harness.send("r");
  assert.equal(harness.controller.focus, "confirm");
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "no remove without a complete confirmation frame");
  const removeView = confirmText(harness);
  assert.ok(removeView.some((line) => line.includes("Remove destination?")));
  assert.ok(removeView.some((line) => line.includes("studio")));
  assert.ok(removeView.some((line) => line.includes("receiving grant")), "removal does not claim a grant revoke");
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [{ type: "peer-remove", hostId: "studio" }]);
  assert.equal(harness.controller.focus, "form", "the pane returns after the request");

  // Receiving revocation is independent and separately confirmed.
  harness.baseline = harness.actions.length;
  peerPaneText(harness);
  // Rows: 7 controls, host, remote row, then the trusted peer.
  movePeerRow(harness, 2);
  harness.send("v");
  assert.equal(harness.controller.focus, "confirm");
  const revokeView = confirmText(harness);
  assert.ok(revokeView.some((line) => line.includes("Revoke receiving permission?")));
  assert.ok(revokeView.some((line) => line.includes("No session is stopped")));
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [{ type: "peer-revoke", peerId: "p1" }]);
});

// ---------------------------------------------------------------------------
// Remote rows: separate typed metadata, never a local session action
// ---------------------------------------------------------------------------

test("remote host rows stay honest metadata and never emit a local session action", () => {
  const current = makeHost({
    id: "current",
    label: "studio",
    state: "connected",
    fingerprint: "SHA256:studio",
    previouslyConnected: true,
    roster: {
      state: "current",
      rows: [
        makeRemoteRow({ id: "r1", label: "build", workspace: "/owner/work/build" }),
        makeRemoteRow({ id: "r2", label: "done", lifecycle: "exited", hasLiveProcess: false, exitCode: 0 }),
      ],
    },
  });
  const stale = makeHost({
    id: "stale",
    label: "laptop",
    state: "retrying",
    reconnectSuppressed: true,
    previouslyConnected: true,
    roster: { state: "stale", rows: [makeRemoteRow({ id: "old", label: "old-row" })] },
  });
  const never = makeHost({ id: "never", label: "spare" });
  const harness = makeHarness(makeSnapshot({ hosts: [current, stale, never] }));
  openNetworkPane(harness);
  const text = peerPaneText(harness, 140, 40).join("\n");
  assert.ok(text.includes("roster current (2)"));
  assert.ok(text.includes("roster stale (1 last seen)") && text.includes("auto retry suppressed until Connect"));
  assert.ok(text.includes("roster never observed"), "never-observed rosters are stated, never empty");
  assert.ok(text.includes("build | agent unknown"));
  assert.ok(text.includes("background unknown"), "unknown counts are never zero");
  assert.ok(text.includes("input unknown"));
  assert.ok(text.includes("/owner/work/build"), "the exact owner workspace stays display-only data");
  assert.ok(text.includes("old-row [stale]"), "stale rows are marked");

  // Selecting and Entering a remote row shows a metadata-only notice and
  // changes nothing else.
  const focusBefore = harness.controller.focus;
  const selectedBefore = harness.controller.selectedId;
  movePeerRow(harness, 8, 40); // host, then the first remote row
  harness.send(ENTER);
  const after = peerPaneText(harness, 140, 40).join("\n");
  assert.ok(after.includes("Remote session metadata only"));
  assert.equal(harness.controller.focus, focusBefore);
  assert.equal(harness.controller.selectedId, selectedBefore);
  const localActions = harness.commands().filter((action) =>
    action.type === "select" || action.type === "resume-row" || action.type === "remove"
    || action.type === "stop-remove" || action.type === "edit" || action.type === "create"
    || action.type === "rename");
  assert.deepEqual(localActions, [], "no local session action is fabricated for a remote row");

  // The SAME attached DTO also projects those rows into the LEFT roster as a
  // separate typed kind; the Network pane's metadata-only behavior above is
  // unchanged, and the local action filter still finds nothing there either.
  harness.send(ESC);
  const left = rosterText(harness, 140, 40).join("\n");
  assert.ok(left.includes("build") && left.includes("/owner/work/build"),
    "the left roster projects the same remote rows alongside locals");
  assert.ok(left.includes("old-row") && left.includes("[stale]"),
    "stale remote cards are marked in the left roster too");
  assert.deepEqual(harness.commands(), [], "projecting the left cards emits nothing");
});

// ---------------------------------------------------------------------------
// Prominent, persistent consent alert
// ---------------------------------------------------------------------------

test("the incoming consent alert is prominent, multiline, and survives a muted bell", () => {
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bellEnabled: false },
    consents: [makeConsent({ id: "A", label: "studio", fingerprint: "SHA256:studio" })],
  }));
  show(harness);
  const text = rosterText(harness, 64, 30);
  const start = text.findIndex((line) => line.includes("Incoming connection request"));
  assert.ok(start >= 0, "the alert is visible in the roster");
  const block = text.slice(start, start + 6);
  assert.ok(block.join(" ").includes("studio"), "the request label is shown");
  assert.ok(block.join(" ").includes("SHA256:studio"), "the key fingerprint is shown");
  assert.ok(block.join(" ").includes("192.0.2.10:51234"), "the origin endpoint is shown");
  assert.ok(block.join(" ").includes("120s"), "the human approval window is shown");
  assert.ok(block.filter((line) => line.trim().length > 0).length >= 6, "the alert is multiline, not a tiny badge");
  assert.ok(block.join(" ").includes("review"), "the band points at the operator-opened review path");
  assert.deepEqual(harness.commands(), [], "an arriving alert approves nothing");
  assert.equal(harness.controller.focus, "sidebar");
});

// ---------------------------------------------------------------------------
// Consent dialog: latch, geometry, and the actual-written receipt
// ---------------------------------------------------------------------------

test("consent approves only after the exact rendered frame is written", () => {
  const harness = makeHarness(makeSnapshot({
    consents: [makeConsent({ id: "A", label: "studio", fingerprint: "SHA256:studio" })],
  }));
  openConsentFromAlert(harness);
  const view = confirmText(harness);
  const joined = view.join("\n");
  assert.ok(joined.includes("Approve incoming connection?"));
  assert.ok(joined.includes("name: studio"));
  assert.ok(joined.includes("key: SHA256:studio"));
  assert.ok(joined.includes("from: 192.0.2.10:51234"));
  assert.ok(joined.includes("120s remaining"));
  assert.ok(joined.includes("Approve") && joined.includes("Deny"));

  const presentation = harness.controller.capturePeerConsentPresentation();
  assert.ok(presentation !== undefined, "a complete frame produces a candidate presentation");
  assert.equal(presentation?.consentId, "A");

  // Deny (the safe default) is refused until Main reports the writer receipt.
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), []);
  assert.ok(confirmText(harness).join(" ").includes("No written receipt"));
  // That refusal notice moved the decision controls, so the refused frame is
  // superseded: only the newly rendered frame can be settled.
  assert.equal(harness.controller.isPeerConsentRenderCurrent(presentation!.renderToken), false);
  const current = harness.controller.capturePeerConsentPresentation();
  assert.ok(current !== undefined);
  assert.notEqual(current.renderToken, presentation!.renderToken);
  assert.equal(harness.controller.settlePeerConsentRender(current.renderToken + 1), false,
    "a token that is not the current frame can never settle");
  assert.equal(harness.controller.settlePeerConsentRender(current.renderToken), true);

  harness.send(ENTER);
  const decisions = harness.commands().filter((action) => action.type === "peer-consent");
  assert.deepEqual(decisions, [{
    type: "peer-consent",
    consentId: "A",
    decision: "deny",
    renderToken: current.renderToken,
  }]);
  assert.equal(harness.controller.focus, "sidebar", "the dialog closes after the one decision");

  // Held repeats/releases of the decision key emit nothing further.
  harness.send(KITTY_ENTER_REPEAT);
  harness.send(KITTY_ENTER_RELEASE);
  harness.send(KITTY_ENTER_RELEASE);
  harness.send(ENTER);
  assert.equal(harness.commands().filter((action) => action.type === "peer-consent").length, 1);
});

test("changing the decision or the geometry revokes the written frame until it is written again", () => {
  const harness = makeHarness(makeSnapshot({ consents: [makeConsent({ id: "A" })] }));
  openConsentFromAlert(harness);
  confirmText(harness);
  const first = harness.controller.capturePeerConsentPresentation();
  assert.ok(first !== undefined);
  assert.equal(harness.controller.settlePeerConsentRender(first.renderToken), true);

  // Selecting the other semantic target invalidates the proof.
  harness.send("y");
  assert.equal(harness.controller.capturePeerConsentPresentation(), undefined);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "the old receipt never authorizes the new decision");

  const second = confirmText(harness);
  assert.ok(second.join(" ").includes("120s remaining"));
  const approve = harness.controller.capturePeerConsentPresentation();
  assert.ok(approve !== undefined && approve.renderToken !== first.renderToken,
    "the new decision target gets its own frame token");
  assert.equal(harness.controller.settlePeerConsentRender(first.renderToken), false);
  assert.equal(harness.controller.settlePeerConsentRender(approve.renderToken), true);

  // A geometry change also invalidates the proof.
  const wider = assertPaneSafe(harness.controller.render(70, 24).lines, 70, 24);
  assert.ok(wider.join(" ").includes("Trust") || wider.join(" ").includes("Approve incoming"));
  const resized = harness.controller.capturePeerConsentPresentation();
  assert.ok(resized !== undefined && resized.renderToken !== approve.renderToken,
    "a resized dialog is a different frame");
  assert.equal(harness.controller.settlePeerConsentRender(approve.renderToken), false);
  assert.equal(harness.controller.settlePeerConsentRender(resized.renderToken), true);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [{
    type: "peer-consent",
    consentId: "A",
    decision: "approve",
    renderToken: resized.renderToken,
  }]);
});

test("a too-small frame, a closed view, or an expired window authorizes nothing", () => {
  const harness = makeHarness(makeSnapshot({ consents: [makeConsent({ id: "A" })] }));
  openConsentFromAlert(harness);
  confirmText(harness);
  const settled = harness.controller.capturePeerConsentPresentation();
  assert.ok(settled !== undefined);
  assert.equal(harness.controller.settlePeerConsentRender(settled.renderToken), true);

  const tiny = assertPaneSafe(harness.controller.render(18, 4).lines, 18, 4);
  assert.ok(tiny.join(" ").includes("too small"), "an unshowable dialog degrades honestly");
  assert.equal(harness.controller.capturePeerConsentPresentation(), undefined);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "a too-small frame never approves");
  confirmText(harness);
  assert.equal(harness.controller.settlePeerConsentRender(settled.renderToken), false,
    "the superseded token stays unauthorized");

  // Escape closes the view without inventing a decision; the request stays
  // pending and the persistent alert keeps showing it.
  harness.send(ESC);
  assert.deepEqual(harness.commands(), []);
  assert.equal(harness.controller.focus, "sidebar");
  assert.ok(rosterText(harness).some((line) => line.includes("Incoming connection request")));

  // Expiry ends the window: no presentation, no decision.
  openConsentFromAlert(harness);
  confirmText(harness);
  const beforeExpiry = harness.controller.capturePeerConsentPresentation();
  assert.ok(beforeExpiry !== undefined);
  assert.equal(harness.controller.settlePeerConsentRender(beforeExpiry.renderToken), true);
  harness.clock.value = NOW + WINDOW_MS;
  assert.equal(harness.controller.isPeerConsentRenderCurrent(beforeExpiry.renderToken), false);
  const expiredView = confirmText(harness);
  assert.ok(expiredView.join(" ").includes("approval window: ended"));
  assert.equal(harness.controller.capturePeerConsentPresentation(), undefined);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), []);
});

test("request A is latched: a later request B never retargets it, and unrelated metadata keeps the proof", () => {
  const consentA = makeConsent({ id: "A", label: "alpha", fingerprint: "SHA256:alpha" });
  const consentB = makeConsent({ id: "B", label: "beta", fingerprint: "SHA256:beta", requestedAt: NOW + 1 });
  const harness = makeHarness(makeSnapshot({ consents: [consentA, consentB] }));
  openConsentFromAlert(harness);
  const view = confirmText(harness).join("\n");
  assert.ok(view.includes("name: alpha"), "the oldest request is reviewed");

  const settled = harness.controller.capturePeerConsentPresentation();
  assert.ok(settled !== undefined);
  assert.equal(harness.controller.settlePeerConsentRender(settled.renderToken), true);

  // Unrelated metadata (revision, notice, hosts) must not revoke a proven,
  // unchanged frame.
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    revision: 9,
    consents: [consentA, consentB],
    hosts: [makeHost({ id: "new-host" })],
    notice: "unrelated status text",
  }));
  const afterMetadata = harness.controller.capturePeerConsentPresentation();
  assert.ok(afterMetadata !== undefined);
  assert.equal(afterMetadata?.renderToken, settled.renderToken, "the unchanged frame keeps its token");
  assert.equal(harness.controller.settlePeerConsentRender(settled.renderToken), true);

  // Request A leaves the coordinator: this latched dialog is never retargeted
  // to B in place, and it authorizes nothing further.
  harness.controller.setPeerUiSnapshot(makeSnapshot({ revision: 10, consents: [consentB] }));
  assert.equal(harness.controller.capturePeerConsentPresentation(), undefined);
  assert.equal(harness.controller.settlePeerConsentRender(settled.renderToken), false);
  const ended = confirmText(harness).join("\n");
  assert.ok(ended.includes("name: alpha"), "the latched identity is not replaced by B");
  assert.ok(!ended.includes("name: beta"));
  assert.ok(ended.includes("no longer pending"));
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "an ended request approves nothing");

  // Closing the stale view and reviewing again targets B explicitly.
  harness.send(ESC);
  harness.baseline = harness.actions.length;
  reopenConsentReview(harness);
  const reviewB = confirmText(harness).join("\n");
  assert.ok(reviewB.includes("name: beta"));
});

test("the consent alert and dialog render hostile labels safely", () => {
  const harness = makeHarness(makeSnapshot({
    consents: [makeConsent({
      id: "A",
      label: "evil\u001b[31m\u0007name",
      fingerprint: "SHA256:\u001b]0;title\u0007fp",
      endpoint: "\u001b[2J192.0.2.99:1",
    })],
    notice: "notice\u001b[2J",
  }));
  show(harness);
  const alert = rosterText(harness, 70, 30).join("\n");
  assert.ok(alert.includes("evil"), "the label text survives sanitization");
  assert.ok(!alert.includes("\u001b]"));

  // Open the review through the pane and check the dialog too.
  reopenConsentReview(harness);
  const dialog = confirmText(harness, 70, 24).join("\n");
  assert.ok(dialog.includes("name: evil"));
  assert.ok(!dialog.includes("\u001b]"));
  assert.ok(dialog.includes("Approve") && dialog.includes("Deny"));
});

// ---------------------------------------------------------------------------
// Pointer authorization identity
// ---------------------------------------------------------------------------

test("mouse authorization identity includes the peer pane and consent targets", () => {
  const harness = makeHarness(makeSnapshot({ consents: [makeConsent({ id: "A" })] }));
  show(harness);
  rosterText(harness);
  const rosterKey = harness.controller.captureMousePresentation().authorizationKey;

  harness.controller.openPeerMenu();
  peerPaneText(harness);
  const paneKey = harness.controller.captureMousePresentation().authorizationKey;
  assert.notEqual(paneKey, rosterKey, "the network pane has its own target mapping");

  harness.send(ESC);
  openConsentFromAlert(harness);
  confirmText(harness);
  const denyKey = harness.controller.captureMousePresentation().authorizationKey;
  harness.send("y");
  confirmText(harness);
  const approveKey = harness.controller.captureMousePresentation().authorizationKey;
  assert.notEqual(denyKey, approveKey, "a different decision target is a different authorization identity");
});

// ---------------------------------------------------------------------------
// Bounded host-owned alert band (parent/compositor-owned placement)
// ---------------------------------------------------------------------------

test("renderPeerAlert is a bounded notification band that authorizes nothing", () => {
  const harness = makeHarness(makeSnapshot({
    consents: [makeConsent({ id: "A", label: "studio", fingerprint: "SHA256:studio" })],
  }));
  show(harness);
  harness.controller.setActiveMainOwner("native-a");
  rosterText(harness);
  const focusBefore = harness.controller.focus;
  const highlightedBefore = rosterText(harness).find((line) => line.startsWith("> "));
  harness.baseline = harness.actions.length;

  // One row: no identity can fit, so it only points at the review surface.
  const one = assertPaneSafe(harness.controller.renderPeerAlert(40, 1).lines, 40, 1);
  assert.equal(one.length, 1);
  assert.ok(one[0].includes("Incoming connection request"));
  assert.ok(one[0].includes("review"));
  assert.ok(!one[0].includes("Approve") && !one[0].includes("Deny"),
    "a one-row band offers no decision control");

  // Six rows carry the complete identity summary and the review hint.
  const six = assertPaneSafe(harness.controller.renderPeerAlert(60, 6).lines, 60, 6);
  const joined = six.join("\n");
  assert.ok(joined.includes("Incoming connection request"));
  assert.ok(joined.includes("name: studio"));
  assert.ok(joined.includes("key: SHA256:studio"));
  assert.ok(joined.includes("from: 192.0.2.10:51234"));
  assert.ok(joined.includes("120s"));
  assert.ok(joined.includes("review"));
  assert.ok(!joined.includes("Approve") && !joined.includes("Deny"),
    "the alert band never renders confirmation controls");

  // Intermediate heights stay bounded and meaningful.
  for (let rows = 2; rows <= 5; rows += 1) {
    const lines = assertPaneSafe(harness.controller.renderPeerAlert(50, rows).lines, 50, rows);
    assert.equal(lines.length, rows, `band of ${rows} rows fills its geometry`);
    assert.ok(lines[0].includes("Incoming connection request"));
  }

  // Band rendering establishes no consent authority and never moves focus,
  // selection, or the observed active owner.
  assert.equal(harness.controller.capturePeerConsentPresentation(), undefined);
  assert.equal(harness.controller.isPeerConsentRenderCurrent(1), false);
  assert.equal(harness.controller.focus, focusBefore, "the band never moves focus");
  assert.equal(harness.controller.activeMainOwnerID, "native-a");
  assert.equal(rosterText(harness).find((line) => line.startsWith("> ")), highlightedBefore);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "the band approves nothing");
});

test("renderPeerAlert renders nothing when no request is pending", () => {
  const harness = makeHarness(makeSnapshot());
  show(harness);
  assert.deepEqual(harness.controller.renderPeerAlert(40, 3).lines, []);
  assert.deepEqual(harness.controller.renderPeerAlert(40, 6).lines, []);
});

// ---------------------------------------------------------------------------
// Wide hostConfirmation placement seam
// ---------------------------------------------------------------------------

test("the active peer confirmation exposes a placement getter and renders in the wide form pane", () => {
  const harness = makeHarness(makeSnapshot({ consents: [makeConsent({ id: "A", label: "studio" })] }));
  show(harness);
  assert.equal(harness.controller.peerConsentConfirmationActive, false);
  assert.equal(harness.controller.savedDeleteConfirmationActive, false);

  harness.controller.openPeerMenu();
  focusPeerEntry(harness, "approval window");
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "confirm");
  assert.equal(harness.controller.peerConsentConfirmationActive, true,
    "the placement signal exists before anything renders");
  assert.equal(harness.controller.capturePeerConsentPresentation(), undefined,
    "an unrendered latch authorizes nothing");

  // Left pane stays the roster notice/rows; the right form slot renders the
  // dialog itself while confirm focus remains unchanged.
  const left = assertPaneSafe(harness.controller.renderRoster(40, 20).lines, 40, 20).join("\n");
  assert.ok(left.includes("Incoming connection request"), "the left pane keeps the roster alert");
  assert.equal(harness.controller.capturePeerConsentPresentation(), undefined,
    "a roster render alone is not the consent dialog");
  const right = assertPaneSafe(harness.controller.renderForm(50, 22).lines, 50, 22).join("\n");
  assert.ok(right.includes("Approve incoming connection?"));
  assert.ok(right.includes("name: studio"));
  assert.equal(harness.controller.focus, "confirm", "placement never changes keyboard ownership");
  assert.equal(harness.controller.peerConsentConfirmationActive, true);

  const placement = harness.controller.capturePeerConsentPresentation();
  assert.ok(placement !== undefined);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "placement alone authorizes nothing");
  assert.equal(harness.controller.settlePeerConsentRender(placement.renderToken), true);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [{
    type: "peer-consent",
    consentId: "A",
    decision: "deny",
    renderToken: placement.renderToken,
  }]);
  assert.equal(harness.controller.peerConsentConfirmationActive, false, "the decision closes the confirmation");

  // Closing or hiding the confirmation ends the placement signal.
  harness.baseline = harness.actions.length;
  reopenConsentReview(harness);
  assert.equal(harness.controller.peerConsentConfirmationActive, true);
  harness.send(ESC);
  assert.equal(harness.controller.peerConsentConfirmationActive, false);

  reopenConsentReview(harness);
  assert.equal(harness.controller.peerConsentConfirmationActive, true);
  harness.send("\x1b[1;3D"); // reserved toggle hides the pane
  assert.equal(harness.controller.visible, false);
  assert.equal(harness.controller.peerConsentConfirmationActive, false,
    "a hidden pane has no active confirmation placement");
  assert.deepEqual(harness.commands().filter((action) => action.type === "peer-consent"), [],
    "closing or hiding never invents a decision");
});

// ---------------------------------------------------------------------------
// Review regressions: dispatch guard, invisible frames, moved controls,
// non-scrolling alert band
// ---------------------------------------------------------------------------

test("a Main-style onAction guard sees the written consent frame as current during dispatch", () => {
  const observed: { during?: boolean; captureDuring?: boolean } = {};
  let harness: Harness | undefined;
  harness = makeHarness(makeSnapshot({ consents: [makeConsent({ id: "A" })] }), {
    onAction: (action) => {
      if (action.type !== "peer-consent") return;
      observed.during = harness?.controller.isPeerConsentRenderCurrent(action.renderToken);
      observed.captureDuring = harness?.controller.capturePeerConsentPresentation() !== undefined;
    },
  });
  openConsentFromAlert(harness);
  confirmText(harness);
  const presentation = harness.controller.capturePeerConsentPresentation();
  assert.ok(presentation !== undefined);
  assert.equal(harness.controller.settlePeerConsentRender(presentation.renderToken), true);
  harness.send(ENTER);
  const decision = harness.commands().find((action) => action.type === "peer-consent");
  assert.ok(decision !== undefined);
  assert.equal(observed.during, true,
    "the exact current frame is still current during synchronous dispatch");
  assert.equal(observed.captureDuring, true, "Main can capture the same frame in its own guard");
  assert.equal(harness.controller.isPeerConsentRenderCurrent(decision.renderToken), false,
    "the closed view is not current once dispatch returns");
  assert.equal(harness.controller.capturePeerConsentPresentation(), undefined);
  assert.equal(harness.controller.focus, "sidebar", "the dialog closes only after dispatch");
});

test("an unshowable form-slot frame refuses drawn network actions and revokes consent proof", () => {
  const harness = makeHarness(makeSnapshot());
  openNetworkPane(harness);
  const hidden = assertPaneSafe(harness.controller.renderForm(18, 4).lines, 18, 4);
  assert.ok(hidden.join(" ").includes("too small"));
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [], "a control that is not on screen cannot act");

  peerPaneText(harness); // complete render again
  harness.send(ENTER); // highlighted row 0 = Hosting
  assert.ok(harness.commands().some((action) => action.type === "peer-listener"),
    "a fully drawn control acts again after a complete render");

  const consent = makeHarness(makeSnapshot({ consents: [makeConsent({ id: "A" })] }));
  openConsentFromAlert(consent);
  assertPaneSafe(consent.controller.renderForm(50, 22).lines, 50, 22);
  const first = consent.controller.capturePeerConsentPresentation();
  assert.ok(first !== undefined);
  assert.equal(consent.controller.settlePeerConsentRender(first.renderToken), true);
  assertPaneSafe(consent.controller.renderForm(18, 4).lines, 18, 4);
  assert.equal(consent.controller.capturePeerConsentPresentation(), undefined);
  assertPaneSafe(consent.controller.renderForm(50, 22).lines, 50, 22);
  const second = consent.controller.capturePeerConsentPresentation();
  assert.ok(second !== undefined && second.renderToken !== first.renderToken,
    "the earlier receipt is never restored by re-rendering at the old geometry");
  assert.equal(consent.controller.settlePeerConsentRender(first.renderToken), false);
  assert.equal(consent.controller.settlePeerConsentRender(second.renderToken), true);
});

test("moved decision controls mint a new token and change the pointer mapping", () => {
  const harness = makeHarness(makeSnapshot({ consents: [makeConsent({ id: "A" })] }));
  openConsentFromAlert(harness);
  confirmText(harness);
  const before = harness.controller.capturePeerConsentPresentation();
  const mouseBefore = harness.controller.captureMousePresentation().authorizationKey;
  assert.ok(before !== undefined);

  // Applying before any receipt adds a local notice line, which shifts both
  // decision controls down by one row.
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), []);
  confirmText(harness);
  assert.ok(confirmText(harness).join(" ").includes("No written receipt"));
  const moved = harness.controller.capturePeerConsentPresentation();
  const mouseMoved = harness.controller.captureMousePresentation().authorizationKey;
  assert.ok(moved !== undefined);
  assert.notEqual(moved.renderToken, before.renderToken, "a moved control is a different frame");
  assert.notEqual(mouseMoved, mouseBefore, "the pointer target mapping moved with it");
  assert.equal(harness.controller.settlePeerConsentRender(before.renderToken), false);
  assert.equal(harness.controller.settlePeerConsentRender(moved.renderToken), true);

  // An identical re-render of that same frame keeps its token and receipt.
  confirmText(harness);
  const stable = harness.controller.capturePeerConsentPresentation();
  assert.equal(stable?.renderToken, moved.renderToken);
  assert.equal(harness.controller.settlePeerConsentRender(moved.renderToken), true);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [{
    type: "peer-consent",
    consentId: "A",
    decision: "deny",
    renderToken: moved.renderToken,
  }]);
});

test("the pending alert band stays visible while later session rows scroll into view", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bellEnabled: false },
    consents: [makeConsent({ id: "A", label: "studio", fingerprint: "SHA256:studio" })],
  }));
  harness.controller.updateItems(ids.map((id) => makeItem(id)));
  show(harness);
  harness.controller.select("h");
  const text = rosterText(harness, 44, 22);
  const joined = text.join("\n");
  assert.ok(joined.includes("Incoming connection request"), "the alert band is still visible");
  assert.ok(joined.includes("name: studio") && joined.includes("SHA256:studio"));
  assert.ok(joined.includes("120s"));
  assert.ok(joined.includes("label-h"), "a later session row is the drawn selection");
  const bandIndex = text.findIndex((line) => line.includes("Incoming connection request"));
  const sessionIndex = text.findIndex((line) => line.includes("label-"));
  assert.ok(bandIndex >= 0 && sessionIndex > bandIndex, "the band is reserved above the scrolling list");

  harness.controller.select("a");
  const again = rosterText(harness, 44, 22).join("\n");
  assert.ok(again.includes("Incoming connection request"), "scrolling never removes the band");
  assert.ok(again.includes("label-a"));
  assert.deepEqual(harness.commands(), []);
});

test("a ticking approval countdown never revokes an unchanged written frame", () => {
  const harness = makeHarness(makeSnapshot({ consents: [makeConsent({ id: "A" })] }));
  openConsentFromAlert(harness);
  confirmText(harness);
  const first = harness.controller.capturePeerConsentPresentation();
  assert.ok(first !== undefined);
  assert.equal(harness.controller.settlePeerConsentRender(first.renderToken), true);

  harness.clock.value = NOW + 5_000;
  const ticked = assertPaneSafe(harness.controller.render(60, 22).lines, 60, 22);
  assert.ok(ticked.join(" ").includes("115s"), "the remaining human window is still displayed");
  const after = harness.controller.capturePeerConsentPresentation();
  assert.equal(after?.renderToken, first.renderToken, "the countdown alone is not a new frame");
  assert.equal(harness.controller.settlePeerConsentRender(first.renderToken), true);
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), [{
    type: "peer-consent",
    consentId: "A",
    decision: "deny",
    renderToken: first.renderToken,
  }]);
});

test("streamed paste cannot confirm network consent, remove, or revoke", () => {
  const PASTE = ["\x1b[200~", ENTER, "y", "\x1b[201~"];

  // Consent: an already-settled Approve frame must ignore pasted Enter/y.
  const consent = makeHarness(makeSnapshot({ consents: [makeConsent({ id: "A" })] }));
  openConsentFromAlert(consent);
  confirmText(consent);
  consent.send("y"); // deliberate choice of Approve
  confirmText(consent);
  const frame = consent.controller.capturePeerConsentPresentation();
  assert.ok(frame !== undefined);
  assert.equal(consent.controller.settlePeerConsentRender(frame.renderToken), true);
  consent.baseline = consent.actions.length;
  for (const chunk of PASTE) consent.send(chunk);
  assert.deepEqual(consent.commands(), [], "a pasted Enter/y never approves");
  assert.equal(consent.controller.focus, "confirm", "the consent dialog stays open");
  assert.equal(consent.controller.peerConsentConfirmationActive, true);
  consent.send(ENTER); // a deliberate press still decides
  assert.deepEqual(consent.commands(), [{
    type: "peer-consent",
    consentId: "A",
    decision: "approve",
    renderToken: frame.renderToken,
  }]);

  // Remove destination: pasted confirmation is opaque.
  const remove = makeHarness(makeSnapshot({ hosts: [makeHost({ id: "studio", label: "studio" })] }));
  openNetworkPane(remove);
  movePeerRow(remove, 7);
  remove.send("r");
  assert.equal(remove.controller.focus, "confirm");
  confirmText(remove);
  remove.baseline = remove.actions.length;
  for (const chunk of PASTE) remove.send(chunk);
  assert.deepEqual(remove.commands(), [], "a pasted Enter/y never removes a destination");
  assert.equal(remove.controller.focus, "confirm");
  remove.send(ENTER);
  assert.deepEqual(remove.commands(), [{ type: "peer-remove", hostId: "studio" }]);

  // Receiving revoke: pasted confirmation is opaque.
  const revoke = makeHarness(makeSnapshot({
    trustedPeers: [makeTrustedPeer({ id: "p1", label: "laptop" })],
  }));
  openNetworkPane(revoke);
  movePeerRow(revoke, 7);
  revoke.send("v");
  assert.equal(revoke.controller.focus, "confirm");
  confirmText(revoke);
  revoke.baseline = revoke.actions.length;
  for (const chunk of PASTE) revoke.send(chunk);
  assert.deepEqual(revoke.commands(), [], "a pasted Enter/y never revokes a grant");
  assert.equal(revoke.controller.focus, "confirm");
  revoke.send(ENTER);
  assert.deepEqual(revoke.commands(), [{ type: "peer-revoke", peerId: "p1" }]);
});

test("short visible rosters keep the pending alert instead of only a too-small message", () => {
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bellEnabled: false },
    consents: [makeConsent({ id: "A", label: "studio", fingerprint: "SHA256:studio" })],
  }));
  harness.controller.updateItems([makeItem("a"), makeItem("b")]);
  show(harness);
  const focusBefore = harness.controller.focus;
  const selectedBefore = harness.controller.selectedId;
  harness.baseline = harness.actions.length;

  for (const rows of [1, 4, 8]) {
    const lines = assertPaneSafe(harness.controller.render(60, rows).lines, 60, rows);
    const joined = lines.join(" ");
    assert.ok(joined.includes("Incoming connection request"),
      `a ${rows}-row roster still shows the pending notification`);
    assert.ok(!joined.includes("too small"), "the bounded notification replaces the generic message");
    assert.equal(harness.controller.focus, focusBefore, "focus is unchanged");
    assert.equal(harness.controller.selectedId, selectedBefore, "selection is unchanged");
    assert.equal(harness.controller.capturePeerConsentPresentation(), undefined,
      "the roster band never becomes a confirmation frame");
  }

  // Invisible roster targets cannot act from these frames.
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), []);
});

test("without a pending request the short roster keeps the legacy too-small message", () => {
  const harness = makeHarness(makeSnapshot());
  harness.controller.updateItems([makeItem("a")]);
  show(harness);
  // Two rows cannot show a usable roster at all, so the legacy message stays.
  const lines = assertPaneSafe(harness.controller.render(60, 2).lines, 60, 2);
  assert.ok(lines.join(" ").includes("too small"));
  assert.ok(!lines.join(" ").includes("Incoming connection request"));
  harness.send(ENTER);
  assert.deepEqual(harness.commands(), []);
});

// ---------------------------------------------------------------------------
// Left-roster clicks while the right-hand network UI owns its pane (#486)
// ---------------------------------------------------------------------------

/** Draws the wide two-pane frame: the left roster beside the right-hand UI. */
function wideDraw(
  harness: Harness,
  rosterCols = 32,
  rows = 24,
  formCols = 47,
): string[] {
  const roster = assertPaneSafe(harness.controller.renderRoster(rosterCols, rows).lines, rosterCols, rows);
  void harness.controller.renderForm(formCols, rows);
  return roster;
}

/** The written roster row that begins the entry containing `text`. */
function wideRow(roster: readonly string[], text: string): number {
  const row = roster.findIndex((line) => line.includes(text));
  assert.ok(row > 0, `the written roster drew no ${JSON.stringify(text)} row: ${JSON.stringify(roster)}`);
  return row;
}

/** Plain text of the right-hand pane at the wide geometry. */
function wideRightPane(harness: Harness, formCols = 47, rows = 24): string {
  return assertPaneSafe(harness.controller.renderForm(formCols, rows).lines, formCols, rows).join("\n");
}

/** Opens the Network pane from the roster so the LEFT highlight owns the pane. */
function openNetworkFromRoster(harness: Harness): void {
  show(harness);
  void rosterText(harness); // deliberate Enter only acts on a row the last roster render drew
  harness.send(DOWN); // New session -> Network
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  harness.baseline = harness.actions.length;
}

test("a left-roster click closes the network pane and its Add menu without sending anything", () => {
  const harness = makeHarness(makeSnapshot());
  harness.controller.updateItems([makeItem("local-a")]);
  openNetworkFromRoster(harness);

  // The highlighted Network row is a pure no-op while its own pane is open.
  let roster = wideDraw(harness);
  assert.equal(harness.controller.activateRosterAt(1, wideRow(roster, "Network"), 32, 24), true);
  assert.deepEqual(harness.commands(), [], "the highlighted Network row emits nothing while its pane is open");
  assert.equal(harness.controller.focus, "form", "the network pane stays open");
  assert.ok(wideRightPane(harness).includes("Network"), "the same pane is still on screen");

  // A different row closes the whole pane first, then acts normally once.
  roster = wideDraw(harness);
  assert.equal(harness.controller.activateRosterAt(1, wideRow(roster, "label-local-a"), 32, 24), true);
  assert.equal(harness.controller.focus, "main");
  assert.deepEqual(harness.commands(), [{ type: "select", id: "local-a" }],
    "the clicked row performs its ordinary action exactly once");
  assert.equal(wideRightPane(harness).includes("Network"), false, "the network pane is really closed");
  assert.deepEqual(harness.actions.filter((action) => action.type.startsWith("peer-")), [],
    "closing the pane sends no network command of any kind");

  // Reopen through the roster, then abandon a half-edited Add-destination
  // field: the click closes the editor AND its containing pane and adds
  // nothing, while the untouched local draft rules stay as they are.
  roster = wideDraw(harness);
  assert.equal(harness.controller.activateRosterAt(1, wideRow(roster, "Network"), 32, 24), true);
  assert.equal(harness.controller.focus, "form");
  harness.baseline = harness.actions.length; // the shared Add-menu helper compares against this point
  openAddMenu(harness);
  focusPeerEntry(harness, "Host:");
  harness.send(ENTER); // one field editor, still inside the Add menu
  harness.send("half-edited.example");
  harness.baseline = harness.actions.length;
  roster = wideDraw(harness);
  assert.equal(harness.controller.activateRosterAt(1, wideRow(roster, "label-local-a"), 32, 24), true);
  assert.equal(harness.controller.focus, "main");
  assert.deepEqual(harness.commands(), [{ type: "select", id: "local-a" }],
    "the field editor and its Add menu both close, then the clicked row acts once");
  assert.equal(harness.actions.some((action) => action.type === "peer-add"), false,
    "a pointer gesture never adds a destination");
  const closedAddMenu = wideRightPane(harness);
  assert.equal(closedAddMenu.includes("Add destination"), false, "no hidden Add menu survives the click");
  assert.equal(closedAddMenu.includes("Network"), false, "the containing network pane closed with it");
});

test("a left-roster click dismisses a pending consent review without deciding it", () => {
  const harness = makeHarness(makeSnapshot({
    consents: [makeConsent({ id: "A", label: "studio", fingerprint: "SHA256:studio" })],
  }));
  harness.controller.updateItems([makeItem("local-a")]);
  openConsentFromAlert(harness);
  assert.equal(harness.controller.peerConsentConfirmationActive, true);
  harness.baseline = harness.actions.length;

  const roster = wideDraw(harness, 40, 22, 50);
  assert.ok(roster.join("\n").includes("Incoming connection request"),
    "the left roster stays visible beside the consent dialog");
  assert.equal(harness.controller.activateRosterAt(1, wideRow(roster, "label-local-a"), 40, 22), true);
  assert.equal(harness.controller.focus, "main");
  assert.deepEqual(harness.commands(), [{ type: "select", id: "local-a" }],
    "the click dismisses the review and performs the clicked row's ordinary action once");
  assert.equal(harness.actions.some((action) => action.type === "peer-consent"), false,
    "a pointer gesture never approves or denies a request");
  assert.equal(harness.controller.peerConsentConfirmationActive, false, "the review is closed");
  assert.equal(harness.controller.capturePeerConsentPresentation(), undefined,
    "a dismissed review keeps no written decision authority");

  const after = assertPaneSafe(harness.controller.renderRoster(40, 22).lines, 40, 22);
  assert.ok(after.join(" ").includes("Incoming connection request"),
    "the still-pending request keeps its alert band");
});

// ---------------------------------------------------------------------------
// Field labels align with the editable content row (#482 UI correction)
// ---------------------------------------------------------------------------

test("every Network field label sits beside the editable content row it names", () => {
  // The two listen editors, opened prefilled from a known fresh snapshot.
  const listen = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, bindHost: "", bindPort: null },
  }));
  openNetworkPane(listen);
  focusPeerEntry(listen, "Listen address:");
  listen.send(ENTER);
  assertLabeledInputRow(listen.controller.renderForm(70, 26), 70, 26, "> Listen address: ", "*");
  listen.send(ESC);
  focusPeerEntry(listen, "Listen port:");
  listen.send(ENTER);
  assertLabeledInputRow(listen.controller.renderForm(70, 26), 70, 26, "> Listen port: ", "8088");
  listen.send(ESC);
  assert.deepEqual(listen.commands(), [], "reading the listen editors emits nothing");

  // The three Add-destination editors, each revisited from its stored draft.
  const add = makeHarness(makeSnapshot());
  seedFullAddDraft(add);
  for (const [menuRow, label, value] of [
    ["Name:", "> Destination name: ", "studio-mac"],
    ["Host:", "> Host: ", "10.1.2.3"],
    ["Port:", "> Port: ", "7000"],
  ] as const) {
    focusPeerEntry(add, menuRow);
    add.send(ENTER);
    assertLabeledInputRow(add.controller.renderForm(70, 26), 70, 26, label, value);
    add.send(ESC);
  }
  assert.deepEqual(add.commands(), [], "reading the Add-field editors emits nothing");
});

test("a typed Network value stays on the labelled row with the caret immediately after it", () => {
  const harness = makeHarness(makeSnapshot({ settings: null }));
  openNetworkPane(harness);
  focusPeerEntry(harness, "Listen address:");
  harness.send(ENTER);
  harness.send("10.0.0.7");
  const frame = harness.controller.renderForm(70, 26);
  const lines = assertPaneSafe(frame.lines, 70, 26);
  assert.ok(frame.cursor, "the editor exposes its actual native input cursor");
  const label = "> Listen address: ";
  assert.equal(lines[frame.cursor.row]?.slice(0, label.length), label,
    "the label is beside the row the native cursor is on");
  assert.equal(lines[frame.cursor.row]?.slice(label.length, frame.cursor.column), "10.0.0.7",
    "the native caret sits immediately after the typed value on the labelled row");
  assert.equal(lines.filter((line) => line.includes(label.trimEnd())).length, 1,
    "the field is labelled exactly once, and never on a border row");
});

test("the smallest usable Network field frame still labels its content row; one row less refuses", () => {
  const harness = makeHarness(makeSnapshot());
  seedFullAddDraft(harness);
  focusPeerEntry(harness, "Host:");
  harness.send(ENTER);
  let usable = 0;
  for (let rows = 4; rows <= 26; rows += 1) {
    if (harness.controller.renderForm(60, rows).cursor !== undefined) {
      usable = rows;
      break;
    }
  }
  assert.ok(usable > 0, "some frame shows the Host editor with its native cursor");
  assertLabeledInputRow(harness.controller.renderForm(60, usable), 60, usable, "> Host: ", "10.1.2.3");
  const refused = assertPaneSafe(harness.controller.renderForm(60, usable - 1).lines, 60, usable - 1);
  assert.ok(refused.join(" ").includes("too small"), "one row less shows the truthful refusal");
  assert.equal(refused.some((line) => line.includes("> Host:")), false,
    "a refused frame draws no field label at all");
  assert.deepEqual(harness.commands(), [], "reading and refusing a frame emits nothing");
});

// ---------------------------------------------------------------------------
// Pointer activation inside the Network menus (#482 UI correction)
// ---------------------------------------------------------------------------

/** The pane row the current network render drew the row containing `text` on. */
function peerRowOf(harness: Harness, text: string, cols = 70, rows = 26): number {
  const lines = peerPaneText(harness, cols, rows);
  const row = lines.findIndex((line) => line.includes(text));
  assert.ok(row >= 0, `the network pane drew no ${JSON.stringify(text)} row: ${JSON.stringify(lines)}`);
  return row;
}

/** The row currently highlighted in the network pane. */
function peerHighlighted(harness: Harness): string {
  return peerPaneText(harness).find((line) => line.startsWith("> ")) ?? "";
}

const LOCAL_SESSION_ACTIONS: readonly string[] = ["select", "create", "remove", "stop-remove", "quit", "rename"];

test("a press on a drawn Network row performs that row's ordinary Enter action once", () => {
  const harness = makeHarness(makeSnapshot());
  openNetworkPane(harness);

  assert.equal(harness.controller.activatePeerAt(1, peerRowOf(harness, "Hosting: disabled"), 70, 26), true);
  assert.deepEqual(harness.commands(), [{ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "8443" }],
    "the press runs exactly the command Enter runs, and runs it once");
  assert.equal(harness.controller.focus, "form", "the pane stays open under the pointer");
  harness.baseline = harness.actions.length;

  assert.equal(harness.controller.activatePeerAt(1, peerRowOf(harness, "Auto reconnect: off"), 70, 26), true);
  assert.deepEqual(harness.commands(), [{ type: "peer-auto-reconnect", enabled: true }]);
  harness.baseline = harness.actions.length;

  assert.equal(harness.controller.activatePeerAt(1, peerRowOf(harness, "Incoming bell: on"), 70, 26), true);
  assert.deepEqual(harness.commands(), [{ type: "peer-bell", enabled: false }]);
});

test("a press targets the row it landed on, not the row the pane highlighted", () => {
  const harness = makeHarness(makeSnapshot({
    hosts: [makeHost({ id: "studio" }), makeHost({ id: "lab", host: "10.0.0.9" })],
  }));
  openNetworkPane(harness);
  assert.ok(peerHighlighted(harness).includes("Hosting:"), "the pane still highlights row 0");
  assert.equal(harness.controller.activatePeerAt(1, peerRowOf(harness, "host-lab"), 70, 26), true);
  assert.deepEqual(harness.commands(), [], "selecting a destination sends nothing");
  assert.ok(peerHighlighted(harness).includes("host-lab"),
    "the press moved the highlight to the row it actually hit");
  assert.ok(peerPaneFlat(harness).includes("Selected host-lab"));
});

test("informational and permission rows keep their no-authority semantics under the pointer", () => {
  const harness = makeHarness(makeSnapshot({
    hosts: [makeHost({ id: "studio", roster: { state: "current", rows: [makeRemoteRow({ id: "r1" })] } })],
    trustedPeers: [makeTrustedPeer({ id: "t1" })],
  }));
  openNetworkPane(harness);

  assert.equal(harness.controller.activatePeerAt(1, peerRowOf(harness, "- host-studio: remote-r1"), 70, 26), true);
  // The pane holds one notice at a time, so each row's own receipt is read
  // before the next press replaces it.
  const remoteFlat = peerPaneFlat(harness);
  assert.ok(remoteFlat.includes("Remote session metadata only"), remoteFlat);
  assert.equal(harness.controller.activatePeerAt(1, peerRowOf(harness, "trusted-t1"), 70, 26), true);
  assert.deepEqual(harness.commands(), [],
    "metadata and permission rows never become a local or network action under the pointer");
  assert.deepEqual(harness.actions.filter((action) => LOCAL_SESSION_ACTIONS.includes(action.type)), [],
    "a pointer press on a remote row emits no local session action of any kind");
  const flat = peerPaneFlat(harness);
  assert.ok(flat.includes("Receiving permission for trusted-t1"), flat);
  assert.equal(harness.controller.focus, "form", "informational rows change no focus");
});

test("a press on a pending request opens its review and decides nothing", () => {
  const harness = makeHarness(makeSnapshot({ consents: [makeConsent({ id: "A" })] }));
  openNetworkPane(harness);
  harness.baseline = harness.actions.length;

  assert.equal(harness.controller.activatePeerAt(1, peerRowOf(harness, "approval window"), 70, 26), true);
  assert.equal(harness.controller.peerConsentConfirmationActive, true, "the review opened");
  assert.deepEqual(harness.commands(), [], "opening a review is not a decision");
  assert.equal(harness.actions.some((action) => action.type === "peer-consent"), false,
    "a pointer press never approves or denies a request");
  assert.equal(harness.controller.capturePeerConsentPresentation(), undefined,
    "no written frame has authorized a decision yet");
});

test("the Add-destination menu acts under the pointer through the same rows as Enter", () => {
  const harness = makeHarness(makeSnapshot());
  openNetworkPane(harness);

  assert.equal(harness.controller.activatePeerAt(1, peerRowOf(harness, "Add destination"), 70, 26), true);
  assert.ok(peerPaneText(harness).some((line) => line.includes("Add destination (enter to add)")),
    "the press opened the field menu");
  assert.deepEqual(harness.commands(), [], "opening the menu sends nothing");
  harness.baseline = harness.actions.length;

  // A field row opens exactly that editor, empty and unchanged.
  assert.equal(harness.controller.activatePeerAt(1, peerRowOf(harness, "Host: (not set)"), 70, 26), true);
  assertLabeledInputRow(harness.controller.renderForm(70, 26), 70, 26, "> Host: ", "");
  assert.deepEqual(harness.commands(), [], "opening an editor sends nothing and types nothing");
  harness.send(ESC);

  // An incomplete draft stays a local refusal under the pointer too.
  assert.equal(harness.controller.activatePeerAt(1, peerRowOf(harness, "Add destination (enter to add)"), 70, 26), true);
  assert.deepEqual(harness.commands(), [], "an incomplete draft is never added");
  assert.ok(peerPaneFlat(harness).includes("A destination name is required"));
  harness.baseline = harness.actions.length;

  // A complete draft sends exactly one Add through the same single action row.
  focusPeerEntry(harness, "Name:");
  harness.send(ENTER);
  submitField(harness, "studio");
  focusPeerEntry(harness, "Host:");
  harness.send(ENTER);
  submitField(harness, "10.1.2.3");
  focusPeerEntry(harness, "Port:");
  harness.send(ENTER);
  submitField(harness, "7000");
  harness.baseline = harness.actions.length;
  assert.equal(harness.controller.activatePeerAt(1, peerRowOf(harness, "Add destination (enter to add)"), 70, 26), true);
  assert.deepEqual(harness.commands(), [{ type: "peer-add", label: "studio", host: "10.1.2.3", port: "7000" }],
    "one press on the single Add action sends the draft once");
});

test("pointer targets are the written rows: header, footer, blank, geometry, focus, and hidden refusals", () => {
  const harness = makeHarness(makeSnapshot({ hosts: [makeHost({ id: "studio" })] }));
  openNetworkPane(harness);
  const drawn = peerRowOf(harness, "host-studio");
  const lines = peerPaneText(harness);
  const footerRow = lines.findIndex((line) => line.includes("up/down select"));
  const blankRow = lines.findIndex((line, index) => index > drawn && line.trim() === "");

  assert.equal(harness.controller.activatePeerAt(0, 0, 70, 26), false, "the pane header is not a row");
  assert.equal(harness.controller.activatePeerAt(1, footerRow, 70, 26), false, "footer hints are not rows");
  assert.ok(blankRow > drawn);
  assert.equal(harness.controller.activatePeerAt(1, blankRow, 70, 26), false, "blank padding is not a row");
  assert.equal(harness.controller.activatePeerAt(1, drawn, 69, 26), false, "a different pane width authorizes nothing");
  assert.equal(harness.controller.activatePeerAt(1, drawn, 70, 25), false, "a different pane height authorizes nothing");
  assert.equal(harness.controller.activatePeerAt(-1, drawn, 70, 26), false, "a negative column is not a cell");
  assert.deepEqual(harness.commands(), [], "every refused press sends nothing");

  // The Add field editor owns its own pane: a press there activates no menu row
  // and cannot touch the value being edited.
  focusPeerEntry(harness, "Add destination");
  harness.send(ENTER);
  const hostRowInMenu = peerRowOf(harness, "Host: (not set)");
  focusPeerEntry(harness, "Host:");
  harness.send(ENTER);
  harness.send("10.1.2.3");
  harness.baseline = harness.actions.length;
  const editorFrame = harness.controller.renderForm(70, 26);
  assert.equal(harness.controller.activatePeerAt(1, hostRowInMenu, 70, 26), false,
    "no network menu row exists while a field editor is open");
  assertLabeledInputRow(harness.controller.renderForm(70, 26), 70, 26, "> Host: ", "10.1.2.3");
  assert.equal(editorFrame.cursor?.column, harness.controller.renderForm(70, 26).cursor?.column,
    "the refused press left the editor's native caret untouched");
  assert.deepEqual(harness.commands(), [], "a press inside a field editor sends nothing");
  harness.send(ESC);
  harness.send(ESC);

  // A hidden pane holds no drawn rows at all.
  harness.send("\x1b[1;3D"); // the reserved toggle hides the pane
  assert.equal(harness.controller.visible, false);
  assert.equal(harness.controller.activatePeerAt(1, drawn, 70, 26), false, "a hidden pane authorizes nothing");
});

test("a captured pointer presentation cannot outlive or retarget its drawn rows", () => {
  const harness = makeHarness(makeSnapshot({ hosts: [makeHost({ id: "studio" })] }));
  openNetworkPane(harness);
  const studioRow = peerRowOf(harness, "host-studio");
  const written = harness.controller.captureMousePresentation();
  const networkKey = written.authorizationKey;

  // The destination is removed while the captured frame is still held.
  harness.controller.setPeerUiSnapshot(makeSnapshot({ revision: 2, hosts: [] }));
  peerPaneText(harness);
  assert.notEqual(harness.controller.captureMousePresentation().authorizationKey, networkKey,
    "the removed destination changes the pointer authorization identity");
  assert.equal(written.activatePeerAt(1, studioRow, 70, 26), false,
    "the captured presentation refuses the row its frame no longer offers");
  assert.deepEqual(harness.commands(), [], "a refused press sends nothing");

  // A row that moved to a different pane row keeps its own identity: the press
  // that was captured for the old position never activates whatever sits there.
  const reordered = makeHarness(makeSnapshot({
    hosts: [makeHost({ id: "studio" }), makeHost({ id: "lab", host: "10.0.0.9" })],
  }));
  openNetworkPane(reordered);
  const labRow = peerRowOf(reordered, "host-lab");
  const before = reordered.controller.captureMousePresentation();
  reordered.controller.setPeerUiSnapshot(makeSnapshot({
    revision: 2,
    hosts: [makeHost({ id: "lab", host: "10.0.0.9" }), makeHost({ id: "studio" })],
  }));
  peerPaneText(reordered);
  assert.equal(before.activatePeerAt(1, labRow, 70, 26), false,
    "a reordered pane cannot make an old press activate a different row");
  assert.deepEqual(reordered.commands(), [], "the reordered refusal sent nothing");
  // The freshly drawn pane still acts on its own rows.
  assert.equal(reordered.controller.activatePeerAt(1, peerRowOf(reordered, "host-lab"), 70, 26), true);
  assert.deepEqual(reordered.commands(), [], "selecting a destination still sends nothing");
  assert.ok(peerPaneFlat(reordered).includes("Selected host-lab"));
});

test("the captured form map acts only on its written row and refuses a row that moved", () => {
  const harness = makeHarness(makeSnapshot({
    hosts: [makeHost({ id: "studio" }), makeHost({ id: "lab", host: "10.0.0.9" })],
  }));
  openNetworkPane(harness);
  const labRow = peerRowOf(harness, "host-lab");
  const formMap = harness.controller.captureMousePresentation();
  assert.equal(formMap.activateFormRowAt(1, labRow, 70, 26), true,
    "the written form map acts on the row it was drawn with");
  assert.deepEqual(harness.commands(), [], "selecting a destination still sends nothing");
  assert.ok(peerPaneFlat(harness).includes("Selected host-lab"));
  harness.baseline = harness.actions.length;

  // A destination added above shifts the same row to a later written row, and
  // the old coordinate now sits over a different destination.
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    revision: 2,
    hosts: [makeHost({ id: "aaa" }), makeHost({ id: "studio" }), makeHost({ id: "lab", host: "10.0.0.9" })],
  }));
  peerPaneText(harness);
  assert.notEqual(harness.controller.captureMousePresentation().authorizationKey,
    formMap.authorizationKey, "a shifted written row is a different pointer authorization identity");
  assert.equal(formMap.activateFormRowAt(1, labRow, 70, 26), false,
    "the captured form map refuses the coordinate whose row has moved");
  assert.equal(formMap.activatePeerAt(1, labRow, 70, 26), false,
    "the captured network map refuses it through its own entry point too");
  assert.deepEqual(harness.commands(), [], "the refused press sent nothing");
  const stillSelected = peerPaneFlat(harness);
  assert.ok(stillSelected.includes("Selected host-lab"),
    "the refusal neither selects nor clears a row");
  assert.ok(!stillSelected.includes("Selected host-aaa"),
    "the old coordinate never activates whatever now sits on that written row");

  // Resolve the actual menu row, not the notice above it that also names
  // host-lab, then capture that exact render's map.
  const freshRows = peerPaneText(harness);
  const freshLabRow = freshRows.findIndex((line) => /^(?:> |  )host-lab\b/.test(line));
  assert.ok(freshLabRow >= 0, "the current menu actually draws the host-lab destination row");
  const freshMap = harness.controller.captureMousePresentation();
  assert.equal(freshMap.activateFormRowAt(1, freshLabRow, 70, 26), true,
    "the current written form map remains usable");
  assert.ok(peerPaneFlat(harness).includes("Selected host-lab"));
});

test("a press acts on the intent its frame drew, never on state the operator never saw", () => {
  const harness = makeHarness(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, hostingEnabled: false, autoReconnect: false, bellEnabled: true },
  }));
  openNetworkPane(harness);
  const hostingRow = peerRowOf(harness, "Hosting: disabled");
  const bellRow = peerRowOf(harness, "Incoming bell: on");
  const written = harness.controller.captureMousePresentation();

  // The coordinator reports that hosting turned on while the captured frame is
  // still held. The drawn row promised "enter to enable"; acting on the live
  // state would send the opposite of what the operator was shown.
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    settings: { ...DEFAULT_SETTINGS, hostingEnabled: true, autoReconnect: false, bellEnabled: true },
  }));
  assert.equal(written.activatePeerAt(1, hostingRow, 70, 26), false,
    "a toggle whose drawn state changed refuses instead of flipping the opposite");
  assert.deepEqual(harness.commands(), [], "the refused toggle sent nothing");

  // The refusal is per row: an unrelated settings change leaves a row whose own
  // intent is untouched fully actionable.
  assert.equal(written.activatePeerAt(1, bellRow, 70, 26), true,
    "an unrelated settings change does not invalidate a row whose intent is unchanged");
  assert.deepEqual(harness.commands(), [{ type: "peer-bell", enabled: false }]);

  // Known-then-unknown is a different intent as well: a press whose frame showed
  // a real setting never substitutes a fresh default.
  harness.baseline = harness.actions.length;
  const enabledRow = peerRowOf(harness, "Hosting: enabled");
  const enabledFrame = harness.controller.captureMousePresentation();
  harness.controller.setPeerUiSnapshot(makeSnapshot({ revision: 3, settings: null }));
  assert.equal(enabledFrame.activatePeerAt(1, enabledRow, 70, 26), false,
    "a press whose settings became unknown refuses rather than inventing a default");
  assert.deepEqual(harness.commands(), [], "the unknown-settings refusal sent nothing");

  // Once the pane has drawn the unknown state, the ordinary row behaves exactly
  // as it always has: it refuses with a visible reason and sends no command.
  const unknownRow = peerRowOf(harness, "Hosting: unknown");
  assert.equal(harness.controller.activatePeerAt(1, unknownRow, 70, 26), true,
    "the drawn unknown row stays the row the operator can act on");
  assert.deepEqual(harness.commands(), [], "an unknown setting authorizes no listener command");
  assert.ok(peerPaneFlat(harness).includes("no hosting change was sent"),
    "the refusal names the unavailable settings document");
});
