/**
 * Shared native expansion hints for the #93 tool-result rollout.
 *
 * Integration contract (shared by every family renderer):
 *
 * - Family renderers produce their header/body WITHOUT an expansion hint of
 *   their own. The shared wrapper installed by `expandableResult`
 *   (./tool-result-expansion) appends exactly one native-style hint to the
 *   first rendered line (the header) of every tool that has a contributed
 *   expanded renderer:
 *
 *       (ctrl+o to expand)      while collapsed
 *       (ctrl+o to collapse)    while expanded
 *
 *   The key is never hard-coded. It is the host's currently configured
 *   binding for `app.tools.expand` (Ctrl+O by default), resolved at render
 *   time through Pi's own `keyHint()`/`keyText()` helpers (verified in pi
 *   0.85.1: dist/modes/interactive/components/keybinding-hints.js, which
 *   reads the live KeybindingsManager so user keybindings.json overrides are
 *   honored). The styling matches the native tool rows: muted parentheses
 *   around the host-styled hint (dim key, muted description), exactly as pi's
 *   bash-execution and tool-execution components emit it.
 *
 * - Width-safe, and never silently hintless: the hint is appended to the
 *   header when the resulting line still fits the render width, measured with
 *   the host's own pi-tui `visibleWidth` when loadable. When the hinted header
 *   would exceed the width, the hint is instead rendered on its own wrapped
 *   row(s) below the family's lines — the header and body are never truncated
 *   or dropped to make room. Oversized hint tokens (long configured bindings,
 *   degenerate widths) are hard-wrapped with the host's own ANSI-aware
 *   `wrapTextWithAnsi`, so EVERY hint row fits the render width and the
 *   affordance stays visible at every width without tripping a host width
 *   guard.
 *
 * - Interaction stays fully native: this module registers no key handler and
 *   owns no toggle state. Keyboard expansion is the host's global
 *   `app.tools.expand` binding, which flips every row's `options.expanded`
 *   together (verified in pi 0.85.1 interactive-mode setToolsExpanded). In
 *   fullscreen mode the host wraps each rendered tool slot in its own
 *   MouseRegion, so clicking one card toggles only that card (verified in
 *   tool-execution.js createResultRegion + pi-tui MouseRegion, which runs
 *   the region handler only when the wrapped component did not handle the
 *   click itself). The wrapper therefore forwards any mouse/input handlers
 *   the inner component defines and otherwise leaves events unhandled so the
 *   host's per-card region receives them. Regular mode remains keyboard-only
 *   because the host does not capture mouse input there — nothing to add.
 *
 * - Expansion is presentation only: no I/O, no fetching, no re-execution on
 *   toggle. The raw result and the native render context (including `args`)
 *   are forwarded unchanged so family detail views can reuse the recorded
 *   call arguments instead of duplicating them.
 *
 * Outside a Pi host (unit tests, tooling) the peer packages are not
 * resolvable and no hint is rendered: the wrapper degrades to the inner
 * component byte-for-byte instead of guessing a key. Tests inject a fake
 * host through {@link setNativeExpansionHost}.
 */

/** The keybinding id Pi binds tool-output expansion to (default Ctrl+O). */
export const EXPANSION_KEYBINDING_ID = "app.tools.expand";

/** The native hint surface this module consumes from the running host. */
export interface NativeExpansionHost {
  /** Host `keyHint(keybinding, description)`: styled key plus description. */
  keyHint?: (keybinding: string, description: string) => string;
  /** Host `keyText(keybinding)`: raw configured key text, unstyled. */
  keyText?: (keybinding: string) => string;
  /** Host pi-tui `visibleWidth(line)`: terminal-cell width of a line. */
  visibleWidth?: (line: string) => number;
  /**
   * Host pi-tui `wrapTextWithAnsi(text, width)`: the host's own ANSI-aware
   * wrapper. Used to hard-wrap hint tokens that exceed the render width (long
   * configured bindings, degenerate widths) so every fallback row fits.
   */
  wrapTextWithAnsi?: (text: string, width: number) => string[];
}

let hostOverride: NativeExpansionHost | undefined;
let loadedHost: NativeExpansionHost | undefined;
let hostLoadAttempted = false;

/** Test seam: inject a fake native host, or clear the override with undefined. */
export function setNativeExpansionHost(host: NativeExpansionHost | undefined): void {
  hostOverride = host;
}

function resolveNativeHost(): NativeExpansionHost | undefined {
  if (hostOverride !== undefined) return hostOverride;
  if (!hostLoadAttempted) {
    loadedHost = loadNativeExpansionHost();
    hostLoadAttempted = true;
  }
  return loadedHost;
}

function loadNativeExpansionHost(): NativeExpansionHost | undefined {
  try {
    // Loaded inside Pi: the extension loader aliases @earendil-works/pi-coding-agent
    // and @earendil-works/pi-tui to the running host's modules (verified in pi
    // 0.85.1, dist/core/extensions/loader.js). Never a hard import: both are
    // host-provided peers, not dependencies of this extension.
    const agent = require("@earendil-works/pi-coding-agent") as {
      keyHint?: (keybinding: string, description: string) => string;
      keyText?: (keybinding: string) => string;
    };
    if (typeof agent?.keyHint !== "function") return undefined;
    let visibleWidth: ((line: string) => number) | undefined;
    let wrapTextWithAnsi: ((text: string, width: number) => string[]) | undefined;
    try {
      const tui = require("@earendil-works/pi-tui") as {
        visibleWidth?: (line: string) => number;
        wrapTextWithAnsi?: (text: string, width: number) => string[];
      };
      if (typeof tui?.visibleWidth === "function") visibleWidth = tui.visibleWidth;
      if (typeof tui?.wrapTextWithAnsi === "function") wrapTextWithAnsi = tui.wrapTextWithAnsi;
    } catch {
      // A host without the pi-tui alias degrades to the conservative helpers below.
    }
    return { keyHint: agent.keyHint, keyText: agent.keyText, visibleWidth, wrapTextWithAnsi };
  } catch {
    // Outside Pi (unit tests, tooling) the peer is simply not resolvable.
    return undefined;
  }
}

const SGR_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Terminal-cell width of one line, measured with the host's own pi-tui
 * `visibleWidth` when loadable and falling back to a conservative count
 * otherwise. A failing host measurement degrades to the fallback instead of
 * breaking the render.
 */
export function visibleLineWidth(line: string): number {
  const host = resolveNativeHost();
  if (host && typeof host.visibleWidth === "function") {
    try {
      const cells = host.visibleWidth(line);
      if (typeof cells === "number" && Number.isFinite(cells) && cells >= 0) return cells;
    } catch {
      // Fall through to the conservative count.
    }
  }
  return fallbackVisibleWidth(line);
}

/**
 * Degraded width count used only when the host's own `visibleWidth` is not
 * resolvable (never inside a real Pi session, where the loader aliases
 * pi-tui). It deliberately over-counts every non-ASCII code point as two
 * cells so an uncertain guess omits the hint rather than emit an over-width
 * line that would trip the host's width guard.
 */
function fallbackVisibleWidth(line: string): number {
  let cells = 0;
  for (const ch of line.replace(SGR_RE, "").replace(OSC_RE, "")) {
    cells += ch.charCodeAt(0) >= 0x80 ? 2 : 1;
  }
  return cells;
}

/**
 * The styled native expansion hint for one toggle state, or `undefined` when
 * it cannot be produced honestly (host unavailable, binding unresolved, host
 * error). It never returns a partial guess such as "( to expand)".
 */
export function expansionHint(
  expanded: boolean,
  fg?: (color: string, text: string) => string,
): string | undefined {
  const host = resolveNativeHost();
  if (!host || typeof host.keyHint !== "function") return undefined;
  if (typeof host.keyText === "function") {
    let binding: unknown;
    try {
      binding = host.keyText(EXPANSION_KEYBINDING_ID);
    } catch {
      return undefined;
    }
    // An empty resolution means the binding is unconfigured or unresolved:
    // a keyless "( to expand)" would mislead, so no hint at all.
    if (typeof binding !== "string" || binding.trim().length === 0) return undefined;
  }
  let styledKey: unknown;
  try {
    styledKey = host.keyHint(EXPANSION_KEYBINDING_ID, expanded ? "to collapse" : "to expand");
  } catch {
    // e.g. host theme not initialized outside interactive mode: no hint
    // rather than a broken row.
    return undefined;
  }
  if (typeof styledKey !== "string" || styledKey.length === 0) return undefined;
  let open = "(";
  let close = ")";
  if (typeof fg === "function") {
    try {
      // The theme's fg() may depend on its receiver or throw for unknown
      // colors: a broken style degrades to plain parens, never a crash.
      open = fg("muted", "(");
      close = fg("muted", ")");
    } catch {
      return undefined;
    }
  }
  if (typeof open !== "string" || typeof close !== "string") return undefined;
  return `${open}${styledKey}${close}`;
}

/** Structural component shape the wrapper can wrap (Pi tool renderers). */
export interface ToolResultViewComponent {
  render(width: number): string[];
  invalidate?(): void;
  handleInput?(data: string): void;
  handleMouse?(event: unknown): unknown;
  wantsKeyRelease?: boolean;
}

/**
 * Wraps a family renderer's component so its first rendered line (the header)
 * carries exactly one native-style expansion hint, appended when it fits the
 * render width. When the hinted header would exceed the width, the hint moves
 * to its own wrapped row(s) so the affordance remains visible without
 * truncating or dropping any family line. Returns the inner component
 * unchanged when no hint can be produced (outside a Pi host, unresolved
 * binding), so presentation degrades byte-for-byte to the family's own output.
 *
 * The wrapper owns no state and registers no handlers: `invalidate` is
 * forwarded, optional `handleMouse`/`handleInput`/`wantsKeyRelease` are
 * forwarded verbatim, and any event the inner does not handle falls through
 * to the host's per-card MouseRegion (fullscreen click toggle) or the host's
 * global `app.tools.expand` keybinding.
 */
export function withExpansionHint<T extends ToolResultViewComponent>(
  inner: T,
  expanded: boolean,
  fg?: (color: string, text: string) => string,
): T {
  const hint = expansionHint(expanded, fg);
  if (hint === undefined) return inner;
  const hinted: ToolResultViewComponent = {
    render(width: number): string[] {
      const lines = inner.render(width);
      if (lines.length === 0) return lines;
      const header = lines[0];
      // Nothing to anchor the hint to (empty or escape-only first line).
      if (typeof header !== "string" || visibleLineWidth(header) === 0) return lines;
      // Width-safe inline form: append when the hinted header still fits.
      const candidate = `${header} ${hint}`;
      if (visibleLineWidth(candidate) <= Math.max(0, width)) {
        const next = lines.slice();
        next[0] = candidate;
        return next;
      }
      // The header cannot carry the hint without exceeding the width. Never
      // truncate or drop family content to make room: render the hint on its
      // own wrapped row(s) instead, so the affordance stays visible at every
      // width ("all views need a visible hint") and no second toggle
      // machinery is implied.
      return [...lines, ...wrappedHintRows(hint, Math.max(0, width))];
    },
    invalidate() {
      inner.invalidate?.();
    },
  };
  // Forward the optional interaction surface so the host's per-card
  // MouseRegion (and any family-owned behavior) keeps working unchanged. When
  // the inner defines none, the wrapper defines none: clicks fall through to
  // the host's region, which toggles that one card.
  if (typeof inner.handleMouse === "function") {
    hinted.handleMouse = (event: unknown) => inner.handleMouse!(event);
  }
  if (typeof inner.handleInput === "function") {
    hinted.handleInput = (data: string) => inner.handleInput!(data);
  }
  if (inner.wantsKeyRelease === true) {
    hinted.wantsKeyRelease = true;
  }
  return hinted as T;
}

/**
 * Lays the hint out on one or more rows that each fit `width`, measured with
 * the host's own `visibleLineWidth` (no parallel width algorithm).
 *
 * Space-separated tokens (the muted paren, the host-styled key, the
 * description words) are kept whole and packed greedily. A token wider than
 * the width itself — a long configured binding or a degenerate width — is
 * hard-wrapped with the host's own ANSI-aware `wrapTextWithAnsi` (pi-tui),
 * splitting the binding and description into width-fitting pieces with styling
 * carried across the split. Every emitted row fits the width, so the fallback
 * can never trip a host width guard; only a width of zero or less (no cell to
 * wrap into) passes the hint through on a single row.
 */
function wrappedHintRows(hint: string, width: number): string[] {
  if (width <= 0) return [hint];
  const tokens = hint.split(" ").filter((token) => token.length > 0);
  if (tokens.length === 0) return [hint];
  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const token of tokens) {
    const tokenWidth = visibleLineWidth(token);
    if (tokenWidth <= width) {
      if (current.length > 0 && currentWidth + 1 + tokenWidth <= width) {
        current += ` ${token}`;
        currentWidth += 1 + tokenWidth;
      } else {
        if (current.length > 0) rows.push(current);
        current = token;
        currentWidth = tokenWidth;
      }
      continue;
    }
    // Oversized token: hard-wrap it with the host's ANSI-aware wrapper and
    // keep only its last piece open so following tokens still pack onto it.
    if (current.length > 0) {
      rows.push(current);
      current = "";
      currentWidth = 0;
    }
    const pieces = hardWrapHintToken(token, width);
    for (const piece of pieces.slice(0, -1)) rows.push(piece);
    const last = pieces[pieces.length - 1] ?? "";
    current = last;
    currentWidth = visibleLineWidth(last);
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

/**
 * Splits one hint token that exceeds `width` into width-fitting pieces using
 * the host's own ANSI-aware `wrapTextWithAnsi` when resolvable (styling is
 * tracked and re-applied across the split by the host itself). Without the
 * host function, a conservative cell-measured splitter degrades safely rather
 * than emitting an over-wide row.
 */
function hardWrapHintToken(token: string, width: number): string[] {
  const host = resolveNativeHost();
  if (typeof host?.wrapTextWithAnsi === "function") {
    try {
      const pieces = host.wrapTextWithAnsi(token, width);
      if (Array.isArray(pieces) && pieces.length > 0 && pieces.every((piece) => typeof piece === "string")) {
        return pieces;
      }
    } catch {
      // Fall through to the degraded splitter.
    }
  }
  return fallbackHardWrapToken(token, width);
}

const ANSI_PART_RE = /\x1b\[[0-?]*[ -/]*[@-~]|[\s\S]/gu;

/** Degraded splitter used only when the host's own wrapper is unavailable. */
function fallbackHardWrapToken(token: string, width: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const part of token.match(ANSI_PART_RE) ?? [token]) {
    if (part.startsWith("\x1b")) {
      current += part; // zero-width styling attaches to the current piece
      continue;
    }
    const candidate = current + part;
    if (current.length > 0 && visibleLineWidth(candidate) > width) {
      pieces.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces.length > 0 ? pieces : [token];
}
