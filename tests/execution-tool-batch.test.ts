import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

test("execute_subtasks is the sole registered delegated execution tool", () => {
  const registered: Array<Record<string, unknown>> = [];
  let activeTools = ["read"];
  const pi = {
    registerTool(tool: Record<string, unknown>) {
      registered.push(tool);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(next: string[]) {
      activeTools = next;
    },
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: {
      activeExecutor: null,
    },
  });
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => process.cwd(),
  });

  manager.sync();
  assert.equal(registered.length, 0);

  config.execution!.activeExecutor = { source: "external", id: "fake" };
  manager.sync();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "execute_subtasks");
  assert.ok(activeTools.includes("execute_subtasks"));

  // Verify batch tool schema.
  const batchTool = registered[0] as Record<string, unknown>;
  const params = batchTool.parameters as Record<string, unknown>;
  assert.equal(params.type, "object");
  assert.equal(params.additionalProperties, false);
  assert.deepEqual(params.required, ["action"]);
  const props = params.properties as Record<string, unknown>;
  const tasksProp = props.tasks as Record<string, unknown>;
  assert.equal(tasksProp.type, "array");
  assert.equal(tasksProp.minItems, 1);
  assert.equal(tasksProp.maxItems, 16);

  const maxWorkersProp = props.maxWorkers as Record<string, unknown>;
  assert.equal(maxWorkersProp.type, "integer");
  assert.equal(maxWorkersProp.minimum, 1);
  assert.equal(maxWorkersProp.maximum, 16);

  // Verify both tools deactivated when executor removed.
  config.execution!.activeExecutor = null;
  manager.sync();
  assert.equal(registered.length, 1);
  assert.ok(!activeTools.includes("execute_subtasks"));
});

test("execute_subtasks rejects empty tasks array", async () => {
  const registered: Array<Record<string, unknown>> = [];
  let activeTools: string[] = [];
  const pi = {
    registerTool(tool: Record<string, unknown>) { registered.push(tool); },
    getActiveTools() { return activeTools; },
    setActiveTools(next: string[]) { activeTools = next; },
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: { activeExecutor: { source: "external", id: "fake" } },
  });
  new ExecutionToolManager({ pi, config, state: createState(), cwd: () => process.cwd() }).sync();

  const batchTool = registered[0] as Record<string, unknown>;
  const execute = batchTool.execute as (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((result: unknown) => void) | undefined,
    ctx: unknown,
  ) => Promise<unknown>;

  // Empty tasks
  const result1 = await execute("1", { action: "start", tasks: [] }, undefined, undefined, {});
  assert.equal((result1 as Record<string, unknown>).isError, true);

  // Too many tasks (17)
  const tooMany = { action: "start", tasks: Array.from({ length: 17 }, (_, i) => ({
    title: `T${i}`,
    instructions: "i",
    acceptanceCriteria: ["a"],
  })) };
  const result2 = await execute("2", tooMany, undefined, undefined, {});
  assert.equal((result2 as Record<string, unknown>).isError, true);

  // Invalid maxWorkers (0)
  const result3 = await execute("3", {
    action: "start",
    tasks: [{ title: "T", instructions: "i", acceptanceCriteria: ["a"] }],
    maxWorkers: 0,
  }, undefined, undefined, {});
  assert.equal((result3 as Record<string, unknown>).isError, true);

  // Invalid maxWorkers (17)
  const result4 = await execute("4", {
    action: "start",
    tasks: [{ title: "T", instructions: "i", acceptanceCriteria: ["a"] }],
    maxWorkers: 17,
  }, undefined, undefined, {});
  assert.equal((result4 as Record<string, unknown>).isError, true);

  // Non-integer maxWorkers
  const result5 = await execute("5", {
    action: "start",
    tasks: [{ title: "T", instructions: "i", acceptanceCriteria: ["a"] }],
    maxWorkers: 2.5,
  }, undefined, undefined, {});
  assert.equal((result5 as Record<string, unknown>).isError, true);

  // Malformed task (missing instructions)
  const result6 = await execute("6", {
    action: "start",
    tasks: [{ title: "T", acceptanceCriteria: ["a"] }],
  }, undefined, undefined, {});
  assert.equal((result6 as Record<string, unknown>).isError, true);

  // Empty title
  const result7 = await execute("7", {
    action: "start",
    tasks: [{ title: "  ", instructions: "i", acceptanceCriteria: ["a"] }],
  }, undefined, undefined, {});
  assert.equal((result7 as Record<string, unknown>).isError, true);

  // Empty acceptanceCriteria
  const result8 = await execute("8", {
    action: "start",
    tasks: [{ title: "T", instructions: "i", acceptanceCriteria: [] }],
  }, undefined, undefined, {});
  assert.equal((result8 as Record<string, unknown>).isError, true);

  // Blank acceptance criterion (whitespace only)
  const result9 = await execute("9", {
    action: "start",
    tasks: [{ title: "T", instructions: "i", acceptanceCriteria: ["a", "  "] }],
  }, undefined, undefined, {});
  assert.equal((result9 as Record<string, unknown>).isError, true);
});

test("execute_subtasks blocks without parent baseline", async () => {
  const registered: Array<Record<string, unknown>> = [];
  let activeTools: string[] = [];
  const state = createState();
  const pi = {
    registerTool(tool: Record<string, unknown>) { registered.push(tool); },
    getActiveTools() { return activeTools; },
    setActiveTools(next: string[]) { activeTools = next; },
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: { activeExecutor: { source: "external", id: "fake" } },
  });
  new ExecutionToolManager({ pi, config, state, cwd: () => process.cwd() }).sync();

  const batchTool = registered[0] as Record<string, unknown>;
  const execute = batchTool.execute as (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((result: unknown) => void) | undefined,
    ctx: unknown,
  ) => Promise<unknown>;

  // No parent baseline — should block.
  const result = await execute("1", {
    action: "start",
    tasks: [{ title: "T", instructions: "i", acceptanceCriteria: ["a"] }],
  }, undefined, undefined, {});
  assert.equal((result as Record<string, unknown>).isError, true);
  const summary = (result as Record<string, unknown>).content as Array<Record<string, string>>;
  assert.ok(summary[0].text.includes("parent ownership baseline"));
});

test("batch render shows task count and per-task status", () => {
  const registered: Array<Record<string, unknown>> = [];
  let activeTools: string[] = [];
  const pi = {
    registerTool(tool: Record<string, unknown>) { registered.push(tool); },
    getActiveTools() { return activeTools; },
    setActiveTools(next: string[]) { activeTools = next; },
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: { activeExecutor: { source: "external", id: "fake" } },
  });
  new ExecutionToolManager({ pi, config, state: createState(), cwd: () => process.cwd() }).sync();

  const batchTool = registered[0] as Record<string, unknown>;
  const theme = {
    bold: (value: string) => value,
    fg: (_color: string, value: string) => value,
  };
  type TestTheme = { bold(value: string): string; fg(color: string, value: string): string };

  // Render call
  const renderCall = batchTool.renderCall as (args: unknown, value: TestTheme) => { render(width: number): string[] };
  const callText = renderCall({ action: "start", tasks: [{ title: "A" }, { title: "B" }, { title: "C" }] }, theme).render(100).join("\n");
  assert.match(callText, /execute_subtasks/);
  assert.match(callText, /3 task/);

  // Render result with task results
  const renderResult = batchTool.renderResult as (
    result: unknown,
    options: unknown,
    value: TestTheme,
  ) => { render(width: number): string[] };
  const resultText = renderResult({
    content: [{ type: "text", text: "done" }],
    details: {
      waveId: "abc123",
      waveRoot: "/tmp/wave-abc123",
      phase: "completed",
      taskResults: [
        { taskId: "task-0", title: "A", status: "accepted", summary: "ok" },
        { taskId: "task-1", title: "B", status: "executor_error", summary: "fail" },
      ],
      integration: { status: "integrated" },
      landing: { status: "landed" },
    },
  }, { expanded: true }, theme).render(120).join("\n");
  assert.match(resultText, /completed/);
  assert.match(resultText, /task-0/);
  assert.match(resultText, /accepted/);
  assert.match(resultText, /executor_error/);
  assert.match(resultText, /ignored files excluded/);
});

test("batch render shows live progress with per-task status", () => {
  const registered: Array<Record<string, unknown>> = [];
  let activeTools: string[] = [];
  const pi = {
    registerTool(tool: Record<string, unknown>) { registered.push(tool); },
    getActiveTools() { return activeTools; },
    setActiveTools(next: string[]) { activeTools = next; },
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: { activeExecutor: { source: "external", id: "fake" } },
  });
  new ExecutionToolManager({ pi, config, state: createState(), cwd: () => process.cwd() }).sync();

  const batchTool = registered[0] as Record<string, unknown>;
  const theme = {
    bold: (value: string) => value,
    fg: (_color: string, value: string) => value,
  };
  type TestTheme = { bold(value: string): string; fg(color: string, value: string): string };

  const renderResult = batchTool.renderResult as (
    result: unknown,
    options: unknown,
    value: TestTheme,
  ) => { render(width: number): string[] };

  // Live progress with per-task status
  const liveText = renderResult({
    content: [{ type: "text", text: "Working" }],
    details: {
      state: "running",
      progress: {
        startedAt: new Date().toISOString(),
        phase: "working",
        message: "Starting 3 worker(s) with max 2 concurrent",
        taskStatuses: [
          {
            subtaskId: "task-0",
            phase: "executing",
            message: "executor turn 1 running",
            executorAdapter: "little-coder-model",
            executorModel: "ollama/deepseek-v4-flash:0731-cloud",
          },
          {
            subtaskId: "task-1",
            phase: "reviewing",
            message: "review cycle 1",
            executorModel: "ollama/deepseek-v4-flash:0731-cloud",
            reviewer: "openai-codex/gpt-5.6-luna (high)",
          },
        ],
        activity: [
          "task-1: openai-codex/gpt-5.6-luna (high) started",
          "task-1: openai-codex/gpt-5.6-luna (high) · model reasoning",
        ],
      },
    },
  }, { expanded: true }, theme).render(120).join("\n");
  assert.match(liveText, /Working/);
  assert.match(liveText, /task-0: executing · model: ollama\/deepseek-v4-flash:0731-cloud/);
  assert.match(liveText, /task-1: reviewing · reviewer: openai-codex\/gpt-5\.6-luna \(high\)/);
  assert.match(liveText, /Recent activity/);
  assert.match(liveText, /task-1: openai-codex\/gpt-5\.6-luna \(high\) · model reasoning/);
  assert.doesNotMatch(liveText, /task-1: reviewing · model: ollama/);
});

test("batch result marks non-landed outcomes as errors", () => {
  const registered: Array<Record<string, unknown>> = [];
  let activeTools: string[] = [];
  const pi = {
    registerTool(tool: Record<string, unknown>) { registered.push(tool); },
    getActiveTools() { return activeTools; },
    setActiveTools(next: string[]) { activeTools = next; },
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: { activeExecutor: { source: "external", id: "fake" } },
  });
  new ExecutionToolManager({ pi, config, state: createState(), cwd: () => process.cwd() }).sync();

  const batchTool = registered[0] as Record<string, unknown>;
  const theme = {
    bold: (value: string) => value,
    fg: (_color: string, value: string) => value,
  };
  type TestTheme = { bold(value: string): string; fg(color: string, value: string): string };

  const renderResult = batchTool.renderResult as (
    result: unknown,
    options: unknown,
    value: TestTheme,
  ) => { render(width: number): string[] };

  // Integration conflict with all-successful workers and no landing — should be error.
  const conflictResult = renderResult({
    content: [{ type: "text", text: "done" }],
    details: {
      waveId: "conflict123",
      waveRoot: "/tmp/wave-conflict",
      phase: "completed",
      taskResults: [
        { taskId: "task-0", title: "A", status: "accepted", summary: "ok" },
        { taskId: "task-1", title: "B", status: "accepted", summary: "ok" },
      ],
      integration: { status: "conflicted" },
      // No landing field — integration conflict skipped landing.
    },
    isError: true,
  }, { expanded: true }, theme).render(120).join("\n");
  assert.ok(conflictResult.includes("✗"), "Should show error icon for non-landed outcome");

  // Landed outcome — should be success.
  const landedResult = renderResult({
    content: [{ type: "text", text: "done" }],
    details: {
      waveId: "landed123",
      waveRoot: "/tmp/wave-landed",
      phase: "completed",
      taskResults: [
        { taskId: "task-0", title: "A", status: "accepted", summary: "ok" },
      ],
      integration: { status: "integrated" },
      landing: { status: "landed" },
    },
  }, { expanded: true }, theme).render(120).join("\n");
  assert.ok(landedResult.includes("✓"), "Should show success icon for landed outcome");
});

test("batch render fits narrow width", () => {
  const registered: Array<Record<string, unknown>> = [];
  let activeTools: string[] = [];
  const pi = {
    registerTool(tool: Record<string, unknown>) { registered.push(tool); },
    getActiveTools() { return activeTools; },
    setActiveTools(next: string[]) { activeTools = next; },
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: { activeExecutor: { source: "external", id: "fake" } },
  });
  new ExecutionToolManager({ pi, config, state: createState(), cwd: () => process.cwd() }).sync();

  const batchTool = registered[0] as Record<string, unknown>;
  const theme = {
    bold: (value: string) => value,
    fg: (_color: string, value: string) => value,
  };
  type TestTheme = { bold(value: string): string; fg(color: string, value: string): string };

  const narrowWidth = 40;

  // Call render at narrow width
  const renderCall = batchTool.renderCall as (args: unknown, value: TestTheme) => { render(width: number): string[] };
  const callLines = renderCall({ action: "start", tasks: [{ title: "A" }] }, theme).render(narrowWidth);
  assert.ok(callLines.every((line: string) => line.length <= narrowWidth - 2), `Call render overflowed: ${callLines.join("\n")}`);

  // Result render at narrow width
  const renderResult = batchTool.renderResult as (
    result: unknown,
    options: unknown,
    value: TestTheme,
  ) => { render(width: number): string[] };
  const resultLines = renderResult({
    content: [{ type: "text", text: "done" }],
    details: {
      waveId: "very-long-wave-id-that-should-be-clipped",
      waveRoot: "/tmp/very-long-wave-root-path-that-should-be-clipped",
      phase: "completed",
      taskResults: [
        { taskId: "task-0", title: "A Very Long Task Title That Should Be Clipped", status: "accepted", summary: "ok" },
      ],
      integration: { status: "integrated" },
      landing: { status: "landed" },
    },
  }, { expanded: true }, theme).render(narrowWidth);
  assert.ok(resultLines.every((line: string) => line.length <= narrowWidth - 2), `Result render overflowed: ${resultLines.join("\n")}`);
});
