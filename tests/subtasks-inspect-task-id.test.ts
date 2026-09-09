import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import type { BackgroundExecutionController } from "../src/execution/background-controller";
import {
  INLINE_SETTLED_TASK_LIMIT,
  serializeGroupSnapshot,
  writeGroupSnapshot,
  type BackgroundExecutionGroup,
} from "../src/execution/background-group-store";
import { newTask, type BackgroundTaskState } from "../src/execution/task-state";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

type ToolExecute = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

interface FixtureTask {
  taskId: string;
  state: BackgroundTaskState;
  title?: string;
  updatedAt?: string;
}

/**
 * Synthetic isolated fixture for #53: a durable v3 execution group restored
 * through the real controller, exercised only through the registered
 * SubtasksInspect tool. No live executors, configs, or credentials are used.
 */
async function managerWithGroup(
  executionId: string,
  tasks: FixtureTask[],
): Promise<{ base: string; manager: ExecutionToolManager; execute: ToolExecute }> {
  const base = await mkdtemp(join(tmpdir(), "pi-review-inspect53-"));
  const sourceRoot = join(base, "source");
  const groupRoot = join(base, `pi-review-execution-${executionId}`);
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(groupRoot, { recursive: true });
  const now = new Date().toISOString();
  const records = tasks.map((task, index) => {
    const record = newTask({ title: task.title ?? `bounded work ${index}`, instructions: "do bounded work", acceptanceCriteria: ["done"] });
    record.taskId = task.taskId;
    record.state = task.state;
    if (task.updatedAt) record.updatedAt = task.updatedAt;
    return record;
  });
  const group: BackgroundExecutionGroup = {
    version: 3, revision: 1, integritySha256: "", executionId, kind: "execute",
    root: await realpath(groupRoot), cwd: sourceRoot, createdAt: now, updatedAt: now, peakConcurrency: 1, tasks: records,
  };
  // serializeGroupSnapshot evicts settled tasks beyond the bounded inline
  // window into integrity-checked archive files, exactly like live saves.
  await writeGroupSnapshot(group.root, serializeGroupSnapshot(group, new Map()));
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
  };
  // A resolvable but zero-capacity external agent registers the tools while
  // guaranteeing nothing is ever dispatched (no live providers or processes).
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "unstarted",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] },
    }],
    execution: {
workerResources: [{ resourceId: "default", selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 }],
    },
  });
  // Nothing may ever dispatch in these fixtures: settlement is never needed.
  config.execution!.maxWorkers = 0;
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => sourceRoot });
  manager.sync();
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  await controller.restore({ waveRoots: [], bundles: [], groupRoots: [group.root] });
  const inspectTool = tools.find((tool) => tool.name === "SubtasksInspect");
  assert.ok(inspectTool, "SubtasksInspect must be registered");
  return { base, manager, execute: inspectTool.execute as ToolExecute };
}

test("registered SubtasksInspect rejects an omitted taskId immediately in activity and evidence modes", async () => {
  // Queued tasks stay active through restore (non-queued active states are
  // deliberately reclassified as paused_recoverable by restart recovery).
  const single = await managerWithGroup("exec-single53", [{ taskId: "task-single-1", state: "queued" }]);
  const multi = await managerWithGroup("exec-multi53", [
    { taskId: "task-multi-1", state: "queued" },
    { taskId: "task-multi-2", state: "queued" },
  ]);
  try {
    for (const [index, [groupLabel, executionId]] of [["single-task", "exec-single53"], ["multi-task", "exec-multi53"]].entries()) {
      const fixture = index === 0 ? single : multi;
      const cases: Array<{ label: string; params: Record<string, unknown> }> = [
        { label: `${groupLabel} activity {}`, params: {} },
        { label: `${groupLabel} activity executionId only`, params: { executionId } },
        { label: `${groupLabel} evidence without taskId`, params: { executionId, evidence: { index: 0 } } },
      ];
      for (const testCase of cases) {
        const response = await fixture.execute(`missing-${index}-${testCase.label}`, testCase.params);
        assert.equal(response.isError, true, testCase.label);
        assert.match(String(response.content[0].text), /Invalid SubtasksInspect request: inspect requires an explicit taskId; use a stable task handle/, testCase.label);
        assert.equal(typeof response.details.diagnostic, "string", testCase.label);
        // Immediate and concise: no group state is resolved or leaked, and the
        // old late evidence-only error is gone.
        assert.ok(!String(response.content[0].text).includes("Task handles"), testCase.label);
        assert.doesNotMatch(String(response.content[0].text), /Evidence inspection requires a known taskId/, testCase.label);
      }
    }
  } finally {
    await single.manager.shutdown();
    await multi.manager.shutdown();
    await rm(single.base, { recursive: true, force: true });
    await rm(multi.base, { recursive: true, force: true });
  }
});

test("registered SubtasksInspect with an explicit taskId keeps active, archived, and ownership behavior", async () => {
  const settledCount = INLINE_SETTLED_TASK_LIMIT + 4;
  const fixture = await managerWithGroup("exec-explicit53", [
    { taskId: "task-active-1", state: "queued" },
    { taskId: "task-active-2", state: "queued" },
    ...Array.from({ length: settledCount }, (_unused, index) => ({
      taskId: `task-settled-${String(index).padStart(2, "0")}`,
      state: "landed" as const,
      updatedAt: new Date(Date.parse("2025-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
    })),
  ]);
  try {
    // Active task inspection by explicit ID returns exactly that task.
    const active = await fixture.execute("explicit-active", { executionId: "exec-explicit53", taskId: "task-active-1" });
    assert.equal(active.isError, false);
    assert.deepEqual((active.details.tasks as Array<{ taskId: string }>).map((task) => task.taskId), ["task-active-1"]);
    assert.equal(active.details.tasks[0].state, "queued");
    assert.equal(active.details.tasks[0].dispatchState, "waiting_for_capacity");

    // The oldest settled tasks were evicted beyond the bounded inline window;
    // their exact handles still load the integrity-checked archive.
    const archived = await fixture.execute("explicit-archived", { executionId: "exec-explicit53", taskId: "task-settled-00" });
    assert.equal(archived.isError, false);
    assert.equal(archived.details.tasks[0].taskId, "task-settled-00");
    assert.equal(archived.details.tasks[0].state, "landed");
    assert.equal(archived.details.archivedCount, 4);

    // Existing ownership checks are preserved.
    const unknownTask = await fixture.execute("explicit-unknown-task", { executionId: "exec-explicit53", taskId: "task-missing" });
    assert.equal(unknownTask.isError, true);
    assert.match(String(unknownTask.content[0].text), /Unknown task task-missing/);
    const unknownExecution = await fixture.execute("explicit-unknown-execution", { executionId: "exec-missing53", taskId: "task-active-1" });
    assert.equal(unknownExecution.isError, true);
    assert.match(String(unknownExecution.content[0].text), /Unknown execution group exec-missing53/);
  } finally {
    await fixture.manager.shutdown();
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("registered shared guidance requires an explicit taskId for inspection only", () => {
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "unstarted",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] },
    }],
    execution: {
workerResources: [{ resourceId: "default", selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 }],
    },
  });
  config.execution!.maxWorkers = 0;
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => process.cwd() });
  manager.sync();
  const inspect = tools.find((tool) => tool.name === "SubtasksInspect");
  assert.ok(inspect, "SubtasksInspect must be registered");
  assert.match(String(inspect.description), /taskId is required/i);
  const guidelines = inspect.promptGuidelines as string[];
  assert.ok(
    guidelines.some((line) => line.startsWith("SubtasksInspect always requires an explicit taskId")),
    "shared guidance must require an explicit inspection taskId",
  );
  assert.ok(
    guidelines.some((line) => /for every other operation a taskId may be omitted only when the supplied executionId contains exactly one task/.test(line)),
    "shared guidance must keep the optional-ID contract for the other operations",
  );
});
