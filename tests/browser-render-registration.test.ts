// Interactive Browser* registered-tool result rendering (#93).
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
import { isExpandableResult } from "../src/tool-result-expansion";
import { setNativeExpansionHost, type NativeExpansionHost } from "../src/tool-result-hints";

const theme = {
  bold: (value: string) => value,
  fg: (_color: string, value: string) => value,
};

// ── Injected native host (#93) ──────────────────────────────────────────
//
// Family renderers emit headers WITHOUT an expansion hint; the shared
// `expandableResult` wrapper owns the single hint. These tests render the
// real registrations under an injected native host so every canonical header
// assertion includes exactly one configured-binding hint — the same seam a
// real Pi host resolves through keyHint()/keyText(). node:test runs each
// file in its own process, so the override stays file-local.
const fakeHost: NativeExpansionHost & { binding: string } = {
  binding: "ctrl+o",
  keyHint: (id: string, description: string) => {
    assert.equal(id, "app.tools.expand");
    return `\x1b[2m${fakeHost.binding}\x1b[0m\x1b[90m ${description}\x1b[0m`;
  },
  keyText: (id: string) => {
    assert.equal(id, "app.tools.expand");
    return fakeHost.binding;
  },
  visibleWidth: (line: string) => {
    let cells = 0;
    for (const ch of line.replace(/\x1b\[[0-9;]*[a-zA-Z]/gu, "")) cells += 1;
    return cells;
  },
};

setNativeExpansionHost(fakeHost);

/** Runs a fixture without the injected host (family-only width contracts). */
function withoutNativeHost<T>(run: () => T): T {
  setNativeExpansionHost(undefined);
  try {
    return run();
  } finally {
    setNativeExpansionHost(fakeHost);
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/gu, "");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

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
    assert.notEqual(tool.renderResult, browserRenderResult, `${name} must not use the interactive browser family wrapper`);
    if (name === "WebSearch") {
      assert.equal(isExpandableResult(tool.renderResult), true, "WebSearch uses its shared human expansion wrapper (#93)");
    } else {
      assert.equal(isExpandableResult(tool.renderResult), true, `${name} uses its acquisition detail wrapper (#82)`);
    }
  }
});

test("all 18 registered Browser views expose canonical requests and results", () => {
  const shared = { session: "browser1", tab: "tab1", generation: "generation1", url: "https://example.com/" };
  const cases: Array<{
    name: string;
    response: Record<string, unknown>;
    args: Record<string, unknown>;
    expected: string[];
  }> = [
    {
      name: "BrowserOpen",
      response: { ...shared, status: 200, title: "Example", limits: {} },
      args: { url: "https://example.com/" },
      expected: ["Requested URL: https://example.com/", "Final URL: https://example.com/", "HTTP status: 200"],
    },
    {
      name: "BrowserNavigate",
      response: { ...shared, generation: "generation2", url: "https://example.com/docs", status: 200, title: "Documentation", navigationsRemaining: null },
      args: { session: "browser1", tab: "tab1", url: "https://example.com/docs" },
      expected: ["Requested URL: https://example.com/docs", "Final URL: https://example.com/docs", "Generation: generation2"],
    },
    {
      name: "BrowserSnapshot",
      response: { ...shared, title: "Documentation", snapshot: 'heading \\"Documentation\\"', refs: 1, truncation: { truncated: false, originalChars: 25, returnedChars: 25, maxChars: 12000 } },
      args: { session: "browser1", tab: "tab1", maxChars: 12000 },
      expected: ["Requested maximum: 12000 characters", "Acquisition truncated: no", 'heading \\\\"Documentation\\\\"'],
    },
    {
      name: "BrowserConsole",
      response: { ...shared, events: [{ sequence: 1, elapsedMs: 12, kind: "console", level: "log", text: "Ready", textTruncated: false, source: null }], cursor: { requested: 0, next: 1, latest: 1, oldestRetained: 1 }, counts: { returned: 1, dropped: 0, totalDropped: 0, truncated: 0, captureTruncated: 0, totalCaptureTruncated: 0 }, capacity: 256 },
      args: { session: "browser1", tab: "tab1", cursor: 0, maxEvents: 64 },
      expected: ["Request: cursor 0, maximum 64 events", "Next cursor: 1", "Ready"],
    },
    {
      name: "BrowserNetwork",
      response: { ...shared, events: [{ sequence: 1, elapsedMs: 12, phase: "response", method: "GET", origin: "https://example.com", resourceKind: "document", status: 200, durationMs: 84, outcome: "succeeded" }], cursor: { requested: 0, next: 1, latest: 1, oldestRetained: 1 }, counts: { returned: 1, dropped: 0, totalDropped: 0, truncated: 0, captureTruncated: 0, totalCaptureTruncated: 0 }, capacity: 256 },
      args: { session: "browser1", tab: "tab1", cursor: 0, maxEvents: 64 },
      expected: ["Request: cursor 0, maximum 64 events", "Outcome: response", "Bodies, headers and request queries are not captured"],
    },
    {
      name: "BrowserInspect",
      response: { ...shared, ref: "ref1", semantic: { role: "link", tag: "a", type: null, accessibleName: "Install", accessibleDescription: "", states: { checked: null, disabled: false, expanded: null, selected: null, focused: false, editable: false }, hrefOrigin: "https://example.com", visibleText: { text: "Install", returnedChars: 7, truncated: false, suppressed: false } } },
      args: { session: "browser1", tab: "tab1", ref: "ref1" },
      expected: ["Requested ref: ref1", "Role: link", "Name: Install", "Visible: [not returned]", "Enabled: true", "Destination origin: https://example.com"],
    },
    {
      name: "BrowserScreenshot",
      response: { ...shared, mode: "viewport", mimeType: "image/png", width: 1280, height: 720, encodedBytes: 48216, limits: { maxWidth: 2000, maxHeight: 2000, maxPixels: 4000000, maxEncodedBytes: 4194304, maxAllocationBytes: 33554432 } },
      args: { session: "browser1", tab: "tab1", mode: "viewport" },
      expected: ["Requested mode: viewport", "Captured size: 1280×720", "Format: image/png", "[native image]"],
    },
    {
      name: "BrowserScroll",
      response: { ...shared, target: "page", direction: "down", amount: 2 },
      args: { session: "browser1", tab: "tab1", target: "page", direction: "down", amount: 2 },
      expected: ["Target: page", "Direction: down", "Amount: 2 viewport fractions", "Result: scroll operation completed"],
    },
    {
      name: "BrowserHover",
      response: { ...shared, operation: "hover", consequence: "observational", confirmed: false, approval: "not_required", effect: "completed", effects: { navigation: "not_observed", network: "not_observed", observedPopupTabs: 0, observedOverflowPopupsClosed: 0, observedDialogsDismissed: 0, download: "not_observed", accounting: "bounded_stable" } },
      args: { session: "browser1", tab: "tab1", ref: "ref2" },
      expected: ["Requested target: ref2", "Operation: hover", "Effect: completed"],
    },
    {
      name: "BrowserClick",
      response: { ...shared, operation: "click", consequence: "ordinary_navigation", confirmed: false, approval: "automatic", effect: "completed", effects: { navigation: "observed", network: "observed", observedPopupTabs: 0, observedOverflowPopupsClosed: 0, observedDialogsDismissed: 0, download: "not_observed", accounting: "bounded_stable" } },
      args: { session: "browser1", tab: "tab1", ref: "ref1", button: "left" },
      expected: ["Requested target: ref1", "Button: left", "Approval: automatic", "Observed navigation: yes"],
    },
    {
      name: "BrowserFill",
      response: { ...shared, operation: "fill", consequence: "local_editing", confirmed: false, approval: "automatic", effect: "completed", effects: { navigation: "not_observed", network: "not_observed", observedPopupTabs: 0, observedOverflowPopupsClosed: 0, observedDialogsDismissed: 0, download: "not_observed", accounting: "bounded_stable" } },
      args: { session: "browser1", tab: "tab1", ref: "ref3", value: "secret-shaped-company" },
      expected: ["Value submitted:\nsecret-shaped-company", "Approval: automatic", "Effect: completed"],
    },
    {
      name: "BrowserType",
      response: { ...shared, operation: "type", consequence: "local_editing", confirmed: false, approval: "automatic", effect: "completed", effects: { navigation: "not_observed", network: "not_observed", observedPopupTabs: 0, observedOverflowPopupsClosed: 0, observedDialogsDismissed: 0, download: "not_observed", accounting: "bounded_stable" } },
      args: { session: "browser1", tab: "tab1", ref: "ref3", text: " secret-shaped-region", delayMs: 0 },
      expected: ["Per-character delay: 0ms", "Text submitted:\n secret-shaped-region"],
    },
    {
      name: "BrowserSelect",
      response: { ...shared, operation: "select", consequence: "local_editing", confirmed: false, approval: "automatic", effect: "completed", effects: { navigation: "not_observed", network: "not_observed", observedPopupTabs: 0, observedOverflowPopupsClosed: 0, observedDialogsDismissed: 0, download: "not_observed", accounting: "bounded_stable" } },
      args: { session: "browser1", tab: "tab1", ref: "ref4", values: ["secret-shaped-tier", "Annual"] },
      expected: ["Submitted option labels/values:\n- secret-shaped-tier\n- Annual"],
    },
    {
      name: "BrowserPress",
      response: { ...shared, operation: "press", consequence: "local_editing", confirmed: false, approval: "automatic", effect: "completed", effects: { navigation: "not_observed", network: "not_observed", observedPopupTabs: 0, observedOverflowPopupsClosed: 0, observedDialogsDismissed: 0, download: "not_observed", accounting: "bounded_stable" } },
      args: { session: "browser1", tab: "tab1", ref: "ref3", key: "Tab" },
      expected: ["Key: Tab", "Effect: completed"],
    },
    {
      name: "BrowserWait",
      response: { ...shared, condition: "text", satisfied: true, elapsedMs: 812 },
      args: { session: "browser1", tab: "tab1", condition: "text", text: "Ready", present: true, timeoutMs: 10000 },
      expected: ["Condition: text", "Text: Ready", "Required presence: true", "Timeout: 10000ms", "Result: satisfied"],
    },
    {
      name: "BrowserHistory",
      response: { ...shared, operation: "back", title: "Documentation", entries: [{ index: 0, url: "https://example.com/", generation: "g0", current: false }, { index: 1, url: "https://example.com/docs", generation: "g1", current: true }], truncated: false, omittedEntries: 0, navigationsRemaining: null },
      args: { session: "browser1", tab: "tab1", operation: "back", maxEntries: 16 },
      expected: ["Requested operation: back", "Requested maximum entries: 16", "Returned history:", "* 1  https://example.com/docs", "Current entry: 1"],
    },
    {
      name: "BrowserTabs",
      response: { session: "browser1", operation: "switch", activeTab: "tab2", tabs: [{ tab: "tab1", generation: "g1", url: "https://example.com/", active: false }, { tab: "tab2", generation: "g2", url: "https://example.com/docs", active: true }], sessionClosed: false, tabsRemaining: 2, maxTabs: 4 },
      args: { session: "browser1", operation: "switch", tab: "tab2" },
      expected: ["Requested operation: switch", "Requested tab: tab2", "* tab2 · https://example.com/docs", "Session closed: no"],
    },
    {
      name: "BrowserClose",
      response: { session: "browser1", closed: true, alreadyClosed: false, quiescent: true, broker: { connections: 3, ledgerDropped: 0, capacityRefusals: 0, budgetAborts: 0 }, diagnosticsRetained: true },
      args: { session: "browser1" },
      expected: ["Requested session: browser1", "Closed: yes", "Already closed: no", "Quiescent: yes", "Broker connections: 3"],
    },
  ];

  assert.equal(cases.length, INTERACTIVE_BROWSER_TOOL_NAMES.length);
  for (const fixture of cases) {
    const tool = registeredTool(fixture.name);
    const result = fixture.name === "BrowserScreenshot"
      ? { ...textResult("screenshot metadata", fixture.response), content: [{ type: "text", text: "screenshot metadata" }, { type: "image", data: SCREENSHOT_BASE64, mimeType: "image/png" }] }
      : textResult("model-visible summary", fixture.response);
    const context = { showImages: true, toolName: fixture.name, args: fixture.args };
    const collapsed = renderThrough(tool, result, { expanded: false }, context).join("\n");
    assert.match(stripAnsi(collapsed), /ctrl\+o to expand/, `${fixture.name} collapsed hint`);
    assert.equal(countOccurrences(stripAnsi(collapsed), "(ctrl+o to expand)"), 1, `${fixture.name}: exactly one collapsed hint via the shared wrapper`);
    assert.doesNotMatch(stripAnsi(collapsed), /to collapse/, `${fixture.name}: collapsed card advertises only expansion`);
    const expanded = renderThrough(tool, result, { expanded: true }, context).join("\n");
    assert.match(stripAnsi(expanded), /ctrl\+o to collapse/, `${fixture.name} expanded hint`);
    assert.equal(countOccurrences(stripAnsi(expanded), "(ctrl+o to collapse)"), 1, `${fixture.name}: exactly one expanded hint via the shared wrapper`);
    for (const expected of fixture.expected) assert.match(expanded, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")), `${fixture.name}: ${expected}`);
  }
});

test("registered BrowserHistory keeps its response classification when maxEntries is omitted", () => {
  const tool = registeredTool("BrowserHistory");
  for (const operation of ["list", "back", "forward", "reload"] as const) {
    const result = textResult("history result", {
      session: "browser1",
      tab: "tab1",
      generation: `generation-${operation}`,
      url: `https://example.com/${operation}`,
      title: "History fixture",
      operation,
      entries: [{ index: 0, url: "https://example.com/start", generation: "generation-start", current: true }],
      truncated: false,
      omittedEntries: 0,
      navigationsRemaining: null,
    });
    const expanded = renderThrough(
      tool,
      result,
      { expanded: true },
      { showImages: true, args: { session: "browser1", tab: "tab1", operation } },
    ).join("\n");
    assert.match(stripAnsi(expanded), /BrowserHistory \(ctrl\+o to collapse\)/, operation);
    assert.match(expanded, /Returned history:/, operation);
    assert.match(expanded, /\* 0  https:\/\/example\.com\/start/, operation);
    assert.doesNotMatch(expanded, /BrowserTabs|Returned tabs:/, operation);
  }
});

test("BrowserConsole registered tool expands readable records and re-collapses", () => {
  const tool = registeredTool("BrowserConsole");
  const result = diagnosticsResult();
  const collapsed = renderThrough(tool, result, { expanded: false });
  assert.match(stripAnsi(collapsed.join("\n")), /BrowserConsole · 2 events · 1 error \(ctrl\+o to expand\)/);
  assert.ok(collapsed.length <= BROWSER_COLLAPSED_PREVIEW_LINES, "the collapsed preview stays bounded");

  const expanded = renderThrough(tool, result, { expanded: true });
  const expandedText = expanded.join("\n");
  assert.match(stripAnsi(expandedText), /BrowserConsole \(ctrl\+o to collapse\)/);
  assert.match(expandedText, /#1 · \+12ms · console · log/);
  assert.match(expandedText, /hello/);
  assert.match(expandedText, /#2 · \+40ms · page error · TypeError/);
  assert.match(expandedText, /Next cursor: 2/);
  assert.match(expandedText, /Dropped events: 0/);
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
  assert.match(collapsed, /BrowserScreenshot · viewport · 640×480/);
  assert.match(collapsed, /\[native image\]/);
  assert.match(stripAnsi(expanded), /BrowserScreenshot \(ctrl\+o to collapse\)/);
  assert.match(expanded, /Captured size: 640×480/);
  assert.match(expanded, /Encoded size: 12345 bytes/);
  assert.match(expanded, /Image: native image block retained; encoded data is not printed/);
  // The host's image-visibility flag is the only extra state the detail view
  // reads, and it changes only the presentation line.
  const hidden = renderThrough(tool, result, { expanded: true }, { showImages: false }).join("\n");
  assert.match(hidden, /\(image display is currently hidden\)/);
  assert.doesNotMatch(hidden, /encoded data is not printed\./);
});

test("BrowserFill expansion shows the recorded model value without changing browser output protection", () => {
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
  const collapsed = renderThrough(tool, result, { expanded: false }, { showImages: true, toolName: "BrowserFill", args: {
    session: "session_safe", tab: "tab_safe", ref: "ref_safe", value: "hunter2-secret",
  } }).join("\n");
  const expanded = renderThrough(tool, result, { expanded: true }, { showImages: true, toolName: "BrowserFill", args: {
    session: "session_safe", tab: "tab_safe", ref: "ref_safe", value: "hunter2-secret",
  } }).join("\n");
  assert.doesNotMatch(collapsed, /hunter2-secret|payload/);
  assert.doesNotMatch(expanded, /payload|enteredValue|internalState/);
  assert.match(collapsed, /BrowserFill · ref_safe · replaced field value/);
  assert.match(expanded, /Value submitted:\nhunter2-secret/);
  assert.match(expanded, /Consequence: local_editing/);
  assert.match(expanded, /Effect: dispatched/);
});

test("registered Browser cards carry exactly one configured-binding hint through the shared wrapper", () => {
  const tool = registeredTool("BrowserOpen");
  const result = textResult("opened", {
    session: "browser1", tab: "tab1", generation: "generation1",
    url: "https://example.com/", title: "Example", status: 200, limits: {},
  });
  const context = { showImages: true, toolName: "BrowserOpen", args: { url: "https://example.com/" } };

  // Collapsed: the family header is the canonical text; the wrapper appends
  // the single hint, so a real host can never show a duplicate.
  const collapsedRows = renderThrough(tool, result, { expanded: false }, context).map(stripAnsi);
  assert.equal(collapsedRows[0], "BrowserOpen · opened · Example (ctrl+o to expand)");
  assert.equal(countOccurrences(collapsedRows.join("\n"), "to expand"), 1);
  assert.doesNotMatch(collapsedRows.join("\n"), /to collapse/);

  // Expanded: the same single-hint contract in the other state.
  const expandedRows = renderThrough(tool, result, { expanded: true }, context).map(stripAnsi);
  assert.equal(expandedRows[0], "BrowserOpen (ctrl+o to collapse)");
  assert.equal(countOccurrences(expandedRows.join("\n"), "to collapse"), 1);
  assert.doesNotMatch(expandedRows.join("\n"), /to expand/);

  // The binding is resolved from the host, never hard-coded: overriding it
  // changes the rendered hint and the default disappears.
  fakeHost.binding = "alt+shift+x";
  try {
    const rebound = renderThrough(tool, result, { expanded: false }, context).map(stripAnsi);
    assert.equal(rebound[0], "BrowserOpen · opened · Example (alt+shift+x to expand)");
    assert.doesNotMatch(rebound.join("\n"), /ctrl\+o/);
    assert.equal(countOccurrences(rebound.join("\n"), "to expand"), 1);
  } finally {
    fakeHost.binding = "ctrl+o";
  }
});

test("narrow registered Browser headers keep full content and show the hint on its own wrapped row", () => {
  const tool = registeredTool("BrowserOpen");
  const title = "A deliberately long untrusted page title";
  const result = textResult("opened", {
    session: "browser1", tab: "tab1", generation: "generation1",
    url: "https://example.com/", title, status: 200, limits: {},
  });
  const context = { showImages: true, toolName: "BrowserOpen", args: { url: "https://example.com/" } };
  const header = `BrowserOpen · opened · ${title}`;
  // At every width the full header content survives untouched and exactly one
  // hint stays visible: inline while it fits, otherwise on its own wrapped
  // row(s) — never a hidden affordance or a second toggle.
  for (const width of [header.length + 1, 20, 10]) {
    const rows = renderThrough(tool, result, { expanded: false }, context, width).map(stripAnsi);
    assert.ok(rows.join("").includes(header), `width ${width}: full header content preserved`);
    assert.equal(countOccurrences(rows.join("\n"), "ctrl+o"), 1, `width ${width}: exactly one visible hint`);
    assert.doesNotMatch(rows.join("\n"), /to collapse/);
    for (const row of rows) {
      assert.ok(Array.from(row).length <= width, `width ${width}: row fits: ${JSON.stringify(row)}`);
    }
  }
  // Below the inline-fit width the hint moved to its own row(s).
  const narrow = renderThrough(tool, result, { expanded: false }, context, 10).map(stripAnsi);
  assert.deepEqual(narrow.slice(-2), ["(ctrl+o to", "expand)"]);
});

test("registered BrowserType expansion display-encodes control bytes without deleting any submitted byte", () => {
  const tool = registeredTool("BrowserType");
  // Distinguishable inputs: actual ESC/CR/NUL/DEL bytes AND literally typed
  // escape-shaped text ("\r", "\u001b" as ordinary characters) — the encoding
  // must keep them visually distinct and recover both exactly.
  const submitted = "hunter2-secret\u001b[31mred\r\nline2\u0000tail\u007f\\r\\u001bliteral";
  const result = textResult("Browser type applied.", {
    session: "session_safe", tab: "tab_safe", generation: "generation_safe",
    operation: "type", approval: "automatic", effect: "completed",
  });
  const args = { session: "session_safe", tab: "tab_safe", ref: "ref3", text: submitted, delayMs: 0 };
  const context = { showImages: true, toolName: "BrowserType", args };
  const resultBefore = JSON.stringify(result);
  const argsBefore = JSON.stringify(args);
  const rows = renderThrough(tool, result, { expanded: true }, context).map(stripAnsi);
  const expanded = rows.join("\n");

  // Every control byte is visible as escape notation — ESC as \u001b, CR as
  // \r, NUL as \u0000, DEL as \u007f — while literal backslash text is
  // escaped (\\r, \\u001b), keeping the two inputs distinguishable.
  assert.match(
    expanded,
    /Text submitted:\nhunter2-secret\\u001b\[31mred\\r\nline2\\u0000tail\\u007f\\\\r\\\\u001bliteral/,
    "display-encoded submitted value fully visible, literals distinguishable",
  );
  // No raw control bytes reach the terminal: only LF line structure remains.
  for (const row of rows) {
    for (const ch of row) {
      assert.ok(ch === "\n" || (ch >= " " && ch !== "\u007f"), `no executable control byte in row: ${JSON.stringify(row)}`);
    }
  }
  // The encoding is reversible: a sequential decoder recovers the exact
  // original bytes, literal escape-shaped text included.
  const renderedValue = expanded.slice(
    expanded.indexOf("Text submitted:\n") + "Text submitted:\n".length,
    expanded.indexOf("\nApproval:") >= 0 ? expanded.indexOf("\nApproval:") : undefined,
  );
  assert.equal(decodeVisibleTerminal(renderedValue), submitted, "exact round-trip of the submitted value");
  // Rendering never mutates the returned payload or the recorded call args.
  assert.equal(JSON.stringify(result), resultBefore, "the raw result payload is unchanged");
  assert.equal(JSON.stringify(context.args), argsBefore, "the recorded call args are unchanged");
});

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

test("error results render the failed states without fabricating detail", () => {
  const tool = registeredTool("BrowserClose");
  const withText = textResult("BrowserClose failed: phase=timeout.", { error: "timeout" }, true);
  const expanded = renderThrough(tool, withText, { expanded: true }).join("\n");
  assert.match(expanded, /Browser result failed; no additional retained detail is available/);
  assert.match(expanded, /BrowserClose failed: phase=timeout/);
  assert.deepEqual(renderThrough(tool, withText, { expanded: false }), renderThrough(tool, withText, { expanded: false }));
  const withoutText = { content: [], details: {}, isError: true };
  assert.match(renderThrough(tool, withoutText, { expanded: true }).join("\n"), /No bounded error text was returned/);
  assert.match(stripAnsi(renderThrough(tool, withoutText, { expanded: false }).join("\n")), /Browser · failed \(ctrl\+o to expand\)/);
  assert.match(renderThrough(tool, withoutText, { expanded: false }).join("\n"), /No retained error text/);
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
  assert.match(stripAnsi(collapsedPartial), /Browser · running \(ctrl\+o to expand\)/);
  assert.match(collapsedPartial, /No completed browser result is retained yet/);
});

test("empty results report the empty state in both states", () => {
  const tool = registeredTool("BrowserOpen");
  const empty = { content: [], details: {} };
  assert.match(renderThrough(tool, empty, { expanded: false }).join("\n"), /no retained output/);
  const expanded = renderThrough(tool, empty, { expanded: true }).join("\n");
  assert.match(stripAnsi(expanded), /Browser \(ctrl\+o to collapse\)/);
  assert.match(expanded, /No retained browser output/);
});

test("collapsed output stays concise while expanded output keeps all retained snapshot text", () => {
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
  assert.match(stripAnsi(collapsedText), /BrowserSnapshot · Untrusted fixture · 5 refs \(ctrl\+o to expand\)/);
  assert.ok(!collapsedText.includes("model line 1"), "the collapsed card should remain a concise result summary");

  const expanded = renderThrough(tool, result, { expanded: true }).join("\n");
  assert.match(stripAnsi(expanded), /BrowserSnapshot \(ctrl\+o to collapse\)/);
  assert.match(expanded, /Untrusted snapshot:/);
  assert.match(expanded, /line 116/);
  assert.ok(renderThrough(tool, result, { expanded: true }).length > BROWSER_RENDER_MAX_LINES);
  assert.doesNotMatch(expanded, /retained renderer line\(s\) omitted|renderer line truncated/);

  // A single oversized retained line remains complete after width wrapping.
  const longExpanded = renderThrough(tool, longLineResult, { expanded: true }).join("\n");
  assert.ok(longExpanded.replace(/\n/g, "").includes("y".repeat(5_000)));
  assert.doesNotMatch(longExpanded, /renderer line truncated/);
});

test("collapsed previews stay bounded at narrow widths with a width-clipped marker", () => {
  // Family-only width contract: rendered without the injected host so the
  // wrapper's fallback hint row does not perturb the preview bound. The
  // host-injected narrow behavior is covered in the dedicated test below.
  withoutNativeHost(() => {
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
    assert.ok(collapsed.length > 0);
    // Re-collapse renders exactly the same bounded view.
    assert.deepEqual(renderThrough(tool, result, { expanded: false }, { showImages: true }, width), collapsed);
  }
  });
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
  assert.match(collapsed.join("\n"), /BrowserSnapshot/);
  assert.match(stripAnsi(collapsed.join("\n")), /ctrl\+o to expand/);
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
  assert.match(manyCollapsed.join("\n"), /BrowserSnapshot/);
  assert.match(stripAnsi(manyCollapsed.join("\n")), /ctrl\+o to expand/);
  // Expanded rendering is unaffected by the collapsed row bound: the detail
  // view still reveals the retained snapshot.
  const expanded = renderThrough(tool, oneLongLine, { expanded: true }, { showImages: true }, 80);
  assert.ok(expanded.length > BROWSER_COLLAPSED_PREVIEW_LINES, "expansion must still reveal the retained detail");
  assert.match(expanded.join("\n"), /Untrusted snapshot:/);
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
  assert.match(stripAnsi(expanded), /BrowserHistory \(ctrl\+o to collapse\)/);
  assert.match(expanded, /\* 0  https:\/\/example\.test\//);
});
