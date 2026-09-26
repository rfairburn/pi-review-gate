// Extension entrypoint readiness suites: automatic review waits for active
// background work (external ShellStart process groups, native shell wake
// ordering, delegated execution subtasks) before settling a turn.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activate } from "../src/index";
import { reapAll } from "../src/background-shell";
import {
  executionToolNames,
  indexTestConfig,
  invokeNativeToolCall,
  trigger,
  triggerAgentEnd,
  waitForCondition,
  waitForFile,
} from "./entrypoint-harness";

test("automatic review waits for ShellStart process groups and resumes the orchestrator when they clear", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-background-readiness-"));
  let background: ChildProcess | undefined;
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationMarker = join(dir, "reviewer-invoked.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(invocationMarker)},'invoked');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'background work reviewed',findings:[]})))`,
    ],
      timeoutMs: 15000,
    }
    }
    },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
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
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(invocationMarker)},'invoked');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'background work reviewed',findings:[]})))`,
    ],
      timeoutMs: 15000,
    }
    }
    },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const tools = new Map<string, { name: string; execute: (...args: any[]) => Promise<Record<string, unknown>> }>();
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
    await invokeNativeToolCall(hooks, { name: "ShellStart", execute: shellStart.execute }, "native-shell-start", { command: "sleep 0.25", label: "native-tests" }, { hasUI: false });
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

test("entrypoint wiring preserves raw ShellStart identity through null normalization and an active repeat", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-native-raw-shell-identity-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify(indexTestConfig), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const tools = new Map<string, { name: string; execute: (...args: any[]) => Promise<Record<string, unknown>> }>();
    let toolResultEvents = 0;
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerTool(tool: { name: string; execute: (...args: any[]) => Promise<Record<string, unknown>> }) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      notify() {},
      sendMessage() {},
      sendUserMessage() {},
    };

    await activate(pi);
    hooks.set("tool_result", [...(hooks.get("tool_result") ?? []), () => { toolResultEvents += 1; }]);
    const shellStart = tools.get("ShellStart");
    const shellList = tools.get("ShellList");
    assert.ok(shellStart);
    assert.ok(shellList);
    const context = { hasUI: false };
    const submitted = { command: "sleep 30", label: null };
    const validated = { command: "sleep 30" };
    try {
      const first = await invokeNativeToolCall(
        hooks,
        shellStart,
        "nullable-shell-first",
        submitted,
        context,
        validated,
      );
      assert.equal(first.isError, false);

      const repeated = await invokeNativeToolCall(
        hooks,
        shellStart,
        "nullable-shell-repeat",
        submitted,
        context,
        validated,
      );
      assert.equal(repeated.isError, true);
      assert.match(String((repeated.content as Array<{ text?: unknown }>)[0]?.text), /still active \(job\d+\)/);
      assert.equal(toolResultEvents, 1, "the preflight-blocked repeat emits no extension tool_result");

      const listed = await shellList.execute("shell-list", {}, undefined, undefined, context);
      const jobs = (listed.details as { jobs?: Array<{ status?: string }> }).jobs;
      assert.equal(jobs?.length, 1);
      assert.equal(jobs?.[0]?.status, "running");
    } finally {
      reapAll();
    }
  } finally {
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
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
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
        timeoutMs: 15000,
      }
      }
      },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const tools = new Map<string, { name: string; execute: (...args: any[]) => Promise<Record<string, unknown>> }>();
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
    await invokeNativeToolCall(hooks, { name: "ShellStart", execute: shellStart.execute }, "clean-exit-order", { command: "exit 0", label: "clean-exit-order" }, { hasUI: false });

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
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(invocationMarker)},'invoked')`],
      timeoutMs: 15000,
    }
    }
    },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const tools = new Map<string, { name: string; execute: (...args: any[]) => Promise<Record<string, unknown>> }>();
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
    await invokeNativeToolCall(hooks, { name: "ShellStart", execute: shellStart.execute }, "first-run", {
      command: "sleep 0.2",
      label: "first-run",
      wake_on: { exit: false },
    }, { hasUI: false });
    await triggerAgentEnd(hooks, { cwd: dir, messages: [{ role: "assistant", content: "first run active" }] });

    await waitForCondition(() => messages.filter((message) => message.customType === "pi-review-background-ready").length === 1);
    const firstWake = String(messages.find((message) => message.customType === "pi-review-background-ready")?.content ?? "");
    assert.match(firstWake, /idle transition/);
    assert.match(firstWake, /newer job may have started/);

    // The completion wake begins a new turn, which immediately replaces the
    // finished job. The old wake must not authorize review of this newer state.
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await invokeNativeToolCall(hooks, { name: "ShellStart", execute: shellStart.execute }, "replacement-run", {
      command: "sleep 0.35",
      label: "replacement-run",
      wake_on: { exit: false },
    }, { hasUI: false });
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
externalAgents: {
  "slow-executor": {
    adapter: "run-as-binary",
    command: process.execPath,
    execution: {
      protocol: "pi-review-executor-jsonl-v1",
      args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{},30000))"],
    }
  },
  "reviewer": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(invocationMarker)},'invoked');process.stdout.write(JSON.stringify({verdict:'pass',summary:'reviewed',findings:[]}))`,
    ],
      timeoutMs: 15000,
    }
    }
    },
execution: {
        workerResources: { "default": { selection: { source: "external", id: "slow-executor" }, maxConcurrent: 1 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
      },
review: { activeReviewers: [
        { source: "external", id: "reviewer" }
      ] },
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
    await invokeNativeToolCall(hooks, {
      name: "SubtasksStart",
      execute: executionTool.execute,
    }, "start-slow-task", {
      tasks: [{
        title: "slow delegated work",
        instructions: "Remain active while the readiness gate is tested.",
        acceptanceCriteria: ["The delegated task finishes."],
      }],
    }, { cwd: dir });

    await triggerAgentEnd(hooks, { cwd: dir, messages: [{ role: "assistant", content: "subtask still active" }] });

    await assert.rejects(access(invocationMarker), /ENOENT/);
    assert.match(notices.join("\n"), /automatic review deferred while 1 background subtask\(s\) remain active/);
    assert.match(notices.join("\n"), /slow delegated work \[(queued|capturing|running)\]/);
    await trigger(hooks, "session_shutdown", { cwd: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
