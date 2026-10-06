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
  type PresentationRenderCallback,
  type PresentationRenderContext,
  type PresentationRenderer,
  type PresentationTheme,
} from "./presentation-expansion";

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
  (render as unknown as Record<string, unknown>)[EXPANDABLE_RESULT_MARKER] = true;
  return render;
}

/** True when the callback came from expandableResult (wiring audit only). */
export function isExpandableResult(value: unknown): boolean {
  return typeof value === "function"
    && (value as unknown as { [key: string]: unknown })[EXPANDABLE_RESULT_MARKER] === true;
}