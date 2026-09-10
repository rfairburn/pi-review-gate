/*
 * Expanded result views for the background shell tool family: ShellStart,
 * ShellList, ShellLog, ShellSend, and ShellStop.
 *
 * Scope by design: this module owns only the Shell family's render callbacks.
 * The shared collapse/expand plumbing is the result-expansion foundation
 * (#57, src/tool-result-expansion.ts): `expandableResult(collapsedRenderer,
 * expandedRenderer?)` takes a collapsed renderer plus one of these callbacks
 * and returns the native Pi `renderResult` component factory that switches on
 * `options.expanded`, falling back to the collapsed view whenever the detail
 * callback throws or returns a non-component. `src/background-shell/index.ts`
 * wires every Shell* registration through it with this module's preserved
 * native-fallback collapsed renderer plus the matching per-tool expanded
 * callback — no other expansion helper, key handler, or state exists in this
 * family.
 *
 * Expansion is display-only. Every expanded view renders data the tool result
 * already retains — the model-facing `content` text plus the `details`
 * metadata captured at call time (details are a Pi rendering/state channel;
 * they are never sent to the model, so enriching them does not change the
 * model-visible result or any retention budget). Nothing is re-read,
 * re-fetched, or reconstructed from live job state, so a restored session
 * renders exactly the bounded snapshot the call recorded, including its
 * truncation markers, ranges, and drop counts.
 *
 * The collapsed side (`shellCollapsedResultRenderer`) deliberately mirrors
 * Pi's native fallback for tools without a custom `renderResult` — full text
 * when expanded, a 10-line preview with an expand hint when collapsed —
 * because wiring the shared mechanism replaces that native fallback. It also
 * honors the expanded flag itself, so a failed detail render degrades to the
 * familiar native view in both states.
 *
 * Every renderer is defensive about its input (session restore can hand it a
 * result recorded before structured details existed) and about its budget:
 * all text is wrapped into terminal-cell-safe display lines (wide CJK/emoji
 * glyphs and ANSI escapes handled), the retained-data bounds are unchanged,
 * and any missing detail degrades to a bounded preview of the retained
 * content text rather than a fabricated value.
 */
import {
  MAX_COMMAND_DISPLAY_CHARS,
  MAX_ERROR_DISPLAY_CHARS,
  formatElapsed,
  truncateText,
} from "./jobs";

/** Names of the tools whose results this module renders. */
export type ShellToolName = "ShellStart" | "ShellList" | "ShellLog" | "ShellSend" | "ShellStop";

/** Theme subset the renderers use; matches Pi's theme.fg()/bold() contract. */
export type ShellResultViewTheme = {
  bold(text: string): string;
  fg(
    color:
      | "accent"
      | "dim"
      | "error"
      | "muted"
      | "success"
      | "toolOutput"
      | "toolTitle"
      | "warning",
    text: string,
  ): string;
};

/** Bounded component returned by every renderer (same shape as the repo's
 *  other tool renderers: { render, invalidate }). */
export interface ShellResultComponent {
  render(width: number): string[];
  invalidate(): void;
}

/** Render options Pi passes to renderResult. The shared foundation decides
 *  WHEN to call an expanded renderer (options.expanded === true); these
 *  callbacks own WHAT the expanded view shows. isPartial renders a bounded
 *  pending line because our tools never stream updates but defensive shapes
 *  must not crash. */
export interface ShellRenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
}

/** Native Pi renderResult signature (result, options, theme, context). */
export type ShellResultRenderer = (
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  context?: unknown,
) => ShellResultComponent;

// ── Bounds (display only; the retained data itself is already capped) ───

/** Log body lines shown in one expanded ShellLog render. The result content
 *  cannot exceed ShellLog's own 400-line cap, so this only guards against
 *  malformed input, never hides retained output the model received. */
const MAX_EXPANDED_LOG_LINES = 400;
/** Job rows shown in one expanded ShellList render. The harness caps live
 *  jobs at 8; this is defensive against hand-built or legacy details. */
const MAX_EXPANDED_JOB_ROWS = 16;
/** Lines of the model-visible content shown by fallback and summary views. */
const MAX_EXPANDED_CONTENT_LINES = 8;
/** Command lines shown for one job (commands may contain newlines). */
const MAX_EXPANDED_COMMAND_LINES = 4;

// ── Result-details helpers ──────────────────────────────────────────────

/** Common details tag for Shell* results. `kind` matches the existing
 *  pi-review-bg-shell tag; `tool` marks which renderer the result belongs
 *  to. Details live on the tool result for rendering/state only. */
export function shellResultDetails(
  tool: ShellToolName,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind: "pi-review-bg-shell", tool, ...fields };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  const first = result.content[0];
  return isRecord(first) && typeof first.text === "string" ? first.text : "";
}

function isErrorResult(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
}

/** Structured metadata on a Shell* result, when present and correctly tagged. */
function shellDetails(result: unknown, tool: ShellToolName): Record<string, any> | undefined {
  if (!isRecord(result) || !isRecord(result.details)) return undefined;
  const details = result.details;
  return details.tool === tool && details.kind === "pi-review-bg-shell" ? details : undefined;
}

/** Bounded string read out of details: unknown shapes degrade to undefined
 *  and long values carry the visible truncation marker. */
function dString(details: Record<string, any>, key: string, max: number): string | undefined {
  const value = details[key];
  return typeof value === "string" ? truncateText(value, max) : undefined;
}

function dNumber(details: Record<string, any>, key: string): number | undefined {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Bounded ISO timestamp from a numeric epoch-ms details field. */
function dTimestamp(details: Record<string, any>, key: string): string | undefined {
  const value = dNumber(details, key);
  if (value === undefined) return undefined;
  try {
    return new Date(value).toISOString();
  } catch {
    return undefined;
  }
}

// ── Shared view helpers ─────────────────────────────────────────────────

function viewComponent(render: (width: number) => string[]): ShellResultComponent {
  return {
    render: (width: number) => render(Math.max(0, width - 2)),
    invalidate() {},
  };
}

// ── Terminal-cell-aware wrapping ────────────────────────────────────────

// Pi (pi-tui) rejects any rendered line wider than the terminal, counting
// terminal CELLS, not characters: East Asian wide glyphs and most emoji
// occupy two cells, ANSI/OSC escape sequences none. The shell family renders
// arbitrary child-process output, so wrapping here is cell-aware rather than
// trusting the char-count approximation in width.ts (that one is only safe
// for the widget content it was built for).

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2329, 0x232a], // angle brackets
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], // CJK radicals … CJK ext A
  [0x4e00, 0x9fff], // CJK unified
  [0xa000, 0xa4cf], [0xa960, 0xa97f], // Yi, Hangul Jamo ext-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], // vertical forms, CJK compat forms
  [0xff00, 0xff60], [0xffe0, 0xffe6], // fullwidth forms
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], // emoji blocks
  [0x1fa70, 0x1faff], // Symbols and Pictographs Extended-A (🫠 U+1FAE0 …)
  [0x20000, 0x3fffd], // CJK ext B+ / plane 3
];

function codePointCells(cp: number): number {
  if (WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) return 2;
  // Zero-width: combining marks, variation selectors, zero-width controls.
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200b || cp === 0x200d) {
    return 0;
  }
  return 1;
}

/** Visible terminal-cell width of a line: ANSI/OSC escapes are ignored, wide
 *  glyphs count two cells. Exported for width-safe test assertions. */
export function visibleCells(line: string): number {
  let cells = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "\x1b") {
      const rest = line.slice(i);
      const csi = rest.match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
      if (csi) {
        i += csi[0].length;
        continue;
      }
      if (line[i + 1] === "]") {
        const end = line.indexOf("\x07", i);
        if (end >= 0) {
          i = end + 1;
          continue;
        }
      }
    }
    const cp = line.codePointAt(i)!;
    cells += codePointCells(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return cells;
}

/** Wrap one line (already-themed or plain) into display lines that never
 *  exceed `width` terminal cells. Formatting is preserved, not cut:
 *  whitespace and embedded ANSI escapes survive the wrap, and styles are
 *  re-applied at the start of every continuation line (Pi resets styling at
 *  each rendered line, so styles would otherwise not carry across).
 *
 *  Display-only adjustments, both necessary for honest width math: CR is
 *  stripped (a CRLF stream would otherwise move the cursor) and tabs are
 *  expanded to four spaces (tab stop positions are terminal-dependent, so a
 *  raw tab cannot be measured). The model-visible text is untouched. */
export function wrapToWidth(line: string, width: number): string[] {
  if (width <= 0) return [];
  const prepared = line.replace(/\r/g, "").replace(/\t/g, "    ");
  if (visibleCells(prepared) <= width) return [prepared];
  const out: string[] = [];
  let current = "";
  let cells = 0;
  let activeSgr = "";
  let i = 0;
  while (i < prepared.length) {
    const ch = prepared[i]!;
    if (ch === "\x1b") {
      const rest = prepared.slice(i);
      const sgr = rest.match(/^\x1b\[[0-9;]*m/);
      if (sgr) {
        current += sgr[0];
        activeSgr = sgr[0] === "\x1b[0m" || sgr[0] === "\x1b[m" ? "" : sgr[0];
        i += sgr[0].length;
        continue;
      }
      const csi = rest.match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
      if (csi) {
        current += csi[0];
        i += csi[0].length;
        continue;
      }
      if (prepared[i + 1] === "]") {
        const end = prepared.indexOf("\x07", i);
        if (end >= 0) {
          current += prepared.slice(i, end + 1);
          i = end + 1;
          continue;
        }
      }
    }
    const cp = prepared.codePointAt(i)!;
    const cpCells = codePointCells(cp);
    if (cells > 0 && cells + cpCells > width) {
      // Break: re-apply the in-flight style at the start of the next line
      // (Pi resets styling at line ends) and close this one.
      out.push(activeSgr ? `${current}\x1b[0m` : current);
      current = activeSgr;
      cells = 0;
    }
    current += prepared.slice(i, i + (cp > 0xffff ? 2 : 1));
    cells += cpCells;
    i += cp > 0xffff ? 2 : 1;
  }
  if (current.length > 0 || out.length === 0) out.push(current);
  return out;
}

/** Wrap an already-themed line into width-safe display lines. */
function wrap(line: string, width: number): string[] {
  return wrapToWidth(line, width);
}

/** First non-empty line of a content blob — used as the honest summary of
 *  the model-visible result in summary views. */
function firstContentLine(result: unknown): string {
  return contentText(result).split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
}

/** Bounded preview of the retained model-visible text, used by fallback and
 *  detail views so nothing important is silently dropped. */
function contentPreview(result: unknown, maxLines = MAX_EXPANDED_CONTENT_LINES): string[] {
  const lines = contentText(result).split("\n").slice(0, maxLines);
  const total = contentText(result).split("\n").length;
  if (total > lines.length) lines.push(`… ${total - lines.length} more line(s) in the result`);
  return lines;
}

function pendingView(tool: ShellToolName, theme: ShellResultViewTheme): ShellResultComponent {
  return viewComponent((width) => [...wrap(theme.fg("muted", `${tool} … (running)`), width)]);
}

// ── Collapsed fallback (preserves Pi's native presentation) ─────────────

/** Pi's fallback preview height for tools without a custom renderResult
 *  (tool-execution.ts createResultFallback). Mirrored, not imported: the
 *  value is part of the presentation this collapsed renderer must preserve. */
const NATIVE_PREVIEW_LINES = 10;

/** Pi's `keyHint` helper, resolvable only inside the host. The hint degrades
 *  to plain wording outside Pi (tests, tooling) — never a hard import: the
 *  package is a host-provided peer, not a dependency of this extension. */
function expandHint(): string {
  try {
    const host = require("@earendil-works/pi-coding-agent") as {
      keyHint?: (keybinding: string, label: string) => string;
    };
    if (typeof host.keyHint === "function") return host.keyHint("app.tools.expand", "to expand");
  } catch {
    /* outside Pi: fall through to the plain label */
  }
  return "to expand";
}

/** The collapsed view wired into the shared expansion mechanism for the Shell
 *  family. These tools previously had NO custom renderResult, so Pi's native
 *  fallback owned both states; this renderer reproduces it so wiring the
 *  shared mechanism extends it instead of replacing it with something weaker:
 *
 *  - collapsed (options.expanded !== true): first NATIVE_PREVIEW_LINES lines
 *    of the model-visible text, then `... (N more lines, <expand hint>)`.
 *  - expanded (options.expanded === true): the full text — this is also the
 *    graceful path when the detail callback throws or returns a
 *    non-component, because the shared wrapper falls back here unchanged.
 *
 *  Like Pi's fallback it renders the raw content text only: no details
 *  parsing, no per-tool framing, nothing invented for error or empty
 *  results (an empty result renders as no lines at all, as native does). */
export function shellCollapsedResultRenderer(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  _context?: unknown,
): ShellResultComponent {
  const expanded = isRecord(options) && options.expanded === true;
  return viewComponent((width) => {
    const text = contentText(result);
    if (text.length === 0) return [];
    const lines = text.split("\n");
    const shown = expanded ? lines : lines.slice(0, NATIVE_PREVIEW_LINES);
    const out = shown.flatMap((line) => wrap(theme.fg("toolOutput", line), width));
    const remaining = lines.length - shown.length;
    if (remaining > 0) {
      out.push(...wrap(theme.fg("muted", `... (${remaining} more lines, ${expandHint()})`), width));
    }
    return out;
  });
}

function missingDetailsView(tool: ShellToolName, result: unknown, theme: ShellResultViewTheme): ShellResultComponent {
  return viewComponent((width) => {
    const lines = [
      ...wrap(theme.fg("muted", `${tool} — expanded view limited: no structured details were recorded with this result`), width),
      ...contentPreview(result).flatMap((l) => wrap(theme.fg("dim", `  ${l}`), width)),
    ];
    return lines;
  });
}

function errorView(tool: ShellToolName, result: unknown, theme: ShellResultViewTheme): ShellResultComponent {
  return viewComponent((width) => {
    const text = truncateText(firstContentLine(result), MAX_ERROR_DISPLAY_CHARS);
    return [
      ...wrap(theme.fg("error", `${tool} · error`), width),
      ...wrap(theme.fg("error", `  ${text || "(error result carried no text)"}`), width),
    ];
  });
}

// ── ShellStart ──────────────────────────────────────────────────────────

export function renderShellStartResult(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  _context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellStart", theme);
  const details = shellDetails(result, "ShellStart");
  if (!details) return missingDetailsView("ShellStart", result, theme);
  if (isErrorResult(result)) return errorView("ShellStart", result, theme);
  return viewComponent((width) => {
    const id = dString(details, "id", 64) ?? "?";
    const label = dString(details, "label", 80) ?? id;
    const lines = [
      ...wrap(theme.fg("toolTitle", `ShellStart · ${id} ${theme.bold(`"${label}"`)}`), width),
    ];
    const command = dString(details, "command", MAX_COMMAND_DISPLAY_CHARS);
    if (command) {
      const commandLines = command.split("\n");
      const shown = commandLines.slice(0, MAX_EXPANDED_COMMAND_LINES);
      lines.push(...shown.flatMap((l) => wrap(theme.fg("dim", `  command: ${l}`), width)));
      if (commandLines.length > shown.length) {
        lines.push(...wrap(theme.fg("dim", `  … ${commandLines.length - shown.length} more command line(s)`), width));
      }
    }
    const pid = dNumber(details, "pid");
    const pgid = dNumber(details, "processGroupId");
    const startedAt = dTimestamp(details, "startedAt");
    const lifecycle = [
      pid !== undefined ? `pid ${pid}` : null,
      // Details omit the process-group id on Windows; keep the line honest.
      process.platform !== "win32" && pgid !== undefined && pgid !== pid
        ? `process group ${pgid}`
        : null,
      startedAt ? `started ${startedAt}` : null,
    ].filter(Boolean);
    if (lifecycle.length > 0) {
      lines.push(...wrap(theme.fg("dim", `  ${lifecycle.join(" · ")}`), width));
    }
    const watching = dString(details, "watching", 512);
    lines.push(...wrap(theme.fg("dim", `  watching: ${watching || "nothing"}`), width));
    return lines;
  });
}

// ── ShellList ───────────────────────────────────────────────────────────

export function renderShellListResult(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  _context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellList", theme);
  const details = shellDetails(result, "ShellList");
  if (!details) return missingDetailsView("ShellList", result, theme);
  if (isErrorResult(result)) return errorView("ShellList", result, theme);
  return viewComponent((width) => {
    const jobs = Array.isArray(details.jobs) ? details.jobs.filter(isRecord) : [];
    const lines = [
      ...wrap(
        theme.fg("toolTitle", `ShellList · ${jobs.length} job(s) at the time of the call`),
        width,
      ),
    ];
    if (jobs.length === 0) {
      lines.push(...wrap(theme.fg("muted", "  no background jobs"), width));
      return lines;
    }
    const shown = jobs.slice(0, MAX_EXPANDED_JOB_ROWS);
    for (const job of shown) {
      const id = typeof job.id === "string" ? job.id : "?";
      const label = typeof job.label === "string" ? truncateText(job.label, 80) : id;
      const status = typeof job.status === "string" ? job.status : "unknown";
      const bits: string[] = [status];
      if (typeof job.exitCode === "number" && Number.isFinite(job.exitCode)) bits.push(`exit ${job.exitCode}`);
      if (typeof job.pid === "number" && Number.isFinite(job.pid) && process.platform !== "win32") {
        bits.push(`pid ${job.pid}`);
      }
      if (typeof job.elapsedMs === "number" && Number.isFinite(job.elapsedMs) && job.elapsedMs >= 0) {
        bits.push(`ran ${formatElapsed(job.elapsedMs)}`);
      }
      if (typeof job.lastOutputAgoMs === "number" && Number.isFinite(job.lastOutputAgoMs)) {
        bits.push(`last output ${formatElapsed(job.lastOutputAgoMs)} before the call`);
      } else {
        bits.push("no output");
      }
      const total = typeof job.totalLines === "number" && Number.isFinite(job.totalLines) ? job.totalLines : undefined;
      const dropped = typeof job.droppedCount === "number" && Number.isFinite(job.droppedCount) ? job.droppedCount : 0;
      if (total !== undefined) {
        bits.push(`${total} line(s)${dropped > 0 ? ` (${dropped} oldest dropped)` : ""}`);
      }
      lines.push(...wrap(theme.fg("dim", `  ${id} ${theme.bold(`"${label}"`)} — ${bits.join(" · ")}`), width));
      const command = typeof job.command === "string" ? truncateText(job.command, MAX_COMMAND_DISPLAY_CHARS) : undefined;
      if (command) {
        const commandLines = command.split("\n").slice(0, MAX_EXPANDED_COMMAND_LINES);
        lines.push(...commandLines.flatMap((l) => wrap(theme.fg("dim", `    command: ${l}`), width)));
        if (command.split("\n").length > commandLines.length) {
          lines.push(...wrap(theme.fg("dim", "    … more command line(s)"), width));
        }
      }
      const watching = typeof job.watching === "string" ? truncateText(job.watching, 512) : "";
      lines.push(...wrap(theme.fg("dim", `    watching: ${watching || "nothing"}`), width));
    }
    if (jobs.length > shown.length) {
      lines.push(...wrap(theme.fg("muted", `  … ${jobs.length - shown.length} more job(s)`), width));
    }
    return lines;
  });
}

// ── ShellLog ────────────────────────────────────────────────────────────

/** The ShellLog body is the retained log text itself, not a second copy of
 *  it: the renderer reads the fenced block back out of the model-visible
 *  content so the expanded view always matches what the call delivered,
 *  including its per-line truncation markers. */
export interface ShellLogBody {
  header: string;
  body: string[];
  /** True when the closing fence was cut by the result cap (the last body
   *  line carries the visible truncation marker). */
  tailCut: boolean;
}

export function parseShellLogText(text: string): ShellLogBody | undefined {
  const lines = text.split("\n");
  const first = lines.indexOf("```");
  if (first === -1) return undefined;
  // The closing fence is real only when it TERMINATES the envelope. An
  // embedded ``` inside the log output must never be mistaken for it, and
  // when the result cap cut the text the fence itself is gone (the last line
  // is a truncated body line) — then everything after the opening fence is
  // body, and the view must say the tail was cut.
  const last = lines.length - 1;
  if (last > first && lines[last] === "```") {
    return { header: lines.slice(0, first).join("\n"), body: lines.slice(first + 1, last), tailCut: false };
  }
  return { header: lines.slice(0, first).join("\n"), body: lines.slice(first + 1), tailCut: true };
}

export function renderShellLogResult(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  _context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellLog", theme);
  const details = shellDetails(result, "ShellLog");
  if (!details) return missingDetailsView("ShellLog", result, theme);
  if (isErrorResult(result)) return errorView("ShellLog", result, theme);
  return viewComponent((width) => {
    const id = dString(details, "id", 64) ?? "?";
    const label = dString(details, "label", 80) ?? id;
    const status = dString(details, "status", 32) ?? "unknown";
    const lines = [
      ...wrap(theme.fg("toolTitle", `ShellLog · ${id} ${theme.bold(`"${label}"`)} · ${status}`), width),
    ];
    const total = dNumber(details, "totalLines");
    const dropped = dNumber(details, "droppedLines") ?? 0;
    const from = dNumber(details, "from");
    const nextOffset = dNumber(details, "nextOffset");
    const range =
      from !== undefined && nextOffset !== undefined
        ? `lines ${from}–${nextOffset}`
        : total !== undefined
          ? "last lines"
          : undefined;
    if (range && total !== undefined) {
      lines.push(
        ...wrap(
          theme.fg("dim", `  ${range} of ${total} line(s)${dropped > 0 ? ` · ${dropped} oldest dropped from the job buffer` : ""}`),
          width,
        ),
      );
    }
    const parsed = parseShellLogText(contentText(result));
    if (!parsed || parsed.body.length === 0) {
      lines.push(...wrap(theme.fg("muted", "  (no lines retained in this range)"), width));
      return lines;
    }
    const body = parsed.body.slice(0, MAX_EXPANDED_LOG_LINES);
    lines.push(
      ...wrap(
        theme.fg("dim", `  ${body.length} line(s), retained output as delivered to the model${parsed.tailCut ? " (cut by the ShellLog result cap)" : ""}`),
        width,
      ),
    );
    for (const line of body) {
      // Verbatim: log content, whitespace, and embedded ANSI escapes survive
      // the wrap; long lines reflow across display lines instead of being
      // cut, so expanding always reveals the whole retained suffix.
      lines.push(...wrap(line, width));
    }
    if (parsed.body.length > body.length) {
      lines.push(...wrap(theme.fg("muted", `  … ${parsed.body.length - body.length} more retained line(s)`), width));
    }
    return lines;
  });
}

// ── ShellSend ───────────────────────────────────────────────────────────

export function renderShellSendResult(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  _context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellSend", theme);
  const details = shellDetails(result, "ShellSend");
  if (!details) return missingDetailsView("ShellSend", result, theme);
  if (isErrorResult(result)) return errorView("ShellSend", result, theme);
  return viewComponent((width) => {
    const id = dString(details, "id", 64) ?? "?";
    const bytes = dNumber(details, "bytes");
    const delivery = dString(details, "delivery", 16);
    const lines = [
      ...wrap(
        theme.fg("toolTitle", `ShellSend · ${id} · ${delivery ?? "unknown delivery"}`),
        width,
      ),
    ];
    if (bytes !== undefined) {
      lines.push(...wrap(theme.fg("dim", `  ${bytes} byte(s) ${delivery === "unconfirmed" ? "queued — delivery NOT confirmed within the flush window" : "written to stdin"}`), width));
    }
    const event = dString(details, "event", 64);
    if (event) lines.push(...wrap(theme.fg("dim", `  event: ${event}`), width));
    const summary = firstContentLine(result);
    if (summary) lines.push(...wrap(theme.fg("dim", `  ${summary}`), width));
    return lines;
  });
}

// ── ShellStop ───────────────────────────────────────────────────────────

export function renderShellStopResult(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  _context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellStop", theme);
  const details = shellDetails(result, "ShellStop");
  if (!details) return missingDetailsView("ShellStop", result, theme);
  if (isErrorResult(result)) return errorView("ShellStop", result, theme);
  return viewComponent((width) => {
    const target = dString(details, "target", 80) ?? "?";
    const outcome = dString(details, "outcome", 32);
    const lines: string[] = [];
    if (target === "all") {
      const count = dNumber(details, "count");
      lines.push(...wrap(theme.fg("toolTitle", `ShellStop · all jobs · stopping ${count ?? "?"} job(s)`), width));
    } else {
      const jobId = dString(details, "jobId", 64) ?? target;
      const label = dString(details, "label", 80) ?? jobId;
      const status = dString(details, "status", 32);
      const heading = outcome === "already-exited"
        ? `${jobId} ${theme.bold(`"${label}"`)} · already exited${status ? ` (${status})` : ""}`
        : `${jobId} ${theme.bold(`"${label}"`)} · stopping`;
      lines.push(...wrap(theme.fg("toolTitle", `ShellStop · ${heading}`), width));
    }
    if (outcome === "stopping") {
      lines.push(...wrap(theme.fg("dim", "  SIGTERM sent to the process group; SIGKILL escalation follows if it ignores that"), width));
    }
    const summary = firstContentLine(result);
    if (summary) lines.push(...wrap(theme.fg("dim", `  ${summary}`), width));
    return lines;
  });
}

// ── Selection ───────────────────────────────────────────────────────────

/** One expanded renderer per Shell tool, keyed by tool name. The shared
 *  foundation (#57) pairs these with the preserved collapsed rendering. */
export const SHELL_EXPANDED_RESULT_RENDERERS: Record<ShellToolName, ShellResultRenderer> = {
  ShellStart: renderShellStartResult,
  ShellList: renderShellListResult,
  ShellLog: renderShellLogResult,
  ShellSend: renderShellSendResult,
  ShellStop: renderShellStopResult,
};

export function shellExpandedRenderer(tool: ShellToolName): ShellResultRenderer {
  return SHELL_EXPANDED_RESULT_RENDERERS[tool];
}