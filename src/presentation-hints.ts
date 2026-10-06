/**
 * Shared native expansion hints for presentation renderers with a contributed
 * expanded view (#92 phase 1: the generic core extracted from the #93
 * tool-result rollout so tool-result and custom-message renderers consume the
 * same mechanism).
 *
 * Integration contract (shared by every presentation renderer):
 *
 * - Renderers produce their header/body WITHOUT an expansion hint of
 *   their own. The shared wrapper installed by the shared expansion core
 *   (`expandablePresentation`, ./presentation-expansion) appends exactly one
 *   native-style hint to the first rendered line (the header) of every row
 *   that has a contributed expanded renderer:
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
 *   fullscreen mode the host wraps each rendered row slot in its own
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
 * Peer loading: the two host packages are resolved with the established
 * shared host-relative loader (src/host-peer-loader.ts) — soft `require`
 * first (works under the extension loader's package aliases), then, for a
 * compiled extension entry (pi >= 0.86 loads pre-compiled CommonJS by native
 * import and `require()` no longer sees the aliases), resolution inside the
 * running Pi's own install. The load is asynchronous and happens at session
 * setup — src/index.ts awaits it before the first render — never at render
 * time: rendering only reads the already-resolved peer record and degrades
 * to the byte-for-byte native fallback when it is genuinely unavailable.
 * Tests inject a fake host through {@link setNativeExpansionHost}.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadHostPeerModule, resolveHostPeerPackageRoot } from "./host-peer-loader";

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
let hostEntryProvider: (() => string | undefined) | undefined;
/** Populated only by a completed warm; rendering never loads anything itself. */
let warmedHost: NativeExpansionHost | undefined;
let warmPromise: Promise<NativeExpansionHost | undefined> | undefined;

/** Test seam: inject a fake native host, or clear the override with undefined. */
export function setNativeExpansionHost(host: NativeExpansionHost | undefined): void {
  hostOverride = host;
}

/**
 * Test seam: replace (or clear) discovery of the running Pi entry file. The
 * replacement still goes through the same realpath/package.json validation.
 */
export function setNativeExpansionHostEntryProvider(
  provider: (() => string | undefined) | undefined,
): void {
  hostEntryProvider = provider;
  warmPromise = undefined;
  warmedHost = undefined;
}

/**
 * Resolves the running host's peer packages through the established shared
 * loader (soft require first — the extension loader's package alias path —
 * then host-relative resolution for a compiled entry) and remembers the
 * resolved record for every later synchronous render. Memoized per process;
 * a resolution that finds nothing is also final until the entry provider or
 * override seam changes. Returns the resolved host (possibly undefined).
 */
export function warmNativeExpansionHost(): Promise<NativeExpansionHost | undefined> {
  if (hostOverride !== undefined) return Promise.resolve(hostOverride);
  warmPromise ??= loadSharedNativeExpansionHost();
  return warmPromise;
}

const PI_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_TUI_PACKAGE_NAME = "@earendil-works/pi-tui";

async function loadSharedNativeExpansionHost(): Promise<NativeExpansionHost | undefined> {
  // Loaded inside Pi: the extension loader aliases @earendil-works/pi-coding-agent
  // and @earendil-works/pi-tui to the running host's modules (verified in pi
  // 0.85.1, dist/core/extensions/loader.js) for the soft-require step, and the
  // shared loader's host-relative step covers a compiled entry (pi >= 0.86).
  // Never a hard import: both are host-provided peers, not dependencies of
  // this extension.
  const agent = await loadHostPeerModule(PI_AGENT_PACKAGE_NAME, {
    entryProvider: hostEntryProvider,
    packageMainFallback: true,
  });
  const agentKeyHint = hostFnOf<(keybinding: string, description: string) => string>(agent, "keyHint");
  if (!agentKeyHint) {
    warmedHost = undefined;
    return undefined;
  }
  const agentKeyText = hostFnOf<(keybinding: string) => string>(agent, "keyText");
  const host: NativeExpansionHost = {
    keyHint: (keybinding, description) => agentKeyHint(keybinding, description),
    keyText: agentKeyText ? (keybinding) => agentKeyText(keybinding) : undefined,
  };
  try {
    const tui = await loadHostPeerModule(PI_TUI_PACKAGE_NAME, { entryProvider: hostEntryProvider });
    await configurePeerKeybindingsGlobal(tui);
    const visibleWidth = hostFnOf<(line: string) => number>(tui, "visibleWidth");
    const wrapTextWithAnsi = hostFnOf<(text: string, width: number) => string[]>(tui, "wrapTextWithAnsi");
    if (visibleWidth && wrapTextWithAnsi) {
      host.visibleWidth = (line) => visibleWidth(line);
      host.wrapTextWithAnsi = (text, width) => wrapTextWithAnsi(text, width);
    }
  } catch {
    // A host without the pi-tui peer degrades to the conservative helpers below.
  }
  warmedHost = host;
  return host;
}

function resolveNativeHost(): NativeExpansionHost | undefined {
  if (hostOverride !== undefined) return hostOverride;
  return warmedHost;
}

/** The running host's agent keybinding config (dist-relative, no absolute path). */
const AGENT_KEYBINDINGS_SUBPATH = "./dist/core/keybindings.js";

// tsc rewrites `await import(x)` in CommonJS output to require(x), which
// cannot load ESM on Node 20 — compile a native dynamic import the
// transpiler leaves untouched (same technique as ./host-peer-loader).
const nativeDynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The running host's agent package keybinding definitions module (the class
 * that carries the app-level defaults, including `app.tools.expand`, plus the
 * user's keybindings.json overrides), loaded from the resolved install root
 * without any absolute path. Returns undefined when unresolvable.
 */
async function loadAgentKeybindingDefinitions(
  entryProvider: (() => string | undefined) | undefined,
): Promise<Record<string, unknown> | undefined> {
  const root = resolveHostPeerPackageRoot(PI_AGENT_PACKAGE_NAME, {
    entryProvider,
    packageMainFallback: true,
  });
  if (!root) return undefined;
  let resolved: string;
  try {
    resolved = createRequire(join(root, "package.json")).resolve(AGENT_KEYBINDINGS_SUBPATH);
  } catch {
    return undefined;
  }
  try {
    const mod = require(resolved) as unknown;
    return isRecord(mod) ? mod : undefined;
  } catch {
    // Node < 22.12 (ERR_REQUIRE_ESM): load the same file natively instead.
  }
  try {
    const mod = await nativeDynamicImport(pathToFileURL(resolved).href);
    return isRecord(mod) ? mod : undefined;
  } catch {
    return undefined;
  }
}

/** The configured keys for the expansion binding from a manager, if any. */
function expansionBindingKeys(manager: unknown): string[] | undefined {
  if (!isRecord(manager) || typeof manager.getKeys !== "function") return undefined;
  try {
    const keys = manager.getKeys(EXPANSION_KEYBINDING_ID);
    if (Array.isArray(keys) && keys.every((key) => typeof key === "string")) {
      return keys as string[];
    }
  } catch {
    // an unusable manager: treat as unconfigured
  }
  return undefined;
}

/**
 * Gives the separately evaluated pi-tui record the running host's configured
 * keybindings: the interactive mode installs its manager on the RUNNING
 * (bundled) pi-tui copy, while a compiled extension resolves its own pi-tui
 * record whose global starts empty (or lazily holds a TUI-only default without
 * app-level ids) — so the record's `keyText("app.tools.expand")` resolution
 * would otherwise be empty. When this record's current global cannot name the
 * expansion binding yet, install the host's own configured manager — the agent
 * package's `KeybindingsManager` (built-in app defaults plus the user's
 * keybindings.json overrides, the same file the running mode reads). The
 * running session's own manager and the bundled copy are never touched, and a
 * resolution failure leaves the honest no-hint degradation (binding
 * unresolved) rather than guessing a key.
 */
async function configurePeerKeybindingsGlobal(tui: Record<string, unknown> | undefined): Promise<void> {
  try {
    const getKeybindings = hostFnOf<() => unknown>(tui, "getKeybindings");
    const setKeybindings = hostFnOf<(manager: unknown) => void>(tui, "setKeybindings");
    if (!getKeybindings || !setKeybindings) return;
    const currentKeys = expansionBindingKeys(safeCall(getKeybindings));
    if (currentKeys !== undefined && currentKeys.length > 0) return; // already configured
    const agent = await loadAgentKeybindingDefinitions(hostEntryProvider);
    const agentManagerCtor = hostFnOf<new (...args: never[]) => unknown>(agent, "KeybindingsManager");
    if (!agentManagerCtor) return;
    // The configured manager comes from the class's own static factory
    // (`KeybindingsManager.create()`, pi 1.0.2 and 1.0.4): built-in defaults
    // plus the user's keybindings.json overrides, so a remapped expansion
    // binding resolves exactly as the host renders it. Called with the class
    // as receiver. A configured initialization failure installs nothing — a
    // defaults-only manager would silently show a wrong hint for a remapped
    // binding — and the honest no-hint degradation applies instead.
    const staticCreate = typeof (agentManagerCtor as unknown as Record<string, unknown>).create === "function"
      ? (agentManagerCtor as unknown as { create: (agentDir?: string) => unknown }).create
      : undefined;
    let managerValue: unknown;
    if (staticCreate) {
      try {
        managerValue = staticCreate.call(agentManagerCtor);
      } catch {
        return;
      }
    } else {
      // Unknown future layout without the static factory: the class's own
      // constructor still installs its same built-in definitions.
      managerValue = new agentManagerCtor();
    }
    if (isRecord(managerValue)) setKeybindings(managerValue);
  } catch {
    // Any failure leaves the honest no-hint degradation (binding unresolved).
  }
}

function safeCall<T>(fn: ((...args: never[]) => T) | undefined): T | undefined {
  if (typeof fn !== "function") return undefined;
  try {
    return (fn as () => T)();
  } catch {
    return undefined;
  }
}

/** A structurally present callable member of one loaded peer record. */
function hostFnOf<T>(record: Record<string, unknown> | undefined, name: string): T | undefined {
  return typeof record?.[name] === "function" ? record[name] as T : undefined;
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

/** Structural component shape the wrapper can wrap (host render slots). */
export interface PresentationViewComponent {
  render(width: number): string[];
  invalidate?(): void;
  handleInput?(data: string): void;
  handleMouse?(event: unknown): unknown;
  wantsKeyRelease?: boolean;
}

/**
 * Wraps a renderer's component so its first rendered line (the header)
 * carries exactly one native-style expansion hint, appended when it fits the
 * render width. When the hinted header would exceed the width, the hint moves
 * to its own wrapped row(s) so the affordance remains visible without
 * truncating or dropping any renderer line. Returns the inner component
 * unchanged when no hint can be produced (outside a Pi host, unresolved
 * binding), so presentation degrades byte-for-byte to the renderer's own
 * output.
 *
 * The wrapper owns no state and registers no handlers: `invalidate` is
 * forwarded, optional `handleMouse`/`handleInput`/`wantsKeyRelease` are
 * forwarded verbatim, and any event the inner does not handle falls through
 * to the host's per-card MouseRegion (fullscreen click toggle) or the host's
 * global `app.tools.expand` keybinding.
 */
export function withExpansionHint<T extends PresentationViewComponent>(
  inner: T,
  expanded: boolean,
  fg?: (color: string, text: string) => string,
): T {
  const hint = expansionHint(expanded, fg);
  if (hint === undefined) return inner;
  const hinted: PresentationViewComponent = {
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
      // truncate or drop renderer content to make room: render the hint on its
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
