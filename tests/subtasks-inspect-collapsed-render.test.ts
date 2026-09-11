import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

// #56: collapsed SubtasksInspect call/result cards. These tests exercise the
// real registered renderers (renderCall/renderResult) with representative
// result details for every navigation mode and assert on the rendered lines —
// they do not re-implement the renderer's formatting logic.

const identityTheme = { bold: (value: string) => value, fg: (_color: string, value: string) => value };
const colorTheme = { bold: (value: string) => value, fg: (color: string, value: string) => `[${color}]${value}` };
const ANSI_COLORS: Record<string, number> = { toolTitle: 39, accent: 45, success: 34, warning: 33, error: 31, dim: 245 };
const ansiTheme = {
  bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
  fg: (color: string, value: string) => `\x1b[38;5;${ANSI_COLORS[color] ?? 7}m${value}\x1b[0m`,
};

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function harness() {
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
    getActiveTools() { return ["read", "bash"]; },
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
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => process.cwd() });
  manager.sync();
  return tools;
}

function inspectTool(tools: Array<Record<string, any>>): Record<string, any> {
  const tool = tools.find((candidate) => candidate.name === "SubtasksInspect");
  assert.ok(tool, "SubtasksInspect was not registered");
  return tool;
}

function renderCall(tool: Record<string, any>, args: unknown, theme: typeof identityTheme, width = 120): string {
  const component = tool.renderCall(args, theme) as { render(width: number): string[] };
  return component.render(width).join("\n");
}

function renderResult(tool: Record<string, any>, value: unknown, options: unknown, theme: typeof identityTheme, width = 120): string {
  const component = tool.renderResult(value, options, theme) as { render(width: number): string[] };
  return component.render(width).join("\n");
}

function entry(index: number, overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    index,
    entryId: `entry-${index}`,
    kind: "tool_call",
    provenance: "executor_observed",
    preview: "PREVIEW-TEXT-MARKER",
    contentBytes: 128,
    ...overrides,
  };
}

function evidenceRead(mode: string, extra: Record<string, any> = {}): Record<string, any> {
  return {
    taskId: "task-t",
    mode,
    snapshot: {
      totalEntries: 43,
      sources: [],
      unavailable: [],
      capability: { toolEvidence: "available" },
      diagnostics: {},
    },
    ...extra,
  };
}

const singleTask = [{ taskId: "task-t", state: "running", definition: { title: "Investigated work" } }];

function inspectResult(evidence: Record<string, any> | undefined, overrides: Record<string, any> = {}): Record<string, any> {
  return {
    content: [{ type: "text", text: "SubtasksInspect: execute group exec-1, 1 active task(s)." }],
    details: {
      action: "inspect",
      executionId: "exec-1",
      kind: "execute",
      tasks: singleTask,
      ...(evidence ? { evidence } : {}),
    },
    isError: false,
    ...overrides,
  };
}

test("collapsed inspect call names the task and plain status mode", () => {
  const rendered = renderCall(inspectTool(harness()), { executionId: "exec-1", taskId: "task-abc123" }, identityTheme);
  assert.match(rendered, /^SubtasksInspect · task task-abc123 · status$/);
});

test("collapsed inspect call distinguishes legacy activity paging from status", () => {
  const rendered = renderCall(inspectTool(harness()), { executionId: "exec-1", taskId: "task-a", offset: 5, lines: 40 }, identityTheme);
  assert.match(rendered, /activity offset=5 lines=40/);
  assert.doesNotMatch(rendered, /· status$/);
});

test("collapsed inspect call summarizes find with its filter", () => {
  const rendered = renderCall(inspectTool(harness()), {
    executionId: "exec-1",
    taskId: "task-a",
    evidence: { find: "E2E-FAILURE-MARKER", filter: "command" },
  }, identityTheme);
  assert.match(rendered, /find "E2E-FAILURE-MARKER" filter command/);
});

test("collapsed inspect call redacts sensitive query text before display", () => {
  const rendered = renderCall(inspectTool(harness()), {
    executionId: "exec-1",
    taskId: "task-a",
    evidence: { find: "password=hunter2 token=abc123def456ghi789" },
  }, identityTheme);
  assert.match(rendered, /\[REDACTED\]/);
  assert.doesNotMatch(rendered, /hunter2/);
  assert.doesNotMatch(rendered, /abc123def456ghi789/);
});

test("collapsed inspect call summarizes ranged reads with their requested window", () => {
  const tool = inspectTool(harness());
  assert.match(renderCall(tool, { taskId: "task-a", evidence: { index: 40, limit: 20 } }, identityTheme), /entries 40\.\.59/);
  // The navigation default (20 entries) applies when the caller omits limit.
  assert.match(renderCall(tool, { taskId: "task-a", evidence: { index: 7 } }, identityTheme), /entries 7\.\.26/);
  assert.match(renderCall(tool, { taskId: "task-a", evidence: { index: 0, limit: 10, filter: "review" } }, identityTheme), /entries 0\.\.9 filter review/);
});

test("collapsed inspect call names cursor continuation without displaying the opaque token", () => {
  const cursor = `ev1.${"opaque".repeat(30)}`;
  const rendered = renderCall(inspectTool(harness()), { taskId: "task-a", evidence: { cursor } }, identityTheme);
  assert.match(rendered, /cursor continuation/);
  assert.doesNotMatch(rendered, new RegExp(cursor.slice(0, 24)));
});

test("collapsed inspect call summarizes entry deep reads and call resolutions", () => {
  const tool = inspectTool(harness());
  assert.match(renderCall(tool, { taskId: "task-a", evidence: { entryId: "turn:0001/line:12", chunkIndex: 2 } }, identityTheme), /entry turn:0001\/line:12 chunk 2/);
  assert.match(renderCall(tool, { taskId: "task-a", evidence: { callId: "toolu_01ABC" } }, identityTheme), /call toolu_01ABC/);
  // Effective-mode precedence matches the navigation read: entryId wins over find.
  const precedence = renderCall(tool, { taskId: "task-a", evidence: { entryId: "e-1", find: "q" } }, identityTheme);
  assert.match(precedence, /entry e-1/);
  assert.doesNotMatch(precedence, /find/);
});

test("long selector values stay redaction-safe and clipped within the card width", () => {
  const rendered = renderCall(inspectTool(harness()), {
    taskId: "task-a",
    evidence: { find: "password=supersecretvalue " + "c".repeat(300) },
  }, ansiTheme, 60);
  for (const line of rendered.split("\n")) {
    assert.ok(stripAnsi(line).length <= 60, `line exceeds width: ${stripAnsi(line).length}`);
  }
  assert.match(rendered, /\[REDACTED\]/);
  assert.doesNotMatch(stripAnsi(rendered), /supersecretvalue/);
  assert.match(stripAnsi(rendered), /…/);
});

test("non-inspect call summaries are unchanged", () => {
  const tools = harness();
  const start = tools.find((tool) => tool.name === "SubtasksStart")!;
  assert.match(renderCall(start, { tasks: [{}, {}, {}] }, identityTheme), /SubtasksStart · 3 tasks/);
  const steer = tools.find((tool) => tool.name === "SubtasksSteer")!;
  assert.match(renderCall(steer, { instructions: "change" }, identityTheme), /SubtasksSteer · steer/);
});

test("collapsed range result reports the returned window, provenance mix, and continuations", () => {
  const entries = Array.from({ length: 20 }, (_unused, index) =>
    entry(index, { provenance: index < 17 ? "executor_observed" : "worker_claim" }));
  const rendered = renderResult(inspectTool(harness()), inspectResult(evidenceRead("range", {
    entries,
    nextIndex: 20,
    cursor: "ev1.watermark",
  })), {}, identityTheme);
  assert.match(rendered, /entries 0–19 of 43 · 17 observed, 3 claims/);
  assert.match(rendered, /next page at index=20 · incremental cursor available/);
  // The group/scheduler boilerplate no longer leads the card.
  assert.doesNotMatch(rendered, /active task\(s\)/);
  // Entry previews are retained content and never appear in the collapsed card.
  assert.doesNotMatch(rendered, /PREVIEW-TEXT-MARKER/);
});

test("collapsed filtered range result omits the unfiltered sequence total", () => {
  const rendered = renderResult(inspectTool(harness()), inspectResult(evidenceRead("range", {
    entries: [entry(5), entry(6)],
    nextIndex: 7,
  })), {}, identityTheme);
  assert.match(rendered, /entries 5–6/);
  assert.doesNotMatch(rendered, /of 43/);
  assert.match(rendered, /next page at index=7/);
  assert.doesNotMatch(rendered, /incremental cursor/);
});

test("collapsed range result reports an empty read as an outcome, not boilerplate", () => {
  const rendered = renderResult(inspectTool(harness()), inspectResult(evidenceRead("range")), {}, identityTheme);
  assert.match(rendered, /no entries in this read/);
  assert.doesNotMatch(rendered, /active task\(s\)/);
});

test("collapsed range result discloses retention-truncated entries", () => {
  const rendered = renderResult(inspectTool(harness()), inspectResult(evidenceRead("range", {
    entries: [entry(0, { truncatedContent: true }), entry(1, { truncatedContent: true }), entry(2)],
    cursor: "ev1.watermark",
  })), {}, identityTheme);
  assert.match(rendered, /2 truncated at retention/);
});

test("collapsed find result reports match totals and list truncation with a redacted query", () => {
  const tool = inspectTool(harness());
  const truncated = renderResult(tool, inspectResult(evidenceRead("find", {
    matches: Array.from({ length: 20 }, (_unused, index) => ({ index, entryId: `e${index}`, kind: "tool_result", snippet: "s" })),
    matchSummary: { query: "password=hunter2", totalMatches: 25, matchesTruncated: true },
  })), {}, identityTheme);
  assert.match(truncated, /25 matches for "[^"]*\[REDACTED\]"/);
  assert.match(truncated, /\(20 shown\)/);
  assert.doesNotMatch(truncated, /hunter2/);

  const single = renderResult(tool, inspectResult(evidenceRead("find", {
    matches: [{ index: 3, entryId: "e3", kind: "claim", snippet: "s" }],
    matchSummary: { query: "E2E-FAILURE-MARKER", totalMatches: 1, matchesTruncated: false },
  })), {}, identityTheme);
  assert.match(single, /1 match for "E2E-FAILURE-MARKER"/);
  assert.doesNotMatch(single, /shown/);
});

test("collapsed find result reports zero matches explicitly", () => {
  const rendered = renderResult(inspectTool(harness()), inspectResult(evidenceRead("find", {
    matches: [],
    matchSummary: { query: "missing-marker", totalMatches: 0, matchesTruncated: false },
  })), {}, identityTheme);
  assert.match(rendered, /no matches for "missing-marker"/);
});

test("collapsed call result distinguishes returned resolution from in-flight calls", () => {
  const tool = inspectTool(harness());
  const returned = renderResult(tool, inspectResult(evidenceRead("call", {
    callPair: {
      call: entry(12, { callId: "toolu_9" }),
      result: entry(13, { kind: "tool_result", callId: "toolu_9" }),
      status: "returned",
    },
  })), {}, identityTheme);
  assert.match(returned, /call toolu_9 · result returned/);

  const inFlight = renderResult(tool, inspectResult(evidenceRead("call", {
    callPair: { call: entry(12, { callId: "toolu_9" }), status: "in_flight" },
  })), {}, identityTheme);
  assert.match(inFlight, /call toolu_9 · in flight, result not observed yet/);
});

test("collapsed call result reports an observed result with unresolved pairing", () => {
  // readCall returns { result: only, status: "in_flight" } for an observed
  // source-scoped result without a validated pair: the card must not deny the
  // existence of a result that was actually observed.
  const rendered = renderResult(inspectTool(harness()), inspectResult(evidenceRead("call", {
    callPair: { result: entry(13, { kind: "tool_result", callId: "item-7" }), status: "in_flight" },
  })), {}, identityTheme);
  assert.match(rendered, /call item-7 · result observed, pairing unresolved/);
  assert.doesNotMatch(rendered, /not observed yet/);
});

test("collapsed entry result summarizes the chunk without dumping retained content", () => {
  const rendered = renderResult(inspectTool(harness()), inspectResult(evidenceRead("entry", {
    deepContent: {
      entryId: "turn:0001/line:12",
      chunkIndex: 1,
      content: "THINKING-BLOCK-CONTENT ".repeat(400),
      hasMore: true,
      nextChunk: 2,
      contentBytes: 256_000,
    },
  })), {}, identityTheme);
  assert.match(rendered, /entry turn:0001\/line:12 · chunk 1 · 9200 chars/);
  assert.match(rendered, /more chunks \(next: 2\)/);
  // The collapsed card never carries retained content or private reasoning.
  assert.doesNotMatch(rendered, /THINKING-BLOCK-CONTENT/);
});

test("collapsed entry result discloses retention truncation and empty chunks", () => {
  const tool = inspectTool(harness());
  const truncated = renderResult(tool, inspectResult(evidenceRead("entry", {
    deepContent: {
      entryId: "e-t",
      chunkIndex: 0,
      content: "abc",
      hasMore: false,
      contentBytes: 256_000,
      truncatedContent: true,
      note: "The source record exceeded the retention cap; retained content may end mid-record.",
    },
  })), {}, identityTheme);
  assert.match(truncated, /source record truncated at retention cap/);

  const empty = renderResult(tool, inspectResult(evidenceRead("entry", {
    deepContent: {
      entryId: "e-t",
      chunkIndex: 3,
      content: "",
      hasMore: false,
      contentBytes: 10,
      note: "No retained content at this chunk; use an earlier chunkIndex.",
    },
  })), {}, identityTheme);
  assert.match(empty, /No retained content at this chunk/);
});

test("collapsed cursor result reports newer entries and the updated continuation without the token", () => {
  const tool = inspectTool(harness());
  const withNewer = renderResult(tool, inspectResult(evidenceRead("cursor", {
    entries: [entry(43), entry(44)],
    cursor: "ev1." + "new".repeat(40),
  })), {}, identityTheme);
  assert.match(withNewer, /2 newer entries/);
  assert.match(withNewer, /updated cursor issued for the next continuation/);
  assert.doesNotMatch(withNewer, /newnewnewnew/);

  const quiet = renderResult(tool, inspectResult(evidenceRead("cursor", {
    cursor: "ev1." + "quiet".repeat(40),
  })), {}, identityTheme);
  assert.match(quiet, /no newer entries/);
  assert.doesNotMatch(quiet, /quietquiet/);
});

test("collapsed result surfaces important unavailable outcomes", () => {
  const tool = inspectTool(harness());
  const noToolEvidence = renderResult(tool, inspectResult({
    ...evidenceRead("range", { entries: [entry(0)] }),
    snapshot: {
      totalEntries: 1,
      sources: [],
      unavailable: [],
      capability: { toolEvidence: "unavailable", reason: "no tool records" },
      diagnostics: {},
    },
  }), {}, identityTheme);
  assert.match(noToolEvidence, /tool evidence unavailable: no tool records/);

  const notes = renderResult(tool, inspectResult(evidenceRead("range", {
    entries: [entry(0)],
    snapshot: {
      totalEntries: 1,
      sources: [],
      unavailable: [
        { source: "reviews", reason: "review_unavailable", detail: "No completed review evidence is available for this task." },
        { source: "artifacts", reason: "artifact_dir_missing", detail: "The task has no artifact directory." },
      ],
      capability: { toolEvidence: "available" },
      diagnostics: {},
    },
  })), {}, identityTheme);
  assert.match(notes, /2 unavailable source note\(s\): review_unavailable, artifact_dir_missing/);
});

test("error results keep native error rendering and skip the evidence summary", () => {
  const tool = inspectTool(harness());
  const failed = {
    content: [{ type: "text", text: "SubtasksInspect failed: No evidence entry \"bad-entry\" exists in this task's current snapshot.\nRecover with a bounded read on task task-t." }],
    details: { action: "inspect", diagnostic: "entry_not_found", executionId: "exec-1", taskId: "task-t", evidenceSelectorError: true },
    isError: true,
  };
  const rendered = renderResult(tool, failed, {}, identityTheme);
  // #93 canonical error card: the operation header with the returned diagnostic.
  assert.match(rendered, /^SubtasksInspect · failed/);
  assert.match(rendered, /diagnostic: entry_not_found/);
  // The diagnostic line is styled with the error color, not success.
  const colored = renderResult(tool, failed, {}, colorTheme);
  assert.ok(colored.split("\n")[1]!.startsWith("[error]"), `expected error styling, got: ${colored.split("\n")[1]}`);
  // No evidence-mode outcome lines are invented for a failed read.
  assert.doesNotMatch(rendered, /entries \d|matches for|newer entr|result returned/);

  const ok = renderResult(tool, inspectResult(evidenceRead("range", { entries: [entry(0)], cursor: "ev1.x" })), {}, colorTheme);
  assert.ok(ok.split("\n")[1]!.startsWith("[success]"), `expected success styling, got: ${ok.split("\n")[1]}`);
});

test("expanded evidence results render the #59 detail view; re-collapsing restores the collapsed card", () => {
  const value = inspectResult(evidenceRead("range", {
    entries: [entry(0), entry(1)],
    nextIndex: 2,
    cursor: "ev1.watermark",
  }));
  // #56 is the collapsed-card experience: without the expansion flag the
  // registered renderer keeps the mode-specific collapsed lines.
  const collapsed = renderResult(inspectTool(harness()), value, {}, identityTheme);
  assert.match(collapsed, /entries 0–1 of 43/);
  assert.match(collapsed, /next page at index=2/);
  assert.doesNotMatch(collapsed, /Retained content chunk/);
  // #59: with the native expansion flag the registered renderer routes to the
  // contributed expanded detail view, and re-collapsing restores the identical
  // collapsed card.
  const expanded = renderResult(inspectTool(harness()), value, { expanded: true }, identityTheme);
  assert.match(expanded, /SubtasksInspect · task-t · range/);
  assert.match(expanded, /Observed evidence \(executor_observed/);
  assert.match(expanded, /PREVIEW-TEXT-MARKER/);
  const recollapsed = renderResult(inspectTool(harness()), value, { expanded: false }, identityTheme);
  assert.equal(recollapsed, collapsed);
});

test("partial results keep the native pending rendering", () => {
  const rendered = renderResult(inspectTool(harness()), inspectResult(evidenceRead("range", { entries: [entry(0)] })), { isPartial: true }, identityTheme);
  // #93 canonical pending card: the operation label with a warning ellipsis.
  assert.match(rendered, /^SubtasksInspect …$/);
  assert.doesNotMatch(rendered, /entries 0/);
});

test("plain status inspection results render the canonical bounded card", () => {
  const rendered = renderResult(inspectTool(harness()), inspectResult(undefined), {}, identityTheme);
  // #93: the summary-first card was replaced by the canonical header plus the
  // inspected task line (taskId · state · title).
  assert.match(rendered, /^SubtasksInspect · task \? · status/);
  assert.match(rendered, /task-t · running · Investigated work/);
  assert.doesNotMatch(rendered, /active task\(s\)/);
});

test("collapsed evidence cards stay within the terminal width for every mode", () => {
  const tool = inspectTool(harness());
  const fixtures: Array<[string, Record<string, any>]> = [
    ["range", evidenceRead("range", {
      entries: Array.from({ length: 5 }, (_unused, index) => entry(index, { provenance: index % 2 ? "worker_claim" : "executor_observed", truncatedContent: true })),
      nextIndex: 5,
      cursor: "ev1.watermark",
    })],
    ["find", evidenceRead("find", {
      matches: [{ index: 0, entryId: "e0", kind: "tool_result", snippet: "s" }],
      matchSummary: { query: "a-very-long-search-query-that-keeps-going-and-going", totalMatches: 31, matchesTruncated: true },
    })],
    ["call", evidenceRead("call", { callPair: { call: entry(12, { callId: `toolu_${"d".repeat(80)}` }), status: "in_flight" } })],
    ["entry", evidenceRead("entry", {
      deepContent: {
        entryId: `turn:${"e".repeat(60)}/line:12`,
        chunkIndex: 4,
        content: "f".repeat(8_000),
        hasMore: true,
        nextChunk: 5,
        contentBytes: 1_000_000,
      },
    })],
    ["cursor", evidenceRead("cursor", { entries: [entry(43)], cursor: "ev1." + "g".repeat(80) })],
  ];
  for (const [mode, evidence] of fixtures) {
    const rendered = renderResult(tool, inspectResult(evidence), {}, ansiTheme, 48);
    for (const line of rendered.split("\n")) {
      assert.ok(stripAnsi(line).length <= 48, `${mode}: line exceeds width (${stripAnsi(line).length}): ${line}`);
    }
  }
});
