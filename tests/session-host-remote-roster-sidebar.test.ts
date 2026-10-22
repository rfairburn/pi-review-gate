/**
 * Pure left-roster projection of remote session cards.
 *
 * Everything here is a controlled DTO: no coordinator, transport, process,
 * filesystem, or real clock is involved. The tests pin the contract Main later
 * integrates against — remote cards are a display projection of the SAME
 * `PeerUiSnapshot` the Network pane renders, ordinary activation emits exactly
 * one typed `select-remote` (never a local item action, even when opaque ids
 * collide), stale/unknown facts stay honest, and the existing focus, expansion,
 * pointer-cancellation, and Main-owner-highlight semantics are preserved.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";
import {
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  SidebarController,
  remoteRosterEntryKey,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarItem,
  type SidebarMainOwnerKey,
} from "../src/session-host/sidebar";
import type { RemoteSessionMetadata } from "../src/session-host/network/roster-metadata";
import type { PeerUiHost, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const TOGGLE = "\x1b[1;3D";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const DELETE = "\x1b[3~";
const SPACE = " ";
const ACTIVE_MAIN_WHITE = "\x1b[1;97m";
const SAVED_ROWS = [
  { id: "conv-1", file: "/agents/a/sessions/proj/one.jsonl", caption: "First conversation" },
] as const;

type RemoteTestHost = PeerUiHost & {
  roster: PeerUiHost["roster"] & { hostRunId?: string | null };
};

function makeItem(overrides: Partial<SidebarItem> & { id: string }): SidebarItem {
  return {
    label: `local-${overrides.id}`,
    workspace: `/local/ws/${overrides.id}`,
    agentDir: `/agents/${overrides.id}`,
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
    ...overrides,
  };
}

function makeRemoteRow(
  overrides: Partial<RemoteSessionMetadata> & { id: string },
): RemoteSessionMetadata {
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

function makeHost(options: {
  id: string;
  label?: string;
  state?: PeerUiHost["state"];
  rosterState?: "never" | "current" | "stale";
  rows?: readonly RemoteSessionMetadata[] | null;
  hostRunId?: string | null;
}): RemoteTestHost {
  return {
    id: options.id,
    label: options.label ?? `host-${options.id}`,
    host: "10.0.0.5",
    port: 8443,
    state: options.state ?? "connected",
    fingerprint: null,
    message: null,
    reconnectSuppressed: false,
    previouslyConnected: true,
    roster: {
      state: options.rosterState ?? "current",
      rows: options.rows ?? null,
      ...(options.hostRunId === undefined ? {} : { hostRunId: options.hostRunId }),
    },
  };
}

function makeSnapshot(overrides: Partial<PeerUiSnapshot> = {}): PeerUiSnapshot {
  return {
    revision: 1,
    status: "ready",
    settings: {
      hostingEnabled: false,
      bindHost: "127.0.0.1",
      bindPort: 8443,
      autoReconnect: false,
      bellEnabled: true,
    },
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
  send(data: string): void;
}

function makeHarness(options: SidebarControllerOptions = {}): Harness {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    initialVisible: false,
    ...options,
    onAction: (action) => actions.push(action),
  });
  return {
    controller,
    actions,
    send: (data: string) => controller.handleInput(data),
  };
}

function commandsSince(harness: Harness, baseline: number): SidebarAction[] {
  return harness.actions.slice(baseline).filter((action) => action.type !== "forward");
}

/** Shows the pane and puts keyboard focus on the roster picker. */
function show(harness: Harness): void {
  if (!harness.controller.visible || harness.controller.focus === "main") harness.send(TOGGLE);
  assert.equal(harness.controller.visible, true);
  assert.equal(harness.controller.focus, "sidebar");
}

function assertPaneSafe(lines: string[], cols: number, rowCount: number): string[] {
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
  assert.equal(lines.length, rowCount, "pane fills the supplied geometry");
  return lines.map((line) => line.replace(SGR_PATTERN, ""));
}

function rosterText(harness: Harness, cols = 70, rows = 40): string[] {
  return assertPaneSafe(harness.controller.render(cols, rows).lines, cols, rows);
}

function wideRoster(
  harness: Harness,
  cols = 32,
  rows = 30,
): { raw: string[]; text: string[] } {
  const raw = harness.controller.renderRoster(cols, rows).lines;
  return { raw, text: assertPaneSafe(raw, cols, rows) };
}

function peerPaneText(harness: Harness, cols = 47, rows = 30): string[] {
  return assertPaneSafe(harness.controller.renderForm(cols, rows).lines, cols, rows);
}

function rowOf(texts: readonly string[], needle: string): number {
  const row = texts.findIndex((line) => line.includes(needle));
  assert.ok(row > 0, `no drawn row contains ${JSON.stringify(needle)}: ${JSON.stringify(texts)}`);
  return row;
}

/** The drawn title line plus the highlighted line of the focused entry. */
function highlightedCardIn(texts: readonly string[]): string {
  const markerRow = texts.findIndex((line) => line.startsWith("> "));
  if (markerRow < 0) return "";
  const marker = texts[markerRow] ?? "";
  // Action rows carry their own caption, unlike session cards whose marker
  // sits on the status row. The preceding action is never the selected title.
  if (["Saved conversations", "New session", "Network", "Quit host", "Host shortcuts"]
    .some((caption) => marker.slice(2).trim() === caption)) return marker;
  const titleRow = markerRow > 0 ? texts[markerRow - 1] ?? "" : "";
  return `${titleRow}\n${marker}`;
}

function highlightedEntryText(harness: Harness): string {
  return highlightedCardIn(rosterText(harness));
}

/** Moves the roster highlight to the card whose drawn title contains `title`. */
function focusCard(harness: Harness, title: string): void {
  for (let step = 0; step < 40; step += 1) {
    if (highlightedEntryText(harness).includes(title)) return;
    harness.send(DOWN);
  }
  assert.fail(`roster card ${JSON.stringify(title)} could not be focused`);
}

// ---------------------------------------------------------------------------
// Projection, ordering, and honest bounded facts
// ---------------------------------------------------------------------------

test("the left roster projects remote cards alongside locals with honest facts and order", () => {
  const local = makeItem({ id: "shared", label: "Local shared", activity: ["activity-local"] });
  const current = makeHost({
    id: "h1",
    label: "studio",
    hostRunId: "run-alpha:1",
    rows: [
      makeRemoteRow({
        id: "shared",
        label: "remote-fallback",
        workspace: "/owner/work/build",
        nativeSession: { sessionId: "sess-remote", epoch: 3, name: "Remote build" },
        activity: ["activity-remote"],
      }),
      makeRemoteRow({ id: "second", label: "Remote second", lifecycle: "starting" }),
    ],
  });
  const stale = makeHost({
    id: "h2",
    label: "laptop",
    state: "retrying",
    rosterState: "stale",
    rows: [makeRemoteRow({
      id: "old",
      label: "old-row",
      lifecycle: "exited",
      hasLiveProcess: false,
      exitCode: 1,
    })],
  });
  const harness = makeHarness();
  harness.controller.updateItems([local]);
  harness.controller.setPeerUiSnapshot(makeSnapshot({ hosts: [current, stale] }));
  show(harness);
  const baseline = harness.actions.length;
  const texts = rosterText(harness, 72, 50);
  const joined = texts.join("\n");

  assert.ok(texts[0]?.includes("Sessions (1)"), "the local roster count keeps its existing meaning");
  assert.ok(joined.includes("Local shared"), "the local card is unchanged");
  assert.ok(joined.includes("Remote build"), "the remote canonical title comes from the DTO");
  assert.ok(!joined.includes("remote-fallback"),
    "the native name is canonical, so the fallback label is not invented alongside it");
  assert.ok(joined.includes("studio"), "the owner host's friendly label is shown");
  assert.ok(joined.includes("laptop") && joined.includes("[stale]"), "stale observations are marked");

  // Unknown stays unknown: no fabricated idle, zero, agent dir, or current file.
  assert.ok(joined.includes("agent unknown"));
  assert.ok(joined.includes("input unknown"));
  assert.ok(joined.includes("background unknown"));
  assert.ok(!joined.includes("agent idle"));
  assert.ok(!joined.includes("bg tasks 0"));
  assert.ok(!joined.includes("/agents/"), "no private owner fields are projected");
  assert.ok(joined.includes("/owner/work/build"), "the exact owner workspace is display-only data");
  assert.ok(joined.includes("activity-remote"), "generic activity is shown when expanded");
  assert.ok(joined.includes("exited (code 1)"), "a known exit code is shown honestly");

  // Stable ordering: local rows keep their order, then DTO host order, then row order.
  const localRow = rowOf(texts, "Local shared");
  const firstRemote = rowOf(texts, "Remote build");
  const secondRemote = rowOf(texts, "Remote second");
  const staleRemote = rowOf(texts, "old-row");
  assert.ok(localRow < firstRemote && firstRemote < secondRemote && secondRemote < staleRemote,
    "local rows stay first, then host order and each host's own row order");
  assert.equal(harness.controller.selectedId, undefined, "projection alone selects nothing");
  assert.deepEqual(commandsSince(harness, baseline), [], "projection emits nothing");
});

test("a stale card keeps its honest marker visible ahead of a long owner label", () => {
  const longLabel = "studio-owner-".padEnd(80, "x");
  const harness = makeHarness();
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    hosts: [makeHost({
      id: "h1",
      label: longLabel,
      rosterState: "stale",
      rows: [makeRemoteRow({ id: "r1", label: "Remote one" })],
    })],
  }));
  show(harness);
  const texts = rosterText(harness, 32, 30);
  const staleLine = texts.find((line) => line.includes("[stale]"));
  assert.ok(staleLine !== undefined, "the stale marker survives narrow clipping");
  assert.ok(staleLine.trimStart().startsWith("[stale]"),
    "the marker leads the variable-length owner label so truncation cannot hide it");
  assert.ok(!texts.join("\n").includes(longLabel),
    "the long label is clipped rather than widening the card");
});

test("empty and never-observed rosters add no cards and do not disturb the local roster", () => {
  const withNever = makeHarness();
  withNever.controller.updateItems([makeItem({ id: "a" })]);
  withNever.controller.setPeerUiSnapshot(makeSnapshot({
    hosts: [makeHost({ id: "h", rosterState: "never", rows: null })],
  }));
  show(withNever);

  const withNoHosts = makeHarness();
  withNoHosts.controller.updateItems([makeItem({ id: "a" })]);
  withNoHosts.controller.setPeerUiSnapshot(makeSnapshot({ hosts: [] }));
  show(withNoHosts);

  const never = wideRoster(withNever, 40, 24);
  const none = wideRoster(withNoHosts, 40, 24);
  assert.deepEqual(never.text, none.text,
    "a never-observed roster projects no card and changes nothing else");
  assert.ok(never.text.some((line) => line.includes("Network")),
    "the existing Network menu row is unchanged");
  assert.ok(!never.text.some((line) => line.includes("remote-")),
    "no remote title is fabricated from an unobserved roster");
});

// ---------------------------------------------------------------------------
// Typed selection and local-operation isolation
// ---------------------------------------------------------------------------

test("keyboard selection emits exactly one typed select-remote and never a local action", () => {
  const harness = makeHarness();
  harness.controller.updateItems([makeItem({ id: "shared" })]);
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    hosts: [
      makeHost({
        id: "h1",
        hostRunId: "run-alpha:1",
        rows: [makeRemoteRow({ id: "shared", label: "Remote shared" })],
      }),
      makeHost({
        id: "h2",
        rosterState: "stale",
        rows: [makeRemoteRow({ id: "old", label: "Remote old" })],
      }),
    ],
  }));
  show(harness);
  void rosterText(harness);

  focusCard(harness, "Remote shared");
  let baseline = harness.actions.length;
  harness.send(ENTER);
  assert.deepEqual(commandsSince(harness, baseline), [{
    type: "select-remote",
    hostId: "h1",
    hostRunId: "run-alpha:1",
    rowId: "shared",
  }], "one structured selection, exactly as observed");
  assert.equal(harness.controller.focus, "main",
    "the existing selection convention returns focus to Main");
  assert.equal(harness.controller.selectedId, undefined,
    "a remote opaque id is never exposed as a local item selection");

  show(harness);
  void rosterText(harness);
  focusCard(harness, "Remote old");
  baseline = harness.actions.length;
  harness.send(ENTER);
  assert.deepEqual(commandsSince(harness, baseline), [{
    type: "select-remote",
    hostId: "h2",
    hostRunId: null,
    rowId: "old",
  }], "an unobserved owner run stays null rather than defaulted or guessed");

  show(harness);
  void rosterText(harness);
  focusCard(harness, "local-shared");
  baseline = harness.actions.length;
  harness.send(ENTER);
  assert.deepEqual(commandsSince(harness, baseline), [{ type: "select", id: "shared" }],
    "a local row still selects its own local id");
  assert.equal(harness.controller.selectedId, "shared");
});

test("a normal left press selects a remote card once and local-only keys refuse it", () => {
  const harness = makeHarness();
  harness.controller.updateItems([makeItem({ id: "dup" })]);
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    hosts: [makeHost({
      id: "h1",
      hostRunId: "run-1",
      rows: [makeRemoteRow({ id: "dup", label: "Remote dup" })],
    })],
  }));
  show(harness);
  const written = wideRoster(harness, 40, 30);
  const remoteRow = rowOf(written.text, "Remote dup");
  let baseline = harness.actions.length;
  assert.equal(harness.controller.activateRosterAt(1, remoteRow, 40, 30), true);
  assert.deepEqual(commandsSince(harness, baseline), [{
    type: "select-remote",
    hostId: "h1",
    hostRunId: "run-1",
    rowId: "dup",
  }], "the written card is selected exactly once");
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.controller.selectedId, undefined,
    "the colliding local id is not claimed by the remote row");

  show(harness);
  void rosterText(harness);
  focusCard(harness, "Remote dup");
  // A deliberate d/Delete on the WRITTEN remote card asks Main about that owner
  // row only: it never claims the colliding local id, never starts a local stop,
  // and never carries a confirmation or a local removal of its own.
  const remoteCloseRequest = { type: "remote-close-request", hostId: "h1", hostRunId: "run-1", rowId: "dup" };
  baseline = harness.actions.length;
  harness.send("d");
  assert.deepEqual(commandsSince(harness, baseline), [remoteCloseRequest],
    "d asks for that remote owner row exactly once");
  baseline = harness.actions.length;
  harness.send(DELETE);
  assert.deepEqual(commandsSince(harness, baseline), [remoteCloseRequest],
    "Delete is the same deliberate remote request");
  baseline = harness.actions.length;
  harness.send("e");
  assert.deepEqual(commandsSince(harness, baseline), [],
    "edit still refuses a remote card instead of emitting any local command");
  assert.equal(harness.controller.selectedId, undefined,
    "the colliding local id is never claimed by a remote close");

  // The local row with the colliding id is still reachable through the
  // backend selection seam, and only it becomes the local selection.
  harness.controller.select("dup");
  assert.equal(harness.controller.selectedId, "dup");
});

// ---------------------------------------------------------------------------
// Expansion, pointer cancellation, and the #486 same-highlight no-op
// ---------------------------------------------------------------------------

test("composite expansion keeps colliding remote row ids and the local card independent", () => {
  const harness = makeHarness();
  harness.controller.updateItems([makeItem({ id: "dup", activity: ["activity-local"] })]);
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    hosts: [
      makeHost({
        id: "h1",
        rows: [makeRemoteRow({ id: "dup", label: "Remote one", activity: ["activity-h1"] })],
      }),
      makeHost({
        id: "h2",
        rows: [makeRemoteRow({ id: "dup", label: "Remote two", activity: ["activity-h2"] })],
      }),
    ],
  }));
  show(harness);
  let texts = rosterText(harness, 72, 50);
  assert.ok(texts.join("\n").includes("activity-h1"));
  assert.ok(texts.join("\n").includes("activity-h2"));

  focusCard(harness, "Remote one");
  harness.send(SPACE);
  texts = rosterText(harness, 72, 50);
  assert.ok(!texts.join("\n").includes("activity-h1"), "the highlighted remote card collapses");
  assert.ok(texts.join("\n").includes("activity-h2"),
    "the other host's colliding row id keeps its own expansion state");
  assert.ok(texts.join("\n").includes("activity-local"), "the local card is untouched");

  focusCard(harness, "Remote two");
  harness.send(SPACE);
  texts = rosterText(harness, 72, 50);
  assert.ok(!texts.join("\n").includes("activity-h2"));
  assert.ok(texts.join("\n").includes("activity-local"));

  focusCard(harness, "Remote one");
  harness.send(SPACE);
  texts = rosterText(harness, 72, 50);
  assert.ok(texts.join("\n").includes("activity-h1"), "each composite card re-expands independently");
  assert.ok(!texts.join("\n").includes("activity-h2"));

  assert.equal(remoteRosterEntryKey("h1", "dup") === remoteRosterEntryKey("h2", "dup"), false);
});

test("a same drawn remote highlight beside an open right UI is a pure no-op; another row cancels once", () => {
  const harness = makeHarness();
  harness.controller.updateItems([makeItem({ id: "local-a" })]);
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    hosts: [makeHost({
      id: "h1",
      hostRunId: "run-1",
      rows: [
        makeRemoteRow({ id: "r1", label: "Remote one" }),
        makeRemoteRow({ id: "r2", label: "Remote two" }),
      ],
    })],
  }));
  show(harness);
  void rosterText(harness);
  focusCard(harness, "Remote one");
  void rosterText(harness);

  harness.controller.openPeerMenu();
  assert.equal(harness.controller.focus, "form");
  const first = wideRoster(harness, 32, 30);
  void harness.controller.renderForm(47, 30);
  let baseline = harness.actions.length;
  assert.equal(harness.controller.activateRosterAt(1, rowOf(first.text, "Remote one"), 32, 30), true);
  assert.deepEqual(commandsSince(harness, baseline), [],
    "the already-highlighted card neither cancels nor re-activates");
  assert.equal(harness.controller.focus, "form", "the right-hand pane stays open");
  assert.ok(harness.controller.renderForm(47, 30).lines.join("\n").includes("Network"),
    "the open Network pane keeps its own state");

  const second = wideRoster(harness, 32, 30);
  baseline = harness.actions.length;
  assert.equal(harness.controller.activateRosterAt(1, rowOf(second.text, "Remote two"), 32, 30), true);
  assert.deepEqual(commandsSince(harness, baseline), [{
    type: "select-remote",
    hostId: "h1",
    hostRunId: "run-1",
    rowId: "r2",
  }], "a different remote card closes the pane through its own route and selects exactly once");
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.actions.some((action) =>
    action.type === "peer-connect" || action.type === "peer-disconnect"
    || action.type === "peer-consent" || action.type === "peer-remove"), false,
  "no connect, pairing, consent, removal, or trust change is implied");

  // A local row behaves exactly as before next to a projected remote card.
  harness.controller.openPeerMenu();
  const third = wideRoster(harness, 32, 30);
  void harness.controller.renderForm(47, 30);
  baseline = harness.actions.length;
  assert.equal(harness.controller.activateRosterAt(1, rowOf(third.text, "local-local-a"), 32, 30), true);
  assert.deepEqual(commandsSince(harness, baseline), [{ type: "select", id: "local-a" }],
    "the local row's ordinary action is unchanged");

  // The nested Add-destination menu closes through the pane's own route too.
  harness.controller.openPeerMenu();
  for (let step = 0; step < 12; step += 1) {
    const pane = peerPaneText(harness);
    if (pane.some((line) => line.startsWith("> ") && line.includes("Add destination"))) break;
    harness.send(DOWN);
  }
  assert.ok(peerPaneText(harness).some((line) =>
    line.startsWith("> ") && line.includes("Add destination")));
  harness.send(ENTER);
  assert.ok(peerPaneText(harness).some((line) => line.includes("Add destination (enter to add)")),
    "the nested Add menu is open before the click");
  const fourth = wideRoster(harness, 32, 30);
  baseline = harness.actions.length;
  assert.equal(harness.controller.activateRosterAt(1, rowOf(fourth.text, "Remote one"), 32, 30), true);
  assert.deepEqual(commandsSince(harness, baseline), [{
    type: "select-remote",
    hostId: "h1",
    hostRunId: "run-1",
    rowId: "r1",
  }], "the nested menu closes and the remote row selects once, never adding a destination");
  assert.equal(harness.actions.some((action) => action.type === "peer-add"), false);
});

test("a different remote row closes New, Saved, and a nested delete confirmation once", () => {
  const setup = (): Harness => {
    const harness = makeHarness();
    harness.controller.updateItems([makeItem({ id: "local-a" })]);
    harness.controller.setPeerUiSnapshot(makeSnapshot({
      hosts: [makeHost({
        id: "h1",
        hostRunId: "run-1",
        rows: [makeRemoteRow({ id: "r1", label: "Remote one" })],
      })],
    }));
    show(harness);
    void rosterText(harness);
    return harness;
  };
  const remoteSelection: SidebarAction = {
    type: "select-remote",
    hostId: "h1",
    hostRunId: "run-1",
    rowId: "r1",
  };

  // New session form with a dirty draft: the click closes it through its own
  // cancellation route and never submits a create.
  const newForm = setup();
  focusCard(newForm, "New session");
  newForm.send(ENTER);
  assert.equal(newForm.controller.focus, "form");
  newForm.send("/dirty-draft");
  let written = wideRoster(newForm, 32, 30);
  void newForm.controller.renderForm(47, 30);
  let baseline = newForm.actions.length;
  assert.equal(newForm.controller.activateRosterAt(1, rowOf(written.text, "Remote one"), 32, 30), true);
  assert.deepEqual(commandsSince(newForm, baseline), [remoteSelection],
    "the New form is abandoned through its own route, then the remote row selects once");
  assert.equal(newForm.controller.focus, "main");
  assert.equal(newForm.actions.some((action) => action.type === "create"), false,
    "cancelling the New form never submits it");

  // Saved picker: its own dismissal runs first, then the remote selection.
  const saved = setup();
  focusCard(saved, "Saved conversations");
  saved.send(ENTER);
  assert.equal(saved.controller.focus, "form");
  const list = saved.actions.at(-1);
  assert.ok(list !== undefined && list.type === "saved-list");
  assert.equal(saved.controller.completeSavedList(list.requestId, [...SAVED_ROWS], 0), true);
  written = wideRoster(saved, 32, 30);
  void saved.controller.renderForm(47, 30);
  baseline = saved.actions.length;
  assert.equal(saved.controller.activateRosterAt(1, rowOf(written.text, "Remote one"), 32, 30), true);
  assert.deepEqual(commandsSince(saved, baseline), [
    { type: "saved-dismiss", pickerId: list.requestId },
    remoteSelection,
  ], "the picker is dismissed through its own route and nothing is opened");
  assert.equal(saved.controller.savedPickerRequestId, undefined);
  assert.equal(saved.actions.some((action) =>
    action.type === "saved-delete" || action.type === "saved-open"), false);

  // Nested Saved-delete confirmation: both the confirmation and its containing
  // picker close through their existing cancellation routes without deciding.
  const nested = setup();
  focusCard(nested, "Saved conversations");
  nested.send(ENTER);
  const nestedList = nested.actions.at(-1);
  assert.ok(nestedList !== undefined && nestedList.type === "saved-list");
  nested.controller.completeSavedList(nestedList.requestId, [...SAVED_ROWS], 0);
  void nested.controller.renderForm(47, 20);
  nested.send("\x04"); // native default app.session.delete
  const prepare = nested.actions.at(-1);
  assert.ok(prepare !== undefined && prepare.type === "saved-delete-prepare");
  assert.equal(nested.controller.completeSavedDeleteCheck(prepare.requestId, true), true);
  assert.equal(nested.controller.focus, "confirm");
  written = wideRoster(nested, 32, 20);
  void nested.controller.renderSavedDeleteConfirmation(47, 20);
  baseline = nested.actions.length;
  assert.equal(nested.controller.activateRosterAt(1, rowOf(written.text, "Remote one"), 32, 20), true);
  assert.deepEqual(commandsSince(nested, baseline), [
    { type: "saved-dismiss", pickerId: nestedList.requestId },
    remoteSelection,
  ], "the confirmation and its containing picker both close, then the remote row selects once");
  assert.equal(nested.actions.some((action) => action.type === "saved-delete"), false,
    "a pointer gesture never confirms a deletion");
  assert.equal(nested.controller.savedDeleteConfirmationActive, false);
});

// ---------------------------------------------------------------------------
// Captured target identity and metadata arrivals
// ---------------------------------------------------------------------------
test("stale, removed, run-replaced, and reordered captured remote targets refuse instead of retargeting", () => {
  const harness = makeHarness();
  harness.controller.updateItems([makeItem({ id: "local-a" })]);
  const host = (options: {
    hostRunId?: string | null;
    rosterState?: "current" | "stale";
    rows?: readonly RemoteSessionMetadata[];
  } = {}): RemoteTestHost => makeHost({
    id: "h1",
    hostRunId: options.hostRunId === undefined ? "run-1" : options.hostRunId,
    rosterState: options.rosterState ?? "current",
    rows: options.rows ?? [
      makeRemoteRow({ id: "r1", label: "Remote one" }),
      makeRemoteRow({ id: "r2", label: "Remote two" }),
    ],
  });
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    hosts: [host()],
  }));
  show(harness);
  let written = wideRoster(harness, 32, 30);
  let captured = harness.controller.captureMousePresentation();
  const remoteRow = rowOf(written.text, "Remote one");
  let baseline = harness.actions.length;

  // Same row id, replaced owner run.
  harness.controller.setPeerUiSnapshot(makeSnapshot({ revision: 2, hosts: [host({ hostRunId: "run-2" })] }));
  assert.equal(captured.activateRosterAt(1, remoteRow, 32, 30), false,
    "a captured target from another owner run refuses");
  assert.deepEqual(commandsSince(harness, baseline), []);

  // Removed row.
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    revision: 3,
    hosts: [host({ rows: [makeRemoteRow({ id: "r2", label: "Remote two" })] })],
  }));
  assert.equal(captured.activateRosterAt(1, remoteRow, 32, 30), false,
    "a captured target whose row disappeared refuses");
  assert.deepEqual(commandsSince(harness, baseline), []);

  // Reordered rows: the old written geometry is no longer the current projection.
  harness.controller.setPeerUiSnapshot(makeSnapshot({ revision: 4, hosts: [host()] }));
  written = wideRoster(harness, 32, 30);
  const reorderedRow = rowOf(written.text, "Remote one");
  const reorderCapture = harness.controller.captureMousePresentation();
  const oldAuthorization = reorderCapture.authorizationKey;
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    revision: 5,
    hosts: [host({
      rows: [
        makeRemoteRow({ id: "r2", label: "Remote two" }),
        makeRemoteRow({ id: "r1", label: "Remote one" }),
      ],
    })],
  }));
  assert.equal(reorderCapture.activateRosterAt(1, reorderedRow, 32, 30), false,
    "a captured presentation from the old order refuses instead of retargeting");
  assert.deepEqual(commandsSince(harness, baseline), []);
  assert.equal(harness.controller.activateRosterAt(1, reorderedRow, 32, 30), false,
    "a reordered projection refuses the old geometry instead of retargeting");
  assert.deepEqual(commandsSince(harness, baseline), []);
  const reorderedView = wideRoster(harness, 32, 30);
  assert.ok(reorderedView.text.some((line) => line.includes("Remote one")));
  assert.notEqual(harness.controller.captureMousePresentation().authorizationKey, oldAuthorization,
    "the redrawn order has its own written-target authorization identity");

  // Current -> stale observation for the same identity.
  harness.controller.setPeerUiSnapshot(makeSnapshot({ revision: 6, hosts: [host()] }));
  written = wideRoster(harness, 32, 30);
  captured = harness.controller.captureMousePresentation();
  const staleRow = rowOf(written.text, "Remote one");
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    revision: 7,
    hosts: [host({ rosterState: "stale" })],
  }));
  assert.equal(captured.activateRosterAt(1, staleRow, 32, 30), false,
    "a captured current observation never activates a now-stale card");
  assert.deepEqual(commandsSince(harness, baseline), []);

  // A fresh written card states its own staleness honestly.
  written = wideRoster(harness, 32, 30);
  assert.ok(written.text.some((line) => line.includes("Remote one"))
    && written.text.some((line) => line.includes("[stale]")),
  "the redrawn card states its staleness");

  // Same row id and lifecycle, but a replaced native conversation tuple/epoch.
  const tupleRow = (epoch: number): RemoteSessionMetadata => makeRemoteRow({
    id: "r1",
    label: "Remote one",
    nativeSession: { sessionId: "sess-1", epoch, name: "Remote one" },
  });
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    revision: 8,
    hosts: [host({ rows: [tupleRow(2)] })],
  }));
  written = wideRoster(harness, 32, 30);
  captured = harness.controller.captureMousePresentation();
  const tupleTargetRow = rowOf(written.text, "Remote one");
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    revision: 9,
    hosts: [host({ rows: [tupleRow(3)] })],
  }));
  assert.equal(captured.activateRosterAt(1, tupleTargetRow, 32, 30), false,
    "a captured target whose native session tuple/epoch was replaced refuses");
  assert.deepEqual(commandsSince(harness, baseline), []);

  // A fresh written card at the fresh identity acts normally, exactly once.
  written = wideRoster(harness, 32, 30);
  assert.equal(
    harness.controller.activateRosterAt(1, rowOf(written.text, "Remote one"), 32, 30),
    true,
  );
  assert.deepEqual(commandsSince(harness, baseline), [{
    type: "select-remote",
    hostId: "h1",
    hostRunId: "run-1",
    rowId: "r1",
  }], "the fresh drawn identity resolves once, without reconnecting or falling back");
  assert.equal(harness.controller.focus, "main");
});

test("metadata arrivals and reorders preserve open forms, drafts, and the still-present highlight", () => {
  const harness = makeHarness();
  harness.controller.updateItems([makeItem({ id: "local-a" })]);
  const snapshotWith = (revision: number, rows: readonly RemoteSessionMetadata[]): PeerUiSnapshot =>
    makeSnapshot({
      revision,
      hosts: [makeHost({ id: "h1", hostRunId: "run-1", rows })],
    });
  const rows = [
    makeRemoteRow({ id: "r1", label: "Remote one" }),
    makeRemoteRow({ id: "r2", label: "Remote two" }),
  ];
  harness.controller.setPeerUiSnapshot(snapshotWith(1, rows));
  show(harness);
  void rosterText(harness);
  focusCard(harness, "Remote one");
  void rosterText(harness);

  // An open Network pane survives an arrival that keeps the highlighted card.
  harness.controller.openPeerMenu();
  let written = wideRoster(harness, 32, 30);
  void harness.controller.renderForm(47, 30);
  let baseline = harness.actions.length;
  harness.controller.setPeerUiSnapshot(snapshotWith(2, [rows[1]!, rows[0]!]));
  assert.equal(harness.controller.focus, "form", "the arrival keeps the open pane's focus");
  assert.deepEqual(commandsSince(harness, baseline), [], "an arrival emits nothing");
  written = wideRoster(harness, 32, 30);
  assert.ok(highlightedCardIn(written.text).includes("Remote one"),
    "the highlight stays on the same structured identity through a reorder");
  assert.ok(harness.controller.renderForm(47, 30).lines.join("\n").includes("Network"),
    "the open pane survives the arrival");

  // Losing the highlighted card clears only the highlight and keeps the pane.
  harness.controller.setPeerUiSnapshot(snapshotWith(3, [rows[1]!]));
  assert.equal(harness.controller.focus, "form", "losing a remote card never steals focus");
  assert.ok(!highlightedCardIn(wideRoster(harness, 32, 30).text).includes("Remote one"),
    "no sibling inherits the highlight");
  assert.ok(harness.controller.renderForm(47, 30).lines.join("\n").includes("Network"),
    "the open pane is not cancelled by a metadata loss");

  // A New form draft is untouched by a later arrival.
  harness.send(ESC);
  assert.equal(harness.controller.focus, "sidebar");
  for (let step = 0; step < 10; step += 1) {
    if (highlightedEntryText(harness).includes("New session")) break;
    harness.send(DOWN);
  }
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  harness.send("/keep-draft");
  baseline = harness.actions.length;
  harness.controller.setPeerUiSnapshot(snapshotWith(4, rows));
  assert.equal(harness.controller.focus, "form", "the arrival keeps the New form open");
  assert.ok(harness.controller.renderForm(47, 12).lines.join("\n").includes("/keep-draft"),
    "the draft survives the arrival");
  assert.deepEqual(commandsSince(harness, baseline), [], "no create or selection is implied");
});

// ---------------------------------------------------------------------------
// Actual Main owner is tracked separately from the left highlight
// ---------------------------------------------------------------------------

test("Main's actual remote owner is structured and distinct from the left highlight", () => {
  const harness = makeHarness();
  harness.controller.updateItems([makeItem({ id: "local-a" })]);
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    hosts: [makeHost({
      id: "h1",
      hostRunId: "run-1",
      rows: [makeRemoteRow({
        id: "r1",
        label: "Remote one",
        nativeSession: { sessionId: "sess-r1", epoch: 4, name: "Remote one" },
      })],
    })],
  }));
  show(harness);
  void rosterText(harness);
  focusCard(harness, "Remote one");
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.controller.activeMainOwnerKey, undefined,
    "selection alone does not decide the actual content owner");

  const owner: SidebarMainOwnerKey = {
    kind: "remote",
    hostId: "h1",
    hostRunId: "run-1",
    rowId: "r1",
  };
  harness.controller.setActiveMainOwnerKey(owner);
  assert.deepEqual(harness.controller.activeMainOwnerKey, owner);
  assert.equal(harness.controller.activeMainOwnerID, undefined,
    "a remote owner is never exposed as a local item id");
  assert.equal(harness.controller.selectedId, undefined);
  const remoteHighlight = rosterText(harness);
  const remoteTitle = remoteHighlight.find((line) => line.includes("Remote one")) ?? "";
  assert.ok(remoteTitle.includes("Remote one"));
  const rawRemote = harness.controller.renderRoster(40, 30).lines.find((line) =>
    line.includes("Remote one")) ?? "";
  assert.ok(rawRemote.includes(ACTIVE_MAIN_WHITE),
    "the actual remote owner takes the existing white title highlight");
  assert.ok(
    !(harness.controller.renderRoster(40, 30).lines.find((line) => line.includes("local-local-a")) ?? "")
      .includes(ACTIVE_MAIN_WHITE),
    "a different local row is not marked as the actual owner",
  );

  harness.controller.setActiveMainOwner("local-a");
  assert.deepEqual(harness.controller.activeMainOwnerKey, { kind: "local", id: "local-a" });
  assert.equal(harness.controller.activeMainOwnerID, "local-a");
  const rawLocal = harness.controller.renderRoster(40, 30).lines;
  assert.ok((rawLocal.find((line) => line.includes("local-local-a")) ?? "").includes(ACTIVE_MAIN_WHITE),
    "the local owner keeps its existing white highlight");
  assert.ok(!(rawLocal.find((line) => line.includes("Remote one")) ?? "").includes(ACTIVE_MAIN_WHITE),
    "the remote card is no longer falsely marked");

  harness.controller.setActiveMainOwnerKey(undefined);
  assert.equal(harness.controller.activeMainOwnerKey, undefined);
  assert.equal(harness.controller.activeMainOwnerID, undefined);
});

// ---------------------------------------------------------------------------
// Remote Close: the written highlight, the frozen confirmation, and its receipt
// ---------------------------------------------------------------------------

/** Fixed display title of the remote card these fixtures draw. */
const REMOTE_CLOSE_TITLE = "Remote build";
/** Fixed owner host label the dialog shows beside that title. */
const REMOTE_CLOSE_HOST = "studio";
const KITTY_ENTER_REPEAT = "\x1b[13;1:2u";
const KITTY_ENTER_RELEASE = "\x1b[13;1:3u";

/** A remote card whose drawn facts are positively, completely idle. */
function idleRemoteRow(overrides: Partial<RemoteSessionMetadata> & { id: string }): RemoteSessionMetadata {
  return makeRemoteRow({
    label: "fallback-label",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    backgroundTasks: 0,
    backgroundShells: 0,
    activeTasks: 0,
    activeShells: 0,
    nativeSession: { sessionId: "sess-remote", epoch: 4, name: REMOTE_CLOSE_TITLE },
    ...overrides,
  });
}

function remoteCloseHarness(options: {
  rows?: readonly RemoteSessionMetadata[];
  hostRunId?: string | null;
  rosterState?: "current" | "stale";
} = {}): Harness {
  const harness = makeHarness();
  harness.controller.updateItems([makeItem({ id: "local-a" })]);
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    hosts: [makeHost({
      id: "h1",
      label: REMOTE_CLOSE_HOST,
      hostRunId: options.hostRunId === undefined ? "run-1" : options.hostRunId,
      rosterState: options.rosterState ?? "current",
      rows: options.rows ?? [idleRemoteRow({ id: "r1" }), idleRemoteRow({ id: "r2" })],
    })],
  }));
  show(harness);
  void rosterText(harness, 40, 30);
  focusCard(harness, REMOTE_CLOSE_TITLE);
  void rosterText(harness, 40, 30);
  return harness;
}

test("a deliberate d/Delete names only the completely drawn remote highlight", () => {
  const harness = remoteCloseHarness();
  const drawn = harness.controller.captureMousePresentation().remoteClose;
  assert.ok(drawn, "the written highlight of a complete remote card is captured");
  assert.deepEqual(
    { hostId: drawn.hostId, hostRunId: drawn.hostRunId, rowId: drawn.rowId },
    { hostId: "h1", hostRunId: "run-1", rowId: "r1" },
    "the captured target is the minimal owner host/run/row tuple",
  );
  assert.equal(drawn.focus, "sidebar");
  assert.equal(drawn.height, 5, "the complete expanded card height was drawn");
  assert.equal(drawn.cols, 40);
  assert.equal(drawn.rows, 30);
  assert.equal(drawn.idle, true,
    "the condensed preflight uses the same complete-idle rule as a local card");
  assert.equal(drawn.title, REMOTE_CLOSE_TITLE);
  assert.equal(drawn.hostLabel, REMOTE_CLOSE_HOST);

  let baseline = harness.actions.length;
  harness.send("d");
  assert.deepEqual([...commandsSince(harness, baseline)], [{
    type: "remote-close-request", hostId: "h1", hostRunId: "run-1", rowId: "r1",
  }], "d emits exactly one minimal target and no confirmed flag");

  // A local highlight never captures a remote close, and never asks an owner.
  harness.controller.select("local-a");
  void rosterText(harness, 40, 30);
  assert.equal(harness.controller.captureMousePresentation().remoteClose, undefined,
    "a local highlight captures no remote target");
  baseline = harness.actions.length;
  harness.send("d");
  assert.equal(
    commandsSince(harness, baseline).some((action) => action.type.startsWith("remote-close")),
    false,
    "a local highlight never asks any owner to close a remote row",
  );
  // The local refusal stays on the roster: nothing replaced the pane, so no
  // dismissal is needed (and ESC here would hide the sidebar instead).
  assert.equal(harness.controller.visible, true, "the local refusal leaves the roster visible");
  assert.equal(harness.controller.focus, "sidebar", "the local refusal keeps roster focus");
  void rosterText(harness, 40, 30);

  // A too-small pane draws no complete card, so nothing is captured at all.
  void assertPaneSafe(harness.controller.render(10, 3).lines, 10, 3);
  assert.equal(harness.controller.captureMousePresentation().remoteClose, undefined,
    "a tiny fallback authorizes no remote close");
  baseline = harness.actions.length;
  harness.send("d");
  assert.deepEqual(commandsSince(harness, baseline), [],
    "a tiny fallback cannot ask for a close");
});

test("a remote row without an observed owner run refuses instead of guessing", () => {
  const harness = remoteCloseHarness({ hostRunId: null });
  const drawn = harness.controller.captureMousePresentation().remoteClose;
  assert.ok(drawn, "the drawn highlight is still described honestly");
  assert.equal(drawn.hostRunId, null, "no owner run is invented");
  const baseline = harness.actions.length;
  harness.send("d");
  assert.deepEqual(commandsSince(harness, baseline), [],
    "no close is requested without an observed owner run");
  assert.equal(harness.controller.prepareRemoteClose(
    { hostId: "h1", hostRunId: null, rowId: "r1" }, { direct: false },
  ), "refused", "preparation refuses an unknown run as well");
  assert.ok(rosterText(harness, 96, 30).join("\n").includes("owner run was not observed"),
    "the refusal is a bounded local notice, never a request");
});

test("the written remote close confirmation submits once and only after the exact frame is written", () => {
  const harness = remoteCloseHarness();
  const drawn = harness.controller.captureMousePresentation().remoteClose!;
  const target = { hostId: drawn.hostId, hostRunId: drawn.hostRunId, rowId: drawn.rowId };
  const baseline = harness.actions.length;

  assert.equal(harness.controller.prepareRemoteClose(target, { direct: true }), "direct",
    "an idle written row is reported as a direct plan");
  assert.equal(harness.controller.remoteCloseConfirmationActive, false,
    "a direct plan opens no dialog and emits nothing");
  assert.deepEqual(commandsSince(harness, baseline), []);

  assert.equal(harness.controller.prepareRemoteClose(target, { direct: false }), "confirmation-opened");
  assert.equal(harness.controller.remoteCloseConfirmationActive, true);
  assert.equal(harness.controller.focus, "confirm");
  const dialog = assertPaneSafe(harness.controller.render(40, 24).lines, 40, 24);
  const joined = dialog.join("\n");
  assert.ok(joined.includes("Close remote session?"), "the dialog names its purpose");
  assert.ok(joined.includes(REMOTE_CLOSE_TITLE), "the frozen display title is shown");
  assert.ok(joined.includes(REMOTE_CLOSE_HOST), "the owner host label is shown");
  assert.ok(joined.includes("enter/y = close") && joined.includes("esc/n = cancel"),
    "the drawn controls are the confirm/cancel rows");
  const first = harness.controller.captureRemoteCloseConfirmationPresentation();
  assert.ok(first, "the complete dialog mints a candidate token");
  assert.deepEqual(first.target, { hostId: "h1", hostRunId: "run-1", rowId: "r1" },
    "the frozen target carries only the minimal owner identity");

  // No writer receipt yet: a deliberate Enter says so and sends nothing.
  harness.send(ENTER);
  assert.deepEqual(commandsSince(harness, baseline), [],
    "an unwritten frame can never confirm anything");
  assert.equal(harness.controller.remoteCloseConfirmationActive, true,
    "the refused confirmation keeps its dialog for review");
  const notice = harness.controller.render(40, 24).lines.join("\n");
  assert.ok(notice.includes("No written receipt"), "the dialog states why nothing was sent");

  assert.equal(
    harness.controller.settleRemoteCloseConfirmationRender(first.generation, first.renderToken),
    true,
    "Main's actual-written settlement grants confirmation authority",
  );
  harness.send(ENTER);
  assert.deepEqual(commandsSince(harness, baseline), [{
    type: "remote-close-confirmed",
    hostId: "h1",
    hostRunId: "run-1",
    rowId: "r1",
    generation: first.generation,
    renderToken: first.renderToken,
  }], "exactly one confirmation of that exact written frame is emitted");
  assert.equal(harness.controller.remoteCloseConfirmationActive, false,
    "the submitted dialog is dismissed");
  assert.equal(harness.controller.focus, "sidebar");

  // The held key's repeat/release never reaches a second submission.
  harness.send(KITTY_ENTER_REPEAT);
  harness.send(KITTY_ENTER_RELEASE);
  assert.deepEqual(commandsSince(harness, baseline).slice(1), [],
    "a held Enter cannot submit a second close");

  // Re-opening the same frozen target is a NEW decision: new generation, new token.
  void rosterText(harness, 40, 24);
  assert.equal(harness.controller.prepareRemoteClose(target, { direct: false }), "confirmation-opened");
  void harness.controller.render(40, 24);
  const second = harness.controller.captureRemoteCloseConfirmationPresentation();
  assert.ok(second);
  assert.ok(second.generation > first.generation, "each deliberate open advances the generation");
  assert.notEqual(second.renderToken, first.renderToken,
    "identical bytes in a new generation never inherit the previous token");
  assert.equal(harness.controller.isRemoteCloseConfirmationRenderCurrent(first.generation, first.renderToken), false,
    "the previous generation is no longer current");
  assert.equal(harness.controller.settleRemoteCloseConfirmationRender(first.generation, first.renderToken), false);

  // Another row's request cannot be prepared while this dialog owns the roster.
  assert.equal(
    harness.controller.prepareRemoteClose({ hostId: "h1", hostRunId: "run-1", rowId: "r2" }, { direct: true }),
    "refused",
    "a dialog in progress never retargets to another row",
  );

  // Cancel sends nothing at all and restores roster focus.
  const afterCancel = harness.actions.length;
  harness.send(ESC);
  assert.deepEqual(commandsSince(harness, afterCancel), [], "cancel before submission sends no request");
  assert.equal(harness.controller.remoteCloseConfirmationActive, false);
  assert.equal(harness.controller.focus, "sidebar");
});

test("a tiny, replaced, or superseded dialog frame cannot confirm anything", () => {
  const harness = remoteCloseHarness();
  const drawn = harness.controller.captureMousePresentation().remoteClose!;
  const target = { hostId: drawn.hostId, hostRunId: drawn.hostRunId, rowId: drawn.rowId };
  const baseline = harness.actions.length;
  assert.equal(harness.controller.prepareRemoteClose(target, { direct: false }), "confirmation-opened");
  void harness.controller.render(40, 24);
  const frame = harness.controller.captureRemoteCloseConfirmationPresentation();
  assert.ok(frame);
  assert.equal(harness.controller.settleRemoteCloseConfirmationRender(frame.generation, frame.renderToken), true);

  // A frame that cannot show the whole target/control set revokes the token.
  void assertPaneSafe(harness.controller.render(10, 3).lines, 10, 3);
  assert.equal(harness.controller.isRemoteCloseConfirmationRenderCurrent(frame.generation, frame.renderToken), false);
  assert.equal(harness.controller.settleRemoteCloseConfirmationRender(frame.generation, frame.renderToken), false,
    "an unshowable frame can never be settled");
  harness.send(ENTER);
  assert.deepEqual(commandsSince(harness, baseline), [],
    "no confirmation can come from a frame that was never fully drawn");

  // Drawing the identical dialog again is a new candidate that must be settled again.
  void harness.controller.render(40, 24);
  const redrawn = harness.controller.captureRemoteCloseConfirmationPresentation();
  assert.ok(redrawn);
  assert.notEqual(redrawn.renderToken, frame.renderToken,
    "a re-established candidate after revocation is a new token");
  assert.equal(harness.controller.isRemoteCloseConfirmationRenderCurrent(frame.generation, frame.renderToken), false);
  harness.send(ENTER);
  assert.deepEqual(commandsSince(harness, baseline), [],
    "the superseded token can never be replayed");

  // The new frame is confirmable only after its own actual-written settlement.
  assert.equal(
    harness.controller.settleRemoteCloseConfirmationRender(redrawn.generation, redrawn.renderToken),
    true,
  );
  // An identical redraw of the SAME frame keeps that written receipt.
  void harness.controller.render(40, 24);
  const again = harness.controller.captureRemoteCloseConfirmationPresentation();
  assert.ok(again);
  assert.equal(again.renderToken, redrawn.renderToken, "an unchanged semantic frame keeps its token");
  harness.send(ENTER);
  assert.deepEqual(commandsSince(harness, baseline), [{
    type: "remote-close-confirmed",
    hostId: "h1",
    hostRunId: "run-1",
    rowId: "r1",
    generation: redrawn.generation,
    renderToken: redrawn.renderToken,
  }], "exactly one confirmation is emitted for the settled frame");
});

test("the written remote close presentation tracks the drawn highlight, row, and idleness by value", () => {
  const harness = remoteCloseHarness();
  const first = harness.controller.captureMousePresentation().remoteClose;
  assert.ok(first);
  void rosterText(harness, 40, 30);
  assert.deepEqual(harness.controller.captureMousePresentation().remoteClose, first,
    "the same written frame describes the same value");

  // Collapsing the highlighted card changes the drawn height, so it is a
  // different presented value (never inherited from the previous draw).
  harness.send(SPACE);
  void rosterText(harness, 40, 30);
  const collapsed = harness.controller.captureMousePresentation().remoteClose;
  assert.ok(collapsed);
  assert.equal(collapsed.height, 3);
  assert.notEqual(collapsed.row, undefined);

  // A changed observation of the SAME row changes the condensed preflight facts.
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    revision: 2,
    hosts: [makeHost({
      id: "h1",
      label: REMOTE_CLOSE_HOST,
      hostRunId: "run-1",
      rows: [idleRemoteRow({ id: "r1", busy: true }), idleRemoteRow({ id: "r2" })],
    })],
  }));
  void rosterText(harness, 40, 30);
  const busy = harness.controller.captureMousePresentation().remoteClose;
  assert.ok(busy);
  assert.equal(busy.rowId, "r1");
  assert.equal(busy.idle, false, "a busy observation is never condensed as idle");

  // The same row drawn lower (a new card ahead of it) is a different value.
  harness.controller.setPeerUiSnapshot(makeSnapshot({
    revision: 3,
    hosts: [makeHost({
      id: "h1",
      label: REMOTE_CLOSE_HOST,
      hostRunId: "run-1",
      rows: [idleRemoteRow({ id: "r2" }), idleRemoteRow({ id: "r3" }), idleRemoteRow({ id: "r1" })],
    })],
  }));
  void rosterText(harness, 40, 30);
  const reordered = harness.controller.captureMousePresentation().remoteClose;
  assert.ok(reordered);
  assert.equal(reordered.rowId, "r1", "the highlight still names the same owner row");
  assert.notEqual(reordered.row, busy.row, "its drawn pane row moved, so the value moved with it");
});

test("a dialog whose owner target vanished is abandoned without any request", () => {
  const harness = remoteCloseHarness();
  const drawn = harness.controller.captureMousePresentation().remoteClose!;
  const baseline = harness.actions.length;
  assert.equal(harness.controller.prepareRemoteClose(
    { hostId: drawn.hostId, hostRunId: drawn.hostRunId, rowId: drawn.rowId }, { direct: false },
  ), "confirmation-opened");
  void harness.controller.render(40, 24);
  const frame = harness.controller.captureRemoteCloseConfirmationPresentation();
  assert.ok(frame);

  // Main observed that the row disappeared, so it abandons the dialog. Nothing
  // is emitted, nothing is confirmed, and the previous token can never submit.
  assert.equal(harness.controller.abandonRemoteCloseConfirmation(), true);
  assert.equal(harness.controller.remoteCloseConfirmationActive, false);
  assert.equal(harness.controller.focus, "sidebar");
  assert.equal(harness.controller.abandonRemoteCloseConfirmation(), false,
    "a second abandonment has nothing to dismiss");
  void rosterText(harness, 40, 30);
  assert.equal(harness.controller.settleRemoteCloseConfirmationRender(
    frame.generation, frame.renderToken,
  ), false, "the abandoned frame can never be settled again");
  assert.deepEqual(commandsSince(harness, baseline), [],
    "abandoning a dialog sends no owner request at all");
});
