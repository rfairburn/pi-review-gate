/**
 * Backwards-compatible tool-result adapter over the shared presentation
 * expansion core (#92 phase 1: ./presentation-expansion).
 *
 * The generic expansion core now owns renderer selection, failure notice,
 * native hints, width safety, and component forwarding for every presentation
 * row (tool-result and custom-message alike). This module keeps the #57/#93
 * tool-result surface byte-for-byte on top of it:
 *
 * - Pi toggles every tool row's expanded state through its own configured
 *   expansion binding (`app.tools.expand`, Ctrl+O by default) and passes that
 *   state to the registered `renderResult` as
 *   `(result, { expanded, isPartial }, theme, context)`. Extensions must not
 *   register a competing key handler, mirror expansion state, or fetch
 *   anything when a row expands: expansion is presentation of the
 *   already-returned tool result only.
 *
 * - `expandableResult()` remains the single shared mechanism for
 *   extension-owned tools. It forwards to the generic
 *   `expandablePresentation` core as the collapsed view wrapper and
 *   optionally accepts an expanded-detail renderer contributed by a family
 *   detail issue (#58 background shell, #60 interactive browser, #82
 *   WebFetch/BrowserExtract; the #59 subtasks callback is contributed). Until
 *   an expanded renderer is contributed the wrapped tool keeps its existing
 *   presentation in both states — no fabricated
 *   data, no retrieval, no behavior change; the wiring is ready and the
 *   detail callback is the only remaining contribution.
 *
 * - Tools that never defined a custom `renderResult` keep Pi's native
 *   fallback rendering, which already expands and re-collapses the returned
 *   text output with a bounded preview. That adequate native expansion is
 *   retained as-is: do not wrap those registrations, because a custom
 *   collapsed renderer would replace the native fallback rather than extend
 *   it.
 *
 * - Shared native hints (#93): for every tool that has a contributed expanded
 *   renderer, the callback returned here wraps the rendered component so its
 *   header line carries exactly one native-style hint —
 *   `(ctrl+o to expand)` / `(ctrl+o to collapse)` with the host's configured
 *   `app.tools.expand` binding and the native inline casing/styling (see
 *   ./tool-result-hints → ./presentation-hints). Family renderers must NOT
 *   emit their own expansion hints. The wrapper adds no toggle state or key
 *   handler: keyboard expansion is the host's global binding and fullscreen
 *   per-card clicking is the host's own MouseRegion, both of which this
 *   mechanism reuses unchanged. Tools without an expanded renderer keep
 *   their exact existing presentation in both states — a hint there would
 *   promise a change that does not exist.
 */

import {
  expandablePresentation,
  PRESENTATION_EXPANSION_MARKER,
  type PresentationRenderCallback,
  type PresentationRenderContext,
  type PresentationRenderer,
  type PresentationTheme,
} from "./presentation-expansion";
import { isRecord } from "./record-guard";

/** Structural theme subset used by extension tool result renderers. */
export type ToolResultTheme = PresentationTheme;

/**
 * Native tool-result renderResult options: the row's current expansion state
 * (toggled by the configured binding, Ctrl+O by default) and streaming phase.
 * Expanded callbacks must handle `isPartial` (streaming progress), error
 * results (`result.isError`), and absent detail data without fabricating
 * content.
 */
export interface ToolResultRenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

/** Structural subset of Pi's native tool-row renderResult context. */
export type ToolResultRenderContext = PresentationRenderContext;

/**
 * A Pi-compatible tool-result renderResult delegate. Both callbacks of the
 * shared expansion mechanism use the native signature; older hosts and tests
 * may omit the context argument.
 */
export type ToolResultRenderer<TTheme = ToolResultTheme, TContext = ToolResultRenderContext> = (
  result: unknown,
  options: ToolResultRenderOptions,
  theme: TTheme,
  context?: TContext,
) => unknown;

/**
 * The renderResult callback installed on a registered tool. It keeps the loose
 * native shape (unknown options/theme/context) so registration sites keep
 * their own structural theme types.
 */
export type ToolResultRenderCallback<TTheme = unknown, TContext = unknown> =
  PresentationRenderCallback<TTheme, TContext>;

/** Wiring-audit marker set on every callback produced by expandableResult. */
export const EXPANDABLE_RESULT_MARKER = "__piReviewGateExpandableResult";

/** The background tokens the host paints a tool-result row's Box with (#677):
 *  pending while the call is partial, error for a failed result, success
 *  otherwise — the same decision the host's own row makes. */
export type ToolRowBackgroundToken = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

/** What one SGR sequence leaves the terminal background doing:
 *  - `cleared`: the sequence ends with the background unset (a full reset —
 *    no parameters or all-zero parameters — or a background reset `49`, with
 *    nothing after it that sets a background again);
 *  - `set`: the sequence ends with an explicit background (`40`–`47`, the
 *    bright `100`–`107`, or an extended `48;5;n` / `48;2;r;g;b`);
 *  - `swapped`: the row still has inverse video ON after this sequence (turned
 *    on with `7` and not disabled by `27` or a full reset, possibly in an
 *    earlier sequence of the same row), so what a cell paints is the foreground
 *    colour and a background re-open would change what the retained styling
 *    means;
 *  - `unknown`: the sequence neither resets nor sets the background (a plain
 *    foreground, weight, or underline change), so nothing has to be restored. */
type SgrBackgroundEffect = "cleared" | "set" | "swapped" | "unknown";

/** The numeric value of one top-level SGR parameter, or `undefined` when the
 *  terminal would not read it as a number. Parameters are numeric, so a
 *  zero-padded mode (`05`, `02`) is the same mode as `5` / `2`; an empty
 *  parameter is the terminal's own shorthand for 0. Colon sub-parameters
 *  (`38:2::255:128:0`) belong to their own attribute and never reach here as a
 *  number of their own. */
function parameterCode(part: string): number | undefined {
  const head = part.includes(":") ? part.slice(0, part.indexOf(":")) : part;
  if (head !== "" && !/^\d+$/.test(head)) return undefined;
  return head === "" ? 0 : Number(head);
}

/** The index of the last parameter a semicolon-form extended colour consumes:
 *  `38`/`48`/`58` take `5;n` (one more parameter) or `2;r;g;b` (three more),
 *  with the mode read numerically so `48;05;0` consumes its payload exactly
 *  like `48;5;0`. Consuming the payload is what stops the zero components of
 *  `38;2;0;0;0` from being read as a full reset. A colon-form colour
 *  (`48:2::0:0:0`) keeps its payload inside one top-level parameter and consumes
 *  nothing beyond itself. */
function extendedColorEnd(parts: string[], start: number): number {
  // A colon-form colour carries its whole payload inside this one parameter
  // (`38:2::255:0:0`), so the next parameter is another top-level attribute and
  // must be left to the walk — reading it as a colour mode would swallow a later
  // background setter or reset.
  if (parts[start]!.includes(":")) return start;
  const mode = parameterCode(parts[start + 1] ?? "");
  if (mode === 5) return start + 2;
  if (mode === 2) return Math.min(start + 4, parts.length - 1);
  return start;
}

/** The background effect a row has reached so far, carried across the SGR
 *  sequences of one rendered row: inverse video and a pending background
 *  restoration are row state, not one-sequence state, because a row routinely
 *  splits them (`\x1b[7m\x1b[49m`, `\x1b[0;7m…\x1b[27m`). */
type RowSgrState = { inverse: boolean; effect: Exclude<SgrBackgroundEffect, "swapped"> };

/** The background effect after one SGR sequence, given the row state reached
 *  before it, and the row state updated in place. The walk reads the sequence's
 *  top-level parameters in order so a reset combined with other attributes is
 *  judged by what it leaves set: `\x1b[0;31m` clears the background and keeps a
 *  red foreground (restore the background, keep the red), while `\x1b[0;41m`,
 *  `\x1b[0;48;2;0;0;0m`, or `\x1b[0;48:2::0:0:0m` set their own background after
 *  the reset (leave the row's own colour alone). Inverse video is tracked
 *  separately from that effect, and across sequences within the row: a cleared
 *  background under active inverse video is not restored until the inverse ends
 *  (`\x1b[7m\x1b[49m` stays alone, `\x1b[7m\x1b[49m…\x1b[27m` restores after the
 *  `\x1b[27m`), and `\x1b[0;7;27m` restores immediately. */
function sgrBackgroundEffect(parameters: string, state: RowSgrState): SgrBackgroundEffect {
  const parts = parameters.split(";");
  let effect = state.effect;
  let inverse = state.inverse;
  for (let index = 0; index < parts.length; index += 1) {
    const code = parameterCode(parts[index]!);
    if (code === undefined) continue;
    if (code === 0 || code === 49) {
      // Full reset, or background reset: the background is unset again.
      effect = "cleared";
      if (code === 0) inverse = false;
    } else if (code === 7) {
      inverse = true;
    } else if (code === 27) {
      inverse = false;
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      effect = "set";
    } else if (code === 48) {
      index = extendedColorEnd(parts, index);
      effect = "set";
    } else if (code === 38 || code === 58) {
      // Foreground / underline colour: consumes its payload, never the
      // background, so it leaves the current effect untouched.
      index = extendedColorEnd(parts, index);
    }
  }
  state.inverse = inverse;
  state.effect = effect;
  // Inverse video is decided only once the sequence has been read: a sequence
  // that leaves the background cleared while inverse video is still on defers
  // the restoration to wherever the row turns inverse off, while one that turns
  // it back off (`27`) restores an ordinary cleared background.
  return inverse ? "swapped" : effect;
}

const SGR_SEQUENCE = /\x1b\[([0-9;:]*)m/g;

/** Re-open `backgroundAnsi` (a bare background sequence from the live theme)
 *  after every SGR sequence that leaves the terminal background unset — a
 *  canonical `\x1b[0m` / `\x1b[m` / `\x1b[49m`, or a reset combined with
 *  attributes that do not set a background — including one at the very end of
 *  a row so the host's following padding stays painted. The row is walked with
 *  one row-local state, so inverse video and a deferred restoration survive
 *  across adjacent sequences. A row with no such sequence is returned unchanged,
 *  and nothing is ever removed: the row's own resets, glyphs, foregrounds, and
 *  explicit backgrounds survive verbatim. */
export function reopenRowBackground(line: string, backgroundAnsi: string): string {
  if (!line.includes("\x1b")) return line;
  const state: RowSgrState = { inverse: false, effect: "unknown" };
  return line.replace(SGR_SEQUENCE, (sequence, parameters: string) => {
    if (sgrBackgroundEffect(parameters, state) !== "cleared") return sequence;
    // The inserted open satisfies any deferred restoration.
    state.effect = "set";
    return `${sequence}${backgroundAnsi}`;
  });
}

/** The background token the host is painting this tool row with: pending while
 *  the call is partial, error for a failed result (the recorded `result.isError`
 *  stays as the legacy fallback for pre-context hosts and restored records),
 *  success otherwise. */
export function toolRowBackgroundToken(
  result: unknown,
  options: unknown,
  context: unknown,
): ToolRowBackgroundToken {
  if (isRecord(options) && options.isPartial === true) return "toolPendingBg";
  if ((isRecord(result) && result.isError === true) || (isRecord(context) && context.isError === true)) {
    return "toolErrorBg";
  }
  return "toolSuccessBg";
}

/** The background token the host paints a tool row's CALL region with: pending
 *  while the call itself is still streaming (`context.isPartial` is the call
 *  region's own streaming signal — the call renderer is handed no options
 *  object), and otherwise exactly the shared result-row decision: error for a
 *  failed result already recorded on the row, success otherwise. */
export function toolCallRowBackgroundToken(context: unknown): ToolRowBackgroundToken {
  if (isRecord(context) && context.isPartial === true) return "toolPendingBg";
  return toolRowBackgroundToken(undefined, undefined, context);
}

/** The live theme's bare background sequence for one row-background token, or
 *  undefined when the theme cannot answer: no accessor (a fake or older theme),
 *  a throwing lookup, or a non-string value. Callers then leave the rendered
 *  rows exactly as they are rather than guessing a colour. */
export function toolRowBackgroundAnsi(theme: unknown, token: ToolRowBackgroundToken): string | undefined {
  if (!isRecord(theme)) return undefined;
  try {
    // Reading the property itself can throw: a host proxy or a theme object
    // with a throwing accessor must degrade to unchanged rows, not escape the
    // adapter and push the host onto its fallback renderer.
    const getter = (theme as { getBgAnsi?: unknown }).getBgAnsi;
    if (typeof getter !== "function") return undefined;
    // The host theme reads instance state, and host proxies hand out the raw
    // method: keep the theme object as the receiver.
    const ansi = (getter as (token: string) => unknown).call(theme, token);
    return typeof ansi === "string" ? ansi : undefined;
  } catch {
    return undefined;
  }
}

/** The live theme's bare background sequence for the row state this render call
 *  is presenting. */
function rowBackgroundAnsi(theme: unknown, result: unknown, options: unknown, context: unknown): string | undefined {
  return toolRowBackgroundAnsi(theme, toolRowBackgroundToken(result, options, context));
}

/** Wrap a rendered tool-row component so every row it emits reopens the row
 *  background after a reset. Width, padding, wrapping, glyphs, foregrounds,
 *  invalidation, and the component's own interaction surface are untouched;
 *  only zero-width escapes are inserted. The host's own Box still closes the
 *  completed padded row, so nothing is painted outside the card.
 *
 *  Exported for the one other surface that draws tool rows and therefore owns
 *  the same seam (#677): the gate's renderer decoration in
 *  `./tool-protection/coordinator`, which repairs the rows a native host
 *  renderer emits. A caller keeps the renderer's own component as
 *  `context.lastComponent` — this wrapper carries no renderer state, so handing
 *  it back would break a native renderer's incremental cache. */
export function withReopenedRowBackground<T>(component: T, backgroundAnsi: string): T {
  const inner = component as {
    render(width: number): string[];
    invalidate?(): void;
    handleMouse?: (event: unknown) => unknown;
    handleInput?: (data: string) => unknown;
    wantsKeyRelease?: boolean;
  };
  const reopened: typeof inner = {
    render(width: number): string[] {
      return inner.render(width).map((line) =>
        typeof line === "string" ? reopenRowBackground(line, backgroundAnsi) : line);
    },
    invalidate() {
      inner.invalidate?.();
    },
  };
  if (typeof inner.handleMouse === "function") {
    reopened.handleMouse = (event: unknown) => inner.handleMouse!(event);
  }
  if (typeof inner.handleInput === "function") {
    reopened.handleInput = (data: string) => inner.handleInput!(data);
  }
  if (inner.wantsKeyRelease === true) {
    reopened.wantsKeyRelease = true;
  }
  return reopened as T;
}

/**
 * Builds the shared native renderResult callback for one tool.
 *
 * Thin adapter: delegates entirely to the generic
 * {@link expandablePresentation} core and only supplies the tool-row native
 * contract — the `{ expanded: false, isPartial: false }` fallback options the
 * tool delegates have always observed when Pi provides no options object,
 * plus the historical `EXPANDABLE_RESULT_MARKER` wiring-audit tag (the core
 * adds its own generic marker; both are set). Selection, failure notice,
 * hints, width safety, and handler forwarding all come from the shared core,
 * so tool-result and custom-message presentation stay in lockstep.
 *
 * The raw `result` object is forwarded unchanged, and the native `options`
 * object is forwarded unchanged whenever the host provides one, so delegates
 * observe exactly what Pi passed, including `isPartial` and `result.isError`.
 * No key handler is registered and nothing is fetched, rerun, or read from
 * disk by this mechanism.
 *
 * The adapter is also the shared boundary for extension-owned tool-row
 * background continuity (#677) — `reopenRowBackground`,
 * `toolRowBackgroundAnsi`, `toolRowBackgroundToken`,
 * `toolCallRowBackgroundToken`, and `withReopenedRowBackground` are exported so
 * the one other surface that draws tool rows (the gate's renderer decoration in
 * `./tool-protection/coordinator`) applies the same rule to the native host rows
 * it draws instead of restating it. After the shared core selects the component,
 * every row it emits gets the live theme's bare background OPEN sequence
 * (`theme.getBgAnsi(token)` for that row's own pending/error/success state)
 * inserted directly after each background-clearing reset — a full reset
 * (`\x1b[0m`) or a background reset (`\x1b[49m`) — including a reset at the very
 * end of a row, so the host's own padding stays painted. Nothing is removed,
 * reordered, or normalized, no background close is added (the host's `Box`
 * still ends the completed padded row), attribute-setting sequences are left
 * alone so a row's own colours win, reset-free rows come back byte-for-byte
 * unchanged, and a theme without the accessor — or one whose lookup throws or
 * returns a non-string — renders exactly as before. Tool-row presentation only:
 * the generic presentation core and custom-message rows are untouched.
 */

export function expandableResult<TTheme, TContext>(
  collapsedRenderer: ToolResultRenderer<TTheme, TContext>,
  expandedRenderer?: ToolResultRenderer<TTheme, TContext>,
): ToolResultRenderCallback<TTheme, TContext> {
  const render = expandablePresentation(
    collapsedRenderer as PresentationRenderer<ToolResultRenderOptions, TTheme, TContext>,
    expandedRenderer as PresentationRenderer<ToolResultRenderOptions, TTheme, TContext> | undefined,
    {
      // Native tool-row fallback: exactly the options delegates observed
      // before the core extraction, built fresh per call.
      fallbackOptions: () => ({ expanded: false, isPartial: false }),
    },
  );
  const withBackground: PresentationRenderCallback<TTheme, TContext> = (result, options, theme, context) => {
    const component = render(result, options, theme, context);
    // A non-renderable value passes through exactly as before so the host's
    // own slot fallback still applies to it.
    if (typeof component !== "object" || component === null
      || typeof (component as { render?: unknown }).render !== "function") {
      return component;
    }
    const backgroundAnsi = rowBackgroundAnsi(theme, result, options, context);
    if (backgroundAnsi === undefined) return component;
    return withReopenedRowBackground(component, backgroundAnsi);
  };
  // Both wiring-audit markers stay on the registered callback: the generic
  // core's marker (it produced the presentation) and this adapter's.
  const tagged = withBackground as unknown as Record<string, unknown>;
  tagged[PRESENTATION_EXPANSION_MARKER] = true;
  tagged[EXPANDABLE_RESULT_MARKER] = true;
  return withBackground;
}

/** True when the callback came from expandableResult (wiring audit only). */
export function isExpandableResult(value: unknown): boolean {
  return typeof value === "function"
    && (value as unknown as { [key: string]: unknown })[EXPANDABLE_RESULT_MARKER] === true;
}