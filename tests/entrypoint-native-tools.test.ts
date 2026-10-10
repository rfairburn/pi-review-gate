import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { activate } from "../src/index";
import { resetPrimaryCodemodeDefaultForTests } from "../src/activation/primary-codemode-default";
import { RESEARCH_ALLOWED_TOOLS } from "../src/execution/tool";
import { EXECUTOR_TOOL_CATALOG_ENV, createExecutorToolCatalog } from "../src/execution/tool-catalog";
import {
  PI_SETTLEMENT_CHILD_ENV,
  PI_SETTLEMENT_PATH_ENV,
  PI_SETTLEMENT_SECRET_ENV,
  PI_SETTLEMENT_SESSION_ENV,
  createPiSettlementBootstrap,
  piSettlementEnvironment,
} from "../src/execution/pi-settlement-receipt";
import { reapAll } from "../src/background-shell";
import { getSessionHostSpawnCapability, SESSION_HOST_SPAWN_CAPABILITY_KEY, publishSessionHostSpawnCapability, revokeSessionHostSpawnCapability } from "../src/session-host/spawn-capability";
import {
  primeSessionHostStartupMetadata,
  SESSION_HOST_STARTUP_REQUEST_ENV,
  __test as startupRequestTest,
} from "../src/session-host/startup-request";

const CODEMODE_DEFAULT_ENV = "PI_REVIEW_GATE_CODEMODE_DEFAULT";

interface ToolDefinition {
  name: string;
  description?: string;
  exposure?: string;
  annotations?: Record<string, unknown>;
  execute?: (id: string, params: unknown) => Promise<Record<string, unknown>>;
  [key: string]: unknown;
}

class NativeToolRuntime {
  readonly hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  readonly definitions = new Map<string, ToolDefinition>();
  readonly sessionManager = {};
  readonly context: { cwd: string; ui: Record<string, never>; sessionManager: object };
  readonly pi: Record<string, unknown>;
  private active: string[];
  private initialized = false;

  constructor(cwd: string, nativeTools: ToolDefinition[], active: string[]) {
    for (const tool of nativeTools) this.definitions.set(tool.name, tool);
    this.active = [...active];
    this.context = { cwd, ui: {}, sessionManager: this.sessionManager };
    this.pi = {
      on: (name: string, handler: (...args: unknown[]) => unknown) => {
        this.hooks.set(name, [...(this.hooks.get(name) ?? []), handler]);
      },
      registerTool: (tool: ToolDefinition) => {
        this.definitions.set(tool.name, tool);
        // Pi's normal registration path activates the definition unless its
        // native --tools selection has already excluded it.
        if (!this.active.includes(tool.name)) this.active.push(tool.name);
      },
      registerCommand: () => {},
      getActiveTools: () => {
        this.assertInitialized();
        return [...this.active];
      },
      getAllTools: () => {
        this.assertInitialized();
        return [...this.definitions.values()];
      },
      setActiveTools: (names: string[]) => {
        this.assertInitialized();
        this.active = [...names];
      },
      notify: () => {},
    };
  }

  start(): void {
    this.initialized = true;
  }

  activeTools(): string[] {
    this.assertInitialized();
    return [...this.active];
  }

  setNativeActive(name: string, active: boolean): void {
    this.assertInitialized();
    this.active = active
      ? [...this.active, ...(this.active.includes(name) ? [] : [name])]
      : this.active.filter((candidate) => candidate !== name);
  }

  registerNative(tool: ToolDefinition): void {
    this.definitions.set(tool.name, tool);
    if (!this.active.includes(tool.name)) this.active.push(tool.name);
  }

  removeNative(name: string): void {
    this.definitions.delete(name);
  }

  async fire(name: string, ...args: unknown[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.hooks.get(name) ?? []) {
      const result = await handler(...args);
      if (result !== undefined) results.push(result);
    }
    return results;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("Extension runtime not initialized");
  }
}

const previousEnvironment = new Map<string, string | undefined>();
const environmentNames = [
  "PI_REVIEW_GATE_CONFIG",
  "PI_REVIEW_GATE_DISABLED",
  "PI_REVIEW_GATE_RUNTIME_ROLE",
  CODEMODE_DEFAULT_ENV,
  EXECUTOR_TOOL_CATALOG_ENV,
  PI_SETTLEMENT_SECRET_ENV,
  PI_SETTLEMENT_PATH_ENV,
  PI_SETTLEMENT_SESSION_ENV,
  PI_SETTLEMENT_CHILD_ENV,
  SESSION_HOST_STARTUP_REQUEST_ENV,
  "PI_CODING_AGENT_DIR",
];

beforeEach(() => {
  resetPrimaryCodemodeDefaultForTests();
  previousEnvironment.clear();
  for (const name of environmentNames) previousEnvironment.set(name, process.env[name]);
  delete process.env.PI_REVIEW_GATE_DISABLED;
  delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete process.env[CODEMODE_DEFAULT_ENV];
  delete process.env[EXECUTOR_TOOL_CATALOG_ENV];
  delete process.env[PI_SETTLEMENT_SECRET_ENV];
  delete process.env[PI_SETTLEMENT_PATH_ENV];
  delete process.env[PI_SETTLEMENT_SESSION_ENV];
  delete process.env[PI_SETTLEMENT_CHILD_ENV];
  delete process.env[SESSION_HOST_STARTUP_REQUEST_ENV];
  delete process.env.PI_CODING_AGENT_DIR;
  startupRequestTest.clearProcessMetadata();
  delete (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_SPAWN_CAPABILITY_KEY];
});

afterEach(() => {
  reapAll();
  resetPrimaryCodemodeDefaultForTests();
  delete (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_SPAWN_CAPABILITY_KEY];
  startupRequestTest.clearProcessMetadata();
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function writeConfig(cwd: string, config: Record<string, unknown> = {}): Promise<void> {
  const path = join(cwd, "review-gate.json");
  await writeFile(path, JSON.stringify({
    enabled: true,
    maxCorrectionCycles: 3,
    implementationGuidanceAfterCorrectionAttempts: 1,
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
    ...config,
  }), "utf8");
  process.env.PI_REVIEW_GATE_CONFIG = path;
}

async function startSession(runtime: NativeToolRuntime): Promise<void> {
  runtime.start();
  await runtime.fire("session_start", { cwd: runtime.context.cwd }, runtime.context);
}

async function submitModelCall(
  runtime: NativeToolRuntime,
  name: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  await runtime.fire("message_end", {
    message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: input }] },
  }, runtime.context);
  await runtime.fire("tool_execution_start", { toolCallId: id, toolName: name, args: input }, runtime.context);
  return blockResult(await runtime.fire("tool_call", { toolCallId: id, toolName: name, input }, runtime.context));
}

async function submitNestedCall(
  runtime: NativeToolRuntime,
  parentToolCallId: string,
  name: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  await runtime.fire("tool_execution_start", {
    toolCallId: id,
    toolName: name,
    args: input,
    parentToolCallId,
  }, runtime.context);
  return blockResult(await runtime.fire("tool_call", {
    toolCallId: id,
    toolName: name,
    input,
    parentToolCallId,
  }, runtime.context));
}

function blockResult(results: unknown[]): { block?: boolean; reason?: string } | undefined {
  const result = results.find((candidate) => typeof candidate === "object" && candidate !== null && "block" in candidate);
  return result as { block?: boolean; reason?: string } | undefined;
}

function searchTool(runtime: NativeToolRuntime): NonNullable<ToolDefinition["execute"]> {
  const execute = runtime.definitions.get("tool_search")?.execute;
  assert.ok(execute, "tool_search must really be registered");
  return execute;
}

function loadFreshActivate(): typeof activate {
  // Pi re-instantiates extension factories after native session replacement.
  // Clear both modules while leaving globalThis intact, as a real Pi process
  // does when it reloads extension code.
  delete require.cache[require.resolve("../src/index")];
  delete require.cache[require.resolve("../src/activation/primary-codemode-default")];
  return (require("../src/index") as { activate: typeof activate }).activate;
}

function nativeDefinitions(options: { codemode?: boolean; mcp?: boolean } = {}): ToolDefinition[] {
  return [
    { name: "read", description: "Read files." },
    { name: "WebSearch", description: "Search the web." },
    ...(options.codemode === false ? [] : [{
      name: "codemode",
      description: "Run code that calls tools.",
      exposure: "codemode",
    }]),
    { name: "NativeDeferred", description: "Native deferred callee.", exposure: "deferred" },
    { name: "ModelOnly", description: "A model-only tool.", exposure: "model-only" },
    ...(options.mcp === false ? [] : [{
      name: "mcp__docs__lookup",
      description: "Search remote documentation.",
      exposure: "codemode",
      annotations: { readOnlyHint: true },
    }]),
  ];
}

test("wrapper codemode intent is consumed synchronously and composes primary direct/nested authorization", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-native-tools-wrapper-"));
  try {
    // This warning suspends activate() at its first await, allowing the
    // one-shot marker's synchronous consumption to be observed by the caller.
    await writeConfig(cwd, {
      decider: { id: "unsupported", adapter: "unsupported", command: process.execPath },
    });
    const runtime = new NativeToolRuntime(cwd, nativeDefinitions(), ["read", "ModelOnly"]);
    process.env[CODEMODE_DEFAULT_ENV] = "1";
    const activation = activate(runtime.pi);
    assert.equal(process.env[CODEMODE_DEFAULT_ENV], undefined, "wrapper intent is erased before activate reaches its first await");
    await activation;
    await startSession(runtime);

    assert.ok(runtime.definitions.has("tool_search"), "the authorized loader was registered");
    assert.ok(runtime.definitions.get("tool_search")?.description?.includes("codemode"),
      "wrapper default makes an inactive registered codemode searchable");
    assert.equal(runtime.activeTools().includes("codemode"), false, "wrapper default does not promote codemode into the direct active set");
    assert.equal(runtime.activeTools().includes("NativeDeferred"), false);

    const codemodeSearch = await searchTool(runtime)("search-code", { query: "codemode" });
    assert.deepEqual((codemodeSearch.details as { activated: string[] }).activated, ["codemode"]);
    assert.equal(runtime.activeTools().includes("codemode"), true, "the loader declares the authorized codemode exposure");

    // Model-only tools may be loaded for model use, but are never script
    // callees. Deferred native exposure remains nested-callable while inactive.
    const modelOnlySearch = await searchTool(runtime)("load-model-only", { query: "ModelOnly" });
    assert.deepEqual((modelOnlySearch.details as { activated: string[] }).activated, ["ModelOnly"]);
    const parent = await submitModelCall(runtime, "codemode", "active-code", { code: "await tools.NativeDeferred({}); await tools.ModelOnly({})" });
    assert.equal(parent?.block, undefined, "the loader-declared codemode call is allowed");
    const deferredChild = await submitNestedCall(runtime, "active-code", "NativeDeferred", "active-code/1", {});
    assert.equal(deferredChild?.block, undefined, "registered deferred callees may run nested while inactive");
    assert.equal(runtime.activeTools().includes("NativeDeferred"), false, "nested native reachability never promotes a direct declaration");
    const modelOnlyChild = await submitNestedCall(runtime, "active-code", "ModelOnly", "active-code/2", {});
    assert.equal(modelOnlyChild?.block, true, "model-only exposure is never nested-callable");

    // A nested call without an authorized parent is blocked.
    const orphan = await submitNestedCall(runtime, "never-authorized", "NativeDeferred", "orphan/1", {});
    assert.equal(orphan?.block, true, "an orphaned nested call cannot authorize itself");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("primary wrapper codemode intent survives module reload and a replaced session identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-native-tools-replacement-"));
  const nextCwd = join(cwd, "replacement");
  try {
    await mkdir(nextCwd);
    await writeConfig(cwd);
    await writeConfig(nextCwd);
    const initial = new NativeToolRuntime(cwd, nativeDefinitions(), ["read"]);
    process.env[CODEMODE_DEFAULT_ENV] = "1";
    await activate(initial.pi);
    assert.equal(process.env[CODEMODE_DEFAULT_ENV], undefined);
    await startSession(initial);
    assert.ok(initial.definitions.get("tool_search")?.description?.includes("codemode"));
    assert.equal(initial.activeTools().includes("codemode"), false);

    await initial.fire("session_shutdown", initial.context);
    const replacement = new NativeToolRuntime(nextCwd, nativeDefinitions(), ["read"]);
    const reloadedActivate = loadFreshActivate();
    assert.equal(process.env[CODEMODE_DEFAULT_ENV], undefined, "the replacement inherits no environment marker");
    await reloadedActivate(replacement.pi);
    await startSession(replacement);

    assert.ok(replacement.definitions.get("tool_search")?.description?.includes("codemode"),
      "the process-local primary default rebuilds discovery under the replacement manager identity");
    assert.equal(replacement.activeTools().includes("codemode"), false,
      "retaining wrapper intent does not change native codemode's initial selection");
    const result = await searchTool(replacement)("replacement-codemode", { query: "codemode" });
    assert.deepEqual((result.details as { activated: string[] }).activated, ["codemode"]);
    assert.equal(replacement.activeTools().includes("codemode"), true,
      "the loader declares the wrapper-authorized codemode under the replacement identity");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a fresh manual primary activation does not inherit wrapper codemode default", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-native-tools-manual-"));
  try {
    await writeConfig(cwd);
    const runtime = new NativeToolRuntime(cwd, nativeDefinitions(), ["read"]);
    await activate(runtime.pi);
    await startSession(runtime);

    assert.doesNotMatch(runtime.definitions.get("tool_search")?.description ?? "", /codemode/);
    const result = await searchTool(runtime)("manual-codemode", { query: "codemode" });
    assert.deepEqual((result.details as { matched: string[] }).matched, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("SessionSpawn is reporter-capability-gated for top-level hosted children and absent from executors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-session-spawn-registration-"));
  try {
    await writeConfig(cwd);
    const standalone = new NativeToolRuntime(cwd, nativeDefinitions(), ["read"]);
    await activate(standalone.pi);
    await startSession(standalone);
    assert.equal(standalone.definitions.has("SessionSpawn"), false, "ordinary standalone Pi has no host capability");

    const capability = { titleColumns: 32, spawn: async () => "started" as const };
    publishSessionHostSpawnCapability(capability);
    assert.equal(getSessionHostSpawnCapability(), capability);
    const hostedNativeTools = nativeDefinitions();
    const hosted = new NativeToolRuntime(cwd, hostedNativeTools, hostedNativeTools.map((tool) => tool.name));
    await activate(hosted.pi);
    await startSession(hosted);
    assert.equal(hosted.definitions.has("SessionSpawn"), true, "the reporter-published top-level capability registers the tool");

    const catalog = createExecutorToolCatalog(["read"], ["read"]);
    const settlement = createPiSettlementBootstrap(cwd, "session-spawn-executor-ceiling");
    process.env.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";
    process.env[EXECUTOR_TOOL_CATALOG_ENV] = JSON.stringify(catalog);
    Object.assign(process.env, piSettlementEnvironment(settlement));
    const executor = new NativeToolRuntime(cwd, nativeDefinitions(), ["read"]);
    await activate(executor.pi);
    await startSession(executor);
    assert.equal(executor.definitions.has("SessionSpawn"), false, "executor role ignores even a process-local capability");
    assert.equal(executor.activeTools().includes("SessionSpawn"), false);
    await executor.fire("session_shutdown", executor.context);
    revokeSessionHostSpawnCapability(capability);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the initial hosted request waits for review initialization and is persisted before dispatch", async () => {
  // The raw checkpoint store lives under the agent-data directory, so the
  // workspace and agent-data must be siblings: an agent-data inside the
  // capture workspace is a refused non-Git overlap configuration.
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-spawn-startup-gate-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent-data");
  try {
    await mkdir(cwd);
    await mkdir(agentDir);
    await writeConfig(cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const title = "-- exact initial title --";
    const prompt = "  @literal-request.md\n--offline is prompt text, not a Pi option.\n  ";
    process.env[SESSION_HOST_STARTUP_REQUEST_ENV] = JSON.stringify({ title, prompt });
    primeSessionHostStartupMetadata(true);

    const runtime = new NativeToolRuntime(cwd, nativeDefinitions(), ["read"]);
    // The session file (and its persisted state sidecar) stay outside the
    // capture workspace so checkpoint enumeration never sees gate-owned state.
    const sessionFile = join(agentDir, "native-session.jsonl");
    Object.assign(runtime.context.sessionManager, {
      getSessionId: () => "startup-gate-session",
      getSessionFile: () => sessionFile,
      getCwd: () => cwd,
    });
    runtime.pi.appendEntry = () => undefined;
    const submitted: Array<{ title?: string; prompt: string; options?: { expandPromptTemplates?: boolean } }> = [];
    let extensionInput: Promise<unknown[]> | undefined;
    let immediateTurn: Promise<unknown[]> | undefined;
    runtime.pi.setSessionName = (name: string) => {
      submitted.push({ title: name, prompt: "", options: undefined });
    };
    runtime.pi.sendUserMessage = (message: string, options?: { expandPromptTemplates?: boolean }) => {
      assert.equal(runtime.activeTools().includes("tool_search"), true,
        "deferred-tool authorization is established before the initial turn is submitted");
      submitted.push({ prompt: message, options });
      // Pi reports this public API call as extension input; the gate's normal
      // input observer intentionally ignores it, so startup must record it itself.
      extensionInput = runtime.fire("input", { source: "extension", text: message }, runtime.context);
      // Model Pi's eager sendUserMessage semantics: the run may enter
      // before_agent_start before the surrounding session_start hook returns.
      immediateTurn = runtime.fire("before_agent_start", { systemPrompt: "" }, runtime.context);
    };

    let releaseInitialization!: () => void;
    let signalInitializationHeld!: () => void;
    const initialization = new Promise<void>((resolve) => { releaseInitialization = resolve; });
    const held = new Promise<void>((resolve) => { signalInitializationHeld = resolve; });
    await activate(runtime.pi, {
      sessionStartInitializationTestBarrier: async () => {
        signalInitializationHeld();
        await initialization;
      },
    });
    runtime.start();
    const starting = runtime.fire("session_start", { cwd }, runtime.context);
    await held;
    assert.deepEqual(submitted, [], "no title or user turn is dispatched while gate session setup is suspended");
    releaseInitialization();
    await starting;
    await extensionInput;
    await immediateTurn;

    assert.deepEqual(submitted, [
      { title, prompt: "", options: undefined },
      { prompt, options: { expandPromptTemplates: false } },
    ], "the supplied title and literal prompt are dispatched only after initialization");
    const persisted = JSON.parse(await readFile(`${sessionFile}.pi-review-gate-state.json`, "utf8")) as {
      state: { reviewWindow?: { requestHistory: Array<{ phase: string; text: string }> } };
    };
    assert.deepEqual(persisted.state.reviewWindow?.requestHistory, [
      { sequence: 1, phase: "initial", text: prompt },
    ], "the initial extension-sourced prompt is explicitly present in review request context");

    const armed = JSON.parse(await readFile(`${sessionFile}.pi-review-gate-state.json`, "utf8")) as {
      state: { reviewWindow?: { baseline?: { kind?: string } } };
    };
    assert.equal(armed.state.reviewWindow?.baseline?.kind, "checkpoint",
      "the initialized live-session checkpoint scope arms the actual first turn");
    await runtime.fire("session_shutdown", runtime.context);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executor activation consumes but never captures primary wrapper codemode intent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-native-tools-executor-default-"));
  const primaryCwd = join(cwd, "primary");
  try {
    await mkdir(primaryCwd);
    await writeConfig(cwd);
    await writeConfig(primaryCwd);
    const catalog = createExecutorToolCatalog(["read"], ["read"]);
    const settlement = createPiSettlementBootstrap(cwd, "executor-no-primary-default");
    const executor = new NativeToolRuntime(cwd, nativeDefinitions(), ["read"]);
    process.env.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";
    process.env[EXECUTOR_TOOL_CATALOG_ENV] = JSON.stringify(catalog);
    Object.assign(process.env, piSettlementEnvironment(settlement));
    process.env[CODEMODE_DEFAULT_ENV] = "1";
    await activate(executor.pi);
    assert.equal(process.env[CODEMODE_DEFAULT_ENV], undefined);
    assert.equal(process.env[EXECUTOR_TOOL_CATALOG_ENV], JSON.stringify(catalog));
    await startSession(executor);
    assert.equal(executor.activeTools().includes("codemode"), false,
      "executor authority remains its fixed catalog despite the primary marker");
    await executor.fire("session_shutdown", executor.context);

    delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
    delete process.env[EXECUTOR_TOOL_CATALOG_ENV];
    const primary = new NativeToolRuntime(primaryCwd, nativeDefinitions(), ["read"]);
    await activate(primary.pi);
    await startSession(primary);
    assert.doesNotMatch(primary.definitions.get("tool_search")?.description ?? "", /codemode/,
      "an executor marker cannot seed primary-process wrapper intent");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("primary lifecycle reconciliation preserves the live loader gate and adopts only current host authority", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-native-tools-lifecycle-"));
  try {
    await writeConfig(cwd);
    const runtime = new NativeToolRuntime(cwd, nativeDefinitions({ codemode: false, mcp: false }), ["read"]);
    await activate(runtime.pi);
    await startSession(runtime);

    for (const event of ["turn_start", "session_tree", "mcp_servers_change"]) {
      assert.ok(runtime.hooks.has(event), `${event} is a registered public reconciliation boundary`);
    }
    assert.equal(runtime.hooks.has("tools_changed"), false, "no synthetic tools_changed event is used");

    // A call-time authorization query must not reapply the desired set before
    // checking whether tool_search is still selected.
    runtime.setNativeActive("tool_search", false);
    const deselectedLoader = await submitModelCall(runtime, "tool_search", "deselected-loader", { query: "read" });
    assert.equal(deselectedLoader?.block, true, "a deselected loader is rejected");
    assert.equal(runtime.activeTools().includes("tool_search"), false, "denial does not resurrect the loader");

    runtime.setNativeActive("tool_search", true);
    runtime.registerNative({ name: "LateNativeTool", description: "Registered after startup." });
    await runtime.fire("mcp_servers_change", runtime.context);
    assert.equal(runtime.activeTools().includes("LateNativeTool"), false,
      "the host's late auto-activation is not adopted as a direct declaration");
    assert.ok(runtime.definitions.get("tool_search")?.description?.includes("LateNativeTool"),
      "a permitted late top-level registry name joins host discovery");
    const lateSearch = await searchTool(runtime)("load-late", { query: "LateNativeTool" });
    assert.deepEqual((lateSearch.details as { activated: string[] }).activated, ["LateNativeTool"]);
    assert.equal((await submitModelCall(runtime, "LateNativeTool", "late-call", {}))?.block, undefined);

    runtime.removeNative("LateNativeTool");
    const withdrawn = await submitModelCall(runtime, "LateNativeTool", "withdrawn-call", {});
    assert.equal(withdrawn?.block, true, "registry withdrawal denies immediately at call time");
    await runtime.fire("turn_start", runtime.context);
    assert.equal(runtime.activeTools().includes("LateNativeTool"), false,
      "turn boundary removes a withdrawn managed selection");

    runtime.registerNative({ name: "LateHiddenTool", description: "Becomes hidden after startup." });
    await runtime.fire("mcp_servers_change", runtime.context);
    const hidden = runtime.definitions.get("LateHiddenTool");
    assert.ok(hidden);
    hidden.exposure = "hidden";
    assert.equal((await submitModelCall(runtime, "LateHiddenTool", "hidden-call", {}))?.block, true,
      "a newly hidden registry entry is denied immediately");
    await runtime.fire("turn_start", runtime.context);
    assert.equal(runtime.activeTools().includes("LateHiddenTool"), false);

    runtime.registerNative({ name: "TreeLateTool", description: "Registered before branch navigation." });
    await runtime.fire("session_tree", runtime.context);
    assert.equal(runtime.activeTools().includes("TreeLateTool"), false,
      "session-tree reconciliation strips a late direct auto-activation");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("plan/research rejects codemode and annotated MCP tools with deferred tools on or off", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-native-tools-research-"));
  try {
    for (const deferredPiTools of [true, false]) {
      const runDir = join(cwd, String(deferredPiTools));
      await mkdir(runDir);
      await writeConfig(runDir, {
        operatingMode: "plan-research",
        execution: { deferredPiTools },
      });
      const runtime = new NativeToolRuntime(runDir, nativeDefinitions(), ["read", "mcp__docs__lookup"]);
      process.env[CODEMODE_DEFAULT_ENV] = "1";
      await activate(runtime.pi);
      await startSession(runtime);

      assert.equal(runtime.activeTools().includes("codemode"), false);
      assert.equal(runtime.activeTools().includes("mcp__docs__lookup"), false,
        "read-only annotations do not create a research MCP exception");
      assert.equal((await submitModelCall(runtime, "codemode", `research-code-${deferredPiTools}`, { code: "" }))?.block, true);
      assert.equal((await submitModelCall(runtime, "mcp__docs__lookup", `research-mcp-${deferredPiTools}`, {}))?.block, true);
      const description = runtime.definitions.get("tool_search")?.description ?? "";
      assert.doesNotMatch(description, /codemode|mcp__docs__lookup/);
      await runtime.fire("session_shutdown", runtime.context);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit native registry exclusion and frozen research-worker catalogs cannot be widened by wrapper intent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-native-tools-ceiling-"));
  try {
    const topDir = join(cwd, "top");
    await mkdir(topDir);
    await writeConfig(topDir);
    const restricted = new NativeToolRuntime(topDir, nativeDefinitions({ codemode: false, mcp: false }), ["read"]);
    process.env[CODEMODE_DEFAULT_ENV] = "1";
    await activate(restricted.pi);
    await startSession(restricted);
    assert.equal(restricted.definitions.has("codemode"), false, "the extension never registers excluded native codemode");
    assert.equal(restricted.activeTools().includes("codemode"), false);
    assert.doesNotMatch(restricted.definitions.get("tool_search")?.description ?? "", /codemode/);
    assert.equal((await submitModelCall(restricted, "codemode", "excluded-code", { code: "" }))?.block, true);

    process.env.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";
    for (const deferredPiTools of [true, false]) {
      const workerDir = join(cwd, `worker-${deferredPiTools}`);
      await mkdir(workerDir);
      await writeConfig(workerDir, { execution: { deferredPiTools } });
      const worker = new NativeToolRuntime(workerDir, nativeDefinitions(), ["read", "WebSearch"]);
      const researchCandidates = ["read", "WebSearch", "codemode", "mcp__docs__lookup"];
      const researchTools = researchCandidates.filter((name) => RESEARCH_ALLOWED_TOOLS.has(name));
      const initialActiveTools = deferredPiTools ? ["read"] : researchTools;
      const catalog = createExecutorToolCatalog(researchTools, initialActiveTools);
      process.env[EXECUTOR_TOOL_CATALOG_ENV] = JSON.stringify(catalog);
      process.env[CODEMODE_DEFAULT_ENV] = "1";
      const settlement = createPiSettlementBootstrap(workerDir, `research-worker-${deferredPiTools}`);
      Object.assign(process.env, piSettlementEnvironment(settlement));
      await activate(worker.pi);
      assert.equal(process.env[CODEMODE_DEFAULT_ENV], undefined);
      await startSession(worker);
      assert.equal(process.env[EXECUTOR_TOOL_CATALOG_ENV], undefined);
      assert.deepEqual(worker.activeTools(), deferredPiTools
        ? ["read", "tool_search"]
        : ["read", "WebSearch", "tool_search"]);
      worker.registerNative({ name: "LateWorkerTool", description: "Outside the captured worker ceiling." });
      await worker.fire("mcp_servers_change", worker.context);
      assert.equal(worker.activeTools().includes("LateWorkerTool"), false,
        "late registry additions never widen the frozen worker catalog");
      assert.doesNotMatch(worker.definitions.get("tool_search")?.description ?? "", /LateWorkerTool/);
      assert.equal((await submitModelCall(worker, "LateWorkerTool", `worker-late-${deferredPiTools}`, {}))?.block, true);
      assert.equal((await submitModelCall(worker, "codemode", `worker-code-${deferredPiTools}`, { code: "" }))?.block, true);
      assert.equal((await submitModelCall(worker, "mcp__docs__lookup", `worker-mcp-${deferredPiTools}`, {}))?.block, true,
        "the fixed research-worker ceiling is not widened by MCP annotations or wrapper intent");
      await worker.fire("session_shutdown", worker.context);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
