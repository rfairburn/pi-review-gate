/**
 * Native result rendering for the interactive Browser* tool family (#93).
 *
 * The shared `expandableResult` wrapper owns the expansion lifecycle.  This
 * module only presents the result that the browser tool already returned:
 * collapsed cards are concise operation/outcome summaries and expanded cards
 * show the complete recorded request and meaningful retained response.  A
 * renderer never calls the browser, reads a report, or performs any other I/O
 * when a row is expanded.
 *
 * Browser page data remains untrusted evidence.  The browser manager's
 * upstream privacy, safety, and retention boundaries remain authoritative;
 * this renderer does not expose fields that were not returned by that manager.
 * Conversely, a value supplied by the model is read from the native
 * renderResult context's `args` for the human detail view without a second
 * masking, redaction, summarisation, or truncation pass.  This is especially
 * important for BrowserFill, BrowserType, and BrowserSelect: their execution
 * result intentionally does not echo the submitted value, while the original
 * model call arguments are still available to the renderer.
 *
 * Terminal control bytes in recorded text are display-encoded as visible
 * escape notation, never deleted or executed (see ../tool-result-text).
 */
import { expandableResult, type ToolResultRenderCallback } from "../tool-result-expansion";
import { visibleTerminalText } from "../tool-result-text";

/**
 * Kept as compatibility exports for callers that imported the old renderer
 * bounds.  They are no longer used for expanded rendering: the old 96-line
 * and 16,000-character secondary display caps were presentation loss, not
 * browser retention limits.
 */
export const BROWSER_RENDER_MAX_LINES = 96;
export const BROWSER_RENDER_MAX_CHARS = 16_000;

/** Every interactive browser tool owned by this renderer; acquisition tools are intentionally absent. */
export const INTERACTIVE_BROWSER_TOOL_NAMES = [
  "BrowserOpen",
  "BrowserNavigate",
  "BrowserSnapshot",
  "BrowserConsole",
  "BrowserNetwork",
  "BrowserInspect",
  "BrowserScreenshot",
  "BrowserScroll",
  "BrowserHover",
  "BrowserClick",
  "BrowserFill",
  "BrowserType",
  "BrowserSelect",
  "BrowserPress",
  "BrowserWait",
  "BrowserHistory",
  "BrowserTabs",
  "BrowserClose",
] as const;

export type BrowserRendererTone =
  | "accent"
  | "dim"
  | "error"
  | "muted"
  | "success"
  | "toolOutput"
  | "warning";

/** The small part of Pi's Theme contract used by this renderer. */
export interface BrowserRendererTheme {
  bold(text: string): string;
  /** The shared expansion contract deliberately exposes a string color key. */
  fg(color: string, text: string): string;
}

/** The native TUI Component shape, kept structural so the extension has no Pi runtime dependency. */
export interface BrowserRendererComponent {
  render(width: number): string[];
  invalidate(): void;
}

export interface BrowserTextContent {
  type: "text";
  text: string;
}

export interface BrowserImageContent {
  type: "image";
  /** Intentionally not read by this renderer. Pi owns native image presentation. */
  data: string;
  mimeType: string;
}

export type BrowserResultContent = BrowserTextContent | BrowserImageContent;

/** Structural equivalent of Pi's AgentToolResult for the native renderer callback. */
export interface BrowserToolResult {
  content: readonly BrowserResultContent[];
  details?: unknown;
  isError?: boolean;
}

export interface BrowserRenderResultOptions {
  expanded: boolean;
  isPartial: boolean;
}

/** Native context fields used by interactive Browser rendering. */
export interface BrowserRendererContext {
  /** Original parsed tool-call arguments supplied by the native host. */
  readonly args?: unknown;
  readonly showImages?: boolean;
  /** Optional host metadata used only to disambiguate empty diagnostic packets. */
  readonly toolName?: string;
  readonly name?: string;
  readonly toolCallName?: string;
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

export type BrowserResultRenderer = (
  result: unknown,
  options: BrowserRenderResultOptions,
  theme: BrowserRendererTheme,
  context?: unknown,
) => BrowserRendererComponent;

type RenderLine = {
  text: string;
  tone?: BrowserRendererTone;
};

type RecordValue = Record<string, unknown>;

type BrowserView =
  | "open"
  | "navigate"
  | "snapshot"
  | "console"
  | "network"
  | "inspect"
  | "screenshot"
  | "scroll"
  | "hover"
  | "click"
  | "fill"
  | "type"
  | "select"
  | "press"
  | "wait"
  | "history"
  | "tabs"
  | "close"
  | "unknown";

/** Collapsed preview depth, matching Pi's native fallback preview bound. */
export const BROWSER_COLLAPSED_PREVIEW_LINES = 10;

/**
 * Collapsed browser cards contain an actionable summary, not the diagnostic
 * JSON that some browser tools return in their model-facing text.  The
 * summary is still bounded like a native tool row; detail rendering is not.
 */
export const renderBrowserCollapsedResult: BrowserResultRenderer = (rawResult, options, theme, context) => {
  const result = asBrowserToolResult(rawResult);
  const isError = result.isError === true || contextIsError(context);
  const response = options.isPartial || isError ? undefined : responseRecord(result);
  const args = originalArgs(context);
  const view = browserView(response, result, context);
  const tool = browserToolName(view, context);

  let lines: RenderLine[];
  if (options.isPartial) {
    lines = [
      browserHeader(tool, "running", "warning"),
      { text: "No completed browser result is retained yet.", tone: "dim" },
    ];
  } else if (isError) {
    const first = firstContentLine(result);
    lines = [
      browserHeader(tool, "failed", "error"),
      ...(first ? [{ text: first, tone: "error" as const }] : [{ text: "No retained error text.", tone: "dim" as const }]),
    ];
  } else if (response) {
    lines = collapsedResponse(view, response, result, args);
  } else {
    const first = firstContentLine(result);
    lines = [
      browserHeader(tool, first ? compact(first) : "no retained output"),
      ...(result.content.some((content) => content.type === "image") ? [{ text: "[native image]", tone: "muted" as const }] : []),
    ];
  }
  return createCollapsedComponent(lines, theme);
};

/**
 * Expanded browser detail rendering.  Unlike the old renderer, this function
 * deliberately has no logical-line, event-count, character, or per-line
 * display cap.  The only transformations are terminal-width wrapping and
 * visible display-encoding of non-printing control bytes; an upstream
 * `truncated`/`captureTruncated`/`omitted` field is shown as data, not
 * replaced with a renderer omission marker.
 */
export const renderBrowserExpandedResult: BrowserResultRenderer = (rawResult, options, theme, context) => {
  const result = asBrowserToolResult(rawResult);
  const args = originalArgs(context);
  const isError = result.isError === true || contextIsError(context);
  const response = options.isPartial || isError ? undefined : responseRecord(result);
  const view = browserView(response, result, context);
  const tool = browserToolName(view, context);
  let lines: RenderLine[];

  if (options.isPartial) {
    lines = [
      browserHeader(tool, ""),
      { text: "Browser operation is still running; retained output may be partial.", tone: "warning" },
    ];
    const partial = textContent(result);
    if (partial) {
      lines.push({ text: "Retained partial output (untrusted evidence):", tone: "muted" });
      lines.push(...textLines(partial));
    } else {
      lines.push({ text: "No retained browser output yet.", tone: "dim" });
    }
    const partialRequest = requestLinesForUnavailable(view, args);
    if (partialRequest.length > 0) {
      lines.push({ text: "Recorded request (completion not established):", tone: "muted" });
      lines.push(...partialRequest);
    }
  } else if (isError) {
    lines = [
      browserHeader(tool, ""),
      { text: "Browser result failed; no additional retained detail is available.", tone: "error" },
    ];
    const errorText = textContent(result);
    if (errorText) lines.push(...textLines(errorText, "error"));
    else lines.push({ text: "No bounded error text was returned.", tone: "dim" });
    const failedRequest = requestLinesForUnavailable(view, args);
    if (failedRequest.length > 0) {
      lines.push({ text: "Recorded request (dispatch not established):", tone: "muted" });
      lines.push(...failedRequest);
    }
  } else if (response) {
    lines = renderResponse(view, response, result, args, context);
    if (lines.length === 0) lines = genericResultLines(tool, result);
  } else {
    lines = genericResultLines(tool, result);
  }

  return createComponent(lines, theme);
};

/** The one shared registration wrapper installed on all 18 interactive tools. */
export const browserRenderResult = expandableResult(
  renderBrowserCollapsedResult,
  renderBrowserExpandedResult,
) as ToolResultRenderCallback;

// ---------------------------------------------------------------------------
// View selection and headers
// ---------------------------------------------------------------------------

/**
 * Family headers carry NO expansion hint of their own. The shared wrapper
 * installed by `expandableResult` (./tool-result-expansion → withExpansionHint
 * in ../tool-result-hints) appends exactly one native `(ctrl+o …)` hint with
 * the host's configured binding; emitting one here would duplicate it in a
 * real host. No hard-coded key fallback exists in this family.
 */
function browserHeader(
  tool: string,
  suffix: string,
  tone: BrowserRendererTone = "accent",
): RenderLine {
  return {
    text: `${tool}${suffix ? ` · ${suffix}` : ""}`,
    tone,
  };
}

function browserToolName(view: BrowserView, context: unknown): string {
  const explicit = toolNameFromContext(context);
  if (explicit) return explicit;
  switch (view) {
    case "open": return "BrowserOpen";
    case "navigate": return "BrowserNavigate";
    case "snapshot": return "BrowserSnapshot";
    case "console": return "BrowserConsole";
    case "network": return "BrowserNetwork";
    case "inspect": return "BrowserInspect";
    case "screenshot": return "BrowserScreenshot";
    case "scroll": return "BrowserScroll";
    case "hover": return "BrowserHover";
    case "click": return "BrowserClick";
    case "fill": return "BrowserFill";
    case "type": return "BrowserType";
    case "select": return "BrowserSelect";
    case "press": return "BrowserPress";
    case "wait": return "BrowserWait";
    case "history": return "BrowserHistory";
    case "tabs": return "BrowserTabs";
    case "close": return "BrowserClose";
    default: return "Browser";
  }
}

function toolNameFromContext(context: unknown): string | undefined {
  if (!isRecord(context)) return undefined;
  const candidates: unknown[] = [context.toolName, context.name, context.toolCallName];
  const tool = context.tool;
  if (isRecord(tool)) candidates.push(tool.name);
  for (const candidate of candidates) {
    if (typeof candidate === "string" && INTERACTIVE_BROWSER_TOOL_NAMES.includes(candidate as typeof INTERACTIVE_BROWSER_TOOL_NAMES[number])) {
      return candidate;
    }
  }
  return undefined;
}

function browserView(response: RecordValue | undefined, result: BrowserToolResult, context: unknown): BrowserView {
  const explicit = viewFromToolName(toolNameFromContext(context));
  if (explicit) return explicit;
  if (response) {
    if (typeof response.snapshot === "string") return "snapshot";
    if (isRecord(response.semantic)) return "inspect";
    if (typeof response.mode === "string" && typeof response.mimeType === "string") return "screenshot";
    if (Array.isArray(response.events) && isRecord(response.counts) && isRecord(response.cursor)) {
      return isNetworkEvent(response.events) || /\bnetwork\b/iu.test(textContent(result)) ? "network" : "console";
    }
    if (Array.isArray(response.entries) && typeof response.operation === "string") return "history";
    if (Array.isArray(response.tabs) && typeof response.operation === "string") return "tabs";
    if (response.closed === true || response.quiescent === true || response.broker !== undefined) return "close";
    if (isRecord(response.effects) && typeof response.operation === "string") {
      return viewFromOperation(response.operation);
    }
    if (typeof response.condition === "string") return "wait";
    if (typeof response.target === "string" && typeof response.amount === "number") return "scroll";
    if (isRecord(response.limits) && typeof response.status === "number") return "open";
    if (typeof response.status === "number" || response.navigationsRemaining !== undefined) return "navigate";
  }
  if (result.isError === true || contextIsError(context)) {
    const failedTool = toolNameFromErrorResult(result);
    const failedView = viewFromToolName(failedTool);
    if (failedView) return failedView;
  }
  const fromArgs = viewFromArgs(originalArgs(context));
  if (fromArgs) return fromArgs;
  if (result.content.some((content) => content.type === "image")) return "screenshot";
  return "unknown";
}

/**
 * Pi omits the top-level `isError` flag from the object passed to a custom
 * result renderer; the row context carries that flag instead.  Error text
 * produced by the browser registration has a fixed `Browser<Name> failed:`
 * prefix, so it is safe to recover the tool label for a failed result without
 * treating arbitrary page text as a tool-name signal.
 */
function toolNameFromErrorResult(result: BrowserToolResult): string | undefined {
  const first = firstContentLine(result);
  const match = /^(Browser(?:Open|Navigate|Snapshot|Console|Network|Inspect|Screenshot|Scroll|Hover|Click|Fill|Type|Select|Press|Wait|History|Tabs|Close)) failed:/u.exec(first);
  return match?.[1];
}

/** Best-effort classification for incomplete/error packets with no response.
 * Ambiguous handle-only calls are intentionally left unknown unless their
 * argument shape contains a distinguishing field; no action is inferred from
 * an opaque ref alone. */
function viewFromArgs(args: RecordValue | undefined): BrowserView | undefined {
  if (!args) return undefined;
  if (hasArg(args, "value")) return "fill";
  if (hasArg(args, "values")) return "select";
  if (hasArg(args, "key")) return "press";
  if (hasArg(args, "delayMs") || (hasArg(args, "text") && hasArg(args, "ref"))) return "type";
  if (hasArg(args, "condition")) return "wait";
  if (hasArg(args, "mode")) return "screenshot";
  if (hasArg(args, "maxChars")) return "snapshot";
  if (hasArg(args, "cursor") || hasArg(args, "maxEvents")) return undefined;
  if (hasArg(args, "maxEntries")) return "history";
  if (hasArg(args, "target") || hasArg(args, "amount")) return "scroll";
  if (hasArg(args, "operation") && (hasArg(args, "tab") || hasArg(args, "url"))) return "tabs";
  if (hasArg(args, "url")) return hasArg(args, "tab") ? "navigate" : "open";
  return undefined;
}

function viewFromToolName(name: string | undefined): BrowserView | undefined {
  if (!name) return undefined;
  const mapping: Record<string, BrowserView> = {
    BrowserOpen: "open",
    BrowserNavigate: "navigate",
    BrowserSnapshot: "snapshot",
    BrowserConsole: "console",
    BrowserNetwork: "network",
    BrowserInspect: "inspect",
    BrowserScreenshot: "screenshot",
    BrowserScroll: "scroll",
    BrowserHover: "hover",
    BrowserClick: "click",
    BrowserFill: "fill",
    BrowserType: "type",
    BrowserSelect: "select",
    BrowserPress: "press",
    BrowserWait: "wait",
    BrowserHistory: "history",
    BrowserTabs: "tabs",
    BrowserClose: "close",
  };
  return mapping[name];
}

function viewFromOperation(operation: string): BrowserView {
  switch (operation) {
    case "hover": return "hover";
    case "click": return "click";
    case "fill": return "fill";
    case "type": return "type";
    case "select": return "select";
    case "press": return "press";
    default: return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Collapsed summaries
// ---------------------------------------------------------------------------

function collapsedResponse(view: BrowserView, response: RecordValue, result: BrowserToolResult, args: RecordValue | undefined): RenderLine[] {
  switch (view) {
    case "open": {
      const title = compact(displayString(response.title));
      return [
        browserHeader("BrowserOpen", `opened${title !== "[empty]" ? ` · ${title}` : ""}`),
        { text: `  ${formatRequestedOrFallback(args, "url", response.url)}` },
      ];
    }
    case "navigate": {
      const title = compact(displayString(response.title));
      return [
        browserHeader("BrowserNavigate", `navigated${title !== "[empty]" ? ` · ${title}` : ""}`),
        { text: `  ${formatRequestedOrFallback(args, "url", response.url)}` },
      ];
    }
    case "snapshot": {
      const title = compact(displayString(response.title));
      const refs = numberOrUnknown(response.refs);
      const truncation = isRecord(response.truncation) ? response.truncation : undefined;
      return [
        browserHeader("BrowserSnapshot", `${title !== "[empty]" ? `${title} · ` : ""}${refs} refs`),
        { text: `  Acquisition truncated: ${yesNoOrUnknown(truncation?.truncated)}` },
      ];
    }
    case "console":
    case "network": {
      const events = Array.isArray(response.events) ? response.events : [];
      const failures = view === "network"
        ? events.filter((event) => isRecord(event) && (event.outcome === "failed" || event.outcome === "policy_blocked" || event.phase === "failure" || event.phase === "policy")).length
        : events.filter((event) => isRecord(event) && (event.kind === "page_error" || event.level === "error")).length;
      const eventLabel = events.length === 1 ? "event" : "events";
      const issueLabel = view === "network"
        ? `${failures} ${failures === 1 ? "failure" : "failures"}`
        : `${failures} ${failures === 1 ? "error" : "errors"}`;
      const cursor = isRecord(response.cursor) ? response.cursor : undefined;
      const counts = isRecord(response.counts) ? response.counts : undefined;
      return [
        browserHeader(view === "network" ? "BrowserNetwork" : "BrowserConsole", `${events.length} ${eventLabel} · ${issueLabel}`),
        { text: `  Next cursor: ${numberOrUnknown(cursor?.next)} · dropped: ${numberOrUnknown(counts?.dropped)}` },
      ];
    }
    case "inspect": {
      const semantic = isRecord(response.semantic) ? response.semantic : {};
      const name = compact(displayString(semantic.accessibleName));
      return [browserHeader("BrowserInspect", `${stringOrUnknown(response.ref)} · ${name !== "[empty]" ? name : stringOrUnknown(semantic.role)}`)];
    }
    case "screenshot": {
      const size = `${numberOrUnknown(response.width)}×${numberOrUnknown(response.height)}`;
      return [
        browserHeader("BrowserScreenshot", `${stringOrUnknown(response.mode)} · ${size}`),
        { text: "[native image]", tone: "muted" },
      ];
    }
    case "scroll": {
      const target = stringOrUnknown(valueOrInput(args, "target", response.target));
      const direction = valueOrInput(args, "direction", response.direction);
      const amount = valueOrInput(args, "amount", response.amount);
      const summary = `${target}${direction === undefined ? "" : ` ${formatValue(direction)}`} · ${formatValue(amount)} viewport fraction${formatValue(amount) === "1" ? "" : "s"}`;
      return [browserHeader("BrowserScroll", summary)];
    }
    case "hover": {
      const target = formatRequestedOrFallback(args, "ref", response.ref);
      return [browserHeader("BrowserHover", `${target} · ${stringOrUnknown(response.effect)}`)];
    }
    case "click": {
      const target = formatRequestedOrFallback(args, "ref", response.ref);
      const button = formatRequestedOrFallback(args, "button", response.button);
      return [browserHeader("BrowserClick", `${target} · ${button} · ${stringOrUnknown(response.effect)}`)];
    }
    case "fill":
      return [browserHeader("BrowserFill", `${formatRequestedOrFallback(args, "ref", response.ref)} · replaced field value${response.effect === "completed" ? "" : ` · ${stringOrUnknown(response.effect)}`}`)];
    case "type":
      return [browserHeader("BrowserType", `${formatRequestedOrFallback(args, "ref", response.ref)} · appended text${response.effect === "completed" ? "" : ` · ${stringOrUnknown(response.effect)}`}`)];
    case "select":
      return [browserHeader("BrowserSelect", `${formatRequestedOrFallback(args, "ref", response.ref)} · selection ${response.effect === "completed" ? "completed" : stringOrUnknown(response.effect)}`)];
    case "press": {
      const target = formatRequestedOrFallback(args, "ref", response.ref);
      const key = formatRequestedOrFallback(args, "key", response.key);
      return [browserHeader("BrowserPress", `${target} · ${key} · ${stringOrUnknown(response.effect)}`)];
    }
    case "wait": {
      const criterion = compactWaitCriterion(args, response);
      const elapsed = numberOrUnknown(response.elapsedMs);
      const outcome = response.satisfied === true ? `satisfied in ${elapsed}ms`
        : response.satisfied === false ? "not satisfied" : "outcome unavailable";
      return [browserHeader("BrowserWait", `${criterion} · ${outcome}`)];
    }
    case "history": {
      const title = compact(displayString(response.title));
      const suffix = `${stringOrUnknown(response.operation)}${title !== "[empty]" ? ` · ${title}` : ""}`;
      return [browserHeader("BrowserHistory", suffix), { text: `  ${stringOrUnknown(response.url)}` }];
    }
    case "tabs": {
      const operation = stringOrUnknown(response.operation);
      const target = valueOrInput(args, "tab", response.activeTab);
      const outcome = operation === "switch" ? `switched to ${formatValue(target)}`
        : operation === "open" ? `opened ${formatRequestedOrFallback(args, "url", response.openedTab)}`
          : operation === "close" ? `closed ${formatRequestedOrFallback(args, "tab", response.closedTab)}` : operation;
      return [browserHeader("BrowserTabs", `${outcome} · ${numberOrUnknown(response.tabsRemaining)} tabs`)];
    }
    case "close": {
      const state = response.closed === true && response.quiescent === true ? "closed and quiescent"
        : response.alreadyClosed === true ? "already closed" : "not confirmed";
      return [browserHeader("BrowserClose", `${formatRequestedOrFallback(args, "session", response.session)} · ${state}`)];
    }
    default: {
      const first = firstContentLine(result);
      return [browserHeader("Browser", first ? compact(first) : "no retained output")];
    }
  }
}

// ---------------------------------------------------------------------------
// Expanded response views
// ---------------------------------------------------------------------------

function renderResponse(
  view: BrowserView,
  response: RecordValue,
  result: BrowserToolResult,
  args: RecordValue | undefined,
  context: unknown,
): RenderLine[] {
  switch (view) {
    case "open": return renderOpen(response, args);
    case "navigate": return renderNavigate(response, args);
    case "snapshot": return renderSnapshot(response, args);
    case "console": return renderDiagnostics("console", response, args);
    case "network": return renderDiagnostics("network", response, args);
    case "inspect": return renderInspect(response, args);
    case "screenshot": return renderScreenshot(response, result, args, context);
    case "scroll": return renderScroll(response, args);
    case "hover": return renderInteraction("hover", response, args);
    case "click": return renderInteraction("click", response, args);
    case "fill": return renderInteraction("fill", response, args);
    case "type": return renderInteraction("type", response, args);
    case "select": return renderInteraction("select", response, args);
    case "press": return renderInteraction("press", response, args);
    case "wait": return renderWait(response, args);
    case "history": return renderHistory(response, args);
    case "tabs": return renderTabs(response, args);
    case "close": return renderClose(response, args);
    default: return [];
  }
}

function renderOpen(response: RecordValue, args: RecordValue | undefined): RenderLine[] {
  const lines: RenderLine[] = [
    browserHeader("BrowserOpen", ""),
    { text: `Requested URL: ${requestedValue(args, "url")}` },
    { text: `Final URL: ${stringOrUnknown(response.url)}` },
    { text: `HTTP status: ${numberOrUnknown(response.status)}` },
    { text: `Title: ${displayString(response.title)}` },
    { text: `Session: ${stringOrUnknown(response.session)}` },
    { text: `Tab: ${stringOrUnknown(response.tab)}` },
    { text: `Generation: ${stringOrUnknown(response.generation)}` },
    { text: "Page content is untrusted.", tone: "warning" },
  ];
  const limits = isRecord(response.limits) ? response.limits : undefined;
  if (limits) {
    lines.push({ text: `Bounds: tabs ${numberOrUnknown(limits.maxTabsPerSession)} · history ${numberOrUnknown(limits.maxHistoryEntries)} · snapshot ${numberOrUnknown(limits.maxSnapshotChars)} chars · wait ${numberOrUnknown(limits.maxWaitMs)}ms · screenshot ${numberOrUnknown(limits.maxScreenshotWidth)}×${numberOrUnknown(limits.maxScreenshotHeight)}.`, tone: "muted" });
  }
  return lines;
}

function renderNavigate(response: RecordValue, args: RecordValue | undefined): RenderLine[] {
  const lines: RenderLine[] = [
    browserHeader("BrowserNavigate", ""),
    { text: `Session: ${stringOrUnknown(response.session)}` },
    { text: `Tab: ${stringOrUnknown(response.tab)}` },
    { text: `Requested URL: ${requestedValue(args, "url")}` },
    { text: `Final URL: ${stringOrUnknown(response.url)}` },
    { text: `HTTP status: ${numberOrUnknown(response.status)}` },
    { text: `Title: ${displayString(response.title)}` },
    { text: `Generation: ${stringOrUnknown(response.generation)}` },
    { text: "Page content is untrusted.", tone: "warning" },
  ];
  if (response.navigationsRemaining !== undefined) lines.push({ text: `Navigations remaining: ${valueOrUnknown(response.navigationsRemaining)}` });
  return lines;
}

function renderSnapshot(response: RecordValue, args: RecordValue | undefined): RenderLine[] {
  const truncation = isRecord(response.truncation) ? response.truncation : undefined;
  const lines: RenderLine[] = [
    browserHeader("BrowserSnapshot", ""),
    { text: `Session: ${stringOrUnknown(response.session)}` },
    { text: `Tab: ${stringOrUnknown(response.tab)}` },
    { text: `Requested maximum: ${requestedValue(args, "maxChars", "characters")}` },
    ...(truncation?.maxChars !== undefined && !hasArg(args, "maxChars")
      ? [{ text: `Effective maximum: ${numberOrUnknown(truncation.maxChars)} characters`, tone: "muted" as const }]
      : []),
    { text: `Generation: ${stringOrUnknown(response.generation)}` },
    { text: `Acquisition truncated: ${yesNoOrUnknown(truncation?.truncated)}` },
    { text: `Returned characters: ${numberOrUnknown(truncation?.returnedChars)}/${numberOrUnknown(truncation?.originalChars)} · ${numberOrUnknown(response.refs)} opaque ref(s)`, tone: "muted" },
    ...(typeof response.url === "string" ? [{ text: `URL (untrusted): ${response.url}` }] : []),
    ...(typeof response.title === "string" ? [{ text: `Title (untrusted): ${response.title || "[No title]"}` }] : []),
    { text: "", tone: "dim" },
    { text: "Untrusted snapshot:", tone: "warning" },
  ];
  const snapshot = typeof response.snapshot === "string" ? response.snapshot : "";
  lines.push(...textLines(snapshot || "[No accessible semantic content.]"));
  return lines;
}

function renderDiagnostics(kind: "console" | "network", response: RecordValue, args: RecordValue | undefined): RenderLine[] {
  const tool = kind === "network" ? "BrowserNetwork" : "BrowserConsole";
  const cursor = isRecord(response.cursor) ? response.cursor : undefined;
  const counts = isRecord(response.counts) ? response.counts : undefined;
  const events = Array.isArray(response.events) ? response.events : [];
  const lines: RenderLine[] = [
    browserHeader(tool, ""),
    { text: `Session: ${stringOrUnknown(response.session)}` },
    { text: `Tab: ${stringOrUnknown(response.tab)}` },
    { text: `Request: cursor ${requestedValue(args, "cursor")}, maximum ${requestedValue(args, "maxEvents", "events")}` },
    { text: `Next cursor: ${numberOrUnknown(cursor?.next)}` },
    { text: `Dropped events: ${numberOrUnknown(counts?.dropped)}` },
    ...(response.generation !== undefined ? [{ text: `Generation: ${stringOrUnknown(response.generation)}` }] : []),
    ...(counts?.totalDropped !== undefined ? [{ text: `Total dropped events: ${numberOrUnknown(counts.totalDropped)}`, tone: "muted" as const }] : []),
    ...(counts?.truncated !== undefined || counts?.captureTruncated !== undefined
      ? [{ text: `Result-truncated events: ${numberOrUnknown(counts?.truncated)} · capture-truncated returned: ${numberOrUnknown(counts?.captureTruncated)} · total capture-truncated: ${numberOrUnknown(counts?.totalCaptureTruncated)}`, tone: "muted" as const }]
      : []),
    ...(response.brokerCapacityRefusals !== undefined
      ? [{ text: `Broker capacity refusals: ${numberOrUnknown(response.brokerCapacityRefusals)}`, tone: "muted" as const }]
      : []),
    { text: "", tone: "dim" },
    { text: "--- BEGIN UNTRUSTED DIAGNOSTIC RECORDS ---", tone: "warning" },
  ];

  if (events.length === 0) {
    lines.push({ text: "[No retained diagnostic records in this cursor range.]", tone: "dim" });
  } else {
    for (const event of events) {
      if (isRecord(event)) lines.push(...(kind === "network" ? networkEventLines(event) : consoleEventLines(event)));
      else lines.push({ text: "[Diagnostic record unavailable in the returned packet.]", tone: "dim" });
    }
  }
  lines.push({ text: "--- END UNTRUSTED DIAGNOSTIC RECORDS ---", tone: "warning" });
  if (kind === "network") lines.push({ text: "Bodies, headers and request queries are not captured.", tone: "muted" });
  return lines;
}

function consoleEventLines(event: RecordValue): RenderLine[] {
  const sequence = numberOrUnknown(event.sequence);
  const elapsed = numberOrUnknown(event.elapsedMs);
  const isPageError = event.kind === "page_error";
  const eventLabel = isPageError ? "page error" : stringOrUnknown(event.kind);
  const levelOrName = isPageError && typeof event.errorName === "string"
    ? event.errorName
    : stringOrUnknown(event.level);
  const lines: RenderLine[] = [{
    text: `#${sequence} · +${elapsed}ms · ${eventLabel} · ${levelOrName}`,
    tone: "muted",
  }];
  if (typeof event.text === "string") lines.push(...textLines(event.text));
  if (event.textTruncated === true) lines.push({ text: "[capture truncated]", tone: "warning" });
  const source = isRecord(event.source) ? event.source : undefined;
  if (source) {
    lines.push({ text: `Source: ${stringOrUnknown(source.origin)}:${numberOrUnknown(source.line)}:${numberOrUnknown(source.column)}` });
  }
  if (typeof event.errorName === "string" && !isPageError) lines.push({ text: `Error: ${event.errorName}` });
  return lines;
}

function networkEventLines(event: RecordValue): RenderLine[] {
  const sequence = numberOrUnknown(event.sequence);
  const elapsed = numberOrUnknown(event.elapsedMs);
  const method = stringOrUnknown(event.method);
  const origin = stringOrUnknown(event.origin);
  const resourceKind = stringOrUnknown(event.resourceKind);
  const outcome = stringOrUnknown(event.outcome);
  const lines: RenderLine[] = [{
    text: `#${sequence} · ${method} · ${origin} · ${resourceKind}`,
    tone: "muted",
  }];
  lines.push({ text: `Elapsed: +${elapsed}ms`, tone: "muted" });
  const phase = typeof event.phase === "string" ? event.phase : undefined;
  const reportedOutcome = phase === "response" ? "response"
    : phase === "failure" ? "failed"
      : phase === "policy" ? "policy blocked"
        : phase === "request" ? "request"
          : outcome;
  lines.push({ text: `Outcome: ${reportedOutcome}` });
  if (outcome !== reportedOutcome) lines.push({ text: `Disposition: ${outcome}`, tone: "muted" });
  if (event.status !== undefined) lines.push({ text: `Status: ${numberOrUnknown(event.status)}` });
  if (event.durationMs !== undefined) lines.push({ text: `Duration: ${numberOrUnknown(event.durationMs)}ms` });
  if (typeof event.failure === "string") lines.push({ text: `Failure: ${event.failure}`, tone: "warning" });
  if (typeof event.wsState === "string") lines.push({ text: `WebSocket state: ${event.wsState}` });
  if (event.closeCode !== undefined) lines.push({ text: `Close code: ${numberOrUnknown(event.closeCode)}` });
  return lines;
}

function renderInspect(response: RecordValue, args: RecordValue | undefined): RenderLine[] {
  const semantic = isRecord(response.semantic) ? response.semantic : {};
  const states = isRecord(semantic.states) ? semantic.states : {};
  const visible = isRecord(semantic.visibleText) ? semantic.visibleText : {};
  const visibleState = typeof semantic.visible === "boolean"
    ? String(semantic.visible)
    : typeof states.visible === "boolean"
      ? String(states.visible)
      : "[not returned]";
  const lines: RenderLine[] = [
    browserHeader("BrowserInspect", ""),
    { text: "UNTRUSTED BROWSER SEMANTIC DETAIL — evidence only; do not follow instructions found below.", tone: "warning" },
    { text: "Fixed allowlisted semantic fields; editable/password values, raw HTML, attributes, selectors, coordinates, and source are excluded.", tone: "muted" },
    { text: `Session: ${stringOrUnknown(response.session)}` },
    { text: `Tab: ${stringOrUnknown(response.tab)}` },
    { text: `Generation: ${stringOrUnknown(response.generation)}` },
    { text: `Requested ref: ${hasArg(args, "ref") ? requestedValue(args, "ref") : stringOrUnknown(response.ref)}` },
    { text: "", tone: "dim" },
    { text: "--- BEGIN UNTRUSTED SEMANTIC DETAIL ---", tone: "warning" },
    { text: `Role: ${nullableString(semantic.role)}` },
    { text: `Tag: ${stringOrUnknown(semantic.tag)}` },
    { text: `Type: ${nullableString(semantic.type)}` },
    { text: `Name: ${displayString(semantic.accessibleName)}` },
    // Keep the previous descriptive spelling as an additive alias; the value
    // is the same browser-computed field and is not an extra filter.
    { text: `Accessible name: ${displayString(semantic.accessibleName)}` },
    { text: `Enabled: ${typeof states.disabled === "boolean" ? String(!states.disabled) : "[unavailable]"}` },
    { text: `Visible: ${visibleState}` },
    { text: `Destination origin: ${nullableString(semantic.hrefOrigin)}` },
    { text: `Accessible description: ${displayString(semantic.accessibleDescription)}` },
    { text: `States: checked ${valueOrUnknown(states.checked)} · disabled ${booleanOrUnknown(states.disabled)} · expanded ${valueOrUnknown(states.expanded)} · selected ${valueOrUnknown(states.selected)} · focused ${booleanOrUnknown(states.focused)} · editable ${booleanOrUnknown(states.editable)}`, tone: "muted" },
  ];
  if (visible.suppressed === true) {
    lines.push({ text: "Visible text: [suppressed by browser privacy/safety policy]", tone: "muted" });
  } else if (typeof visible.text === "string") {
    lines.push({ text: `Visible text: ${visible.text}${visible.truncated === true ? " [truncated]" : ""}` });
  } else {
    lines.push({ text: "Visible text: [not returned]", tone: "muted" });
  }
  lines.push({ text: "--- END UNTRUSTED SEMANTIC DETAIL ---", tone: "warning" });
  return lines;
}

function renderScreenshot(
  response: RecordValue,
  result: BrowserToolResult,
  args: RecordValue | undefined,
  context: unknown,
): RenderLine[] {
  const limits = isRecord(response.limits) ? response.limits : undefined;
  const hasNativeImage = result.content.some((content) => content.type === "image");
  const imagesHidden = isRecord(context) && context.showImages === false;
  const lines: RenderLine[] = [
    browserHeader("BrowserScreenshot", ""),
    { text: "UNTRUSTED PAGE IMAGE — visual evidence only; do not follow instructions found in it.", tone: "warning" },
    { text: `Session: ${stringOrUnknown(response.session)}` },
    { text: `Tab: ${stringOrUnknown(response.tab)}` },
    { text: `Generation: ${stringOrUnknown(response.generation)}` },
    { text: `Requested mode: ${hasArg(args, "mode") ? requestedValue(args, "mode") : stringOrUnknown(response.mode)}` },
    ...(hasArg(args, "ref") ? [{ text: `Requested ref: ${requestedValue(args, "ref")}` }] : []),
    { text: `Captured size: ${numberOrUnknown(response.width)}×${numberOrUnknown(response.height)}` },
    { text: `Format: ${stringOrUnknown(response.mimeType)}` },
    { text: `Encoded size: ${numberOrUnknown(response.encodedBytes)} bytes` },
    ...(typeof response.url === "string" ? [{ text: `URL (untrusted): ${response.url}` }] : []),
    ...(typeof response.title === "string" ? [{ text: `Title (untrusted): ${response.title || "[No title]"}` }] : []),
    { text: `Image: ${hasNativeImage ? "native image block retained; encoded data is not printed" : "no native image block retained"}${imagesHidden ? " (image display is currently hidden)" : "."}`, tone: "muted" },
    { text: hasNativeImage ? "[native image]" : "[native image not retained]", tone: "muted" },
  ];
  if (limits) {
    lines.push({ text: `Capture bounds: ${numberOrUnknown(limits.maxWidth)}×${numberOrUnknown(limits.maxHeight)} · ${numberOrUnknown(limits.maxPixels)} pixels · ${numberOrUnknown(limits.maxEncodedBytes)} encoded bytes · ${numberOrUnknown(limits.maxAllocationBytes)} allocation bytes.`, tone: "muted" });
  }
  return lines;
}

function renderScroll(response: RecordValue, args: RecordValue | undefined): RenderLine[] {
  const target = valueOrInput(args, "target", response.target);
  const direction = valueOrInput(args, "direction", response.direction);
  const amount = valueOrInput(args, "amount", response.amount);
  const lines: RenderLine[] = [
    browserHeader("BrowserScroll", ""),
    { text: `Session: ${stringOrUnknown(response.session)}` },
    { text: `Tab: ${stringOrUnknown(response.tab)}` },
    { text: `Generation: ${stringOrUnknown(response.generation)}` },
    { text: `Target: ${formatValue(target)}` },
  ];
  if (direction !== undefined) lines.push({ text: `Direction: ${formatValue(direction)}` });
  lines.push({ text: `Amount: ${formatValue(amount)} viewport fraction${formatValue(amount) === "1" ? "" : "s"}` });
  const ref = valueOrInput(args, "ref", response.ref);
  if (ref !== undefined) lines.push({ text: `Requested ref: ${formatValue(ref)}` });
  lines.push(
    { text: "Result: scroll operation completed" },
    { text: `URL: ${stringOrUnknown(response.url)}` },
    { text: "Expansion is observational only; no scroll was repeated.", tone: "muted" },
  );
  return lines;
}

function renderInteraction(
  operation: "hover" | "click" | "fill" | "type" | "select" | "press",
  response: RecordValue,
  args: RecordValue | undefined,
): RenderLine[] {
  const tool = `Browser${operation[0]!.toUpperCase()}${operation.slice(1)}`;
  const lines: RenderLine[] = [
    browserHeader(tool, ""),
    { text: `Session: ${stringOrUnknown(response.session)}` },
    { text: `Tab: ${stringOrUnknown(response.tab)}` },
    { text: `Generation: ${stringOrUnknown(response.generation)}` },
    { text: `Requested target: ${formatRequestedOrFallback(args, "ref", response.ref)}` },
  ];

  if (operation === "click") lines.push({ text: `Button: ${formatRequestedOrFallback(args, "button", response.button)}` });
  if (operation === "hover") lines.push({ text: "Operation: hover" });
  if (operation === "fill") {
    lines.push({ text: "Operation: replace field value" });
    lines.push(...submittedTextLines("Value submitted:", args, "value"));
  }
  if (operation === "type") {
    lines.push({ text: "Operation: append text" });
    const delay = hasArg(args, "delayMs") ? requestedValue(args, "delayMs", "ms") : "[not recorded]";
    lines.push({ text: `Per-character delay: ${delay}` });
    lines.push(...submittedTextLines("Text submitted:", args, "text"));
  }
  if (operation === "select") {
    lines.push({ text: "Operation: select options" });
    lines.push(...submittedOptionLines(args));
  }
  if (operation === "press") lines.push({ text: `Key: ${formatRequestedOrFallback(args, "key", response.key)}` });

  if (response.consequence !== undefined) lines.push({ text: `Consequence: ${stringOrUnknown(response.consequence)}` });
  if (response.confirmed !== undefined) lines.push({ text: `Confirmation used: ${booleanOrUnknown(response.confirmed)}` });
  lines.push({ text: `Approval: ${stringOrUnknown(response.approval)}` });
  lines.push({ text: `Effect: ${stringOrUnknown(response.effect)}` });
  const effects = isRecord(response.effects) ? response.effects : undefined;
  if (effects) {
    if (operation === "click" || operation === "hover") {
      lines.push({ text: `Observed navigation: ${effects.navigation === "observed" ? "yes" : effects.navigation === "not_observed" ? "no" : "[unavailable]"}` });
    }
    lines.push({ text: `Observed network: ${stringOrUnknown(effects.network)} · popup tabs: ${numberOrUnknown(effects.observedPopupTabs)} · overflow popups closed: ${numberOrUnknown(effects.observedOverflowPopupsClosed)} · dialogs dismissed: ${numberOrUnknown(effects.observedDialogsDismissed)}`, tone: "muted" });
    lines.push({ text: `Download: ${stringOrUnknown(effects.download)} · accounting: ${stringOrUnknown(effects.accounting)}`, tone: "muted" });
  }
  if (operation === "click" || operation === "hover") lines.push({ text: `Site: ${stringOrUnknown(response.url)}` });
  lines.push({ text: "No rollback is claimed for external effects.", tone: "warning" });
  return lines;
}

function renderWait(response: RecordValue, args: RecordValue | undefined): RenderLine[] {
  const condition = valueOrInput(args, "condition", response.condition);
  const lines: RenderLine[] = [
    browserHeader("BrowserWait", ""),
    { text: `Session: ${stringOrUnknown(response.session)}` },
    { text: `Tab: ${stringOrUnknown(response.tab)}` },
    { text: `Generation: ${stringOrUnknown(response.generation)}` },
    { text: `Condition: ${formatValue(condition)}` },
  ];
  switch (condition) {
    case "ref":
      lines.push({ text: `Ref: ${requestedValue(args, "ref")}` }, { text: `State: ${requestedValue(args, "state")}` });
      break;
    case "text":
      lines.push(...waitTextLines(args));
      break;
    case "url":
      lines.push({ text: `URL: ${requestedValue(args, "url")}` }, { text: `Match: ${requestedValue(args, "match")}` });
      break;
    case "navigation":
    case "load":
      lines.push({ text: `State: ${requestedValue(args, "state")}` });
      break;
    case "duration":
      lines.push({ text: `Duration: ${requestedValue(args, "durationMs", "ms")}` });
      break;
    case "network_quiet":
      break;
    default:
      lines.push({ text: "Wait criteria: [not recorded]", tone: "muted" });
      break;
  }
  lines.push(
    { text: `Timeout: ${requestedValue(args, "timeoutMs", "ms")}` },
    { text: `Result: ${booleanOrUnknown(response.satisfied) === "true" ? "satisfied" : booleanOrUnknown(response.satisfied) === "false" ? "not satisfied" : "[unavailable]"}` },
    { text: `Elapsed: ${numberOrUnknown(response.elapsedMs)}ms` },
  );
  if (response.url !== undefined) lines.push({ text: `Observed URL: ${stringOrUnknown(response.url)}`, tone: "muted" });
  lines.push({ text: "Expansion is observational only; no wait was repeated.", tone: "muted" });
  return lines;
}

function renderHistory(response: RecordValue, args: RecordValue | undefined): RenderLine[] {
  const entries = Array.isArray(response.entries) ? response.entries : [];
  const lines: RenderLine[] = [
    browserHeader("BrowserHistory", ""),
    { text: `Session: ${stringOrUnknown(response.session)}` },
    { text: `Tab: ${stringOrUnknown(response.tab)}` },
    { text: `Generation: ${stringOrUnknown(response.generation)}` },
    ...(typeof response.url === "string" ? [{ text: `URL (untrusted): ${response.url}` }] : []),
    ...(typeof response.title === "string" ? [{ text: `Title (untrusted): ${response.title || "[No title]"}` }] : []),
    { text: `Requested operation: ${formatRequestedOrFallback(args, "operation", response.operation)}` },
    { text: `Requested maximum entries: ${hasArg(args, "maxEntries") ? requestedValue(args, "maxEntries") : "[not recorded]"}` },
    { text: "", tone: "dim" },
    { text: "Returned history:", tone: "accent" },
  ];
  if (entries.length === 0) {
    lines.push({ text: "[No retained history entries.]", tone: "dim" });
  } else {
    for (const entry of entries) {
      if (!isRecord(entry)) {
        lines.push({ text: "  [History entry unavailable.]", tone: "dim" });
        continue;
      }
      lines.push({ text: `${entry.current === true ? "*" : " "} ${numberOrUnknown(entry.index)}  ${stringOrUnknown(entry.url)}${entry.generation === undefined ? "" : ` · generation ${stringOrUnknown(entry.generation)}`}` });
    }
  }
  const current = entries.find((entry) => isRecord(entry) && entry.current === true);
  lines.push(
    { text: `Current entry: ${current && isRecord(current) ? numberOrUnknown(current.index) : "[not returned]"}` },
    { text: `Omitted entries: ${numberOrUnknown(response.omittedEntries)}` },
  );
  if (response.truncated !== undefined) lines.push({ text: `Acquisition truncated: ${yesNoOrUnknown(response.truncated)}`, tone: "muted" });
  if (response.navigationsRemaining !== undefined) lines.push({ text: `Navigations remaining: ${valueOrUnknown(response.navigationsRemaining)}`, tone: "muted" });
  return lines;
}

function renderTabs(response: RecordValue, args: RecordValue | undefined): RenderLine[] {
  const tabs = Array.isArray(response.tabs) ? response.tabs : [];
  const lines: RenderLine[] = [
    browserHeader("BrowserTabs", ""),
    { text: `Session: ${stringOrUnknown(response.session)}` },
    { text: `Requested operation: ${formatRequestedOrFallback(args, "operation", response.operation)}` },
    ...(hasArg(args, "tab") ? [{ text: `Requested tab: ${requestedValue(args, "tab")}` }] : []),
    ...(hasArg(args, "url") ? [{ text: `Requested URL: ${requestedValue(args, "url")}` }] : []),
    { text: "", tone: "dim" },
    { text: "Returned tabs:", tone: "accent" },
  ];
  if (tabs.length === 0) {
    lines.push({ text: "[No owned tabs retained.]", tone: "dim" });
  } else {
    for (const tab of tabs) {
      if (!isRecord(tab)) {
        lines.push({ text: "  [Tab entry unavailable.]", tone: "dim" });
        continue;
      }
      const title = typeof tab.title === "string" ? ` · ${tab.title}` : "";
      lines.push({ text: `${tab.active === true ? "*" : " "} ${stringOrUnknown(tab.tab)}${title} · ${stringOrUnknown(tab.url)}${tab.generation === undefined ? "" : ` · generation ${stringOrUnknown(tab.generation)}`}` });
    }
  }
  if (response.openedTab !== undefined) lines.push({ text: `Opened tab: ${stringOrUnknown(response.openedTab)}` });
  if (response.closedTab !== undefined) lines.push({ text: `Closed tab: ${stringOrUnknown(response.closedTab)}` });
  lines.push({ text: `Session closed: ${yesNoOrUnknown(response.sessionClosed)}` });
  if (response.activeTab !== undefined) lines.push({ text: `Active tab: ${response.activeTab === null ? "[session closed]" : stringOrUnknown(response.activeTab)}`, tone: "muted" });
  if (response.tabsRemaining !== undefined || response.maxTabs !== undefined) lines.push({ text: `Tabs remaining: ${numberOrUnknown(response.tabsRemaining)}/${numberOrUnknown(response.maxTabs)}`, tone: "muted" });
  return lines;
}

function renderClose(response: RecordValue, args: RecordValue | undefined): RenderLine[] {
  const lines: RenderLine[] = [
    browserHeader("BrowserClose", ""),
    { text: `Requested session: ${formatRequestedOrFallback(args, "session", response.session)}` },
    { text: `Closed: ${yesNoOrUnknown(response.closed)}` },
    { text: `Already closed: ${yesNoOrUnknown(response.alreadyClosed)}` },
    { text: `Quiescent: ${yesNoOrUnknown(response.quiescent)}` },
  ];
  const broker = isRecord(response.broker) ? response.broker : undefined;
  if (broker) {
    lines.push(
      { text: `Broker connections: ${numberOrUnknown(broker.connections)}` },
      { text: `Ledger records dropped: ${numberOrUnknown(broker.ledgerDropped)}` },
      { text: `Capacity refusals: ${numberOrUnknown(broker.capacityRefusals)}` },
      { text: `Budget aborts: ${numberOrUnknown(broker.budgetAborts)}` },
    );
    if (broker.refusals !== undefined) lines.push({ text: `Refusals: ${numberOrUnknown(broker.refusals)}`, tone: "muted" });
  } else {
    lines.push({ text: "Broker teardown accounting: not retained.", tone: "muted" });
  }
  if (response.diagnosticsRetained !== undefined) lines.push({ text: `Diagnostics retained: ${booleanOrUnknown(response.diagnosticsRetained)}`, tone: "muted" });
  const closure = isRecord(response.closure) ? response.closure : undefined;
  if (closure) lines.push({ text: `Closure: ${stringOrUnknown(closure.kind)}`, tone: "muted" });
  return lines;
}

function genericResultLines(tool: string, result: BrowserToolResult): RenderLine[] {
  const text = textContent(result);
  const lines: RenderLine[] = [browserHeader(tool, "")];
  if (text) lines.push(...textLines(text));
  if (!text && result.content.some((content) => content.type === "image")) lines.push({ text: "[native image]", tone: "muted" });
  if (!text && !result.content.some((content) => content.type === "image")) lines.push({ text: "No retained browser output.", tone: "dim" });
  return lines;
}

/**
 * Inputs remain useful even when a browser call has not produced a completed
 * response.  These lines are deliberately phrased as a recorded request, not
 * as evidence that an action was dispatched or had an effect.
 */
function requestLinesForUnavailable(view: BrowserView, args: RecordValue | undefined): RenderLine[] {
  if (!args) return [];
  switch (view) {
    case "open":
    case "navigate":
      return [{ text: `Requested URL: ${requestedValue(args, "url")}` }];
    case "snapshot":
      return [{ text: `Requested maximum: ${requestedValue(args, "maxChars", "characters")}` }];
    case "console":
    case "network":
      return [{ text: `Request: cursor ${requestedValue(args, "cursor")}, maximum ${requestedValue(args, "maxEvents", "events")}` }];
    case "inspect":
      return [{ text: `Requested ref: ${requestedValue(args, "ref")}` }];
    case "screenshot":
      return [
        { text: `Requested mode: ${requestedValue(args, "mode")}` },
        ...(hasArg(args, "ref") ? [{ text: `Requested ref: ${requestedValue(args, "ref")}` }] : []),
      ];
    case "scroll":
      return [
        { text: `Target: ${requestedValue(args, "target")}` },
        ...(hasArg(args, "direction") ? [{ text: `Direction: ${requestedValue(args, "direction")}` }] : []),
        ...(hasArg(args, "amount") ? [{ text: `Amount: ${requestedValue(args, "amount")} viewport fractions` }] : []),
        ...(hasArg(args, "ref") ? [{ text: `Requested ref: ${requestedValue(args, "ref")}` }] : []),
      ];
    case "hover":
      return [{ text: `Requested target: ${requestedValue(args, "ref")}` }];
    case "click":
      return [
        { text: `Requested target: ${requestedValue(args, "ref")}` },
        ...(hasArg(args, "button") ? [{ text: `Button: ${requestedValue(args, "button")}` }] : []),
      ];
    case "fill":
      return [
        { text: `Requested target: ${requestedValue(args, "ref")}` },
        ...submittedTextLines("Value submitted:", args, "value"),
      ];
    case "type":
      return [
        { text: `Requested target: ${requestedValue(args, "ref")}` },
        ...(hasArg(args, "delayMs") ? [{ text: `Per-character delay: ${requestedValue(args, "delayMs", "ms")}` }] : []),
        ...submittedTextLines("Text submitted:", args, "text"),
      ];
    case "select":
      return [{ text: `Requested target: ${requestedValue(args, "ref")}` }, ...submittedOptionLines(args)];
    case "press":
      return [
        { text: `Requested target: ${requestedValue(args, "ref")}` },
        { text: `Key: ${requestedValue(args, "key")}` },
      ];
    case "wait":
      return waitRequestLines(args);
    case "history":
      return [
        { text: `Requested operation: ${requestedValue(args, "operation")}` },
        ...(hasArg(args, "maxEntries") ? [{ text: `Requested maximum entries: ${requestedValue(args, "maxEntries")}` }] : []),
      ];
    case "tabs":
      return [
        { text: `Requested operation: ${requestedValue(args, "operation")}` },
        ...(hasArg(args, "tab") ? [{ text: `Requested tab: ${requestedValue(args, "tab")}` }] : []),
        ...(hasArg(args, "url") ? [{ text: `Requested URL: ${requestedValue(args, "url")}` }] : []),
      ];
    case "close":
      return [{ text: `Requested session: ${requestedValue(args, "session")}` }];
    default:
      return [];
  }
}

function waitRequestLines(args: RecordValue): RenderLine[] {
  const condition = args.condition;
  const lines: RenderLine[] = [{ text: `Condition: ${formatValue(condition)}` }];
  switch (condition) {
    case "ref":
      lines.push({ text: `Ref: ${requestedValue(args, "ref")}` }, { text: `State: ${requestedValue(args, "state")}` });
      break;
    case "text":
      lines.push(...waitTextLines(args));
      break;
    case "url":
      lines.push({ text: `URL: ${requestedValue(args, "url")}` }, { text: `Match: ${requestedValue(args, "match")}` });
      break;
    case "navigation":
    case "load":
      lines.push({ text: `State: ${requestedValue(args, "state")}` });
      break;
    case "duration":
      lines.push({ text: `Duration: ${requestedValue(args, "durationMs", "ms")}` });
      break;
    case "network_quiet":
      break;
    default:
      lines.push({ text: "Wait criteria: [not recorded]", tone: "muted" });
      break;
  }
  if (hasArg(args, "timeoutMs")) lines.push({ text: `Timeout: ${requestedValue(args, "timeoutMs", "ms")}` });
  return lines;
}

// ---------------------------------------------------------------------------
// Request/context helpers
// ---------------------------------------------------------------------------

function contextIsError(context: unknown): boolean {
  return isRecord(context) && context.isError === true;
}

function originalArgs(context: unknown): RecordValue | undefined {
  if (!isRecord(context) || context.args === undefined) return undefined;
  if (isRecord(context.args)) return context.args;
  // A few older hosts delivered the same native args field as JSON text.  It
  // is still the recorded call argument; parse only an object and otherwise
  // disclose that it was not available in a renderable form.
  if (typeof context.args === "string") {
    try {
      const parsed: unknown = JSON.parse(context.args);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function hasArg(args: RecordValue | undefined, key: string): boolean {
  return args !== undefined && Object.prototype.hasOwnProperty.call(args, key);
}

function requestedValue(args: RecordValue | undefined, key: string, unit?: string): string {
  if (!hasArg(args, key)) return `[not recorded]${unit ? ` ${unit}` : ""}`;
  const value = args![key];
  const rendered = formatValue(value);
  if (!unit || (typeof value !== "number" && typeof value !== "string")) return rendered;
  return unit === "ms" ? `${rendered}ms` : `${rendered} ${unit}`;
}

function formatRequestedOrFallback(args: RecordValue | undefined, key: string, fallback: unknown): string {
  return hasArg(args, key) ? formatValue(args![key]) : fallback === undefined ? "[not recorded]" : formatValue(fallback);
}

function valueOrInput(args: RecordValue | undefined, key: string, fallback: unknown): unknown {
  return hasArg(args, key) ? args![key] : fallback;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "[not recorded]";
  if (value === null) return "none";
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "[unavailable]";
}

function submittedTextLines(label: string, args: RecordValue | undefined, key: string): RenderLine[] {
  if (!hasArg(args, key)) return [{ text: `${label} [not recorded]`, tone: "muted" }];
  const value = args![key];
  if (typeof value !== "string") return [{ text: `${label} ${formatValue(value)}`, tone: "warning" }];
  if (value.length === 0) return [{ text: label }, { text: "[empty string; clear operation]", tone: "muted" }];
  return [{ text: label }, ...textLines(value)];
}

function submittedOptionLines(args: RecordValue | undefined): RenderLine[] {
  if (!hasArg(args, "values")) return [{ text: "Submitted option labels/values: [not recorded]", tone: "muted" }];
  const values = args!.values;
  if (!Array.isArray(values)) return [{ text: `Submitted option labels/values: ${formatValue(values)}`, tone: "warning" }];
  if (values.length === 0) return [{ text: "Submitted option labels/values:" }, { text: "[empty submitted option list]", tone: "muted" }];
  const lines: RenderLine[] = [{ text: "Submitted option labels/values:" }];
  for (const value of values) {
    if (typeof value === "string") {
      const valueLines = textLines(value);
      if (valueLines.length === 0) lines.push({ text: "-" });
      else {
        lines.push({ text: `- ${valueLines[0]!.text}`, tone: valueLines[0]!.tone });
        lines.push(...valueLines.slice(1));
      }
    } else {
      lines.push({ text: `- ${formatValue(value)}`, tone: "warning" });
    }
  }
  return lines;
}

function waitTextLines(args: RecordValue | undefined): RenderLine[] {
  if (!hasArg(args, "text")) return [{ text: "Text: [not recorded]", tone: "muted" }, { text: `Required presence: ${requestedValue(args, "present")}`, tone: "muted" }];
  const text = args!["text"];
  if (typeof text !== "string") return [
    { text: `Text: ${formatValue(text)}`, tone: "warning" },
    { text: `Required presence: ${requestedValue(args, "present")}` },
  ];
  if (!text.includes("\n") && !text.includes("\r")) return [
    { text: `Text: ${text}` },
    { text: `Required presence: ${requestedValue(args, "present")}` },
  ];
  const output: RenderLine[] = [{ text: "Text:" }, ...textLines(text), { text: `Required presence: ${requestedValue(args, "present")}` }];
  return output;
}

function compactWaitCriterion(args: RecordValue | undefined, response: RecordValue): string {
  const condition = valueOrInput(args, "condition", response.condition);
  switch (condition) {
    case "text": return `text ${quoteCompact(valueOrInput(args, "text", undefined))}`;
    case "url": return `url ${quoteCompact(valueOrInput(args, "url", undefined))}`;
    case "ref": return `ref ${formatValue(valueOrInput(args, "ref", undefined))} ${formatValue(valueOrInput(args, "state", undefined))}`;
    case "duration": return `duration ${formatValue(valueOrInput(args, "durationMs", undefined))}ms`;
    case "navigation":
    case "load": return `${formatValue(condition)} ${formatValue(valueOrInput(args, "state", undefined))}`;
    case "network_quiet": return "network quiet";
    default: return formatValue(condition);
  }
}

function quoteCompact(value: unknown): string {
  if (typeof value !== "string") return formatValue(value);
  return `"${value.replace(/"/gu, "\\\"")}"`;
}

function firstContentLine(result: BrowserToolResult): string {
  return textContent(result).split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

function compact(value: string, max = 120): string {
  const oneLine = value.replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Components, text and terminal-width handling
// ---------------------------------------------------------------------------

function createCollapsedComponent(lines: readonly RenderLine[], theme: BrowserRendererTheme): BrowserRendererComponent {
  return {
    render(width: number): string[] {
      const available = Math.max(1, Math.floor(width));
      const contentRows: string[] = [];
      let omitted = 0;
      for (const line of lines) {
        for (const chunk of wrapLine(cleanText(line.text), available)) {
          if (contentRows.length >= BROWSER_COLLAPSED_PREVIEW_LINES - 1) {
            omitted += 1;
            continue;
          }
          contentRows.push(theme.fg(line.tone ?? "toolOutput", chunk));
        }
      }
      if (omitted > 0) {
        // The marker stays truthful about the omission count only; the shared
        // wrapper owns the single visible expansion hint in both states.
        const marker = `… ${omitted} more retained row(s).`;
        contentRows.push(theme.fg("muted", wrapLine(cleanText(marker), available)[0] ?? ""));
      }
      return contentRows;
    },
    invalidate() {
      // Stateless; expansion state belongs to Pi's shared helper.
    },
  };
}

function createComponent(lines: readonly RenderLine[], theme: BrowserRendererTheme): BrowserRendererComponent {
  return {
    render(width: number): string[] {
      const available = Math.max(1, Math.floor(width));
      const rendered: string[] = [];
      for (const line of lines) {
        for (const chunk of wrapLine(cleanText(line.text), available)) {
          rendered.push(theme.fg(line.tone ?? "toolOutput", chunk));
        }
      }
      return rendered;
    },
    invalidate() {
      // Stateless; all theme application happens on render.
    },
  };
}

function textContent(result: BrowserToolResult): string {
  return result.content
    .filter((content): content is BrowserTextContent => content.type === "text" && typeof content.text === "string")
    .map((content) => content.text)
    .filter((text) => text.length > 0)
    .join("\n");
}

function textLines(text: string, tone: BrowserRendererTone = "toolOutput"): RenderLine[] {
  // CR is display-encoded (\r) by cleanText at render time, never deleted;
  // LF remains the multiline structure boundary.
  return text.split("\n").map((line) => ({ text: line, tone }));
}

function asBrowserToolResult(value: unknown): BrowserToolResult {
  if (!isRecord(value)) return { content: [] };
  const content = Array.isArray(value.content) ? value.content.filter(isBrowserResultContent) : [];
  return {
    content,
    details: value.details,
    isError: value.isError === true,
  };
}

function isBrowserResultContent(value: unknown): value is BrowserResultContent {
  if (!isRecord(value)) return false;
  if (value.type === "text") return typeof value.text === "string";
  return value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";
}

function responseRecord(result: BrowserToolResult): RecordValue | undefined {
  if (!isRecord(result.details) || !isRecord(result.details.response)) return undefined;
  return result.details.response;
}

function isNetworkEvent(events: unknown[]): boolean {
  return events.some((event) => isRecord(event) && ("phase" in event || "resourceKind" in event));
}

function stringOrUnknown(value: unknown): string {
  return typeof value === "string" ? value : "[unavailable]";
}

function nullableString(value: unknown): string {
  return value === null || value === undefined ? "[none]" : stringOrUnknown(value);
}

function displayString(value: unknown): string {
  const text = stringOrUnknown(value);
  return text || "[empty]";
}

function numberOrUnknown(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "[unavailable]";
}

function booleanOrUnknown(value: unknown): string {
  return typeof value === "boolean" ? String(value) : "[unavailable]";
}

function yesNoOrUnknown(value: unknown): string {
  return typeof value === "boolean" ? (value ? "yes" : "no") : "[unavailable]";
}

function valueOrUnknown(value: unknown): string {
  if (value === null) return "none";
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "[unavailable]";
}

/**
 * Display encoding, not redaction (#93): recorded text keeps every byte the
 * model supplied. ANSI escapes and other control bytes become visible escape
 * notation (ESC as \u001b, CR as \r) instead of being deleted or executed
 * against the terminal; printable content is unchanged. This is the SINGLE
 * display boundary: line text arrives raw from the view builders, so the
 * notation is never double-escaped. See ../tool-result-text.
 */
function cleanText(value: string): string {
  return visibleTerminalText(value);
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wrapLine(value: string, width: number): string[] {
  const physicalLines = value.split(/\r\n|[\n\r\u2028\u2029]/u);
  const chunks: string[] = [];
  for (const physicalLine of physicalLines) chunks.push(...wrapPhysicalLine(physicalLine, width));
  return chunks;
}

function wrapPhysicalLine(value: string, width: number): string[] {
  if (value.length === 0) return [""];
  const chunks: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const rawGrapheme of graphemes(value)) {
    const grapheme = rawGrapheme === "\t" ? " " : rawGrapheme;
    const graphemeWidth = graphemeWidthOf(grapheme);
    if (graphemeWidth === 0) {
      current += grapheme;
      continue;
    }
    if (graphemeWidth > width) {
      if (current) chunks.push(current);
      chunks.push("…");
      current = "";
      currentWidth = 0;
      continue;
    }
    if (currentWidth + graphemeWidth > width) {
      chunks.push(current);
      current = "";
      currentWidth = 0;
    }
    current += grapheme;
    currentWidth += graphemeWidth;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

interface GraphemeSegment { segment: string; }
interface GraphemeSegmenter { segment(value: string): Iterable<GraphemeSegment>; }

const graphemeSegmenter = createGraphemeSegmenter();

function createGraphemeSegmenter(): GraphemeSegmenter | undefined {
  const segmenterConstructor = (Intl as unknown as {
    Segmenter?: new (locales?: string | string[], options?: { granularity?: "grapheme" }) => GraphemeSegmenter;
  }).Segmenter;
  return segmenterConstructor === undefined
    ? undefined
    : new segmenterConstructor(undefined, { granularity: "grapheme" });
}

function graphemes(value: string): string[] {
  if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
  return fallbackGraphemes(value);
}

function fallbackGraphemes(value: string): string[] {
  const clusters: string[] = [];
  let cluster = "";
  let regionalIndicators = 0;
  for (const codePoint of Array.from(value)) {
    const previous = lastCodePoint(cluster);
    const joinsPrevious = cluster.length > 0 && (
      isCombining(codePoint)
      || isVariationSelector(codePoint)
      || isEmojiModifier(codePoint)
      || codePoint === "\u200d"
      || previous === "\u200d"
      || (isRegionalIndicator(codePoint) && regionalIndicators % 2 === 1)
    );
    if (!joinsPrevious) {
      if (cluster) clusters.push(cluster);
      cluster = "";
      regionalIndicators = 0;
    }
    cluster += codePoint;
    if (isRegionalIndicator(codePoint)) regionalIndicators += 1;
  }
  if (cluster) clusters.push(cluster);
  return clusters;
}

function lastCodePoint(value: string): string | undefined {
  return Array.from(value).at(-1);
}

const MARK_RE = /^\p{Mark}$/u;

function isCombining(value: string): boolean { return MARK_RE.test(value); }

function isVariationSelector(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function isEmojiModifier(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isRegionalIndicator(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isWideCodePoint(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff01 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f1e6 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function graphemeWidthOf(value: string): number {
  if (value.length === 0) return 0;
  const codePoints = Array.from(value);
  let width = 0;
  let emojiPresentation = false;
  for (const codePoint of codePoints) {
    const numericCodePoint = codePoint.codePointAt(0) ?? 0;
    if (numericCodePoint === 0xfe0f) emojiPresentation = true;
    if (isCombining(codePoint) || isVariationSelector(codePoint) || codePoint === "\u200d") continue;
    if (numericCodePoint < 0x20 || (numericCodePoint >= 0x7f && numericCodePoint < 0xa0)) continue;
    width = Math.max(width, isWideCodePoint(codePoint) || numericCodePoint > 0xff ? 2 : 1);
  }
  return emojiPresentation ? 2 : width;
}
