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
 */

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
 *   that), the collapsed renderer runs instead so pending, partial, completed,
 *   error, and cancelled states stay stable in the TUI.
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
    if (!expandedRenderer || !isNativelyExpanded(options)) {
      return collapsedRenderer(result, renderOptionsOf(options), theme, context);
    }
    let component: unknown;
    try {
      component = expandedRenderer(result, renderOptionsOf(options), theme, context);
    } catch {
      return collapsedRenderer(result, renderOptionsOf(options), theme, context);
    }
    if (!isRenderableComponent(component)) {
      return collapsedRenderer(result, renderOptionsOf(options), theme, context);
    }
    return component;
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