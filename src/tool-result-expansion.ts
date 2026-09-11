/**
 * Shared native tool-result expansion foundation (#57).
 *
 * Pi toggles every tool row's expanded state through its own configured
 * expansion binding (`app.tools.expand`, Ctrl+O by default) and passes that
 * state to the registered `renderResult` as
 * `(result, { expanded, isPartial }, theme, context)`. Extensions must not
 * register a competing key handler, mirror expansion state, or fetch anything
 * when a row expands: expansion is presentation of the already-returned tool
 * result only.
 *
 * `expandableResult()` is the single shared mechanism for extension-owned
 * tools. It wraps an existing result renderer as the collapsed view and
 * optionally accepts an expanded-detail renderer contributed by a family
 * detail issue (#58 background shell, #60 interactive browser, #82
 * WebFetch/BrowserExtract; the #59 subtasks callback is contributed). Until an
 * expanded renderer is contributed the wrapped tool keeps its existing
 * presentation in both states — no fabricated
 * data, no retrieval, no behavior change; the wiring is ready and the detail
 * callback is the only remaining contribution.
 *
 * Tools that never defined a custom `renderResult` keep Pi's native fallback
 * rendering, which already expands and re-collapses the returned text output
 * with a bounded preview. That adequate native expansion is retained as-is:
 * do not wrap those registrations, because a custom collapsed renderer would
 * replace the native fallback rather than extend it.
 *
 * Shared native hints (#93): for every tool that has a contributed expanded
 * renderer, the callback returned here wraps the rendered component so its
 * header line carries exactly one native-style hint —
 * `(ctrl+o to expand)` / `(ctrl+o to collapse)` with the host's configured
 * `app.tools.expand` binding and the native inline casing/styling (see
 * ./tool-result-hints). Family renderers must NOT emit their own expansion
 * hints. The wrapper adds no toggle state or key handler: keyboard expansion
 * is the host's global binding and fullscreen per-card clicking is the
 * host's own MouseRegion, both of which this mechanism reuses unchanged.
 * Tools without an expanded renderer keep their exact existing presentation
 * in both states — a hint there would promise a change that does not exist.
 */

import {
  visibleLineWidth,
  withExpansionHint,
  type ToolResultViewComponent,
} from "./tool-result-hints";

/** Structural theme subset used by extension tool result renderers. */
export interface ToolResultTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

/**
 * Native renderResult options: the row's current expansion state (toggled by
 * the configured binding, Ctrl+O by default) and streaming phase. Expanded
 * callbacks must handle `isPartial` (streaming progress), error results
 * (`result.isError`), and absent detail data without fabricating content.
 */
export interface ToolResultRenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

/** Structural subset of Pi's native renderResult context. */
export interface ToolResultRenderContext {
  readonly args?: unknown;
  readonly toolCallId?: string;
  readonly cwd?: string;
  readonly state?: Record<string, unknown>;
  invalidate?(): void;
  readonly [key: string]: unknown;
}

/**
 * A Pi-compatible renderResult delegate. Both callbacks of the shared
 * expansion mechanism use the native signature; older hosts and tests may omit
 * the context argument.
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
export type ToolResultRenderCallback<TTheme = unknown, TContext = unknown> = (
  result: unknown,
  options: unknown,
  theme: TTheme,
  context?: TContext,
) => unknown;

/** Wiring-audit marker set on every callback produced by expandableResult. */
export const EXPANDABLE_RESULT_MARKER = "__piReviewGateExpandableResult";

/**
 * Builds the shared native renderResult callback for one tool.
 *
 * - Collapsed state (or no expanded callback yet): renders
 *   `collapsedRenderer` exactly as before — the existing renderer is passed
 *   through unchanged, preserving today's presentation, no-data behavior, and
 *   any existing expanded behavior.
 * - Expanded state with a contributed `expandedRenderer`: renders the detail
 *   view. If the detail renderer throws or returns something that is not a
 *   renderable component (Pi's custom-renderer slot does not guard against
 *   that), the collapsed summary is shown WITH a visible failure notice line
 *   (`detail view unavailable - showing summary`, progressively shortened at
 *   narrow widths down to a single-cell marker): the failure is never
 *   swallowed into a complete-looking expanded summary, and the raw result
 *   content stays available through the summary. If even the collapsed
 *   renderer is non-renderable, the value passes through exactly as before so
 *   Pi's own slot fallback still applies.
 *
 * The raw `result` object is forwarded unchanged, and the native `options`
 * object is forwarded unchanged whenever the host provides one, so delegates
 * observe exactly what Pi passed, including `isPartial` and `result.isError`.
 * No key handler is registered and nothing is fetched, rerun, or read from
 * disk by this mechanism.
 */
export function expandableResult<TTheme, TContext>(
  collapsedRenderer: ToolResultRenderer<TTheme, TContext>,
  expandedRenderer?: ToolResultRenderer<TTheme, TContext>,
): ToolResultRenderCallback<TTheme, TContext> {
  const render = (
    result: unknown,
    options: unknown,
    theme: TTheme,
    context?: TContext,
  ): unknown => {
    let component: unknown;
    if (!expandedRenderer || !isNativelyExpanded(options)) {
      component = collapsedRenderer(result, renderOptionsOf(options), theme, context);
    } else {
      try {
        component = expandedRenderer(result, renderOptionsOf(options), theme, context);
      } catch {
        component = undefined;
      }
      if (!isRenderableComponent(component)) {
        // The detail view failed. Present the collapsed summary with a
        // visible failure notice — never a silent, complete-looking expanded
        // summary — while keeping the raw result content available.
        const base = collapsedRenderer(result, renderOptionsOf(options), theme, context);
        component = isRenderableComponent(base)
          ? withDetailViewFailureNotice(base as ToolResultViewComponent, fgOf(theme))
          : base;
      }
    }
    // #93: only a tool with a contributed expanded view carries the shared
    // native header hint (both states). A non-renderable delegate is passed
    // through exactly as before so Pi's own slot fallback still applies.
    if (!expandedRenderer || !isRenderableComponent(component)) return component;
    return withExpansionHint(
      component as ToolResultViewComponent,
      isNativelyExpanded(options),
      fgOf(theme),
    );
  };
  (render as unknown as Record<string, unknown>)[EXPANDABLE_RESULT_MARKER] = true;
  return render;
}

/** True when the callback came from expandableResult (wiring audit only). */
export function isExpandableResult(value: unknown): boolean {
  return typeof value === "function"
    && (value as unknown as { [key: string]: unknown })[EXPANDABLE_RESULT_MARKER] === true;
}

/** Native expansion flag: anything but an explicit true stays collapsed. */
function isNativelyExpanded(options: unknown): boolean {
  return isRecord(options) && options.expanded === true;
}

/**
 * The theme's fg() when structurally present (host themes always have it),
 * wrapped to preserve the receiver. Pi's native `Theme.fg` reads
 * `this.fgColors`, and the host's theme proxy hands out the raw method, so a
 * standalone call would throw; the closure below keeps `theme` as `this`.
 */
function fgOf(theme: unknown): ((color: string, text: string) => string) | undefined {
  const record = isRecord(theme) ? theme : undefined;
  if (!record || typeof (record as { fg?: unknown }).fg !== "function") return undefined;
  const fg = (record as { fg: (color: string, text: string) => string }).fg;
  return (color: string, text: string): string => fg.call(record, color, text);
}

/** Visible notice appended when a contributed detail view fails to render. */
const DETAIL_VIEW_FAILURE_MESSAGE = "detail view unavailable - showing summary";
const DETAIL_VIEW_FAILURE_SHORT = "detail view unavailable";

/**
 * Wraps the collapsed-summary component so an expanded-state detail-view
 * failure stays visible: one error-styled notice line is appended, chosen
 * from progressively shorter indicators (full message, shortened message,
 * `detail failed`, `ERROR`, `!`) so that at least a single-cell marker shows
 * whenever any terminal cell is available. It is omitted only when the render
 * width provides no cell at all. The family's lines are never modified.
 */
function withDetailViewFailureNotice(
  inner: ToolResultViewComponent,
  fg?: (color: string, text: string) => string,
): ToolResultViewComponent {
  const style = (text: string): string => {
    if (typeof fg === "function") {
      try {
        return fg("error", text);
      } catch {
        // Unknown color or receiver issue: plain text still communicates.
      }
    }
    return text;
  };
  // Progressive indicators: as the width shrinks, step down to shorter
  // markers so a failed detail view never silently looks like a complete
  // summary. Only when not even one cell is available is nothing appended.
  const full = style(DETAIL_VIEW_FAILURE_MESSAGE);
  const short = style(DETAIL_VIEW_FAILURE_SHORT);
  const indicators = [full, short, style("detail failed"), style("ERROR"), "!"];
  return {
    render(width: number): string[] {
      const lines = inner.render(width).slice();
      const safeWidth = Math.max(0, width);
      const message = indicators.find((text) => visibleLineWidth(text) <= safeWidth);
      if (message !== undefined) lines.push(message);
      return lines;
    },
    invalidate() {
      inner.invalidate?.();
    },
  };
}

/**
 * Forwards the native options object unchanged when the host provided one;
 * a missing options argument falls back to conservative defaults so the
 * delegates always observe boolean `expanded`/`isPartial` fields.
 */
function renderOptionsOf(options: unknown): ToolResultRenderOptions {
  if (isRecord(options)) return options as unknown as ToolResultRenderOptions;
  return { expanded: false, isPartial: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pi tool renderers must return a component with a render(width) method. */
function isRenderableComponent(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && typeof (value as { render?: unknown }).render === "function";
}