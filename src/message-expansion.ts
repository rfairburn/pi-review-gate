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
 *   promised where it cannot be produced honestly.
 * - The single native header hint is added by the shared core (the host's
 *   configured `app.tools.expand` binding); family renderers emit no hint of
 *   their own. No competing key handler is registered and nothing is fetched,
 *   rerun, or read from disk on toggle.
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
  type PresentationRenderer,
} from "./presentation-expansion";
import { loadHostPeerModule } from "./host-peer-loader";
import { visibleTerminalText } from "./tool-result-text";
import { BACKGROUND_TASK_STATES } from "./execution/task-state";

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

interface PiTuiHost {
  wrapTextWithAnsi?: (text: string, width: number) => string[];
  MouseRegion?: new (child: MessageComponent, handler: (event: unknown) => unknown) => MessageComponent;
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
  warmedTuiHost = host;
  return host;
}

function resolveTui(): PiTuiHost | undefined {
  if (tuiOverride !== undefined) return tuiOverride;
  return warmedTuiHost;
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
 * The theme's fg()/bold() with the receiver preserved: the host Theme.fg reads
 * instance state (token tables), so a standalone call throws. Unknown colors or
 * a broken receiver degrade to plain text rather than breaking the render.
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
 * - The returned component is wrapped in pi-tui's MouseRegion when available so
 *   a fullscreen left click toggles that one message (handled, no neighbor
 *   effect). When pi-tui's wrapTextWithAnsi is unavailable the renderer returns
 *   undefined (full native fallback) so no over-width custom output is emitted;
 *   without the MouseRegion peer the full accessible text still renders and the
 *   keyboard global binding keeps working.
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
    { fallbackOptions: () => ({ expanded: false, outputPad: 0 }) },
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

    const Region = resolveTui()?.MouseRegion;
    if (typeof Region !== "function") return inner; // keyboard-only degradation
    return new Region(inner, (event: unknown): unknown => {
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
    // visible notation instead of being executed or deleted.
    return wrapLines(visibleTerminalText(text), width);
  });
}

/**
 * The honest fallback for unknown/historical/malformed content: the FULL
 * retained content (no arbitrary preview, no compaction promise). The expanded
 * view carries the same complete text.
 */
function collapsedFallback(message: unknown, theme: unknown): MessageComponent {
  return renderFullMessageContent(message, {}, theme);
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
 * actionable detail from the curated diagnostic. Unrecognized content falls back
 * to the full retained text rather than a misleading summary.
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
  // an empty `diagnostic: {}` must not bypass the full-content fallback.
  const diagnostic = isRecord(details.diagnostic) && hasDiagnosticContent(details.diagnostic)
    ? details.diagnostic : undefined;

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
      rendererTheme.fg("accent", rendererTheme.bold("[subtask]")),
      title ? visibleTerminalText(title) : "[title not retained]",
      stateInfo
        ? `· ${rendererTheme.fg(stateInfo.color, stateInfo.label)}`
        : (rawState ? `· ${rendererTheme.fg("muted", visibleTerminalText(rawState.toUpperCase()))}` : ""),
      count ? `· ${count}` : "",
    ].filter((part) => part.length > 0);
    const lines = [headerParts.join(" ")];

    if (reportLine) lines.push(visibleTerminalText(reportLine.trim()));
    else if (landedLine) lines.push(visibleTerminalText(landedLine.trim()));

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
      if (notice && notice !== error) lines.push(visibleTerminalText(notice));
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
      rendererTheme.fg("accent", rendererTheme.bold("[bg-shell]")),
      visibleTerminalText(label),
      rendererTheme.fg("muted", `(${visibleTerminalText(id)})`),
      `· ${visibleTerminalText(reason)}`,
      exitCode !== undefined
        ? rendererTheme.fg(Number(exitCode) === 0 ? "success" : "error", `· exit ${exitCode}`)
        : "",
    ].filter((part) => part.length > 0);
    const lines = [headerParts.join(" ")];
    if (command) lines.push(rendererTheme.fg("muted", `command: ${visibleTerminalText(command)}`));
    for (const line of excerpt) {
      lines.push(visibleTerminalText(line));
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
      rendererTheme.fg("accent", rendererTheme.bold("[subtask-watch]")) + " "
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
      rendererTheme.fg("accent", rendererTheme.bold("[scheduled]")) + " "
      + rendererTheme.fg(outcome.color, outcome.label) + " · "
      + visibleTerminalText(head),
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
      rendererTheme.fg("accent", rendererTheme.bold("[scheduled-turn]")) + " "
      + visibleTerminalText(head),
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
