/**
 * Expanded (Ctrl+O) detail-view renderer tests for the Subtasks* family (#59).
 *
 * Everything here runs against actual production surfaces: results are produced
 * by the real registered tools (real controller, real evidence indexing and
 * navigation, real redaction) and rendered through the real expanded callback.
 * No rendering algorithm is replicated in the tests.
 *
 * Shared-mechanism dependency (#57, landed): the registered tools render the
 * collapsed card in the collapsed state because the registration combines this
 * callback as `expandableResult`'s second argument in src/execution/tool.ts —
 * the collapsed rendering must stay byte-identical for non-expanded options,
 * and `expanded: true` must route to this callback through the real registered
 * `renderResult`. The expanded callback carries the native renderResult
 * signature (3-arity, optional context) so it slots directly into the landed
 * `expandableResult(collapsed, expanded)` without adapters.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { normalizeConfig } from "../src/config";
import type { BackgroundExecutionGroup } from "../src/execution/background-group-store";
import { serializeGroupSnapshot, writeGroupSnapshot } from "../src/execution/background-group-store";
import { renderSubtaskResultExpanded } from "../src/execution/subtask-result-expanded";
import { newTask } from "../src/execution/task-state";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

const THEME = { bold: (text: string) => text, fg: (_color: string, text: string) => text };

const EXECUTION_TOOL_NAMES = [
  "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue",
  "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean",
];

type ExecuteTool = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

/**
 * Independent terminal display-width measurement for assertions: East Asian
 * Wide/Fullwidth code points occupy two cells, combining marks and zero-width
 * characters none, everything else one; ANSI escape sequences occupy none.
 */
function displayWidthOf(value: string): number {
  const stripped = value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const wideRanges: Array<[number, number]> = [
    [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
    [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
    [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
    [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
  ];
  const zeroRanges: Array<[number, number]> = [[0x0300, 0x036f], [0xfe00, 0xfe0f]];
  const emojiPresentation = /\p{Emoji_Presentation}/u;
  let width = 0;
  for (const character of stripped) {
    const code = character.codePointAt(0)!;
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff
      || zeroRanges.some(([start, end]) => code >= start && code <= end)) continue;
    if (emojiPresentation.test(String.fromCodePoint(code))) width += 2;
    else if (wideRanges.some(([start, end]) => code >= start && code <= end)) width += 2;
    else width += 1;
  }
  return width;
}

/** Renders through the real expanded callback and returns plain text lines.
 * `context` is the optional native renderResult context (context.args = the
 * actual recorded request fields, exactly as the host passes them). */
function expandedLines(value: unknown, options: unknown = {}, width = 400, context?: unknown): string[] {
  const component = renderSubtaskResultExpanded(
    value,
    options as { expanded?: boolean; isPartial?: boolean },
    THEME,
    context as { args?: unknown } | undefined,
  ) as { render(w: number): string[] };
  assert.ok(component && typeof component.render === "function", "expanded renderer must return a text component");
  const lines = component.render(width) as string[];
  for (const line of lines) {
    const cells = displayWidthOf(line);
    assert.ok(cells <= width, `rendered line must fit ${width} columns (${cells} display cells): ${line}`);
  }
  return lines;
}

function joined(value: unknown, options: unknown = {}, width = 400, context?: unknown): string {
  return expandedLines(value, options, width, context).join("\n");
}

/** Mirrors the production result envelope exactly as the tools produce it. */
function envelope(summary: string, details: Record<string, any>, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text: summary }], details, isError };
}

// ---------------------------------------------------------------------------
// Harness: real registered execution tools with a fake executor
// ---------------------------------------------------------------------------

function harness(options: { notifySink?: (message: string) => void; cwd?: () => string } = {}) {
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
    getActiveTools: () => ["read", "bash", ...EXECUTION_TOOL_NAMES],
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: {
        protocol: "pi-review-executor-jsonl-v1" as const,
        args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{},30000))"],
      },
    }],
    execution: {
      workerResources: [{ resourceId: "default", selection: { source: "external", id: "fake" }, maxConcurrent: 4 }],
    },
  });
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: options.cwd ?? (() => process.cwd()),
    notify: options.notifySink ?? (() => {}),
  });
  manager.sync();
  return { tools, manager };
}

function toolFor(tools: Array<Record<string, any>>, name: string): Record<string, any> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} was not registered`);
  return tool;
}

/** Creates a fresh directory and returns its path for realpath resolution. */
async function mkdirFresh(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

/** Content digest of every file under a tree: expansion must not rewrite any
 * retained artifact, so the tree stays byte-identical. */
async function digestTree(root: string): Promise<Map<string, string>> {
  const digest = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else digest.set(path, createHash("sha256").update(await readFile(path)).digest("hex"));
    }
  };
  await walk(root);
  return digest;
}

// ---------------------------------------------------------------------------
// Production evidence fixture: restored execution groups with real artifacts
// ---------------------------------------------------------------------------

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const PRIVATE_MARKER = "EXPANDED-PRIVATE-THINKING-MARKER";
const SECRET = "supersecretvalue123";
const FAILURE_MARKER = "EXPANDED-FAILURE-MARKER: 3 of 10 tests failed";

interface EvidenceFixture {
  root: string;
  inspect: ExecuteTool;
  inspectTool: Record<string, any>;
  manager: ExecutionToolManager;
}

let evidence: EvidenceFixture | undefined;
const renderedFamilies = new Set<string>();

before(async () => {
  const base = await mkdtemp(join(tmpdir(), "subtask-expanded-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });

  // Group 1: rich evidence (paired call/result, in-flight call, worker claim,
  // process outcome, operation record, review report with a secret to redact).
  const waveRoot = join(base, "wave-1");
  const artifactDir = join(waveRoot, "artifacts", "task-ev");
  await mkdir(join(artifactDir, "executor-sessions"), { recursive: true });
  await mkdir(join(artifactDir, "executor", "0001"), { recursive: true });

  await writeFile(join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`), [
    JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: "2025-06-01T10:00:00.000Z", cwd: "/tmp/wt" }),
    JSON.stringify({
      type: "message", id: "m-1", parentId: null, timestamp: "2025-06-01T10:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `${PRIVATE_MARKER} secret plan details` },
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test -- expanded-fixture" } },
        ],
      },
    }),
    JSON.stringify({
      type: "message", id: "m-2", parentId: "m-1", timestamp: "2025-06-01T10:00:03.000Z",
      message: {
        role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: true, details: {}, usage: null,
        timestamp: "2025-06-01T10:00:03.000Z",
        content: [{ type: "text", text: `${FAILURE_MARKER}\ntoken=${SECRET} leaked into output` }],
      },
    }),
    JSON.stringify({
      type: "message", id: "m-3", parentId: "m-2", timestamp: "2025-06-01T10:00:04.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/a.ts" } }] },
    }),
  ].join("\n") + "\n");

  await writeFile(join(artifactDir, "executor", "0001", "process-result.json"), JSON.stringify({ adapter: "pi-model", code: 1, sessionId: SESSION_ID }));
  // The worker claim is multi-line with significant whitespace: the expanded
  // deep read must preserve it verbatim.
  await writeFile(
    join(artifactDir, "executor", "0001", "final-response.md"),
    [
      "I fixed the failing tests; all suites pass now.",
      "",
      "\tDetail line with\ttab and   internal spacing.",
      "    indented continuation block:",
      "        deeper indentation stays readable.",
      "",
    ].join("\n"),
  );

  const now = "2025-06-01T10:05:00.000Z";
  await writeFile(join(artifactDir, "operation.json"), JSON.stringify({
    version: 1, revision: 2, operationId: "op-ev", waveId: "wave-1", taskId: "task-ev", title: "expanded evidence",
    state: "failed_critical", worktreeRoot: join(base, "worktree"), effectiveCwd: join(base, "worktree"), artifactDir,
    generation: 1, retryBudget: 0,
    assignments: [
      { entryId: "e-1", priority: 0, selection: { source: "pi", model: "model-x" }, generation: 1, reason: "initial", startedAt: "2025-06-01T10:00:00.000Z", endedAt: "2025-06-01T10:04:00.000Z", outcome: "failed" },
    ],
    attempts: [{ attempt: 1, generation: 1, turn: 1, startedAt: "2025-06-01T10:00:01.000Z", endedAt: "2025-06-01T10:04:00.000Z", outcome: "failed", sessionId: SESSION_ID }],
    incidents: [],
    checkpoint: {
      checkpointId: "cp-ev", commitSha: "abc", treeSha: "def", ref: "refs/candidates/task-ev",
      differsFromBase: true, createdAt: now, verified: true, changedPaths: ["src/expanded.ts"],
    },
    instructions: [
      { instructionId: "i-1", sequence: 1, action: "steer", text: "focus on tests", status: "acknowledged", createdAt: "2025-06-01T10:02:00.000Z", acknowledgedAt: "2025-06-01T10:02:05.000Z" },
    ],
    nextInstructionSequence: 2, createdAt: "2025-06-01T10:00:00.000Z", updatedAt: now,
  }));

  const task = newTask({
    title: "expanded evidence",
    instructions: "run the expanded fixture\nthen verify every line survived",
    acceptanceCriteria: ["fixture passes", "every instruction line stays visible"],
    relevantContext: "Context marker: CONTEXT-PROVENANCE-FLAG for the status expansion check.",
  });
  task.taskId = "task-ev";
  task.state = "failed";
  task.waveRoot = waveRoot;
  task.executorSelection = { source: "pi", model: "model-x" };
  task.commands = [{ instructionId: "i-1", action: "steer", actor: "model", status: "acknowledged", createdAt: "2025-06-01T10:02:00.000Z", acknowledgedAt: "2025-06-01T10:02:05.000Z" }];
  // A reviewer summary carrying a secret stays redacted in every view.
  task.result = {
    waveId: "wave-1", waveRoot, sourceRoot, phase: "completed",
    taskResults: [{
      taskId: "task-ev", title: "expanded evidence", status: "accepted", summary: "ok",
      reviewReport: {
        aggregate: "needs_changes", summary: "issues found", reviewCycles: 1, latestReviewSequence: 1,
        reviewers: [{ reviewerId: "reviewer-1", displayLabel: "R1", verdict: "needs_changes", summary: `bug in a.ts token=${SECRET}`, findings: [] }],
        history: [],
      },
    }],
  } as never;

  const resolvedGroupRoot = await realpath(await mkdirFresh(join(base, "pi-review-execution-expanded")));
  const group: BackgroundExecutionGroup = {
    version: 3, revision: 1, integritySha256: "", executionId: "exec-ev", kind: "execute",
    root: resolvedGroupRoot, cwd: sourceRoot, createdAt: "2025-06-01T10:00:00.000Z", updatedAt: now,
    peakConcurrency: 1, tasks: [task],
  };
  await writeGroupSnapshot(resolvedGroupRoot, serializeGroupSnapshot(group, new Map()));

  // Group 2: artifacts exist but no readable streams — the expanded view must
  // disclose the gaps explicitly.
  const emptyWaveRoot = join(base, "wave-2");
  const emptyArtifactDir = join(emptyWaveRoot, "artifacts", "task-empty");
  await mkdir(join(emptyArtifactDir, "executor-sessions"), { recursive: true });
  await mkdir(join(emptyArtifactDir, "executor", "0001"), { recursive: true });
  const emptyTask = newTask({ title: "EMPTY-EVIDENCE-WORK", instructions: "work", acceptanceCriteria: ["done"] });
  emptyTask.taskId = "task-empty";
  emptyTask.state = "failed";
  emptyTask.waveRoot = emptyWaveRoot;
  const resolvedEmptyGroupRoot = await realpath(await mkdirFresh(join(base, "pi-review-execution-expanded-empty")));
  const emptyGroup: BackgroundExecutionGroup = {
    version: 3, revision: 1, integritySha256: "", executionId: "exec-ev-empty", kind: "execute",
    root: resolvedEmptyGroupRoot, cwd: sourceRoot, createdAt: "2025-06-01T10:06:00.000Z", updatedAt: "2025-06-01T10:06:00.000Z",
    peakConcurrency: 1, tasks: [emptyTask],
  };
  await writeGroupSnapshot(resolvedEmptyGroupRoot, serializeGroupSnapshot(emptyGroup, new Map()));

  const { tools, manager } = harness({ cwd: () => sourceRoot });
  const controller = (manager as unknown as { controller: { restore: (value: unknown) => Promise<void> } }).controller;
  await controller.restore({ waveRoots: [], bundles: [], groupRoots: [resolvedGroupRoot, resolvedEmptyGroupRoot] });
  const inspectTool = tools.find((candidate) => candidate.name === "SubtasksInspect")!;
  assert.ok(inspectTool, "SubtasksInspect must be registered");
  evidence = { root: base, inspect: inspectTool.execute as ExecuteTool, inspectTool, manager };
});

after(async () => {
  if (evidence) await evidence.manager.shutdown();
  await rm(join(tmpdir(), "subtask-expanded-"), { recursive: true, force: true });
});

async function runInspect(params: Record<string, unknown>): Promise<Record<string, any>> {
  assert.ok(evidence, "evidence fixture must be initialized");
  const result = await evidence.inspect("expanded-render-test", params, undefined, undefined, {});
  renderedFamilies.add("SubtasksInspect");
  return result;
}

// ---------------------------------------------------------------------------
// Registered wiring: the shared helper selects the expanded callback
// ---------------------------------------------------------------------------

test("the registered tool expands natively and re-collapses to the identical collapsed card", async () => {
  const { tools, manager } = harness();
  try {
    const inspectTool = tools.find((tool) => tool.name === "SubtasksInspect")!;
    const value = envelope("inspect: execution exec-i", {
      action: "inspect", kind: "execute", executionId: "exec-i", updatedAt: "2025-06-01T10:00:00.000Z",
      tasks: [{ taskId: "task-i", state: "running", definition: { title: "In flight work" } }],
    });
    // Native renderResult callback signature: (value, options, theme, context?)
    // with 4 counted parameters — the optional 4th carries the native context
    // (context.args, the actual recorded request fields). Directly assignable
    // to the landed helper's ToolResultRenderer delegate type.
    assert.equal(renderSubtaskResultExpanded.length, 4);
    const inspectRenderer = inspectTool.renderResult as (value: unknown, options: unknown, theme: unknown) => { render(w: number): string[] };
    const collapsed = inspectRenderer(value, {}, THEME).render(200).join("\n");
    assert.match(collapsed, /task-i/);
    // The contributed expanded callback is selected by the native flag.
    const expanded = inspectRenderer(value, { expanded: true }, THEME).render(200).join("\n");
    assert.match(expanded, /SubtasksInspect · \? · status/);
    assert.match(expanded, /task-i · In flight work · running/);
    assert.notEqual(expanded, collapsed);
    // Re-collapsing the same retained result returns to the identical
    // collapsed presentation, and the expanded view is deterministic.
    assert.equal(inspectRenderer(value, { expanded: false }, THEME).render(200).join("\n"), collapsed);
    assert.equal(inspectRenderer(value, { expanded: true }, THEME).render(200).join("\n"), expanded);
  } finally {
    await manager.shutdown();
    await manager.detach();
  }
});

test("expanding then re-collapsing a retained inspect result re-runs nothing", async () => {
  assert.ok(evidence, "evidence fixture must be initialized");
  const inspectTool = evidence.inspectTool;
  const originalExecute = inspectTool.execute as ExecuteTool;
  let executeCalls = 0;
  inspectTool.execute = ((...callArgs: unknown[]) => {
    executeCalls += 1;
    return (originalExecute as unknown as (...rest: unknown[]) => Promise<Record<string, any>>)(...callArgs);
  }) as ExecuteTool;
  try {
    // One real retained inspection through the registered tool (counted by the
    // wrapper, so any re-execution during rendering would also be observed).
    const page = await (inspectTool.execute as ExecuteTool)("expand-collapse-test", { executionId: "exec-ev", taskId: "task-ev", evidence: { index: 0, limit: 20 } }, undefined, undefined, {});
    renderedFamilies.add("SubtasksInspect");
    assert.equal(page.isError, false);

    // Capture the retained artifacts on disk before any expansion.
    const before = await digestTree(evidence.root);

    const inspectRenderer = inspectTool.renderResult as (value: unknown, options: unknown, theme: unknown) => { render(w: number): string[] };
    const collapsedBefore = inspectRenderer(page, {}, THEME).render(300).join("\n");
    // #56: the collapsed card leads with the mode-specific evidence outcome.
    assert.match(collapsedBefore, /entries \d+–\d+ of \d+/);

    // Expand the same retained result object, then re-collapse it.
    const expanded = inspectRenderer(page, { expanded: true }, THEME).render(300).join("\n");
    assert.match(expanded, /SubtasksInspect · task-ev · range/);
    assert.match(expanded, /Observed evidence \(executor_observed/);
    const collapsedAfter = inspectRenderer(page, { expanded: false }, THEME).render(300).join("\n");

    // The collapsed summaries are unchanged by the expand/re-collapse round
    // trip, the expanded view of the same object is deterministic, and the
    // render path never re-executed the tool or modified any retained
    // artifact on disk (the measured guarantees; read-only presentation by
    // construction — the renderer receives only the already-returned result).
    assert.equal(collapsedAfter, collapsedBefore);
    assert.equal(inspectRenderer(page, { expanded: true }, THEME).render(300).join("\n"), expanded);
    assert.equal(executeCalls, 1, "expansion must not re-execute the inspect tool");
    assert.deepEqual(await digestTree(evidence.root), before, "expansion must not rewrite retained artifacts on disk");
  } finally {
    inspectTool.execute = originalExecute;
  }
});

// ---------------------------------------------------------------------------
// Lifecycle: partial results, unrecognized shapes, and non-record values
// ---------------------------------------------------------------------------

test("partial results render the bounded pending view and never detail from a half-shaped payload", () => {
  const value = envelope("SubtasksStart accepted: details still streaming", { partial: true });
  const text = expandedLines(value, { isPartial: true }, 200).join("\n");
  assert.match(text, /result still streaming/);
  assert.match(text, /Expanded detail becomes available once the operation returns/);
  assert.doesNotMatch(text, /expanded result/);
});

test("unrecognized and non-record values fall back to the returned summary only", () => {
  // A recognized bare acknowledgement (SubtasksMarkClean returns { cleared,
  // paths } with no action tag) renders its returned operation fields.
  const bare = joined(envelope("mark_clean: nothing to clear", { cleared: false, paths: [] }));
  assert.match(bare, /SubtasksMarkClean/);
  assert.match(bare, /Conflict gate: none active/);
  assert.match(bare, /Validated paths: \(none\)/);
  const shapeless = joined(envelope("some tool ran", { unrelated: true }));
  assert.match(shapeless, /some tool ran/);
  assert.match(shapeless, /No expandable Subtasks details were returned/);
  const undefinedValue = expandedLines(undefined);
  assert.ok(undefinedValue.join("\n").includes("No execution result."));
});

test("the lifecycle card labels the selected target workspace and no parent-session directory", () => {
  // root is the temporary execution-record storage; cwd is the persisted
  // selected target checkout; the live projection carries the resolved target.
  const base = {
    action: "start",
    executionId: "exec-target-distinct",
    kind: "execute",
    root: "/tmp/pi-review-execution-storage-123",
    cwd: "/work/target-checkout",
    tasks: [{ taskId: "task-t1", state: "queued", definition: { title: "Targeted work" } }],
  };
  const restored = joined(envelope("SubtasksStart accepted: execution exec-target-distinct (1 task(s)).", { ...base }), { expanded: true });
  assert.match(restored, /Target workspace: \/work\/target-checkout/);
  assert.ok(!restored.includes("pi-review-execution-storage-123"), "execution storage must never be labeled as the target");
  assert.doesNotMatch(restored, /Session directory/, "the removed parent-session label must not return");
  const live = joined(envelope("SubtasksStart accepted: execution exec-target-distinct (1 task(s)).", {
    ...base,
    dispatchView: { executionId: "exec-target-distinct", kind: "execute", targetWorkspace: "/live/target-resolved", tasks: [] },
  }), { expanded: true });
  assert.match(live, /Target workspace: \/live\/target-resolved/);
});

// ---------------------------------------------------------------------------
// Family inventory: every Subtasks* operation's production envelope renders
// ---------------------------------------------------------------------------

test("all nine Subtasks* operations produce envelopes that render through the expanded callback", async () => {
  const { tools, manager } = harness();
  try {
    const execute = (name: string) => {
      const tool = toolFor(tools, name);
      return tool.execute as ExecuteTool;
    };
    const started = await execute("SubtasksStart")("start-expanded", {
      tasks: [
        { title: "EXPANDED-FIRST", instructions: "bounded work", acceptanceCriteria: ["done"] },
        { title: "EXPANDED-SECOND", instructions: "bounded work", acceptanceCriteria: ["done"] },
      ],
    }, undefined, undefined, {});
    renderedFamilies.add("SubtasksStart");
    const executionId = started.details.executionId;
    const firstTaskId = started.details.tasks[0].taskId;

    const added = await execute("SubtasksAdd")("add-expanded", {
      executionId,
      tasks: [{ title: "EXPANDED-ADDED", instructions: "bounded work", acceptanceCriteria: ["done"] }],
    }, undefined, undefined, {});
    renderedFamilies.add("SubtasksAdd");

    const inspected = await execute("SubtasksInspect")("inspect-expanded", {
      executionId, taskId: firstTaskId, offset: 0, lines: 5,
    }, undefined, undefined, {});
    renderedFamilies.add("SubtasksInspect");

    const watch = await execute("SubtasksWatch")("watch-expanded", { executionId, after: "30s" }, undefined, undefined, {});
    renderedFamilies.add("SubtasksWatch");

    const steered = await execute("SubtasksSteer")("steer-expanded", {
      executionId, taskId: firstTaskId, instructions: "adjust course", instructionId: "instr-expanded-1",
    }, undefined, undefined, {});
    renderedFamilies.add("SubtasksSteer");

    const interrupted = await execute("SubtasksInterrupt")("interrupt-expanded", {
      executionId, taskId: firstTaskId, interruptMode: "interrupt_as_failure",
    }, undefined, undefined, {});
    renderedFamilies.add("SubtasksInterrupt");

    const continued = await execute("SubtasksContinue")("continue-expanded", {
      executionId, taskId: firstTaskId, instructions: "resume from the checkpoint",
    }, undefined, undefined, {});
    renderedFamilies.add("SubtasksContinue");

    const forceMerged = await execute("SubtasksForceMerge")("force-merge-expanded", {
      executionId, taskId: firstTaskId,
    }, undefined, undefined, {});
    renderedFamilies.add("SubtasksForceMerge");

    const markClean = await execute("SubtasksMarkClean")("mark-clean-expanded", {}, undefined, undefined, {});
    renderedFamilies.add("SubtasksMarkClean");

    for (const familyEnvelope of [started, added, inspected, watch, steered, interrupted, continued, forceMerged, markClean]) {
      expandedLines(familyEnvelope, { expanded: true }, 240);
    }

    // Start envelope expanded: the submitted definitions and the truthful
    // queued/dispatch provenance (dispatch record integration pending).
    const startText = joined(started, {}, 240);
    assert.match(startText, /SubtasksStart · exec\S* · (queued|capturing|running)/);
    assert.match(startText, /Submitted instructions:/);
    assert.match(startText, /bounded work/);
    assert.match(startText, /Acceptance criteria:/);
    assert.match(startText, /- done/);
    assert.match(startText, /Dispatch: (not yet started|dispatched to executor transport|no capture in this returned record)/);
    assert.match(startText, /Captured base commit: (not yet available|not available in this record)/);
    assert.match(startText, /Worker worktree: (not yet created|\S+)/);
    assert.match(startText, /Prompt sent to worker: (not yet sent|not recorded in this inspection)/);

    // Steer envelope: the full sent instruction and transport-only delivery.
    const steerText = joined(steered, {}, 240);
    assert.match(steerText, /SubtasksSteer · /);
    assert.match(steerText, /Submitted instructions:/);
    assert.match(steerText, /adjust course/);
    assert.match(steerText, /Interrupt first: no/);
    assert.match(steerText, /Delivery: (transport acknowledged|delivered by transport|queued for transport)/);
    // Transport-only acknowledgment: the compliance disclaimer appears exactly
    // when a transport acknowledgment/delivery is claimed.
    if (/transport acknowledged|delivered by transport/.test(steerText)) {
      assert.match(steerText, /Task compliance: not established by acknowledgment/);
    } else {
      assert.doesNotMatch(steerText, /Task compliance:/);
    }

    // Interrupt envelope: exact request mode and established outcomes only.
    const interruptText = joined(interrupted, {}, 240);
    assert.match(interruptText, /SubtasksInterrupt · /);
    assert.match(interruptText, /Requested mode: interrupt_as_failure/);
    assert.match(interruptText, /Workspace changes: (not landed|conflict markers materialized in main|landed)/);

    // Watch acknowledgement: requested checkpoint and one-shot semantics.
    const watchText = joined(watch, {}, 240);
    assert.match(watchText, /SubtasksWatch · /);
    assert.match(watchText, /Requested checkpoint: after 30 seconds/);
    assert.match(watchText, /Watch: armed/);
    assert.match(watchText, /Kind: one-shot notification/);
    assert.match(watchText, /Task completion\/failure notifications: independent of this watch/);
    assert.match(watchText, /Replaced the prior watch for this execution: no/);

    // Mark-clean acknowledgement: actual operation data, no guessed workspace.
    const markCleanText = joined(markClean, {}, 240);
    assert.match(markCleanText, /SubtasksMarkClean/);
    assert.match(markCleanText, /Conflict gate: (none active|cleared)/);
    assert.match(markCleanText, /Validated paths: /);
    assert.match(markCleanText, /Workspace identity: not named by this acknowledgement/);
  } finally {
    await manager.shutdown();
    await manager.detach();
  }
});

// ---------------------------------------------------------------------------
// Error results: diagnostics, recovery, and scoped evidence failures
// ---------------------------------------------------------------------------

test("genuine failure envelopes expand with diagnostic, source workspace, recovery, and durable state", async () => {
  const { tools, manager } = harness();
  try {
    const start = toolFor(tools, "SubtasksStart").execute as ExecuteTool;
    const steer = toolFor(tools, "SubtasksSteer").execute as ExecuteTool;
    await start("err-start", {
      tasks: [{ title: "ERR-GROUP-WORK", instructions: "bounded work", acceptanceCriteria: ["done"] }],
    }, undefined, undefined, {});
    const failed = await steer("err-steer", {
      executionId: "exec-missing", taskId: "task-missing", instructions: "hello",
    }, undefined, undefined, {});
    assert.equal(failed.isError, true);
    const text = joined(failed, {}, 300);
    assert.match(text, /SubtasksSteer · failed/);
    assert.match(text, /diagnostic: /);
    assert.match(text, /source workspace: /);
    assert.match(text, /Recovery guidance \(returned with the failure\):/);
    assert.match(text, /SubtasksInspect/);
    assert.match(text, /Durable execution state as of the failure/);
    assert.match(text, /ERR-GROUP-WORK/);
  } finally {
    await manager.shutdown();
    await manager.detach();
  }
});

test("evidence selector failures stay task-scoped in the expanded view", async () => {
  const { tools, manager } = harness();
  try {
    const start = toolFor(tools, "SubtasksStart").execute as ExecuteTool;
    const inspect = toolFor(tools, "SubtasksInspect").execute as ExecuteTool;
    const target = await start("scoped-start", {
      tasks: [{ title: "SCOPED-TARGET-WORK", instructions: "bounded work", acceptanceCriteria: ["done"] }],
    }, undefined, undefined, {});
    await start("scoped-unrelated", {
      tasks: [{ title: "UNRELATED-EXPANDED-TITLE", instructions: "bounded work", acceptanceCriteria: ["done"] }],
    }, undefined, undefined, {});
    const failed = await inspect("scoped-inspect", {
      executionId: target.details.executionId,
      taskId: target.details.tasks[0].taskId,
      evidence: { callId: "no-such-call-id" },
    }, undefined, undefined, {});
    assert.equal(failed.isError, true);
    const text = joined(failed, {}, 300);
    assert.match(text, /SubtasksInspect · failed/);
    assert.match(text, /Task-scoped evidence navigation failure: no other execution's state is included by design/);
    // #61: neither the authorized task's own inventory nor any other group's
    // state may appear beyond the returned diagnostic.
    assert.ok(!text.includes("SCOPED-TARGET-WORK"), "scoped errors must not leak the task inventory");
    assert.ok(!text.includes("UNRELATED-EXPANDED-TITLE"), "scoped errors must not leak unrelated groups");
  } finally {
    await manager.shutdown();
    await manager.detach();
  }
});

// ---------------------------------------------------------------------------
// Evidence inspection: the retained page, provenance separation, links, context
// ---------------------------------------------------------------------------

test("evidence inspect expands the retained page with separated provenance, redaction, and privacy intact", async () => {
  const page = await runInspect({ executionId: "exec-ev", taskId: "task-ev", evidence: { index: 0, limit: 20 } });
  assert.equal(page.isError, false);
  const text = joined(page, {}, 300);

  // Header, identity, and freshness.
  assert.match(text, /SubtasksInspect · task-ev · range/);
  assert.match(text, /Request:/);
  assert.match(text, /Evidence selector: /);
  assert.match(text, /Snapshot as of 20\d\d-.+ — a point-in-time read; live work may have advanced\./);
  assert.match(text, /execution exec-ev \(execute\) · revision \d+/);
  assert.match(text, /Target workspace: /);
  assert.match(text, /Snapshot as of 20\d\d-.+ — a point-in-time read; live work may have advanced\./);
  assert.match(text, /Evidence read \(mode: range\)/);
  // Freshness uncertainty is scoped to active work; a failed task is settled.
  assert.doesNotMatch(text, /still active/);

  // Provenance separation is visible with the correct entries in each section.
  assert.match(text, /Observed evidence \(executor_observed/);
  assert.match(text, /Worker claims \(worker_claim/);
  assert.match(text, /Reviewer verdicts \(reviewer_verdict/);
  assert.match(text, /tool_call · bash · returned/);
  assert.match(text, /I fixed the failing tests; all suites pass now\./);

  // Call/result links: the paired call and the unpaired in-flight call.
  assert.match(text, /paired with: /);
  assert.match(text, /callId call-2/);

  // Authoritative context from durable records.
  assert.match(text, /Authoritative context \(durable records/);
  assert.match(text, /authoritative state: failed/);
  assert.match(text, /changed files \(unlanded, authoritative landing state\): paths: src\/expanded\.ts/);
  assert.match(text, /assignments: current: pi-model\/model-x; initial@2025-06-01T10:00:00 \(pi-model\)/);
  assert.match(text, /attempts: #1\/turn 1 failed/);
  assert.match(text, /steering: steer i-1 · acknowledged/);
  assert.match(text, /review \(official verdicts\): aggregate needs_changes over 1 cycle; latest reviewers: reviewer-1=needs_changes/);
  assert.match(text, /inspected task task-ev · durable state failed/);

  // Continuation disclosure: a cursor is issued for unfiltered reads; the
  // bounded-page nextIndex continuation is covered by the long-page test.
  assert.match(text, /incremental cursor/);

  // Privacy and redaction hold in the expanded view.
  assert.ok(!text.includes(PRIVATE_MARKER), "private reasoning must never be rendered");
  assert.ok(!text.includes(SECRET), "raw secrets must never be rendered");
});

test("the in-flight call pair reports an unobserved result honestly", async () => {
  const pair = await runInspect({ executionId: "exec-ev", taskId: "task-ev", evidence: { callId: "call-2" } });
  const text = joined(pair, {}, 300);
  assert.match(text, /Call\/result link \(callId navigation/);
  assert.match(text, /call call-2: status in_flight/);
  assert.match(text, /result: not observed yet \(in flight\)\. A later in-flight status is never evidence of success\./);
});

test("the returned call/result pair keeps its linked statuses", async () => {
  const pair = await runInspect({ executionId: "exec-ev", taskId: "task-ev", evidence: { callId: "call-1" } });
  const text = joined(pair, {}, 300);
  assert.match(text, /call call-1: status returned/);
  assert.match(text, /result \[\d+\] .+ · failed: /);
});

test("find reads render bounded matches with the returned summary", async () => {
  const found = await runInspect({ executionId: "exec-ev", taskId: "task-ev", evidence: { find: "EXPANDED-FAILURE-MARKER" } });
  const text = joined(found, {}, 300);
  assert.match(text, /Matches for "EXPANDED-FAILURE-MARKER": \d+ total/);
  assert.match(text, /match \[\d+\] /);
  assert.ok(!joined(found).includes(PRIVATE_MARKER));
});

test("deep reads render the retained chunk with verbatim whitespace and continuation notes", async () => {
  const page = await runInspect({ executionId: "exec-ev", taskId: "task-ev", evidence: { index: 0, limit: 20 } });
  const claimEntry = (page.details.evidence.entries as Array<Record<string, any>>)
    .find((entry) => entry.kind === "claim");
  assert.ok(claimEntry, "the worker claim entry must be in the returned page");
  const deep = await runInspect({
    executionId: "exec-ev", taskId: "task-ev",
    evidence: { entryId: claimEntry.entryId, chunkIndex: 0 },
  });
  const text = joined(deep, {}, 300);
  assert.match(text, /Retained content chunk \(deep read .+ · chunk 0 · \d+ retained byte\(s\)\) — verbatim whitespace:/);
  // Whitespace fidelity: tabs and multi-space runs survive presentation.
  assert.ok(text.includes("\tDetail line with\ttab and   internal spacing."), "tab and spacing must be preserved verbatim");
  assert.ok(text.includes("    indented continuation block:"), "indentation must be preserved verbatim");
  assert.ok(text.includes("        deeper indentation stays readable."));
  assert.ok(!text.includes(SECRET));
});

test("unavailable evidence ranges are disclosed instead of silently missing", async () => {
  const restored = await runInspect({ executionId: "exec-ev-empty", taskId: "task-empty", evidence: { index: 0, limit: 10 } });
  assert.equal(restored.isError, false);
  const text = joined(restored, {}, 300);
  assert.match(text, /unavailable \(disclosed gaps; upstream retention, not display clipping\):/);
  assert.match(text, /missing_stream/);
});

// ---------------------------------------------------------------------------
// Status inspection: the submitted task definition is part of the expansion
// ---------------------------------------------------------------------------

test("status inspection expands the submitted definitions of the inspected task", async () => {
  const status = await runInspect({ executionId: "exec-ev", taskId: "task-ev" });
  assert.equal(status.isError, false);
  const text = joined(status, {}, 300);
  // The submitted definition — multiline instructions, every criterion, and
  // the relevant context — is already returned and must be visible in full.
  assert.match(text, /Submitted instructions:/);
  assert.match(text, /run the expanded fixture/);
  assert.match(text, /then verify every line survived/);
  assert.match(text, /Acceptance criteria:/);
  assert.match(text, /- fixture passes/);
  assert.match(text, /- every instruction line stays visible/);
  assert.match(text, /Relevant context:/);
  assert.match(text, /CONTEXT-PROVENANCE-FLAG/);
});

// ---------------------------------------------------------------------------
// Steering provenance: queued steering is never labeled as sent
// ---------------------------------------------------------------------------

test("queued steering without a live executor says not yet sent, not instruction sent", () => {
  const value = envelope("SubtasksSteer: execute group exec-q, 1 active task(s).", {
    action: "steer",
    executionId: "exec-queued",
    kind: "execute",
    tasks: [{
      taskId: "task-queued",
      state: "queued",
      definition: { title: "Queued work" },
      commands: [{
        instructionId: "steer-queued", action: "steer", actor: "model",
        text: "Redirect to the focused regression.", status: "queued", createdAt: "2025-06-01T10:00:00.000Z",
      }],
    }],
  });
  const text = joined(value, { expanded: true }, 300, { args: { taskId: "task-queued", instructions: "Redirect to the focused regression.", instructionId: "steer-queued" } });
  assert.match(text, /Submitted instructions:/);
  assert.match(text, /Redirect to the focused regression\./);
  assert.match(text, /Delivery: queued for transport \(not yet delivered\)/);
  assert.match(text, /Instruction sent to the worker: not yet sent/);
  assert.doesNotMatch(text, /Instruction sent:$/);
  assert.doesNotMatch(text, /Task compliance:/);
});

test("transport-acknowledged steering keeps the compliance disclaimer", () => {
  const value = envelope("SubtasksSteer: execute group exec-s, 1 active task(s).", {
    action: "steer",
    executionId: "exec-steer",
    kind: "execute",
    tasks: [{
      taskId: "task-steer",
      state: "running",
      definition: { title: "Steered work" },
      commands: [{
        instructionId: "steer-ack", action: "steer", actor: "model",
        text: "Stop the stress run.", status: "acknowledged", createdAt: "2025-06-01T10:00:00.000Z",
        acknowledgedAt: "2025-06-01T10:00:05.000Z",
      }],
    }],
  });
  const text = joined(value, { expanded: true }, 300, { args: { taskId: "task-steer", instructions: "Stop the stress run.", instructionId: "steer-ack" } });
  assert.match(text, /Submitted instructions:/);
  assert.match(text, /Delivery: transport acknowledged/);
  assert.match(text, /Instruction sent to the worker: yes/);
  assert.match(text, /Task compliance: not established by acknowledgment/);
});

// ---------------------------------------------------------------------------
// Long results: bounded expansion with explicit omissions
// ---------------------------------------------------------------------------

test("long task lists render every returned task without an expanded-view cap", () => {
  const tasks = Array.from({ length: 30 }, (_unused, index) => ({
    taskId: `task-b${index}`,
    state: "running",
    definition: { title: `Bounded work ${index}` },
  }));
  const value = envelope("SubtasksInspect: bounded tasks", {
    action: "inspect", kind: "execute", executionId: "exec-b", revision: 9, updatedAt: "2025-06-01T10:00:00.000Z",
    tasks,
  });
  const text = joined(value, {}, 200);
  // Expansion adds no presentation cap on top of the returned page.
  assert.match(text, /task-b29 · Bounded work 29 · running/);
  assert.doesNotMatch(text, /omitted from this expanded view/);
});

test("long evidence pages render every returned entry, source, and gap note", () => {
  const entries = Array.from({ length: 15 }, (_unused, index) => ({
    index,
    entryId: `entry-b${index}`,
    kind: "tool_result",
    status: "returned",
    provenance: "executor_observed",
    preview: `observed result ${index} — ${"x".repeat(50)}`,
    contentBytes: 100,
    source: { sourceId: "session:1", adapter: "pi-model", stream: "session" },
  }));
  const value = envelope("SubtasksInspect: bounded evidence page", {
    action: "inspect", kind: "execute", executionId: "exec-b", revision: 9, updatedAt: "2025-06-01T10:00:00.000Z",
    tasks: [],
    evidence: {
      mode: "range",
      taskId: "task-b0",
      snapshot: {
        totalEntries: 40,
        sources: Array.from({ length: 15 }, (_u, index) => ({ sourceId: `session:${index}`, adapter: "pi-model", stream: "session", records: index + 1 })),
        unavailable: Array.from({ length: 12 }, (_u, index) => ({ source: `turn-${index}`, reason: "missing_stream", detail: `gap ${index}` })),
        capability: { toolEvidence: "available" },
        diagnostics: { recordsScanned: 40, oversizedRecords: 1, skippedRecords: 2 },
      },
      entries,
      nextIndex: 15,
    },
  });
  const text = joined(value, {}, 240);
  assert.match(text, /entry-b14/);
  assert.match(text, /source session:14/);
  assert.match(text, /turn-11 · missing_stream · gap 11/);
  assert.doesNotMatch(text, /omitted from this expanded view/);
  assert.match(text, /more entries available: continue the ranged read with index=15/);
});

test("an extreme payload renders completely: the guard is gone and the final sentinel is visible", () => {
  const tasks = Array.from({ length: 60 }, (_unused, index) => ({
    taskId: `task-c${index}`,
    state: "running",
    definition: { title: `Cap work ${index}` },
    summary: `outcome ${index}`,
    commands: Array.from({ length: 6 }, (_u, command) => ({ instructionId: `i-${index}-${command}`, action: "steer", status: "queued", createdAt: "2025-06-01T10:00:00.000Z" })),
    activity: Array.from({ length: 100 }, (_u, event) => ({ sequence: event, phase: "running", message: `event ${event} for task ${index}` })),
  }));
  const value = envelope("SubtasksInspect: cap stress result", {
    action: "inspect", kind: "execute", executionId: "exec-c", revision: 9, updatedAt: "2025-06-01T10:00:00.000Z",
    tasks,
  });
  const text = joined(value, {}, 200);
  // No presentation-side cap: the payload is far beyond the old 5,000-line
  // budget, and its final sentinel still renders.
  assert.doesNotMatch(text, /expanded view truncated/);
  assert.match(text, /task-c59 · Cap work 59 · running/);
  assert.match(text, /event 99 for task 59/);
});

test("long retained lines wrap into width-safe rows without dropping characters", () => {
  const value = envelope("SubtasksInspect: deep chunk", {
    action: "inspect", kind: "execute", executionId: "exec-b", updatedAt: "2025-06-01T10:00:00.000Z",
    evidence: {
      mode: "entry", taskId: "task-b0",
      snapshot: { totalEntries: 1, sources: [], unavailable: [], capability: { toolEvidence: "available" }, diagnostics: { recordsScanned: 1, oversizedRecords: 0, skippedRecords: 0 } },
      deepContent: { entryId: "entry-b0", chunkIndex: 0, content: "y".repeat(500), hasMore: false, contentBytes: 500 },
    },
  });
  const lines = expandedLines(value, {}, 120);
  const plain = lines.map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ""));
  for (const line of plain) {
    assert.ok(displayWidthOf(line) <= 120, `rendered row exceeds width: ${displayWidthOf(line)} cells`);
  }
  // Wrapping, not clipping: every character survives; the full run is
  // recoverable from the wrapped rows (4-space indent + 500 y's = 504 cells →
  // split across rows that concatenate back to the original characters).
  assert.doesNotMatch(plain.join(""), /…/, "no character may be replaced by an ellipsis");
  assert.ok(plain.join("").includes("y".repeat(500)), "all 500 characters must survive wrapping contiguously");
});

test("long submitted instructions and evidence previews wrap at ordinary terminal widths", () => {
  // A long single-line instruction rendered at an ordinary terminal width:
  // wrapping must keep the final sentinel visible (no suffix loss).
  const sentinel = "END-OF-INSTRUCTION-SENTINEL";
  const longInstruction = `Fix the renderer. ${"Detail sentence. ".repeat(20)}${sentinel}`;
  const startEnvelope = envelope("SubtasksStart accepted: execution exec-long, 1 active task(s).", {
    action: "start",
    executionId: "exec-long",
    kind: "execute",
    root: "/work/project",
    cwd: "/work/project",
    tasks: [{ taskId: "task-long", state: "queued", definition: { title: "Long work", instructions: longInstruction, acceptanceCriteria: ["done"] } }],
  });
  const startText = joined(startEnvelope, { expanded: true }, 80, { args: { tasks: [{ title: "Long work", instructions: longInstruction, acceptanceCriteria: ["done"] }] } });
  assert.ok(startText.includes(sentinel), "a wrapped long instruction keeps its final sentinel at width 80");

  // A long single-line evidence preview at the same width: same guarantee.
  const previewSentinel = "END-OF-PREVIEW-SENTINEL";
  const longPreview = `observed result ${"x".repeat(200)} ${previewSentinel}`;
  const evidenceEnvelope = envelope("SubtasksInspect: long preview", {
    action: "inspect", kind: "execute", executionId: "exec-b", updatedAt: "2025-06-01T10:00:00.000Z",
    tasks: [],
    evidence: {
      mode: "range", taskId: "task-b0",
      snapshot: { totalEntries: 1, sources: [], unavailable: [], capability: { toolEvidence: "available" }, diagnostics: { recordsScanned: 1, oversizedRecords: 0, skippedRecords: 0 } },
      entries: [{ index: 0, entryId: "entry-b0", kind: "tool_result", status: "returned", provenance: "executor_observed", preview: longPreview, contentBytes: 220, source: { sourceId: "session:1", adapter: "pi-model", stream: "session" } }],
    },
  });
  const evidenceText = joined(evidenceEnvelope, { expanded: true }, 80);
  // Wrapping is a pure row split: the sentinel may land across a row break,
  // so reconstruct the rows to prove the complete suffix survived.
  assert.ok(evidenceText.split("\n").join("").includes(previewSentinel), "a wrapped long evidence preview keeps its final sentinel at width 80");
});

test("expanded lines are lossless: multiline criteria and repeated-space queries keep their exact whitespace", () => {
  // A multiline acceptance criterion with internal repeated spaces: the
  // expanded view must show the exact characters, including the line break
  // and the space runs, not a whitespace-compacted rewrite.
  const criterion = "first criterion line\nsecond line with   triple   spaces";
  const value = envelope("SubtasksStart accepted: execution exec-ws, 1 active task(s).", {
    action: "start",
    executionId: "exec-ws",
    kind: "execute",
    root: "/work/project",
    tasks: [{ taskId: "task-ws", state: "queued", definition: { title: "Whitespace work", instructions: "bounded", acceptanceCriteria: [criterion] } }],
  });
  const text = joined(value, { expanded: true }, 200);
  assert.match(text, /- first criterion line\n/, "the criterion's line boundary must survive");
  assert.match(text, /second line with   triple   spaces/, "repeated internal spaces must survive verbatim");
  assert.doesNotMatch(text, /first criterion line second line/, "the line break must not be compacted away");

  // A find query containing repeated spaces is a different query after
  // compaction; the request description and match summary must show it exactly.
  const query = "marker  with  double spaces";
  const findEnvelope = envelope("SubtasksInspect: whitespace query", {
    action: "inspect", kind: "execute", executionId: "exec-ws", updatedAt: "2025-06-01T10:00:00.000Z",
    tasks: [],
    evidence: {
      mode: "find", taskId: "task-ws",
      snapshot: { totalEntries: 1, sources: [], unavailable: [], capability: { toolEvidence: "available" }, diagnostics: { recordsScanned: 1, oversizedRecords: 0, skippedRecords: 0 } },
      matches: [{ index: 0, entryId: "entry-ws", kind: "tool_result", snippet: "s" }],
      matchSummary: { query, totalMatches: 1, matchesTruncated: false },
    },
  });
  const findText = joined(findEnvelope, { expanded: true }, 200, { args: { evidence: { find: query } } });
  assert.ok(findText.includes(`find "${query}"`), "the request selector must carry the exact query spaces");
  assert.ok(findText.includes(`Matches for "${query}": 1 total`), "the match summary must carry the exact query spaces");
});

test("content exceeding 5,000 rendered lines stays complete", () => {
  const lines = Array.from({ length: 6000 }, (_unused, index) => `chunk-line-${index}`);
  const value = envelope("SubtasksInspect: oversized deep chunk", {
    action: "inspect", kind: "execute", executionId: "exec-over", updatedAt: "2025-06-01T10:00:00.000Z",
    evidence: {
      mode: "entry", taskId: "task-b0",
      snapshot: { totalEntries: 1, sources: [], unavailable: [], capability: { toolEvidence: "available" }, diagnostics: { recordsScanned: 1, oversizedRecords: 0, skippedRecords: 0 } },
      deepContent: { entryId: "entry-b0", chunkIndex: 0, content: lines.join("\n"), hasMore: false, contentBytes: 90_000 },
    },
  });
  const text = joined(value, {}, 200);
  assert.doesNotMatch(text, /expanded view truncated/);
  assert.match(text, /chunk-line-5999/);
});

test("narrow widths are honored: no line exceeds the supplied column count", () => {
  const value = envelope("SubtasksInspect: narrow width result", {
    action: "inspect", kind: "execute", executionId: "exec-n", revision: 1, updatedAt: "2025-06-01T10:00:00.000Z",
    tasks: [{
      taskId: "task-n1", state: "running", definition: { title: "Narrow work with a fairly long descriptive title" },
      summary: "a fairly long authoritative outcome sentence that must clip at every width",
      activity: [{ sequence: 1, phase: "running", message: "a long activity message that also must clip at narrow widths" }],
    }],
  });
  for (const width of [1, 2, 3, 5, 8, 12, 19]) {
    const lines = expandedLines(value, {}, width);
    assert.ok(lines.length > 0, `width ${width} must still render lines`);
  }
});

test("wide Unicode retained content is measured in terminal cells, not UTF-16 units", () => {
  const cjkLine = "漢字テスト中文한국어".repeat(12); // 120 wide chars = 240 display cells
  const emojiLine = "🚀".repeat(50); // 100 display cells in 50 code units*2
  const value = envelope("SubtasksInspect: wide-character chunk", {
    action: "inspect", kind: "execute", executionId: "exec-w", updatedAt: "2025-06-01T10:00:00.000Z",
    evidence: {
      mode: "entry", taskId: "task-w",
      snapshot: { totalEntries: 2, sources: [], unavailable: [], capability: { toolEvidence: "available" }, diagnostics: { recordsScanned: 2, oversizedRecords: 0, skippedRecords: 0 } },
      entries: [
        { index: 0, entryId: "entry-w0", kind: "tool_result", status: "returned", provenance: "executor_observed", preview: `CJK 结果 ${cjkLine}`, contentBytes: 800, source: { sourceId: "session:1", adapter: "pi-model", stream: "session" } },
      ],
      deepContent: { entryId: "entry-w1", chunkIndex: 0, content: `${cjkLine}\n${emojiLine}`, hasMore: false, contentBytes: 900 },
    },
  });
  // At a width where string length would fit but display cells would not: the
  // CJK line is 480 UTF-16 units but 240 display cells, so a 100-column row
  // must wrap by cells even though a naive length check would call it short.
  const lines = expandedLines(value, {}, 100);
  const joinedText = lines.join("\n");
  assert.ok(joinedText.includes("漢字"), "CJK retained content must render");
  const deepRows = lines.filter((line) => line.includes("漢字"));
  assert.ok(deepRows.length > 1, "the wide retained line wraps into multiple rows");
  for (const row of deepRows) {
    assert.ok(displayWidthOf(row) <= 100, `deep CJK row must fit 100 columns: ${displayWidthOf(row)} cells`);
  }
  // Wrapping drops nothing: the wrapped CJK rows concatenate back to the full
  // original run.
  assert.ok(lines.join("").includes(cjkLine), "the complete CJK run must survive wrapping");
  // Independent exact-cell assertion for the default-wide-emoji row (🚀 is
  // Emoji_Presentation=Yes, two terminal cells — outside any hand-picked
  // range table): with the 4-space deep-read indent, 50 rockets occupy 104
  // cells, so the row must wrap at this width.
  const rocketRows = lines.filter((line) => line.includes("🚀"));
  assert.ok(rocketRows.length > 0, "retained rocket content must render");
  for (const rocketRow of rocketRows) {
    const rocketCells = [...rocketRow].reduce(
      (cells, character) => cells + (character === "🚀" ? 2 : 1), 0,
    );
    assert.ok(rocketCells <= 100, `rocket row exceeds width: ${rocketCells}`);
  }
  assert.equal((lines.join("").match(/🚀/g) ?? []).length, 50, "all 50 rockets must survive wrapping");
  // A width where a 40-code-unit CJK run is 80 cells: wrapping must count 2 cells per char.
  const shortWide = envelope("SubtasksInspect: short wide chunk", {
    action: "inspect", kind: "execute", executionId: "exec-w", updatedAt: "2025-06-01T10:00:00.000Z",
    evidence: {
      mode: "entry", taskId: "task-w",
      snapshot: { totalEntries: 1, sources: [], unavailable: [], capability: { toolEvidence: "available" }, diagnostics: { recordsScanned: 1, oversizedRecords: 0, skippedRecords: 0 } },
      deepContent: { entryId: "entry-w0", chunkIndex: 0, content: "漢字".repeat(20), hasMore: false, contentBytes: 96 },
    },
  });
  const shortLines = expandedLines(shortWide, {}, 60);
  assert.ok(shortLines.length > 1, "an 80-cell CJK line wraps at a 60-column width");
  assert.ok(shortLines.join("").includes("漢字".repeat(20)), "the complete short wide run must survive wrapping");
});

// ---------------------------------------------------------------------------
// Collapsed rendering must remain the bounded card for the registered tools
// ---------------------------------------------------------------------------

test("collapsed rendering remains the bounded card for the registered tools", async () => {
  const { tools, manager } = harness();
  try {
    const inspectTool = tools.find((tool) => tool.name === "SubtasksInspect")!;
    const value = envelope("inspect: execution exec-p", {
      action: "inspect", kind: "execute", executionId: "exec-p", updatedAt: "2025-06-01T10:00:00.000Z",
      archivedCount: 12,
      tasks: Array.from({ length: 11 }, (_unused, index) => ({
        taskId: `task-p${index}`, state: "running", definition: { title: `P ${index}` },
      })),
    });
    const inspectRenderer = inspectTool.renderResult as (value: unknown, options: unknown, theme: unknown) => { render(w: number): string[] };
    const collapsed = inspectRenderer(value, {}, THEME).render(200).join("\n");
    // The canonical bounded card: header plus the inspected task's line
    // (taskId · state · title), with archive-only history disclosed.
    assert.match(collapsed, /^SubtasksInspect · task \? · status/);
    assert.match(collapsed, /task-p0 · running · P 0/);
    assert.doesNotMatch(collapsed, /task-p8/, "the bounded card shows the inspected task, not a full inventory dump");
    assert.match(collapsed, /… 12 earlier settled task\(s\) are archived; inspect by taskId for exact history\./);
  } finally {
    await manager.shutdown();
    await manager.detach();
  }
});

// The family inventory must be complete: every registered Subtasks* tool name
// produced at least one production envelope in this file's tests.
test("family inventory covers every Subtasks* tool", () => {
  for (const name of EXECUTION_TOOL_NAMES) {
    assert.ok(renderedFamilies.has(name), `no production envelope rendered for ${name}`);
  }
  assert.equal(renderedFamilies.size, EXECUTION_TOOL_NAMES.length);
});