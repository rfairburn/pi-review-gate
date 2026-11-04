/**
 * Production-Main acceptance for the #613 sidebar scrollbar gesture, driven only
 * by synthetic SGR/X10 mouse packets delivered to the RUNNING host's real
 * terminal-input callback (`__test.runWithDependencies` with the synthetic Main
 * dependency seam). Nothing here calls a sidebar helper: every claim is about
 * which dispatch production Main performs for given bytes and what the REAL
 * frame writer actually emitted, replayed through a real `TerminalSurface` so
 * "the viewport moved" means the screen the operator has.
 *
 * What is proven:
 * - a left press on the drawn track jumps the ONE roster viewport, and activates
 *   nothing: no session is created, renamed, stopped, reordered, or persisted; no
 *   highlight, focus, visibility, or Main content owner moves; no byte reaches a
 *   hosted child;
 * - a thumb press holds the gesture, raises the host's own outer capture to drag
 *   reporting (1002) for exactly the held button, and never asks for hover (1003);
 * - motion packets OUTSIDE the roster pane — over the native Main pane and past
 *   either track end — drive the SAME viewport, clamped to the drawn range, while
 *   the native pane's own cells and the observed Main owner stay identical;
 * - the release ends the drag and moves/activates nothing, even when it lands on
 *   a session-card row, and the ordinary press path still works afterwards;
 * - an open right-hand form keeps its ownership and draft through a lane press;
 * - a resize retires a held lane drag: no later motion or release packet moves
 *   the viewport, and no drag capture is left enabled;
 * - the lane never manufactures overflow (a fitting roster draws no lane and no
 *   press at its last column scrolls anything), and the existing wheel and
 *   keyboard viewport paths are unchanged by the lane's presence.
 *
 * These are input-protocol and written-frame evidence, not physical-device
 * evidence: no real mouse, trackpad, PTY, peer, credential, or SSH run is claimed.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { Writable } from "node:stream";
import test from "node:test";

import type { ComposedHostFrame } from "../src/session-host/compositor";
import { createSessionHostFrameWriter } from "../src/session-host/frame-writer";
import type { NativeInstanceView } from "../src/session-host/instances";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import type { RemoteSessionMetadata } from "../src/session-host/network/roster-metadata";
import { TerminalSurface, type TerminalFrame } from "../src/session-host/terminal-surface";
import {
  type FakeManager,
  FakeSurface,
  type Harness,
  QueuedFrameOutput,
  closeWithSignal,
  createHarness,
  emitMouse,
  makeMainTestDirectory,
  nextTurn,
  peerMainHarness,
  plain,
  ready,
} from "./helpers/session-host-main-harness";
import { parseRosterFrame, sidebarPaneLines } from "./helpers/session-host-native-roster-witness";

const SGR = /\x1b\[[0-9;]*m/g;
const SIDEBAR_COLS = 32;
/** The SGR button value a held-drag motion report carries. */
const DRAG_MOTION = 32;
/** The three glyphs the renderer owns for the lane. */
const LANE_GLYPHS = new Set(["\u2502", "\u2503", "\u2588"]);
const THUMB_GLYPHS = new Set(["\u2503", "\u2588"]);
/** The pane column the lane occupies: the sidebar's last column. */
const LANE_COLUMN = SIDEBAR_COLS - 1;
const MODE_WRITE = /^\x1b\[\?10\d\d[hl]$/;

// ---------------------------------------------------------------------------
// Harness: production Main whose frames cross the REAL frame writer, so every
// assertion reads the screen a terminal would actually show.
// ---------------------------------------------------------------------------

function realWriterHarness(): {
  harness: Harness;
  output: QueuedFrameOutput;
  submitted: ComposedHostFrame[];
  lastFrame(): ComposedHostFrame | undefined;
} {
  const output = new QueuedFrameOutput();
  const submitted: ComposedHostFrame[] = [];
  const agentDir = makeMainTestDirectory("scrollbar-agent");
  writeFileSync(join(agentDir, "keybindings.json"), "{}", "utf8");
  const harness = createHarness({}, {
    createSessionSetup: () => ({
      nativeSetup: true,
      nativeAgentDir: agentDir,
      profileRegistry: { prepare: () => { throw new Error("the synthetic manager prepares no profile"); } },
    }),
    createWriter: (_stdout, writerOptions) => {
      const driver = createSessionHostFrameWriter(output as unknown as Writable, {
        ...writerOptions,
        redrawIntervalMs: 0,
      });
      return {
        start: () => driver.start(),
        submit: (frame, cols, rows, settle) => {
          submitted.push(frame);
          driver.submit(frame, cols, rows, settle);
        },
        invalidate: () => driver.invalidate(),
        close: () => driver.close(),
      };
    },
  });
  return { harness, output, submitted, lastFrame: () => submitted.at(-1) };
}

/** The screen a real terminal would show from the bytes the production writer emitted. */
async function emittedScreen(output: QueuedFrameOutput, harness: Harness): Promise<TerminalFrame> {
  const surface = new TerminalSurface(harness.terminal.columns, harness.terminal.rows);
  try {
    for (const bytes of output.writes) surface.write(bytes.toString("utf8"));
    await surface.flush();
    return surface.frame();
  } finally {
    surface.dispose();
  }
}

/** One emitted screen row as the operator sees its text. */
function text(line: string): string {
  return line.replace(SGR, "");
}

/** The whole emitted screen as text rows. */
function frameText(frame: TerminalFrame): string {
  return frame.lines.map(text).join("\n");
}

/**
 * The lane the last emitted screen actually shows: one entry per screen row, the
 * drawn lane glyph or undefined. Read from terminal cells, so a lane that was
 * computed but never painted cannot pass.
 */
function laneOf(frameTextValue: string): (string | undefined)[] {
  return frameTextValue.split("\n").map((line) => {
    const cell = text(line).slice(0, SIDEBAR_COLS);
    const glyph = cell.length === SIDEBAR_COLS ? cell[LANE_COLUMN] : "";
    return LANE_GLYPHS.has(glyph) ? glyph : undefined;
  });
}

/** The painted lane's rows plus its thumb rows, or undefined when no lane is drawn. */
function laneBounds(frameTextValue: string): { top: number; bottom: number; thumb: number[] } | undefined {
  const lane = laneOf(frameTextValue);
  const marked = lane.map((glyph) => glyph !== undefined);
  if (marked.filter(Boolean).length < 2) return undefined;
  const top = marked.indexOf(true);
  const bottom = marked.lastIndexOf(true);
  for (let row = top; row <= bottom; row += 1) {
    assert.ok(marked[row], `the painted lane has a gap at row ${row}: ${JSON.stringify(marked)}`);
  }
  const thumb = lane
    .map((glyph, row) => (glyph !== undefined && THUMB_GLYPHS.has(glyph) ? row : -1))
    .filter((row) => row >= 0);
  assert.ok(thumb.length > 0, "a painted lane always carries a thumb");
  return { top, bottom, thumb };
}

/**
 * A bare (non-thumb) track row as far as possible from the current thumb, so a
 * press there must move the viewport no matter which end of the range the drawn
 * window already sits on.
 */
function bareTrackRow(frameTextValue: string): number {
  const bounds = laneBounds(frameTextValue);
  assert.ok(bounds, "an overflowing roster paints a lane on the emitted screen");
  const thumb = new Set(bounds.thumb);
  const centre = bounds.thumb.reduce((sum, row) => sum + row, 0) / bounds.thumb.length;
  let best = -1;
  let bestDistance = -1;
  for (let row = bounds.top; row <= bounds.bottom; row += 1) {
    if (thumb.has(row)) continue;
    const distance = Math.abs(row - centre);
    if (distance > bestDistance) {
      bestDistance = distance;
      best = row;
    }
  }
  assert.ok(best >= 0, `the drawn track has a bare row to press: ${JSON.stringify(bounds)}`);
  return best;
}

/**
 * The roster pane's own text rows below its header, lane decoration removed by
 * the shipped witness. This is what the operator sees, and it needs no claim
 * that the whole list fits on screen.
 */
function bodyRows(frame: TerminalFrame): string[] {
  const pane = sidebarPaneLines(frameText(frame));
  // pane[0] is the outer host header, pane[1] the roster's own header row.
  assert.match(pane[1]?.trim() ?? "", /^Sessions \(\d+\)$/, `the roster header is drawn: ${JSON.stringify(pane.slice(0, 3))}`);
  return pane.slice(2);
}

/** The card labels the screen shows, in vertical order. */
function drawnCardLabels(frame: TerminalFrame): string[] {
  return bodyRows(frame)
    .map((row) => /Native native-\d+/.exec(row.replace(/^>\s*/, ""))?.[0])
    .filter((label): label is string => label !== undefined);
}

/** The single highlighted row's text, and never more than one highlight. */
function highlightedRow(frame: TerminalFrame): string | undefined {
  const marked = bodyRows(frame).filter((row) => row.startsWith("> "));
  assert.ok(marked.length <= 1, `the drawn roster shows at most one highlight: ${JSON.stringify(marked)}`);
  return marked[0]?.slice(2).trim();
}

/** The strict witness parse of the emitted screen, for the cases where the whole
 *  roster fits and completeness is itself the claim. */
function parsedRoster(frame: TerminalFrame) {
  return parseRosterFrame(frameText(frame));
}

/** The roster pane's own text rows, lane decoration removed, for failure messages. */
function rosterText(frame: TerminalFrame): string {
  return sidebarPaneLines(frameText(frame)).join("\n");
}

/** The native Main pane's own cells (everything right of the divider), so a lane
 *  gesture cannot disturb them. */
function nativePaneCells(frame: TerminalFrame): string[] {
  return frame.lines.map((line) => text(line).slice(SIDEBAR_COLS + 1));
}

/** The row of one drawn roster text, in the last emitted screen. */
function rosterRowOf(frame: TerminalFrame, value: string): number {
  return frame.lines.findIndex((line, row) => row >= 1
    && text(line).slice(0, SIDEBAR_COLS).includes(value));
}

/**
 * The mouse-tracking modes this host currently has enabled, folded from its own
 * owned `?100Nh` / `?100Nl` writes in order. Only modes the host itself wrote
 * appear, so a pre-existing terminal mode is never guessed at.
 */
function enabledTrackingModes(writes: readonly string[]): string[] {
  const on = new Set<string>();
  for (const value of writes) {
    const match = /^\x1b\[\?(\d{4})([hl])$/.exec(value);
    if (match === null || !(match[1] === "1000" || match[1] === "1002" || match[1] === "1003")) continue;
    if (match[2] === "h") on.add(match[1]!);
    else on.delete(match[1]!);
  }
  return [...on].sort();
}

/** Only the mode-enable/disable bytes written since `since`. */
function modeWrites(harness: Harness, since: number): string[] {
  return harness.terminal.writes.slice(since).filter((value) => MODE_WRITE.test(value));
}

/** The existing ordinary click path: a press and its release on one drawn row. */
function clickRow(harness: Harness, column: number, row: number): void {
  emitMouse(harness.terminal, column, row);
  emitMouse(harness.terminal, column, row, 0, "m");
}

const pressLane = (harness: Harness, row: number): void => emitMouse(harness.terminal, LANE_COLUMN, row);
const moveLane = (harness: Harness, column: number, row: number): void =>
  emitMouse(harness.terminal, column, row, DRAG_MOTION);
const releaseAt = (harness: Harness, column: number, row: number): void =>
  emitMouse(harness.terminal, column, row, 0, "m");
/** One SGR wheel notch (the existing viewport control). */
const emitWheel = (harness: Harness, column: number, row: number, direction: "up" | "down"): void =>
  harness.terminal.emitInput(`\x1b[<${direction === "up" ? 64 : 65};${column + 1};${row + 1}M`);

function managerOf(harness: Harness): FakeManager {
  const manager = harness.manager;
  assert.ok(manager, "the production host created its manager");
  return manager;
}

/** `count` live local rows, announced through the manager's own change callback. */
async function seedRoster(harness: Harness, count: number): Promise<FakeManager> {
  const manager = managerOf(harness);
  for (let index = manager.views.length + 1; index <= count; index += 1) {
    const id = `native-${index}`;
    const nativeSession: SessionHostNativeSession = {
      sessionId: `conversation-${index}`, epoch: 1, name: `Native native-${index}`,
    };
    const view: NativeInstanceView = {
      id,
      label: nativeSession.name,
      workspace: `/scrollbar/ws/${index}`,
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
    manager.surfaces.set(id, surface);
    manager.geometry.set(id, { cols: 47, rows: 23 });
  }
  manager.notify();
  await nextTurn();
  return manager;
}

/** A complete fingerprint of everything a lane gesture must not disturb. */
function untouchedState(harness: Harness, manager: FakeManager): string {
  return JSON.stringify({
    focus: harness.sidebar?.focus,
    visible: harness.sidebar?.visible,
    selected: harness.sidebar?.selectedId,
    owner: harness.sidebar?.activeMainOwnerKey ?? null,
    sessionPointerActive: harness.sidebar?.sessionPointerActive,
    views: manager.views.map((view) => view.id),
    creates: manager.createOptions.length,
    renames: manager.renameCalls.length,
    childWrites: manager.writes.length,
    childResizes: manager.resizeCalls.length,
  });
}

function ensureShutdown(harness: Harness, closed: boolean): Promise<number | undefined> {
  if (!closed) harness.signals.emit("SIGTERM");
  return harness.result.catch(() => undefined);
}

// ---------------------------------------------------------------------------

test("a left press on the drawn track jumps the roster viewport and activates nothing else", async () => {
  let closed = false;
  const { harness, output } = realWriterHarness();
  try {
    const manager = await ready(harness);
    await seedRoster(harness, 6);
    const before = await emittedScreen(output, harness);
    assert.ok(laneBounds(frameText(before)), "six cards overflow the pane, so the screen shows a lane");
    const beforeCards = drawnCardLabels(before);
    const beforeRows = bodyRows(before);
    const beforeHighlight = highlightedRow(before);
    const selectedBefore = harness.sidebar?.selectedId;
    const beforeNative = nativePaneCells(before).join("\n");
    const fingerprint = untouchedState(harness, manager);

    pressLane(harness, bareTrackRow(frameText(before)));
    await nextTurn();
    const after = await emittedScreen(output, harness);

    // The viewport the operator sees really moved, and it is still a valid roster
    // window of whole cards with exactly one highlight.
    const afterCards = drawnCardLabels(after);
    assert.notDeepEqual(bodyRows(after), beforeRows,
      `the track press moved the drawn window:\nBEFORE\n${rosterText(before)}\nAFTER\n${rosterText(after)}`);
    assert.ok(afterCards.length > 0, "the drawn window still shows whole roster cards");
    // The selection itself is untouched; it may simply be off the drawn window
    // now, exactly as a wheel scroll can leave it off screen.
    if (highlightedRow(after) !== undefined) {
      assert.equal(highlightedRow(after), beforeHighlight, "a drawn highlight is still the same entry");
    }
    assert.equal(harness.sidebar?.selectedId, selectedBefore, "the selected entry itself did not change");

    // Nothing else happened: no activation, no owner change, no child byte.
    assert.equal(untouchedState(harness, manager), fingerprint,
      "a track press changed no focus, selection, owner, order, child write, create, or rename");
    assert.equal(nativePaneCells(after).join("\n"), beforeNative,
      "the native Main pane's cells are unchanged by the lane press");

    // And the ordinary pointer path is intact afterwards: a click on a drawn card
    // row still activates it and makes it Main's content owner.
    const cardRow = rosterRowOf(after, "Native native-");
    assert.ok(cardRow > 0, "a card row is drawn on the new window");
    clickRow(harness, 1, cardRow);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "main", "the ordinary click path still activates a drawn row");
    assert.equal(typeof harness.sidebar?.activeMainOwnerID, "string",
      "and Main took that row as its content owner, exactly as before this feature");

    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a thumb press holds the drag, raises drag reporting only while held, and never asks for hover", async () => {
  let closed = false;
  const { harness, output } = realWriterHarness();
  try {
    const manager = await ready(harness);
    await seedRoster(harness, 6);
    const before = await emittedScreen(output, harness);
    const bounds = laneBounds(frameText(before));
    assert.ok(bounds);
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1000"],
      "the visible host pane already asks for press reports");

    const beforePress = harness.terminal.writes.length;
    pressLane(harness, bounds.thumb[0]);
    assert.deepEqual(modeWrites(harness, beforePress), ["\x1b[?1000l", "\x1b[?1002h"],
      "the held thumb press raises the host capture to drag reporting, with SGR already on");
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1002"],
      "motion is reportable while the thumb is held");
    assert.equal(harness.sidebar?.scrollbarDragActive, true, "the production host holds the lane gesture");
    assert.equal(harness.sidebar?.sessionPointerActive, false, "the lane press did not begin a card reorder");

    const beforeHold = harness.terminal.writes.length;
    moveLane(harness, LANE_COLUMN, bounds.bottom);
    await nextTurn();
    assert.deepEqual(modeWrites(harness, beforeHold), [], "no mode churn while the drag runs");

    const beforeRelease = harness.terminal.writes.length;
    releaseAt(harness, LANE_COLUMN, bounds.bottom);
    assert.deepEqual(modeWrites(harness, beforeRelease), ["\x1b[?1002l", "\x1b[?1000h"],
      "the release returns to the ordinary press capture, nothing else");
    assert.equal(harness.sidebar?.scrollbarDragActive, false, "the drag ended exactly once");
    assert.equal(harness.terminal.writes.some((value) => value === "\x1b[?1003h"), false,
      "the host never asked for hover reporting for this gesture");
    assert.equal(manager.writes.length, 0, "no byte reached a hosted child during the gesture");

    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), [],
      "shutdown disables exactly the modes this host enabled");
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("motion outside the roster pane drives the same viewport while the native pane and owner stay identical", async () => {
  let closed = false;
  const { harness, output } = realWriterHarness();
  try {
    const manager = await ready(harness);
    await seedRoster(harness, 6);
    const first = await emittedScreen(output, harness);
    const bounds = laneBounds(frameText(first));
    assert.ok(bounds);
    const fingerprint = untouchedState(harness, manager);
    const nativeBefore = nativePaneCells(first).join("\n");

    pressLane(harness, bounds.thumb[0]);
    moveLane(harness, LANE_COLUMN, bounds.thumb[0] + 1);
    await nextTurn();
    const movedInside = await emittedScreen(output, harness);
    assert.notDeepEqual(bodyRows(movedInside), bodyRows(first), "motion inside the pane moved the window");
    assert.equal(nativePaneCells(movedInside).join("\n"), nativeBefore,
      "the native Main pane's cells are identical while the lane drag runs");

    // Motion far outside the roster pane: over the native Main pane's columns and
    // past the pane's last row. The SAME viewport keeps moving.
    moveLane(harness, harness.terminal.columns - 2, harness.terminal.rows - 1);
    await nextTurn();
    const movedOutside = await emittedScreen(output, harness);
    assert.ok(drawnCardLabels(movedOutside).length > 0,
      `the window driven from outside the pane is still a valid roster window:\n${rosterText(movedOutside)}`);
    assert.equal(nativePaneCells(movedOutside).join("\n"), nativeBefore,
      "a motion packet over the native pane changed nothing in the native pane");
    assert.equal(untouchedState(harness, manager), fingerprint,
      "no focus, selection, owner, order, child write, create, or rename happened during the drag");

    // A pointer past the track end clamps to the drawn range end instead of
    // extrapolating: the thumb's last row sits on the track's last row.
    const afterBounds = laneBounds(frameText(movedOutside));
    assert.ok(afterBounds);
    assert.equal(afterBounds.thumb.at(-1), bounds.bottom, "the drag clamps to the drawn range end");

    releaseAt(harness, harness.terminal.columns - 2, harness.terminal.rows - 1);
    await nextTurn();
    const released = await emittedScreen(output, harness);
    assert.deepEqual(bodyRows(released), bodyRows(movedOutside), "the release itself moved nothing");
    assert.equal(untouchedState(harness, manager), fingerprint, "and activated nothing");

    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a release that lands on a card row activates nothing, and the ordinary press path still works after it", async () => {
  let closed = false;
  const { harness, output } = realWriterHarness();
  try {
    const manager = await ready(harness);
    await seedRoster(harness, 6);
    const first = await emittedScreen(output, harness);
    const bounds = laneBounds(frameText(first));
    assert.ok(bounds);
    const fingerprint = untouchedState(harness, manager);
    const focusBefore = harness.sidebar?.focus;

    pressLane(harness, bounds.thumb[0]);
    moveLane(harness, LANE_COLUMN, bounds.top);
    await nextTurn();
    const moved = await emittedScreen(output, harness);
    assert.notDeepEqual(bodyRows(moved), bodyRows(first), "the held drag moved the window first");
    const cardRow = rosterRowOf(moved, "Native native-");
    assert.ok(cardRow > 0, "a card row is drawn where the release will land");

    // The release is delivered over a session-card row. It belongs to the held
    // lane gesture, so it must not activate that card.
    releaseAt(harness, 4, cardRow);
    await nextTurn();
    assert.equal(untouchedState(harness, manager), fingerprint,
      "a release over a card row activated nothing and changed no owner, focus, or selection");
    assert.equal(harness.sidebar?.focus, focusBefore, "no form or popup was opened by the release");

    // The pointer machinery is still sane: an ordinary click on that same drawn
    // card row activates it, which is exactly what the lane release did not do.
    const ownerBefore = harness.sidebar?.activeMainOwnerID;
    clickRow(harness, 4, cardRow);
    await nextTurn();
    assert.equal(typeof harness.sidebar?.activeMainOwnerID, "string",
      "the following ordinary click reached the production activation path");
    assert.notEqual(harness.sidebar?.activeMainOwnerID, ownerBefore,
      "and it made a different row Main's content owner");

    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a lane press never steals or cancels an open right-hand form", async () => {
  let closed = false;
  const { harness, output } = realWriterHarness();
  try {
    const manager = await ready(harness);
    await seedRoster(harness, 6);
    const first = await emittedScreen(output, harness);
    const actionRow = rosterRowOf(first, "New session");
    assert.ok(actionRow > 0, "the roster keeps its unchanged New session action row");
    emitMouse(harness.terminal, 1, actionRow);
    assert.equal(harness.sidebar?.focus, "form", "the action row opened the form");
    harness.terminal.emitInput("\x15"); // replace any retained workspace draft
    harness.terminal.emitInput("/scrollbar/draft");
    await nextTurn();
    const withForm = await emittedScreen(output, harness);
    assert.ok(frameText(withForm).includes("/scrollbar/draft"), "the draft is on screen");
    const bounds = laneBounds(frameText(withForm));
    assert.ok(bounds, "the roster keeps its lane while the form is open");
    const creates = manager.createOptions.length;

    const row = bareTrackRow(frameText(withForm));
    pressLane(harness, row);
    await nextTurn();
    const after = await emittedScreen(output, harness);

    assert.equal(harness.sidebar?.focus, "form", "the lane press did not close or replace the form");
    assert.ok(frameText(after).includes("/scrollbar/draft"), "the draft survives the lane press");
    assert.equal(manager.createOptions.length, creates, "and nothing was submitted");
    // The roster window still moved: the lane belongs to the roster even while a
    // form occupies the right-hand pane.
    assert.notDeepEqual(bodyRows(after), bodyRows(withForm), "the lane press scrolled the roster");

    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a resize retires a held lane drag; later packets move nothing and no capture is left enabled", async () => {
  let closed = false;
  const { harness, output } = realWriterHarness();
  try {
    const manager = await ready(harness);
    await seedRoster(harness, 6);
    const first = await emittedScreen(output, harness);
    const bounds = laneBounds(frameText(first));
    assert.ok(bounds);
    pressLane(harness, bounds.thumb[0]);
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1002"], "the thumb is held");
    assert.equal(harness.sidebar?.scrollbarDragActive, true);

    harness.terminal.setSize(100, 40);
    await nextTurn();
    assert.equal(harness.sidebar?.scrollbarDragActive, false, "the resize retired the lane gesture");
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1000"],
      "the resize left no drag capture enabled, only the ordinary press reports");

    const resized = await emittedScreen(output, harness);
    const rowsAfterResize = bodyRows(resized);
    const fingerprint = untouchedState(harness, manager);
    // A motion packet and a release from the retired gesture arrive afterwards.
    moveLane(harness, LANE_COLUMN, 30);
    await nextTurn();
    const afterMotion = await emittedScreen(output, harness);
    assert.deepEqual(bodyRows(afterMotion), rowsAfterResize, "the stale motion packet moved nothing");
    releaseAt(harness, LANE_COLUMN, 30);
    await nextTurn();
    const afterRelease = await emittedScreen(output, harness);
    assert.deepEqual(bodyRows(afterRelease), rowsAfterResize, "the stale release moved nothing");
    assert.equal(untouchedState(harness, manager), fingerprint,
      "and neither activated, selected, focused, wrote to a child, or resized one");

    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

test("a lane press over a roster that projects local AND remote cards scrolls the list and asks a peer or child for nothing", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  const manager = managerOf(harness);
  for (let index = 1; index <= 2; index += 1) {
    const id = `native-${index}`;
    manager.views.push({
      id,
      label: `Native native-${index}`,
      workspace: `/scrollbar/ws/${index}`,
      agentDir: "/synthetic-agent",
      lifecycle: "alive",
      hasLiveProcess: true,
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [],
      nativeSession: { sessionId: `conversation-${index}`, epoch: 1, name: `Native native-${index}` },
    });
    manager.geometry.set(id, { cols: 47, rows: 23 });
  }
  manager.notify();
  const remoteRows: readonly RemoteSessionMetadata[] = ["alpha", "beta", "gamma", "delta", "epsilon"].map((name) => ({
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
  peer.publish({
    hosts: [{
      id: "h1",
      label: "host-one",
      host: "10.0.0.5",
      port: 8443,
      state: "connected",
      fingerprint: null,
      message: null,
      reconnectSuppressed: false,
      previouslyConnected: true,
      roster: { state: "current", rows: remoteRows, hostRunId: "run-1" },
    }],
  });
  await nextTurn();

  const shown = () => plain(harness.writer.frames.at(-1)?.frame);
  const labels = () => sidebarPaneLines(shown())
    .map((row) => row.replace(/^> /, "").trim())
    .filter((row) => /^(?:Native native-\d+|Remote \w+)$/u.test(row));
  const tail = labels();
  assert.ok(tail.some((row) => row.startsWith("Remote ")), "the drawn window shows projected remote cards");
  const bounds = laneBounds(shown());
  assert.ok(bounds, "the mixed roster overflows, so the written frame carries a lane");
  assert.ok(tail.length < 7, "and the drawn window really is a window, not the whole list");

  const commands = peer.commands.length;
  const writes = manager.writes.length;
  const selected = harness.sidebar?.selectedId;
  const owner = harness.sidebar?.activeMainOwnerKey;
  const renamed = manager.renameCalls.length;
  const creates = manager.createOptions.length;

  pressLane(harness, bounds.top);
  await nextTurn();
  const head = labels();
  assert.notDeepEqual(head, tail, "the lane press revealed a different window of the mixed list");
  assert.ok(head.includes("Native native-1"), "the top of the lane reaches the mixed list's local cards");
  assert.ok(!head.includes("Remote epsilon"), "and the far remote card left the window");

  pressLane(harness, bareTrackRow(shown()));
  await nextTurn();
  assert.deepEqual(labels(), tail, "the bottom of the lane restores the original mixed window");

  assert.equal(peer.commands.length, commands, "the lane press sent no peer/owner command");
  assert.equal(manager.writes.length, writes, "the lane press sent no local child input");
  assert.equal(manager.renameCalls.length, renamed, "and no rename");
  assert.equal(manager.createOptions.length, creates, "and started no session");
  assert.equal(harness.sidebar?.selectedId, selected, "the lane press moved no highlight");
  assert.deepEqual(harness.sidebar?.activeMainOwnerKey, owner, "the lane press changed no content owner");
  assert.equal(harness.sidebar?.scrollbarDragActive, false, "and left no held gesture");

  assert.equal(await closeWithSignal(harness), 0);
});

test("the lane never manufactures overflow, and wheel and keyboard viewport paths keep working beside it", async () => {
  let closed = false;
  const { harness, output } = realWriterHarness();
  try {
    const manager = await ready(harness);
    // One card: the roster fits, so no lane is drawn. The renderer never hid or
    // capped an entry to manufacture overflow.
    await seedRoster(harness, 1);
    const fitting = await emittedScreen(output, harness);
    assert.equal(laneBounds(frameText(fitting)), undefined, "a fitting roster paints no lane on the emitted screen");
    const fittingRows = bodyRows(fitting);
    assert.deepEqual(drawnCardLabels(fitting), ["Native native-1"], "the one card is drawn");
    const parsed = parsedRoster(fitting);
    assert.equal(parsed.complete, true, "the fitting roster is drawn completely, never capped to create overflow");
    assert.equal(parsed.entries.length, 5, "one card plus the whole fixed action tail");
    for (const action of ["Saved conversations", "New session", "Settings", "Quit host"]) {
      assert.ok(fittingRows.some((row) => row.replace(/^> /, "").trim() === action),
        `the fixed action tail is drawn, nothing was hidden to manufacture overflow:\n${rosterText(fitting)}`);
    }
    pressLane(harness, 2);
    moveLane(harness, LANE_COLUMN, 5);
    releaseAt(harness, LANE_COLUMN, 5);
    await nextTurn();
    const afterFitting = await emittedScreen(output, harness);
    assert.deepEqual(bodyRows(afterFitting), fittingRows,
      "presses at the last column of a fitting roster scroll nothing");
    assert.equal(harness.sidebar?.scrollbarDragActive, false, "and hold no lane gesture");

    // Grow the same roster past the pane: the lane appears with no resize.
    await seedRoster(harness, 6);
    const overflowing = await emittedScreen(output, harness);
    const bounds = laneBounds(frameText(overflowing));
    assert.ok(bounds, "the lane appears when the same roster overflows");

    // The existing wheel control still drives the SAME single viewport, and the
    // thumb tracks it.
    const wheelRows = bodyRows(overflowing);
    emitWheel(harness, 5, bounds.top + 2, "down");
    await nextTurn();
    const afterWheel = await emittedScreen(output, harness);
    assert.notDeepEqual(bodyRows(afterWheel), wheelRows, "the wheel notch still moves the window");
    const wheelBounds = laneBounds(frameText(afterWheel));
    assert.ok(wheelBounds);
    assert.ok(wheelBounds.thumb[0] > bounds.thumb[0], "the thumb follows the wheel-driven viewport");
    emitWheel(harness, 5, bounds.top + 2, "up");
    await nextTurn();
    const backWheel = await emittedScreen(output, harness);
    assert.deepEqual(bodyRows(backWheel), wheelRows, "the opposite notch returns the same window");
    assert.deepEqual(laneBounds(frameText(backWheel))?.thumb, bounds.thumb, "and the thumb back to where it was");

    // Keyboard selection is unchanged: it still moves, and the drawn highlight
    // lands on a real row. The roster is already host-focused here, so no toggle
    // is needed (and the toggle would hide the pane).
    assert.equal(harness.sidebar?.visible, true, "the roster is still visible before the keyboard step");
    await nextTurn();
    const focused = await emittedScreen(output, harness);
    const highlightBefore = highlightedRow(focused);
    harness.terminal.emitInput("\x1b[B");
    await nextTurn();
    const stepped = await emittedScreen(output, harness);
    const highlightAfter = highlightedRow(stepped);
    assert.ok(highlightAfter !== undefined, "the keyboard step leaves one drawn highlight");
    assert.notEqual(highlightAfter, highlightBefore, "the keyboard step moved it");
    assert.equal(harness.sidebar?.sessionPointerActive, false, "no reorder was involved");

    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});

// ---------------------------------------------------------------------------
// #613 review pass 1: a no-op track press stays consumed by the lane, and a
// roster change under a held drag retires it on the frame that changed the range.
// ---------------------------------------------------------------------------

test("a no-op track press in a mixed-height window never falls through to the row underneath", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  const manager = managerOf(harness);
  // One 5-row local card, then three 6-row remote cards, then the 1-row host
  // actions. In this window some track offsets have no usable destination of their
  // own, and the nearest usable index can be the window already drawn.
  manager.views.push({
    id: "native-1",
    label: "Native native-1",
    workspace: "/scrollbar/ws/1",
    agentDir: "/synthetic-agent",
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession: { sessionId: "conversation-1", epoch: 1, name: "Native native-1" },
  });
  manager.geometry.set("native-1", { cols: 47, rows: 23 });
  manager.notify();
  peer.publish({
    hosts: [{
      id: "h1",
      label: "host-one",
      host: "10.0.0.5",
      port: 8443,
      state: "connected",
      fingerprint: null,
      message: null,
      reconnectSuppressed: false,
      previouslyConnected: true,
      roster: {
        state: "current",
        hostRunId: "run-1",
        rows: ["r1", "r2", "r3"].map((name) => ({
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
        })),
      },
    }],
  });
  await nextTurn();
  harness.terminal.setSize(80, 14);
  await nextTurn();

  const shown = () => plain(harness.writer.frames.at(-1)?.frame);
  const body = () => sidebarPaneLines(shown()).slice(2).join("\n");
  const fingerprint = () => untouchedState(harness, manager);
  assert.ok(laneBounds(shown()), "the mixed roster overflows, so the written frame carries a lane");
  const fingerprintBefore = fingerprint();
  const focusBefore = harness.sidebar?.focus;

  // Press bare track rows until one maps back to the window already on screen. The
  // invariant holds at every press; the no-op case is then proved in full.
  const pressed: number[] = [];
  let noOpRow: number | undefined;
  for (let step = 0; step < 12 && noOpRow === undefined; step += 1) {
    const bounds = laneBounds(shown());
    assert.ok(bounds, "the lane keeps being drawn while the window moves");
    const thumbs = new Set(bounds.thumb);
    const bare: number[] = [];
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      if (!thumbs.has(row) && !pressed.includes(row)) bare.push(row);
    }
    if (bare.length === 0) break;
    const row = bare[0];
    pressed.push(row);
    const before = body();
    const modesBefore = harness.terminal.writes.length;
    pressLane(harness, row);
    await nextTurn();
    assert.equal(harness.sidebar?.sessionPointerActive, false,
      `a lane press on row ${row} never started a session-card pointer drag underneath it`);
    assert.equal(fingerprint(), fingerprintBefore,
      `a lane press on row ${row} activated, selected, focused, created, renamed, owned, or forwarded nothing`);
    assert.deepEqual(modeWrites(harness, modesBefore), [],
      `a lane press on row ${row} is not a held gesture, so the outer capture never changed`);
    if (body() === before) noOpRow = row;
  }
  assert.ok(noOpRow !== undefined,
    `this mixed-height window contains a bare track row whose mapped destination is the window already drawn (the case this guards); pressed ${JSON.stringify(pressed)}`);

  // The no-op click in full: press, motion, release. Nothing moves and nothing is
  // activated, because the lane owned the whole click rather than passing the
  // press through to the row it is painted over.
  const beforeClick = body();
  pressLane(harness, noOpRow);
  await nextTurn();
  moveLane(harness, LANE_COLUMN, noOpRow + 1);
  await nextTurn();
  releaseAt(harness, LANE_COLUMN, noOpRow + 1);
  await nextTurn();
  assert.equal(body(), beforeClick, "the no-op press, its motion, and its release moved nothing");
  assert.equal(harness.sidebar?.sessionPointerActive, false, "and started no card drag");
  assert.equal(harness.sidebar?.focus, focusBefore, "and opened no form or popup");
  assert.equal(fingerprint(), fingerprintBefore, "and activated nothing end to end");

  assert.equal(await closeWithSignal(harness), 0);
});

test("a roster change under a held lane drag retires it on the new frame and restores ordinary capture", async () => {
  let closed = false;
  const { harness, output } = realWriterHarness();
  try {
    const manager = await ready(harness);
    await seedRoster(harness, 6);
    const first = await emittedScreen(output, harness);
    const bounds = laneBounds(frameText(first));
    assert.ok(bounds);
    const beforePress = harness.terminal.writes.length;
    pressLane(harness, bounds.thumb[0]);
    assert.deepEqual(modeWrites(harness, beforePress), ["\x1b[?1000l", "\x1b[?1002h"],
      "the held thumb raised the outer capture to drag reporting");
    assert.equal(harness.sidebar?.scrollbarDragActive, true);

    // A new card arrives while the thumb is held, and the list STILL overflows. The
    // render that draws the new range retires the grab, and Main's frame boundary
    // brings the capture back down WITHOUT waiting for another mouse packet.
    const beforeChange = harness.terminal.writes.length;
    await seedRoster(harness, 7);
    assert.equal(harness.sidebar?.scrollbarDragActive, false,
      "the membership change retired the held drag on the frame that changed the range");
    assert.deepEqual(modeWrites(harness, beforeChange).filter((value) => MODE_WRITE.test(value)),
      ["\x1b[?1002l", "\x1b[?1000h"],
      "and the ordinary press capture was restored on that same frame");
    assert.deepEqual(enabledTrackingModes(harness.terminal.writes), ["1000"],
      "no drag capture is left enabled after the retirement");

    const changed = await emittedScreen(output, harness);
    const rowsAfterChange = bodyRows(changed);
    const fingerprint = untouchedState(harness, manager);
    // The physical motion and release of the abandoned drag arrive afterwards. They
    // are fenced: no viewport move, no activation, no byte to a child.
    moveLane(harness, LANE_COLUMN, bounds.top);
    await nextTurn();
    const afterMotion = await emittedScreen(output, harness);
    assert.deepEqual(bodyRows(afterMotion), rowsAfterChange, "the stale motion packet moved nothing");
    releaseAt(harness, LANE_COLUMN, bounds.top);
    await nextTurn();
    const afterRelease = await emittedScreen(output, harness);
    assert.deepEqual(bodyRows(afterRelease), rowsAfterChange, "the stale release moved nothing");
    assert.equal(harness.sidebar?.sessionPointerActive, false, "and started no card drag");
    assert.equal(untouchedState(harness, manager), fingerprint,
      "and activated, selected, focused, created, or forwarded nothing");

    closed = true;
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    await ensureShutdown(harness, closed);
  }
});
