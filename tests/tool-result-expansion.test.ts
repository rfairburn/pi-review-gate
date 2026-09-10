// Shared native tool-result expansion foundation (#57).
//
// These tests exercise the actual shared mechanism in src/tool-result-expansion.ts
// and the real registered tool renderer wiring (Subtasks*, ApplyPatch, and the
// interactive Browser* family wrapped, rendererless tools keeping Pi's native
// fallback). They do not replicate any rendering algorithm: outputs come from
// the real renderers.
// Subtasks* and Browser* contribute expanded callbacks; ApplyPatch retains its
// existing presentation in both expansion states.
import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPANDABLE_RESULT_MARKER,
  expandableResult,
  isExpandableResult,
  type ToolResultRenderOptions,
} from "../src/tool-result-expansion";
import { ExecutionToolManager, EXECUTION_TOOL_NAMES } from "../src/execution/tool";
import { APPLY_PATCH_TOOL_NAME, registerApplyPatchTool } from "../src/apply-patch/tool";
import registerBackgroundShell from "../src/background-shell";
import { WebToolManager } from "../src/web/tools";
import { INTERACTIVE_BROWSER_TOOL_NAMES } from "../src/web/browser-renderer";
import { DeferredToolManager } from "../src/deferred-tools";
import { normalizeConfig } from "../src/config";
import { createState } from "../src/state";

const executionToolNames = Object.values(EXECUTION_TOOL_NAMES);

const theme = {
  bold: (value: string) => value,
  fg: (_color: string, value: string) => value,
};

function collapseLine(text: string): string {
  return `collapsed:${text}`;
}

function expandLine(text: string): string {
  return `expanded:${text}`;
}

function renderLines(component: unknown): string[] {
  assert.ok(component && typeof (component as { render?: unknown }).render === "function", "renderResult must return a renderable component");
  return (component as { render(width: number): string[] }).render(200);
}

// A minimal Pi-compatible text component, matching the shape the extension's
// own textComponent helper returns to Pi.
function textComponent(lines: string[]): unknown {
  return {
    render: (width: number) => lines.map((line) => line.slice(0, Math.max(1, width - 1))),
    invalidate() {},
  };
}

function sampleResult(): Record<string, unknown> {
  return { content: [{ type: "text", text: "result summary" }], details: { items: ["a", "b"] }, isError: false };
}

test("expandableResult renders the collapsed renderer unless natively expanded", () => {
  const collapsedCalls: unknown[][] = [];
  const expanded = expandableResult(
    (result, options, renderTheme, context) => {
      collapsedCalls.push([result, options, renderTheme, context]);
      return textComponent([collapseLine("summary")]);
    },
    () => {
      throw new Error("expanded renderer must not run while collapsed");
    },
  );
  const result = sampleResult();
  const options: ToolResultRenderOptions = { expanded: false, isPartial: false };
  const component = expanded(result, options, theme, { toolCallId: "call-1" });
  assert.deepEqual(renderLines(component), [collapseLine("summary")]);
  assert.equal(collapsedCalls.length, 1);
  // The raw native result, options, and context objects are forwarded unchanged.
  assert.equal(collapsedCalls[0]![0], result);
  assert.equal(collapsedCalls[0]![1], options);
  assert.equal(collapsedCalls[0]![2], theme);
  assert.deepEqual(collapsedCalls[0]![3], { toolCallId: "call-1" });
});

test("the same native toggle expands and re-collapses through the shared helper", () => {
  const expandedCalls: unknown[][] = [];
  const rendered = expandableResult(
    (_result, _options, _renderTheme, _context) => textComponent([collapseLine("summary")]),
    (result, options, _renderTheme, _context) => {
      expandedCalls.push([result, options]);
      return textComponent([collapseLine("summary"), expandLine("detail")]);
    },
  );
  const result = sampleResult();
  const expandedOptions = { expanded: true, isPartial: false };
  assert.deepEqual(renderLines(rendered(result, { expanded: false, isPartial: false }, theme)), [collapseLine("summary")]);
  assert.deepEqual(renderLines(rendered(result, expandedOptions, theme)), [
    collapseLine("summary"),
    expandLine("detail"),
  ]);
  // Re-collapse returns to the existing collapsed presentation.
  assert.deepEqual(renderLines(rendered(result, { expanded: false, isPartial: false }, theme)), [collapseLine("summary")]);
  assert.equal(expandedCalls.length, 1);
  assert.equal(expandedCalls[0]![0], result);
  assert.equal(expandedCalls[0]![1], expandedOptions);
});

test("tools awaiting richer details keep their existing presentation when expanded", () => {
  // No expanded callback contributed yet: expansion must not fabricate data or
  // change the existing renderer's output in either state.
  const collapsed = expandableResult(
    (result, _options, _renderTheme, _context) => textComponent([collapseLine(String((result as { text?: string }).text))]),
  );
  const result = { text: "existing summary" };
  const collapsedOutput = renderLines(collapsed(result, { expanded: false, isPartial: false }, theme));
  const expandedOutput = renderLines(collapsed(result, { expanded: true, isPartial: false }, theme));
  assert.deepEqual(collapsedOutput, [collapseLine("existing summary")]);
  assert.deepEqual(expandedOutput, collapsedOutput);
});

test("partial and error states are forwarded unchanged through the shared helper", () => {
  const seen: Array<{ result: unknown; options: ToolResultRenderOptions }> = [];
  const rendered = expandableResult((result, options) => {
    seen.push({ result, options });
    return textComponent([collapseLine("state")]);
  });
  const errorResult = { content: [{ type: "text", text: "failed" }], isError: true };
  const partialOptions = { expanded: true, isPartial: true };
  rendered(errorResult, partialOptions, theme);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.result, errorResult);
  assert.equal(seen[0]!.options, partialOptions);
  assert.equal(seen[0]!.options.isPartial, true);
  assert.equal(seen[0]!.options.expanded, true);
  // The detail callback owns lifecycle handling: the foundation forwards the
  // expanded/partial state unchanged, so a contributed callback must render a
  // useful streaming view for partial results (or choose the collapsed view
  // itself) rather than destabilizing the row.
  const withDetails = expandableResult(
    () => textComponent([collapseLine("state")]),
    (_result, options) => textComponent([expandLine(options.isPartial ? "streaming" : "detail")]),
  );
  assert.deepEqual(renderLines(withDetails(sampleResult(), { expanded: true, isPartial: true }, theme)), [expandLine("streaming")]);
  assert.deepEqual(renderLines(withDetails(errorResult, { expanded: true, isPartial: false }, theme)), [expandLine("detail")]);
});

test("a failing or non-rendering expanded callback falls back to the existing renderer", () => {
  const throwing = expandableResult(
    () => textComponent([collapseLine("safe")]),
    () => {
      throw new Error("detail renderer failure");
    },
  );
  assert.deepEqual(renderLines(throwing(sampleResult(), { expanded: true, isPartial: false }, theme)), [collapseLine("safe")]);
  // Pi's custom-renderer slot does not guard against undefined components;
  // the shared helper does, so a bad callback cannot destabilize the TUI.
  const returningUndefined = expandableResult(
    () => textComponent([collapseLine("safe")]),
    () => undefined,
  );
  assert.deepEqual(renderLines(returningUndefined(sampleResult(), { expanded: true, isPartial: false }, theme)), [collapseLine("safe")]);
});

test("produced callbacks carry the wiring-audit marker", () => {
  assert.equal(isExpandableResult(expandableResult(() => textComponent([]))), true);
  assert.equal(isExpandableResult(() => undefined), false);
  assert.equal((expandableResult(() => textComponent([])) as unknown as { [key: string]: unknown })[EXPANDABLE_RESULT_MARKER], true);
});

// ---------------------------------------------------------------------------
// Registered-tool wiring coverage (#57)
// ---------------------------------------------------------------------------

function executionHarness() {
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand(_name: string, _options: unknown) {},
    setToolActive() {},
    getActiveTools: () => [...executionToolNames, "read", "bash"],
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" as const },
    }],
    execution: {
      workerResources: [{ resourceId: "default", selection: { source: "external", id: "fake" }, maxConcurrent: 4 }],
    },
  });
  new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => process.cwd(),
    notify: () => {},
  }).sync();
  return tools;
}

test("every Subtasks* result renderer is wired through the shared expansion mechanism", () => {
  const tools = executionHarness();
  assert.equal(tools.length, executionToolNames.length);
  for (const name of executionToolNames) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} was not registered`);
    assert.equal(isExpandableResult(tool.renderResult), true, `${name} renderResult must be expandableResult-wired`);
  }
  // #59 contributed the expanded callback for the family: expanding a result
  // renders the contributed detail view through the real registered wiring,
  // and re-collapsing the same retained result returns to the identical
  // existing collapsed presentation.
  const inspect = tools.find((candidate) => candidate.name === "SubtasksInspect")!;
  const value = {
    content: [{ type: "text", text: "inspect: execution exec-1" }],
    details: { action: "inspect", tasks: [{ taskId: "task-a", state: "running", definition: { title: "Work" } }] },
  };
  const collapsed = renderLines(inspect.renderResult(value, {}, theme));
  assert.match(collapsed.join("\n"), /task-a running Work/);
  const expanded = renderLines(inspect.renderResult(value, { expanded: true }, theme));
  assert.match(expanded.join("\n"), /SubtasksInspect — expanded result/);
  assert.match(expanded.join("\n"), /task-a · Work · running/);
  assert.notDeepEqual(expanded, collapsed);
  assert.deepEqual(renderLines(inspect.renderResult(value, { expanded: false }, theme)), collapsed);
});

test("ApplyPatch's existing renderer is wired as the collapsed view of the mechanism", () => {
  const tools: Array<Record<string, any>> = [];
  registerApplyPatchTool({ registerTool: (tool: Record<string, any>) => { tools.push(tool); } });
  const tool = tools.find((candidate) => candidate.name === APPLY_PATCH_TOOL_NAME)!;
  assert.ok(tool, "ApplyPatch was not registered");
  assert.equal(isExpandableResult(tool.renderResult), true);
  const value = {
    content: [{ type: "text", text: "ApplyPatch updated 1 file(s)." }],
    details: { requestedDiff: "", finalDiff: "+ added line\n" },
  };
  const collapsed = renderLines(tool.renderResult(value, {}, theme));
  assert.deepEqual(renderLines(tool.renderResult(value, { expanded: true }, theme)), collapsed);
  assert.match(collapsed.join("\n"), /Final diff:/);
});

test("rendererless tools retain Pi's native expandable fallback rendering", () => {
  // Shell*, search_tools, WebSearch, WebFetch, and BrowserExtract never define
  // a custom renderResult: Pi's native fallback (bounded preview with an
  // expand hint, full returned text when expanded) is their adequate existing
  // expansion and must not be replaced by a custom collapsed renderer. The
  // WebFetch/BrowserExtract detail views are a separate contribution (#82).
  const shellTools: Record<string, any> = {};
  registerBackgroundShell({
    registerTool: (tool: any) => { shellTools[tool.name] = tool; },
    on: () => {},
    sendMessage: () => {},
  });
  const webTools: Array<Record<string, any>> = [];
  new WebToolManager(
    { registerTool: (tool) => { webTools.push(tool); } },
    normalizeConfig({}),
    undefined,
    undefined,
    { shutdown: async () => {}, updateConfig: () => {} } as unknown as any,
  ).register();
  const deferredTools: Array<Record<string, any>> = [];
  new DeferredToolManager({
    registerTool: (tool: any) => { deferredTools.push(tool); },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
  }).register();
  const expectedNative = [
    "ShellStart", "ShellList", "ShellLog", "ShellSend", "ShellStop",
    "WebSearch", "WebFetch", "BrowserExtract",
    "search_tools",
  ];
  const registered = [...Object.values(shellTools), ...webTools, ...deferredTools] as Array<Record<string, any>>;
  const registeredNames = new Set(registered.map((tool) => String(tool.name)));
  for (const name of expectedNative) {
    assert.ok(registeredNames.has(name), `${name} was not registered`);
  }
  assert.equal(registered.length, expectedNative.length + INTERACTIVE_BROWSER_TOOL_NAMES.length, "unexpected additional rendererless registrations");
  const interactiveBrowserNames = new Set<string>(INTERACTIVE_BROWSER_TOOL_NAMES);
  for (const tool of registered) {
    if (interactiveBrowserNames.has(String(tool.name))) continue;
    assert.equal(tool.renderResult, undefined, `${tool.name} must keep Pi's native fallback expansion`);
    assert.equal(tool.renderCall, undefined, `${tool.name} must keep Pi's native fallback expansion`);
  }
});

test("every interactive Browser* result renderer is wired through the shared expansion mechanism", () => {
  const webTools: Array<Record<string, any>> = [];
  new WebToolManager(
    { registerTool: (tool) => { webTools.push(tool); } },
    normalizeConfig({}),
    undefined,
    undefined,
    { shutdown: async () => {}, updateConfig: () => {} } as unknown as any,
  ).register();
  const browserTools = webTools.filter((tool) => (INTERACTIVE_BROWSER_TOOL_NAMES as readonly string[]).includes(tool.name));
  assert.equal(browserTools.length, INTERACTIVE_BROWSER_TOOL_NAMES.length, "the interactive browser family must be registered");
  for (const tool of browserTools) {
    assert.equal(isExpandableResult(tool.renderResult), true, `${tool.name} renderResult must be expandableResult-wired`);
    // No tool in the family registers a competing call renderer or expansion
    // machinery; the shared wrapper instance is reused by every registration.
    assert.equal(tool.renderCall, undefined, `${tool.name} must keep the native call fallback`);
  }
  // The non-browser web tools stay rendererless (WebFetch/BrowserExtract are
  // owned by #82).
  for (const name of ["WebSearch", "WebFetch", "BrowserExtract"]) {
    const tool = webTools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} was not registered`);
    assert.equal(tool.renderResult, undefined, `${name} must keep Pi's native fallback expansion`);
  }
});

test("the expansion coverage inventory matches the registered tool set", () => {
  const wrapped = [...executionToolNames, APPLY_PATCH_TOOL_NAME, ...INTERACTIVE_BROWSER_TOOL_NAMES];
  const tools = [...executionHarness()];
  registerApplyPatchTool({ registerTool: (tool: Record<string, any>) => { tools.push(tool); } });
  const webTools: Array<Record<string, any>> = [];
  new WebToolManager(
    { registerTool: (tool) => { webTools.push(tool); } },
    normalizeConfig({}),
    undefined,
    undefined,
    { shutdown: async () => {}, updateConfig: () => {} } as unknown as any,
  ).register();
  tools.push(...webTools);
  const wrappedRegistered = tools.filter((tool: Record<string, unknown>) => isExpandableResult(tool.renderResult));
  assert.deepEqual(
    wrappedRegistered.map((tool) => tool.name).sort(),
    [...wrapped].sort(),
    "the wrapped inventory must cover exactly the tools with existing custom renderers",
  );
});