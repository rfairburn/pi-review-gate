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
  type ToolResultRenderOptions,
} from "../src/tool-result-expansion";
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
  const expectedNames = [...INTERACTIVE_BROWSER_TOOL_NAMES, "WebFetch", "BrowserExtract", "WebSearch", "search_tools"];
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
