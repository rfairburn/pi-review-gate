/**
 * Pure Pi-styled scrollbar geometry for the session-host sidebar roster (#613).
 *
 * This module is arithmetic on terminal rows and nothing else: no state, no I/O,
 * no timers, no rendering, no theme, no input handling, and no import of Pi's
 * private TUI internals. It reproduces the numbers the pinned Pi 1.5.0 chat
 * scrollbar draws — the same thumb-height rule, the same track-relative thumb
 * placement, and the same press-to-offset inverse — so a sidebar scrollbar reads
 * the way the operator's chat scrollbar already reads. The glyphs (`│` track,
 * `┃` idle thumb, `█` active thumb) belong to the rendering integration and the
 * app-owned theme; nothing here emits, imports, or owns a glyph.
 *
 * Whole-card compatibility:
 *
 * The sidebar draws only COMPLETE cards and keeps exactly ONE viewport position,
 * `listTop`, an entry index whose largest usable value is the topmost index whose
 * complete tail still fits the available list rows (#439). The caller therefore
 * supplies `maxOffset` as the cumulative content rows BEFORE that LAST USABLE
 * `listTop`, NOT `contentHeight - trackHeight`. This helper never computes,
 * widens, narrows, or reinterprets that range: it maps an offset in
 * `[0, maxOffset]` onto the track and back, so the scrollbar can never express a
 * scroll position the roster renderer would draw empty, and the existing scroll
 * range, order, and viewport stay exactly as they are.
 *
 * `contentHeight` is used only for the overflow test and the thumb-size ratio,
 * exactly as Pi uses the content box height there.
 *
 * Fail-closed rules (no silent defaults, no extrapolation):
 *
 * - `sidebarScrollbarGeometry` returns `undefined` — "draw no scrollbar" — for a
 *   list that already fits (`contentHeight <= trackHeight`, so nothing is
 *   hidden), for any non-safe-integer input, and for a negative `column`,
 *   `trackTop`, `offset`, `contentHeight`, or `trackHeight`, a zero
 *   `trackHeight`, or a zero `maxOffset`. An out-of-range `undefined` never
 *   becomes a zero-height thumb, a top-reset, or a made-up track.
 * - An offset above `maxOffset` is clamped to `maxOffset` for thumb placement,
 *   and the returned geometry reports the clamped offset, so a later inverse
 *   cannot disagree with what was drawn.
 * - `sidebarScrollbarOffsetAt` returns the geometry's own represented offset for
 *   an unusable pointer row or grab offset, and for a track with no thumb travel
 *   (`thumbHeight === trackHeight`). Pi's own inverse resets to offset 0 in that
 *   last case, which is a visible jump-to-top on a viewport too short for the
 *   thumb to move; this inverse keeps the current position instead. A pointer
 *   outside the track clamps to the nearest END of the caller's real range; it
 *   never produces an offset beyond `maxOffset`.
 */

/**
 * One drawn scrollbar track. Every field is a non-negative integer terminal row
 * (or column) in the caller's absolute screen coordinates, which is what the
 * pointer hit map and the renderer both already speak.
 */
export interface SidebarScrollbarGeometry {
  /** The single terminal column the track occupies. */
  readonly column: number;
  /** First row of the track. */
  readonly trackTop: number;
  /** Rows the track spans; at least 1 whenever geometry exists. */
  readonly trackHeight: number;
  /** First row of the thumb, in the same coordinates as `trackTop`. */
  readonly thumbTop: number;
  /** Rows the thumb covers, always 1..trackHeight. */
  readonly thumbHeight: number;
  /** Largest representable offset (inclusive), as supplied by the caller. */
  readonly maxOffset: number;
  /** The offset this geometry represents, already clamped into [0, maxOffset]. */
  readonly offset: number;
}

/**
 * Terminal-row arithmetic only accepts a finite, integral, exactly representable
 * value. `Number.isSafeInteger` rejects `NaN`, both infinities, fractional rows,
 * and values past the integer-exact range in one check, so a corrupted frame
 * size can never be silently rounded into a plausible track.
 */
function isRow(value: number): boolean {
  return Number.isSafeInteger(value);
}

/**
 * The thumb height Pi 1.5.0 uses for a track of `trackHeight` rows holding
 * `contentHeight` rows of content: at least 2 rows whenever the track can spare
 * them, never taller than the track, otherwise proportional to the visible
 * fraction (`trackHeight² / contentHeight`).
 */
function piThumbHeight(trackHeight: number, contentHeight: number): number {
  return Math.max(
    Math.min(2, trackHeight),
    Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
  );
}

/**
 * Geometry for one idle-or-active scrollbar track, or `undefined` when no
 * scrollbar may be drawn at all (see the fail-closed rules above).
 *
 * Inputs are integer terminal rows in the caller's absolute coordinates:
 * `column`, `trackTop`, `trackHeight`, `contentHeight` (total content rows),
 * `offset` (the caller's current position, clamped to `maxOffset` here), and
 * `maxOffset` (the caller's real usable range — for the roster, the cumulative
 * content rows before its last usable whole-card `listTop`).
 *
 * The thumb placement is Pi's: `thumbTop = trackTop + round(offset / maxOffset *
 * travel)` with `travel = trackHeight - thumbHeight`, so offset 0 lands the thumb
 * on the first track row and `maxOffset` lands its LAST row on the final track
 * row.
 */
export function sidebarScrollbarGeometry(
  column: number,
  trackTop: number,
  trackHeight: number,
  contentHeight: number,
  offset: number,
  maxOffset: number,
): SidebarScrollbarGeometry | undefined {
  if (!isRow(column) || column < 0) return undefined;
  if (!isRow(trackTop) || trackTop < 0) return undefined;
  if (!isRow(trackHeight) || trackHeight <= 0) return undefined;
  if (!isRow(contentHeight) || contentHeight < 0) return undefined;
  if (!isRow(offset) || offset < 0) return undefined;
  if (!isRow(maxOffset) || maxOffset <= 0) return undefined;
  // Nothing hidden: a list that fits its rows has nothing to scroll and gets no
  // track at all, exactly as Pi hides an "auto" scrollbar.
  if (contentHeight <= trackHeight) return undefined;

  const thumbHeight = piThumbHeight(trackHeight, contentHeight);
  const travel = trackHeight - thumbHeight;
  const clampedOffset = Math.min(offset, maxOffset);
  const thumbTop = trackTop + Math.round((clampedOffset / maxOffset) * travel);
  return { column, trackTop, trackHeight, thumbTop, thumbHeight, maxOffset, offset: clampedOffset };
}

/**
 * The offset a pointer row asks for, given where the press grabbed the thumb.
 *
 * The caller supplies the grab offset Pi uses: `pointerRow - thumbTop` for a
 * press that landed ON the thumb, and `Math.floor(thumbHeight / 2)` for a press
 * on the bare track, so a track press centers the thumb under the pointer.
 *
 * Inverse of the placement above: `row = clamp(pointerRow - trackTop -
 * grabOffset, 0, travel)` then `round(row / travel * maxOffset)`. The result is
 * always inside `[0, maxOffset]` — a press above the track gives 0 and a press
 * below it gives `maxOffset`, never an extrapolated position outside the
 * caller's real range.
 *
 * A geometry whose thumb fills the track (`travel === 0`) has no position to
 * move to, so this returns the geometry's own represented offset rather than Pi's
 * reset-to-top. An unusable `pointerRow` or `grabOffset` (non-safe integer or
 * negative) likewise returns the current offset instead of jumping anywhere.
 *
 * `geometry` is expected to come from `sidebarScrollbarGeometry`; a hand-built
 * object that yields a non-integer result also returns the current offset rather
 * than `NaN`.
 */
export function sidebarScrollbarOffsetAt(
  geometry: SidebarScrollbarGeometry,
  pointerRow: number,
  grabOffset: number,
): number {
  const current = geometry.offset;
  if (!isRow(pointerRow) || pointerRow < 0) return current;
  if (!isRow(grabOffset) || grabOffset < 0) return current;
  const travel = geometry.trackHeight - geometry.thumbHeight;
  if (travel <= 0) return current;
  const row = Math.min(Math.max(pointerRow - geometry.trackTop - grabOffset, 0), travel);
  const offset = Math.round((row / travel) * geometry.maxOffset);
  if (!Number.isSafeInteger(offset)) return current;
  return Math.min(Math.max(offset, 0), geometry.maxOffset);
}
