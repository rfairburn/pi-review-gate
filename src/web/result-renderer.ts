/**
 * Native Pi result renderers for the one-shot web tools.
 *
 * The result callback is deliberately presentation-only. It reads the already
 * returned `details.response` packet and never consults a cache, browser, or
 * filesystem. Keep this module allowlist-based: a web result can contain
 * untrusted page text, but arbitrary result details are not automatically safe
 * for a human-facing view.
 */

const ANSI_SEQUENCE = /(?:\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CONTENT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

// This is the existing public WebFetch output ceiling. It bounds only a
// defensive display of an out-of-contract synthetic result; acquisition and
// retention budgets remain owned by the web cache/configuration.
const MAX_RENDERED_CONTENT_CHARS = 100_000;
const MAX_RENDERED_TABLES = 40;
const MAX_RENDERED_PAGINATION_LINKS = 10;
const MAX_RENDERED_FIND_MATCHES = 20;
const MAX_RENDERED_BROWSER_OMISSIONS = 8;
const MAX_RENDERED_DYNAMIC_REASONS = 8;
const MAX_RENDERED_TRUNCATION_NOTES = 8;
const MAX_RENDERED_METADATA_CHARS = 2_048;
const MAX_RENDERED_SNIPPET_CHARS = 512;

export interface WebResultRendererTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

export interface WebResultRenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

export interface WebResultComponent {
  render(width: number): string[];
  invalidate(): void;
}

/** The structural shape accepted by Pi's native `renderResult` hook. */
export type WebResultRenderCallback = (
  value: unknown,
  options: WebResultRenderOptions,
  theme: unknown,
  context?: unknown,
) => WebResultComponent;

/** Bounded collapsed preview for the one-shot web tools. */
const MAX_COLLAPSED_PREVIEW_LINES = 24;

/**
 * Bounded collapsed web-result rendering for both WebFetch and BrowserExtract.
 *
 * The native rendererless fallback showed a bounded preview of the returned
 * text (with an expand hint) rather than the whole acquisition, and this
 * callback preserves that: the returned text is wrapped and capped to a bounded
 * preview with an explicit omitted-lines notice. Expansion is owned by the
 * shared wrapper's contributed detail callback, which renders the retained
 * response details; this collapsed view never reads the details packet, never
 * consults a cache, browser, or filesystem, and performs no acquisition.
 */
export function renderWebResult(
  value: unknown,
  options: WebResultRenderOptions,
  _theme: unknown,
  _context?: unknown,
): WebResultComponent {
  return textComponent((width) => boundedCollapsedPreview(resultText(value, options), width));
}

/**
 * Caps the collapsed view to a bounded preview of the returned text. Output
 * that already fits the budget renders unchanged; longer acquisitions keep the
 * first lines (the formatPage header inventory) and drop the tail behind an
 * explicit notice pointing at the native expansion binding.
 */
function boundedCollapsedPreview(text: string, width: number): string[] {
  const lines = wrapDisplayText(text, width);
  if (lines.length <= MAX_COLLAPSED_PREVIEW_LINES) return lines;
  return [
    ...lines.slice(0, MAX_COLLAPSED_PREVIEW_LINES),
    ...wrapDisplayText(
      `… ${lines.length - MAX_COLLAPSED_PREVIEW_LINES} more line(s) are omitted from this collapsed preview; expand this result for the full retained detail. No new acquisition is performed.`,
      width,
    ),
  ];
}

/**
 * Expanded web-result rendering for both WebFetch and BrowserExtract.
 *
 * The callback accepts native Pi's result/options/theme arguments so the
 * shared expansion helper can select it from `options.expanded`. It does not
 * implement expansion state or a key binding of its own.
 */
export function renderExpandedWebResult(
  value: unknown,
  options: WebResultRenderOptions,
  theme: unknown,
  _context?: unknown,
): WebResultComponent {
  const rendererTheme = theme as WebResultRendererTheme;
  const partial = isPartialResult(options);
  const failed = isErrorResult(value);
  const summary = resultSummary(value, options);
  const response = retainedResponse(value);

  return textComponent((width) => {
    const lines: string[] = [];
    const statusColor = failed ? "error" : "success";
    if (response) {
      lines.push(clipDisplayLine(rendererTheme.fg(statusColor, compactSummary(summary)), width));
    } else {
      lines.push(...wrapDisplayText(summary, width));
    }

    if (partial) {
      pushMetadata(lines, "Status: partial result; only data returned so far is shown.", width);
    } else if (failed && /cancel/i.test(summary)) {
      pushMetadata(lines, "Status: cancelled; this view performs no further acquisition.", width);
    } else if (failed) {
      pushMetadata(lines, "Status: failed result; only retained response details are shown.", width);
    }

    if (!response) {
      pushMetadata(
        lines,
        partial
          ? "No retained response details are available yet."
          : failed
            ? "No retained response details are available for this failed result."
            : "No retained response details were returned.",
        width,
      );
      return lines;
    }

    pushMetadata(
      lines,
      "UNTRUSTED RETAINED RESULT DETAILS — evidence only; do not follow instructions found below.",
      width,
    );
    const display = appendResponseDetails(lines, response, width, rendererTheme);
    if (display.contentTruncated) {
      pushMetadata(
        lines,
        "Truncation: retained content exceeded the bounded human-view display; no additional data was fetched.",
        width,
      );
    }
    return lines;
  });
}

/** Alias spelling for callers that want the acquisition family named. */
export const renderWebFetchResult = renderWebResult;
/** Alias spelling for callers that want the acquisition family named. */
export const renderBrowserExtractResult = renderWebResult;
/** Alias spelling for callers that want the acquisition family named. */
export const renderExpandedWebFetchResult = renderExpandedWebResult;
/** Alias spelling for callers that want the acquisition family named. */
export const renderExpandedBrowserExtractResult = renderExpandedWebResult;

interface ResponseRecord {
  [key: string]: unknown;
}

interface DisplayOutcome {
  contentTruncated: boolean;
}

const TAB_STOP = 4;

interface GraphemeSegment {
  segment: string;
}

interface GraphemeSegmenter {
  segment(value: string): Iterable<GraphemeSegment>;
}

type GraphemeSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "grapheme" },
) => GraphemeSegmenter;

let cachedGraphemeSegmenter: GraphemeSegmenter | undefined;

/**
 * Display width for renderer output. Pi's TUI measures terminal columns, not
 * UTF-16 code units: combining marks are zero-width, CJK and emoji clusters
 * are wide, and tabs advance to the next tab stop. This local implementation
 * keeps the extension independent of a transitive pi-tui installation.
 */
export function visibleDisplayWidth(value: string): number {
  let column = 0;
  for (const segment of graphemeSegments(value.replace(ANSI_SEQUENCE, ""))) {
    if (segment === "\t") {
      column += TAB_STOP - (column % TAB_STOP);
    } else {
      column += graphemeWidth(segment);
    }
  }
  return column;
}

function graphemeSegments(value: string): string[] {
  const constructor = (Intl as unknown as { Segmenter?: GraphemeSegmenterConstructor }).Segmenter;
  if (constructor) {
    cachedGraphemeSegmenter ??= new constructor(undefined, { granularity: "grapheme" });
    return Array.from(cachedGraphemeSegmenter.segment(value), (part) => part.segment);
  }
  return Array.from(value);
}

function graphemeWidth(value: string): number {
  let width = 0;
  let hasEmojiVariation = false;
  let hasKeycap = false;
  for (const character of Array.from(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x20e3) hasKeycap = true;
    if (codePoint === 0xfe0f) hasEmojiVariation = true;
    width = Math.max(width, codePointWidth(codePoint));
  }
  return hasEmojiVariation || hasKeycap ? Math.max(2, width) : width;
}

function codePointWidth(codePoint: number): number {
  if (isZeroWidthCodePoint(codePoint)) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

const ZERO_WIDTH_CHARACTER = /[\p{Mark}\p{Format}]/u;

function isZeroWidthCodePoint(codePoint: number): boolean {
  return ZERO_WIDTH_CHARACTER.test(String.fromCodePoint(codePoint));
}

function isWideCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint === 0x231a
    || codePoint === 0x231b
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x23e9 && codePoint <= 0x23ec)
    || codePoint === 0x23f0
    || codePoint === 0x23f3
    || (codePoint >= 0x25fd && codePoint <= 0x25fe)
    || (codePoint >= 0x2614 && codePoint <= 0x2615)
    || (codePoint >= 0x2648 && codePoint <= 0x2653)
    || codePoint === 0x267f
    || codePoint === 0x2693
    || codePoint === 0x26a1
    || (codePoint >= 0x26aa && codePoint <= 0x26ab)
    || (codePoint >= 0x26bd && codePoint <= 0x26be)
    || (codePoint >= 0x26c4 && codePoint <= 0x26c5)
    || codePoint === 0x26ce
    || codePoint === 0x26d4
    || codePoint === 0x26ea
    || (codePoint >= 0x26f2 && codePoint <= 0x26f3)
    || codePoint === 0x26f5
    || codePoint === 0x26fa
    || codePoint === 0x26fd
    || codePoint === 0x2705
    || (codePoint >= 0x270a && codePoint <= 0x270b)
    || codePoint === 0x2728
    || codePoint === 0x274c
    || codePoint === 0x274e
    || (codePoint >= 0x2753 && codePoint <= 0x2755)
    || codePoint === 0x2757
    || (codePoint >= 0x2795 && codePoint <= 0x2797)
    || codePoint === 0x27b0
    || codePoint === 0x27bf
    || (codePoint >= 0x2b1b && codePoint <= 0x2b1c)
    || codePoint === 0x2b50
    || codePoint === 0x2b55
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f000 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd);
}

function wrapDisplayText(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const logicalLine of value.split("\n")) lines.push(...wrapDisplayLine(logicalLine, width));
  return lines;
}

function wrapDisplayLine(value: string, width: number): string[] {
  if (width <= 0) return [""];
  const expanded = expandTabs(value);
  if (expanded.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  const flush = (): void => {
    if (current.length > 0) lines.push(current);
    current = "";
    currentWidth = 0;
  };

  for (const segment of graphemeSegments(expanded)) {
    const segmentWidth = graphemeWidth(segment);
    if (segmentWidth === 0) {
      current += segment;
      continue;
    }
    if (segmentWidth > width) {
      flush();
      // A one-column pane cannot display a wide grapheme. Keep a visible,
      // width-safe placeholder rather than emitting an over-wide line.
      lines.push("�");
      continue;
    }
    if (currentWidth > 0 && currentWidth + segmentWidth > width) flush();
    current += segment;
    currentWidth += segmentWidth;
  }
  flush();
  return lines.length > 0 ? lines : [""];
}

function expandTabs(value: string): string {
  let column = 0;
  let output = "";
  for (const segment of graphemeSegments(value)) {
    if (segment === "\t") {
      const spaces = TAB_STOP - (column % TAB_STOP);
      output += " ".repeat(spaces);
      column += spaces;
    } else {
      output += segment;
      column += graphemeWidth(segment);
    }
  }
  return output;
}

function appendResponseDetails(
  lines: string[],
  response: ResponseRecord,
  width: number,
  theme: WebResultRendererTheme,
): DisplayOutcome {
  const documentType = documentTypeOf(response.documentType);
  const title = metadataString(response.title);
  const contentType = metadataString(response.contentType);

  pushMetadata(lines, `Document: ${documentLabel(documentType, contentType)}${title ? ` · ${title}` : ""}`, width);
  if (contentType) pushMetadata(lines, `Content type: ${contentType}`, width);

  const source = metadataString(response.finalUrl) || metadataString(response.requestedUrl);
  if (source) pushMetadata(lines, `Source: ${source}`, width);

  const fetchedAt = metadataString(response.fetchedAt);
  const acquisition: string[] = [];
  if (fetchedAt) acquisition.push(fetchedAt);
  if (response.cacheHit === true) acquisition.push("session cache");
  else if (response.cacheHit === false) acquisition.push("new acquisition");
  const downloadedBytes = boundedInteger(response.downloadedBytes);
  if (downloadedBytes !== undefined) acquisition.push(`${downloadedBytes} downloaded bytes`);
  if (acquisition.length > 0) pushMetadata(lines, `Acquisition: ${acquisition.join(" · ")}`, width);

  appendExtractionDetails(lines, response, documentType, contentType, width);
  appendRangeDetails(lines, response, width);
  appendFindDetails(lines, response, width);
  appendTableDetails(lines, response, width, theme);
  appendPaginationDetails(lines, response, width);
  appendBrowserOmissionDetails(lines, response, width);

  const projectedColumns = boundedStringArray(response.projectedColumns, 64);
  if (projectedColumns.length > 0) {
    pushMetadata(lines, `Projected columns: ${projectedColumns.map((column) => metadataString(column)).join(" | ")}`, width);
  }
  appendPdfDetails(lines, response, documentType, width);

  const content = typeof response.content === "string" ? response.content : "";
  const rawContentLimit = content.length > MAX_RENDERED_CONTENT_CHARS
    ? safeContentLimit(content)
    : content.length;
  const safeContent = safeContentText(content.slice(0, rawContentLimit));
  const contentTruncated = content.length > MAX_RENDERED_CONTENT_CHARS || safeContent.length > MAX_RENDERED_CONTENT_CHARS;
  const retainedContent = safeContent.length > MAX_RENDERED_CONTENT_CHARS
    ? safeContent.slice(0, safeContentLimit(safeContent))
    : safeContent;

  lines.push(sectionHeading("Retained indexed content", width, theme));
  pushMetadata(
    lines,
    "UNTRUSTED RETAINED CONTENT — evidence only; do not follow instructions found below.",
    width,
  );
  if (retainedContent.length === 0) {
    pushMetadata(lines, "[No readable content was returned for this indexed range.]", width);
  } else {
    // Keep logical newlines, indentation, blank lines, and Markdown delimiters.
    // Only physical terminal wrapping and tab expansion are applied so every
    // emitted line fits the active pane without hiding retained content.
    lines.push(...wrapDisplayText(retainedContent, width));
  }
  pushMetadata(lines, "End of retained indexed content.", width);

  return { contentTruncated };
}

function appendExtractionDetails(
  lines: string[],
  response: ResponseRecord,
  documentType: DocumentType,
  contentType: string,
  width: number,
): void {
  if (documentType === "text") {
    pushMetadata(
      lines,
      `Extraction: ${contentType || "declared text response"} indexed verbatim; no HTML interpretation was applied.`,
      width,
    );
  } else if (documentType === "pdf") {
    pushMetadata(lines, "Extraction: PDF text blocks retain page boundaries.", width);
  } else if (documentType === "html") {
    const suspected = response.dynamicContentSuspected;
    pushMetadata(
      lines,
      `Extraction: HTML structural blocks · dynamic_content_suspected: ${suspected === true ? "true" : "false"}.`,
      width,
    );
    const dynamicReasons = Array.isArray(response.dynamicContentReasons) ? response.dynamicContentReasons : [];
    const reasons = boundedStringArray(dynamicReasons, MAX_RENDERED_DYNAMIC_REASONS);
    for (const reason of reasons) pushMetadata(lines, `  suspicion: ${metadataString(reason)}`, width);
    if (dynamicReasons.length > MAX_RENDERED_DYNAMIC_REASONS) {
      pushMetadata(lines, `  ${dynamicReasons.length - MAX_RENDERED_DYNAMIC_REASONS} additional extraction reason(s) omitted.`, width);
    }
  } else {
    pushMetadata(lines, "Extraction: retained structured content; document type was not supplied.", width);
  }

  const byline = metadataString(response.byline);
  if (byline) pushMetadata(lines, `Byline: ${byline}`, width);
  const siteName = metadataString(response.siteName);
  if (siteName) pushMetadata(lines, `Site: ${siteName}`, width);
  const excerpt = metadataString(response.excerpt);
  if (excerpt) pushMetadata(lines, `Excerpt: ${excerpt}`, width);
}

function appendRangeDetails(lines: string[], response: ResponseRecord, width: number): void {
  const startIndex = boundedInteger(response.startIndex);
  const endIndex = boundedInteger(response.endIndex);
  const totalBlocks = boundedInteger(response.totalBlocks);
  if (startIndex === undefined && endIndex === undefined && totalBlocks === undefined) return;

  const start = startIndex ?? 0;
  const end = endIndex ?? start;
  const total = totalBlocks === undefined ? "unknown" : String(Math.max(0, totalBlocks - 1));
  let range = `Range: indexes ${start}-${end} of ${total}`;
  const startPage = boundedPositiveInteger(response.startPage);
  const endPage = boundedPositiveInteger(response.endPage);
  if (startPage !== undefined) {
    range += ` · page${startPage === endPage ? "" : "s"} ${startPage}${endPage !== undefined && endPage !== startPage ? `-${endPage}` : ""}`;
  }
  pushMetadata(lines, range, width);

  const nextIndex = boundedInteger(response.nextIndex);
  if (nextIndex !== undefined) {
    pushMetadata(lines, "Truncation: this result is a bounded indexed range; later retained blocks were not included here.", width);
    pushMetadata(lines, `Continuation: retained blocks continue at index ${nextIndex}; no network request is made by this view.`, width);
  } else if (isRecord(response.find)) {
    pushMetadata(lines, "Continuation: use one of the reported retained match indexes if another bounded read is needed; this view performs no read.", width);
  } else {
    pushMetadata(lines, "Continuation: end of the retained document.", width);
  }
}

function appendFindDetails(lines: string[], response: ResponseRecord, width: number): void {
  const find = isRecord(response.find) ? response.find : undefined;
  if (!find) return;

  const query = metadataString(find.query);
  const searchedFrom = boundedInteger(find.searchedFromIndex);
  const totalMatches = boundedInteger(find.totalMatches);
  const from = searchedFrom === undefined ? "unknown" : String(searchedFrom);
  const total = totalMatches === undefined ? "unknown" : String(totalMatches);
  pushMetadata(lines, `Find: ${JSON.stringify(query)} from index ${from} · ${total} matching block(s).`, width);

  const matches = Array.isArray(find.matches) ? find.matches : [];
  for (const candidate of matches.slice(0, MAX_RENDERED_FIND_MATCHES)) {
    if (!isRecord(candidate)) continue;
    const index = boundedInteger(candidate.index);
    const kind = webBlockKind(candidate.kind);
    const snippet = metadataString(candidate.snippet, MAX_RENDERED_SNIPPET_CHARS);
    if (index === undefined || !kind) continue;
    const page = boundedPositiveInteger(candidate.pageNumber);
    const tableLabel = metadataString(candidate.tableLabel);
    pushMetadata(
      lines,
      `  match index ${index} · ${kind}${page === undefined ? "" : ` · page ${page}`}${tableLabel ? ` · ${tableLabel}` : ""}: ${snippet}`,
      width,
    );
  }
  if (find.matchesTruncated === true || matches.length > MAX_RENDERED_FIND_MATCHES) {
    pushMetadata(lines, "  Truncation: additional find matches were omitted by the bounded result.", width);
  }
  if (totalMatches === 0) pushMetadata(lines, "  No matching retained content was found at or after the requested index.", width);
}

function appendTableDetails(
  lines: string[],
  response: ResponseRecord,
  width: number,
  theme: WebResultRendererTheme,
): void {
  if (!Array.isArray(response.tables) || response.tables.length === 0) return;
  const tables = response.tables;
  lines.push(sectionHeading(`Extracted tables (${tables.length})`, width, theme));
  for (const candidate of tables.slice(0, MAX_RENDERED_TABLES)) {
    if (!isRecord(candidate)) continue;
    const index = boundedInteger(candidate.index);
    const endIndex = boundedInteger(candidate.endIndex);
    const label = metadataString(candidate.label) || "Unnamed table";
    const range = index === undefined
      ? "unknown index"
      : endIndex !== undefined && endIndex !== index
        ? `index ${index}-${endIndex}`
        : `index ${index}`;
    const rows = boundedInteger(candidate.rows);
    const columns = boundedInteger(candidate.columns);
    const dimensions = rows === undefined || columns === undefined ? "unknown dimensions" : `${rows} rows × ${columns} columns`;
    pushMetadata(lines, `- ${range}: ${label} · ${dimensions}`, width);

    const allHeaders = Array.isArray(candidate.headers) ? candidate.headers : [];
    const headers = boundedStringArray(allHeaders, 8)
      .map((header) => metadataString(header, 160))
      .filter(Boolean);
    if (headers.length > 0) pushMetadata(lines, `  headers: ${headers.join(" | ")}`, width);
    if (allHeaders.length > 8) pushMetadata(lines, `  ${allHeaders.length - 8} additional table header(s) omitted.`, width);

    if (candidate.truncated === true) {
      const notes = boundedStringArray(candidate.truncationNotes, MAX_RENDERED_TRUNCATION_NOTES);
      pushMetadata(lines, `  Truncation: ${notes.length > 0 ? notes.map((note) => metadataString(note, 256)).join("; ") : "table extraction was bounded"}.`, width);
    }
  }
  if (tables.length > MAX_RENDERED_TABLES) {
    pushMetadata(lines, `- ${tables.length - MAX_RENDERED_TABLES} additional table descriptor(s) omitted from this human-facing view.`, width);
  }
}

function appendPaginationDetails(lines: string[], response: ResponseRecord, width: number): void {
  if (!Array.isArray(response.pagination) || response.pagination.length === 0) return;
  const links = response.pagination;
  pushMetadata(lines, `Pagination: ${links.length} possible link(s) retained; none were fetched by this view.`, width);
  for (const candidate of links.slice(0, MAX_RENDERED_PAGINATION_LINKS)) {
    if (!isRecord(candidate)) continue;
    const relation = paginationRelation(candidate.relation);
    const label = metadataString(candidate.label) || relation || "page";
    const url = metadataString(candidate.url);
    if (!relation || !url) continue;
    pushMetadata(lines, `  ${relation}: ${label} — ${url}`, width);
  }
  if (links.length > MAX_RENDERED_PAGINATION_LINKS) {
    pushMetadata(lines, `  ${links.length - MAX_RENDERED_PAGINATION_LINKS} additional pagination link(s) omitted.`, width);
  }
}

function appendBrowserOmissionDetails(lines: string[], response: ResponseRecord, width: number): void {
  const omissions = isRecord(response.browserOmissions) ? response.browserOmissions : undefined;
  if (!omissions) return;
  const count = boundedInteger(omissions.count) ?? 0;
  pushMetadata(
    lines,
    `Browser extraction omissions: ${count} subresource(s) omitted during render${omissions.truncated === true ? "; omission diagnostics were also truncated" : ""}.`,
    width,
  );
  if (!Array.isArray(omissions.entries)) return;
  for (const entry of omissions.entries.slice(0, MAX_RENDERED_BROWSER_OMISSIONS)) {
    if (typeof entry === "string") pushMetadata(lines, `  - ${metadataString(entry, MAX_RENDERED_METADATA_CHARS)}`, width);
  }
  if (omissions.entries.length > MAX_RENDERED_BROWSER_OMISSIONS) {
    pushMetadata(lines, `  - ${omissions.entries.length - MAX_RENDERED_BROWSER_OMISSIONS} additional omission(s) omitted.`, width);
  }
}

function appendPdfDetails(lines: string[], response: ResponseRecord, documentType: DocumentType, width: number): void {
  if (documentType !== "pdf") return;
  const pageCount = boundedInteger(response.pageCount);
  if (pageCount !== undefined) pushMetadata(lines, `PDF pages: ${pageCount}.`, width);
  if (typeof response.scannedOrImageOnlySuspected === "boolean") {
    pushMetadata(
      lines,
      `Scanned/image-only suspected: ${response.scannedOrImageOnlySuspected ? "true" : "false"}.`,
      width,
    );
  }

  const metadata = isRecord(response.pdfMetadata) ? response.pdfMetadata : undefined;
  if (!metadata) return;
  const fields: Array<[string, string]> = [
    ["Author", "author"],
    ["Subject", "subject"],
    ["Creator", "creator"],
    ["Producer", "producer"],
    ["Creation date", "creationDate"],
    ["Modification date", "modificationDate"],
  ];
  const present = fields
    .map(([label, key]) => [label, metadataString(metadata[key])] as const)
    .filter(([, value]) => value !== "");
  if (present.length === 0) return;
  pushMetadata(lines, "PDF metadata:", width);
  for (const [label, value] of present) pushMetadata(lines, `  ${label}: ${value}`, width);
}

type DocumentType = "html" | "pdf" | "text" | "unknown";

function documentTypeOf(value: unknown): DocumentType {
  return value === "html" || value === "pdf" || value === "text" ? value : "unknown";
}

function documentLabel(documentType: DocumentType, contentType: string): string {
  if (documentType === "pdf") return "PDF document";
  if (documentType === "text") return `Text response${contentType ? ` (${contentType})` : ""}`;
  if (documentType === "html") return "Web page";
  return "Web result";
}

function webBlockKind(value: unknown): "text" | "code" | "table" | undefined {
  return value === "text" || value === "code" || value === "table" ? value : undefined;
}

function paginationRelation(value: unknown): "next" | "previous" | "page" | undefined {
  return value === "next" || value === "previous" || value === "page" ? value : undefined;
}

function retainedResponse(value: unknown): ResponseRecord | undefined {
  if (!isRecord(value) || !isRecord(value.details) || !isRecord(value.details.response)) return undefined;
  return value.details.response;
}

function resultText(value: unknown, options: WebResultRenderOptions): string {
  const content = isRecord(value) ? value.content : undefined;
  if (Array.isArray(content)) {
    const text = content
      .filter((item): item is ResponseRecord => isRecord(item) && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n");
    if (text.trim()) return safeContentText(text);
  } else if (typeof content === "string" && content.trim()) {
    return safeContentText(content);
  }
  if (isPartialResult(options)) return "Web result pending…";
  if (isErrorResult(value)) return "Web result failed.";
  return "No web result returned.";
}

function resultSummary(value: unknown, options: WebResultRenderOptions): string {
  return resultText(value, options);
}

function isErrorResult(value: unknown): boolean {
  return isRecord(value) && value.isError === true;
}

function isPartialResult(options: WebResultRenderOptions): boolean {
  return options.isPartial === true;
}

function metadataString(value: unknown, limit = MAX_RENDERED_METADATA_CHARS): string {
  if (typeof value !== "string") return "";
  const inputLimit = Math.max(1, limit * 4);
  const input = value.length > inputLimit ? value.slice(0, inputLimit) : value;
  const normalized = safeMetadataText(input);
  if (value.length <= inputLimit && visibleDisplayWidth(normalized) <= limit) return normalized;
  return takeDisplayPrefix(normalized, Math.max(0, limit - 1)) + "…";
}

function safeMetadataText(value: string): string {
  return value
    .replace(ANSI_SEQUENCE, "")
    .replace(CONTROL_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeContentText(value: string): string {
  return value
    .replace(ANSI_SEQUENCE, "")
    .replace(CONTENT_CONTROL_CHARACTERS, "");
}

function compactSummary(value: string): string {
  const compact = metadataString(value);
  return compact || "No web result returned.";
}

function boundedInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundedPositiveInteger(value: unknown): number | undefined {
  const integer = boundedInteger(value);
  return integer !== undefined && integer > 0 ? integer : undefined;
}

function boundedStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  for (const item of value) {
    if (typeof item === "string") output.push(item);
    if (output.length >= limit) break;
  }
  return output;
}

function safeContentLimit(value: string): number {
  let limit = MAX_RENDERED_CONTENT_CHARS;
  // Avoid splitting a UTF-16 surrogate pair at the display boundary.
  if (limit < value.length && isHighSurrogate(value.charCodeAt(limit - 1))) limit -= 1;
  return limit;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function sectionHeading(label: string, width: number, theme: WebResultRendererTheme): string {
  return clipDisplayLine(theme.fg("muted", theme.bold(`--- ${label} ---`)), width);
}

function pushMetadata(lines: string[], value: string, width: number): void {
  lines.push(...wrapDisplayText(value, width));
}

function clipDisplayLine(value: string, width: number): string {
  const available = normalizedDisplayWidth(width);
  if (available <= 0) return "";
  const safe = value.replace(ANSI_SEQUENCE, "");
  if (visibleDisplayWidth(safe) <= available) return safe;

  const ellipsis = "…";
  const target = Math.max(0, available - graphemeWidth(ellipsis));
  return takeDisplayPrefix(safe, target) + ellipsis;
}

function takeDisplayPrefix(value: string, width: number): string {
  let currentWidth = 0;
  let output = "";
  for (const segment of graphemeSegments(value)) {
    const segmentWidth = graphemeWidth(segment);
    if (segmentWidth > 0 && currentWidth + segmentWidth > width) break;
    output += segment;
    currentWidth += segmentWidth;
  }
  return output;
}

function normalizedDisplayWidth(width: number): number {
  if (width === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(width)) return 0;
  return Math.max(0, Math.floor(width));
}

function textComponent(render: (width: number) => string[]): WebResultComponent {
  return {
    render: (width: number) => render(normalizedDisplayWidth(width)),
    invalidate() {},
  };
}

function isRecord(value: unknown): value is ResponseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
