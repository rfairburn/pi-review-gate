import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { visibleTerminalText } from "../src/tool-result-text";
import { isExpandableResult } from "../src/tool-result-expansion";
import { formatSearch, WebToolManager } from "../src/web/tools";
import type { SearchResponse } from "../src/web/network";

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

const THEME = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

function registeredSearchTool(): Record<string, any> {
  const tools: Array<Record<string, any>> = [];
  new WebToolManager(
    { registerTool: (tool) => { tools.push(tool); } },
    normalizeConfig({}),
    undefined,
    undefined,
    { shutdown: async () => {}, updateConfig: () => {} } as unknown as any,
  ).register();
  const search = tools.find((tool) => tool.name === "WebSearch");
  assert.ok(search, "WebSearch was not registered");
  return search;
}

function render(tool: Record<string, any>, result: unknown, expanded: boolean, context: unknown = {}): string {
  const component = tool.renderResult(
    result,
    { expanded, isPartial: false },
    THEME,
    context,
  ) as { render(width: number): string[] };
  return component.render(240).join("\n");
}

test("registered WebSearch has a common expandable request/result view without changing model output", () => {
  const tool = registeredSearchTool();
  assert.equal(isExpandableResult(tool.renderResult), true);

  const response: Omit<SearchResponse, "fetchedAt" | "durationMs"> = {
    provider: "ddgs",
    query: "native terminal UI",
    excludedDomains: ["noise.example"],
    results: [
      {
        rank: 1,
        title: "Terminal UI guide",
        url: "https://example.com/terminal",
        hostname: "example.com",
        snippet: `A complete provider snippet ${"x".repeat(700)}`,
        dateText: "Aug 23, 2026",
        dateSource: "provider" as const,
      },
      {
        rank: 2,
        title: "Keyboard interaction",
        url: "https://example.com/keyboard",
        hostname: "example.com",
        snippet: "Keyboard and mouse interaction reference.",
      },
    ],
  };
  const modelText = formatSearch({
    ...response,
    fetchedAt: "2026-08-23T00:00:00.000Z",
    durationMs: 12,
  });
  const result = {
    content: [{ type: "text", text: modelText }],
    details: {
      response,
      request: {
        query: "native terminal UI",
        maxResults: 2,
        domain: "example.com",
        excludeDomains: ["noise.example"],
        region: "us-en",
        provided: { maxResults: true, domain: true, excludeDomains: true, region: false, freshness: false },
      },
    },
    isError: false,
  };
  const context = {
    args: {
      query: "native terminal UI",
      maxResults: 2,
      domain: "example.com",
      excludeDomains: ["noise.example"],
    },
  };

  const collapsed = render(tool, result, false, context);
  assert.match(collapsed, /^WebSearch · "native terminal UI" · 2 results/);
  assert.match(collapsed, /Domain: example\.com/);
  assert.doesNotMatch(collapsed, /complete provider snippet/);

  const expanded = render(tool, result, true, context);
  assert.match(expanded, /WebSearch/);
  assert.match(expanded, /Query: native terminal UI/);
  assert.match(expanded, /Domain: example\.com/);
  assert.match(expanded, /Excluded domains: noise\.example/);
  assert.match(expanded, /Requested maximum results: 2/);
  assert.match(expanded, /Region: us-en/);
  assert.match(expanded, /Freshness: unrestricted/);
  assert.match(expanded.replace(/\n/g, ""), new RegExp("x".repeat(700)));
  assert.match(expanded, /Keyboard and mouse interaction reference/);
  assert.doesNotMatch(expanded, /rawPath|privateTransport/);
  assert.equal((result.content[0] as { text: string }).text, modelText, "the model-facing output is not rewritten");

  assert.equal(render(tool, result, true, context), expanded);
  assert.equal(render(tool, result, false, context), collapsed);
});

test("registered WebSearch keeps control-byte queries and snippets visible without double encoding", () => {
  const tool = registeredSearchTool();
  const query = 'native \\r literal \\u001b[31m and \u0000raw\u001b';
  const snippetControls = "\u001b[31mstyled\u001b[0m\rcr\u0000nul\u007f\u009b";
  const response: Omit<SearchResponse, "fetchedAt" | "durationMs"> = {
    provider: "ddgs",
    query,
    excludedDomains: [],
    results: [
      {
        rank: 1,
        title: "Result with \u0007bell control",
        url: "https://example.com/controls",
        hostname: "example.com",
        snippet: `secret hunter2 ${snippetControls} typed\\u0041 end ${"x".repeat(400)}`,
        dateText: "Aug 23, 2026",
        dateSource: "provider" as const,
      },
      {
        rank: 2,
        title: "Keyboard interaction",
        url: "https://example.com/keyboard",
        hostname: "example.com",
        snippet: "Keyboard and mouse interaction reference.",
      },
    ],
  };
  const modelText = formatSearch({
    ...response,
    fetchedAt: "2026-08-23T00:00:00.000Z",
    durationMs: 12,
  });
  const result = {
    content: [{ type: "text", text: modelText }],
    details: { response, request: { query, maxResults: 2 } },
    isError: false,
  };
  const context = { args: { query, maxResults: 2 } };

  const encodedQuery = visibleTerminalText(query);
  const collapsed = render(tool, result, false, context);
  assert.ok(collapsed.includes(JSON.stringify(encodedQuery)), `collapsed heading shows the encoded-once query: ${collapsed}`);
  assert.doesNotMatch(collapsed, /hunter2/, "collapsed stays a summary");
  assertNoRawControlBytes(collapsed);

  const expanded = render(tool, result, true, context);
  assert.ok(expanded.includes(`Query: ${encodedQuery}`), "expanded request shows the encoded-once query");
  assert.ok(expanded.includes("\\u0000raw\\u001b"), "encoded controls are visible notation, not deleted");
  // Literal escape-shaped query text stays distinguishable from encoded controls.
  assert.ok(expanded.includes("native \\\\r literal \\\\u001b[31m"), JSON.stringify(expanded));
  // Every returned result, including the long control-laden snippet, expands completely.
  assert.match(expanded.replace(/\n/g, ""), new RegExp("x".repeat(400)));
  assert.match(expanded, /hunter2/, "secret-shaped snippet text is not masked");
  assert.ok(expanded.includes("\\u001b[31mstyled\\u001b[0m\\rcr\\u0000nul\\u007f\\u009b"), JSON.stringify(expanded));
  // Applied exactly once: the encoded notation is never re-escaped.
  assert.doesNotMatch(expanded, /\\\\u001b\[31mstyled/);
  assertNoRawControlBytes(expanded);
  // Rendering never rewrites the model-facing payload.
  assert.equal((result.content[0] as { text: string }).text, modelText, "the model-facing output is not rewritten");

  assert.equal(render(tool, result, true, context), expanded, "expansion is deterministic with no re-encoding drift");
  assert.equal(render(tool, result, false, context), collapsed, "re-collapse is deterministic");
});
