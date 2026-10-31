/**
 * #439 left-session-list wheel scrolling, driven through the PRODUCTION host
 * input-routing path (`__test.runWithDependencies` with the synthetic Main
 * dependency seam), never by calling a sidebar helper directly.
 *
 * Every assertion reads the ACTUAL rows the host wrote into the sidebar pane
 * (scoped to the real 32-cell pane by the shipped pane witness), so a handler
 * that ran without changing what the operator sees can never pass. The shipped
 * strict roster parser is additionally required to be complete wherever the
 * whole tail (cards plus the fixed actions) is on screen.
 *
 * What is proven here:
 * - a wheel notch inside the drawn left roster reveals later rows (down) and
 *   earlier rows (up) when the list overflows the page, and leaves a
 *   one-page list exactly as it was;
 * - the gesture activates nothing, moves no highlight, takes no focus, and
 *   never changes the observed Main content owner;
 * - region control: a wheel over the roster never reaches the hosted child
 *   (so it cannot scroll Main as well), while the same packet inside the
 *   written native Main pane keeps its existing forwarded behavior;
 * - keyboard Up/Down keeps working after scrolling and still reaches rows
 *   that were off-screen, with the highlighted entry always actually drawn;
 * - boundaries, terminal resize, and roster-content changes cannot leave an
 *   invalid offset, a partial card, or an unreachable entry, and a pane too
 *   short for the earlier card refuses that notch without blanking its still
 *   usable window or disabling later wheel reports.
 *
 * These are synthetic SGR/X10 wheel reports delivered through the terminal
 * input callback. They are input-protocol evidence, not physical-device
 * evidence: no real mouse/trackpad run is claimed here.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { NativeInstanceView } from "../src/session-host/instances";
import type { PeerUiHost } from "../src/session-host/peer-ui-protocol";
import type { RemoteSessionMetadata } from "../src/session-host/network/roster-metadata";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import {
  FakeSurface,
  emitMouse,
  peerMainHarness,
  type FakeTerminal,
  type Harness,
  closeWithSignal,
  createHarness,
  nextTurn,
  plain,
  ready,
} from "./helpers/session-host-main-harness";
import {
  parseRosterFrame,
  sidebarPaneLines,
} from "./helpers/session-host-native-roster-witness";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ESC = "\x1b";
const ALT_LEFT = `${ESC}[1;3D`;
/** One SGR wheel report (the #439 input): button 64 up, 65 down, 1-based cells. */
function emitWheel(terminal: FakeTerminal, column: number, row: number, direction: "up" | "down"): void {
  terminal.emitInput(`${ESC}[<${direction === "up" ? 64 : 65};${column + 1};${row + 1}M`);
}
/** The same notch in the legacy X10 encoding the same decoder accepts. */
function emitX10Wheel(terminal: FakeTerminal, column: number, row: number, direction: "up" | "down"): void {
  const button = (direction === "up" ? 64 : 65) + 32;
  terminal.emitInput(`${ESC}[M${String.fromCharCode(button, column + 33, row + 33)}`);
}
/** A wheel report that also carries the drag/motion bit (terminals do send these). */
function emitMotionWheel(terminal: FakeTerminal, column: number, row: number, direction: "up" | "down"): void {
  terminal.emitInput(`${ESC}[<${(direction === "up" ? 64 : 65) + 32};${column + 1};${row + 1}M`);
}
/** A horizontal wheel notch (button 66): never a vertical scroll request. */
function emitHorizontalWheel(terminal: FakeTerminal, column: number, row: number): void {
  terminal.emitInput(`${ESC}[<66;${column + 1};${row + 1}M`);
}

/** Any point inside the wide-layout left roster pane (columns 0..31, rows 1..23). */
const ROSTER_POINT = { column: 5, row: 6 };
/** Any point inside the wide-layout native Main pane (starts at column 33). */
const MAIN_POINT = { column: 40, row: 6 };

function managerOf(harness: Harness): NonNullable<Harness["manager"]> {
  const manager = harness.manager;
  assert.ok(manager, "the production host created its manager");
  return manager;
}

/** One live owned row whose surface reports a mouse-tracking native mode. */
function seedSession(harness: Harness, index: number): void {
  const manager = managerOf(harness);
  const id = `native-${index}`;
  const nativeSession: SessionHostNativeSession = { sessionId: `conversation-${index}`, epoch: 1, name: `Session ${index}` };
  const view: NativeInstanceView = {
    id,
    label: nativeSession.name,
    workspace: `/synthetic/ws/${index}`,
    agentDir: "/synthetic-agent",
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession,
  };
  manager.views.push(view);
  const surface = new FakeSurface(47, 23, `frame:${id}`);
  surface.modes = { ...surface.modes, mouseTracking: "vt200", mouseEncoding: "sgr" };
  manager.surfaces.set(id, surface);
  manager.geometry.set(id, { cols: 47, rows: 23 });
}

/** Seed `count` rows and let the host repaint the roster. */
async function seedRoster(harness: Harness, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) seedSession(harness, index);
  managerOf(harness).notify();
  await nextTurn();
}

function latestFrameText(harness: Harness): string {
  return plain(harness.writer.frames.at(-1)?.frame);
}

/** Exactly the sidebar pane cells the last written frame drew. */
function rosterPane(harness: Harness): string[] {
  return sidebarPaneLines(latestFrameText(harness));
}

/**
 * Pane rows below the drawn roster header, or [] when no roster header is on
 * screen. The outer host header carries the active owner's title, so scanning
 * above the roster header could mistake it for a card title.
 */
function rosterRows(harness: Harness): string[] {
  const pane = rosterPane(harness);
  const header = pane.findIndex((line) => /^\s*Sessions \(\d+\)\s*$/u.test(line));
  return header < 0 ? [] : pane.slice(header + 1);
}

/**
 * The native card titles the pane actually drew. Fail closed on a partial
 * draw: a title without its own status, background, and reserved activity rows
 * is a clipped card and can never be counted as visible.
 */
function drawnCardTitles(harness: Harness): string[] {
  const rows = rosterRows(harness);
  const titles: string[] = [];
  for (let row = 0; row < rows.length; row += 1) {
    const title = rows[row].trimEnd();
    if (!/^Session \d+$/u.test(title)) continue;
    assert.match(rows[row + 1]?.trimEnd() ?? "", /^(?:> |  )agent /u, `"${title}" is drawn with its status row`);
    assert.match(rows[row + 2]?.trimEnd() ?? "", /^(?:> |  )background /u, `"${title}" is drawn with its background row`);
    for (const activityRow of [rows[row + 3] ?? "", rows[row + 4] ?? ""]) {
      assert.ok(activityRow.trimEnd() === "" || /^ {4}/u.test(activityRow.trimEnd()),
        `"${title}" keeps its full expanded extent instead of a clipped card`);
    }
    titles.push(title);
  }
  return titles;
}

/** The fixed action rows the pane actually drew, in visible order. */
function drawnActions(harness: Harness): string[] {
  return rosterRows(harness)
    .map((line) => line.trimEnd())
    .filter((line) => /^(?:> |  )(?:Saved conversations|New session|Quit host)$/u.test(line))
    .map((line) => line.slice(2));
}

/** The entry carrying the left highlight marker, resolved to its card title. */
function highlightedEntry(harness: Harness): string | undefined {
  const rows = rosterRows(harness);
  const row = rows.findIndex((line) => line.startsWith("> "));
  if (row < 0) return undefined;
  const text = rows[row].slice(2).trimEnd();
  return /^agent /u.test(text) ? rows[row - 1]?.trimEnd() : text;
}

/** Absolute frame row of a drawn roster entry whose text contains `text`, or -1. */
function rosterRowOf(harness: Harness, text: string): number {
  const pane = rosterPane(harness);
  const header = pane.findIndex((line) => /^\s*Sessions \(\d+\)\s*$/u.test(line));
  if (header < 0) return -1;
  return pane.findIndex((line, row) => row > header && line.includes(text));
}

/**
 * Move the left highlight to the first card with the EXISTING keyboard path, so
 * each case starts from a known window (the render follows the highlight).
 */
async function highlightFirstCard(harness: Harness): Promise<void> {
  for (let step = 0; step < 12; step += 1) {
    harness.terminal.emitInput(DOWN);
    await nextTurn();
    if (highlightedEntry(harness) === "Session 1") return;
  }
  assert.fail("the existing keyboard path could not highlight the first card");
}

test("wheel down over the overflowing left roster reveals later rows; wheel up reveals earlier ones", async () => {
  const harness = createHarness();
  await ready(harness);
  await seedRoster(harness, 6);
  await highlightFirstCard(harness);

  const before = drawnCardTitles(harness);
  assert.deepEqual(before, ["Session 1", "Session 2", "Session 3"], "six 5-row cards overflow the visible page");
  assert.deepEqual(drawnActions(harness), [], "the fixed actions sit past the page edge as before");

  const framesBefore = harness.writer.frames.length;
  emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
  await nextTurn();
  assert.deepEqual(drawnCardTitles(harness), ["Session 2", "Session 3", "Session 4"],
    "one notch down reveals the next entry and drops the one scrolled past");
  assert.ok(harness.writer.frames.length > framesBefore, "the scroll repainted the frame");

  emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "up");
  await nextTurn();
  assert.deepEqual(drawnCardTitles(harness), before, "one notch back restores the earlier rows exactly");

  // The legacy X10 encoding of the same notch behaves identically.
  emitX10Wheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
  await nextTurn();
  assert.deepEqual(drawnCardTitles(harness), ["Session 2", "Session 3", "Session 4"],
    "the same notch in X10 encoding scrolls the same way");
  assert.equal(await closeWithSignal(harness), 0);
});

test("the wheel scrolls the list without activating, re-highlighting, refocusing, or re-owning anything", async () => {
  const harness = createHarness();
  await ready(harness);
  const manager = managerOf(harness);
  await seedRoster(harness, 6);
  await highlightFirstCard(harness);
  // Deliberate activation of one drawn row: the owner, focus, and highlight
  // that the scroll must leave untouched.
  emitMouse(harness.terminal, 1, rosterRowOf(harness, "Session 2"));
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "main", "the click activated Main as before");
  assert.equal(harness.sidebar?.selectedId, "native-2");
  assert.equal(harness.sidebar?.activeMainOwnerID, "native-2", "Main's observed content owner is a live row");
  const writesAfterActivation = manager.writes.length;
  const createsAfterActivation = manager.createOptions.length;
  const visible = drawnCardTitles(harness);

  for (const direction of ["down", "down", "up", "down"] as const) {
    emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, direction);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "main", "wheel input never changes host focus");
    assert.equal(harness.sidebar?.visible, true, "wheel input never hides the sidebar");
    assert.equal(harness.sidebar?.selectedId, "native-2", "wheel input never moves the left highlight");
    assert.equal(harness.sidebar?.activeMainOwnerID, "native-2", "wheel input never changes Main's owner");
    assert.equal(manager.createOptions.length, createsAfterActivation, "wheel input starts no session");
    assert.ok(highlightedEntry(harness) === undefined || highlightedEntry(harness) === "Session 2",
      "the highlight never moves to another entry, and is only absent because it scrolled off");
  }
  assert.equal(manager.writes.length, writesAfterActivation, "no wheel packet ever reached a child process");
  assert.notDeepEqual(drawnCardTitles(harness), visible, "the visible rows did move");
  assert.equal(await closeWithSignal(harness), 0);
});

test("region control: a roster wheel never reaches the child, a Main-pane wheel keeps its existing forwarding", async () => {
  const harness = createHarness();
  await ready(harness);
  const manager = managerOf(harness);
  await seedRoster(harness, 6);
  await highlightFirstCard(harness);
  emitMouse(harness.terminal, 1, rosterRowOf(harness, "Session 1"));
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "main");
  const writes = manager.writes.length;

  emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
  await nextTurn();
  assert.equal(manager.writes.length, writes, "the roster wheel is host-owned: nothing reaches Main's child");
  assert.ok(drawnCardTitles(harness).includes("Session 4"), "it scrolled the left list instead");

  // The same gesture inside the written native pane keeps its existing
  // Main-focused behavior: it is translated and forwarded to that owner only.
  const windowBefore = drawnCardTitles(harness);
  emitWheel(harness.terminal, MAIN_POINT.column, MAIN_POINT.row, "down");
  const forwarded = manager.writes.at(-1);
  assert.equal(manager.writes.length, writes + 1, "a Main-pane wheel is forwarded to that owner's child");
  assert.equal(forwarded?.id, "native-1", "the wheel goes only to the current owner");
  assert.equal(typeof forwarded?.data === "string" && forwarded.data.startsWith(`${ESC}[<65;`), true,
    "the forwarded packet is that same wheel report in the pane's own coordinates");
  assert.deepEqual(drawnCardTitles(harness), windowBefore,
    "the Main-pane wheel left the roster window alone");
  assert.equal(await closeWithSignal(harness), 0);

  // With the roster focused, a Main-pane wheel stays host-consumed (#439
  // changes no Main routing rule), and still scrolls nothing but the list.
  const rosterFocused = createHarness();
  await ready(rosterFocused);
  await seedRoster(rosterFocused, 6);
  assert.equal(rosterFocused.sidebar?.focus, "sidebar");
  const before = drawnCardTitles(rosterFocused);
  emitWheel(rosterFocused.terminal, MAIN_POINT.column, MAIN_POINT.row, "down");
  await nextTurn();
  assert.equal(managerOf(rosterFocused).writes.length, 0, "a roster-focused Main-pane wheel still goes nowhere");
  assert.deepEqual(drawnCardTitles(rosterFocused), before, "and it never scrolls the left list from that region");
  assert.equal(await closeWithSignal(rosterFocused), 0);
});

test("a roster that fits one page is untouched by wheeling in either direction", async () => {
  const harness = createHarness();
  await ready(harness);
  await seedRoster(harness, 2);
  const before = drawnCardTitles(harness);
  assert.deepEqual(before, ["Session 1", "Session 2"], "both cards fit the visible page");
  assert.deepEqual(drawnActions(harness), ["Saved conversations", "New session", "Quit host"],
    "the whole list, actions included, is on one page");
  const frames = harness.writer.frames.length;
  for (let notch = 0; notch < 4; notch += 1) {
    emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
    emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "up");
    await nextTurn();
  }
  assert.deepEqual(drawnCardTitles(harness), before, "a one-page list never scrolls");
  assert.deepEqual(drawnActions(harness), ["Saved conversations", "New session", "Quit host"],
    "and stays fully usable");
  assert.equal(harness.writer.frames.length, frames, "a refused scroll repaints nothing");
  assert.equal(parseRosterFrame(latestFrameText(harness)).complete, true,
    "the strict roster witness still accepts the untouched roster");
  assert.equal(await closeWithSignal(harness), 0);
});

test("keyboard navigation still works after scrolling and reaches rows that were off-screen", async () => {
  const harness = createHarness();
  await ready(harness);
  await seedRoster(harness, 6);
  assert.equal(harness.sidebar?.focus, "sidebar", "the roster owns keyboard focus for this case");
  await highlightFirstCard(harness);

  emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
  await nextTurn();
  const scrolled = drawnCardTitles(harness);
  assert.ok(!scrolled.includes("Session 1"), "the highlighted row is now off-screen above the window");
  assert.equal(harness.sidebar?.selectedId, "native-1", "the scroll itself moved no highlight");

  // Every keyboard step must land on an entry the frame actually drew, and the
  // tail that was off-screen before the scroll must stay reachable by keyboard.
  let highlighted: string | undefined;
  for (let step = 0; step < 8; step += 1) {
    harness.terminal.emitInput(DOWN);
    await nextTurn();
    highlighted = highlightedEntry(harness);
    assert.ok(highlighted !== undefined, `keyboard step ${step + 1}: the highlight is a drawn entry`);
    if (highlighted === "Saved conversations") break;
  }
  assert.equal(highlighted, "Saved conversations", "the keyboard path still reaches the fixed actions");
  assert.deepEqual(drawnActions(harness), ["Saved conversations", "New session", "Quit host"],
    "and the whole tail that was off-screen is now visible");

  // Up from the tail follows the highlight back down into the window.
  harness.terminal.emitInput(UP);
  await nextTurn();
  assert.equal(highlightedEntry(harness), "Session 6");
  assert.ok(drawnCardTitles(harness).includes("Session 6"), "the last card is visible while highlighted");
  assert.equal(await closeWithSignal(harness), 0);
});

test("boundaries: repeated notches stop at the first and last page and never draw a partial card", async () => {
  const harness = createHarness();
  await ready(harness);
  await seedRoster(harness, 6);
  await highlightFirstCard(harness);

  let lastTop = drawnCardTitles(harness);
  for (let notch = 0; notch < 12; notch += 1) {
    emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
    await nextTurn();
    const cards = drawnCardTitles(harness);
    // Every intermediate window is a complete, unclamped-safe draw, and the
    // window never advances past the last page that fits: once it settles, the
    // tail and the fixed actions stay on screen.
    assert.ok(cards.length > 0, `boundary notch ${notch + 1} still draws whole cards`);
    lastTop = cards;
  }
  assert.ok(lastTop.includes("Session 6"), "the tail stays reachable: the last card is drawn");
  assert.deepEqual(drawnActions(harness), ["Saved conversations", "New session", "Quit host"],
    "the window never scrolls past the last whole page");
  for (let notch = 0; notch < 12; notch += 1) {
    emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "up");
    await nextTurn();
  }
  assert.deepEqual(drawnCardTitles(harness), ["Session 1", "Session 2", "Session 3"], "the head stays reachable");
  assert.notDeepEqual(lastTop, drawnCardTitles(harness), "the scroll really moved between the pages");
  assert.equal(await closeWithSignal(harness), 0);
});

test("resize and roster-content changes keep the viewport valid and every entry reachable", async () => {
  const harness = createHarness();
  await ready(harness);
  await seedRoster(harness, 6);
  await highlightFirstCard(harness);
  emitMouse(harness.terminal, 1, rosterRowOf(harness, "Session 1"));
  await nextTurn();
  emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
  emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
  await nextTurn();
  assert.ok(!drawnCardTitles(harness).includes("Session 1"), "the roster is scrolled away from the head");

  // A shorter terminal: the render re-fits, and the highlighted card must be
  // drawn whole again rather than left off-screen.
  harness.terminal.setSize(80, 20);
  await nextTurn();
  assert.ok(drawnCardTitles(harness).includes("Session 1"), "a shrink re-fits the highlighted card into view");
  assert.equal(highlightedEntry(harness), "Session 1", "and keeps it highlighted");

  // A taller terminal plus a new session: still one valid window, no stale offset.
  harness.terminal.setSize(80, 30);
  await nextTurn();
  seedSession(harness, 7);
  managerOf(harness).notify();
  await nextTurn();
  assert.equal(highlightedEntry(harness), "Session 1", "the highlight survived the roster change");
  assert.equal(harness.sidebar?.activeMainOwnerID, "native-1", "geometry and roster changes own nothing new");
  for (let notch = 0; notch < 10; notch += 1) {
    emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
    await nextTurn();
  }
  assert.ok(drawnCardTitles(harness).includes("Session 7"), "the new session joins the same list and is reachable");
  assert.deepEqual(drawnActions(harness), ["Saved conversations", "New session", "Quit host"],
    "and the scrolled window settles on its last whole page");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a short pane refuses a notch whose next entry cannot fit and stays wheel-usable", async () => {
  const harness = createHarness();
  await ready(harness);
  await seedRoster(harness, 1);
  emitMouse(harness.terminal, 1, rosterRowOf(harness, "Session 1"));
  await nextTurn();
  assert.equal(harness.sidebar?.activeMainOwnerID, "native-1", "the drawn card is the observed Main owner");

  // Four available list rows are shorter than the expanded five-row card, so
  // only the fixed action tail can be drawn, with New session highlighted.
  harness.terminal.setSize(80, 10);
  await nextTurn();
  harness.terminal.emitInput(ALT_LEFT);
  await nextTurn();
  harness.terminal.emitInput(DOWN); // Saved conversations
  await nextTurn();
  harness.terminal.emitInput(DOWN); // New session
  await nextTurn();
  const tail = ["Saved conversations", "New session", "Quit host"];
  assert.equal(highlightedEntry(harness), "New session");
  assert.deepEqual(drawnActions(harness), tail, "the action tail is actually visible");
  assert.deepEqual(drawnCardTitles(harness), [], "the five-row card cannot fit four list rows");
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.activeMainOwnerID, "native-1");

  const shown = latestFrameText(harness);
  const frames = harness.writer.frames.length;
  const writes = managerOf(harness).writes.length;

  // Up would land on the undrawable card. It must be refused, not committed
  // into an empty window (which would also disable every later wheel report).
  emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "up");
  await nextTurn();
  assert.equal(latestFrameText(harness), shown, "the usable tail window is unchanged");
  assert.deepEqual(drawnActions(harness), tail, "and its rows are still actually drawn");
  assert.equal(harness.writer.frames.length, frames, "a refused short-pane scroll repaints nothing");

  // The refusal is not a trap: further notches in either direction stay safe.
  for (const direction of ["down", "up", "down"] as const) {
    emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, direction);
    await nextTurn();
    assert.equal(latestFrameText(harness), shown, `a ${direction} notch left the usable window alone`);
    assert.deepEqual(drawnActions(harness), tail, `the ${direction} notch drew no blank pane`);
  }
  assert.equal(highlightedEntry(harness), "New session", "the wheel moved no highlight");
  assert.equal(harness.sidebar?.focus, "sidebar", "the wheel took no focus");
  assert.equal(harness.sidebar?.activeMainOwnerID, "native-1", "the wheel changed no Main owner");
  assert.equal(managerOf(harness).writes.length, writes, "no wheel report reached a child");

  // Recovery: once the pane is tall enough for the card, the same earlier
  // destination becomes a real scroll in both directions.
  harness.terminal.setSize(80, 13);
  await nextTurn();
  assert.deepEqual(drawnActions(harness), tail, "the taller pane keeps the valid tail window");
  emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "up");
  await nextTurn();
  assert.deepEqual(drawnCardTitles(harness), ["Session 1"], "the earlier card is revealable again");
  assert.deepEqual(drawnActions(harness), ["Saved conversations", "New session"]);
  emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
  await nextTurn();
  assert.deepEqual(drawnCardTitles(harness), [], "and the wheel scrolls back to the tail");
  assert.deepEqual(drawnActions(harness), tail);
  assert.equal(highlightedEntry(harness), "New session");
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.activeMainOwnerID, "native-1");
  assert.equal(managerOf(harness).writes.length, writes, "recovery scrolling wrote to no child");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a wheel over a roster that projects remote cards scrolls the list and asks any owner for nothing", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  const rows: readonly RemoteSessionMetadata[] = ["alpha", "beta", "gamma", "delta"].map((name) => ({
    id: `row-${name}`,
    label: `Remote ${name}`,
    workspace: `/remote/ws/${name}`,
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
  }));
  const host = {
    id: "h1",
    label: "host-one",
    host: "10.0.0.5",
    port: 8443,
    state: "connected",
    fingerprint: null,
    message: null,
    reconnectSuppressed: false,
    previouslyConnected: true,
    roster: { state: "current", rows, hostRunId: "run-1" },
  } satisfies PeerUiHost & { roster: { state: "current"; rows: readonly RemoteSessionMetadata[]; hostRunId: string } };
  peer.publish({ hosts: [host] });
  await nextTurn();

  const remoteLabels = (): string[] => rosterRows(harness)
    .map((line) => line.trim())
    .filter((line) => /^Remote (alpha|beta|gamma|delta)$/u.test(line));
  // Rewind to the first page (the render follows the welcome highlight, which
  // sits with the fixed actions), then scroll from a known head window.
  for (let notch = 0; notch < 4; notch += 1) {
    emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "up");
    await nextTurn();
  }
  const head = remoteLabels();
  assert.ok(head.length > 0 && head.length < 4, "the projected remote cards overflow the visible page");
  assert.ok(head.includes("Remote alpha"), "the head window draws the first remote card");
  const commands = peer.commands.length;
  const writes = managerOf(harness).writes.length;
  const selected = harness.sidebar?.selectedId;
  const owner = harness.sidebar?.activeMainOwnerKey;

  emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
  await nextTurn();
  const later = remoteLabels();
  assert.notDeepEqual(later, head, "the wheel revealed a different remote card set");
  assert.ok(later.some((label) => !head.includes(label)), "a previously off-screen remote card is now drawn");
  emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "up");
  await nextTurn();
  assert.deepEqual(remoteLabels(), head, "wheeling back restores the earlier remote cards");

  assert.equal(peer.commands.length, commands, "the wheel sent no network/owner command");
  assert.equal(managerOf(harness).writes.length, writes, "the wheel sent no local child input");
  assert.equal(harness.sidebar?.selectedId, selected, "the wheel moved no highlight");
  assert.deepEqual(harness.sidebar?.activeMainOwnerKey, owner, "the wheel changed no content owner");
  assert.equal(await closeWithSignal(harness), 0);
});

test("wheel over a form slot, a hidden sidebar, or a horizontal notch never scrolls the left roster", async () => {
  const harness = createHarness();
  await ready(harness);
  await seedRoster(harness, 6);
  await highlightFirstCard(harness);
  // Scroll to the last page so the fixed actions are actually drawn, then open
  // the New form from its drawn row.
  for (let notch = 0; notch < 3; notch += 1) {
    emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
    await nextTurn();
  }
  assert.deepEqual(drawnActions(harness), ["Saved conversations", "New session", "Quit host"],
    "the wheel itself brought the fixed actions on screen");
  const newRow = rosterRowOf(harness, "New session");
  assert.ok(newRow > 0, "the New session action is drawn in the scrolled roster");
  emitMouse(harness.terminal, 1, newRow);
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "form", "the New form owns the right-hand pane");
  const rosterVisible = drawnCardTitles(harness);
  assert.ok(rosterVisible.includes("Session 6"), "the scrolled roster is still drawn beside the form");

  // The form slot owns its own wheel; the left list keeps its own.
  emitWheel(harness.terminal, 40, 6, "down");
  await nextTurn();
  assert.deepEqual(drawnCardTitles(harness), rosterVisible, "a wheel inside the form slot never scrolls the roster");
  emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "up");
  await nextTurn();
  assert.notDeepEqual(drawnCardTitles(harness), rosterVisible,
    "a wheel over the still-drawn left pane scrolls that pane, not the form");

  // Abandon the form, then hide the sidebar: the gesture keeps its existing
  // native behavior and cannot scroll a hidden pane back into view.
  harness.terminal.emitInput(ESC);
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "sidebar");
  harness.terminal.emitInput(ALT_LEFT);
  await nextTurn();
  assert.equal(harness.sidebar?.visible, false, "the sidebar is hidden");
  const manager = managerOf(harness);
  const writes = manager.writes.length;
  emitWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
  await nextTurn();
  assert.equal(harness.sidebar?.visible, false, "a hidden sidebar cannot be scrolled into view");
  assert.equal(manager.writes.length, writes, "no host surface consumed the gesture as a sidebar scroll");
  assert.ok(!latestFrameText(harness).includes(" Sessions ("), "and no roster reappears");

  // A horizontal notch is not a vertical scroll; a motion-flagged notch is.
  harness.terminal.emitInput(ALT_LEFT);
  await nextTurn();
  assert.equal(harness.sidebar?.visible, true);
  const shown = latestFrameText(harness);
  emitHorizontalWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row);
  await nextTurn();
  assert.equal(latestFrameText(harness), shown, "a horizontal notch never scrolls the list");
  emitMotionWheel(harness.terminal, ROSTER_POINT.column, ROSTER_POINT.row, "down");
  await nextTurn();
  assert.notEqual(latestFrameText(harness), shown, "a motion-flagged wheel notch still scrolls");
  assert.equal(await closeWithSignal(harness), 0);
});
