import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { WebPageCache } from "../src/web/cache";
import { canonicalSearchUrl, parseDuckDuckGoResults, searchDuckDuckGo, type DownloadedText, type NetworkOptions } from "../src/web/network";
import { extractWebPage, findInWebPage, renderWebPage } from "../src/web/page";
import { formatSearch, WebToolManager } from "../src/web/tools";

const fixture = `<!doctype html><html><head><title>Population fixture</title></head><body>
<main><h1>Largest cities</h1>${Array.from({ length: 20 }, (_, index) => `<p>Context paragraph ${index} with enough useful content for extraction and structural indexing.</p>`).join("")}</main>
<h2>Population table</h2>
<table><thead><tr><th rowspan="2">City</th><th colspan="2">Population</th></tr><tr><th>2020</th><th>2025</th></tr></thead>
<tbody><tr><td>New York</td><td>8,804,190</td><td>8,584,629</td></tr><tr><td>Los Angeles</td><td>3,898,747</td><td>3,869,089</td></tr></tbody></table>
<nav class="pagination"><a rel="next" href="/page/2">Next</a></nav></body></html>`;

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

test("DuckDuckGo provider parsing normalizes redirect URLs and deduplicates results", () => {
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Fcities%2F%3Futm_source%3Dsearch%26b%3D2%26a%3D1">Cities</a><span class="result__timestamp">Aug 22, 2026</span><div class="result__snippet">Population data for the largest cities in the country.</div></div>
  <div class="result"><a class="result__a" href="http://example.com/cities?a=1&amp;b=2#table">Duplicate</a></div>
  <div class="result"><a class="result__a" href="https://example.org/short">Short</a><div class="result__snippet">with residents.</div></div>
  <div class="result"><a class="result__a" href="https://dated.example/report">Dated</a><div class="result__snippet">Aug 21, 2026 — A complete provider excerpt with a date prefix and enough context to be useful.</div></div>`;
  assert.deepEqual(parseDuckDuckGoResults(html, 10), [{
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

test("WebSearch continues within a provider page, then follows its opaque next-page form", async () => {
  const result = (url: string, title: string) => `<div class="result"><a class="result__a" href="${url}">${title}</a><div class="result__snippet">A sufficiently complete provider snippet describing ${title} for search testing.</div></div>`;
  const firstPage = `${result("https://one.example/a", "One")}${result("https://two.example/b", "Two")}${result("https://three.example/c", "Three")}
    <form action="/html/" method="post"><input type="submit" value="Next"><input type="hidden" name="q" value="cities -site:noise.example"><input type="hidden" name="s" value="30"><input type="hidden" name="vqd" value="opaque-provider-state"></form>`;
  const secondPage = `${result("https://four.example/d", "Four")}${result("https://five.example/e", "Five")}`;
  const calls: Array<{ url: string; options: NetworkOptions }> = [];
  const download = async (url: string, options: NetworkOptions): Promise<DownloadedText> => {
    calls.push({ url, options });
    const text = options.method === "POST" ? secondPage : firstPage;
    return { requestedUrl: url, finalUrl: url, contentType: "text/html", text, bytes: text.length, fetchedAt: "2026-08-23T00:00:00.000Z" };
  };
  const common = {
    query: "cities",
    maxResults: 2,
    excludeDomains: ["noise.example", "NOISE.EXAMPLE"],
    options: { timeoutMs: 1_000, maxBytes: 100_000, userAgent: "test" },
    download,
  };

  const first = await searchDuckDuckGo(common);
  assert.deepEqual(first.results.map((item) => [item.rank, item.title]), [[1, "One"], [2, "Two"]]);
  assert.deepEqual(first.excludedDomains, ["noise.example"]);
  assert.ok(first.nextCursor);
  assert.match(calls[0]!.url, /q=cities\+-site%3Anoise\.example/);

  const withinPage = await searchDuckDuckGo({ ...common, cursor: first.nextCursor });
  assert.deepEqual(withinPage.results.map((item) => [item.rank, item.title]), [[3, "Three"]]);
  assert.ok(withinPage.nextCursor);
  assert.equal(calls[1]!.options.method, "GET");

  const nextPage = await searchDuckDuckGo({ ...common, cursor: withinPage.nextCursor });
  assert.deepEqual(nextPage.results.map((item) => [item.rank, item.title]), [[4, "Four"], [5, "Five"]]);
  assert.equal(calls[2]!.options.method, "POST");
  assert.match(calls[2]!.options.body ?? "", /vqd=opaque-provider-state/);
  assert.equal(nextPage.nextCursor, undefined);

  await assert.rejects(
    searchDuckDuckGo({ ...common, query: "different", cursor: first.nextCursor }),
    /cursor does not match/,
  );
  await assert.rejects(
    searchDuckDuckGo({ ...common, freshness: "day", cursor: first.nextCursor }),
    /cursor does not match/,
  );
  await assert.rejects(
    searchDuckDuckGo({ ...common, domain: "noise.example" }),
    /cannot also be excluded/,
  );
});

test("WebSearch reports provider date coverage without inferring missing dates", () => {
  const base = {
    provider: "duckduckgo" as const,
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
  assert.ok(tools.get("WebSearch").parameters.properties.cursor);
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
