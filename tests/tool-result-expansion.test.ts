// Shared native tool-result expansion foundation (#57).
//
// These tests exercise the actual shared mechanism in src/tool-result-expansion.ts
// and real registered tool renderer wiring: Subtasks*, ApplyPatch, Shell*,
// interactive Browser*, WebFetch and BrowserExtract use the shared helper.
// Outputs come from production renderers, not copied rendering algorithms.
// ApplyPatch retains its existing presentation in both expansion states.
import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPANDABLE_RESULT_MARKER,
  expandableResult,
  isExpandableResult,
  reopenRowBackground,
  toolRowBackgroundToken,
  type ToolResultRenderOptions,
} from "../src/tool-result-expansion";
import { isExpandablePresentation } from "../src/presentation-expansion";
import { ExecutionToolManager, EXECUTION_TOOL_NAMES } from "../src/execution/tool";
import { APPLY_PATCH_TOOL_NAME, registerApplyPatchTool } from "../src/apply-patch/tool";
import registerBackgroundShell, { reapAll } from "../src/background-shell";
import { shellResultDetails } from "../src/background-shell/result-view";
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

test("a failing or non-rendering expanded callback falls back to the existing renderer with a visible notice", () => {
  // #93: the silent fallback was replaced by a visible failure indication —
  // the summary stays available but is never presented as a complete-looking
  // expanded view.
  const throwing = expandableResult(
    () => textComponent([collapseLine("safe")]),
    () => {
      throw new Error("detail renderer failure");
    },
  );
  assert.deepEqual(renderLines(throwing(sampleResult(), { expanded: true, isPartial: false }, theme)), [
    collapseLine("safe"),
    "detail view unavailable - showing summary",
  ]);
  // Pi's custom-renderer slot does not guard against undefined components;
  // the shared helper does, so a bad callback cannot destabilize the TUI.
  const returningUndefined = expandableResult(
    () => textComponent([collapseLine("safe")]),
    () => undefined,
  );
  assert.deepEqual(renderLines(returningUndefined(sampleResult(), { expanded: true, isPartial: false }, theme)), [
    collapseLine("safe"),
    "detail view unavailable - showing summary",
  ]);
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
    externalAgents: {
      "fake": {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1" as const }
      }
    },
    execution: {
      workerResources: { "default": { selection: { source: "external", id: "fake" }, maxConcurrent: 4 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
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
  assert.match(collapsed.join("\n"), /task-a · running · Work/);
  const expanded = renderLines(inspect.renderResult(value, { expanded: true }, theme));
  assert.match(expanded.join("\n"), /SubtasksInspect · \? · status/);
  assert.match(expanded.join("\n"), /task-a · Work · running/);
  assert.notDeepEqual(expanded, collapsed);
  assert.deepEqual(renderLines(inspect.renderResult(value, { expanded: false }, theme)), collapsed);
});

test("ApplyPatch expands the actual request and retained diff through the shared mechanism", () => {
  const tools: Array<Record<string, any>> = [];
  registerApplyPatchTool({ registerTool: (tool: Record<string, any>) => { tools.push(tool); } });
  const tool = tools.find((candidate) => candidate.name === APPLY_PATCH_TOOL_NAME)!;
  assert.ok(tool, "ApplyPatch was not registered");
  assert.equal(isExpandableResult(tool.renderResult), true);
  const value = {
    content: [{ type: "text", text: "ApplyPatch updated 1 file(s)." }],
    details: { requestedDiff: "", finalDiff: "+ added line\n" },
  };
  const patch = "*** Begin Patch\n*** Add File: sample.txt\n+ added line\n*** End Patch";
  const context = { args: { patch } };
  const collapsed = renderLines(tool.renderResult(value, {}, theme, context));
  const expanded = renderLines(tool.renderResult(value, { expanded: true }, theme, context));
  assert.notDeepEqual(expanded, collapsed);
  assert.ok(expanded.join("\n").includes(patch), "expansion preserves the actual submitted envelope");
  assert.match(expanded.join("\n"), /Final diff:\n\+ added line/);
  assert.deepEqual(renderLines(tool.renderResult(value, { expanded: false }, theme, context)), collapsed);
});

test("web and discovery registrations all use the shared expansion mechanism", () => {
  // #93 adds genuine request/result views to the formerly rendererless tools.
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
  const expectedNames = [...INTERACTIVE_BROWSER_TOOL_NAMES, "WebFetch", "BrowserExtract", "WebSearch", "tool_search"];
  const registered = [...webTools, ...deferredTools] as Array<Record<string, any>>;
  const registeredNames = new Set(registered.map((tool) => String(tool.name)));
  for (const name of expectedNames) {
    assert.ok(registeredNames.has(name), `${name} was not registered`);
  }
  assert.equal(registered.length, expectedNames.length, "unexpected additional registrations");
  for (const tool of registered) {
    assert.equal(isExpandableResult(tool.renderResult), true, `${tool.name} must use shared expansion`);
  }
  // Acquisition wiring must preserve the interactive browser family's wrapper.
  for (const name of ["BrowserOpen", "BrowserNavigate", "BrowserClose"]) {
    const tool = webTools.find((candidate: Record<string, any>) => candidate.name === name);
    assert.ok(tool, `${name} was not registered`);
    assert.equal(isExpandableResult(tool.renderResult), true, `${name} must retain shared expansion wiring`);
  }
});

// Real registered-tool integration for the two acquisition tools (#82).
test("registered WebFetch and BrowserExtract expand and re-collapse through the shared mechanism", async () => {
  const webTools: Array<Record<string, any>> = [];
  // Long production-shaped retained content: formatPage emits the full content
  // block in the returned text, so the collapsed view must stay bounded.
  const longContent = Array.from({ length: 60 }, (_, index) => `retained line ${index + 1} of the acquired document`).join("\n");
  const retainedResponse = {
    requestedUrl: "https://example.test/article",
    finalUrl: "https://example.test/article",
    fetchedAt: "2026-08-23T00:00:00.000Z",
    contentType: "text/html; charset=utf-8",
    downloadedBytes: 123_456,
    cacheHit: true,
    title: "Retained article",
    documentType: "html",
    dynamicContentSuspected: false,
    dynamicContentReasons: [],
    tables: [],
    pagination: [],
    startIndex: 0,
    endIndex: 0,
    nextIndex: 1,
    totalBlocks: 2,
    content: longContent,
  };
  const acquisitionCache = {
    fetch: async () => retainedResponse,
    cleanupSync() {},
    updateConfig() {},
  } as unknown as any;
  new WebToolManager(
    { registerTool: (tool) => { webTools.push(tool); } },
    normalizeConfig({}),
    acquisitionCache,
    acquisitionCache,
    { shutdown: async () => {}, updateConfig: () => {} } as unknown as any,
  ).register();

  for (const name of ["WebFetch", "BrowserExtract"]) {
    const tool = webTools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} was not registered`);
    assert.equal(isExpandableResult(tool.renderResult), true, `${name} renderResult must be expandableResult-wired`);

    // The result value is the real production packet: textResult(formatPage(...)).
    const value = await tool.execute("call-1", { url: "https://example.test/article" });
    const returnedText = (value.content as Array<{ text: string }>)[0]!.text;
    assert.ok(returnedText.includes("retained line 60"), "fixture sanity: the production text includes the full retained content");

    // The collapsed arm is a concise structured summary, not a second body
    // preview. The complete retained body is reserved for expansion.
    const collapsed = renderLines(tool.renderResult(value, { expanded: false, isPartial: false }, theme));
    assert.ok(collapsed.length <= 6, `${name} collapsed output must stay concise, got ${collapsed.length} lines`);
    assert.match(collapsed.join("\n"), new RegExp(`${name} · Retained article`));
    assert.doesNotMatch(collapsed.join("\n"), /retained line 60/, "the collapsed summary must omit the retained tail");

    // Expansion renders the retained-response detail through the shared
    // wrapper — same wrapper object, no re-execution or extra retrieval.
    const expanded = renderLines(tool.renderResult(value, { expanded: true, isPartial: false }, theme));
    assert.notDeepEqual(expanded, collapsed, `${name} expanded view must render the contributed detail`);
    assert.match(expanded.join("\n"), /UNTRUSTED RETAINED RESULT DETAILS/);
    assert.match(expanded.join("\n"), /Retained indexed content/);
    assert.match(expanded.join("\n"), /# retained heading|retained line 60/, "the expanded detail retains the bounded returned content");
    assert.match(expanded.join("\n"), /Range: indexes 0-0 of 1/);

    // Re-collapse returns to the same bounded collapsed presentation without
    // re-running the tool or changing output.
    assert.deepEqual(renderLines(tool.renderResult(value, { expanded: false, isPartial: false }, theme)), collapsed);
  }

  // Error results keep the native collapsed diagnostics when expanded.
  const fetchTool = webTools.find((candidate) => candidate.name === "WebFetch")!;
  const failedValue = {
    content: [{ type: "text", text: "WebFetch failed: bounded diagnostic" }],
    details: { error: "private transport detail" },
    isError: true,
  };
  const failedExpanded = renderLines(fetchTool.renderResult(failedValue, { expanded: true, isPartial: false }, theme)).join("\n");
  assert.match(failedExpanded, /WebFetch failed: bounded diagnostic/);
  assert.doesNotMatch(failedExpanded, /private transport detail/);
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
  // Search now uses the shared acquisition/search expansion mechanism.
  const search = webTools.find((candidate) => candidate.name === "WebSearch");
  assert.ok(search, "WebSearch was not registered");
  assert.equal(isExpandableResult(search.renderResult), true, "WebSearch must use shared expansion wiring");
});

// ---------------------------------------------------------------------------
// Registered Shell* wiring coverage (#58)
// ---------------------------------------------------------------------------

const SHELL_TOOL_NAMES = ["ShellStart", "ShellList", "ShellLog", "ShellSend", "ShellStop"] as const;

function shellHarness(): Record<string, any> {
  const tools: Record<string, any> = {};
  registerBackgroundShell({
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    on: () => {},
    sendMessage: () => {},
  });
  return tools;
}

async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await fn();
}

test("every Shell* registration is wired through the shared mechanism and expands with real results", async () => {
  const tools = shellHarness();
  for (const name of SHELL_TOOL_NAMES) {
    assert.ok(tools[name], `${name} was not registered`);
    assert.equal(isExpandableResult(tools[name].renderResult), true, `${name} renderResult must be expandableResult-wired`);
  }

  const ctx = { hasUI: false, ui: {} };
  const call = (name: string, params: any) =>
    tools[name].execute("id", params, undefined, undefined, ctx);
  try {
    // Two real jobs: one that exits fast, one with a live stdin.
    const started = await call("ShellStart", { command: "echo head-line; echo tail-line; exit 3", label: "wiring" });
    let listed: any;
    let logged: any;
    assert.equal(
      await until(async () => {
        listed = await call("ShellList", {});
        logged = await call("ShellLog", { id: started.details.id, lines: 1 });
        return listed.details.jobs[0]?.status === "failed(3)";
      }),
      true,
      "the wiring job must exit before its results are rendered",
    );
    const stoppedExited = await call("ShellStop", { id: started.details.id });
    const piper = await call("ShellStart", { command: "cat", label: "piper" });
    const sent = await call("ShellSend", { id: piper.details.id, text: "hello" });
    assert.equal(sent.details.delivery, "confirmed");
    const stopped = await call("ShellStop", { id: piper.details.id });

    // From here on any execute call — from a rendering path or otherwise —
    // fails the test: expansion must never rerun a tool.
    for (const name of SHELL_TOOL_NAMES) {
      tools[name].execute = () => { throw new Error(`${name}.execute must not run during expansion`); };
    }

    // Toggle every real result through its registered renderResult only.
    const captured: Array<[string, any]> = [
      ["ShellStart", started],
      ["ShellList", listed],
      ["ShellLog", logged],
      ["ShellSend", sent],
      ["ShellStop", stopped],
      ["ShellStop", stoppedExited],
    ];
    for (const [name, value] of captured) {
      const collapsed = renderLines(tools[name].renderResult(value, { expanded: false, isPartial: false }, theme));
      const expanded = renderLines(tools[name].renderResult(value, { expanded: true, isPartial: false }, theme));
      const recollapsed = renderLines(tools[name].renderResult(value, { expanded: false, isPartial: false }, theme));
      assert.deepEqual(recollapsed, collapsed, `${name} re-collapse must restore the collapsed presentation`);
    }

    // Collapsed is the canonical actionable command preview.
    const startCollapsed = renderLines(tools.ShellStart.renderResult(started, { expanded: false, isPartial: false }, theme));
    assert.match(startCollapsed.join("\n"), /ShellStart · job\d+ "wiring" · running/);
    assert.match(startCollapsed.join("\n"), /command:/);

    // Expanded shows the retained snapshot's provenance from the result alone.
    const startExpanded = renderLines(tools.ShellStart.renderResult(started, { expanded: true, isPartial: false }, theme));
    assert.match(startExpanded.join("\n"), new RegExp(`ShellStart · ${started.details.id} "wiring"`));
    assert.match(startExpanded.join("\n"), /Command:\necho head-line; echo tail-line; exit 3/);
    assert.match(startExpanded.join("\n"), new RegExp(`PID: ${started.details.pid}\\b`));

    // The expanded ShellLog view renders exactly the retained slice — the one
    // line the call delivered, with its range — never the rest of the live
    // buffer, which only a re-fetch could show.
    const logExpanded = renderLines(tools.ShellLog.renderResult(logged, { expanded: true, isPartial: false }, theme));
    const logJoined = logExpanded.join("\n");
    assert.match(logJoined, /Returned range: \[1, 2\)/);
    assert.match(logJoined, /Total lines recorded: 2/);
    assert.match(logJoined, /tail-line/);
    assert.doesNotMatch(logJoined, /head-line/);

    // Expansion is presentation only: the throwing spies above prove no toggle
    // re-executed a tool, and the retained result is neither mutated nor
    // re-derived from live job state.
    const loggedSnapshot = JSON.stringify(logged);
    reapAll();
    assert.deepEqual(renderLines(tools.ShellLog.renderResult(logged, { expanded: true, isPartial: false }, theme)), logExpanded);
    assert.equal(JSON.stringify(logged), loggedSnapshot, "expansion must not mutate the retained result");
  } finally {
    reapAll();
  }
});

test("Shell* registered renderers stay stable across error, partial, and no-data results", async () => {
  const tools = shellHarness();
  const ctx = { hasUI: false, ui: {} };
  try {
    // Real error result through the real registration. Error results carry no
    // structured details, so expansion degrades to the bounded preview of the
    // retained error text — nothing fabricated.
    const missing = await tools.ShellLog.execute("id", { id: "nope" }, undefined, undefined, ctx);
    assert.equal(missing.isError, true);
    const expandedMissing = renderLines(tools.ShellLog.renderResult(missing, { expanded: true, isPartial: false }, theme)).join("\n");
    assert.match(expandedMissing, /no structured details were recorded/);
    assert.match(expandedMissing, /no such job "nope"/);
    // Collapsed renders the retained error text through the preserved fallback.
    assert.match(
      renderLines(tools.ShellLog.renderResult(missing, { expanded: false, isPartial: false }, theme)).join("\n"),
      /no such job "nope"/,
    );

    // A tagged error result renders the bounded error view through the wiring.
    const taggedError = {
      content: [{ type: "text", text: `Error: ${"x".repeat(400)}` }],
      isError: true,
      details: shellResultDetails("ShellLog"),
    };
    assert.match(
      renderLines(tools.ShellLog.renderResult(taggedError, { expanded: true, isPartial: false }, theme)).join("\n"),
      /ShellLog · error/,
    );

    // Partial (streaming) renders one bounded pending line per tool.
    for (const name of SHELL_TOOL_NAMES) {
      assert.deepEqual(
        renderLines(tools[name].renderResult(missing, { expanded: true, isPartial: true }, theme)),
        [`${name} … (running)`],
      );
    }

    // No structured details (restored pre-details result): bounded preview of
    // the retained text, nothing fabricated.
    const legacy = { content: [{ type: "text", text: 'Started "old" as job1 (pid 1); currently running.' }], isError: false };
    const legacyJoined = renderLines(tools.ShellStart.renderResult(legacy, { expanded: true, isPartial: false }, theme)).join("\n");
    assert.match(legacyJoined, /no structured details were recorded/);
    assert.match(legacyJoined, /Started "old" as job1/);

    // Empty content renders nothing in the collapsed fallback, as native does.
    const empty = { content: [{ type: "text", text: "" }], isError: false };
    assert.deepEqual(renderLines(tools.ShellList.renderResult(empty, { expanded: false, isPartial: false }, theme)), []);
  } finally {
    reapAll();
  }
});

test("Shell* registered renderers never surface unrelated internal details or context", () => {
  // Sentinel values in detail fields no renderer reads and in the render
  // context must never reach a rendered line, in either expansion state.
  const sentinels = ["SENTINEL-SECRET-TOKEN", "SENTINEL-INTERNAL-PATH", "SENTINEL-CTX-STATE"];
  const tools = shellHarness();
  for (const name of SHELL_TOOL_NAMES) {
    const value = {
      content: [{ type: "text", text: `Result body for ${name}.` }],
      isError: false,
      details: shellResultDetails(name, {
        id: "job1",
        label: "sentinel",
        status: "running",
        totalLines: 0,
        droppedLines: 0,
        from: 0,
        nextOffset: 0,
        bytes: 1,
        delivery: "confirmed",
        command: "true",
        pid: 1,
        watching: "exit",
        startedAt: Date.UTC(2026, 0, 1),
        jobs: [],
        target: "job1",
        jobId: "job1",
        outcome: "stopping",
        count: 1,
        secretToken: sentinels[0],
        internalPath: sentinels[1],
      }),
    };
    const context = { toolCallId: sentinels[2], state: { note: sentinels[2] }, cwd: "/tmp" };
    for (const options of [{ expanded: false, isPartial: false }, { expanded: true, isPartial: false }]) {
      const lines = renderLines(tools[name].renderResult(value, options, theme, context)).join("\n");
      for (const sentinel of sentinels) {
        assert.doesNotMatch(lines, new RegExp(sentinel), `${name} must not render internal data (${JSON.stringify(options)})`);
      }
    }
  }
});

test("the expansion coverage inventory matches the registered tool set", () => {
  const wrapped = [...executionToolNames, APPLY_PATCH_TOOL_NAME, ...INTERACTIVE_BROWSER_TOOL_NAMES, ...SHELL_TOOL_NAMES, "WebFetch", "BrowserExtract", "WebSearch"];
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
  const shellTools = shellHarness();
  for (const name of SHELL_TOOL_NAMES) tools.push(shellTools[name]);
  const wrappedRegistered = tools.filter((tool: Record<string, unknown>) => isExpandableResult(tool.renderResult));
  assert.deepEqual(
    wrappedRegistered.map((tool) => tool.name).sort(),
    [...wrapped].sort(),
    "the wrapped inventory must cover exactly the tools with existing custom renderers",
  );
});

// ── Tool-row background continuity across a row's resets (#677) ──────────
//
// The host pads a tool row and paints the whole padded row with ONE background
// span (`Box.applyBg` → `theme.bg(token, padded)`), so a full reset (`\x1b[0m`)
// or background reset (`\x1b[49m`) surviving inside a rendered row cancels that
// span for the rest of the row — including the card's own right padding, which
// then falls back to the terminal background. Two ways a tool row can carry
// such a reset: a family's own width wrap closing a continued styled row, and
// retained output (a diff, a discovery outcome, shell output) that already
// contains resets. The repair lives in this adapter, so it covers every custom
// tool-result registration; these tests pin the adapter's rule and prove it on
// registrations whose retained content really does preserve live SGR.

const BG_OPEN: Record<string, string> = {
  toolPendingBg: "\x1b[48;5;24m",
  toolSuccessBg: "\x1b[48;5;22m",
  toolErrorBg: "\x1b[48;5;52m",
};

const bgTheme = {
  bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
  fg: (_color: string, value: string) => `\x1b[38;5;145m${value}\x1b[39m`,
  getBgAnsi: (token: string) => BG_OPEN[token]!,
};

/** The same theme without the background accessor: the degradation case. */
const noBgTheme = { bold: bgTheme.bold, fg: bgTheme.fg };

const RESET_TEXT = "retained diff context alpha beta gamma \x1b[0m tail after a full reset alpha beta gamma delta epsilon zeta";
const BGR_RESET_TEXT = "retained context with a background reset \x1b[49m and more retained text alpha beta gamma delta";

function assertReopened(lines: string[], backgroundAnsi: string, label: string): void {
  for (const [index, line] of lines.entries()) {
    for (const reset of ["\x1b[0m", "\x1b[m", "\x1b[49m"]) {
      let at = line.indexOf(reset);
      while (at !== -1) {
        assert.equal(
          line.slice(at + reset.length, at + reset.length + backgroundAnsi.length),
          backgroundAnsi,
          `${label}: row ${index + 1} does not reopen the themed row background after ${JSON.stringify(reset)}`,
        );
        at = line.indexOf(reset, at + reset.length);
      }
    }
  }
}

function assertOnlyOpensInserted(before: string[], after: string[], backgroundAnsi: string, label: string): void {
  assert.equal(after.length, before.length, `${label}: the number of rendered rows changed`);
  for (const [index, repaired] of after.entries()) {
    assert.equal(
      repaired.split(backgroundAnsi).join(""),
      before[index]!,
      `${label}: row ${index + 1} changed beyond the inserted background open`,
    );
  }
}

function renderAt(component: unknown, width: number): string[] {
  return (component as { render(w: number): string[] }).render(width);
}

test("reopenRowBackground inserts only the background open after background-clearing resets", () => {
  const bg = BG_OPEN.toolSuccessBg;
  assert.equal(reopenRowBackground("a\x1b[0mb", bg), `a\x1b[0m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[mb", bg), `a\x1b[m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[49mb", bg), `a\x1b[49m${bg}b`);
  // A reset at the very end of a row reopens too, so the host's own padding
  // that follows stays painted.
  assert.equal(reopenRowBackground("a\x1b[0m", bg), `a\x1b[0m${bg}`);
  assert.equal(reopenRowBackground("\x1b[0ma\x1b[49mb\x1b[0m", bg), `\x1b[0m${bg}a\x1b[49m${bg}b\x1b[0m${bg}`);
  // Sequences made only of resets still clear the background.
  assert.equal(reopenRowBackground("a\x1b[0;49mb", bg), `a\x1b[0;49m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[00mb", bg), `a\x1b[00m${bg}b`);
});

test("reopenRowBackground never reopens over a sequence that sets attributes", () => {
  const bg = BG_OPEN.toolSuccessBg;
  // A sequence that neither resets nor sets the background leaves the row alone.
  for (const line of ["a\x1b[31mb", "a\x1b[1mb", "a\x1b[42mb", "a\x1b[39mb", "a\x1b[22mb", "a\x1b[7mb"]) {
    assert.equal(reopenRowBackground(line, bg), line);
  }
  // A background set AFTER the reset wins: the row's own colour is never
  // overridden, whatever came before it in the same sequence.
  for (const line of ["a\x1b[0;41mb", "a\x1b[0;48;2;0;0;0mb", "a\x1b[0;48;5;0mb", "a\x1b[0;100mb"]) {
    assert.equal(reopenRowBackground(line, bg), line);
  }
  // Extended-colour payloads are not resets: the zero components of
  // `38;5;0` / `38;2;0;0;0` / `58;5;0` change no background, and a colon form
  // is skipped entirely.
  for (const line of ["a\x1b[38;5;0mb", "a\x1b[38;2;0;0;0mb", "a\x1b[58;5;0mb", "a\x1b[38:2::255:0:0mb"]) {
    assert.equal(reopenRowBackground(line, bg), line);
  }
  // Parameters are numeric, so a zero-padded mode is the same mode: `48;05;0`
  // and `48;02;0;0;0` set a background just like `48;5;0` / `48;2;0;0;0`, and
  // their payload zeros must not be read as resets. Byte-for-byte identity
  // includes the padded bytes themselves.
  for (const line of [
    "a\x1b[48;05;0mb", "a\x1b[48;02;0;0;0mb", "a\x1b[0;48;05;0mb", "a\x1b[0;48;02;0;0;0mb",
    "a\x1b[38;05;0mb", "a\x1b[38;02;0;0;0mb",
  ]) {
    assert.equal(reopenRowBackground(line, bg), line);
  }
  // Colon sub-parameters belong to their own attribute: an explicit colon-form
  // background is never overridden, padded or not.
  for (const line of ["a\x1b[48:5:0mb", "a\x1b[0;48:5:0mb", "a\x1b[0;48:2::0:0:0mb", "a\x1b[0;48:2::1:1:1mb"]) {
    assert.equal(reopenRowBackground(line, bg), line);
  }
  // Non-SGR controls are never touched.
  assert.equal(reopenRowBackground("a\x1b[2Jb\x1b]0;title\x07c", bg), "a\x1b[2Jb\x1b]0;title\x07c");
  // A row without any reset is returned unchanged.
  assert.equal(reopenRowBackground("plain retained row", bg), "plain retained row");
  assert.equal(reopenRowBackground("", bg), "");
  // Inverse video paints with the foreground colour, so a reset combined with
  // it is left alone rather than re-opened under a swapped meaning.
  assert.equal(reopenRowBackground("a\x1b[0;7mb", bg), "a\x1b[0;7mb");
});

test("reopenRowBackground reopens a reset combined with attributes that keep the background unset", () => {
  const bg = BG_OPEN.toolSuccessBg;
  // The reported family of forms: the sequence resets, then sets only
  // foreground attributes, so the background is still unset at the end of it.
  assert.equal(reopenRowBackground("a\x1b[0;31mb", bg), `a\x1b[0;31m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[31;0mb", bg), `a\x1b[31;0m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[0;1mb", bg), `a\x1b[0;1m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[0;4;38;5;208mb", bg), `a\x1b[0;4;38;5;208m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[0;38;2;255;128;0mb", bg), `a\x1b[0;38;2;255;128;0m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[0;38;5;0mb", bg), `a\x1b[0;38;5;0m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[49;31mb", bg), `a\x1b[49;31m${bg}b`);
  // A colon-form foreground after a reset: the sequence is inspected despite
  // its sub-parameters, the background is re-opened, and every original byte —
  // colons included — is kept in front of the re-open.
  assert.equal(reopenRowBackground("a\x1b[0;38:2::255:0:0mb", bg), `a\x1b[0;38:2::255:0:0m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[0;38:5:0mb", bg), `a\x1b[0;38:5:0m${bg}b`);
  // A zero-padded mode combined with a reset: the reset still clears.
  assert.equal(reopenRowBackground("a\x1b[0;38;05;0;1mb", bg), `a\x1b[0;38;05;0;1m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[0;38;02;0;0;0mb", bg), `a\x1b[0;38;02;0;0;0m${bg}b`);
  // A background set BEFORE the reset is still cleared by the reset.
  assert.equal(reopenRowBackground("a\x1b[41;0mb", bg), `a\x1b[41;0m${bg}b`);
});

test("colon colors do not consume subsequent top-level attributes", () => {
  const bg = BG_OPEN.toolSuccessBg;
  // A colon-form colour carries its whole payload inside ONE parameter, so the
  // parameters after it are ordinary attributes: the dim (`2`) here must not be
  // read as a colour mode and swallow the explicit red background (`41`).
  const ownBackground = "a\x1b[0;38:2::255:0:0;2;41mb";
  assert.equal(reopenRowBackground(ownBackground, bg), ownBackground);
  // Likewise a following blink (`5`) must not swallow a background reset that
  // comes after the colon colour.
  for (const sequence of [
    "\x1b[38:2::255:0:0;5;49m",
    "\x1b[48:2::0:0:0;2;49m",
    "\x1b[48:5:0;2;49m",
  ]) {
    assert.equal(reopenRowBackground(`a${sequence}b`, bg), `a${sequence}${bg}b`);
  }
  // And a colon colour followed by another explicit background keeps that one.
  for (const line of ["a\x1b[0;48:2::0:0:0;2;41mb", "a\x1b[38:2::255:0:0;5;48;5;22mb"]) {
    assert.equal(reopenRowBackground(line, bg), line);
  }
});

test("combined inverse attributes retain their final meaning", () => {
  const bg = BG_OPEN.toolSuccessBg;
  // Inverse video is tracked separately from the background effect and judged
  // at the END of the sequence: turned back off here, so the cleared background
  // is restored.
  assert.equal(reopenRowBackground("a\x1b[0;7;27mb", bg), `a\x1b[0;7;27m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[7;27;49mb", bg), `a\x1b[7;27;49m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[0;4;7;27;31mb", bg), `a\x1b[0;4;7;27;31m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[0;38:2::255:0:0;7;27mb", bg), `a\x1b[0;38:2::255:0:0;7;27m${bg}b`);
  // Still inverted at the end of the sequence: what the cell paints is the
  // foreground colour, so the row is left exactly as it is.
  for (const inverted of ["a\x1b[0;7;49mb", "a\x1b[7;49mb", "a\x1b[0;27;7mb"]) {
    assert.equal(reopenRowBackground(inverted, bg), inverted);
  }
  // A full reset turns inverse off, and an explicit background is untouched.
  assert.equal(reopenRowBackground("a\x1b[7;0mb", bg), `a\x1b[7;0m${bg}b`);
  assert.equal(reopenRowBackground("a\x1b[0;7;41mb", bg), "a\x1b[0;7;41mb");
});

test("inverse state survives adjacent SGR sequences within a row", () => {
  const bg = BG_OPEN.toolSuccessBg;
  // The split-sequence equivalents: inverse video and a deferred background
  // restoration are row state, so a reset under still-active inverse video is
  // not restored until the row turns inverse off.
  assert.equal(
    reopenRowBackground("a\x1b[7m\x1b[49mb\x1b[27mc", bg),
    `a\x1b[7m\x1b[49mb\x1b[27m${bg}c`,
  );
  assert.equal(
    reopenRowBackground("a\x1b[0;7mb\x1b[27mc", bg),
    `a\x1b[0;7mb\x1b[27m${bg}c`,
  );
  assert.equal(
    reopenRowBackground("a\x1b[7m\x1b[49mb", bg),
    "a\x1b[7m\x1b[49mb",
  );
  // The restoration is satisfied once, and a later reset restores again.
  assert.equal(
    reopenRowBackground("a\x1b[0;7mb\x1b[27mc\x1b[49md", bg),
    `a\x1b[0;7mb\x1b[27m${bg}c\x1b[49m${bg}d`,
  );
  assert.equal(
    reopenRowBackground("a\x1b[7m\x1b[49mb\x1b[27mc\x1b[49md", bg),
    `a\x1b[7m\x1b[49mb\x1b[27m${bg}c\x1b[49m${bg}d`,
  );
  // An explicit background set while inverted still wins over the theme
  // re-open, and `27` alone never invents a restoration on a row that was never
  // inverted.
  assert.equal(reopenRowBackground("a\x1b[0;7m\x1b[41mb\x1b[27mc", bg), "a\x1b[0;7m\x1b[41mb\x1b[27mc");
  assert.equal(reopenRowBackground("a\x1b[7m\x1b[41mb\x1b[27mc", bg), "a\x1b[7m\x1b[41mb\x1b[27mc");
  assert.equal(reopenRowBackground("a\x1b[0;31mb\x1b[27mc", bg), `a\x1b[0;31m${bg}b\x1b[27mc`);
});

test("toolRowBackgroundToken follows the host's tool-row state", () => {
  const ok = { content: [{ type: "text", text: "done" }] };
  const errored = { content: [{ type: "text", text: "boom" }], isError: true };
  assert.equal(toolRowBackgroundToken(ok, { expanded: false, isPartial: false }, { isError: false }), "toolSuccessBg");
  assert.equal(toolRowBackgroundToken(ok, { expanded: true, isPartial: true }, { isError: true }), "toolPendingBg");
  assert.equal(toolRowBackgroundToken(ok, { expanded: false, isPartial: false }, { isError: true }), "toolErrorBg");
  // Legacy records keep reporting the failure on the result itself.
  assert.equal(toolRowBackgroundToken(errored, { expanded: false, isPartial: false }, undefined), "toolErrorBg");
  assert.equal(toolRowBackgroundToken(undefined, undefined, undefined), "toolSuccessBg");
});

test("a partial row with a reset reopens the pending token, never the success or error one", () => {
  const render = expandableResult(
    () => textComponent([`streaming ${RESET_TEXT}`]),
    () => textComponent([`streaming ${RESET_TEXT}`]),
  );
  const options = { expanded: false, isPartial: true };
  const before = renderAt(render({}, options, noBgTheme, {}), 200);
  // The trigger: the partial row really does carry a background-clearing reset,
  // so this case cannot pass vacuously.
  assert.ok(/\x1b\[(?:0+m|49m)/.test(before.join("")), "the partial fixture carries no background-clearing reset");
  const after = renderAt(render({}, options, bgTheme, {}), 200);
  assertReopened(after, BG_OPEN.toolPendingBg, "partial row");
  assertOnlyOpensInserted(before, after, BG_OPEN.toolPendingBg, "partial row");
  // The other two tokens belong to non-partial rows: a partial render must not
  // paint a row the host is still drawing as pending.
  const joined = after.join("");
  assert.ok(!joined.includes(BG_OPEN.toolSuccessBg), "a partial row reopened the success token");
  assert.ok(!joined.includes(BG_OPEN.toolErrorBg), "a partial row reopened the error token");
});

test("the shared adapter keeps both wiring-audit markers on the registered callback", () => {
  const render = expandableResult(() => textComponent(["row"]), () => textComponent(["detail"]));
  assert.equal(isExpandableResult(render), true);
  assert.equal(isExpandablePresentation(render), true);
});

test("the repair forwards invalidation and the component's own interaction surface", () => {
  let invalidated = 0;
  const inner = {
    render: (_width: number) => ["streaming row \x1b[0m tail"],
    invalidate: () => {
      invalidated += 1;
    },
    handleMouse: (event: unknown) => `mouse:${JSON.stringify(event)}`,
    handleInput: (data: string) => `input:${data}`,
    wantsKeyRelease: true,
  };
  const render = expandableResult(() => inner, () => inner);
  const component = render({}, { expanded: false, isPartial: false }, bgTheme, {}) as typeof inner;
  assert.deepEqual(component.render(80), [`streaming row \x1b[0m${BG_OPEN.toolSuccessBg} tail`]);
  component.invalidate();
  assert.equal(invalidated, 1);
  assert.equal(component.handleMouse({ x: 1 }), 'mouse:{"x":1}');
  assert.equal(component.handleInput("q"), "input:q");
  assert.equal(component.wantsKeyRelease, true);

  // Without a background accessor the inner component is handed through as-is.
  const passthrough = render({}, { expanded: false, isPartial: false }, noBgTheme, {}) as typeof inner;
  assert.deepEqual(passthrough.render(80), ["streaming row \x1b[0m tail"]);
  assert.equal(passthrough.handleMouse, inner.handleMouse);
});

test("a non-renderable delegate still passes through with the repair active", () => {
  const render = expandableResult(() => undefined, () => undefined);
  assert.equal(render({}, { expanded: false, isPartial: false }, bgTheme, {}), undefined);
});

test("a theme without the accessor, or one that cannot answer, keeps the previous rows", () => {
  const render = expandableResult(
    () => textComponent([RESET_TEXT]),
    () => textComponent([RESET_TEXT, BGR_RESET_TEXT]),
  );
  const baseline = renderAt(render({}, { expanded: true, isPartial: false }, noBgTheme, {}), 200);
  assert.ok(baseline.join("\n").includes("\x1b[0m"), "the degraded output keeps the reset (nothing is stripped)");

  const throwing = { ...bgTheme, getBgAnsi: () => {
    throw new Error("unknown theme color");
  } };
  assert.deepEqual(renderAt(render({}, { expanded: true, isPartial: false }, throwing, {}), 200), baseline);

  const nonString = { ...bgTheme, getBgAnsi: () => undefined as unknown as string };
  assert.deepEqual(renderAt(render({}, { expanded: true, isPartial: false }, nonString, {}), 200), baseline);

  // Reading the accessor itself can throw (a host proxy or a theme with a
  // throwing getter): the rows stay exactly as they were rather than the throw
  // escaping renderResult and pushing the host onto its fallback renderer.
  const throwingAccessor = Object.defineProperty({ ...noBgTheme }, "getBgAnsi", {
    get() { throw new Error("theme accessor unavailable"); },
  });
  assert.deepEqual(renderAt(render({}, { expanded: true, isPartial: false }, throwingAccessor, {}), 200), baseline);
});

test("registered ApplyPatch rows reopen the themed background after retained diff resets", () => {
  const tools: Array<Record<string, any>> = [];
  registerApplyPatchTool({ registerTool: (tool: Record<string, any>) => { tools.push(tool); } });
  const tool = tools.find((candidate) => candidate.name === APPLY_PATCH_TOOL_NAME)!;
  assert.ok(tool, "ApplyPatch was not registered");
  const value = {
    content: [{ type: "text", text: `ApplyPatch partial failure ${RESET_TEXT}` }],
    details: { requestedDiff: `${RESET_TEXT}\n${BGR_RESET_TEXT}`, finalDiff: `${RESET_TEXT}\n${BGR_RESET_TEXT}` },
    isError: true,
  };
  const context = { args: { patch: `*** Begin Patch\n${RESET_TEXT}\n*** End Patch` }, isError: true };
  for (const width of [40, 80]) {
    for (const expanded of [false, true]) {
      const label = `ApplyPatch ${expanded ? "expanded" : "collapsed"} width ${width}`;
      const before = renderAt(tool.renderResult(value, { expanded }, noBgTheme, context), width);
      const after = renderAt(tool.renderResult(value, { expanded }, bgTheme, context), width);
      assert.ok(/\x1b\[(?:0+m|49m)/.test(before.join("")), `${label}: the fixture carries no background-clearing reset`);
      assertReopened(after, BG_OPEN.toolErrorBg, label);
      assertOnlyOpensInserted(before, after, BG_OPEN.toolErrorBg, label);
    }
  }
});

test("registered tool_search rows reopen the themed background after retained outcome resets", () => {
  const deferredTools: Array<Record<string, any>> = [];
  new DeferredToolManager({
    registerTool: (tool: any) => { deferredTools.push(tool); },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
  }).register();
  const tool = deferredTools.find((candidate) => candidate.name === "tool_search")!;
  assert.ok(tool, "tool_search was not registered");
  const value = {
    content: [{ type: "text", text: `Discovery ${RESET_TEXT}` }],
    details: { query: `${RESET_TEXT} ${BGR_RESET_TEXT}`, activated: ["BrowserClick"], alreadyActive: [], refused: [], omitted: 0 },
  };
  const context = { args: { query: `${RESET_TEXT}` } };
  for (const width of [40, 80]) {
    for (const expanded of [false, true]) {
      const label = `tool_search ${expanded ? "expanded" : "collapsed"} width ${width}`;
      const before = renderAt(tool.renderResult(value, { expanded }, noBgTheme, context), width);
      const after = renderAt(tool.renderResult(value, { expanded }, bgTheme, context), width);
      assertReopened(after, BG_OPEN.toolSuccessBg, label);
      assertOnlyOpensInserted(before, after, BG_OPEN.toolSuccessBg, label);
      if (expanded) {
        assert.ok(/\x1b\[(?:0+m|49m)/.test(before.join("")), `${label}: the fixture carries no background-clearing reset`);
      }
    }
  }
});
