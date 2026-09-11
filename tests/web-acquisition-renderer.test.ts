import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { visibleTerminalText } from "../src/tool-result-text";
import { isExpandableResult } from "../src/tool-result-expansion";
import { WebToolManager } from "../src/web/tools";

const THEME = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

function render(tool: Record<string, any>, value: unknown, expanded: boolean, context: unknown = {}): string {
  const component = tool.renderResult(
    value,
    { expanded, isPartial: false },
    THEME,
    context,
  ) as { render(width: number): string[] };
  return component.render(240).join("\n");
}

function responseBase(content: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestedUrl: "https://example.test/article",
    finalUrl: "https://example.test/article",
    fetchedAt: "2026-08-23T00:00:00.000Z",
    contentType: "text/html; charset=utf-8",
    downloadedBytes: 123_456,
    cacheHit: false,
    title: "Example article",
    documentType: "html",
    dynamicContentSuspected: false,
    dynamicContentReasons: [],
    tables: [],
    pagination: [],
    startIndex: 0,
    endIndex: 1,
    nextIndex: 2,
    totalBlocks: 4,
    content,
    ...overrides,
  };
}

function result(response: Record<string, unknown>, request: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: [{ type: "text", text: "model-facing result summary" }],
    details: { response, request },
    isError: false,
  };
}

function retainedContentRegion(output: string): string {
  const lines = output.split("\n");
  let start = -1;
  let end = -1;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("UNTRUSTED RETAINED CONTENT")) start = index;
    if (start >= 0 && index > start && line.startsWith("End of ")) {
      end = index;
      break;
    }
  }
  assert.ok(start >= 0 && end > start, "retained content markers should be rendered");
  return lines.slice(start + 2, end).join("\n");
}

/** Reverses visibleTerminalText notation back to the original bytes (tests only). */
function decodeVisibleTerminal(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = text[index + 1];
    if (next === "\\") {
      out += "\\";
      index += 1;
      continue;
    }
    if (next === "r") {
      out += "\r";
      index += 1;
      continue;
    }
    if (next === "u") {
      const hex = text.slice(index + 2, index + 6);
      if (/^[0-9a-f]{4}$/u.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        index += 5;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function assertNoRawControlBytes(output: string): void {
  for (const line of output.split("\n")) {
    for (const ch of line) {
      const code = ch.codePointAt(0) ?? 0;
      assert.ok(
        code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f),
        `no raw control byte may be rendered: ${JSON.stringify(line)}`,
      );
    }
  }
}

function retainedResponseOf(result: unknown): Record<string, unknown> {
  const details = (result as { details?: { response?: Record<string, unknown> } }).details;
  assert.ok(details && details.response, "retained response details must be present");
  return details.response!;
}

function webHarness(responseFor: (input: Record<string, unknown>) => Record<string, unknown>): {
  tools: Map<string, Record<string, any>>;
  fetchCalls: number[];
  cleanup: () => Promise<void>;
} {
  const config = normalizeConfig({});
  const fetchCalls: number[] = [];
  const cache = {
    fetch: async (input: Record<string, unknown>) => {
      fetchCalls.push(1);
      return responseFor(input);
    },
    cleanup: async () => {},
    cleanupSync: () => {},
    updateConfig: () => {},
    cacheRoot: () => undefined,
  } as unknown as any;
  const tools = new Map<string, Record<string, any>>();
  const manager = new WebToolManager(
    { registerTool: (tool) => { tools.set(tool.name, tool); } },
    config,
    cache,
    cache,
    { shutdown: async () => {}, updateConfig: () => {} } as unknown as any,
  );
  manager.register();
  return { tools, fetchCalls, cleanup: () => manager.cleanup() };
}

test("registered WebFetch and BrowserExtract expand complete retained acquisition data", async () => {
  const longTail = "COMPLETE_RETAINED_TAIL";
  const longContent = `${"retained body ".repeat(8_000)}${longTail}`;
  const tables = Array.from({ length: 41 }, (_, index) => ({
    id: `table-${index}`,
    label: `table-label-${index}-${"L".repeat(2_100)}`,
    index: index + 2,
    endIndex: index + 2,
    rows: 2,
    columns: 9,
    headers: ["City", "Population", "2020", "2025", "Region", "Source", "Rank", "Notes", `header-${index}-${"H".repeat(700)}`],
    ...(index === 40 ? { truncated: true, truncationNotes: ["upstream table extraction retained a bounded result"] } : {}),
  }));
  const pagination = Array.from({ length: 11 }, (_, index) => ({
    label: `Page ${index + 2}`,
    relation: "page",
    url: `https://example.test/article?page=${index + 2}`,
  }));
  const main = responseBase(longContent, {
    tables,
    pagination,
    dynamicContentReasons: Array.from({ length: 9 }, (_, index) => `reason-${index}-${"R".repeat(300)}`),
  });
  const find = responseBase("", {
    find: {
      query: "needle",
      searchedFromIndex: 4,
      totalMatches: 21,
      matchesTruncated: true,
      matches: Array.from({ length: 21 }, (_, index) => ({
        index: index + 4,
        kind: "text",
        snippet: `find-snippet-${index}-${"S".repeat(700)}`,
      })),
    },
    startIndex: 4,
    endIndex: 4,
    nextIndex: undefined,
  });
  const projected = responseBase("projected content PROJECTED_TAIL", {
    projectedColumns: ["City", "Population"],
    startIndex: 9,
    endIndex: 9,
    nextIndex: undefined,
  });
  const pdf = responseBase("PDF retained content PDF_TAIL", {
    finalUrl: "https://example.test/report.pdf",
    contentType: "application/pdf",
    documentType: "pdf",
    pageCount: 7,
    startPage: 2,
    endPage: 3,
    scannedOrImageOnlySuspected: false,
    pdfMetadata: {
      author: "Example author",
      subject: "Example subject",
      creator: "Example creator",
      producer: "Example producer",
      creationDate: "2026-08-22",
      modificationDate: "2026-08-23",
    },
  });
  const browser = responseBase("Rendered browser content BROWSER_TAIL", {
    title: "Example dashboard",
    finalUrl: "https://example.test/dashboard",
    browserOmissions: {
      count: 9,
      truncated: true,
      entries: Array.from({ length: 9 }, (_, index) => `omission-${index}-${"O".repeat(300)}`),
    },
  });

  const harness = webHarness((input) => {
    if (input.find) return find;
    if (input.columns) return projected;
    if (String(input.url).endsWith(".pdf")) return pdf;
    if (String(input.url).includes("dashboard")) return browser;
    return main;
  });
  const webFetch = harness.tools.get("WebFetch")!;
  const browserExtract = harness.tools.get("BrowserExtract")!;
  assert.equal(isExpandableResult(webFetch.renderResult), true);
  assert.equal(isExpandableResult(browserExtract.renderResult), true);

  const request = { url: "  https://example.test/article  ", index: 4, maxChars: 1_000, refresh: true };
  const fetched = await webFetch.execute("read", request);
  const context = { args: request };
  const collapsed = render(webFetch, fetched, false, context);
  assert.match(collapsed, /WebFetch · Example article · HTML/);
  assert.doesNotMatch(collapsed, new RegExp(longTail));
  const expanded = render(webFetch, fetched, true, context);
  assert.match(expanded, /Requested URL:  +https:\/\/example\.test\/article/);
  assert.match(expanded, /Final URL: https:\/\/example\.test\/article/);
  assert.match(expanded, /Index: 4/);
  assert.match(expanded, /Maximum characters: 1000/);
  assert.match(expanded, /Refresh: true/);
  assert.match(expanded, /Acquisition truncated: not retained/);
  assert.match(expanded, /upstream table extraction retained a bounded result/);
  assert.match(expanded.replace(/\n/g, ""), new RegExp(longTail));
  assert.equal(expanded.split(longTail).length - 1, 1, "retained content is rendered once");
  assert.match(expanded, /table-label-40/);
  assert.match(expanded.replace(/\n/g, ""), new RegExp(`header-40-${"H".repeat(700)}`));
  assert.match(expanded, /Page 12/);
  assert.match(expanded, /reason-8-/);
  assert.doesNotMatch(expanded, /additional table descriptor|additional pagination|additional extraction reason/);
  assert.deepEqual(render(webFetch, fetched, false, context), collapsed);
  assert.equal(harness.fetchCalls.length, 1, "collapse and expansion do not call the cache");

  const found = await webFetch.execute("find", { url: "https://example.test/article", find: "needle" });
  const findOutput = render(webFetch, found, true, { args: { url: "https://example.test/article", find: "needle" } });
  assert.match(findOutput, /Find: "needle"/);
  assert.match(findOutput, /match index 24/);
  assert.match(findOutput.replace(/\n/g, ""), new RegExp(`find-snippet-20-${"S".repeat(700)}`));
  assert.match(findOutput, /additional find matches were omitted upstream/);

  const tableRead = await webFetch.execute("table", { url: "https://example.test/article", index: 9, columns: ["City", "Population"] });
  const tableOutput = render(webFetch, tableRead, true, { args: { url: "https://example.test/article", index: 9, columns: ["City", "Population"] } });
  assert.match(tableOutput, /Columns: \["City", "Population"\]/);
  assert.match(tableOutput, /Projected columns: City \| Population/);
  assert.match(tableOutput, /PROJECTED_TAIL/);

  const pdfRead = await webFetch.execute("pdf", { url: "https://example.test/report.pdf" });
  const pdfOutput = render(webFetch, pdfRead, true, { args: { url: "https://example.test/report.pdf" } });
  assert.match(pdfOutput, /Document: PDF/);
  assert.match(pdfOutput, /PDF pages: 7/);
  assert.match(pdfOutput, /Modification date: 2026-08-23/);
  assert.match(pdfOutput, /PDF_TAIL/);

  const rendered = await browserExtract.execute("browser", { url: "https://example.test/dashboard" });
  const browserOutput = render(browserExtract, rendered, true, { args: { url: "https://example.test/dashboard" } });
  assert.match(browserOutput, /Acquisition: rendered browser page/);
  assert.match(browserOutput, /Cache hit: false/);
  assert.match(browserOutput, /Resource omissions: 9/);
  assert.match(browserOutput, /omission-8-/);
  assert.match(browserOutput, /BROWSER_TAIL/);

  const defaults = await webFetch.execute("defaults", { url: "https://example.test/article" });
  const defaultOutput = render(webFetch, defaults, true, { args: { url: "https://example.test/article" } });
  assert.match(defaultOutput, /Index: 0 \(default\)/);
  assert.match(defaultOutput, /Maximum characters: \d+ \(default\)/);
  assert.match(defaultOutput, /Refresh: false \(default\)/);
  await harness.cleanup();
});

test("registered acquisition renderers preserve partial, failed, and restored boundaries", async () => {
  const harness = webHarness(() => responseBase("unused"));
  const tool = harness.tools.get("WebFetch")!;
  const partial = render(tool, {
    content: [{ type: "text", text: "partial retained output" }],
    details: {},
    isError: false,
  }, true, { args: { url: "https://example.test/live" } });
  assert.match(partial, /No retained response details were returned/);
  // The helper forwards partial state; use its native shape directly for the
  // partial arm because the shared wrapper supplies this flag to the renderer.
  const partialComponent = tool.renderResult(
    { content: [{ type: "text", text: "partial retained output" }], details: {}, isError: false },
    { expanded: true, isPartial: true },
    THEME,
    { args: { url: "https://example.test/live" } },
  ) as { render(width: number): string[] };
  const partialOutput = partialComponent.render(240).join("\n");
  assert.match(partialOutput, /Status: partial result/);
  assert.match(partialOutput, /partial retained output/);

  const failed = tool.renderResult(
    {
      content: [{ type: "text", text: "WebFetch failed: public diagnostic\nSecond diagnostic" }],
      details: { error: "private transport detail" },
      isError: true,
    },
    { expanded: true, isPartial: false },
    THEME,
    { args: { url: "https://example.test/failure" }, isError: true },
  ) as { render(width: number): string[] };
  const failedOutput = failed.render(240).join("\n");
  assert.match(failedOutput, /Status: failed result/);
  assert.match(failedOutput, /Second diagnostic/);
  assert.doesNotMatch(failedOutput, /private transport detail/);

  const restored = tool.renderResult(
    { content: [{ type: "text", text: "restored result text" }], details: {}, isError: false },
    { expanded: true, isPartial: false },
    THEME,
    { args: { url: "https://example.test/restored" } },
  ) as { render(width: number): string[] };
  const restoredOutput = restored.render(240).join("\n");
  assert.match(restoredOutput, /No retained response details were returned/);
  assert.match(restoredOutput, /restored result text/);
  assert.doesNotMatch(restoredOutput, /Final URL: https:\/\/example\.test\/restored/);
  await harness.cleanup();
});

test("registered WebFetch preserves control-byte find requests and returned content in the human view", async () => {
  const controls = "\u001b[31mstyled\u001b[0m\u0007\rcarriage\u0000null\u007f\u009b\u000bend";
  const literal = "typed\\r typed\\u001b[31m and a lone \\ backslash";
  const longTail = "COMPLETE_CONTROL_TAIL";
  const content = [
    `control line: ${controls}`,
    "",
    `literal line: ${literal}`,
    "secret line: token hunter2 api_key=AKIAEXAMPLEKEY",
    `${"control padding ".repeat(400)}${longTail}`,
  ].join("\n");
  const harness = webHarness((input) => responseBase(content, {
    documentType: "text",
    ...(input.find
      ? {
          find: {
            query: input.find,
            searchedFromIndex: 0,
            totalMatches: 1,
            matches: [{ index: 1, kind: "text", snippet: `matched ${controls}` }],
          },
        }
      : {}),
  }));
  const tool = harness.tools.get("WebFetch")!;

  const findQuery = "needle\\r literal \\u001b[31m and \u0000raw\u001b";
  const found = await tool.execute("find", { url: "https://example.test/article", find: findQuery });
  const context = { args: { url: "https://example.test/article", find: findQuery } };

  // The model-visible payload itself is untouched by rendering.
  assert.equal(retainedResponseOf(found).content, content);

  const encodedQuery = visibleTerminalText(findQuery);
  const quotedQuery = JSON.stringify(encodedQuery);
  const collapsed = render(tool, found, false, context);
  assert.ok(collapsed.includes(`Find ${quotedQuery}`), `collapsed heading shows the encoded-once find request: ${collapsed}`);
  assert.ok(collapsed.includes("\\\\u0000raw\\\\u001b"), "collapsed shows encoded controls, not stripped ones");
  assert.doesNotMatch(collapsed, /control line/, "collapsed stays a summary");

  const expanded = render(tool, found, true, context);
  assert.ok(expanded.includes(`Find: ${quotedQuery}`), "expanded request shows the encoded-once find query");
  // Returned content is complete, encoded exactly once, and reversible.
  const contentRegion = retainedContentRegion(expanded);
  assert.equal(
    decodeVisibleTerminal(contentRegion).replace(/\n/g, ""),
    content.replace(/\n/g, ""),
    "human view decodes back to the exact returned content (physical wrapping only)",
  );
  assert.match(expanded, new RegExp(longTail));
  assert.equal(expanded.split(longTail).length - 1, 1, "long retained content is rendered exactly once");
  // Literal escape-shaped request text stays distinguishable from encoded controls.
  assert.ok(expanded.includes(quotedQuery), "no double encoding of the find query");
  assert.doesNotMatch(expanded, /\\\\u001b\[31mstyled/);
  // Secret-shaped request and returned text stay visible without masking.
  assert.match(expanded, /hunter2/);
  assert.match(expanded, /AKIAEXAMPLEKEY/);
  assert.match(expanded, /match index 1 · text: matched \\u001b\[31mstyled/);
  assertNoRawControlBytes(expanded);
  assert.equal(harness.fetchCalls.length, 1, "collapse, expansion, and re-render perform no additional acquisition");

  assert.equal(render(tool, found, true, context), expanded, "expansion is deterministic with no re-encoding drift");
  assert.equal(render(tool, found, false, context), collapsed, "re-collapse is deterministic");
  await harness.cleanup();
});
