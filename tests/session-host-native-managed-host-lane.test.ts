/**
 * #682: production sidebar startup wiring of the native managed Start/Inspect
 * lane (`src/session-host/native-managed-host-lane.ts` and its use in
 * `src/session-host/main.ts`).
 *
 * EVIDENCE SCOPE: the composition tests use the real custody, the real native
 * owner, its real restore and association store, the real no-Pi
 * `ExecutionToolManager` and controller, the real lane delegate, real saved
 * settings files, and the real persisted MCP server-name store, under a
 * test-owned temporary root. Only the installed Pi SDK the ceiling loads is
 * the policy module's fake seam. Lane contexts are hand-built around run
 * objects the test revokes, because no provider CLI is launched. The Main
 * tests drive the real public controller through `__test.runWithDependencies`
 * with the REAL `InstanceManager`, real host ownership store, and the real
 * composition, and a fake broker/terminal; they observe exactly what Main hands
 * the manager and that host shutdown drains custody before ownership release.
 * The admitted task dispatches to an external placeholder executor (a bounded
 * keep-alive node child) that each drain stops. Every artifact, including the
 * controller's temp-directory work, stays under the owned root, which is
 * removed after each test.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import test from "node:test";

import { sharedManagedToolDescriptor, type ExecutionToolManager } from "../src/execution/tool";
import type { StatusBroker } from "../src/session-host/broker";
import type { ComposedHostFrame } from "../src/session-host/compositor";
import {
  InstanceManager,
  type InstanceManagerOptions,
  type NativeMcpLaneContext,
  type NativeMcpLaneOwner,
  type NativeMcpLaneRunScope,
} from "../src/session-host/instances";
import { __test as mainTest, type SessionHostOptions } from "../src/session-host/main";
import {
  createNativeManagedConversationOwner,
  type NativeManagedConversationOwnerOptions,
} from "../src/session-host/native-managed-conversation-owner";
import {
  createNativeManagedHostLane,
  NATIVE_MANAGED_HOST_LANE_ACTIONS,
  type NativeManagedHostLaneInput,
} from "../src/session-host/native-managed-host-lane";
import { readNativeManagedAssociations } from "../src/session-host/native-managed-association-store";
import { nativeMcpServerNamePath, readNativeMcpServerName } from "../src/session-host/native-mcp-server-name";
import type { ProfilePreparer } from "../src/session-host/profiles";
import { hostOwnershipPath, sessionHostStateDir } from "../src/session-host/roster-store";
import { toolCallFingerprint } from "../src/tool-call-fingerprint";
import { queuedTask } from "./managed-tool-fixtures";

const CONVERSATION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_CONVERSATION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const PI_FILE = "/synthetic/pi/dist/cli.js";
const PI_VERSION = "9.9.9";
const text = (result: { readonly content: readonly Record<string, unknown>[] } | undefined) =>
  String(result?.content.map((item) => item.text).join("\n"));

const CEILING = Object.freeze({
  loadSdk: () => ({
    parseArgs: () => ({ offline: true }),
    createReadToolDefinition: () => ({ name: "read", description: "Read files." }),
    createBashToolDefinition: () => ({ name: "bash", description: "Execute a command." }),
  }),
  nativePowerShellSupported: () => false,
});

function savedSettings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    executorTimeoutMs: 120_000,
    review: { activeReviewers: [] },
    externalAgents: {
      unstarted: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", "setTimeout(() => {}, 120_000)"] } },
    },
    execution: {
      workerResources: { default: { selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    ...overrides,
  };
}

const PI_WORKER_SETTINGS = savedSettings({
  execution: {
    workerResources: { default: { selection: { source: "pi", model: "provider/model-a" }, maxConcurrent: 1 } },
    routes: { execute: [{ resourceId: "default" }], research: [] },
  },
});

interface Root {
  root: string;
  agentDir: string;
  home: string;
  workspace: string;
  writeSettings(content: unknown): void;
}

/**
 * One owned root per test. The real controller places execution artifacts under
 * the platform temp directory, so it is pointed inside the root until removal.
 */
function ownedRoot(t: { after(fn: () => void | Promise<void>): void }, cleanup?: () => Promise<unknown>): Root {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "prg-native-managed-host-lane-tests-")));
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  for (const dir of [agentDir, home, workspace, artifacts]) mkdirSync(dir, { mode: 0o700 });
  mkdirSync(sessionHostStateDir(agentDir), { mode: 0o700 });
  const tempVars = ["TMPDIR", "TMP", "TEMP"] as const;
  const original = tempVars.map((key) => process.env[key]);
  for (const key of tempVars) process.env[key] = artifacts;
  t.after(async () => {
    try {
      await cleanup?.();
    } finally {
      for (const [index, key] of tempVars.entries()) {
        const value = original[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    agentDir,
    home,
    workspace,
    writeSettings: (content) => writeFileSync(join(agentDir, "review-gate.json"), JSON.stringify(content)),
  };
}

function makeRun(): { run: NativeMcpLaneRunScope; revoke(): void } {
  const controller = new AbortController();
  let current = true;
  const run: NativeMcpLaneRunScope = Object.freeze({ signal: controller.signal, isCurrent: () => current && !controller.signal.aborted });
  return { run, revoke: () => { current = false; controller.abort(); } };
}

function laneContext(
  identity: { rowId: string; backend: "claude" | "codex"; workspace: string; conversationId: string },
  run: NativeMcpLaneRunScope | undefined,
  overrides: Partial<NativeMcpLaneContext> = {},
): { context: NativeMcpLaneContext; abort(): void } {
  const request = new AbortController();
  const signal = run === undefined ? request.signal : AbortSignal.any([request.signal, run.signal]);
  const context: NativeMcpLaneContext = Object.freeze({
    ...identity,
    signal,
    isCurrent: () => !signal.aborted && (run === undefined || run.isCurrent()),
    ...(run === undefined ? {} : { run }),
    ...overrides,
  });
  return { context, abort: () => request.abort() };
}

const canonicalCatalog = () => NATIVE_MANAGED_HOST_LANE_ACTIONS.map((action) => {
  const descriptor = sharedManagedToolDescriptor(action);
  return { name: descriptor.name, description: descriptor.description, inputSchema: descriptor.parameters };
});

/** A recording wrapper around the real owner, optionally gating its preparation. */
function recordingOwners(gate?: Promise<void>) {
  const created: NativeManagedConversationOwnerOptions[] = [];
  const managers: ExecutionToolManager[] = [];
  const createOwner = (options: NativeManagedConversationOwnerOptions) => {
    created.push(options);
    const owner = createNativeManagedConversationOwner(options);
    return Object.freeze({
      delegate: owner.delegate,
      prepare: async () => {
        if (gate !== undefined) await gate;
        const result = await owner.prepare();
        const manager = result.status === "ready" ? result.manager : "retainedManager" in result ? result.retainedManager : undefined;
        if (manager !== undefined && !managers.includes(manager)) managers.push(manager);
        return result;
      },
    });
  };
  return { created, managers, createOwner };
}

function broker(): StatusBroker & { registerNativeHookSource(): never; registerNativeMcpSource(): never } {
  return {
    register() { throw new Error("no Pi child is registered in this test"); },
    registerNativeHookSource() { throw new Error("no native launch happens in this test"); },
    registerNativeMcpSource() { throw new Error("no native launch happens in this test"); },
    async dispose() {},
  } as unknown as StatusBroker & { registerNativeHookSource(): never; registerNativeMcpSource(): never };
}

function laneInput(root: Root, overrides: Partial<NativeManagedHostLaneInput> = {}): NativeManagedHostLaneInput {
  return {
    platform: "linux",
    broker: broker(),
    ownedAgentDir: root.agentDir,
    resolveSlotId: (rowId) => rowId,
    settings: { env: {}, agentDir: root.agentDir },
    pi: { executable: PI_FILE, version: PI_VERSION, launchArgs: ["--offline"] },
    ...overrides,
  };
}

test("the armed lane uses the broker, the persisted name, and the canonical early catalog; one hold per run dispatches Start and Inspect", async (t) => {
  let drain: (() => Promise<unknown>) | undefined;
  const root = ownedRoot(t, () => drain?.() ?? Promise.resolve());
  root.writeSettings(savedSettings());
  let releasePrepare!: () => void;
  const owners = recordingOwners(new Promise<void>((resolve) => { releasePrepare = resolve; }));
  const registrar = broker();
  const armed = createNativeManagedHostLane(laneInput(root, {
    broker: registrar,
    testHooks: { ceiling: CEILING, createOwner: owners.createOwner },
  }));
  assert.equal(armed.status, "armed", JSON.stringify(armed));
  if (armed.status !== "armed") return;
  drain = () => armed.host.drain();
  const { lane } = armed.host;

  // Existing broker, persisted stable name, canonical metadata only.
  assert.equal(lane.registrar, registrar);
  const persisted = readNativeMcpServerName(root.agentDir);
  assert.equal(persisted.status, "loaded");
  assert.equal(lane.serverName, persisted.status === "loaded" ? persisted.serverName : undefined);
  assert.ok(existsSync(nativeMcpServerNamePath(root.agentDir)));
  assert.deepEqual(lane.preProofTools, canonicalCatalog());
  assert.deepEqual(lane.preProofTools?.map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect"]);
  // Restarting the host keeps the same name.
  const again = createNativeManagedHostLane(laneInput(root));
  assert.equal(again.status === "armed" && again.host.lane.serverName, lane.serverName);
  await (again.status === "armed" ? again.host.drain() : undefined);
  assert.equal(owners.created.length, 0, "arming acquires nothing and prepares nothing");

  const identity = { rowId: "row-a", backend: "claude" as const, workspace: root.workspace, conversationId: CONVERSATION };
  const first = makeRun();

  // A context without the run proof never reaches an owner.
  assert.deepEqual(await lane.delegate.listTools(laneContext(identity, undefined).context), []);
  assert.equal(await lane.delegate.callTool(laneContext(identity, undefined).context, { name: "SubtasksInspect", arguments: {} }), undefined);
  assert.equal(owners.created.length, 0);

  // The first proved listing awaits the run's single preparation: never an empty interim catalog.
  let listedEarly: unknown;
  const listing = lane.delegate.listTools(laneContext(identity, first.run).context).then((tools) => { listedEarly = tools; return tools; });
  const concurrent = lane.delegate.listTools(laneContext(identity, first.run).context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listedEarly, undefined, "nothing is listed while the restore is pending");
  releasePrepare();
  assert.deepEqual((await listing).map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect"]);
  assert.deepEqual((await concurrent).map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect"]);
  assert.deepEqual((await listing).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), canonicalCatalog(),
    "the proved catalog is the same canonical metadata the host announced early");
  assert.equal(owners.created.length, 1, "one hold per proved run");
  const created = owners.created[0]!;
  assert.equal(created.run, first.run);
  assert.deepEqual({ ...created.identity }, identity);
  assert.equal(created.stateRoot, sessionHostStateDir(root.agentDir));
  assert.deepEqual(created.pi, { executable: PI_FILE, version: PI_VERSION, launchArgs: ["--offline"] });
  assert.equal(created.scopedModels, undefined, "no unverified Pi model scope is supplied");
  assert.equal(created.notify, undefined, "no callback routing is wired");

  // Actual canonical Start dispatch, durable under the exact owner.
  // One worker slot: the first task dispatches, the second stays queued.
  const args = { tasks: [queuedTask("host lane start"), queuedTask("host lane queued")] };
  const started = await lane.delegate.callTool(laneContext(identity, first.run).context, { name: "SubtasksStart", arguments: args });
  assert.equal(started?.isError, false, text(started));
  assert.equal(owners.created.length, 1, "later calls reuse the run's hold");
  const manager = owners.managers[0]!;
  const liveness = manager.startLiveness(toolCallFingerprint("SubtasksStart", args)!) as { state: string; identity?: string };
  assert.equal(liveness.state, "active");
  const controller = (manager as unknown as { controller: { groups: Map<string, { tasks: Array<{ taskId: string; state: string }> }> } }).controller;
  const [task, queued] = controller.groups.get(liveness.identity!)!.tasks;
  assert.ok(task && queued);
  assert.equal(queued.state, "queued");
  const stored = await readNativeManagedAssociations(sessionHostStateDir(root.agentDir),
    { slotId: identity.rowId, backend: identity.backend, conversationId: identity.conversationId, workspace: identity.workspace });
  assert.equal(stored.status, "loaded");
  const inspected = await lane.delegate.callTool(laneContext(identity, first.run).context, { name: "SubtasksInspect", arguments: { taskId: task.taskId } });
  assert.equal(inspected?.isError, false, text(inspected));
  assert.match(text(inspected), new RegExp(task.taskId));
  assert.equal(await lane.delegate.callTool(laneContext(identity, first.run).context, { name: "SubtasksWatch", arguments: {} }), undefined,
    "Watch stays unwired");

  // Wrong owners on a proved run reach nothing and change nothing.
  for (const overrides of [{ conversationId: OTHER_CONVERSATION }, { rowId: "row-b" }, { backend: "codex" as const }]) {
    const wrong = laneContext({ ...identity, ...overrides }, first.run).context;
    assert.deepEqual(await lane.delegate.listTools(wrong), []);
    assert.equal(await lane.delegate.callTool(wrong, { name: "SubtasksStart", arguments: { tasks: [queuedTask("wrong owner")] } }), undefined);
  }
  assert.equal(controller.groups.size, 1);

  // A cancelled request ends only that request.
  const cancelled = laneContext(identity, first.run);
  cancelled.abort();
  await assert.rejects(lane.delegate.listTools(cancelled.context));
  assert.equal((manager.startLiveness(toolCallFingerprint("SubtasksStart", args)!) as { state: string }).state, "active");

  // Host drain hands the manager off canonically and refuses later runs.
  assert.deepEqual(await armed.host.drain(), { status: "clean" });
  assert.equal(queued.state, "stopped_for_application_exit", "the canonical shutdown recorded the stop");
  assert.notEqual((manager.startLiveness(toolCallFingerprint("SubtasksStart", args)!) as { state: string }).state, "active",
    "the dispatched runtime settled");
  assert.equal(controller.groups.size, 0, "detach released the drained manager's groups");
  assert.deepEqual(await lane.delegate.listTools(laneContext(identity, first.run).context), []);
  const late = makeRun();
  assert.deepEqual(await lane.delegate.listTools(laneContext(identity, late.run).context), []);
  assert.equal(owners.created.length, 1, "a run after the drain constructs no owner");
});

test("a successor with a new runtime row restores the same roster slot only after the handoff", async (t) => {
  let drain: (() => Promise<unknown>) | undefined;
  const root = ownedRoot(t, () => drain?.() ?? Promise.resolve());
  root.writeSettings(savedSettings());
  const owners = recordingOwners();
  // A host restart resumes the conversation into the same roster slot under a fresh runtime row id.
  const armed = createNativeManagedHostLane(laneInput(root, {
    resolveSlotId: (rowId) => (rowId === "row-a" || rowId === "row-after-restart" ? "slot-a" : undefined),
    testHooks: { ceiling: CEILING, createOwner: owners.createOwner },
  }));
  assert.equal(armed.status, "armed");
  if (armed.status !== "armed") return;
  drain = () => armed.host.drain();
  const { delegate } = armed.host.lane;
  const identity = { rowId: "row-a", backend: "codex" as const, workspace: root.workspace, conversationId: CONVERSATION };
  const slotOwner = { slotId: "slot-a", backend: identity.backend, conversationId: CONVERSATION, workspace: root.workspace };

  // A runtime row the host binds to no slot reaches nothing and constructs no owner.
  const unbound = makeRun();
  assert.deepEqual(await delegate.listTools(laneContext({ ...identity, rowId: "row-unbound" }, unbound.run).context), []);
  assert.equal(await delegate.callTool(laneContext({ ...identity, rowId: "row-unbound" }, unbound.run).context,
    { name: "SubtasksStart", arguments: { tasks: [queuedTask("unbound")] } }), undefined);
  assert.equal(owners.created.length, 0);

  const first = makeRun();
  const args = { tasks: [queuedTask("first run")] };
  const started = await delegate.callTool(laneContext(identity, first.run).context, { name: "SubtasksStart", arguments: args });
  assert.equal(started?.isError, false, text(started));
  const firstManager = owners.managers[0]!;
  const controller = (firstManager as unknown as { controller: { groups: Map<string, { tasks: Array<{ taskId: string }> }> } }).controller;
  const executionId = (firstManager.startLiveness(toolCallFingerprint("SubtasksStart", args)!) as { identity?: string }).identity!;
  const taskId = controller.groups.get(executionId)!.tasks[0]!.taskId;
  assert.equal(owners.created[0]!.identity.rowId, "slot-a", "the owner is keyed by the durable roster slot");
  const stored = await readNativeManagedAssociations(sessionHostStateDir(root.agentDir), slotOwner);
  assert.equal(stored.status, "loaded", "associations persist under the slot, not the runtime row");
  assert.equal((await readNativeManagedAssociations(sessionHostStateDir(root.agentDir), { ...slotOwner, slotId: "row-a" })).status, "absent");

  first.revoke();
  await assert.rejects(delegate.listTools(laneContext(identity, first.run).context), /ended before its owner was prepared/,
    "a revoked run reaches nothing");
  const second = makeRun();
  const resumed = laneContext({ ...identity, rowId: "row-after-restart" }, second.run).context;
  const relisted = await delegate.listTools(resumed);
  assert.deepEqual(relisted.map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect"]);
  assert.equal(owners.created.length, 2);
  const secondManager = owners.managers[1]!;
  assert.notEqual(secondManager, firstManager);
  assert.equal(controller.groups.size, 0, "the first manager was detached before the successor restored");
  assert.equal(owners.created[1]!.identity.rowId, "slot-a");
  assert.deepEqual(await delegate.listTools(laneContext(identity, second.run).context), [],
    "the old runtime row cannot use the successor's hold even though it resolves to the same slot");
  const inspected = await delegate.callTool(resumed, { name: "SubtasksInspect", arguments: { taskId } });
  assert.equal(inspected?.isError, false, text(inspected));
  assert.match(text(inspected), new RegExp(taskId), "the restarted row finds the task its previous run recorded");
  assert.deepEqual(await armed.host.drain(), { status: "clean" });
});

test("unsupported hosts arm no lane: Pi-only broker, refused name, unavailable or Pi-routed settings", async (t) => {
  const root = ownedRoot(t);
  root.writeSettings(savedSettings());
  const piOnly = { register() { throw new Error("unused"); }, registerNativeHookSource() { throw new Error("unused"); }, async dispose() {} };
  assert.deepEqual(createNativeManagedHostLane(laneInput(root, { broker: piOnly })), { status: "unavailable", reason: "no-registrar" });
  assert.deepEqual(createNativeManagedHostLane(laneInput(root, {
    testHooks: { readOrCreateServerName: () => ({ status: "refused", reason: "unsafe-entry", message: "refused" }) },
  })), { status: "unavailable", reason: "server-name-refused" });
  assert.equal(existsSync(nativeMcpServerNamePath(root.agentDir)), false, "no name is minted for a refused or unsupported host");
  assert.deepEqual(createNativeManagedHostLane(laneInput(root, { ownedAgentDir: join(root.root, "missing") })),
    { status: "unavailable", reason: "state-root-unavailable" });

  root.writeSettings(PI_WORKER_SETTINGS);
  assert.deepEqual(createNativeManagedHostLane(laneInput(root)), { status: "unavailable", reason: "unsupported-workers" });
  root.writeSettings(savedSettings({ execution: { workerResources: {}, routes: { execute: [], research: [] } } }));
  assert.deepEqual(createNativeManagedHostLane(laneInput(root)), { status: "unavailable", reason: "unsupported-workers" });
  // External workers must resolve exactly as ExecutionToolManager.sync() requires before it exposes the tools.
  const workerRoutes = { workerResources: { default: { selection: { source: "external", id: "worker" }, maxConcurrent: 1 } }, routes: { execute: [{ resourceId: "default" }], research: [] } };
  for (const [label, externalAgents] of [
    ["dangling worker reference", {}],
    ["review-only agent", { worker: { adapter: "run-as-binary", command: process.execPath, review: { protocol: "pi-reviewer-json-v1" } } }],
  ] as const) {
    root.writeSettings(savedSettings({ externalAgents, execution: workerRoutes }));
    assert.deepEqual(createNativeManagedHostLane(laneInput(root)), { status: "unavailable", reason: "unsupported-workers" }, label);
    assert.equal(existsSync(nativeMcpServerNamePath(root.agentDir)), false, `${label}: no server name is minted`);
  }
  // Native MCP launch preparation declines Windows: nothing is armed or minted there.
  root.writeSettings(savedSettings());
  for (const platform of ["win32", "freebsd"] as const) {
    assert.deepEqual(createNativeManagedHostLane(laneInput(root, { platform })), { status: "unavailable", reason: "platform-unsupported" }, platform);
  }
  assert.equal(existsSync(nativeMcpServerNamePath(root.agentDir)), false);
  root.writeSettings("{ not json");
  assert.deepEqual(createNativeManagedHostLane(laneInput(root)), { status: "unavailable", reason: "settings-unavailable" });
  root.writeSettings(savedSettings());
  assert.deepEqual(createNativeManagedHostLane(laneInput(root, { settings: { env: { PI_REVIEW_GATE_DISABLED: "1" }, agentDir: root.agentDir } })),
    { status: "unavailable", reason: "settings-unavailable" });
  assert.equal(existsSync(nativeMcpServerNamePath(root.agentDir)), false);
});

test("settings switched to Pi workers after arming refuse construction: the lane lists nothing", async (t) => {
  let drain: (() => Promise<unknown>) | undefined;
  const root = ownedRoot(t, () => drain?.() ?? Promise.resolve());
  root.writeSettings(savedSettings());
  const armed = createNativeManagedHostLane(laneInput(root, { testHooks: { ceiling: CEILING } }));
  assert.equal(armed.status, "armed");
  if (armed.status !== "armed") return;
  drain = () => armed.host.drain();
  root.writeSettings(PI_WORKER_SETTINGS);
  const identity = { rowId: "row-a", backend: "claude" as const, workspace: root.workspace, conversationId: CONVERSATION };
  const run = makeRun();
  assert.deepEqual(await armed.host.lane.delegate.listTools(laneContext(identity, run.run).context), []);
  assert.equal(await armed.host.lane.delegate.callTool(laneContext(identity, run.run).context, { name: "SubtasksStart", arguments: { tasks: [queuedTask("pi")] } }), undefined);
  assert.deepEqual(await armed.host.drain(), { status: "clean" });
});

/* ------------------------------------------------------------------------- *
 * Real Main startup hookup                                                   *
 * ------------------------------------------------------------------------- */

class FakeInput extends EventEmitter {
  readonly isTTY = true;
  readableEnded = false;
}

class FakeOutput extends EventEmitter {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
  write(): boolean { return true; }
}

class FakeTerminal {
  kittyProtocolActive = false;
  modifyOtherKeysActive = false;
  columns = 100;
  rows = 40;
  inputHandler?: (data: string) => void;
  start(onInput: (data: string) => void): void { this.inputHandler = onInput; }
  emitInput(data: string): void { this.inputHandler?.(data); }
  write(): void {}
  async drainInput(): Promise<void> {}
  stop(): void {}
}

class FakeObserver {
  flags = 0;
  private resolveWait?: (flags: number) => void;
  feed(): void {}
  wait(): Promise<number> { return new Promise((resolve) => { this.resolveWait = resolve; }); }
  settle(): void { this.resolveWait?.(0); }
  dispose(): void { this.resolveWait?.(0); }
}

class FakeWriter {
  start(): void {}
  submit(_frame: ComposedHostFrame): void {}
  async close(): Promise<boolean> { return true; }
}

type MainTestDependencies = NonNullable<Parameters<typeof mainTest.runWithDependencies>[1]>;

interface MainRun {
  result: Promise<number>;
  terminal: FakeTerminal;
  observer: FakeObserver;
  events: string[];
  reports: string[];
  managerOptions(): InstanceManagerOptions | undefined;
  laneInputs: NativeManagedHostLaneInput[];
  owners: ReturnType<typeof recordingOwners>;
  hostBroker: StatusBroker;
}

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function startMain(root: Root, options: {
  readonly broker?: StatusBroker;
  readonly hosting?: boolean;
  readonly failDrain?: boolean;
  readonly args?: readonly string[];
  readonly platform?: NodeJS.Platform;
} = {}): MainRun {
  const terminal = new FakeTerminal();
  const observer = new FakeObserver();
  const events: string[] = [];
  const reports: string[] = [];
  const laneInputs: NativeManagedHostLaneInput[] = [];
  const owners = recordingOwners();
  const hostBroker = options.broker ?? broker();
  const originalDispose = hostBroker.dispose.bind(hostBroker);
  hostBroker.dispose = async () => { events.push("broker.dispose"); await originalDispose(); };
  let captured: InstanceManagerOptions | undefined;
  const hostOptions: SessionHostOptions = {
    packageRoot: process.cwd(),
    stateRoot: join(root.root, "broker-root"),
    args: [...(options.args ?? ["--offline"])],
    env: { PATH: process.env.PATH, HOME: root.home },
  };
  const dependencies: MainTestDependencies = {
    platform: options.platform ?? "linux",
    nodeVersion: "22.23.5",
    stdin: new FakeInput(),
    stdout: new FakeOutput() as unknown as Writable & EventEmitter & { isTTY?: boolean },
    signals: new EventEmitter(),
    resolvePi: () => ({ file: PI_FILE, version: PI_VERSION }),
    createBroker: async () => hostBroker,
    createManager: (managerOptions) => {
      captured = managerOptions;
      events.push("manager.create");
      return new InstanceManager(managerOptions) as never;
    },
    createTerminal: () => terminal as never,
    createObserver: () => observer as never,
    createWriter: () => new FakeWriter() as never,
    createSessionSetup: () => ({
      nativeSetup: true,
      nativeAgentDir: root.agentDir,
      profileRegistry: { prepare: () => { throw new Error("no session is prepared in this test"); } } satisfies ProfilePreparer,
    }),
    nativeCliHosting: () => (options.hosting === false
      ? { targets: [] }
      : {
        targets: [{ id: "claude", backend: "claude", label: "Claude Code (default)" }],
        launch: async () => { throw new Error("no native launch happens in this test"); },
      }),
    listSavedCatalog: async () => { throw new Error("no saved listing in this test"); },
    createNativeManagedHostLane: (input) => {
      laneInputs.push(input);
      const armed = createNativeManagedHostLane({
        ...input,
        // This fixture calls the delegate directly without creating a provider row.
        resolveSlotId: (rowId) => (rowId === "row-main" ? "slot-main" : input.resolveSlotId(rowId)),
        testHooks: { ceiling: CEILING, createOwner: owners.createOwner },
      });
      if (armed.status !== "armed") return armed;
      return {
        status: "armed",
        host: {
          lane: armed.host.lane,
          drain: async (drainOptions) => {
            events.push("drain.start");
            const result = await armed.host.drain(drainOptions);
            events.push(`drain.${result.status}`);
            return options.failDrain === true ? { status: "failed" } : result;
          },
        },
      };
    },
    reportError: (message) => reports.push(message),
  };
  const result = mainTest.runWithDependencies(hostOptions, dependencies);
  return { result, terminal, observer, events, reports, managerOptions: () => captured, laneInputs, owners, hostBroker };
}

async function mainReady(run: MainRun): Promise<InstanceManagerOptions> {
  for (let turn = 0; turn < 20 && run.managerOptions() === undefined; turn += 1) await nextTurn();
  const options = run.managerOptions();
  assert.ok(options, "Main constructed the real manager");
  run.observer.settle();
  await nextTurn();
  await nextTurn();
  return options;
}

async function quitMain(run: MainRun): Promise<number> {
  run.terminal.emitInput("q");
  run.terminal.emitInput("y");
  return run.result;
}

test("Main hands the real manager the native lane from host facts and drains its custody before releasing ownership", async (t) => {
  let pending: MainRun | undefined;
  const root = ownedRoot(t, async () => {
    if (pending) {
      pending.observer.settle();
      await quitMain(pending).catch(() => undefined);
    }
  });
  root.writeSettings(savedSettings());
  const run = startMain(root);
  pending = run;
  const options = await mainReady(run);

  const lane = options.nativeMcpLane as NativeMcpLaneOwner | undefined;
  assert.ok(lane, "the production host supplies the native lane");
  assert.equal(lane.registrar, run.hostBroker, "the lane registrar is the host's one broker");
  assert.equal(options.nativeHookRegistrar, run.hostBroker, "beside the existing observation pair");
  assert.ok(options.nativeStatusObserverFactory);
  const persisted = readNativeMcpServerName(root.agentDir);
  assert.equal(persisted.status, "loaded");
  assert.equal(lane.serverName, persisted.status === "loaded" ? persisted.serverName : undefined, "the persisted stable server name");
  assert.deepEqual(lane.preProofTools, canonicalCatalog());

  assert.equal(run.laneInputs.length, 1);
  const input = run.laneInputs[0]!;
  assert.equal(input.broker, run.hostBroker);
  assert.equal(input.ownedAgentDir, root.agentDir);
  assert.equal(input.resolveSlotId("row-main"), undefined, "Main refuses a runtime row its roster does not bind");
  assert.equal(input.settings.agentDir, root.agentDir);
  assert.equal(input.settings.env.HOME, root.home);
  assert.equal(input.settings.resolvedHomeDir, root.home);
  assert.deepEqual(input.pi, { executable: PI_FILE, version: PI_VERSION, launchArgs: ["--offline"] });
  assert.equal(existsSync(hostOwnershipPath(root.agentDir)), true, "the host owns the agent directory");

  // The manager's lane delegate is the composed one: a proved run dispatches canonically.
  const identity = { rowId: "row-main", backend: "claude" as const, workspace: root.workspace, conversationId: CONVERSATION };
  const proved = makeRun();
  const listed = await lane.delegate.listTools(laneContext(identity, proved.run).context);
  assert.deepEqual(listed.map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect"]);
  const args = { tasks: [queuedTask("main start"), queuedTask("main queued")] };
  const started = await lane.delegate.callTool(laneContext(identity, proved.run).context, { name: "SubtasksStart", arguments: args });
  assert.equal(started?.isError, false, text(started));
  const manager = run.owners.managers[0]!;
  const liveness = manager.startLiveness(toolCallFingerprint("SubtasksStart", args)!) as { state: string; identity?: string };
  assert.equal(liveness.state, "active");
  const controller = (manager as unknown as { controller: { groups: Map<string, { tasks: Array<{ state: string }> }> } }).controller;
  const queued = controller.groups.get(liveness.identity!)!.tasks[1]!;
  assert.equal(queued.state, "queued");

  pending = undefined;
  assert.equal(await quitMain(run), 0, run.reports.join("\n"));
  assert.deepEqual(run.events.filter((event) => event.startsWith("drain") || event === "broker.dispose"),
    ["drain.start", "drain.clean", "broker.dispose"], "the drain settles before the broker is disposed");
  assert.equal(queued.state, "stopped_for_application_exit", "host close handed the work off canonically");
  assert.notEqual((manager.startLiveness(toolCallFingerprint("SubtasksStart", args)!) as { state: string }).state, "active");
  assert.equal(controller.groups.size, 0);
  assert.equal(existsSync(hostOwnershipPath(root.agentDir)), false, "ownership is released only after a clean drain");
  assert.deepEqual(await lane.delegate.listTools(laneContext(identity, makeRun().run).context), [], "nothing is exposed after shutdown");
});

test("a drain that does not hand off cleanly keeps agent-directory ownership", async (t) => {
  const root = ownedRoot(t);
  root.writeSettings(savedSettings());
  const run = startMain(root, { failDrain: true });
  const options = await mainReady(run);
  assert.ok(options.nativeMcpLane);
  assert.equal(await quitMain(run), 1);
  assert.ok(run.reports.some((report) => /did not hand off cleanly/.test(report)), run.reports.join("\n"));
  assert.equal(existsSync(hostOwnershipPath(root.agentDir)), true, "ownership is retained (fail closed)");
});

test("Pi-only brokers, hosts without native hosting, and Pi-routed settings start exactly as before", async (t) => {
  const root = ownedRoot(t);
  const cases: Array<{ name: string; settings: unknown; options: Parameters<typeof startMain>[1]; composed: boolean }> = [
    {
      name: "broker without the native MCP family",
      settings: savedSettings(),
      options: { broker: { register() { throw new Error("unused"); }, registerNativeHookSource() { throw new Error("unused"); }, async dispose() {} } as unknown as StatusBroker },
      composed: true,
    },
    { name: "no native hosting", settings: savedSettings(), options: { hosting: false }, composed: false },
    { name: "pi workers", settings: PI_WORKER_SETTINGS, options: {}, composed: true },
  ];
  for (const scenario of cases) {
    root.writeSettings(scenario.settings);
    const run = startMain(root, scenario.options);
    const options = await mainReady(run);
    assert.equal(options.nativeMcpLane, undefined, `${scenario.name}: no lane`);
    assert.equal(run.laneInputs.length, scenario.composed ? 1 : 0, `${scenario.name}: composition consulted only with native hosting`);
    assert.equal(await quitMain(run), 0, `${scenario.name}: ${run.reports.join("\n")}`);
    assert.equal(run.events.includes("drain.start"), false, `${scenario.name}: nothing to drain`);
    assert.equal(existsSync(hostOwnershipPath(root.agentDir)), false, `${scenario.name}: ownership released`);
  }
  assert.equal(existsSync(nativeMcpServerNamePath(root.agentDir)), false, "an unarmed host mints no server name");
});

test("a Windows host keeps its native observation pair but arms no MCP lane and mints no server name", async (t) => {
  const root = ownedRoot(t);
  root.writeSettings(savedSettings());
  const run = startMain(root, { platform: "win32" });
  const options = await mainReady(run);
  assert.equal(options.nativeHookRegistrar, run.hostBroker, "the existing native observation pair stays installed");
  assert.ok(options.nativeStatusObserverFactory);
  assert.equal(options.nativeMcpLane, undefined, "native MCP launch preparation declines Windows, so no lane is armed");
  assert.equal(run.laneInputs.length, 1);
  assert.equal(run.laneInputs[0]!.platform, "win32", "Main passes its own platform fact");
  assert.equal(existsSync(nativeMcpServerNamePath(root.agentDir)), false, "no server name is minted on Windows");
  assert.equal(await quitMain(run), 0, run.reports.join("\n"));
  assert.equal(run.events.includes("drain.start"), false);
});
