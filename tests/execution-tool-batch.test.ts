import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

function harness(options: { slowExecutor?: boolean } = {}) {
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
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: {
        protocol: "pi-review-executor-jsonl-v1",
        args: options.slowExecutor
          ? ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{},30000))"]
          : undefined,
      },
    }],
    execution: { activeExecutor: { source: "external", id: "fake" } },
  });
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => process.cwd(), notify: (message) => { notices.push(message); } });
  manager.sync();
  return { tools, commands, commandHandlers, notices, active, manager, config };
}

test("ExecuteSubtasks is the sole execution tool and exposes the durable action surface", () => {
  const { tools, commands, active } = harness();
  assert.deepEqual(tools.map((tool) => tool.name), ["ExecuteSubtasks"]);
  assert.deepEqual(active.at(-1), { name: "ExecuteSubtasks", enabled: true });
  assert.deepEqual(commands.sort(), [
    "subtask-add",
    "subtask-force-merge",
    "subtask-inspect",
    "subtask-interrupt",
    "subtask-mark-clean",
    "subtask-steer",
    "subtasks",
  ]);
  const parameters = tools[0]!.parameters as Record<string, any>;
  assert.deepEqual(parameters.required, ["action"]);
  assert.deepEqual(parameters.properties.action.enum, [
    "start", "add", "inspect", "continue", "steer", "interrupt", "force_merge", "mark_clean",
  ]);
  assert.equal(parameters.properties.tasks.minItems, 1);
  assert.equal(parameters.properties.tasks.maxItems, 16);
  assert.equal(parameters.properties.maxWorkers, undefined);
  assert.equal(parameters.properties.parallelism, undefined);
});

test("ExecuteSubtasks rejects malformed and obsolete requests with diagnostics", async () => {
  const { tools } = harness();
  const execute = tools[0]!.execute as (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;
  for (const [id, request] of [
    ["empty", { action: "start", tasks: [] }],
    ["obsolete", { action: "start", tasks: [{ title: "T", instructions: "I", acceptanceCriteria: ["A"] }], maxWorkers: 2 }],
    ["unknown-task-key", { action: "start", tasks: [{ title: "T", instructions: "I", acceptanceCriteria: ["A"], extra: true }] }],
    ["missing-steer-target", { action: "steer", instructions: "change direction" }],
  ] as const) {
    const result = await execute(id, request, undefined, undefined, {});
    assert.equal(result.isError, true, id);
    assert.equal(typeof result.details.diagnostic, "string", id);
  }
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

test("ExecuteSubtasks renders action, task count, and durable task states", () => {
  const { tools } = harness();
  const theme = { bold: (value: string) => value, fg: (_color: string, value: string) => value };
  const call = tools[0]!.renderCall({ action: "start", tasks: [{}, {}, {}] }, theme).render(100).join("\n");
  assert.match(call, /ExecuteSubtasks start/);
  assert.match(call, /3 tasks/);
  const rendered = tools[0]!.renderResult({
    content: [{ type: "text", text: "inspect: execution exec-1" }],
    details: {
      tasks: [
        { taskId: "task-q", state: "queued", definition: { title: "Waiting work" } },
        { taskId: "task-a", state: "running", definition: { title: "Fast work" } },
        { taskId: "task-b", state: "conflicted", definition: { title: "Needs merge" } },
      ],
    },
  }, {}, theme).render(120).join("\n");
  assert.match(rendered, /task-q queued \(executor startup\/capacity wait\) Waiting work/);
  assert.match(rendered, /task-a running Fast work/);
  assert.match(rendered, /task-b conflicted Needs merge/);
});

test("ExecuteSubtasks start result explains that queued work may have startup delay", async () => {
  const { tools, manager } = harness();
  const execute = tools[0]!.execute as (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;
  const result = await execute("start-delay", {
    action: "start",
    tasks: [{ title: "Waiting work", instructions: "Do bounded work", acceptanceCriteria: ["Work is complete"] }],
  }, undefined, undefined, {});
  assert.match(result.content[0].text, /Queued tasks may wait for executor startup or available pool capacity/);
  assert.match(result.content[0].text, /Inspect whenever you need current status or diagnostics; avoid tight repetitive polling/);
  assert.match(result.content[0].text, new RegExp(result.details.tasks[0].taskId));
  assert.match(result.content[0].text, /Task handles \(retain these for steer\/interrupt\/inspect\)/);
  await manager.shutdown();
});

test("slash-command task inspection uses an interactive picker when IDs are omitted", async () => {
  const { tools, commandHandlers, notices, manager } = harness();
  const execute = tools[0]!.execute as (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;
  const started = await execute("picker-start", {
    action: "start",
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
  const execute = tools[0]!.execute as (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;
  const started = await execute("interrupt-picker-start", {
    action: "start",
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
  assert.deepEqual(selections, ["Interrupt execution subtask", "Interrupt outcome"]);
  assert.match(notices.at(-1) ?? "", new RegExp(started.details.tasks[0].taskId));
  assert.match(notices.at(-1) ?? "", /interrupted/);
  await manager.shutdown();
});
