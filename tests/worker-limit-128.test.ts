/**
 * Issue #119: deterministic coverage for the raised 128-worker/batch limit.
 *
 * These tests never spawn 128 executor processes or make a provider call. They
 * drive the real production accounting instead of reimplementing it:
 *   - `normalizeConfig` / settings validation for the configurable ceilings,
 *   - `ExecutorPoolScheduler` for the shared per-resource lease ledger,
 *   - the `ExecutionToolManager` schema + runtime task-normalization path,
 *   - the background controller's `schedulingSnapshot` (via `inspect`) for the
 *     global worker budget vs. the shared resource budget, excess queueing,
 *     and lease release/refill.
 * A small deferred-executor end-to-end case exercises real settlement and
 * cancellation slot release/refill with the same production controller.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_MAX_WORKERS,
  MAX_EXECUTION_WORKERS,
  normalizeConfig,
  resolvedWorkerResources,
  type ReviewGateConfig,
} from "../src/config";
import { ExecutorPoolScheduler, type ExecutorPoolLease } from "../src/execution/executor-pool";
import {
  BackgroundExecutionController,
  MAX_UNSETTLED_TASKS_PER_EXECUTION,
  type BackgroundExecutionGroup,
  type BackgroundTaskRecord,
} from "../src/execution/background-controller";
import { transitionTaskState } from "../src/execution/task-state";
import { ExecutionToolManager } from "../src/execution/tool";
import { validateSelection } from "../src/settings/validation";
import { createState } from "../src/state";
import { initGitRepo, settleOldestUnsettled, waitFor } from "./helpers/background-controller-fixtures";

type ExecuteTool = (
  id: string,
  params: unknown,
  signal?: AbortSignal,
  update?: unknown,
  ctx?: unknown,
) => Promise<Record<string, any>>;

// ── fixtures ─────────────────────────────────────────────────────────────────

/** One external executor resource with an explicit shared capacity. */
function workerConfig(options: {
  maxWorkers?: number;
  capacity?: number;
  resources?: Record<string, number>;
}): ReviewGateConfig {
  const resources = options.resources ?? { default: options.capacity ?? 128 };
  const catalog: Record<string, { selection: { source: "external"; id: string }; maxConcurrent: number }> = {};
  const routes: Array<{ resourceId: string }> = [];
  const agents: Record<string, unknown> = {};
  for (const [id, maxConcurrent] of Object.entries(resources)) {
    catalog[id] = { selection: { source: "external", id }, maxConcurrent };
    routes.push({ resourceId: id });
    agents[id] = {
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] },
    };
  }
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: agents,
    execution: {
      ...(options.maxWorkers !== undefined ? { maxWorkers: options.maxWorkers } : {}),
      workerResources: catalog,
      routes: { execute: routes, research: [] },
    },
    retainBundles: "always",
  });
}

function poolOf(controller: BackgroundExecutionController): ExecutorPoolScheduler {
  return (controller as unknown as { pool: ExecutorPoolScheduler }).pool;
}

function controllerOf(manager: ExecutionToolManager): BackgroundExecutionController {
  return (manager as unknown as { controller: BackgroundExecutionController }).controller;
}

function definitions(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    title: `task ${index}`,
    instructions: `bounded work ${index}`,
    acceptanceCriteria: ["done"],
  }));
}

function toolHarness(config: ReviewGateConfig) {
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() { /* not required by these tests */ },
    setToolActive() { /* no-op */ },
    getActiveTools: () => ["read", "bash", "SubtasksStart", "SubtasksAdd"],
  };
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => process.cwd() });
  manager.sync();
  return {
    tools,
    manager,
    start: () => tools.find((tool) => tool.name === "SubtasksStart") as Record<string, any>,
    add: () => tools.find((tool) => tool.name === "SubtasksAdd") as Record<string, any>,
  };
}

/** A deferred lifecycle-runner substitute used by the scheduler-count tests. */
interface DeferredLifecycleRunner {
  runner: (
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    abort: AbortController,
    lease: ExecutorPoolLease,
  ) => Promise<void>;
  started: string[];
  active: () => number;
  settle: (taskId: string) => void;
  /** Resolve every current and future runner immediately, draining the queue. */
  drain: () => void;
}

/**
 * Deterministic lifecycle-runner substitute: each dispatch suspends until it is
 * settled, then records a landed state exactly like a real runner would. The
 * controller's own pump, launch, lease, and finalization accounting is what is
 * under test here, so the substitute never touches a worktree, process, or
 * provider.
 */
function deferredLifecycleRunner(): DeferredLifecycleRunner {
  const pending = new Map<string, () => void>();
  const started: string[] = [];
  let auto = false;
  const finish = (task: BackgroundTaskRecord): void => {
    transitionTaskState(task, "landed");
    task.summary = "synthetic settlement";
  };
  const runner = (_group: BackgroundExecutionGroup, task: BackgroundTaskRecord): Promise<void> => {
    started.push(task.taskId);
    if (auto) return Promise.resolve().then(() => finish(task));
    return new Promise<void>((resolve) => { pending.set(task.taskId, resolve); }).then(() => finish(task));
  };
  const release = (taskId: string): void => {
    const resolve = pending.get(taskId);
    if (!resolve) return;
    pending.delete(taskId);
    resolve();
  };
  return {
    runner,
    started,
    active: () => pending.size,
    settle: release,
    drain: () => {
      auto = true;
      for (const taskId of [...pending.keys()]) release(taskId);
    },
  };
}

/** A deferred fake executor: every turn blocks until a release-gate file exists. */
async function writeDeferredExecutor(root: string): Promise<{ command: string; gate: string }> {
  const command = join(root, "deferred-executor.cjs");
  await writeFile(command, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    "const finish=()=>{",
    "if(prompt.includes('TASK_A'))fs.writeFileSync('a.txt','a landed\\n');",
    "if(prompt.includes('TASK_B'))fs.writeFileSync('b.txt','b landed\\n');",
    "if(prompt.includes('TASK_C'))fs.writeFileSync('c.txt','c landed\\n');",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
    "};",
    "const gate=process.env.PI_REVIEW_EXECUTOR_TEST_GATE;",
    "const poll=setInterval(()=>{if(gate&&fs.existsSync(gate)){clearInterval(poll);finish();}},10);",
    "});",
  ].join("\n"), "utf8");
  await chmod(command, 0o755);
  return { command, gate: join(root, "release-gate") };
}

// ── configurable ceilings ────────────────────────────────────────────────────

test("worker and batch ceilings are 128 with an unchanged default of 4", () => {
  assert.equal(DEFAULT_MAX_WORKERS, 4);
  assert.equal(MAX_EXECUTION_WORKERS, 128);
  assert.equal(MAX_UNSETTLED_TASKS_PER_EXECUTION, 128);
});

test("normalizeConfig accepts maxWorkers 128 and rejects 129 while defaulting to 4", () => {
  assert.equal(normalizeConfig({ enabled: true, execution: {} }).execution?.maxWorkers, undefined);

  for (const maxWorkers of [1, 32, 64, 128]) {
    const config = normalizeConfig({ enabled: true, execution: { maxWorkers } });
    assert.equal(config.execution?.maxWorkers, maxWorkers);
  }
  assert.throws(
    () => normalizeConfig({ enabled: true, execution: { maxWorkers: 129 } }),
    /maxWorkers must be between 1 and 128/,
  );
  assert.throws(
    () => normalizeConfig({ enabled: true, execution: { maxWorkers: 0 } }),
    /maxWorkers must be between 1 and 128/,
  );
});

test("normalizeConfig accepts per-resource maxConcurrent 128 and rejects 129", () => {
  const config = workerConfig({ capacity: 128 });
  assert.deepEqual(resolvedWorkerResources(config).map((entry) => entry.maxConcurrent), [128]);

  assert.throws(
    () => workerConfig({ capacity: 129 }),
    /execution\.workerResources\.default\.maxConcurrent must be between 1 and 128/,
  );
});

test("settings validation accepts a 128 resource capacity and rejects 129", async () => {
  const config = workerConfig({ maxWorkers: 128, capacity: 128 });
  const catalog = resolvedWorkerResources(config);
  const workers = Object.fromEntries(catalog.map((entry) => [entry.entryId, { selection: entry.selection, maxConcurrent: entry.maxConcurrent }]));

  assert.equal(await validateSelection(workers, [], config, []), undefined);

  const over = { ...workers, default: { ...workers.default!, maxConcurrent: 129 } };
  assert.equal(
    await validateSelection(over, [], config, []),
    "Executor maximum concurrency must be between 1 and 128: default",
  );
});

// ── shared resource ledger (ExecutorPoolScheduler) ───────────────────────────

test("a 128-capacity resource grants exactly 128 leases and releases them without leaks", () => {
  const scheduler = new ExecutorPoolScheduler([
    { entryId: "one", selection: { source: "external", id: "one" }, maxConcurrent: 128 },
  ]);
  const leases = Array.from({ length: 128 }, () => scheduler.tryAcquire());
  assert.ok(leases.every((lease) => lease?.entry.entryId === "one"));
  assert.equal(scheduler.tryAcquire(), undefined, "the 129th lease is refused");
  assert.deepEqual(scheduler.capacitySnapshot(), {
    totalCapacity: 128,
    activeLeases: 128,
    availableSlots: 0,
    entries: [{ entryId: "one", priority: 0, capacity: 128, activeLeases: 128, availableSlots: 0 }],
  });

  // Releasing one lease makes exactly one slot immediately available again.
  leases.pop()!.release();
  assert.equal(scheduler.capacitySnapshot().availableSlots, 1);
  const refilled = scheduler.tryAcquire()!;
  assert.equal(scheduler.capacitySnapshot().availableSlots, 0);

  refilled.release();
  leases.forEach((lease) => lease!.release());
  assert.equal(scheduler.capacitySnapshot().activeLeases, 0);
  assert.equal(scheduler.activeCount("one"), 0);
});

test("execution and research routes share one 128-slot physical capacity ledger", () => {
  const entries = [
    { entryId: "shared", selection: { source: "external" as const, id: "shared" }, maxConcurrent: 128 },
  ];
  const scheduler = new ExecutorPoolScheduler(entries);
  const executeRoute = [entries[0]!];
  const researchRoute = [entries[0]!];

  const executeLeases = Array.from({ length: 128 }, () => scheduler.tryAcquireRoute(executeRoute));
  assert.ok(executeLeases.every(Boolean));
  assert.equal(scheduler.tryAcquireRoute(researchRoute), undefined, "research cannot exceed the shared 128 slots");

  executeLeases.pop()!.release();
  const research = scheduler.tryAcquireRoute(researchRoute);
  assert.equal(research?.entry.entryId, "shared", "research takes the freed shared slot");
  assert.equal(scheduler.activeCount("shared"), 128);

  research!.release();
  executeLeases.forEach((lease) => lease!.release());
  assert.equal(scheduler.activeCount("shared"), 0);
});

test("an aborted capacity waiter releases cleanly and leaves no phantom lease", async () => {
  const scheduler = new ExecutorPoolScheduler([
    { entryId: "one", selection: { source: "external", id: "one" }, maxConcurrent: 128 },
  ]);
  const held = Array.from({ length: 128 }, () => scheduler.tryAcquire()!);
  const abort = new AbortController();
  const waiter = scheduler.acquireAfter(-1, abort.signal);
  assert.equal(scheduler.capacitySnapshot().activeLeases, 128);

  abort.abort();
  assert.equal(await waiter, undefined);
  assert.equal(scheduler.capacitySnapshot().activeLeases, 128, "an aborted waiter never charges capacity");

  held.forEach((lease) => lease.release());
  assert.equal(scheduler.capacitySnapshot().activeLeases, 0);
  assert.ok(scheduler.tryAcquire(), "capacity is reusable after the abort");
});

// ── SubtasksStart / SubtasksAdd schema and runtime boundaries ────────────────

test("SubtasksStart and SubtasksAdd schemas admit 1..128 tasks", async () => {
  const config = workerConfig({ maxWorkers: 128, capacity: 128 });
  const { manager, start, add } = toolHarness(config);
  try {
    // Nothing may dispatch: keep the runtime admission path pure for this test.
    config.execution!.maxWorkers = 0;
    for (const tool of [start(), add()]) {
      assert.equal(tool.parameters.properties.tasks.minItems, 1);
      assert.equal(tool.parameters.properties.tasks.maxItems, 128);
      assert.match(String(tool.parameters.properties.tasks.description), /One to 128 bounded task definitions/);
      assert.match(String(tool.description), /1–128/);
    }
  } finally {
    await manager.shutdown();
    await manager.detach();
  }
});

test("SubtasksStart runtime accepts 128 tasks and rejects 129", async () => {
  const config = workerConfig({ maxWorkers: 128, capacity: 128 });
  const { manager, start } = toolHarness(config);
  config.execution!.maxWorkers = 0;
  const execute = start().execute as ExecuteTool;
  try {
    const accepted = await execute("start-128", { tasks: definitions(128) });
    assert.equal(accepted.isError, false);
    assert.equal(accepted.details.tasks.length, 128);
    assert.equal(accepted.details.scheduling.configuredWorkerLimit, 0);
    assert.equal(accepted.details.scheduling.globallyDispatchPending, 128);

    const rejected = await execute("start-129", { tasks: definitions(129) });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /tasks must contain 1\.\.128 items/);
  } finally {
    await manager.shutdown();
    await manager.detach();
  }
});

test("SubtasksAdd runtime accepts 128 tasks and rejects 129", async () => {
  const config = workerConfig({ maxWorkers: 128, capacity: 128 });
  const { manager, start, add } = toolHarness(config);
  config.execution!.maxWorkers = 0;
  const executeStart = start().execute as ExecuteTool;
  const executeAdd = add().execute as ExecuteTool;
  try {
    const started = await executeStart("start-one", {
      tasks: [{ title: "seed", instructions: "seed work", acceptanceCriteria: ["done"] }],
    });
    const executionId = started.details.executionId as string;
    // Free the single unsettled admission slot through production bookkeeping.
    await settleOldestUnsettled(controllerOf(manager), executionId, "seed settled");

    const accepted = await executeAdd("add-128", { executionId, tasks: definitions(128) });
    assert.equal(accepted.isError, false);
    assert.equal(accepted.details.historicalCount, 129);
    assert.equal(accepted.details.scheduling.globallyDispatchPending, 128);

    const rejected = await executeAdd("add-129", { executionId, tasks: definitions(129) });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /tasks must contain 1\.\.128 items/);
  } finally {
    await manager.shutdown();
    await manager.detach();
  }
});

// ── 128 lifecycle slots through the real pump/launch/lease path ─────────────

test("128 lifecycle workers dispatch across groups and refill without exceeding the global budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-lifecycle-128-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root, {});
    const deferred = deferredLifecycleRunner();
    controller = new BackgroundExecutionController({
      pi: {},
      // Two resources whose summed capacity (160) exceeds the global budget,
      // so the global budget binds.
      config: workerConfig({ maxWorkers: 128, resources: { alpha: 120, beta: 40 } }),
      state: createState(),
      cwd: () => root,
      lifecycleRunner: deferred.runner,
    });
    const groupA = await controller.start(definitions(128));
    const groupB = await controller.start([{ title: "overflow", instructions: "overflow work", acceptanceCriteria: ["done"] }]);

    // Exactly 128 lifecycle workers actually launched: the 129th task across
    // the second group stays queued.
    const accepted = controller.inspect(groupA.executionId).scheduling;
    assert.equal(accepted.configuredWorkerLimit, 128);
    assert.equal(accepted.configuredPoolCapacity, 160, "pooled capacity exceeds the global budget");
    assert.equal(accepted.activeWorkers, 128, "the real pump dispatched exactly the global budget");
    assert.equal(accepted.activePoolLeases, 128);
    assert.equal(accepted.globallyDispatchPending, 1, "the 129th task stays pending");
    assert.equal(deferred.started.length, 128);
    assert.equal(deferred.active(), 128);

    // Settling one dispatched worker frees exactly one slot; the queued task in
    // the OTHER group claims it and the global budget is never exceeded.
    const firstTaskId = controller.inspect(groupA.executionId).tasks[0]!.taskId;
    deferred.settle(firstTaskId);
    await waitFor(() => controller!.inspect(groupA.executionId).scheduling.globallyDispatchPending === 0, 15_000);
    const refilled = controller.inspect(groupA.executionId).scheduling;
    assert.equal(refilled.activeWorkers, 128, "refill keeps the budget at exactly 128");
    assert.equal(refilled.activePoolLeases, 128);
    assert.equal(deferred.started.length, 129, "the queued task launched after the slot freed");
    assert.equal(deferred.active(), 128);
    assert.equal(controller.inspect(groupA.executionId).tasks[0]!.state, "landed");
    assert.equal(controller.inspect(groupB.executionId).scheduling.dispatchPending, 0, "group B now holds the freed slot");

    // Settling every runner drains the queue and releases every lease.
    deferred.drain();
    await waitFor(() => {
      const current = controller!.inspect(groupA.executionId);
      return current.scheduling.activeWorkers === 0
        && current.scheduling.activePoolLeases === 0
        && current.scheduling.globallyDispatchPending === 0
        && controller!.inspect(groupB.executionId).scheduling.activeWorkers === 0;
    }, 15_000);
    assert.equal(deferred.active(), 0);
    assert.equal(poolOf(controller).capacitySnapshot().activeLeases, 0, "no lease leak after settlement");
    assert.ok(controller.inspect(groupA.executionId).tasks.every((task) => task.state === "landed"));
    assert.equal(controller.inspect(groupB.executionId).tasks[0]!.state, "landed");
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a shared resource budget below the global budget caps real dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-lifecycle-resource-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root, {});
    const deferred = deferredLifecycleRunner();
    controller = new BackgroundExecutionController({
      pi: {},
      // The shared resource budget is smaller than the global worker budget.
      config: workerConfig({ maxWorkers: 128, capacity: 100 }),
      state: createState(),
      cwd: () => root,
      lifecycleRunner: deferred.runner,
    });
    const started = await controller.start(definitions(128));
    const accepted = controller.inspect(started.executionId).scheduling;
    assert.equal(accepted.configuredWorkerLimit, 128);
    assert.equal(accepted.configuredPoolCapacity, 100, "the shared resource budget is smaller");
    assert.equal(accepted.activeWorkers, 100, "the resource budget binds below the global budget");
    assert.equal(accepted.activePoolLeases, 100);
    assert.equal(accepted.globallyDispatchPending, 28);
    assert.equal(deferred.started.length, 100);

    deferred.drain();
    await waitFor(() => {
      const current = controller!.inspect(started.executionId).scheduling;
      return current.activeWorkers === 0 && current.activePoolLeases === 0 && current.globallyDispatchPending === 0;
    }, 15_000);
    assert.equal(deferred.active(), 0);
    assert.equal(poolOf(controller).capacitySnapshot().activeLeases, 0);
    assert.ok(controller.inspect(started.executionId).tasks.every((task) => task.state === "landed"));
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// ── deferred-executor settlement / cancellation refill ──────────────────────

test("deferred executors respect the global budget, queue excess, and release slots on settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-deferred-settle-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const { command, gate } = await writeDeferredExecutor(root);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        deferred: {
          adapter: "run-as-binary",
          command,
          env: { PI_REVIEW_EXECUTOR_TEST_GATE: gate },
          execution: { protocol: "pi-review-executor-jsonl-v1" },
        },
      },
      execution: {
        maxWorkers: 2,
        workerResources: { default: { selection: { source: "external", id: "deferred" }, maxConcurrent: 2 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
      },
      retainBundles: "always",
    });
    controller = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    const started = await controller.start([
      { title: "a", instructions: "TASK_A", acceptanceCriteria: ["a.txt exists"] },
      { title: "b", instructions: "TASK_B", acceptanceCriteria: ["b.txt exists"] },
      { title: "c", instructions: "TASK_C", acceptanceCriteria: ["c.txt exists"] },
    ]);

    const accepted = controller.inspect(started.executionId);
    assert.equal(accepted.scheduling.configuredWorkerLimit, 2);
    assert.equal(accepted.scheduling.configuredPoolCapacity, 2);
    assert.equal(accepted.scheduling.activeWorkers, 2, "both slots dispatched");
    assert.equal(accepted.scheduling.activePoolLeases, 2);
    assert.equal(accepted.scheduling.dispatchPending, 1, "the third task queues");
    assert.equal(accepted.scheduling.globallyDispatchPending, 1);
    assert.equal(accepted.scheduling.estimatedImmediatelyAvailableSlots, 0);

    await writeFile(gate, "release\n", "utf8");
    // Wait for the full lifecycle bookkeeping: a task can read as landed a tick
    // before its launch finally releases the lease.
    await waitFor(() => {
      const current = controller!.inspect(started.executionId);
      return current.activeCount === 0
        && current.scheduling.activeWorkers === 0
        && current.scheduling.activePoolLeases === 0
        && current.tasks.every((task) => task.state === "landed");
    }, 30_000);

    const settled = controller.inspect(started.executionId);
    assert.equal(settled.peakConcurrency, 2, "concurrency never exceeded the configured budget");
    assert.equal(settled.scheduling.activeWorkers, 0);
    assert.equal(settled.scheduling.activePoolLeases, 0, "every lease released after settlement");
    assert.equal(settled.scheduling.globallyDispatchPending, 0);
    assert.equal(poolOf(controller).capacitySnapshot().activeLeases, 0);
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling a dispatched task releases its slot so a queued task refills it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-deferred-cancel-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const { command, gate } = await writeDeferredExecutor(root);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        deferred: {
          adapter: "run-as-binary",
          command,
          env: { PI_REVIEW_EXECUTOR_TEST_GATE: gate },
          execution: { protocol: "pi-review-executor-jsonl-v1" },
        },
      },
      execution: {
        maxWorkers: 1,
        workerResources: { default: { selection: { source: "external", id: "deferred" }, maxConcurrent: 1 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
      },
      retainBundles: "always",
    });
    controller = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    const started = await controller.start([
      { title: "a", instructions: "TASK_A", acceptanceCriteria: ["a.txt exists"] },
      { title: "b", instructions: "TASK_B", acceptanceCriteria: ["b.txt exists"] },
    ]);
    const [first, second] = started.tasks;
    const queued = controller.inspect(started.executionId).scheduling;
    assert.equal(queued.activeWorkers, 1);
    assert.equal(queued.globallyDispatchPending, 1);

    await controller.interrupt({
      executionId: started.executionId,
      taskId: first!.taskId,
      mode: "interrupt_as_failure",
      instructionId: "cancel-first",
      actor: "user",
    });
    await waitFor(() => controller!.inspect(started.executionId).scheduling.globallyDispatchPending === 0, 15_000);

    const refilled = controller.inspect(started.executionId);
    assert.equal(refilled.tasks.find((task) => task.taskId === first!.taskId)?.state, "interrupted");
    assert.equal(refilled.scheduling.activeWorkers, 1, "the queued task took the freed slot");
    assert.equal(refilled.scheduling.globallyDispatchPending, 0);
    assert.ok(
      ["queued", "capturing", "running", "reviewing", "landed"].includes(
        refilled.tasks.find((task) => task.taskId === second!.taskId)!.state,
      ),
    );

    await writeFile(gate, "release\n", "utf8");
    await waitFor(() => {
      const current = controller!.inspect(started.executionId);
      return current.activeCount === 0
        && current.scheduling.activeWorkers === 0
        && current.scheduling.activePoolLeases === 0;
    }, 30_000);
    const finished = controller.inspect(started.executionId);
    assert.equal(finished.scheduling.activeWorkers, 0);
    assert.equal(finished.scheduling.activePoolLeases, 0, "no lease leak after cancellation");
    assert.equal(poolOf(controller).capacitySnapshot().activeLeases, 0);
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
