// Extension entrypoint activation and deferred-discovery suites: fail-closed
// startup registration, the conservative active tool set, the deferred
// discovery surface (search_tools inventory and activations), and per-session
// isolation of deferred authorization across API recreation.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activate } from "../src/index";
import { reapAll } from "../src/background-shell";
import {
  backgroundShellToolNames,
  escapeRegExp,
  executionToolNames,
  indexTestConfig,
  trigger,
  triggerResults,
  webToolNames,
} from "./entrypoint-harness";
test("unsupported configuration warns and still registers normal tools and settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-legacy-config-fail-closed-"));
  try {
    const configPath = join(dir, "review-gate.json");
    // Unsupported input is not interpreted, but must not abort startup.
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        timeoutMs: 5000,
      },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const commands: string[] = [];
    const tools: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string) { commands.push(name); },
      registerTool(tool: { name: string }) { tools.push(tool.name); },
      notify(message: string) { notices.push(message); },
    };

    await activate(pi);
    assert.match(notices.join("\n"), /config warning: decider is invalid or unsupported/);
    assert.ok(commands.includes("review-settings"));
    assert.ok(tools.includes("ApplyPatch"));
    assert.ok(hooks.has("session_start"));
    const results = await triggerResults(hooks, "tool_call", {
      cwd: dir,
      toolName: "read",
      args: { path: configPath },
    });
    assert.ok(results.every((result) => !(result as { block?: boolean } | undefined)?.block));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("session_start keeps launch-authorized native discovery active in the conservative active set (#71)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-discovery-"));
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
      externalAgents: {
        "fake": {
          adapter: "run-as-binary",
          command: process.execPath,
          execution: { protocol: "pi-review-executor-jsonl-v1" as const }
        }
      },
      execution: {
        workerResources: { "default": { selection: { source: "external", id: "fake" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    // Pi's default startup registers discovery without initially activating it.
    let activeTools = ["read", "bash", "edit"];
    let runtimeInitialized = false;
    const assertRuntime = () => {
      if (!runtimeInitialized) throw new Error("Extension runtime not initialized");
    };
    const registeredTools: Array<{ name: string; description?: string }> = [];
    const registeredDiscovery = [
      { name: "grep", description: "Search file contents." },
      { name: "find", description: "Find files." },
      { name: "ls", description: "List directory entries." },
    ];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand() {},
      registerTool(tool: { name: string; description?: string }) {
        // Pi replaces a same-name registration in place (documented override
        // path); an already-active tool is not re-activated.
        const existing = registeredTools.findIndex((candidate) => candidate.name === tool.name);
        if (existing >= 0) registeredTools.splice(existing, 1, tool);
        else registeredTools.push(tool);
        if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
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
          ...registeredDiscovery,
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
    runtimeInitialized = true;
    await trigger(hooks, "session_start", { cwd: dir }, { cwd: dir, ui: {}, sessionManager: {} });
    for (const name of ["grep", "find", "ls"]) {
      assert.ok(activeTools.includes(name), `${name} is active from the first request`);
    }
    // The conservative set keeps the discovery trio alongside the loader and
    // execution controls; a mode switch retains them (covered role-level).
    assert.deepEqual(activeTools, [
      "read", "grep", "find", "ls", "bash", "edit", "ApplyPatch", "SubtasksStart", "search_tools",
    ]);
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
      externalAgents: {
        "fake": {
          adapter: "run-as-binary",
          command: process.execPath,
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
workerResources: { "default": { selection: { source: "external", id: "fake" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
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
        // Pi replaces a same-name registration in place (documented override
        // path), so a description refresh keeps the original position.
        const existing = registeredTools.findIndex((candidate) => candidate.name === tool.name);
        if (existing >= 0) registeredTools.splice(existing, 1, tool);
        else registeredTools.push(tool);
        if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
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
      ...webToolNames, "ApplyPatch", ...backgroundShellToolNames, "search_tools", "AskUserQuestion",
    ]);

    runtimeInitialized = true;
    const sessionContext = { cwd: dir, ui: {}, sessionManager: {} };
    await trigger(hooks, "session_start", { cwd: dir }, sessionContext);
    assert.deepEqual(registeredTools.map((tool) => tool.name), [
      ...webToolNames, "ApplyPatch", ...backgroundShellToolNames, "search_tools", "AskUserQuestion", ...executionToolNames,
    ]);
    const deferredActive = ["read", "bash", "edit", "ApplyPatch", "SubtasksStart", "search_tools"];
    assert.deepEqual(activeTools, deferredActive);

    // The registered search_tools description itself discloses the deferred
    // discovery set — authorized minus baseline-loaded — comma-delimited.
    const searchDefinition = registeredTools.find((tool) => tool.name === "search_tools");
    const expectedDiscovery = [
      "AskUserQuestion", ...webToolNames, ...backgroundShellToolNames,
      ...executionToolNames.filter((name) => name !== "SubtasksStart"),
    ].sort();
    assert.match(searchDefinition?.description ?? "", new RegExp(`Authorized tool names: ${expectedDiscovery.map(escapeRegExp).join(", ")}\\.$`));
    assert.doesNotMatch(searchDefinition?.description ?? "", /parameters|properties/);

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
      "AskUserQuestion", ...executionToolNames,
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
    // The startup inventory is the stable deferred discovery set only:
    // baseline-loaded tools (read/bash/edit/ApplyPatch/SubtasksStart) and
    // search_tools itself are omitted, every deferred discovery tool is
    // listed with its compact canonical purpose.
    const discoveryNames = [
      "AskUserQuestion", ...webToolNames, ...backgroundShellToolNames,
      ...executionToolNames.filter((name) => name !== "SubtasksStart"),
    ];
    for (const name of discoveryNames) {
      assert.match(inventory, new RegExp(escapeRegExp(`\\"${name}\\"`)));
    }
    for (const baselineName of ["read", "bash", "edit", "ApplyPatch", "SubtasksStart", "search_tools"]) {
      assert.doesNotMatch(inventory, new RegExp(escapeRegExp(`\\"${baselineName}\\"`)));
    }
    assert.match(inventory, /exact name/);
    assert.match(inventory, /next turn/);
    // Compact canonical purposes are part of the inventory; schemas and
    // unauthorized late registrations never appear.
    assert.match(inventory, /Search the public web/);
    assert.doesNotMatch(inventory, /LateIdleTool|parameters|properties/);
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

    // A mode switch is a legitimate permission-boundary change: both discovery
    // surfaces rebuild from the live mode ceiling (write-capable and
    // execution-control names disappear), and switching back restores the
    // execute baseline byte-for-byte despite the SubtasksAdd activation.
    const executeDescription = searchDefinition?.description ?? "";
    const selectOperatingMode = async (label: string) => {
      assert.ok(reviewSettingsHandler);
      let rootVisits = 0;
      await reviewSettingsHandler("", {
        ui: {
          select: async (title: string, options: string[]) => {
            if (title === "Review settings") return rootVisits++ === 0
              ? options.find((option) => option.startsWith("Operating mode"))
              : "Save changes";
            if (title === "Operating mode") return options.find((option) => option.startsWith(label));
            throw new Error(`Unexpected menu: ${title}`);
          },
          notify() {},
        },
      });
    };
    await selectOperatingMode("Plan/research");
    const researchInventory = JSON.stringify(await triggerResults(hooks, "before_agent_start", { cwd: dir }));
    // Scope to the inventory segment: the mode prompt prose legitimately
    // names tools; only the discovery list must drop them.
    const researchSegment = researchInventory.match(/Authorized tool names with purpose:.*?If an authorized/)?.[0] ?? "";
    assert.match(researchSegment, new RegExp(escapeRegExp(`\\"SubtasksInspect\\" (`)));
    assert.match(researchSegment, new RegExp(escapeRegExp(`\\"WebSearch\\" (`)));
    assert.doesNotMatch(researchSegment, /SubtasksAdd|ShellStart|BrowserClick|SubtasksSteer/);
    const researchSearch = registeredTools.find((tool) => tool.name === "search_tools");
    assert.doesNotMatch(researchSearch?.description ?? "", /SubtasksAdd|ShellStart|BrowserClick/);
    assert.match(researchSearch?.description ?? "", /SubtasksInspect, SubtasksWatch, WebFetch, WebSearch\.$/);

    await selectOperatingMode("Prefer orchestration");
    const restoredInventory = JSON.stringify(await triggerResults(hooks, "before_agent_start", { cwd: dir }));
    const restoredSegment = restoredInventory.match(/Authorized tool names with purpose:.*?If an authorized/)?.[0] ?? "";
    assert.match(restoredSegment, new RegExp(escapeRegExp(`\\"SubtasksAdd\\" (`)));
    assert.equal(registeredTools.find((tool) => tool.name === "search_tools")?.description, executeDescription);
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
