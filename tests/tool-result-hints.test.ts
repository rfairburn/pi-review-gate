// Shared native expansion hints and host interaction contract (#93).
//
// Dedicated coverage for the shared hint mechanism in src/tool-result-hints.ts
// and its installation by expandableResult (src/tool-result-expansion.ts):
// native-style configured-key header hints, width-safe wrapped fallbacks,
// no competing
// toggle state or handlers, and the host's fullscreen per-card mouse path plus
// global keyboard semantics. The existing inventory in
// tests/tool-result-expansion.test.ts is owned by the parent reconciliation
// and is intentionally not edited here.
import assert from "node:assert/strict";
import test from "node:test";
import {
  expandableResult,
  type ToolResultRenderCallback,
} from "../src/tool-result-expansion";
import {
  EXPANSION_KEYBINDING_ID,
  expansionHint,
  setNativeExpansionHost,
  withExpansionHint,
  type NativeExpansionHost,
  type ToolResultViewComponent,
} from "../src/tool-result-hints";
import registerBackgroundShell, { reapAll } from "../src/background-shell";
import { shellResultDetails } from "../src/background-shell/result-view";

// ── Test doubles ─────────────────────────────────────────────────────────

const plainTheme = {
  bold: (value: string) => value,
  fg: (_color: string, value: string) => value,
};
// Marks theme styling so assertions can prove the native composition
// (muted parentheses around the host-styled key hint).
const markerTheme = {
  bold: (value: string) => value,
  fg: (color: string, value: string) => `[${color}]${value}[/${color}]`,
};

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
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

// Deterministic stand-in for the host's pi-tui visibleWidth: ANSI escapes are
// ignored and "中" counts two cells (wide glyph) so width math is provably
// cell-based, not character-based.
function fakeVisibleWidth(line: string): number {
  let cells = 0;
  for (const ch of stripAnsi(line)) cells += ch === "中" ? 2 : 1;
  return cells;
}

interface FakeHost extends NativeExpansionHost {
  calls: Array<[string, string]>;
}

function makeFakeHost(binding = "ctrl+o", bindingText?: string): FakeHost {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    // Mirrors the native keyHint shape: dim key text + muted description.
    keyHint: (id: string, description: string) => {
      calls.push([id, description]);
      return `\x1b[2m${binding}\x1b[0m\x1b[90m ${description}\x1b[0m`;
    },
    keyText: (id: string) => {
      calls.push([id, "text"]);
      return bindingText ?? binding;
    },
    visibleWidth: fakeVisibleWidth,
  };
}

interface ComponentHooks {
  renderCalls?: number[];
  invalidateCalls?: number[];
}

function linesComponent(lines: string[], hooks: ComponentHooks = {}): ToolResultViewComponent {
  return {
    render(width: number) {
      if (hooks.renderCalls) hooks.renderCalls.push(width);
      return lines.slice();
    },
    invalidate() {
      if (hooks.invalidateCalls) hooks.invalidateCalls.push(1);
    },
  };
}

function sampleResult(): Record<string, unknown> {
  return { content: [{ type: "text", text: "result summary" }], isError: false };
}

// ── Host interaction simulation (verified pi 0.85.1 contract) ────────────
//
// pi-tui dispatchMouseEvent(component, event): calls component.handleMouse?.(event);
// a falsy result — or one without handled/capture/focus — means unhandled.
// pi-tui MouseRegion.handleMouse: `childResult ?? this.onMouse(event)`.
// tool-execution.js createResultRegion: the region handler toggles ONLY that
// row's own expanded state on a left click and returns { handled: true }.
function dispatchLikeHost(component: unknown, event: Record<string, unknown>): unknown {
  const handle = (component as { handleMouse?: (e: unknown) => unknown } | null | undefined)
    ?.handleMouse;
  if (typeof handle !== "function") return undefined;
  const result = handle(event) as Record<string, unknown> | null | undefined;
  if (!result || typeof result !== "object") return undefined;
  if ("target" in result) return result;
  if (!result.handled && !result.capture && !result.focus) return undefined;
  return { ...result, handled: true };
}

function makeHostRegion(component: unknown, row: { expanded: boolean }) {
  return {
    handleMouse(event: { type: string; button: string }): unknown {
      const childResult = dispatchLikeHost(component, event);
      if (childResult !== undefined) return childResult;
      if (event.type !== "click" || event.button !== "left") return undefined;
      row.expanded = !row.expanded;
      return { handled: true };
    },
  };
}

// ── Hint composition ─────────────────────────────────────────────────────

test("the collapsed header carries exactly one native-style to-expand hint", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const inner = linesComponent([
      'ShellStart · job1 "demo" · running',
      "  command preview line",
    ]);
    const wrapped = withExpansionHint(inner, false, markerTheme.fg);
    const expectedKey = "\x1b[2mctrl+o\x1b[0m\x1b[90m to expand\x1b[0m";
    const expectedHint = `[muted]([/muted]${expectedKey}[muted])[\/muted]`;
    const lines = wrapped.render(200);
    assert.deepEqual(lines, [
      `ShellStart · job1 "demo" · running ${expectedHint}`,
      "  command preview line",
    ]);
    assert.equal(lines[1], "  command preview line");
    // Plain theme: the visible text is the approved inline lowercase form,
    // exactly once, on the header only.
    const plain = withExpansionHint(inner, false, plainTheme.fg).render(200);
    assert.equal(stripAnsi(plain[0]!), 'ShellStart · job1 "demo" · running (ctrl+o to expand)');
    assert.equal(countOccurrences(stripAnsi(plain.join("\n")), "(ctrl+o to expand)"), 1);
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("the expanded header carries exactly one to-collapse hint", () => {
  const host = makeFakeHost();
  setNativeExpansionHost(host);
  try {
    const inner = linesComponent(["ShellStart · job1 \"demo\" · running", "Command:", "echo demo"]);
    const wrapped = withExpansionHint(inner, true, plainTheme.fg);
    const lines = wrapped.render(200);
    assert.equal(stripAnsi(lines[0]!), "ShellStart · job1 \"demo\" · running (ctrl+o to collapse)");
    assert.equal(countOccurrences(stripAnsi(lines.join("\n")), "(ctrl+o to collapse)"), 1);
    // The hint is resolved through the host helper for app.tools.expand.
    assert.ok(host.calls.some(([id, description]) => id === EXPANSION_KEYBINDING_ID && description === "to collapse"));
    assert.equal(countOccurrences(stripAnsi(lines.join("\n")), "to expand"), 0);
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("the hint resolves the configured binding instead of a hard-coded default", () => {
  const host = makeFakeHost("alt+shift+x");
  setNativeExpansionHost(host);
  try {
    const wrapped = withExpansionHint(linesComponent(["Card A"]), false, plainTheme.fg);
    const visible = stripAnsi(wrapped.render(200).join("\n"));
    assert.match(visible, /\(alt\+shift\+x to expand\)/);
    assert.doesNotMatch(visible, /ctrl\+o/);
    assert.ok(host.calls.some(([id]) => id === EXPANSION_KEYBINDING_ID));
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("a too-wide header keeps full content and moves the hint to its own row", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    // Visible hint width with the plain theme: "(ctrl+o to expand)" = 18
    // cells, plus the separating space = 19.
    const header = "a".repeat(30);
    const inner = linesComponent([header, "body"]);
    const wrapped = withExpansionHint(inner, false, plainTheme.fg);
    // Fits exactly at 49 (30 + 19): inline hint present.
    assert.equal(stripAnsi(wrapped.render(49)[0]!), `${header} (ctrl+o to expand)`);
    // One cell short: the header stays byte-for-byte and the hint moves to
    // its own row — still visible, never omitted, never truncating family
    // content to make room.
    const narrow = wrapped.render(48).map(stripAnsi);
    assert.deepEqual(narrow, [header, "body", "(ctrl+o to expand)"]);
    assert.equal(countOccurrences(narrow.join("\n"), "(ctrl+o to expand)"), 1);
    // Every state stays hint-visible; the expanded hint likewise wraps.
    const collapse = withExpansionHint(inner, true, plainTheme.fg).render(48).map(stripAnsi);
    assert.deepEqual(collapse, [header, "body", "(ctrl+o to collapse)"]);
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("width math delegates to the host visibleWidth (cell-based, not char-based)", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    // 20 wide glyphs = 40 cells but only 20 characters. A character-counting
    // implementation would fit the hint at width 39 (20 + 19); the host's cell
    // math needs 59.
    const header = "中".repeat(20);
    const wrapped = withExpansionHint(linesComponent([header]), false, plainTheme.fg);
    assert.equal(stripAnsi(wrapped.render(59)[0]!), `${header} (ctrl+o to expand)`); // 40 + 19 fits
    // 59 cells needed at width 47: the inline hint moves to its own wrapped
    // row (18 cells <= 47) while the header stays whole.
    assert.deepEqual(wrapped.render(47).map(stripAnsi), [header, "(ctrl+o to expand)"]);
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("the wrapped hint fallback keeps family lines byte-for-byte and stays visible at very narrow widths", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const header = 'ShellStart · job1 "demo" · running';
    const body = "  command preview line";
    const wrapped = withExpansionHint(linesComponent([header, body]), false, plainTheme.fg);
    // Width 25: inline (34 + 19) does not fit; the hint wraps whole below.
    const rows = wrapped.render(25).map(stripAnsi);
    assert.deepEqual(rows.slice(0, 2), [header, body], "family lines untouched");
    assert.deepEqual(rows.slice(2), ["(ctrl+o to expand)"]);
    // Width 10: the binding and description wrap fully — the affordance
    // never disappears ("all views need a visible hint").
    const tiny = wrapped.render(10).map(stripAnsi);
    assert.deepEqual(tiny.slice(0, 2), [header, body]);
    assert.deepEqual(tiny.slice(2), ["(ctrl+o to", "expand)"]);
    assert.equal(countOccurrences(tiny.join("\n"), "ctrl+o"), 1);
    // Styled hints keep their styling across the row split: the key's dim
    // escape re-attaches to the piece carrying the key characters.
    const styled = withExpansionHint(linesComponent([header, body]), false, markerTheme.fg).render(10);
    assert.ok(styled.some((row) => row.includes("\x1b[2m") && stripAnsi(row).includes("ctrl")), "the styled key survives wrapping with its escape codes");
    assert.ok(stripAnsi(styled.join("")).includes("[muted]([/muted]ctrl+o"), "the styled hint stays fully visible and ordered");
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("every fallback hint row fits at degenerate widths and long bindings, in both states", () => {
  const inner = linesComponent(["x"]);
  for (const binding of ["ctrl+o", "alt+shift+x", "option+shift+down"]) {
    setNativeExpansionHost(makeFakeHost(binding));
    try {
      for (const expanded of [false, true]) {
        const wrapped = withExpansionHint(inner, expanded, plainTheme.fg);
        const description = expanded ? "to collapse" : "to expand";
        for (const width of [1, 5, 12]) {
          const rows = wrapped.render(width).map(stripAnsi);
          // The affordance never disappears: the whole binding stays visible
          // across the wrapped rows...
          const joined = rows.slice(1).join("");
          assert.ok(joined.startsWith(`(${binding}`), `width ${width}: hint visible and whole across rows`);
          assert.ok(joined.replace(/\s+/gu, "").includes(description.replace(/ /gu, "")) || joined.includes(description), `width ${width}: description fully present`);
          // ...and no row exceeds the width: oversized tokens are hard-wrapped.
          for (const row of rows) {
            assert.ok(fakeVisibleWidth(row) <= width, `width ${width}: row fits: ${JSON.stringify(row)}`);
          }
        }
      }
    } finally {
      setNativeExpansionHost(undefined);
    }
  }
});

test("oversized hint tokens are hard-wrapped through the host's own ANSI-aware wrapper", () => {
  const wrappedCalls: Array<[string, number]> = [];
  const host = makeFakeHost("option+shift+down");
  // Mirrors pi-tui's wrapTextWithAnsi contract: width-fitting rows, ANSI tracked.
  host.wrapTextWithAnsi = (text: string, width: number) => {
    wrappedCalls.push([text, width]);
    const pieces: string[] = [];
    let current = "";
    for (const ch of text) {
      if (fakeVisibleWidth(current + ch) > width) {
        pieces.push(current);
        current = ch;
      } else {
        current += ch;
      }
    }
    if (current.length > 0) pieces.push(current);
    return pieces;
  };
  setNativeExpansionHost(host);
  try {
    const wrapped = withExpansionHint(linesComponent(["x"]), false, plainTheme.fg);
    const rows = wrapped.render(5).map(stripAnsi);
    // The binding token ("(option+shift+down", 18 cells) went through the
    // host wrapper, and every emitted row fits.
    assert.ok(wrappedCalls.some(([text, width]) => text.includes("option+shift+down") && width === 5), "the host wrapper wrapped the oversized binding token");
    for (const row of rows) {
      assert.ok(fakeVisibleWidth(row) <= 5, `row fits: ${JSON.stringify(row)}`);
    }
    assert.ok(rows.join("").includes("(option+shift+down".replace(/\s/gu, "")) || rows.join("").startsWith("x(option"), "the full binding stays visible across the split");
  } finally {
    setNativeExpansionHost(undefined);
  }
});

// ── Shared wiring through expandableResult ───────────────────────────────

test("tools without an expanded renderer keep the exact legacy presentation", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const collapsed = expandableResult(
      (_result: unknown, _options: unknown, theme: { fg(color: string, text: string): string }) =>
        linesComponent([`collapsed:${theme.fg("muted", "summary")}`]),
    );
    const result = sampleResult();
    for (const options of [{ expanded: false, isPartial: false }, { expanded: true, isPartial: false }]) {
      const lines = (collapsed(result, options, plainTheme) as ToolResultViewComponent).render(200);
      assert.deepEqual(lines, ["collapsed:summary"]);
      assert.doesNotMatch(stripAnsi(lines.join("\n")), /ctrl\+o|to expand|to collapse/);
    }
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("short, long, error and partial cards all carry the hint exactly once", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const tool: ToolResultRenderCallback = expandableResult(
      (_result, options) => linesComponent([`header:${options.expanded ? "x" : "c"}`]),
      (_result, _options) => linesComponent(["detail header", ...Array.from({ length: 50 }, (_, i) => `detail line ${i + 1}`)]),
    );
    const result = sampleResult();

    // Short card (one body line), collapsed.
    const shortCollapsed = (tool(result, { expanded: false, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    assert.equal(stripAnsi(shortCollapsed[0]!), "header:c (ctrl+o to expand)");

    // Long card, expanded: exactly one hint across all 51 lines, on the header.
    const longExpanded = (tool(result, { expanded: true, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    assert.equal(longExpanded.length, 51);
    assert.equal(stripAnsi(longExpanded[0]!), "detail header (ctrl+o to collapse)");
    assert.equal(countOccurrences(stripAnsi(longExpanded.join("\n")), "(ctrl+o"), 1);

    // Error result, both states.
    const errorResult = { content: [{ type: "text", text: "failed" }], isError: true };
    const errorCollapsed = (tool(errorResult, { expanded: false, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    assert.equal(stripAnsi(errorCollapsed[0]!), "header:c (ctrl+o to expand)");
    const errorExpanded = (tool(errorResult, { expanded: true, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    assert.equal(stripAnsi(errorExpanded[0]!), "detail header (ctrl+o to collapse)");

    // Partial (streaming) card still advertises the native toggle.
    const partial = (tool(result, { expanded: false, isPartial: true }, plainTheme) as ToolResultViewComponent).render(200);
    assert.equal(stripAnsi(partial[0]!), "header:c (ctrl+o to expand)");
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("an empty component renders nothing and never crashes", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const wrapped = withExpansionHint(linesComponent([]), false, plainTheme.fg);
    assert.deepEqual(wrapped.render(200), []);
    // Escape-only first line: nothing visible to anchor the hint to.
    const escapeOnly = withExpansionHint(linesComponent(["\x1b[31m", "body"]), false, plainTheme.fg);
    assert.deepEqual(escapeOnly.render(200), ["\x1b[31m", "body"]);
  } finally {
    setNativeExpansionHost(undefined);
  }
});

// ── Host interaction: fullscreen mouse + keyboard stay native ────────────

test("fullscreen click toggles only the clicked card; a re-click contracts it", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const toolA = expandableResult(
      () => linesComponent(["Card A header", "collapsed body A"]),
      () => linesComponent(["Card A header", "full detail A"]),
    );
    const toolB = expandableResult(
      () => linesComponent(["Card B header", "collapsed body B"]),
      () => linesComponent(["Card B header", "full detail B"]),
    );
    const valueA = sampleResult();
    const valueB = { ...sampleResult(), content: [{ type: "text", text: "other" }] };
    const rowA = { expanded: false };
    const rowB = { expanded: false };

    const renderRow = (tool: ToolResultRenderCallback, value: unknown, row: { expanded: boolean }) =>
      tool(value, { expanded: row.expanded, isPartial: false }, plainTheme) as ToolResultViewComponent;
    // Click through the host's per-card region exactly like tool-execution.js.
    const clickRow = (tool: ToolResultRenderCallback, value: unknown, row: { expanded: boolean }) => {
      const component = renderRow(tool, value, row);
      const result = makeHostRegion(component, row).handleMouse({ type: "click", button: "left" });
      assert.deepEqual(result, { handled: true }, "the host region must own the click");
      return component;
    };

    // The wrapper registers no mouse handler of its own: the event falls
    // through to the host's per-card region (no competing state/handler).
    assert.equal(typeof renderRow(toolA, valueA, rowA).handleMouse, "undefined");

    const initialA = renderRow(toolA, valueA, rowA).render(200);
    assert.equal(stripAnsi(initialA[0]!), "Card A header (ctrl+o to expand)");

    // Click A: only A expands.
    clickRow(toolA, valueA, rowA);
    assert.equal(rowA.expanded, true);
    assert.equal(rowB.expanded, false, "clicking A must not change neighboring item B");
    const aExpanded = renderRow(toolA, valueA, rowA).render(200);
    assert.equal(stripAnsi(aExpanded[0]!), "Card A header (ctrl+o to collapse)");
    assert.deepEqual(aExpanded.map(stripAnsi), ["Card A header (ctrl+o to collapse)", "full detail A"]);
    const bStillCollapsed = renderRow(toolB, valueB, rowB).render(200);
    assert.equal(stripAnsi(bStillCollapsed[0]!), "Card B header (ctrl+o to expand)");

    // Re-click A: it contracts back to the identical collapsed presentation.
    clickRow(toolA, valueA, rowA);
    assert.equal(rowA.expanded, false);
    assert.deepEqual(renderRow(toolA, valueA, rowA).render(200), initialA);

    // Click B: only B toggles; A stays contracted.
    clickRow(toolB, valueB, rowB);
    assert.equal(rowB.expanded, true);
    assert.equal(stripAnsi(renderRow(toolB, valueB, rowB).render(200)[0]!), "Card B header (ctrl+o to collapse)");
    assert.deepEqual(renderRow(toolA, valueA, rowA).render(200), initialA);

    // Non-click mouse events never toggle.
    const noToggle = makeHostRegion(renderRow(toolA, valueA, rowA), rowA).handleMouse({ type: "move", button: "left" });
    assert.equal(noToggle, undefined);
    assert.equal(rowA.expanded, false);
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("a family-owned mouse handler is forwarded, not shadowed by the wrapper", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const seen: unknown[] = [];
    const inner: ToolResultViewComponent = {
      render: () => ["owned header"],
      invalidate() {},
      handleMouse: (event) => {
        seen.push(event);
        return { handled: true };
      },
    };
    const wrapped = withExpansionHint(inner, false, plainTheme.fg);
    let toggles = 0;
    const regionResult = makeHostRegion(wrapped, { expanded: false }).handleMouse({ type: "click", button: "left" });
    assert.deepEqual(regionResult, { handled: true }, "the inner's handled result is what the host sees");
    assert.equal(toggles, 0);
    assert.equal(seen.length, 1, "the inner component receives the event verbatim");
    // pi-tui dispatch semantics: a handled child suppresses the region handler.
    assert.deepEqual(dispatchLikeHost(wrapped, { type: "click", button: "left" }), { handled: true });
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("keyboard stays native: no competing handlers; the global toggle moves every row", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const tool = expandableResult(
      () => linesComponent(["Card header", "collapsed body"]),
      () => linesComponent(["Card header", "full detail"]),
    );
    const value = sampleResult();
    const row = { expanded: false };
    const component = tool(value, { expanded: row.expanded, isPartial: false }, plainTheme) as ToolResultViewComponent;

    // The wrapper registers no keyboard handler and (with a plain family
    // component) no mouse handler either: the host's global app.tools.expand
    // binding owns keyboard expansion, and regular mode — where the host does
    // not capture mouse input — remains keyboard-only by host design.
    assert.equal(typeof component.handleInput, "undefined");
    assert.equal(typeof component.handleMouse, "undefined");

    // The host's app.tools.expand flips EVERY row's expanded state together
    // (interactive-mode setToolsExpanded). Simulate the global toggle: the
    // renderers are pure functions of options.expanded with no per-row state
    // of their own, so both states flip in lockstep and back.
    const rowB = { expanded: false };
    for (const target of [true, false]) {
      row.expanded = target;
      rowB.expanded = target;
      const a = (tool(value, { expanded: row.expanded, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
      const b = (tool(value, { expanded: rowB.expanded, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
      const expected = target ? "(ctrl+o to collapse)" : "(ctrl+o to expand)";
      assert.equal(stripAnsi(a[0]!), `Card header ${expected}`);
      assert.equal(stripAnsi(b[0]!), `Card header ${expected}`);
    }
  } finally {
    setNativeExpansionHost(undefined);
  }
});

// ── Fidelity: no masking, no I/O, raw content unchanged ──────────────────

test("expansion adds no masking or truncation to model-visible content", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const secretShaped = "api_key=sk-live-SECRET-SHAPED-0123456789abcdef";
    const callArgs = { command: secretShaped };
    const formValue = 'value="hunter2@example.com"';
    const result = {
      content: [{ type: "text", text: `${secretShaped}\n${formValue}` }],
      isError: false,
      details: { submitted: [secretShaped, formValue] },
    };
    // A family expanded renderer that reuses the recorded call args/context
    // and echoes the model-visible text verbatim.
    let seenArgs: unknown;
    const tool = expandableResult(
      (_r, _o) => linesComponent(["summary header"]),
      (_r, _o, _t, context) => {
        seenArgs = (context as { args?: unknown } | undefined)?.args;
        const text = (result.content as Array<{ text: string }>)[0]!.text;
        return linesComponent(["full detail header", ...text.split("\n")]);
      },
    );
    const context = { args: callArgs };
    const expanded = (tool(result, { expanded: true, isPartial: false }, plainTheme, context) as ToolResultViewComponent).render(200);
    const visible = stripAnsi(expanded.join("\n"));
    assert.ok(visible.includes(secretShaped), "secret-shaped model-visible input must not be filtered again");
    assert.ok(visible.includes(formValue), "form values must survive rendering verbatim");
    // The wrapper only appends the header hint: every other line is the
    // family's own output, byte-for-byte.
    const [header, ...rest] = expanded;
    assert.ok(stripAnsi(header!).endsWith("(ctrl+o to collapse)"));
    assert.deepEqual(rest, ["api_key=sk-live-SECRET-SHAPED-0123456789abcdef", 'value="hunter2@example.com"']);
    // The native call context args are reused by reference, not duplicated or
    // rewritten.
    assert.equal(seenArgs, callArgs);
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("toggling performs no I/O and renders deterministically without mutating the result", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const hooks: ComponentHooks = { renderCalls: [] };
    const tool = expandableResult(
      () => linesComponent(["header", "body"], hooks),
      () => linesComponent(["header", "detail body"]),
    );
    const result = sampleResult();
    const before = JSON.stringify(result);
    const collapsed1 = (tool(result, { expanded: false, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    const expanded1 = (tool(result, { expanded: true, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    const collapsed2 = (tool(result, { expanded: false, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    assert.deepEqual(collapsed2, collapsed1, "re-collapse is deterministic");
    // Each render(width) invokes that family renderer exactly once (the two
    // collapsed renders; the expanded view is a different component); the
    // wrapper itself does no work beyond the width check (no timers, fs, or
    // network in this module).
    assert.deepEqual(hooks.renderCalls, [200, 200]);
    assert.equal(JSON.stringify(result), before, "the raw result is never mutated by a toggle");
    assert.notDeepEqual(expanded1, collapsed1);
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("invalidate is forwarded to the family component", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const hooks: ComponentHooks = { invalidateCalls: [] };
    const wrapped = withExpansionHint(linesComponent(["header"], hooks), false, plainTheme.fg);
    wrapped.invalidate?.();
    assert.deepEqual(hooks.invalidateCalls, [1]);
  } finally {
    setNativeExpansionHost(undefined);
  }
});

// ── Receiver-dependent themes (native Theme shape) ───────────────────────

test("theme.fg is invoked with its receiver preserved (native Theme shape)", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    // Mirrors the installed native Theme (pi 0.85.1): fg() reads
    // this.fgColors, so a standalone call without the receiver throws.
    class ReceiverTheme {
      private fgColors = new Map<string, string>([
        ["muted", "\x1b[90m"],
        ["error", "\x1b[31m"],
      ]);
      fg(color: string, text: string): string {
        const ansi = this.fgColors.get(color);
        if (!ansi) throw new Error(`Unknown theme color: ${color}`);
        return `${ansi}${text}\x1b[39m`;
      }
    }
    const theme = new ReceiverTheme();
    const tool = expandableResult(
      () => linesComponent(["Card header", "body"]),
      () => linesComponent(["detail header", "full detail"]),
    );
    const collapsed = (tool(sampleResult(), { expanded: false, isPartial: false }, theme) as ToolResultViewComponent).render(200);
    assert.equal(stripAnsi(collapsed[0]!), "Card header (ctrl+o to expand)");
    // The muted parens come from the real receiver-bound fg().
    assert.ok(collapsed[0]!.includes("\x1b[90m("), "open paren styled through theme.fg with receiver");
    const expanded = (tool(sampleResult(), { expanded: true, isPartial: false }, theme) as ToolResultViewComponent).render(200);
    assert.equal(stripAnsi(expanded[0]!), "detail header (ctrl+o to collapse)");
  } finally {
    setNativeExpansionHost(undefined);
  }
});

// ── Expanded-view failure stays visible, never silently complete ─────────

test("a throwing expanded renderer shows a visible failure notice over the summary", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const tool = expandableResult(
      (_result, _options) => linesComponent(["summary header", "raw content line"]),
      () => {
        throw new Error("detail renderer exploded");
      },
    );
    const collapsed = (tool(sampleResult(), { expanded: false, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    assert.deepEqual(collapsed.map(stripAnsi), ["summary header (ctrl+o to expand)", "raw content line"]);

    const failed = (tool(sampleResult(), { expanded: true, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200).map(stripAnsi);
    // The raw content stays available through the summary...
    assert.ok(failed.includes("raw content line"), "raw result content remains visible");
    // ...and the failure is explicitly indicated, not swallowed.
    assert.ok(failed.includes("detail view unavailable - showing summary"), "visible failure notice present");
    // The row is still host-expanded: the hint reflects the toggle direction.
    assert.equal(failed[0], "summary header (ctrl+o to collapse)");
    // Re-collapsing returns to the clean collapsed presentation.
    const recollapsed = (tool(sampleResult(), { expanded: false, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    assert.deepEqual(recollapsed.map(stripAnsi), ["summary header (ctrl+o to expand)", "raw content line"]);
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("a non-renderable expanded delegate also keeps the failure visible", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const tool = expandableResult(
      () => linesComponent(["summary header"]),
      () => ("not a component" as unknown),
    );
    const failed = (tool(sampleResult(), { expanded: true, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200).map(stripAnsi);
    assert.ok(failed.includes("detail view unavailable - showing summary"));
    assert.equal(failed[0], "summary header (ctrl+o to collapse)");
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("the failure notice is width-safe and never modifies family lines", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const tool = expandableResult(
      () => linesComponent(["summary header", "body line"]),
      () => {
        throw new Error("boom");
      },
    );
    // Full notice fits at 200...
    const wide = (tool(sampleResult(), { expanded: true, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200).map(stripAnsi);
    assert.ok(wide.includes("detail view unavailable - showing summary"));
    // ...at narrow width the shortened notice is used instead...
    const narrow = (tool(sampleResult(), { expanded: true, isPartial: false }, plainTheme) as ToolResultViewComponent).render(40).map(stripAnsi);
    assert.ok(narrow.includes("detail view unavailable"));
    assert.ok(!narrow.some((line) => line.includes("- showing summary")));
    // Family lines are untouched in both cases (the header hint fits at
    // both widths: 14 + 19 = 33 <= 40).
    assert.deepEqual(wide.slice(0, 2), ["summary header (ctrl+o to collapse)", "body line"]);
    assert.deepEqual(narrow.slice(0, 2), ["summary header (ctrl+o to collapse)", "body line"]);
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("narrow widths still show a visible failure indicator (throwing and invalid delegates)", () => {
  setNativeExpansionHost(makeFakeHost());
  try {
    const throwing = expandableResult(
      () => linesComponent(["x"]),
      () => {
        throw new Error("detail renderer exploded");
      },
    );
    const invalid = expandableResult(
      () => linesComponent(["x"]),
      () => ("not a component" as unknown),
    );
    // One-character summary; the header hint does not fit inline at any of
    // these widths ("x (ctrl+o to collapse)" = 22 cells), so it renders on
    // its own wrapped row(s). The failure indicator steps down: full(41) /
    // short(23) -> "detail failed"(13) -> "ERROR"(5) -> "!"(1), so a failed
    // detail view is never silent while any cell exists — and oversized hint
    // tokens are hard-wrapped so EVERY row fits, even at width 1.
    const expectations: Array<[number, string[]]> = [
      [20, ["x", "detail failed", "(ctrl+o to collapse)"]],
      [5, ["x", "ERROR", "(ctrl", "+o to", "colla", "pse)"]],
      [1, ["x", "!", "(", "c", "t", "r", "l", "+", "o", "t", "o", "c", "o", "l", "l", "a", "p", "s", "e", ")"]],
    ];
    for (const tool of [throwing, invalid]) {
      for (const [width, expected] of expectations) {
        const lines = (tool(sampleResult(), { expanded: true, isPartial: false }, plainTheme) as ToolResultViewComponent).render(width);
        assert.deepEqual(lines.map(stripAnsi), expected, `indicator visible and exact at width ${width}`);
        // Every row — family, failure indicator, and hard-wrapped hint — fits
        // the width: no over-wide row can trip a host width guard.
        for (const line of lines) {
          assert.ok(fakeVisibleWidth(line) <= width, `every row fits the width: ${JSON.stringify(line)} @ ${width}`);
        }
      }
    }
  } finally {
    setNativeExpansionHost(undefined);
  }
});

// ── Honest degradation: no hint rather than a wrong or partial one ───────

test("an unavailable host yields the inner component byte-for-byte", () => {
  setNativeExpansionHost(undefined); // outside Pi: peers are not resolvable
  const inner = linesComponent(["header", "body"]);
  assert.equal(withExpansionHint(inner, false, plainTheme.fg), inner);
  assert.equal(expansionHint(false, plainTheme.fg), undefined);
});

test("a failing or unresolved host yields no hint, never a partial one", () => {
  try {
    // keyHint throws (e.g. host theme not initialized): no hint, no crash.
    setNativeExpansionHost({
      keyHint: () => {
        throw new Error("Theme not initialized");
      },
      visibleWidth: fakeVisibleWidth,
    });
    assert.equal(expansionHint(false, plainTheme.fg), undefined);

    // Binding resolves to an empty chord (unconfigured): a keyless
    // "( to expand)" would mislead, so no hint at all.
    setNativeExpansionHost(makeFakeHost("ctrl+o", ""));
    assert.equal(expansionHint(false, plainTheme.fg), undefined);

    // keyText missing entirely but keyHint present: the hint is still honest
    // because it carries the host's own resolved key text.
    const { keyText: _unused, ...withoutKeyText } = makeFakeHost();
    setNativeExpansionHost(withoutKeyText);
    assert.match(stripAnsi(expansionHint(false) ?? ""), /ctrl\+o to expand/);
  } finally {
    setNativeExpansionHost(undefined);
  }
});

// ── Real registered-tool wiring (production path) ────────────────────────

test("real registered Shell* renderers carry the shared header hint through the production wiring", () => {
  const tools: Record<string, any> = {};
  registerBackgroundShell({
    registerTool: (tool: any) => {
      tools[tool.name] = tool;
    },
    on: () => {},
    sendMessage: () => {},
  });
  setNativeExpansionHost(makeFakeHost());
  try {
    const startValue = {
      content: [{ type: "text", text: 'Started "demo" as job1 (pid 42); currently running.' }],
      isError: false,
      details: shellResultDetails("ShellStart", {
        id: "job1",
        label: "demo",
        state: "running",
        command: "echo demo",
        pid: 42,
        watching: "exit",
        startedAt: Date.UTC(2026, 8, 10, 20, 21, 46),
      }),
    };

    // Short collapsed card: the shared hint lands on the header line.
    const collapsed = (tools.ShellStart.renderResult(startValue, { expanded: false, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    assert.equal(stripAnsi(collapsed[0]!), 'ShellStart · job1 "demo" · running (ctrl+o to expand)');
    assert.equal(countOccurrences(stripAnsi(collapsed.join("\n")), "(ctrl+o"), 1, "exactly one hint on the short card");

    // Expanded: the contributed detail header carries the to-collapse hint.
    const expanded = (tools.ShellStart.renderResult(startValue, { expanded: true, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    assert.equal(stripAnsi(expanded[0]!), 'ShellStart · job1 "demo" · running (ctrl+o to collapse)');
    assert.equal(countOccurrences(stripAnsi(expanded.join("\n")), "(ctrl+o"), 1, "exactly one hint on the expanded card");
    assert.match(stripAnsi(expanded.join("\n")), /Command:\necho demo/);
    assert.match(stripAnsi(expanded.join("\n")), /Started: 2026-09-10T20:21:46/);

    // Re-collapse restores the identical collapsed presentation.
    const recollapsed = (tools.ShellStart.renderResult(startValue, { expanded: false, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    assert.deepEqual(recollapsed, collapsed);

    // Error results carry the hint in both states through the real wiring.
    const errorValue = {
      content: [{ type: "text", text: 'no such job "nope"' }],
      isError: true,
      details: shellResultDetails("ShellLog"),
    };
    const errorCollapsed = (tools.ShellLog.renderResult(errorValue, { expanded: false, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    assert.match(stripAnsi(errorCollapsed[0]!), /\(ctrl\+o to expand\)$/);
    const errorExpanded = (tools.ShellLog.renderResult(errorValue, { expanded: true, isPartial: false }, plainTheme) as ToolResultViewComponent).render(200);
    assert.match(stripAnsi(errorExpanded[0]!), /ShellLog · error \(ctrl\+o to collapse\)$/);

    // The per-card host mouse path works through the production wiring too:
    // the wrapped component defines no competing handler, so the host region
    // owns the click and toggles only this card.
    const row = { expanded: false };
    const component = tools.ShellStart.renderResult(startValue, { expanded: row.expanded, isPartial: false }, plainTheme) as ToolResultViewComponent;
    assert.equal(typeof component.handleMouse, "undefined");
    makeHostRegion(component, row).handleMouse({ type: "click", button: "left" });
    assert.equal(row.expanded, true);
  } finally {
    setNativeExpansionHost(undefined);
    reapAll();
  }
});
