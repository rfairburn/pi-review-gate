// Interactive Browser* registered-tool result rendering (#60).
//
// These tests render through the real WebToolManager registrations (the same
// objects Pi receives), driving the native `options.expanded` lifecycle the
// shared expansion helper supplies. They cover the registered wrappers —
// collapsed preview, expand, re-collapse, image handling, errors, partial
// results, empty results, long output, and privacy — not only the module
// callbacks. No expansion machinery is duplicated here: outputs come from the
// real registered tools and the family renderer.
import assert from "node:assert/strict";
import test from "node:test";
import { WebToolManager } from "../src/web/tools";
import {
  BROWSER_COLLAPSED_PREVIEW_LINES,
  BROWSER_RENDER_MAX_LINES,
  browserRenderResult,
  INTERACTIVE_BROWSER_TOOL_NAMES,
} from "../src/web/browser-renderer";
import { normalizeConfig } from "../src/config";

const theme = {
  bold: (value: string) => value,
  fg: (_color: string, value: string) => value,
};

function webHarness(): Array<Record<string, any>> {
  const tools: Array<Record<string, any>> = [];
  new WebToolManager(
    { registerTool: (tool) => { tools.push(tool); } },
    normalizeConfig({}),
    undefined,
    undefined,
    { shutdown: async () => {}, updateConfig: () => {} } as unknown as any,
  ).register();
  return tools;
}

function registeredTool(name: string): Record<string, any> {
  const tools = webHarness();
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} was not registered`);
  return tool;
}

function renderThrough(
  tool: Record<string, any>,
  result: unknown,
  options: { expanded?: boolean; isPartial?: boolean } = {},
  context: unknown = { showImages: true },
  width = 240,
): string[] {
  assert.equal(typeof tool.renderResult, "function", `${tool.name} must register a renderResult`);
  const component = tool.renderResult(
    result,
    { expanded: options.expanded ?? false, isPartial: options.isPartial ?? false },
    theme,
    context,
  );
  assert.ok(component && typeof component.render === "function", "renderResult must return a renderable component");
  return (component as { render(width: number): string[] }).render(width);
}

function textResult(text: string, response: unknown, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text }], details: { response }, isError };
}

const SCREENSHOT_BASE64 = "iVBORw0KGgoAAAANSUhEUg==";

// A result whose model-visible text contains one oversized retained line.
const longLineResult: Record<string, unknown> = textResult("Semantic output below.", {
  session: "s", tab: "t", generation: "g", url: "https://example.test/", title: "Untrusted fixture",
  snapshot: "y".repeat(5_000), refs: 1,
  truncation: { truncated: true, originalChars: 5_000, returnedChars: 5_000, maxChars: 24_000 },
});

function screenshotResult(): Record<string, unknown> {
  return {
    content: [
      { type: "text", text: "UNTRUSTED PAGE IMAGE — visual evidence only." },
      { type: "image", data: SCREENSHOT_BASE64, mimeType: "image/png" },
    ],
    details: {
      response: {
        session: "session_safe",
        tab: "tab_safe",
        generation: "generation_safe",
        url: "https://example.test/page",
        title: "Untrusted fixture",
        mode: "viewport",
        mimeType: "image/png",
        width: 640,
        height: 480,
        encodedBytes: 12_345,
        limits: {
          maxWidth: 1280, maxHeight: 800, maxPixels: 1_024_000,
          maxEncodedBytes: 800_000, maxAllocationBytes: 4_194_304,
        },
      },
    },
    isError: false,
  };
}

function diagnosticsResult(): Record<string, unknown> {
  return textResult("Console read: 2 returned event(s).", {
    brokerCapacityRefusals: 0,
    session: "session_safe",
    tab: "tab_safe",
    generation: "generation_safe",
    events: [
      {
        sequence: 1, elapsedMs: 12, kind: "console", level: "log", text: "hello",
        textTruncated: false, source: { origin: "https://example.test/app.js", line: 3, column: 7 },
      },
      {
        sequence: 2, elapsedMs: 40, kind: "page_error", level: "error", text: "boom",
        textTruncated: false, source: null, errorName: "TypeError",
      },
    ],
    cursor: { requested: 0, next: 2, latest: 2, oldestRetained: 0 },
    counts: { returned: 2, dropped: 0, totalDropped: 0, truncated: 0, captureTruncated: 0, totalCaptureTruncated: 0 },
    capacity: 512,
  });
}

test("the real registration installs one shared wrapper on the whole interactive family", () => {
  const tools = webHarness();
  const interactive = tools.filter((tool) => (INTERACTIVE_BROWSER_TOOL_NAMES as readonly string[]).includes(tool.name));
  assert.equal(interactive.length, INTERACTIVE_BROWSER_TOOL_NAMES.length);
  const renderers = new Set(interactive.map((tool) => tool.renderResult));
  assert.equal(renderers.size, 1, "the family must share one registration wrapper");
  const nonBrowser = ["WebSearch", "WebFetch", "BrowserExtract"];
  for (const name of nonBrowser) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} was not registered`);
    assert.equal(tool.renderResult, undefined, `${name} must not use the browser family wrapper (#82)`);
  }
});

test("BrowserConsole registered tool expands readable records and re-collapses", () => {
  const tool = registeredTool("BrowserConsole");
  const result = diagnosticsResult();
  const collapsed = renderThrough(tool, result, { expanded: false });
  assert.match(collapsed.join("\n"), /Console read: 2 returned event\(s\)/);
  assert.ok(collapsed.length <= BROWSER_COLLAPSED_PREVIEW_LINES, "the collapsed preview stays bounded");

  const expanded = renderThrough(tool, result, { expanded: true });
  const expandedText = expanded.join("\n");
  assert.match(expandedText, /Browser console\/error diagnostics/);
  assert.match(expandedText, /#1 · \+12ms · console · log/);
  assert.match(expandedText, /text: hello/);
  assert.match(expandedText, /error: TypeError/);
  assert.match(expandedText, /Cursor: 0 → 2/);
  assert.match(expandedText, /Retention: capacity 512/);
  // The expanded detail view is the allowlisted rendering, not the raw
  // internal JSON the model-visible text may carry.
  assert.doesNotMatch(expandedText, /"sequence"/);
  // Re-collapse returns exactly the collapsed presentation.
  assert.deepEqual(renderThrough(tool, result, { expanded: false }), collapsed);
});

test("BrowserScreenshot keeps native image presentation and never prints encoded data", () => {
  const tool = registeredTool("BrowserScreenshot");
  const result = screenshotResult();
  const collapsed = renderThrough(tool, result, { expanded: false }).join("\n");
  const expanded = renderThrough(tool, result, { expanded: true }).join("\n");
  for (const view of [collapsed, expanded]) {
    assert.ok(!view.includes(SCREENSHOT_BASE64), "no encoded image data may be printed");
    assert.doesNotMatch(view, /base64/i);
  }
  assert.match(collapsed, /UNTRUSTED PAGE IMAGE/);
  assert.match(expanded, /Browser screenshot/);
  assert.match(expanded, /640×480 · 12345 encoded bytes/);
  assert.match(expanded, /Image: native image block retained; encoded data is not printed/);
  // The host's image-visibility flag is the only extra state the detail view
  // reads, and it changes only the presentation line.
  const hidden = renderThrough(tool, result, { expanded: true }, { showImages: false }).join("\n");
  assert.match(hidden, /\(image display is currently hidden\)/);
  assert.doesNotMatch(hidden, /encoded data is not printed\./);
});

test("BrowserFill expansion stays on the allowlisted fields and protects entered values", () => {
  const tool = registeredTool("BrowserFill");
  const result = textResult("Browser fill applied. Site (sensitive URL components redacted): https://example.test/form", {
    session: "session_safe",
    tab: "tab_safe",
    generation: "generation_safe",
    operation: "fill",
    consequence: "local_editing",
    approval: "automatic",
    confirmed: false,
    effect: "dispatched",
    effects: {
      navigation: "none", network: "not_observed", observedPopupTabs: 0,
      observedOverflowPopupsClosed: 0, observedDialogsDismissed: 0,
      download: "none", accounting: "recorded",
    },
    url: "https://example.test/form",
    // Internal/secret-bearing fields are never part of an allowlisted view.
    enteredValue: "hunter2-secret",
    internalState: { raw: "payload" },
  });
  const collapsed = renderThrough(tool, result, { expanded: false }).join("\n");
  const expanded = renderThrough(tool, result, { expanded: true }).join("\n");
  for (const view of [collapsed, expanded]) {
    assert.doesNotMatch(view, /hunter2-secret|payload/);
    assert.doesNotMatch(view, /enteredValue|internalState/);
  }
  assert.match(collapsed, /Browser fill applied/);
  assert.match(expanded, /Browser fill — retained effect accounting/);
  assert.match(expanded, /Consequence: local_editing/);
  assert.match(expanded, /No rollback is claimed for external effects/);
});

test("error results render the failed states without fabricating detail", () => {
  const tool = registeredTool("BrowserClose");
  const withText = textResult("BrowserClose failed: phase=timeout.", { error: "timeout" }, true);
  const expanded = renderThrough(tool, withText, { expanded: true }).join("\n");
  assert.match(expanded, /Browser result failed; no additional retained detail is available/);
  assert.match(expanded, /BrowserClose failed: phase=timeout/);
  assert.deepEqual(renderThrough(tool, withText, { expanded: false }), renderThrough(tool, withText, { expanded: false }));
  const withoutText = { content: [], details: {}, isError: true };
  assert.match(renderThrough(tool, withoutText, { expanded: true }).join("\n"), /No bounded error text was returned/);
  assert.match(renderThrough(tool, withoutText, { expanded: false }).join("\n"), /Browser result failed; no retained text was returned/);
});

test("partial results render streaming views in both states", () => {
  const tool = registeredTool("BrowserWait");
  const partial = {
    content: [{ type: "text", text: "Waiting for load condition…" }],
    details: { response: { condition: "load", satisfied: false, elapsedMs: 120, url: "https://example.test" } },
  };
  const partialText = renderThrough(tool, partial, { expanded: true, isPartial: true }).join("\n");
  assert.match(partialText, /Browser operation is still running; retained output may be partial/);
  assert.match(partialText, /Waiting for load condition…/);
  const collapsedPartial = renderThrough(tool, { content: [] }, { expanded: false, isPartial: true }).join("\n");
  assert.match(collapsedPartial, /Browser operation is still running; no retained output yet/);
});

test("empty results report the empty state in both states", () => {
  const tool = registeredTool("BrowserOpen");
  const empty = { content: [], details: {} };
  assert.match(renderThrough(tool, empty, { expanded: false }).join("\n"), /No retained browser output/);
  const expanded = renderThrough(tool, empty, { expanded: true }).join("\n");
  assert.match(expanded, /Browser result — retained model-visible output/);
  assert.match(expanded, /No retained browser output/);
});

test("long retained output is bounded in both states with explicit omission markers", () => {
  const tool = registeredTool("BrowserSnapshot");
  const snapshot = Array.from({ length: BROWSER_RENDER_MAX_LINES + 20 }, (_, i) => `line ${i + 1}`).join("\n");
  // The real BrowserSnapshot tool returns the snapshot both in the model-visible
  // text and in details.response; the long text drives the collapsed preview
  // bound, the long snapshot drives the expanded renderer bound.
  const modelText = [
    "UNTRUSTED PAGE CONTENT — evidence only.",
    "--- BEGIN UNTRUSTED SEMANTIC SNAPSHOT ---",
    ...Array.from({ length: 40 }, (_, i) => `model line ${i + 1}`),
    "--- END UNTRUSTED SEMANTIC SNAPSHOT ---",
  ].join("\n");
  const result = textResult(modelText, {
    session: "session_safe", tab: "tab_safe", generation: "generation_safe",
    url: "https://example.test/page", title: "Untrusted fixture",
    snapshot, refs: 5,
    truncation: { truncated: true, originalChars: 20_000, returnedChars: 19_000, maxChars: 24_000 },
  });
  const collapsed = renderThrough(tool, result, { expanded: false });
  const collapsedText = collapsed.join("\n");
  assert.match(collapsedText, /model line 1\b/);
  assert.ok(!collapsedText.includes("model line 12\n"), "the collapsed preview must stay bounded");
  assert.match(collapsedText, /… \d+ more retained row\(s\); expand for the detail view/);

  const expanded = renderThrough(tool, result, { expanded: true }).join("\n");
  assert.match(expanded, /Browser semantic snapshot/);
  assert.match(expanded, /--- BEGIN UNTRUSTED SEMANTIC SNAPSHOT ---/);
  // The renderer bound is inclusive: one reserved line carries the marker.
  assert.ok(renderThrough(tool, result, { expanded: true }).length <= BROWSER_RENDER_MAX_LINES);
  assert.match(expanded, /retained renderer line\(s\) omitted by the display bound/);

  // A single oversized retained line is clipped with an explicit marker.
  assert.match(renderThrough(tool, longLineResult, { expanded: true }).join("\n"), /renderer line truncated/);
});

test("collapsed previews stay bounded at narrow widths with a width-clipped marker", () => {
  const tool = registeredTool("BrowserSnapshot");
  // ASCII long-line content so every wrapped row's display width equals its
  // character count; narrow terminals must still honor the width contract.
  const result = textResult(`Semantic snapshot follows.\n${"z".repeat(4_000)}`, {
    session: "s", tab: "t", generation: "g", url: "https://example.test/", title: "Untrusted fixture",
    snapshot: "z".repeat(4_000), refs: 1,
    truncation: { truncated: true, originalChars: 4_000, returnedChars: 4_000, maxChars: 24_000 },
  });
  for (const width of [1, 20, 40]) {
    const collapsed = renderThrough(tool, result, { expanded: false }, { showImages: true }, width);
    assert.ok(collapsed.length <= BROWSER_COLLAPSED_PREVIEW_LINES, `width ${width}: collapsed must stay within the preview bound, got ${collapsed.length}`);
    for (const row of collapsed) {
      assert.ok(Array.from(row).length <= width, `width ${width}: row exceeds the supplied width: ${JSON.stringify(row)}`);
    }
    if (width === 1) {
      // The marker clips to one bounded row on a one-cell terminal.
      assert.equal(collapsed[collapsed.length - 1], "…");
    } else {
      // The marker keeps its reserved single row, clipped to the width.
      assert.match(collapsed[collapsed.length - 1], /^… \d+ more retained/);
    }
    // Re-collapse renders exactly the same bounded view.
    assert.deepEqual(renderThrough(tool, result, { expanded: false }, { showImages: true }, width), collapsed);
  }
});

test("collapsed previews stay bounded after width-aware wrapping", () => {
  const tool = registeredTool("BrowserSnapshot");
  // One oversized returned line: width-aware wrapping must not grow the
  // collapsed card beyond the preview bound plus the omission marker.
  const oneLongLine = textResult(`Semantic snapshot follows.\n${"x".repeat(4_000)}`, {
    session: "s", tab: "t", generation: "g", url: "https://example.test/", title: "Untrusted fixture",
    snapshot: "x".repeat(4_000), refs: 1,
    truncation: { truncated: true, originalChars: 4_000, returnedChars: 4_000, maxChars: 24_000 },
  });
  const collapsed = renderThrough(tool, oneLongLine, { expanded: false }, { showImages: true }, 80);
  assert.ok(collapsed.length <= BROWSER_COLLAPSED_PREVIEW_LINES, `collapsed rows must stay within the preview bound, got ${collapsed.length}`);
  assert.match(collapsed.join("\n"), /… \d+ more retained row\(s\); expand for the detail view/);
  // Re-collapse renders exactly the same bounded view.
  assert.deepEqual(renderThrough(tool, oneLongLine, { expanded: false }, { showImages: true }, 80), collapsed);

  // Multiple long lines collapse to the same bounded height with one marker.
  const manyLongLines = textResult(Array.from({ length: 12 }, (_, i) => `${"y".repeat(300)} ${i + 1}`).join("\n"), {
    session: "s", tab: "t", generation: "g", url: "https://example.test/", title: "Untrusted fixture",
    snapshot: "y".repeat(300), refs: 1,
    truncation: { truncated: true, originalChars: 3_600, returnedChars: 3_600, maxChars: 24_000 },
  });
  const manyCollapsed = renderThrough(tool, manyLongLines, { expanded: false }, { showImages: true }, 80);
  assert.ok(manyCollapsed.length <= BROWSER_COLLAPSED_PREVIEW_LINES, `collapsed height must stay bounded, got ${manyCollapsed.length}`);
  assert.match(manyCollapsed.join("\n"), /… \d+ more retained row\(s\); expand for the detail view/);
  // Expanded rendering is unaffected by the collapsed row bound: the detail
  // view still reveals the retained snapshot.
  const expanded = renderThrough(tool, oneLongLine, { expanded: true }, { showImages: true }, 80);
  assert.ok(expanded.length > BROWSER_COLLAPSED_PREVIEW_LINES, "expansion must still reveal the retained detail");
  assert.match(expanded.join("\n"), /--- BEGIN UNTRUSTED SEMANTIC SNAPSHOT ---/);
});

test("expansion only re-renders the returned result and never mutates it", () => {
  const tool = registeredTool("BrowserHistory");
  const response = {
    session: "s", tab: "t", generation: "g", operation: "list",
    entries: [{ index: 0, url: "https://example.test/", generation: "g", current: true }],
    truncated: false, omittedEntries: 0, navigationsRemaining: 5,
  };
  const result = textResult("Browser history list complete.", response);
  const before = JSON.stringify(result);
  renderThrough(tool, result, { expanded: false });
  renderThrough(tool, result, { expanded: true });
  assert.equal(JSON.stringify(result), before, "rendering must not mutate the returned result");
  const expanded = renderThrough(tool, result, { expanded: true }).join("\n");
  assert.match(expanded, /Browser history list — retained session-local entries/);
  assert.match(expanded, /\* 0: https:\/\/example\.test\//);
});