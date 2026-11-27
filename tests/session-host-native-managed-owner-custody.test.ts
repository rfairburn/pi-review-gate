/**
 * #682: host custody of one native managed owner per exact durable tuple
 * (`src/session-host/native-managed-owner-custody.ts`).
 *
 * EVIDENCE SCOPE: deterministic ordering tests drive the custody through its
 * test-only owner seam with recording fake owners whose managers expose only
 * `shutdown()`/`detach()` with caller-controlled settlement. The final test uses
 * the real owner (`createNativeManagedConversationOwner`), the real no-Pi
 * `ExecutionToolManager` and controller, and the real owner association store;
 * only the installed Pi SDK the ceiling loads is the policy module's fake seam.
 * No InstanceManager, MCP transport, provider, wake routing, or main.ts startup
 * is exercised.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { ExecutionToolManager } from "../src/execution/tool";
import type { NativeMcpLaneContext, NativeMcpLaneRunScope } from "../src/session-host/instances";
import type {
  NativeManagedConversationOwner,
  NativeManagedConversationOwnerOptions,
} from "../src/session-host/native-managed-conversation-owner";
import { createNativeManagedOwnerCustody } from "../src/session-host/native-managed-owner-custody";
import type { NativeManagedOwnerHandoffFailure } from "../src/session-host/native-managed-owner-custody";
import { NativeManagedAssociationSaveError } from "../src/session-host/native-managed-owner-restore";
import { ExecutionArtifactCleanupRefusal } from "../src/execution/background-group-store";
import type { NativeManagedOwnerRestoreResult } from "../src/session-host/native-managed-owner-restore";
import type { NativeManagedToolOwnerIdentity } from "../src/session-host/native-managed-tool-delegate";
import { toolCallFingerprint } from "../src/tool-call-fingerprint";
import { queuedTask } from "./managed-tool-fixtures";

const CONVERSATION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_CONVERSATION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const WORKSPACE = "/synthetic/workspace";
const IDENTITY: NativeManagedToolOwnerIdentity = Object.freeze({ rowId: "row-a", backend: "claude", workspace: WORKSPACE, conversationId: CONVERSATION });
const PI = Object.freeze({ executable: "/synthetic/pi/dist/cli.js", version: "9.9.9", launchArgs: ["--offline"] });
const SETTINGS = Object.freeze({ env: {}, agentDir: "/synthetic/agent" });

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every queued microtask and one macrotask turn run. */
async function flush(turns = 5): Promise<void> {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Whether a promise has settled after the queue was flushed. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await flush();
  return done;
}

function makeRun(): { run: NativeMcpLaneRunScope; revoke(): void } {
  const controller = new AbortController();
  let current = true;
  const run: NativeMcpLaneRunScope = Object.freeze({ signal: controller.signal, isCurrent: () => current && !controller.signal.aborted });
  return { run, revoke: () => { current = false; controller.abort(); } };
}

/** One request on a lane of `run`; `abort()` cancels only this request. */
function lane(run: NativeMcpLaneRunScope, identity: NativeManagedToolOwnerIdentity = IDENTITY): { context: NativeMcpLaneContext; abort(): void } {
  const request = new AbortController();
  const signal = AbortSignal.any([request.signal, run.signal]);
  const context: NativeMcpLaneContext = Object.freeze({ ...identity, signal, isCurrent: () => !signal.aborted && run.isCurrent(), run });
  return { context, abort: () => request.abort() };
}

/** A recording fake manager: only the canonical lifecycle, settled by the test. */
class FakeManager {
  shutdownCalls = 0;
  detachCalls = 0;
  readonly shutdownGate = deferred();
  readonly detachGate = deferred();
  constructor(private readonly label: string, private readonly events: string[]) {}
  shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.events.push(`shutdown:${this.label}`);
    return this.shutdownGate.promise;
  }
  detach(): Promise<void> {
    this.detachCalls += 1;
    this.events.push(`detach:${this.label}`);
    return this.detachGate.promise;
  }
  /** Let both steps complete immediately. */
  settleCleanly(): this {
    this.shutdownGate.resolve();
    this.detachGate.resolve();
    return this;
  }
}

type FakeResult = (manager: ExecutionToolManager) => NativeManagedOwnerRestoreResult<ExecutionToolManager>;
const READY: FakeResult = (manager) => ({ status: "ready", manager, source: "absent" });

interface FakeHarness {
  readonly events: string[];
  readonly managers: Map<string, FakeManager>;
  readonly prepareCalls: Map<string, number>;
  readonly delegateCalls: string[];
  /** Per label: what the fake owner's prepare resolves to. */
  readonly results: Map<string, FakeResult>;
  readonly custody: ReturnType<typeof createNativeManagedOwnerCustody>;
  acquire(label: string, run: NativeMcpLaneRunScope, identity?: NativeManagedToolOwnerIdentity): ReturnType<ReturnType<typeof createNativeManagedOwnerCustody>["acquire"]>;
}

function fakeHarness(): FakeHarness {
  const events: string[] = [];
  const managers = new Map<string, FakeManager>();
  const prepareCalls = new Map<string, number>();
  const delegateCalls: string[] = [];
  const results = new Map<string, FakeResult>();
  const labels = new WeakMap<NativeMcpLaneRunScope, string>();
  const custody = createNativeManagedOwnerCustody({
    stateRoot: "/synthetic/state",
    testHooks: {
      createOwner: (options: NativeManagedConversationOwnerOptions): NativeManagedConversationOwner => {
        assert.equal(options.stateRoot, "/synthetic/state", "the custody's state root binds every owner");
        const label = labels.get(options.run)!;
        const manager = new FakeManager(label, events);
        managers.set(label, manager);
        return {
          delegate: {
            listTools: async () => {
              delegateCalls.push(`list:${label}`);
              return [{ name: "SubtasksStart", inputSchema: { type: "object" } }];
            },
            callTool: async (_context, call) => {
              delegateCalls.push(`call:${label}:${call.name}`);
              return { content: [{ type: "text", text: "ok" }], isError: false };
            },
          },
          prepare: async () => {
            prepareCalls.set(label, (prepareCalls.get(label) ?? 0) + 1);
            events.push(`prepare:${label}`);
            return (results.get(label) ?? READY)(manager as unknown as ExecutionToolManager);
          },
        };
      },
    },
  });
  return {
    events,
    managers,
    prepareCalls,
    delegateCalls,
    results,
    custody,
    acquire: (label, run, identity = IDENTITY) => {
      labels.set(run, label);
      return custody.acquire({ run, identity, settings: SETTINGS, pi: PI });
    },
  };
}

test("same tuple: the successor restores only after the predecessor's shutdown and detach both completed", async () => {
  const h = fakeHarness();
  const first = makeRun();
  const a = h.acquire("A", first.run);
  assert.equal((await a.prepare()).status, "ready");
  const second = makeRun();
  const b = h.acquire("B", second.run);
  const bPrepared = b.prepare();

  assert.equal(await settled(bPrepared), false, "no successor restore while the predecessor run is current");
  assert.deepEqual(h.events, ["prepare:A"]);
  assert.equal(h.managers.get("A")!.shutdownCalls, 0);

  first.revoke();
  await flush();
  assert.deepEqual(h.events, ["prepare:A", "shutdown:A"], "revocation hands off through shutdown first");
  assert.deepEqual(await a.delegate.listTools(lane(first.run).context), [], "admissions closed on revocation");
  assert.equal(await settled(bPrepared), false);

  h.managers.get("A")!.shutdownGate.resolve();
  await flush();
  assert.deepEqual(h.events, ["prepare:A", "shutdown:A", "detach:A"], "detach only after shutdown completed");
  assert.equal(await settled(bPrepared), false, "still no restore while detach is pending");

  h.managers.get("A")!.detachGate.resolve();
  assert.equal(await a.handoff, "clean");
  const bResult = await bPrepared;
  assert.equal(bResult.status, "ready");
  assert.equal(bResult.status === "ready" && bResult.manager, h.managers.get("B") as unknown as ExecutionToolManager);
  assert.deepEqual(h.events, ["prepare:A", "shutdown:A", "detach:A", "prepare:B"]);
  assert.equal(h.managers.get("A")!.shutdownCalls, 1);
  assert.equal(h.managers.get("A")!.detachCalls, 1);

  // A third holder of the same tuple waits on B in turn.
  const third = makeRun();
  const c = h.acquire("C", third.run);
  const cPrepared = c.prepare();
  assert.equal(await settled(cPrepared), false);
  h.managers.get("B")!.settleCleanly();
  second.revoke();
  assert.equal((await cPrepared).status, "ready");
  assert.equal(await b.handoff, "clean");
  h.managers.get("C")!.settleCleanly();
  assert.deepEqual(await h.custody.drain(), { status: "clean" });
});

test("distinct tuples never serialize on each other", async () => {
  const h = fakeHarness();
  const held = makeRun();
  const a = h.acquire("A", held.run);
  assert.equal((await a.prepare()).status, "ready");
  for (const [label, identity] of [
    ["other-conversation", { ...IDENTITY, conversationId: OTHER_CONVERSATION }],
    ["other-row", { ...IDENTITY, rowId: "row-b" }],
    ["other-backend", { ...IDENTITY, backend: "codex" as const }],
    ["other-workspace", { ...IDENTITY, workspace: "/synthetic/other-workspace" }],
  ] as const) {
    const run = makeRun();
    const hold = h.acquire(label, run.run, identity);
    assert.equal((await hold.prepare()).status, "ready", label);
    h.managers.get(label)!.settleCleanly();
  }
  assert.equal(h.managers.get("A")!.shutdownCalls, 0, "the held tuple's manager was never touched");
  h.managers.get("A")!.settleCleanly();
  assert.deepEqual(await h.custody.drain(), { status: "clean" });
});

test("one preparation per run, and a request's abort neither retires nor cancels", async () => {
  const h = fakeHarness();
  const { run, revoke } = makeRun();
  const hold = h.acquire("A", run);
  assert.throws(() => h.acquire("A2", run), /prepared at most once/);
  assert.throws(() => h.acquire("A3", run, { ...IDENTITY, rowId: "row-b" }), /prepared at most once/, "whatever the tuple");
  const [r1, r2] = await Promise.all([hold.prepare(), hold.prepare()]);
  assert.equal(r1, r2);
  assert.equal((await hold.prepare()).status, "ready");
  assert.equal(h.prepareCalls.get("A"), 1, "the owner prepares exactly once");

  const request = lane(run);
  request.abort();
  await flush();
  assert.equal(h.managers.get("A")!.shutdownCalls, 0, "a request's cancellation never retires the owner");
  assert.equal(await settled(hold.handoff), false);
  // The aborted request itself is the owner delegate's to refuse; the custody stays open.
  await hold.delegate.callTool(lane(run).context, { name: "SubtasksStart", arguments: {} });
  assert.deepEqual(h.delegateCalls, ["call:A:SubtasksStart"]);

  revoke();
  await flush();
  assert.equal(h.managers.get("A")!.shutdownCalls, 1, "only the run's revocation retires it");
  assert.equal(await hold.delegate.callTool(lane(run).context, { name: "SubtasksStart", arguments: {} }), undefined);
  assert.deepEqual(h.delegateCalls, ["call:A:SubtasksStart"], "nothing reaches the owner after retirement begins");
  const stale = await hold.prepare();
  assert.equal(stale.status, "stale");
  assert.equal(stale.status === "stale" && stale.retainedManager, h.managers.get("A") as unknown as ExecutionToolManager);
  h.managers.get("A")!.settleCleanly();
  assert.equal(await hold.handoff, "clean");
});

for (const failing of ["shutdown", "detach"] as const) {
  test(`a failed ${failing} poisons the tuple: the successor is refused and nothing is claimed clean`, async () => {
    const h = fakeHarness();
    const first = makeRun();
    const a = h.acquire("A", first.run);
    assert.equal((await a.prepare()).status, "ready");
    const second = makeRun();
    const b = h.acquire("B", second.run);
    const bPrepared = b.prepare();
    const manager = h.managers.get("A")!;
    if (failing === "shutdown") {
      manager.shutdownGate.reject(new Error("synthetic shutdown failure"));
    } else {
      manager.shutdownGate.resolve();
      manager.detachGate.reject(new Error("synthetic detach failure"));
    }
    first.revoke();

    assert.deepEqual(await bPrepared, { status: "refused", reason: "predecessor-handoff-failed" });
    assert.equal(await a.handoff, "failed");
    assert.equal(h.prepareCalls.get("B"), undefined, "no successor restore while the old manager may still write");
    assert.equal(manager.detachCalls, failing === "shutdown" ? 0 : 1, "no step after a failed one");
    assert.deepEqual(await b.delegate.listTools(lane(second.run).context), []);

    // Sticky: a later holder of the tuple is refused at once, another tuple is not.
    const c = h.acquire("C", makeRun().run);
    assert.deepEqual(await c.prepare(), { status: "refused", reason: "predecessor-handoff-failed" });
    assert.equal(h.managers.has("C"), false, "no owner is even constructed");
    const otherRun = makeRun();
    const other = h.acquire("other", otherRun.run, { ...IDENTITY, conversationId: OTHER_CONVERSATION });
    assert.equal((await other.prepare()).status, "ready");
    h.managers.get("other")!.settleCleanly();

    second.revoke();
    assert.equal(await b.handoff, "failed");
    assert.equal((await h.custody.drain()).status, "failed", "the drain never reports clean");
  });
}

/**
 * #780 diagnostics phase: the drain names WHICH canonical step failed, with a
 * CLOSED reason and the failed tuple's backend and roster slot row. Nothing here
 * reads or forwards the error: every case rejects with a value carrying a path
 * and a marker the result must never contain.
 */
const SECRET = "PRG-DIAGNOSTIC-SECRET";
const leakProof = (value: unknown): string => {
  const rendered = JSON.stringify(value);
  for (const forbidden of [SECRET, "/home/example-user", "wave-", "Refusing to remove"]) {
    assert.ok(!rendered.includes(forbidden), `the drain result must not carry ${forbidden}: ${rendered}`);
  }
  return rendered;
};

/** A manager whose canonical steps behave as the scenario says. */
function customManager(handlers: Partial<Record<"shutdown" | "detach", () => unknown>>): ExecutionToolManager {
  return {
    shutdown: handlers.shutdown ?? (async () => undefined),
    detach: handlers.detach ?? (async () => undefined),
  } as unknown as ExecutionToolManager;
}

interface DiagnosticCase {
  readonly name: string;
  readonly result: (manager: ExecutionToolManager) => NativeManagedOwnerRestoreResult<ExecutionToolManager>;
  readonly expected: Pick<NativeManagedOwnerHandoffFailure, "stage" | "reason">;
}

const diagnosticCases: readonly DiagnosticCase[] = [
  {
    name: "a manager without the canonical lifecycle",
    result: () => ({ status: "ready", manager: {} as ExecutionToolManager, source: "absent" }),
    expected: { stage: "lifecycle", reason: "lifecycle-unavailable" },
  },
  {
    name: "shutdown throwing synchronously with a known code",
    result: () => ({
      status: "ready",
      manager: customManager({ shutdown: () => {
        throw Object.assign(new Error(`Refusing to remove unrecognized wave root: /home/example-user/${SECRET}/wave-0123`), { code: "EACCES" });
      } }),
      source: "absent",
    }),
    expected: { stage: "shutdown", reason: "not-permitted" },
  },
  {
    name: "shutdown rejecting with the owner's association save error",
    result: () => ({
      status: "ready",
      manager: customManager({ shutdown: async () => {
        throw new NativeManagedAssociationSaveError(`failed: publication-failed ${SECRET}`);
      } }),
      source: "absent",
    }),
    expected: { stage: "shutdown", reason: "association-publication-failed" },
  },
  {
    name: "the cleanup ownership guard rejecting a wave root without exposing its path",
    result: () => ({
      status: "ready",
      manager: customManager({ shutdown: async () => {
        throw new ExecutionArtifactCleanupRefusal(`Refusing to remove unrecognized wave root: /home/example-user/${SECRET}`);
      } }),
      source: "absent",
    }),
    expected: { stage: "shutdown", reason: "artifact-cleanup-refused" },
  },
  {
    name: "detach rejecting after shutdown completed",
    result: () => ({
      status: "ready",
      manager: customManager({ detach: async () => {
        throw Object.assign(new Error(`EBUSY /home/example-user/${SECRET}`), { code: "ABORT_ERR" });
      } }),
      source: "absent",
    }),
    expected: { stage: "detach", reason: "aborted" },
  },
  {
    name: "a rejection whose code is not in the closed set",
    result: () => ({
      status: "ready",
      manager: customManager({ shutdown: async () => {
        throw Object.assign(new Error(`Refusing to remove unrecognized wave root: /home/example-user/${SECRET}`), { code: "constructor" });
      } }),
      source: "absent",
    }),
    expected: { stage: "shutdown", reason: "rejected" },
  },
  {
    name: "a synchronous throw with nothing classifiable",
    result: () => ({
      status: "ready",
      manager: customManager({ shutdown: () => {
        throw new Error(`/home/example-user/${SECRET}`);
      } }),
      source: "absent",
    }),
    expected: { stage: "shutdown", reason: "threw" },
  },
  {
    name: "an error whose code accessor throws",
    result: () => ({
      status: "ready",
      manager: customManager({ shutdown: async () => {
        throw { name: "Opaque", get code(): string { throw new Error(SECRET); } };
      } }),
      source: "absent",
    }),
    expected: { stage: "shutdown", reason: "rejected" },
  },
];

for (const scenario of diagnosticCases) {
  test(`the drain names the failing stage and a closed reason for ${scenario.name}`, async () => {
    const h = fakeHarness();
    h.results.set("A", scenario.result);
    const { run, revoke } = makeRun();
    const a = h.acquire("A", run);
    assert.equal((await a.prepare()).status, "ready");
    revoke();
    assert.equal(await a.handoff, "failed", "the verdict itself is unchanged");
    const drained = await h.custody.drain();
    assert.ok(drained.status === "failed", JSON.stringify(drained));
    assert.deepEqual(drained.failures, [{ ...scenario.expected, backend: "claude", rowId: "row-a" }]);
    leakProof(drained);
  });
}

for (const [property, value] of [["code", "EACCES"], ["name", "AbortError"]] as const) {
  test(`the drain does not invoke an error's ${property} getter`, async () => {
    let getterCalls = 0;
    const error = new Error(SECRET);
    Object.defineProperty(error, property, { get() { getterCalls += 1; return value; } });
    const h = fakeHarness();
    h.results.set("A", () => ({
      status: "ready", source: "absent",
      manager: customManager({ shutdown: async () => { throw error; } }),
    }));
    const { run } = makeRun();
    const hold = h.acquire("A", run);
    assert.equal((await hold.prepare()).status, "ready");
    assert.deepEqual(await h.custody.drain(), {
      status: "failed",
      failures: [{ stage: "shutdown", reason: "rejected", backend: "claude", rowId: "row-a" }],
    });
    assert.equal(getterCalls, 0);
  });
}

/**
 * A rejection value must never get to run code during a handoff that previously
 * ignored it: neither as a Proxy itself, nor as a Proxy that only sits on the
 * prototype chain (which a chain walk or `instanceof` would enter).
 */
for (const shape of ["a direct Proxy", "an ordinary object with a Proxy prototype"] as const) {
  test(`the drain never introspects ${shape}`, async () => {
    const traps: string[] = [];
    const handler: ProxyHandler<Error> = {
      get: (target, property) => { traps.push(`get:${String(property)}`); return Reflect.get(target, property); },
      has: (target, property) => { traps.push(`has:${String(property)}`); return Reflect.has(target, property); },
      getPrototypeOf: (target) => { traps.push("getPrototypeOf"); return Reflect.getPrototypeOf(target); },
      getOwnPropertyDescriptor: (target, property) => {
        traps.push(`getOwnPropertyDescriptor:${String(property)}`);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    };
    const proxy = new Proxy(new Error(SECRET), handler);
    const error: object = shape === "a direct Proxy" ? proxy : Object.create(proxy);
    const h = fakeHarness();
    h.results.set("A", () => ({
      status: "ready", source: "absent",
      manager: customManager({ shutdown: async () => { throw error; } }),
    }));
    const { run } = makeRun();
    const hold = h.acquire("A", run);
    assert.equal((await hold.prepare()).status, "ready");
    assert.deepEqual(await h.custody.drain(), {
      status: "failed",
      failures: [{ stage: "shutdown", reason: "rejected", backend: "claude", rowId: "row-a" }],
    });
    assert.deepEqual(traps, [], "no Proxy trap may run while classifying a handoff failure");
  });
}

test("the drain names each failed tuple once, and never a tuple that handed off clean", async () => {
  const h = fakeHarness();
  const first = makeRun();
  const a = h.acquire("A", first.run);
  assert.equal((await a.prepare()).status, "ready");
  const otherRun = makeRun();
  const other = h.acquire("other", otherRun.run, { ...IDENTITY, rowId: "row-b", backend: "codex" });
  assert.equal((await other.prepare()).status, "ready");
  h.managers.get("A")!.shutdownGate.reject(Object.assign(
    new Error(`EBUSY: resource busy or locked, rename '/home/example-user/${SECRET}'`),
    { code: "EBUSY" },
  ));
  first.revoke();
  assert.equal(await a.handoff, "failed");

  // A successor of the failed tuple inherits the verdict, not a second record.
  const successor = h.acquire("B", makeRun().run);
  assert.deepEqual(await successor.prepare(), { status: "refused", reason: "predecessor-handoff-failed" });
  assert.equal(await successor.handoff, "failed");

  // The other tuple hands off clean and is never named.
  h.managers.get("other")!.settleCleanly();
  otherRun.revoke();
  assert.equal(await other.handoff, "clean");

  const drained = await h.custody.drain();
  assert.ok(drained.status === "failed", JSON.stringify(drained));
  assert.deepEqual(drained.failures, [
    { stage: "shutdown", reason: "busy", backend: "claude", rowId: "row-a" },
  ], "one record naming the step and tuple that actually failed");
  leakProof(drained);
});

test("a clean drain still reports clean and carries no diagnostics", async () => {
  const h = fakeHarness();
  const { run, revoke } = makeRun();
  const a = h.acquire("A", run);
  assert.equal((await a.prepare()).status, "ready");
  h.managers.get("A")!.settleCleanly();
  revoke();
  assert.equal(await a.handoff, "clean");
  assert.deepEqual(await h.custody.drain(), { status: "clean" });
});
test("an unsettled handoff keeps successors waiting; a waiting run revoked settles stale without restoring", async () => {
  const h = fakeHarness();
  const first = makeRun();
  const a = h.acquire("A", first.run);
  assert.equal((await a.prepare()).status, "ready");
  first.revoke();
  await flush();
  const manager = h.managers.get("A")!;
  assert.equal(manager.shutdownCalls, 1);

  const second = makeRun();
  const b = h.acquire("B", second.run);
  const bPrepared = b.prepare();
  assert.equal(await settled(bPrepared), false, "the shutdown has not settled");
  second.revoke();
  assert.deepEqual(await bPrepared, { status: "stale" });
  assert.equal(h.prepareCalls.get("B"), undefined, "the revoked waiter never restored");
  assert.equal(await settled(b.handoff), false, "the waiter's chain still waits on the unsettled predecessor");

  const third = makeRun();
  const c = h.acquire("C", third.run);
  const cPrepared = c.prepare();
  assert.equal(await settled(cPrepared), false);

  // The host drain stops waiting on its own signal and never forces anything.
  const stop = new AbortController();
  const drained = h.custody.drain({ signal: stop.signal });
  assert.equal(await settled(drained), false);
  stop.abort();
  assert.deepEqual(await drained, { status: "unsettled" });
  assert.equal(manager.shutdownCalls, 1);
  assert.equal(manager.detachCalls, 0);
  assert.deepEqual(await cPrepared, { status: "refused", reason: "host-draining" }, "the drain refused the waiting successor");
  assert.equal(h.prepareCalls.get("C"), undefined);

  // Once the handoff completes, the whole chain settles clean.
  manager.settleCleanly();
  assert.equal(await a.handoff, "clean");
  assert.equal(await b.handoff, "clean");
  assert.equal(await c.handoff, "clean");
  assert.deepEqual(await h.custody.drain(), { status: "clean" });
});

test("a retained manager from a stale or failed preparation is handed off on revocation too", async () => {
  const h = fakeHarness();
  h.results.set("A", (manager) => ({ status: "failed", reason: "restore-incomplete", retainedManager: manager }));
  h.results.set("B", () => ({ status: "unavailable", reason: "malformed" }));
  const first = makeRun();
  const a = h.acquire("A", first.run);
  assert.equal((await a.prepare()).status, "failed");
  const second = makeRun();
  const b = h.acquire("B", second.run);
  const bPrepared = b.prepare();
  assert.equal(await settled(bPrepared), false, "a retained manager can still write");
  h.managers.get("A")!.settleCleanly();
  first.revoke();
  assert.deepEqual(await bPrepared, { status: "unavailable", reason: "malformed" });
  assert.equal(h.managers.get("A")!.detachCalls, 1);
  second.revoke();
  assert.equal(await b.handoff, "clean", "no manager was constructed, nothing to hand off");
  assert.equal(h.managers.get("B")!.shutdownCalls, 0);
});

test("host drain retires current runs, refuses new acquires, and reports clean only after every handoff", async () => {
  const h = fakeHarness();
  const runs = [makeRun(), makeRun()];
  const a = h.acquire("A", runs[0]!.run);
  const other = h.acquire("other", runs[1]!.run, { ...IDENTITY, rowId: "row-b" });
  assert.equal((await a.prepare()).status, "ready");
  assert.equal((await other.prepare()).status, "ready");

  const drained = h.custody.drain();
  await flush();
  assert.equal(h.managers.get("A")!.shutdownCalls, 1, "the drain retires a still-current run");
  assert.equal(h.managers.get("other")!.shutdownCalls, 1);
  assert.deepEqual(await a.delegate.listTools(lane(runs[0]!.run).context), [], "admissions closed");
  assert.deepEqual(h.delegateCalls, []);
  const late = h.acquire("late", makeRun().run);
  assert.deepEqual(await late.prepare(), { status: "refused", reason: "host-draining" });
  assert.equal(h.managers.has("late"), false);

  assert.equal(await settled(drained), false);
  h.managers.get("A")!.settleCleanly();
  assert.equal(await settled(drained), false, "one handoff is still pending");
  h.managers.get("other")!.settleCleanly();
  assert.deepEqual(await drained, { status: "clean" });
});

test("a failed handoff refuses every already-queued holder at once, without revoking them", async () => {
  const h = fakeHarness();
  const first = makeRun();
  const a = h.acquire("A", first.run);
  assert.equal((await a.prepare()).status, "ready");
  const second = makeRun();
  const third = makeRun();
  const b = h.acquire("B", second.run);
  const c = h.acquire("C", third.run);
  const [bPrepared, cPrepared] = [b.prepare(), c.prepare()];
  assert.equal(await settled(bPrepared), false);
  assert.equal(await settled(cPrepared), false);

  h.managers.get("A")!.shutdownGate.reject(new Error("synthetic shutdown failure"));
  first.revoke();
  // B and C stay current: neither is retired, yet the failure reaches both.
  assert.deepEqual(await bPrepared, { status: "refused", reason: "predecessor-handoff-failed" });
  assert.deepEqual(await cPrepared, { status: "refused", reason: "predecessor-handoff-failed" });
  assert.equal(await a.handoff, "failed");
  assert.equal(await b.handoff, "failed");
  assert.equal(await c.handoff, "failed");
  assert.equal(h.prepareCalls.get("B"), undefined);
  assert.equal(h.prepareCalls.get("C"), undefined);
  assert.equal(h.managers.get("A")!.detachCalls, 0);
  assert.equal(second.run.isCurrent() && third.run.isCurrent(), true);
  assert.equal((await h.custody.drain()).status, "failed");
});

test("a same-tuple acquire refused during drain reports the tuple's real handoff, never an unconditional clean", async () => {
  const h = fakeHarness();
  const first = makeRun();
  const a = h.acquire("A", first.run);
  assert.equal((await a.prepare()).status, "ready");
  const drained = h.custody.drain();
  await flush();
  assert.equal(h.managers.get("A")!.shutdownCalls, 1, "the drain began A's handoff");

  const late = h.acquire("late", makeRun().run);
  assert.deepEqual(await late.prepare(), { status: "refused", reason: "host-draining" });
  assert.equal(h.managers.has("late"), false);
  assert.equal(await settled(late.handoff), false, "A is still shutting down");

  // A tuple with no earlier holder reports clean at once.
  const unrelated = h.acquire("unrelated", makeRun().run, { ...IDENTITY, rowId: "row-z" });
  assert.equal(await unrelated.handoff, "clean");

  h.managers.get("A")!.shutdownGate.reject(new Error("synthetic shutdown failure"));
  assert.equal(await late.handoff, "failed");
  assert.equal((await drained).status, "failed");
  // Once the tuple is poisoned, a later refused acquire reports failed too.
  const after = h.acquire("after", makeRun().run);
  assert.deepEqual(await after.prepare(), { status: "refused", reason: "host-draining" });
  assert.equal(await after.handoff, "failed");
});

test("the real owner and manager: revocation stops and detaches the old manager before the same tuple restores", async (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "prg-native-managed-owner-custody-tests-"));
  const stateRoot = join(root, "session-host");
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  // The real controller places (and prunes) execution and wave artifacts under
  // the platform temp directory: keep it private to this test through the drain.
  const artifacts = join(root, "artifacts");
  const tempVars = ["TMPDIR", "TMP", "TEMP"] as const;
  const originalTemp = tempVars.map((key) => process.env[key]);
  const custody = createNativeManagedOwnerCustody({ stateRoot });
  t.after(async () => {
    try {
      await custody.drain();
    } finally {
      for (const [index, key] of tempVars.entries()) {
        const value = originalTemp[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(workspace);
  mkdirSync(agentDir);
  mkdirSync(artifacts);
  for (const key of tempVars) process.env[key] = artifacts;
  writeFileSync(join(agentDir, "review-gate.json"), JSON.stringify({
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
  }));
  const identity: NativeManagedToolOwnerIdentity = Object.freeze({ rowId: "row-a", backend: "claude", workspace, conversationId: CONVERSATION });
  const acquire = (run: NativeMcpLaneRunScope) => custody.acquire({
    run,
    identity,
    settings: { env: {}, agentDir },
    pi: PI,
    testHooks: {
      ceiling: {
        loadSdk: () => ({
          parseArgs: () => ({ offline: true }),
          createReadToolDefinition: () => ({ name: "read", description: "Read files." }),
          createBashToolDefinition: () => ({ name: "bash", description: "Execute a command." }),
        }),
        nativePowerShellSupported: () => false,
      },
    },
  });

  const first = makeRun();
  const a = acquire(first.run);
  const aResult = await a.prepare();
  assert.equal(aResult.status, "ready", JSON.stringify(aResult));
  const manager = (aResult as { manager: ExecutionToolManager }).manager;
  // One worker slot: the first task dispatches, the second stays queued.
  const args = { tasks: [queuedTask("custody start"), queuedTask("custody queued")] };
  const started = await a.delegate.callTool(lane(first.run, identity).context, { name: "SubtasksStart", arguments: args });
  assert.equal(started?.isError, false, JSON.stringify(started));
  const liveness = manager.startLiveness(toolCallFingerprint("SubtasksStart", args)!) as { state: string; identity?: string };
  assert.equal(liveness.state, "active");
  const executionId = liveness.identity!;
  const roots = manager.associations().groupRoots ?? [];
  assert.equal(roots.length, 1);
  assert.equal(dirname(roots[0]!), artifacts, "the real controller uses the test-owned temp directory");
  const controller = (manager as unknown as { controller: { groups: Map<string, { tasks: Array<{ taskId: string; state: string }> }> } }).controller;
  const [task, queued] = controller.groups.get(executionId)!.tasks;
  assert.ok(task && queued);
  assert.equal(queued.state, "queued");

  // A request's abort leaves the work running.
  const request = lane(first.run, identity);
  request.abort();
  await flush();
  assert.equal((manager.startLiveness(toolCallFingerprint("SubtasksStart", args)!) as { state: string }).state, "active");

  // The successor waits; revocation hands off through the canonical path.
  const second = makeRun();
  const b = acquire(second.run);
  const bPrepared = b.prepare();
  assert.equal(await settled(bPrepared), false, "no same-tuple restore while the first manager holds the run");
  first.revoke();
  assert.equal(await a.handoff, "clean");
  assert.equal(queued.state, "stopped_for_application_exit", "the canonical shutdown recorded the stop");
  assert.equal(manager.startLiveness(toolCallFingerprint("SubtasksStart", args)!).state === "active", false, "the old runtime settled");
  assert.equal(controller.groups.size, 0, "detach released the old manager's groups");

  const bResult = await bPrepared;
  assert.equal(bResult.status, "ready", JSON.stringify(bResult));
  const successor = (bResult as { manager: ExecutionToolManager }).manager;
  assert.notEqual(successor, manager);
  assert.deepEqual(successor.associations().groupRoots, roots, "the exact restore picked up the handed-off work");
  for (const taskId of [task.taskId, queued.taskId]) {
    const inspected = await b.delegate.callTool(lane(second.run, identity).context, { name: "SubtasksInspect", arguments: { taskId } });
    assert.equal(inspected?.isError, false, JSON.stringify(inspected));
  }
  assert.deepEqual(await a.delegate.listTools(lane(first.run, identity).context), [], "the retired run reaches nothing");
  assert.deepEqual(await custody.drain(), { status: "clean" });
});
