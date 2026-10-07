/**
 * Automatic notification consumers of unified expansion (#92 phase 2).
 *
 * The five extension-generated custom messages that trigger orchestrator turns
 * are delivered with `display: true` but, before this module, registered no
 * message renderer — so Pi's default `CustomMessageComponent` rendered the
 * label plus the FULL Markdown body in both collapsed and expanded states and
 * ignored expansion entirely. This module registers a public
 * `registerMessageRenderer` consumer for exactly those five types:
 *
 *   - pi-review-subtask-event              (execution/wake-delivery)
 *   - pi-review-bg-shell                   (background-shell wake)
 *   - pi-review-subtask-watch              (execution/watch checkpoint)
 *   - pi-review-scheduled-task-event       (scheduling owner wake)
 *   - pi-review-scheduled-orchestrator-turn (scheduling orchestrator turn)
 *
 * It reuses the SAME shared presentation core the tool-result rollout landed in
 * #92 phase 1 (`expandablePresentation` + `withExpansionHint`,
 * ./presentation-expansion + ./presentation-hints): one mechanism owns renderer
 * selection, the single native header hint, width safety, the detail-view
 * failure notice, and component forwarding. Tool-result behavior is unchanged;
 * this module is a second consumer of that core over the custom-message host
 * contract.
 *
 * Host reality this encodes (verified against installed Pi 1.0.4):
 *
 * - `pi.registerMessageRenderer(customType, renderer)` installs
 *   `(message, { expanded, outputPad }, theme) => Component | undefined`. The
 *   host's `CustomMessageComponent` re-invokes the renderer on every rebuild and
 *   passes its own global expansion flag (`options.expanded`). Returning
 *   `undefined` falls back to the host's default label + full-Markdown box.
 * - Unlike tool rows, the host does NOT wrap a custom message in its own
 *   MouseRegion (tool-execution.js createResultRegion has no message
 *   counterpart). Per-item click parity therefore requires this renderer to
 *   supply its own `MouseRegion` and its OWN per-message expansion state.
 * - The global binding (`app.tools.expand`, Ctrl+O by default) flips every row
 *   together through `setToolsExpanded` → `child.setExpanded` → rebuild, so a
 *   global change re-invokes this renderer for every message with the new flag.
 *
 * Per-message expansion state (the asymmetry tool rows do not have):
 *
 * - The host re-creates the returned component on every rebuild but does NOT
 *   re-invoke the renderer on a click-triggered re-render, so a clicked
 *   message's state must survive in a per-message slot that the returned
 *   component reads at render time. Identity is the message OBJECT itself (a
 *   `WeakMap`): CustomMessage carries no guaranteed id and several events share
 *   a customType, so keying by taskId/customType would collapse distinct events
 *   into one state.
 * - A left click on one message toggles ONLY that message (the MouseRegion
 *   handler returns `{ handled: true }`); neighbors are untouched.
 * - When the host's global flag changes, every message's local state is
 *   reconciled to the new absolute value (the global binding wins over a prior
 *   click). An unrelated rebuild/invalidation with an unchanged global flag
 *   retains each message's clicked state.
 *
 * Content contract (presentation only — no I/O, no fetching, no delivery change):
 *
 * - Expanded is ALWAYS the complete existing notification text
 *   (`message.content`), rendered through the shared `visibleTerminalText`
 *   display encoding so terminal control bytes are shown, never executed. The
 *   expanded view never fetches a linked report and applies no human-view
 *   truncation or filter of model-visible text.
 * - Collapsed is a concise, truthful summary derived from the recorded
 *   `content` and `details` (no new payload fields). Unknown, historical, or
 *   malformed content that yields no supported short summary falls back to the
 *   FULL retained content rather than a misleading preview — compaction is not
 *   promised where it cannot be produced honestly. A failure/recovery event
 *   compacts from the curated diagnostic whether it arrives as structured
 *   `details.diagnostic` or only as the producer's retained preamble + JSON
 *   text (validated structurally, and against the preamble's own task,
 *   execution, kind, state, revision, and progress identities). Valid
 *   structured metadata stays authoritative; nonempty but unusable structured
 *   metadata is never replaced by a text-derived diagnostic, and a recovered
 *   diagnostic is rejected when it contradicts a supplied taskId, executionId,
 *   or state, so genuinely unknown, invalid, or inconsistent data stays
 *   full-text.
 * - A full-text fallback row is marked as the complete retained text
 *   (`markFullTextFallback`), so the shared core shows it in both states with
 *   NO expansion hint: the hint would advertise a change expansion cannot make.
 *   This is explicit state, never a rendered-line comparison, so width, theme,
 *   and partial rendering cannot disable a genuinely expandable row's hint.
 * - The single native header hint is added by the shared core (the host's
 *   configured `app.tools.expand` binding); family renderers emit no hint of
 *   their own. No competing key handler is registered and nothing is fetched,
 *   rerun, or read from disk on toggle.
 *
 * Native visual boundary (#92 correction): the compact and expanded rows are
 * wrapped in the HOST'S OWN native card — the same pi-tui
 * `Box(1, 1, (t) => theme.bg("customMessageBg", t))` the default
 * `CustomMessageComponent` uses (one horizontal/vertical padding cell, every
 * rendered row filled to the terminal width through the theme's
 * `customMessageBg` token) — in BOTH states, and the formerly unstyled body
 * text follows the native `customMessageText`/`customMessageLabel` fg tokens
 * (status colors stay). Every color is resolved through the theme object the
 * host passed, at render time — never snapshotted or hard-coded — so the card
 * follows the active theme (including nondefault/custom themes and theme
 * changes) exactly like the native card. This is presentation only: content,
 * interactions, hints, and degradation paths are unchanged, and without the
 * Box peer or a theme bg() the row degrades to the previously shipped
 * unwrapped rendering.
 *
 * Public peer degradation: when `registerMessageRenderer` is absent (older
 * hosts) registration is skipped entirely so the host's full native fallback
 * renders. When pi-tui's `wrapTextWithAnsi` is unavailable the renderer returns
 * `undefined` (full native fallback) rather than emit a custom component whose
 * lines could exceed the terminal width and bypass the host's own wrapping; the
 * MouseRegion click affordance is likewise omitted when the peer is absent,
 * while keyboard expansion via the global binding keeps working. The pi-tui
 * peer is resolved with the established shared host-relative loader
 * (src/host-peer-loader.ts) asynchronously at session setup — a compiled
 * extension entry (pi >= 0.86 native import) cannot resolve host packages by
 * bare `require` name — and rendering itself performs no loading: it reads
 * only the already-resolved peer record and degrades to the documented full
 * native fallback when the peer is genuinely unavailable.
 */

import {
  expandablePresentation,
  isPresentationExpanded,
  markFullTextFallback,
  type PresentationRenderer,
} from "./presentation-expansion";
import { loadHostPeerModule } from "./host-peer-loader";
import { visibleTerminalText } from "./tool-result-text";
import { BACKGROUND_TASK_STATES, type BackgroundTaskKind } from "./execution/task-state";
import { TRUNCATION_MARKER, subtaskSuccessVerb } from "./execution/subtask-notifications";

// ── Structural host types ────────────────────────────────────────────────────

/** The structural shape of a Pi CustomMessage as delivered to the renderer. */
export interface CustomMessageView {
  role?: string;
  customType: string;
  content: string | Array<Record<string, unknown>>;
  display: boolean;
  details?: unknown;
  [key: string]: unknown;
}

/** Render options the host passes to a message renderer. */
export interface MessageRenderOptions {
  expanded: boolean;
  outputPad: number;
}

/** A renderable TUI component (the structural subset this module drives). */
export interface MessageComponent {
  render(width: number): string[];
  invalidate(): void;
  handleMouse?(event: unknown): unknown;
}

/** Theme subset the renderers use; matches Pi's theme.fg()/bold() contract. */
export interface MessageRendererTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

/**
 * A collapsed/expanded delegate for one notification family. Mirrors the shared
 * core's PresentationRenderer shape with loose parameter types so the
 * registration site keeps its own structural theme type. `message` is the
 * CustomMessage; `options` is the host-owned `{ expanded, outputPad }`.
 */
export type MessageDelegate = (
  message: unknown,
  options: unknown,
  theme: unknown,
) => MessageComponent;

/** The public registerMessageRenderer callback shape. */
export type MessageRendererCallback = (
  message: unknown,
  options: unknown,
  theme: unknown,
) => unknown;

// ── pi-tui peer loading (host-provided, never a dependency) ─────────────────

/** The structural pi-tui `Box` subset this module drives (host card boundary). */
export interface TuiBoxLike extends MessageComponent {
  addChild(child: MessageComponent): unknown;
}

interface PiTuiHost {
  wrapTextWithAnsi?: (text: string, width: number) => string[];
  truncateToWidth?: (text: string, maxWidth: number, ellipsis?: string, pad?: boolean) => string;
  MouseRegion?: new (child: MessageComponent, handler: (event: unknown) => unknown) => MessageComponent;
  Box?: new (
    paddingX: number,
    paddingY: number,
    bgFn: ((text: string) => string) | undefined,
  ) => TuiBoxLike;
}

let tuiOverride: PiTuiHost | undefined;
let tuiEntryProvider: (() => string | undefined) | undefined;
/** Populated only by a completed warm; rendering never loads anything itself. */
let warmedTuiHost: PiTuiHost | undefined;
let warmPromise: Promise<PiTuiHost | undefined> | undefined;

/** Test seam: inject a fake pi-tui host, or clear the override with undefined. */
export function setPiTuiHost(host: PiTuiHost | undefined): void {
  tuiOverride = host;
}

/**
 * Test seam: replace (or clear) discovery of the running Pi entry file. The
 * replacement still goes through the same realpath/package.json validation.
 */
export function setPiTuiHostEntryProvider(provider: (() => string | undefined) | undefined): void {
  tuiEntryProvider = provider;
  warmPromise = undefined;
  warmedTuiHost = undefined;
}

/** The running host's pi-tui peer package name; resolved host-relatively. */
const PI_TUI_PACKAGE_NAME = "@earendil-works/pi-tui";

/**
 * Resolves the running host's pi-tui peer through the established shared
 * loader (soft require first — the extension loader's package alias path —
 * then host-relative resolution for a compiled entry, which a pi >= 0.86
 * native-import load needs) and remembers the resolved record for every later
 * synchronous render. Memoized per process; a resolution that finds nothing is
 * also final until the entry provider or override seam changes. Returns the
 * resolved host record (possibly empty or undefined), never rejects.
 */
export function warmPiTuiHost(): Promise<PiTuiHost | undefined> {
  if (tuiOverride !== undefined) return Promise.resolve(tuiOverride);
  warmPromise ??= loadSharedPiTuiHost();
  return warmPromise;
}

async function loadSharedPiTuiHost(): Promise<PiTuiHost | undefined> {
  const tui = await loadHostPeerModule(PI_TUI_PACKAGE_NAME, { entryProvider: tuiEntryProvider });
  if (!tui) {
    warmedTuiHost = undefined;
    return undefined;
  }
  const host: PiTuiHost = {};
  if (typeof tui?.wrapTextWithAnsi === "function") {
    host.wrapTextWithAnsi = tui.wrapTextWithAnsi as PiTuiHost["wrapTextWithAnsi"];
  }
  if (typeof tui?.MouseRegion === "function") {
    host.MouseRegion = tui.MouseRegion as PiTuiHost["MouseRegion"];
  }
  if (typeof tui?.Box === "function") {
    host.Box = tui.Box as PiTuiHost["Box"];
  }
  if (typeof tui?.truncateToWidth === "function") {
    host.truncateToWidth = tui.truncateToWidth as PiTuiHost["truncateToWidth"];
  }
  warmedTuiHost = host;
  return host;
}

function resolveTui(): PiTuiHost | undefined {
  if (tuiOverride !== undefined) return tuiOverride;
  return warmedTuiHost;
}

// ── The native notification card boundary (theme-driven, both states) ───────

/**
 * Wraps one notification row in the host's OWN native card: a pi-tui `Box`
 * with exactly the default `CustomMessageComponent` padding and background —
 * `new Box(1, 1, (t) => theme.bg("customMessageBg", t))` — so every rendered
 * row (content, wrapped hint, and the blank one-cell padding rows) fills the
 * terminal width with the theme's `customMessageBg` token in BOTH states.
 *
 * The box's bgFn is evaluated by the Box itself on EVERY render against the
 * theme object the host passed, so colors follow the active theme (including
 * nondefault/custom themes and theme changes) without any ANSI snapshot —
 * exactly like the native card. The returned box forwards clicks into the
 * row (which has none of its own), so any card content or padding location
 * toggles that one item; when the Box peer or a theme bg() is unavailable the
 * unwrapped row degrades exactly as previously shipped.
 *
 * Width safety (#92 review correction): the native one-cell horizontal
 * padding needs three cells (pad×2 + one content cell). The host can measure
 * some graphemes as more than two cells, so content rows are clipped to the
 * width Box gives them before padding is added. Below three cells the card uses
 * zero horizontal padding, the same one-cell vertical padding and background,
 * and clips each row to the exact cell width. Width 0 and below renders nothing
 * — there is no cell to render into. Rows already fitting their content width
 * remain byte-identical, and both paths keep the native Box background.
 */
/**
 * A narrow card line that clipped a wide grapheme can carry a FULL ANSI reset
 * from the host truncator (`\x1b[0m`, review pass 2): the reset clears the
 * background, so a background applied ONLY at the line start leaves every
 * following cell — including the Box's own padding cell — unthemed. The card
 * background therefore reapplies `customMessageBg` after every full reset,
 * span by span. Ordinary rows (no full reset inside) stay byte-identical: one
 * background application around the whole padded line, exactly as before.
 */
const CARD_BG_FULL_RESET_SPLIT = /(\x1b\[0?m|\x1b\[49m)/;

function themedCardBgFn(bg: (color: string, text: string) => string): (text: string) => string {
  return (text: string): string => {
    const parts = text.split(CARD_BG_FULL_RESET_SPLIT);
    if (parts.length === 1) return bg("customMessageBg", text); // ordinary rows: byte-identical
    let result = "";
    for (const part of parts) {
      if (part === "\x1b[0m" || part === "\x1b[m" || part === "\x1b[49m") {
        result += part; // the reset itself; the next background span reopens
      } else if (part.length > 0) {
        result += bg("customMessageBg", part);
      }
    }
    return result;
  };
}

function nativeCard(row: MessageComponent, theme: unknown): MessageComponent {
  const tui = resolveTui();
  const BoxCtor = tui?.Box;
  const bg = bgOf(theme);
  if (typeof BoxCtor !== "function" || !bg) return row;
  const truncateToWidth = typeof tui?.truncateToWidth === "function"
    ? tui.truncateToWidth
    : undefined;
  const bgFn = themedCardBgFn(bg);
  const box = new BoxCtor(1, 1, bgFn);
  box.addChild({
    render(width: number): string[] {
      const w = Math.max(0, Math.floor(width));
      const lines = row.render(w);
      return w > 0 && truncateToWidth
        ? lines.map((line) => truncateToWidth(line, w, ""))
        : lines;
    },
    invalidate() {
      row.invalidate();
    },
  });
  // Degenerate-width card: zero horizontal padding (the native one-cell
  // padding cannot fit), the same vertical padding and background, and every
  // row clipped to the exact cell width with the host's own ANSI-aware
  // truncator so a wide grapheme can never push a row past the width.
  const narrowBox = new BoxCtor(0, 1, bgFn);
  narrowBox.addChild({
    render(width: number): string[] {
      const w = Math.max(0, Math.floor(width));
      if (w <= 0 || !truncateToWidth) return row.render(w);
      return row.render(w).map((line) => truncateToWidth(line, w, ""));
    },
    invalidate() {
      row.invalidate();
    },
  });
  return {
    render(width: number): string[] {
      const w = Math.max(0, Math.floor(width));
      // Keep native padding from three cells up. Both paths clip oversized
      // graphemes before Box adds padding; clusters can exceed two cells.
      if (w >= 3) return box.render(w);
      if (w <= 0) return [];
      if (truncateToWidth) return narrowBox.render(w);
      // Without the host truncator the narrow path is not cell-safe; keep the
      // native Box behavior (identical to the host's own degenerate widths).
      return box.render(w);
    },
    invalidate() {
      box.invalidate();
    },
    handleMouse(event: unknown): unknown {
      const width = isRecord(event) && typeof event.width === "number"
        ? Math.floor(event.width) : 0;
      return width >= 3 ? box.handleMouse?.(event) : narrowBox.handleMouse?.(event);
    },
  };
}

// ── Shared display helpers ───────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRenderableComponent(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && typeof (value as { render?: unknown }).render === "function";
}

/**
 * The theme's bg() with the receiver preserved, returning the theme-token ANSI
 * applied at CALL time: the host Theme.bg reads instance token tables, so a
 * standalone call throws; this closure keeps the theme object as `this` and
 * degrades to plain text on every failure. Never a hard-coded color, and
 * nothing is snapshotted — each call resolves the CURRENT token value, so a
 * theme change (or in-place token update) shows on the next render.
 */
function bgOf(value: unknown): ((color: string, text: string) => string) | undefined {
  const record = isRecord(value) ? value : undefined;
  const bgFn = typeof record?.bg === "function" ? record.bg as (color: string, text: string) => string : undefined;
  if (!bgFn) return undefined;
  return (color, text): string => {
    try {
      return bgFn.call(record, color, text);
    } catch {
      // Unknown token or receiver issue: plain text still communicates.
      return text;
    }
  };
}

/**
 * The native fg() with the receiver preserved: the host Theme.fg reads
 * instance state (token tables), so a standalone call throws. Unknown colors
 * or a broken receiver degrade to plain text rather than breaking the render.
 * Each call resolves the CURRENT token value (never a cached ANSI snapshot).
 */
function themeOf(value: unknown): MessageRendererTheme {
  const theme = isRecord(value) ? value : undefined;
  const boldFn = typeof theme?.bold === "function" ? (theme.bold as (text: string) => string) : undefined;
  const fgFn = typeof theme?.fg === "function" ? (theme.fg as (color: string, text: string) => string) : undefined;
  return {
    bold: boldFn
      ? (text) => { try { return boldFn.call(theme, text); } catch { return text; } }
      : (text) => text,
    fg: fgFn
      ? (color, text) => { try { return fgFn.call(theme, color, text); } catch { return text; } }
      : (_color, text) => text,
  };
}

/** A stateless text component that renders wrapped lines for a width. */
function textComponent(render: (width: number) => string[]): MessageComponent {
  return {
    render: (width: number) => render(Math.max(0, Math.floor(width))),
    invalidate() {},
  };
}

/**
 * Wraps already display-encoded text into terminal-cell-safe rows using the
 * host's own ANSI-aware `wrapTextWithAnsi` (wide glyphs and styling tracked).
 * Callers gate on availability first (see createExpandableMessageRenderer); the
 * newline split here is a last resort that never fabricates an over-wide row by
 * joining, but does not hard-wrap — hence the upstream gate.
 */
function wrapLines(text: string, width: number): string[] {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth <= 0) return text.split(/\r?\n/);
  const tui = resolveTui();
  if (typeof tui?.wrapTextWithAnsi === "function") {
    try {
      const lines = tui.wrapTextWithAnsi(text, safeWidth);
      if (Array.isArray(lines) && lines.length > 0 && lines.every((line) => typeof line === "string")) {
        return lines;
      }
    } catch {
      // Fall through to the degraded split.
    }
  }
  return text.split(/\r?\n/);
}

/** The message's model-visible text content (string or text-part array). */
export function messageContentText(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => isRecord(item) && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n");
  }
  return "";
}

/** The message's structured details record, when present. */
function detailsOf(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message)) return undefined;
  return isRecord(message.details) ? message.details : undefined;
}

// ── The shared core adapter for custom-message rows ─────────────────────────

/**
 * Builds the public `registerMessageRenderer` callback for one notification
 * family over the shared presentation expansion core.
 *
 * - `collapsedRenderer` is shown while the row is collapsed; `expandedRenderer`
 *   (required for a hint to appear) is shown while expanded. Both receive the
 *   CustomMessage, the host options, and the theme, and must render only
 *   recorded content (no I/O).
 * - Per-message expansion state lives in a WeakMap keyed by the message object
 *   (no id is guaranteed; multiple events share a customType). A left click on
 *   one message toggles only that message; a host global-flag change reconciles
 *   every message to the new absolute value; an unrelated rebuild with an
 *   unchanged flag retains each clicked state.
 * - The returned row is wrapped in the native message card (`nativeCard`,
 *   `Box(1, 1, customMessageBg)`) in BOTH states, and in pi-tui's MouseRegion
 *   when available so a fullscreen left click toggles that one message (handled,
 *   no neighbor effect). When pi-tui's wrapTextWithAnsi is unavailable the
 *   renderer returns undefined (full native fallback) so no over-width custom
 *   output is emitted; without the MouseRegion peer the full accessible text
 *   still renders and the keyboard global binding keeps working.
 */
export function createExpandableMessageRenderer(
  collapsedRenderer: MessageDelegate,
  expandedRenderer?: MessageDelegate,
): MessageRendererCallback {
  // Per-message state: the expansion value plus the global flag in effect when
  // it was last set. A host global-flag change reconciles a message lazily on its
  // next render (no WeakMap key iteration, which the lib target does not expose);
  // an unchanged global retains the clicked state.
  const localState = new WeakMap<object, { expanded: boolean; globalAtSet: boolean }>();

  const renderRow = expandablePresentation(
    collapsedRenderer as PresentationRenderer<unknown, unknown, unknown>,
    expandedRenderer as PresentationRenderer<unknown, unknown, unknown> | undefined,
    {
      fallbackOptions: () => ({ expanded: false, outputPad: 0 }),
      // The five family renderers fall back to the complete retained text when
      // a row's shape cannot be compacted truthfully; such a row must not
      // advertise an expansion that could not change what is shown.
      honorFullTextFallback: true,
    },
  );

  return (message: unknown, options: unknown, theme: unknown): unknown => {
    if (!isRecord(message)) return undefined; // host falls back to its default box
    // Cannot wrap into terminal cells safely: hand back to the host's native
    // full-text rendering rather than emit a custom component that could exceed
    // the width and bypass the host's own wrapping.
    if (typeof resolveTui()?.wrapTextWithAnsi !== "function") return undefined;

    const currentGlobal = isPresentationExpanded(options);
    const stored = localState.get(message);
    // A host global-flag change wins over a prior per-message click: if the
    // global differs from the one in effect when this message's state was last
    // set, reset to the current global. An unchanged global retains the clicked
    // state (an unrelated rebuild/invalidation does not clear it).
    const state = {
      expanded: stored && stored.globalAtSet === currentGlobal ? stored.expanded : currentGlobal,
      globalAtSet: currentGlobal,
    };
    localState.set(message, state);

    // Cache the core-produced row per expansion state. The core applies the
    // single native header hint and selects the delegate; both are pure for a
    // given (message, state), so the cached row is safe to re-render at any
    // width. A rebuild (theme change, global flag) creates a fresh component
    // instance with a fresh cache.
    let collapsedRow: unknown;
    let expandedRow: unknown;
    const inner: MessageComponent = {
      render(width: number): string[] {
        const base = isRecord(options) ? options : {};
        const effectiveOptions = { ...base, expanded: state.expanded };
        let row = state.expanded ? expandedRow : collapsedRow;
        if (!row) {
          row = renderRow(message, effectiveOptions, theme);
          if (state.expanded) expandedRow = row;
          else collapsedRow = row;
        }
        return isRenderableComponent(row) ? (row as MessageComponent).render(width) : [];
      },
      invalidate() {},
    };

    // The native visual boundary (both states): the row — header, hint, and
    // expanded body alike — is wrapped in the host's own native card so the
    // notification never blends with surrounding assistant text. Rendering is
    // synchronous, IO-free, and peer-load-free: it reads only the
    // already-warmed peer record and the theme object the host passed.
    const card = nativeCard(inner, theme);
    const Region = resolveTui()?.MouseRegion;
    if (typeof Region !== "function") return card; // keyboard-only degradation
    return new Region(card, (event: unknown): unknown => {
      if (!isRecord(event) || event.type !== "click" || event.button !== "left") return undefined;
      state.expanded = !state.expanded;
      localState.set(message, { expanded: state.expanded, globalAtSet: currentGlobal });
      inner.invalidate();
      return { handled: true };
    });
  };
}

// ── Shared expanded view: the complete existing notification text ───────────

/**
 * The expanded view for every notification family: the COMPLETE existing
 * notification text (`message.content`), display-encoded and wrapped. No report
 * is fetched, no model-visible text is truncated or filtered, and no I/O occurs.
 */
export function renderFullMessageContent(
  message: unknown,
  _options: unknown,
  theme: unknown,
): MessageComponent {
  const rendererTheme = themeOf(theme);
  const text = messageContentText(message);
  return textComponent((width) => {
    if (text.length === 0) {
      return wrapLines(rendererTheme.fg("muted", "[no retained notification content]"), width);
    }
    // Display-encode exactly once at the raw-text boundary: control bytes become
    // visible notation instead of being executed or deleted. Each wrapped body
    // row follows the native customMessageText body token (resolved against the
    // theme at render time — never a cached ANSI snapshot), like the host's
    // default custom-message body.
    return wrapLines(visibleTerminalText(text), width)
      .map((line) => rendererTheme.fg("customMessageText", line));
  });
}

/**
 * The honest fallback for unknown/historical/malformed content: the FULL
 * retained content (no arbitrary preview, no compaction promise). The expanded
 * view carries the same complete text. The component is explicitly marked as
 * the complete retained text so the shared core omits the expansion hint (the
 * hint would promise a change expansion cannot make); the mark is a
 * presentation signal, never a comparison of rendered lines.
 */
function collapsedFallback(message: unknown, theme: unknown): MessageComponent {
  return markFullTextFallback(renderFullMessageContent(message, {}, theme));
}

function firstLine(text: string): string {
  const index = text.indexOf("\n");
  return (index === -1 ? text : text.slice(0, index)).trim();
}

/**
 * Extracts the execution's `N/M` aggregate count from the producer's OWN
 * aggregate line — anchored to the group label + execution id + a COMPLETE /
 * IN PROGRESS / INCOMPLETE (or "has") clause. This never matches an unrelated
 * ratio inside an inlined report (which does not carry that anchored prefix).
 * Iterating in reverse prefers the final producer aggregate when more than one
 * line could match.
 */
function aggregateCount(content: string, executionId?: string): string | undefined {
  for (const line of content.split(/\r?\n/).reverse()) {
    const match = line.match(/^(?:Execution|Research|In-place) (\S+) (?:(?:COMPLETE|IN PROGRESS|INCOMPLETE):|(?:currently )?has) (\d+)\s*\/\s*(\d+)\b/);
    if (match && (!executionId || match[1] === executionId)) {
      return `${match[2]}/${match[3]}`;
    }
  }
  return undefined;
}

/**
 * A curated failure diagnostic is usable only when it carries the full set of
 * fields the collapsed view relies on: a supported task state, a non-empty
 * title and notice, and a recovery block with at least one actionable
 * instruction. An empty `diagnostic: {}` or a `recovery: {}` must not bypass
 * the full-content fallback — a failure we cannot interpret is shown in full.
 */
function hasDiagnosticContent(d: Record<string, unknown>): boolean {
  return typeof d.taskState === "string"
    && BACKGROUND_TASK_STATES.some((state) => state === d.taskState)
    && typeof d.title === "string" && d.title.trim().length > 0
    && typeof d.message === "string"
    && (d.error === undefined || typeof d.error === "string")
    && isRecord(d.recovery)
    && Array.isArray(d.recovery.suggestedActions)
    && d.recovery.suggestedActions.length > 0
    && d.recovery.suggestedActions.every((action) => typeof action === "string" && action.trim().length > 0);
}

/**
 * True only for ABSENT diagnostic metadata (`undefined`/`null`) or an empty
 * record. Any other delivered value is nonempty metadata: even when it is not
 * usable, it is meaningful recorded state and must not be silently replaced by
 * a diagnostic recovered from the retained text.
 */
function isEmptyDiagnosticMetadata(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return isRecord(value) && Object.keys(value).length === 0;
}

/** A supplied details field that is actually present (non-empty string). */
function suppliedIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The producer's preamble head line (`formatWakeFailurePreamble`, line 1). */
const WAKE_FAILURE_PREAMBLE_HEAD =
  /^Task (\S+) requires recovery attention at state ([A-Z_]+) in (execute|research|inplace) execution (\S+) \(revision (\d+)\)\.$/;
/** The producer's preamble progress line (`formatWakeFailurePreamble`, line 2). */
const WAKE_FAILURE_PREAMBLE_PROGRESS = /^Execution progress: (\d+)\/(\d+) task\(s\) (.+), (\d+) active\.$/;
/** The literal separator the producer writes between the preamble and the curated JSON. */
const WAKE_FAILURE_DIAGNOSTIC_BOUNDARY =
  "Failure recovery diagnostic (curated and bounded; use SubtasksInspect for the full current snapshot):";

/** Structural validation of the diagnostic's optional conflict gate. */
function validConflictGate(value: unknown): boolean {
  return isRecord(value)
    && Array.isArray(value.paths) && value.paths.every((path) => typeof path === "string")
    && typeof value.manifestPath === "string"
    && typeof value.reason === "string";
}

/**
 * Content-only recognition of the producer's recovery/failure notification: the
 * `formatWakeFailurePreamble` head, the literal diagnostic boundary line, and
 * the curated `formatWakeFailureDiagnostic` JSON — all read from the retained
 * message text alone (no fetch, artifact, log, or history read). Used only when
 * the delivered structured details are absent or unusable, so valid structured
 * metadata always stays authoritative.
 *
 * Recognition is deliberately strict so a compact recovery summary can never be
 * fabricated from unrelated JSON or inlined content:
 *
 * - the preamble must OPEN the message (its first two lines must match the
 *   producer's own wording) and its optional Notice/Summary/Error lines must
 *   appear in the producer's order, exactly once each;
 * - the literal boundary line must follow a single blank separator line, and the
 *   remainder must be complete, parseable JSON — an explicitly truncated
 *   diagnostic is rejected (its recovery actions may be incomplete);
 * - the JSON's task/execution/kind/state/revision/progress identities and its
 *   Notice/Summary/Error text must AGREE with the preamble, and the fields the
 *   collapsed view relies on (title, message, recovery actions) must validate
 *   structurally. Any mismatch or malformed shape returns undefined, and the
 *   caller keeps the full retained text.
 */
function contentWakeFailureDiagnostic(content: string): Record<string, unknown> | undefined {
  const lines = content.split(/\r?\n/);
  const head = lines[0]?.match(WAKE_FAILURE_PREAMBLE_HEAD);
  if (!head) return undefined;
  const taskId = head[1]!;
  const stateUpper = head[2]!;
  const kind = head[3]!;
  const executionId = head[4]!;
  const revisionText = head[5]!;
  const progress = lines[1]?.match(WAKE_FAILURE_PREAMBLE_PROGRESS);
  if (!progress) return undefined;
  const settledText = progress[1]!;
  const taskCountText = progress[2]!;
  const activeText = progress[4]!;
  // The prose between the counts must be this kind's own success verb, exactly
  // as the producer writes it (execute lands, research reports, in-place
  // settles in place) — a different sentence is not the producer's preamble.
  if (progress[3] !== subtaskSuccessVerb(kind as BackgroundTaskKind)) return undefined;

  // Notice/Summary/Error in the producer's own order, each at most once, then
  // the blank separator and the literal boundary line.
  let index = 2;
  const preambleText: { notice?: string; summary?: string; error?: string } = {};
  for (const [field, prefix] of [["notice", "Notice: "], ["summary", "Summary: "], ["error", "Error: "]] as const) {
    const line = lines[index];
    if (line !== undefined && line.startsWith(prefix)) {
      preambleText[field] = line.slice(prefix.length);
      index += 1;
    }
  }
  if (lines[index] !== "" || lines[index + 1] !== WAKE_FAILURE_DIAGNOSTIC_BOUNDARY) return undefined;
  const jsonText = lines.slice(index + 2).join("\n");
  if (jsonText.length === 0 || jsonText.endsWith(TRUNCATION_MARKER)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  // Identity agreement between the preamble and the curated JSON: both are
  // written from ONE diagnostic by the producer, so any disagreement means this
  // is not the producer's own concatenation (unrelated or inlined JSON).
  if (parsed.taskId !== taskId || parsed.executionId !== executionId) return undefined;
  if (parsed.kind !== kind) return undefined;
  if (parsed.revision !== Number(revisionText)) return undefined;
  if (typeof parsed.taskState !== "string" || parsed.taskState.toUpperCase() !== stateUpper) return undefined;
  if (!BACKGROUND_TASK_STATES.some((state) => state === parsed.taskState)) return undefined;
  if (typeof parsed.title !== "string" || parsed.title.trim().length === 0) return undefined;
  if (typeof parsed.message !== "string") return undefined;
  if (parsed.summary !== undefined && typeof parsed.summary !== "string") return undefined;
  if (parsed.error !== undefined && typeof parsed.error !== "string") return undefined;
  const groupSummary = parsed.groupSummary;
  if (!isRecord(groupSummary)
    || groupSummary.settled !== Number(settledText)
    || groupSummary.taskCount !== Number(taskCountText)
    || groupSummary.active !== Number(activeText)) return undefined;
  if (!isRecord(parsed.recovery)
    || !Array.isArray(parsed.recovery.suggestedActions)
    || parsed.recovery.suggestedActions.length === 0
    || !parsed.recovery.suggestedActions.every((action) => typeof action === "string" && action.trim().length > 0)) {
    return undefined;
  }
  if (parsed.recovery.conflictGate !== undefined && !validConflictGate(parsed.recovery.conflictGate)) return undefined;
  // The preamble omits a field exactly when the curated value is empty, and
  // repeats the value verbatim otherwise: a present/absent or textual mismatch
  // is a shape we cannot attribute to the producer.
  const summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
  const error = typeof parsed.error === "string" ? parsed.error : undefined;
  if (preambleText.notice !== undefined && preambleText.notice !== parsed.message) return undefined;
  if (preambleText.summary !== undefined && preambleText.summary !== summary) return undefined;
  if (preambleText.error !== undefined && preambleText.error !== error) return undefined;
  if (preambleText.notice === undefined && parsed.message.length > 0) return undefined;
  if (preambleText.summary === undefined && summary !== undefined && summary.length > 0) return undefined;
  if (preambleText.error === undefined && error !== undefined && error.length > 0) return undefined;
  return parsed;
}

/**
 * Recovers the curated diagnostic from the retained notification text ONLY when
 * the delivered metadata is absent or empty, and ONLY when the recovered
 * identity does not contradict any identity the delivered details DID supply
 * (`taskId`, `executionId`, `state`). A conflict means the two recorded views
 * disagree, so neither is presented as a compact summary — the caller keeps the
 * full retained text. Valid structured metadata never reaches this path (it is
 * authoritative on its own).
 */
function recoverTextDiagnostic(
  details: Record<string, unknown>,
  content: string,
): Record<string, unknown> | undefined {
  const recovered = contentWakeFailureDiagnostic(content);
  if (!recovered) return undefined;
  const taskId = suppliedIdentity(details.taskId);
  if (taskId !== undefined && recovered.taskId !== taskId) return undefined;
  const executionId = suppliedIdentity(details.executionId);
  if (executionId !== undefined && recovered.executionId !== executionId) return undefined;
  const state = suppliedIdentity(details.state);
  if (state !== undefined && recovered.taskState !== state) return undefined;
  return recovered;
}

/**
 * The bounded output excerpt from a `formatWakePayload` body: the lines between
 * the `last N of M lines:` marker and its closing fence. This is where a failed
 * job's diagnostic or a matched line lives; it is already bounded upstream, so
 * the complete retained excerpt is returned (no further truncation). The
 * closing fence is located from the END so a literal ``` inside command output
 * does not terminate extraction early.
 */
function shellExcerptLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => /^last \d+ of \d+ lines:$/.test(l.trim()));
  if (start === -1) return [];
  const fenceStart = lines.findIndex((l, i) => i > start && l.trim() === "```");
  if (fenceStart === -1) return [];
  let fenceEnd = lines.length;
  for (let i = lines.length - 1; i > fenceStart; i--) {
    if (lines[i]!.trim() === "```") {
      fenceEnd = i;
      break;
    }
  }
  return lines.slice(fenceStart + 1, fenceEnd);
}

// ── pi-review-subtask-event ──────────────────────────────────────────────────

/**
 * The recorded task state as a truthful display label. Success states are
 * distinct per kind (an in-place "reported" / settled-in-place is never equated
 * with a Git "landed"); recovery states are surfaced, not hidden.
 */
function subtaskStateLabel(state: string): { label: string; color: "success" | "error" | "warning" } | undefined {
  switch (state) {
    case "landed": return { label: "LANDED", color: "success" };
    case "reported": return { label: "REPORTED", color: "success" };
    case "failed": return { label: "FAILED", color: "error" };
    case "conflicted": return { label: "CONFLICTED", color: "warning" };
    case "paused_recoverable": return { label: "PAUSED (RECOVERABLE)", color: "warning" };
    case "stopped_for_application_exit": return { label: "STOPPED (APP EXIT)", color: "warning" };
    case "interrupted": return { label: "INTERRUPTED", color: "warning" };
    default: return undefined;
  }
}

/**
 * Collapsed subtask lifecycle event: task title + actual outcome state + the
 * available aggregate count; a separate full report-reference line when present
 * (no path shortening); and, for failures/conflicts/recovery, the immediate
 * actionable detail from the curated diagnostic — whether it arrived as
 * structured details or only as the producer's retained preamble + JSON text.
 * Unrecognized, malformed, or identity-inconsistent content falls back to the
 * full retained text rather than a misleading summary, as does nonempty but
 * unusable structured metadata and a text-derived diagnostic that contradicts a
 * supplied task/execution/state identity.
 */
export function renderSubtaskEventCollapsed(
  message: unknown,
  _options: unknown,
  theme: unknown,
): MessageComponent {
  const rendererTheme = themeOf(theme);
  const content = messageContentText(message);
  const details = detailsOf(message) ?? {};
  // A curated failure diagnostic is usable only when it carries real content —
  // an empty `diagnostic: {}` must not bypass the full-content fallback. Valid
  // structured details stay authoritative. Nonempty but unusable structured
  // metadata is meaningful recorded state and is NEVER replaced by a diagnostic
  // recovered from text: the full retained text is shown instead. Only ABSENT or
  // EMPTY diagnostic metadata falls through to the retained-text path, whose
  // recovered identity must not contradict any identity the details supplied.
  const suppliedDiagnostic = details.diagnostic;
  const structuredDiagnostic = isRecord(suppliedDiagnostic) && hasDiagnosticContent(suppliedDiagnostic)
    ? suppliedDiagnostic : undefined;
  if (!structuredDiagnostic && !isEmptyDiagnosticMetadata(suppliedDiagnostic)) {
    return collapsedFallback(message, theme);
  }
  const diagnostic = structuredDiagnostic ?? recoverTextDiagnostic(details, content);

  // Title and state from the recorded "Task: <id> · <title> · <state>" line.
  // The producer appends its authoritative Task line AFTER any inlined report
  // text, so select the FINAL match — a report that itself contains a `Task:`
  // line must not be mistaken for the event header (which would show the wrong
  // title and, without details, a false LANDED state).
  let title: string | undefined;
  let taskLineState: string | undefined;
  const taskLine = content.split(/\r?\n/).reverse().find((line) => /^Task:\s/.test(line));
  if (taskLine) {
    const parts = taskLine.replace(/^Task:\s*/, "").split(" · ");
    if (parts.length >= 3) {
      title = parts.slice(1, -1).join(" · ").trim();
      taskLineState = parts[parts.length - 1]!.trim();
    }
  }
  if (!title && typeof diagnostic?.title === "string" && diagnostic.title.length > 0) {
    title = diagnostic.title;
  }

  // details.state is authoritative when present; else the state recorded in the
  // Task line, else the diagnostic's own taskState. Without a retained title,
  // a supported state, or (for failures) a usable recovery diagnostic, the
  // shape is not one we can summarize truthfully — show the full retained text.
  const rawState = (typeof details.state === "string" && details.state.length > 0)
    ? details.state : taskLineState ?? (typeof diagnostic?.taskState === "string" ? diagnostic.taskState : undefined);
  const stateInfo = rawState ? subtaskStateLabel(rawState) : undefined;

  if (!title || !rawState || !BACKGROUND_TASK_STATES.some((state) => state === rawState)) {
    return collapsedFallback(message, theme);
  }

  const executionId = typeof details.executionId === "string" ? details.executionId : undefined;
  const isFailure = rawState === "failed" || rawState === "conflicted"
    || rawState === "paused_recoverable" || rawState === "stopped_for_application_exit"
    || rawState === "interrupted" || diagnostic !== undefined;
  // A failure/recovery state without a usable diagnostic cannot be compacted to
  // its header — that would hide the retained failure and recovery instructions.
  if (isFailure && !diagnostic) return collapsedFallback(message, theme);

  // Count: the validated diagnostic groupSummary for failures, else a recognized
  // aggregate line (named by the execution id when available) — never an
  // unrelated ratio inside an inlined report.
  const groupSummary = isRecord(diagnostic?.groupSummary) ? diagnostic.groupSummary : undefined;
  const summaryCount = groupSummary && typeof groupSummary.settled === "number" && typeof groupSummary.taskCount === "number"
    ? `${groupSummary.settled}/${groupSummary.taskCount}` : undefined;
  const count = (isFailure && summaryCount) ? summaryCount : aggregateCount(content, executionId);

  // Report reference: a full, unshortened path line when the content carries one.
  const reportLine = content.split(/\r?\n/).find((line) => /^Full report:\s*\S/.test(line));
  const landedLine = content.split(/\r?\n/).find((line) => /^Landed paths:\s*\S/.test(line));

  return textComponent((width) => {
    const headerParts = [
      // Native custom-message styling (#92 correction): the bounded card label
      // and body text follow the theme's customMessageLabel/customMessageText
      // tokens (resolved per render, never hard-coded); status colors stay.
      rendererTheme.fg("customMessageLabel", rendererTheme.bold("[subtask]")),
      title
        ? rendererTheme.fg("customMessageText", visibleTerminalText(title))
        : rendererTheme.fg("customMessageText", "[title not retained]"),
      stateInfo
        ? `· ${rendererTheme.fg(stateInfo.color, stateInfo.label)}`
        : (rawState ? `· ${rendererTheme.fg("muted", visibleTerminalText(rawState.toUpperCase()))}` : ""),
      count ? `· ${rendererTheme.fg("customMessageText", count)}` : "",
    ].filter((part) => part.length > 0);
    const lines = [headerParts.join(" ")];

    if (reportLine) lines.push(rendererTheme.fg("customMessageText", visibleTerminalText(reportLine.trim())));
    else if (landedLine) lines.push(rendererTheme.fg("customMessageText", visibleTerminalText(landedLine.trim())));

    // Immediate actionable failure/conflict/recovery detail, from the curated
    // diagnostic when present (bounded by construction upstream). The notice and
    // EVERY recovery instruction stay visible alongside the error — the producer
    // orders SubtasksInspect first, then conflict/continuation/interrupt steps.
    if (isFailure && diagnostic) {
      const error = typeof diagnostic.error === "string" ? diagnostic.error : undefined;
      const notice = typeof diagnostic.message === "string" ? diagnostic.message : undefined;
      const recovery = isRecord(diagnostic.recovery) ? diagnostic.recovery : undefined;
      const conflictGate = recovery && isRecord(recovery.conflictGate) ? recovery.conflictGate : undefined;
      if (error) lines.push(rendererTheme.fg("error", `Error: ${visibleTerminalText(error)}`));
      if (notice && notice !== error) lines.push(rendererTheme.fg("customMessageText", visibleTerminalText(notice)));
      if (conflictGate) {
        const paths = Array.isArray(conflictGate.paths)
          ? (conflictGate.paths as unknown[]).filter((item): item is string => typeof item === "string")
          : [];
        const reason = typeof conflictGate.reason === "string" ? conflictGate.reason : undefined;
        lines.push(rendererTheme.fg("warning", `Conflict: ${visibleTerminalText(paths.join(", "))}${reason ? ` — ${visibleTerminalText(reason)}` : ""}`));
      }
      const actions = recovery && Array.isArray(recovery.suggestedActions)
        ? (recovery.suggestedActions as unknown[]).filter((item): item is string => typeof item === "string" && item.length > 0)
        : [];
      for (const action of actions) {
        lines.push(rendererTheme.fg("warning", `Recovery: ${visibleTerminalText(action)}`));
      }
    }

    return lines.flatMap((line) => wrapLines(line, width));
  });
}

// ── pi-review-bg-shell ───────────────────────────────────────────────────────

/**
 * Collapsed background-shell wake: job identity/label, the wake reason, the exit
 * status when reported, and a bounded command preview — all parsed from the
 * actual `formatWakePayload` text. If the payload shape is not recognized (so the
 * reason or exit status cannot be shown truthfully), falls back to the full
 * retained payload rather than hiding it behind an id alone. The output excerpt
 * and "still running" note are the expanded view.
 */
export function renderBgShellCollapsed(
  message: unknown,
  _options: unknown,
  theme: unknown,
): MessageComponent {
  const rendererTheme = themeOf(theme);
  const content = messageContentText(message);

  // formatWakePayload head: background job "<label>" (<id>) — <reason>
  const head = firstLine(content);
  const headMatch = head.match(/^background job "([^"]*)" \(([^)]+)\) — (.+)$/);
  if (!headMatch) return collapsedFallback(message, theme);
  const label = headMatch[1]!;
  const id = headMatch[2]!;
  const reason = headMatch[3]!;

  // running: <elapsed>[ · exit <code>]
  const runningLine = content.split(/\r?\n/).find((line) => /^running:\s/.test(line));
  let exitCode: string | undefined;
  if (runningLine) {
    const exitMatch = runningLine.match(/exit\s+(-?\d+)/);
    if (exitMatch) exitCode = exitMatch[1];
  }

  // command: <command>
  const commandLine = content.split(/\r?\n/).find((line) => /^command:\s/.test(line));
  const command = commandLine ? commandLine.replace(/^command:\s*/, "") : undefined;

  // Actionable wakes (a nonzero or signal-killed exit, or a match/milestone)
  // keep the bounded output excerpt visible — that is where the diagnostic or
  // matched line lives. Success and silence wakes are summarized without it.
  // The excerpt is already bounded upstream and must not be truncated again.
  const failedExit = (exitCode !== undefined && Number(exitCode) !== 0)
    || /^exited null(?:\s|$)/.test(reason);
  const isMatchWake = /^matched\b/i.test(reason);
  const excerpt = (failedExit || isMatchWake) ? shellExcerptLines(content) : [];

  return textComponent((width) => {
    const headerParts = [
      rendererTheme.fg("customMessageLabel", rendererTheme.bold("[bg-shell]")),
      rendererTheme.fg("customMessageText", visibleTerminalText(label)),
      rendererTheme.fg("muted", `(${visibleTerminalText(id)})`),
      `· ${rendererTheme.fg("customMessageText", visibleTerminalText(reason))}`,
      exitCode !== undefined
        ? rendererTheme.fg(Number(exitCode) === 0 ? "success" : "error", `· exit ${exitCode}`)
        : "",
    ].filter((part) => part.length > 0);
    const lines = [headerParts.join(" ")];
    if (command) lines.push(rendererTheme.fg("muted", `command: ${visibleTerminalText(command)}`));
    for (const line of excerpt) {
      lines.push(rendererTheme.fg("customMessageText", visibleTerminalText(line)));
    }
    return lines.flatMap((line) => wrapLines(line, width));
  });
}

// ── pi-review-subtask-watch ──────────────────────────────────────────────────

interface WatchExecutionView {
  executionId?: unknown;
  kind?: unknown;
  revision?: unknown;
  tasks?: Array<Record<string, unknown>>;
}

/** Active (unsettled) task states for a watch checkpoint summary — mirrors the producer's ACTIVE_TASK_STATES. */
function isActiveWatchState(state: string): boolean {
  return state === "queued" || state === "capturing" || state === "accepted" || state === "running"
    || state === "reviewing" || state === "waiting_to_land" || state === "landing";
}

/**
 * Collapsed subtask watch checkpoint: the active-work summary per execution,
 * clearly labeled a deliberate checkpoint (NOT a completion or failure event).
 * Falls back to the full retained text when the structured details are absent.
 */
export function renderSubtaskWatchCollapsed(
  message: unknown,
  _options: unknown,
  theme: unknown,
): MessageComponent {
  const rendererTheme = themeOf(theme);
  const details = detailsOf(message) ?? {};
  const executionsRaw = Array.isArray(details.executions) ? details.executions : undefined;

  // Validate the structured shape before summarizing: every execution must be a
  // record with a tasks array of records carrying a string state. A missing
  // tasks field (executions: [{}]) or a malformed task (tasks: [null]) is not a
  // reliable snapshot — fall back to the full retained content rather than
  // fabricate an active count or throw mid-render.
  if (!executionsRaw || executionsRaw.length === 0) {
    return collapsedFallback(message, theme);
  }
  const executions: WatchExecutionView[] = [];
  for (const raw of executionsRaw) {
    if (!isRecord(raw) || typeof raw.executionId !== "string" || !raw.executionId.trim()
      || !Array.isArray(raw.tasks)) return collapsedFallback(message, theme);
    const tasks = raw.tasks as unknown[];
    for (const task of tasks) {
      if (!isRecord(task) || !BACKGROUND_TASK_STATES.some((state) => state === task.state)) {
        return collapsedFallback(message, theme);
      }
    }
    executions.push({ ...raw, tasks: tasks as Record<string, unknown>[] });
  }

  return textComponent((width) => {
    const lines: string[] = [
      rendererTheme.fg("customMessageLabel", rendererTheme.bold("[subtask-watch]")) + " "
      + rendererTheme.fg("muted", "one-shot checkpoint · active work only — not a completion or failure"),
    ];
    for (const execution of executions) {
      const tasks = execution.tasks ?? [];
      const active = tasks.filter((task) => isActiveWatchState(task.state as string));
      const id = typeof execution.executionId === "string" ? execution.executionId : "[unknown]";
      lines.push(rendererTheme.fg("muted", `· ${visibleTerminalText(id)}: ${active.length} active task(s)`));
    }
    return lines.flatMap((line) => wrapLines(line, width));
  });
}

// ── pi-review-scheduled-task-event ───────────────────────────────────────────

/**
 * The truthful outcome of a scheduled owner event, from the recorded wording.
 * Never implies completion or execution; uncertainty and the duplicate-retry
 * warning stay in the collapsed view (not hidden in the expanded text).
 */
/**
 * The truthful outcome of a scheduled owner event, recognized from the
 * FORMATTER'S OWN outcome clauses — distinctive multi-word phrases that an entry
 * name or error could not accidentally contain — rather than by searching the
 * whole payload for substrings like "dispatch failed". Each outcome also names
 * its actionable instruction line (the producer's repair/inspect guidance), which
 * must stay visible in the collapsed view.
 */
function scheduledEventOutcome(content: string): {
  label: string;
  color: "error" | "warning";
  actionMatch: RegExp;
} | undefined {
  const head = firstLine(content);
  const lines = content.split(/\r?\n/);
  // Every current formatter opens with this prefix; anything else (a historical
  // or malformed event) is not recognized and falls back to the full content.
  if (!/^Scheduled task \S+ \(.+\) was due at /.test(head)) return undefined;
  // Recognize each outcome from the FORMATTER'S OWN fixed head suffix or
  // dedicated outcome line — never by searching the whole payload, so an error
  // message that merely contains an uncertainty phrase cannot flip a dispatch
  // failure to UNKNOWN (or vice versa).
  if (head.endsWith(' and its orchestrator-turn send was accepted by the host, but it did not acknowledge within its bounded delivery window.')) {
    return { label: "UNKNOWN (MAY STILL ARRIVE)", color: "warning", actionMatch: /Inspect the conversation before retrying/i };
  }
  if (head.endsWith(', but dispatch failed:')) {
    return { label: "DISPATCH FAILED", color: "error", actionMatch: /Fix the entry or its worker\/review choices/i };
  }
  if (head.endsWith(', but its scheduled orchestrator turn could not be delivered to the existing agent:')) {
    return { label: "NOT DELIVERED", color: "error", actionMatch: /Repair the delivery channel/i };
  }
  if (head.endsWith(' The due occurrence was SKIPPED: nothing was dispatched, queued, interrupted, or completed.')) {
    return { label: "SKIPPED (PREVIOUS RUN ACTIVE)", color: "warning", actionMatch: /Inspect the active executions before re-dispatching/i };
  }
  if (lines[1]?.startsWith('The due occurrence was SKIPPED: no second turn was queued, dispatched, or executed.')) {
    return { label: "SKIPPED (ONE-SHOT PENDING)", color: "warning", actionMatch: /pending turn counts as the entry's single execution/i };
  }
  if (lines[1]?.startsWith('The occurrence was NOT RUN: nothing was dispatched, queued, interrupted, or completed, and no catch-up run is started.')) {
    return { label: "NOT RUN (OVERDUE DROP)", color: "warning", actionMatch: /no catch-up run is started/i };
  }
  return undefined;
}

/**
 * Collapsed scheduled-task owner event: the entry and due occurrence with the
 * truthful outcome (SKIPPED / NOT RUN / DISPATCH FAILED / NOT DELIVERED / UNKNOWN)
 * and the immediate actionable detail — the bounded error for a failure, or the
 * inspect-before-retry / duplicate warning for an uncertain delivery. Recognizes
 * every current formatter shape (overlap skip, one-shot pending skip, overdue
 * drop, dispatch failure, orchestrator delivery failure/uncertain); unrecognized
 * content falls back to the full retained text.
 */
export function renderScheduledTaskEventCollapsed(
  message: unknown,
  _options: unknown,
  theme: unknown,
): MessageComponent {
  const rendererTheme = themeOf(theme);
  const content = messageContentText(message);
  const head = firstLine(content);
  if (!head) return collapsedFallback(message, theme);

  // Recognize the outcome from the formatter's own clause; an unrecognized shape
  // (a historical or malformed event) falls back to the full retained content
  // rather than being compacted to its first line.
  const outcome = scheduledEventOutcome(content);
  if (!outcome) return collapsedFallback(message, theme);

  const lines = content.split(/\r?\n/);
  // The actionable repair/inspect instruction is the final line (the formatter
  // always appends it last); validate it matches the outcome before compacting.
  // For a failure the bounded error is every line between the head and that
  // action line — it may be multiline, so none of it is dropped.
  const isErrorOutcome = outcome.color === "error";
  const actionLine = lines.at(-1)?.trim();
  if (!actionLine || !outcome.actionMatch.test(actionLine)) return collapsedFallback(message, theme);
  const errorLines = isErrorOutcome
    ? lines.slice(1, -1).map((line) => line.trim()).filter((line) => line.length > 0)
    : [];

  return textComponent((width) => {
    const out: string[] = [
      rendererTheme.fg("customMessageLabel", rendererTheme.bold("[scheduled]")) + " "
      + rendererTheme.fg(outcome.color, outcome.label) + " · "
      + rendererTheme.fg("customMessageText", visibleTerminalText(head)),
    ];
    for (const errorLine of errorLines) {
      out.push(rendererTheme.fg("error", visibleTerminalText(errorLine)));
    }
    if (actionLine && actionLine !== head) {
      out.push(rendererTheme.fg(isErrorOutcome ? "muted" : "warning", visibleTerminalText(actionLine)));
    }
    return out.flatMap((line) => wrapLines(line, width));
  });
}

// ── pi-review-scheduled-orchestrator-turn ────────────────────────────────────

/**
 * Collapsed scheduled orchestrator turn: the entry and due occurrence, clearly a
 * scheduled request (NOT a completed outcome or an outcome report). The full
 * current instructions are the expanded view.
 */
export function renderScheduledOrchestratorTurnCollapsed(
  message: unknown,
  _options: unknown,
  theme: unknown,
): MessageComponent {
  const rendererTheme = themeOf(theme);
  const content = messageContentText(message);
  const details = detailsOf(message) ?? {};
  const head = firstLine(content);
  // Recognize the formatter's own clause; an unrecognized (historical or
  // malformed) shape falls back to the full retained content rather than being
  // compacted to its first line.
  if (!head || !/^Scheduled orchestrator turn for task /.test(head)) {
    return collapsedFallback(message, theme);
  }

  return textComponent((width) => {
    const lines: string[] = [
      rendererTheme.fg("customMessageLabel", rendererTheme.bold("[scheduled-turn]")) + " "
      + rendererTheme.fg("customMessageText", visibleTerminalText(head)),
      rendererTheme.fg("muted", "scheduled request for the current turn — not a completed outcome or an outcome report"),
    ];
    const entryId = typeof details.entryId === "string" ? details.entryId : undefined;
    const dueAt = typeof details.dueAt === "string" ? details.dueAt : undefined;
    if (entryId || dueAt) {
      lines.push(rendererTheme.fg("muted", [entryId ? `entry ${visibleTerminalText(entryId)}` : "", dueAt ? `due ${visibleTerminalText(dueAt)}` : ""].filter(Boolean).join(" · ")));
    }
    return lines.flatMap((line) => wrapLines(line, width));
  });
}

// ── Registration ─────────────────────────────────────────────────────────────

/** The five notification custom types this module renders (exactly these). */
export const NOTIFICATION_MESSAGE_TYPES = [
  "pi-review-subtask-event",
  "pi-review-bg-shell",
  "pi-review-subtask-watch",
  "pi-review-scheduled-task-event",
  "pi-review-scheduled-orchestrator-turn",
] as const;

export type NotificationMessageType = (typeof NOTIFICATION_MESSAGE_TYPES)[number];

/** The registered renderer for each notification family. */
const NOTIFICATION_RENDERERS: Record<NotificationMessageType, MessageRendererCallback> = {
  "pi-review-subtask-event": createExpandableMessageRenderer(renderSubtaskEventCollapsed, renderFullMessageContent),
  "pi-review-bg-shell": createExpandableMessageRenderer(renderBgShellCollapsed, renderFullMessageContent),
  "pi-review-subtask-watch": createExpandableMessageRenderer(renderSubtaskWatchCollapsed, renderFullMessageContent),
  "pi-review-scheduled-task-event": createExpandableMessageRenderer(renderScheduledTaskEventCollapsed, renderFullMessageContent),
  "pi-review-scheduled-orchestrator-turn": createExpandableMessageRenderer(renderScheduledOrchestratorTurnCollapsed, renderFullMessageContent),
};

/**
 * Registers the five notification message renderers on a Pi host. Returns true
 * when registration happened, false when the host lacks `registerMessageRenderer`
 * (older hosts) so the caller can report the full-native-fallback degradation.
 * Never throws: a host that rejects one registration keeps the rest attempted.
 */
export function registerNotificationMessageRenderers(pi: unknown): boolean {
  const host = pi as { registerMessageRenderer?: (customType: string, renderer: MessageRendererCallback) => void } | null;
  if (!host || typeof host.registerMessageRenderer !== "function") return false;
  for (const customType of NOTIFICATION_MESSAGE_TYPES) {
    try {
      host.registerMessageRenderer(customType, NOTIFICATION_RENDERERS[customType]);
    } catch {
      // A host that rejects one type must not abort the rest; that type keeps
      // the host's default full-text rendering.
    }
  }
  return true;
}
