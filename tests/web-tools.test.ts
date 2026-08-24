import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { assertSuccessfulBrowserNavigation } from "../src/web/browser";
import { WebPageCache } from "../src/web/cache";
import { canonicalSearchUrl, normalizeDdgsResults, searchDdgs, type DdgsRunner } from "../src/web/network";
import { extractWebPage, findInWebPage, renderWebPage } from "../src/web/page";
import { extractPdfDocument, isPdfResponse } from "../src/web/pdf";
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

test("WebSearch continues with an ordinary DDGS page number", async () => {
  const result = (href: string, title: string) => ({ href, title, body: `A sufficiently complete provider snippet describing ${title} for search testing.` });
  const calls: Parameters<DdgsRunner>[0][] = [];
  const run: DdgsRunner = async (request) => {
    calls.push(request);
    return request.page === 1
      ? { results: [result("https://one.example/a", "One"), result("https://two.example/b", "Two")], hasMore: true }
      : { results: [result("https://three.example/c", "Three"), result("https://four.example/d", "Four")], hasMore: false };
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
  assert.equal(first.page, 1);
  assert.equal(first.nextPage, 2);
  assert.equal(calls[0]!.query, "cities -site:noise.example");
  assert.equal(calls[0]!.page, 1);
  assert.equal(calls[0]!.region, "us-en");

  const nextPage = await searchDdgs({ ...common, page: first.nextPage });
  assert.deepEqual(nextPage.results.map((item) => [item.rank, item.title]), [[3, "Three"], [4, "Four"]]);
  assert.equal(calls[1]!.page, 2);
  assert.equal(nextPage.page, 2);
  assert.equal(nextPage.nextPage, undefined);

  await assert.rejects(
    searchDdgs({ ...common, page: 101 }),
    /page must be an integer from 1 through 100/i,
  );
  await assert.rejects(
    searchDdgs({ ...common, domain: "noise.example" }),
    /cannot also be excluded/,
  );
});

test("WebSearch reports provider date coverage without inferring missing dates", () => {
  const base = {
    provider: "ddgs" as const,
    query: "cities",
    page: 1,
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
  assert.match(formatSearch({ ...base, nextPage: 2, results: [result(1)] }), /same WebSearch query and filters with page: 2/);
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
    };
  });
  const manager = new WebToolManager({
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, handler) => hooks.set(name, handler),
  }, config, cache, browserCache);
  manager.register();
  assert.deepEqual([...tools.keys()], ["WebSearch", "WebFetch", "BrowserExtract"]);
  assert.equal(tools.has("WebRead"), false);
  assert.ok(tools.get("WebSearch").parameters.properties.excludeDomains);
  assert.ok(tools.get("WebSearch").parameters.properties.page);
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
