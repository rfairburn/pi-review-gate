import assert from "node:assert/strict";
import test from "node:test";
import * as sidebarScrollbar from "../src/session-host/sidebar-scrollbar";
import {
  sidebarScrollbarGeometry,
  sidebarScrollbarOffsetAt,
  type SidebarScrollbarGeometry,
} from "../src/session-host/sidebar-scrollbar";

/**
 * Pure geometry contract for the sidebar scrollbar (#613). These cases pin the
 * numbers Pi 1.5.0's own chat scrollbar produces (verified against the pinned
 * dependency's track/thumb layout: `thumbHeight = max(min(2, trackHeight),
 * min(trackHeight, round(trackHeight squared / contentHeight)))`,
 * `thumbTop = trackTop + round(offset / maxOffset * travel)`,
 * `travel = trackHeight - thumbHeight`, and the press inverse
 * `round(clamp(pointerRow - trackTop - grabOffset, 0, travel) / travel *
 * maxOffset)`), plus the two deliberate deviations this helper makes: the offset
 * range is the CALLER's usable whole-card range rather than
 * `contentHeight - trackHeight`, and a track with no thumb travel keeps the
 * current offset instead of Pi's reset-to-top.
 *
 * Nothing here renders, stores state, or touches input: the integration owns the
 * glyphs (track, idle thumb, active thumb), the theme, and the one `listTop`
 * viewport these numbers describe.
 */

/** Independent restatement of the pinned Pi thumb-size rule for cross-checking. */
function piThumbHeight(trackHeight: number, contentHeight: number): number {
  return Math.max(
    Math.min(2, trackHeight),
    Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
  );
}

function assertInsideTrack(geometry: SidebarScrollbarGeometry): void {
  assert.ok(
    geometry.thumbTop >= geometry.trackTop,
    `thumb above the track: ${JSON.stringify(geometry)}`,
  );
  assert.ok(
    geometry.thumbTop + geometry.thumbHeight <= geometry.trackTop + geometry.trackHeight,
    `thumb past the last track row: ${JSON.stringify(geometry)}`,
  );
  assert.ok(
    geometry.thumbHeight >= 1 && geometry.thumbHeight <= geometry.trackHeight,
    `thumb height outside the track: ${JSON.stringify(geometry)}`,
  );
  assert.ok(
    geometry.offset >= 0 && geometry.offset <= geometry.maxOffset,
    `represented offset outside the caller's range: ${JSON.stringify(geometry)}`,
  );
}

test("an overflowing roster gets a Pi-sized thumb with endpoints pinned to the track ends", () => {
  // A 10-row track holding 30 content rows: Pi draws a 3-row thumb with 7 rows of
  // travel, so offset 0 sits on the first track row and maxOffset puts the thumb's
  // LAST row on the last track row.
  const geometry = sidebarScrollbarGeometry(39, 2, 10, 30, 0, 20);
  assert.ok(geometry);
  assert.equal(geometry.column, 39);
  assert.equal(geometry.trackTop, 2);
  assert.equal(geometry.trackHeight, 10);
  assert.equal(geometry.thumbHeight, 3);
  assert.equal(geometry.maxOffset, 20);
  assert.equal(geometry.offset, 0);
  assert.equal(geometry.thumbTop, 2);
  assertInsideTrack(geometry);

  const middle = sidebarScrollbarGeometry(39, 2, 10, 30, 10, 20);
  assert.ok(middle);
  // round(10 / 20 * 7) = 4 rows of travel.
  assert.equal(middle.thumbTop, 6);
  assertInsideTrack(middle);

  const end = sidebarScrollbarGeometry(39, 2, 10, 30, 20, 20);
  assert.ok(end);
  assert.equal(end.thumbTop, 9);
  assert.equal(end.thumbTop + end.thumbHeight - 1, 2 + 10 - 1);
  assertInsideTrack(end);
});

test("thumb height follows the pinned Pi rule across tall, short, and tiny tracks", () => {
  const sizes: Array<[number, number]> = [
    [40, 200],
    [24, 120],
    [12, 13],
    [5, 25],
    [3, 100],
    [2, 3],
    [1, 100],
  ];
  for (const [trackHeight, contentHeight] of sizes) {
    const geometry = sidebarScrollbarGeometry(0, 0, trackHeight, contentHeight, 0, 7);
    assert.ok(geometry, `expected a track for ${trackHeight}/${contentHeight}`);
    assert.equal(geometry.thumbHeight, piThumbHeight(trackHeight, contentHeight));
    // Never taller than the track, and never below 2 rows unless the track itself
    // is shorter than 2 rows.
    assert.ok(geometry.thumbHeight <= trackHeight);
    assert.ok(geometry.thumbHeight >= Math.min(2, trackHeight));
    assertInsideTrack(geometry);
  }
});

test("a list that fits its rows gets no scrollbar at all", () => {
  // Exactly fitting and comfortably fitting both hide the track: nothing is
  // hidden, so there is nothing to grab and no idle column to paint.
  assert.equal(sidebarScrollbarGeometry(39, 2, 10, 10, 0, 20), undefined);
  assert.equal(sidebarScrollbarGeometry(39, 2, 10, 4, 0, 20), undefined);
  assert.equal(sidebarScrollbarGeometry(39, 2, 1, 1, 0, 1), undefined);
});

test("unusable geometry inputs return undefined instead of an invented track", () => {
  const invalid: Array<[number, number, number, number, number, number]> = [
    // Negative placement or range.
    [-1, 0, 10, 30, 0, 20],
    [0, -1, 10, 30, 0, 20],
    [0, 0, -10, 30, 0, 20],
    [0, 0, 10, -30, 0, 20],
    [0, 0, 10, 30, -1, 20],
    [0, 0, 10, 30, 0, -20],
    // Zero-height track and zero-length range cannot describe a scroll position.
    [0, 0, 0, 30, 0, 20],
    [0, 0, 10, 30, 0, 0],
    // Non-integers, infinities, NaN, and values past exact integer arithmetic.
    [0.5, 0, 10, 30, 0, 20],
    [0, 0.5, 10, 30, 0, 20],
    [0, 0, 10.5, 30, 0, 20],
    [0, 0, 10, 30.5, 0, 20],
    [0, 0, 10, 30, 2.5, 20],
    [0, 0, 10, 30, 0, 1.5],
    [Number.NaN, 0, 10, 30, 0, 20],
    [0, 0, Number.POSITIVE_INFINITY, 30, 0, 20],
    [0, 0, 10, Number.NaN, 0, 20],
    [0, 0, 10, 30, Number.NaN, 20],
    [0, 0, 10, 30, 0, Number.POSITIVE_INFINITY],
    [0, 0, 10, 30, Number.MAX_SAFE_INTEGER + 2, 20],
    [2 ** 53, 0, 10, 30, 0, 20],
  ];
  for (const args of invalid) {
    assert.equal(sidebarScrollbarGeometry(...args), undefined, `accepted ${JSON.stringify(args)}`);
  }
});

test("an offset past the caller's range is clamped, and the geometry reports the clamped value", () => {
  const clamped = sidebarScrollbarGeometry(39, 2, 10, 30, 99, 20);
  const atEnd = sidebarScrollbarGeometry(39, 2, 10, 30, 20, 20);
  assert.ok(clamped && atEnd);
  assert.equal(clamped.offset, 20);
  assert.deepEqual(clamped, atEnd);
  assertInsideTrack(clamped);
});

test("the range is the caller's usable whole-card range, not contentHeight minus trackHeight", () => {
  // The roster's last usable listTop stops early so its tail card stays complete
  // (#439). With 30 content rows in a 10-row track, contentHeight - trackHeight
  // would be 20, but this caller says the usable range is 12: every number below
  // comes from 12, and the helper never invents the extra 8 rows.
  const geometry = sidebarScrollbarGeometry(39, 2, 10, 30, 12, 12);
  assert.ok(geometry);
  assert.equal(geometry.maxOffset, 12);
  assert.equal(geometry.thumbHeight, 3);
  assert.equal(geometry.thumbTop, 9);
  assertInsideTrack(geometry);

  const smaller = sidebarScrollbarGeometry(39, 2, 10, 30, 4, 3);
  assert.ok(smaller);
  assert.equal(smaller.offset, 3);
  assert.equal(smaller.thumbTop, 9);

  // A grab at the bottom of the track lands on 12, never on 20.
  assert.equal(sidebarScrollbarOffsetAt(geometry, 2 + 10 - 1, Math.floor(3 / 2)), 12);
  // Halfway through the travel lands on half of 12 (within one row, because the
  // thumb can only land on whole rows), never on half of 20.
  const half = sidebarScrollbarGeometry(39, 2, 10, 30, 6, 12);
  assert.ok(half);
  assert.equal(half.thumbTop, 6);
  const halfPress = sidebarScrollbarOffsetAt(half, half.thumbTop, 0);
  assert.ok(halfPress >= 5 && halfPress <= 7, `half travel landed at ${halfPress}`);
  assert.ok(halfPress < 10, `half travel used a 20-row range: ${halfPress}`);
});

test("a track with no thumb travel keeps the current offset instead of jumping to the top", () => {
  // Pi's own inverse resets to 0 when the thumb cannot move. The thumb fills the
  // track only when the track is 1 or 2 rows tall (Pi's 2-row minimum is the
  // track), and on such a track a pointer press is a visible jump to the top in
  // Pi; here the offset stays where it was.
  const cases: Array<[number, number, number, number]> = [
    [1, 100, 17, 40],
    [1, 100, 0, 40],
    [1, 100, 40, 40],
    [1, 2, 1, 1],
    [2, 3, 1, 1],
    [2, 100, 5, 9],
  ];
  for (const [trackHeight, contentHeight, offset, maxOffset] of cases) {
    const geometry = sidebarScrollbarGeometry(39, 5, trackHeight, contentHeight, offset, maxOffset);
    assert.ok(geometry, `expected a track for ${trackHeight}/${contentHeight}`);
    assert.equal(geometry.thumbHeight, trackHeight);
    assert.equal(geometry.thumbTop, 5);
    assertInsideTrack(geometry);
    for (let pointerRow = 0; pointerRow < 40; pointerRow += 1) {
      const grabs: number[] = [0, Math.floor(geometry.thumbHeight / 2), geometry.thumbHeight - 1];
      for (const grabOffset of grabs) {
        assert.equal(
          sidebarScrollbarOffsetAt(geometry, pointerRow, grabOffset),
          offset,
          `no-travel track moved: ${trackHeight}/${contentHeight} at row ${pointerRow}`,
        );
      }
    }
  }
});

test("a track press centers the thumb and clamps to the real ends with no extrapolation", () => {
  const geometry = sidebarScrollbarGeometry(39, 1, 20, 60, 0, 40);
  assert.ok(geometry);
  assert.equal(geometry.thumbHeight, 7);
  const grabOffset = Math.floor(geometry.thumbHeight / 2);
  const travel = geometry.trackHeight - geometry.thumbHeight;
  assert.equal(travel, 13);

  // The first track row and every row above it give the top of the range.
  assert.equal(sidebarScrollbarOffsetAt(geometry, 1, grabOffset), 0);
  assert.equal(sidebarScrollbarOffsetAt(geometry, 0, grabOffset), 0);
  // The row that puts the thumb's travel at its end gives the caller's maxOffset,
  // and every row below the track stays at maxOffset rather than going past it.
  assert.equal(sidebarScrollbarOffsetAt(geometry, 1 + travel + grabOffset, grabOffset), 40);
  assert.equal(sidebarScrollbarOffsetAt(geometry, 1 + geometry.trackHeight - 1, grabOffset), 40);
  assert.equal(sidebarScrollbarOffsetAt(geometry, 400, grabOffset), 40);

  // The whole track maps monotonically into [0, maxOffset] with no backward steps.
  let previous = 0;
  for (let pointerRow = 1; pointerRow < 1 + geometry.trackHeight; pointerRow += 1) {
    const offset = sidebarScrollbarOffsetAt(geometry, pointerRow, grabOffset);
    assert.ok(offset >= 0 && offset <= geometry.maxOffset, `offset out of range at row ${pointerRow}`);
    assert.ok(offset >= previous, `offset moved backwards at row ${pointerRow}`);
    previous = offset;
  }
  assert.equal(previous, 40);
});

test("a thumb press keeps the thumb exactly where it was grabbed when travel and range match", () => {
  // 12-row track, 24 content rows: thumbHeight 6, travel 6. With maxOffset 6 the
  // offset domain and the thumb travel line up, so grabbing the thumb at any of
  // its rows and releasing in place is exact in both directions.
  const trackTop = 2;
  for (const grabOffset of [0, 3, 5]) {
    for (let offset = 0; offset <= 6; offset += 1) {
      const geometry = sidebarScrollbarGeometry(39, trackTop, 12, 24, offset, 6);
      assert.ok(geometry);
      assert.equal(geometry.thumbTop, trackTop + offset);
      const pointerRow = geometry.thumbTop + grabOffset;
      const pressed = sidebarScrollbarOffsetAt(geometry, pointerRow, pointerRow - geometry.thumbTop);
      assert.equal(pressed, offset, `thumb press moved offset ${offset} at row ${pointerRow}`);
      const redrawn = sidebarScrollbarGeometry(39, trackTop, 12, 24, pressed, 6);
      assert.ok(redrawn);
      assert.equal(redrawn.thumbTop, geometry.thumbTop);
      assert.ok(pointerRow >= redrawn.thumbTop && pointerRow < redrawn.thumbTop + redrawn.thumbHeight);
    }
  }
});

test("an inverse fed an unusable pointer or grab offset returns the current offset", () => {
  const geometry = sidebarScrollbarGeometry(39, 1, 20, 60, 17, 40);
  assert.ok(geometry);
  assert.equal(geometry.offset, 17);
  const pointers = [-1, -100, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53];
  for (const pointerRow of pointers) {
    assert.equal(sidebarScrollbarOffsetAt(geometry, pointerRow, 3), 17, `accepted pointer ${pointerRow}`);
  }
  const grabs = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY];
  for (const grabOffset of grabs) {
    assert.equal(sidebarScrollbarOffsetAt(geometry, 10, grabOffset), 17, `accepted grab ${grabOffset}`);
  }

  // A hand-built geometry that cannot produce an integer result still returns the
  // offset it represents rather than NaN.
  const malformed: SidebarScrollbarGeometry = {
    column: 39,
    trackTop: 1,
    trackHeight: Number.NaN,
    thumbTop: 1,
    thumbHeight: 7,
    maxOffset: 40,
    offset: 17,
  };
  assert.equal(sidebarScrollbarOffsetAt(malformed, 10, 3), 17);
});

test("the module surface stays the settled pure helpers with no state", () => {
  assert.deepEqual(Object.keys(sidebarScrollbar).sort(), [
    "sidebarScrollbarGeometry",
    "sidebarScrollbarOffsetAt",
  ]);
  // Same inputs, same numbers: no hidden counter, cache, or first-call behavior.
  const first = sidebarScrollbarGeometry(39, 2, 10, 30, 7, 20);
  const second = sidebarScrollbarGeometry(39, 2, 10, 30, 7, 20);
  assert.deepEqual(first, second);
  assert.ok(first && second);
  assert.equal(
    sidebarScrollbarOffsetAt(first, first.thumbTop, 0),
    sidebarScrollbarOffsetAt(second, second.thumbTop, 0),
  );
});
