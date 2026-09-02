import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const MAX_BLOCK_CHARS = 7_000;
const MAX_TABLES = 64;

// Conservative adversarial-input budgets for HTML table extraction. All are
// enforced before any dense allocation or span-fill loop, so attacker-controlled
// numeric spans and cell counts can never drive unbounded memory work.
const MAX_TABLE_ROWS = 2_000;
const MAX_TABLE_COLUMNS = 256;
const MAX_TABLE_CELLS = 65_536;
const MAX_TABLE_SPAN = 1_000;
const MAX_CELL_TEXT_CHARS = 2_000;
const MAX_TABLE_LABEL_CHARS = 500;
const MAX_TABLE_MARKDOWN_CHARS = 512_000;

export interface WebPageBlock {
  index: number;
  kind: "text" | "code" | "table";
  markdown: string;
  pageNumber?: number;
  tableId?: string;
  tableLabel?: string;
  tableHeaders?: string[];
  tableRows?: string[][];
}

export interface WebTableDescriptor {
  id: string;
  label: string;
  index: number;
  endIndex: number;
  rows: number;
  columns: number;
  headers: string[];
  /** Present when any extraction budget (rows, columns, cells, spans, cell text, Markdown) truncated this table. */
  truncated?: boolean;
  truncationNotes?: string[];
}

export interface WebPaginationLink {
  label: string;
  url: string;
  relation: "next" | "previous" | "page";
}

export interface ExtractedWebPage {
  url: string;
  title: string;
  documentType: "html" | "pdf";
  byline?: string;
  siteName?: string;
  excerpt?: string;
  blocks: WebPageBlock[];
  tables: WebTableDescriptor[];
  pagination: WebPaginationLink[];
  dynamicContentSuspected: boolean;
  dynamicContentReasons: string[];
  pageCount?: number;
  pdfMetadata?: PdfMetadata;
  scannedOrImageOnlySuspected?: boolean;
}

export interface PdfMetadata {
  author?: string;
  subject?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
}

export interface RenderedWebPage {
  content: string;
  startIndex: number;
  endIndex: number;
  nextIndex?: number;
  totalBlocks: number;
  projectedColumns?: string[];
  startPage?: number;
  endPage?: number;
}

export interface WebPageMatch {
  index: number;
  kind: WebPageBlock["kind"];
  snippet: string;
  tableId?: string;
  tableLabel?: string;
  pageNumber?: number;
}

export interface WebPageFindResult {
  query: string;
  searchedFromIndex: number;
  totalMatches: number;
  matches: WebPageMatch[];
  matchesTruncated: boolean;
}

export function extractWebPage(html: string, url: string): ExtractedWebPage {
  const parsed = parseHTML(html);
  const document = parsed.document as unknown as Document;
  absolutizeLinks(document, url);
  const dynamicContentReasons = dynamicReasons(document, html);
  const scriptSignals = executableScriptSignals(document);
  for (const element of [...document.querySelectorAll("script,style,noscript,template,svg,img,picture,source")]) element.remove();

  const readable = readArticle(document, url);
  const sourceHtml = readable?.content || document.body?.innerHTML || html;
  const contentDocument = parseHTML(`<body>${sourceHtml}</body>`).document as unknown as Document;
  absolutizeLinks(contentDocument, url);
  const turndown = new TurndownService({
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    strongDelimiter: "**",
    bulletListMarker: "-",
  });
  turndown.use(gfm);

  const blocks: WebPageBlock[] = [];
  for (const element of [...contentDocument.querySelectorAll("h1,h2,h3,h4,h5,h6,p,ul,ol,pre,blockquote,figcaption")]) {
    if (element.closest("table") || nestedInSelectedContainer(element)) continue;
    const markdown = turndown.turndown(element.outerHTML).trim();
    if (!markdown) continue;
    for (const part of splitBlock(markdown, MAX_BLOCK_CHARS)) {
      blocks.push({ index: blocks.length, kind: element.tagName.toLowerCase() === "pre" ? "code" : "text", markdown: part });
    }
  }
  if (blocks.length === 0) {
    const fallback = cleanText(contentDocument.body?.textContent ?? document.body?.textContent ?? "");
    for (const part of splitBlock(fallback, MAX_BLOCK_CHARS)) blocks.push({ index: blocks.length, kind: "text", markdown: part });
  }

  const tables: WebTableDescriptor[] = [];
  // Bounded traversal: never materializes a collection proportional to the
  // document's table count.
  const tableElements = collectBoundedElements(document, "table", MAX_TABLES);
  for (const element of tableElements.elements) {
    const table = tableData(element, tables.length + 1);
    if (!table || table.rows.length < 2 || table.columns < 2) continue;
    const start = blocks.length;
    const markdownNotes = [...table.truncationNotes];
    const chunks = tableMarkdownChunks(table.label, table.headers, table.rows, MAX_BLOCK_CHARS, markdownNotes);
    for (const chunk of chunks) {
      blocks.push({
        index: blocks.length,
        kind: "table",
        markdown: chunk.markdown,
        tableId: table.id,
        tableLabel: table.label,
        tableHeaders: table.headers,
        tableRows: chunk.rows,
      });
    }
    const truncated = [...new Set(markdownNotes)];
    tables.push({
      id: table.id,
      label: table.label,
      index: start,
      endIndex: blocks.length - 1,
      rows: table.rows.length,
      columns: table.columns,
      headers: table.headers,
      ...(truncated.length > 0 ? { truncated: true, truncationNotes: truncated } : {}),
    });
  }
  dynamicContentReasons.push(...extractionDynamicReasons(blocks, scriptSignals));

  return {
    url,
    title: readable?.title?.trim() || cleanText(document.title || "Untitled page"),
    documentType: "html",
    ...(readable?.byline ? { byline: readable.byline } : {}),
    ...(readable?.siteName ? { siteName: readable.siteName } : {}),
    ...(readable?.excerpt ? { excerpt: readable.excerpt } : {}),
    blocks,
    tables,
    pagination: paginationLinks(document, url),
    dynamicContentSuspected: dynamicContentReasons.length > 0,
    dynamicContentReasons,
  };
}

export function renderWebPage(page: ExtractedWebPage, index: number, maxChars: number, columns?: string[]): RenderedWebPage {
  if (!Number.isInteger(index) || index < 0) throw new Error("index must be a non-negative integer.");
  if (page.blocks.length === 0) {
    if (columns) throw new Error("columns can only be used when index points directly to a table block.");
    if (index !== 0) throw new Error("This page has no readable block at the requested index.");
    return { content: "", startIndex: 0, endIndex: 0, totalBlocks: 0 };
  }
  if (index >= page.blocks.length) throw new Error(`index ${index} is beyond the final block ${page.blocks.length - 1}.`);
  const projection = columns ? resolveColumnProjection(page.blocks[index]!, columns) : undefined;
  const selected: WebPageBlock[] = [];
  const rendered: string[] = [];
  let chars = 0;
  for (let position = index; position < page.blocks.length; position += 1) {
    const block = page.blocks[position]!;
    if (projection && block.tableId !== projection.tableId) break;
    const markdown = projection ? projectTableBlock(block, projection) : block.markdown;
    const addition = markdown.length + (selected.length > 0 ? 2 : 0);
    if (selected.length > 0 && chars + addition > maxChars) break;
    selected.push(block);
    rendered.push(markdown);
    chars += addition;
    if (chars >= maxChars) break;
  }
  const endIndex = selected.at(-1)?.index ?? index;
  return {
    content: rendered.join("\n\n"),
    startIndex: index,
    endIndex,
    ...(endIndex + 1 < page.blocks.length ? { nextIndex: endIndex + 1 } : {}),
    totalBlocks: page.blocks.length,
    ...(projection ? { projectedColumns: projection.headers } : {}),
    ...(selected[0]?.pageNumber ? { startPage: selected[0].pageNumber } : {}),
    ...(selected.at(-1)?.pageNumber ? { endPage: selected.at(-1)!.pageNumber } : {}),
  };
}

interface ResolvedColumnProjection {
  tableId: string;
  tableLabel: string;
  indexes: number[];
  headers: string[];
}

function resolveColumnProjection(block: WebPageBlock, selectors: string[]): ResolvedColumnProjection {
  if (block.kind !== "table" || !block.tableId || !block.tableHeaders || !block.tableRows) {
    throw new Error("columns can only be used when index points directly to a table block.");
  }
  if (selectors.length === 0) throw new Error("columns must contain at least one selector.");
  const indexes = selectors.map((selector) => resolveColumnSelector(block.tableHeaders!, selector));
  if (new Set(indexes).size !== indexes.length) throw new Error("columns must not select the same table column more than once.");
  return {
    tableId: block.tableId,
    tableLabel: block.tableLabel ?? block.tableId,
    indexes,
    headers: indexes.map((column) => block.tableHeaders![column]!),
  };
}

function resolveColumnSelector(headers: string[], rawSelector: string): number {
  const selector = rawSelector.trim();
  if (!selector) throw new Error("column selectors must be non-empty strings.");
  const ordinal = /^#([1-9]\d*)$/.exec(selector);
  if (ordinal) {
    const index = Number(ordinal[1]) - 1;
    if (index >= headers.length) throw new Error(`column selector ${JSON.stringify(selector)} is beyond the final column #${headers.length}.`);
    return index;
  }
  const normalized = normalizeHeader(selector);
  const matches = headers
    .map((header, index) => normalizeHeader(header) === normalized ? index : -1)
    .filter((index) => index >= 0);
  if (matches.length === 1) return matches[0]!;
  const available = headers.map((header, index) => `#${index + 1} ${header}`).join("; ");
  if (matches.length > 1) {
    throw new Error(`column selector ${JSON.stringify(selector)} is ambiguous; use a numbered selector. Available columns: ${available}`);
  }
  throw new Error(`unknown column selector ${JSON.stringify(selector)}. Available columns: ${available}`);
}

function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function projectTableBlock(block: WebPageBlock, projection: ResolvedColumnProjection): string {
  if (!block.tableRows) throw new Error("The cached table block has no structured rows for projection.");
  const descriptorRows = block.tableRows.map((row) => projection.indexes.map((column) => row[column] ?? ""));
  return tableMarkdown(projection.tableLabel, projection.headers, descriptorRows, MAX_BLOCK_CHARS);
}

export function findInWebPage(
  page: ExtractedWebPage,
  query: string,
  fromIndex = 0,
  maxMatches = 20,
): WebPageFindResult {
  const needle = query.trim();
  if (!needle) throw new Error("find must contain non-whitespace text.");
  if (!Number.isInteger(fromIndex) || fromIndex < 0) throw new Error("index must be a non-negative integer.");
  if (fromIndex >= page.blocks.length && page.blocks.length > 0) {
    throw new Error(`index ${fromIndex} is beyond the final block ${page.blocks.length - 1}.`);
  }
  const normalizedNeedle = needle.toLocaleLowerCase();
  const matching = page.blocks.filter((block) =>
    block.index >= fromIndex && block.markdown.toLocaleLowerCase().includes(normalizedNeedle)
  );
  return {
    query: needle,
    searchedFromIndex: fromIndex,
    totalMatches: matching.length,
    matches: matching.slice(0, maxMatches).map((block) => {
      const descriptor = block.tableId ? page.tables.find((table) => table.id === block.tableId) : undefined;
      return {
        index: block.index,
        kind: block.kind,
        snippet: matchSnippet(block.markdown, normalizedNeedle),
        ...(block.tableId ? { tableId: block.tableId } : {}),
        ...(descriptor ? { tableLabel: descriptor.label } : {}),
        ...(block.pageNumber ? { pageNumber: block.pageNumber } : {}),
      };
    }),
    matchesTruncated: matching.length > maxMatches,
  };
}

function matchSnippet(markdown: string, normalizedNeedle: string): string {
  const normalized = markdown.replace(/\s+/g, " ").trim();
  const at = normalized.toLocaleLowerCase().indexOf(normalizedNeedle);
  const radius = 180;
  const start = Math.max(0, at - radius);
  const end = Math.min(normalized.length, at + normalizedNeedle.length + radius);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

function readArticle(document: Document, url: string): ReturnType<Readability["parse"]> {
  try {
    const clone = document.cloneNode(true) as Document;
    const base = clone.createElement("base");
    base.setAttribute("href", url);
    clone.head?.prepend(base);
    return new Readability(clone, { charThreshold: 100 }).parse();
  } catch {
    return null;
  }
}

function absolutizeLinks(document: Document, base: string): void {
  for (const element of [...document.querySelectorAll("a[href]")]) {
    const value = element.getAttribute("href");
    if (!value) continue;
    try { element.setAttribute("href", new URL(value, base).href); } catch { /* retain malformed source value */ }
  }
}

function nestedInSelectedContainer(element: Element): boolean {
  const parent = element.parentElement;
  if (!parent) return false;
  return Boolean(parent.closest("ul,ol,pre,blockquote"));
}

function splitBlock(value: string, limit: number): string[] {
  if (value.length <= limit) return [value];
  const output: string[] = [];
  let remaining = value;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const split = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = split > Math.floor(limit / 2) ? split : limit;
    output.push(remaining.slice(0, at).trim());
    remaining = remaining.slice(at).trimStart();
  }
  if (remaining.trim()) output.push(remaining.trim());
  return output;
}

interface ParsedTable {
  id: string;
  label: string;
  headers: string[];
  rows: string[][];
  columns: number;
  truncationNotes: string[];
}

function tableData(table: Element, ordinal: number): ParsedTable | undefined {
  const notes: string[] = [];
  // Bounded traversal: collect at most MAX_TABLE_ROWS rows without building a
  // NodeList of every attacker-controlled <tr>; expandTableRows enforces the
  // same budget.
  const trs = collectBoundedElements(table, "tr", MAX_TABLE_ROWS);
  if (trs.overflow) notes.push(`table rows capped at ${MAX_TABLE_ROWS}`);
  const expanded = expandTableRows(trs.elements, notes);
  const allRows = expanded.map((row) => row.values).filter((row) => row.some(Boolean));
  if (allRows.length < 2) return undefined;
  const columns = Math.min(Math.max(...allRows.map((row) => row.length)), MAX_TABLE_COLUMNS);
  if (columns < 2) return undefined;
  let headerCount = 0;
  for (const row of expanded) {
    if (row.tags.length === 0 || row.tags.some((tag) => tag !== "th")) break;
    headerCount += 1;
  }
  headerCount = Math.min(Math.max(1, headerCount), Math.max(1, allRows.length - 1));
  // The dense result pads every retained row to `columns` cells, so bound the
  // padded total (including rowspan carry-over slots already counted during
  // expansion) against MAX_TABLE_CELLS before the per-row allocation.
  const maxBodyRows = Math.max(1, Math.floor(MAX_TABLE_CELLS / columns) - headerCount);
  let bodyRows = allRows.slice(headerCount);
  if (bodyRows.length > maxBodyRows) {
    bodyRows = bodyRows.slice(0, maxBodyRows);
    notes.push(`expanded table cells capped at ${MAX_TABLE_CELLS}`);
  }
  const headerRows = allRows.slice(0, headerCount);
  const headers = Array.from({ length: columns }, (_, column) => {
    const values = headerRows.map((row) => row[column]).filter((value): value is string => Boolean(value));
    return boundedHeaderText(values, notes) || `Column ${column + 1}`;
  });
  const caption = cleanText(table.querySelector("caption")?.textContent ?? "");
  const heading = nearestHeading(table);
  const rawLabel = caption || heading || `Table ${ordinal}`;
  const label = rawLabel.length > MAX_TABLE_LABEL_CHARS
    ? `${rawLabel.slice(0, MAX_TABLE_LABEL_CHARS - 1)}…`
    : rawLabel;
  if (label !== rawLabel) notes.push(`table label truncated to ${MAX_TABLE_LABEL_CHARS} characters`);
  return {
    id: `table-${ordinal}`,
    label,
    headers,
    rows: bodyRows.map((row) => Array.from({ length: columns }, (_, column) => row[column] ?? "")),
    columns,
    truncationNotes: [...new Set(notes)],
  };
}

interface ExpandedTableRow {
  values: string[];
  tags: string[];
}

function expandTableRows(rows: Element[], notes: string[]): ExpandedTableRow[] {
  const output: ExpandedTableRow[] = [];
  const spans = new Map<number, { value: string; tag: string; remaining: number }>();
  let cellCount = 0;
  let cellTextTruncated = false;
  for (const row of rows) {
    if (output.length >= MAX_TABLE_ROWS) {
      notes.push(`table rows capped at ${MAX_TABLE_ROWS}`);
      break;
    }
    const values: string[] = [];
    const tags: string[] = [];
    // Rowspan carry-over cells are emitted cells too: count them against the
    // total-cell budget before replaying, and stop expanding once exhausted.
    if (spans.size > 0) {
      if (cellCount + spans.size > MAX_TABLE_CELLS) {
        notes.push(`expanded table cells capped at ${MAX_TABLE_CELLS}`);
        break;
      }
      for (const [column, span] of [...spans]) {
        values[column] = span.value;
        tags[column] = span.tag;
        span.remaining -= 1;
        if (span.remaining <= 0) spans.delete(column);
        cellCount += 1;
      }
    }
    let column = 0;
    // Walk sibling pointers directly: linkedom's `children` getter materializes
    // a NodeList of every child, so a huge physical cell list would otherwise
    // still be allocated. The budget checks below stop the walk early.
    for (let cell = row.firstElementChild; cell; cell = cell.nextElementSibling) {
      const tag = cell.tagName.toLowerCase();
      if (tag !== "th" && tag !== "td") continue;
      while (values[column] !== undefined) column += 1;
      const value = cleanText(cell.textContent ?? "");
      let text = value;
      if (text.length > MAX_CELL_TEXT_CHARS) {
        text = `${text.slice(0, MAX_CELL_TEXT_CHARS - 1)}…`;
        cellTextTruncated = true;
      }
      const colspan = clampedSpan(cell.getAttribute("colspan"), "colspan", notes);
      const rowspan = clampedSpan(cell.getAttribute("rowspan"), "rowspan", notes);
      // Clamp width against the column and total-cell budgets before the
      // span-fill loop so no attacker-controlled span can allocate or loop
      // beyond the caps.
      let width = colspan;
      if (column + width > MAX_TABLE_COLUMNS) {
        width = MAX_TABLE_COLUMNS - column;
        notes.push(`table columns capped at ${MAX_TABLE_COLUMNS}`);
        if (width <= 0) break;
      }
      const remainingCells = MAX_TABLE_CELLS - cellCount;
      if (width > remainingCells) {
        width = remainingCells;
        notes.push(`expanded table cells capped at ${MAX_TABLE_CELLS}`);
        if (width <= 0) break;
      }
      cellCount += width;
      for (let offset = 0; offset < width; offset += 1) {
        values[column + offset] = text;
        tags[column + offset] = tag;
        if (rowspan > 1) spans.set(column + offset, { value: text, tag, remaining: rowspan - 1 });
      }
      column += width;
    }
    if (values.some(Boolean)) output.push({ values, tags });
  }
  if (cellTextTruncated) notes.push(`cell text truncated to ${MAX_CELL_TEXT_CHARS} characters`);
  return output;
}

/**
 * Joins distinct header-row values for one column into at most
 * MAX_CELL_TEXT_CHARS characters (including the ellipsis), so multi-row
 * spanned headers cannot amplify a small table into oversized synthesized
 * header strings.
 */
function boundedHeaderText(values: string[], notes: string[]): string {
  const seen = new Set<string>();
  let output = "";
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    const addition = `${output ? " " : ""}${value}`;
    if (output.length + addition.length > MAX_CELL_TEXT_CHARS) {
      output = `${`${output}${addition}`.slice(0, MAX_CELL_TEXT_CHARS - 1)}…`;
      notes.push(`combined table header text truncated to ${MAX_CELL_TEXT_CHARS} characters`);
      break;
    }
    output += addition;
  }
  return output;
}

function clampedSpan(value: string | null, name: string, notes: string[]): number {
  const parsed = Number(value ?? "1");
  if (!Number.isInteger(parsed) || parsed < 1) return 1;
  if (parsed > MAX_TABLE_SPAN) {
    notes.push(`${name} clamped to ${MAX_TABLE_SPAN}`);
    return MAX_TABLE_SPAN;
  }
  return parsed;
}

interface BoundedElements {
  elements: Element[];
  overflow: boolean;
}

/**
 * Collects up to `limit` descendant elements with the given tag in document
 * order via depth-first traversal, without materializing a full NodeList of
 * every match. `overflow` reports that additional matches exist beyond the
 * budget. Iterative by design: nesting depth cannot overflow the call stack.
 * Exported for tests.
 */
export function collectBoundedElements(root: Element | Document, tag: string, limit: number): BoundedElements {
  const elements: Element[] = [];
  const start: Element | null =
    root.nodeType === 9 /* Document */ ? (root as Document).documentElement : (root as Element);
  if (!start) return { elements, overflow: false };
  // Iterative pre-order walk over first-child / next-sibling / parent pointers:
  // no recursion (nesting depth cannot overflow the call stack) and no
  // allocation proportional to the number of descendants or matches.
  let node: Element | null = start.firstElementChild;
  while (node) {
    if (node.tagName.toLowerCase() === tag) {
      if (elements.length >= limit) return { elements, overflow: true };
      elements.push(node);
    }
    if (node.firstElementChild) {
      node = node.firstElementChild;
      continue;
    }
    while (node && node !== start && !node.nextElementSibling) node = node.parentElement;
    node = node && node !== start ? node.nextElementSibling : null;
  }
  return { elements, overflow: false };
}

function nearestHeading(element: Element): string {
  const headings = [...element.ownerDocument.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const heading = headings[index]!;
    if ((heading.compareDocumentPosition(element) & 4) !== 0) return cleanText(heading.textContent ?? "");
  }
  return "";
}

interface TableMarkdownChunk {
  markdown: string;
  rows: string[][];
}

function tableMarkdownChunks(label: string, headers: string[], rows: string[][], limit: number, notes: string[] = []): TableMarkdownChunk[] {
  // Bound the heading and repeated header preamble first so even a huge label
  // or many wide headers can never produce an oversized block.
  let heading = `### ${label}`;
  const maxHeadingChars = Math.max(1, limit - 4);
  if (heading.length > maxHeadingChars) {
    heading = `${heading.slice(0, Math.max(0, maxHeadingChars - 1))}…`;
    notes.push("table heading truncated");
  }
  let header = `| ${headers.map(escapeCell).join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |`;
  // Leave room for at least one row line plus its separator in every block.
  const maxHeaderChars = Math.max(1, limit - heading.length - 3);
  if (header.length > maxHeaderChars) {
    header = `${header.slice(0, Math.max(0, maxHeaderChars - 1))}…`;
    notes.push("table header Markdown truncated");
  }
  const preambleLength = heading.length + 1 + header.length;
  const chunks: TableMarkdownChunk[] = [];
  let lines = [heading, header];
  let chunkRows: string[][] = [];
  let chunkChars = preambleLength;
  let totalChars = preambleLength;
  for (const [index, row] of rows.entries()) {
    const raw = `| ${row.map(escapeCell).join(" | ")} |`;
    let line = raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw;
    if (chunkChars + line.length + 1 > limit && lines.length > 2) {
      chunks.push({ markdown: lines.join("\n"), rows: chunkRows });
      lines = [heading, header];
      chunkRows = [];
      chunkChars = preambleLength;
      totalChars += preambleLength;
    }
    if (chunkChars + line.length + 1 > limit) {
      // The chunk still holds only the preamble; trim the line so every
      // emitted block stays within the block limit.
      line = `${line.slice(0, Math.max(0, limit - chunkChars - 2))}…`;
      notes.push("table row Markdown truncated to fit the block limit");
    }
    if (totalChars + line.length + 1 > MAX_TABLE_MARKDOWN_CHARS) {
      // Stop entirely: no further lines are built or discarded past the cap.
      const omittedRows = rows.length - index;
      notes.push(`generated table Markdown capped at ${MAX_TABLE_MARKDOWN_CHARS} characters; ${omittedRows} row(s) omitted`);
      break;
    }
    lines.push(line);
    chunkRows.push(row);
    chunkChars += line.length + 1;
    totalChars += line.length + 1;
  }
  if (lines.length > 2 || chunks.length === 0) chunks.push({ markdown: lines.join("\n"), rows: chunkRows });
  return chunks;
}

function tableMarkdown(label: string, headers: string[], rows: string[][], limit: number): string {
  return tableMarkdownChunks(label, headers, rows, limit)[0]!.markdown;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function paginationLinks(document: Document, base: string): WebPaginationLink[] {
  const output: WebPaginationLink[] = [];
  const seen = new Set<string>();
  for (const anchor of [...document.querySelectorAll("a[href]")]) {
    const text = cleanText(anchor.textContent ?? "");
    const rel = (anchor.getAttribute("rel") ?? "").toLowerCase();
    let relation: WebPaginationLink["relation"] | undefined;
    if (rel.split(/\s+/).includes("next") || /^(next|newer|older)\b/i.test(text)) relation = "next";
    else if (rel.split(/\s+/).includes("prev") || /^(previous|prev)\b/i.test(text)) relation = "previous";
    else if (/^\d{1,4}$/.test(text) && /page|pagination|pager/i.test(anchor.parentElement?.className?.toString() ?? "")) relation = "page";
    if (!relation) continue;
    try {
      const url = new URL(anchor.getAttribute("href") ?? "", base).href;
      if (seen.has(url)) continue;
      seen.add(url);
      output.push({ label: text || relation, url, relation });
      if (output.length >= 20) break;
    } catch { /* ignore malformed pagination link */ }
  }
  return output;
}

function dynamicReasons(document: Document, html: string): string[] {
  const reasons: string[] = [];
  const visibleBody = document.body?.cloneNode(true) as HTMLElement | undefined;
  for (const element of [...visibleBody?.querySelectorAll("script,style,noscript,template") ?? []]) element.remove();
  const bodyText = cleanText(visibleBody?.textContent ?? "");
  const scriptElements = [...document.querySelectorAll("script")];
  const scripts = scriptElements.length;
  const inlineScript = scriptElements
    .filter((script) => !script.getAttribute("src"))
    .map((script) => script.textContent ?? "")
    .join("\n");
  if (bodyText.length < 300 && scripts >= 5) reasons.push("very little server-rendered text relative to script count");
  if (/__NEXT_DATA__|__NUXT__|data-reactroot|ng-version|id=["'](?:root|app)["']/i.test(html) && bodyText.length < 1_000) {
    reasons.push("framework shell detected with limited rendered content");
  }
  if (/\bdocument\s*\.\s*write(?:ln)?\s*\(/i.test(inlineScript)) {
    reasons.push("inline script constructs visible page content with document.write");
  } else if (bodyText.length < 1_000 && /(?:\.\s*(?:innerHTML|outerHTML)\s*(?:\+?=)|\.\s*insertAdjacentHTML\s*\()/i.test(inlineScript)) {
    reasons.push("inline script mutates HTML while server-rendered content is limited");
  }
  if (/enable javascript|javascript is required|please turn on javascript/i.test(bodyText)) reasons.push("page explicitly requires JavaScript");
  return reasons;
}

interface ExecutableScriptSignals {
  count: number;
  inlineBytes: number;
}

function executableScriptSignals(document: Document): ExecutableScriptSignals {
  const scripts = [...document.querySelectorAll("script")].filter(isExecutableScript);
  return {
    count: scripts.length,
    inlineBytes: scripts.reduce((total, script) => total + Buffer.byteLength(script.textContent ?? "", "utf8"), 0),
  };
}

function isExecutableScript(script: Element): boolean {
  const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
  return type === "" || type === "module" || /^(?:text|application)\/(?:java|ecma)script$/.test(type);
}

function extractionDynamicReasons(blocks: WebPageBlock[], scripts: ExecutableScriptSignals): string[] {
  if (scripts.count === 0) return [];
  const readableChars = blocks.reduce((total, block) => total + block.markdown.length, 0);
  if (readableChars === 0) {
    return ["no readable content despite executable scripts"];
  }
  if (readableChars < 500 && scripts.inlineBytes >= 4_096 && scripts.inlineBytes / Math.max(1, readableChars) >= 4) {
    return ["executable script payload greatly exceeds extracted readable content"];
  }
  return [];
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
