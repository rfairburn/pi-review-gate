import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import {
  executorDisplayLabel,
  renderSubtaskWidget,
  type SubtaskWidgetTaskSnapshot,
} from "../src/execution/subtask-widget";
import type { BackgroundTaskKind, BackgroundTaskState } from "../src/execution/task-state";

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
    executorPool: [
      { entryId: "pi-entry", selection: { source: "pi", model: "gpt-x" }, maxConcurrent: 1 },
      { entryId: "external-fake", selection: { source: "external", id: "fake" }, maxConcurrent: 1 },
    ],
  },
});

function widgetTask(overrides: Partial<SubtaskWidgetTaskSnapshot> = {}): SubtaskWidgetTaskSnapshot {
  return {
    kind: "execute" as BackgroundTaskKind,
    taskId: "task-1",
    title: "Task one",
    state: "running" as BackgroundTaskState,
    updatedAt: "2024-01-01T00:00:00.000Z",
    queuedExecutorAssigned: false,
    ...overrides,
  };
}

test("executorDisplayLabel resolves pi models, external agents, and fallbacks", () => {
  assert.equal(executorDisplayLabel({}, config), "executor pending");
  assert.equal(executorDisplayLabel({ executorEntryId: "pi-entry" }, config), "gpt-x");
  assert.equal(executorDisplayLabel({ executorEntryId: "external-fake" }, config), "fake");
  assert.equal(executorDisplayLabel({ executorEntryId: "unknown-entry" }, config), "unknown-entry");
});

test("renderSubtaskWidget compact view renders queue states, overflow, conflicts, and clearing", () => {
  const waiting = renderSubtaskWidget({
    expanded: false,
    tasks: [widgetTask({ state: "queued", queuedExecutorAssigned: false })],
    recent: [],
  }, config);
  assert.deepEqual(waiting.lines, ["⟳ 1 background subtask — Task one (queued: executor capacity wait)"]);

  const assigned = renderSubtaskWidget({
    expanded: false,
    tasks: [widgetTask({ state: "queued", queuedExecutorAssigned: true })],
    recent: [],
  }, config);
  assert.deepEqual(assigned.lines, ["⟳ 1 background subtask — Task one (queued: executor assigned/startup)"]);

  const overflow = renderSubtaskWidget({
    expanded: false,
    tasks: [
      widgetTask({ taskId: "task-1", title: "A" }),
      widgetTask({ taskId: "task-2", title: "B" }),
      widgetTask({ taskId: "task-3", title: "C" }),
      widgetTask({ taskId: "task-4", title: "D" }),
    ],
    recent: [],
  }, config);
  assert.deepEqual(overflow.lines, ["⟳ 4 background subtasks — A (running), B (running), C (running), +1 more"]);

  const conflict = renderSubtaskWidget({
    expanded: false,
    conflictPaths: ["src/a.ts", "src/b.ts"],
    tasks: [],
    recent: [],
  }, config);
  assert.deepEqual(conflict.lines, ["⟳ 0 background subtasks — CRITICAL conflict: src/a.ts, src/b.ts"]);

  const cleared = renderSubtaskWidget({ expanded: false, tasks: [], recent: [] }, config);
  assert.equal(cleared.lines, undefined);
});

test("renderSubtaskWidget expanded view sorts by recency, bounds the list, and renders details", () => {
  const tasks = Array.from({ length: 17 }, (_, index) => widgetTask({
    taskId: `task-${index}`,
    title: `Task ${index}`,
    updatedAt: new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 1000).toISOString(),
  }));
  const rendered = renderSubtaskWidget({
    expanded: true,
    tasks,
    recent: [{ title: "Task 0", event: { sequence: 1, at: "2024-01-01T00:00:00.000Z", phase: "running", message: "a  long\nmessage that is quite long but under the bound" } }],
  }, config);
  assert.ok(rendered.component);
  const componentLines = rendered.component!().render(400);
  const lines = componentLines.join("\n");
  assert.ok(lines.includes("⟳ 17 active background subtasks — expanded live view (/subtasks-view to collapse)"));
  const taskLines = componentLines.filter((line) => line.startsWith("  execute · "));
  assert.equal(taskLines.length, 16);
  assert.ok(taskLines[0]!.startsWith("  execute · Task 16 [running] · executor pending"));
  assert.ok(lines.includes("  … 1 additional active task omitted"));
  assert.ok(lines.includes("  Recent activity (10 newest events across all tasks):"));
  assert.ok(lines.includes("    Task 0 · running · a long message that is quite long but under the bound"));

  const detailed = renderSubtaskWidget({
    expanded: true,
    conflictPaths: ["src/a.ts"],
    tasks: [widgetTask({
      state: "reviewing",
      reviewStatus: { phase: "reviewing", reviewers: [] },
      latestCommand: { action: "steer", status: "queued" },
    })],
    recent: [],
  }, config).component!().render(400);
  assert.ok(detailed.includes("CRITICAL conflict: src/a.ts"));
  assert.ok(detailed[2]!.includes(" · reviewers none (reviewing)"));
  assert.ok(detailed[2]!.endsWith(" · steer queued"));

  const empty = renderSubtaskWidget({ expanded: true, tasks: [], recent: [] }, config).component!().render(400);
  assert.ok(empty.includes("⟳ 0 active background subtasks — expanded live view (/subtasks-view to collapse)"));
  assert.ok(empty.includes("  No active background subtasks."));
  assert.ok(empty.includes("    no activity recorded yet"));

  const singular = renderSubtaskWidget({ expanded: true, tasks: [widgetTask()], recent: [] }, config).component!().render(400)[0]!;
  assert.equal(singular, "⟳ 1 active background subtask — expanded live view (/subtasks-view to collapse)");
});
