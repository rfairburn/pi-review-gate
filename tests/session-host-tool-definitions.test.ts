/**
 * #682: SessionHosts and SessionSpawn each have one canonical definition and
 * handler. Pi registration must consume exactly that definition, and the
 * definition must derive all authority from the owner's actual capability.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SESSION_HOSTS_TOOL_NAME,
  registerSessionHostsTool,
  sessionHostsOutputSchema,
  sessionHostsResult,
  sessionHostsToolDefinition,
  sessionHostsToolSchema,
  type SessionHostsToolDefinition,
} from "../src/session-host/hosts-tool";
import {
  SESSION_SPAWN_CREATE_WORKSPACE_GUIDANCE,
  SESSION_SPAWN_DISCOVERY_GUIDANCE,
  SESSION_SPAWN_TOOL_NAME,
  registerSessionSpawnTool,
  sessionSpawnResult,
  sessionSpawnToolDefinition,
  sessionSpawnToolSchema,
  type SessionSpawnToolDefinition,
} from "../src/session-host/spawn-tool";
import type { SessionHostSpawnCapability } from "../src/session-host/spawn-capability";
import type {
  SessionHostsInspection,
  SessionHostsSnapshot,
  SessionHostsUnavailableReason,
  SessionSpawnInput,
  SessionSpawnOutcome,
} from "../src/session-host/protocol";

type PiExecute = (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<Record<string, unknown>>;

function capturePi(): { pi: { registerTool(tool: Record<string, unknown>): void }; tools: Record<string, unknown>[] } {
  const tools: Record<string, unknown>[] = [];
  return { pi: { registerTool: (tool) => { tools.push(tool); } }, tools };
}

function registeredHosts(capability: SessionHostSpawnCapability | undefined): Record<string, unknown> | undefined {
  const { pi, tools } = capturePi();
  const registered = registerSessionHostsTool(pi, capability);
  assert.equal(registered, tools.length === 1);
  assert.ok(tools.length <= 1);
  return tools[0];
}

function registeredSpawn(capability: SessionHostSpawnCapability | undefined): Record<string, unknown> | undefined {
  const { pi, tools } = capturePi();
  const registered = registerSessionSpawnTool(pi, capability);
  assert.equal(registered, tools.length === 1);
  assert.ok(tools.length <= 1);
  return tools[0];
}

/** Everything Pi sees except the execute adapter. */
function staticFields(tool: Record<string, unknown>): Record<string, unknown> {
  const { execute: _execute, ...rest } = tool;
  return rest;
}

function hostsDefinitionFields(definition: SessionHostsToolDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    label: definition.label,
    annotations: { ...definition.annotations },
    description: definition.description,
    promptSnippet: definition.promptSnippet,
    promptGuidelines: [...definition.promptGuidelines],
    parameters: definition.parameters,
    outputSchema: definition.outputSchema,
  };
}

function spawnDefinitionFields(definition: SessionSpawnToolDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    promptSnippet: definition.promptSnippet,
    promptGuidelines: [...definition.promptGuidelines],
    executionMode: definition.executionMode,
    parameters: definition.parameters,
  };
}

/** Settle a promise into a comparable value without losing the rejection message. */
async function settle(promise: Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    assert.ok(error instanceof Error, "rejections are model-facing Error objects");
    return { ok: false, message: error.message };
  }
}

const SNAPSHOT: SessionHostsSnapshot = {
  ownKinds: ["pi", "codex"],
  hosts: [
    { id: "peer-a", label: "desk", kinds: ["pi"] },
    { id: "peer-b", label: "desk", kinds: ["claude", "codex"] },
  ],
};

const UNAVAILABLE_REASONS: readonly SessionHostsUnavailableReason[] = [
  "not-connected", "busy", "cancelled", "timeout", "disconnected", "host-unavailable", "protocol",
];

describe("canonical SessionHosts definition", () => {
  function hostsCapability(
    inspectHosts: SessionHostSpawnCapability["inspectHosts"],
    overrides: Partial<SessionHostSpawnCapability> = {},
  ): SessionHostSpawnCapability {
    return {
      titleColumns: 32,
      routing: true,
      spawn: async (): Promise<SessionSpawnOutcome> => { throw new Error("discovery must never spawn"); },
      ...(inspectHosts ? { inspectHosts } : {}),
      ...overrides,
    };
  }

  it("exists only with the actual routed inspection capability, and Pi registration follows it exactly", () => {
    const inspect = async (): Promise<SessionHostsInspection> => ({ outcome: "complete", snapshot: SNAPSHOT });
    const refused: Array<SessionHostSpawnCapability | undefined> = [
      undefined,
      hostsCapability(undefined),
      hostsCapability(inspect, { routing: false }),
      hostsCapability(inspect, { routing: undefined }),
      { ...hostsCapability(undefined), inspectHosts: "not a function" } as unknown as SessionHostSpawnCapability,
    ];
    for (const capability of refused) {
      assert.equal(sessionHostsToolDefinition(capability), undefined);
      assert.equal(registeredHosts(capability), undefined, "no Pi registration without inspection authority");
    }
    const capability = hostsCapability(inspect);
    assert.ok(sessionHostsToolDefinition(capability));
    assert.ok(registeredHosts(capability));
    // A capability is necessary but not sufficient: an invalid Pi host still registers nothing.
    assert.equal(registerSessionHostsTool(undefined, capability), false);
    assert.equal(registerSessionHostsTool({ registerTool: "nope" }, capability), false);
  });

  it("Pi registers exactly the shared definition's static surface", () => {
    const definition = sessionHostsToolDefinition(hostsCapability(async () => ({ outcome: "complete", snapshot: SNAPSHOT })))!;
    const tool = registeredHosts(hostsCapability(async () => ({ outcome: "complete", snapshot: SNAPSHOT })))!;
    assert.deepEqual(staticFields(tool), hostsDefinitionFields(definition));
    assert.deepEqual(Object.keys(tool), [
      "name", "label", "annotations", "description", "promptSnippet", "promptGuidelines", "parameters", "outputSchema", "execute",
    ]);
    assert.equal(definition.name, SESSION_HOSTS_TOOL_NAME);
    assert.equal(definition.label, SESSION_HOSTS_TOOL_NAME);
    assert.deepEqual(definition.annotations, { readOnlyHint: true, destructiveHint: false });
    assert.deepEqual(definition.parameters, sessionHostsToolSchema());
    assert.deepEqual(definition.outputSchema, sessionHostsOutputSchema());
    assert.match(definition.description, /descriptive, not a permission grant or launch receipt/);
    assert.match(definition.promptGuidelines[1]!, /unavailable SessionHosts result means nothing is known, not that no hosts exist/);
    assert.equal(typeof tool.execute, "function");
  });

  it("is frozen so a binder cannot swap the handler or guidance", () => {
    const definition = sessionHostsToolDefinition(hostsCapability(async () => ({ outcome: "complete", snapshot: SNAPSHOT })))!;
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.promptGuidelines));
    assert.ok(Object.isFrozen(definition.annotations));
    assert.throws(() => { (definition as { execute: unknown }).execute = async () => ({}); }, TypeError);
  });

  it("returns the same complete result through the shared handler and Pi, forwarding the cancellation signal", async () => {
    const calls: Array<{ self: unknown; signal: AbortSignal | undefined }> = [];
    const capability: SessionHostSpawnCapability = hostsCapability(async function (this: unknown, signal?: AbortSignal) {
      calls.push({ self: this, signal });
      return { outcome: "complete", snapshot: SNAPSHOT };
    });
    const definition = sessionHostsToolDefinition(capability)!;
    const tool = registeredHosts(capability)!;
    const shared = new AbortController().signal;
    const viaPi = new AbortController().signal;
    const sharedResult = await definition.execute({}, shared);
    const piResult = await (tool.execute as PiExecute)("pi-call", {}, viaPi);
    assert.deepEqual(sharedResult, sessionHostsResult(SNAPSHOT));
    assert.deepEqual(piResult, sharedResult);
    assert.deepEqual(sharedResult.structuredContent, SNAPSHOT);
    assert.deepEqual(calls.map((call) => call.signal), [shared, viaPi]);
    assert.ok(calls.every((call) => call.self === capability), "the inspection runs on the owner's own capability");
  });

  it("an unavailable inspection is the same error on both paths and never an empty roster", async () => {
    for (const reason of [...UNAVAILABLE_REASONS, "unexpected" as SessionHostsUnavailableReason]) {
      const capability = hostsCapability(async () => ({ outcome: "unavailable", reason }));
      const definition = sessionHostsToolDefinition(capability)!;
      const tool = registeredHosts(capability)!;
      const shared = await settle(definition.execute({}));
      const viaPi = await settle((tool.execute as PiExecute)("pi-call", {}));
      assert.equal(shared.ok, false, `${reason} must not resolve as a listing`);
      assert.deepEqual(viaPi, shared);
      if (shared.ok) continue;
      assert.match(shared.message, /^SessionHosts inspection is unavailable: /);
      assert.match(shared.message, /This does not mean no paired hosts exist; no session was started, no trust or settings were changed, and no retry was made\.$/);
      if (reason === ("unexpected" as SessionHostsUnavailableReason)) {
        assert.match(shared.message, /could not provide a complete answer/, "an unknown reason maps to host-unavailable");
      }
    }
  });

  it("rejects arguments identically on both paths before any inspection", async () => {
    let inspections = 0;
    const capability = hostsCapability(async () => { inspections += 1; return { outcome: "complete", snapshot: SNAPSHOT }; });
    const definition = sessionHostsToolDefinition(capability)!;
    const tool = registeredHosts(capability)!;
    for (const params of [{ host: "peer-a" }, [], "x", null, 7]) {
      const shared = await settle(definition.execute(params));
      const viaPi = await settle((tool.execute as PiExecute)("pi-call", params));
      assert.deepEqual(shared, { ok: false, message: "SessionHosts takes no arguments." });
      assert.deepEqual(viaPi, shared);
    }
    assert.equal(inspections, 0);
    assert.equal((await settle(definition.execute(undefined))).ok, true, "an absent argument object is the empty object");
  });
});

describe("canonical SessionSpawn definition", () => {
  interface SpawnCall { self: unknown; input: SessionSpawnInput; signal: AbortSignal | undefined }

  function spawnCapability(
    overrides: Partial<SessionHostSpawnCapability> = {},
    outcome: SessionSpawnOutcome = "started",
  ): { capability: SessionHostSpawnCapability; calls: SpawnCall[] } {
    const calls: SpawnCall[] = [];
    const capability: SessionHostSpawnCapability = {
      titleColumns: 40,
      async spawn(this: unknown, input: SessionSpawnInput, signal?: AbortSignal) {
        calls.push({ self: this, input, signal });
        return outcome;
      },
      ...overrides,
    };
    return { capability, calls };
  }

  const inspectHosts = async (): Promise<SessionHostsInspection> => ({ outcome: "unavailable", reason: "timeout" });

  const SHAPES: ReadonlyArray<{ name: string; overrides: Partial<SessionHostSpawnCapability>; routing: boolean; discovery: boolean; createWorkspace: boolean }> = [
    { name: "legacy own-host Pi", overrides: {}, routing: false, discovery: false, createWorkspace: false },
    { name: "legacy with undeclared facets", overrides: { createWorkspace: true, inspectHosts }, routing: false, discovery: false, createWorkspace: false },
    { name: "routed", overrides: { routing: true }, routing: true, discovery: false, createWorkspace: false },
    { name: "routed with discovery", overrides: { routing: true, inspectHosts }, routing: true, discovery: true, createWorkspace: false },
    { name: "routed with createWorkspace", overrides: { routing: true, createWorkspace: true }, routing: true, discovery: false, createWorkspace: true },
    { name: "routed with everything", overrides: { routing: true, createWorkspace: true, inspectHosts }, routing: true, discovery: true, createWorkspace: true },
  ];

  it("exists only with a capability carrying a valid title-space snapshot", () => {
    for (const titleColumns of [0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "40" as unknown as number]) {
      const { capability } = spawnCapability({ titleColumns });
      assert.equal(sessionSpawnToolDefinition(capability), undefined, String(titleColumns));
      assert.equal(registeredSpawn(capability), undefined);
    }
    assert.equal(sessionSpawnToolDefinition(undefined), undefined);
    assert.equal(registeredSpawn(undefined), undefined);
    for (const titleColumns of [1, 1000]) {
      assert.ok(sessionSpawnToolDefinition(spawnCapability({ titleColumns }).capability));
    }
    assert.equal(registerSessionSpawnTool({}, spawnCapability().capability), false);
  });

  it("Pi registers exactly the shared definition for every capability shape", () => {
    for (const shape of SHAPES) {
      const definition = sessionSpawnToolDefinition(spawnCapability(shape.overrides).capability)!;
      const tool = registeredSpawn(spawnCapability(shape.overrides).capability)!;
      assert.deepEqual(staticFields(tool), spawnDefinitionFields(definition), shape.name);
      assert.deepEqual(Object.keys(tool), [
        "name", "label", "description", "promptSnippet", "promptGuidelines", "executionMode", "parameters", "execute",
      ]);
      assert.equal(definition.name, SESSION_SPAWN_TOOL_NAME);
      assert.equal(definition.executionMode, "sequential");
      assert.deepEqual(definition.parameters, sessionSpawnToolSchema(40, {
        routing: shape.routing,
        discovery: shape.discovery,
        ...(shape.createWorkspace ? { createWorkspace: true } : {}),
      }), shape.name);
      const properties = (definition.parameters as { properties: Record<string, unknown> }).properties;
      assert.equal("host" in properties, shape.routing, shape.name);
      assert.equal("kind" in properties, shape.routing, shape.name);
      assert.equal("createWorkspace" in properties, shape.createWorkspace, shape.name);
      const text = JSON.stringify(spawnDefinitionFields(definition));
      assert.equal(text.includes(SESSION_SPAWN_DISCOVERY_GUIDANCE), shape.discovery, shape.name);
      assert.equal(text.includes("SessionHosts"), shape.discovery, `${shape.name}: no pointer to an unavailable tool`);
      assert.equal(text.includes(SESSION_SPAWN_CREATE_WORKSPACE_GUIDANCE), shape.createWorkspace, shape.name);
      assert.match(definition.description, /confirms child launch only, not that its prompt has completed/);
      assert.ok(Object.isFrozen(definition));
      assert.ok(Object.isFrozen(definition.promptGuidelines));
    }
  });

  it("forwards the exact input with native defaults and the same launch-only result on both paths", async () => {
    for (const outcome of ["started", "failed", "unknown"] as const) {
      const { capability, calls } = spawnCapability({ routing: true, createWorkspace: true }, outcome);
      const definition = sessionSpawnToolDefinition(capability)!;
      const tool = registeredSpawn(capability)!;
      // Omitted host/kind stay omitted (own host, Pi child); false createWorkspace is the noncreating request.
      const params = { workspace: " /w ", title: " Title ", prompt: "--flag\n", createWorkspace: false };
      const shared = new AbortController().signal;
      const viaPi = new AbortController().signal;
      const sharedResult = await definition.execute(params, shared);
      const piResult = await (tool.execute as PiExecute)("pi-call", params, viaPi);
      assert.deepEqual(sharedResult, sessionSpawnResult(outcome));
      assert.deepEqual(piResult, sharedResult);
      const expected = { workspace: " /w ", title: " Title ", prompt: "--flag\n" };
      assert.deepEqual(calls.map((call) => call.input), [expected, expected]);
      assert.deepEqual(calls.map((call) => call.signal), [shared, viaPi]);
      assert.ok(calls.every((call) => call.self === capability), "the launch runs on the owner's own capability");
      assert.equal(JSON.stringify(sharedResult).includes("--flag"), false, "the result never echoes the prompt");
      if (outcome === "started") {
        assert.match((sharedResult.content as Array<{ text: string }>)[0]!.text, /confirms launch only; its initial request may not yet have been processed/);
      }
    }
    const { capability, calls } = spawnCapability({ routing: true, createWorkspace: true });
    const routed = { workspace: "/w", title: "t", prompt: "p", host: "peer-a", kind: "codex", createWorkspace: true };
    await sessionSpawnToolDefinition(capability)!.execute(routed);
    assert.deepEqual(calls.map((call) => call.input), [routed], "declared selectors pass through unchanged");
  });

  it("refuses undeclared selectors and invalid input identically on both paths without launching", async () => {
    const cases: ReadonlyArray<{ overrides: Partial<SessionHostSpawnCapability>; params: unknown; message: RegExp }> = [
      { overrides: {}, params: { workspace: "/w", title: "t", prompt: "p", host: "peer-a" }, message: /^SessionSpawn host\/kind routing is not available in this session, so nothing was started\./ },
      { overrides: {}, params: { workspace: "/w", title: "t", prompt: "p", kind: "pi" }, message: /^SessionSpawn host\/kind routing is not available/ },
      { overrides: { createWorkspace: true }, params: { workspace: "/w", title: "t", prompt: "p", createWorkspace: true }, message: /^SessionSpawn createWorkspace is not available in this session, so nothing was started\./ },
      { overrides: { routing: true }, params: { workspace: "/w", title: "t", prompt: "p", createWorkspace: true }, message: /^SessionSpawn createWorkspace is not available/ },
      { overrides: { routing: true }, params: { workspace: "/w", title: "t", prompt: "p", routing: true }, message: /accepts exactly workspace, title, and prompt/ },
      { overrides: { routing: true }, params: { workspace: "/w", title: "t", prompt: "p", kind: "other" }, message: /kind must be one of pi, claude, codex/ },
      { overrides: { routing: true }, params: { workspace: "/w", title: "t", prompt: "p", host: "" }, message: /host must be an exact paired host id/ },
      { overrides: { routing: true, createWorkspace: true }, params: { workspace: "/w", title: "t", prompt: "p", createWorkspace: "yes" }, message: /createWorkspace must be a boolean/ },
      { overrides: {}, params: { workspace: "", title: "t", prompt: "p" }, message: /workspace must be a nonempty path/ },
      { overrides: {}, params: { workspace: "/w", title: "t", prompt: "" }, message: /prompt must be a nonempty string/ },
      { overrides: {}, params: undefined, message: /requires workspace, title, and prompt/ },
    ];
    for (const { overrides, params, message } of cases) {
      const { capability, calls } = spawnCapability(overrides);
      const definition = sessionSpawnToolDefinition(capability)!;
      const tool = registeredSpawn(capability)!;
      const shared = await settle(definition.execute(params));
      const viaPi = await settle((tool.execute as PiExecute)("pi-call", params));
      assert.equal(shared.ok, false, JSON.stringify(params));
      assert.deepEqual(viaPi, shared);
      if (!shared.ok) assert.match(shared.message, message);
      assert.deepEqual(calls, [], "nothing is launched for a refused request");
    }
  });

  it("propagates a capability launch failure unchanged on both paths", async () => {
    const capability: SessionHostSpawnCapability = {
      titleColumns: 40,
      spawn: async () => { throw new Error("owner transport failed"); },
    };
    const params = { workspace: "/w", title: "t", prompt: "p" };
    const shared = await settle(sessionSpawnToolDefinition(capability)!.execute(params));
    const viaPi = await settle((registeredSpawn(capability)!.execute as PiExecute)("pi-call", params));
    assert.deepEqual(shared, { ok: false, message: "owner transport failed" });
    assert.deepEqual(viaPi, shared);
  });

  it("takes authority only from the owner capability, never from the definition's schema or later caller edits", async () => {
    const { capability, calls } = spawnCapability();
    const definition = sessionSpawnToolDefinition(capability)!;
    // A binder editing the descriptive schema does not widen what the handler accepts.
    const properties = (definition.parameters as { properties: Record<string, unknown> }).properties;
    properties.host = { type: "string" };
    // Facets are fixed from the capability when the definition is built, as Pi registration always was.
    (capability as { routing?: boolean }).routing = true;
    (capability as { createWorkspace?: boolean }).createWorkspace = true;
    const routed = await settle(definition.execute({ workspace: "/w", title: "t", prompt: "p", host: "peer-a" }));
    assert.equal(routed.ok, false);
    if (!routed.ok) assert.match(routed.message, /routing is not available/);
    const creating = await settle(definition.execute({ workspace: "/w", title: "t", prompt: "p", createWorkspace: true }));
    assert.equal(creating.ok, false);
    if (!creating.ok) assert.match(creating.message, /createWorkspace is not available/);
    assert.deepEqual(calls, []);
    assert.throws(() => { (definition as { execute: unknown }).execute = async () => ({}); }, TypeError);
  });
});
