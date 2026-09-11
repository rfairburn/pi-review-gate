import assert from "node:assert/strict";
import test from "node:test";
import {
  renderExpandedWebResult,
  renderWebResult,
  visibleDisplayWidth,
  type WebResultRenderOptions,
} from "../src/web/result-renderer";
import { visibleTerminalText } from "../src/tool-result-text";

const THEME = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

function rendered(
  callback: typeof renderWebResult,
  value: unknown,
  options: WebResultRenderOptions = { expanded: true, isPartial: false },
  width = 400,
): string[] {
  return callback(value, options, THEME).render(width);
}

function webResult(response: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: [{ type: "text", text: "WebFetch summary remains compact." }],
    details: { response },
    isError: false,
    ...extra,
  };
}

function assertLinesFit(lines: string[], width: number): void {
  for (const [index, line] of lines.entries()) {
    assert.ok(
      visibleDisplayWidth(line) <= width,
      `line ${index} exceeds width ${width}: ${JSON.stringify(line)}`,
    );
  }
}

function retainedContentBounds(output: string): { start: number; end: number } {
  const lines = output.split("\n");
  let start = -1;
  let end = -1;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("UNTRUSTED RETAINED CONTENT") || line.startsWith("UNTRUSTE")) start = index;
    if (start >= 0 && index > start && line.startsWith("End of ")) {
      end = index;
      break;
    }
  }
  assert.ok(start >= 0 && end > start, "retained content markers should be rendered");
  return { start, end };
}

function retainedContentRegion(output: string): string {
  const lines = output.split("\n");
  const { start, end } = retainedContentBounds(output);
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

function assertNoRawControlBytes(lines: string[]): void {
  for (const line of lines) {
    for (const ch of line) {
      const code = ch.codePointAt(0) ?? 0;
      assert.ok(
        code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f),
        `no raw control byte may be rendered: ${JSON.stringify(line)}`,
      );
    }
  }
}

test("web result compact rendering keeps a concise retained-response summary", () => {
  const value = webResult({
    content: "This retained content must not appear in the compact result renderer.",
    finalUrl: "https://example.test/article",
    title: "Example article",
    documentType: "html",
  });
  const lines = rendered(renderWebResult, value, { expanded: false, isPartial: false });

  assert.match(lines.join("\n"), /WebFetch · Example article · HTML/);
  assert.match(lines.join("\n"), /https:\/\/example\.test\/article/);
  assert.doesNotMatch(lines.join("\n"), /This retained content/);
});

test("collapsed rendering preserves native multiline WebFetch output and error diagnostics", () => {
  const nativeFormatPage = [
    "Web page: Retained article",
    "Source: https://example.test/article",
    "Fetched: 2026-08-23T00:00:00.000Z · session cache.",
    "Showing index 0-1 of 4.",
    "Content:",
    "# Retained heading",
    "",
    "  indented line",
    "End of cached document.",
  ].join("\n");
  const value = {
    content: [{ type: "text", text: nativeFormatPage }],
    details: { response: { rawPath: "/private/raw" } },
    isError: false,
  };
  const lines = rendered(renderWebResult, value, { expanded: false, isPartial: false }, 120);
  assert.equal(lines.join("\n"), nativeFormatPage);
  assert.ok(lines.length > 1, "legacy returned output remains multiline");
  assert.doesNotMatch(lines.join("\n"), /rawPath|private\/raw/);

  const errorText = [
    "WebFetch failed: the validated public request was refused.",
    "Use BrowserExtract only when rendered delivery is plausibly required.",
    "No retry was started by the renderer.",
  ].join("\n");
  const errorLines = rendered(renderWebResult, {
    content: [{ type: "text", text: errorText }],
    details: { error: "private transport detail" },
    isError: true,
  }, { expanded: false, isPartial: false }, 120);
  assert.equal(errorLines.join("\n"), errorText);
});

test("collapsed rendering stays concise while expansion retains long acquisitions", () => {
  // The production formatPage text includes the full retained content block,
  // so a large acquisition must not occupy thousands of collapsed lines.
  const longText = [
    "Web page: Retained article",
    "Source: https://example.test/article",
    "Content:",
    ...Array.from({ length: 120 }, (_, index) => `retained line ${index + 1}`),
    "End of cached document.",
  ].join("\n");
  const lines = rendered(renderWebResult, {
    content: [{ type: "text", text: longText }],
    details: { response: { content: longText } },
    isError: false,
  }, { expanded: false, isPartial: false }, 120);

  // Structured metadata is concise and does not expose the retained body while collapsed.
  assert.ok(lines.length <= 24, `collapsed summary must stay bounded, got ${lines.length} lines`);
  const output = lines.join("\n");
  assert.match(output, /^WebFetch · result/);
  assert.doesNotMatch(output, /retained line 1|retained line 100|End of cached document/);
  assertLinesFit(lines, 120);

  // The same view re-renders identically on re-collapse (no state, no re-fetch).
  assert.deepEqual(rendered(renderWebResult, {
    content: [{ type: "text", text: longText }],
    details: { response: { content: longText } },
    isError: false,
  }, { expanded: false, isPartial: false }, 120), lines);
});

test("expanded WebFetch rendering shows retained text, extraction metadata, range, and continuation", () => {
  const content = "# Retained heading\n\n  indented line\n\t tabbed line\n\n- item";
  const value = webResult({
    content,
    finalUrl: "https://example.test/article",
    requestedUrl: "https://example.test/article?source=prompt",
    fetchedAt: "2026-08-23T00:00:00.000Z",
    contentType: "text/html; charset=utf-8",
    downloadedBytes: 321,
    cacheHit: true,
    title: "Retained article",
    byline: "Author",
    siteName: "Example",
    excerpt: "A bounded extraction excerpt.",
    documentType: "html",
    dynamicContentSuspected: true,
    dynamicContentReasons: ["framework shell detected with limited rendered content"],
    startIndex: 2,
    endIndex: 4,
    nextIndex: 5,
    totalBlocks: 12,
    startPage: 3,
    endPage: 4,
    projectedColumns: ["City", "Population"],
    // These fields are deliberately not part of the allowlist and must not be
    // surfaced merely because they arrived in a synthetic result.
    rawPath: "/private/source.html",
    indexPath: "/private/index.json",
    privateTransport: { socket: "secret" },
  });

  const output = rendered(renderExpandedWebResult, value).join("\n");
  assert.match(output, /Document: HTML/);
  assert.match(output, /Final URL: https:\/\/example\.test\/article/);
  assert.match(output, /Acquisition: 2026-08-23T00:00:00\.000Z · session cache · 321 downloaded bytes/);
  assert.match(output, /Extraction: HTML structural blocks · dynamic_content_suspected: true/);
  assert.match(output, /Byline: Author/);
  assert.match(output, /Site: Example/);
  assert.match(output, /Range: indexes 2-4 of 11 · pages 3-4/);
  assert.match(output, /Continuation: retained blocks continue at index 5; no network request is made by this view/);
  assert.match(output, /Projected columns: City \| Population/);
  assert.match(output, /--- Retained indexed content ---/);
  assert.ok(output.includes("# Retained heading\n\n  indented line\n     tabbed line\n\n- item"), "retained logical formatting must remain visible");
  assert.doesNotMatch(output, /rawPath|indexPath|privateTransport|private\/source|socket.*secret/);
});

test("expanded WebFetch PDF rendering shows page and retained metadata without raw transport fields", () => {
  const value = webResult({
    content: "PDF heading\n\npage text",
    finalUrl: "https://example.test/report.pdf",
    documentType: "pdf",
    contentType: "application/pdf",
    pageCount: 7,
    startIndex: 0,
    endIndex: 2,
    totalBlocks: 5,
    startPage: 2,
    endPage: 3,
    scannedOrImageOnlySuspected: false,
    pdfMetadata: {
      author: "Example author",
      subject: "Bounded report",
      creationDate: "2026-08-22",
    },
    rawBytes: "private bytes",
    decoderState: { secret: true },
  });

  const output = rendered(renderExpandedWebResult, value).join("\n");
  assert.match(output, /Document: PDF/);
  assert.match(output, /Content type: application\/pdf/);
  assert.match(output, /PDF pages: 7/);
  assert.match(output, /Range: indexes 0-2 of 4 · pages 2-3/);
  assert.match(output, /Scanned\/image-only suspected: false/);
  assert.match(output, /PDF metadata:/);
  assert.match(output, /Author: Example author/);
  assert.ok(output.includes("PDF heading\n\npage text"));
  assert.doesNotMatch(output, /rawBytes|decoderState|private bytes|secret/);
});

test("expanded WebFetch find rendering shows retained match indexes without performing another read", () => {
  const value = webResult({
    content: "",
    finalUrl: "https://example.test/article",
    documentType: "html",
    startIndex: 4,
    endIndex: 4,
    totalBlocks: 9,
    find: {
      query: "needle",
      searchedFromIndex: 4,
      totalMatches: 2,
      matches: [
        { index: 5, kind: "text", snippet: "...needle..." },
        { index: 7, kind: "table", tableLabel: "Results", pageNumber: 2, snippet: "needle in a row" },
      ],
      matchesTruncated: false,
    },
  });

  const output = rendered(renderExpandedWebResult, value).join("\n");
  assert.match(output, /Find: "needle" from index 4 · 2 matching block\(s\)/);
  assert.match(output, /match index 5 · text: \.\.\.needle\.\.\./);
  assert.match(output, /match index 7 · table · page 2 · Results: needle in a row/);
  assert.match(output, /Continuation: use one of the reported retained match indexes/);
  assert.match(output, /No readable content was returned for this indexed range/);
});

test("expanded BrowserExtract rendering exposes retained omissions and extraction truncation without browser actions", () => {
  const value = webResult({
    content: "Rendered result\n\nvalue: 42",
    finalUrl: "https://example.test/app",
    fetchedAt: "2026-08-23T00:00:01.000Z",
    contentType: "text/html",
    downloadedBytes: 88,
    cacheHit: false,
    title: "Rendered application",
    documentType: "html",
    startIndex: 0,
    endIndex: 0,
    totalBlocks: 3,
    browserOmissions: {
      count: 3,
      truncated: true,
      entries: [
        "passive resource omitted before any connection: image https://cdn.example.test/a.png",
        "connect destination refused: unresolved.example.test",
      ],
    },
    tables: [{
      id: "table-1",
      label: "Results",
      index: 1,
      endIndex: 2,
      rows: 2,
      columns: 2,
      headers: ["Name", "Value"],
      truncated: true,
      truncationNotes: ["generated table Markdown capped at 512000 characters; 4 rows omitted"],
    }],
    pagination: [{ label: "Next", relation: "next", url: "https://example.test/app?page=2" }],
  });

  const output = rendered(renderExpandedWebResult, value).join("\n");
  assert.match(output, /Resource omissions: 3/);
  assert.match(output, /Resource omission diagnostics: the retained diagnostic list is truncated/);
  assert.match(output, /passive resource omitted before any connection/);
  assert.match(output, /--- Extracted tables \(1\) ---/);
  assert.match(output, /Truncation: generated table Markdown capped at 512000 characters; 4 rows omitted/);
  assert.match(output, /Pagination: 1 possible link\(s\) retained; none were fetched by this view/);
  assert.doesNotMatch(output, /BrowserOpen|BrowserNavigate|click|scroll|refetch/i);
});

test("expanded rendering handles pending, partial, empty, failed, and cancelled native results", () => {
  const pending = rendered(renderExpandedWebResult, undefined, { expanded: true, isPartial: true });
  assert.match(pending.join("\n"), /Web result pending/);
  assert.match(pending.join("\n"), /Status: partial result/);
  assert.match(pending.join("\n"), /No retained response details are available yet/);

  const partial = rendered(
    renderExpandedWebResult,
    webResult({ content: "partial\ntext", finalUrl: "https://example.test/live", documentType: "text" }),
    { expanded: true, isPartial: true },
  ).join("\n");
  assert.match(partial, /Status: partial result/);
  assert.match(partial, /partial\ntext/);

  const empty = rendered(renderExpandedWebResult, webResult({ content: "", documentType: "html" })).join("\n");
  assert.match(empty, /No readable content was returned for this indexed range/);

  const failed = rendered(renderExpandedWebResult, {
    content: [{ type: "text", text: "WebFetch failed: bounded diagnostic" }],
    details: { error: "raw private error", response: undefined },
    isError: true,
  }).join("\n");
  assert.match(failed, /WebFetch failed: bounded diagnostic/);
  assert.match(failed, /No retained response details are available for this failed result/);
  assert.doesNotMatch(failed, /raw private error/);

  const diagnosticText = [
    "WebFetch failed: first diagnostic is deliberately longer than the pane.",
    "Second diagnostic survives expansion.",
    "Third diagnostic remains visible.",
  ].join("\n");
  const diagnosticLines = rendered(renderExpandedWebResult, {
    content: [{ type: "text", text: diagnosticText }],
    details: { error: "private transport detail" },
    isError: true,
  }, { expanded: true, isPartial: false }, 12);
  assertLinesFit(diagnosticLines, 12);
  assert.ok(
    diagnosticLines.join("\n").replace(/\n/g, "").includes(diagnosticText.replace(/\n/g, "")),
    "expanded errors retain all returned diagnostics after wrapping",
  );

  const cancelled = rendered(renderExpandedWebResult, {
    content: [{ type: "text", text: "BrowserExtract cancelled before dispatch." }],
    details: { error: "private abort reason" },
    isError: true,
  }).join("\n");
  assert.match(cancelled, /Status: cancelled; this view performs no further acquisition/);
  assert.doesNotMatch(cancelled, /private abort reason/);
});

test("expanded rendering wraps long retained lines without a renderer truncation", () => {
  const longContent = `${"x".repeat(100_010)}\ntrailing data must not be fetched or displayed`;
  const lines = rendered(
    renderExpandedWebResult,
    webResult({ content: longContent, finalUrl: "https://example.test/long", documentType: "text" }),
    { expanded: true, isPartial: false },
    120,
  );
  const output = lines.join("\n");

  assertLinesFit(lines, 120);
  const contentRegion = retainedContentRegion(output).replace(/\n/g, "");
  assert.ok(contentRegion.includes("x".repeat(100_010)), "the complete retained content is preserved");
  assert.match(contentRegion, /trailing data must not be fetched or displayed/);
  assert.doesNotMatch(output, /retained content exceeded the bounded human-view display/);
});

test("expanded rendering respects narrow widths, wide Unicode, tabs, and wrapped metadata", () => {
  assert.equal(visibleDisplayWidth("界"), 2);
  assert.equal(visibleDisplayWidth("🙂"), 2);
  assert.equal(visibleDisplayWidth("e\u0301"), 1);
  assert.equal(visibleDisplayWidth("\t"), 4);

  const title = `Title-${"m".repeat(80)}`;
  const content = `界🙂\talpha ${"z".repeat(120)}\n\n  final line`;
  const lines = rendered(
    renderExpandedWebResult,
    webResult({ content, title, finalUrl: "https://example.test/narrow", documentType: "text" }),
    { expanded: true, isPartial: false },
    9,
  );
  const output = lines.join("\n");

  assertLinesFit(lines, 9);
  const { start: contentStart } = retainedContentBounds(output);
  const metadataRegion = lines.slice(0, contentStart).join("\n");
  assert.ok(metadataRegion.replace(/\n/g, "").includes(title), "long metadata is wrapped, not silently clipped");
  const contentRegion = retainedContentRegion(output);
  assert.doesNotMatch(contentRegion, /\t/, "tabs are expanded before terminal wrapping");
  assert.ok(contentRegion.includes("界🙂"), "wide Unicode content remains visible");
  assert.ok(contentRegion.replace(/\n/g, "").includes("z".repeat(120)), "wrapped content remains available");
  assert.ok(contentRegion.replace(/\n/g, "").includes("final line"), "blank lines and later content remain available");
});

test("expanded retained content shows control bytes as visible notation exactly once (no stripping, no double encoding)", () => {
  const controls = "\u001b[31mred\u001b[0m\u0007\rmid\u0000dle\u007f\u009b\u000bend";
  const literal = "typed\\r and typed\\u001b[31m and a lone \\ backslash";
  const secret = "token hunter2 password=correct horse battery staple";
  const content = [
    `ANSI and control bytes: ${controls}`,
    "",
    `literal backslash text: ${literal}`,
    secret,
    "plain final line",
  ].join("\n");
  const value = webResult({ content, finalUrl: "https://example.test/controls", documentType: "text" });

  const lines = rendered(renderExpandedWebResult, value);
  const output = lines.join("\n");
  const contentRegion = retainedContentRegion(output);
  const encoded = visibleTerminalText(content);

  // The complete model-visible content survives and decodes back exactly:
  // controls are visible notation, not executed, deleted, or double-encoded.
  assert.equal(decodeVisibleTerminal(contentRegion), content, "human view decodes back to the exact returned content");
  assert.ok(contentRegion.includes(encoded), "retained content is the shared visible encoding applied once");
  assert.match(contentRegion, /\\u001b\[31mred\\u001b\[0m\\u0007\\rmid\\u0000dle\\u007f\\u009b\\u000bend/);
  // Literal escape-shaped text stays distinguishable from encoded controls.
  assert.match(contentRegion, /typed\\\\r and typed\\\\u001b\[31m and a lone \\\\ backslash/);
  // Secret-shaped model-visible text is not masked.
  assert.match(output, /hunter2/);
  assert.match(output, /correct horse battery staple/);
  // Multiline structure is preserved; no executable control byte is rendered.
  assert.ok(contentRegion.includes("\n"), "multiline formatting is preserved");
  assertNoRawControlBytes(lines);
  // Applied exactly once: encoded notation is never re-escaped, body shown once.
  assert.doesNotMatch(contentRegion, /\\\\u001b\[31mred/);
  assert.equal(contentRegion.split("\\u001b[31mred").length - 1, 1, "content is rendered exactly once");
});

test("collapsed legacy output encodes control bytes visibly and keeps secret-shaped text", () => {
  const text = [
    "Web page: Legacy retained result",
    "\u001b[31mstyled\u001b[0m\rvalue\u0000tail\u007f",
    "password hunter2",
  ].join("\n");
  const value = {
    content: [{ type: "text", text }],
    details: { response: { rawPath: "/private/raw" } },
    isError: false,
  };
  const lines = rendered(renderWebResult, value, { expanded: false, isPartial: false }, 200);
  assert.equal(decodeVisibleTerminal(lines.join("\n")), text, "collapsed legacy output round-trips through the visible encoding");
  assert.match(lines.join("\n"), /hunter2/, "secret-shaped text stays visible");
  assertNoRawControlBytes(lines);

  // Expanded no-response fallback (returned tool output) behaves identically.
  const expanded = rendered(renderExpandedWebResult, value).join("\n");
  assert.match(expanded, /\\u001b\[31mstyled\\u001b\[0m\\rvalue\\u0000tail\\u007f/);
  assert.match(expanded, /hunter2/);
});
