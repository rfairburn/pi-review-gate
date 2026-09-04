import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { activate } from "../src/index";
import { normalizeConfig } from "../src/config";
import { ExecutionToolManager } from "../src/execution/tool";
import {
  EXECUTOR_TOOL_CATALOG_ENV,
  createPiWorkerToolCatalog,
  type ExecutorToolCatalog,
} from "../src/execution/tool-catalog";
import { createState } from "../src/state";

const executionToolNames = [
  "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue",
  "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean",
];
const backgroundShellToolNames = ["ShellStart", "ShellList", "ShellLog", "ShellSend", "ShellStop"];
const webToolNames = [
  "WebSearch", "WebFetch", "BrowserExtract",
  "BrowserOpen", "BrowserNavigate", "BrowserSnapshot", "BrowserConsole", "BrowserNetwork", "BrowserInspect", "BrowserScreenshot",
  "BrowserScroll", "BrowserHover", "BrowserClick", "BrowserFill", "BrowserType", "BrowserSelect", "BrowserPress",
  "BrowserWait", "BrowserHistory", "BrowserTabs", "BrowserClose",
];

let previousConfig: string | undefined;
let previousDisabled: string | undefined;
let previousRole: string | undefined;
let previousToolCatalog: string | undefined;

beforeEach(() => {
  previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
  previousRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  previousToolCatalog = process.env[EXECUTOR_TOOL_CATALOG_ENV];
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.PI_REVIEW_GATE_CONFIG;
  else process.env.PI_REVIEW_GATE_CONFIG = previousConfig;
  if (previousDisabled === undefined) delete process.env.PI_REVIEW_GATE_DISABLED;
  else process.env.PI_REVIEW_GATE_DISABLED = previousDisabled;
  if (previousRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRole;
  if (previousToolCatalog === undefined) delete process.env[EXECUTOR_TOOL_CATALOG_ENV];
  else process.env[EXECUTOR_TOOL_CATALOG_ENV] = previousToolCatalog;
});

interface ActivationCapture {
  hooks: Map<string, unknown[]>;
  tools: Set<string>;
  commands: string[];
  notices: string[];
}

function captureHost(): { pi: Record<string, unknown>; captured: ActivationCapture } {
  const captured: ActivationCapture = {
    hooks: new Map(),
    tools: new Set(),
    commands: [],
    notices: [],
  };
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      captured.hooks.set(name, [...(captured.hooks.get(name) ?? []), handler]);
    },
    registerTool(tool: { name: string }) {
      captured.tools.add(tool.name);
    },
    registerCommand(name: string) {
      captured.commands.push(name);
    },
    notify(message: string) {
      captured.notices.push(message);
    },
  };
  return { pi, captured };
}

async function writeConfig(dir: string): Promise<string> {
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({ enabled: true }), "utf8");
  return configPath;
}

test("executor role registers web tools and background shell without orchestration or review machinery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-executor-role-"));
  try {
    process.env.PI_REVIEW_GATE_CONFIG = await writeConfig(dir);
    delete process.env.PI_REVIEW_GATE_DISABLED;
    process.env.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";

    const { pi, captured } = captureHost();
    await activate(pi);

    for (const tool of webToolNames) {
      assert.ok(captured.tools.has(tool), `expected executor child to register ${tool}`);
    }
    for (const tool of backgroundShellToolNames) {
      assert.ok(captured.tools.has(tool), `expected executor child to register ${tool}`);
    }
    for (const tool of executionToolNames) {
      assert.equal(captured.tools.has(tool), false, `executor child must not register ${tool}`);
    }
    // Only the background shell's own lifecycle hooks may be present (its
    // session hooks plus agent_start/agent_settled, which gate nonurgent wake
    // coalescing); the review machinery (agent_end, before_agent_start,
    // input, tool_call, tool_result) and command surface must stay out of
    // executor children.
    assert.deepEqual([...captured.hooks.keys()].sort(), [
      "agent_settled",
      "agent_start",
      "session_shutdown",
      "session_start",
    ]);
    assert.deepEqual(captured.commands, [], "executor child must not register review commands");
    assert.ok(!captured.notices.some((notice) => notice.includes("disabled")), "executor child must not report the gate disabled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor role defers to the durable initial subset and activates authorized matches on the next turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-executor-deferred-"));
  try {
    process.env.PI_REVIEW_GATE_CONFIG = await writeConfig(dir);
    delete process.env.PI_REVIEW_GATE_DISABLED;
    process.env.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";
    const parentStyleCatalog = await catalogProducedByExecutionToolManager();
    assert.ok(parentStyleCatalog.allowedToolCatalog.includes("SubtasksStart"));
    process.env[EXECUTOR_TOOL_CATALOG_ENV] = JSON.stringify(createPiWorkerToolCatalog(parentStyleCatalog));

    type Tool = {
      name: string;
      description?: string;
      execute?: (id: string, params: unknown) => Promise<Record<string, unknown>>;
    };
    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const definitions = new Map<string, Tool>([
      ["read", { name: "read", description: "Read files." }],
      ["edit", { name: "edit", description: "Edit files." }],
    ]);
    let active = ["read", "edit"];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerTool(tool: Tool) {
        definitions.set(tool.name, tool);
        active.push(tool.name);
      },
      getActiveTools: () => [...active],
      getAllTools: () => [...definitions.values()],
      setActiveTools(names: string[]) { active = [...names]; },
      notify() {},
    };

    await activate(pi);
    const ctx = { cwd: dir, ui: {}, sessionManager: {} };
    for (const hook of hooks.get("session_start") ?? []) await hook({ cwd: dir }, ctx);
    assert.equal(process.env[EXECUTOR_TOOL_CATALOG_ENV], undefined, "bootstrap catalog is removed before worker tools run");
    assert.deepEqual(active, ["read", "edit", "search_tools"]);

    const before = await Promise.all((hooks.get("before_agent_start") ?? []).map((hook) =>
      hook({ cwd: dir, systemPrompt: "native Pi prompt" }, ctx)
    ));
    const guidance = before.map((value) =>
      (value as { systemPrompt?: string } | undefined)?.systemPrompt ?? ""
    ).join("\n");
    assert.match(guidance, /native Pi prompt/);
    for (const name of ["read", "edit", ...webToolNames, "ShellList", "search_tools"]) {
      assert.match(guidance, new RegExp(`"${name}"`));
    }
    assert.doesNotMatch(guidance, /SubtasksStart|SubtasksInspect/);
    assert.match(guidance, /exact name/i);
    assert.match(guidance, /next turn/i);
    assert.doesNotMatch(guidance, /Read files|Edit files|Search the public web|parameters|properties/);

    const search = definitions.get("search_tools");
    assert.ok(search?.execute);
    const loaded = await search.execute("load-web", { query: "WebSearch" });
    assert.deepEqual((loaded.details as { activated: string[] }).activated, ["WebSearch"]);
    assert.deepEqual(active, ["read", "edit", "search_tools", "WebSearch"]);

    for (const hook of hooks.get("tool_result") ?? []) await hook({ toolName: "search_tools" }, ctx);
    for (const hook of hooks.get("before_agent_start") ?? []) await hook({ cwd: dir }, ctx);
    assert.deepEqual(active, ["read", "edit", "search_tools", "WebSearch"], "activation remains additive on the next model turn");

    const unmatched = await search.execute("load-unmatched", { query: "nonexistent-capability-token" });
    assert.deepEqual((unmatched.details as { activated: string[] }).activated, []);
    assert.equal(active.includes("ShellLog"), false);

    const screenshot = await search.execute("load-screenshot", { query: "BrowserScreenshot" });
    assert.deepEqual((screenshot.details as { activated: string[] }).activated, ["BrowserScreenshot"]);
    assert.ok(active.includes("BrowserScreenshot"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function catalogProducedByExecutionToolManager(): Promise<ExecutorToolCatalog> {
  const tools: Array<{ name: string; execute?: (...args: any[]) => Promise<Record<string, any>> }> = [];
  const activeNames = ["read", "edit", ...webToolNames, "ShellList", ...executionToolNames];
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: {
        protocol: "pi-review-executor-jsonl-v1",
        args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
      },
    }],
    execution: { activeExecutor: { source: "external", id: "fake" } },
  });
  const manager = new ExecutionToolManager({
    pi: {
      registerTool(tool: { name: string; execute?: (...args: any[]) => Promise<Record<string, any>> }) { tools.push(tool); },
      registerCommand() {},
      setToolActive() {},
      getActiveTools: () => activeNames,
    },
    config,
    state: createState(),
    cwd: () => process.cwd(),
  });
  manager.sync();
  try {
    const start = tools.find((tool) => tool.name === "SubtasksStart");
    assert.ok(start?.execute);
    const result = await start.execute("catalog-bootstrap", {
      tasks: [{ title: "Catalog", instructions: "Wait", acceptanceCriteria: ["Catalog captured"] }],
    }, undefined, undefined, {});
    return result.details.tasks[0].definition.executorToolCatalog as ExecutorToolCatalog;
  } finally {
    await manager.shutdown();
  }
}

test("PI_REVIEW_GATE_DISABLED still short-circuits activation before executor-role registration", async () => {
  // Documents the kill-switch behavior that previously broke Pi executor
  // children: when the disablement reaches the child, activate() returns
  // before the executor-role branch and no web tools are registered.
  const dir = await mkdtemp(join(tmpdir(), "pi-review-executor-disabled-"));
  try {
    process.env.PI_REVIEW_GATE_CONFIG = await writeConfig(dir);
    process.env.PI_REVIEW_GATE_DISABLED = "1";
    process.env.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";

    const { pi, captured } = captureHost();
    await activate(pi);

    assert.equal(captured.tools.size, 0, "disabled activation must not register any tools");
    assert.deepEqual([...captured.hooks.keys()], []);
    assert.match(captured.notices.join("\n"), /review gate: disabled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
