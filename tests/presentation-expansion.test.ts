// Direct regression tests for the shared presentation expansion core
// (#92 phase 1: the generic core in src/presentation-expansion.ts +
// src/presentation-hints.ts that tool-result and custom-message renderers
// both consume through backwards-compatible adapters).
//
// These tests exercise the core in its own, non-tool-specific shape: opaque
// result values, host-owned options objects in non-tool shapes
// ({ expanded, outputPad }), and a custom-message-style row. Tool-result
// compatibility itself is covered by the existing tests in
// tests/tool-result-expansion.test.ts, tests/tool-result-hints.test.ts, and
// tests/tool-result-hints-host.test.ts running through the adapter.
import assert from "node:assert/strict";
import test from "node:test";
import {
  PRESENTATION_EXPANSION_MARKER,
  expandablePresentation,
  isExpandablePresentation,
  isPresentationExpanded,
} from "../src/presentation-expansion";
import {
  EXPANDABLE_RESULT_MARKER,
  expandableResult,
  isExpandableResult,
  type ToolResultRenderOptions,
} from "../src/tool-result-expansion";
import {
  setNativeExpansionHost,
  type NativeExpansionHost,
} from "../src/presentation-hints";

const theme = {
  bold: (value: string) => value,
  fg: (_color: string, value: string) => value,
};

function textComponent(lines: string[]): unknown {
  return {
    render: (_width: number) => lines,
    invalidate() {},
  };
}

function renderLines(component: unknown, width = 200): string[] {
  assert.ok(component && typeof (component as { render?: unknown }).render === "function");
  return (component as { render(width: number): string[] }).render(width);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

// ── Renderer selection ───────────────────────────────────────────────────

test("selection: collapsed unless options.expanded is exactly true", () => {
  const rendered = expandablePresentation(
    () => textComponent(["collapsed"]),
    () => textComponent(["expanded"]),
  );
  assert.deepEqual(renderLines(rendered({}, {}, theme)), ["collapsed"]);
  assert.deepEqual(renderLines(rendered({}, undefined, theme)), ["collapsed"]);
  assert.deepEqual(renderLines(rendered({}, { expanded: false, outputPad: 2 }, theme)), ["collapsed"]);
  assert.deepEqual(renderLines(rendered({}, { expanded: "yes", outputPad: 2 }, theme)), ["collapsed"]);
  assert.deepEqual(renderLines(rendered({}, { expanded: 1, outputPad: 2 }, theme)), ["collapsed"]);
  assert.deepEqual(renderLines(rendered({}, { expanded: null, outputPad: 2 }, theme)), ["collapsed"]);
  assert.deepEqual(renderLines(rendered({}, { expanded: true, outputPad: 2 }, theme)), ["expanded"]);
});

test("selection helper reads only the host's expanded flag", () => {
  assert.equal(isPresentationExpanded(undefined), false);
  assert.equal(isPresentationExpanded(null), false);
  assert.equal(isPresentationExpanded({}), false);
  assert.equal(isPresentationExpanded({ outputPad: 4 }), false);
  assert.equal(isPresentationExpanded({ expanded: false }), false);
  assert.equal(isPresentationExpanded({ expanded: true }), true);
});

test("host-owned options and opaque result are forwarded unchanged to the selected delegate", () => {
  const message = { message: "custom-message-payload", padHint: new Date(0) };
  const seen: Array<{ result: unknown; options: unknown; theme: unknown; context: unknown }> = [];
  const rendered = expandablePresentation(
    (result, options, renderTheme, context) => {
      seen.push({ result, options, theme: renderTheme, context });
      return textComponent(["collapsed"]);
    },
    (result, options, renderTheme, context) => {
      seen.push({ result, options, theme: renderTheme, context });
      return textComponent(["expanded"]);
    },
  );
  const expandedOptions = { expanded: true, outputPad: 2 };
  const collapsedOptions = { expanded: false, outputPad: 2 };
  const context = { invalidate: () => {} };
  renderLines(rendered(message, expandedOptions, theme, context));
  assert.equal(seen.length, 1);
  // The same object references reach the expanded delegate: no recomposition.
  assert.equal(seen[0]!.result, message);
  assert.equal(seen[0]!.options, expandedOptions);
  assert.equal(seen[0]!.theme, theme);
  assert.equal(seen[0]!.context, context);
  // The collapsed arm forwards the host's object unchanged as well.
  renderLines(rendered(message, collapsedOptions, theme, context));
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.options, collapsedOptions);
  assert.equal(seen[1]!.result, message);
});

test("custom message renderers can read non-tool options fields through the core", () => {
  const rendered = expandablePresentation(
    (_result, options) => {
      const record = options as { expanded?: boolean; outputPad?: number };
      return textComponent([`collapsed pad=${String(record.outputPad)}`]);
    },
    (_result, options) => {
      const record = options as { expanded?: boolean; outputPad?: number };
      return textComponent([`expanded pad=${String(record.outputPad)}`]);
    },
  );
  assert.deepEqual(renderLines(rendered({}, { expanded: false, outputPad: 2 }, theme)), ["collapsed pad=2"]);
  assert.deepEqual(renderLines(rendered({}, { expanded: true, outputPad: 2 }, theme)), ["expanded pad=2"]);
});

// ── Options fallback when the host provides none ─────────────────────────

test("missing options fall back to a neutral generic shape by default", () => {
  const seen: unknown[] = [];
  const rendered = expandablePresentation(
    (_result, options) => {
      seen.push(options);
      return textComponent(["collapsed"]);
    },
    (_result, _options) => textComponent(["expanded"]),
  );
  renderLines(rendered({}, undefined, theme));
  assert.deepEqual(seen[0] as Record<string, unknown>, { expanded: false }, "the generic default fallback is a neutral { expanded: false }");
  // Built fresh per call, never a shared mutable object.
  renderLines(rendered({}, undefined, theme));
  assert.notEqual(seen[0], seen[1]);
});

test("a consumer supplies its own fallback options shape through config", () => {
  const seen: unknown[] = [];
  const rendered = expandablePresentation(
    (_result, options) => {
      seen.push(options);
      return textComponent(["collapsed"]);
    },
    undefined,
    { fallbackOptions: () => ({ expanded: false, outputPad: 0 }) },
  );
  renderLines(rendered({}, undefined, theme));
  assert.deepEqual(seen[0] as { outputPad?: number }, { expanded: false, outputPad: 0 });
});

// ── Failure notice ───────────────────────────────────────────────────────

test("throwing and non-renderable expanded delegates fall back with a visible notice", () => {
  const throwing = expandablePresentation(
    () => textComponent(["summary"]),
    () => { throw new Error("detail renderer failure"); },
  );
  assert.deepEqual(renderLines(throwing({}, { expanded: true }, theme)), [
    "summary",
    "detail view unavailable - showing summary",
  ]);
  const returningUndefined = expandablePresentation(
    () => textComponent(["summary"]),
    () => undefined,
  );
  assert.deepEqual(renderLines(returningUndefined({}, { expanded: true }, theme)), [
    "summary",
    "detail view unavailable - showing summary",
  ]);
  // Collapsed state never shows the notice.
  assert.deepEqual(renderLines(throwing({}, { expanded: false }, theme)), ["summary"]);
});

test("the failure notice stays width-safe down to a single-cell marker", () => {
  const rendered = expandablePresentation(
    () => textComponent(["summary"]),
    () => undefined,
  );
  assert.deepEqual(renderLines(rendered({}, { expanded: true }, theme), 50), [
    "summary",
    "detail view unavailable - showing summary",
  ]);
  assert.deepEqual(renderLines(rendered({}, { expanded: true }, theme), 30), [
    "summary",
    "detail view unavailable",
  ]);
  assert.deepEqual(renderLines(rendered({}, { expanded: true }, theme), 13), ["summary", "detail failed"]);
  assert.deepEqual(renderLines(rendered({}, { expanded: true }, theme), 5), ["summary", "ERROR"]);
  assert.deepEqual(renderLines(rendered({}, { expanded: true }, theme), 1), ["summary", "!"]);
});

// ── Native hints through the generic core ────────────────────────────────

function makeFakeHost(binding = "ctrl+o"): { host: NativeExpansionHost; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    host: {
      keyHint: (id: string, description: string) => {
        calls.push([id, description]);
        return `\x1b[2m${binding}\x1b[0m\x1b[90m ${description}\x1b[0m`;
      },
      keyText: (id: string) => {
        calls.push([id, "text"]);
        return binding;
      },
      visibleWidth: (line: string) => stripAnsi(line).length,
    },
  };
}

test("rows with a contributed expanded renderer carry the shared host hint through the core", () => {
  const fake = makeFakeHost();
  setNativeExpansionHost(fake.host);
  try {
    const withDetail = expandablePresentation(
      () => textComponent(["header"]),
      () => textComponent(["header", "detail body"]),
    );
    const collapsed = renderLines(withDetail({}, { expanded: false }, theme));
    assert.equal(fake.calls.length > 0, true, "the hint resolved through the injected host");
    assert.deepEqual(
      fake.calls.map((pair) => pair[1]).filter((description) => description === "to expand").length > 0,
      true,
    );
    assert.match(stripAnsi(collapsed[0]!), /^header \(ctrl\+o to expand\)$/);
    const expanded = renderLines(withDetail({}, { expanded: true }, theme));
    assert.match(stripAnsi(expanded[0]!), /to collapse/, "the expanded state hints how to collapse");
    assert.deepEqual(expanded.slice(1), ["detail body"]);
    // Without a contributed expanded renderer there is no hint and no change.
    const withoutDetail = expandablePresentation(() => textComponent(["header"]));
    assert.deepEqual(
      renderLines(withoutDetail({}, { expanded: true }, theme)).map(stripAnsi),
      ["header"],
    );
  } finally {
    setNativeExpansionHost(undefined);
  }
});

test("an unavailable host degrades the core's hint wrapping byte-for-byte", () => {
  // Clear the host seam: outside a Pi host the peers do not resolve, so the
  // wrapper must not guess a key and must return the inner component itself.
  setNativeExpansionHost(undefined);
  const inner = textComponent(["header"]);
  const rendered = expandablePresentation(() => inner, () => inner);
  assert.equal(rendered({}, { expanded: true }, theme), inner);
});

test("forwarded handlers of the inner component reach the wrapped surface", () => {
  const fake = makeFakeHost();
  setNativeExpansionHost(fake.host);
  try {
    const mouseEvents: unknown[] = [];
    const keyEvents: string[] = [];
    const inner = {
      render: () => ["header"],
      invalidate() {},
      handleMouse(event: unknown) {
        mouseEvents.push(event);
        return { handled: true };
      },
      handleInput(data: string) {
        keyEvents.push(data);
      },
      wantsKeyRelease: true,
    };
    const rendered = expandablePresentation(() => inner, () => inner);
    // With a resolvable host the contributed expanded view is hint-wrapped, so
    // the component under test is genuinely the wrapper, not the inner itself.
    const component = rendered({}, { expanded: true }, theme) as unknown as typeof inner;
    assert.notEqual(component, inner, "the host hint wrapper must actually wrap the inner component");
    assert.match(stripAnsi((component as { render(width: number): string[] }).render(200)[0]!), /ctrl\+o to collapse/);
    const click = { kind: "click" };
    assert.deepEqual(component.handleMouse?.(click), { handled: true });
    assert.equal(mouseEvents[0], click, "the host's per-card mouse region receives the component's handler");
    component.handleInput?.("x");
    assert.deepEqual(keyEvents, ["x"], "input handlers are forwarded verbatim");
    assert.equal(component.wantsKeyRelease, true);
    // No handlers defined: none are invented (also under a resolvable host).
    const plain = expandablePresentation(() => textComponent(["h"]), () => textComponent(["h"]));
    const plainComponent = plain({}, { expanded: true }, theme) as { handleMouse?: unknown; handleInput?: unknown };
    assert.equal(plainComponent.handleMouse, undefined);
    assert.equal(plainComponent.handleInput, undefined);
  } finally {
    setNativeExpansionHost(undefined);
  }
});

// ── Wiring-audit markers ─────────────────────────────────────────────────

test("core callbacks carry the generic marker; adapters also keep the tool marker", () => {
  const coreOnly = expandablePresentation(() => textComponent([]));
  assert.equal(isExpandablePresentation(coreOnly), true);
  assert.equal(
    (coreOnly as unknown as Record<string, unknown>)[PRESENTATION_EXPANSION_MARKER],
    true,
  );
  assert.equal(isExpandableResult(coreOnly), false, "the generic marker alone does not claim tool wiring");
  const adapted = expandableResult(() => textComponent([]));
  assert.equal(isExpandablePresentation(adapted), true, "tool rows run on the generic core");
  assert.equal(isExpandableResult(adapted), true, "tool audit markers stay true on adapter callbacks");
  assert.equal((adapted as unknown as Record<string, unknown>)[EXPANDABLE_RESULT_MARKER], true);
  assert.equal(isExpandablePresentation(() => undefined), false);
});

// ── Tool adapter contract over the shared core ───────────────────────────

test("the tool adapter preserves the native tool fallback options shape", () => {
  const seen: unknown[] = [];
  const rendered = expandableResult((_result, options) => {
    seen.push(options);
    return textComponent([]);
  });
  // Host options present: forwarded unchanged, including isPartial.
  const options: ToolResultRenderOptions = { expanded: true, isPartial: true };
  rendered({}, options, theme);
  assert.equal(seen[0], options);
  // Host options absent: exactly the pre-extraction tool fallback shape.
  rendered({}, undefined, theme);
  assert.deepEqual(seen[1] as Record<string, unknown>, { expanded: false, isPartial: false });
});