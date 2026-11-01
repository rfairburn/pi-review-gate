/**
 * Pure sidebar session-reorder controller (#477 frontend phase).
 *
 * Everything here is a controlled DTO: no Main, frame writer, compositor,
 * terminal surface, process, PTY, network, filesystem, or real clock is
 * involved. These tests pin the contract the production Main integration is
 * built against — Main's ONE canonical order arrives as a read-only callback,
 * the sidebar keeps no order store of its own, a preview emits nothing, and a
 * deliberate commit emits exactly one `reorder-session` DTO naming runtime
 * identities (never slots). The pointer API is exercised through the same
 * draw-derived hit maps Main will drive with its actually-written presentation,
 * including stale-map, tiny-pane, geometry-mismatch, and edge-scroll seams.
 *
 * Proof boundary: this is a pure controller proof, NOT a physical-terminal or
 * full-production-Main proof. It does not prove which bytes a terminal emits at
 * mouse mode 1002, that a real frame writer settled a map, or that Main
 * persists an order. Those belong to the Main/writer integration phase.
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
  type SidebarMainOwnerKey,
  type SidebarMousePresentation,
} from "../src/session-host/sidebar";
import type { RemoteSessionMetadata } from "../src/session-host/network/roster-metadata";
import type { PeerUiHost, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const TOGGLE = "\x1b[1;3D"; // alt+left
const RETURN = "\x1b[1;3C"; // alt+right
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const MOVE = "m";

type RemoteTestHost = PeerUiHost & {
  roster: PeerUiHost["roster"] & { hostRunId?: string | null };
};

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  /** Main's one canonical order view; the sidebar only ever reads it. */
  order: SidebarMainOwnerKey[];
  baseline: number;
  /** How many times the sidebar called the read-only order view. */
  orderCalls(): number;
  send(data: string): void;
  /** Non-forward actions emitted since the current baseline. */
  focusedActions(): SidebarAction[];
  /** Re-draws the roster and returns its plain rows. */
  view(cols?: number, rows?: number): string[];
  /**
   * Re-draws the LEFT roster pane the way the wide layout does while a form,
   * picker, or right-pane confirmation owns the right slot, and returns its
   * plain rows. The pane under test is not the focused pane here, so `view()`
   * would render that other pane instead.
   */
  rosterView(cols?: number, rows?: number): string[];
  /** Captured pointer maps for the roster that was just drawn. */
  presentation(): SidebarMousePresentation;
}

function makeItem(overrides: Partial<SidebarItem> & { id: string }): SidebarItem {
  return {
    label: `label-${overrides.id}`,
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
    label: `label-${overrides.id}`,
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
  rows?: readonly RemoteSessionMetadata[] | null;
  hostRunId?: string | null;
  rosterState?: "never" | "current" | "stale";
}): RemoteTestHost {
  return {
    id: options.id,
    label: `host-${options.id}`,
    host: "10.0.0.5",
    port: 8443,
    state: "connected",
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

function makeSnapshot(hosts: readonly RemoteTestHost[]): PeerUiSnapshot {
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
    hosts: [...hosts],
    trustedPeers: [],
    consents: [],
    notice: null,
  };
}

function makeHarness(
  options: {
    items?: readonly SidebarItem[];
    hosts?: readonly RemoteTestHost[];
    order?: readonly SidebarMainOwnerKey[];
    controllerOptions?: SidebarControllerOptions;
  } = {},
): Harness {
  const actions: SidebarAction[] = [];
  let calls = 0;
  const harness: Harness = {
    controller: undefined as unknown as SidebarController,
    actions,
    order: [...(options.order ?? [])],
    baseline: 0,
    orderCalls: () => calls,
    send: (data: string) => harness.controller.handleInput(data),
    focusedActions: () => actions.slice(harness.baseline).filter((action) => action.type !== "forward"),
    view: (cols = 40, rows = 30) => plainLines(harness.controller.render(cols, rows).lines, cols, rows),
    rosterView: (cols = 40, rows = 30) => plainLines(harness.controller.renderRoster(cols, rows).lines, cols, rows),
    presentation: () => harness.controller.captureMousePresentation(),
  };
  const controller = new SidebarController({
    initialVisible: false,
    ...options.controllerOptions,
    onAction: (action) => actions.push(action),
    // Main's view is handed over frozen: the sidebar may read it, never write
    // it. A test that supplies its own failing/malformed view keeps it.
    getSessionOrder: options.controllerOptions?.getSessionOrder ?? (() => {
      calls += 1;
      return Object.freeze([...harness.order]) as readonly SidebarMainOwnerKey[];
    }),
  });
  harness.controller = controller;
  if (options.items !== undefined) controller.updateItems([...options.items]);
  if (options.hosts !== undefined) controller.setPeerUiSnapshot(makeSnapshot(options.hosts));
  // Show the pane and take roster focus, exactly like the reserved toggle.
  harness.send(TOGGLE);
  assert.equal(controller.focus, "sidebar");
  // The show itself emits its ordinary visibility action; every assertion below
  // measures only what the interaction under test adds.
  harness.baseline = actions.length;
  return harness;
}

function plainLines(lines: string[], cols: number, rows?: number): string[] {
  if (rows !== undefined) assert.equal(lines.length, rows, "the pane must fill its geometry");
  for (const line of lines) {
    for (const sgr of line.match(SGR_PATTERN) ?? []) {
      assert.ok(
        SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
        `unexpected generated SGR ${JSON.stringify(sgr)} in ${JSON.stringify(line)}`,
      );
    }
    const text = line.replace(SGR_PATTERN, "");
    assert.ok(!text.includes("\x1b"), `raw ESC outside generated SGR: ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(text) <= cols, `rendered row wider than pane: ${JSON.stringify(line)}`);
  }
  return lines.map((line) => line.replace(SGR_PATTERN, ""));
}

/** The drawn row that carries a card's title line, or -1 when it is not drawn. */
function titleRow(view: readonly string[], title: string): number {
  return view.findIndex((line) => line.trim() === title);
}

/** The visible session titles, top to bottom, skipping undrawn ones. */
function visibleTitles(harness: Harness, titles: readonly string[], cols = 40, rows = 30): string[] {
  const view = harness.view(cols, rows);
  return titles
    .map((title) => ({ title, row: titleRow(view, title) }))
    .filter((entry) => entry.row >= 0)
    .sort((a, b) => a.row - b.row)
    .map((entry) => entry.title);
}

/**
 * The row of one drawn card that carries its own two-cell marker column: the
 * row below the title for a local card, two below for a remote card (whose
 * extra owner-host line is indented, never marked). Selection, move, and
 * insertion markers all live in those cells, so none of them can be clipped.
 */
function markerRowOf(view: readonly string[], title: string, remote = false): string {
  const row = titleRow(view, title);
  assert.ok(row >= 0, `no drawn card titled ${JSON.stringify(title)}: ${JSON.stringify(view)}`);
  return view[remote ? row + 2 : row + 1] ?? "";
}

/** The wrapped footer rows of one rendered pane. */
function footerRows(view: readonly string[]): string[] {
  const start = view.findIndex((line) => line.includes("toggle"));
  assert.ok(start >= 0, `no footer rows in ${JSON.stringify(view)}`);
  return view.slice(start);
}

/** The static rows keep their own relative order after every session card. */
function staticRowsAfterSessions(harness: Harness, cols = 40, rows = 30): void {
  const view = harness.view(cols, rows);
  const lastSessionRow = Math.max(...["label-a", "label-b", "label-c", "label-d", "label-r1"]
    .map((title) => titleRow(view, title))
    .filter((row) => row >= 0));
  for (const action of ["Saved conversations", "New session", "Quit host"]) {
    const row = view.findIndex((line) => line.includes(action));
    assert.ok(row > lastSessionRow, `${action} stays after every session card: ${JSON.stringify(view)}`);
  }
}

// ---------------------------------------------------------------------------
// Committed order comes only from Main's read-only view.
// ---------------------------------------------------------------------------

test("Main's read-only order view drives visible session cards across local and remote owners", () => {
  const harness = makeHarness({
    items: [makeItem({ id: "a" }), makeItem({ id: "c" })],
    hosts: [
      makeHost({ id: "host1", hostRunId: "run-1", rows: [makeRemoteRow({ id: "r1" })] }),
      makeHost({ id: "host2", hostRunId: "run-2", rows: [makeRemoteRow({ id: "r2" })] }),
    ],
  });
  // Without an order view the existing source order stands: locals, then the
  // peer projection, then the unchanged host action rows. The static-row check
  // uses a pane tall enough to draw every row: this roster overflows a 30-row
  // window, and the wrapped footer (which carries the move key here) takes one
  // of those rows, so the last action row scrolls. The order itself, which is
  // what the check pins, is identical at either height.
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-c", "label-r1", "label-r2"]), [
    "label-a", "label-c", "label-r1", "label-r2",
  ]);
  staticRowsAfterSessions(harness, 40, 34);

  // A(l), B(host1), C(l), D(host2) -> B, A, C, D with the SAME cards/owners.
  harness.order = [
    { kind: "remote", hostId: "host1", hostRunId: "run-1", rowId: "r1" },
    { kind: "local", id: "a" },
    { kind: "local", id: "c" },
    { kind: "remote", hostId: "host2", hostRunId: "run-2", rowId: "r2" },
  ];
  harness.controller.updateItems([makeItem({ id: "a" }), makeItem({ id: "c" })]);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-c", "label-r1", "label-r2"]), [
    "label-r1", "label-a", "label-c", "label-r2",
  ]);
  staticRowsAfterSessions(harness, 40, 34);
  // Nothing was emitted: an order view is a projection input, not an action.
  assert.deepEqual(harness.focusedActions(), []);

  // The view is read while rebuilding, not on every render.
  const before = harness.orderCalls();
  harness.view();
  harness.view();
  assert.equal(harness.orderCalls(), before, "rendering never re-reads or re-writes the order");
});

test("order matching is identity-safe across local/remote and host/row collisions", () => {
  // `a` + `bc` and `ab` + `c` must never share an identity, and a local id may
  // look like a remote pair without ever becoming one.
  const harness = makeHarness({
    items: [makeItem({ id: "a:bc" }), makeItem({ id: "x" })],
    hosts: [
      makeHost({ id: "a", hostRunId: "run", rows: [makeRemoteRow({ id: "bc" })] }),
      makeHost({ id: "ab", hostRunId: "run", rows: [makeRemoteRow({ id: "c" })] }),
    ],
    order: [{ kind: "remote", hostId: "ab", hostRunId: "run", rowId: "c" }],
  });
  assert.deepEqual(
    visibleTitles(harness, ["label-a:bc", "label-x", "label-bc", "label-c"]),
    ["label-c", "label-a:bc", "label-x", "label-bc"],
  );

  // A null run is a distinct identity from any string run.
  const nullRun = makeHarness({
    hosts: [
      makeHost({ id: "h", hostRunId: null, rows: [makeRemoteRow({ id: "row" })] }),
    ],
    order: [{ kind: "remote", hostId: "h", hostRunId: "run-9", rowId: "row" }],
  });
  assert.deepEqual(visibleTitles(nullRun, ["label-row"]), ["label-row"],
    "a view naming a different run matches nothing and reorders nothing");
});

test("a view identity with no card adds nothing and a new card appends in source order", () => {
  const harness = makeHarness({
    items: [makeItem({ id: "a" }), makeItem({ id: "b" })],
    order: [
      { kind: "local", id: "b" },
      { kind: "local", id: "vanished-and-remembered" },
      { kind: "local", id: "a" },
    ],
  });
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b"]), ["label-b", "label-a"]);
  const view = harness.view();
  assert.ok(!view.some((line) => line.includes("vanished-and-remembered")),
    "an absent identity is retained by Main without inventing a card");

  // A first-observed row the view does not name yet appends after the named ones.
  harness.controller.updateItems([
    makeItem({ id: "a" }), makeItem({ id: "b" }), makeItem({ id: "new" }),
  ]);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-new"]), [
    "label-b", "label-a", "label-new",
  ]);

  // A throwing or malformed view fails closed to the existing source order.
  const broken = makeHarness({
    items: [makeItem({ id: "a" }), makeItem({ id: "b" })],
    controllerOptions: {
      getSessionOrder: (() => {
        throw new Error("host view failed");
      }) as unknown as SidebarControllerOptions["getSessionOrder"],
    },
  });
  assert.deepEqual(visibleTitles(broken, ["label-a", "label-b"]), ["label-a", "label-b"]);
  const malformed = makeHarness({
    items: [makeItem({ id: "a" }), makeItem({ id: "b" })],
    controllerOptions: {
      getSessionOrder: (() => [
        { kind: "remote", hostId: "h" },
        { kind: "local" },
        null,
        "b",
      ]) as unknown as SidebarControllerOptions["getSessionOrder"],
    },
  });
  assert.deepEqual(visibleTitles(malformed, ["label-a", "label-b"]), ["label-a", "label-b"],
    "a malformed identity never reorders a real card");
});

// ---------------------------------------------------------------------------
// Keyboard move mode.
// ---------------------------------------------------------------------------

function moveHarness(ids: readonly string[] = ["a", "b", "c"], selected = "a"): Harness {
  const harness = makeHarness({ items: ids.map((id) => makeItem({ id })) });
  harness.controller.select(selected);
  harness.view();
  harness.baseline = harness.actions.length;
  return harness;
}

test("m previews one position at a time and Enter commits exactly one reorder-session DTO", () => {
  const harness = moveHarness();
  harness.send(MOVE);
  assert.equal(harness.controller.sessionMoveActive, true);
  const hints = harness.view().join(" ");
  for (const hint of ["up/down place", "enter drop", "esc cancel"]) {
    assert.ok(hints.includes(hint), `missing move hint ${hint}: ${hints}`);
  }
  // Entering the mode changed nothing but the hints.
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]), ["label-a", "label-b", "label-c"]);
  assert.deepEqual(harness.focusedActions(), []);

  harness.send(DOWN);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]), ["label-b", "label-a", "label-c"]);
  assert.ok(harness.view().some((line) => line.trim().startsWith(">>")), "the moving card is marked");
  assert.equal(harness.controller.selectedId, "a", "the highlight stays on the moved card");
  assert.deepEqual(harness.focusedActions(), [], "a preview emits nothing at all");

  harness.send(DOWN);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]), ["label-b", "label-c", "label-a"]);
  harness.send(UP);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]), ["label-b", "label-a", "label-c"]);

  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{
    type: "reorder-session",
    source: { kind: "local", id: "a" },
    target: { kind: "local", id: "c" },
    placement: "before",
  }], "one committed action, and Enter never activated a row");
  assert.equal(harness.controller.sessionMoveActive, false);
  assert.equal(harness.controller.focus, "sidebar", "committing does not change focus or input ownership");
  assert.equal(harness.controller.selectedId, "a");
  assert.equal(harness.controller.activeMainOwnerKey, undefined, "the displayed Main owner is untouched");

  // The committed order is Main's: once the view reports the new order, the
  // same card keeps its identity, selection, and action routing.
  harness.order = [
    { kind: "local", id: "b" }, { kind: "local", id: "c" }, { kind: "local", id: "a" },
  ];
  harness.controller.updateItems([makeItem({ id: "a" }), makeItem({ id: "b" }), makeItem({ id: "c" })]);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]), ["label-b", "label-c", "label-a"]);
  assert.equal(harness.controller.selectedId, "a");
  harness.baseline = harness.actions.length;
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{ type: "select", id: "a" }],
    "the moved card still routes its exact captured identity");
});

test("Escape cancels, arrows never wrap, and every abandoned path emits nothing", () => {
  const harness = moveHarness();
  harness.send(MOVE);
  harness.send(UP);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]), ["label-a", "label-b", "label-c"],
    "no wrap past the first position");
  assert.ok(markerRowOf(harness.view(), "label-a").trim().startsWith(">>"),
    "a refused step leaves the card being moved visibly marked");
  assert.ok(!harness.view().some((line) => line.trim().startsWith("^") || line.trim().startsWith("v ")),
    "and no destination is claimed when no position was previewed");
  harness.send(UP);
  harness.send(UP);
  assert.deepEqual(harness.focusedActions(), []);

  harness.send(DOWN);
  harness.send(DOWN);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]), ["label-b", "label-c", "label-a"]);
  harness.send(ESC);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]), ["label-a", "label-b", "label-c"],
    "Escape restores the committed order");
  assert.equal(harness.controller.sessionMoveActive, false);
  assert.deepEqual(harness.focusedActions(), [], "a cancel emits nothing");

  // The last position behaves the same way at the other end.
  const tail = moveHarness(["a", "b", "c"], "c");
  tail.send(MOVE);
  tail.send(DOWN);
  tail.send(DOWN);
  assert.deepEqual(visibleTitles(tail, ["label-a", "label-b", "label-c"]), ["label-a", "label-b", "label-c"],
    "no wrap past the last position");
  tail.send(ENTER);
  assert.deepEqual(tail.focusedActions(), [], "committing nothing emits nothing");
  assert.equal(tail.controller.sessionMoveActive, false);
});

test("move mode owns the roster's keys, and ordinary navigation returns unchanged", () => {
  const harness = moveHarness();
  harness.send(MOVE);
  for (const key of ["d", "D", "e", "n", "q", " "]) {
    harness.send(key);
  }
  assert.deepEqual(harness.focusedActions(), [],
    "a mid-move stop/remove, edit, detach, quit, or expand never fires");
  assert.notEqual(harness.controller.focus, "confirm", "the Quit confirmation cannot open mid-move");
  // A fresh Enter with nothing previewed simply leaves the mode.
  harness.send(ENTER);
  assert.equal(harness.controller.sessionMoveActive, false);
  assert.deepEqual(harness.focusedActions(), []);

  // Outside the mode the existing keys act exactly as before. Roster
  // navigation still wraps through the unchanged static rows (b -> Saved ->
  // New -> Quit -> a), so this check uses a sessions-only roster.
  const navigate = makeHarness({ items: [makeItem({ id: "a" }), makeItem({ id: "b" })] });
  navigate.controller.select("b");
  navigate.view();
  navigate.baseline = navigate.actions.length;
  navigate.send(DOWN);
  assert.equal(navigate.controller.selectedId, undefined,
    "b still steps into the unchanged static rows");
  navigate.send(DOWN); // Saved -> New
  navigate.send(DOWN); // New -> Quit
  navigate.send(DOWN); // Quit wraps to the first session
  assert.equal(navigate.controller.selectedId, "a", "ordinary navigation still wraps as it always did");

  // The exited-row Delete path is also unchanged.
  const exited = makeHarness({ items: [makeItem({ id: "a" }), makeItem({ id: "gone", lifecycle: "exited" })] });
  exited.controller.select("gone");
  exited.view();
  exited.baseline = exited.actions.length;
  exited.send("d");
  assert.deepEqual(exited.focusedActions(), [{ type: "remove", id: "gone" }]);
});

test("a placeholder card moves too, and neither path changes the displayed Main owner", () => {
  const harness = makeHarness({
    items: [
      makeItem({ id: "live" }),
      makeItem({ id: "gone", lifecycle: "exited", hasLiveProcess: false }),
      makeItem({ id: "stuck", lifecycle: "error", unavailable: true, hasLiveProcess: false }),
    ],
  });
  harness.controller.setActiveMainOwnerKey({ kind: "local", id: "live" });
  harness.controller.select("stuck");
  harness.view();
  harness.baseline = harness.actions.length;
  harness.send(MOVE);
  harness.send(UP);
  assert.deepEqual(harness.focusedActions(), []);
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{
    type: "reorder-session",
    source: { kind: "local", id: "stuck" },
    target: { kind: "local", id: "gone" },
    placement: "before",
  }]);
  assert.deepEqual(harness.controller.activeMainOwnerKey, { kind: "local", id: "live" },
    "a reorder never changes the real content owner");
  assert.equal(harness.controller.focus, "sidebar");
});

test("a remote card moves across owners and commits its exact host/run/row identity", () => {
  const harness = makeHarness({
    items: [makeItem({ id: "a" })],
    hosts: [makeHost({ id: "host1", hostRunId: "run-1", rows: [makeRemoteRow({ id: "r1" })] })],
  });
  // Highlight the remote card the way an operator does: the drawn row's own
  // activation, then back to the roster with the return chord.
  const view = harness.view();
  const remoteRow = titleRow(view, "label-r1");
  assert.ok(remoteRow > 0);
  harness.presentation().activateRosterAt(0, remoteRow, 40, 30);
  assert.equal(harness.controller.focus, "main");
  harness.send(TOGGLE);
  assert.equal(harness.controller.focus, "sidebar");
  harness.view();
  harness.baseline = harness.actions.length;

  harness.send("M");
  assert.equal(harness.controller.sessionMoveActive, true, "shift+M enters the same move mode");
  harness.send(DOWN);
  harness.send(UP);
  harness.send(UP);
  assert.deepEqual(harness.focusedActions(), []);
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{
    type: "reorder-session",
    source: { kind: "remote", hostId: "host1", hostRunId: "run-1", rowId: "r1" },
    target: { kind: "local", id: "a" },
    placement: "before",
  }], "a remote move names its exact owner run and row, never a slot");
});

// ---------------------------------------------------------------------------
// Pointer interaction.
// ---------------------------------------------------------------------------

function pointerHarness(
  options: Parameters<typeof makeHarness>[0] = {},
): Harness {
  const harness = makeHarness(options);
  harness.view();
  harness.baseline = harness.actions.length;
  return harness;
}

test("a session press activates only on release over the same card, with no motion", () => {
  const harness = pointerHarness({ items: [makeItem({ id: "a" }), makeItem({ id: "b" })] });
  const presentation = harness.presentation();
  const rowA = titleRow(harness.view(), "label-a");
  assert.equal(presentation.beginSessionPointerAt(0, rowA, 40, 30), true);
  assert.equal(harness.controller.sessionPointerActive, true);
  assert.deepEqual(harness.focusedActions(), [], "a press alone activates nothing");
  assert.equal(harness.controller.selectedId, undefined, "a press alone does not even select");

  assert.equal(presentation.finishSessionPointerAt(0, rowA, 40, 30), true);
  assert.deepEqual(harness.focusedActions(), [{ type: "select", id: "a" }]);
  assert.equal(harness.controller.sessionPointerActive, false);
  // No replay: the retired interaction cannot act again.
  assert.equal(presentation.finishSessionPointerAt(0, rowA, 40, 30), false);
  assert.equal(presentation.updateSessionPointerAt(0, rowA + 1, 40, 30), false);
  assert.deepEqual(harness.focusedActions(), [{ type: "select", id: "a" }]);

  // A release over a DIFFERENT card is not a click on the pressed one.
  const other = pointerHarness({ items: [makeItem({ id: "a" }), makeItem({ id: "b" })] });
  const otherView = other.view();
  const pressed = other.presentation();
  const rowB = titleRow(otherView, "label-b");
  assert.equal(pressed.beginSessionPointerAt(0, titleRow(otherView, "label-a"), 40, 30), true);
  assert.equal(pressed.finishSessionPointerAt(0, rowB, 40, 30), false);
  assert.deepEqual(other.focusedActions(), []);
  assert.equal(other.controller.selectedId, undefined);

  // Motion against a stale/mismatched map still makes this a DRAG: a later
  // release over the pressed card cannot fall back to a click activation.
  const staleMotion = pointerHarness({ items: [makeItem({ id: "a" })] });
  const staleView = staleMotion.view();
  const stalePresentation = staleMotion.presentation();
  const staleRow = titleRow(staleView, "label-a");
  assert.equal(stalePresentation.beginSessionPointerAt(0, staleRow, 40, 30), true);
  assert.equal(stalePresentation.updateSessionPointerAt(0, staleRow + 1, 44, 30), true);
  assert.equal(stalePresentation.finishSessionPointerAt(0, staleRow, 40, 30), false);
  assert.deepEqual(staleMotion.focusedActions(), [],
    "a drag whose motion could not resolve still never activates on release");
});

test("a drag previews the pointer's side of the destination and commits one reorder, activating nothing", () => {
  const harness = pointerHarness({
    items: [makeItem({ id: "a" })],
    hosts: [makeHost({ id: "host1", hostRunId: "run-1", rows: [makeRemoteRow({ id: "r1" })] })],
  });
  const presentation = harness.presentation();
  const view = harness.view();
  const rowA = titleRow(view, "label-a");
  const remoteTop = titleRow(view, "label-r1");
  assert.equal(presentation.beginSessionPointerAt(0, rowA, 40, 30), true);

  // Lower half of the destination card -> after; the preview is visible and
  // emits nothing.
  assert.equal(presentation.updateSessionPointerAt(0, remoteTop + 5, 40, 30), true);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-r1"]), ["label-r1", "label-a"]);
  assert.ok(harness.view().some((line) => line.trim().startsWith(">>")));
  assert.deepEqual(harness.focusedActions(), [], "a drag preview never writes or emits");

  // Upper half -> before, which is the destination's existing side, and still
  // nothing emitted.
  assert.equal(presentation.updateSessionPointerAt(0, remoteTop + 1, 40, 30), true);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-r1"]), ["label-a", "label-r1"]);
  assert.deepEqual(harness.focusedActions(), []);

  // Back to the lower half; the release commits the previewed "after" position.
  assert.equal(presentation.updateSessionPointerAt(0, remoteTop + 5, 40, 30), true);
  assert.equal(presentation.finishSessionPointerAt(0, remoteTop + 5, 40, 30), true);
  assert.deepEqual(harness.focusedActions(), [{
    type: "reorder-session",
    source: { kind: "local", id: "a" },
    target: { kind: "remote", hostId: "host1", hostRunId: "run-1", rowId: "r1" },
    placement: "after",
  }], "one commit, and neither the source nor the destination was activated");
  assert.equal(harness.controller.focus, "sidebar", "a drag never changes focus or input ownership");
  assert.deepEqual(harness.controller.activeMainOwnerKey, undefined);
});

test("a pointer drop stays stable when the preview redraw puts the source under the pointer", () => {
  const cols = 40;
  const rows = 30;
  const expected = [{
    type: "reorder-session" as const,
    source: { kind: "local" as const, id: "a" },
    target: { kind: "local" as const, id: "b" },
    placement: "after" as const,
  }];

  // The direct path: finish through the captured PREVIEW map at the unchanged
  // coordinate, with no extra motion packet.
  const direct = pointerHarness({ items: [makeItem({ id: "a" }), makeItem({ id: "b" })] });
  const directView = direct.view(cols, rows);
  const directStart = direct.presentation();
  const directDropRow = titleRow(directView, "label-b") + 4;
  assert.equal(directStart.beginSessionPointerAt(0, titleRow(directView, "label-a"), cols, rows), true);
  assert.equal(directStart.updateSessionPointerAt(0, directDropRow, cols, rows), true);
  direct.view(cols, rows);
  assert.deepEqual(visibleTitles(direct, ["label-a", "label-b"]), ["label-b", "label-a"]);
  assert.equal(direct.presentation().finishSessionPointerAt(0, directDropRow, cols, rows), true);
  assert.deepEqual(direct.focusedActions(), expected);
  assert.equal(direct.controller.focus, "sidebar");

  // Motion over the moved card after the redraw keeps the drop intent, then the
  // release through the newly captured written map commits once.
  const harness = pointerHarness({ items: [makeItem({ id: "a" }), makeItem({ id: "b" })] });
  const view = harness.view(cols, rows);
  const rowA = titleRow(view, "label-a");
  const rowB = titleRow(view, "label-b");
  const dropRow = rowB + 4; // the lower half of B (expanded local card)
  const start = harness.presentation();
  assert.equal(start.beginSessionPointerAt(0, rowA, cols, rows), true);
  assert.equal(start.updateSessionPointerAt(0, dropRow, cols, rows), true);

  // The preview frame moves A into B's old slot; the unchanged coordinate is
  // now inside the moved card itself.
  const previewView = harness.view(cols, rows);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b"]), ["label-b", "label-a"]);
  const previewPresentation = harness.presentation();
  assert.ok(dropRow >= titleRow(previewView, "label-a")
    && dropRow < titleRow(previewView, "label-a") + 5);

  // Further motion over the moved card keeps the established drop intent
  // instead of deleting the preview.
  assert.equal(previewPresentation.updateSessionPointerAt(0, dropRow, cols, rows), true);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b"]), ["label-b", "label-a"]);
  assert.deepEqual(harness.focusedActions(), []);

  // Release through the newly written preview map at the same coordinate:
  // exactly one reorder, and neither card is activated.
  harness.view(cols, rows);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b"]), ["label-b", "label-a"]);
  const finish = harness.presentation();
  assert.equal(finish.finishSessionPointerAt(0, dropRow, cols, rows), true);
  assert.deepEqual(harness.focusedActions(), expected);
  assert.equal(harness.controller.focus, "sidebar");
  assert.deepEqual(harness.controller.activeMainOwnerKey, undefined);
});

test("a release outside the session cards cancels, and host action clicks stay unchanged", () => {
  const harness = pointerHarness({ items: [makeItem({ id: "a" })] });
  const presentation = harness.presentation();
  const view = harness.view();
  const quitRow = view.findIndex((line) => line.includes("Quit host"));
  const savedRow = view.findIndex((line) => line.includes("Saved conversations"));
  const blankRow = view.findIndex((line, index) => index > quitRow + 1 && line.trim() === "");

  // A press that begins on a session card and releases on a host action row.
  assert.equal(presentation.beginSessionPointerAt(0, titleRow(view, "label-a"), 40, 30), true);
  assert.equal(presentation.updateSessionPointerAt(0, savedRow, 40, 30), true);
  assert.ok(!harness.view().some((line) => line.trim().startsWith(">>")), "no drop position off the cards");
  assert.equal(presentation.finishSessionPointerAt(0, savedRow, 40, 30), false);
  assert.equal(presentation.finishSessionPointerAt(0, blankRow, 40, 30), false);
  assert.deepEqual(harness.focusedActions(), [], "a cancelled drag emits nothing and activates nothing");

  // A press that begins ON a host action row is not a session target at all, so
  // Main's unchanged activation path keeps owning it exactly as before.
  const actions = pointerHarness({ items: [makeItem({ id: "a" })] });
  const actionView = actions.view();
  const actionPresentation = actions.presentation();
  const actionQuitRow = actionView.findIndex((line) => line.includes("Quit host"));
  const actionSavedRow = actionView.findIndex((line) => line.includes("Saved conversations"));
  assert.equal(actionPresentation.beginSessionPointerAt(0, actionSavedRow, 40, 30), false);
  assert.equal(actionPresentation.beginSessionPointerAt(0, actionQuitRow, 40, 30), false);
  assert.equal(actionPresentation.beginSessionPointerAt(0, actionView.findIndex((line, index) => index > actionQuitRow + 1 && line.trim() === ""), 40, 30), false,
    "a blank row is not a session target");
  assert.equal(actionPresentation.activateRosterAt(0, actionSavedRow, 40, 30), true);
  assert.equal(actions.controller.focus, "form", "the Saved row still opens its own existing picker");
  assert.ok(actions.focusedActions().some((action) => action.type === "saved-list"));

  const quitRowHarness = pointerHarness({ items: [makeItem({ id: "a" })] });
  const quitPresentation = quitRowHarness.presentation();
  const quitRowAt = quitRowHarness.view().findIndex((line) => line.includes("Quit host"));
  assert.equal(quitPresentation.beginSessionPointerAt(0, quitRowAt, 40, 30), false);
  assert.equal(quitPresentation.activateRosterAt(0, quitRowAt, 40, 30), true);
  assert.equal(quitRowHarness.controller.focus, "confirm",
    "the Quit row still opens its own existing confirmation");
  assert.equal(harness.controller.focus, "sidebar", "the cancelled drag left focus alone");
});

test("pointer begin refuses stale, hidden, tiny, clipped, and geometry-mismatched maps", () => {
  const harness = pointerHarness({ items: [makeItem({ id: "a" }), makeItem({ id: "b" })] });
  const presentation = harness.presentation();
  const rowA = titleRow(harness.view(), "label-a");
  assert.equal(presentation.beginSessionPointerAt(0, rowA, 44, 30), false, "a wider pane than this map");
  assert.equal(presentation.beginSessionPointerAt(0, rowA, 40, 34), false, "a taller pane than this map");
  assert.equal(presentation.beginSessionPointerAt(40, rowA, 40, 30), false, "the right edge is exclusive");
  assert.equal(presentation.beginSessionPointerAt(0, 0, 40, 30), false, "the header is not a card");

  // A newer projection invalidates the captured map rather than retargeting it.
  harness.controller.updateItems([makeItem({ id: "b" }), makeItem({ id: "a" })]);
  assert.equal(presentation.beginSessionPointerAt(0, rowA, 40, 30), false);
  assert.equal(presentation.updateSessionPointerAt(0, rowA + 1, 40, 30), false);
  assert.equal(presentation.finishSessionPointerAt(0, rowA, 40, 30), false);
  assert.deepEqual(harness.focusedActions(), []);

  // A hidden roster has no written map at all.
  const hidden = pointerHarness({ items: [makeItem({ id: "a" })] });
  const hiddenPresentation = hidden.presentation();
  const hiddenRow = titleRow(hidden.view(), "label-a");
  hidden.send(TOGGLE);
  assert.equal(hidden.controller.visible, false);
  assert.equal(hiddenPresentation.beginSessionPointerAt(0, hiddenRow, 40, 30), false);

  // A too-small pane and a clipped card expose no complete-card region.
  const tiny = pointerHarness({ items: [makeItem({ id: "a" })] });
  assert.ok(tiny.view(40, 3).some((line) => line.includes("too small")));
  assert.equal(tiny.presentation().beginSessionPointerAt(0, 1, 40, 3), false);
  const clipped = pointerHarness({ items: [makeItem({ id: "a" }), makeItem({ id: "b" }), makeItem({ id: "c" })] });
  const clippedView = clipped.view(40, 10);
  assert.ok(!clippedView.some((line) => line.includes("label-a")), "the scrolled card is not drawn");
  const clippedBlank = clippedView.findIndex((line, index) => index > 0 && line.trim() === "");
  assert.equal(clipped.presentation().beginSessionPointerAt(0, clippedBlank, 40, 10), false);
});

test("edge dragging scrolls an overflowing list so an offscreen card becomes reachable", () => {
  const harness = pointerHarness({ items: ["a", "b", "c", "d"].map((id) => makeItem({ id })) });
  harness.controller.select("a");
  const cols = 40;
  const rows = 21;
  let view = harness.view(cols, rows);
  const hiddenTitle = "label-d";
  assert.equal(titleRow(view, hiddenTitle), -1, "the tail card starts offscreen");
  const presentation = harness.presentation();
  const rowA = titleRow(view, "label-a");
  assert.equal(presentation.beginSessionPointerAt(0, rowA, cols, rows), true);

  // The last row of the list window (the blank remainder under the clipped
  // card) is the scroll edge, so a drawn card row is never stolen by scrolling.
  const edgeRow = view.findIndex((line) => line.includes("toggle")) - 1;
  assert.equal(presentation.updateSessionPointerAt(0, edgeRow, cols, rows), true);

  // The list scrolled; Main writes that frame and captures a new presentation.
  view = harness.view(cols, rows);
  assert.notEqual(titleRow(view, hiddenTitle), -1, "edge scrolling revealed the offscreen card");
  const scrolled = harness.presentation();
  const rowD = titleRow(view, hiddenTitle);
  assert.ok(rowD + 4 < edgeRow, "the revealed card is an interior drop target");
  assert.equal(scrolled.updateSessionPointerAt(0, rowD + 4, cols, rows), true);
  assert.deepEqual(harness.focusedActions(), [], "scrolling and previewing still emit nothing");
  assert.equal(scrolled.finishSessionPointerAt(0, rowD + 4, cols, rows), true);
  assert.deepEqual(harness.focusedActions(), [{
    type: "reorder-session",
    source: { kind: "local", id: "a" },
    target: { kind: "local", id: "d" },
    placement: "after",
  }], "a position that was offscreen is now a real drop target");

  // The stationary-hold seam: no timer lives in the controller, Main schedules
  // one step at a time through a captured written map, and nothing ticks
  // without an active drag.
  assert.equal(harness.presentation().tickSessionPointerEdge(), false, "no drag, no tick");
  const idle = pointerHarness({ items: ["a", "b", "c", "d"].map((id) => makeItem({ id })) });
  assert.equal(idle.presentation().tickSessionPointerEdge(), false);
});

test("a keyboard move step re-follows its source after a wheel notch moved it off-screen", () => {
  const harness = pointerHarness({ items: ["a", "b", "c", "d", "e"].map((id) => makeItem({ id })) });
  harness.controller.select("a");
  const cols = 40;
  const rows = 26;
  let view = harness.view(cols, rows);
  const rowA = titleRow(view, "label-a");
  assert.ok(rowA >= 0, "the source card starts drawn");
  // Move mode on the first card: it is marked before any destination exists.
  harness.send(MOVE);
  view = harness.view(cols, rows);
  assert.ok(view.some((line) => line.startsWith(">>")), "the card being moved is marked");
  // One wheel notch moves the single viewport past it, and the honest interim
  // state is that the moving card is off-screen.
  assert.equal(harness.presentation().scrollRosterAt(0, rowA + 2, cols, rows, 1), true,
    "the notch scrolled the drawn window");
  view = harness.view(cols, rows);
  assert.equal(titleRow(view, "label-a"), -1, "the wheel moved the moving card off-screen");
  assert.ok(!view.some((line) => line.startsWith(">>")), "an off-screen moving card draws no marker");

  // One keyboard step re-engages the follow rule: the card being moved AND the
  // destination its marker sits on return to the drawn window, and nothing was
  // committed, activated, or re-selected on the way.
  harness.send(DOWN);
  view = harness.view(cols, rows);
  assert.notEqual(titleRow(view, "label-a"), -1,
    "the step brought the moving card back into the drawn window");
  assert.ok(view.some((line) => line.startsWith(">>")), "the returned card is still marked as the one being moved");
  assert.ok(view.some((line) => /(?:\^ |v )agent /u.test(line)),
    "the destination card and its insertion marker came back with it");
  assert.deepEqual(harness.focusedActions(), [], "the wheel and the step emitted no action");
  assert.equal(harness.controller.selectedId, "a", "the wheel and the step moved no highlight");
});

test("a keyboard move down across the BOTTOM edge keeps the complete moving card and its marker drawn", () => {
  const harness = pointerHarness({ items: ["a", "b", "c", "d", "e"].map((id) => makeItem({ id })) });
  const cols = 40;
  const rows = 21; // three 5-row cards fit in this window, a fourth does not
  harness.controller.select("a");
  harness.view(cols, rows); // pins the window at the first card
  harness.controller.select("c");
  let view = harness.view(cols, rows);
  assert.notEqual(titleRow(view, "label-c"), -1, "the source card is the last card the window draws");
  assert.equal(titleRow(view, "label-d"), -1, "its destination starts off-screen below");

  harness.send(MOVE);
  harness.send(DOWN);
  view = harness.view(cols, rows);
  assert.notEqual(titleRow(view, "label-c"), -1, "the step kept the moving card inside the drawn window");
  assert.notEqual(titleRow(view, "label-d"), -1, "and drew the destination card its marker sits on");
  const marked = view.findIndex((line) => line.trim().startsWith(">>"));
  assert.ok(marked >= 1, "the moving card is marked");
  assert.ok(/^ {2}background /u.test(view[marked + 1] ?? ""),
    "the moving card stays COMPLETE rather than clipped at the window edge");
  assert.ok(view.some((line) => /(?:\^ |v )agent /u.test(line)), "the destination shows its insertion marker");
  assert.deepEqual(harness.focusedActions(), [], "a preview emits nothing at all");
  assert.equal(harness.controller.selectedId, "c", "the highlight stayed on the moving card");
});

test("a window that fits only one card keeps the COMPLETE moving card when the pair cannot fit", () => {
  const harness = pointerHarness({ items: ["a", "b", "c"].map((id) => makeItem({ id })) });
  harness.controller.select("a");
  const cols = 40;
  const rows = 10; // one 5-row card fits; a source/destination pair does not
  let view = harness.view(cols, rows);
  assert.notEqual(titleRow(view, "label-a"), -1, "the window draws the highlighted card");
  assert.equal(titleRow(view, "label-b"), -1, "and only that one card");

  harness.send(MOVE);
  harness.send(DOWN);
  view = harness.view(cols, rows);
  assert.notEqual(titleRow(view, "label-a"), -1, "the moving card stayed drawn");
  const marked = view.findIndex((line) => line.trim().startsWith(">>"));
  assert.ok(marked >= 1, "it is still marked as the card being moved");
  assert.ok(/^ {2}background /u.test(view[marked + 1] ?? ""),
    "and it is drawn COMPLETE: the window keeps the moving card, not the pair");
  assert.equal(titleRow(view, "label-b"), -1, "the destination gives way when both cannot fit");
  assert.deepEqual(harness.focusedActions(), [], "the preview emitted nothing");

  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{
    type: "reorder-session",
    source: { kind: "local", id: "a" },
    target: { kind: "local", id: "b" },
    placement: "after",
  }], "the preview the operator could see commits exactly once");
});

test("further wheel notches during a move preview keep scrolling; a step back re-follows the returning card", () => {
  const harness = pointerHarness({ items: ["a", "b", "c", "d", "e"].map((id) => makeItem({ id })) });
  const cols = 40;
  const rows = 21;
  harness.controller.select("a");
  let view = harness.view(cols, rows); // pins the window at the first card
  harness.send(MOVE);
  harness.send(DOWN); // the preview is B,A,C,D,E: the moving card sits at projected index 1
  view = harness.view(cols, rows);
  assert.notEqual(titleRow(view, "label-a"), -1, "the previewed card is drawn");
  const rowA = titleRow(view, "label-a");
  const presentation = harness.presentation();

  assert.equal(presentation.scrollRosterAt(0, rowA + 2, cols, rows, 1), true, "the first notch scrolls");
  view = harness.view(cols, rows);
  assert.notEqual(titleRow(view, "label-c"), -1, "the notch brought later rows into view");
  assert.equal(presentation.scrollRosterAt(0, rowA + 2, cols, rows, 1), true, "a second notch is accepted");
  view = harness.view(cols, rows);
  assert.equal(titleRow(view, "label-a"), -1,
    "the further notch kept scrolling instead of snapping the window back to a card whose projected index never changed");
  assert.notEqual(titleRow(view, "label-e"), -1, "and the last session row is now drawn");

  // One step back returns the card to the index the retained render recorded it
  // at BEFORE the preview moved it, which is exactly what re-engages following.
  harness.send(UP);
  view = harness.view(cols, rows);
  assert.notEqual(titleRow(view, "label-a"), -1,
    "the step back re-followed the card returning to its original index");
  const marked = view.findIndex((line) => line.trim().startsWith(">>"));
  assert.ok(marked >= 1, "the returning card is marked as the one being moved");
  assert.ok(view.some((line) => /(?:\^ |v )agent /u.test(line)), "with its destination marker beside it");
  assert.deepEqual(harness.focusedActions(), [], "no notch or step emitted an action");
  assert.equal(harness.controller.selectedId, "a", "no gesture moved the highlight");
});

test("a wheel notch over a live drag preview scrolls the window that written preview drew", () => {
  const harness = pointerHarness({ items: ["a", "b", "c", "d"].map((id) => makeItem({ id })) });
  harness.controller.select("a");
  const cols = 40;
  const rows = 21;
  const titles = ["label-a", "label-b", "label-c", "label-d"];
  let view = harness.view(cols, rows);
  assert.equal(titleRow(view, "label-d"), -1, "the tail card starts offscreen");
  const pressed = harness.presentation();
  assert.equal(pressed.beginSessionPointerAt(0, titleRow(view, "label-a"), cols, rows), true);
  // A live preview: this written window now draws the previewed order while the
  // committed order stays untouched.
  assert.equal(pressed.updateSessionPointerAt(0, titleRow(view, "label-b") + 4, cols, rows), true);
  view = harness.view(cols, rows);
  assert.deepEqual(visibleTitles(harness, titles, cols, rows), ["label-b", "label-a", "label-c"],
    "the previewed order is what this written window draws");
  const selectedBefore = harness.controller.selectedId;

  // The wheel applies to THAT preview geometry: one notch reveals the preview's
  // next entry, keeps whole cards on screen, and ends nothing.
  const previewed = harness.presentation();
  assert.equal(previewed.scrollRosterAt(0, titleRow(view, "label-b") + 4, cols, rows, 1), true,
    "a notch over the drawn preview scrolls that window");
  const after = harness.view(cols, rows);
  const revealed = titles.filter((title) => titleRow(after, title) >= 0);
  assert.notDeepEqual(revealed, ["label-b", "label-a", "label-c"], "the previewed window moved");
  assert.ok(revealed.includes("label-d"), "the notch revealed the preview's offscreen tail card");
  assert.ok(revealed.length >= 2, "the previewed window still draws whole cards, never a blank page");
  assert.deepEqual(harness.focusedActions(), [], "the preview and the wheel emitted no action");
  assert.equal(harness.controller.selectedId, selectedBefore, "the wheel moved no highlight");
  assert.equal(harness.controller.sessionPointerActive, true, "the wheel did not end the held drag");
  // The wheel stays usable: a previewed notch never left a window with no drawn
  // entry behind, which is what would disable every later notch.
  assert.equal(harness.presentation().scrollRosterAt(0, titleRow(after, "label-a") + 1, cols, rows, -1), true,
    "a following notch still scrolls the same single viewport");
});

test("mixed-height overflow drops survive a preview redraw", () => {
  const harness = makeHarness({
    items: ["a", "c", "d"].map((id) => makeItem({ id })),
    hosts: [makeHost({
      id: "host1", hostRunId: "run-1", rows: [makeRemoteRow({ id: "b" })],
    })],
    order: [
      { kind: "local", id: "a" },
      { kind: "remote", hostId: "host1", hostRunId: "run-1", rowId: "b" },
      { kind: "local", id: "c" },
      { kind: "local", id: "d" },
    ],
  });
  harness.controller.select("a");
  const cols = 40;
  const rows = 22;
  let view = harness.view(cols, rows);
  const start = harness.presentation();
  const edge = view.findIndex((line) => line.includes("toggle")) - 1;
  assert.equal(titleRow(view, "label-d"), -1);
  assert.equal(start.beginSessionPointerAt(0, titleRow(view, "label-a"), cols, rows), true);
  assert.equal(start.updateSessionPointerAt(0, edge, cols, rows), true);
  view = harness.view(cols, rows);
  const dropRow = titleRow(view, "label-d") + 4;
  assert.ok(titleRow(view, "label-b") > 0);
  assert.ok(titleRow(view, "label-d") > 0 && dropRow < edge);
  assert.equal(harness.presentation().updateSessionPointerAt(0, dropRow, cols, rows), true);
  harness.view(cols, rows);
  assert.equal(harness.presentation().finishSessionPointerAt(0, dropRow, cols, rows), true);
  assert.deepEqual(harness.focusedActions(), [{
    type: "reorder-session",
    source: { kind: "local", id: "a" },
    target: { kind: "local", id: "d" },
    placement: "after",
  }]);
});

test("an edge step never lands the one window on a card too tall to draw, in either direction", () => {
  // The renderer draws only COMPLETE cards, so a window landed on a card taller
  // than the list rows would draw nothing at all. The wheel refuses that
  // destination (#439); a pointer edge step is the same mover and must refuse it
  // in both directions instead of leaving a blank pane the drag cannot escape.
  const harness = makeHarness({
    items: [makeItem({ id: "a" }), makeItem({ id: "c" })],
    hosts: [makeHost({
      id: "host1", hostRunId: "run-1", rows: [makeRemoteRow({ id: "b" })],
    })],
    order: [
      { kind: "local", id: "a" },
      { kind: "remote", hostId: "host1", hostRunId: "run-1", rowId: "b" },
      { kind: "local", id: "c" },
    ],
  });
  harness.controller.select("a");
  const cols = 40;
  // A five-row list window: the selected 5-row local card fits completely, the
  // 6-row remote card below it does not.
  const rows = 10;
  let view = harness.view(cols, rows);
  const edgeRow = view.findIndex((line) => line.includes("toggle")) - 1;
  assert.equal(edgeRow, 5, "the list window is exactly five rows");
  const rowA = titleRow(view, "label-a");
  assert.ok(rowA > 0, "the selected local card is drawn whole");
  assert.equal(titleRow(view, "label-b"), -1, "the taller remote card starts off-screen");
  assert.equal(titleRow(view, "label-c"), -1, "and so does the card after it");
  harness.baseline = harness.actions.length;

  const start = harness.presentation();
  assert.equal(start.beginSessionPointerAt(0, rowA, cols, rows), true, "the card press is captured");
  assert.equal(start.updateSessionPointerAt(0, edgeRow, cols, rows), true,
    "the bottom-edge motion stays host-owned");
  view = harness.view(cols, rows);
  assert.notEqual(titleRow(view, "label-a"), -1,
    "the refused step kept the usable window instead of landing on the too-tall card");
  assert.equal(titleRow(view, "label-b"), -1,
    "the too-tall card was never scrolled to the top of the window");
  assert.equal(harness.controller.sessionPointerActive, true, "the drag stays alive over a refused step");
  assert.deepEqual(harness.focusedActions(), [], "a refused step emits nothing");
  assert.equal(harness.presentation().finishSessionPointerAt(0, edgeRow, cols, rows), false,
    "the blank remainder under a clipped non-final card is still not an end drop");
  assert.deepEqual(harness.focusedActions(), [], "and that release commits nothing");
  assert.equal(harness.controller.sessionPointerActive, false, "and ends the interaction");

  // Normal navigation and the one viewport are unharmed: selecting the last card
  // moves the SAME window and draws it whole.
  harness.controller.select("c");
  view = harness.view(cols, rows);
  const rowC = titleRow(view, "label-c");
  assert.ok(rowC > 0, "selection still moves the one window to the last card");

  // The reverse direction under the same constraint: the top edge cannot land
  // the window back on the too-tall card.
  const atTail = harness.presentation();
  assert.equal(atTail.beginSessionPointerAt(0, rowC, cols, rows), true);
  assert.equal(atTail.updateSessionPointerAt(0, 1, cols, rows), true, "the top-edge motion stays host-owned");
  view = harness.view(cols, rows);
  assert.notEqual(titleRow(view, "label-c"), -1, "the refused upward step kept the drawn card");
  assert.equal(titleRow(view, "label-b"), -1, "and never landed the window on the too-tall card");

  // The wheel is bounded by the same rule, so it refuses the same destination
  // and leaves the usable window drawn rather than blanking the pane.
  assert.equal(harness.presentation().scrollRosterAt(0, rowC + 1, cols, rows, -1), false,
    "the wheel refuses the same unusable destination");
  assert.notEqual(titleRow(harness.view(cols, rows), "label-c"), -1,
    "and the single viewport stays usable");
  harness.controller.cancelSessionPointer();
  assert.equal(harness.controller.sessionPointerActive, false, "cleanup retires the interaction");
  assert.deepEqual(harness.focusedActions(), [], "and nothing was ever emitted");
});

test("stationary edge ticks advance only from a captured written presentation", () => {
  const harness = pointerHarness({ items: ["a", "b", "c", "d"].map((id) => makeItem({ id })) });
  harness.controller.select("a");
  const cols = 40;
  const rows = 16;
  let view = harness.view(cols, rows);
  const written = harness.presentation();
  const rowA = titleRow(view, "label-a");
  const edgeRow = view.findIndex((line) => line.includes("toggle")) - 1;
  assert.equal(written.beginSessionPointerAt(0, rowA, cols, rows), true);
  assert.equal(written.updateSessionPointerAt(0, edgeRow, cols, rows), true);
  assert.equal(written.tickSessionPointerEdge(), false,
    "a tick cannot advance twice before the scrolled frame is written");

  // Render the next frame but do not present it as written. The old written
  // map must not advance using that new render.
  view = harness.view(cols, rows);
  const unwritten = harness.presentation();
  assert.equal(titleRow(view, "label-d"), -1, "one step has not revealed the tail");
  assert.equal(written.tickSessionPointerEdge(), false,
    "the oldest written map cannot consume a newer unwritten render");
  view = harness.view(cols, rows);
  assert.equal(titleRow(view, "label-d"), -1, "no tick advanced off the unwritten frame");

  // Once that captured frame is the written presentation, one tick may advance.
  assert.equal(unwritten.tickSessionPointerEdge(), true);
  assert.equal(unwritten.tickSessionPointerEdge(), false,
    "one written frame authorizes exactly one edge step");
  view = harness.view(cols, rows);
  assert.notEqual(titleRow(view, "label-d"), -1,
    "a written presentation authorizes the next edge step");
});

test("cancelSessionPointer retires the interaction for lifecycle cleanup with no action", () => {
  const harness = pointerHarness({ items: [makeItem({ id: "a" }), makeItem({ id: "b" })] });
  const presentation = harness.presentation();
  const view = harness.view();
  const rowA = titleRow(view, "label-a");
  const rowB = titleRow(view, "label-b");
  assert.equal(presentation.beginSessionPointerAt(0, rowA, 40, 30), true);
  assert.equal(presentation.updateSessionPointerAt(0, rowB + 4, 40, 30), true);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b"]), ["label-b", "label-a"]);
  harness.controller.cancelSessionPointer();
  assert.equal(harness.controller.sessionPointerActive, false);
  assert.equal(harness.controller.sessionMoveActive, false);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b"]), ["label-a", "label-b"],
    "an abandoned interaction never persists a preview");
  assert.equal(presentation.finishSessionPointerAt(0, rowB + 4, 40, 30), false, "no replay after cleanup");
  assert.deepEqual(harness.focusedActions(), []);
});

// ---------------------------------------------------------------------------
// Discoverability: the move key, the card being moved, and the drop position.
// ---------------------------------------------------------------------------

test("the default roster footer advertises m move without costing the list a row", () => {
  const harness = makeHarness({ items: [makeItem({ id: "a" }), makeItem({ id: "b" })] });
  // 32 columns is the wide layout's real sidebar width; the others are widths a
  // full-width roster takes. Wherever every roster row still fits, the wrapped
  // footer carries the move key and loses no other hint.
  for (const [cols, rows] of [[20, 30], [32, 22], [32, 30], [40, 22], [40, 30], [60, 22]] as const) {
    const footer = footerRows(harness.view(cols, rows)).join(" ");
    assert.ok(footer.includes("m move"), `m move missing at ${cols}x${rows}: ${footer}`);
    for (const hint of ["toggle", "enter open", "e edit name", "d stop/remove",
      "esc hide", "q quit", "space expand", "alt+right main"]) {
      assert.ok(footer.includes(hint), `${hint} still advertised at ${cols}x${rows}: ${footer}`);
    }
    for (const line of footerRows(harness.view(cols, rows))) {
      assert.ok(!line.includes("..."), `a hint segment was ellipsized at ${cols}x${rows}: ${JSON.stringify(line)}`);
    }
  }
  // The affordance costs no session card and no unchanged host action row at
  // the production 32-column width.
  const wide = harness.view(32, 22);
  for (const title of ["label-a", "label-b"]) {
    assert.ok(titleRow(wide, title) >= 0, `the card ${title} stays drawn at 32x22: ${JSON.stringify(wide)}`);
  }
  staticRowsAfterSessions(harness, 32, 22);

  // An overflowing roster keeps its affordance: the extra segment wraps into no
  // additional footer row at these widths, so the drawn geometry is identical
  // with and without it and the list loses nothing.
  for (const [cols, rows] of [[160, 30], [60, 30], [44, 30], [32, 30]] as const) {
    const many = makeHarness({ items: ["a", "b", "c", "d", "e", "f"].map((id) => makeItem({ id })) });
    const view = many.view(cols, rows);
    const drawn = view.filter((line) => line.trim().startsWith("label-")).length;
    assert.ok(drawn < 6, `this roster really overflows at ${cols}x${rows}: ${JSON.stringify(view)}`);
    const footer = footerRows(view).join(" ");
    assert.ok(footer.includes("m move"), `an overflowing roster still advertises m move at ${cols}x${rows}: ${footer}`);
    for (const hint of ["toggle", "enter open", "e edit name", "d stop/remove",
      "esc hide", "q quit", "space expand", "alt+right main"]) {
      assert.ok(footer.includes(hint), `${hint} still advertised at ${cols}x${rows}: ${footer}`);
    }
    // Complete-card safety holds regardless: the highlighted entry is drawn
    // whole, and the window still shows entry rows.
    many.controller.select("d");
    const selected = many.view(cols, rows);
    const selectedRow = titleRow(selected, "label-d");
    assert.ok(selectedRow >= 0, `the highlighted card is drawn at ${cols}x${rows}: ${JSON.stringify(selected)}`);
    for (let row = selectedRow; row < selectedRow + 5; row += 1) {
      assert.ok(row < selected.length && !selected[row].includes("too small"),
        `the highlighted card is not clipped at ${cols}x${rows}`);
    }
  }

  // A pane where the extra wrapped footer row WOULD clip the highlighted card
  // keeps its existing footer, its card, and its ordinary rendering: the
  // affordance steps back rather than pushing the highlighted card out or
  // turning the pane into the too-small message.
  const tight = makeHarness({ items: [makeItem({ id: "a" })] });
  tight.controller.select("a");
  const tightView = tight.view(40, 9);
  assert.ok(!tightView.some((line) => line.includes("too small")), "a short pane still shows its roster");
  assert.ok(titleRow(tightView, "label-a") >= 0, `and still draws its card: ${JSON.stringify(tightView)}`);
  assert.ok(!footerRows(tightView).join(" ").includes("m move"),
    `the shorter footer keeps its existing rows: ${JSON.stringify(footerRows(tightView))}`);
  // One row taller and the highlighted card still fits completely, so the same
  // roster advertises the key again while drawing exactly the same card.
  const roomier = tight.view(40, 10);
  assert.ok(footerRows(roomier).join(" ").includes("m move"), "the affordance returns when the pane absorbs the row");
  assert.ok(titleRow(roomier, "label-a") >= 0, "with the card still drawn completely");
  assert.ok(roomier.some((line) => line.includes("agent unknown")), "and the whole card still rendered");

  // Nothing to move, nothing advertised: an empty roster and a Main-focused
  // roster (where the key does not act) keep the shorter footer.
  const empty = makeHarness({ items: [] });
  assert.ok(!footerRows(empty.view(32, 22)).join(" ").includes("m move"),
    "a roster with no session card advertises no move key");
  const mainFocused = makeHarness({ items: [makeItem({ id: "a" })] });
  mainFocused.view(32, 22);
  mainFocused.send(RETURN);
  assert.equal(mainFocused.controller.focus, "main");
  assert.ok(!footerRows(mainFocused.view(32, 22)).join(" ").includes("m move"),
    "the sidebar-only move key is not advertised while Main owns focus");
});

test("entering move mode marks the card being moved before any destination exists", () => {
  const harness = moveHarness(["a", "b", "c"], "b");
  harness.send(MOVE);
  assert.equal(harness.controller.sessionMoveActive, true);
  const view = harness.view();
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]),
    ["label-a", "label-b", "label-c"], "entering the mode changes no order");
  assert.ok(markerRowOf(view, "label-b").trim().startsWith(">>"),
    "the pane names the card being moved as soon as the mode is entered");
  for (const title of ["label-a", "label-c"]) {
    const marker = markerRowOf(view, title).trim();
    assert.ok(!marker.startsWith("^") && !marker.startsWith("v"),
      `${title} carries no insertion marker before a position is previewed: ${JSON.stringify(marker)}`);
  }
  assert.ok(!view.some((line) => line.includes("end of sessions")),
    "no end position exists before a pointer drop previews one");
  assert.deepEqual(harness.focusedActions(), [], "the mode itself emits nothing");

  // A held-mode key that cannot preview (no wrap past the first position) still
  // leaves the source indicated, so the operator always sees which card is armed.
  const first = moveHarness(["a", "b", "c"], "a");
  first.send(MOVE);
  first.send(UP);
  assert.deepEqual(visibleTitles(first, ["label-a", "label-b", "label-c"]),
    ["label-a", "label-b", "label-c"], "no wrap past the first position");
  assert.ok(markerRowOf(first.view(), "label-a").trim().startsWith(">>"),
    "the source stays indicated even with no destination at all");
});

test("a previewed move marks which side of the destination card it lands on", () => {
  const harness = pointerHarness({
    items: [makeItem({ id: "a" })],
    hosts: [makeHost({ id: "host1", hostRunId: "run-1", rows: [makeRemoteRow({ id: "r1" })] })],
  });
  const presentation = harness.presentation();
  const view = harness.view();
  const rowA = titleRow(view, "label-a");
  const remoteTop = titleRow(view, "label-r1");
  assert.ok(remoteTop > rowA);
  assert.equal(presentation.beginSessionPointerAt(0, rowA, 40, 30), true);

  // The pointer's UPPER half over the remote destination: the destination card
  // itself marks an insert ABOVE it, in its own marker column.
  assert.equal(presentation.updateSessionPointerAt(0, remoteTop + 1, 40, 30), true);
  let preview = harness.view();
  assert.ok(markerRowOf(preview, "label-r1", true).trim().startsWith("^"),
    `the destination marks an insert before it: ${JSON.stringify(markerRowOf(preview, "label-r1", true))}`);
  assert.ok(!markerRowOf(preview, "label-r1", true).trim().startsWith("v"));
  assert.ok(markerRowOf(preview, "label-a").trim().startsWith(">>"), "the moving card stays marked");
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-r1"]), ["label-a", "label-r1"],
    "a before-preview keeps the source on this side of the destination");
  assert.deepEqual(harness.focusedActions(), [], "the marker is display only");

  // The pointer's LOWER half: the SAME row flips to an insert BELOW it.
  assert.equal(presentation.updateSessionPointerAt(0, remoteTop + 5, 40, 30), true);
  preview = harness.view();
  assert.ok(markerRowOf(preview, "label-r1", true).trim().startsWith("v"),
    `the destination marks an insert after it: ${JSON.stringify(markerRowOf(preview, "label-r1", true))}`);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-r1"]), ["label-r1", "label-a"],
    "the preview shows the resulting order beside the marker");

  // The marker lives in the card's own two marker cells, so a narrow roster
  // keeps it: it can never be ellipsized away. (16 columns is the narrowest
  // pane this roster can draw at all; below that the honest too-small message
  // replaces every row and no card exists to mark.)
  const narrow = harness.view(16, 30);
  assert.ok(markerRowOf(narrow, "label-r1", true).startsWith("v"),
    `the insertion marker survives a 16-column roster: ${JSON.stringify(narrow)}`);

  // A keyboard preview carries the same marker on the same row.
  const keyboard = moveHarness(["a", "b", "c"], "a");
  keyboard.send(MOVE);
  keyboard.send(DOWN);
  const keyboardView = keyboard.view();
  assert.ok(markerRowOf(keyboardView, "label-b").trim().startsWith("v"),
    `a keyboard step marks after its neighbour: ${JSON.stringify(markerRowOf(keyboardView, "label-b"))}`);
  assert.deepEqual(keyboard.focusedActions(), []);
});

test("a blank row under the drawn session cards is the end of the session list", () => {
  const harness = pointerHarness({
    items: [makeItem({ id: "a" }), makeItem({ id: "b" }), makeItem({ id: "c" })],
  });
  const presentation = harness.presentation();
  const view = harness.view(40, 30);
  const rowA = titleRow(view, "label-a");
  const quitRow = view.findIndex((line) => line.includes("Quit host"));
  const endRow = view.findIndex((line, index) => index > quitRow && line.trim() === "");
  assert.ok(endRow > 0, `the window leaves blank space under the cards: ${JSON.stringify(view)}`);
  // This window's blank remainder happens to sit BELOW the drawn action rows.
  // It is still the END of the SESSION list, because the session cards this map
  // draws already include the list's last session card: the append lands after
  // that card, the action rows keep their own relative order after every session
  // card, and no row an entry occupies is ever a drop position (pinned below).
  assert.ok(endRow > quitRow, "the end position is blank space, never an entry row");

  assert.equal(presentation.beginSessionPointerAt(0, rowA, 40, 30), true);
  assert.equal(presentation.updateSessionPointerAt(0, endRow, 40, 30), true);

  // The preview is visible AND carries its own end-of-list marker in one row the
  // window already left blank: the moved card sits after the last session card
  // and before the unchanged host action rows.
  const preview = harness.view(40, 30);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]),
    ["label-b", "label-c", "label-a"], "the end position appends after the last session card");
  staticRowsAfterSessions(harness);
  assert.ok(markerRowOf(preview, "label-a").trim().startsWith(">>"), "the moving card is marked");
  const markerRow = preview.findIndex((line) => line.includes("end of sessions"));
  assert.ok(markerRow > 0, `the end position is marked visibly: ${JSON.stringify(preview)}`);
  assert.ok(!preview.some((line, index) => index > 0 && index !== markerRow
    && titleRow(preview, "label-a") < index && line.includes("end of sessions")),
    "the marker is drawn once");
  assert.deepEqual(harness.focusedActions(), [], "an end preview emits nothing at all");

  // Main writes that preview frame and drives the release through the map it
  // captured for it: the release stays in the same end position, so the append
  // commits exactly once, naming the last session card.
  const written = harness.presentation();
  assert.equal(written.finishSessionPointerAt(0, endRow, 40, 30), true);
  assert.deepEqual(harness.focusedActions(), [{
    type: "reorder-session",
    source: { kind: "local", id: "a" },
    target: { kind: "local", id: "c" },
    placement: "after",
  }], "one append, and no card was activated");
  assert.equal(harness.controller.sessionPointerActive, false);
  assert.equal(harness.controller.focus, "sidebar", "an end drop never takes input ownership");
  assert.deepEqual(harness.controller.activeMainOwnerKey, undefined);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]),
    ["label-a", "label-b", "label-c"],
    "the committed order is still Main's, so nothing moves until Main reports it");

  // The last session card has no position after ITSELF: the same blank space is
  // simply not a drop for it, so nothing is previewed, marked, or emitted.
  const tail = pointerHarness({ items: ["a", "b", "c"].map((id) => makeItem({ id })) });
  const tailView = tail.view(40, 30);
  const tailEnd = tailView.findIndex((line, index) => index
    > tailView.findIndex((line) => line.includes("Quit host")) && line.trim() === "");
  const tailPress = tail.presentation();
  assert.equal(tailPress.beginSessionPointerAt(0, titleRow(tailView, "label-c"), 40, 30), true);
  assert.equal(tailPress.updateSessionPointerAt(0, tailEnd, 40, 30), true);
  const tailPreview = tail.view(40, 30);
  assert.ok(!tailPreview.some((line) => line.includes("end of sessions")),
    `the last card is offered no position after itself: ${JSON.stringify(tailPreview)}`);
  const tailWritten = tail.presentation();
  assert.equal(tailWritten.finishSessionPointerAt(0, tailEnd, 40, 30), false,
    "and releasing there is not a drop");
  assert.deepEqual(tail.focusedActions(), []);

  // The end drop is committed only through the captured map that actually drew
  // the preview. A release handed to the map drawn BEFORE the preview frame
  // fails closed and emits nothing, exactly like every other pointer seam here:
  // Main drives the release on the presentation whose frame it wrote.
  const staleMap = pointerHarness({ items: ["a", "b", "c"].map((id) => makeItem({ id })) });
  const staleView = staleMap.view(40, 30);
  const staleEnd = staleView.findIndex((line, index) => index
    > staleView.findIndex((line) => line.includes("Quit host")) && line.trim() === "");
  const before = staleMap.presentation();
  assert.equal(before.beginSessionPointerAt(0, titleRow(staleView, "label-a"), 40, 30), true);
  assert.equal(before.updateSessionPointerAt(0, staleEnd, 40, 30), true);
  staleMap.view(40, 30); // the preview frame is rendered; the older map did not draw it
  assert.equal(before.finishSessionPointerAt(0, staleEnd, 40, 30), false,
    "a map that did not draw the preview cannot commit the end drop");
  assert.deepEqual(staleMap.focusedActions(), [], "and it commits nothing at all");
  assert.deepEqual(visibleTitles(staleMap, ["label-a", "label-b", "label-c"]),
    ["label-a", "label-b", "label-c"], "the retired preview leaves the committed order standing");
});

test("continued motion inside the end position keeps the append and commits once", () => {
  const harness = pointerHarness({ items: ["a", "b", "c"].map((id) => makeItem({ id })) });
  const view = harness.view(40, 30);
  const quitRow = view.findIndex((line) => line.includes("Quit host"));
  const endRow = view.findIndex((line, index) => index > quitRow && line.trim() === "");
  const first = harness.presentation();
  assert.equal(first.beginSessionPointerAt(0, titleRow(view, "label-a"), 40, 30), true);
  assert.equal(first.updateSessionPointerAt(0, endRow, 40, 30), true);
  let preview = harness.view(40, 30);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]),
    ["label-b", "label-c", "label-a"], "the first motion previews the append");
  assert.ok(preview.some((line) => line.includes("end of sessions")), "with the end marker visible");

  // Main wrote that preview frame, so the next motion packet arrives on the map
  // that DREW it. The moved card now sits at the session-list tail, and the
  // pointer is still inside the same blank end position below it: the append
  // survives repeated motion instead of being cancelled by the redraw.
  const second = harness.presentation();
  assert.equal(second.updateSessionPointerAt(0, endRow + 1, 40, 30), true);
  preview = harness.view(40, 30);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]),
    ["label-b", "label-c", "label-a"], "the previewed append survives another motion packet");
  assert.ok(preview.some((line) => line.includes("end of sessions")),
    `the end marker stays visible across the redraw: ${JSON.stringify(preview)}`);
  assert.deepEqual(harness.focusedActions(), [], "and it still emits nothing");

  // Motion over the moved card at the tail keeps the same frozen position too.
  const third = harness.presentation();
  assert.equal(third.updateSessionPointerAt(0, titleRow(preview, "label-a") + 1, 40, 30), true);
  preview = harness.view(40, 30);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]),
    ["label-b", "label-c", "label-a"], "the position is unchanged");
  assert.deepEqual(harness.focusedActions(), []);

  // Leaving the end position still retakes the drop intent: a packet over a
  // host action row drops the preview exactly as before.
  const fourth = harness.presentation();
  assert.equal(fourth.updateSessionPointerAt(0, quitRow, 40, 30), true);
  const cleared = harness.view(40, 30);
  assert.ok(!cleared.some((line) => line.includes("end of sessions")),
    `leaving the end position clears it: ${JSON.stringify(cleared)}`);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]),
    ["label-a", "label-b", "label-c"], "and the committed order shows again");

  // Back inside the end position, then release: exactly one append DTO.
  const fifth = harness.presentation();
  assert.equal(fifth.updateSessionPointerAt(0, endRow + 1, 40, 30), true);
  assert.ok(harness.view(40, 30).some((line) => line.includes("end of sessions")),
    "re-entering the end position previews it again");
  const written = harness.presentation();
  assert.equal(written.finishSessionPointerAt(0, endRow + 1, 40, 30), true);
  assert.deepEqual(harness.focusedActions(), [{
    type: "reorder-session",
    source: { kind: "local", id: "a" },
    target: { kind: "local", id: "c" },
    placement: "after",
  }], "one append after all that motion, and nothing else");
});

test("a remainder under a clipped non-final card and every action row are never the end", () => {
  // An overflowing window whose tail card is clipped shows blank space under a
  // card that is NOT the end of the session list. That remainder is not an end
  // position, and the window still scrolls instead of pretending to be finished.
  const harness = pointerHarness({ items: ["a", "b", "c", "d"].map((id) => makeItem({ id })) });
  harness.controller.select("a");
  const cols = 40;
  const rows = 17;
  const view = harness.view(cols, rows);
  assert.notEqual(titleRow(view, "label-a"), -1);
  assert.notEqual(titleRow(view, "label-b"), -1);
  assert.equal(titleRow(view, "label-c"), -1, "a non-final card is clipped out of this window");
  const lastDrawnRow = titleRow(view, "label-b");
  const remainder = view.findIndex((line, index) => index > lastDrawnRow + 4 && line.trim() === "");
  assert.ok(remainder > 0 && remainder < rows - 4, `the remainder is inside the window: ${JSON.stringify(view)}`);

  const presentation = harness.presentation();
  assert.equal(presentation.beginSessionPointerAt(0, titleRow(view, "label-a"), cols, rows), true);
  assert.equal(presentation.updateSessionPointerAt(0, remainder, cols, rows), true);
  const after = harness.view(cols, rows);
  assert.ok(!after.some((line) => line.includes("end of sessions")),
    `a clipped non-final remainder never claims the session-list end: ${JSON.stringify(after)}`);
  assert.ok(!after.some((line) => line.trim().startsWith(">>")), "and it previews no position");
  assert.deepEqual(harness.focusedActions(), []);

  // A release inside that same remainder is not a drop: the drag simply cancels.
  const written = harness.presentation();
  assert.equal(written.finishSessionPointerAt(0, remainder, cols, rows), false);
  assert.deepEqual(harness.focusedActions(), [], "and it emits nothing");

  // The host action rows themselves are never drop targets, even in a window
  // that DOES show the end of the session list.
  const full = pointerHarness({ items: ["a", "b", "c"].map((id) => makeItem({ id })) });
  const fullPresentation = full.presentation();
  const fullView = full.view(40, 30);
  assert.equal(fullPresentation.beginSessionPointerAt(0, titleRow(fullView, "label-a"), 40, 30), true);
  for (const label of ["Saved conversations", "New session", "Quit host"]) {
    const actionRow = fullView.findIndex((line) => line.includes(label));
    assert.ok(actionRow > 0);
    assert.equal(fullPresentation.updateSessionPointerAt(0, actionRow, 40, 30), true);
    assert.ok(!full.view(40, 30).some((line) => line.includes("end of sessions")),
      `the ${label} row is not an end position`);
    assert.ok(!full.view(40, 30).some((line) => line.trim().startsWith(">>")),
      `the ${label} row previews nothing`);
  }
  const actionRelease = full.presentation();
  assert.equal(actionRelease.finishSessionPointerAt(
    0,
    fullView.findIndex((line) => line.includes("Quit host")),
    40,
    30,
  ), false, "a release on a host action row is not a drop");
  assert.deepEqual(full.focusedActions(), [], "and it emits nothing");
});

// ---------------------------------------------------------------------------
// The still-visible left roster beside a right-hand host UI.
// ---------------------------------------------------------------------------

test("a session card visible beside an open picker holds the press and acts on release", () => {
  const harness = makeHarness({ items: [makeItem({ id: "a" }), makeItem({ id: "b" })] });
  // Open the Saved picker the way a roster click does.
  const opened = harness.rosterView();
  const savedRow = opened.findIndex((line) => line.includes("Saved conversations"));
  assert.equal(harness.presentation().activateRosterAt(0, savedRow, 40, 30), true);
  assert.equal(harness.controller.focus, "form");
  harness.baseline = harness.actions.length;

  // The wide layout still draws the left roster beside the picker, so its
  // session cards keep their ordinary click-on-RELEASE semantics.
  const roster = harness.rosterView();
  const rowA = titleRow(roster, "label-a");
  const rowB = titleRow(roster, "label-b");
  assert.ok(rowA > 0 && rowB > 0, `both session cards stay clickable: ${JSON.stringify(roster)}`);
  const pressed = harness.presentation();
  assert.equal(pressed.beginSessionPointerAt(0, rowA, 40, 30), true,
    "the press is held instead of acting on the press itself");
  assert.equal(harness.controller.sessionPointerActive, true);
  assert.deepEqual(harness.focusedActions(), [],
    "the initial press cancels the picker and activates nothing");
  assert.equal(harness.controller.focus, "form", "the picker is still open while the press is held");
  assert.equal(harness.controller.selectedId, undefined, "a press does not even select");

  // Release on the same card: the picker's OWN cancellation route, then that
  // row's ordinary action, exactly once.
  assert.equal(pressed.finishSessionPointerAt(0, rowA, 40, 30), true);
  const types = harness.focusedActions().map((action) => action.type);
  assert.deepEqual(types, ["saved-dismiss", "saved-cancel", "select"],
    "the pane's own dismissal runs once, then one activation");
  assert.deepEqual(harness.focusedActions().filter((action) => action.type === "select"),
    [{ type: "select", id: "a" }]);
  assert.equal(harness.controller.sessionPointerActive, false);
  assert.equal(harness.controller.selectedId, "a");
  assert.equal(harness.controller.focus, "main", "the activated row owns the pane again");
});

test("the already-highlighted row keeps its no-op while a right-hand pane stays open", () => {
  const harness = makeHarness({ items: [makeItem({ id: "a" }), makeItem({ id: "b" })] });
  const opened = harness.rosterView();
  assert.equal(harness.presentation().activateRosterAt(
    0,
    opened.findIndex((line) => line.includes("Saved conversations")),
    40,
    30,
  ), true);
  // A backend selection moves the LEFT highlight onto a session card while the
  // picker keeps the right pane and its draft.
  harness.controller.select("a");
  harness.baseline = harness.actions.length;
  const roster = harness.rosterView();
  const rowA = titleRow(roster, "label-a");
  assert.ok(markerRowOf(roster, "label-a").startsWith(">"), "the drawn highlight is on that card");

  const pressed = harness.presentation();
  assert.equal(pressed.beginSessionPointerAt(0, rowA, 40, 30), true);
  assert.equal(pressed.finishSessionPointerAt(0, rowA, 40, 30), true,
    "the click is handled, and handled by doing nothing at all");
  assert.deepEqual(harness.focusedActions(), [],
    "no cancellation, no activation, no reorder, nothing emitted");
  assert.equal(harness.controller.focus, "form", "the pane and its draft stay open exactly as they were");
  assert.equal(harness.controller.selectedId, "a", "and the selection is untouched");
  assert.ok(harness.rosterView().some((line) => line.includes("Saved conversations")),
    "the picker is still drawn beside the roster");
});

test("a drag beside an open pane never cancels it, activates a row, or touches the owner", () => {
  const harness = makeHarness({ items: [makeItem({ id: "a" }), makeItem({ id: "b" })] });
  const opened = harness.rosterView();
  assert.equal(harness.presentation().activateRosterAt(
    0,
    opened.findIndex((line) => line.includes("New session")),
    40,
    30,
  ), true, "the New form opens as the right-hand pane");
  assert.equal(harness.controller.focus, "form");
  // A real draft in the form, so a drag's effect on it is observable.
  harness.send("draft-workspace");
  assert.ok(harness.view().some((line) => line.includes("draft-workspace")), "the form shows its draft");
  harness.baseline = harness.actions.length;
  harness.controller.setActiveMainOwnerKey({ kind: "local", id: "b" });

  const roster = harness.rosterView();
  const rowA = titleRow(roster, "label-a");
  const rowB = titleRow(roster, "label-b");
  const pressed = harness.presentation();
  assert.equal(pressed.beginSessionPointerAt(0, rowA, 40, 30), true);
  assert.deepEqual(harness.focusedActions(), [], "the press touches no pane");
  assert.equal(pressed.updateSessionPointerAt(0, rowB + 4, 40, 30), true);
  const preview = harness.rosterView();
  assert.ok(markerRowOf(preview, "label-b").trim().startsWith("v"), "the drag still marks its position");
  assert.deepEqual(harness.focusedActions(), [], "a drag preview emits nothing beside an open pane");

  const written = harness.presentation();
  assert.equal(written.finishSessionPointerAt(0, rowB + 4, 40, 30), true);
  assert.deepEqual(harness.focusedActions(), [{
    type: "reorder-session",
    source: { kind: "local", id: "a" },
    target: { kind: "local", id: "b" },
    placement: "after",
  }], "exactly one reorder, and no cancellation or activation route ran");
  assert.equal(harness.controller.focus, "form", "the form keeps focus and ownership");
  assert.ok(harness.view().some((line) => line.includes("draft-workspace")),
    "the form's draft survives the drag untouched");
  assert.deepEqual(harness.controller.activeMainOwnerKey, { kind: "local", id: "b" },
    "the real content owner is untouched");
  assert.equal(harness.controller.sessionPointerActive, false);
});

test("a press beside another pane still refuses confirmations, overlays, and stale maps", () => {
  const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];

  // A confirmation that REPLACES the roster: the map drawn before it holds no
  // press, and no session card can be armed under a live confirmation.
  const quit = makeHarness({ items });
  const before = quit.view();
  const rowA = titleRow(before, "label-a");
  const captured = quit.presentation();
  quit.send("q");
  assert.equal(quit.controller.focus, "confirm");
  assert.equal(captured.beginSessionPointerAt(0, rowA, 40, 30), false,
    "a roster the confirmation replaced authorizes nothing");
  assert.equal(quit.presentation().beginSessionPointerAt(0, rowA, 40, 30), false,
    "and neither does a capture taken while the confirmation is drawn");

  // The focused-pane path overlays the roster with the picker: that pane draws
  // no roster, so no written card exists at this geometry.
  const overlay = makeHarness({ items });
  const overlayView = overlay.rosterView();
  assert.equal(overlay.presentation().activateRosterAt(
    0,
    overlayView.findIndex((line) => line.includes("Saved conversations")),
    40,
    30,
  ), true);
  assert.equal(overlay.controller.focus, "form");
  overlay.view(); // the picker replaces the roster in this layout
  assert.equal(overlay.presentation().beginSessionPointerAt(0, titleRow(overlayView, "label-a"), 40, 30), false,
    "an overlaid roster exposes no drawn session card");

  // A too-small pane exposes no complete card, even with a picker open beside it.
  const tiny = makeHarness({ items });
  assert.ok(tiny.rosterView(40, 3).some((line) => line.includes("too small")));
  assert.equal(tiny.presentation().beginSessionPointerAt(0, 1, 40, 3), false);

  // A newer projection invalidates the captured map rather than retargeting it.
  const stale = makeHarness({ items });
  const staleView = stale.rosterView();
  assert.equal(stale.presentation().activateRosterAt(
    0,
    staleView.findIndex((line) => line.includes("Saved conversations")),
    40,
    30,
  ), true);
  stale.baseline = stale.actions.length;
  const staleRoster = stale.rosterView();
  const stalePress = stale.presentation();
  stale.controller.updateItems([makeItem({ id: "b" }), makeItem({ id: "a" })]);
  assert.equal(stalePress.beginSessionPointerAt(0, titleRow(staleRoster, "label-a"), 40, 30), false,
    "a replaced roster refuses the older map");
  assert.deepEqual(stale.focusedActions(), []);
  assert.equal(stale.controller.sessionPointerActive, false);
});

// ---------------------------------------------------------------------------
// Live updates versus an unfinished move.
// ---------------------------------------------------------------------------

test("status, label, and activity updates keep an unfinished preview; membership or run changes cancel it", () => {
  const harness = moveHarness();
  harness.send(MOVE);
  harness.send(DOWN);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]), ["label-b", "label-a", "label-c"]);

  // Display-only changes: same membership, same run.
  harness.controller.updateItems([
    makeItem({ id: "a", label: "renamed-a", busy: true, activity: ["still working"] }),
    makeItem({ id: "b", lifecycle: "exited" }),
    makeItem({ id: "c", pendingInput: true }),
  ]);
  assert.deepEqual(visibleTitles(harness, ["renamed-a", "label-b", "label-c"]), ["label-b", "renamed-a", "label-c"],
    "a status or label change does not cancel the move");
  assert.deepEqual(harness.focusedActions(), []);

  // Membership: the destination card is gone.
  harness.controller.updateItems([makeItem({ id: "a" }), makeItem({ id: "c" })]);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-c"]), ["label-a", "label-c"],
    "the retired preview restores the committed order");
  assert.deepEqual(harness.focusedActions(), [], "the live update still stands and nothing was emitted");

  // Owner run: the moved remote card's run changed underneath the drag.
  const remote = pointerHarness({
    items: [makeItem({ id: "a" })],
    hosts: [makeHost({ id: "host1", hostRunId: "run-1", rows: [makeRemoteRow({ id: "r1" })] })],
  });
  const presentation = remote.presentation();
  const view = remote.view();
  assert.equal(presentation.beginSessionPointerAt(0, titleRow(view, "label-r1"), 40, 30), true);
  assert.equal(presentation.updateSessionPointerAt(0, titleRow(view, "label-a"), 40, 30), true);
  assert.deepEqual(visibleTitles(remote, ["label-a", "label-r1"]), ["label-r1", "label-a"],
    "the drag previews the moved card above the local one");
  remote.controller.setPeerUiSnapshot(makeSnapshot([
    makeHost({ id: "host1", hostRunId: "run-2", rows: [makeRemoteRow({ id: "r1" })] }),
  ]));
  assert.deepEqual(remote.focusedActions(), []);
  assert.equal(presentation.finishSessionPointerAt(0, titleRow(remote.view(), "label-a") + 4, 40, 30), false,
    "a reconnected owner run cancels the unfinished move");
  assert.deepEqual(remote.focusedActions(), [], "and it emits nothing");

  // An UNRELATED membership change also retires the unfinished move: the
  // baseline is the roster's session identities, not just either move side.
  const added = moveHarness();
  added.send(MOVE);
  added.send(DOWN);
  assert.deepEqual(visibleTitles(added, ["label-a", "label-b", "label-c"]), ["label-b", "label-a", "label-c"]);
  added.controller.updateItems([
    makeItem({ id: "a" }), makeItem({ id: "b" }), makeItem({ id: "c" }), makeItem({ id: "new" }),
  ]);
  assert.equal(added.controller.sessionMoveActive, false,
    "an unrelated card joining the roster cancels the unfinished move");
  assert.deepEqual(visibleTitles(added, ["label-a", "label-b", "label-c", "label-new"]), [
    "label-a", "label-b", "label-c", "label-new",
  ], "the live membership update stands and the committed order returns");
  assert.deepEqual(added.focusedActions(), []);

  // The same baseline covers an unrelated owner run change.
  const unrelatedRun = makeHarness({
    items: [makeItem({ id: "a" }), makeItem({ id: "b" })],
    hosts: [makeHost({ id: "host1", hostRunId: "run-1", rows: [makeRemoteRow({ id: "r1" })] })],
  });
  unrelatedRun.controller.select("a");
  unrelatedRun.view();
  unrelatedRun.baseline = unrelatedRun.actions.length;
  unrelatedRun.send(MOVE);
  unrelatedRun.send(DOWN);
  assert.deepEqual(visibleTitles(unrelatedRun, ["label-a", "label-b", "label-r1"]), [
    "label-b", "label-a", "label-r1",
  ]);
  unrelatedRun.controller.setPeerUiSnapshot(makeSnapshot([
    makeHost({ id: "host1", hostRunId: "run-2", rows: [makeRemoteRow({ id: "r1" })] }),
  ]));
  assert.equal(unrelatedRun.controller.sessionMoveActive, false,
    "an unrelated owner run change cancels the unfinished move");
  assert.deepEqual(visibleTitles(unrelatedRun, ["label-a", "label-b", "label-r1"]), [
    "label-a", "label-b", "label-r1",
  ]);
  assert.deepEqual(unrelatedRun.focusedActions(), []);
});

test("hiding or replacing the roster abandons an unfinished move without emitting", () => {
  const harness = moveHarness();
  harness.send(MOVE);
  harness.send(DOWN);
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]), ["label-b", "label-a", "label-c"]);
  harness.send(TOGGLE); // hide
  assert.equal(harness.controller.visible, false);
  assert.equal(harness.controller.sessionMoveActive, false);
  // Hiding still emits exactly its own existing visibility action, never a
  // reorder or any other move side effect.
  assert.deepEqual(harness.focusedActions(), [{ type: "visibility", visible: false }],
    "hiding abandons the preview with no reorder action");
  harness.send(TOGGLE); // show again
  assert.deepEqual(visibleTitles(harness, ["label-a", "label-b", "label-c"]), ["label-a", "label-b", "label-c"],
    "the committed order is what comes back");

  // Opening a form over the roster abandons it the same way.
  const covered = moveHarness();
  covered.controller.select("b");
  const coveredView = covered.view();
  covered.send(MOVE);
  covered.send(DOWN);
  assert.deepEqual(visibleTitles(covered, ["label-a", "label-b", "label-c"]), ["label-a", "label-c", "label-b"]);
  covered.baseline = covered.actions.length;
  assert.equal(covered.presentation().activateRosterAt(
    0,
    coveredView.findIndex((line) => line.includes("New session")),
    40,
    30,
  ), true, "the New row keeps its own existing open action");
  assert.equal(covered.controller.sessionMoveActive, false);
  assert.deepEqual(covered.focusedActions(), []);
  // The New form covers the roster, so bring it back before reading the
  // committed order; the abandoned preview never survives the cover.
  covered.send(TOGGLE); // hide the form/roster
  covered.send(TOGGLE); // show the roster again
  assert.deepEqual(visibleTitles(covered, ["label-a", "label-b", "label-c"]), ["label-a", "label-b", "label-c"],
    "a covered roster never keeps an unfinished preview");
});
