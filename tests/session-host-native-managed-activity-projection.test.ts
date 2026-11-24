/**
 * #682: the canonical managed activity census projected onto the owning native
 * sidebar row (`InstanceManager.list()`, which both the local sidebar and the
 * peer view read).
 *
 * EVIDENCE SCOPE: every test drives the REAL `InstanceManager` with the REAL
 * composed native managed host lane (`createNativeManagedHostLane`) and its real
 * custody, through the endpoint the manager registered on a fake broker, with a
 * fake provider launch, synthetic PTY, and synthetic observer (no provider
 * binary, relay, or peer). The census tests swap only the owner for a fake whose
 * manager exposes a test-controlled `HostActivityCensus`, so combination, stale
 * and incomplete states, and handoff transitions are deterministic. The final
 * test uses the real owner, real restore, and the real no-Pi
 * `ExecutionToolManager`/controller census. Every artifact, including the
 * process temp directory, stays under a test-owned root removed after each test.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { HostActivityCensus, HostActivityCensusRead } from "../src/execution/background-controller";
import type { NativeMcpRegistration } from "../src/session-host/broker";
import {
  InstanceManager,
  type CreateInstanceOptions,
  type InstanceManagerOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type NativeCliLaunchDescriptor,
  type NativeInstanceView,
  type NativeStatusObserverContext,
} from "../src/session-host/instances";
import type { ExecutionToolManager } from "../src/execution/tool";
import {
  createNativeManagedConversationOwner,
  type NativeManagedConversationOwnerOptions,
} from "../src/session-host/native-managed-conversation-owner";
import { createNativeManagedHostLane, type NativeManagedHostLaneInput } from "../src/session-host/native-managed-host-lane";
import type { NativeMcpLaunchOutcome } from "../src/session-host/native-mcp-launch-prep";
import type { NativeMcpToolEndpoint } from "../src/session-host/native-mcp-stdio";
import { sessionHostStateDir } from "../src/session-host/roster-store";
import type { NativeCliBackend } from "../src/session-host/session-backend";

const CONVERSATION_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CONVERSATION_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CONVERSATION_C = "16fd2706-8baf-433b-82eb-8c7fada847da";
const ALL_SUPPORTED = Object.freeze({ agent: "supported", input: "supported", tasks: "supported", shells: "supported", activity: "supported" } as const);

function savedSettings() {
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
  };
}

interface Root {
  root: string;
  agentDir: string;
  home: string;
  workspace: string;
}

/** One owned root per test; the process temp directory points inside it until removal. */
function ownedRoot(t: { after(fn: () => void | Promise<void>): void }, cleanup: () => Promise<unknown>): Root {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "prg-native-managed-activity-projection-")));
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  for (const dir of [agentDir, home, workspace, artifacts]) mkdirSync(dir, { mode: 0o700 });
  mkdirSync(sessionHostStateDir(agentDir), { mode: 0o700 });
  writeFileSync(join(agentDir, "review-gate.json"), JSON.stringify(savedSettings()));
  const tempVars = ["TMPDIR", "TMP", "TEMP"] as const;
  const original = tempVars.map((key) => process.env[key]);
  for (const key of tempVars) process.env[key] = artifacts;
  t.after(async () => {
    try {
      await cleanup();
    } finally {
      for (const [index, key] of tempVars.entries()) {
        const value = original[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  return { root, agentDir, home, workspace };
}

class LanePty implements InstancePty {
  static #nextPid = 970_000;
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
  kill(signal?: string): void {
    if (this.#exited || (signal ?? "SIGHUP") !== "SIGTERM") return;
    this.#exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode: 0, signal: 15 });
  }
}

/** A broker-shaped registrar that records each launch's MCP endpoint. */
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

/** A test-controlled census: a read answers `value` at read time; `signal()` notifies subscribers. */
class FakeCensus implements HostActivityCensus {
  value: HostActivityCensusRead = { status: "incomplete" };
  reads = 0;
  readonly #listeners = new Set<() => void | Promise<void>>();
  #gate: Promise<void> | undefined;
  /** Park every later read until the returned release runs. */
  holdReads(): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.#gate = gate;
    return () => {
      if (this.#gate === gate) this.#gate = undefined;
      release();
    };
  }
  async read(): Promise<HostActivityCensusRead> {
    this.reads += 1;
    // The value as of read start: a parked read answers what it saw, never a later value.
    const value = this.value;
    const gate = this.#gate;
    if (gate !== undefined) await gate;
    return value;
  }
  subscribe(listener: () => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  get subscribers(): number { return this.#listeners.size; }
  set(count: number | null): void {
    this.value = count === null
      ? { status: "incomplete" }
      : { status: "complete", count, tokens: new Set(Array.from({ length: count }, (_, index) => `token-${index}`)) };
    for (const listener of [...this.#listeners]) void listener();
  }
}

interface FakeOwner {
  readonly options: NativeManagedConversationOwnerOptions;
  readonly census: FakeCensus;
  releasePrepare(): void;
  releaseShutdown(outcome?: "ok" | "reject"): void;
  shutdowns: number;
  detaches: number;
}

/** How a fake preparation settles, given the manager it built. */
type FakePrepare = (manager: unknown) => unknown;
const READY: FakePrepare = (manager) => ({ status: "ready", manager, source: "absent" });

/**
 * Owners whose manager exposes a FakeCensus; preparation and shutdown are gated per
 * owner. `outcomes[n]` (default ready) decides how the n-th owner's preparation settles.
 */
function fakeOwners(outcomes: readonly FakePrepare[] = []) {
  const owners: FakeOwner[] = [];
  const createOwner = (options: NativeManagedConversationOwnerOptions) => {
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    let releaseShutdown!: (outcome: "ok" | "reject") => void;
    const shutdownGate = new Promise<"ok" | "reject">((resolve) => { releaseShutdown = resolve; });
    const census = new FakeCensus();
    const owner: FakeOwner = {
      options,
      census,
      releasePrepare: () => releasePrepare(),
      releaseShutdown: (outcome = "ok") => releaseShutdown(outcome),
      shutdowns: 0,
      detaches: 0,
    };
    const manager = {
      activityCensus: () => census,
      shutdown: async () => {
        owner.shutdowns += 1;
        if (await shutdownGate === "reject") throw new Error("synthetic shutdown failure");
      },
      detach: async () => { owner.detaches += 1; },
    };
    const index = owners.length;
    owners.push(owner);
    return Object.freeze({
      delegate: Object.freeze({ listTools: async () => [], callTool: async () => undefined }),
      prepare: async () => {
        await prepareGate;
        return (outcomes[index] ?? READY)(manager) as never;
      },
    });
  };
  /** Cleanup: open every gate so the host drain can settle every handoff. */
  const releaseAll = (): void => {
    for (const owner of owners) {
      owner.releasePrepare();
      owner.releaseShutdown("ok");
    }
  };
  return { owners, createOwner, releaseAll };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Wait (bounded) until the predicate holds; fails with the last observed value. */
async function until<T>(read: () => T, predicate: (value: T) => boolean, what: string): Promise<T> {
  let value = read();
  for (let attempt = 0; attempt < 200 && !predicate(value); attempt += 1) {
    await turn();
    value = read();
  }
  assert.ok(predicate(value), `${what}: last observed ${JSON.stringify(value)}`);
  return value;
}

interface Harness {
  manager: InstanceManager;
  endpoints: Map<string, NativeMcpToolEndpoint>;
  observers: Map<string, NativeStatusObserverContext>;
  changes: string[];
  row(id: string): NativeInstanceView;
  /** One proved lane call that acquires (or reuses) the run's hold; resolves when it settles. */
  call(id: string): Promise<unknown>;
  create(): Promise<string>;
}

function harness(root: Root, laneOverrides: Partial<NativeManagedHostLaneInput>, onManager: (manager: InstanceManager) => void, onDrain: (drain: () => Promise<unknown>) => void): Harness {
  const { hostBroker, endpoints } = endpointBroker();
  const armed = createNativeManagedHostLane({
    platform: "linux",
    broker: hostBroker,
    ownedAgentDir: root.agentDir,
    resolveSlotId: (rowId) => rowId,
    settings: { env: {}, agentDir: root.agentDir },
    pi: { executable: "/synthetic/pi/dist/cli.js", version: "9.9.9", launchArgs: ["--offline"] },
    ...laneOverrides,
  });
  assert.equal(armed.status, "armed", JSON.stringify(armed));
  if (armed.status !== "armed") throw new Error("unarmed");
  onDrain(() => armed.host.drain());
  assert.equal(typeof armed.host.lane.activity?.contributionFor, "function", "the armed lane exposes its activity projection");

  const packageRoot = join(root.root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  for (const file of ["index.js", "session-host/reporter.js", "session-host/bootstrap-preload.js"]) {
    writeFileSync(join(packageRoot, "dist", "src", file), "// Synthetic fixture; never executed.\n", "utf8");
  }
  const piExecutable = join(root.root, "bin", "mock-pi");
  mkdirSync(join(root.root, "bin"), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n// Synthetic inert fixture.\n", { encoding: "utf8", mode: 0o755 });

  const observers = new Map<string, NativeStatusObserverContext>();
  const changes: string[] = [];
  const options: InstanceManagerOptions = {
    packageRoot,
    piExecutable,
    statusRegistrar: { register() { throw new Error("no Pi child in this test"); } },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root.home, PI_CODING_AGENT_DIR: root.agentDir },
    args: [],
    onChange: (id) => { changes.push(id); },
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
  };
  const manager = new InstanceManager(options);
  onManager(manager);
  return {
    manager,
    endpoints,
    observers,
    changes,
    row: (id) => {
      const view = manager.list().find((candidate) => candidate.id === id);
      assert.ok(view, `row ${id} is listed`);
      return view;
    },
    call: (id) => {
      const endpoint = endpoints.get(id);
      assert.ok(endpoint, "the row registered its MCP endpoint");
      return endpoint.listTools({ signal: new AbortController().signal });
    },
    create: () => manager.create({ workspace: root.workspace, backend: "claude" } as CreateInstanceOptions),
  };
}

const counts = (view: NativeInstanceView) => ({
  activeTasks: view.activeTasks,
  activeShells: view.activeShells,
  backgroundTasks: view.backgroundTasks,
  backgroundShells: view.backgroundShells,
});

test("the owning native row shows native + managed census (2+1=3); unknown on either side stays unknown; shells and ownership never change", async (t) => {
  let manager: InstanceManager | undefined;
  let drain: (() => Promise<unknown>) | undefined;
  const fakes = fakeOwners();
  const root = ownedRoot(t, async () => {
    await manager?.dispose();
    fakes.releaseAll();
    await drain?.();
  });
  const h = harness(root, { testHooks: { createOwner: fakes.createOwner } }, (value) => { manager = value; }, (value) => { drain = value; });

  const id = await h.create();
  const observer = h.observers.get(id);
  assert.ok(observer);
  assert.equal(observer.emit({ busy: false, pendingInput: false, activeTasks: 2, activeShells: 1, support: ALL_SUPPORTED }).accepted, true);
  // Native-only before any managed hold exists for this run.
  assert.deepEqual(counts(h.row(id)), { activeTasks: 2, activeShells: 1, backgroundTasks: null, backgroundShells: null });
  assert.equal(observer.emitConversationIdentity?.(CONVERSATION_A), true);
  assert.equal(h.row(id).activeTasks, 2, "a bound lane without a hold is still native-only");

  // The first proved call acquires the hold: restore pending is unknown, never zero.
  h.changes.length = 0;
  const listed = h.call(id);
  await until(() => fakes.owners.length, (n) => n === 1, "the hold constructed its owner");
  assert.deepEqual(counts(h.row(id)), { activeTasks: null, activeShells: 1, backgroundTasks: null, backgroundShells: null });
  assert.ok(h.changes.includes(id), "acquiring the hold redraws the owning row");
  const [owner] = fakes.owners;
  assert.equal(owner?.options.identity.rowId, id);

  // Census incomplete after restore: still unknown.
  owner!.releasePrepare();
  await listed;
  await until(() => owner!.census.reads, (n) => n >= 1, "the first census read ran");
  await turn();
  assert.equal(h.row(id).activeTasks, null, "an incomplete census is unknown, never zero");

  // A census signal re-reads: 2 native + 1 managed = 3; shells unchanged.
  h.changes.length = 0;
  owner!.census.set(1);
  await until(() => h.row(id).activeTasks, (value) => value === 3, "native 2 + managed 1");
  assert.deepEqual(counts(h.row(id)), { activeTasks: 3, activeShells: 1, backgroundTasks: null, backgroundShells: null });
  assert.ok(h.changes.includes(id), "a census transition redraws the owning row without polling");

  // A managed known zero is exactly the native count.
  owner!.census.set(0);
  await until(() => h.row(id).activeTasks, (value) => value === 2, "native 2 + managed 0");

  // Keep displaying the last known count while a fresh census is in flight.
  h.changes.length = 0;
  const releaseReads = owner!.census.holdReads();
  owner!.census.set(5);
  await turn();
  assert.equal(h.row(id).activeTasks, 2, "a refresh does not blank the displayed count");
  assert.deepEqual(h.changes, [], "starting the refresh does not redraw the row");
  owner!.census.set(4);
  await turn();
  assert.equal(h.row(id).activeTasks, 2, "another census signal keeps the displayed count");
  // Park the replacement read too, then let the superseded one (which saw 5) resolve.
  const releaseFreshRead = owner!.census.holdReads();
  const readsBeforeRelease = owner!.census.reads;
  releaseReads();
  await until(() => owner!.census.reads, (n) => n > readsBeforeRelease, "the replacement read started");
  await turn();
  assert.equal(h.row(id).activeTasks, 2, "the superseded result was discarded while the fresh read is blocked");
  assert.deepEqual(h.changes, [], "a superseded result does not redraw the row");
  releaseFreshRead();
  await until(() => h.row(id).activeTasks, (value) => value === 6, "native 2 + managed 4 after the fresh read");

  // Native unknown with managed known: unknown, never the managed count alone.
  assert.equal(observer.emit({ busy: true, pendingInput: false, activeTasks: null, activeShells: 1, support: ALL_SUPPORTED }).accepted, true);
  assert.equal(h.row(id).activeTasks, null, "an unknown native count makes the combined count unknown");
  assert.equal(observer.emit({ busy: true, pendingInput: false, activeTasks: 0, activeShells: 3, support: ALL_SUPPORTED }).accepted, true);
  assert.deepEqual(counts(h.row(id)), { activeTasks: 4, activeShells: 3, backgroundTasks: null, backgroundShells: null });

  // Managed census turns incomplete again: unknown.
  owner!.census.set(null);
  await until(() => h.row(id).activeTasks, (value) => value === null, "an incomplete census after a known count");
});

test("exact-run isolation: each row projects only its own current run's census; a row without a hold stays native", async (t) => {
  let manager: InstanceManager | undefined;
  let drain: (() => Promise<unknown>) | undefined;
  const fakes = fakeOwners();
  const root = ownedRoot(t, async () => {
    await manager?.dispose();
    fakes.releaseAll();
    await drain?.();
  });
  const h = harness(root, { testHooks: { createOwner: fakes.createOwner } }, (value) => { manager = value; }, (value) => { drain = value; });

  const first = await h.create();
  const second = await h.create();
  const third = await h.create();
  for (const [id, tasks, conversation] of [[first, 2, CONVERSATION_A], [second, 5, CONVERSATION_B], [third, 7, CONVERSATION_C]] as const) {
    const observer = h.observers.get(id);
    assert.ok(observer);
    assert.equal(observer.emit({ busy: false, pendingInput: false, activeTasks: tasks, activeShells: 0, support: ALL_SUPPORTED }).accepted, true);
    assert.equal(observer.emitConversationIdentity?.(conversation), true);
  }

  const firstCall = h.call(first);
  await until(() => fakes.owners.length, (n) => n === 1, "first hold");
  const secondCall = h.call(second);
  await until(() => fakes.owners.length, (n) => n === 2, "second hold");
  const [ownerA, ownerB] = fakes.owners;
  assert.equal(ownerA?.options.identity.rowId, first);
  assert.equal(ownerB?.options.identity.rowId, second);
  ownerA!.releasePrepare();
  ownerB!.releasePrepare();
  await Promise.all([firstCall, secondCall]);
  ownerA!.census.set(1);
  ownerB!.census.set(10);
  await until(() => [h.row(first).activeTasks, h.row(second).activeTasks], ([a, b]) => a === 3 && b === 15, "per-run sums");
  assert.equal(h.row(third).activeTasks, 7, "a row with no hold is never given another run's census");

  // One run's census turning incomplete leaves the others' projections untouched.
  ownerA!.census.set(null);
  await until(() => h.row(first).activeTasks, (value) => value === null, "first unknown");
  assert.equal(h.row(second).activeTasks, 15);
  assert.equal(h.row(third).activeTasks, 7);
});

test("handoff: a revoked run is unknown until its handoff settles; clean removes the contribution, failed stays unknown", async (t) => {
  let manager: InstanceManager | undefined;
  let drain: (() => Promise<unknown>) | undefined;
  const fakes = fakeOwners();
  const root = ownedRoot(t, async () => {
    await manager?.dispose();
    fakes.releaseAll();
    await drain?.();
  });
  const h = harness(root, { testHooks: { createOwner: fakes.createOwner } }, (value) => { manager = value; }, (value) => { drain = value; });

  const clean = await h.create();
  const failing = await h.create();
  for (const [id, conversation] of [[clean, CONVERSATION_A], [failing, CONVERSATION_B]] as const) {
    const observer = h.observers.get(id);
    assert.ok(observer);
    assert.equal(observer.emit({ busy: false, pendingInput: false, activeTasks: 2, activeShells: 1, support: ALL_SUPPORTED }).accepted, true);
    assert.equal(observer.emitConversationIdentity?.(conversation), true);
  }
  const cleanCall = h.call(clean);
  await until(() => fakes.owners.length, (n) => n === 1, "clean hold");
  const failingCall = h.call(failing);
  await until(() => fakes.owners.length, (n) => n === 2, "failing hold");
  const [cleanOwner, failingOwner] = fakes.owners;
  cleanOwner!.releasePrepare();
  failingOwner!.releasePrepare();
  await Promise.all([cleanCall, failingCall]);
  cleanOwner!.census.set(0);
  failingOwner!.census.set(0);
  await until(() => [h.row(clean).activeTasks, h.row(failing).activeTasks], ([a, b]) => a === 2 && b === 2, "known zero contributions");

  // Losing the proved conversation revokes each lane run: retirement starts, the
  // last census (a known zero) is no longer claimed while the handoff is open.
  h.changes.length = 0;
  assert.equal(h.observers.get(clean)?.emitConversationIdentity?.(CONVERSATION_C), true);
  assert.equal(h.observers.get(failing)?.emitConversationIdentity?.(CONVERSATION_C), true);
  await until(() => cleanOwner!.shutdowns + failingOwner!.shutdowns, (n) => n === 2, "both handoffs started");
  assert.equal(h.row(clean).activeTasks, null, "an unresolved handoff never claims the known zero");
  assert.equal(h.row(failing).activeTasks, null);
  assert.ok(h.changes.includes(clean) && h.changes.includes(failing), "retirement redraws each owning row");

  cleanOwner!.releaseShutdown("ok");
  failingOwner!.releaseShutdown("reject");
  await until(() => h.row(clean).activeTasks, (value) => value === 2, "a clean handoff removes the contribution");
  assert.equal(cleanOwner!.detaches, 1);
  assert.equal(cleanOwner!.census.subscribers, 0, "a settled handoff releases the census subscription");
  await turn();
  assert.equal(failingOwner!.detaches, 0, "the step after a failed shutdown is never attempted");
  assert.equal(h.row(failing).activeTasks, null, "a failed handoff stays unknown, never zero");
  assert.deepEqual(counts(h.row(failing)), { activeTasks: null, activeShells: 1, backgroundTasks: null, backgroundShells: null });
});

test("a declared not-applicable tasks category keeps its N/A reading whatever the managed census says", async (t) => {
  let manager: InstanceManager | undefined;
  let drain: (() => Promise<unknown>) | undefined;
  const fakes = fakeOwners();
  const root = ownedRoot(t, async () => {
    await manager?.dispose();
    fakes.releaseAll();
    await drain?.();
  });
  const h = harness(root, { testHooks: { createOwner: fakes.createOwner } }, (value) => { manager = value; }, (value) => { drain = value; });
  const id = await h.create();
  const observer = h.observers.get(id);
  assert.ok(observer);
  const support = { ...ALL_SUPPORTED, tasks: "unsupported" } as const;
  assert.equal(observer.emit({ busy: false, pendingInput: false, activeShells: 1, support }).accepted, true);
  assert.equal(observer.emitConversationIdentity?.(CONVERSATION_A), true);
  const call = h.call(id);
  await until(() => fakes.owners.length, (n) => n === 1, "hold");
  assert.equal(h.row(id).activeTasks, null);
  assert.equal(h.row(id).statusSupport?.tasks, "unsupported", "the pending hold never rewrites the declaration");
  fakes.owners[0]!.releasePrepare();
  await call;
  fakes.owners[0]!.census.set(3);
  await until(() => fakes.owners[0]!.census.reads, (n) => n >= 2, "census re-read");
  await turn();
  assert.deepEqual({ tasks: h.row(id).activeTasks, support: h.row(id).statusSupport?.tasks, shells: h.row(id).activeShells },
    { tasks: null, support: "unsupported", shells: 1 });
});

test("real owner: the native owner's manager drives its own host census, projected as native + managed known zero", async (t) => {
  let manager: InstanceManager | undefined;
  let drain: (() => Promise<unknown>) | undefined;
  const root = ownedRoot(t, async () => {
    await manager?.dispose();
    await drain?.();
  });
  const managers: ExecutionToolManager[] = [];
  const createOwner = (options: NativeManagedConversationOwnerOptions) => {
    const owner = createNativeManagedConversationOwner(options);
    return Object.freeze({
      delegate: owner.delegate,
      prepare: async () => {
        const result = await owner.prepare();
        if (result.status === "ready") managers.push(result.manager);
        return result;
      },
    });
  };
  const h = harness(root, { testHooks: { createOwner } }, (value) => { manager = value; }, (value) => { drain = value; });
  const id = await h.create();
  const observer = h.observers.get(id);
  assert.ok(observer);
  assert.equal(observer.emit({ busy: false, pendingInput: false, activeTasks: 2, activeShells: 1, support: ALL_SUPPORTED }).accepted, true);
  assert.equal(observer.emitConversationIdentity?.(CONVERSATION_A), true);
  assert.equal(h.row(id).activeTasks, 2);
  await h.call(id);
  assert.equal(managers.length, 1, "the real owner prepared one real manager");
  const census = managers[0]!.activityCensus();
  assert.ok(census, "the native owner's manager opts into its own host census");
  const read = await census.read();
  assert.deepEqual(read.status === "complete" ? read.count : read.status, 0);
  // The real restore found no work: the real controller census is a known zero.
  await until(() => h.row(id).activeTasks, (value) => value === 2, "native 2 + real managed 0");
  assert.deepEqual(counts(h.row(id)), { activeTasks: 2, activeShells: 1, backgroundTasks: null, backgroundShells: null });
  assert.deepEqual(await drain?.(), { status: "clean" });
  drain = undefined;
  await until(() => h.row(id).activeTasks, (value) => value === 2, "after the clean drain the row is native-only");
});

test("a preparation that is not ready stays unknown while the run is current, even after a clean custody settlement or a retained zero census", async (t) => {
  let manager: InstanceManager | undefined;
  let drain: (() => Promise<unknown>) | undefined;
  const fakes = fakeOwners([
    // Restore unavailable: no manager, so custody settles the hold's handoff clean at once.
    () => ({ status: "unavailable", reason: "unreadable" }),
    // Incomplete restore: a retained manager whose census sees only live groups.
    (retained) => ({ status: "failed", reason: "restore-incomplete", retainedManager: retained }),
  ]);
  const root = ownedRoot(t, async () => {
    await manager?.dispose();
    fakes.releaseAll();
    await drain?.();
  });
  const h = harness(root, { testHooks: { createOwner: fakes.createOwner } }, (value) => { manager = value; }, (value) => { drain = value; });
  const unavailable = await h.create();
  const incomplete = await h.create();
  for (const [id, conversation] of [[unavailable, CONVERSATION_A], [incomplete, CONVERSATION_B]] as const) {
    const observer = h.observers.get(id);
    assert.ok(observer);
    assert.equal(observer.emit({ busy: false, pendingInput: false, activeTasks: 2, activeShells: 1, support: ALL_SUPPORTED }).accepted, true);
    assert.equal(observer.emitConversationIdentity?.(conversation), true);
  }
  const unavailableCall = h.call(unavailable);
  await until(() => fakes.owners.length, (n) => n === 1, "unavailable hold");
  const incompleteCall = h.call(incomplete);
  await until(() => fakes.owners.length, (n) => n === 2, "incomplete hold");
  const [unavailableOwner, incompleteOwner] = fakes.owners;
  incompleteOwner!.census.value = { status: "complete", count: 0, tokens: new Set() };
  unavailableOwner!.releasePrepare();
  incompleteOwner!.releasePrepare();
  await Promise.all([unavailableCall, incompleteCall]);
  for (let index = 0; index < 10; index += 1) await turn();
  incompleteOwner!.census.set(0);
  for (let index = 0; index < 10; index += 1) await turn();
  assert.equal(h.row(unavailable).activeTasks, null, "an unavailable restore is never a known zero, even after its clean custody settlement");
  assert.equal(h.row(incomplete).activeTasks, null, "a retained manager's zero census is not read for an incomplete restore");
  assert.equal(incompleteOwner!.census.reads, 0, "only a ready preparation's census is read");
  assert.equal(incompleteOwner!.census.subscribers, 0);
  assert.deepEqual([h.row(unavailable).activeShells, h.row(incomplete).activeShells], [1, 1], "shells unchanged");
});

test("host drain: a current row with a known zero becomes unknown as soon as retirement begins, before its shutdown settles", async (t) => {
  let manager: InstanceManager | undefined;
  let drain: (() => Promise<unknown>) | undefined;
  const fakes = fakeOwners();
  const root = ownedRoot(t, async () => {
    await manager?.dispose();
    fakes.releaseAll();
    await drain?.();
  });
  const h = harness(root, { testHooks: { createOwner: fakes.createOwner } }, (value) => { manager = value; }, (value) => { drain = value; });
  const id = await h.create();
  const observer = h.observers.get(id);
  assert.ok(observer);
  assert.equal(observer.emit({ busy: false, pendingInput: false, activeTasks: 2, activeShells: 1, support: ALL_SUPPORTED }).accepted, true);
  assert.equal(observer.emitConversationIdentity?.(CONVERSATION_A), true);
  const call = h.call(id);
  await until(() => fakes.owners.length, (n) => n === 1, "hold");
  const [owner] = fakes.owners;
  owner!.releasePrepare();
  await call;
  owner!.census.set(0);
  await until(() => h.row(id).activeTasks, (value) => value === 2, "native 2 + known managed 0");

  h.changes.length = 0;
  const drained = drain!();
  await until(() => owner!.shutdowns, (n) => n === 1, "drain started the handoff");
  assert.equal(h.row(id).activeTasks, null, "a drained hold never keeps claiming its known zero while shutdown is blocked");
  assert.ok(h.changes.includes(id), "retirement redraws the owning row");
  owner!.releaseShutdown("ok");
  assert.deepEqual(await drained, { status: "clean" });
  drain = undefined;
  await until(() => h.row(id).activeTasks, (value) => value === 2, "a clean drain handoff removes the contribution");
  assert.equal(owner!.detaches, 1);
});

test("exact-run isolation on one durable slot and conversation: a successor never inherits its predecessor's census", async (t) => {
  let manager: InstanceManager | undefined;
  let drain: (() => Promise<unknown>) | undefined;
  const fakes = fakeOwners();
  const root = ownedRoot(t, async () => {
    await manager?.dispose();
    fakes.releaseAll();
    await drain?.();
  });
  // Both runtime rows resolve to the same durable roster slot.
  const h = harness(root, { resolveSlotId: () => "slot-shared", testHooks: { createOwner: fakes.createOwner } },
    (value) => { manager = value; }, (value) => { drain = value; });
  const predecessor = await h.create();
  const predecessorObserver = h.observers.get(predecessor);
  assert.ok(predecessorObserver);
  assert.equal(predecessorObserver.emit({ busy: false, pendingInput: false, activeTasks: 2, activeShells: 0, support: ALL_SUPPORTED }).accepted, true);
  assert.equal(predecessorObserver.emitConversationIdentity?.(CONVERSATION_A), true);
  const predecessorCall = h.call(predecessor);
  await until(() => fakes.owners.length, (n) => n === 1, "predecessor hold");
  const [first] = fakes.owners;
  assert.equal(first?.options.identity.rowId, "slot-shared");
  first!.releasePrepare();
  await predecessorCall;
  first!.census.set(3);
  await until(() => h.row(predecessor).activeTasks, (value) => value === 5, "predecessor native 2 + managed 3");

  // The predecessor's run is revoked; its handoff blocks in shutdown.
  assert.equal(predecessorObserver.emitConversationIdentity?.(CONVERSATION_C), true);
  await until(() => first!.shutdowns, (n) => n === 1, "predecessor handoff started");
  assert.equal(h.row(predecessor).activeTasks, null);

  // A successor row on the same slot and conversation acquires its own hold, which
  // waits behind the predecessor's handoff: unknown, never the predecessor's count.
  const successor = await h.create();
  const successorObserver = h.observers.get(successor);
  assert.ok(successorObserver);
  assert.equal(successorObserver.emit({ busy: false, pendingInput: false, activeTasks: 1, activeShells: 0, support: ALL_SUPPORTED }).accepted, true);
  assert.equal(successorObserver.emitConversationIdentity?.(CONVERSATION_A), true);
  assert.equal(h.row(successor).activeTasks, 1, "native-only before its own hold");
  const successorCall = h.call(successor);
  await until(() => fakes.owners.length, (n) => n === 2, "successor hold");
  const [, second] = fakes.owners;
  assert.equal(second?.options.identity.rowId, "slot-shared");
  second!.releasePrepare();
  for (let index = 0; index < 10; index += 1) await turn();
  assert.equal(h.row(successor).activeTasks, null, "a successor waiting on the predecessor's handoff is unknown");
  assert.equal(second!.census.reads, 0, "the successor's preparation has not run yet");

  // The predecessor hands off cleanly: it returns to native-only, and the successor
  // projects only its OWN census.
  first!.releaseShutdown("ok");
  await successorCall;
  await until(() => h.row(predecessor).activeTasks, (value) => value === 2, "predecessor native-only after its clean handoff");
  second!.census.set(4);
  await until(() => h.row(successor).activeTasks, (value) => value === 5, "successor native 1 + its own managed 4");
  first!.census.set(9);
  for (let index = 0; index < 10; index += 1) await turn();
  assert.deepEqual([h.row(predecessor).activeTasks, h.row(successor).activeTasks], [2, 5],
    "a retired predecessor census never reaches either row");
});
