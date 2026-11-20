/**
 * The one shared mouse-routing seam for extension-owned text fields (#714).
 *
 * Every audited extension text-entry family embeds a NATIVE pi-tui text
 * component: the `Editor` (session-host fields, the in-Pi native editor
 * bridge, and the AskUserQuestion popup's free-text row) or the single-line
 * `Input` (the Saved-conversation query and the settings deny-picker query).
 * Both components already own their caret mapping through their public
 * `handleMouse(event)` method: `Editor` maps a completed left `click` through
 * its own wrapped visual-line map, grapheme segmentation, paste-marker
 * awareness, horizontal padding, and scroll offset; `Input` maps a left
 * `press` on its single row through its own horizontal scroll window. This
 * module never re-implements any of that. It only:
 *
 * - translates a host-local event into the native component's own local
 *   coordinates through ONE explicit drawn region (where the component's rows
 *   were actually written, which component row was written first after
 *   scrolling or clipping, and the component's own rendered size), refusing
 *   every coordinate outside that region; and
 * - builds the one native event a HOST-OWNED, already-authorized press stands
 *   for, so a host that owns the whole gesture (the session-host sidebar,
 *   where Main authorizes row actions on the press and fences the matching
 *   release/motion) delivers exactly the native convention each component
 *   expects: a completed `click` for `Editor`, a `press` for `Input`.
 *
 * Components embedded inside Pi's own TUI receive Pi's real mouse events and
 * forward them unchanged in type through {@link routeNativeTextFieldMouse}, so
 * native click/selection semantics survive: presses, drags, and releases the
 * native Editor does not consume stay unhandled and remain Pi's native text
 * selection.
 *
 * Contract useful to other consumers: a text-field wrapper MAY expose the
 * optional {@link NativeTextMouseTarget.handleMouse} method; callers must treat
 * it as optional and keep keyboard behavior unchanged when it is absent. The
 * result is the native component's own result (or undefined); this seam never
 * fabricates a handled result for an event the native component refused.
 */

/** Structural subset of pi-tui's normalized `TuiMouseEvent` (zero-based cells). */
export interface TextFieldMouseEvent {
  type: "press" | "release" | "move" | "drag" | "click" | "wheel";
  button: "left" | "middle" | "right" | "none";
  /** Coordinates local to the receiving component. */
  x: number;
  y: number;
  /** Absolute terminal coordinates (informational; never used for mapping here). */
  screenX?: number;
  screenY?: number;
  /** Current bounds of the receiving component. */
  width: number;
  height: number;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  wheelDelta?: number;
  clickCount?: number;
}

/** The complete normalized event shape the pinned native components require. */
export interface NativeMouseEvent extends TextFieldMouseEvent {
  screenX: number;
  screenY: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/**
 * Fill the optional informational fields a native handler's type requires,
 * without changing the event's type, button, coordinates, bounds, wheel delta,
 * or click count.
 */
export function completeNativeMouseEvent(event: TextFieldMouseEvent): NativeMouseEvent {
  return {
    ...event,
    screenX: typeof event.screenX === "number" ? event.screenX : event.x,
    screenY: typeof event.screenY === "number" ? event.screenY : event.y,
    shift: event.shift === true,
    alt: event.alt === true,
    ctrl: event.ctrl === true,
  };
}

/** Structural subset of pi-tui's `TuiMouseEventResult`. */
export interface TextFieldMouseResult {
  handled?: boolean;
  capture?: boolean;
  focus?: boolean;
  render?: boolean;
}

/** Any native component (or wrapper) that may accept normalized mouse events. */
export interface NativeTextMouseTarget {
  handleMouse?(event: TextFieldMouseEvent): TextFieldMouseResult | undefined;
}

/**
 * Where a native text component's rows were actually written in the caller's
 * own local coordinates.
 *
 * - `left`/`top`: the caller-local cell where the component's column 0 and
 *   its first WRITTEN row landed.
 * - `width`: the width the component was rendered at (its own layout width).
 * - `rows`: how many of the component's rows were written (after clipping).
 * - `firstRow`: the component-local row index written at `top` (non-zero when
 *   the caller scrolled or clipped rows above it).
 * - `height`: the component's own full rendered row count.
 */
export interface NativeTextFieldRegion {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly rows: number;
  readonly firstRow: number;
  readonly height: number;
}

/** Which native component convention a host-owned press stands for. */
export type NativeTextComponentKind = "editor" | "input";

/** True for a finite, non-negative safe integer. */
function isCell(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A region every coordinate check can trust: non-empty and internally consistent. */
export function isUsableTextFieldRegion(region: NativeTextFieldRegion | undefined): region is NativeTextFieldRegion {
  return region !== undefined
    && isCell(region.left) && isCell(region.top) && isCell(region.firstRow)
    && isCell(region.width) && isCell(region.rows) && isCell(region.height)
    && region.width > 0 && region.rows > 0 && region.height > 0
    && region.firstRow + region.rows <= region.height;
}

/**
 * Translate one caller-local event into the component-local event for the
 * drawn region, or undefined when the event is malformed or lies outside the
 * written region. The event type, button, modifiers, wheel delta, and click
 * count are preserved exactly; only the coordinates and bounds change.
 */
export function translateTextFieldMouse(
  event: TextFieldMouseEvent,
  region: NativeTextFieldRegion | undefined,
): TextFieldMouseEvent | undefined {
  if (typeof event !== "object" || event === null || !isUsableTextFieldRegion(region)) return undefined;
  const { x, y } = event;
  if (!isCell(x) || !isCell(y)) return undefined;
  if (x < region.left || x >= region.left + region.width) return undefined;
  if (y < region.top || y >= region.top + region.rows) return undefined;
  return {
    ...event,
    x: x - region.left,
    y: y - region.top + region.firstRow,
    width: region.width,
    height: region.height,
  };
}

/**
 * Route one event to a native component through its drawn region. Returns the
 * native component's own result, or undefined when the event is outside the
 * region, the target has no mouse handler, or the native handler threw (a
 * failing native handler never escapes into the host's input path).
 */
export function routeNativeTextFieldMouse(
  target: NativeTextMouseTarget | undefined,
  event: TextFieldMouseEvent,
  region: NativeTextFieldRegion | undefined,
): TextFieldMouseResult | undefined {
  if (target === undefined || typeof target.handleMouse !== "function") return undefined;
  const local = translateTextFieldMouse(event, region);
  if (local === undefined) return undefined;
  try {
    const result = target.handleMouse(local);
    return typeof result === "object" && result !== null ? result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The single native event a host-owned, already-authorized primary press
 * stands for, in component-local coordinates. `Editor` positions its caret
 * only on a completed left `click` (Pi's renderer synthesizes that click from
 * a stationary press/release); `Input` positions on the left `press` itself.
 * The host that owns the gesture therefore delivers the native convention
 * directly and never forwards any other part of the gesture.
 */
export function hostCaretEvent(
  kind: NativeTextComponentKind,
  x: number,
  y: number,
  width: number,
  height: number,
): TextFieldMouseEvent {
  return {
    type: kind === "editor" ? "click" : "press",
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    ...(kind === "editor" ? { clickCount: 1 } : {}),
  };
}

/** True when a native result reports that the component consumed the event. */
export function nativeMouseHandled(result: TextFieldMouseResult | undefined): boolean {
  return result !== undefined && (result.handled === true || result.capture === true || result.focus === true);
}
