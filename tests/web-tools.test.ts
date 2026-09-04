import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { assertChromiumAvailable, assertSuccessfulBrowserNavigation, missingChromiumError } from "../src/web/browser";
import { WebPageCache } from "../src/web/cache";
import { canonicalSearchUrl, normalizeDdgsResults, searchDdgs, type DdgsRunner } from "../src/web/network";
import { parseHTML } from "linkedom";
import { collectBoundedElements, extractWebPage, findInWebPage, renderWebPage } from "../src/web/page";
import { extractPdfDocument, isPdfResponse } from "../src/web/pdf";
import type { InteractiveBrowserManager } from "../src/web/interactive-browser";
import { formatSearch, WebToolManager } from "../src/web/tools";

const fixture = `<!doctype html><html><head><title>Population fixture</title></head><body>
<main><h1>Largest cities</h1>${Array.from({ length: 20 }, (_, index) => `<p>Context paragraph ${index} with enough useful content for extraction and structural indexing.</p>`).join("")}</main>
<h2>Population table</h2>
<table><thead><tr><th rowspan="2">City</th><th colspan="2">Population</th></tr><tr><th>2020</th><th>2025</th></tr></thead>
<tbody><tr><td>New York</td><td>8,804,190</td><td>8,584,629</td></tr><tr><td>Los Angeles</td><td>3,898,747</td><td>3,869,089</td></tr></tbody></table>
<nav class="pagination"><a rel="next" href="/page/2">Next</a></nav></body></html>`;

function pdfFixture(pages: string[], title = "Population report"): Uint8Array {
  const objects: string[] = [];
  const pageObjectNumbers = pages.map((_, index) => 3 + index * 2);
  const fontObjectNumber = 3 + pages.length * 2;
  const infoObjectNumber = fontObjectNumber + 1;
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  for (const [index, text] of pages.entries()) {
    const pageObjectNumber = pageObjectNumbers[index]!;
    const contentObjectNumber = pageObjectNumber + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`);
    const lines = text.split("\n").map((line) => line.replace(/([\\()])/g, "\\$1"));
    const stream = text ? `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET` : "";
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push(`<< /Title (${title.replace(/([\\()])/g, "\\$1")}) /Author (Review Gate Tests) >>`);

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoObjectNumber} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("BrowserExtract accepts only successful final main-document responses", () => {
  assert.doesNotThrow(() => assertSuccessfulBrowserNavigation(200, "https://example.com/page"));
  assert.doesNotThrow(() => assertSuccessfulBrowserNavigation(204, "https://example.com/no-content"));
  assert.throws(
    () => assertSuccessfulBrowserNavigation(404, "https://example.com/missing"),
    /HTTP 404.*https:\/\/example\.com\/missing/,
  );
  assert.throws(
    () => assertSuccessfulBrowserNavigation(undefined, "https://example.com/no-response"),
    /no HTTP response/,
  );
});

test("BrowserExtract explains how to install missing Chromium", () => {
  assert.throws(
    () => assertChromiumAvailable("/missing/playwright/chromium", () => false),
    /Playwright Chromium is not installed.*BrowserExtract cannot run.*npx playwright install chromium.*PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM/,
  );
  assert.match(missingChromiumError("/missing/playwright/chromium").message, /unset PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM/);
});

test("full-page extraction reports tables beyond the current view and supports direct indexed reads", () => {
  const page = extractWebPage(fixture, "https://example.com/cities");
  const first = renderWebPage(page, 0, 1_000);
  assert.ok(first.nextIndex !== undefined);
  assert.equal(page.tables.length, 1);
  const table = page.tables[0]!;
  assert.ok(table.index > first.endIndex);
  assert.deepEqual(table.headers, ["City", "Population 2020", "Population 2025"]);
  assert.equal(table.label, "Population table");
  const direct = renderWebPage(page, table.index, 4_000);
  assert.match(direct.content, /New York/);
  assert.match(direct.content, /Los Angeles/);
  assert.equal(page.pagination[0]?.url, "https://example.com/page/2");
});

test("within-page search locates structural and table blocks without another tool", () => {
  const page = extractWebPage(fixture, "https://example.com/cities");
  const city = findInWebPage(page, "Los Angeles");
  assert.equal(city.totalMatches, 1);
  assert.equal(city.matches[0]?.index, page.tables[0]?.index);
  assert.equal(city.matches[0]?.tableLabel, "Population table");
  assert.match(city.matches[0]?.snippet ?? "", /Los Angeles/);

  const later = findInWebPage(page, "Context paragraph", 10, 3);
  assert.ok(later.totalMatches > later.matches.length);
  assert.equal(later.matchesTruncated, true);
  assert.ok(later.matches.every((match) => match.index >= 10));
});

test("table reads project semantic columns and retain numeric fallback for ambiguous headers", () => {
  const page = extractWebPage(fixture, "https://example.com/cities");
  const tableIndex = page.tables[0]!.index;
  const projected = renderWebPage(page, tableIndex, 4_000, ["City", "population 2025"]);
  assert.deepEqual(projected.projectedColumns, ["City", "Population 2025"]);
  assert.match(projected.content, /New York.*8,584,629/);
  assert.doesNotMatch(projected.content, /8,804,190|3,898,747/);

  const duplicatePage = extractWebPage(
    `<html><body><h1>Areas</h1><table><tr><th>Area</th><th>Area</th></tr><tr><td>10</td><td>20</td></tr><tr><td>30</td><td>40</td></tr></table></body></html>`,
    "https://example.com/areas",
  );
  const duplicateIndex = duplicatePage.tables[0]!.index;
  assert.throws(() => renderWebPage(duplicatePage, duplicateIndex, 4_000, ["Area"]), /ambiguous.*#1 Area; #2 Area/);
  const secondArea = renderWebPage(duplicatePage, duplicateIndex, 4_000, ["#2"]);
  assert.match(secondArea.content, /\| 20 \|/);
  assert.doesNotMatch(secondArea.content, /\| 10 \|/);
  assert.throws(() => renderWebPage(page, 0, 4_000, ["City"]), /index points directly to a table block/);
  assert.throws(() => renderWebPage(page, tableIndex, 4_000, ["Unknown"]), /unknown column selector.*#1 City/);
});

test("dynamic-content suspicion is explicit for script-heavy empty application shells", () => {
  const page = extractWebPage(`<html><body><div id="root"></div>${"<script>void 0</script>".repeat(8)}</body></html>`, "https://example.com/app");
  assert.equal(page.dynamicContentSuspected, true);
  assert.ok(page.dynamicContentReasons.length > 0);
});

test("dynamic-content suspicion detects inline DOM construction without counting script data as visible text", () => {
  const page = extractWebPage(`
    <html><body>
      <h1>Quotes</h1><a href="/login">Login</a>
      <script src="/jquery.js"></script>
      <script>
        const data = [{ text: "The primary quote is embedded here but not server-rendered." }];
        for (const item of data) document.write("<div class='quote'>" + item.text + "</div>");
      </script>
      <a href="/page/2">Next</a>
    </body></html>
  `, "https://example.com/js/");
  assert.equal(page.dynamicContentSuspected, true);
  assert.deepEqual(page.dynamicContentReasons, ["inline script constructs visible page content with document.write"]);
});

test("embedded script data alone does not imply missing rendered content", () => {
  const page = extractWebPage(`
    <html><body>
      <main><h1>Complete article</h1><p>${"Server-rendered article text. ".repeat(50)}</p></main>
      <script type="application/ld+json">{"headline":"Complete article"}</script>
      <script>window.analyticsConfig = { enabled: true };</script>
    </body></html>
  `, "https://example.com/article");
  assert.equal(page.dynamicContentSuspected, false);
  assert.deepEqual(page.dynamicContentReasons, []);
});

test("dynamic-content suspicion detects a modern hydration shell from extraction outcome", () => {
  const page = extractWebPage(`
    <html><head><title>Modern application</title></head><body>
      <div class="application-shell"></div>
      <script type="application/json">${JSON.stringify({ hydration: "data".repeat(2_000) })}</script>
      <script type="module" src="/assets/runtime.js"></script>
      <script type="module" src="/assets/application.js"></script>
    </body></html>
  `, "https://example.com/modern");
  assert.equal(page.dynamicContentSuspected, true);
  assert.deepEqual(page.dynamicContentReasons, ["no readable content despite executable scripts"]);
});

test("an empty static page or structured-data-only page does not imply dynamic rendering", () => {
  const empty = extractWebPage("<html><body></body></html>", "https://example.com/empty");
  const structured = extractWebPage(
    `<html><body><script type="application/ld+json">${JSON.stringify({ name: "Metadata only" })}</script></body></html>`,
    "https://example.com/structured",
  );
  assert.equal(empty.dynamicContentSuspected, false);
  assert.equal(structured.dynamicContentSuspected, false);
});

test("dynamic-content suspicion compares executable payload with sparse readable output", () => {
  const hydration = `self.__application_chunks.push(${JSON.stringify("rendered content ".repeat(300))});`;
  const page = extractWebPage(`
    <html><body>
      <nav><p><a href="/login">Login</a></p></nav>
      <script>${hydration}</script>
    </body></html>
  `, "https://example.com/hydrated");
  assert.equal(page.dynamicContentSuspected, true);
  assert.ok(page.dynamicContentReasons.includes("executable script payload greatly exceeds extracted readable content"));
});

test("image payloads are excluded while nearby captions and prose remain searchable", () => {
  const page = extractWebPage(
    `<html><body><main><h1>Atlas</h1><figure><img alt="Phoenix map marker" src="marker.svg"><figcaption>Map of major cities</figcaption></figure><p>Phoenix population details are tabulated below.</p></main></body></html>`,
    "https://example.com/atlas",
  );
  const markdown = page.blocks.map((block) => block.markdown).join("\n");
  assert.doesNotMatch(markdown, /marker\.svg|Phoenix map marker|!\[/);
  assert.match(markdown, /Map of major cities|Phoenix population details/);
  assert.equal(findInWebPage(page, "Phoenix").totalMatches, 1);
});

test("PDF detection accepts either response metadata or file magic", () => {
  const pdf = pdfFixture(["First page"]);
  assert.equal(isPdfResponse("application/octet-stream", pdf), true);
  assert.equal(isPdfResponse("application/pdf", pdf), true);
  assert.equal(isPdfResponse("text/html", Buffer.from("<html></html>")), false);
  assert.equal(isPdfResponse("application/pdf", undefined, "<html></html>"), false);
});

test("invalid PDF data produces a document-specific extraction error", async () => {
  await assert.rejects(
    extractPdfDocument(Buffer.from("%PDF-1.4\nnot a valid document", "latin1"), "https://example.com/broken.pdf"),
    /PDF extraction failed.*(?:invalid|corrupt|Invalid PDF structure)/i,
  );
});

test("WebFetch parses PDFs into cached page-aware blocks with find and continuation", async () => {
  const config = normalizeConfig({});
  const pdf = pdfFixture([
    ["The first page discusses New York.", ...Array.from({ length: 80 }, (_, index) => `Supporting population context line ${index}.`)].join("\n"),
    "The second page discusses Phoenix.",
  ], "City estimates");
  let downloads = 0;
  const cache = new WebPageCache(config.web!.fetch, async (url) => {
    downloads += 1;
    return {
      requestedUrl: url,
      finalUrl: url,
      contentType: "application/octet-stream",
      text: new TextDecoder("latin1").decode(pdf),
      data: pdf,
      bytes: pdf.byteLength,
      fetchedAt: "2026-08-23T00:00:00.000Z",
    };
  });

  const first = await cache.fetch({ url: "https://example.com/report.pdf", maxChars: 1_000 });
  assert.equal(first.documentType, "pdf");
  assert.equal(first.title, "City estimates");
  assert.equal(first.pageCount, 2);
  assert.equal(first.startPage, 1);
  assert.equal(first.endPage, 1);
  assert.equal(first.scannedOrImageOnlySuspected, false);
  assert.equal(first.pdfMetadata?.author, "Review Gate Tests");
  assert.match(first.content, /## Page 1[\s\S]*New York/);
  assert.equal(first.nextIndex, 1);

  const second = await cache.fetch({ url: "https://example.com/report.pdf", index: first.nextIndex });
  assert.equal(second.cacheHit, true);
  assert.equal(second.startPage, 2);
  assert.match(second.content, /## Page 2[\s\S]*Phoenix/);
  assert.equal(downloads, 1);

  const found = await cache.fetch({ url: "https://example.com/report.pdf", find: "Phoenix" });
  assert.equal(found.find?.matches[0]?.index, 1);
  assert.equal(found.find?.matches[0]?.pageNumber, 2);
  const cacheRoot = cache.cacheRoot()!;
  const sourceFile = (await readdir(cacheRoot)).find((name) => name.endsWith(".source"));
  assert.ok(sourceFile);
  assert.equal((await readFile(`${cacheRoot}/${sourceFile}`)).subarray(0, 5).toString("latin1"), "%PDF-");
  await assert.rejects(
    cache.fetch({ url: "https://example.com/report.pdf", index: 0, columns: ["City"] }),
    /columns are not available for PDF documents/,
  );
  await cache.cleanup();
});

test("WebFetch reports PDFs with no extractable text as likely scanned or image-only", async () => {
  const config = normalizeConfig({});
  const pdf = pdfFixture([""]);
  const cache = new WebPageCache(config.web!.fetch, async (url) => ({
    requestedUrl: url,
    finalUrl: url,
    contentType: "application/pdf",
    text: new TextDecoder("latin1").decode(pdf),
    data: pdf,
    bytes: pdf.byteLength,
    fetchedAt: "2026-08-23T00:00:00.000Z",
  }));
  const fetched = await cache.fetch({ url: "https://example.com/scan.pdf" });
  assert.equal(fetched.documentType, "pdf");
  assert.equal(fetched.pageCount, 1);
  assert.equal(fetched.scannedOrImageOnlySuspected, true);
  assert.equal(fetched.content, "");
  await cache.cleanup();
});

test("WebFetch keeps its existing tool contract while formatting PDF navigation", async () => {
  const config = normalizeConfig({});
  const pdf = pdfFixture(["A PDF page containing Phoenix population evidence."], "PDF navigation");
  const cache = new WebPageCache(config.web!.fetch, async (url) => ({
    requestedUrl: url,
    finalUrl: url,
    contentType: "application/pdf",
    text: new TextDecoder("latin1").decode(pdf),
    data: pdf,
    bytes: pdf.byteLength,
    fetchedAt: "2026-08-23T00:00:00.000Z",
  }));
  const tools = new Map<string, any>();
  const manager = new WebToolManager({ registerTool: (tool) => tools.set(tool.name, tool) }, config, cache);
  manager.register();
  assert.deepEqual(Object.keys(tools.get("WebFetch").parameters.properties), ["url", "index", "find", "columns", "maxChars", "refresh"]);

  const fetched = await tools.get("WebFetch").execute("pdf", { url: "https://example.com/report.pdf" });
  const output = fetched.content[0].text as string;
  assert.match(output, /PDF document: PDF navigation/);
  assert.match(output, /PDF pages: 1/);
  assert.match(output, /Showing index 0-0 of 0 · page 1/);
  assert.match(output, /scanned_or_image_only_suspected: false/);
  assert.match(output, /## Page 1[\s\S]*Phoenix/);

  const found = await tools.get("WebFetch").execute("pdf-find", { url: "https://example.com/report.pdf", find: "Phoenix" });
  assert.match(found.content[0].text as string, /index 0 · text · page 1/);
  await manager.cleanup();
});

test("DDGS result normalization removes tracking, deduplicates URLs, and retains available dates", () => {
  assert.deepEqual(normalizeDdgsResults([{
    title: "Cities",
    href: "https://www.example.com/cities/?utm_source=search&b=2&a=1",
    body: "Population data for the largest cities in the country.",
    date: "Aug 22, 2026",
  }, {
    title: "Duplicate",
    href: "http://example.com/cities?a=1&b=2#table",
    body: "Duplicate result.",
  }, {
    title: "Short",
    href: "https://example.org/short",
    body: "with residents.",
  }, {
    title: "Dated",
    href: "https://dated.example/report",
    body: "Aug 21, 2026 — A complete provider excerpt with a date prefix and enough context to be useful.",
  }]), [{
    rank: 1,
    title: "Cities",
    url: "https://www.example.com/cities/?a=1&b=2",
    hostname: "www.example.com",
    snippet: "Population data for the largest cities in the country.",
    dateText: "Aug 22, 2026",
    dateSource: "provider",
  }, {
    rank: 2,
    title: "Short",
    url: "https://example.org/short",
    hostname: "example.org",
    snippet: "with residents.",
    snippetQuality: "weak",
  }, {
    rank: 3,
    title: "Dated",
    url: "https://dated.example/report",
    hostname: "dated.example",
    snippet: "Aug 21, 2026 — A complete provider excerpt with a date prefix and enough context to be useful.",
    dateText: "Aug 21, 2026",
    dateSource: "provider",
  }]);
  assert.equal(canonicalSearchUrl("https://www.example.com/cities/?b=2&utm_medium=x&a=1"), "example.com/cities?a=1&b=2");
});

test("WebSearch passes the requested result count directly without pagination", async () => {
  const result = (href: string, title: string) => ({ href, title, body: `A sufficiently complete provider snippet describing ${title} for search testing.` });
  const calls: Parameters<DdgsRunner>[0][] = [];
  const run: DdgsRunner = async (request) => {
    calls.push(request);
    return { results: [result("https://one.example/a", "One"), result("https://two.example/b", "Two")] };
  };
  const common = {
    query: "cities",
    maxResults: 2,
    excludeDomains: ["noise.example", "NOISE.EXAMPLE"],
    options: { timeoutMs: 1_000 },
    run,
  };

  const first = await searchDdgs(common);
  assert.deepEqual(first.results.map((item) => [item.rank, item.title]), [[1, "One"], [2, "Two"]]);
  assert.deepEqual(first.excludedDomains, ["noise.example"]);
  assert.equal(calls[0]!.query, "cities -site:noise.example");
  assert.equal(calls[0]!.maxResults, 2);
  assert.equal(calls[0]!.region, "us-en");
  await assert.rejects(
    searchDdgs({ ...common, domain: "noise.example" }),
    /cannot also be excluded/,
  );
});

test("WebSearch retries one empty DDGS provider result", async () => {
  let attempts = 0;
  const requestedCounts: number[] = [];
  const run: DdgsRunner = async (request) => {
    attempts += 1;
    requestedCounts.push(request.maxResults);
    if (attempts === 1) return { results: [] };
    return {
      results: [{ title: "Recovered", href: "https://example.com/recovered", body: "A valid result returned by the retry attempt." }],
    };
  };
  const response = await searchDdgs({
    query: "known good query",
    maxResults: 5,
    options: { timeoutMs: 1_000 },
    run,
  });
  assert.equal(attempts, 2);
  assert.deepEqual(requestedCounts, [5, 5]);
  assert.equal(response.results[0]?.title, "Recovered");
});

test("WebSearch reports provider date coverage without inferring missing dates", () => {
  const base = {
    provider: "ddgs" as const,
    query: "cities",
    fetchedAt: "2026-08-23T00:00:00.000Z",
    durationMs: 12,
  };
  const result = (rank: number, dateText?: string) => ({
    rank,
    title: `Result ${rank}`,
    url: `https://example.com/${rank}`,
    hostname: "example.com",
    snippet: "A complete provider snippet with enough content for this formatting test.",
    ...(dateText ? { dateText, dateSource: "provider" as const } : {}),
  });

  assert.match(formatSearch({ ...base, results: [result(1), result(2)] }), /unavailable for all 2 result\(s\); dates were not inferred/);
  assert.match(formatSearch({ ...base, results: [result(1, "Aug 23, 2026"), result(2)] }), /supplied for 1\/2 result\(s\); absent dates were not inferred/);
  assert.match(formatSearch({ ...base, results: [result(1, "Aug 23, 2026"), result(2, "Aug 22, 2026")] }), /supplied for all 2 result\(s\)/);
});

test("WebFetch reuses its session cache, exposes table indexes, and removes the cache on shutdown", async () => {
  const config = normalizeConfig({});
  let downloads = 0;
  let browserRenders = 0;
  const cache = new WebPageCache(config.web!.fetch, async (url) => {
    downloads += 1;
    return {
      requestedUrl: url,
      finalUrl: url,
      contentType: "text/html; charset=utf-8",
      text: fixture,
      bytes: Buffer.byteLength(fixture),
      fetchedAt: "2026-08-23T00:00:00.000Z",
    };
  });
  const tools = new Map<string, any>();
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const browserCache = new WebPageCache(config.web!.fetch, async (url) => {
    browserRenders += 1;
    const rendered = fixture.replace("Largest cities", "Rendered largest cities");
    return {
      requestedUrl: url,
      finalUrl: url,
      contentType: "text/html; charset=utf-8",
      text: rendered,
      bytes: Buffer.byteLength(rendered),
      fetchedAt: "2026-08-23T00:00:01.000Z",
      browserOmissions: {
        count: 3,
        truncated: true,
        entries: [
          "passive resource omitted before any connection: image https://cdn.other.test/a.png",
          "connect destination refused: Hostname did not resolve: unresolved.test (https://unresolved.test:8080/).",
          "byte budget exceeded for slow.test:443 (8388608 bytes); connection destroyed.",
        ],
      },
    };
  });
  const manager = new WebToolManager({
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, handler) => hooks.set(name, handler),
  }, config, cache, browserCache);
  manager.register();
  assert.deepEqual([...tools.keys()], [
    "WebSearch", "WebFetch", "BrowserExtract",
    "BrowserOpen", "BrowserNavigate", "BrowserSnapshot", "BrowserScreenshot",
    "BrowserScroll", "BrowserWait", "BrowserHistory", "BrowserTabs", "BrowserClose",
  ]);
  assert.deepEqual(Object.keys(tools.get("BrowserOpen").parameters.properties), ["url"]);
  assert.deepEqual(Object.keys(tools.get("BrowserNavigate").parameters.properties), ["session", "tab", "url"]);
  assert.deepEqual(Object.keys(tools.get("BrowserSnapshot").parameters.properties), ["session", "tab", "maxChars"]);
  assert.deepEqual(Object.keys(tools.get("BrowserScreenshot").parameters.properties), ["session", "tab", "mode", "ref"]);
  assert.deepEqual(tools.get("BrowserScreenshot").parameters.required, ["session", "tab", "mode"]);
  assert.deepEqual(Object.keys(tools.get("BrowserScroll").parameters.properties), ["session", "tab", "target", "direction", "amount", "ref"]);
  assert.deepEqual(Object.keys(tools.get("BrowserWait").parameters.properties), ["session", "tab", "condition", "ref", "state", "text", "present", "url", "match", "durationMs", "timeoutMs"]);
  assert.deepEqual(Object.keys(tools.get("BrowserHistory").parameters.properties), ["session", "tab", "operation", "maxEntries"]);
  assert.deepEqual(Object.keys(tools.get("BrowserTabs").parameters.properties), ["session", "operation", "tab", "url"]);
  assert.deepEqual(Object.keys(tools.get("BrowserClose").parameters.properties), ["session"]);
  assert.match(tools.get("BrowserSnapshot").description, /no DOM script, selector, coordinate, or CDP/i);
  assert.match(tools.get("BrowserScreenshot").description, /Pi image content.*not a file path or textual encoding/i);
  assert.equal(tools.has("WebRead"), false);
  assert.ok(tools.get("WebSearch").parameters.properties.excludeDomains);
  assert.equal(tools.get("WebSearch").parameters.properties.page, undefined);
  assert.equal(tools.get("WebSearch").parameters.properties.cursor, undefined);
  assert.deepEqual(
    Object.keys(tools.get("BrowserExtract").parameters.properties),
    Object.keys(tools.get("WebFetch").parameters.properties),
  );
  assert.match(tools.get("BrowserExtract").promptSnippet, /only after WebFetch/);

  const first = await tools.get("WebFetch").execute("one", { url: "https://example.com/cities", maxChars: 1_000 });
  const firstText = first.content[0].text as string;
  assert.match(firstText, /Tables discovered across the full page/);
  assert.match(firstText, /Population table/);
  assert.match(firstText, /dynamic_content_suspected: false — no static heuristic detected; this does not prove the page is complete/);
  assert.match(firstText, /Cache scope: current session\./);
  const tableIndex = (first.details.response.tables[0].index) as number;
  const second = await tools.get("WebFetch").execute("two", { url: "https://example.com/cities", index: tableIndex });
  assert.match(second.content[0].text as string, /New York/);
  assert.match(second.content[0].text as string, /session cache/);
  assert.equal(downloads, 1);

  const projected = await tools.get("WebFetch").execute("project", {
    url: "https://example.com/cities",
    index: tableIndex,
    columns: ["City", "Population 2025"],
  });
  assert.match(projected.content[0].text as string, /Projected columns: City \| Population 2025/);
  assert.match(projected.content[0].text as string, /New York.*8,584,629/s);
  assert.doesNotMatch(projected.content[0].text as string, /8,804,190/);
  assert.equal(downloads, 1);

  const invalidProjection = await tools.get("WebFetch").execute("invalid-project", {
    url: "https://example.com/cities",
    find: "New York",
    columns: ["City"],
  });
  assert.equal(invalidProjection.isError, true);
  assert.match(invalidProjection.content[0].text as string, /find and columns cannot be used together/);

  const found = await tools.get("WebFetch").execute("find", { url: "https://example.com/cities", find: "Los Angeles" });
  assert.match(found.content[0].text as string, /Find "Los Angeles"/);
  assert.match(found.content[0].text as string, new RegExp(`index ${tableIndex}`));
  assert.match(found.content[0].text as string, /Los Angeles/);
  assert.equal(downloads, 1);

  const browserFirst = await tools.get("BrowserExtract").execute("browser-one", {
    url: "https://example.com/cities",
    find: "Rendered largest cities",
  });
  assert.match(browserFirst.content[0].text as string, /Find "Rendered largest cities"/);
  assert.match(browserFirst.content[0].text as string, /BrowserExtract/);
  // Bounded omission warnings must be visible in the model-facing tool text.
  assert.match(browserFirst.content[0].text as string, /browser_omissions: 3 subresource\(s\) omitted during the render \(diagnostics truncated; more omissions occurred\)\./);
  assert.match(browserFirst.content[0].text as string, /- passive resource omitted before any connection: image https:\/\/cdn\.other\.test\/a\.png/);
  const browserIndex = browserFirst.details.response.find.matches[0].index as number;
  const browserSecond = await tools.get("BrowserExtract").execute("browser-two", {
    url: "https://example.com/cities",
    index: browserIndex,
  });
  assert.match(browserSecond.content[0].text as string, /Rendered largest cities/);
  assert.match(browserSecond.content[0].text as string, /session cache/);
  assert.equal(browserRenders, 1);

  const root = manager.cacheRoot();
  const browserRoot = manager.browserCacheRoot();
  assert.ok(root);
  assert.ok(browserRoot);
  await access(root);
  await access(browserRoot);
  await hooks.get("session_shutdown")?.();
  await assert.rejects(access(root), /ENOENT/);
  await assert.rejects(access(browserRoot), /ENOENT/);
});

test("BrowserScreenshot returns Pi image content and fails with BrowserSnapshot guidance without vision", async () => {
  const config = normalizeConfig({});
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  let captures = 0;
  const metadata = {
    session: "browser_session_fixture",
    tab: "tab_fixture",
    generation: "generation_fixture",
    url: "https://example.com/visual",
    title: "Untrusted visual fixture",
    mode: "viewport" as const,
    mimeType: "image/png" as const,
    width: 1,
    height: 1,
    encodedBytes: png.byteLength,
    limits: {
      maxWidth: 2_000,
      maxHeight: 2_000,
      maxPixels: 4_000_000,
      maxEncodedBytes: 4 * 1024 * 1024,
      maxAllocationBytes: 32 * 1024 * 1024,
    },
  };
  const interactive = {
    screenshot: async () => {
      captures += 1;
      return { image: png, metadata };
    },
    updateConfig() {},
    async shutdown() {},
  } as unknown as InteractiveBrowserManager;
  const tools = new Map<string, any>();
  const manager = new WebToolManager(
    { registerTool: (tool) => tools.set(tool.name, tool) },
    config,
    undefined,
    undefined,
    interactive,
  );
  manager.register();
  const screenshot = tools.get("BrowserScreenshot");

  const unsupported = await screenshot.execute(
    "no-vision",
    { session: "s", tab: "t", mode: "viewport" },
    undefined,
    undefined,
    { model: { input: ["text"] } },
  );
  assert.equal(unsupported.isError, true);
  assert.match(unsupported.content[0].text, /use BrowserSnapshot/i);
  assert.equal(captures, 0, "unsupported delivery is rejected before browser capture");

  const supported = await screenshot.execute(
    "vision",
    { session: "s", tab: "t", mode: "viewport" },
    undefined,
    undefined,
    { model: { input: ["text", "image"] } },
  );
  assert.equal(supported.isError, false);
  assert.equal(captures, 1);
  assert.deepEqual(supported.content.map((item: { type: string }) => item.type), ["text", "image"]);
  assert.deepEqual(supported.content[1], {
    type: "image",
    data: png.toString("base64"),
    mimeType: "image/png",
  });
  assert.deepEqual(supported.details, { response: metadata });
  assert.equal(JSON.stringify(supported.details).includes(png.toString("base64")), false);
  assert.doesNotMatch(supported.content[0].text, new RegExp(png.toString("base64")));
  assert.match(supported.content[0].text, /1x1.*encoded bytes/);
  await manager.cleanup();
});

test("WebFetch gives a direct BrowserExtract escalation when static extraction suspects JavaScript", async () => {
  const config = normalizeConfig({});
  const shell = `<html><body><div id="root"></div>${"<script>void 0</script>".repeat(8)}</body></html>`;
  const staticCache = new WebPageCache(config.web!.fetch, async (url) => ({
    requestedUrl: url,
    finalUrl: url,
    contentType: "text/html",
    text: shell,
    bytes: Buffer.byteLength(shell),
    fetchedAt: "2026-08-23T00:00:00.000Z",
  }));
  const browserCache = new WebPageCache(config.web!.fetch, async (url) => ({
    requestedUrl: url,
    finalUrl: url,
    contentType: "text/html",
    text: "<html><body><main><h1>Rendered application</h1><p>The JavaScript result is now present.</p></main></body></html>",
    bytes: 111,
    fetchedAt: "2026-08-23T00:00:01.000Z",
  }));
  const tools = new Map<string, any>();
  const manager = new WebToolManager({ registerTool: (tool) => tools.set(tool.name, tool) }, config, staticCache, browserCache);
  manager.register();
  const staticResult = await tools.get("WebFetch").execute("static", { url: "https://example.com/app" });
  assert.match(staticResult.content[0].text as string, /dynamic_content_suspected: true/);
  assert.match(staticResult.content[0].text as string, /use BrowserExtract/i);
  await manager.cleanup();
});

test("web cache configuration updates apply to subsequent acquisitions", async () => {
  const config = normalizeConfig({});
  const observedLimits: number[] = [];
  const cache = new WebPageCache(config.web!.fetch, async (url, options) => {
    observedLimits.push(options.maxBytes);
    return {
      requestedUrl: url,
      finalUrl: url,
      contentType: "text/html",
      text: "<html><body><p>Configuration update fixture.</p></body></html>",
      bytes: 64,
      fetchedAt: "2026-08-23T00:00:00.000Z",
    };
  });
  await cache.fetch({ url: "https://example.com/first" });
  cache.updateConfig({ ...config.web!.fetch, maxDownloadBytes: 96 * 1024 * 1024 });
  await cache.fetch({ url: "https://example.com/second" });
  assert.deepEqual(observedLimits, [50 * 1024 * 1024, 96 * 1024 * 1024]);
  await cache.cleanup();
});

test("adversarial billion colspan and rowspan are clamped before expansion", () => {
  const html = `<html><body><h1>Spans</h1><table><tr><th>A</th><th>B</th></tr>`
    + `<tr><td colspan="1000000000">wide</td><td>tail</td></tr>`
    + `<tr><td rowspan="9999999999">tall</td><td>v2</td></tr></table></body></html>`;
  const startedAt = Date.now();
  const page = extractWebPage(html, "https://example.com/spans");
  const table = page.tables[0]!;
  assert.equal(table.columns, 256);
  assert.equal(table.truncated, true);
  assert.ok(table.truncationNotes!.includes("colspan clamped to 1000"));
  assert.ok(table.truncationNotes!.includes("rowspan clamped to 1000"));
  assert.ok(table.truncationNotes!.includes("table columns capped at 256"));
  assert.equal(table.rows, 2);
  const bodyRows = page.blocks.filter((block) => block.tableId === table.id).flatMap((block) => block.tableRows ?? []);
  const wideRow = bodyRows[0]!;
  assert.equal(wideRow.length, 256);
  assert.ok(wideRow.every((cell) => cell === "wide"));
  const tallRow = bodyRows[1]!;
  assert.equal(tallRow[0], "tall");
  assert.equal(tallRow[1], "v2");
  for (const block of page.blocks) assert.ok(block.markdown.length <= 7_000);
  assert.ok(Date.now() - startedAt < 5_000);
});

test("table row budget caps expanded rows and reports the truncation", () => {
  const rows = Array.from({ length: 5_000 }, (_, index) => `<tr><td>r${index}</td><td>${index}</td></tr>`).join("");
  const page = extractWebPage(
    `<html><body><h1>Wide rows</h1><table><tr><th>Name</th><th>Value</th></tr>${rows}</table></body></html>`,
    "https://example.com/many-rows",
  );
  const table = page.tables[0]!;
  assert.equal(table.rows, 1_999);
  assert.equal(table.truncated, true);
  assert.ok(table.truncationNotes!.includes("table rows capped at 2000"));
  const lastBodyRow = page.blocks[table.endIndex]!.tableRows!.at(-1)!;
  assert.equal(lastBodyRow[0], "r1998");
});

test("table cell budget caps total expanded cells before allocation", () => {
  const headerRow = `<tr>${Array.from({ length: 256 }, (_, index) => `<th>H${index}</th>`).join("")}</tr>`;
  const bodyRows = Array.from({ length: 300 }, (_, index) => `<tr><td colspan="256">row ${index}</td></tr>`).join("");
  const page = extractWebPage(
    `<html><body><h1>Dense</h1><table>${headerRow}${bodyRows}</table></body></html>`,
    "https://example.com/dense",
  );
  const table = page.tables[0]!;
  assert.equal(table.columns, 256);
  assert.equal(table.rows, 255);
  assert.equal(table.truncated, true);
  assert.ok(table.truncationNotes!.includes("expanded table cells capped at 65536"));
});

test("oversized cell text is truncated to the per-cell budget", () => {
  const page = extractWebPage(
    `<html><body><h1>Long cells</h1><table><tr><th>Text</th><th>N</th></tr>`
      + `<tr><td>${"x".repeat(3_000)}</td><td>1</td></tr><tr><td>${"y".repeat(3_100)}</td><td>2</td></tr></table></body></html>`,
    "https://example.com/long-cells",
  );
  const table = page.tables[0]!;
  const cell = page.blocks[table.index]!.tableRows![0]![0]!;
  assert.equal(cell.length, 2_000);
  assert.ok(cell.endsWith("…"));
  const secondCell = page.blocks[table.index]!.tableRows![1]![0]!;
  assert.equal(secondCell.length, 2_000);
  assert.equal(table.truncated, true);
  assert.ok(table.truncationNotes!.includes("cell text truncated to 2000 characters"));
});

test("generated table Markdown is capped with a descriptor-level truncation signal", () => {
  const rows = Array.from(
    { length: 300 },
    (_, index) => `<tr><td>${"x".repeat(2_000)}</td><td>row ${index}</td></tr>`,
  ).join("");
  const page = extractWebPage(
    `<html><body><h1>Heavy markdown</h1><table><tr><th>Big</th><th>N</th></tr>${rows}</table></body></html>`,
    "https://example.com/heavy",
  );
  const table = page.tables[0]!;
  assert.equal(table.truncated, true);
  assert.ok(table.truncationNotes!.some((note) => /generated table Markdown capped at 512000 characters/.test(note)));
  const markdownChars = page.blocks
    .filter((block) => block.tableId === table.id)
    .reduce((total, block) => total + block.markdown.length, 0);
  assert.ok(markdownChars <= 512_000);
  assert.ok(page.blocks.filter((block) => block.tableId === table.id).length > 1);
});

test("adversarial table truncation surfaces through the formatted table inventory and cache result", async () => {
  const config = normalizeConfig({});
  const html = `<html><body><h1>Spans</h1><table><tr><th>A</th><th>B</th></tr>`
    + `<tr><td colspan="1000000">wide</td><td>tail</td></tr><tr><td>plain</td><td>2</td></tr></table></body></html>`;
  const cache = new WebPageCache(config.web!.fetch, async (url) => ({
    requestedUrl: url,
    finalUrl: url,
    contentType: "text/html",
    text: html,
    bytes: Buffer.byteLength(html),
    fetchedAt: "2026-08-23T00:00:00.000Z",
  }));
  const tools = new Map<string, any>();
  const manager = new WebToolManager({ registerTool: (tool) => tools.set(tool.name, tool) }, config, cache, cache);
  manager.register();
  const result = await tools.get("WebFetch").execute("adversarial", { url: "https://example.com/spans", maxChars: 1_000 });
  assert.equal(result.isError, false);
  const response = result.details.response as { tables: Array<{ truncated?: boolean; truncationNotes?: string[] }> };
  assert.equal(response.tables[0]?.truncated, true);
  assert.ok(response.tables[0]?.truncationNotes!.includes("colspan clamped to 1000"));
  assert.match(result.content[0].text as string, /truncated: .*colspan clamped to 1000/);
  await manager.cleanup();
});

test("ordinary tables with modest spans keep full extraction without a truncation signal", () => {
  const page = extractWebPage(fixture, "https://example.com/cities");
  const table = page.tables[0]!;
  assert.equal(table.truncated, undefined);
  assert.equal(table.truncationNotes, undefined);
  assert.deepEqual(table.headers, ["City", "Population 2020", "Population 2025"]);
  assert.equal(table.rows, 2);
  assert.equal(table.columns, 3);
  const modest = extractWebPage(
    `<html><body><h1>Merged</h1><table><tr><th rowspan="2">Region</th><th colspan="2">Sales</th></tr>`
      + `<tr><th>2024</th><th>2025</th></tr><tr><td>West</td><td>10</td><td>20</td></tr>`
      + `<tr><td>East</td><td>30</td><td>40</td></tr></table></body></html>`,
    "https://example.com/merged",
  );
  const merged = modest.tables[0]!;
  assert.equal(merged.truncated, undefined);
  assert.deepEqual(merged.headers, ["Region", "Sales 2024", "Sales 2025"]);
  assert.deepEqual(modest.blocks[merged.index]!.tableRows, [["West", "10", "20"], ["East", "30", "40"]]);
});

test("huge physical cell lists stop iterating once budgets are exhausted", () => {
  const row = Array.from({ length: 50_000 }, (_, index) => `<td>c${index}</td>`).join("");
  const startedAt = Date.now();
  const page = extractWebPage(
    `<html><body><h1>Physical cells</h1><table><tr><th>A</th><th>B</th></tr><tr>${row}</tr><tr><td>tail1</td><td>tail2</td></tr></table></body></html>`,
    "https://example.com/physical-cells",
  );
  const table = page.tables[0]!;
  assert.equal(table.columns, 256);
  assert.equal(table.truncated, true);
  assert.ok(table.truncationNotes!.includes("table columns capped at 256"));
  const bodyRow = page.blocks[table.index]!.tableRows![0]!;
  assert.ok(bodyRow.length <= 256);
  assert.ok(Date.now() - startedAt < 5_000);
});

test("sparse wide tables bound the padded dense result against the cell budget", () => {
  const headerRow = `<tr>${Array.from({ length: 256 }, (_, index) => `<th>H${index}</th>`).join("")}</tr>`;
  const bodyRows = Array.from({ length: 1_999 }, (_, index) => `<tr><td>v${index}</td></tr>`).join("");
  const page = extractWebPage(
    `<html><body><h1>Sparse</h1><table>${headerRow}${bodyRows}</table></body></html>`,
    "https://example.com/sparse-wide",
  );
  const table = page.tables[0]!;
  assert.equal(table.columns, 256);
  assert.equal(table.rows, 255);
  assert.equal(table.truncated, true);
  assert.ok(table.truncationNotes!.includes("expanded table cells capped at 65536"));
  for (const row of page.blocks[table.index]!.tableRows!) assert.equal(row.length, 256);
});

test("rowspan carry-over cells count against the total-cell budget", () => {
  const headerRow = `<tr>${Array.from({ length: 256 }, (_, index) => `<th>H${index}</th>`).join("")}</tr>`;
  const spanRows = `<tr><td colspan="256" rowspan="1000">span</td></tr>`.repeat(2);
  const fillerRows = "<tr></tr>".repeat(1_000);
  const startedAt = Date.now();
  const page = extractWebPage(
    `<html><body><h1>Carry over</h1><table>${headerRow}${spanRows}${fillerRows}</table></body></html>`,
    "https://example.com/rowspan-heavy",
  );
  const table = page.tables[0]!;
  assert.equal(table.truncated, true);
  assert.ok(table.truncationNotes!.includes("expanded table cells capped at 65536"));
  assert.ok(table.rows <= 256);
  assert.ok(Date.now() - startedAt < 5_000);
});

test("oversized table headers are truncated and every block stays within the block limit", () => {
  const headerRow = `<tr>${Array.from({ length: 8 }, () => `<th>${"H".repeat(2_000)}</th>`).join("")}</tr>`;
  const bodyRows = Array.from({ length: 2 }, (_, index) => `<tr><td>row ${index}</td><td>x</td><td>y</td><td>z</td><td>a</td><td>b</td><td>c</td><td>d</td></tr>`).join("");
  const page = extractWebPage(
    `<html><body><h1>Wide headers</h1><table>${headerRow}${bodyRows}</table></body></html>`,
    "https://example.com/wide-headers",
  );
  const table = page.tables[0]!;
  assert.equal(table.truncated, true);
  assert.ok(table.truncationNotes!.includes("table header Markdown truncated"));
  for (const block of page.blocks) assert.ok(block.markdown.length <= 7_000);
});

test("bounded element collection walks deeply nested markup iteratively", () => {
  // A recursive traversal overflows the call stack at roughly 8-12k depth;
  // 25k depth must therefore fail any recursive implementation and pass here.
  const depth = 25_000;
  const { document } = parseHTML(
    `<html><body>${"<div>".repeat(depth)}<table><tr><td>x</td></tr></table>${"</div>".repeat(depth)}</body></html>`,
  );
  const collected = collectBoundedElements(document, "table", 64);
  assert.equal(collected.elements.length, 1);
  assert.equal(collected.overflow, false);
});

test("deeply nested markup does not overflow the stack while extracting tables", () => {
  const depth = 12_000;
  const page = extractWebPage(
    `<html><body><h1>Deep</h1>${"<div>".repeat(depth)}<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>${"</div>".repeat(depth)}</body></html>`,
    "https://example.com/deep",
  );
  assert.equal(page.tables.length, 1);
  assert.equal(page.tables[0]!.rows, 2);
  assert.equal(page.tables[0]!.truncated, undefined);
});

test("combined oversized table labels and headers remain within Markdown budgets", () => {
  const headers = Array.from(
    { length: 256 },
    () => `<th>${"H".repeat(2_000)}</th>`,
  ).join("");
  const page = extractWebPage(
    `<html><body><table><caption>${"L".repeat(10_000)}</caption>`
      + `<tr>${headers}</tr><tr><td>a</td><td>b</td></tr>`
      + `<tr><td>c</td><td>d</td></tr></table></body></html>`,
    "https://example.com/oversized-preamble",
  );
  const table = page.tables[0]!;
  const blocks = page.blocks.filter((block) => block.tableId === table.id);
  assert.equal(table.label.length, 500);
  assert.ok(table.label.endsWith("…"));
  assert.ok(table.truncationNotes!.includes("table label truncated to 500 characters"));
  assert.ok(table.truncationNotes!.includes("table header Markdown truncated"));
  assert.ok(blocks.every((block) => block.markdown.length <= 7_000));
  assert.ok(blocks.reduce((total, block) => total + block.markdown.length, 0) <= 512_000);
});

test("multi-row spanned headers cannot amplify past text and Markdown budgets", () => {
  const headerRows = Array.from(
    { length: 64 },
    (_, index) => `<tr><th colspan="256">${`${index}-`.padEnd(2_000, "H")}</th></tr>`,
  ).join("");
  const page = extractWebPage(
    `<html><body><table>${headerRows}`
      + `<tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr>`
      + `</table></body></html>`,
    "https://example.com/spanned-headers",
  );
  const table = page.tables[0]!;
  assert.ok(table.headers.every((header) => header.length <= 2_000));
  assert.ok(table.truncationNotes!.includes("combined table header text truncated to 2000 characters"));
  assert.ok(table.headers.reduce((total, header) => total + header.length, 0) <= 512_000);
  assert.ok(page.blocks.filter((block) => block.tableId === table.id).every((block) => block.markdown.length <= 7_000));
});
