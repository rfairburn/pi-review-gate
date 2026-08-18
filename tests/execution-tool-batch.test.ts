import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import {
  BACKGROUND_TASK_STATES,
  isActiveTaskState,
  isForceMergeCandidateTaskState,
  isInterruptibleTaskState,
} from "../src/execution/background-controller";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

const executionToolNames = [
  "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue",
  "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean",
];

type ExecuteTool = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

function executionTool(tools: Array<Record<string, any>>, name: string): Record<string, any> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} was not registered`);
  return tool;
}

function harness(options: { slowExecutor?: boolean; expandedView?: boolean; researchCapable?: boolean; resourceCapacity?: number } = {}) {
  const tools: Array<Record<string, any>> = [];
  const commands: string[] = [];
  const commandHandlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const notices: string[] = [];
  const active: Array<{ name: string; enabled: boolean }> = [];
  const pi = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.push(name);
      commandHandlers.set(name, options.handler);
    },
    setToolActive(name: string, enabled: boolean) { active.push({ name, enabled }); },
    getActiveTools() { return ["read", "bash", ...executionToolNames]; },
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: options.researchCapable ? "codex-cli" : "run-as-binary",
      command: process.execPath,
      execution: {
        ...(options.researchCapable ? {} : { protocol: "pi-review-executor-jsonl-v1" as const }),
        args: options.slowExecutor
          ? ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{},30000))"]
          : undefined,
      },
    }],
    execution: options.resourceCapacity === undefined
      ? { activeExecutor: { source: "external", id: "fake" } }
      : {
          workerResources: [{
            resourceId: "fake-shared",
            selection: { source: "external", id: "fake" },
            maxConcurrent: options.resourceCapacity,
          }],
          routes: { execute: [{ resourceId: "fake-shared" }], research: [] },
          maxWorkers: 4,
        },
    ui: { subtasksViewExpanded: options.expandedView ?? false },
  });
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => process.cwd(),
    notify: (message) => { notices.push(message); },
    onExpandedViewChanged: (expanded) => { config.ui = { ...config.ui, subtasksViewExpanded: expanded }; },
  });
  manager.sync();
  return { tools, commands, commandHandlers, notices, active, manager, config };
}

test("operation-specific execution tools expose exact durable schemas", () => {
  const { tools, commands, active } = harness();
  assert.deepEqual(tools.map((tool) => tool.name), executionToolNames);
  assert.deepEqual(active, executionToolNames.map((name) => ({ name, enabled: true })));
  assert.deepEqual(commands.sort(), [
    "subtask-add",
    "subtask-force-merge",
    "subtask-inspect",
    "subtask-interrupt",
    "subtask-mark-clean",
    "subtask-steer",
    "subtasks",
    "subtasks-view",
  ]);
  const expectedProperties: Record<string, string[]> = {
    SubtasksStart: ["kind", "tasks"],
    SubtasksAdd: ["executionId", "tasks"],
    SubtasksInspect: ["executionId", "taskId", "offset", "lines"],
    SubtasksContinue: ["executionId", "taskId", "bundle", "instructions", "instructionId"],
    SubtasksSteer: ["executionId", "taskId", "instructions", "instructionId"],
    SubtasksInterrupt: ["executionId", "taskId", "interruptMode", "instructionId"],
    SubtasksForceMerge: ["executionId", "taskId", "mergeAnyhow", "instructionId"],
    SubtasksMarkClean: [],
  };
  for (const tool of tools) {
    assert.equal(tool.parameters.additionalProperties, false, tool.name);
    assert.deepEqual(Object.keys(tool.parameters.properties), expectedProperties[tool.name], tool.name);
    assert.equal(tool.parameters.properties.action, undefined, tool.name);
    assert.ok(tool.promptGuidelines.some((guideline: string) => /Steering wins over review/.test(guideline)), tool.name);
    assert.ok(tool.promptGuidelines.some((guideline: string) => /Quiet mode \(the default\)/.test(guideline)), tool.name);
  }
  const start = executionTool(tools, "SubtasksStart").parameters;
  assert.deepEqual(start.required, ["tasks"]);
  assert.equal(start.properties.tasks.minItems, 1);
  assert.equal(start.properties.tasks.maxItems, 16);
  assert.equal(start.properties.tasks.items.properties.wakeOn, undefined);
  assert.equal(start.properties.instructions, undefined);
  const forceMerge = executionTool(tools, "SubtasksForceMerge").parameters;
  assert.equal(forceMerge.properties.bundle, undefined);
  assert.match(forceMerge.properties.mergeAnyhow.description, /manual workspace inspection/i);
  assert.match(executionTool(tools, "SubtasksInterrupt").parameters.properties.interruptMode.description, /must always be inspected afterward/i);
});

test("background task state predicates classify every durable state consistently", () => {
  const active = new Set(["queued", "capturing", "running", "reviewing", "accepted", "waiting_to_land", "landing"]);
  for (const state of BACKGROUND_TASK_STATES) {
    assert.equal(isActiveTaskState(state), active.has(state), state);
    assert.equal(isInterruptibleTaskState(state), active.has(state), state);
    assert.equal(isForceMergeCandidateTaskState(state), !active.has(state), state);
  }
});

test("execution review readiness reports every unfinished task and omits terminal tasks", async () => {
  const { tools, manager } = harness({ slowExecutor: true });
  try {
    const execute = executionTool(tools, "SubtasksStart").execute as ExecuteTool;
    const started = await execute("readiness-start", {
      tasks: [{ title: "readiness task", instructions: "remain active", acceptanceCriteria: ["eventually finish"] }],
    }, undefined, undefined, {});
    assert.equal(started.isError, false);
    const readiness = manager.reviewReadiness();
    assert.equal(readiness.length, 1);
    assert.equal(readiness[0]?.kind, "execute");
    assert.equal(readiness[0]?.title, "readiness task");
    assert.ok(readiness[0] && isActiveTaskState(readiness[0].state));
  } finally {
    await manager.shutdown();
    await manager.detach();
  }
  assert.deepEqual(manager.reviewReadiness(), []);
});

test("saved executor settings govern queued dispatch while existing leases keep running", async () => {
  const tools: Array<Record<string, any>> = [];
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: ["qwen", "deepseek"].map((id) => ({
      id,
      adapter: "run-as-binary",
      command: process.execPath,
      execution: {
        protocol: "pi-review-executor-jsonl-v1",
        args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{},30000))"],
      },
    })),
    execution: {
      executorPool: [
        { entryId: "qwen", selection: { source: "external", id: "qwen" }, maxConcurrent: 1 },
        { entryId: "deepseek", selection: { source: "external", id: "deepseek" }, maxConcurrent: 1 },
      ],
      maxWorkers: 1,
    },
  });
  const manager = new ExecutionToolManager({
    pi: {
      registerTool(tool: Record<string, any>) { tools.push(tool); },
      registerCommand() {},
      setToolActive() {},
      getActiveTools() { return ["read", ...executionToolNames]; },
    },
    config,
    state: createState(),
    cwd: () => process.cwd(),
  });
  manager.sync();
  const start = executionTool(tools, "SubtasksStart").execute as ExecuteTool;
  const inspectTool = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;
  let executionRoot: string | undefined;
  try {
    const started = await start("live-settings-start", {
      tasks: [
        { title: "existing lease", instructions: "remain active", acceptanceCriteria: ["eventually finish"] },
        { title: "queued dispatch", instructions: "remain queued", acceptanceCriteria: ["eventually finish"] },
      ],
    }, undefined, undefined, {});
    executionRoot = started.details.root as string;
    const executionId = started.details.executionId as string;
    const inspect = async () => (await inspectTool("live-settings-inspect", { executionId }, undefined, undefined, {})).details as Record<string, any>;
    await waitUntil(async () => (await inspect()).tasks[0]?.executorEntryId === "qwen");

    config.execution!.executorPool = [
      { entryId: "deepseek", selection: { source: "external", id: "deepseek" }, maxConcurrent: 1 },
    ];
    config.execution!.maxWorkers = 2;
    manager.sync();

    const inspection = await waitUntil(async () => {
      const current = await inspect();
      return current.tasks[1]?.executorEntryId === "deepseek" ? current : undefined;
    });
    assert.equal(inspection.tasks[0]?.executorEntryId, "qwen");
    assert.equal(inspection.tasks[1]?.executorEntryId, "deepseek");
  } finally {
    await manager.shutdown();
    await manager.detach();
    if (executionRoot) await rm(executionRoot, { recursive: true, force: true });
  }
});

test("resource capacity is a grand total across independent subtask groups", async () => {
  const { tools, manager } = harness({ slowExecutor: true, resourceCapacity: 1 });
  try {
    const start = executionTool(tools, "SubtasksStart").execute as ExecuteTool;
    const first = await start("capacity-group-one", {
      tasks: [{ title: "First holder", instructions: "Remain active", acceptanceCriteria: ["Eventually finish"] }],
    }, undefined, undefined, {});
    const second = await start("capacity-group-two", {
      tasks: [{ title: "Second waiter", instructions: "Wait for capacity", acceptanceCriteria: ["Eventually finish"] }],
    }, undefined, undefined, {});

    assert.equal(first.details.scheduling.activePoolLeases, 1);
    assert.equal(second.details.tasks[0].dispatchState, "waiting_for_capacity");
    assert.equal(second.details.scheduling.activePoolLeases, 1);
    assert.equal(second.details.scheduling.availablePoolSlots, 0);
  } finally {
    await manager.shutdown();
    await manager.detach();
  }
});

test("operation-specific execution tools reject malformed and obsolete requests with diagnostics", async () => {
  const { tools } = harness();
  const start = executionTool(tools, "SubtasksStart").execute as ExecuteTool;
  for (const [id, request] of [
    ["empty", { tasks: [] }],
    ["obsolete", { tasks: [{ title: "T", instructions: "I", acceptanceCriteria: ["A"] }], maxWorkers: 2 }],
    ["unknown-task-key", { tasks: [{ title: "T", instructions: "I", acceptanceCriteria: ["A"], extra: true }] }],
    ["removed-wake-policy", { tasks: [{ title: "T", instructions: "I", acceptanceCriteria: ["A"], wakeOn: { completion: "now" } }] }],
  ] as const) {
    const result = await start(id, request, undefined, undefined, {});
    assert.equal(result.isError, true, id);
    assert.equal(typeof result.details.diagnostic, "string", id);
  }
  const steer = executionTool(tools, "SubtasksSteer").execute as ExecuteTool;
  const missingTarget = await steer("missing-steer-target", { instructions: "change direction" }, undefined, undefined, {});
  assert.equal(missingTarget.isError, true);
  assert.equal(typeof missingTarget.details.diagnostic, "string");
});

test("restoring an unverifiable background group drops it with a visible diagnostic", async () => {
  const notices: string[] = [];
  const manager = new ExecutionToolManager({
    pi: {},
    config: normalizeConfig({ enabled: false }),
    state: createState(),
    cwd: () => process.cwd(),
    notify: (message) => { notices.push(message); },
  });
  await manager.restoreAssociations({
    waveRoots: [],
    bundles: [],
    groupRoots: [join(tmpdir(), `pi-review-missing-execution-${process.pid}`)],
  });
  assert.deepEqual(manager.associations(), { waveRoots: [], bundles: [], groupRoots: [], conflictGate: undefined });
  assert.match(notices.join("\n"), /background execution was not restored/);
});

test("operation-specific execution tools render operation, task count, and durable task states", () => {
  const { tools } = harness();
  const theme = { bold: (value: string) => value, fg: (_color: string, value: string) => value };
  const start = executionTool(tools, "SubtasksStart");
  const call = start.renderCall({ tasks: [{}, {}, {}] }, theme).render(100).join("\n");
  assert.match(call, /SubtasksStart/);
  assert.match(call, /3 tasks/);
  const rendered = executionTool(tools, "SubtasksInspect").renderResult({
    content: [{ type: "text", text: "inspect: execution exec-1" }],
    details: {
      tasks: [
        { taskId: "task-q", state: "queued", dispatchState: "waiting_for_capacity", definition: { title: "Waiting work" } },
        { taskId: "task-s", state: "queued", dispatchState: "assigned_starting", definition: { title: "Starting work" } },
        { taskId: "task-a", state: "running", definition: { title: "Fast work" } },
        { taskId: "task-b", state: "conflicted", definition: { title: "Needs merge" } },
      ],
    },
  }, {}, theme).render(120).join("\n");
  assert.match(rendered, /task-q queued \(executor capacity wait\) Waiting work/);
  assert.match(rendered, /task-s queued \(executor assigned\/startup\) Starting work/);
  assert.match(rendered, /task-a running Fast work/);
  assert.match(rendered, /task-b conflicted Needs merge/);
});

test("/subtasks-view toggles a live multiline widget without entering model context", async () => {
  const { commandHandlers, manager, config } = harness();
  const widgetCalls: Array<{ key: string; content: unknown; placement?: string }> = [];
  const ctx = {
    ui: {
      setWidget(key: string, content: unknown, options?: { placement?: string }) {
        widgetCalls.push({ key, content, placement: options?.placement });
      },
    },
  };
  await commandHandlers.get("subtasks-view")!("", ctx);
  assert.equal(widgetCalls.at(-1)?.key, "review-gate-subtasks");
  assert.equal(widgetCalls.at(-1)?.placement, "belowEditor");
  assert.equal(typeof widgetCalls.at(-1)?.content, "function");
  const expanded = renderWidget(widgetCalls.at(-1)?.content).join("\n");
  assert.match(expanded, /expanded live view/);
  assert.match(expanded, /10 newest events across all tasks/);
  assert.equal(config.ui?.subtasksViewExpanded, true);
  assert.equal("subtasksViewExpanded" in manager.associations(), false);
  const restoredHarness = harness({ expandedView: true });
  const restoredWidgets: unknown[] = [];
  restoredHarness.manager.setUiContext({
    ui: { setWidget: (_key: string, content: unknown) => restoredWidgets.push(content) },
  });
  assert.match(renderWidget(restoredWidgets.at(-1)).join("\n"), /expanded live view/);
  await restoredHarness.manager.shutdown();
  await commandHandlers.get("subtasks-view")!("", ctx);
  assert.equal(widgetCalls.at(-1)?.content, undefined);
  assert.equal(config.ui?.subtasksViewExpanded, false);
});

test("SubtasksStart result explains that queued work may have startup delay", async () => {
  const { tools, manager } = harness();
  const execute = executionTool(tools, "SubtasksStart").execute as ExecuteTool;
  const result = await execute("start-delay", {
    tasks: [{ title: "Waiting work", instructions: "Do bounded work", acceptanceCriteria: ["Work is complete"] }],
  }, undefined, undefined, {});
  assert.match(result.content[0].text, /Queued tasks may wait for executor startup or available pool capacity/);
  assert.match(result.content[0].text, /Scheduler at acceptance: 1 task\(s\) assigned and starting, 0 still pending dispatch/);
  assert.match(result.content[0].text, /Assignment is not proof that executor startup has completed/);
  assert.equal(result.details.scheduling.dispatchPending, 0);
  assert.equal(result.details.scheduling.dispatchAssigned, 1);
  assert.equal(result.details.scheduling.configuredWorkerLimit, 4);
  assert.equal(result.details.scheduling.estimatedImmediatelyAvailableSlots, 3);
  assert.match(result.content[0].text, /Quiet notification mode is active/);
  assert.match(result.content[0].text, /Every task still triggers a turn when it lands/);
  assert.match(result.content[0].text, /Internal progress stays available in SubtasksInspect and \/subtasks-view without triggering turns/);
  assert.match(result.content[0].text, /DO NOT POLL for task-state changes/);
  assert.match(result.content[0].text, /repeated inspect loop, or other waiting surrogate/);
  assert.match(result.content[0].text, new RegExp(result.details.tasks[0].taskId));
  assert.match(result.content[0].text, /Task handles \(retain these for SubtasksSteer, SubtasksInterrupt, and SubtasksInspect\)/);
  assert.match(result.content[0].text, /executor assigned; startup in progress/);
  assert.deepEqual(result.details.tasks[0].definition.executorAllowedTools, ["read", "bash", ...executionToolNames]);
  assert.deepEqual(result.details.tasks[0].timing, {
    queueMs: result.details.tasks[0].timing.queueMs,
    captureMs: 0,
    executionMs: 0,
    reviewMs: 0,
    landingMs: 0,
    totalMs: result.details.tasks[0].timing.totalMs,
  });
  await manager.shutdown();
});

test("SubtasksStart creates immutable research groups with a parent-intersected read-only toolset", async () => {
  const { tools, manager } = harness({ slowExecutor: true, researchCapable: true });
  const start = executionTool(tools, "SubtasksStart").execute as ExecuteTool;
  const add = executionTool(tools, "SubtasksAdd").execute as ExecuteTool;
  const started = await start("research-start", {
    kind: "research",
    tasks: [{
      title: "Inspect safely",
      instructions: "Read the repository and report findings",
      acceptanceCriteria: ["Evidence-backed report is returned"],
    }],
  }, undefined, undefined, {});

  assert.equal(started.details.kind, "research");
  assert.match(started.content[0].text, /research group/);
  assert.deepEqual(started.details.tasks[0].definition.executorAllowedTools, ["read"]);
  assert.equal(started.details.tasks[0].definition.backgroundKind, "research");
  assert.equal(manager.reviewReadiness()[0]?.kind, "research");

  const added = await add("research-add", {
    executionId: started.details.executionId,
    tasks: [{
      title: "Inspect another area",
      instructions: "Read another area and report findings",
      acceptanceCriteria: ["A second report is returned"],
    }],
  }, undefined, undefined, {});
  assert.equal(added.details.kind, "research");
  assert.equal(added.details.tasks[1].definition.backgroundKind, "research");
  assert.deepEqual(added.details.tasks[1].definition.executorAllowedTools, ["read"]);
  await manager.shutdown();
});

test("slash-command task inspection uses an interactive picker when IDs are omitted", async () => {
  const { tools, commandHandlers, notices, manager } = harness();
  const execute = executionTool(tools, "SubtasksStart").execute as ExecuteTool;
  const started = await execute("picker-start", {
    tasks: [{ title: "Pick me", instructions: "Do bounded work", acceptanceCriteria: ["Work is complete"] }],
  }, undefined, undefined, {});
  const selectedOptions: string[][] = [];
  await commandHandlers.get("subtask-inspect")!("", {
    ui: {
      select: async (_title: string, options: string[]) => {
        selectedOptions.push(options);
        return options[0];
      },
    },
  });
  assert.match(selectedOptions[0]![0]!, /Pick me/);
  assert.match(selectedOptions[0]![0]!, new RegExp(started.details.tasks[0].taskId));
  assert.match(notices.at(-1) ?? "", new RegExp(started.details.tasks[0].taskId));
  await manager.shutdown();
});

test("slash-command interrupt selects both the task and outcome when IDs are omitted", async () => {
  const { tools, commandHandlers, notices, manager } = harness({ slowExecutor: true });
  const execute = executionTool(tools, "SubtasksStart").execute as ExecuteTool;
  const started = await execute("interrupt-picker-start", {
    tasks: [{ title: "Cancel me", instructions: "Wait for interruption", acceptanceCriteria: ["Task is interrupted"] }],
  }, undefined, undefined, {});
  const selections: string[] = [];
  await commandHandlers.get("subtask-interrupt")!("", {
    ui: {
      select: async (title: string, options: string[]) => {
        selections.push(title);
        return title === "Interrupt outcome" ? "Interrupt as failure" : options[0];
      },
    },
  });
  assert.deepEqual(selections, ["Interrupt background subtask", "Interrupt outcome"]);
  assert.match(notices.at(-1) ?? "", new RegExp(started.details.tasks[0].taskId));
  assert.match(notices.at(-1) ?? "", /interrupted/);
  await manager.shutdown();
});

function renderWidget(content: unknown, width = 240): string[] {
  assert.equal(typeof content, "function");
  const component = (content as () => { render(width: number): string[] })();
  return component.render(width);
}

async function waitUntil<T>(condition: () => Promise<T | undefined | false>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value !== undefined && value !== false) return value;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`condition was not satisfied within ${timeoutMs}ms`);
}
