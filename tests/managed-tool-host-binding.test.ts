/**
 * #682: a trusted native host binds the canonical managed tools without a Pi
 * session through `ExecutionToolManagerInput.hostExposure`.
 *
 * Verified here, in process, against the real manager and controller:
 * - A no-Pi manager with a deliberate action set binds and invokes the
 *   existing handler. It still needs the owner's live call policy, owner
 *   admission, a parent catalog, a resolvable pool, and a live owner scope.
 * - The declared set is copied at construction; actions outside it are
 *   refused before the handler.
 * - An absent, malformed, or mixed Pi + host declaration never exposes
 *   anything: absent keeps the existing no-Pi refusal, and the others throw
 *   at construction before any Pi call.
 * - A Pi manager registers, activates, and filters exactly as before.
 * - A trusted host-only admitted Pi executable is validated once, refused
 *   beside a Pi host or without hostExposure, and reaches each per-kind
 *   lifecycle projection; absent, every projection keeps default `pi`.
 *
 * The catalog, policy, and admission are fixture-owned. Queued tasks never
 * dispatch (`maxWorkers = 0`). No MCP transport, real owner, launch, or
 * native-CLI behavior is covered.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import { ExecutionToolManager, type SharedManagedToolAction } from "../src/execution/tool";
import { createState } from "../src/state";
import {
  EMPTY_ASSOCIATIONS,
  FixtureAdmission,
  SUBTASK_TOOL_NAMES,
  assertManagedEnvelope,
  queuedTask,
  type SharedTool,
} from "./managed-tool-fixtures";

type Binding = { toolCallId: string; host?: unknown; ownerScopedInputsOnly: boolean };
type Handler = (action: string, toolName: string, params: unknown, binding: Binding) => Promise<Record<string, unknown>>;

const startParams = (title: string) => ({ tasks: [queuedTask(title)] });
const call = (toolCallId: string) => ({ toolCallId });
/** Masks live ids and numbers so two runs of the same request compare equal. */
const masked = (text: string) => text.replace(/\b(exec|task)-[0-9a-f-]+/g, "$1-<id>").replace(/\d+/g, "#");

function fixtureConfig() {
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      unstarted: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] } },
    },
    execution: {
      workerResources: { default: { selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
  });
  // Admission only: queued tasks never dispatch.
  config.execution!.maxWorkers = 0;
  return config;
}

interface HostOptions {
  /** Raw declaration; `undefined` omits the key. */
  hostExposure?: unknown;
  pi?: unknown;
  authorizedTools?: (() => string[] | undefined) | null;
  liveToolCallAllowed?: ((name: string) => boolean) | null;
}

interface HostFixture {
  manager: ExecutionToolManager;
  config: ReturnType<typeof fixtureConfig>;
  admission: FixtureAdmission;
  handlerCalls: Array<{ action: string; binding: Binding }>;
  shared(action: SharedManagedToolAction): SharedTool;
  admitAndInvoke(action: SharedManagedToolAction, toolName: string, toolCallId: string, params: unknown): Promise<Record<string, any>>;
  groupCount(): number;
  dispose(): Promise<void>;
}

const tempRoots: string[] = [];

/** Builds the manager the way a host owner would: construct, restore, sync. */
async function hostFixture(options: HostOptions = {}): Promise<HostFixture> {
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-review-managed-host-"));
  tempRoots.push(sourceRoot);
  const config = fixtureConfig();
  const catalog = ["read", "bash"];
  // Freeze the input (not the live config or the caller's declaration).
  const manager = new ExecutionToolManager(Object.freeze({
    pi: options.pi,
    config,
    state: createState(),
    cwd: () => sourceRoot,
    ...(options.authorizedTools === null ? {} : { authorizedTools: options.authorizedTools ?? (() => [...catalog]) }),
    ...(options.liveToolCallAllowed === null ? {} : { liveToolCallAllowed: options.liveToolCallAllowed ?? ((name: string) => SUBTASK_TOOL_NAMES.includes(name)) }),
    ...(options.hostExposure === undefined ? {} : { hostExposure: options.hostExposure as never }),
  }));
  const handlerCalls: Array<{ action: string; binding: Binding }> = [];
  const instance = manager as unknown as { executeAction: Handler };
  const original = instance.executeAction.bind(manager);
  instance.executeAction = async (action, toolName, params, binding) => {
    handlerCalls.push({ action, binding });
    return original(action, toolName, params, binding);
  };
  await manager.restoreAssociations(EMPTY_ASSOCIATIONS);
  manager.sync();
  const admission = new FixtureAdmission();
  const ownedRoots = new Set<string>();
  const collectRoots = () => {
    for (const root of manager.associations().groupRoots ?? []) ownedRoots.add(root);
  };
  const shared = (action: SharedManagedToolAction) => manager.sharedManagedTool(action, admission) as SharedTool;
  return {
    manager,
    config,
    admission,
    handlerCalls,
    shared,
    admitAndInvoke: async (action, toolName, toolCallId, params) => {
      admission.admit(toolCallId, toolName, params);
      return shared(action).invoke(call(toolCallId));
    },
    groupCount: () => {
      collectRoots();
      return manager.associations().groupRoots?.length ?? 0;
    },
    dispose: async () => {
      collectRoots();
      await manager.shutdown();
      await manager.detach();
      for (const root of ownedRoots) await rm(root, { recursive: true, force: true });
    },
  };
}

test.after(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
});

function assertRefused(response: Record<string, any>, pattern: RegExp, label: string): void {
  assertManagedEnvelope(response, true, label);
  assert.match(response.content[0].text, pattern, label);
  assert.match(response.content[0].text, /nothing was started or read/, label);
}

test("a trusted no-Pi host binds its declared actions to the existing handler and controller", async () => {
  const declared: SharedManagedToolAction[] = ["start", "inspect"];
  const fixture = await hostFixture({ hostExposure: { actions: declared } });
  try {
    // Later edits to the caller's declaration cannot widen exposure.
    declared.push("add", "steer");

    const started = await fixture.admitAndInvoke("start", "SubtasksStart", "host-start-1", startParams("host queued"));
    assertManagedEnvelope(started, false, "start");
    const details = started.details as Record<string, any>;
    assert.equal(details.action, "start");
    assert.equal(details.tasks[0].state, "queued");
    assert.equal(details.tasks[0].definition.title, "host queued");
    assert.deepEqual(details.tasks[0].definition.executorToolCatalog.allowedToolCatalog, ["read", "bash"], "the fixture-owned parent catalog is the ceiling");
    assert.equal(fixture.groupCount(), 1);

    const handle = { executionId: details.executionId, taskId: details.tasks[0].taskId };
    const inspected = await fixture.admitAndInvoke("inspect", "SubtasksInspect", "host-inspect-1", handle);
    assertManagedEnvelope(inspected, false, "inspect");
    assert.equal((inspected.details as Record<string, any>).tasks[0].taskId, handle.taskId);

    assert.deepEqual(fixture.handlerCalls.map(({ action }) => action), ["start", "inspect"]);
    for (const { binding } of fixture.handlerCalls) {
      assert.equal(binding.host, undefined, "no host context");
      assert.equal(binding.ownerScopedInputsOnly, true, "owner-scoped admission applies");
    }

    // Undeclared actions, including ones pushed after construction, never reach the handler.
    const before = fixture.handlerCalls.length;
    const added = await fixture.admitAndInvoke("add", "SubtasksAdd", "host-add-1", { executionId: handle.executionId, tasks: [queuedTask("extra")] });
    assertRefused(added, /SubtasksAdd is not currently exposed by this owner/, "add");
    const steered = await fixture.admitAndInvoke("steer", "SubtasksSteer", "host-steer-1", { ...handle, instructions: "x" });
    assertRefused(steered, /SubtasksSteer is not currently exposed by this owner/, "steer");
    assert.equal(fixture.handlerCalls.length, before);
    assert.equal(fixture.groupCount(), 1);

    // Owner admission still governs: an unadmitted call id is refused.
    const unadmitted = await fixture.shared("inspect").invoke(call("never-admitted"));
    assertRefused(unadmitted, /no owner admission for this call and tool/, "unadmitted");
    assert.equal(fixture.handlerCalls.length, before);
  } finally {
    await fixture.dispose();
  }
});

test("host exposure still needs the live call policy, a parent catalog, and a resolvable pool", async () => {
  const exposure = { actions: ["start", "inspect"] };

  const unwired = await hostFixture({ hostExposure: exposure, liveToolCallAllowed: null });
  try {
    assertRefused(await unwired.admitAndInvoke("start", "SubtasksStart", "c1", startParams("a")), /not allowed by this owner's live call policy/, "unwired policy");
    assert.equal(unwired.handlerCalls.length, 0);
  } finally {
    await unwired.dispose();
  }

  const denied = await hostFixture({ hostExposure: exposure, liveToolCallAllowed: (name) => name === "SubtasksInspect" });
  try {
    assertRefused(await denied.admitAndInvoke("start", "SubtasksStart", "c1", startParams("a")), /not allowed by this owner's live call policy/, "denied policy");
    assert.equal(denied.handlerCalls.length, 0);
    assert.equal(denied.groupCount(), 0);
  } finally {
    await denied.dispose();
  }

  // With no Pi there is no active-tool fallback: Start without a parent catalog
  // fails in the existing handler and creates nothing.
  const noCatalog = await hostFixture({ hostExposure: exposure, authorizedTools: null });
  try {
    const response = await noCatalog.admitAndInvoke("start", "SubtasksStart", "c1", startParams("a"));
    assertManagedEnvelope(response, true, "no catalog");
    assert.match(response.content[0].text, /requires an authoritative parent active-tool snapshot/);
    assert.equal(noCatalog.groupCount(), 0);
  } finally {
    await noCatalog.dispose();
  }

  // Pool resolvability is the same live sync() verdict Pi activation uses.
  const pool = await hostFixture({ hostExposure: exposure });
  try {
    assert.match((await pool.admitAndInvoke("inspect", "SubtasksInspect", "c1", { taskId: "task-any" })).content[0].text, /^SubtasksInspect failed: /);
    const resources = pool.config.execution!.workerResources;
    pool.config.execution!.workerResources = {};
    pool.manager.sync();
    assertRefused(await pool.admitAndInvoke("inspect", "SubtasksInspect", "c2", { taskId: "task-any" }), /not currently exposed by this owner/, "unresolvable pool");
    assert.equal(pool.handlerCalls.length, 1);
    pool.config.execution!.workerResources = resources;
    pool.manager.sync();
    assert.match((await pool.admitAndInvoke("inspect", "SubtasksInspect", "c3", { taskId: "task-any" })).content[0].text, /^SubtasksInspect failed: /);
  } finally {
    await pool.dispose();
  }
});

test("host exposure keeps the restore, detach, and shutdown ownership fences", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-review-managed-host-"));
  tempRoots.push(sourceRoot);
  const manager = new ExecutionToolManager({
    pi: undefined,
    config: fixtureConfig(),
    state: createState(),
    cwd: () => sourceRoot,
    authorizedTools: () => ["read"],
    liveToolCallAllowed: () => true,
    hostExposure: { actions: ["inspect"] },
  });
  const admission = new FixtureAdmission();
  try {
    // Before the first restore there is no owner scope to bind into.
    assert.throws(() => manager.sharedManagedTool("inspect", admission), /only while its owner session is live/);
    await manager.restoreAssociations(EMPTY_ASSOCIATIONS);
    // Bound but not yet synced: the pool verdict is still unresolved.
    admission.admit("pre-sync", "SubtasksInspect", { taskId: "task-any" });
    assertRefused(await manager.sharedManagedTool("inspect", admission).invoke(call("pre-sync")), /not currently exposed by this owner/, "before sync");
    manager.sync();

    admission.admit("cached", "SubtasksInspect", { taskId: "task-any" });
    const cached = manager.sharedManagedTool("inspect", admission);
    await manager.restoreAssociations(EMPTY_ASSOCIATIONS);
    assertRefused(await cached.invoke(call("cached")), /owner session that bound this tool is no longer live/, "across restore");
    const fresh = await (manager.sharedManagedTool("inspect", admission) as SharedTool).invoke(call("cached"));
    assert.match(fresh.content[0].text, /^SubtasksInspect failed: /);

    const beforeDetach = manager.sharedManagedTool("inspect", admission);
    await manager.detach();
    assert.throws(() => manager.sharedManagedTool("inspect", admission), /only while its owner session is live/);
    assertRefused(await beforeDetach.invoke(call("cached")), /owner session that bound this tool is no longer live/, "after detach");

    await manager.restoreAssociations(EMPTY_ASSOCIATIONS);
    const beforeShutdown = manager.sharedManagedTool("inspect", admission);
    await manager.shutdown();
    assert.throws(() => manager.sharedManagedTool("inspect", admission), /only while its owner session is live/);
    assertRefused(await beforeShutdown.invoke(call("cached")), /owner session that bound this tool is no longer live/, "after shutdown");
  } finally {
    await manager.shutdown();
    await manager.detach();
  }
});

test("absent, malformed, or mixed host declarations never expose a tool", async () => {
  // Absent with no Pi: the existing no-Pi refusal, unchanged.
  const absent = await hostFixture({ liveToolCallAllowed: () => true });
  try {
    assertRefused(await absent.admitAndInvoke("inspect", "SubtasksInspect", "c1", { taskId: "task-any" }), /not currently exposed by this owner/, "absent");
    assert.equal(absent.handlerCalls.length, 0);
  } finally {
    await absent.dispose();
  }

  const construct = (input: { pi?: unknown; hostExposure: unknown }) => new ExecutionToolManager({
    pi: input.pi,
    config: fixtureConfig(),
    state: createState(),
    cwd: () => tmpdir(),
    authorizedTools: () => ["read"],
    liveToolCallAllowed: () => true,
    hostExposure: input.hostExposure as never,
  });
  const malformed: unknown[] = [
    null,
    "start",
    ["start"],
    {},
    { actions: [] },
    { actions: "start" },
    { actions: ["bogus"] },
    { actions: ["SubtasksStart"] },
    { actions: ["start", undefined] },
    { actions: ["start", "start"] },
    // Sparse declarations: a hole is malformed, never skipped.
    { actions: ["start", , ] },
    { actions: [, "start"] },
  ];
  for (const hostExposure of malformed) {
    assert.throws(() => construct({ hostExposure }), /requires a non-empty, duplicate-free set of shared managed tool actions/, JSON.stringify(hostExposure));
  }

  // An accessor entry is read exactly once: the value validated is the value exposed.
  let reads = 0;
  const shifting: string[] = [];
  Object.defineProperty(shifting, 0, { enumerable: true, configurable: true, get: () => (reads++ === 0 ? "inspect" : "start") });
  const accessor = await hostFixture({ hostExposure: { actions: shifting } });
  try {
    assert.equal(reads, 1, "each declared entry is read once");
    assertRefused(await accessor.admitAndInvoke("start", "SubtasksStart", "a1", startParams("a")), /SubtasksStart is not currently exposed by this owner/, "accessor start");
    assert.match((await accessor.admitAndInvoke("inspect", "SubtasksInspect", "a2", { taskId: "task-any" })).content[0].text, /^SubtasksInspect failed: /);
    assert.deepEqual(accessor.handlerCalls.map(({ action }) => action), ["inspect"]);
    assert.equal(accessor.groupCount(), 0);
  } finally {
    await accessor.dispose();
  }

  // Mixed Pi + host is refused before any Pi registration, command, or activation.
  const piCalls: string[] = [];
  const pi = {
    registerTool() { piCalls.push("registerTool"); },
    registerCommand() { piCalls.push("registerCommand"); },
    setToolActive() { piCalls.push("setToolActive"); },
    getActiveTools: () => { piCalls.push("getActiveTools"); return ["read", ...SUBTASK_TOOL_NAMES]; },
  };
  for (const piHost of [pi, null, {}]) {
    assert.throws(() => construct({ pi: piHost, hostExposure: { actions: ["inspect"] } }), /cannot be combined with a Pi host/);
  }
  assert.deepEqual(piCalls, []);
});

test("a Pi manager registers, activates, and filters exactly as without the host seam", async () => {
  const run = async (input: { activeTools: string[]; withExplicitUndefined: boolean }) => {
    const record: string[] = [];
    const tools: Array<Record<string, any>> = [];
    const pi = {
      registerTool(tool: Record<string, any>) { tools.push(tool); record.push(`tool:${tool.name}`); },
      registerCommand(name: string) { record.push(`command:${name}`); },
      setToolActive(name: string, enabled: boolean) { record.push(`active:${name}:${enabled}`); },
      getActiveTools: () => [...input.activeTools],
    };
    const fixture = await hostFixture({
      pi,
      liveToolCallAllowed: () => true,
      ...(input.withExplicitUndefined ? { hostExposure: undefined } : {}),
    });
    try {
      const start = await fixture.admitAndInvoke("start", "SubtasksStart", "c1", startParams("pi"));
      const inspect = await fixture.admitAndInvoke("inspect", "SubtasksInspect", "c2", { taskId: "task-any" });
      return {
        record,
        schemas: tools.map((tool) => JSON.stringify([tool.name, tool.parameters, tool.description, tool.executionMode])),
        start: masked(start.content[0].text),
        inspect: masked(inspect.content[0].text),
        groups: fixture.groupCount(),
      };
    } finally {
      await fixture.dispose();
    }
  };

  const full = ["read", ...SUBTASK_TOOL_NAMES];
  const plain = await run({ activeTools: full, withExplicitUndefined: false });
  const explicit = await run({ activeTools: full, withExplicitUndefined: true });
  assert.deepEqual(explicit, plain);
  assert.deepEqual(plain.record.filter((entry) => entry.startsWith("tool:")), SUBTASK_TOOL_NAMES.map((name) => `tool:${name}`));
  assert.deepEqual(plain.record.filter((entry) => entry.startsWith("active:")), SUBTASK_TOOL_NAMES.map((name) => `active:${name}:true`));
  assert.ok(plain.record.some((entry) => entry.startsWith("command:")), "Pi commands still register");
  assert.match(plain.start, /^SubtasksStart accepted: /);
  assert.equal(plain.groups, 1);

  // The Pi launch-active filter still governs exposure.
  const narrowed = await run({ activeTools: ["read", "SubtasksInspect"], withExplicitUndefined: false });
  assert.match(narrowed.start, /SubtasksStart is not currently exposed by this owner/);
  assert.match(narrowed.inspect, /^SubtasksInspect failed: /);
  assert.equal(narrowed.groups, 0);
  assert.ok(narrowed.record.includes("active:SubtasksStart:false"));
});

test("host exposure ignores a late Pi and honors live policy and catalog changes", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-review-managed-host-"));
  tempRoots.push(sourceRoot);
  const piCalls: string[] = [];
  // The owner supplies its current catalog and policy through getters.
  let catalog: string[] | undefined = ["read"];
  let allowed = true;
  const input: Record<string, unknown> = {
    pi: undefined,
    config: fixtureConfig(),
    state: createState(),
    cwd: () => sourceRoot,
    get authorizedTools() {
      const current = catalog;
      return () => current;
    },
    get liveToolCallAllowed() {
      const current = allowed;
      return () => current;
    },
    hostExposure: { actions: ["start", "inspect"] },
  };
  const manager = new ExecutionToolManager(input as never);
  input.pi = {
    registerTool() { piCalls.push("registerTool"); },
    registerCommand() { piCalls.push("registerCommand"); },
    setToolActive() { piCalls.push("setToolActive"); },
    getActiveTools: () => { piCalls.push("getActiveTools"); return ["read", "bash", ...SUBTASK_TOOL_NAMES]; },
  };
  const admission = new FixtureAdmission();
  try {
    await manager.restoreAssociations(EMPTY_ASSOCIATIONS);
    manager.sync();
    admission.admit("granted-inspect", "SubtasksInspect", { taskId: "task-any" });
    assert.match((await (manager.sharedManagedTool("inspect", admission) as SharedTool).invoke(call("granted-inspect"))).content[0].text, /^SubtasksInspect failed: /);
    // Catalog revoked: a late Pi must not become the fallback.
    catalog = undefined;
    admission.admit("late-start", "SubtasksStart", startParams("late pi"));
    const started = await (manager.sharedManagedTool("start", admission) as SharedTool).invoke(call("late-start"));
    assertManagedEnvelope(started, true, "start without catalog");
    assert.match(started.content[0].text, /requires an authoritative parent active-tool snapshot/);
    assert.equal(manager.associations().groupRoots?.length ?? 0, 0);
    admission.admit("late-add", "SubtasksAdd", { executionId: "exec-any", tasks: [queuedTask("x")] });
    assertRefused(await (manager.sharedManagedTool("add", admission) as SharedTool).invoke(call("late-add")), /SubtasksAdd is not currently exposed by this owner/, "undeclared add");
    // Policy revoked on the same manager, with the catalog restored.
    catalog = ["read"];
    allowed = false;
    admission.admit("revoked-start", "SubtasksStart", startParams("revoked"));
    assertRefused(await (manager.sharedManagedTool("start", admission) as SharedTool).invoke(call("revoked-start")), /not allowed by this owner's live call policy/, "revoked policy");
    assert.equal(manager.associations().groupRoots?.length ?? 0, 0);
    manager.sync();
    assert.deepEqual(piCalls, [], "the late Pi is never registered, activated, or read");
  } finally {
    await manager.shutdown();
    await manager.detach();
  }
});

/** Each per-kind lifecycle projection's admitted Pi executable for one group. */
function projectedAdmittedPiCommands(manager: ExecutionToolManager): Array<string | undefined> {
  const controller = (manager as unknown as { controller: Record<string, { config: { admittedPiCommand?: (group: unknown) => string | undefined } }> }).controller;
  return ["researchDeps", "inplaceDeps", "waveDeps"].map((key) => controller[key]!.config.admittedPiCommand?.({}));
}

test("a trusted host-admitted Pi executable is validated once, host-only, and reaches every lifecycle projection", async () => {
  const admitted = join(tmpdir(), "synthetic-admitted-pi", "cli.js");
  const base = () => ({
    config: fixtureConfig(),
    state: createState(),
    cwd: () => tmpdir(),
    authorizedTools: () => ["read"],
    liveToolCallAllowed: () => true,
  });

  // One read at construction; later reads of the owner's input never reach the controller.
  let reads = 0;
  const input = {
    ...base(),
    pi: undefined,
    hostExposure: { actions: ["inspect"] as SharedManagedToolAction[] },
    get admittedPiCommand() { reads += 1; return reads === 1 ? admitted : "/other/pi"; },
  };
  const host = new ExecutionToolManager(input);
  try {
    assert.equal(reads, 1, "the owner's value is read exactly once");
    assert.deepEqual(projectedAdmittedPiCommands(host), [admitted, admitted, admitted]);
    assert.equal(reads, 1, "the projections reuse the validated value");
  } finally {
    await host.shutdown();
    await host.detach();
  }

  // Without hostExposure the controller never re-reads the caller's value: a
  // getter that first answers undefined cannot install a path on a second read.
  let lateReads = 0;
  const late = new ExecutionToolManager({
    ...base(),
    pi: undefined,
    get admittedPiCommand() { lateReads += 1; return lateReads === 1 ? undefined : admitted; },
  });
  try {
    assert.equal(lateReads, 1, "the caller's value is read exactly once");
    assert.deepEqual(projectedAdmittedPiCommands(late), [undefined, undefined, undefined]);
    assert.equal(lateReads, 1);
  } finally {
    await late.shutdown();
    await late.detach();
  }

  // Host-only: refused beside a Pi host and on a no-Pi manager without hostExposure.
  const pi = { registerTool() { throw new Error("unused"); }, registerCommand() { throw new Error("unused"); } };
  assert.throws(() => new ExecutionToolManager({ ...base(), pi, admittedPiCommand: admitted }),
    /requires a managed tool host exposure without a Pi host/);
  assert.throws(() => new ExecutionToolManager({ ...base(), pi: undefined, admittedPiCommand: admitted }),
    /requires a managed tool host exposure without a Pi host/);
  for (const invalid of ["", "relative/pi", "/bin/pi\0x", 7 as unknown as string]) {
    assert.throws(() => new ExecutionToolManager({ ...base(), pi: undefined, hostExposure: { actions: ["inspect"] }, admittedPiCommand: invalid }),
      /the admitted Pi executable must be a non-empty absolute path/, JSON.stringify(invalid));
  }
  // The controller enforces the same Pi exclusion on its own input.
  assert.throws(() => new BackgroundExecutionController({ ...base(), pi, admittedPiCommand: admitted }),
    /cannot be combined with a Pi host/);

  // Absent keeps every projection on the default Pi resolution, for host and Pi managers alike.
  const plainHost = await hostFixture({ hostExposure: { actions: ["inspect"] } });
  const piManager = await hostFixture({
    pi: { registerTool() {}, registerCommand() {}, setToolActive() {}, getActiveTools: () => ["read", ...SUBTASK_TOOL_NAMES] },
  });
  try {
    assert.deepEqual(projectedAdmittedPiCommands(plainHost.manager), [undefined, undefined, undefined]);
    assert.deepEqual(projectedAdmittedPiCommands(piManager.manager), [undefined, undefined, undefined]);
  } finally {
    await plainHost.dispose();
    await piManager.dispose();
  }
});
