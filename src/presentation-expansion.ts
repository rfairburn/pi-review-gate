/**
 * Shared presentation expansion core (#92 phase 1: the generic core extracted
 * from the #57/#93 tool-result foundation so tool-result and custom-message
 * renderers consume the same mechanism).
 *
 * The host toggles an expansion binding (`app.tools.expand`, Ctrl+O by
 * default) and passes the row's current expansion state to the registered
 * renderer through the options argument (tool rows read `options.expanded`
 * plus `isPartial`; custom message rows read `options.expanded` plus
 * `outputPad`). Extensions must not register a competing key handler, mirror
 * expansion state, or fetch anything when a row expands: expansion is
 * presentation of already-delivered content only.
 *
 * This core owns exactly the cross-cutting expansion presentation logic and
 * nothing else:
 *
 * - Renderer selection: the row is collapsed unless
 *   `options.expanded === true` (anything else stays collapsed), and the
 *   contributed expanded detail renderer is used only when one exists.
 *   Without a contributed expanded renderer the wrapped renderer keeps its
 *   existing presentation in both states — no fabricated data, no retrieval,
 *   no behavior change.
 * - Native hints and width safety: {@link ./presentation-hints
 *   withExpansionHint} adds exactly one host-configured native-style hint to
 *   the header of renderers that have a contributed expanded view, width-safe
 *   at every terminal size. Renderers must not emit their own hints.
 * - Honest fallback rows: a consumer whose collapsed renderer can honestly
 *   fall back to the complete retained text (
 *   {@link markFullTextFallback}) opts in through `honorFullTextFallback`;
 *   such a row renders that same complete text in both states and carries no
 *   expansion hint, because expansion could not change what is shown. The
 *   signal is explicit state, never a rendered-line comparison, so width,
 *   theme, or partial-render differences cannot disable a real row's
 *   expansion. Consumers that do not opt in are byte-identical to before.
 * - Failure notice: if the expanded detail renderer throws or returns a
 *   non-renderable component (the host's custom-renderer slot does not guard
 *   against that), the collapsed view is shown WITH a visible failure notice
 *   line — the failure is never swallowed into a complete-looking expanded
 *   summary. If even the collapsed renderer is non-renderable, the value
 *   passes through unchanged so the host's own slot fallback still applies.
 * - Component forwarding: any mouse/input handlers the inner component
 *   defines are forwarded verbatim; anything unhandled falls through to the
 *   host's per-card MouseRegion or global toggle binding.
 * - Wiring-audit marker: every produced callback is marked so registrations
 *   can be audited for shared-expansion wiring.
 *
 * The core never assumes a tool result or streaming type: delegates receive
 * an opaque `result` value, the host's `options` object forwarded unchanged,
 * the theme, and the host context. Every host-owned options field — tool
 * `isPartial`, message `outputPad`, anything else — reaches the selected
 * delegate exactly as the host passed it. When the host provides no options
 * object at all, the configured {@link PresentationExpansionConfig
 * fallbackOptions} are built per call (the generic default is a neutral
 * `{ expanded: false }`; a consumer whose host contract requires more fields
 * supplies its own fallback). No key handler is registered and nothing is
 * fetched, rerun, or read from disk by this core.
 */

import {
  visibleLineWidth,
  withExpansionHint,
  type PresentationViewComponent,
} from "./presentation-hints";

/** Structural theme subset used by presentation renderers. */
export interface PresentationTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

/** Structural subset of the host's renderer context, forwarded unchanged. */
export interface PresentationRenderContext {
  readonly args?: unknown;
  readonly toolCallId?: string;
  readonly cwd?: string;
  readonly state?: Record<string, unknown>;
  invalidate?(): void;
  readonly [key: string]: unknown;
}

/**
 * A presentation renderer delegate. Both callbacks of the shared expansion
 * core use the same native signature; older hosts and tests may omit the
 * context argument. `options` is the host-owned expansion-state object in
 * whatever shape the host passes (`{ expanded, isPartial }` for tool rows,
 * `{ expanded, outputPad }` for custom message rows).
 */
export type PresentationRenderer<TOptions, TTheme = unknown, TContext = unknown> = (
  result: unknown,
  options: TOptions,
  theme: TTheme,
  context?: TContext,
) => unknown;

/**
 * The loose render callback installed on a registered renderer. It keeps the
 * loose native shape (unknown options) so registration sites keep their own
 * structural theme, options, and context types.
 */
export type PresentationRenderCallback<TTheme = unknown, TContext = unknown> = (
  result: unknown,
  options: unknown,
  theme: TTheme,
  context?: TContext,
) => unknown;

/** Per-consumer configuration of the shared expansion core. */
export interface PresentationExpansionConfig {
  /**
   * Options handed to the delegates when the host provides none at all.
   * Built per call. Consumers whose host contract guarantees specific
   * options fields (tool rows: `isPartial`; custom message rows: `outputPad`)
   * supply their own fallback shape; the generic default is a neutral
   * `{ expanded: false }`.
   */
  fallbackOptions?: () => unknown;
  /**
   * Opt-in for consumers whose collapsed renderer can honestly fall back to
   * the COMPLETE retained text (see {@link markFullTextFallback}) when a row's
   * shape cannot be compacted truthfully. With this enabled the core renders
   * such a row's complete text in both states and adds NO expansion hint,
   * because expansion could not change what is shown; the decision is the
   * collapsed renderer's explicit marker, never a rendered-line comparison
   * (width, theme, and partial rendering cannot accidentally disable a real
   * row's expansion). Tool-result consumers omit it, so their rendering — and
   * the number of delegate invocations — is byte-identical to before.
   */
  honorFullTextFallback?: boolean;
}

/** Generic wiring-audit marker set on every callback produced here. */
export const PRESENTATION_EXPANSION_MARKER = "__piReviewGateExpandablePresentation";

/**
 * Explicit-state marker for a collapsed component that already IS the complete
 * retained text: the honest fallback used when a row cannot be compacted
 * (unknown, historical, malformed, or otherwise untrustworthy shape).
 */
export const PRESENTATION_FULL_TEXT_FALLBACK_MARKER = "__piReviewGateFullTextFallback";

/**
 * Marks a collapsed component as the complete retained text (no compaction).
 * A marked row has no meaningful expansion — the expanded view would show the
 * same text — so the core shows it in both states without an expansion hint.
 * The marker is a non-enumerable own property and carries no rendering state;
 * when a component cannot be marked (a non-extensible host component) it stays
 * unmarked and the default expandable presentation applies rather than a
 * fabricated decision.
 */
export function markFullTextFallback<T>(component: T): T {
  if (component !== null && (typeof component === "object" || typeof component === "function")) {
    try {
      Object.defineProperty(component, PRESENTATION_FULL_TEXT_FALLBACK_MARKER, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    } catch {
      // Non-extensible component: keep the default presentation.
    }
  }
  return component;
}

/** True when the component was explicitly marked as the complete retained text. */
export function isFullTextFallback(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && (value as Record<string, unknown>)[PRESENTATION_FULL_TEXT_FALLBACK_MARKER] === true;
}

/** True when the host's expansion flag is on: anything else stays collapsed. */
export function isPresentationExpanded(options: unknown): boolean {
  return isRecord(options) && options.expanded === true;
}

/**
 * Builds the shared render callback for one presentation row.
 *
 * - Collapsed state (or no expanded callback yet): renders
 *   `collapsedRenderer` exactly as before — the existing renderer is passed
 *   through unchanged, preserving today's presentation and any existing
 *   expanded behavior.
 * - Expanded state with a contributed `expandedRenderer`: renders the detail
 *   view. If the detail renderer throws or returns something that is not a
 *   renderable component, the collapsed view is shown WITH a visible failure
 *   notice line (`detail view unavailable - showing summary`, progressively
 *   shortened at narrow widths down to a single-cell marker), never silently
 *   presented as a complete expanded summary. If even the collapsed renderer
 *   is non-renderable, the value passes through unchanged so the host's own
 *   slot fallback still applies.
 * - A contributed expanded view carries the shared native header hint in both
 *   states. A non-renderable result is passed through exactly as before.
 *
 * The raw `result` object is forwarded unchanged, and the native `options`
 * object is forwarded unchanged whenever the host provides one, so delegates
 * observe exactly what the host passed.
 */
export function expandablePresentation<TOptions, TTheme, TContext>(
  collapsedRenderer: PresentationRenderer<TOptions, TTheme, TContext>,
  expandedRenderer?: PresentationRenderer<TOptions, TTheme, TContext>,
  config?: PresentationExpansionConfig,
): PresentationRenderCallback<TTheme, TContext> {
  const fallbackOptions = config?.fallbackOptions
    ?? (() => ({ expanded: false } as unknown as TOptions));
  const honorFullTextFallback = config?.honorFullTextFallback === true;
  // TOptions is only ever materialized through the host's forwarded record or
  // the consumer's own fallback: the unknown-typed config closure above is
  // narrowed to the delegates' options type here.
  const fallbackOptionsOf = (): TOptions => fallbackOptions() as unknown as TOptions;
  const render = (
    result: unknown,
    options: unknown,
    theme: TTheme,
    context?: TContext,
  ): unknown => {
    let component: unknown;
    if (!expandedRenderer || !isPresentationExpanded(options)) {
      component = collapsedRenderer(result, optionsOf(options, fallbackOptionsOf), theme, context);
      // A collapsed row that explicitly IS the complete retained text has no
      // meaningful expansion: no hint would be honest, so none is added.
      if (honorFullTextFallback && isFullTextFallback(component)) return component;
    } else {
      if (honorFullTextFallback) {
        // The collapsed shape decides (explicitly, never by comparing rendered
        // output): an un-compactable row shows its complete text in both states
        // and advertises no expansion it cannot perform.
        const collapsedProbe = collapsedRenderer(result, optionsOf(options, fallbackOptionsOf), theme, context);
        if (isFullTextFallback(collapsedProbe)) return collapsedProbe;
      }
      try {
        component = expandedRenderer(result, optionsOf(options, fallbackOptionsOf), theme, context);
      } catch {
        component = undefined;
      }
      if (!isRenderableComponent(component)) {
        // The detail view failed. Present the collapsed view with a visible
        // failure notice — never a silent, complete-looking expanded view —
        // while keeping the already-delivered content available.
        const base = collapsedRenderer(result, optionsOf(options, fallbackOptionsOf), theme, context);
        component = isRenderableComponent(base)
          ? withDetailViewFailureNotice(base as PresentationViewComponent, fgOf(theme))
          : base;
      }
    }
    // Only a row with a contributed expanded view carries the shared native
    // header hint (both states). A non-renderable delegate is passed through
    // exactly as before so the host's own slot fallback still applies.
    if (!expandedRenderer || !isRenderableComponent(component)) return component;
    return withExpansionHint(
      component as PresentationViewComponent,
      isPresentationExpanded(options),
      fgOf(theme),
    );
  };
  (render as unknown as Record<string, unknown>)[PRESENTATION_EXPANSION_MARKER] = true;
  return render;
}

/** True when the callback came from the shared presentation expansion core. */
export function isExpandablePresentation(value: unknown): boolean {
  return typeof value === "function"
    && (value as unknown as { [key: string]: unknown })[PRESENTATION_EXPANSION_MARKER] === true;
}

/**
 * The options object forwarded to the delegates: the host's object unchanged
 * when provided, otherwise the configured conservative fallback so the
 * delegates always observe boolean `expanded`.
 */
function optionsOf<TOptions>(
  options: unknown,
  fallbackOptions: () => TOptions,
): TOptions {
  if (isRecord(options)) return options as unknown as TOptions;
  return fallbackOptions() as TOptions;
}

/**
 * The theme's fg() when structurally present (host themes always have it),
 * wrapped to preserve the receiver. The host's `Theme.fg` may read instance
 * state, and host proxies hand out the raw method, so a standalone call
 * would throw; the closure below keeps the theme object as `this`.
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
 * Wraps the collapsed component so an expanded-state detail-view failure
 * stays visible: one error-styled notice line is appended, chosen from
 * progressively shorter indicators (full message, shortened message,
 * `detail failed`, `ERROR`, `!`) so that at least a single-cell marker shows
 * whenever any terminal cell is available. It is omitted only when the render
 * width provides no cell at all. The collapsed renderer's lines are never
 * modified.
 */
function withDetailViewFailureNotice(
  inner: PresentationViewComponent,
  fg?: (color: string, text: string) => string,
): PresentationViewComponent {
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
  // view. Only when not even one cell is available is nothing appended.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Host render slots must return a component with a render(width) method. */
function isRenderableComponent(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && typeof (value as { render?: unknown }).render === "function";
}