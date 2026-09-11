import assert from "node:assert/strict";
import test from "node:test";
import {
  INTERACTIVE_BROWSER_TOOL_NAMES,
  renderBrowserExpandedResult,
  type BrowserRendererTheme,
  type BrowserToolResult,
} from "../src/web/browser-renderer";

const theme: BrowserRendererTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

function renderLines(
  result: BrowserToolResult,
  width = 240,
  options: { expanded?: boolean; isPartial?: boolean } = {},
  context: unknown = { showImages: true },
): string[] {
  const component = renderBrowserExpandedResult(
    result,
    { expanded: options.expanded ?? true, isPartial: options.isPartial ?? false },
    theme,
    context,
  );
  return component.render(width);
}

function render(
  result: BrowserToolResult,
  options: { expanded?: boolean; isPartial?: boolean } = {},
  context: unknown = { showImages: true },
): string {
  return renderLines(result, 240, options, context).join("\n");
}

function testDisplayWidth(value: string): number {
  let width = 0;
  for (const codePoint of Array.from(value)) {
    const numericCodePoint = codePoint.codePointAt(0) ?? 0;
    width += numericCodePoint >= 0x2e80 && numericCodePoint <= 0xa4cf
      || numericCodePoint >= 0xac00 && numericCodePoint <= 0xd7a3
      || numericCodePoint >= 0x1f300 && numericCodePoint <= 0x1faff
      ? 2
      : 1;
  }
  return width;
}

test("the renderer inventory covers only interactive Browser tools", () => {
  assert.ok(INTERACTIVE_BROWSER_TOOL_NAMES.includes("BrowserSnapshot"));
  assert.ok(INTERACTIVE_BROWSER_TOOL_NAMES.includes("BrowserNetwork"));
  assert.ok(INTERACTIVE_BROWSER_TOOL_NAMES.includes("BrowserScreenshot"));
  const toolNames: readonly string[] = INTERACTIVE_BROWSER_TOOL_NAMES;
  assert.ok(!toolNames.includes("WebFetch"));
  assert.ok(!toolNames.includes("BrowserExtract"));
});

test("expanded browser snapshots retain semantic formatting and truncation caveats", () => {
  const output = render({
    content: [{ type: "text", text: "collapsed snapshot preview" }],
    details: {
      response: {
        session: "session_safe",
        tab: "tab_safe",
        generation: "generation_safe",
        url: "https://example.test/page",
        title: "Untrusted fixture",
        snapshot: '- heading "Results"\n  - link "Next" [ref=g_ref]\n    supporting text',
        refs: 1,
        truncation: { truncated: true, originalChars: 90, returnedChars: 74, maxChars: 74 },
      },
    },
  });

  assert.match(output, /^BrowserSnapshot$/m);
  assert.doesNotMatch(output, /ctrl\+o/, "family headers carry no hint; the shared wrapper owns it");
  assert.match(output, /Acquisition truncated: yes/);
  assert.match(output, /Returned characters: 74\/90 · 1 opaque ref\(s\)/);
  assert.match(output, /- heading "Results"/);
  assert.match(output, /  - link "Next" \[ref=g_ref\]/);
  assert.doesNotMatch(output, /collapsed snapshot preview/);
});

test("wrapped browser values honor narrow terminal columns and physical line boundaries", () => {
  const consoleLines = renderLines({
    content: [{ type: "text", text: "console summary" }],
    details: { response: {
      session: "session_safe", tab: "tab_safe", generation: "generation_safe",
      events: [{
        sequence: 1, elapsedMs: 1, kind: "console", level: "info",
        text: "界🙂\nsecond console line", textTruncated: false,
        source: { origin: "https://example.test", line: 1, column: 1 },
      }],
      cursor: { requested: 0, next: 1, latest: 1, oldestRetained: 1 },
      counts: { returned: 1, dropped: 0, totalDropped: 0, truncated: 0, captureTruncated: 0, totalCaptureTruncated: 0 },
      capacity: 16, brokerCapacityRefusals: 0,
    } },
  }, 7);
  const semanticLines = renderLines({
    content: [{ type: "text", text: "semantic summary" }],
    details: { response: {
      session: "session_safe", tab: "tab_safe", generation: "generation_safe", ref: "ref_safe",
      semantic: {
        role: "button", tag: "button", type: null,
        accessibleName: "界🙂\nbutton", accessibleDescription: "説明🙂", visible: true,
        states: { checked: null, disabled: false, expanded: false, selected: false, focused: false, editable: false },
        hrefOrigin: null,
        visibleText: { text: "界🙂\n表示", returnedChars: 4, truncated: false, suppressed: false },
      },
    } },
  }, 7);

  for (const line of [...consoleLines, ...semanticLines]) {
    assert.doesNotMatch(line, /[\r\n]/u);
    assert.ok(testDisplayWidth(line) <= 7, `line exceeds narrow width: ${JSON.stringify(line)}`);
  }
  assert.ok(consoleLines.some((line) => line.includes("界") || line.includes("🙂")));
  assert.ok(semanticLines.some((line) => line.includes("button")));
});

test("expanded console and network diagnostics show retained records without hidden transport data", () => {
  const consoleOutput = render({
    content: [{ type: "text", text: "counts only" }],
    details: {
      response: {
        session: "session_safe",
        tab: "tab_safe",
        generation: "generation_safe",
        events: [{
          sequence: 3,
          elapsedMs: 12,
          kind: "console",
          level: "warning",
          text: "page supplied warning",
          textTruncated: false,
          source: { origin: "https://cdn.example", line: 4, column: 2 },
          errorName: "Warning",
          authorization: "must-not-render",
          stack: "must-not-render",
        }],
        cursor: { requested: 0, next: 3, latest: 3, oldestRetained: 1 },
        counts: { returned: 1, dropped: 0, totalDropped: 0, truncated: 0, captureTruncated: 0, totalCaptureTruncated: 0 },
        capacity: 256,
        brokerCapacityRefusals: 0,
        untrusted: true,
      },
    },
  });
  assert.match(consoleOutput, /page supplied warning/);
  assert.match(consoleOutput, /https:\/\/cdn\.example:4:2/);
  assert.doesNotMatch(consoleOutput, /must-not-render/);

  const networkOutput = render({
    content: [{ type: "text", text: "network counts" }],
    details: {
      response: {
        session: "session_safe",
        tab: "tab_safe",
        generation: "generation_safe",
        events: [{
          sequence: 7,
          elapsedMs: 30,
          phase: "response",
          method: "GET",
          origin: "https://api.example",
          resourceKind: "document",
          status: 200,
          durationMs: 18,
          outcome: "succeeded",
          headers: "must-not-render",
          body: "must-not-render",
        }],
        cursor: { requested: 0, next: 7, latest: 7, oldestRetained: 1 },
        counts: { returned: 1, dropped: 0, totalDropped: 0, truncated: 0, captureTruncated: 0, totalCaptureTruncated: 0 },
        capacity: 256,
        brokerCapacityRefusals: 0,
        untrusted: true,
      },
    },
  });
  assert.match(networkOutput, /#7 · GET · https:\/\/api\.example · document/);
  assert.match(networkOutput, /Outcome: response/);
  assert.match(networkOutput, /Disposition: succeeded/);
  assert.match(networkOutput, /Status: 200/);
  assert.match(networkOutput, /Duration: 18ms/);
  assert.match(networkOutput, /Bodies, headers and request queries are not captured/);
  assert.doesNotMatch(networkOutput, /must-not-render/);
});

test("expanded semantic inspection keeps allowlisted fields and preserves suppressed values", () => {
  const output = render({
    content: [{ type: "text", text: "semantic summary" }],
    details: {
      response: {
        session: "session_safe",
        tab: "tab_safe",
        generation: "generation_safe",
        ref: "generation_safe_ref_safe",
        semantic: {
          role: "textbox",
          tag: "input",
          type: "password",
          accessibleName: "Password",
          accessibleDescription: "Credential field",
          states: { checked: null, disabled: false, expanded: null, selected: null, focused: true, editable: true },
          hrefOrigin: null,
          visibleText: { text: "secret-value", returnedChars: 12, truncated: false, suppressed: true },
          value: "secret-value",
          outerHTML: "<input value=secret-value>",
        },
        untrusted: true,
      },
    },
  });

  assert.match(output, /Accessible name: Password/);
  assert.match(output, /Visible: \[not returned\]/);
  assert.match(output, /Visible text: \[suppressed by browser privacy\/safety policy\]/);
  assert.doesNotMatch(output, /secret-value|outerHTML/);
});

test("expanded screenshots use native image content and never print encoded data", () => {
  const encoded = "c2Vuc2l0aXZlLWltYWdlLWJ5dGVz";
  const output = render({
    content: [
      { type: "text", text: "screenshot metadata" },
      { type: "image", data: encoded, mimeType: "image/png" },
    ],
    details: {
      response: {
        session: "session_safe",
        tab: "tab_safe",
        generation: "generation_safe",
        url: "https://example.test",
        title: "Untrusted page",
        mode: "viewport",
        mimeType: "image/png",
        width: 1280,
        height: 720,
        encodedBytes: 512,
        limits: { maxWidth: 2000, maxHeight: 2000, maxPixels: 4_000_000, maxEncodedBytes: 4_194_304, maxAllocationBytes: 33_554_432 },
      },
    },
  });

  assert.match(output, /native image block retained; encoded data is not printed/);
  assert.match(output, /1280×720/);
  assert.doesNotMatch(output, new RegExp(encoded));
});

test("expanded history, tabs, and interaction results retain bounded state without inventing effects", () => {
  const history = render({
    content: [{ type: "text", text: "history summary" }],
    details: { response: {
      session: "session_safe", tab: "tab_safe", generation: "generation_new", url: "https://example.test/new", title: "New",
      operation: "list", entries: [
        { index: 0, url: "https://example.test/start", generation: "generation_old", current: false },
        { index: 1, url: "https://example.test/new", generation: "generation_new", current: true },
      ], truncated: true, omittedEntries: 4, navigationsRemaining: null,
    } },
  });
  assert.match(history, /Requested operation: list/);
  assert.match(history, /Returned history:/);
  assert.match(history, /\* 1  https:\/\/example\.test\/new/);
  assert.match(history, /Current entry: 1/);
  assert.match(history, /Omitted entries: 4/);

  const tabs = render({
    content: [{ type: "text", text: "tabs summary" }],
    details: { response: {
      session: "session_safe", operation: "list", activeTab: "tab_two", tabs: [
        { tab: "tab_one", generation: "generation_one", url: "https://one.example", active: false },
        { tab: "tab_two", generation: "generation_two", url: "https://two.example", active: true },
      ], sessionClosed: false, tabsRemaining: 2, maxTabs: 4,
    } },
  });
  assert.match(tabs, /Tabs remaining: 2\/4/);
  assert.match(tabs, /\* tab_two · https:\/\/two\.example · generation generation_two/);

  const interaction = render({
    content: [{ type: "text", text: "interaction summary" }],
    details: { response: {
      session: "session_safe", tab: "tab_safe", generation: "generation_new", operation: "click", button: "left",
      consequence: "send", confirmed: true, approval: "human", effect: "completed",
      effects: { navigation: "not_observed", observedPopupTabs: 0, observedOverflowPopupsClosed: 0, observedDialogsDismissed: 0, download: "not_observed", network: "observed", accounting: "bounded_stable" },
      url: "https://example.test", privateInput: "must-not-render",
    } },
  });
  assert.match(interaction, /Consequence: send/);
  assert.match(interaction, /Approval: human/);
  assert.match(interaction, /Effect: completed/);
  assert.match(interaction, /No rollback is claimed for external effects/);
  assert.doesNotMatch(interaction, /privateInput|must-not-render/);
});

test("pending, failed, empty, and generic paths remain bounded and side-effect free", () => {
  const pending = render({ content: [], details: undefined }, { isPartial: true });
  assert.match(pending, /still running/);
  assert.match(pending, /No retained browser output yet/);

  const failed = render({ content: [{ type: "text", text: "BrowserClick failed: not_started; use a fresh snapshot." }], isError: true });
  assert.match(failed, /^BrowserClick$/m);
  assert.doesNotMatch(failed, /ctrl\+o/, "family headers carry no hint; the shared wrapper owns it");
  assert.match(failed, /Browser result failed/);
  assert.match(failed, /fresh snapshot/);
  const hostFailed = render(
    { content: [{ type: "text", text: "BrowserSnapshot failed: not_started; use a fresh snapshot." }], details: { response: { snapshot: "must-not-render" } } },
    {},
    { args: { session: "session_safe", tab: "tab_safe" }, isError: true },
  );
  assert.match(hostFailed, /^BrowserSnapshot$/m);
  assert.doesNotMatch(hostFailed, /must-not-render/);

  const empty = render({ content: [] });
  assert.match(empty, /no retained output|No retained browser output/);

  const long: BrowserToolResult = { content: [{ type: "text", text: Array.from({ length: 140 }, (_, index) => `line-${index}`).join("\n") }] };
  const expanded = render(long);
  assert.match(expanded, /^Browser$/m);
  assert.match(expanded, /line-0/);
  assert.match(expanded, /line-139/);
  assert.doesNotMatch(expanded, /renderer line\(s\) omitted|renderer line truncated/);
});
