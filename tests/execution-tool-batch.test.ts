import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

function harness(options: { slowExecutor?: boolean; expandedView?: boolean } = {}) {
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
    getActiveTools() { return ["read", "bash", "ExecuteSubtasks"]; },
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
    "subtasks-view",
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
  assert.match(parameters.properties.interruptMode.description, /must always be inspected afterward/i);
  assert.match(parameters.properties.mergeAnyhow.description, /always requires manual workspace inspection/i);
  assert.ok(tools[0]!.promptGuidelines.some((guideline: string) => /Steering wins over review/.test(guideline)));
  assert.ok(tools[0]!.promptGuidelines.some((guideline: string) => /Meaningful interaction points inject a message/.test(guideline)));
  assert.ok(tools[0]!.promptGuidelines.some((guideline: string) => /Every force_merge outcome requires manual inspection/.test(guideline)));
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

test("ExecuteSubtasks start result explains that queued work may have startup delay", async () => {
  const { tools, manager } = harness();
  const execute = tools[0]!.execute as (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;
  const result = await execute("start-delay", {
    action: "start",
    tasks: [{ title: "Waiting work", instructions: "Do bounded work", acceptanceCriteria: ["Work is complete"] }],
  }, undefined, undefined, {});
  assert.match(result.content[0].text, /Queued tasks may wait for executor startup or available pool capacity/);
  assert.match(result.content[0].text, /trigger an orchestrator turn at meaningful interaction points/);
  assert.match(result.content[0].text, /CAPTURING, ACCEPTED, WAITING_TO_LAND, and LANDING progress.*without triggering turns/);
  assert.match(result.content[0].text, /DO NOT POLL for task-state changes/);
  assert.match(result.content[0].text, /repeated inspect loop, or other waiting surrogate/);
  assert.match(result.content[0].text, new RegExp(result.details.tasks[0].taskId));
  assert.match(result.content[0].text, /Task handles \(retain these for steer\/interrupt\/inspect\)/);
  assert.deepEqual(result.details.tasks[0].definition.executorAllowedTools, ["read", "bash", "ExecuteSubtasks"]);
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

function renderWidget(content: unknown, width = 240): string[] {
  assert.equal(typeof content, "function");
  const component = (content as () => { render(width: number): string[] })();
  return component.render(width);
}
