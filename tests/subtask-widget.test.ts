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

test("executorDisplayLabel prefers the recorded selection over stale entry-id resolution", () => {
  // Failover case: the task's entry id still points at the original pool
  // entry, but the recorded pi selection is what actually served the turn.
  assert.equal(
    executorDisplayLabel({ executorEntryId: "pi-entry", executorSelection: { source: "pi", model: "gpt-y" } }, config),
    "gpt-y",
  );
  // An external selection is honored as recorded identity even without a
  // model: the label is the recorded catalog handle, never a re-resolution of
  // the entry id against mutable current configuration.
  assert.equal(
    executorDisplayLabel({ executorEntryId: "external-fake", executorSelection: { source: "external", id: "fake" } }, config),
    "fake",
  );
  // A recorded external selection stays honest even when its id no longer
  // resolves anywhere: the recorded id is what actually served the task.
  assert.equal(executorDisplayLabel({ executorSelection: { source: "external", id: "gone" } }, config), "gone");
  // A recorded external selection without a usable id degrades to an explicit
  // unknown label instead of silently falling through to current settings.
  assert.equal(executorDisplayLabel({ executorSelection: { source: "external", id: "" } }, config), "unknown");
  // Without a recorded selection the legacy entry-id resolution is unchanged,
  // and historical activity text is never re-labeled from current settings.
  assert.equal(executorDisplayLabel({ executorEntryId: "pi-entry" }, config), "gpt-x");
});

test("executorDisplayLabel prefers the actual invocation model over mutable settings", () => {
  const modelAgentConfig = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "with-model",
      adapter: "run-as-binary",
      command: process.execPath,
      model: "agent-model-9",
      execution: { protocol: "pi-review-executor-jsonl-v1" as const, model: "execution-override-7" },
    }],
  });
  const rePointedConfig = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "with-model",
      adapter: "run-as-binary",
      command: process.execPath,
      model: "catalog-changed-later",
      execution: { protocol: "pi-review-executor-jsonl-v1" as const },
    }],
  });
  // The execution-level override is what actually ran — the label shows it
  // exactly, not the agent-level default.
  assert.equal(
    executorDisplayLabel({ executorModel: "execution-override-7", executorSelection: { source: "external", id: "with-model" } }, modelAgentConfig),
    "execution-override-7",
  );
  // A catalog change under an already-running task can never relabel it:
  // the same live task renders identically against both configurations.
  const liveTask = { executorModel: "execution-override-7", executorEntryId: "external-with-model", executorSelection: { source: "external" as const, id: "with-model" } };
  assert.equal(executorDisplayLabel(liveTask, modelAgentConfig), executorDisplayLabel(liveTask, rePointedConfig));
  // The invocation model also wins over a recorded pi selection (they agree
  // in practice; the reported value is the ground truth).
  assert.equal(
    executorDisplayLabel({ executorModel: "actual-1", executorSelection: { source: "pi", model: "stale-2" } }, config),
    "actual-1",
  );
});

test("executorDisplayLabel keeps the recorded model-less external identity under later catalog edits", () => {
  const modelLessConfig = normalizeConfig({
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
        { entryId: "external-fake", selection: { source: "external" as const, id: "fake" }, maxConcurrent: 1 },
      ],
    },
  });
  // Later catalog edit: the same agent id now claims a model that never
  // served this model-less invocation.
  const catalogGainedModel = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      model: "never-served-9",
      execution: { protocol: "pi-review-executor-jsonl-v1" as const },
    }],
    execution: {
      executorPool: [
        { entryId: "external-fake", selection: { source: "external" as const, id: "fake" }, maxConcurrent: 1 },
      ],
    },
  });
  // Resource reassignment: the same entry id now resolves to an entirely
  // different executor selection.
  const entryReassigned = normalizeConfig({
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
        { entryId: "external-fake", selection: { source: "pi" as const, model: "gpt-reassigned" }, maxConcurrent: 1 },
      ],
    },
  });
  // A model-less external invocation reports no executorModel: the recorded
  // selection must stay the authoritative identity no matter how the catalog
  // or pool later edits the same entry id.
  const modelLessTask = {
    executorEntryId: "external-fake",
    executorSelection: { source: "external" as const, id: "fake" },
  };
  assert.equal(executorDisplayLabel(modelLessTask, modelLessConfig), "fake");
  assert.equal(executorDisplayLabel(modelLessTask, catalogGainedModel), "fake");
  assert.equal(executorDisplayLabel(modelLessTask, entryReassigned), "fake");

  // The widget line stays honest under the edited catalog as well.
  const rendered = renderSubtaskWidget({
    expanded: true,
    tasks: [widgetTask({ executorEntryId: "external-fake", executorSelection: { source: "external" as const, id: "fake" } })],
    recent: [],
  }, catalogGainedModel).component!().render(400);
  const taskLine = rendered.find((line) => line.startsWith("  execute · "))!;
  assert.ok(taskLine.includes("· fake"), taskLine);
  assert.ok(!taskLine.includes("never-served-9"), taskLine);

  // The true legacy path is untouched: without a recorded selection the entry
  // id still resolves against current configuration.
  assert.equal(executorDisplayLabel({ executorEntryId: "external-fake" }, catalogGainedModel), "never-served-9");
  assert.equal(executorDisplayLabel({ executorEntryId: "external-fake" }, entryReassigned), "gpt-reassigned");
});

test("compact widget count stays one per task regardless of executor identity", () => {
  const rendered = renderSubtaskWidget({
    expanded: false,
    tasks: [
      widgetTask({ taskId: "task-1", title: "One", executorEntryId: "pi-entry", executorSelection: { source: "pi", model: "gpt-x" } }),
      widgetTask({ taskId: "task-2", title: "Two", executorEntryId: "external-fake", executorSelection: { source: "external", id: "fake" } }),
    ],
    recent: [],
  }, config);
  assert.deepEqual(rendered.lines, ["⟳ 2 background subtasks — One (running), Two (running)"]);
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
