/**
 * #613 pure-renderer proof for the session-host sidebar scrollbar lane, and for
 * the terminal-default pane canvas the lane and every host-owned row use.
 *
 * Everything here is the production renderer and the production draw-derived
 * pointer seams of `SidebarController` — no Main, frame writer, compositor, PTY,
 * process, filesystem, or clock. The lane is read out of the ACTUAL pane rows the
 * renderer returned (the last pane column separated from the text), so a lane
 * that was computed but never painted, or painted over a header/footer row,
 * cannot pass. The geometry is restated independently from the pinned Pi 1.5.0
 * thumb rule and from the roster's own whole-card window rule, and the inverse
 * (press/motion -> entry index) is checked against the SAME single `listTop`
 * viewport the wheel moves.
 *
 * The colour half writes those exact pane rows through the real
 * `TerminalSurface` parser and reads the resulting terminal CELLS: every cell of
 * every host-owned row must carry an explicit foreground while leaving the
 * background on the terminal default, exactly like Pi's own canvas-free chat
 * viewport. No child/native cell, header, or divider is recolored, and no
 * terminal query or theme detection is involved.
 *
 * This is renderer and input-protocol evidence, not a physical-mouse claim.
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
import { sidebarPaletteFor, type SidebarThemeId } from "../src/session-host/sidebar-theme";
import { TerminalSurface } from "../src/session-host/terminal-surface";
import type { PeerUiHost, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import type { RemoteSessionMetadata } from "../src/session-host/network/roster-metadata";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const TOGGLE = "\x1b[1;3D"; // the reserved sidebar toggle (alt+left)
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

/** The three glyphs the lane may paint, in the order the renderer owns them. */
const TRACK = "\u2502";
const THUMB = "\u2503";
const ACTIVE_THUMB = "\u2588";
const LANE_GLYPHS = new Set([TRACK, THUMB, ACTIVE_THUMB]);

/** Card heights the renderer owns: local 5 expanded, remote 6, host actions 1. */
const LOCAL_CARD_ROWS = 5;
const REMOTE_CARD_ROWS = 6;
const ACTION_ROW_ROWS = 1;

// ---------------------------------------------------------------------------
// Harness: one mixed local + remote roster drawn by the production renderer.
// ---------------------------------------------------------------------------

function makeItem(id: string): SidebarItem {
  return {
    id,
    label: `local-${id}`,
    workspace: `/local/ws/${id}`,
    agentDir: `/agents/${id}`,
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
  };
}

function makeRemoteRow(id: string): RemoteSessionMetadata {
  return {
    id,
    label: `remote-${id}`,
    workspace: `/remote/ws/${id}`,
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
  };
}

function makeSnapshot(hosts: readonly { id: string; rows: readonly string[] }[]): PeerUiSnapshot {
  const typed: (PeerUiHost & { roster: PeerUiHost["roster"] & { hostRunId?: string | null } })[] = hosts.map((host) => ({
    id: host.id,
    label: `host-${host.id}`,
    host: "10.0.0.5",
    port: 8443,
    state: "connected",
    fingerprint: null,
    message: null,
    reconnectSuppressed: false,
    previouslyConnected: true,
    roster: { state: "current", rows: host.rows.map(makeRemoteRow), hostRunId: `run-${host.id}` },
  }));
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
    hosts: typed,
    trustedPeers: [],
    consents: [],
    notice: null,
  };
}

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  /** Titles of every roster entry, in roster order (cards then host actions). */
  rosterOrder: string[];
  /** Entry heights in roster order, from the renderer's own card model. */
  rosterHeights: number[];
  /** SGR-stripped pane rows with the lane column separated out. */
  view(cols?: number, rows?: number): { texts: string[]; lane: (string | undefined)[]; raw: string[] };
  presentation(): SidebarMousePresentation;
}

function makeHarness(
  options: {
    locals?: number;
    hosts?: readonly { id: string; rows: readonly string[] }[];
    controllerOptions?: SidebarControllerOptions;
  } = {},
): Harness {
  const locals = options.locals ?? 0;
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    initialVisible: false,
    ...options.controllerOptions,
    onAction: (action) => actions.push(action),
    getSessionOrder: (): readonly SidebarMainOwnerKey[] => [],
  });
  if (locals > 0) controller.updateItems(Array.from({ length: locals }, (_unused, index) => makeItem(`l${index + 1}`)));
  if (options.hosts !== undefined) controller.setPeerUiSnapshot(makeSnapshot(options.hosts));
  controller.handleInput(TOGGLE); // show the pane and take roster focus
  assert.equal(controller.focus, "sidebar");

  const localTitles = Array.from({ length: locals }, (_unused, index) => `local-l${index + 1}`);
  const remoteTitles = (options.hosts ?? []).flatMap((host) => host.rows.map((row) => `remote-${row}`));
  // The renderer's fixed action tail, in its drawn order. The grouped Settings
  // row exists exactly when an entry point it offers does: a peer snapshot makes
  // Network available, so a roster with hosts carries it between New session and
  // the final Quit host.
  const actionTitles = ["Saved conversations", "New session"];
  if ((options.hosts?.length ?? 0) > 0) actionTitles.push("Settings");
  actionTitles.push("Quit host");
  const rosterOrder = [...localTitles, ...remoteTitles, ...actionTitles];
  const rosterHeights = [
    ...localTitles.map(() => LOCAL_CARD_ROWS),
    ...remoteTitles.map(() => REMOTE_CARD_ROWS),
    ...actionTitles.map(() => ACTION_ROW_ROWS),
  ];

  return {
    controller,
    actions,
    rosterOrder,
    rosterHeights,
    view: (cols = 32, rows = 24) => {
      const rendered = controller.renderRoster(cols, rows);
      assert.equal(rendered.lines.length, rows, "the roster pane fills its geometry");
      const stripped = rendered.lines.map((line) => {
        for (const sgr of line.match(SGR_PATTERN) ?? []) {
          assert.ok(
            SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
            `unexpected generated SGR ${JSON.stringify(sgr)} in ${JSON.stringify(line)}`,
          );
        }
        const text = line.replace(SGR_PATTERN, "");
        assert.ok(!text.includes("\x1b"), `raw ESC outside generated SGR: ${JSON.stringify(line)}`);
        assert.ok(visibleWidth(text) <= cols, `rendered row wider than the pane: ${JSON.stringify(line)}`);
        return text;
      });
      // The lane is one cell in the pane's LAST column; separate it from the row
      // text so roster assertions read roster text.
      const lane = stripped.map((text) => {
        const code = text.codePointAt(text.length - 1) ?? 0;
        if (code === 0) return undefined;
        const glyph = String.fromCodePoint(code);
        return LANE_GLYPHS.has(glyph) ? glyph : undefined;
      });
      const texts = stripped.map((text, index) => (lane[index] === undefined
        ? text
        : text.slice(0, text.length - ((text.codePointAt(text.length - 1) ?? 0) > 0xffff ? 2 : 1))));
      return { texts, lane, raw: rendered.lines };
    },
    presentation: () => controller.captureMousePresentation(),
  };
}

// ---------------------------------------------------------------------------
// Independent restatements of the rules the lane must follow.
// ---------------------------------------------------------------------------

/** The pinned Pi 1.5.0 thumb-size rule, restated here for cross-checking. */
function piThumbHeight(trackHeight: number, contentHeight: number): number {
  return Math.max(
    Math.min(2, trackHeight),
    Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
  );
}

/**
 * The roster's own whole-card window rule: the largest `listTop` whose COMPLETE
 * tail still fits `listRows` (the topmost window the renderer's tail rule lands
 * on), and the cumulative entry rows before it — which is the lane's whole
 * representable range, NOT `contentHeight - listRows`.
 */
function usableWindow(
  heights: readonly number[],
  listRows: number,
): { lastTop: number; maxOffset: number } {
  let lastTop = 0;
  let tail = 0;
  for (let index = heights.length - 1; index >= 0; index -= 1) {
    if (tail + heights[index] > listRows) break;
    tail += heights[index];
    lastTop = index;
  }
  const maxOffset = heights.slice(0, lastTop).reduce((sum, height) => sum + height, 0);
  return { lastTop, maxOffset };
}

/** The contiguous lane rows of one drawn pane: [firstRow, lastRow], or undefined. */
function laneRows(lane: readonly (string | undefined)[]): [number, number] | undefined {
  const marked = lane.map((glyph) => glyph !== undefined);
  if (!marked.some(Boolean)) return undefined;
  const first = marked.indexOf(true);
  const last = marked.lastIndexOf(true);
  for (let row = first; row <= last; row += 1) {
    assert.ok(marked[row], `the lane has a gap at pane row ${row}: ${JSON.stringify(marked)}`);
  }
  return [first, last];
}

/** Thumb rows of the drawn lane, and only the idle/active thumb glyphs. */
function thumbRows(lane: readonly (string | undefined)[]): number[] {
  return lane
    .map((glyph, row) => (glyph === THUMB || glyph === ACTIVE_THUMB ? row : -1))
    .filter((row) => row >= 0);
}

// ---------------------------------------------------------------------------
// Idle visibility, placement, and the lane's own range.
// ---------------------------------------------------------------------------

test("an overflowing mixed local/remote roster draws one contiguous lane in the pane's last column, over list rows only", () => {
  const harness = makeHarness({ locals: 4, hosts: [{ id: "h1", rows: ["r1", "r2"] }] });
  const cols = 32;
  const rows = 20;
  const { texts, lane } = harness.view(cols, rows);
  const laneBounds = laneRows(lane);
  assert.ok(laneBounds, "an overflowing roster paints a lane");
  const [trackTop, trackBottom] = laneBounds;

  // The lane sits in the last column of the roster pane and nowhere else.
  assert.equal(trackTop, 1, "the lane starts on the first list row, directly under the roster header");
  const headerRow = texts[0];
  assert.match(headerRow.trim(), /^Sessions \(\d+\)$/, "row 0 is the roster header");
  assert.ok(lane[0] === undefined, "the header row carries no lane cell");
  for (let row = trackBottom + 1; row < rows; row += 1) {
    assert.equal(lane[row], undefined, `row ${row} (${JSON.stringify(texts[row])}) is not a list row and gets no lane cell`);
  }
  // The rows below the lane are the roster's unchanged hint footer.
  assert.match(texts[trackBottom + 1] ?? "", /toggle/, "the footer keeps its own row below the list window");

  const trackHeight = trackBottom - trackTop + 1;
  const totalHeight = harness.rosterHeights.reduce((sum, height) => sum + height, 0);
  assert.ok(totalHeight > trackHeight, "the roster really overflows the drawn window");

  // Pi's own thumb size, from the actual track and the actual content height.
  const thumbs = thumbRows(lane);
  assert.equal(thumbs.length, piThumbHeight(trackHeight, totalHeight), "the thumb is the size Pi's scrollbar draws");
  for (let index = 1; index < thumbs.length; index += 1) {
    assert.equal(thumbs[index], thumbs[index - 1] + 1, "the thumb is one contiguous block");
  }
  assert.ok(thumbs[0] >= trackTop && thumbs.at(-1)! <= trackBottom,
    "the thumb stays inside the drawn track");
  for (const [row, glyph] of lane.entries()) {
    if (glyph === undefined) continue;
    assert.ok(
      thumbs.includes(row) ? glyph === THUMB : glyph === TRACK,
      `row ${row} drew ${JSON.stringify(glyph)} outside the idle track/thumb pattern`,
    );
  }

  // And the thumb's placement follows the window that is actually drawn: land on
  // the first entry and the thumb sits on the track's first row.
  const map = harness.presentation();
  assert.equal(map.jumpScrollbarAt(cols - 1, trackTop, cols, rows), true, "the top of the track is a live target");
  const atTop = harness.view(cols, rows);
  assert.equal(thumbRows(atTop.lane)[0], trackTop, "the first window puts the thumb on the first track row");
  assert.equal(atTop.texts[1].trim(), harness.rosterOrder[0], "and draws the roster's first entry");
});

test("a roster that fits its rows draws no lane at all and keeps its full pane width", () => {
  const harness = makeHarness({ locals: 1 });
  const { texts, lane } = harness.view(32, 24);
  assert.equal(laneRows(lane), undefined, "a fitting list paints no track, thumb, or blank lane cell");
  assert.ok(texts.some((line) => line.trim() === "local-l1"), "the single card is drawn");
  // No column was reserved: a long title is truncated against the FULL pane width.
  const wide = makeHarness({ locals: 1 });
  wide.controller.updateItems([{ ...makeItem("long"), label: "x".repeat(60) }]);
  const wideView = wide.view(32, 24);
  const title = wideView.texts.find((line) => line.trim().startsWith("xxxx")) ?? "";
  assert.equal(title.trimEnd().length, 32, "without a lane the title uses all 32 pane columns");
  assert.ok(title.includes("..."), "the overflowing title is ellipsized, not wrapped");
});

test("the lane reserves its column: list rows are clipped one column narrower, header and footer are not", () => {
  const harness = makeHarness({ locals: 6 }); // 6*5 + 3 = 33 rows: overflow
  const cols = 32;
  const rows = 20;
  const { texts, lane } = harness.view(cols, rows);
  const laneBounds = laneRows(lane);
  assert.ok(laneBounds, "the overflowing roster paints a lane");
  const [trackTop, trackBottom] = laneBounds;
  for (let row = trackTop; row <= trackBottom; row += 1) {
    const width = visibleWidth(texts[row] ?? "");
    assert.ok(width <= cols - 1, `list row ${row} keeps a column for the lane: ${JSON.stringify(texts[row])}`);
  }
  // The header and footer were composed at the full pane width and are untouched.
  const header = texts[0];
  assert.ok(visibleWidth(header) <= cols, "the header keeps the pane width");
  const footer = texts.slice(trackBottom + 1);
  assert.ok(footer.length > 0 && footer.every((line) => visibleWidth(line) <= cols));
  // Every drawn card still keeps its full extent: the lane never clips a card to
  // manufacture overflow. A card title row is followed by its own status row.
  const titleRows = texts
    .map((line, row) => (/^local-l\d+$/.test(line.trim()) ? row : -1))
    .filter((row) => row >= 0);
  assert.ok(titleRows.length > 0, "the drawn window shows local cards");
  for (const row of titleRows) {
    assert.match((texts[row + 1] ?? "").trim(), /^(?:> )?agent /, `"${texts[row]}" keeps its status row below it`);
    assert.match((texts[row + 2] ?? "").trim(), /^(?:> )?background /, `"${texts[row]}" keeps its background row`);
  }
});

// ---------------------------------------------------------------------------
// The lane's range is the roster's own whole-card range, at both endpoints.
// ---------------------------------------------------------------------------

test("a track press at the bottom lands the one viewport on the roster's last usable whole-card window", () => {
  const harness = makeHarness({ locals: 4, hosts: [{ id: "h1", rows: ["r1", "r2"] }] });
  const cols = 32;
  const rows = 20;
  const before = harness.view(cols, rows);
  const [trackTop, trackBottom] = laneRows(before.lane) ?? [0, 0];
  const listRows = trackBottom - trackTop + 1;
  const { lastTop } = usableWindow(harness.rosterHeights, listRows);
  const expectedFirst = harness.rosterOrder[lastTop];
  assert.ok(expectedFirst, "the roster's own rule names the last usable window");

  const map = harness.presentation();
  assert.equal(map.jumpScrollbarAt(cols - 1, trackBottom, cols, rows), true,
    "a press on the bare track is handled by the lane");
  const after = harness.view(cols, rows);
  const firstTitle = after.texts
    .map((line, row) => ({ line: line.trim(), row }))
    .filter((entry) => entry.row > trackTop - 1 && harness.rosterOrder.includes(entry.line))
    .map((entry) => entry.line)[0];
  assert.equal(firstTitle, expectedFirst,
    `the bottom of the lane lands on the last usable window, not past it:\n${after.texts.join("\n")}`);

  // The thumb's LAST row now sits on the track's last row: the range endpoints
  // are pinned to the drawn track, exactly as Pi pins them.
  const thumbs = thumbRows(after.lane);
  assert.equal(thumbs.at(-1), trackBottom, "the thumb's last row reaches the track's last row at the range end");
  assert.equal(thumbs[0] >= trackTop, true, "the thumb stays inside the track");
});

test("a track press at the top returns the same viewport to the first window, and the thumb to the track top", () => {
  const harness = makeHarness({ locals: 4, hosts: [{ id: "h1", rows: ["r1", "r2"] }] });
  const cols = 32;
  const rows = 20;
  const initial = harness.view(cols, rows);
  const [trackTop, trackBottom] = laneRows(initial.lane) ?? [0, 0];
  const map = harness.presentation();
  assert.equal(map.jumpScrollbarAt(cols - 1, trackTop, cols, rows), true, "the first track row is a valid target");
  const first = harness.view(cols, rows);
  assert.equal(first.texts[1].trim(), harness.rosterOrder[0], "the top of the lane draws the roster's first entry");
  assert.equal(thumbRows(first.lane)[0], trackTop, "and puts the thumb on the track top");
  assert.equal(map.jumpScrollbarAt(cols - 1, trackBottom, cols, rows), true);
  const scrolled = harness.view(cols, rows);
  assert.notEqual(scrolled.texts.join("\n"), first.texts.join("\n"), "the bottom press moved the window");
  assert.equal(map.jumpScrollbarAt(cols - 1, trackTop, cols, rows), true);
  const back = harness.view(cols, rows);
  assert.deepEqual(back.texts, first.texts, "the top of the lane restores the first window exactly");
  assert.equal(thumbRows(back.lane)[0], trackTop, "and the thumb back to the track top");
});

test("the inverse maps a row offset to the nearest usable entry index and never past the range", () => {
  // A tall-card roster: some entry indices are NOT usable destinations because
  // their complete card cannot fit the drawn rows. The lane must land on the
  // nearest usable index instead of on a window the renderer would draw blank.
  const harness = makeHarness({ locals: 3, hosts: [{ id: "h1", rows: ["r1", "r2", "r3"] }] });
  const cols = 32;
  const rows = 16;
  const { lane } = harness.view(cols, rows);
  const [trackTop, trackBottom] = laneRows(lane) ?? [0, 0];
  const listRows = trackBottom - trackTop + 1;
  const { lastTop } = usableWindow(harness.rosterHeights, listRows);
  for (let row = trackTop; row <= trackBottom; row += 1) {
    // The thumb moves with the window, so each iteration re-reads the drawn lane
    // and re-captures the map for THAT frame, exactly as Main does after every
    // repaint. A map from an older frame describes an older thumb position.
    const currentThumbs = thumbRows(harness.view(cols, rows).lane);
    const map = harness.presentation();
    if (currentThumbs.includes(row)) {
      // The thumb belongs to the held-drag route, never to the jump route.
      assert.equal(map.jumpScrollbarAt(cols - 1, row, cols, rows), false, `thumb row ${row} is not a track jump`);
      assert.equal(map.beginScrollbarAt(cols - 1, row, cols, rows), true, `thumb row ${row} begins the drag`);
      assert.equal(harness.controller.scrollbarDragActive, true, `thumb row ${row} holds the drag`);
      assert.equal(map.endScrollbarAt(), true, `the drag begun on row ${row} ends`);
      assert.equal(harness.controller.scrollbarDragActive, false, "the completed drag leaves nothing held");
      continue;
    }
    assert.equal(map.jumpScrollbarAt(cols - 1, row, cols, rows), true, `track row ${row} is handled`);
    const drawn = harness.view(cols, rows);
    const firstTitle = drawn.texts
      .map((line) => line.trim())
      .filter((line) => harness.rosterOrder.includes(line))[0];
    const landed = harness.rosterOrder.indexOf(firstTitle);
    assert.ok(landed >= 0 && landed <= lastTop,
      `press on row ${row} landed on index ${landed}, outside the usable 0..${lastTop}:\n${drawn.texts.join("\n")}`);
    // The destination card is drawn completely, never a blank window.
    assert.ok(drawn.texts.some((line) => line.trim() === firstTitle), "the destination window draws its first card");
  }
  // A press above or below the painted track is not a lane target at all.
  const lastMap = harness.presentation();
  assert.equal(lastMap.jumpScrollbarAt(cols - 1, trackTop - 1, cols, rows), false, "no lane above the track");
  assert.equal(lastMap.jumpScrollbarAt(cols - 1, trackBottom + 1, cols, rows), false, "no lane below the track");
  assert.equal(lastMap.jumpScrollbarAt(0, trackTop, cols, rows), false, "the pane's other columns are not the lane");
});

// ---------------------------------------------------------------------------
// The held thumb drag, through the same captured seam Main drives.
// ---------------------------------------------------------------------------

test("a thumb press captures the drag; motion drives the same viewport and release only ends it", () => {
  const harness = makeHarness({ locals: 4, hosts: [{ id: "h1", rows: ["r1", "r2"] }] });
  const cols = 32;
  const rows = 20;
  const before = harness.view(cols, rows);
  const thumbs = thumbRows(before.lane);
  assert.ok(thumbs.length > 0);
  const map = harness.presentation();
  assert.equal(harness.controller.scrollbarDragActive, false, "no drag before the press");
  assert.equal(map.beginScrollbarAt(cols - 1, thumbs[1], cols, rows), true, "the thumb press begins the drag");
  assert.equal(harness.controller.scrollbarDragActive, true, "the drag is live");

  // The held thumb is drawn with the active glyph, so the operator can see which
  // thumb their button owns.
  const pressed = harness.view(cols, rows);
  assert.ok(pressed.lane.includes(ACTIVE_THUMB), "the held thumb uses the active thumb glyph");
  assert.deepEqual(pressed.texts, before.texts, "the thumb press alone moved nothing (no jump under the grab)");

  // Motion inside the pane, then OUTSIDE it (over the divider/native pane and
  // past the pane bottom), drives the SAME window and clamps to the range ends.
  const [trackTop, trackBottom] = laneRows(before.lane) ?? [0, 0];
  assert.equal(map.moveScrollbarAt(cols - 1, trackBottom, cols, rows), true);
  const movedInside = harness.view(cols, rows);
  assert.notEqual(movedInside.texts.join("\n"), before.texts.join("\n"), "motion inside the pane moved the window");
  assert.equal(map.moveScrollbarAt(cols + 12, rows + 9, cols, rows), true,
    "motion outside the roster pane still drives the live drag");
  const clamped = harness.view(cols, rows);
  const lastWindowFirst = harness.rosterOrder[usableWindow(harness.rosterHeights, trackBottom - trackTop + 1).lastTop];
  assert.ok(clamped.texts.some((line) => line.trim() === lastWindowFirst),
    "a pointer past the track bottom clamps to the last usable window");

  // Release ends the drag and moves nothing.
  assert.equal(map.endScrollbarAt(), true, "the release ends the live drag");
  assert.equal(harness.controller.scrollbarDragActive, false, "the drag is over");
  const released = harness.view(cols, rows);
  assert.deepEqual(released.texts, clamped.texts, "the release itself moved nothing");
  assert.equal(map.endScrollbarAt(), false, "the drag is ended exactly once");
  // A stale presentation from before the drag cannot drive it any more.
  const stale = harness.presentation();
  assert.equal(stale.moveScrollbarAt(cols - 1, trackTop, cols, rows), false,
    "a presentation with no live drag performs no motion");
});

test("a hidden, replaced, tiny, or non-overflowing roster retires the lane and its drag", () => {
  const harness = makeHarness({ locals: 4, hosts: [{ id: "h1", rows: ["r1", "r2"] }] });
  const cols = 32;
  const rows = 20;
  const first = harness.view(cols, rows);
  const thumbs = thumbRows(first.lane);
  const map = harness.presentation();
  assert.equal(map.beginScrollbarAt(cols - 1, thumbs[0], cols, rows), true);
  assert.equal(harness.controller.scrollbarDragActive, true);

  // The roster left the screen: the drag is retired and no stale packet drives it.
  harness.controller.handleInput(TOGGLE); // the reserved toggle hides the pane
  assert.equal(harness.controller.visible, false);
  assert.equal(harness.controller.scrollbarDragActive, false, "hiding the roster retires the lane drag");
  assert.equal(map.moveScrollbarAt(cols - 1, 5, cols, rows), false, "the captured presentation cannot move a dead drag");
  assert.equal(map.beginScrollbarAt(cols - 1, thumbs[0], cols, rows), false, "a hidden roster offers no lane target");

  // A roster that stops overflowing draws no lane and refuses the press.
  const fitting = makeHarness({ locals: 1 });
  const fittingMap = fitting.presentation();
  void fitting.view(cols, rows);
  assert.equal(fittingMap.beginScrollbarAt(cols - 1, 2, cols, rows), false, "a fitting list has no thumb to grab");
  assert.equal(fittingMap.jumpScrollbarAt(cols - 1, 2, cols, rows), false, "and no track to press");

  // A pane too small to draw any entry has no lane either.
  const tiny = makeHarness({ locals: 4 });
  const tinyMap = tiny.presentation();
  const tinyView = tiny.view(12, 4);
  assert.equal(laneRows(tinyView.lane), undefined, "the too-small fallback paints no lane");
  assert.equal(tinyMap.jumpScrollbarAt(11, 2, 12, 4), false, "no target on a fallback pane");
});

test("a resize recomputes the lane; the same roster at a taller geometry may need none", () => {
  const harness = makeHarness({ locals: 4, hosts: [{ id: "h1", rows: ["r1", "r2"] }] });
  const small = harness.view(32, 18);
  const smallLane = laneRows(small.lane);
  assert.ok(smallLane, "the short pane overflows and draws a lane");
  const [trackTop, trackBottom] = smallLane;
  assert.equal(thumbRows(small.lane).length,
    piThumbHeight(trackBottom - trackTop + 1, harness.rosterHeights.reduce((sum, height) => sum + height, 0)),
    "the short pane's thumb follows the same rule for its own track");

  const tall = harness.view(32, 48);
  assert.equal(laneRows(tall.lane), undefined, "the taller geometry fits the same roster: no lane at all");

  const narrower = harness.view(20, 18);
  const narrowLane = laneRows(narrower.lane);
  assert.ok(narrowLane, "a narrower pane still overflows and draws its lane in ITS last column");
  for (let row = narrowLane[0]; row <= narrowLane[1]; row += 1) {
    assert.ok(visibleWidth(narrower.texts[row] ?? "") <= 19,
      `the lane column is reserved at the narrower width too: ${JSON.stringify(narrower.texts[row])}`);
  }
});

// ---------------------------------------------------------------------------
// The themed lane and the terminal-default pane canvas, read from real cells.
// ---------------------------------------------------------------------------

/**
 * Write the renderer's own pane rows through the real terminal parser at
 * absolute rows, so no line is mis-mapped by the emulator's wrap-pending state
 * after a full-width row.
 */
async function drawPane(surface: TerminalSurface, lines: readonly string[]): Promise<void> {
  for (let row = 0; row < lines.length; row += 1) {
    surface.write(`\x1b[${row + 1};1H${lines[row]}`);
  }
  await surface.flush();
}

/**
 * The live appearance switch the host itself makes, up to the point where the
 * operator's choice has been emitted and Main still has to report its own save:
 * the grouped Settings row, then the Theme row, then one written-frame press on
 * the other choice. Returns the request id Main would persist under. No child,
 * native Pi theme, config file, or restart is involved.
 */
function requestLightTheme(harness: Harness): number {
  const cols = 32;
  const rows = 48;
  const roster = harness.view(cols, rows);
  const settingsRow = roster.texts.findIndex((line) => line.trim() === "Settings");
  assert.ok(settingsRow >= 0, `the roster draws its grouped Settings row:\n${roster.texts.join("\n")}`);
  assert.equal(harness.presentation().activateRosterAt(1, settingsRow, cols, rows), true,
    "the written Settings row opens the grouped menu");
  const menu = harness.controller.renderForm(cols, rows).lines
    .map((line) => line.replace(SGR_PATTERN, "").trim());
  const themeRow = menu.findIndex((line) => line === "Theme" || line === "> Theme");
  assert.ok(themeRow >= 0, `the Settings menu draws its Theme row:\n${menu.join("\n")}`);
  assert.equal(harness.presentation().activateFormRowAt(1, themeRow, cols, rows), true,
    "the written Theme row opens the Theme pane");
  const pane = harness.controller.renderForm(cols, rows).lines
    .map((line) => line.replace(SGR_PATTERN, "").trim());
  const lightRow = pane.findIndex((line) => line === "Light" || line === "> Light");
  assert.ok(lightRow >= 0, `the Theme pane draws the Light choice:\n${pane.join("\n")}`);
  assert.equal(harness.presentation().activateFormRowAt(1, lightRow, cols, rows), true,
    "one press on the drawn choice emits one save request");
  const save = harness.actions.filter((action) => action.type === "theme-save").at(-1);
  assert.ok(save && save.type === "theme-save", "exactly one theme-save action was emitted");
  return save.requestId;
}

/** Request the change and complete it, exactly as Main's save report does. */
function applyLightTheme(harness: Harness): void {
  assert.equal(harness.controller.completeThemeSave(requestLightTheme(harness), "light"), true,
    "the palette applies only when Main reports the save succeeded");
  assert.equal(harness.controller.currentTheme, "light");
}

/** Leave the Theme pane and Settings menu that the appearance switch left open. */
function closeSettings(harness: Harness): void {
  for (let press = 0; press < 3 && harness.controller.focus !== "sidebar"; press += 1) {
    harness.controller.handleInput(ESC);
  }
  assert.equal(harness.controller.focus, "sidebar", "leaving Settings closes to the roster");
}

test("both appearances give every host-owned pane row an explicit foreground and terminal-default background", async () => {
  const cases: { theme: SidebarThemeId; fgPalette: number }[] = [
    { theme: "dark", fgPalette: 7 },
    { theme: "light", fgPalette: 0 },
  ];
  for (const testCase of cases) {
    const harness = makeHarness({
      locals: 4,
      hosts: [{ id: "h1", rows: ["r1"] }],
      controllerOptions: { settingsAvailable: true },
    });
    if (testCase.theme === "light") applyLightTheme(harness);
    const cols = 32;
    const rows = 20;
    const rendered = harness.controller.renderRoster(cols, rows);
    const surface = new TerminalSurface(cols, rows);
    try {
      await drawPane(surface, rendered.lines);
      const frame = surface.frame();
      const styles = frame.styles ?? [];
      assert.equal(styles.length, rows, `every pane row carries explicit attributes (${testCase.theme})`);
      for (const line of styles) {
        assert.ok(line.runs.length > 0, `row ${line.line} has at least one styled run`);
        for (const run of line.runs) {
          assert.ok(run.fg !== undefined, `row ${line.line} run ${JSON.stringify(run.text)} has an explicit foreground`);
          assert.equal(run.fg.mode, "palette", `the ${testCase.theme} foreground is a basic palette colour`);
          assert.equal(run.bg, undefined,
            `row ${line.line} run ${JSON.stringify(run.text)} leaves the background on the terminal default`);
        }
      }
      assert.ok(styles.flatMap((line) => [...line.runs]).some((run) => run.fg?.value === testCase.fgPalette),
        `the ${testCase.theme} pane carries the appearance's canvas foreground`);
      // The scrollbar lane itself is themed, and both of its colours differ from
      // the row's canvas.
      const palette = sidebarPaletteFor(testCase.theme);
      const raw = rendered.lines.join("\n");
      assert.equal(rendered.lines.some((line) => line.includes("\x1b[40m") || line.includes("\x1b[47m")), false,
        `the ${testCase.theme} pane never paints a forced black or white whole-pane ground`);
      assert.ok(raw.includes(`\x1b[${palette.scrollbarTrack}m`),
        `the lane track uses the ${testCase.theme} palette's track role`);
      assert.ok(raw.includes(`\x1b[${palette.scrollbarThumb}m`),
        `the lane thumb uses the ${testCase.theme} palette's thumb role`);
    } finally {
      surface.dispose();
    }
  }
});

test("the focus-domain roles stay distinct with terminal-default backgrounds (no colour-only conflation)", async () => {
  // Main focus: the active-Main card title; sidebar focus: the selected target.
  // Both appearances must paint them with explicit, distinct foregrounds while
  // leaving the background native.
  for (const theme of ["dark", "light"] as const) {
    const harness = makeHarness({ locals: 2, controllerOptions: { settingsAvailable: true } });
    const palette = sidebarPaletteFor(theme);
    const rendered = harness.controller.renderRoster(32, 20);
    const surface = new TerminalSurface(32, 20);
    try {
      await drawPane(surface, rendered.lines);
      const frame = surface.frame();
      const titleRuns = (frame.styles ?? [])
        .flatMap((line) => [...line.runs])
        .filter((run) => run.text.includes("local-l1") || run.text.includes("local-l2"));
      assert.ok(titleRuns.length > 0, `${theme}: card titles are drawn`);
      for (const run of titleRuns) {
        assert.ok(run.fg !== undefined, `${theme}: a title cell carries an explicit foreground`);
        assert.equal(run.bg, undefined, `${theme}: a title cell keeps the terminal-default background`);
      }
      // The palette keeps the two roles as different parameter strings, so the
      // renderer can never merge them into one look.
      assert.notEqual(palette.activeMain, palette.selected, `${theme}: activeMain and selected stay distinct`);
      assert.notEqual(palette.selected, palette.title, `${theme}: selected and ordinary titles stay distinct`);
      assert.notEqual(palette.secondary, palette.header, `${theme}: secondary text and the header stay distinct`);
    } finally {
      surface.dispose();
    }
  }
});

// ---------------------------------------------------------------------------
// The focus-domain roles read as ACTUAL terminal cells. Two palette parameter
// strings that resolve to the same foreground index under the same boldness are
// ONE look on the screen, so the proof has to be the cell attributes the
// emulator recorded, not the palette strings compared side by side.
// ---------------------------------------------------------------------------

/**
 * The palette index a palette value's basic or bright foreground paints,
 * restated here from the SGR rule so the cell assertions name the colour the
 * palette INTENDS instead of a magic index.
 */
function paletteForegroundIndex(sgr: string): number {
  const params = sgr.split(";").map((part) => Number.parseInt(part, 10));
  const colour = params.find((part) => (part >= 30 && part <= 37) || (part >= 90 && part <= 97));
  assert.ok(colour !== undefined, `${JSON.stringify(sgr)} carries a basic or bright foreground`);
  return colour >= 90 ? colour - 90 + 8 : colour - 30;
}

/** The one drawn run carrying the `label` card's title row. */
function titleRun(surface: TerminalSurface, label: string) {
  const runs = (surface.frame().styles ?? [])
    .flatMap((line) => [...line.runs])
    .filter((run) => run.text.includes(label));
  assert.equal(runs.length, 1, `exactly one drawn cell run carries the ${JSON.stringify(label)} title`);
  return runs[0];
}

test("the actual owner's title cell stays distinct from the navigation target and from an ordinary card in both appearances", async () => {
  for (const theme of ["dark", "light"] as const) {
    const harness = makeHarness({ locals: 3, controllerOptions: { settingsAvailable: true } });
    if (theme === "light") {
      applyLightTheme(harness);
      closeSettings(harness);
    }
    // Main's content owner is one card, sidebar navigation sits on ANOTHER card,
    // and a third card is ordinary: the exact state in which the persistent
    // owner mark has to be readable.
    harness.controller.setActiveMainOwner("l1");
    harness.controller.select("l2");
    const actionsBefore = harness.actions.length;
    assert.equal(harness.controller.focus, "sidebar", `${theme}: sidebar focus keeps a separate navigation target`);
    assert.equal(harness.controller.selectedId, "l2", `${theme}: the navigation target is not the owner`);
    assert.equal(harness.controller.activeMainOwnerID, "l1", `${theme}: the content owner is unchanged`);

    const cols = 32;
    const rows = 24;
    const rendered = harness.controller.renderRoster(cols, rows);
    const surface = new TerminalSurface(cols, rows);
    try {
      await drawPane(surface, rendered.lines);
      const owner = titleRun(surface, "local-l1");
      const nav = titleRun(surface, "local-l2");
      const ordinary = titleRun(surface, "local-l3");
      for (const [name, run] of [["owner", owner], ["navigation target", nav], ["ordinary", ordinary]] as const) {
        assert.ok(run.fg !== undefined, `${theme}: the ${name} title cell carries an explicit foreground`);
        assert.equal(run.fg.mode, "palette", `${theme}: the ${name} title foreground is a basic palette colour`);
        assert.equal(run.bg, undefined, `${theme}: the ${name} title cell keeps the terminal-default background`);
        assert.equal(run.bold, true, `${theme}: the ${name} title cell keeps its bold treatment`);
      }
      // The effective cell attributes decide what the operator sees: three
      // equally bold titles in one foreground colour are indistinguishable.
      assert.notEqual(owner.fg!.value, nav.fg!.value,
        `${theme}: the owner title differs from the navigation target on the actual cells`);
      assert.notEqual(owner.fg!.value, ordinary.fg!.value,
        `${theme}: the owner title differs from an ordinary card on the actual cells`);
      assert.notEqual(nav.fg!.value, ordinary.fg!.value,
        `${theme}: the navigation target differs from an ordinary card on the actual cells`);
      // And each cell is the colour its own role intends, so the distinction is
      // the palette's, not an accident of one terminal emulator.
      const palette = sidebarPaletteFor(theme);
      assert.equal(owner.fg!.value, paletteForegroundIndex(palette.activeMain),
        `${theme}: the owner title paints the activeMain colour`);
      assert.equal(nav.fg!.value, paletteForegroundIndex(palette.selected),
        `${theme}: the navigation target paints the selected colour`);
      assert.equal(ordinary.fg!.value, paletteForegroundIndex(palette.canvas),
        `${theme}: an ordinary title is bold on the pane canvas foreground`);
    } finally {
      surface.dispose();
    }

    // The distinction is colour on top of the unchanged non-colour marks: the
    // owner card still carries no selection marker and the marker still follows
    // the navigation target, and no action was emitted anywhere.
    const plain = harness.view(cols, rows).texts.map((line) => line.trimEnd());
    const ownerRow = plain.findIndex((line) => line === "local-l1");
    const navRow = plain.findIndex((line) => line === "local-l2");
    assert.ok(ownerRow >= 0 && navRow >= 0, `${theme}: both titles draw their own rows`);
    assert.ok(plain[ownerRow + 1]?.startsWith("  "), `${theme}: the owner card keeps no selection marker`);
    assert.ok(plain[navRow + 1]?.startsWith("> "), `${theme}: the marker still follows the navigation target`);
    assert.equal(harness.actions.length, actionsBefore, `${theme}: the owner distinction emitted no action`);
  }
});

test("an owner that is also the navigation target keeps the owner cell, and that cell survives navigation moving away", async () => {
  for (const theme of ["dark", "light"] as const) {
    const harness = makeHarness({ locals: 3, controllerOptions: { settingsAvailable: true } });
    if (theme === "light") {
      applyLightTheme(harness);
      closeSettings(harness);
    }
    harness.controller.setActiveMainOwner("l1");
    harness.controller.select("l1"); // the owner IS the navigation target
    const cols = 32;
    const rows = 24;
    const palette = sidebarPaletteFor(theme);
    const ownerIndex = paletteForegroundIndex(palette.activeMain);
    const selectedIndex = paletteForegroundIndex(palette.selected);
    const canvasIndex = paletteForegroundIndex(palette.canvas);

    let surface = new TerminalSurface(cols, rows);
    try {
      await drawPane(surface, harness.controller.renderRoster(cols, rows).lines);
      assert.equal(titleRun(surface, "local-l1").fg?.value, ownerIndex,
        `${theme}: the owner role wins on a card that is both owner and target`);
      assert.notEqual(titleRun(surface, "local-l1").fg?.value, titleRun(surface, "local-l2").fg?.value,
        `${theme}: the winning owner cell is still distinguishable from an ordinary card's cells`);
      assert.equal(titleRun(surface, "local-l2").fg?.value, canvasIndex,
        `${theme}: no ordinary card borrows the owner colour`);
      assert.equal(titleRun(surface, "local-l3").fg?.value, canvasIndex,
        `${theme}: no other card is highlighted either`);
    } finally {
      surface.dispose();
    }

    // Navigation moves elsewhere; the persistent owner mark stays on its card.
    harness.controller.select("l3");
    assert.equal(harness.controller.activeMainOwnerID, "l1", `${theme}: navigation changed no content owner`);
    surface = new TerminalSurface(cols, rows);
    try {
      await drawPane(surface, harness.controller.renderRoster(cols, rows).lines);
      assert.equal(titleRun(surface, "local-l1").fg?.value, ownerIndex,
        `${theme}: the owner keeps its own cell after navigation moved away`);
      assert.equal(titleRun(surface, "local-l3").fg?.value, selectedIndex,
        `${theme}: the new navigation target paints the selected colour`);
      assert.equal(titleRun(surface, "local-l2").fg?.value, canvasIndex,
        `${theme}: the untouched ordinary card stays ordinary`);
    } finally {
      surface.dispose();
    }
  }
});

test("the too-small fallback stays readable: its inverse row keeps explicit foreground/default ground", async () => {
  const harness = makeHarness({ locals: 4, controllerOptions: { settingsAvailable: true } });
  const rendered = harness.controller.renderRoster(12, 4);
  const surface = new TerminalSurface(12, 4);
  try {
    await drawPane(surface, rendered.lines);
    const styles = surface.frame().styles ?? [];
    const banner = styles.find((line) => line.runs.some((run) => run.text.includes("too small")));
    assert.ok(banner, "the fallback row is drawn");
    const run = banner.runs.find((candidate) => candidate.text.includes("too small"))!;
    assert.equal(run.inverse, true, "the fallback keeps its inverse treatment");
    assert.ok(run.fg !== undefined, "and an explicit foreground");
    assert.equal(run.bg, undefined,
      "while its background stays the terminal default, so the inverse swap is defined natively");
  } finally {
    surface.dispose();
  }
});

test("a live theme change restyles the lane and rows without moving the viewport", () => {
  const harness = makeHarness({
    locals: 4,
    hosts: [{ id: "h1", rows: ["r1", "r2"] }],
    controllerOptions: { settingsAvailable: true },
  });
  const cols = 32;
  const rows = 20;
  const before = harness.view(cols, rows);
  const [trackTop, trackBottom] = laneRows(before.lane) ?? [0, 0];
  const map = harness.presentation();
  assert.equal(map.jumpScrollbarAt(cols - 1, trackBottom, cols, rows), true);
  // Navigate the appearance choice, then re-draw BEFORE the save completes: this
  // is the frame the operator sees while Main is writing its own settings file.
  requestLightTheme(harness);
  const afterNavigation = harness.view(cols, rows);
  assert.equal(harness.controller.currentTheme, "dark",
    "an unreported save applies no palette yet");
  assert.equal(harness.controller.completeThemeSave(harness.actions
    .filter((action) => action.type === "theme-save").at(-1)!.requestId, "light"), true);

  const restyled = harness.view(cols, rows);
  assert.deepEqual(restyled.texts, afterNavigation.texts, "the appearance change moved no row of the list");
  assert.deepEqual(laneRows(restyled.lane), laneRows(afterNavigation.lane), "and did not move the lane");
  const palette = sidebarPaletteFor("light");
  assert.ok(restyled.raw.join("\n").includes(`\x1b[${palette.scrollbarThumb}m`),
    "the lane is repainted with the new appearance's thumb colour");
  assert.ok(!restyled.raw.join("\n").includes(`\x1b[${sidebarPaletteFor("dark").scrollbarThumb}m`),
    "the previous appearance's lane colour is gone, not layered under the new one");
});

// ---------------------------------------------------------------------------
// #613 review pass 1: the lane consumes a no-op track press, and a held drag is
// bound to the content and range it was pressed against.
// ---------------------------------------------------------------------------

/** Bare (non-thumb) rows of the lane one render painted, in order. */
function bareRows(lane: readonly (string | undefined)[]): number[] {
  const bounds = laneRows(lane);
  assert.ok(bounds, "the render painted a lane");
  const thumbs = new Set(thumbRows(lane));
  const rows: number[] = [];
  for (let row = bounds[0]; row <= bounds[1]; row += 1) {
    if (!thumbs.has(row)) rows.push(row);
  }
  return rows;
}

test("a track press that maps back to the window already on screen is still consumed by the lane", () => {
  // Mixed card heights in a short window: one 5-row local card, then 6-row remote
  // cards taller than the drawn rows, then the 1-row host actions. Several offsets
  // the track maps to have NO usable destination of their own (the remote cards do
  // not fit), and the nearest usable index can be the window already drawn. The
  // press must still be consumed by the lane: a false here would hand the click to
  // the row underneath and let its release activate it.
  const harness = makeHarness({ locals: 1, hosts: [{ id: "h1", rows: ["r1", "r2", "r3"] }] });
  const cols = 32;
  const rows = 10;
  const first = harness.view(cols, rows);
  const [trackTop, trackBottom] = laneRows(first.lane) ?? [0, 0];
  assert.equal(harness.presentation().jumpScrollbarAt(cols - 1, trackTop, cols, rows), true,
    "the top of the track jumps to the first window");
  const atTop = harness.view(cols, rows);
  assert.equal(atTop.texts[1].trim(), harness.rosterOrder[0],
    `the first window draws the local card:\n${atTop.texts.join("\n")}`);

  // The bare row nearest the thumb now maps to a small offset whose nearest usable
  // index is the window already on screen: the local card, because every remote card
  // is taller than the drawn rows and cannot start a window at all.
  const bare = bareRows(atTop.lane);
  assert.ok(bare.length > 0, "the short track still has bare rows outside the thumb");
  const row = bare[0];
  const actionsBefore = harness.actions.length;
  const map = harness.presentation();
  assert.equal(map.jumpScrollbarAt(cols - 1, row, cols, rows), true,
    `the painted track consumed the no-op press on row ${row}`);
  const after = harness.view(cols, rows);
  assert.deepEqual(after.texts, atTop.texts,
    `the no-op press moved nothing and was not passed through:\n${after.texts.join("\n")}`);
  assert.equal(harness.actions.length, actionsBefore,
    "the lane press emitted no action: no card or host action underneath was activated");
  assert.equal(harness.controller.focus, "sidebar", "the lane press took no focus");
  assert.equal(harness.controller.scrollbarDragActive, false, "a track press is not a held drag");
  // Its later motion and release packets belong to nothing: they are refused rather
  // than resolved against a row the operator never pressed.
  const afterMap = harness.presentation();
  assert.equal(afterMap.moveScrollbarAt(cols - 1, trackBottom, cols, rows), false, "no motion route");
  assert.equal(afterMap.endScrollbarAt(), false, "no release route");
  assert.equal(harness.actions.length, actionsBefore, "and nothing was activated in the end");
});

test("a roster change that still overflows retires a held lane drag on the render that changed the range", () => {
  const harness = makeHarness({ locals: 4, hosts: [{ id: "h1", rows: ["r1", "r2"] }] });
  const cols = 32;
  const rows = 20;
  const first = harness.view(cols, rows);
  const thumbs = thumbRows(first.lane);
  const map = harness.presentation();
  assert.equal(map.beginScrollbarAt(cols - 1, thumbs[0], cols, rows), true, "the drag begins");
  assert.equal(harness.controller.scrollbarDragActive, true);

  // A new remote card arrives and the list STILL overflows: the track is still
  // painted, but it is a different range than the one the grab was pressed
  // against, so the held gesture retires on this render rather than driving rows
  // the operator never pressed.
  harness.controller.setPeerUiSnapshot(makeSnapshot([
    { id: "h1", rows: ["r1", "r2", "r3"] },
  ]));
  const after = harness.view(cols, rows);
  assert.ok(laneRows(after.lane), "the changed roster still overflows and still paints a lane");
  assert.equal(harness.controller.scrollbarDragActive, false,
    "the held drag was retired by the render whose content changed, not by the next mouse packet");
  const stale = harness.presentation();
  const beforeStale = harness.view(cols, rows);
  assert.equal(stale.moveScrollbarAt(cols - 1, (laneRows(beforeStale.lane) ?? [0, 0])[1], cols, rows), false,
    "the stale motion packet performs no scroll");
  const afterStale = harness.view(cols, rows);
  assert.deepEqual(afterStale.texts, beforeStale.texts, "and moved nothing");
});

test("display-only repaints keep a held lane drag alive, while a drawn-height change retires it", () => {
  const harness = makeHarness({ locals: 4, hosts: [{ id: "h1", rows: ["r1", "r2"] }] });
  const cols = 32;
  const rows = 20;
  const first = harness.view(cols, rows);
  const thumbs = thumbRows(first.lane);
  const map = harness.presentation();
  assert.equal(map.beginScrollbarAt(cols - 1, thumbs[0], cols, rows), true);

  // Same content, same range: a plain repaint, then a wheel notch (which moves the
  // WINDOW, not the range), then a keyboard highlight move. None of them may drop a
  // gesture the operator is still holding, and the hold still drives the viewport.
  harness.view(cols, rows);
  assert.equal(harness.controller.scrollbarDragActive, true, "an ordinary repaint keeps the hold");
  const presentation = harness.presentation();
  const [trackTop] = laneRows(harness.view(cols, rows).lane) ?? [0, 0];
  presentation.scrollRosterAt(1, trackTop + 1, cols, rows, 1);
  harness.view(cols, rows);
  assert.equal(harness.controller.scrollbarDragActive, true, "a window move keeps the hold");
  harness.controller.handleInput(DOWN);
  harness.view(cols, rows);
  assert.equal(harness.controller.scrollbarDragActive, true, "a highlight move keeps the hold");
  const held = harness.presentation();
  const moved = held.moveScrollbarAt(cols - 1, trackTop, cols, rows);
  assert.equal(moved, true, "the surviving hold still drives the same viewport");

  // Contrast: collapsing a card changes what one entry costs, so the range the grab
  // was pressed against no longer exists and the hold retires on that render.
  harness.controller.select("l1");
  harness.view(cols, rows);
  assert.equal(harness.controller.scrollbarDragActive, true, "selecting a card keeps the hold");
  harness.controller.handleInput(" "); // space collapses the highlighted local card
  harness.view(cols, rows);
  assert.equal(harness.controller.scrollbarDragActive, false,
    "a drawn entry-height change retires the held drag");
});

test("the too-small roster fallback retires a held lane drag with no track to hold", () => {
  const harness = makeHarness({ locals: 4 });
  const cols = 32;
  const rows = 20;
  const first = harness.view(cols, rows);
  const thumbs = thumbRows(first.lane);
  const map = harness.presentation();
  assert.equal(map.beginScrollbarAt(cols - 1, thumbs[0], cols, rows), true);
  assert.equal(harness.controller.scrollbarDragActive, true);

  // A content/geometry change that lands the roster on its too-small fallback
  // draws no track at all. The drag ends on THAT render, so the outer terminal is
  // never left in temporary drag reporting waiting for another mouse packet.
  const tiny = harness.view(12, 4);
  assert.equal(laneRows(tiny.lane), undefined, "the fallback paints no lane");
  assert.equal(harness.controller.scrollbarDragActive, false, "and the held drag is retired by it");
  assert.equal(map.moveScrollbarAt(cols - 1, 3, cols, rows), false, "no stale motion drives anything");
});
