/*
 * Result views for the background shell tool family: ShellStart, ShellList,
 * ShellLog, ShellSend, and ShellStop (#58, restructured by #93).
 *
 * Scope by design: this module owns only the Shell family's render callbacks.
 * The shared collapse/expand plumbing is the result-expansion foundation
 * (#57, src/tool-result-expansion.ts): `expandableResult(collapsedRenderer,
 * expandedRenderer?)` takes a collapsed renderer plus one of these callbacks
 * and returns the native Pi `renderResult` component factory that switches on
 * `options.expanded`, falling back to the collapsed view whenever the detail
 * callback throws or returns a non-component. `src/background-shell/index.ts`
 * wires every Shell* registration through it with this module's per-tool
 * collapsed view plus the matching expanded detail callback — no other
 * expansion helper, key handler, or state exists in this family.
 *
 * #93 contract (#93 canonical Shell examples 1–5):
 *
 * - Collapsed means a concise, actionable structured summary: job identity,
 *   state, command preview with a truthful line-omission count, pid/started,
 *   wake rules; for ShellLog the returned range plus a bounded preview of the
 *   LAST few already-returned lines; for ShellSend the delivery outcome and
 *   the recorded input; for ShellStop the affected target list.
 * - Expanded means the complete actual inputs and the meaningful retained
 *   result: the full recorded command (never the legacy 512-character or
 *   4-line preview cuts), every returned log line, the full sent stdin
 *   payload, the stop-all target list. No preview limit may survive into an
 *   expanded view.
 * - The toggle hint itself is NOT rendered here. The shared wrapper adds the
 *   native `(ctrl+o to expand)` / `(ctrl+o to collapse)` hint centrally, with
 *   the configured binding; family renderers emit only the desired header and
 *   body so the hint cannot be duplicated or stale.
 * - Anything the model received or submitted is shown to the human without an
 *   additional redaction or truncation layer: the full command (including any
 *   secret-shaped text) and the full sent stdin input are rendered verbatim —
 *   on failed and legacy expanded cards too, where the input is labeled as
 *   submitted (no execution, acceptance, or child-processing claim) and the
 *   retained error text is rendered completely. Protections applied before
 *   information reaches the model are unchanged.
 * - Sources, in preference order: recorded native render `context.args`
 *   (the original tool-call arguments — the complete command for ShellStart,
 *   the sent text for ShellSend) over result-detail copies, which are kept
 *   only as an untruncated fallback for records rendered without a context.
 *   Data recorded at execution time (pid, ranges, delivery outcomes, the
 *   stop-all target snapshot) comes from the result details. Fields a legacy
 *   record genuinely lacks are disclosed as unavailable, never fabricated.
 * - Expansion is display-only. Every expanded view renders data the tool
 *   result already retains — the model-facing `content` text plus the
 *   `details` metadata captured at call time — plus the recorded call
 *   arguments. Nothing is re-read, re-fetched, or reconstructed from live job
 *   state, so a restored session renders exactly the bounded snapshot the
 *   call recorded, including its truncation markers, ranges, and drop counts.
 *   A stop result says "stopping; process exit is not yet confirmed" and a
 *   ShellSend acknowledgment never claims child processing.
 *
 * Every renderer is defensive about its input (session restore can hand it a
 * result recorded before structured details existed — such records fall back
 * to a bounded preview collapsed and the complete retained text expanded)
 * and about its budget: all text is wrapped into terminal-cell-safe display
 * lines (wide CJK/emoji glyphs and ANSI escapes handled) so no rendered line
 * can exceed the terminal width.
 */
import { truncateText } from "./jobs";

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
/** Command lines shown in the COLLAPSED ShellStart preview. Expansion shows
 *  every line — no cap survives into an expanded view. */
const COLLAPSED_COMMAND_PREVIEW_LINES = 4;
/** Wrapped display rows of the already-returned log range shown in the
 *  COLLAPSED ShellLog preview. Per the #93 ShellLog refinement the preview is
 *  the TAIL of the returned range (native-bash-style), with a truthful
 *  earlier-lines omission count; expansion shows the complete returned range. */
const COLLAPSED_LOG_TAIL_ROWS = 6;
/** Character cap for the input preview in the COLLAPSED ShellSend card; the
 *  expanded view renders the full recorded input without this cut. */
const COLLAPSED_INPUT_PREVIEW_CHARS = 200;
/** Job rows shown in one collapsed ShellList render. */
const COLLAPSED_JOB_ROWS = 16;

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

/** The recorded tool-call arguments from the native render context
 *  (documented host contract: `context.args` is the current call's
 *  arguments). Undefined when absent or not an object. */
function contextArgsOf(context: unknown): Record<string, any> | undefined {
  if (!isRecord(context)) return undefined;
  const args = context.args;
  return isRecord(args) ? args : undefined;
}

/** The complete recorded command, preferring the original call arguments over
 *  the result-details snapshot (which exists only as an untruncated fallback
 *  for records rendered without a render context). */
function commandOf(details: Record<string, any> | undefined, context: unknown): string | undefined {
  const args = contextArgsOf(context);
  if (args && typeof args.command === "string" && args.command.trim().length > 0) return args.command;
  return details && typeof details.command === "string" && details.command.length > 0
    ? details.command
    : undefined;
}

/** The actual bytes sent to the job's stdin. The send path appends a newline
 *  unless the submitted text already ends with one, so the recorded call
 *  argument yields the exact payload without duplicating it into details. */
function sentInputOf(details: Record<string, any> | undefined, context: unknown): string | undefined {
  const args = contextArgsOf(context);
  if (args && typeof args.text === "string") {
    return args.text.endsWith("\n") ? args.text : `${args.text}\n`;
  }
  return details && typeof details.input === "string" ? details.input : undefined;
}

/** Truthful unavailable-field wording, used instead of fabricating a value. */
const UNAVAILABLE = "unavailable in the recorded result";

/** Compact state label for headers and rows: an exit code recorded by the
 *  call is rendered as `exited N` (the canonical Shell card wording). */
function stateWithCode(status: string | undefined, exitCode: number | undefined): string {
  if (exitCode !== undefined) return `exited ${exitCode}`;
  return status || "unknown";
}

/** State label for `State:` lines: an exit code recorded by the call means
 *  the process has exited; the code itself is shown on its own line. */
function displayState(status: string | undefined, exitCode: number | undefined): string {
  if (exitCode !== undefined) return "exited";
  return status || "unknown";
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
// terminal CELLS with a grapheme-aware walk (its visibleWidth measures each
// Intl.Segmenter cluster: emoji and East Asian wide glyphs occupy two cells,
// zero-width clusters none). The shell family renders arbitrary child-process
// output, so measurement and wrapping here mirror that established host
// algorithm rather than trusting the char-count approximation in width.ts
// (that one is only safe for the widget content it was built for).

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Code points pi-tui's width guard counts as two terminal cells: the wide /
 *  fullwidth ranges of get-east-asian-width (pi-tui's dependency), mirrored
 *  so wrap decisions agree with the host exactly — including default-emoji
 *  glyphs like ⏰ U+23F0 and ✅ U+2705 that the review pass 1 table missed.
 *  The four coarse emoji-block ranges are a superset of the fine-grained
 *  entries so engines without RGI_Emoji support (see below) still err toward
 *  counting MORE cells, which wraps earlier and can never emit an over-width
 *  line. Re-verify against the installed pi host when it upgrades. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x231a, 0x231b], // ⌚ ⌛
  [0x2329, 0x232a], // angle brackets
  [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], // media controls incl. ⏰
  [0x25fd, 0x25fe], // ◽ ◾
  [0x2614, 0x2615], [0x2630, 0x2637], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x268a, 0x268f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab],
  [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4],
  [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], // misc symbols
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], // dingbats incl. ✅
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], // ⬛ ⬜ ⭐ ⭕
  [0x2e80, 0x2e99], [0x2e9b, 0x2ef3], // CJK radicals supplement
  [0x2f00, 0x2fd5], [0x2ff0, 0x2fff], // Kangxi radicals, ideographic description
  [0x3000, 0x3000], [0x3001, 0x303e], // fullwidth space, CJK punctuation
  [0x3041, 0x3096], [0x3099, 0x30ff], // Hiragana, Katakana
  [0x3105, 0x312f], [0x3131, 0x318e], [0x3190, 0x31e5], // Bopomofo, Hangul compat jamo
  [0x31ef, 0x321e], [0x3220, 0x3247], // enclosed CJK letters and numbers
  [0x3250, 0xa48c], // CJK symbols … Yi syllables
  [0xa490, 0xa4c6], // Yi radicals
  [0xa960, 0xa97f], // Hangul Jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe52], [0xfe54, 0xfe66], [0xfe68, 0xfe6b], // CJK compatibility forms
  [0xff01, 0xff60], [0xffe0, 0xffe6], // fullwidth forms
  [0x16fe0, 0x16fe4], [0x16ff0, 0x16ff6], // Canadian Aboriginal syllabics
  [0x17000, 0x18cd5], [0x18cff, 0x18d1e], [0x18d80, 0x18df2], // Tangut …
  [0x1aff0, 0x1aff3], [0x1aff5, 0x1affb], [0x1affd, 0x1affe], // Kaktovik numerals
  [0x1b000, 0x1b122], [0x1b132, 0x1b132], [0x1b150, 0x1b152], [0x1b155, 0x1b155],
  [0x1b164, 0x1b167], [0x1b170, 0x1b2fb], // Balinese
  [0x1d300, 0x1d356], [0x1d360, 0x1d376], // musical symbols
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], // 🀄 🃏
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], // enclosed symbols
  [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248],
  [0x1f250, 0x1f251], [0x1f260, 0x1f265], // enclosed CJK
  [0x1f300, 0x1f64f], // Misc Symbols and Pictographs + Emoticons
  [0x1f680, 0x1f6ff], // Transport and Map Symbols
  [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0], // Geometric Shapes Extended
  [0x1f900, 0x1f9ff], // Supplemental Symbols and Pictographs
  [0x1fa70, 0x1faff], // Symbols and Pictographs Extended-A (🫠 U+1FAE0 …)
  [0x20000, 0x3fffd], // CJK ext B+ / plane 3
];

// pi-tui measures emoji with the RGI_Emoji Unicode property. Engines without
// it fall back to sequence markers plus the coarse emoji-block ranges above;
// both paths err toward counting MORE cells, which wraps earlier and can
// never emit an over-width line.
let rgiEmojiRegex: RegExp | null = null;
try {
  rgiEmojiRegex = new RegExp("^\\p{RGI_Emoji}$", "v");
} catch {
  rgiEmojiRegex = null;
}

// Per-code-point non-printing classes. (The v-flag property escapes pi-tui
// uses need an ES2024 target; these u-flag equivalents cover the same sets,
// with unpaired surrogates handled by explicit range since they are not a
// standard Unicode property.)
const ZERO_WIDTH_CP = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Mark}]$/u;
const NON_PRINTING_CP = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}]$/u;

function isZeroWidthCp(cp: number): boolean {
  return (cp >= 0xd800 && cp <= 0xdfff) || ZERO_WIDTH_CP.test(String.fromCodePoint(cp));
}

/** True when every code point of the cluster renders no cell of its own. */
function isZeroWidthCluster(grapheme: string): boolean {
  for (const ch of grapheme) {
    if (!isZeroWidthCp(ch.codePointAt(0)!)) return false;
  }
  return true;
}

/** Drop leading non-printing code points to find the cluster's base glyph. */
function stripLeadingNonPrinting(grapheme: string): string {
  let i = 0;
  while (i < grapheme.length) {
    const cp = grapheme.codePointAt(i)!;
    if (!(isZeroWidthCp(cp) || NON_PRINTING_CP.test(String.fromCodePoint(cp)))) break;
    i += cp > 0xffff ? 2 : 1;
  }
  return grapheme.slice(i);
}

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** True for graphemes terminals render as one two-cell emoji: RGI sequences
 *  (ZWJ families, flags, keycaps, tag sequences) — including default-emoji
 *  glyphs like ⏰ U+23F0 and ✅ U+2705. Without RGI_Emoji support the
 *  sequence markers are the conservative stand-in; base-glyph width then
 *  comes from WIDE_RANGES in graphemeCells. */
function isEmojiGrapheme(grapheme: string): boolean {
  if (rgiEmojiRegex !== null) return rgiEmojiRegex.test(grapheme);
  for (const ch of grapheme) {
    const cp = ch.codePointAt(0)!;
    // VS16 forces emoji presentation; ZWJ/keycap/tag sequences are emoji.
    if (cp === 0xfe0f || cp === 0x200d || cp === 0x20e3 || (cp >= 0xe0020 && cp <= 0xe007f)) return true;
  }
  return false;
}

/** Terminal cells occupied by one grapheme cluster: two for emoji and East
 *  Asian wide glyphs, zero for combining-only clusters, else one. */
function graphemeCells(grapheme: string): number {
  if (grapheme === "\t") return 3; // pi-tui's layout width for tabs
  if (isZeroWidthCluster(grapheme)) return 0;
  if (isEmojiGrapheme(grapheme)) return 2;
  const base = stripLeadingNonPrinting(grapheme);
  const cp = base.codePointAt(0);
  if (cp === undefined) return 0;
  // Regional indicators render two cells in terminals even when isolated.
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 2;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

/** Split a line into zero-width escape tokens and visible graphemes so
 *  measurement and wrapping walk the same cells pi-tui counts. */
type WrapToken =
  | { kind: "sgr"; value: string }
  | { kind: "escape"; value: string }
  | { kind: "grapheme"; value: string };

/** Split a line into zero-width escape tokens and visible graphemes so
 *  measurement and wrapping walk the same cells pi-tui counts. The ESC
 *  handling mirrors pi-tui's extractAnsiCode exactly — the host width guard
 *  strips only CSI sequences ending in [mGKHJ] and OSC/APC payloads with a
 *  BEL or ST (ESC backslash) terminator; anything else (standalone ESC,
 *  charset designations like ESC(B, DCS, unterminated OSC) is counted by the
 *  guard as visible text, so consuming more would under-measure and could
 *  emit over-width lines. Every path advances at least one position, so no
 *  input can stall the walk. */
function tokenizeLine(line: string): WrapToken[] {
  const tokens: WrapToken[] = [];
  let i = 0;
  while (i < line.length) {
    let consumedEscape = false;
    if (line[i] === "\x1b") {
      const next = line[i + 1];
      if (next === "[") {
        // CSI: consume through the first final byte in [mGKHJ].
        let j = i + 2;
        while (j < line.length && !/[mGKHJ]/.test(line[j]!)) j++;
        if (j < line.length) {
          tokens.push({ kind: line[j] === "m" ? "sgr" : "escape", value: line.slice(i, j + 1) });
          i = j + 1;
          consumedEscape = true;
        }
      } else if (next === "]" || next === "_") {
        // OSC / APC: consume through BEL or ST (ESC backslash).
        let j = i + 2;
        while (j < line.length && !(line[j] === "\x07" || (line[j] === "\x1b" && line[j + 1] === "\\"))) j++;
        if (line[j] === "\x07") {
          tokens.push({ kind: "escape", value: line.slice(i, j + 1) });
          i = j + 1;
          consumedEscape = true;
        } else if (line[j] === "\x1b" && line[j + 1] === "\\") {
          tokens.push({ kind: "escape", value: line.slice(i, j + 2) });
          i = j + 2;
          consumedEscape = true;
        }
      }
    }
    if (!consumedEscape) {
      // line[i] may itself be an unmatched ESC — include it in the run (it
      // measures zero cells as a control character; the bytes after it are
      // visible text, exactly as the host guard counts them).
      let end = i + 1;
      while (end < line.length && line[end] !== "\x1b") end++;
      for (const { segment } of graphemeSegmenter.segment(line.slice(i, end))) {
        tokens.push({ kind: "grapheme", value: segment });
      }
      i = end;
    }
  }
  return tokens;
}

/** Visible terminal-cell width of a line: ANSI/OSC escapes are ignored, wide
 *  glyphs and emoji count two cells each. Exported for width-safe test
 *  assertions. */
export function visibleCells(line: string): number {
  let cells = 0;
  for (const token of tokenizeLine(line)) {
    if (token.kind === "grapheme") cells += graphemeCells(token.value);
  }
  return cells;
}

/** Wrap one line (already-themed or plain) into display lines that never
 *  exceed `width` terminal cells. Formatting is preserved, not cut:
 *  whitespace and embedded ANSI escapes survive the wrap, styles are
 *  re-applied at the start of every continuation line (Pi resets styling at
 *  each rendered line), and grapheme clusters stay intact — a ZWJ emoji
 *  sequence is one two-cell unit, never split mid-sequence.
 *
 *  Display-only adjustments, both necessary for honest width math: CR is
 *  stripped (a CRLF stream would otherwise move the cursor) and tabs are
 *  expanded to four spaces (tab stop positions are terminal-dependent, so a
 *  raw tab cannot be measured). The model-visible text is untouched. A single
 *  grapheme wider than the whole row (possible only at pathologically narrow
 *  widths) is substituted with one placeholder cell rather than emitted as an
 *  over-width line that would trip pi-tui's width guard. */
export function wrapToWidth(line: string, width: number): string[] {
  if (width <= 0) return [];
  const prepared = line.replace(/\r/g, "").replace(/\t/g, "    ");
  if (visibleCells(prepared) <= width) return [prepared];
  const out: string[] = [];
  let current = "";
  let cells = 0;
  let activeSgr = "";
  for (const token of tokenizeLine(prepared)) {
    if (token.kind === "sgr") {
      current += token.value;
      activeSgr = token.value === "\x1b[0m" || token.value === "\x1b[m" ? "" : token.value;
      continue;
    }
    if (token.kind === "escape") {
      current += token.value;
      continue;
    }
    const gCells = graphemeCells(token.value);
    if (gCells > width) {
      // One grapheme wider than the whole row: close the current line and
      // substitute a bounded placeholder instead of emitting over-width.
      if (cells > 0) {
        out.push(activeSgr ? `${current}\x1b[0m` : current);
        current = activeSgr;
        cells = 0;
      }
      current += "?";
      cells += 1;
      continue;
    }
    if (cells > 0 && cells + gCells > width) {
      // Break: re-apply the in-flight style at the start of the next line
      // (Pi resets styling at line ends) and close this one.
      out.push(activeSgr ? `${current}\x1b[0m` : current);
      current = activeSgr;
      cells = 0;
    }
    current += token.value;
    cells += gCells;
  }
  if (current.length > 0 || out.length === 0) out.push(current);
  return out;
}

/** Wrap an already-themed line into width-safe display lines. */
function wrap(line: string, width: number): string[] {
  return wrapToWidth(line, width);
}

function pendingView(tool: ShellToolName, theme: ShellResultViewTheme): ShellResultComponent {
  return viewComponent((width) => [...wrap(theme.fg("muted", `${tool} … (running)`), width)]);
}

// ── Legacy-record and degraded views ────────────────────────────────────

/** Pi's fallback preview height for tools without a custom renderResult
 *  (tool-execution.ts createResultFallback). Mirrored, not imported: the
 *  value is part of the presentation this legacy preview must preserve.
 *  It bounds WRAPPED DISPLAY ROWS, not logical lines: shell output carries
 *  up-to-2048-char lines that each reflow to many display rows, so a logical
 *  cap applied before wrapping would let the "preview" grow without bound. */
const NATIVE_PREVIEW_LINES = 10;

/** Collapsed view for results recorded before structured details existed
 *  (restored sessions): a bounded preview of the retained model-visible text,
 *  like the native fallback — plus a truthful omission marker WITHOUT any
 *  toggle hint, which the shared wrapper owns. An empty record renders
 *  nothing, as the native fallback does. */
function legacyPreviewView(_tool: ShellToolName, result: unknown, theme: ShellResultViewTheme): ShellResultComponent {
  return viewComponent((width) => {
    const text = contentText(result);
    if (text.length === 0) return [];
    const all = text.split("\n").flatMap((line) => wrap(theme.fg("toolOutput", line), width));
    if (all.length <= NATIVE_PREVIEW_LINES) return all;
    const omitted = all.length - NATIVE_PREVIEW_LINES;
    return [
      ...all.slice(0, NATIVE_PREVIEW_LINES),
      ...wrap(theme.fg("muted", `... (${omitted} more line${omitted === 1 ? "" : "s"})`), width),
    ];
  });
}

/** Full retained content, wrapped: the complete model-visible record. Used by
 *  the expanded legacy view and by the degraded path when a detail callback
 *  fails (the shared wrapper then re-runs the collapsed renderer with
 *  expanded=true). No preview cut applies — the recorded text is the complete
 *  model-visible record, and hiding any of it would misrepresent the call. */
function fullContentLines(result: unknown, theme: ShellResultViewTheme, width: number): string[] {
  const text = contentText(result);
  if (text.length === 0) return [];
  return text.split("\n").flatMap((line) => wrap(theme.fg("toolOutput", line), width));
}

/** Collapsed/degraded view of the full retained content (the shared wrapper
 *  re-runs the collapsed renderer with expanded=true when a detail callback
 *  fails). */
function fullContentView(result: unknown, theme: ShellResultViewTheme): ShellResultComponent {
  return viewComponent((width) => fullContentLines(result, theme, width));
}

/** A recorded call input rendered on failed or legacy expanded cards. The
 *  wording ("submitted") makes no execution or delivery claim — the input the
 *  model supplied is shown in full even when the operation did not start or
 *  the write was not accepted. */
interface SubmittedInput {
  heading: string;
  text: string;
}

/** The submitted command for failed/legacy ShellStart cards, when recorded. */
function submittedCommand(details: Record<string, any> | undefined, context: unknown): SubmittedInput | undefined {
  const command = commandOf(details, context);
  return command ? { heading: "Command submitted:", text: command } : undefined;
}

/** The submitted stdin text for failed/legacy ShellSend cards, when recorded. */
function submittedInput(details: Record<string, any> | undefined, context: unknown): SubmittedInput | undefined {
  const input = sentInputOf(details, context);
  return input ? { heading: "Input submitted:", text: JSON.stringify(input) } : undefined;
}

/** Render a submitted-input block: the complete recorded text, wrapped, no
 *  display cut. Every line keeps the input's multiline structure. */
function submittedLines(submitted: SubmittedInput, theme: ShellResultViewTheme, width: number): string[] {
  const lines = [...wrap(theme.fg("toolOutput", submitted.heading), width)];
  for (const line of submitted.text.split("\n")) {
    lines.push(...wrap(theme.fg("toolOutput", line), width));
  }
  return lines;
}

/** Expanded view for a result without structured details: discloses the
 *  limitation truthfully, renders the complete recorded call input when one
 *  is available (labeled as submitted — no execution/delivery claim), then
 *  the complete retained text so nothing the model received is hidden. */
function legacyExpandedView(
  tool: ShellToolName,
  result: unknown,
  theme: ShellResultViewTheme,
  submitted?: SubmittedInput,
): ShellResultComponent {
  return viewComponent((width) => [
    ...wrap(theme.fg("muted", `${tool} — expanded view limited: no structured details were recorded with this result`), width),
    ...(submitted ? submittedLines(submitted, theme, width) : []),
    ...fullContentLines(result, theme, width),
  ]);
}

function errorView(
  tool: ShellToolName,
  result: unknown,
  theme: ShellResultViewTheme,
  submitted?: SubmittedInput,
): ShellResultComponent {
  return viewComponent((width) => {
    const lines = [...wrap(theme.fg("error", `${tool} · error`), width)];
    if (submitted) lines.push(...submittedLines(submitted, theme, width));
    // Complete retained error text: every line the result carries, with no
    // presentation cap (the producer already applied its own bounded cut,
    // visible in the text itself).
    const text = contentText(result);
    if (text.length === 0) {
      lines.push(...wrap(theme.fg("error", "  (error result carried no text)"), width));
    } else {
      for (const line of text.split("\n")) {
        lines.push(...wrap(theme.fg("error", line), width));
      }
    }
    return lines;
  });
}

// ── ShellStart ──────────────────────────────────────────────────────────

/** Collapsed #93 canonical example 1: identity, state, a bounded command
 *  preview with a truthful omission count, pid/started, and the wake rules. */
export function shellStartCollapsedView(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellStart", theme);
  const details = shellDetails(result, "ShellStart");
  const expanded = isRecord(options) && options.expanded === true;
  if (!details) {
    return expanded ? legacyExpandedView("ShellStart", result, theme) : legacyPreviewView("ShellStart", result, theme);
  }
  if (expanded) return fullContentView(result, theme); // degraded detail-renderer fallback
  if (isErrorResult(result)) return errorView("ShellStart", result, theme);
  return viewComponent((width) => {
    const id = dString(details, "id", 64) ?? "?";
    const label = dString(details, "label", 80) ?? id;
    // State is recorded at call time; a legacy structured record without it
    // says so instead of claiming "running".
    const state = dString(details, "state", 32);
    const lines = [
      ...wrap(theme.fg("toolTitle", `ShellStart · ${id} ${theme.bold(`"${label}"`)}${state ? ` · ${state}` : " · state unavailable in the recorded result"}`), width),
    ];
    const command = commandOf(details, context);
    if (command) {
      const commandLines = command.split("\n");
      const shown = commandLines.slice(0, COLLAPSED_COMMAND_PREVIEW_LINES);
      lines.push(...wrap(theme.fg("dim", "  command:"), width));
      lines.push(...shown.flatMap((l) => wrap(theme.fg("dim", `    ${l}`), width)));
      if (commandLines.length > shown.length) {
        lines.push(...wrap(theme.fg("dim", `    … ${commandLines.length - shown.length} more command line(s)`), width));
      }
    } else {
      lines.push(...wrap(theme.fg("muted", `  command: ${UNAVAILABLE}`), width));
    }
    const pid = dNumber(details, "pid");
    const pgid = dNumber(details, "processGroupId");
    const startedAt = dTimestamp(details, "startedAt");
    const lifecycle = [
      pid !== undefined ? `pid ${pid}` : `pid ${UNAVAILABLE}`,
      // Details omit the process-group id on Windows; keep the line honest.
      process.platform !== "win32" && pgid !== undefined && pgid !== pid
        ? `process group ${pgid}`
        : null,
      startedAt ? `started ${startedAt}` : `started ${UNAVAILABLE}`,
    ].filter(Boolean);
    lines.push(...wrap(theme.fg("dim", `  ${lifecycle.join(" · ")}`), width));
    const watching = dString(details, "watching", 512);
    lines.push(...wrap(theme.fg("dim", `  watching: ${watching || "nothing"}`), width));
    return lines;
  });
}

/** Expanded #93 canonical example 1: the complete recorded command (beyond
 *  the legacy 512-character / 4-line preview cuts) plus the returned
 *  execution details. */
export function renderShellStartResult(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellStart", theme);
  const details = shellDetails(result, "ShellStart");
  // Failed and legacy records keep the complete recorded call input visible,
  // labeled as submitted — a failed start never claims execution.
  if (!details) return legacyExpandedView("ShellStart", result, theme, submittedCommand(undefined, context));
  if (isErrorResult(result)) return errorView("ShellStart", result, theme, submittedCommand(details, context));
  return viewComponent((width) => {
    const id = dString(details, "id", 64) ?? "?";
    const label = dString(details, "label", 80) ?? id;
    const state = dString(details, "state", 32);
    const lines = [
      ...wrap(
        theme.fg("toolTitle", `ShellStart · ${id} ${theme.bold(`"${label}"`)}${state ? ` · ${state}` : ""}`),
        width,
      ),
    ];
    const command = commandOf(details, context);
    if (command) {
      lines.push(...wrap(theme.fg("toolOutput", "Command:"), width));
      for (const line of command.split("\n")) {
        // Verbatim, complete: every line of the recorded call command,
        // wrapped to the terminal width, never cut.
        lines.push(...wrap(theme.fg("toolOutput", line), width));
      }
    } else {
      lines.push(...wrap(theme.fg("muted", `Command: ${UNAVAILABLE}`), width));
    }
    lines.push("");
    const pid = dNumber(details, "pid");
    const pgid = dNumber(details, "processGroupId");
    const startedAt = dTimestamp(details, "startedAt");
    lines.push(...wrap(theme.fg("dim", `PID: ${pid !== undefined ? pid : UNAVAILABLE}`), width));
    if (process.platform !== "win32" && pgid !== undefined && pgid !== pid) {
      lines.push(...wrap(theme.fg("dim", `Process group: ${pgid}`), width));
    }
    lines.push(...wrap(theme.fg("dim", `Started: ${startedAt ?? UNAVAILABLE}`), width));
    const watching = dString(details, "watching", 512);
    lines.push(...wrap(theme.fg("dim", `Wake rules: ${watching || "nothing"}`), width));
    lines.push(...wrap(theme.fg("dim", `State: ${state ? `${state} when this call returned` : UNAVAILABLE}`), width));
    return lines;
  });
}

// ── ShellList ───────────────────────────────────────────────────────────

/** Collapsed #93 canonical example 2: count and one actionable row per job. */
export function shellListCollapsedView(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  _context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellList", theme);
  const details = shellDetails(result, "ShellList");
  const expanded = isRecord(options) && options.expanded === true;
  if (!details) {
    return expanded ? legacyExpandedView("ShellList", result, theme) : legacyPreviewView("ShellList", result, theme);
  }
  if (expanded) return fullContentView(result, theme); // degraded detail-renderer fallback
  if (isErrorResult(result)) return errorView("ShellList", result, theme);
  return viewComponent((width) => {
    const jobs = Array.isArray(details.jobs) ? details.jobs.filter(isRecord) : [];
    const lines = [
      ...wrap(theme.fg("toolTitle", `ShellList · ${jobs.length} job${jobs.length === 1 ? "" : "s"}`), width),
    ];
    if (jobs.length === 0) {
      lines.push(...wrap(theme.fg("muted", "  no background jobs"), width));
      return lines;
    }
    const shown = jobs.slice(0, COLLAPSED_JOB_ROWS);
    for (const job of shown) {
      const id = typeof job.id === "string" ? job.id : "?";
      const label = typeof job.label === "string" ? truncateText(job.label, 80) : id;
      const status = typeof job.status === "string" ? job.status : "unknown";
      const exitCode = typeof job.exitCode === "number" && Number.isFinite(job.exitCode) ? job.exitCode : undefined;
      lines.push(
        ...wrap(theme.fg("dim", `  ${id} ${theme.bold(`"${label}"`)} · ${stateWithCode(status, exitCode)}`), width),
      );
    }
    if (jobs.length > shown.length) {
      lines.push(...wrap(theme.fg("muted", `  … ${jobs.length - shown.length} more job(s)`), width));
    }
    return lines;
  });
}

/** Expanded #93 canonical example 2: every job with its complete recorded
 *  command (the returned snapshot, not a live lookup) and retention counts. */
export function renderShellListResult(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  _context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellList", theme);
  const details = shellDetails(result, "ShellList");
  if (!details) return legacyExpandedView("ShellList", result, theme);
  if (isErrorResult(result)) return errorView("ShellList", result, theme);
  return viewComponent((width) => {
    const jobs = Array.isArray(details.jobs) ? details.jobs.filter(isRecord) : [];
    const lines = [
      ...wrap(theme.fg("toolTitle", `ShellList · ${jobs.length} job${jobs.length === 1 ? "" : "s"}`), width),
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
      const exitCode = typeof job.exitCode === "number" && Number.isFinite(job.exitCode) ? job.exitCode : undefined;
      lines.push(...wrap(theme.fg("toolOutput", `${id} ${theme.bold(`"${label}"`)}`), width));
      const command = typeof job.command === "string" && job.command.length > 0 ? job.command : undefined;
      if (command) {
        // Complete recorded command: no display cut. Multiline commands keep
        // their structure.
        if (command.includes("\n")) {
          lines.push(...wrap(theme.fg("dim", "  Command:"), width));
          for (const line of command.split("\n")) {
            lines.push(...wrap(theme.fg("dim", `    ${line}`), width));
          }
        } else {
          lines.push(...wrap(theme.fg("dim", `  Command: ${command}`), width));
        }
      } else {
        lines.push(...wrap(theme.fg("dim", `  Command: ${UNAVAILABLE}`), width));
      }
      lines.push(...wrap(theme.fg("dim", `  State: ${displayState(status, exitCode)}`), width));
      if (exitCode !== undefined) {
        lines.push(...wrap(theme.fg("dim", `  Exit code: ${exitCode}`), width));
      }
      if (typeof job.pid === "number" && Number.isFinite(job.pid) && process.platform !== "win32") {
        lines.push(...wrap(theme.fg("dim", `  PID: ${job.pid}`), width));
      }
      const total = typeof job.totalLines === "number" && Number.isFinite(job.totalLines) ? job.totalLines : undefined;
      const dropped = typeof job.droppedCount === "number" && Number.isFinite(job.droppedCount) ? job.droppedCount : 0;
      if (total !== undefined) {
        lines.push(...wrap(theme.fg("dim", `  Retained output: ${Math.max(0, total - dropped)} line(s)`), width));
      }
      if (total !== undefined) {
        lines.push(...wrap(theme.fg("dim", `  Dropped output: ${dropped} line(s)`), width));
      }
      const watching = typeof job.watching === "string" ? truncateText(job.watching, 512) : "";
      lines.push(...wrap(theme.fg("dim", `  Wake rules: ${watching || "nothing"}`), width));
      lines.push("");
    }
    if (jobs.length > shown.length) {
      lines.push(...wrap(theme.fg("muted", `  … ${jobs.length - shown.length} more job(s)`), width));
      lines.push("");
    }
    lines.push(...wrap(theme.fg("muted", "Snapshot: state recorded by this list call"), width));
    return lines;
  });
}

// ── ShellLog ────────────────────────────────────────────────────────────

/** The ShellLog body is the retained log text itself, not a second copy of
 *  it: the renderer reads the fenced block back out of the model-visible
 *  content so the views always match what the call delivered, including its
 *  per-line truncation markers. */
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

/** Tail preview for the collapsed ShellLog card (#93 refinement): the LAST
 *  few wrapped rows of the ALREADY RETURNED range, with a truthful count of
 *  the earlier returned lines omitted from the preview. At least the final
 *  line is always shown. No data is fetched or re-read. */
function tailPreview(body: string[], width: number): { shown: string[]; omitted: number } {
  const out: string[] = [];
  let idx = body.length;
  let rows = 0;
  while (idx > 0) {
    const wrappedLine = wrapToWidth(body[idx - 1]!, width);
    if (rows > 0 && rows + wrappedLine.length > COLLAPSED_LOG_TAIL_ROWS) break;
    rows += wrappedLine.length;
    idx -= 1;
    out.unshift(...wrappedLine);
  }
  return { shown: out, omitted: idx };
}

/** Collapsed #93 canonical example 3 (with the #93 ShellLog tail refinement):
 *  identity, state, the returned range with the genuine dropped-lines note,
 *  then a bounded preview of the LAST lines of the returned range. */
export function shellLogCollapsedView(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  _context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellLog", theme);
  const details = shellDetails(result, "ShellLog");
  const expanded = isRecord(options) && options.expanded === true;
  if (!details) {
    return expanded ? legacyExpandedView("ShellLog", result, theme) : legacyPreviewView("ShellLog", result, theme);
  }
  if (expanded) return fullContentView(result, theme); // degraded detail-renderer fallback
  if (isErrorResult(result)) return errorView("ShellLog", result, theme);
  return viewComponent((width) => {
    const id = dString(details, "id", 64) ?? "?";
    const label = dString(details, "label", 80) ?? id;
    const status = dString(details, "status", 32);
    const exitCode = dNumber(details, "exitCode");
    const dropped = dNumber(details, "droppedLines") ?? 0;
    const from = dNumber(details, "from");
    const nextOffset = dNumber(details, "nextOffset");
    const lines = [
      ...wrap(theme.fg("toolTitle", `ShellLog · ${id} ${theme.bold(`"${label}"`)} · ${stateWithCode(status, exitCode)}`), width),
    ];
    if (from !== undefined && nextOffset !== undefined) {
      lines.push(...wrap(theme.fg("dim", `  Returned lines: ${from}–${nextOffset} · dropped: ${dropped}`), width));
    }
    const parsed = parseShellLogText(contentText(result));
    if (!parsed || parsed.body.length === 0) {
      lines.push(...wrap(theme.fg("muted", "  (no lines retained in this range)"), width));
      return lines;
    }
    // Genuine upstream retention notices survive into the collapsed card.
    if (parsed.tailCut) {
      lines.push(...wrap(theme.fg("muted", "  (result cut by the ShellLog result cap)"), width));
    }
    const { shown, omitted } = tailPreview(parsed.body, width);
    if (omitted > 0) {
      lines.push(...wrap(theme.fg("muted", `  … ${omitted} earlier returned line${omitted === 1 ? "" : "s"}`), width));
    }
    lines.push(...shown);
    return lines;
  });
}

/** Expanded #93 canonical example 3: the request selectors, the returned
 *  range provenance, and EVERY retained line of the returned range —
 *  verbatim, with formatting; no re-fetch, and no invented stdout/stderr
 *  split (capture merged the streams). */
export function renderShellLogResult(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  _context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellLog", theme);
  const details = shellDetails(result, "ShellLog");
  if (!details) return legacyExpandedView("ShellLog", result, theme);
  if (isErrorResult(result)) return errorView("ShellLog", result, theme);
  return viewComponent((width) => {
    const id = dString(details, "id", 64) ?? "?";
    const label = dString(details, "label", 80) ?? id;
    const status = dString(details, "status", 32);
    const exitCode = dNumber(details, "exitCode");
    const total = dNumber(details, "totalLines");
    const dropped = dNumber(details, "droppedLines");
    const from = dNumber(details, "from");
    const nextOffset = dNumber(details, "nextOffset");
    const lines = [
      ...wrap(theme.fg("toolTitle", `ShellLog · ${id} ${theme.bold(`"${label}"`)} · ${stateWithCode(status, exitCode)}`), width),
    ];
    // Request selectors as recorded by the call (offset null = the tail
    // default; absent = a legacy record that did not retain them).
    lines.push(...wrap(theme.fg("toolOutput", "Request:"), width));
    lines.push(...wrap(theme.fg("dim", `  Job: ${id}`), width));
    const requestOffset = details.requestOffset;
    const offsetLabel =
      requestOffset === null
        ? "tail"
        : typeof requestOffset === "number" && Number.isFinite(requestOffset)
          ? String(requestOffset)
          : UNAVAILABLE;
    lines.push(...wrap(theme.fg("dim", `  Offset: ${offsetLabel}`), width));
    const requestLimit = dNumber(details, "requestLimit");
    lines.push(...wrap(theme.fg("dim", `  Limit: ${requestLimit ?? UNAVAILABLE}`), width));
    lines.push("");
    if (from !== undefined && nextOffset !== undefined) {
      lines.push(...wrap(theme.fg("toolOutput", `Returned range: [${from}, ${nextOffset})`), width));
    }
    if (nextOffset !== undefined) {
      lines.push(...wrap(theme.fg("dim", `Next offset: ${nextOffset}`), width));
    }
    if (total !== undefined) {
      lines.push(...wrap(theme.fg("dim", `Total lines recorded: ${total}`), width));
    }
    if (dropped !== undefined) {
      lines.push(...wrap(theme.fg("dim", `Oldest lines dropped: ${dropped}`), width));
    }
    const parsed = parseShellLogText(contentText(result));
    if (!parsed || parsed.body.length === 0) {
      lines.push(...wrap(theme.fg("muted", "(no lines retained in this range)"), width));
      return lines;
    }
    lines.push(...wrap(theme.fg("toolOutput", "Output:"), width));
    // Verbatim: the complete retained range, whitespace, and embedded ANSI
    // escapes survive the wrap; long lines reflow across display lines
    // instead of being cut.
    const body = parsed.body.slice(0, MAX_EXPANDED_LOG_LINES);
    for (const line of body) {
      lines.push(...wrap(line, width));
    }
    if (parsed.body.length > body.length) {
      lines.push(...wrap(theme.fg("muted", `… ${parsed.body.length - body.length} more retained line(s)`), width));
    }
    if (parsed.tailCut) {
      lines.push(...wrap(theme.fg("muted", "(result cut by the ShellLog result cap)"), width));
    }
    return lines;
  });
}

// ── ShellSend ───────────────────────────────────────────────────────────

/** Collapsed #93 canonical example 4: the delivery outcome and the recorded
 *  input (bounded preview; the expanded view shows the full input). */
export function shellSendCollapsedView(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellSend", theme);
  const details = shellDetails(result, "ShellSend");
  const expanded = isRecord(options) && options.expanded === true;
  if (!details) {
    return expanded ? legacyExpandedView("ShellSend", result, theme) : legacyPreviewView("ShellSend", result, theme);
  }
  if (expanded) return fullContentView(result, theme); // degraded detail-renderer fallback
  if (isErrorResult(result)) return errorView("ShellSend", result, theme);
  return viewComponent((width) => {
    const id = dString(details, "id", 64) ?? "?";
    const bytes = dNumber(details, "bytes");
    const delivery = dString(details, "delivery", 16);
    const outcome =
      delivery === "confirmed"
        ? `pipe accepted${bytes !== undefined ? ` ${bytes} bytes` : ""}`
        : delivery === "unconfirmed"
          ? `queued${bytes !== undefined ? ` ${bytes} bytes` : ""} · delivery unconfirmed`
          : "unknown delivery";
    const lines = [...wrap(theme.fg("toolTitle", `ShellSend · ${id} · ${outcome}`), width)];
    const input = sentInputOf(details, context);
    const inputPreview =
      input === undefined ? UNAVAILABLE : truncateText(JSON.stringify(input), COLLAPSED_INPUT_PREVIEW_CHARS);
    lines.push(...wrap(theme.fg("dim", `  Input: ${inputPreview}`), width));
    return lines;
  });
}

/** Expanded #93 canonical example 4: the full actual sent input (including
 *  secret-shaped text — no additional human-view redaction or truncation),
 *  the byte count, and the truthful delivery boundary: pipe acceptance is not
 *  child processing. */
export function renderShellSendResult(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellSend", theme);
  const details = shellDetails(result, "ShellSend");
  // Failed and legacy records keep the complete recorded call input visible,
  // labeled as submitted — a failed or unacknowledged write never claims
  // pipe acceptance or child processing.
  if (!details) return legacyExpandedView("ShellSend", result, theme, submittedInput(undefined, context));
  if (isErrorResult(result)) return errorView("ShellSend", result, theme, submittedInput(details, context));
  return viewComponent((width) => {
    const id = dString(details, "id", 64) ?? "?";
    const bytes = dNumber(details, "bytes");
    const delivery = dString(details, "delivery", 16);
    const lines = [...wrap(theme.fg("toolTitle", `ShellSend · ${id}`), width)];
    const input = sentInputOf(details, context);
    if (input === undefined) {
      lines.push(...wrap(theme.fg("muted", `Input sent: ${UNAVAILABLE}`), width));
    } else {
      // Complete and unfiltered: the exact bytes handed to the stdin pipe.
      lines.push(...wrap(theme.fg("toolOutput", `Input sent: ${JSON.stringify(input)}`), width));
    }
    if (bytes !== undefined) {
      lines.push(...wrap(theme.fg("dim", `Bytes: ${bytes}`), width));
    }
    const deliveryLabel =
      delivery === "confirmed"
        ? "accepted by the stdin pipe"
        : delivery === "unconfirmed"
          ? "queued — delivery NOT confirmed within the flush window"
          : UNAVAILABLE;
    lines.push(...wrap(theme.fg("dim", `Delivery: ${deliveryLabel}`), width));
    lines.push(...wrap(theme.fg("dim", "Child processing: not established by this acknowledgment"), width));
    return lines;
  });
}

// ── ShellStop ───────────────────────────────────────────────────────────

/** Collapsed #93 canonical example 5: the stop outcome and the actual
 *  affected target list recorded by the call (stop-all retains its targets). */
export function shellStopCollapsedView(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  _context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellStop", theme);
  const details = shellDetails(result, "ShellStop");
  const expanded = isRecord(options) && options.expanded === true;
  if (!details) {
    return expanded ? legacyExpandedView("ShellStop", result, theme) : legacyPreviewView("ShellStop", result, theme);
  }
  if (expanded) return fullContentView(result, theme); // degraded detail-renderer fallback
  if (isErrorResult(result)) return errorView("ShellStop", result, theme);
  return viewComponent((width) => {
    const target = dString(details, "target", 80) ?? "?";
    const outcome = dString(details, "outcome", 32);
    const targets = Array.isArray(details.targets) ? details.targets.filter(isRecord) : [];
    const lines: string[] = [];
    if (target === "all") {
      const count = dNumber(details, "count");
      lines.push(...wrap(theme.fg("toolTitle", `ShellStop · all jobs · stopping ${count ?? "?"}`), width));
      if (targets.length > 0) {
        const names = targets
          .slice(0, COLLAPSED_JOB_ROWS)
          .map((t) => `${typeof t.id === "string" ? t.id : "?"} ${theme.bold(`"${truncateText(String(t.label ?? "?"), 80)}"`)}`);
        lines.push(...wrap(theme.fg("dim", `  ${names.join(", ")}`), width));
        if (targets.length > COLLAPSED_JOB_ROWS) {
          lines.push(...wrap(theme.fg("muted", `  … ${targets.length - COLLAPSED_JOB_ROWS} more target(s)`), width));
        }
      } else {
        lines.push(...wrap(theme.fg("muted", `  targets: ${UNAVAILABLE}`), width));
      }
    } else {
      const jobId = dString(details, "jobId", 64) ?? target;
      const label = dString(details, "label", 80) ?? jobId;
      const status = dString(details, "status", 32);
      const heading =
        outcome === "already-exited"
          ? `already exited${status ? ` (${status})` : ""}`
          : outcome === "stopping"
            ? "stopping"
            : outcome ?? "unknown outcome";
      lines.push(...wrap(theme.fg("toolTitle", `ShellStop · ${jobId} ${theme.bold(`"${label}"`)} · ${heading}`), width));
    }
    return lines;
  });
}

/** Expanded #93 canonical example 5: the request, the retained target list,
 *  the signal path, and the truthful outcome — stopping is not termination. */
export function renderShellStopResult(
  result: unknown,
  options: unknown,
  theme: ShellResultViewTheme,
  _context?: unknown,
): ShellResultComponent {
  if (isRecord(options) && options.isPartial === true) return pendingView("ShellStop", theme);
  const details = shellDetails(result, "ShellStop");
  if (!details) return legacyExpandedView("ShellStop", result, theme);
  if (isErrorResult(result)) return errorView("ShellStop", result, theme);
  return viewComponent((width) => {
    const target = dString(details, "target", 80) ?? "?";
    const outcome = dString(details, "outcome", 32);
    const lines: string[] = [];
    if (target === "all") {
      const targets = Array.isArray(details.targets) ? details.targets.filter(isRecord) : [];
      const count = dNumber(details, "count");
      lines.push(...wrap(theme.fg("toolTitle", "ShellStop · all jobs"), width));
      lines.push(...wrap(theme.fg("toolOutput", "Request: stop all running jobs"), width));
      if (targets.length > 0) {
        lines.push(...wrap(theme.fg("toolOutput", "Targets:"), width));
        const shown = targets.slice(0, MAX_EXPANDED_JOB_ROWS);
        for (const t of shown) {
          const id = typeof t.id === "string" ? t.id : "?";
          const label = typeof t.label === "string" ? truncateText(t.label, 80) : "?";
          lines.push(...wrap(theme.fg("toolOutput", `  ${id} ${theme.bold(`"${label}"`)}`), width));
        }
        if (targets.length > shown.length) {
          lines.push(...wrap(theme.fg("muted", `  … ${targets.length - shown.length} more target(s)`), width));
        }
      } else {
        lines.push(...wrap(theme.fg("muted", `Targets: ${UNAVAILABLE}`), width));
      }
      lines.push(...wrap(theme.fg("dim", "Action: SIGTERM requested"), width));
      lines.push(...wrap(theme.fg("dim", "Escalation: existing SIGKILL fallback"), width));
      lines.push(...wrap(theme.fg("dim", outcome === "stopping"
        ? "Result: stopping; process exit is not yet confirmed"
        : `Result: ${outcome ?? UNAVAILABLE}`), width));
      if (count !== undefined && targets.length === 0) {
        lines.push(...wrap(theme.fg("dim", `Jobs affected: ${count}`), width));
      }
    } else {
      const jobId = dString(details, "jobId", 64) ?? target;
      const label = dString(details, "label", 80) ?? jobId;
      const status = dString(details, "status", 32);
      lines.push(...wrap(theme.fg("toolTitle", `ShellStop · ${jobId} ${theme.bold(`"${label}"`)}`), width));
      lines.push(...wrap(theme.fg("toolOutput", `Request: stop ${target}`), width));
      lines.push(...wrap(theme.fg("toolOutput", `Job: ${jobId} ${theme.bold(`"${label}"`)}`), width));
      if (outcome === "already-exited") {
        lines.push(...wrap(theme.fg("dim", `Result: job had already exited${status ? ` (${status})` : ""}; no signal was sent by this call`), width));
      } else {
        lines.push(...wrap(theme.fg("dim", "Action: SIGTERM requested"), width));
        lines.push(...wrap(theme.fg("dim", "Escalation: existing SIGKILL fallback"), width));
        lines.push(...wrap(theme.fg("dim", "Result: stopping; process exit is not yet confirmed"), width));
      }
    }
    return lines;
  });
}

// ── Selection ───────────────────────────────────────────────────────────

/** One expanded renderer per Shell tool, keyed by tool name. The shared
 *  foundation (#57) pairs these with the collapsed views above. */
export const SHELL_EXPANDED_RESULT_RENDERERS: Record<ShellToolName, ShellResultRenderer> = {
  ShellStart: renderShellStartResult,
  ShellList: renderShellListResult,
  ShellLog: renderShellLogResult,
  ShellSend: renderShellSendResult,
  ShellStop: renderShellStopResult,
};

/** One collapsed structured view per Shell tool, keyed by tool name. */
export const SHELL_COLLAPSED_RESULT_VIEWS: Record<ShellToolName, ShellResultRenderer> = {
  ShellStart: shellStartCollapsedView,
  ShellList: shellListCollapsedView,
  ShellLog: shellLogCollapsedView,
  ShellSend: shellSendCollapsedView,
  ShellStop: shellStopCollapsedView,
};

export function shellExpandedRenderer(tool: ShellToolName): ShellResultRenderer {
  return SHELL_EXPANDED_RESULT_RENDERERS[tool];
}

export function shellCollapsedRenderer(tool: ShellToolName): ShellResultRenderer {
  return SHELL_COLLAPSED_RESULT_VIEWS[tool];
}