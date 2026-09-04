import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { activate } from "../src/index";
import { reapAll } from "../src/background-shell";
import { queueModelDelivery } from "../src/durable-delivery";
import { SessionStateStore } from "../src/session-state";

const executionToolNames = [
  "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue",
  "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean",
];
const backgroundShellToolNames = ["ShellStart", "ShellList", "ShellLog", "ShellSend", "ShellStop"];
const webToolNames = ["WebSearch", "WebFetch", "BrowserExtract"];

let previousConfig: string | undefined;
let previousDisabled: string | undefined;

beforeEach(() => {
  previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.PI_REVIEW_GATE_CONFIG;
  else process.env.PI_REVIEW_GATE_CONFIG = previousConfig;
  if (previousDisabled === undefined) delete process.env.PI_REVIEW_GATE_DISABLED;
  else process.env.PI_REVIEW_GATE_DISABLED = previousDisabled;
});

const indexTestConfig = {
  enabled: true,
  maxCorrectionCycles: 3,
  implementationGuidanceAfterCorrectionAttempts: 1,
  maxPatchBytes: 200_000,
  maxFileBytes: 1_048_576,
  maxSnapshotBytes: 52_428_800,
  retainBundles: "never",
} as const;

test("automatic review waits for ShellStart process groups and resumes the orchestrator when they clear", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-background-readiness-"));
  let background: ChildProcess | undefined;
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationMarker = join(dir, "reviewer-invoked.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(invocationMarker)},'invoked');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'background work reviewed',findings:[]})))`,
        ],
        timeoutMs: 15_000,
      },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand() {},
      notify(message: string) { notices.push(message); },
      sendUserMessage(message: string, options: unknown) { followUps.push({ message, options }); },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "make a background-assisted change", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    background = spawn(process.execPath, ["-e", "setTimeout(()=>{},350)"], {
      detached: true,
      stdio: "ignore",
    });
    background.unref();
    assert.ok(background.pid);
    await trigger(hooks, "tool_result", {
      cwd: dir,
      toolName: "ShellStart",
      result: { content: [{ type: "text", text: `Started "tests" as job1 (pid ${background.pid}); currently running.\nFuture wake triggers (not current events): exit.\nYou will be notified automatically; do not poll.` }] },
      isError: false,
    });
    await triggerAgentEnd(hooks, { cwd: dir, messages: [{ role: "assistant", content: "background still running" }] });

    await assert.rejects(access(invocationMarker), /ENOENT/);
    assert.match(notices.join("\n"), /automatic review deferred while 1 background process group/);
    await waitForCondition(() => followUps.length === 1);
    assert.match(followUps[0]?.message ?? "", /previously blocked review reached an idle transition/);
    assert.match(followUps[0]?.message ?? "", /Re-check ShellList because a newer job may have started/);
    assert.deepEqual(followUps[0]?.options, { deliverAs: "followUp", triggerTurn: true });

    await trigger(hooks, "before_agent_start", { cwd: dir });
    await triggerAgentEnd(hooks, { cwd: dir, messages: [{ role: "assistant", content: "verified background output" }] });
    assert.equal(await readFile(invocationMarker, "utf8"), "invoked");
  } finally {
    if (background?.pid) {
      try { process.kill(-background.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("native ShellStart exit wake replaces the redundant aggregate-ready wake", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-native-background-readiness-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationMarker = join(dir, "reviewer-invoked.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(invocationMarker)},'invoked');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'background work reviewed',findings:[]})))`,
        ],
        timeoutMs: 15_000,
      },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const tools = new Map<string, { execute: (...args: any[]) => Promise<Record<string, unknown>> }>();
    const notices: string[] = [];
    const messages: Array<{ customType?: unknown; content?: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerTool(tool: { name: string; execute: (...args: any[]) => Promise<Record<string, unknown>> }) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      notify(message: string) { notices.push(message); },
      sendMessage(message: { customType?: unknown; content?: unknown }) { messages.push(message); },
      sendUserMessage() {},
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "make a background-assisted change", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    const shellStart = tools.get("ShellStart");
    assert.ok(shellStart);
    await shellStart.execute("id", { command: "sleep 0.25", label: "native-tests" }, undefined, undefined, { hasUI: false });
    await triggerAgentEnd(hooks, { cwd: dir, messages: [{ role: "assistant", content: "background still running" }] });

    assert.match(notices.join("\n"), /automatic review deferred while 1 background process group/);
    await waitForCondition(() => messages.some((message) => message.customType === "pi-review-bg-shell"));
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
    assert.equal(messages.filter((message) => message.customType === "pi-review-background-ready").length, 0);

    await trigger(hooks, "before_agent_start", { cwd: dir });
    await triggerAgentEnd(hooks, { cwd: dir, messages: [{ role: "assistant", content: "verified background output" }] });
    assert.equal(await readFile(invocationMarker, "utf8"), "invoked");
  } finally {
    reapAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a clean native exit wake is queued before settlement review begins", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-clean-exit-order-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const reviewerStarted = join(dir, "reviewer-started.txt");
    const reviewerRelease = join(dir, "reviewer-release.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(reviewerStarted)},'started');`,
            "const timer=setInterval(()=>{",
            `if(!fs.existsSync(${JSON.stringify(reviewerRelease)}))return;`,
            "clearInterval(timer);",
            "process.stdout.write(JSON.stringify({verdict:'pass',summary:'ordered review',findings:[]}));",
            "},10);",
          ].join(""),
        ],
        timeoutMs: 15_000,
      },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const tools = new Map<string, { execute: (...args: any[]) => Promise<Record<string, unknown>> }>();
    const messages: Array<{ customType?: unknown; content?: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerTool(tool: { name: string; execute: (...args: any[]) => Promise<Record<string, unknown>> }) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      notify() {},
      sendMessage(message: { customType?: unknown; content?: unknown }) { messages.push(message); },
      sendUserMessage() {},
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "finish after the build", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "agent_start");
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    const shellStart = tools.get("ShellStart");
    assert.ok(shellStart);
    await shellStart.execute("id", { command: "exit 0", label: "clean-exit-order" }, undefined, undefined, { hasUI: false });

    await waitForCondition(() => messages.some((message) => message.customType === "pi-review-bg-shell"));
    assert.equal(messages.filter((message) => message.customType === "pi-review-bg-shell").length, 1);
    await assert.rejects(access(reviewerStarted), /ENOENT/);

    await trigger(hooks, "agent_end", { cwd: dir, messages: [{ role: "assistant", content: "build completed" }] });
    const settlement = trigger(hooks, "agent_settled", { cwd: dir });
    await waitForFile(reviewerStarted);
    // The clean-exit follow-up was already queued during the active run; the
    // shell settlement hook cannot start a competing turn beside this review.
    assert.equal(messages.filter((message) => message.customType === "pi-review-bg-shell").length, 1);

    await writeFile(reviewerRelease, "release\n", "utf8");
    await settlement;
  } finally {
    reapAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a replacement ShellStart job keeps review blocked after an earlier idle-transition wake", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-background-restart-race-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationMarker = join(dir, "reviewer-invoked.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(invocationMarker)},'invoked')`],
        timeoutMs: 15_000,
      },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const tools = new Map<string, { execute: (...args: any[]) => Promise<Record<string, unknown>> }>();
    const notices: string[] = [];
    const messages: Array<{ customType?: unknown; content?: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerTool(tool: { name: string; execute: (...args: any[]) => Promise<Record<string, unknown>> }) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      notify(message: string) { notices.push(message); },
      sendMessage(message: { customType?: unknown; content?: unknown }) { messages.push(message); },
      sendUserMessage() {},
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "restart a background validation until it is useful", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    const shellStart = tools.get("ShellStart");
    assert.ok(shellStart);
    await shellStart.execute("id", {
      command: "sleep 0.2",
      label: "first-run",
      wake_on: { exit: false },
    }, undefined, undefined, { hasUI: false });
    await triggerAgentEnd(hooks, { cwd: dir, messages: [{ role: "assistant", content: "first run active" }] });

    await waitForCondition(() => messages.filter((message) => message.customType === "pi-review-background-ready").length === 1);
    const firstWake = String(messages.find((message) => message.customType === "pi-review-background-ready")?.content ?? "");
    assert.match(firstWake, /idle transition/);
    assert.match(firstWake, /newer job may have started/);

    // The completion wake begins a new turn, which immediately replaces the
    // finished job. The old wake must not authorize review of this newer state.
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await shellStart.execute("id", {
      command: "sleep 0.35",
      label: "replacement-run",
      wake_on: { exit: false },
    }, undefined, undefined, { hasUI: false });
    await triggerAgentEnd(hooks, { cwd: dir, messages: [{ role: "assistant", content: "replacement run active" }] });
    await assert.rejects(access(invocationMarker), /ENOENT/);
    assert.match(notices.at(-1) ?? "", /replacement-run/);

    await waitForCondition(() => messages.filter((message) => message.customType === "pi-review-background-ready").length === 2);
    await assert.rejects(access(invocationMarker), /ENOENT/);
  } finally {
    reapAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("automatic review waits while execution subtasks remain active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-execution-readiness-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationMarker = join(dir, "reviewer-invoked.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "reviewer",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(invocationMarker)},'invoked');process.stdout.write(JSON.stringify({verdict:'pass',summary:'reviewed',findings:[]}))`,
        ],
        timeoutMs: 15_000,
      },
      externalAgents: [{
        id: "slow-executor",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{},30000))"],
        },
      }],
      execution: {
        activeExecutor: { source: "external", id: "slow-executor" },
      },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    let executionTool: {
      execute: (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<unknown>;
    } | undefined;
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand() {},
      registerTool(tool: typeof executionTool & { name?: string }) {
        if (tool?.name === "SubtasksStart") executionTool = tool;
      },
      getActiveTools() { return ["read", "bash", ...executionToolNames]; },
      setToolActive() {},
      notify(message: string) { notices.push(message); },
    };

    await activate(pi);
    await trigger(hooks, "session_start", { cwd: dir });
    assert.ok(executionTool);
    await trigger(hooks, "input", { cwd: dir, text: "make a delegated change", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await executionTool.execute("start-slow-task", {
      tasks: [{
        title: "slow delegated work",
        instructions: "Remain active while the readiness gate is tested.",
        acceptanceCriteria: ["The delegated task finishes."],
      }],
    }, undefined, undefined, { cwd: dir });

    await triggerAgentEnd(hooks, { cwd: dir, messages: [{ role: "assistant", content: "subtask still active" }] });

    await assert.rejects(access(invocationMarker), /ENOENT/);
    assert.match(notices.join("\n"), /automatic review deferred while 1 background subtask\(s\) remain active/);
    assert.match(notices.join("\n"), /slow delegated work \[(queued|capturing|running)\]/);
    await trigger(hooks, "session_shutdown", { cwd: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session_start captures execution tools before applying the conservative deferred set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-runtime-start-"));
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "fake",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: {
        activeExecutor: { source: "external", id: "fake" },
      },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    let reviewSettingsHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const registeredTools: Array<{ name: string; description?: string }> = [];
    let activeTools = ["read", "bash", "edit"];
    let runtimeInitialized = false;
    const assertRuntime = () => {
      if (!runtimeInitialized) throw new Error("Extension runtime not initialized");
    };
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        if (name === "review-settings") reviewSettingsHandler = options.handler;
      },
      registerTool(tool: { name: string; description?: string }) {
        registeredTools.push(tool);
        activeTools.push(tool.name);
      },
      getActiveTools() {
        assertRuntime();
        return activeTools;
      },
      getAllTools() {
        assertRuntime();
        return [
          { name: "read", description: "Read files." },
          { name: "bash", description: "Run shell commands." },
          { name: "edit", description: "Edit files." },
          ...registeredTools,
        ];
      },
      setActiveTools(next: string[]) {
        assertRuntime();
        activeTools = next;
      },
      notify() {},
    };

    await activate(pi);
    assert.deepEqual(registeredTools.map((tool) => tool.name), [
      ...webToolNames, "ApplyPatch", ...backgroundShellToolNames, "search_tools",
    ]);

    runtimeInitialized = true;
    const sessionContext = { cwd: dir, ui: {}, sessionManager: {} };
    await trigger(hooks, "session_start", { cwd: dir }, sessionContext);
    assert.deepEqual(registeredTools.map((tool) => tool.name), [
      ...webToolNames, "ApplyPatch", ...backgroundShellToolNames, "search_tools", ...executionToolNames,
    ]);
    const deferredActive = ["read", "bash", "edit", "ApplyPatch", "SubtasksStart", "search_tools"];
    assert.deepEqual(activeTools, deferredActive);

    const toggleDeferredTools = async () => {
      assert.ok(reviewSettingsHandler);
      let selectedToggle = false;
      await reviewSettingsHandler("", {
        ui: {
          select: async (title: string, options: string[]) => {
            if (title !== "Review settings") return undefined;
            if (!selectedToggle) {
              selectedToggle = true;
              return options.find((option) => option.startsWith("Deferred Pi tools"));
            }
            return "Save changes";
          },
          notify() {},
        },
      });
    };
    await toggleDeferredTools();
    const fullAuthorized = [
      "read", "bash", "edit", ...webToolNames, "ApplyPatch", ...backgroundShellToolNames,
      ...executionToolNames,
    ];
    assert.deepEqual(activeTools, [...fullAuthorized, "search_tools"], "saving Off immediately activates the complete local catalog");
    await toggleDeferredTools();
    assert.deepEqual(activeTools, deferredActive, "saving On immediately restores the conservative local catalog");

    pi.registerTool({ name: "LateIdleTool", description: "Registered while the model is idle." });
    assert.ok(activeTools.includes("LateIdleTool"));
    const beforeStart = await triggerResults(hooks, "before_agent_start", { cwd: dir, systemPrompt: "native orchestrator prompt" });
    assert.ok(beforeStart.some((value) => typeof (value as { systemPrompt?: unknown }).systemPrompt === "string"));
    const inventory = JSON.stringify(beforeStart);
    assert.match(inventory, /native orchestrator prompt/);
    for (const name of [
      "read", "bash", "edit", ...webToolNames, "ApplyPatch", ...backgroundShellToolNames,
      "search_tools", ...executionToolNames,
    ]) {
      assert.match(inventory, new RegExp(escapeRegExp(`\\"${name}\\"`)));
    }
    assert.match(inventory, /exact name/);
    assert.match(inventory, /next turn/);
    assert.doesNotMatch(inventory, /LateIdleTool|Read files|Run shell commands|Edit files|parameters|properties/);
    assert.equal(activeTools.includes("LateIdleTool"), false, "request boundary removes an unauthorized idle registration");

    pi.registerTool({ name: "LateToolResultTool", description: "Registered during a tool execution." });
    assert.ok(activeTools.includes("LateToolResultTool"));
    await trigger(hooks, "tool_result", { cwd: dir, toolName: "read", input: {}, isError: false });
    assert.equal(activeTools.includes("LateToolResultTool"), false, "tool-result boundary removes widening before the next request");

    const searchTools = registeredTools.find((tool) => tool.name === "search_tools") as {
      execute?: (id: string, params: unknown) => Promise<Record<string, unknown>>;
    } | undefined;
    assert.ok(searchTools?.execute);
    const result = await searchTools.execute("load-add", { query: "add tasks to existing execution" });
    assert.equal(result.isError, false);
    assert.deepEqual((result.details as { activated: string[] }).activated, ["SubtasksAdd"]);
    assert.deepEqual(activeTools, ["read", "bash", "edit", "ApplyPatch", "SubtasksStart", "search_tools", "SubtasksAdd"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deferred authorization survives API recreation and remains isolated per Pi session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-deferred-sessions-"));
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    type ToolDefinition = {
      name: string;
      description?: string;
      execute?: (id: string, params: unknown) => Promise<Record<string, unknown>>;
    };
    const createBacking = (sessionTool: string) => ({
      definitions: new Map<string, ToolDefinition>([
        ["read", { name: "read", description: "Read files." }],
        ["bash", { name: "bash", description: "Run shell commands." }],
        ["edit", { name: "edit", description: "Edit files." }],
        [sessionTool, { name: sessionTool, description: `Authorized only for ${sessionTool}.` }],
      ]),
      active: ["read", "bash", "edit", sessionTool],
    });
    const createWrapper = (backing: ReturnType<typeof createBacking>) => {
      const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
      const pi = {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          hooks.set(name, [...(hooks.get(name) ?? []), handler]);
        },
        registerCommand() {},
        registerTool(definition: ToolDefinition) {
          backing.definitions.set(definition.name, definition);
          if (!backing.active.includes(definition.name)) backing.active.push(definition.name);
        },
        getActiveTools: () => [...backing.active],
        getAllTools: () => [...backing.definitions.values()],
        setActiveTools(names: string[]) { backing.active = [...names]; },
        notify() {},
      };
      return { hooks, pi };
    };
    const executeSearch = async (backing: ReturnType<typeof createBacking>, query: string) => {
      const search = backing.definitions.get("search_tools");
      assert.ok(search?.execute);
      return search.execute("search", { query });
    };

    const sessionAIdentity = {};
    const backingA = createBacking("SessionAOnly");
    const firstA = createWrapper(backingA);
    await activate(firstA.pi);
    const contextA = { cwd: dir, ui: {}, sessionManager: sessionAIdentity };
    await trigger(firstA.hooks, "session_start", { cwd: dir }, contextA);

    firstA.pi.registerTool({ name: "SessionALate", description: "Registered after authorization capture." });
    const reloadedA = createWrapper(backingA);
    assert.notEqual(reloadedA.pi, firstA.pi, "reload recreates the ExtensionAPI wrapper");
    await activate(reloadedA.pi);
    const reloadedContextA = { cwd: dir, ui: {}, sessionManager: sessionAIdentity };
    assert.notEqual(reloadedContextA, contextA, "reload recreates the ExtensionContext wrapper");
    await trigger(reloadedA.hooks, "session_start", { cwd: dir }, reloadedContextA);
    assert.equal(backingA.active.includes("SessionALate"), false);
    const originalA = await executeSearch(backingA, "SessionAOnly");
    assert.deepEqual((originalA.details as { activated: string[] }).activated, ["SessionAOnly"]);
    const lateA = await executeSearch(backingA, "SessionALate");
    assert.deepEqual((lateA.details as { activated: string[] }).activated, []);

    const sessionBIdentity = {};
    const backingB = createBacking("SessionBOnly");
    const sessionB = createWrapper(backingB);
    await activate(sessionB.pi);
    const contextB = { cwd: dir, ui: {}, sessionManager: sessionBIdentity };
    await trigger(sessionB.hooks, "session_start", { cwd: dir }, contextB);
    const ownB = await executeSearch(backingB, "SessionBOnly");
    assert.deepEqual((ownB.details as { activated: string[] }).activated, ["SessionBOnly"]);
    const foreignA = await executeSearch(backingB, "SessionAOnly");
    assert.deepEqual((foreignA.details as { activated: string[] }).activated, []);
    assert.equal(backingB.active.includes("SessionAOnly"), false);
  } finally {
    reapAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("review state restores only when the same persisted conversation resumes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-conversation-restore-"));
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const runtime = (sessionId: string, file: string) => {
      const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
      const notices: string[] = [];
      const entries: Array<{ type: string; data: unknown }> = [];
      const sent: Array<{ message: string; options: unknown }> = [];
      const pi = {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          hooks.set(name, [...(hooks.get(name) ?? []), handler]);
        },
        registerCommand() {},
        appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
        notify(message: string) { notices.push(message); },
        sendUserMessage(message: string, options: unknown) { sent.push({ message, options }); },
      };
      const ctx = {
        cwd: dir,
        ui: { notify: (message: string) => notices.push(message) },
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => file,
          getCwd: () => dir,
        },
      };
      return { hooks, notices, entries, sent, pi, ctx };
    };

    const first = runtime("conversation-a", sessionFile);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dir, text: "preserve this request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
    const statePath = `${sessionFile}.pi-review-gate-state.json`;
    const beforeTools = await readFile(statePath, "utf8");
    await Promise.all([
      trigger(first.hooks, "tool_call", { cwd: dir, toolName: "read", input: { path: "one.ts" } }, first.ctx),
      trigger(first.hooks, "tool_call", { cwd: dir, toolName: "grep", input: { path: dir, pattern: "evidence" } }, first.ctx),
      trigger(first.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "printf evidence" } }, first.ctx),
    ]);
    await Promise.all([
      trigger(first.hooks, "tool_result", { cwd: dir, toolName: "read", input: { path: "one.ts" }, content: [{ type: "text", text: "contents" }], isError: false }, first.ctx),
      trigger(first.hooks, "tool_result", { cwd: dir, toolName: "grep", input: { path: dir, pattern: "evidence" }, content: [{ type: "text", text: "grep failed" }], isError: true }, first.ctx),
      trigger(first.hooks, "tool_result", { cwd: dir, toolName: "bash", input: { command: "printf evidence" }, content: [{ type: "text", text: "evidence" }], isError: false }, first.ctx),
    ]);
    assert.equal(await readFile(statePath, "utf8"), beforeTools, "tool hooks keep evidence in memory");
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);
    const targetStore = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const targetState = await targetStore.restore(dir);
    assert.ok(targetState);
    assert.deepEqual(targetState.state.reviewWindow?.evidence.events.map((event) => event.toolName), ["bash", "grep", "bash"]);
    assert.match(targetState.state.reviewWindow?.evidence.events[0]?.summary ?? "", /printf evidence/);
    assert.equal(targetState.state.reviewWindow?.evidence.events[1]?.isError, true);
    queueModelDelivery(targetState.state, {
      kind: "review_authorization",
      channel: "follow_up",
      message: "durable pending message for resumed conversation",
    });
    await targetStore.save(targetState.state, targetState.execution);

    // Model the ordinary interactive flow exactly: a later application starts
    // in a temporary/default session, then /resume replaces that runtime with
    // a freshly loaded extension instance for the selected conversation.
    const bootstrapFile = join(dir, "startup-session.jsonl");
    await writeFile(bootstrapFile, "", "utf8");
    const bootstrap = runtime("startup-session", bootstrapFile);
    await activate(bootstrap.pi);
    await trigger(bootstrap.hooks, "session_start", { type: "session_start", reason: "startup" }, bootstrap.ctx);
    await trigger(bootstrap.hooks, "input", { cwd: dir, text: "must not leak into resumed conversation", source: "user" }, bootstrap.ctx);
    await trigger(bootstrap.hooks, "session_shutdown", {
      type: "session_shutdown",
      reason: "resume",
      targetSessionFile: sessionFile,
    }, bootstrap.ctx);

    const resumed = runtime("conversation-a", sessionFile);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);
    assert.match(resumed.notices.join("\n"), /restored conversation state revision/);
    assert.deepEqual(resumed.sent, [{
      message: "durable pending message for resumed conversation",
      options: { deliverAs: "followUp" },
    }]);
    const resumedState = await readFile(`${sessionFile}.pi-review-gate-state.json`, "utf8");
    assert.match(resumedState, /preserve this request/);
    assert.doesNotMatch(resumedState, /must not leak into resumed conversation/);

    const newSessionFile = join(dir, "conversation-b.jsonl");
    await writeFile(newSessionFile, "", "utf8");
    const fresh = runtime("conversation-b", newSessionFile);
    await activate(fresh.pi);
    await trigger(fresh.hooks, "session_start", { type: "session_start", reason: "new" }, fresh.ctx);
    assert.doesNotMatch(fresh.notices.join("\n"), /restored conversation state revision/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same-conversation/different-cwd session start quarantines the prior sidecar and starts fresh", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "pi-review-gate-cwd-mismatch-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "pi-review-gate-cwd-mismatch-b-"));
  const dirC = await mkdtemp(join(tmpdir(), "pi-review-gate-cwd-mismatch-c-"));
  try {
    const configPath = join(dirA, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dirA, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    // First session in dirA persists state with a pending delivery.
    const first = createSessionRuntime("conversation-a", sessionFile, dirA);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dirA, text: "preserve this request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dirA }, first.ctx);
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    const statePath = `${sessionFile}.pi-review-gate-state.json`;
    const targetStore = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dirA });
    const targetState = await targetStore.restore(dirA);
    assert.ok(targetState);
    queueModelDelivery(targetState.state, {
      kind: "review_authorization",
      channel: "follow_up",
      message: "durable pending message for the prior cwd",
    });
    await targetStore.save(targetState.state, targetState.execution);
    const priorBytes = await readFile(statePath, "utf8");

    // Second session: same conversation, different cwd (dirB).
    const resumed = createSessionRuntime("conversation-a", sessionFile, dirB);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    assert.deepEqual(resumed.sent, [], "no old follow-up may be delivered into a different cwd");
    const noticeText = resumed.notices.join("\n");
    assert.match(noticeText, /different working directory/);
    assert.match(noticeText, /quarantined to/);
    assert.match(noticeText, /1 pending delivery record\(s\) preserved/);
    assert.match(noticeText, /review_authorization 1/);
    assert.doesNotMatch(noticeText, /durable pending message for the prior cwd/);
    assert.doesNotMatch(noticeText, /restored conversation state revision/);

    const quarantineFiles = (await readdir(dirA)).filter((name) => name.includes(".quarantine-"));
    assert.equal(quarantineFiles.length, 1);
    assert.equal(
      await readFile(join(dirA, quarantineFiles[0]!), "utf8"),
      priorBytes,
      "quarantine preserves the exact prior sidecar bytes",
    );

    const freshText = await readFile(statePath, "utf8");
    assert.doesNotMatch(freshText, /durable pending message for the prior cwd/);
    assert.doesNotMatch(freshText, /preserve this request/);
    assert.match(freshText, new RegExp(`"cwd":"${escapeRegExp(dirB)}"`));
    const freshState = await targetStore.restore(dirB);
    assert.ok(freshState);
    assert.equal(freshState.state.pendingModelDeliveries.length, 0, "fresh state is isolated from prior pending records");

    // Third session: repeated mismatch (dirC) must not clobber the first quarantine.
    const secondBytes = freshText;
    const again = createSessionRuntime("conversation-a", sessionFile, dirC);
    await activate(again.pi);
    await trigger(again.hooks, "session_start", { type: "session_start", reason: "resume" }, again.ctx);
    assert.deepEqual(again.sent, []);
    const quarantineFiles2 = (await readdir(dirA)).filter((name) => name.includes(".quarantine-"));
    assert.equal(quarantineFiles2.length, 2, "repeated mismatch creates a new quarantine without clobbering prior ones");
    const contents = new Set(await Promise.all(quarantineFiles2.map((name) => readFile(join(dirA, name), "utf8"))));
    assert.ok(contents.has(priorBytes), "first quarantine keeps the exact prior bytes");
    assert.ok(contents.has(secondBytes), "second quarantine holds the intermediate fresh state");
    const finalText = await readFile(statePath, "utf8");
    assert.match(finalText, new RegExp(`"cwd":"${escapeRegExp(dirC)}"`));
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
    await rm(dirC, { recursive: true, force: true });
  }
});

test("quarantine failure leaves the prior sidecar untouched and disables persistence", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
    return;
  }
  const dirA = await mkdtemp(join(tmpdir(), "pi-review-gate-quarantine-fail-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "pi-review-gate-quarantine-fail-b-"));
  try {
    const configPath = join(dirA, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dirA, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = createSessionRuntime("conversation-a", sessionFile, dirA);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dirA, text: "preserve this request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dirA }, first.ctx);
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    const statePath = `${sessionFile}.pi-review-gate-state.json`;
    const priorBytes = await readFile(statePath, "utf8");

    // Make the sidecar's directory read-only so quarantine (link) fails.
    await chmod(dirA, 0o555);

    const resumed = createSessionRuntime("conversation-a", sessionFile, dirB);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    assert.deepEqual(resumed.sent, [], "no old follow-up may be delivered");
    const noticeText = resumed.notices.join("\n");
    assert.match(noticeText, /could not be quarantined/);
    assert.match(noticeText, /left untouched/);
    assert.match(noticeText, /persistence is disabled/);
    assert.equal(await readFile(statePath, "utf8"), priorBytes, "original sidecar must be untouched");
    const quarantineFiles = (await readdir(dirA)).filter((name) => name.includes(".quarantine-"));
    assert.deepEqual(quarantineFiles, [], "no quarantine file may be created");

    // No later save: a subsequent input must not overwrite the prior sidecar.
    await trigger(resumed.hooks, "input", { cwd: dirB, text: "must not be persisted", source: "user" }, resumed.ctx);
    assert.equal(await readFile(statePath, "utf8"), priorBytes, "no later save may overwrite the prior sidecar");
  } finally {
    await chmod(dirA, 0o755).catch(() => undefined);
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("a corrupted prior sidecar is preserved in place and persistence is disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-corrupt-sidecar-"));
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dir, text: "preserve this request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    const statePath = `${sessionFile}.pi-review-gate-state.json`;
    const priorBytes = await readFile(statePath, "utf8");

    // Corrupt the sidecar so restore fails its integrity check.
    const corrupted = JSON.parse(priorBytes) as { state: { reviewsPaused: boolean } };
    corrupted.state.reviewsPaused = !corrupted.state.reviewsPaused;
    const corruptedBytes = `${JSON.stringify(corrupted)}\n`;
    await writeFile(statePath, corruptedBytes, "utf8");

    const resumed = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    assert.deepEqual(resumed.sent, [], "no follow-up may be delivered from a failed restore");
    const noticeText = resumed.notices.join("\n");
    assert.match(noticeText, /was not restored/);
    assert.match(noticeText, /left untouched/);
    assert.match(noticeText, /persistence is disabled/);
    assert.equal(await readFile(statePath, "utf8"), corruptedBytes, "corrupted sidecar must be preserved in place");

    // No later save may overwrite the corrupted sidecar.
    await trigger(resumed.hooks, "input", { cwd: dir, text: "must not be persisted", source: "user" }, resumed.ctx);
    assert.equal(await readFile(statePath, "utf8"), corruptedBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a throwing notifier cannot disable persistence after a successful quarantine", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "pi-review-gate-notice-fail-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "pi-review-gate-notice-fail-b-"));
  try {
    const configPath = join(dirA, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dirA, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = createSessionRuntime("conversation-a", sessionFile, dirA);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dirA, text: "preserve this request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dirA }, first.ctx);
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    const statePath = `${sessionFile}.pi-review-gate-state.json`;
    const priorBytes = await readFile(statePath, "utf8");

    // Second session in dirB: the notifier throws exactly once (on the
    // quarantine success notice), then recovers.
    const resumed = createSessionRuntime("conversation-a", sessionFile, dirB);
    let notifyCalls = 0;
    resumed.ctx.ui.notify = (message: string) => {
      notifyCalls += 1;
      if (notifyCalls === 1) throw new Error("notifier exploded");
      return resumed.notices.push(message);
    };
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    assert.ok(notifyCalls >= 1, "the quarantine notice was attempted");
    assert.deepEqual(resumed.sent, [], "no old follow-up may be delivered");
    const quarantineFiles = (await readdir(dirA)).filter((name) => name.includes(".quarantine-"));
    assert.equal(quarantineFiles.length, 1, "quarantine succeeds despite the throwing notifier");
    assert.equal(
      await readFile(join(dirA, quarantineFiles[0]!), "utf8"),
      priorBytes,
      "quarantine preserves the exact prior sidecar bytes",
    );

    // Notification failure must not disable the store after quarantine
    // succeeded: the fresh save for the new cwd still proceeds.
    const freshText = await readFile(statePath, "utf8");
    assert.match(freshText, new RegExp(`"cwd":"${escapeRegExp(dirB)}"`));
    await trigger(resumed.hooks, "input", { cwd: dirB, text: "later input persists", source: "user" }, resumed.ctx);
    const laterText = await readFile(statePath, "utf8");
    assert.notEqual(laterText, freshText, "persistence stays enabled after the notice failure");
    assert.match(laterText, /later input persists/);
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("malformed sidecar JSON never leaks content or unbounded paths into restore notices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-bad-json-"));
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    // A deeply nested session directory pushes the sidecar path past the
    // notice-path bound so truncation can be asserted.
    let deep = dir;
    for (let i = 0; i < 3; i += 1) {
      deep = join(deep, `segment-${i}-${"x".repeat(50)}`);
    }
    await mkdir(deep, { recursive: true });
    const sessionFile = join(deep, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = createSessionRuntime("conversation-a", sessionFile, deep);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: deep, text: "preserve this request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: deep }, first.ctx);
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    const statePath = `${sessionFile}.pi-review-gate-state.json`;
    assert.ok(statePath.length > 160, "test setup: sidecar path exceeds the notice path bound");

    // Corrupt the sidecar into invalid JSON that carries a secret sentinel:
    // a raw JSON.parse error would quote this text into the notice.
    const sentinel = "SECRET-SENTINEL-pending-message-text";
    const corruptedBytes = `{ "state": { "pendingModelDeliveries": [{ "message": "${sentinel}`;
    await writeFile(statePath, corruptedBytes, "utf8");

    const resumed = createSessionRuntime("conversation-a", sessionFile, deep);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    const noticeText = resumed.notices.join("\n");
    assert.match(noticeText, /was not restored/);
    assert.match(noticeText, /invalid JSON/);
    assert.doesNotMatch(noticeText, new RegExp(sentinel), "sidecar content may never reach the notice");
    assert.ok(statePath.length > 160 && !noticeText.includes(statePath), "unbounded paths may never reach the notice");
    assert.match(noticeText, /… \(truncated\)/);
    assert.match(noticeText, /persistence is disabled/);

    // The malformed sidecar is preserved in place; no later save overwrites it.
    assert.equal(await readFile(statePath, "utf8"), corruptedBytes, "malformed sidecar must be preserved in place");
    await trigger(resumed.hooks, "input", { cwd: deep, text: "must not be persisted", source: "user" }, resumed.ctx);
    assert.equal(await readFile(statePath, "utf8"), corruptedBytes, "no later save may overwrite the malformed sidecar");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cap status is concise while reviewer results are delivered once in the transmission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-cap-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      maxCorrectionCycles: 0,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]})))",
        ],
        timeoutMs: 15000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: string[] = [];
    const statuses: Array<[string, string | undefined]> = [];
    const pi = {
      ui: {
        setStatus(key: string, text: string | undefined) {
          statuses.push([key, text]);
        },
      },
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });

    const noticeText = notices.join("\n\n");
    assert.match(noticeText, /automatic correction cap reached/);
    assert.ok(statuses.some(([, text]) => text?.includes("reviewing changes")));
    assert.deepEqual(statuses.at(-1), ["review-gate", undefined]);
    assert.match(noticeText, /Complete reviewer feedback was transmitted to the implementing model/);
    assert.match(noticeText, /Use \/review-continue to authorize/);
    assert.doesNotMatch(noticeText, /missing guard/);
    assert.equal(followUps.length, 1);
    assert.match(followUps[0] ?? "", /missing guard/);
    assert.match(followUps[0] ?? "", /add the guard/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review pause collects separate exchanges and defers reviewer execution until unpaused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-paused-"));
  const invocationMarker = join(dir, "reviewer-invoked.txt");

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      maxCorrectionCycles: 1,
      retainBundles: "always",
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(invocationMarker)},'invoked');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'reviewed accumulated paused work',findings:[]})))`,
        ],
        timeoutMs: 15000,
      },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const followUps: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };

    await activate(pi);
    await commands.get("review-pause")?.("", pi);

    await trigger(hooks, "input", { cwd: dir, text: "first paused change", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "paused one\n", "utf8");
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo paused-tool-one" } });
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "completed first paused change" }],
    });

    await trigger(hooks, "input", { cwd: dir, text: "second paused change", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "paused two\n", "utf8");
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo paused-tool-two" } });
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "completed second paused change" }],
    });

    await assert.rejects(access(invocationMarker), /ENOENT/);
    assert.equal(followUps.length, 0);

    await commands.get("review-unpause")?.("", pi);
    await trigger(hooks, "input", { cwd: dir, text: "review the accumulated work", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "ready for accumulated review" }],
    });

    assert.equal(await readFile(invocationMarker, "utf8"), "invoked");
    assert.equal(followUps.length, 1);
    assert.match(followUps[0] ?? "", /reviewed accumulated paused work/);
    const bundleDir = extractBundleDir(followUps[0] ?? "", 1);
    assert.match(await readFile(join(bundleDir, "exchanges", "0001", "tool-events.md"), "utf8"), /paused-tool-one/);
    assert.match(await readFile(join(bundleDir, "exchanges", "0002", "tool-events.md"), "utf8"), /paused-tool-two/);
    assert.match(await readFile(join(bundleDir, "exchanges", "0001", "assistant-summary.md"), "utf8"), /first paused change/);
    assert.match(await readFile(join(bundleDir, "exchanges", "0002", "assistant-summary.md"), "utf8"), /second paused change/);
    assert.match(notices.join("\n"), /reviews unpaused/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("user steering during review is held until reviewer feedback is queued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-steer-during-review-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdin.resume();",
            "process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify(",
            "{verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]}",
            ")),50));",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify() {},
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    // Automatic finalization starts at agent_settled, so steer the input in
    // between the two hooks to land it inside the active review window.
    await trigger(hooks, "agent_end", { cwd: dir });
    const reviewPromise = trigger(hooks, "agent_settled", { cwd: dir });
    const inputResults = await triggerResults(hooks, "input", { cwd: dir, text: "also keep the API name stable", source: "user" });
    await reviewPromise;

    assert.deepEqual(inputResults, [{ action: "handled" }]);
    assert.equal(followUps.length, 2);
    assert.match(followUps[0]?.message ?? "", /Review found blocking issues/);
    assert.match(followUps[0]?.message ?? "", /missing guard/);
    assert.equal(followUps[1]?.message, "also keep the API name stable");
    assert.deepEqual(followUps.map((item) => item.options), [{ deliverAs: "followUp" }, { deliverAs: "followUp" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent end skips reviewer when primary turn signal is already aborted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-aborted-before-review-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const markerPath = join(dir, "review-started.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'started');`,
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            "const ok=input.includes('Initial user request:')",
            "&& input.includes('change index')",
            "&& input.includes('redirect to finish safely')",
            "&& input.includes('-before')",
            "&& input.includes('+after redirected');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'kept interrupted context',findings:[]}",
            ":{verdict:'needs_changes',summary:'lost interrupted context',findings:[{severity:'blocking',file:'session',line:null,issue:'missing aborted run context',recommendation:'preserve baseline and request history across abort'}]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const controller = new AbortController();
    controller.abort();
    await triggerAgentEnd(hooks, { cwd: dir, signal: controller.signal });

    await assert.rejects(access(markerPath), /ENOENT/);
    assert.doesNotMatch(notices.join("\n"), /reviewing changes/);

    await trigger(hooks, "input", { cwd: dir, text: "redirect to finish safely", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after redirected\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });

    await access(markerPath);
    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost interrupted context/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/new shutdown silently aborts review work before its context becomes stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-new-session-abort-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const markerPath = join(dir, "review-started.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(markerPath)},'started');`,
            "setInterval(()=>{},1000);",
          ].join(""),
        ],
        timeoutMs: 300000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const terminalHandlers: Array<(input: unknown) => unknown> = [];
    const ui = {
      notify(message: string) {
        notices.push(message);
      },
      onTerminalInput(handler: (input: unknown) => unknown) {
        terminalHandlers.push(handler);
        return () => {
          const index = terminalHandlers.indexOf(handler);
          if (index >= 0) {
            terminalHandlers.splice(index, 1);
          }
        };
      },
    };
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
    };
    const controller = new AbortController();
    let contextActive = true;
    const ctx = {
      cwd: dir,
      signal: controller.signal,
      get ui() {
        if (!contextActive) {
          throw new Error("test context is stale after /new");
        }
        return ui;
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    await trigger(hooks, "agent_end", ctx);
    const reviewPromise = trigger(hooks, "agent_settled", ctx);
    await waitForFile(markerPath);
    assert.equal(terminalHandlers.length, 1);

    controller.abort();
    const shutdownPromise = trigger(hooks, "session_shutdown", { reason: "new" }, ctx);
    contextActive = false;

    await shutdownPromise;
    await reviewPromise;

    assert.equal(terminalHandlers.length, 0);
    assert.doesNotMatch(notices.join("\n"), /review gate: review cancelled/);
    assert.doesNotMatch(notices.join("\n"), /reviewer failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("escape terminal input aborts an active reviewer process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-escape-review-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const markerPath = join(dir, "review-started.txt");
    const invocationPath = join(dir, "review-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');",
            `const markerPath=${JSON.stringify(markerPath)};`,
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "fs.writeFileSync(markerPath,'started');",
            "if(count===0){setInterval(()=>{},1000);}",
            "else {",
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            "const ok=input.includes('Initial user request:')",
            "&& input.includes('change index')",
            "&& input.includes('redirect after cancelling review')",
            "&& input.includes('-before')",
            "&& input.includes('+after redirected');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'kept cancelled review context',findings:[]}",
            ":{verdict:'needs_changes',summary:'lost cancelled review context',findings:[{severity:'blocking',file:'session',line:null,issue:'missing cancelled review context',recommendation:'preserve baseline and request history across review cancellation'}]}));",
            "});",
            "}",
          ].join(""),
        ],
        timeoutMs: 300000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const terminalHandlers: Array<(input: unknown) => unknown> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        onTerminalInput(handler: (input: unknown) => unknown) {
          terminalHandlers.push(handler);
          return () => {
            const index = terminalHandlers.indexOf(handler);
            if (index >= 0) {
              terminalHandlers.splice(index, 1);
            }
          };
        },
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    await trigger(hooks, "agent_end", { cwd: dir, ui: pi.ui });
    const reviewPromise = trigger(hooks, "agent_settled", { cwd: dir, ui: pi.ui });
    await waitForFile(markerPath);

    assert.equal(terminalHandlers.length, 1);
    assert.deepEqual(
      await triggerResults(hooks, "input", { cwd: dir, text: "do not continue with this", source: "user" }),
      [{ action: "handled" }],
    );
    assert.deepEqual(terminalHandlers[0]?.("\x1b"), { action: "handled", consume: true });
    await reviewPromise;

    assert.match(notices.join("\n"), /review gate: review cancelled/);
    assert.doesNotMatch(notices.join("\n"), /reviewer failed/);
    assert.equal(followUps.length, 0);
    assert.equal(terminalHandlers.length, 0);
    // The mid-review guidance was deliberately dropped with the cancellation:
    // one bounded count-only notice, no input content, no follow-up delivery.
    assert.equal(
      notices.filter((notice) => notice.includes("were dropped when the review was cancelled")).length,
      1,
    );
    assert.match(
      notices.join("\n"),
      /review gate: 1 queued user input\(s\) were dropped when the review was cancelled and will not be sent automatically; resend them if still needed/,
    );
    assert.doesNotMatch(notices.join("\n"), /do not continue with this/);

    await trigger(hooks, "input", { cwd: dir, text: "redirect after cancelling review", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after redirected\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir, ui: pi.ui });

    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost cancelled review context/);
    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /Review pass 2 transmission/);
    assert.match(followUps[0]?.message ?? "", /Gate verdict: pass/);
    const bundleDir = extractBundleDir(followUps[0]?.message ?? "", 2);
    assert.match(
      await readFile(join(bundleDir, "reviews", "0001", "CANCELED.md"), "utf8"),
      /A review would have been run here but was canceled by the user\./,
    );
    await assert.rejects(access(join(bundleDir, "reviews", "0001", "reviewers", "fake", "parsed-result.json")), /ENOENT/);
    assert.equal(terminalHandlers.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kitty CSI-u escape aborts an active reviewer process; release and modified escape do not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-escape-csi-u-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const pidPath = join(dir, "reviewer-pid.txt");
    const invocationPath = join(dir, "review-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');",
            `const pidPath=${JSON.stringify(pidPath)};`,
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "fs.writeFileSync(pidPath,String(process.pid));",
            "if(count===0){setInterval(()=>{},1000);}",
            "else {",
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            "const ok=input.includes('Initial user request:')",
            "&& input.includes('change index')",
            "&& input.includes('redirect after cancelling review')",
            "&& input.includes('-before')",
            "&& input.includes('+after redirected');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'kept cancelled review context',findings:[]}",
            ":{verdict:'needs_changes',summary:'lost cancelled review context',findings:[{severity:'blocking',file:'session',line:null,issue:'missing cancelled review context',recommendation:'preserve baseline and request history across review cancellation'}]}));",
            "});",
            "}",
          ].join(""),
        ],
        timeoutMs: 300000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: string[] = [];
    const terminalHandlers: Array<(input: unknown) => unknown> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        onTerminalInput(handler: (input: unknown) => unknown) {
          terminalHandlers.push(handler);
          return () => {
            const index = terminalHandlers.indexOf(handler);
            if (index >= 0) terminalHandlers.splice(index, 1);
          };
        },
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    await trigger(hooks, "agent_end", { cwd: dir, ui: pi.ui });
    const reviewPromise = trigger(hooks, "agent_settled", { cwd: dir, ui: pi.ui });
    await waitForFile(pidPath);

    assert.equal(terminalHandlers.length, 1);
    const reviewerPid = Number(await readFile(pidPath, "utf8"));
    assert.doesNotThrow(() => process.kill(reviewerPid, 0), "reviewer child should be running before cancellation");

    // Key-release and modified Escape sequences must not cancel the review.
    assert.deepEqual(terminalHandlers[0]?.("\x1b[27;1:3u"), undefined);
    assert.deepEqual(terminalHandlers[0]?.("\x1b[27;5u"), undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.doesNotThrow(() => process.kill(reviewerPid, 0), "release/modified escape must not stop the reviewer");
    assert.doesNotMatch(notices.join("\n"), /review cancelled/);

    // Unmodified Escape in Kitty CSI-u form must cancel it.
    assert.deepEqual(terminalHandlers[0]?.("\x1b[27u"), { action: "handled", consume: true });
    // Let the asynchronous acknowledgement notice land before asserting order.
    await new Promise((resolve) => setImmediate(resolve));
    // Immediate acknowledgement must not claim reviewer quiescence; the
    // completion notice appears only after runReview returned and children died.
    assert.match(notices.join("\n"), /review gate: cancelling the automatic review; waiting for reviewer processes to stop/);
    assert.doesNotMatch(notices.join("\n"), /reviewer processes stopped/);
    await reviewPromise;

    await waitForCondition(() => {
      try {
        process.kill(reviewerPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.match(notices.join("\n"), /review gate: review cancelled; reviewer processes stopped/);
    assert.equal(terminalHandlers.length, 0);
    // No input was queued during the review, so no dropped-input notice may
    // claim a drop.
    assert.doesNotMatch(notices.join("\n"), /were dropped when the review was cancelled/);
    assert.doesNotMatch(notices.join("\n"), /will not be sent automatically/);

    // The aborted invocation leaves the user-canceled tombstone artifact.
    await trigger(hooks, "input", { cwd: dir, text: "redirect after cancelling review", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after redirected\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir, ui: pi.ui });

    assert.match(notices.join("\n"), /review gate: passed/);
    const bundleDir = extractBundleDir(followUps[0] ?? "", 2);
    assert.match(
      await readFile(join(bundleDir, "reviews", "0001", "CANCELED.md"), "utf8"),
      /A review would have been run here but was canceled by the user\./,
    );
    assert.equal(terminalHandlers.length, 0);
  } finally {
    reapAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("/review-cancel stops an active automatic review and reports when no review is active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-review-cancel-auto-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const pidPath = join(dir, "reviewer-pid.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "slow",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000)`,
        ],
        timeoutMs: 300000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage() {},
    };

    await activate(pi);
    assert.equal(commands.has("review-cancel"), true);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(hooks, "agent_end", { cwd: dir, ui: pi });

    // No review is active yet.
    await commands.get("review-cancel")?.("", pi);
    assert.match(notices.join("\n"), /no active review to cancel/);

    const reviewPromise = trigger(hooks, "agent_settled", { cwd: dir, ui: pi });
    await waitForFile(pidPath);
    const reviewerPid = Number(await readFile(pidPath, "utf8"));
    assert.doesNotThrow(() => process.kill(reviewerPid, 0));

    // Type guidance mid-review; /review-cancel drops it deliberately, so the
    // session must report the count without delivering or echoing the content.
    assert.deepEqual(
      await triggerResults(hooks, "input", { cwd: dir, text: "keep this guidance", source: "user" }),
      [{ action: "handled" }],
    );

    await commands.get("review-cancel")?.("", pi);
    await reviewPromise;

    assert.match(notices.join("\n"), /review gate: cancelling the automatic review; waiting for reviewer processes to stop/);
    assert.match(notices.join("\n"), /review gate: review cancelled; reviewer processes stopped/);
    // The completion notice appears exactly once even though both the command
    // and the automatic-review settlement path report cancellation.
    assert.equal(
      notices.filter((notice) => notice === "review gate: review cancelled; reviewer processes stopped").length,
      1,
    );
    assert.equal(
      notices.filter((notice) => notice.includes("were dropped when the review was cancelled")).length,
      1,
    );
    assert.match(
      notices.join("\n"),
      /review gate: 1 queued user input\(s\) were dropped when the review was cancelled and will not be sent automatically; resend them if still needed/,
    );
    assert.doesNotMatch(notices.join("\n"), /keep this guidance/);
    await waitForCondition(() => {
      try {
        process.kill(reviewerPid, 0);
        return false;
      } catch {
        return true;
      }
    });

    await commands.get("review-cancel")?.("", pi);
    assert.match(notices.join("\n"), /no active review to cancel/);
  } finally {
    reapAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy queued inputs without active delivery records are counted when a review is cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-legacy-queued-drop-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const markerPath = join(dir, "reviewer-marker.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "slow",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'started');process.stdin.resume();setInterval(()=>{},1000)`,
        ],
        timeoutMs: 300000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const sessionFile = join(dir, "legacy-conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const mkRuntime = (sessionId: string) => {
      const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
      const notices: string[] = [];
      const followUps: Array<{ message: string; options: unknown }> = [];
      const terminalHandlers: Array<(input: unknown) => unknown> = [];
      const pi = {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          hooks.set(name, [...(hooks.get(name) ?? []), handler]);
        },
        registerCommand() {},
        notify(message: string) { notices.push(message); },
        ui: {
          notify(message: string) { notices.push(message); },
          onTerminalInput(handler: (input: unknown) => unknown) {
            terminalHandlers.push(handler);
            return () => {
              const index = terminalHandlers.indexOf(handler);
              if (index >= 0) terminalHandlers.splice(index, 1);
            };
          },
        },
        sendUserMessage(message: string, options: unknown) { followUps.push({ message, options }); },
      };
      const ctx = {
        cwd: dir,
        ui: pi.ui,
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => sessionFile,
          getCwd: () => dir,
        },
      };
      return { hooks, notices, followUps, terminalHandlers, pi, ctx };
    };

    // First session: establish a review window with a baseline, then shut down.
    const first = mkRuntime("legacy-conversation");
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dir, text: "initial request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    // Rewrite the persisted state into a legacy/inconsistent shape: a queued-input
    // ledger entry without an active durable delivery. A stale cancelled record
    // for the same text must not hide the currently queued occurrence.
    const store = new SessionStateStore({ sessionId: "legacy-conversation", sessionFile, cwd: dir });
    const persistedState = await store.restore(dir);
    assert.ok(persistedState);
    persistedState.state.queuedUserInputsDuringReview = ["legacy mid-review direction"];
    persistedState.state.pendingModelDeliveries = [];
    const staleCancelledDelivery = queueModelDelivery(persistedState.state, {
      deliveryId: "queued-user-input:old-window:1",
      kind: "queued_user_input",
      channel: "follow_up",
      message: "legacy mid-review direction",
    });
    staleCancelledDelivery.status = "cancelled";
    await store.save(persistedState.state, persistedState.execution);

    // Resumed session: the legacy entry survives the restore (the recovery
    // notice reports it), the automatic review runs, and Escape cancels it.
    // The drop notice must count the legacy entry even though it has no
    // delivery record, without ever echoing its content.
    const resumed = mkRuntime("legacy-conversation");
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);
    assert.match(resumed.notices.join("\n"), /remain queued from an interrupted review/);

    await trigger(resumed.hooks, "agent_end", { cwd: dir, ui: resumed.pi.ui }, resumed.ctx);
    const reviewPromise = trigger(resumed.hooks, "agent_settled", { cwd: dir, ui: resumed.pi.ui }, resumed.ctx);
    await waitForFile(markerPath);

    assert.equal(resumed.terminalHandlers.length, 1);
    assert.deepEqual(resumed.terminalHandlers[0]?.("\x1b"), { action: "handled", consume: true });
    await reviewPromise;

    assert.match(resumed.notices.join("\n"), /review gate: review cancelled/);
    assert.equal(
      resumed.notices.filter((notice) => notice.includes("were dropped when the review was cancelled")).length,
      1,
    );
    assert.match(
      resumed.notices.join("\n"),
      /review gate: 1 queued user input\(s\) were dropped when the review was cancelled and will not be sent automatically; resend them if still needed/,
    );
    assert.doesNotMatch(resumed.notices.join("\n"), /legacy mid-review direction/);
    assert.equal(resumed.followUps.length, 0);

    // The cancellation is durable: the ledger is cleared and the reconciled
    // delivery is cancelled, so a later restore cannot resurrect either.
    const persisted = JSON.parse(await readFile(`${sessionFile}.pi-review-gate-state.json`, "utf8")) as {
      state: { queuedUserInputsDuringReview: string[]; pendingModelDeliveries: Array<{ kind: string; status: string; message: string }> };
    };
    assert.deepEqual(persisted.state.queuedUserInputsDuringReview, []);
    assert.equal(persisted.state.pendingModelDeliveries.length, 2);
    assert.ok(persisted.state.pendingModelDeliveries.every((delivery) => delivery.kind === "queued_user_input"));
    assert.ok(persisted.state.pendingModelDeliveries.every((delivery) => delivery.status === "cancelled"));
  } finally {
    reapAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failure after listener registration still unregisters, settles, and cleans up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-registration-reject-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-review-gate-reject-session-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const markerPath = join(dir, "reviewer-started.txt");
    const sessionFile = join(sessionDir, "session.jsonl");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'started');process.stdin.resume();setInterval(()=>{},1000)`,
        ],
        timeoutMs: 300000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const terminalHandlers: Array<(input: unknown) => unknown> = [];
    const sessionManager = {
      getSessionId: () => "reject-persist-session",
      getSessionFile: () => sessionFile,
      getCwd: () => dir,
    };
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage() {},
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        onTerminalInput(handler: (input: unknown) => unknown) {
          terminalHandlers.push(handler);
          return () => {
            const index = terminalHandlers.indexOf(handler);
            if (index >= 0) terminalHandlers.splice(index, 1);
          };
        },
      },
    };

    await activate(pi);
    await trigger(hooks, "session_start", { cwd: dir, ui: pi.ui, sessionManager });
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(hooks, "agent_end", { cwd: dir, ui: pi.ui });

    // Remove the persistence target so the post-registration
    // persistSessionState() await inside the agent_settled review path rejects.
    await rm(sessionDir, { recursive: true, force: true });
    const reviewPromise = trigger(hooks, "agent_settled", { cwd: dir, ui: pi.ui });
    await assert.rejects(reviewPromise);

    // The terminal-input listener and coordinator handle were cleaned up, the
    // reviewer never started, and neither session shutdown nor /review-cancel
    // can hang on stale state.
    assert.equal(terminalHandlers.length, 0);
    await assert.rejects(access(markerPath), /ENOENT/);
    await mkdir(sessionDir, { recursive: true });
    await commands.get("review-cancel")?.("", pi);
    assert.match(notices.join("\n"), /no active review to cancel/);
    await trigger(hooks, "session_shutdown", { reason: "new" }, { cwd: dir, ui: pi.ui });
  } finally {
    reapAll();
    await rm(sessionDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("automatic correction turns preserve original baseline and accumulated evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-auto-correction-evidence-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationPath = join(dir, "review-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');",
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            "if(count===0){",
            "process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]}));",
            "return;",
            "}",
            "const ok=input.includes('original-tool-evidence')",
            "&& input.includes('fix-tool-evidence')",
            "&& input.includes('first assistant summary')",
            "&& input.includes('second assistant summary')",
            "&& input.includes('-before')",
            "&& input.includes('+fixed');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'kept accumulated evidence',findings:[]}",
            ":{verdict:'needs_changes',summary:'lost accumulated evidence',findings:[{severity:'blocking',file:'session',line:null,issue:'review prompt lost original baseline or evidence across automatic correction',recommendation:'preserve original baseline and accumulated evidence across automatic correction turns'}]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo original-tool-evidence" } });
    await writeFile(join(dir, "index.ts"), "broken\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "first assistant summary" }],
    });

    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /missing guard/);

    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo fix-tool-evidence" } });
    await writeFile(join(dir, "index.ts"), "fixed\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "second assistant summary" }],
    });

    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost accumulated evidence/);
    assert.equal(followUps.length, 2);
    assert.match(followUps[1]?.message ?? "", /Gate verdict: pass/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("automatic correction is reviewed when it exactly restores the original baseline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-auto-correction-exact-revert-"));
  const invocationPath = join(tmpdir(), `pi-review-gate-exact-revert-${process.pid}-${Date.now()}.txt`);
  const bundlePathRecord = join(tmpdir(), `pi-review-gate-exact-revert-bundle-${process.pid}-${Date.now()}.txt`);

  try {
    await writeFile(join(dir, "index.ts"), "original\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');",
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            `const bundlePathRecord=${JSON.stringify(bundlePathRecord)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "const bundle=process.env.PI_REVIEW_GATE_BUNDLE_DIR;",
            "const firstBundle=fs.existsSync(bundlePathRecord)?fs.readFileSync(bundlePathRecord,'utf8'):'';",
            "if(!firstBundle&&bundle)fs.writeFileSync(bundlePathRecord,bundle);",
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            "if(count===0){",
            "process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'restore required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'original content was removed',recommendation:'restore the original content'}]}));",
            "return;",
            "}",
            "const ok=input.includes('no net submitted workspace changes')",
            "&& input.includes('original content was removed')",
            "&& input.includes('restore the original content')",
            "&& input.includes('correction-tool-evidence')",
            "&& bundle===firstBundle",
            "&& fs.readFileSync(bundle+'/exchanges/0002/submitted.patch','utf8').includes('-incorrect')",
            "&& fs.readFileSync(bundle+'/exchanges/0002/submitted.patch','utf8').includes('+original')",
            "&& fs.readFileSync(bundle+'/exchanges/0002/tool-events.md','utf8').includes('correction-tool-evidence');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'exact restoration validated',findings:[]}",
            ":{verdict:'needs_changes',summary:'lost exact-restoration context',findings:[{severity:'blocking',file:'session',line:null,issue:'follow-up review lost the prior feedback or correction evidence',recommendation:'preserve and review the correction window'}]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "incorrect\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "changed the original content" }],
    });

    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /restore the original content/);

    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo correction-tool-evidence" } });
    await writeFile(join(dir, "index.ts"), "original\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "restored the original content" }],
    });

    assert.equal(await readFile(invocationPath, "utf8"), "2");
    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost exact-restoration context/);
    assert.equal(followUps.length, 2);
    assert.match(followUps[1]?.message ?? "", /Gate verdict: pass/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(invocationPath, { force: true });
    await rm(bundlePathRecord, { force: true });
  }
});

test("automatic correction starts each reviewer in a fresh session against the stable window bundle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reviewer-session-resume-"));
  const argvPath = join(tmpdir(), `pi-review-gate-reviewer-session-argv-${process.pid}-${Date.now()}.json`);
  let retainedBundleDir: string | undefined;

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const reviewerPath = join(dir, "fake-codex.mjs");
    await writeFile(reviewerPath, [
      "#!/usr/bin/env node",
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      `const argvPath=${JSON.stringify(argvPath)};`,
      "const history=existsSync(argvPath)?JSON.parse(readFileSync(argvPath,'utf8')):[];",
      "history.push({argv:process.argv.slice(2),bundle:process.env.PI_REVIEW_GATE_BUNDLE_DIR});",
      "writeFileSync(argvPath,JSON.stringify(history));",
      "const args=process.argv.slice(2);",
      "const out=args[args.indexOf('--output-last-message')+1];",
      "const result=history.length===1",
      "?{verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'bad value',recommendation:'write the fixed value'}]}",
      ":{verdict:'pass',summary:'correction accepted',findings:[]};",
      "writeFileSync(out,JSON.stringify(result));",
      "let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);",
      "process.stdin.on('end',()=>{history.at(-1).prompt=prompt;writeFileSync(argvPath,JSON.stringify(history));process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'stable-review-session'})+'\\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})+'\\n')});",
    ].join("\n"), "utf8");
    await chmod(reviewerPath, 0o755);

    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "codex",
        adapter: "codex-cli",
        command: reviewerPath,
        timeoutMs: 15000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const followUps: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify() {},
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "broken\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });
    assert.equal(followUps.length, 1);

    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "fixed\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });

    const history = JSON.parse(await readFile(argvPath, "utf8"));
    assert.equal(history.length, 2);
    assert.deepEqual(history[1].argv.slice(0, 2), ["exec", "--json"]);
    assert.equal(history[1].argv.includes("resume"), false);
    assert.equal(history[0].bundle, history[1].bundle);
    assert.match(history[0].prompt, /authoritative evidence bundle/);
    assert.match(history[1].prompt, /REVIEW\.md/);
    assert.doesNotMatch(history[1].prompt, /submitted_patch_diff/);
    const freshInvocation = JSON.parse(await readFile(
      join(history[1].bundle, "reviews", "0002", "reviewers", "codex", "invocation.json"),
      "utf8",
    ));
    assert.equal(freshInvocation.resumed, false);
    assert.equal(freshInvocation.telemetry.sessionResumed, false);
    assert.equal(freshInvocation.session.id, "stable-review-session");

    const bundleDir = history[1].bundle;
    retainedBundleDir = bundleDir;
    await trigger(hooks, "session_shutdown", { reason: "test" });
    await assert.rejects(access(bundleDir), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(argvPath, { force: true });
    if (retainedBundleDir) await rm(retainedBundleDir, { recursive: true, force: true });
  }
});

test("/review-continue after cap preserves original baseline and accumulated evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-capped-continue-evidence-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationPath = join(dir, "review-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      maxCorrectionCycles: 0,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');",
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            "if(count===0){",
            "process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]}));",
            "return;",
            "}",
            "const ok=input.includes('capped-original-evidence')",
            "&& input.includes('continued-fix-evidence')",
            "&& input.includes('first capped summary')",
            "&& input.includes('continued summary')",
            "&& input.includes('-before')",
            "&& input.includes('+fixed after continue');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'kept capped continuation evidence',findings:[]}",
            ":{verdict:'needs_changes',summary:'lost capped continuation evidence',findings:[{severity:'blocking',file:'session',line:null,issue:'review prompt lost evidence after correction cap and review-continue',recommendation:'preserve evidence across capped continuation'}]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo capped-original-evidence" } });
    await writeFile(join(dir, "index.ts"), "broken\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "first capped summary" }],
    });

    assert.match(notices.join("\n"), /automatic correction cap reached/);
    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /automatic correction is deferred/);

    await commands.get("review-continue")?.("", { notify(message: string) { notices.push(message); } });

    assert.equal(followUps.length, 2);
    assert.match(followUps[1]?.message ?? "", /correction authorization/);
    assert.doesNotMatch(followUps[1]?.message ?? "", /missing guard/);
    const cappedBundleDir = extractBundleDir(followUps[0]?.message ?? "", 1);
    const cappedDeliveries = JSON.parse(await readFile(
      join(cappedBundleDir, "reviews", "0001", "delivery.json"),
      "utf8",
    ));
    assert.deepEqual(
      cappedDeliveries.deliveries.map((delivery: { action: string }) => delivery.action),
      ["deferred", "correction_required"],
    );

    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo continued-fix-evidence" } });
    await writeFile(join(dir, "index.ts"), "fixed after continue\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "continued summary" }],
    });

    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost capped continuation evidence/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normal user input after cap continues the unresolved review window with complete context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-capped-fresh-input-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationPath = join(dir, "review-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      maxCorrectionCycles: 0,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');",
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            "if(count===0){",
            "process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]}));",
            "return;",
            "}",
            "const ok=input.includes('fresh-task-evidence')",
            "&& input.includes('old-capped-evidence')",
            "&& input.includes('first capped summary')",
            "&& input.includes('missing guard')",
            "&& input.includes('complete feedback transmitted to the implementing model with correction deferred at the cap')",
            "&& input.includes('Initial user request:')",
            "&& input.includes('change index')",
            "&& input.includes('Additional user guidance during the same review window:')",
            "&& input.includes('start a different task')",
            "&& input.includes('-before')",
            "&& input.includes('+fresh change')",
            ";",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'capped window retained complete context',findings:[]}",
            ":{verdict:'needs_changes',summary:'capped window lost context',findings:[{severity:'blocking',file:'session',line:null,issue:'normal prompt after cap lost evidence, feedback, or baseline',recommendation:'keep the unresolved review window intact'}]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage() {},
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo old-capped-evidence" } });
    await writeFile(join(dir, "index.ts"), "broken\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "first capped summary" }],
    });

    assert.match(notices.join("\n"), /automatic correction cap reached/);

    await trigger(hooks, "input", { cwd: dir, text: "start a different task", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo fresh-task-evidence" } });
    await writeFile(join(dir, "index.ts"), "fresh change\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "fresh task summary" }],
    });

    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /capped window lost context/);
    assert.equal(commands.has("review-continue"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a passed review remains available to /ask-reviewer-interactive but is checkpointed out of the next regular window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-window-checkpoint-"));
  const outside = join(tmpdir(), `pi-review-gate-outside-review-${process.pid}-${Date.now()}.md`);
  const invocationPath = join(tmpdir(), `pi-review-gate-window-invocations-${process.pid}-${Date.now()}.txt`);

  try {
    await writeFile(join(dir, "Dockerfile"), "FROM alpine:3.19\n", "utf8");
    await writeFile(outside, "old review document\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      maxCorrectionCycles: 0,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');",
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            `const outside=${JSON.stringify(outside)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            "const firstContext=input.includes(outside)&&input.includes('outside_workspace')&&input.includes('first Docker task');",
            "const ok=count===0",
            "?firstContext",
            ":count===1",
            "?firstContext&&input.includes('Reviewer question:')&&input.includes('what changed outside the workspace?')&&input.includes('-FROM alpine:3.19')&&input.includes('+FROM alpine:3.20')",
            ":!input.includes(outside)&&!input.includes('first Docker task')&&input.includes('second Docker task')&&input.includes('+FROM alpine:3.21');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:count===0?'first window complete':count===1?'passed context retained for question':'second window isolated',findings:[]}",
            ":{verdict:'needs_changes',summary:'review windows mixed',findings:[{severity:'blocking',file:'session',line:null,issue:'a review used changes or context from the wrong window',recommendation:'checkpoint passed changes and open an isolated window'}]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const editorViews: Array<{ title: string; prefill: string }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage() {},
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "first Docker task", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "write", input: { path: outside } });
    await writeFile(outside, "rewritten review document\n", "utf8");
    await writeFile(join(dir, "Dockerfile"), "FROM alpine:3.20\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "finished first Docker task and review document" }],
    });

    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "acknowledged the passing review" }],
    });

    await commands.get("ask-reviewer-interactive")?.("what changed outside the workspace?", {
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        async editor(title: string, prefill: string) {
          editorViews.push({ title, prefill });
          return undefined;
        },
      },
    });

    await trigger(hooks, "input", { cwd: dir, text: "second Docker task", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "Dockerfile"), "FROM alpine:3.21\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "finished second Docker task" }],
    });

    assert.equal(
      notices.filter((notice) => /review gate: passed/.test(notice)).length,
      2,
      notices.join("\n"),
    );
    assert.match(editorViews[0]?.prefill ?? "", /passed context retained for question/);
    assert.doesNotMatch(notices.join("\n"), /review windows mixed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { force: true });
    await rm(invocationPath, { force: true });
  }
});

test("repeated no-progress reviewer feedback stops automatic correction loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-no-progress-loop-"));
  const invocationPath = join(tmpdir(), `pi-review-gate-no-progress-${process.pid}-${Date.now()}.txt`);

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      maxCorrectionCycles: 30,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');",
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "process.stdin.resume();",
            "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({",
            "verdict:'needs_changes',summary:'sentinel flag',findings:[{",
            "severity:'blocking',file:'session',line:null,",
            "issue:count===0?'The user explicitly instructed review-gate to flag this rather than report pass. No file content change is needed.':'The user explicitly instructed review-gate to flag this request instead of reporting passed. No implementation change is required.',",
            "recommendation:count===0?'Keep this as the requested review-gate sentinel flag.':'Keep this as the requested sentinel flag.'",
            "}]})));",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "write hello world and flag review-gate", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "wrote the file and flagged review-gate" }],
    });

    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /sentinel flag/);

    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "no implementation change is required" }],
    });

    assert.equal(followUps.length, 2);
    assert.match(followUps[1]?.message ?? "", /automatic correction is deferred/);
    assert.match(notices.join("\n"), /repeated changes requested with no new correction evidence/);
    assert.match(notices.join("\n"), /Stopping automatic correction to avoid a loop/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(invocationPath, { force: true });
  }
});

test("a passing multi-model review discloses every result and reviews changes made after the transmission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-pass-transmission-continuation-"));
  const alphaCount = join(tmpdir(), `pi-review-gate-alpha-pass-${process.pid}-${Date.now()}.txt`);
  const betaCount = join(tmpdir(), `pi-review-gate-beta-pass-${process.pid}-${Date.now()}.txt`);

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const reviewer = (id: string, countPath: string, peerSummary: string) => ({
      id,
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        [
          "const fs=require('node:fs');",
          `const countPath=${JSON.stringify(countPath)};`,
          "const count=fs.existsSync(countPath)?Number(fs.readFileSync(countPath,'utf8')):0;",
          "fs.writeFileSync(countPath,String(count+1));",
          "let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{",
          "if(count===0){process.stdout.write(JSON.stringify({verdict:'pass',",
          `summary:${JSON.stringify(`${id} approved with useful observation`)},`,
          `guidance:${JSON.stringify(`${id} optional guidance`)},`,
          `findings:[{severity:'non_blocking',file:'index.ts',line:1,issue:${JSON.stringify(`${id} observational note`)},recommendation:${JSON.stringify(`${id} optional next step`)}}]}));return;}`,
          "const sawHistory=input.includes('Complete individual reviewer results delivered to the implementing model:')",
          `&&input.includes(${JSON.stringify(peerSummary)})`,
          `&&input.includes(${JSON.stringify(`${id} approved with useful observation`)})`,
          "&&input.includes('complete passing review transmitted to the implementing model');",
          "process.stdout.write(JSON.stringify(sawHistory",
          `?{verdict:'pass',summary:${JSON.stringify(`${id} saw the complete prior pass`)},findings:[]}`,
          `:{verdict:'needs_changes',summary:${JSON.stringify(`${id} did not see complete prior reviewer results`)},findings:[{severity:'blocking',file:'session',line:null,issue:'prior multi-model pass was hidden',recommendation:'deliver every prior reviewer result'}]}));`,
          "});",
        ].join(""),
      ],
      timeoutMs: 15000,
    });
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      reviewers: [
        reviewer("alpha", alphaCount, "beta approved with useful observation"),
        reviewer("beta", betaCount, "alpha approved with useful observation"),
      ],
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "implement the change", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "first implementation\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });

    assert.equal(followUps.length, 1);
    assert.match(followUps[0] ?? "", /Gate verdict: pass/);
    assert.match(followUps[0] ?? "", /### alpha — pass/);
    assert.match(followUps[0] ?? "", /alpha optional guidance/);
    assert.match(followUps[0] ?? "", /alpha observational note/);
    assert.match(followUps[0] ?? "", /### beta — pass/);
    assert.match(followUps[0] ?? "", /beta optional guidance/);
    assert.match(followUps[0] ?? "", /beta observational note/);
    assert.doesNotMatch(followUps[0] ?? "", /Aggregate decision/);

    const bundleDir = extractBundleDir(followUps[0] ?? "", 1);
    const passOneDir = join(bundleDir, "reviews", "0001");
    assert.equal(await readFile(join(passOneDir, "implementing-model-transmission.md"), "utf8"), followUps[0]);
    const envelope = JSON.parse(await readFile(join(passOneDir, "implementing-model-transmission.json"), "utf8"));
    assert.equal(envelope.gateVerdict, "pass");
    assert.equal(envelope.reviewerResults.length, 2);
    assert.equal("aggregateResult" in envelope, false);
    await assert.rejects(access(join(passOneDir, "parsed-result.json")), /ENOENT/);
    const delivery = JSON.parse(await readFile(join(passOneDir, "delivery.json"), "utf8"));
    assert.equal(delivery.recipient, "implementing_model");
    assert.equal(delivery.deliveries.length, 1);
    assert.equal(delivery.deliveries[0].action, "passed");
    assert.equal(delivery.deliveries[0].content, "implementing-model-transmission.md");
    assert.equal(delivery.deliveries[0].message, undefined);

    await writeFile(join(dir, "index.ts"), "follow-up implementation\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });

    assert.equal(await readFile(alphaCount, "utf8"), "2");
    assert.equal(await readFile(betaCount, "utf8"), "2");
    assert.equal(followUps.length, 2);
    assert.match(followUps[1] ?? "", /alpha saw the complete prior pass/);
    assert.match(followUps[1] ?? "", /beta saw the complete prior pass/);
    assert.doesNotMatch(notices.join("\n"), /prior multi-model pass was hidden/);
    const exchange = JSON.parse(await readFile(join(bundleDir, "exchanges", "0002", "metadata.json"), "utf8"));
    assert.equal(exchange.causedByReviewSequence, 1);
    assert.equal(exchange.causedByReviewVerdict, "pass");
    assert.equal(exchange.reviewResponseMode, "observation");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(alphaCount, { force: true });
    await rm(betaCount, { force: true });
  }
});

test("an unchanged response to a passing transmission closes without another review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-pass-transmission-unchanged-"));
  const invocationCount = join(tmpdir(), `pi-review-gate-pass-unchanged-${process.pid}-${Date.now()}.txt`);

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "passing",
        adapter: "generic-cli",
        command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(invocationCount)},'1');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'final useful observation',guidance:'consider a later cleanup',findings:[]})))`],
        timeoutMs: 15000,
      },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const followUps: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify() {},
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "implement the change", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "implemented\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });
    const bundleDir = extractBundleDir(followUps[0] ?? "", 1);

    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "acknowledged the review without changing files" }],
    });

    assert.equal(await readFile(invocationCount, "utf8"), "1");
    assert.equal(followUps.length, 1);
    const finalExchange = JSON.parse(await readFile(
      join(bundleDir, "exchanges", "0002", "metadata.json"),
      "utf8",
    ));
    assert.equal(finalExchange.causedByReviewSequence, 1);
    assert.equal(finalExchange.reviewResponseMode, "observation");
    assert.match(
      await readFile(join(bundleDir, "exchanges", "0002", "assistant-summary.md"), "utf8"),
      /acknowledged the review without changing files/,
    );
    await trigger(hooks, "input", { cwd: dir, text: "next independent task", source: "user" });
    await assert.rejects(access(bundleDir), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(invocationCount, { force: true });
  }
});

test("/ask-reviewer pauses an active turn before invoking the reviewer and then steers the answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ask-active-turn-"));
  const invocationMarker = join(dir, "reviewer-invoked.txt");

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      maxCorrectionCycles: 1,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            `require('node:fs').writeFileSync(${JSON.stringify(invocationMarker)},'invoked');`,
            "process.stdin.resume();let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>",
            "process.stdout.write(JSON.stringify(s.includes('paused at a stable boundary')",
            "?{verdict:'pass',summary:'reviewed the paused workspace',guidance:null,findings:[],error:null}",
            ":{verdict:'needs_changes',summary:'missing paused exchange',guidance:null,findings:[],error:null})));",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const userMessages: Array<{ message: string; options: unknown }> = [];
    let idle = true;
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify() {},
      sendUserMessage(message: string, options: unknown) {
        userMessages.push({ message, options });
      },
    };
    const ctx = {
      isIdle: () => idle,
      ui: { notify() {} },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    idle = false;
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "changed before consultation\n", "utf8");

    const questionPromise = Promise.resolve(commands.get("ask-reviewer")?.("is this correct?", ctx));
    await waitForCondition(() => userMessages.length === 1);

    assert.deepEqual(userMessages[0]?.options, { deliverAs: "steer" });
    assert.match(userMessages[0]?.message ?? "", /Pause implementation at this steering boundary/);
    await assert.rejects(access(invocationMarker), /ENOENT/);

    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "paused at a stable boundary" }],
    });
    idle = true;
    await questionPromise;

    assert.equal(await readFile(invocationMarker, "utf8"), "invoked");
    assert.equal(userMessages.length, 2);
    assert.deepEqual(userMessages[1]?.options, { deliverAs: "steer" });
    assert.match(userMessages[1]?.message ?? "", /Reviewer note from \/ask-reviewer:/);
    assert.match(userMessages[1]?.message ?? "", /reviewed the paused workspace/);
    assert.doesNotMatch(userMessages[1]?.message ?? "", /Review pass .* transmission/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider-error agent_end followed by a successful retry keeps the original baseline until agent_settled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-retry-settlement-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationPath = join(dir, "review-invocations.txt");
    const promptPath = join(dir, "review-prompt.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');",
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            `fs.writeFileSync(${JSON.stringify(promptPath)},input);`,
            "process.stdout.write(JSON.stringify({verdict:'pass',summary:'retry mutation reviewed against the original baseline',findings:[]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) { notices.push(message); },
      sendUserMessage(message: string, options: unknown) { followUps.push({ message, options }); },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });

    // The first low-level run ends with a retryable provider error and no
    // file changes. Pi has not settled yet: it will automatically retry the
    // same turn, so neither the reviewer nor the window may be finalized.
    await trigger(hooks, "agent_end", {
      cwd: dir,
      messages: [{ role: "assistant", content: "", stopReason: "error", errorMessage: "overloaded" }],
    });
    await assert.rejects(access(invocationPath), /ENOENT/);

    // The retry makes the actual edit. Retries do not re-fire
    // before_agent_start, and no review may run between this agent_end and
    // agent_settled either — the workspace is still mutable until then.
    await writeFile(join(dir, "index.ts"), "after retry\n", "utf8");
    await trigger(hooks, "agent_end", {
      cwd: dir,
      messages: [{ role: "assistant", content: "applied the change after the provider recovered" }],
    });
    await assert.rejects(access(invocationPath), /ENOENT/);

    // Settlement is the boundary where the automatic reviewer may run, and it
    // must still see the diff against the pre-error baseline.
    await trigger(hooks, "agent_settled", { cwd: dir });

    assert.equal(await readFile(invocationPath, "utf8"), "1");
    const reviewerPrompt = await readFile(promptPath, "utf8");
    assert.match(reviewerPrompt, /User request context:/);
    assert.match(reviewerPrompt, /change index/);
    assert.match(reviewerPrompt, /-before/);
    assert.match(reviewerPrompt, /\+after retry/);
    assert.match(notices.join("\n"), /review gate: passed/);
    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /Gate verdict: pass/);
    assert.match(followUps[0]?.message ?? "", /retry mutation reviewed against the original baseline/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createUncertainTransmissionHarness(input: {
  dir: string;
  sessionFile: string;
  diagnostic?: string;
  beforeThrow?: () => void | Promise<void>;
}): Promise<{
  mkRuntime: (sessionId: string) => {
    hooks: Map<string, Array<(...args: unknown[]) => unknown>>;
    notices: string[];
    followUps: Array<{ message: string; options: unknown }>;
    pi: unknown;
    ctx: unknown;
  };
}> {
  await writeFile(join(input.dir, "index.ts"), "before\n", "utf8");
  const configPath = join(input.dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    ...indexTestConfig,
    decider: {
      id: "fake",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'reviewed',findings:[]})))",
      ],
      timeoutMs: 15000,
    },
  }), "utf8");
  process.env.PI_REVIEW_GATE_CONFIG = configPath;
  delete process.env.PI_REVIEW_GATE_DISABLED;

  const mkRuntime = (sessionId: string) => {
    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand() {},
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
        if (input.diagnostic === undefined) return;
        return Promise.resolve(input.beforeThrow?.()).then(() => {
          throw new Error(input.diagnostic);
        });
      },
    };
    // The in-session notice channel lives on the hook context, not on the raw
    // extension object: notices are collected only through ctx.ui.notify so
    // the tests prove uncertain-delivery notices reach the user-visible
    // channel that agent_settled actually targets.
    const ctx = {
      cwd: input.dir,
      ui: {
        notify(message: string) { notices.push(message); },
      },
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => input.sessionFile,
        getCwd: () => input.dir,
      },
    };
    return { hooks, notices, followUps, pi, ctx };
  };

  return { mkRuntime };
}

test("a throwing automatic transmission is durably uncertain and surfaced once in-session without rejecting agent_settled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-uncertain-transmission-"));
  const sessionFile = join(dir, "uncertain-conversation.jsonl");
  await writeFile(sessionFile, "", "utf8");

  try {
    const { mkRuntime } = await createUncertainTransmissionHarness({
      dir,
      sessionFile,
      diagnostic: "transport unavailable: the follow-up channel rejected the review transmission",
    });

    // First session: the automatic review passes and the follow-up transport
    // throws. The delivery must be durably uncertain and surfaced exactly
    // once in-session, and agent_settled must resolve rather than reject.
    const first = mkRuntime("uncertain-conversation");
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dir, text: "change index", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(first.hooks, "agent_end", { cwd: dir }, first.ctx);
    await trigger(first.hooks, "agent_settled", { cwd: dir }, first.ctx);

    assert.equal(first.followUps.length, 1, "the transport was attempted exactly once");
    const uncertainNotices = first.notices.filter((notice) => notice.includes("is uncertain"));
    assert.equal(uncertainNotices.length, 1, "exactly one in-session uncertain notice");
    assert.match(uncertainNotices[0] ?? "", /delivery [0-9a-f]{64} is uncertain/);
    assert.match(uncertainNotices[0] ?? "", /transport unavailable/);
    assert.match(uncertainNotices[0] ?? "", /inspect .*\/reviews\/0001/);
    assert.doesNotMatch(uncertainNotices[0] ?? "", /was not delivered/);

    // The delivery is durably uncertain in the persisted state.
    const persisted = JSON.parse(await readFile(`${sessionFile}.pi-review-gate-state.json`, "utf8")) as {
      state: { pendingModelDeliveries: Array<{ kind: string; status: string; diagnostic?: string; invocationDir?: string }> };
    };
    const delivery = persisted.state.pendingModelDeliveries.find((entry) => entry.kind === "review_transmission");
    assert.ok(delivery, "the review transmission has a durable delivery record");
    assert.equal(delivery.status, "uncertain");
    assert.match(delivery.diagnostic ?? "", /transport unavailable/);

    // Restart recovery must not re-dispatch the uncertain delivery and must
    // not duplicate the in-session notice: the recovery notice is the
    // existing manual-inspection protocol, without the transport diagnostic.
    const resumed = mkRuntime("uncertain-conversation");
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);
    assert.equal(resumed.followUps.length, 0, "restart must not re-dispatch an uncertain delivery");
    const resumedUncertain = resumed.notices.filter((notice) => notice.includes("is uncertain"));
    assert.equal(resumedUncertain.length, 1, "recovery emits the existing manual-inspection notice once");
    assert.match(resumedUncertain[0] ?? "", /was not duplicated automatically/);
    assert.doesNotMatch(resumedUncertain[0] ?? "", /transport unavailable/, "the in-session diagnostic notice is not duplicated on restart");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uncertain transmission notices bound long transport diagnostics with visible truncation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-uncertain-truncation-"));
  const sessionFile = join(dir, "truncation-conversation.jsonl");
  await writeFile(sessionFile, "", "utf8");

  try {
    const longDiagnostic = `provider transport rejected the follow-up with a verbose internal trace: ${'x'.repeat(400)}`;
    const { mkRuntime } = await createUncertainTransmissionHarness({ dir, sessionFile, diagnostic: longDiagnostic });

    const runtime = mkRuntime("truncation-conversation");
    await activate(runtime.pi);
    await trigger(runtime.hooks, "session_start", { type: "session_start", reason: "startup" }, runtime.ctx);
    await trigger(runtime.hooks, "input", { cwd: dir, text: "change index", source: "user" }, runtime.ctx);
    await trigger(runtime.hooks, "before_agent_start", { cwd: dir }, runtime.ctx);
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(runtime.hooks, "agent_end", { cwd: dir }, runtime.ctx);
    await trigger(runtime.hooks, "agent_settled", { cwd: dir }, runtime.ctx);

    const uncertainNotices = runtime.notices.filter((notice) => notice.includes("is uncertain"));
    assert.equal(uncertainNotices.length, 1);
    const notice = uncertainNotices[0] ?? "";
    const marker = "… (truncated)";
    const bounded = longDiagnostic.replace(/\s+/g, " ").trim().slice(0, 200 - marker.length);
    assert.ok(notice.includes(`${bounded}${marker}`), "the notice carries the bounded diagnostic including its marker");
    assert.match(notice, /… \(truncated\)/);
    assert.ok(notice.length < longDiagnostic.length, "the notice is bounded below the raw diagnostic length");
    assert.doesNotMatch(notice, /x{400}/, "the diagnostic tail is not echoed into the notice");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing uncertain-state persist rejects agent_settled without emitting the uncertainty notice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-uncertain-persist-"));
  const sessionFile = join(dir, "uncertain-persist-conversation.jsonl");
  await writeFile(sessionFile, "", "utf8");
  const statePath = `${sessionFile}.pi-review-gate-state.json`;

  try {
    // The transport throws AND the persist of the uncertain transition itself
    // fails: the follow-up channel first makes the state directory read-only
    // so the uncertain-state save cannot become durable. The exception must
    // keep propagating (agent_settled rejects) and no uncertainty notice may
    // be emitted, because no durable uncertain transition was established.
    const { mkRuntime } = await createUncertainTransmissionHarness({
      dir,
      sessionFile,
      diagnostic: "transport unavailable: the follow-up channel rejected the review transmission",
      beforeThrow: async () => {
        await chmod(dir, 0o555);
      },
    });

    const runtime = mkRuntime("uncertain-persist-conversation");
    await activate(runtime.pi);
    await trigger(runtime.hooks, "session_start", { type: "session_start", reason: "startup" }, runtime.ctx);
    await trigger(runtime.hooks, "input", { cwd: dir, text: "change index", source: "user" }, runtime.ctx);
    await trigger(runtime.hooks, "before_agent_start", { cwd: dir }, runtime.ctx);
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(runtime.hooks, "agent_end", { cwd: dir }, runtime.ctx);
    await assert.rejects(
      trigger(runtime.hooks, "agent_settled", { cwd: dir }, runtime.ctx),
      /EACCES|permission denied/,
      "agent_settled must reject when the uncertain transition never became durable",
    );

    assert.equal(
      runtime.notices.filter((notice) => notice.includes("is uncertain")).length,
      0,
      "no in-session uncertainty notice without a durable uncertain transition",
    );

    // The durable record never reached uncertain: the last successful save
    // happened while the dispatch was still in flight.
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      state: { pendingModelDeliveries: Array<{ kind: string; status: string }> };
    };
    const record = persisted.state.pendingModelDeliveries.find((entry) => entry.kind === "review_transmission");
    assert.ok(record, "the queued review transmission has a durable delivery record");
    assert.equal(record.status, "dispatching");
  } finally {
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown before uncertain-state persistence does not masquerade as a durable uncertainty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-uncertain-shutdown-"));
  const sessionFile = join(dir, "uncertain-shutdown-conversation.jsonl");
  await writeFile(sessionFile, "", "utf8");
  let shutdownMidDispatch: (() => Promise<void>) | undefined;

  try {
    // The session shuts down while the follow-up dispatch is in flight: the
    // shutdown hook force-persists the record as `dispatching`, and every
    // persistence after that is a silent no-op. The transport then throws and
    // the uncertain transition never becomes durable, so the exception must
    // propagate (agent_settled rejects) with no uncertainty notice.
    const { mkRuntime } = await createUncertainTransmissionHarness({
      dir,
      sessionFile,
      diagnostic: "transport unavailable during shutdown",
      beforeThrow: () => shutdownMidDispatch?.(),
    });

    const runtime = mkRuntime("uncertain-shutdown-conversation");
    shutdownMidDispatch = () => trigger(
      runtime.hooks,
      "session_shutdown",
      { type: "session_shutdown", reason: "quit" },
      runtime.ctx,
    );

    await activate(runtime.pi);
    await trigger(runtime.hooks, "session_start", { type: "session_start", reason: "startup" }, runtime.ctx);
    await trigger(runtime.hooks, "input", { cwd: dir, text: "change index", source: "user" }, runtime.ctx);
    await trigger(runtime.hooks, "before_agent_start", { cwd: dir }, runtime.ctx);
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(runtime.hooks, "agent_end", { cwd: dir }, runtime.ctx);

    await assert.rejects(
      trigger(runtime.hooks, "agent_settled", { cwd: dir }, runtime.ctx),
      /transport unavailable during shutdown/,
      "agent_settled must reject when the uncertain transition was never durably saved",
    );
    assert.equal(
      runtime.notices.filter((notice) => notice.includes("is uncertain")).length,
      0,
      "no in-session uncertainty notice without a durable uncertain transition",
    );

    // The durable record was last saved by the forced shutdown persist while
    // the dispatch was still in flight: `dispatching`, never `uncertain`.
    const persisted = JSON.parse(await readFile(`${sessionFile}.pi-review-gate-state.json`, "utf8")) as {
      state: { pendingModelDeliveries: Array<{ kind: string; status: string }> };
    };
    assert.equal(
      persisted.state.pendingModelDeliveries.find((entry) => entry.kind === "review_transmission")?.status,
      "dispatching",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a pre-existing uncertain delivery record cannot duplicate the in-session notice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-uncertain-dedupe-"));
  const sessionFile = join(dir, "dedupe-conversation.jsonl");
  await writeFile(sessionFile, "", "utf8");

  try {
    // Runtime A completes a full pass cycle with a working follow-up channel.
    const working = await createUncertainTransmissionHarness({ dir, sessionFile });
    const first = working.mkRuntime("dedupe-conversation");
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dir, text: "change index", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(first.hooks, "agent_end", { cwd: dir }, first.ctx);
    await trigger(first.hooks, "agent_settled", { cwd: dir }, first.ctx);
    assert.equal(first.followUps.length, 1);

    // Durable state now holds a delivered review_transmission record and the
    // still-open review window. Rewrite the record to a pre-existing
    // uncertain state (without its delivery receipt, as if the prior dispatch
    // had been left uncertain) and rewind the review sequence so the next
    // automatic transmission is a deduplicated rediscovery of that record.
    const store = new SessionStateStore({ sessionId: "dedupe-conversation", sessionFile, cwd: dir });
    const restored = await store.restore(dir);
    assert.ok(restored, "persisted conversation state restores");
    const record = restored.state.pendingModelDeliveries.find((entry) => entry.kind === "review_transmission");
    assert.ok(record, "runtime A persisted the review transmission delivery record");
    assert.equal(record.status, "delivered");
    const invocationDir = record.invocationDir;
    assert.ok(invocationDir);
    const window = restored.state.reviewWindow;
    assert.ok(window, "runtime A persisted an open review window");
    assert.equal(window.bundleDir, dirname(dirname(invocationDir)));
    await rm(join(invocationDir, "delivery.json"), { force: true });
    record.status = "uncertain";
    record.diagnostic = "The prior dispatch was left uncertain.";
    window.nextReviewSequence = 1;
    await store.save(restored.state, restored.execution);

    // Runtime B: recovery surfaces the pre-existing uncertainty once via the
    // manual-inspection protocol. A second review whose transmission
    // deduplicates against the uncertain record must not emit a second
    // in-session uncertainty notice and must not re-send the follow-up.
    const second = working.mkRuntime("dedupe-conversation");
    await activate(second.pi);
    await trigger(second.hooks, "session_start", { type: "session_start", reason: "resume" }, second.ctx);
    assert.equal(second.followUps.length, 0, "recovery does not re-dispatch an uncertain delivery");
    await trigger(second.hooks, "input", { cwd: dir, text: "change index again", source: "user" }, second.ctx);
    await trigger(second.hooks, "before_agent_start", { cwd: dir }, second.ctx);
    await writeFile(join(dir, "index.ts"), "after again\n", "utf8");
    await trigger(second.hooks, "agent_end", { cwd: dir }, second.ctx);
    await assert.rejects(
      trigger(second.hooks, "agent_settled", { cwd: dir }, second.ctx),
      /uncertain prior dispatch/,
      "a pre-existing uncertain record is not masked as fresh transport uncertainty",
    );

    assert.equal(second.followUps.length, 0, "no duplicate transmission was sent");
    const uncertainNotices = second.notices.filter((notice) => notice.includes("is uncertain"));
    assert.equal(uncertainNotices.length, 1, "exactly one in-session uncertainty notice: the recovery notice");
    assert.match(uncertainNotices[0] ?? "", /was not duplicated automatically/);
    assert.doesNotMatch(second.notices.join("\n"), /was not retried automatically/, "no second uncertainty notice for the pre-existing uncertain record");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function extractBundleDir(message: string, reviewSequence: number): string {
  const suffix = `/reviews/${String(reviewSequence).padStart(4, "0")}`;
  const line = message.split("\n").find((entry) => entry.startsWith("Complete immutable pass evidence: "));
  assert.ok(line, "transmission includes the immutable pass path");
  const passDir = line.slice("Complete immutable pass evidence: ".length);
  assert.ok(passDir.endsWith(suffix));
  return passDir.slice(0, -suffix.length);
}

async function trigger(hooks: Map<string, Array<(...args: unknown[]) => unknown>>, name: string, ...args: unknown[]): Promise<void> {
  for (const handler of hooks.get(name) ?? []) {
    await handler(...args);
  }
}

/** Escape a literal string for use inside a RegExp constructor. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a minimal Pi host + session context for session_start integration
 * tests, mirroring the runtime helper used by the conversation-restore test.
 */
function createSessionRuntime(sessionId: string, file: string, cwd: string) {
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const notices: string[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const sent: Array<{ message: string; options: unknown }> = [];
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand() {},
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    notify(message: string) { notices.push(message); },
    sendUserMessage(message: string, options: unknown) { sent.push({ message, options }); },
  };
  const ctx = {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => file,
      getCwd: () => cwd,
    },
  };
  return { hooks, notices, entries, sent, pi, ctx };
}

/** Fire the hook pair Pi emits when a turn has no further automatic work:
 *  agent_end (one per low-level run) followed by agent_settled (once, after
 *  retries, compaction retries, and queued continuations have drained). */
async function triggerAgentEnd(hooks: Map<string, Array<(...args: unknown[]) => unknown>>, ...args: unknown[]): Promise<void> {
  await trigger(hooks, "agent_end", ...args);
  await trigger(hooks, "agent_settled", ...args);
}

async function triggerResults(hooks: Map<string, Array<(...args: unknown[]) => unknown>>, name: string, ...args: unknown[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of hooks.get(name) ?? []) {
    results.push(await handler(...args));
  }
  return results.filter((result) => result !== undefined);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await access(path);
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), "condition became true before timeout");
}
