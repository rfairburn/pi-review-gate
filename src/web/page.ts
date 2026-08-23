import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const MAX_BLOCK_CHARS = 7_000;
const MAX_TABLES = 64;

export interface WebPageBlock {
  index: number;
  kind: "text" | "code" | "table";
  markdown: string;
  tableId?: string;
}

export interface WebTableDescriptor {
  id: string;
  label: string;
  index: number;
  endIndex: number;
  rows: number;
  columns: number;
  headers: string[];
}

export interface WebPaginationLink {
  label: string;
  url: string;
  relation: "next" | "previous" | "page";
}

export interface ExtractedWebPage {
  url: string;
  title: string;
  byline?: string;
  siteName?: string;
  excerpt?: string;
  blocks: WebPageBlock[];
  tables: WebTableDescriptor[];
  pagination: WebPaginationLink[];
  dynamicContentSuspected: boolean;
  dynamicContentReasons: string[];
}

export interface RenderedWebPage {
  content: string;
  startIndex: number;
  endIndex: number;
  nextIndex?: number;
  totalBlocks: number;
}

export interface WebPageMatch {
  index: number;
  kind: WebPageBlock["kind"];
  snippet: string;
  tableId?: string;
  tableLabel?: string;
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
  for (const element of [...document.querySelectorAll("table")].slice(0, MAX_TABLES)) {
    const table = tableData(element, tables.length + 1);
    if (!table || table.rows.length < 2 || table.columns < 2) continue;
    const start = blocks.length;
    const chunks = tableMarkdownChunks(table.label, table.headers, table.rows, MAX_BLOCK_CHARS);
    for (const markdown of chunks) {
      blocks.push({ index: blocks.length, kind: "table", markdown, tableId: table.id });
    }
    tables.push({
      id: table.id,
      label: table.label,
      index: start,
      endIndex: blocks.length - 1,
      rows: table.rows.length,
      columns: table.columns,
      headers: table.headers,
    });
  }

  return {
    url,
    title: readable?.title?.trim() || cleanText(document.title || "Untitled page"),
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

export function renderWebPage(page: ExtractedWebPage, index: number, maxChars: number): RenderedWebPage {
  if (!Number.isInteger(index) || index < 0) throw new Error("index must be a non-negative integer.");
  if (page.blocks.length === 0) {
    if (index !== 0) throw new Error("This page has no readable block at the requested index.");
    return { content: "", startIndex: 0, endIndex: 0, totalBlocks: 0 };
  }
  if (index >= page.blocks.length) throw new Error(`index ${index} is beyond the final block ${page.blocks.length - 1}.`);
  const selected: WebPageBlock[] = [];
  let chars = 0;
  for (let position = index; position < page.blocks.length; position += 1) {
    const block = page.blocks[position]!;
    const addition = block.markdown.length + (selected.length > 0 ? 2 : 0);
    if (selected.length > 0 && chars + addition > maxChars) break;
    selected.push(block);
    chars += addition;
    if (chars >= maxChars) break;
  }
  const endIndex = selected.at(-1)?.index ?? index;
  return {
    content: selected.map((block) => block.markdown).join("\n\n"),
    startIndex: index,
    endIndex,
    ...(endIndex + 1 < page.blocks.length ? { nextIndex: endIndex + 1 } : {}),
    totalBlocks: page.blocks.length,
  };
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
}

function tableData(table: Element, ordinal: number): ParsedTable | undefined {
  const expanded = expandTableRows([...table.querySelectorAll("tr")]);
  const allRows = expanded.map((row) => row.values).filter((row) => row.some(Boolean));
  if (allRows.length < 2) return undefined;
  const columns = Math.max(...allRows.map((row) => row.length));
  if (columns < 2) return undefined;
  let headerCount = 0;
  for (const row of expanded) {
    if (row.tags.length === 0 || row.tags.some((tag) => tag !== "th")) break;
    headerCount += 1;
  }
  headerCount = Math.min(Math.max(1, headerCount), Math.max(1, allRows.length - 1));
  const headerRows = allRows.slice(0, headerCount);
  const headers = Array.from({ length: columns }, (_, column) => {
    const values = headerRows.map((row) => row[column]).filter((value): value is string => Boolean(value));
    const unique = values.filter((value, index) => values.indexOf(value) === index);
    return unique.join(" ") || `Column ${column + 1}`;
  });
  const caption = cleanText(table.querySelector("caption")?.textContent ?? "");
  const heading = nearestHeading(table);
  return {
    id: `table-${ordinal}`,
    label: caption || heading || `Table ${ordinal}`,
    headers,
    rows: allRows.slice(headerCount).map((row) => Array.from({ length: columns }, (_, column) => row[column] ?? "")),
    columns,
  };
}

interface ExpandedTableRow {
  values: string[];
  tags: string[];
}

function expandTableRows(rows: Element[]): ExpandedTableRow[] {
  const output: ExpandedTableRow[] = [];
  const spans = new Map<number, { value: string; tag: string; remaining: number }>();
  for (const row of rows) {
    const values: string[] = [];
    const tags: string[] = [];
    for (const [column, span] of [...spans]) {
      values[column] = span.value;
      tags[column] = span.tag;
      span.remaining -= 1;
      if (span.remaining <= 0) spans.delete(column);
    }
    let column = 0;
    const cells = [...row.children].filter((child) => ["th", "td"].includes(child.tagName.toLowerCase()));
    for (const cell of cells) {
      while (values[column] !== undefined) column += 1;
      const value = cleanText(cell.textContent ?? "");
      const tag = cell.tagName.toLowerCase();
      const colspan = positiveSpan(cell.getAttribute("colspan"));
      const rowspan = positiveSpan(cell.getAttribute("rowspan"));
      for (let offset = 0; offset < colspan; offset += 1) {
        values[column + offset] = value;
        tags[column + offset] = tag;
        if (rowspan > 1) spans.set(column + offset, { value, tag, remaining: rowspan - 1 });
      }
      column += colspan;
    }
    if (values.some(Boolean)) output.push({ values, tags });
  }
  return output;
}

function positiveSpan(value: string | null): number {
  const parsed = Number(value ?? "1");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function nearestHeading(element: Element): string {
  const headings = [...element.ownerDocument.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const heading = headings[index]!;
    if ((heading.compareDocumentPosition(element) & 4) !== 0) return cleanText(heading.textContent ?? "");
  }
  return "";
}

function tableMarkdownChunks(label: string, headers: string[], rows: string[][], limit: number): string[] {
  const heading = `### ${label}`;
  const header = `| ${headers.map(escapeCell).join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |`;
  const chunks: string[] = [];
  let lines = [heading, header];
  for (const row of rows) {
    const line = `| ${row.map(escapeCell).join(" | ")} |`;
    if (lines.join("\n").length + line.length + 1 > limit && lines.length > 2) {
      chunks.push(lines.join("\n"));
      lines = [heading, header];
    }
    lines.push(line.length > limit ? `${line.slice(0, limit - 1)}…` : line);
  }
  if (lines.length > 2 || chunks.length === 0) chunks.push(lines.join("\n"));
  return chunks;
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
  const bodyText = cleanText(document.body?.textContent ?? "");
  const scripts = document.querySelectorAll("script").length;
  if (bodyText.length < 300 && scripts >= 5) reasons.push("very little server-rendered text relative to script count");
  if (/__NEXT_DATA__|__NUXT__|data-reactroot|ng-version|id=["'](?:root|app)["']/i.test(html) && bodyText.length < 1_000) {
    reasons.push("framework shell detected with limited rendered content");
  }
  if (/enable javascript|javascript is required|please turn on javascript/i.test(bodyText)) reasons.push("page explicitly requires JavaScript");
  return reasons;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
