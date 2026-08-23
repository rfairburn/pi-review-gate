import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { WebPageCache } from "../src/web/cache";
import { parseDuckDuckGoResults } from "../src/web/network";
import { extractWebPage, findInWebPage, renderWebPage } from "../src/web/page";
import { WebToolManager } from "../src/web/tools";

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

test("dynamic-content suspicion is explicit for script-heavy empty application shells", () => {
  const page = extractWebPage(`<html><body><div id="root"></div>${"<script>void 0</script>".repeat(8)}</body></html>`, "https://example.com/app");
  assert.equal(page.dynamicContentSuspected, true);
  assert.ok(page.dynamicContentReasons.length > 0);
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
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fcities">Cities</a><div class="result__snippet">Population data</div></div>
  <div class="result"><a class="result__a" href="https://example.com/cities">Duplicate</a></div>`;
  assert.deepEqual(parseDuckDuckGoResults(html, 10), [{
    rank: 1,
    title: "Cities",
    url: "https://example.com/cities",
    snippet: "Population data",
  }]);
});

test("WebFetch reuses its session cache, exposes table indexes, and removes the cache on shutdown", async () => {
  const config = normalizeConfig({});
  let downloads = 0;
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
  const manager = new WebToolManager({
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, handler) => hooks.set(name, handler),
  }, config, cache);
  manager.register();
  assert.deepEqual([...tools.keys()], ["WebSearch", "WebFetch"]);
  assert.equal(tools.has("WebRead"), false);

  const first = await tools.get("WebFetch").execute("one", { url: "https://example.com/cities", maxChars: 1_000 });
  const firstText = first.content[0].text as string;
  assert.match(firstText, /Tables discovered across the full page/);
  assert.match(firstText, /Population table/);
  assert.match(firstText, /dynamic_content_suspected: false/);
  assert.match(firstText, /Cache scope: current session\./);
  const tableIndex = (first.details.response.tables[0].index) as number;
  const second = await tools.get("WebFetch").execute("two", { url: "https://example.com/cities", index: tableIndex });
  assert.match(second.content[0].text as string, /New York/);
  assert.match(second.content[0].text as string, /session cache/);
  assert.equal(downloads, 1);

  const found = await tools.get("WebFetch").execute("find", { url: "https://example.com/cities", find: "Los Angeles" });
  assert.match(found.content[0].text as string, /Find "Los Angeles"/);
  assert.match(found.content[0].text as string, new RegExp(`index ${tableIndex}`));
  assert.match(found.content[0].text as string, /Los Angeles/);
  assert.equal(downloads, 1);

  const root = manager.cacheRoot();
  assert.ok(root);
  await access(root);
  await hooks.get("session_shutdown")?.();
  await assert.rejects(access(root), /ENOENT/);
});
