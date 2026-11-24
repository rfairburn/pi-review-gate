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
 *
 * SessionHosts/SessionSpawn on the same lane: the lane-level tests use recording
 * resolvers and spy capabilities; the end-to-end test drives the REAL
 * `InstanceManager` with the real composed lane through the registered MCP
 * endpoint, with a fake provider launch, synthetic PTY, synthetic observer, and
 * spy routed/inspection host callbacks (no provider binary, relay, or peer).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import test from "node:test";

import { sharedManagedToolDescriptor, type ExecutionToolManager } from "../src/execution/tool";
import type { StatusBroker } from "../src/session-host/broker";
import type { ComposedHostFrame } from "../src/session-host/compositor";
import {
  InstanceManager,
  type CreateInstanceOptions,
  type InstanceManagerOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type NativeCliLaunchDescriptor,
  type NativeMcpLaneContext,
  type NativeMcpLaneOwner,
  type NativeMcpLaneRunScope,
  type NativeStatusObserverContext,
} from "../src/session-host/instances";
import type { NativeMcpRegistration, SessionHostsRequestContext } from "../src/session-host/broker";
import { sessionHostsToolDefinition } from "../src/session-host/hosts-tool";
import type { NativeMcpLaunchOutcome } from "../src/session-host/native-mcp-launch-prep";
import type { NativeMcpToolEndpoint } from "../src/session-host/native-mcp-stdio";
import type { NativeSessionToolScope } from "../src/session-host/native-session-tool-delegate";
import type { SessionHostsSnapshot, SessionSpawnInput, SessionSpawnOutcome } from "../src/session-host/protocol";
import type { NativeCliBackend } from "../src/session-host/session-backend";
import type { SessionHostSpawnCapability } from "../src/session-host/spawn-capability";
import { sessionSpawnToolDefinition } from "../src/session-host/spawn-tool";
import { __test as mainTest, type SessionHostOptions } from "../src/session-host/main";
import {
  createNativeManagedConversationOwner,
  type NativeManagedConversationOwnerOptions,
} from "../src/session-host/native-managed-conversation-owner";
import {
  createNativeManagedHostLane,
  NATIVE_MANAGED_HOST_LANE_ACTIONS,
  nativeManagedHostLaneDeliveryTools,
  nativeManagedHostLanePreProofTools,
  type NativeManagedHostLaneInput,
} from "../src/session-host/native-managed-host-lane";
import { readNativeManagedAssociations } from "../src/session-host/native-managed-association-store";
import { nativeMcpServerNamePath, readNativeMcpServerName } from "../src/session-host/native-mcp-server-name";
import { createPeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permissions";
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
  const stateDir = sessionHostStateDir(agentDir);
  mkdirSync(stateDir, { mode: 0o700 });
  // Windows ignores POSIX mode bits and the new directory inherits the parent
  // DACL, so on an actual Windows host the fixture-owned state directory is
  // protected with the existing production policy; POSIX is unchanged. A
  // refusal removes the owned root before teardown is registered.
  if (process.platform === "win32") {
    try {
      createPeerStatePermissionPolicy().protectCreatedDirectory(stateDir);
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }
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

/** How many managed entries lead every native lane listing. */
const MANAGED_COUNT = NATIVE_MANAGED_HOST_LANE_ACTIONS.length;
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
  assert.deepEqual(lane.preProofTools?.map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"]);
  assert.equal(lane.deliveryTools, undefined, "without a delivery accessor no Watch metadata is advertised");
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
  assert.deepEqual((await listing).map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"]);
  assert.deepEqual((await concurrent).map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"]);
  assert.deepEqual((await listing).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), canonicalCatalog(),
    "the proved catalog is the same canonical metadata the host announced early");
  assert.equal(owners.created.length, 1, "one hold per proved run");
  const created = owners.created[0]!;
  assert.equal(created.run, first.run);
  assert.deepEqual({ ...created.identity }, identity);
  assert.equal(created.stateRoot, sessionHostStateDir(root.agentDir));
  assert.deepEqual(created.pi, { executable: PI_FILE, version: PI_VERSION, launchArgs: ["--offline"] });
  assert.equal(created.scopedModels, undefined, "without a host scope none is supplied");
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
  assert.deepEqual(relisted.map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"]);
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

test("private session-host state arms the real managed lane under a 0775 agent directory", {
  skip: process.platform !== "linux" && "Linux mode regression",
}, async (t) => {
  let drain: (() => Promise<unknown>) | undefined;
  const root = ownedRoot(t, () => drain?.() ?? Promise.resolve());
  root.writeSettings(savedSettings());
  chmodSync(root.agentDir, 0o775);
  const armed = createNativeManagedHostLane(laneInput(root));
  assert.equal(armed.status, "armed");
  if (armed.status !== "armed") return;
  drain = () => armed.host.drain();
  assert.ok(existsSync(nativeMcpServerNamePath(root.agentDir)));
});

test("unsupported hosts arm no lane: Pi-only broker, refused name, unavailable or unresolvable worker settings", async (t) => {
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
  // Native MCP launch preparation declines any platform but Linux, macOS, and
  // Windows: nothing is armed or minted there.
  root.writeSettings(savedSettings());
  for (const platform of ["freebsd", "openbsd", "aix", "sunos", "android"] as const) {
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

test("a Windows host lane exposes the managed catalog through the same proof and owner, with no Watch absent a sender", async (t) => {
  // Composition only: the platform fact selects the lane; the server-name
  // store, custody, owner, and settings run on this test host's filesystem, so
  // this is not Windows filesystem or provider-launch evidence.
  let drain: (() => Promise<unknown>) | undefined;
  const root = ownedRoot(t, () => drain?.() ?? Promise.resolve());
  root.writeSettings(savedSettings());
  const owners = recordingOwners();
  const registrar = broker();
  const armed = createNativeManagedHostLane(laneInput(root, {
    platform: "win32",
    broker: registrar,
    testHooks: { ceiling: CEILING, createOwner: owners.createOwner },
  }));
  assert.equal(armed.status, "armed", JSON.stringify(armed));
  if (armed.status !== "armed") return;
  drain = () => armed.host.drain();
  const { lane } = armed.host;
  assert.equal(lane.registrar, registrar, "the host's one existing broker");
  const persisted = readNativeMcpServerName(root.agentDir);
  assert.equal(persisted.status, "loaded");
  assert.equal(lane.serverName, persisted.status === "loaded" ? persisted.serverName : undefined, "the persisted stable server name");
  assert.deepEqual(lane.preProofTools, canonicalCatalog(), "the same canonical early catalog as POSIX");
  assert.equal(lane.deliveryTools, undefined, "no callback accessor: no Watch metadata");
  assert.equal(owners.created.length, 0, "arming acquires nothing");

  for (const backend of ["claude", "codex"] as const) {
    const identity = { rowId: `row-${backend}`, backend, workspace: root.workspace, conversationId: backend === "claude" ? CONVERSATION : OTHER_CONVERSATION };
    // Without the exact run proof nothing is reached.
    assert.deepEqual(await lane.delegate.listTools(laneContext(identity, undefined).context), [], `${backend}: unproved listing`);
    assert.equal(await lane.delegate.callTool(laneContext(identity, undefined).context, { name: "SubtasksInspect", arguments: {} }), undefined);
    const proved = makeRun();
    const listed = await lane.delegate.listTools(laneContext(identity, proved.run).context);
    assert.deepEqual(listed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), canonicalCatalog(),
      `${backend}: the proved catalog is the canonical metadata and lists no Watch`);
    assert.equal(listed.some((tool) => tool.name === "SubtasksWatch"), false);
    const created = owners.created.at(-1)!;
    assert.equal(created.run, proved.run, `${backend}: one hold for the proved run`);
    assert.deepEqual({ ...created.identity }, identity);
    assert.equal(created.nativeEventSink, undefined, `${backend}: no delivery sink without an accessor`);
    assert.equal(created.watchDeliveryCurrent, undefined, `${backend}: no Watch predicate without a sink`);
    assert.equal(await lane.delegate.callTool(laneContext(identity, proved.run).context, { name: "SubtasksWatch", arguments: {} }), undefined,
      `${backend}: Watch is not exposed`);
    const args = { tasks: [queuedTask(`windows ${backend} start`)] };
    const started = await lane.delegate.callTool(laneContext(identity, proved.run).context, { name: "SubtasksStart", arguments: args });
    assert.equal(started?.isError, false, text(started));
    const manager = owners.managers.at(-1)!;
    const liveness = manager.startLiveness(toolCallFingerprint("SubtasksStart", args)!) as { state: string; identity?: string };
    assert.equal(liveness.state, "active", `${backend}: the canonical Start dispatched under the exact owner`);
    const controller = (manager as unknown as { controller: { groups: Map<string, { tasks: Array<{ taskId: string }> }> } }).controller;
    const taskId = controller.groups.get(liveness.identity!)!.tasks[0]!.taskId;
    const inspected = await lane.delegate.callTool(laneContext(identity, proved.run).context, { name: "SubtasksInspect", arguments: { taskId } });
    assert.equal(inspected?.isError, false, text(inspected));
    assert.match(text(inspected), new RegExp(taskId));
    // A different conversation on the same proved run reaches nothing.
    const wrong = laneContext({ ...identity, conversationId: backend === "claude" ? OTHER_CONVERSATION : CONVERSATION }, proved.run).context;
    assert.deepEqual(await lane.delegate.listTools(wrong), []);
  }
  assert.equal(owners.created.length, 2, "one hold per proved run");
  assert.deepEqual(await armed.host.drain(), { status: "clean" });
  drain = undefined;
});

test("Pi worker settings arm the lane; owners get the admitted executable and the host's model scope", async (t) => {
  let drain: (() => Promise<unknown>) | undefined;
  const root = ownedRoot(t, () => drain?.() ?? Promise.resolve());
  // A mixed catalog keeps resolving external eligibility; an unresolvable external worker still refuses.
  const mixed = {
    workerResources: {
      default: { selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 },
      local: { selection: { source: "pi", model: "provider/model-a" }, maxConcurrent: 1 },
    },
    routes: { execute: [{ resourceId: "default" }, { resourceId: "local" }], research: [] },
  };
  root.writeSettings(savedSettings({ externalAgents: {}, execution: mixed }));
  assert.deepEqual(createNativeManagedHostLane(laneInput(root)), { status: "unavailable", reason: "unsupported-workers" });
  assert.equal(existsSync(nativeMcpServerNamePath(root.agentDir)), false);

  root.writeSettings(PI_WORKER_SETTINGS);
  const piOnly = createNativeManagedHostLane(laneInput(root));
  assert.equal(piOnly.status, "armed", JSON.stringify(piOnly));
  if (piOnly.status === "armed") assert.deepEqual(await piOnly.host.drain(), { status: "clean" });

  root.writeSettings(savedSettings({ execution: mixed }));
  const owners = recordingOwners();
  const scope = ["provider/model-a", "provider/model-b"];
  const armed = createNativeManagedHostLane(laneInput(root, {
    scopedModels: scope,
    testHooks: { ceiling: CEILING, createOwner: owners.createOwner },
  }));
  assert.equal(armed.status, "armed", JSON.stringify(armed));
  if (armed.status !== "armed") return;
  drain = () => armed.host.drain();
  scope.push("provider/late");
  const identity = { rowId: "row-a", backend: "claude" as const, workspace: root.workspace, conversationId: CONVERSATION };
  const run = makeRun();
  assert.deepEqual((await armed.host.lane.delegate.listTools(laneContext(identity, run.run).context)).map((tool) => tool.name),
    ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"]);
  assert.equal(owners.created.length, 1);
  assert.deepEqual(owners.created[0]!.scopedModels, ["provider/model-a", "provider/model-b"], "the host scope is bound once at arming");
  assert.deepEqual(owners.created[0]!.pi, { executable: PI_FILE, version: PI_VERSION, launchArgs: ["--offline"] });
  const manager = owners.managers[0]!;
  const controller = (manager as unknown as { controller: Record<string, unknown> }).controller as {
    scopedModels: string[];
    waveDeps: { config: { admittedPiCommand?: (group: unknown) => string | undefined } };
  };
  assert.deepEqual(controller.scopedModels, ["provider/model-a", "provider/model-b"]);
  assert.equal(controller.waveDeps.config.admittedPiCommand?.({}), PI_FILE, "Pi workers launch through the admitted executable");
  assert.deepEqual(await armed.host.drain(), { status: "clean" });
});

/* ------------------------------------------------------------------------- *
 * SessionHosts / SessionSpawn on the same armed lane                         *
 * ------------------------------------------------------------------------- */

const SESSION_FACTS = Object.freeze({ titleColumns: 33, inspection: true, createWorkspace: true });

/** A spy routed capability with the given title snapshot; it records every effect. */
function spyCapability(titleColumns: number = SESSION_FACTS.titleColumns) {
  const spawned: SessionSpawnInput[] = [];
  let inspected = 0;
  const capability: SessionHostSpawnCapability = Object.freeze({
    titleColumns,
    routing: true,
    createWorkspace: true,
    spawn: async (input: SessionSpawnInput) => { spawned.push(input); return "started" as const; },
    inspectHosts: async () => {
      inspected += 1;
      return { outcome: "complete" as const, snapshot: { ownKinds: ["claude" as const], hosts: [] } };
    },
  });
  return { capability, spawned, inspected: () => inspected };
}

/** The canonical definitions for a capability, reduced to the early-catalog shape. */
const canonicalSessionCatalog = (capability: SessionHostSpawnCapability) =>
  [sessionHostsToolDefinition(capability)!, sessionSpawnToolDefinition(capability)!]
    .map((definition) => ({ name: definition.name, description: definition.description, inputSchema: definition.parameters }));

/** The complete canonical MCP descriptors the proved delegate publishes for a capability. */
const canonicalSessionDescriptors = (capability: SessionHostSpawnCapability) => {
  const hosts = sessionHostsToolDefinition(capability)!;
  const spawn = sessionSpawnToolDefinition(capability)!;
  return [
    { name: hosts.name, description: hosts.description, inputSchema: hosts.parameters, outputSchema: hosts.outputSchema, annotations: { ...hosts.annotations } },
    { name: spawn.name, description: spawn.description, inputSchema: spawn.parameters },
  ];
};

/**
 * The early catalog's ONLY wording change: the two title-space sentences name
 * the host-startup snapshot. Mapping them back must give the canonical text.
 */
function asLaunchWording(value: unknown, columns: number): unknown {
  return JSON.parse(JSON.stringify(value)
    .replaceAll(`snapshot at host startup was ${columns} terminal columns`, `snapshot at child launch is ${columns} terminal columns`)
    .replaceAll(`At host startup, the host's visible-layout sidebar title-space snapshot was ${columns} terminal columns.`,
      `At child launch, the host's visible-layout sidebar title-space snapshot is ${columns} terminal columns.`));
}

/** Asserts the early session entries are the canonical ones up to the documented bounded differences. */
function assertEarlySessionEntries(early: readonly { name: string; description?: string; inputSchema: Record<string, unknown> }[], capability: SessionHostSpawnCapability): void {
  const [hostsEarly, spawnEarly] = early;
  const [hostsCanonical, spawnCanonical] = canonicalSessionCatalog(capability);
  const columns = capability.titleColumns;
  // SessionHosts: canonical name, description, and input schema; the manager's
  // pre-proof copy admits no outputSchema or annotations.
  assert.deepEqual(hostsEarly, hostsCanonical);
  // SessionSpawn: both title-space references name the host-startup snapshot ...
  assert.match(spawnEarly!.description!, new RegExp(`snapshot at host startup was ${columns} terminal columns`));
  assert.doesNotMatch(JSON.stringify(spawnEarly), /at child launch|At child launch/);
  const titleField = (spawnEarly!.inputSchema.properties as Record<string, { description: string }>).title!.description;
  assert.match(titleField, new RegExp(`^Friendly title for the new child\\. At host startup, the host's visible-layout sidebar title-space snapshot was ${columns} terminal columns\\.`));
  // ... and otherwise equal the canonical definition exactly.
  assert.deepEqual(asLaunchWording(spawnEarly, columns), spawnCanonical);
}

/** A scope for exactly this context, echoing its identity and exact run object. */
function scopeFor(context: NativeMcpLaneContext, capability: SessionHostSpawnCapability): NativeSessionToolScope {
  return Object.freeze({
    owner: Object.freeze({
      rowId: context.rowId,
      backend: context.backend,
      workspace: context.workspace,
      conversationId: context.conversationId,
      run: context.run!,
    }),
    capability,
  });
}

const SPAWN_REQUEST = { workspace: "/synthetic/child", title: "Sibling", prompt: "exact prompt", kind: "codex" as const };

test("session tools: canonical early metadata, the original proved context, and no dependence on the managed owner", async (t) => {
  let drain: (() => Promise<unknown>) | undefined;
  let releasePrepare: (() => void) | undefined;
  // Cleanup opens the synthetic restore gate before draining, so a failed
  // assertion can never leave custody (and the owned root) waiting on it.
  const root = ownedRoot(t, async () => {
    releasePrepare?.();
    await drain?.();
  });
  root.writeSettings(savedSettings());
  const owners = recordingOwners(new Promise<void>((resolve) => { releasePrepare = resolve; }));
  const spy = spyCapability();
  const resolved: NativeMcpLaneContext[] = [];
  let answer: ((context: NativeMcpLaneContext) => NativeSessionToolScope | undefined) = (context) => scopeFor(context, spy.capability);
  const armed = createNativeManagedHostLane(laneInput(root, {
    // The runtime row is bound to a DIFFERENT durable slot; session tools must not see it.
    resolveSlotId: (rowId) => (rowId === "row-a" ? "slot-a" : undefined),
    sessionTools: {
      resolveScope: (context) => { resolved.push(context); return answer(context); },
      startup: SESSION_FACTS,
    },
    testHooks: { ceiling: CEILING, createOwner: owners.createOwner },
  }));
  assert.equal(armed.status, "armed", JSON.stringify(armed));
  if (armed.status !== "armed") return;
  drain = () => armed.host.drain();
  const { lane } = armed.host;

  // Early discovery: the managed entries, then the canonical session metadata for the host facts.
  assert.deepEqual(lane.preProofTools?.map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean", "SessionHosts", "SessionSpawn"]);
  assert.deepEqual(lane.preProofTools?.slice(0, MANAGED_COUNT), canonicalCatalog());
  assertEarlySessionEntries(lane.preProofTools!.slice(MANAGED_COUNT), spy.capability);
  assert.deepEqual(lane.preProofTools, nativeManagedHostLanePreProofTools(SESSION_FACTS));
  assert.equal(lane.deliveryTools, undefined, "Watch never rides the session tools");
  assert.equal(resolved.length, 0, "arming consults no session authority");
  assert.equal(owners.created.length, 0);

  const identity = { rowId: "row-a", backend: "claude" as const, workspace: root.workspace, conversationId: CONVERSATION };
  const run = makeRun();

  // No authority before proof: without the run proof the resolver is never reached.
  const unproved = laneContext(identity, undefined).context;
  assert.deepEqual(await lane.delegate.listTools(unproved), []);
  assert.equal(await lane.delegate.callTool(unproved, { name: "SessionSpawn", arguments: { ...SPAWN_REQUEST } }), undefined);
  assert.equal(resolved.length, 0);
  assert.deepEqual(spy.spawned, []);

  // While the managed restore is still pending, a session call is served at once,
  // through the ORIGINAL proved context, and constructs no managed owner.
  const proved = laneContext(identity, run.run).context;
  const spawned = await lane.delegate.callTool(proved, { name: "SessionSpawn", arguments: { ...SPAWN_REQUEST } });
  assert.equal(spawned?.isError, false, text(spawned));
  assert.match(text(spawned), /launched in the background/);
  assert.deepEqual(spy.spawned, [SPAWN_REQUEST]);
  assert.ok(resolved.length > 0 && resolved.every((context) => context === proved),
    "the resolver receives the exact proved context, never the slot-keyed owner view");
  assert.equal(proved.rowId, "row-a");
  const hosts = await lane.delegate.callTool(proved, { name: "SessionHosts", arguments: {} });
  assert.equal(hosts?.isError, false, text(hosts));
  assert.deepEqual(hosts?.structuredContent, { ownKinds: ["claude"], hosts: [] });
  assert.equal(owners.created.length, 0, "session tools never acquire the managed owner");

  // A row the host binds to no slot still has its session tools (they need no restore).
  const unbound = laneContext({ ...identity, rowId: "row-unbound" }, makeRun().run).context;
  assert.deepEqual((await lane.delegate.listTools(unbound)).map((tool) => tool.name), ["SessionHosts", "SessionSpawn"]);
  assert.equal(owners.created.length, 0);

  // A slot-bound row's proved listing is ONE response that also carries
  // Start/Inspect, so it keeps the managed rule: it answers once the run's
  // preparation settles, never with an interim catalog missing Start/Inspect.
  let listingSettled = false;
  const pendingListing = lane.delegate.listTools(laneContext(identity, run.run).context);
  const markSettled = (): void => { listingSettled = true; };
  // Both outcomes are observed at once, so an early rejection is reported here.
  void pendingListing.then(markSettled, markSettled);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listingSettled, false, "the bound listing waits for the managed preparation to settle");
  releasePrepare!();
  const listed = await pendingListing;
  assert.deepEqual(listed.map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean", "SessionHosts", "SessionSpawn"]);
  assert.deepEqual(listed.slice(0, MANAGED_COUNT).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), canonicalCatalog());
  assert.deepEqual(listed.slice(MANAGED_COUNT), canonicalSessionDescriptors(spy.capability),
    "the proved session entries are the complete canonical descriptors");
  assert.equal(owners.created.length, 1);
  assert.equal(owners.created[0]!.identity.rowId, "slot-a", "the managed owner keeps its slot key");

  // Start/Inspect stay on the managed owner.
  const started = await lane.delegate.callTool(laneContext(identity, run.run).context,
    { name: "SubtasksStart", arguments: { tasks: [queuedTask("session lane start")] } });
  assert.equal(started?.isError, false, text(started));
  assert.deepEqual(spy.spawned, [SPAWN_REQUEST], "a managed call reaches no session capability");

  // Without the host's answer neither tool exists and nothing is invoked.
  answer = () => undefined;
  const refused = laneContext(identity, run.run).context;
  assert.deepEqual((await lane.delegate.listTools(refused)).map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"]);
  assert.equal(await lane.delegate.callTool(refused, { name: "SessionSpawn", arguments: { ...SPAWN_REQUEST } }), undefined);
  // A scope resolved for another context is refused before any effect.
  answer = (context) => scopeFor({ ...context, rowId: "row-other" }, spy.capability);
  await assert.rejects(lane.delegate.callTool(laneContext(identity, run.run).context, { name: "SessionSpawn", arguments: { ...SPAWN_REQUEST } }));
  assert.deepEqual(spy.spawned, [SPAWN_REQUEST]);
  assert.equal(spy.inspected(), 1);

  // A revoked run reaches nothing.
  answer = (context) => scopeFor(context, spy.capability);
  run.revoke();
  await assert.rejects(lane.delegate.callTool(laneContext(identity, run.run).context, { name: "SessionSpawn", arguments: { ...SPAWN_REQUEST } }));
  assert.deepEqual(spy.spawned, [SPAWN_REQUEST]);
  assert.deepEqual(await armed.host.drain(), { status: "clean" });
});

test("session tools: absent or invalid wiring keeps the lane exactly Start/Inspect; facts shape only the early metadata", async (t) => {
  const root = ownedRoot(t);
  root.writeSettings(savedSettings());
  for (const sessionTools of [undefined, { resolveScope: "nope", startup: SESSION_FACTS }, { resolveScope: () => undefined }]) {
    const armed = createNativeManagedHostLane(laneInput(root, { sessionTools: sessionTools as never, testHooks: { ceiling: CEILING } }));
    assert.equal(armed.status, "armed");
    if (armed.status !== "armed") continue;
    assert.deepEqual(armed.host.lane.preProofTools, canonicalCatalog());
    const context = laneContext({ rowId: "row-a", backend: "codex", workspace: root.workspace, conversationId: CONVERSATION }, makeRun().run).context;
    assert.equal(await armed.host.lane.delegate.callTool(context, { name: "SessionSpawn", arguments: { ...SPAWN_REQUEST } }), undefined);
    assert.deepEqual(await armed.host.drain(), { status: "clean" });
  }
  // No inspection: no SessionHosts and no discovery guidance; no valid title snapshot: no SessionSpawn.
  const noInspection = nativeManagedHostLanePreProofTools({ titleColumns: 20, inspection: false, createWorkspace: false });
  const bare = { titleColumns: 20, routing: true, spawn: async () => "failed" as const } satisfies SessionHostSpawnCapability;
  const spawn = sessionSpawnToolDefinition(bare)!;
  assert.deepEqual(asLaunchWording(noInspection, 20), [...canonicalCatalog(), { name: spawn.name, description: spawn.description, inputSchema: spawn.parameters }]);
  assert.doesNotMatch(JSON.stringify(noInspection), /snapshot at child launch|At child launch/);
  assert.deepEqual(nativeManagedHostLanePreProofTools({ titleColumns: 0, inspection: true, createWorkspace: true }).map((tool) => tool.name),
    ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean", "SessionHosts"]);
});

test("session tools: a failed managed restore still settles the listing with the session entries", async (t) => {
  let drain: (() => Promise<unknown>) | undefined;
  const root = ownedRoot(t, () => drain?.() ?? Promise.resolve());
  root.writeSettings(savedSettings());
  const spy = spyCapability();
  let prepared = 0;
  const armed = createNativeManagedHostLane(laneInput(root, {
    sessionTools: { resolveScope: (context) => scopeFor(context, spy.capability), startup: SESSION_FACTS },
    testHooks: {
      ceiling: CEILING,
      createOwner: (options) => Object.freeze({
        delegate: createNativeManagedConversationOwner(options).delegate,
        prepare: async () => { prepared += 1; throw new Error("synthetic restore failure"); },
      }),
    },
  }));
  assert.equal(armed.status, "armed");
  if (armed.status !== "armed") return;
  drain = () => armed.host.drain();
  const identity = { rowId: "row-a", backend: "codex" as const, workspace: root.workspace, conversationId: CONVERSATION };
  const run = makeRun();
  const listed = await armed.host.lane.delegate.listTools(laneContext(identity, run.run).context);
  assert.equal(prepared, 1);
  assert.deepEqual(listed, canonicalSessionDescriptors(spy.capability), "no Start/Inspect, yet both session tools");
  const spawned = await armed.host.lane.delegate.callTool(laneContext(identity, run.run).context, { name: "SessionSpawn", arguments: { ...SPAWN_REQUEST } });
  assert.equal(spawned?.isError, false, text(spawned));
  assert.equal(await armed.host.lane.delegate.callTool(laneContext(identity, run.run).context,
    { name: "SubtasksStart", arguments: { tasks: [queuedTask("failed restore")] } }), undefined, "Start stays closed after a failed restore");
  assert.deepEqual(await armed.host.drain(), { status: "clean" });
});

/* ---- End to end through the real InstanceManager --------------------------- */

class LanePty implements InstancePty {
  static #nextPid = 960_000;
  readonly pid: number;
  cols: number;
  rows: number;
  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = LanePty.#nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
  }
  #exited = false;
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  onData(): { dispose(): void } { return { dispose: () => undefined }; }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose: () => undefined };
  }
  on(): void {}
  removeListener(): void {}
  write(): void {}
  resize(): void {}
  pause(): void {}
  resume(): void {}
  /** Host stop: a terminate request ends the synthetic child at once. */
  kill(signal?: string): void {
    if (this.#exited || (signal ?? "SIGHUP") !== "SIGTERM") return;
    this.#exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode: 0, signal: 15 });
  }
}

/** A broker shaped registrar: records each launch's MCP endpoint. */
function endpointBroker() {
  const endpoints = new Map<string, NativeMcpToolEndpoint>();
  const hostBroker = {
    register() { throw new Error("no Pi child is registered in this test"); },
    registerNativeHookSource() { throw new Error("unused: the manager receives its own hook registrar"); },
    registerNativeMcpSource(instanceId: string, backend: NativeCliBackend, endpoint: NativeMcpToolEndpoint): NativeMcpRegistration {
      endpoints.set(instanceId, endpoint);
      return {
        bootstrap: {
          version: 1,
          type: "native_mcp_bootstrap",
          socketPath: `/synthetic/native-mcp/${instanceId}.sock`,
          generation: randomUUID(),
          instanceId,
          backend,
          token: randomBytes(32).toString("hex"),
        },
        release: () => undefined,
      };
    },
    async dispose() {},
  };
  return { hostBroker, endpoints };
}

test("end to end: the real manager's proved lane routes SessionSpawn/SessionHosts through its own exact-row authority", async (t) => {
  let manager: InstanceManager | undefined;
  let drain: (() => Promise<unknown>) | undefined;
  const root = ownedRoot(t, async () => {
    await manager?.dispose();
    await drain?.();
  });
  root.writeSettings(savedSettings());
  // Synthetic inert package and Pi fixtures under the owned root; nothing executes them.
  const packageRoot = join(root.root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  for (const file of ["index.js", "session-host/reporter.js", "session-host/bootstrap-preload.js"]) {
    writeFileSync(join(packageRoot, "dist", "src", file), "// Synthetic fixture; never executed.\n", "utf8");
  }
  const piExecutable = join(root.root, "bin", "mock-pi");
  mkdirSync(join(root.root, "bin"));
  writeFileSync(piExecutable, "#!/usr/bin/env node\n// Synthetic inert fixture.\n", "utf8");
  chmodSync(piExecutable, 0o755);

  const { hostBroker, endpoints } = endpointBroker();
  const armed = createNativeManagedHostLane(laneInput(root, {
    broker: hostBroker,
    // No roster slot: the managed owner is unreachable, the session tools are not.
    resolveSlotId: () => undefined,
    sessionTools: {
      resolveScope: (context) => manager?.nativeSessionToolScope(context),
      startup: { titleColumns: 40, inspection: true, createWorkspace: true },
    },
    testHooks: { ceiling: CEILING },
  }));
  assert.equal(armed.status, "armed", JSON.stringify(armed));
  if (armed.status !== "armed") return;
  drain = () => armed.host.drain();

  const routed: Array<{ parentId: string; request: SessionSpawnInput; currentAtCall: boolean }> = [];
  const inspections: Array<{ parentId: string; context: SessionHostsRequestContext }> = [];
  let legacy = 0;
  // The host's live sidebar title snapshot; the terminal resizes after startup.
  let titleColumns = 40;
  const observers = new Map<string, NativeStatusObserverContext>();
  const managerOptions: InstanceManagerOptions = {
    packageRoot,
    piExecutable,
    statusRegistrar: { register() { throw new Error("no Pi child in this test"); } },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root.home, PI_CODING_AGENT_DIR: root.agentDir },
    args: [],
    nativeCliLaunch: (backend, request) => ({
      file: `/synthetic/bin/${backend}`,
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin", HOME: root.home },
      cwd: request.workspace,
      ...(request.nativeMcp === undefined ? {} : {
        nativeMcp: {
          mcp: "prepared",
          backend,
          route: "claude-mcp-config-file",
          placement: "claude-tui",
          serverName: request.nativeMcp.serverName,
          args: [],
          lease: { root: "/synthetic/mcp-root", bootstrapFile: "/synthetic/mcp-root/bootstrap.json", cleanup: async () => ({ removed: true }) },
        } as unknown as NativeMcpLaunchOutcome,
      }),
    } satisfies NativeCliLaunchDescriptor),
    nativeHookRegistrar: {
      registerNativeHookSource: (instanceId, backend) => ({
        bootstrap: { version: 1, socketPath: `/synthetic/native/${instanceId}.sock`, generation: randomUUID(), instanceId, backend, token: randomBytes(32).toString("hex") },
        release: () => undefined,
      }),
    },
    nativeStatusObserverFactory: (context) => {
      observers.set(context.rowId, context);
      return { acceptHook() {}, acceptFailure() {}, dispose() {} };
    },
    nativeMcpLane: armed.host.lane,
    ptyFactory: (descriptor) => new LanePty(descriptor),
    onSpawnRequest: async () => { legacy += 1; return "started"; },
    onRoutedSpawnRequest: async (parentId, request, parentStillCurrent): Promise<SessionSpawnOutcome> => {
      routed.push({ parentId, request, currentAtCall: parentStillCurrent() });
      return parentStillCurrent() ? "started" : "failed";
    },
    onSessionHostsRequest: async (parentId, context): Promise<SessionHostsSnapshot> => {
      inspections.push({ parentId, context });
      return { ownKinds: ["pi", "claude"], hosts: [{ id: "peer-1", label: "Peer", kinds: ["pi"] }] };
    },
    routedSpawnCreateWorkspace: true,
    routedSpawnOwnHostParentProof: true,
    getSidebarTitleColumns: () => titleColumns,
  };
  // Evidence for the bounded SessionHosts difference: the manager's pre-proof copy
  // refuses the canonical outputSchema and annotations the proved listing carries.
  const hostsDefinition = sessionHostsToolDefinition(spyCapability(40).capability)!;
  assert.throws(() => new InstanceManager({
    ...managerOptions,
    nativeMcpLane: {
      ...armed.host.lane,
      preProofTools: [{ name: hostsDefinition.name, description: hostsDefinition.description, inputSchema: hostsDefinition.parameters, outputSchema: hostsDefinition.outputSchema, annotations: { ...hostsDefinition.annotations } }] as never,
    },
  }), /preProofTools must be distinct \{ name, description\?, inputSchema \}/);
  manager = new InstanceManager(managerOptions);
  // A resize between host startup and the native launch.
  titleColumns = 55;

  const id = await manager.create({ workspace: root.workspace, backend: "claude" } as CreateInstanceOptions);
  const endpoint = endpoints.get(id);
  assert.ok(endpoint, "the row registered its MCP endpoint on the host's broker");
  const request = () => ({ signal: new AbortController().signal });

  // Before the conversation is proved: canonical early metadata only, and no call is admitted.
  const early = await endpoint.listTools(request());
  assert.deepEqual(early, armed.host.lane.preProofTools);
  assert.deepEqual(early.map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean", "SessionHosts", "SessionSpawn"]);
  // After the resize the early SessionSpawn still truthfully names the startup snapshot (40), not this launch.
  assertEarlySessionEntries(early.slice(MANAGED_COUNT), spyCapability(40).capability);
  await assert.rejects(endpoint.callTool({ name: "SessionSpawn", arguments: { ...SPAWN_REQUEST }, signal: request().signal }));
  await assert.rejects(endpoint.callTool({ name: "SessionHosts", arguments: {}, signal: request().signal }));
  assert.equal(routed.length + inspections.length + legacy, 0, "early discovery grants no authority");

  // The row's own observer proves its conversation: the lane binds.
  assert.equal(observers.get(id)?.emitConversationIdentity?.(CONVERSATION), true);
  const listed = await endpoint.listTools(request());
  assert.deepEqual(listed.map((tool) => tool.name), ["SessionHosts", "SessionSpawn"],
    "an unslotted row has no managed owner, yet its session tools stand alone");
  // The proved listing is the complete canonical descriptors for the manager's live snapshot.
  assert.deepEqual(listed, canonicalSessionDescriptors({ ...spyCapability(55).capability, createWorkspace: true }),
    "complete canonical descriptors, including SessionHosts outputSchema and annotations");

  const spawned = await endpoint.callTool({ name: "SessionSpawn", arguments: { ...SPAWN_REQUEST, host: "peer-1" }, signal: request().signal });
  assert.equal(spawned?.isError, false, text(spawned));
  assert.deepEqual(routed, [{ parentId: id, request: { ...SPAWN_REQUEST, host: "peer-1" }, currentAtCall: true }],
    "the routed request names the manager's own row as parent, under a live lane proof");
  const own = await endpoint.callTool({ name: "SessionSpawn", arguments: { ...SPAWN_REQUEST, createWorkspace: true }, signal: request().signal });
  assert.equal(own?.isError, false, text(own));
  assert.equal(routed.length, 2, "own-host SessionSpawn uses the declared own-host parent proof");
  const inspected = await endpoint.callTool({ name: "SessionHosts", arguments: {}, signal: request().signal });
  assert.equal(inspected?.isError, false, text(inspected));
  assert.deepEqual(inspected?.structuredContent, { ownKinds: ["pi", "claude"], hosts: [{ id: "peer-1", label: "Peer", kinds: ["pi"] }] });
  assert.equal(inspections[0]?.parentId, id);
  assert.equal(legacy, 0, "the legacy Pi-only handler is never a fallback");
  assert.equal(await endpoint.callTool({ name: "SubtasksStart", arguments: { tasks: [queuedTask("unslotted")] }, signal: request().signal }), undefined,
    "managed tools keep their own slot rule");

  // Losing the proved conversation revokes the lane: nothing more is admitted.
  assert.equal(observers.get(id)?.emitConversationIdentity?.(OTHER_CONVERSATION), true);
  await assert.rejects(endpoint.callTool({ name: "SessionSpawn", arguments: { ...SPAWN_REQUEST }, signal: request().signal }));
  assert.equal(routed.length, 2);
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
  manager(): InstanceManager | undefined;
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
  let createdManager: InstanceManager | undefined;
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
      createdManager = new InstanceManager(managerOptions);
      return createdManager as never;
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
  return { result, terminal, observer, events, reports, managerOptions: () => captured, manager: () => createdManager, laneInputs, owners, hostBroker };
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

  assert.equal(run.laneInputs.length, 1);
  const input = run.laneInputs[0]!;
  // Session-tool facts are Main's own manager declarations and its real title snapshot.
  const sessionTools = input.sessionTools;
  assert.ok(sessionTools, "Main wires SessionHosts/SessionSpawn onto the same lane");
  assert.deepEqual({ ...sessionTools.startup }, {
    titleColumns: options.getSidebarTitleColumns?.(),
    inspection: typeof options.onSessionHostsRequest === "function" && typeof options.onRoutedSpawnRequest === "function",
    createWorkspace: options.routedSpawnCreateWorkspace === true,
  });
  assert.equal(options.routedSpawnOwnHostParentProof, true);
  assert.deepEqual(lane.preProofTools, nativeManagedHostLanePreProofTools(sessionTools.startup));
  assert.deepEqual(lane.preProofTools?.map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean", "SessionHosts", "SessionSpawn"]);
  assert.deepEqual(lane.preProofTools?.slice(0, MANAGED_COUNT), canonicalCatalog());
  assert.equal(input.broker, run.hostBroker);
  assert.equal(input.ownedAgentDir, root.agentDir);
  assert.equal(input.resolveSlotId("row-main"), undefined, "Main refuses a runtime row its roster does not bind");
  assert.equal(input.settings.agentDir, root.agentDir);
  assert.equal(input.settings.env.HOME, root.home);
  assert.equal(input.settings.resolvedHomeDir, root.home);
  assert.deepEqual(input.pi, { executable: PI_FILE, version: PI_VERSION, launchArgs: ["--offline"] });
  assert.equal(existsSync(hostOwnershipPath(root.agentDir)), true, "the host owns the agent directory");
  // Claude completion delivery (#682): the armed Linux lane opts the manager in
  // and reads each runtime row's sender from THAT manager's own accessor.
  assert.equal(options.nativeClaudeInbox, true, "the armed lane opts this host's Claude runs into their own inbox");
  assert.equal(options.nativeClaudeInboxRequiresMcpLane, true, "scoped to runs whose own managed MCP lane is kept");
  const claudeInbox = input.claudeInbox;
  assert.ok(claudeInbox, "Main wires the run-bound Claude completion sink");
  const inboxManager = run.manager();
  assert.ok(inboxManager);
  const senderLookups: string[] = [];
  const realSender = inboxManager.nativeClaudeInboxSender.bind(inboxManager);
  inboxManager.nativeClaudeInboxSender = (rowId) => { senderLookups.push(rowId); return realSender(rowId); };
  assert.equal(claudeInbox.senderFor("row-main"), undefined, "no row, no sender");
  assert.deepEqual(senderLookups, ["row-main"], "the lookup is the manager's own, by the runtime row id");
  // Codex callback (#682): Linux keeps its bounded probe receipt path only; the
  // macOS/Windows handshake seam is never opted into here.
  assert.equal(options.nativeCodexCallback, true, "the armed Linux lane opts owned Codex runs in");
  assert.equal(options.nativeCodexCallbackHandshakeVersion, undefined, "Linux never takes the handshake seam");
  assert.ok(input.codexCallback, "Main wires the run-bound Codex completion sink");

  // The manager's lane delegate is the composed one: a proved run dispatches canonically.
  const identity = { rowId: "row-main", backend: "claude" as const, workspace: root.workspace, conversationId: CONVERSATION };
  const proved = makeRun();
  // The session resolver is the real manager's own scope, called with the ORIGINAL
  // context (not the slot-keyed owner view). This hand-built context was never
  // issued by the manager, so it carries no session authority.
  const realManager = run.manager();
  assert.ok(realManager);
  const scopeCalls: NativeMcpLaneContext[] = [];
  const realScope = realManager.nativeSessionToolScope.bind(realManager);
  realManager.nativeSessionToolScope = (context) => { scopeCalls.push(context); return realScope(context); };
  const handBuilt = laneContext(identity, proved.run).context;
  const listed = await lane.delegate.listTools(handBuilt);
  assert.deepEqual(listed.map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"]);
  assert.deepEqual(scopeCalls, [handBuilt]);
  assert.equal(scopeCalls[0], handBuilt);
  assert.equal(await lane.delegate.callTool(handBuilt, { name: "SessionSpawn", arguments: { ...SPAWN_REQUEST } }), undefined);
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

test("Pi-only brokers and hosts without native hosting start exactly as before", async (t) => {
  const root = ownedRoot(t);
  const cases: Array<{ name: string; settings: unknown; options: Parameters<typeof startMain>[1]; composed: boolean }> = [
    {
      name: "broker without the native MCP family",
      settings: savedSettings(),
      options: { broker: { register() { throw new Error("unused"); }, registerNativeHookSource() { throw new Error("unused"); }, async dispose() {} } as unknown as StatusBroker },
      composed: true,
    },
    { name: "no native hosting", settings: savedSettings(), options: { hosting: false }, composed: false },
  ];
  for (const scenario of cases) {
    root.writeSettings(scenario.settings);
    const run = startMain(root, scenario.options);
    const options = await mainReady(run);
    assert.equal(options.nativeMcpLane, undefined, `${scenario.name}: no lane`);
    assert.equal(options.nativeClaudeInbox, undefined, `${scenario.name}: no Claude inbox opt-in without a lane`);
    assert.equal(options.nativeClaudeInboxRequiresMcpLane, undefined, `${scenario.name}: no lane scope either`);
    assert.equal(run.laneInputs.length, scenario.composed ? 1 : 0, `${scenario.name}: composition consulted only with native hosting`);
    assert.equal(await quitMain(run), 0, `${scenario.name}: ${run.reports.join("\n")}`);
    assert.equal(run.events.includes("drain.start"), false, `${scenario.name}: nothing to drain`);
    assert.equal(existsSync(hostOwnershipPath(root.agentDir)), false, `${scenario.name}: ownership released`);
  }
  assert.equal(existsSync(nativeMcpServerNamePath(root.agentDir)), false, "an unarmed host mints no server name");
});

test("Main arms the lane for Pi worker settings; an unavailable offline Pi catalog leaves owners without a model scope", async (t) => {
  const root = ownedRoot(t);
  root.writeSettings(PI_WORKER_SETTINGS);
  const run = startMain(root);
  const options = await mainReady(run);
  assert.ok(options.nativeMcpLane, "Pi workers launch through the owner's admitted executable");
  assert.equal(run.laneInputs.length, 1);
  assert.deepEqual(run.laneInputs[0]!.pi, { executable: PI_FILE, version: PI_VERSION, launchArgs: run.laneInputs[0]!.pi.launchArgs });
  // The synthetic Pi file has no installed SDK, so the catalog fails: no scope, never a guessed one.
  assert.equal("scopedModels" in run.laneInputs[0]!, false);
  assert.equal(await quitMain(run), 0, run.reports.join("\n"));
});

test("a Windows host arms the managed lane on its existing pair, opting Claude into the callback-only custody channel and Codex into the handshake-proved callback, with no Watch or sender before proof", async (t) => {
  let pending: MainRun | undefined;
  const root = ownedRoot(t, async () => {
    if (pending) {
      pending.observer.settle();
      await quitMain(pending).catch(() => undefined);
    }
  });
  root.writeSettings(savedSettings());
  const run = startMain(root, { platform: "win32" });
  pending = run;
  const options = await mainReady(run);
  assert.equal(options.nativeHookRegistrar, run.hostBroker, "the existing native observation pair stays installed");
  assert.ok(options.nativeStatusObserverFactory);
  const lane = options.nativeMcpLane as NativeMcpLaneOwner | undefined;
  assert.ok(lane, "the Windows host supplies the managed lane");
  assert.equal(lane.registrar, run.hostBroker, "the lane registrar is the host's one broker");
  const persisted = readNativeMcpServerName(root.agentDir);
  assert.equal(persisted.status, "loaded");
  assert.equal(lane.serverName, persisted.status === "loaded" ? persisted.serverName : undefined, "the persisted stable server name");
  assert.equal(run.laneInputs.length, 1);
  const input = run.laneInputs[0]!;
  assert.equal(input.platform, "win32", "Main passes its own platform fact");
  assert.ok(input.sessionTools, "the same SessionHosts/SessionSpawn wiring as POSIX");
  assert.deepEqual(lane.preProofTools, nativeManagedHostLanePreProofTools(input.sessionTools.startup));
  assert.deepEqual(lane.preProofTools?.slice(0, MANAGED_COUNT), canonicalCatalog());
  // #682: Windows opts Claude runs into the same lane-scoped inbox, served only
  // by the callback-only held-child custody composition (consulted solely for a
  // run already eligible on the manager's own facts); no sender exists before
  // the authenticated root start binds the supervisor's candidate. Codex opts
  // into its callback only through the owned backend's verified handshake proof,
  // separate from the Linux probe allowlist; the receipt-gated Watch metadata is
  // listed by the manager only for a run holding that current proof.
  assert.equal(options.nativeClaudeInbox, true, "the armed lane opts this host's Claude runs into their own inbox");
  assert.equal(options.nativeClaudeInboxRequiresMcpLane, true, "scoped to runs whose own managed MCP lane is kept");
  const custody = options.nativeWindowsClaudeCustody;
  assert.ok(custody, "the Windows host supplies the custody composition beside the armed lane");
  assert.equal(custody.callbackOnly, true, "consulted only for a callback-eligible row");
  assert.equal(typeof custody.select, "function");
  assert.equal(custody.createAdapter, undefined, "the landed standalone adapter, unchanged");
  const claudeInbox = input.claudeInbox;
  assert.ok(claudeInbox, "Main wires the run-bound Claude completion sink");
  const inboxManager = run.manager();
  assert.ok(inboxManager);
  const senderLookups: string[] = [];
  const realSender = inboxManager.nativeClaudeInboxSender.bind(inboxManager);
  inboxManager.nativeClaudeInboxSender = (rowId) => { senderLookups.push(rowId); return realSender(rowId); };
  assert.equal(claudeInbox.senderFor("row-main"), undefined, "no row and no bound custody callback: no sender");
  assert.deepEqual(senderLookups, ["row-main"], "the lookup is the manager's own, by the runtime row id");
  assert.ok(options.ownedCodexBackendFactory, "the existing owned Codex backend factory is unchanged");
  assert.equal(options.nativeCodexCallback, true, "Windows Codex runs may prove their own callback sender");
  assert.equal(options.nativeCodexCallbackHandshakeVersion, true, "only through the owned backend's handshake proof");
  assert.deepEqual(lane.deliveryTools, nativeManagedHostLaneDeliveryTools(), "receipt-gated Watch metadata only");
  const codexCallback = input.codexCallback;
  assert.ok(codexCallback, "Main wires the run-bound Codex completion sink");
  const callbackManager = run.manager();
  assert.ok(callbackManager);
  const codexLookups: string[] = [];
  const realCodexSender = callbackManager.nativeCodexCallbackSender.bind(callbackManager);
  callbackManager.nativeCodexCallbackSender = (rowId) => { codexLookups.push(rowId); return realCodexSender(rowId); };
  assert.equal(codexCallback.senderFor("row-main"), undefined, "no row and no handshake proof: no sender");
  assert.deepEqual(codexLookups, ["row-main"], "the lookup is the manager's own, by the runtime row id");

  const identity = { rowId: "row-main", backend: "claude" as const, workspace: root.workspace, conversationId: CONVERSATION };
  const proved = makeRun();
  const listed = await lane.delegate.listTools(laneContext(identity, proved.run).context);
  assert.deepEqual(listed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), canonicalCatalog(),
    "proved discovery lists Start/Inspect and the other managed tools with canonical metadata, and lists no Watch");
  const watch = await lane.delegate.callTool(laneContext(identity, proved.run).context, { name: "SubtasksWatch", arguments: {} });
  if (watch !== undefined) {
    assert.equal(watch.isError, true, "Watch is refused without a sender");
    assert.match(text(watch), /failed closed[\s\S]*nothing was started or read/);
  }
  const created = run.owners.created[0]!;
  // The hold is wired to its run-bound sink, but its Watch predicate re-proves the
  // live sender and stays false without a bound custody callback.
  assert.equal(typeof created.nativeEventSink, "function", "the Claude hold is wired to the run-bound sink");
  assert.equal(created.watchDeliveryCurrent?.(), false, "no bound callback, so Watch delivery is never current");
  const args = { tasks: [queuedTask("windows main start")] };
  const started = await lane.delegate.callTool(laneContext(identity, proved.run).context, { name: "SubtasksStart", arguments: args });
  assert.equal(started?.isError, false, text(started));
  assert.equal(claudeInbox.senderFor("row-main"), undefined, "discovery and calls mint no Claude sender");

  pending = undefined;
  assert.equal(await quitMain(run), 0, run.reports.join("\n"));
  assert.deepEqual(run.events.filter((event) => event.startsWith("drain") || event === "broker.dispose"),
    ["drain.start", "drain.clean", "broker.dispose"], "the drain settles before the broker is disposed");
  assert.equal(existsSync(hostOwnershipPath(root.agentDir)), false, "ownership is released after a clean drain");
});

test("a macOS host arms the lane, opts Claude into its Darwin-proved inbox and owned Codex into the handshake-proved callback, with no Watch or sender before proof", async (t) => {
  let pending: MainRun | undefined;
  const root = ownedRoot(t, async () => {
    if (pending) {
      pending.observer.settle();
      await quitMain(pending).catch(() => undefined);
    }
  });
  root.writeSettings(savedSettings());
  const run = startMain(root, { platform: "darwin" });
  pending = run;
  const options = await mainReady(run);
  assert.equal(options.nativeHookRegistrar, run.hostBroker, "the existing native observation pair stays installed");
  assert.ok(options.nativeStatusObserverFactory);
  const lane = options.nativeMcpLane as NativeMcpLaneOwner | undefined;
  assert.ok(lane, "the managed lane itself is armed");
  assert.equal(lane.registrar, run.hostBroker, "the lane registrar is the host's one broker");
  assert.equal(run.laneInputs.length, 1);
  const input = run.laneInputs[0]!;
  assert.equal(input.platform, "darwin", "Main passes its own platform fact");
  assert.ok(input.sessionTools);
  assert.deepEqual(lane.preProofTools, nativeManagedHostLanePreProofTools(input.sessionTools.startup));
  assert.deepEqual(lane.preProofTools?.slice(0, MANAGED_COUNT), canonicalCatalog());
  // #682: macOS opts Claude runs into their own inbox exactly as Linux does,
  // scoped to the managed lane; each sender still needs the Darwin version and
  // endpoint proofs, so nothing exists before them.
  assert.equal(options.nativeClaudeInbox, true, "the armed lane opts this host's Claude runs into their own inbox");
  assert.equal(options.nativeClaudeInboxRequiresMcpLane, true, "scoped to runs whose own managed MCP lane is kept");
  const claudeInbox = input.claudeInbox;
  assert.ok(claudeInbox, "Main wires the run-bound Claude completion sink");
  const inboxManager = run.manager();
  assert.ok(inboxManager);
  const senderLookups: string[] = [];
  const realSender = inboxManager.nativeClaudeInboxSender.bind(inboxManager);
  inboxManager.nativeClaudeInboxSender = (rowId) => { senderLookups.push(rowId); return realSender(rowId); };
  assert.equal(claudeInbox.senderFor("row-main"), undefined, "no row and no Darwin proof: no sender");
  assert.deepEqual(senderLookups, ["row-main"], "the lookup is the manager's own, by the runtime row id");
  // #682: macOS has no bounded `--version` runner, so owned Codex opts into its
  // callback ONLY through the owned backend's verified handshake proof - the same
  // seam Windows takes, never the Linux probe receipt path.
  assert.ok(options.ownedCodexBackendFactory, "the existing owned Codex backend factory is unchanged");
  assert.equal(options.nativeCodexCallback, true, "macOS owned Codex runs may prove their own callback sender");
  assert.equal(options.nativeCodexCallbackHandshakeVersion, true, "only through the owned backend's handshake proof");
  assert.deepEqual(lane.deliveryTools, nativeManagedHostLaneDeliveryTools(), "receipt-gated Watch metadata only");
  const codexCallback = input.codexCallback;
  assert.ok(codexCallback, "Main wires the run-bound Codex completion sink");
  const callbackManager = run.manager();
  assert.ok(callbackManager);
  const codexLookups: string[] = [];
  const realCodexSender = callbackManager.nativeCodexCallbackSender.bind(callbackManager);
  callbackManager.nativeCodexCallbackSender = (rowId) => { codexLookups.push(rowId); return realCodexSender(rowId); };
  assert.equal(codexCallback.senderFor("row-main"), undefined, "no row and no handshake proof: no sender");
  assert.equal(codexCallback.senderFor("row-unknown"), undefined, "an unknown row has no sender either");
  assert.deepEqual(codexLookups, ["row-main", "row-unknown"], "the lookup is the manager's own, by the runtime row id");

  // No proof and no manager-issued authority: neither a hand-built Claude nor a
  // hand-built Codex context lists Watch or has a Watch call admitted.
  const delegate = lane.delegate;
  // A refusal is either no answer (not this lane's tool) or a fail-closed error
  // that started and read nothing; never an admitted Watch.
  const assertWatchRefused = (result: Awaited<ReturnType<typeof delegate.callTool>>, message: string) => {
    if (result === undefined) return;
    assert.equal(result.isError, true, message);
    assert.match(text(result), /failed closed[\s\S]*nothing was started or read/, message);
  };
  for (const backend of ["claude", "codex"] as const) {
    const identity = { rowId: "row-main", backend, workspace: root.workspace, conversationId: CONVERSATION };
    const proved = makeRun();
    const listed = await delegate.listTools(laneContext(identity, proved.run).context);
    assert.deepEqual(listed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), canonicalCatalog(),
      `${backend}: proved discovery is the canonical metadata and lists no Watch`);
    assertWatchRefused(await delegate.callTool(laneContext(identity, proved.run).context, { name: "SubtasksWatch", arguments: {} }),
      `${backend}: Watch is refused without a sender`);
    // A revoked (stale) run gains nothing either.
    const stale = makeRun();
    stale.revoke();
    assertWatchRefused(await delegate.callTool(laneContext(identity, stale.run).context, { name: "SubtasksWatch", arguments: {} }),
      `${backend}: a stale run admits no Watch`);
  }
  for (const created of run.owners.created) {
    // Each hold is wired to its run-bound sink, but its Watch predicate re-proves
    // the live sender and stays false without a Darwin or handshake proof.
    assert.equal(typeof created.nativeEventSink, "function", `${created.identity.backend}: the hold is wired to the run-bound sink`);
    assert.equal(created.watchDeliveryCurrent?.(), false, `${created.identity.backend}: no proof, so Watch delivery is never current`);
  }
  assert.deepEqual(run.owners.created.map((created) => created.identity.backend).sort(), ["claude", "codex"], "one hold per hand-built run");
  assert.equal(codexCallback.senderFor("row-main"), undefined, "discovery and refused calls mint no sender");
  assert.equal(claudeInbox.senderFor("row-main"), undefined, "discovery and refused calls mint no Claude sender either");

  pending = undefined;
  assert.equal(await quitMain(run), 0, run.reports.join("\n"));
  assert.equal(existsSync(hostOwnershipPath(root.agentDir)), false, "ownership is released after a clean shutdown");
});
