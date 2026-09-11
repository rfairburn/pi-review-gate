/**
 * Collapsed (default) card renderer tests for the Subtasks* family (#93,
 * canonical examples 6–14).
 *
 * Everything here runs against production surfaces: results are produced by the
 * real registered tools (real controller, real evidence indexing and
 * navigation) and rendered through the production collapsed callback with the
 * native context (`context.args`) carrying the actual recorded request fields,
 * exactly as the host passes them. A few lifecycle states that cannot be
 * produced cheaply (a materially conflicted workspace) use synthetic envelopes
 * shaped exactly as the tools return them.
 *
 * The expand/collapse key hint is added centrally by the shared
 * `expandableResult` wrapper, so these cards must never contain their own hint.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { normalizeConfig } from "../src/config";
import { renderSubtaskResultCollapsed } from "../src/execution/subtask-result-collapsed";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

const THEME = { bold: (text: string) => text, fg: (_color: string, text: string) => text };

const EXECUTION_TOOL_NAMES = [
  "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue",
  "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean",
];

type ExecuteTool = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

/** Renders through the real collapsed callback (with native context) and
 * returns plain text lines, asserting the TUI width contract. */
function collapsedLines(value: unknown, options: unknown, theme: typeof THEME, context?: unknown, width = 300): string[] {
  const component = renderSubtaskResultCollapsed(
    value,
    options as { expanded?: boolean; isPartial?: boolean },
    theme,
    context as { args?: unknown } | undefined,
  ) as { render(w: number): string[] };
  assert.ok(component && typeof component.render === "function", "collapsed renderer must return a text component");
  const lines = component.render(width) as string[];
  const plain = (text: string) => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  for (const line of lines) {
    assert.ok(plain(line).length <= width, `rendered line must fit ${width} columns: ${line}`);
  }
  return lines;
}

function joined(value: unknown, options: unknown = {}, context?: unknown, width = 300): string {
  return collapsedLines(value, options, THEME, context, width).join("\n");
}

/** Mirrors the production result envelope exactly as the tools produce it. */
function envelope(summary: string, details: Record<string, any>, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text: summary }], details, isError };
}

// ---------------------------------------------------------------------------
// Harness: real registered execution tools with a fake executor
// ---------------------------------------------------------------------------

function harness() {
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
    cwd: () => process.cwd(),
    notify: () => {},
  });
  manager.sync();
  return { tools, manager };
}

const state: { manager?: ExecutionToolManager; tools: Array<Record<string, any>>; root?: string } = { tools: [] };

before(async () => {
  state.root = await mkdir(join(tmpdir(), "subtask-collapsed-"), { recursive: true }).then(() => join(tmpdir(), "subtask-collapsed-"));
  const harness_ = harness();
  state.manager = harness_.manager;
  state.tools = harness_.tools;
});

after(async () => {
  if (state.manager) await state.manager.shutdown();
  await rm(join(tmpdir(), "subtask-collapsed-"), { recursive: true, force: true });
});

function execute(name: string): ExecuteTool {
  const tool = state.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} was not registered`);
  return tool.execute as ExecuteTool;
}

// ---------------------------------------------------------------------------
// Signature and native wiring contract
// ---------------------------------------------------------------------------

test("the collapsed callback carries the native renderResult signature with optional context", () => {
  assert.equal(typeof renderSubtaskResultCollapsed, "function");
  assert.equal(renderSubtaskResultCollapsed.length, 4);
  const component = renderSubtaskResultCollapsed(envelope("x", { cleared: false, paths: [] }), { expanded: false }, THEME);
  assert.ok(component && typeof (component as { render?: unknown }).render === "function");
});

test("the collapsed card never renders its own expansion hint (the wrapper adds it centrally)", () => {
  const value = envelope("SubtasksMarkClean acknowledged", { cleared: true, paths: ["src/renderer.ts"] });
  const text = joined(value, { expanded: false });
  assert.doesNotMatch(text, /ctrl\+o|to expand|to collapse/);
});

// ---------------------------------------------------------------------------
// Production envelopes through the real registered tools
// ---------------------------------------------------------------------------

test("SubtasksStart renders the concise queued card with the real target and handles", async () => {
  const started = await execute("SubtasksStart")("start-collapsed", {
    tasks: [
      { title: "COLLAPSED-FIRST", instructions: "bounded work", acceptanceCriteria: ["done"] },
      { title: "COLLAPSED-SECOND", instructions: "bounded work", acceptanceCriteria: ["done"] },
    ],
  }, undefined, undefined, {});
  assert.equal(started.isError, false);
  const text = joined(started, { expanded: false }, { args: {} });
  assert.match(text, /^SubtasksStart · 2 execution task\(s\) · (queued|capturing|running)/);
  assert.match(text, /Target: \S+/);
  // taskId · state · title — the canonical per-task line with the queued nuance.
  assert.match(text, /task-[0-9a-f-]+ · (queued|capturing|running)( \(.*\))? · COLLAPSED-FIRST/);
  assert.match(text, /COLLAPSED-SECOND/);
  // Before any dispatch event the card is honest about what has not happened.
  assert.match(text, /dispatch: not yet sent \(no prompt, worktree, or captured base available yet\)/);
  assert.ok(!text.includes("Scheduler:"), "the collapsed card stays concise");
});

test("start/add cards consume the renderer-only dispatch projection when present", () => {
  // The same retained result re-renders with live state and transport-boundary
  // provenance once the parent's lifecycle preparation attaches the projection.
  const value = envelope("SubtasksStart accepted: execution exec-dv (1 task(s)).", {
    action: "start",
    executionId: "exec-dv",
    kind: "execute",
    root: "/work/project",
    tasks: [{
      taskId: "task-d1",
      state: "queued",
      dispatchState: "waiting_for_capacity",
      definition: { title: "Projected work" },
    }],
    dispatchView: {
      executionId: "exec-dv",
      kind: "execute",
      targetWorkspace: "/work/project",
      tasks: [{
        taskId: "task-d1",
        state: "running",
        initialDispatch: {
          provenance: "captured_at_dispatch", delivery: "written_to_transport",
          dispatchedAt: "2025-06-01T10:00:00.000Z", sentPrompt: "PROMPT-A",
          worktreeRoot: "/work/isolated/task-d1", baseCommit: "abcdef1234567890abcdef1234567890abcdef12",
          executorTurn: 1,
        },
        dispatch: {
          provenance: "captured_at_dispatch", delivery: "written_to_transport",
          dispatchedAt: "2025-06-01T10:00:05.000Z", sentPrompt: "PROMPT-B",
          worktreeRoot: "/work/isolated/task-d1", baseCommit: "abcdef1234567890abcdef1234567890abcdef12",
          executorTurn: 2,
        },
      }],
    },
  });
  const text = joined(value, { expanded: false }, { args: {} });
  // The projection wins over the frozen snapshot: live state and provenance.
  assert.match(text, /task-d1 · running · Projected work/);
  assert.match(
    text,
    /dispatch: prompt delivered to transport · worker worktree \/work\/isolated\/task-d1 · captured base abcdef123456 · turn 2 · re-dispatched after recovery \(latest actual dispatch shown\)/,
  );
});

test("a restored task past queued without a persisted capture acknowledges missing provenance, never non-delivery", () => {
  // The original snapshot froze at queued; the live projection has since moved
  // on (paused_recoverable) but this record holds no dispatch capture — e.g.
  // the historical dispatch predates capture or was not retained across
  // restore. Current state is known; delivery provenance is not.
  const restored = envelope("SubtasksStart accepted: execution exec-restore (1 task(s)).", {
    action: "start",
    executionId: "exec-restore",
    kind: "execute",
    root: "/tmp/pi-review-execution-storage-r1",
    cwd: "/work/project",
    tasks: [{
      taskId: "task-r1",
      state: "queued",
      definition: { title: "Restored historical work" },
    }],
    dispatchView: {
      executionId: "exec-restore",
      kind: "execute",
      targetWorkspace: "/work/project",
      tasks: [{ taskId: "task-r1", state: "paused_recoverable" }],
    },
  });
  const restoredText = joined(restored, { expanded: false }, { args: {} });
  // The live state wins for the task line...
  assert.match(restoredText, /task-r1 · paused_recoverable · Restored historical work/);
  // ...and a non-queued task without capture must NOT claim non-delivery.
  assert.doesNotMatch(restoredText, /not yet sent/);
  assert.match(restoredText, /dispatch: no capture available in this record; delivery status is unrecorded/);

  // A task that is effectively still queued (live or snapshot) keeps the
  // honest not-yet-sent wording.
  const queuedLive = envelope("SubtasksStart accepted: execution exec-q1 (1 task(s)).", {
    action: "start",
    executionId: "exec-q1",
    kind: "execute",
    root: "/tmp/pi-review-execution-storage-q1",
    cwd: "/work/project",
    tasks: [{
      taskId: "task-q1",
      state: "queued",
      dispatchState: "waiting_for_capacity",
      definition: { title: "Still queued work" },
    }],
    dispatchView: {
      executionId: "exec-q1",
      kind: "execute",
      targetWorkspace: "/work/project",
      tasks: [{ taskId: "task-q1", state: "queued", dispatchState: "waiting_for_capacity" }],
    },
  });
  const queuedText = joined(queuedLive, { expanded: false }, { args: {} });
  assert.match(queuedText, /dispatch: not yet sent \(no prompt, worktree, or captured base available yet\)/);
  assert.doesNotMatch(queuedText, /no capture available in this record/);
});

test("start/add cards label the selected target workspace, never the execution storage directory", () => {
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
  // Restored envelope (no live projection): the persisted selected target.
  const restored = joined(envelope("SubtasksStart accepted: execution exec-target-distinct (1 task(s)).", { ...base }), { expanded: false }, { args: {} });
  assert.match(restored, /Target: \/work\/target-checkout/);
  assert.ok(!restored.includes("pi-review-execution-storage-123"), "execution storage must never be labeled as the target");
  // The live projection wins when present.
  const live = joined(envelope("SubtasksStart accepted: execution exec-target-distinct (1 task(s)).", {
    ...base,
    dispatchView: { executionId: "exec-target-distinct", kind: "execute", targetWorkspace: "/live/target-resolved", tasks: [] },
  }), { expanded: false }, { args: {} });
  assert.match(live, /Target: \/live\/target-resolved/);
  // The raw request workspace is only the last resort.
  const bare = joined(envelope("SubtasksStart accepted: execution exec-bare (0 task(s)).", { action: "start", executionId: "exec-bare", kind: "execute", tasks: [] }), { expanded: false }, { args: { workspace: "relative-target" } });
  assert.match(bare, /Target: relative-target/);
});

test("SubtasksAdd renders the added-task card with the inherited target", async () => {
  const started = await execute("SubtasksStart")("add-card-base", {
    tasks: [{ title: "ADD-CARD-BASE", instructions: "bounded work", acceptanceCriteria: ["done"] }],
  }, undefined, undefined, {});
  const added = await execute("SubtasksAdd")("add-card", {
    executionId: started.details.executionId,
    tasks: [{ title: "COLLAPSED-ADDED", instructions: "bounded work", acceptanceCriteria: ["done"] }],
  }, undefined, undefined, {});
  // context.args is the actual recorded request (the host passes the full args).
  const args = { executionId: started.details.executionId, tasks: [{ title: "COLLAPSED-ADDED", instructions: "bounded work", acceptanceCriteria: ["done"] }] };
  const text = joined(added, { expanded: false }, { args });
  assert.match(text, /^SubtasksAdd · \S+ · 1 task\(s\) added/);
  assert.match(text, /Target: \S+/);
  assert.match(text, /COLLAPSED-ADDED/);
});

test("SubtasksInspect status card names the task and concise state", async () => {
  const started = await execute("SubtasksStart")("inspect-card-base", {
    tasks: [{ title: "INSPECT-CARD-TASK", instructions: "bounded work", acceptanceCriteria: ["done"] }],
  }, undefined, undefined, {});
  const inspected = await execute("SubtasksInspect")("inspect-card", {
    executionId: started.details.executionId,
    taskId: started.details.tasks[0].taskId,
  }, undefined, undefined, {});
  const text = joined(inspected, { expanded: false }, { args: { executionId: started.details.executionId, taskId: started.details.tasks[0].taskId } });
  assert.match(text, /^SubtasksInspect · task \S+ · status/);
  assert.match(text, /(queued|capturing|running)/);
});

test("SubtasksInspect evidence cards are mode-specific and concise", async () => {
  const started = await execute("SubtasksStart")("evidence-card-base", {
    tasks: [{ title: "EVIDENCE-CARD-TASK", instructions: "bounded work", acceptanceCriteria: ["done"] }],
  }, undefined, undefined, {});
  const executionId = started.details.executionId as string;
  const taskId = started.details.tasks[0].taskId as string;

  const found = await execute("SubtasksInspect")("evidence-card-find", {
    executionId, taskId, evidence: { find: "COLLAPSED-NEEDLE-NO-MATCH" },
  }, undefined, undefined, {});
  const foundText = joined(found, { expanded: false }, { args: { executionId, taskId, evidence: { find: "COLLAPSED-NEEDLE-NO-MATCH" } } });
  assert.match(foundText, /SubtasksInspect · task \S+ · find "COLLAPSED-NEEDLE-NO-MATCH"/);
  assert.match(foundText, /no matches for "COLLAPSED-NEEDLE-NO-MATCH"/);

  const ranged = await execute("SubtasksInspect")("evidence-card-range", {
    executionId, taskId, evidence: { index: 0, limit: 5 },
  }, undefined, undefined, {});
  const rangedText = joined(ranged, { expanded: false }, { args: { executionId, taskId, evidence: { index: 0, limit: 5 } } });
  assert.match(rangedText, /entries \d+–\d+( of \d+)?|no entries in this read/);
});

test("SubtasksWatch renders the armed checkpoint with the human-readable delay", async () => {
  const started = await execute("SubtasksStart")("watch-card-base", {
    tasks: [{ title: "WATCH-CARD-TASK", instructions: "bounded work", acceptanceCriteria: ["done"] }],
  }, undefined, undefined, {});
  const watch = await execute("SubtasksWatch")("watch-card", {
    executionId: started.details.executionId, after: "30s",
  }, undefined, undefined, {});
  const text = joined(watch, { expanded: false }, { args: { executionId: started.details.executionId, after: "30s" } });
  assert.match(text, /^SubtasksWatch · \S+ · checkpoint armed/);
  assert.match(text, /After 30 seconds \(requested as "30s"\)/);
});

test("SubtasksSteer shows the actual instruction and interrupt flag without re-redacting", async () => {
  const started = await execute("SubtasksStart")("steer-card-base", {
    tasks: [{ title: "STEER-CARD-TASK", instructions: "bounded work", acceptanceCriteria: ["done"] }],
  }, undefined, undefined, {});
  const secretShaped = "Stop the stress run; token=SECRET-SHAPED-CARD-VALUE";
  const steered = await execute("SubtasksSteer")("steer-card", {
    executionId: started.details.executionId,
    taskId: started.details.tasks[0].taskId,
    instructions: secretShaped,
  }, undefined, undefined, {});
  const args = { executionId: started.details.executionId, taskId: started.details.tasks[0].taskId, instructions: secretShaped };
  const text = joined(steered, { expanded: false }, { args });
  assert.match(text, /^SubtasksSteer · task-\S+ · (queued|delivered|acknowledged|failed)/);
  assert.match(text, /Stop the stress run; token=SECRET-SHAPED-CARD-VALUE/);
  assert.ok(!text.includes("[REDACTED]"), "the card must not re-redact model-submitted content");

  // Interrupt-first steering stays visible on the card.
  const interruptSteerArgs = { ...args, interrupt: true, instructions: "new direction" };
  const interruptSteered = await execute("SubtasksSteer")("steer-card-interrupt", {
    executionId: started.details.executionId,
    taskId: started.details.tasks[0].taskId,
    instructions: "new direction",
    interrupt: true,
  }, undefined, undefined, {});
  const interruptText = joined(interruptSteered, { expanded: false }, { args: interruptSteerArgs });
  assert.match(interruptText, /Interrupt first: yes/);
});

test("SubtasksContinue shows the submitted continuation and accepted word", async () => {
  // Real continue requires a verified checkpoint bundle (an interrupted task
  // that never dispatched has none and reports that honestly); the accepted
  // continuation card is asserted on a production-shaped inspection envelope
  // whose command record is exactly what the controller appends on admission.
  const continued = envelope("SubtasksContinue: execute group exec-c, 1 active task(s).", {
    action: "continue",
    executionId: "exec-continue",
    kind: "execute",
    tasks: [{
      taskId: "task-cont",
      state: "queued",
      definition: { title: "CONTINUE-CARD-TASK" },
      commands: [{
        instructionId: "continue-card", action: "continue", actor: "model",
        text: "Resume and finish the bounded work.", status: "queued", createdAt: "2025-06-01T10:00:00.000Z",
      }],
    }],
  });
  const text = joined(continued, { expanded: false }, { args: { instructions: "Resume and finish the bounded work.", instructionId: "continue-card" } });
  assert.match(text, /^SubtasksContinue · task-cont · continuation (accepted|queued)/);
  assert.match(text, /Resume and finish the bounded work\./);
});

test("SubtasksInterrupt and SubtasksForceMerge cards name established outcomes", () => {
  const interrupted = envelope("SubtasksInterrupt: execution exec-i, 0 active task(s).", {
    action: "interrupt",
    executionId: "exec-i",
    kind: "execute",
    tasks: [{
      taskId: "task-int", state: "interrupted", definition: { title: "Stopped work" },
      interruptionMode: "interrupt_as_failure",
    }],
  });
  const interruptText = joined(interrupted, { expanded: false }, { args: { interruptMode: "interrupt_as_failure" } });
  assert.match(interruptText, /^SubtasksInterrupt · task-\S+ · stopped without landing/);

  const conflicted = envelope("SubtasksForceMerge: execution exec-f, 0 active task(s).", {
    action: "force_merge",
    executionId: "exec-i",
    kind: "execute",
    root: "/work/project",
    conflictGate: { sourceRoot: "/work/project", paths: ["src/renderer.ts"], activatedAt: "2025-06-01T10:00:00.000Z" },
    tasks: [{ taskId: "task-c1", state: "conflicted", definition: { title: "Merged work" } }],
  });
  const mergeText = joined(conflicted, { expanded: false }, { args: { mergeAnyhow: true } });
  assert.match(mergeText, /^SubtasksForceMerge · task-c1 · conflicts materialized/);
  assert.match(mergeText, /Manual resolution required/);

  const landed = envelope("SubtasksForceMerge: execution exec-i, 0 active task(s).", {
    action: "force_merge",
    executionId: "exec-i",
    kind: "execute",
    tasks: [{ taskId: "task-c1", state: "landed", definition: { title: "Merged work" } }],
  });
  assert.match(joined(landed, { expanded: false }), /SubtasksForceMerge · task-c1 · landed/);
});

test("SubtasksMarkClean cards distinguish cleared and no-gate acknowledgements", () => {
  const cleared = joined(envelope("Conflict gate cleared for 1 path(s); queued landings are waking automatically.", { cleared: true, paths: ["src/renderer.ts"] }));
  assert.match(cleared, /^SubtasksMarkClean · conflict gate cleared/);
  assert.match(cleared, /src\/renderer\.ts/);
  const inactive = joined(envelope("No workspace conflict gate is active.", { cleared: false, paths: [] }));
  assert.match(inactive, /^SubtasksMarkClean · no active conflict gate/);
});

// ---------------------------------------------------------------------------
// Honest fallbacks and lifecycle states
// ---------------------------------------------------------------------------

test("error results render the diagnostic without invented detail", () => {
  const failed = envelope("SubtasksSteer failed: no such execution", {
    action: "steer", diagnostic: "no such execution", executionId: "exec-missing",
  }, true);
  const text = joined(failed, { expanded: false });
  assert.match(text, /^SubtasksSteer · failed/);
  assert.match(text, /diagnostic: no such execution/);
});

test("partial results render the pending card", () => {
  const text = joined(envelope("SubtasksStart accepted…", { partial: true }), { isPartial: true });
  assert.match(text, /Subtasks tool …|SubtasksStart …/);
});

test("unrecognized details fall back to the returned summary", () => {
  const text = joined(envelope("some tool ran", { unrelated: true }));
  assert.match(text, /some tool ran/);
  const undefinedValue = collapsedLines(undefined, {}, THEME);
  assert.ok(undefinedValue.join("\n").includes("No execution result."));
});