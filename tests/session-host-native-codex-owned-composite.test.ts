/**
 * Synchronous owned Codex backend + relay composite lease.
 *
 * The backend and relay here are focused stand-ins: the tests prove THIS
 * module's ordering, dual-lane capability, stop latch, retained root-facts
 * wiring, and settlement algebra without a provider, model, real Codex binary,
 * or real TUI. One census test uses the repository's fake app-server over a real
 * loopback WebSocket so the production read-only probe path is exercised
 * end-to-end (initialize + thread/loaded/list, then its own socket close).
 *
 * What these tests do NOT prove: that a live Codex 0.169 TUI/relay pair works,
 * that the relay forwards unchanged bytes (its own suite covers that), or that
 * any observed start response is a root outside this fresh sequence.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  OwnedCodexBackendLaunchIdentity,
  OwnedCodexBackendLease,
  OwnedCodexBackendReady,
  OwnedCodexBackendSettlement,
  OwnedCodexBackendStatus,
  OwnedCodexTuiConnection,
} from "../src/session-host/native-codex-backend";
import type { OwnedCodexBackendFactory, OwnedCodexBackendLaunchRequest } from "../src/session-host/instances";
import type { NativeCodexOwnedLaunchPlan } from "../src/session-host/native-cli-launch";
import {
  createRelayedOwnedCodexBackendFactory,
  NativeCodexOwnedCompositeError,
  type RelayedOwnedCodexBackendOptions,
} from "../src/session-host/native-codex-owned-composite";
import type { NativeCodexTuiRootFactsSnapshot } from "../src/session-host/native-codex-tui-root-facts";
import {
  NativeCodexTuiRelayError,
  type NativeCodexTuiRelayInput,
  type NativeCodexTuiRelayLease,
  type NativeCodexTuiRelayMetadataEvent,
  type NativeCodexTuiRelayReadiness,
  type NativeCodexTuiRelaySettlement,
  type NativeCodexTuiRelayStatus,
} from "../src/session-host/native-codex-tui-relay";
import { FakeCodexAppServer } from "./session-host-native-codex-rpc-fixture";

/* --------------------------------------------------------------- fixtures */

const IDENTITY: OwnedCodexBackendLaunchIdentity = Object.freeze({ leaseId: "composite-lease", generation: 7 });
const BACKEND_ENDPOINT = "ws://127.0.0.1:54321";
const BACKEND_BEARER = "backend-bearer-composite";
const AUTH_ENV_NAME = "PI_REVIEW_GATE_OWNED_CODEX_RPC_COMPOSITE";
const RELAY_ENDPOINT = "ws://127.0.0.1:61001";
const NOT_CREATED: OwnedCodexBackendSettlement = Object.freeze({ status: "settled", child: "not-created" });

const BACKEND_TUI: OwnedCodexTuiConnection = Object.freeze({
  endpoint: BACKEND_ENDPOINT,
  args: Object.freeze(["--remote", BACKEND_ENDPOINT, "--remote-auth-token-env", AUTH_ENV_NAME]),
  env: Object.freeze({ PATH: "/usr/bin", HOME: "/home/operator", [AUTH_ENV_NAME]: BACKEND_BEARER }),
});

const RELAY_TUI: OwnedCodexTuiConnection = Object.freeze({
  endpoint: RELAY_ENDPOINT,
  args: Object.freeze(["--remote", RELAY_ENDPOINT, "--remote-auth-token-env", AUTH_ENV_NAME]),
  env: Object.freeze({ PATH: "/usr/bin", HOME: "/home/operator", [AUTH_ENV_NAME]: BACKEND_BEARER }),
});

const RELAY_STATUS: NativeCodexTuiRelayStatus = Object.freeze({
  phase: "listening",
  listening: true,
  stopRequested: false,
  activeConnections: 0,
  connectionGenerations: 0,
  openSockets: 0,
  refusedUnauthenticated: 0,
  refusedBusy: 0,
  refusedMalformed: 0,
  metadataTapEnabled: true,
  metadataCallbackErrors: 0,
  forwardedBytesToBackend: 0,
  forwardedBytesToClient: 0,
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function until(condition: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function bounded<T>(promise: Promise<T>, message: string, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${message}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function expectPending(promise: Promise<unknown>, message: string, ms = 40): Promise<void> {
  const pending = Symbol("pending");
  const outcome = await Promise.race([
    promise.then(() => "settled" as const, () => "rejected" as const),
    new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), ms)),
  ]);
  assert.equal(outcome, pending, message);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await bounded(promise, "expected rejection");
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

/* ----------------------------------------------------------- fake backend */

class FakeBackend {
  readonly readiness = deferred<OwnedCodexBackendReady>();
  readonly settlement = deferred<OwnedCodexBackendSettlement>();
  readonly ready: OwnedCodexBackendReady = Object.freeze({
    endpoint: BACKEND_ENDPOINT,
    readObserverBearer: (): string => BACKEND_BEARER,
    createTuiConnection: (): OwnedCodexTuiConnection => BACKEND_TUI,
  });
  stopCalls = 0;
  exitObserved = false;
  settled = false;
  forceEscalationAttempted = false;

  lease(): OwnedCodexBackendLease {
    return {
      identity: IDENTITY,
      readiness: this.readiness.promise,
      settlement: this.settlement.promise,
      status: (): OwnedCodexBackendStatus => this.status(),
      requestStop: (): void => {
        this.stopCalls += 1;
      },
    };
  }

  status(): OwnedCodexBackendStatus {
    return Object.freeze({
      identity: IDENTITY,
      phase: this.settled ? "settled" : this.exitObserved ? "exited" : "ready",
      ready: true,
      readinessFailure: undefined,
      stopRequested: this.stopCalls > 0,
      childWitnessed: true,
      spawnObserved: true,
      spawnFailureObserved: false,
      exitObserved: this.exitObserved,
      stdoutEnded: this.settled,
      stderrEnded: this.settled,
      settled: this.settled,
      terminationAttempted: false,
      terminationFailed: false,
      forceEscalationAttempted: this.forceEscalationAttempted,
      childErrorObserved: false,
      readerErrorObserved: false,
    });
  }

  resolveReady(ready: OwnedCodexBackendReady = this.ready): void {
    this.readiness.resolve(ready);
  }

  /** The exact child's genuine exit arrived while both readers may still drain. */
  exit(): void {
    this.exitObserved = true;
  }

  settle(settlement: OwnedCodexBackendSettlement = NOT_CREATED): void {
    this.settled = true;
    // An exited-settlement proof necessarily includes the child's exit fact;
    // a not-created settlement (spawn failure/abandonment) does not.
    if (settlement.status === "settled" && settlement.child === "exited") this.exitObserved = true;
    this.settlement.resolve(settlement);
  }
}

/* ------------------------------------------------------------- fake relay */

class FakeRelay implements NativeCodexTuiRelayLease {
  readonly input: NativeCodexTuiRelayInput;
  readonly readiness = deferred<NativeCodexTuiRelayReadiness>();
  readonly settlement = deferred<NativeCodexTuiRelaySettlement>();
  stopCalls = 0;
  detachCalls = 0;
  #readinessSettled = false;

  constructor(input: NativeCodexTuiRelayInput) {
    this.input = input;
  }

  get readinessPromise(): Promise<NativeCodexTuiRelayReadiness> {
    return this.readiness.promise;
  }

  get settlementPromise(): Promise<NativeCodexTuiRelaySettlement> {
    return this.settlement.promise;
  }

  status(): NativeCodexTuiRelayStatus {
    return RELAY_STATUS;
  }

  requestStop(): void {
    this.stopCalls += 1;
    // The real relay refuses a pending readiness when stopped; mirror that so
    // the composite's late-readiness handling is exercised honestly.
    if (!this.#readinessSettled) {
      this.#readinessSettled = true;
      this.readiness.reject(new NativeCodexTuiRelayError("stopped"));
    }
  }

  detachMetadataTap(): void {
    this.detachCalls += 1;
  }

  resolveReady(): void {
    if (this.#readinessSettled) return;
    this.#readinessSettled = true;
    this.readiness.resolve({
      endpoint: RELAY_ENDPOINT,
      port: 61_001,
      createTuiConnection: (): OwnedCodexTuiConnection => RELAY_TUI,
    });
  }

  rejectReady(error: unknown = new NativeCodexTuiRelayError("listen-failed")): void {
    if (this.#readinessSettled) return;
    this.#readinessSettled = true;
    this.readiness.reject(error);
  }

  resolveSettled(): void {
    this.settlement.resolve(Object.freeze({
      status: "settled",
      listenerClosed: true,
      socketsClosed: true,
      connectionGenerations: 0,
    }));
  }

  emit(event: NativeCodexTuiRelayMetadataEvent): void {
    this.input.onMetadata(event);
  }
}

/* --------------------------------------------------------------- harness */

interface ProbeCall {
  readonly backend: OwnedCodexBackendReady;
  readonly signal: AbortSignal;
}

interface Harness {
  readonly lease: OwnedCodexBackendLease;
  readonly backend: FakeBackend;
  readonly relays: FakeRelay[];
  readonly abort: AbortController;
  readonly probeCalls: ProbeCall[];
}

interface HarnessOptions {
  readonly probe?: (backend: OwnedCodexBackendReady, signal: AbortSignal) => Promise<readonly string[]>;
  /** Close proof for the focused census seam; defaults to an already-closed probe. */
  readonly probeClosed?: () => Promise<void>;
  /** Use the module's real read-only RPC census instead of the focused seam. */
  readonly realProbe?: boolean;
  readonly startRelay?: (input: NativeCodexTuiRelayInput) => NativeCodexTuiRelayLease;
}

function launchRequest(signal: AbortSignal): OwnedCodexBackendLaunchRequest {
  return {
    identity: IDENTITY,
    plan: {} as NativeCodexOwnedLaunchPlan,
    signal,
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const backend = new FakeBackend();
  const abort = new AbortController();
  const relays: FakeRelay[] = [];
  const probeCalls: ProbeCall[] = [];
  let backendCalls = 0;

  const compositeOptions: RelayedOwnedCodexBackendOptions = {
    backend: ((request) => {
      backendCalls += 1;
      assert.deepEqual(request.identity, IDENTITY);
      return backend.lease();
    }) as OwnedCodexBackendFactory,
    ...(options.realProbe === true
      ? {}
      : {
          preAttachCensus: (ready: OwnedCodexBackendReady, signal: AbortSignal) => {
            probeCalls.push({ backend: ready, signal });
            const threadIds = options.probe === undefined
              ? Promise.resolve<readonly string[]>([])
              : Promise.resolve(options.probe(ready, signal));
            const closed = options.probeClosed === undefined ? Promise.resolve() : options.probeClosed();
            return { threadIds, closed };
          },
        }),
    startRelay: (input) => {
      if (options.startRelay !== undefined) return options.startRelay(input);
      const relay = new FakeRelay(input);
      relays.push(relay);
      return relay;
    },
  };
  const factory = createRelayedOwnedCodexBackendFactory(compositeOptions);
  const lease = factory(launchRequest(abort.signal));
  // The factory seam above is synchronous, so a successful harness always has
  // exactly one backend lease by this point.
  assert.equal(backendCalls, 1);
  return { lease, backend, relays, abort, probeCalls };
}

const CONNECTION = "connection-one";

function initializeEvent(): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "genuine-tui-initialize",
    connectionId: CONNECTION,
    sequence: 1,
    clientName: "codex-tui",
    humanApprovalRequired: true,
  };
}

function startEvent(threadId: string): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "thread-candidate",
    connectionId: CONNECTION,
    sequence: 2,
    origin: "thread-start",
    requestIdKind: "native",
    threadId,
  };
}

function workEvent(threadId: string, turnId: string): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "turn-work-target",
    connectionId: CONNECTION,
    sequence: 3,
    requestIdKind: "native",
    threadId,
    turnId,
  };
}

function itemEvent(itemId: string, turnId: string): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "item-phase",
    connectionId: CONNECTION,
    sequence: 4,
    phase: "started",
    itemKind: "commandExecution",
    itemId,
    threadId: "thread-a",
    turnId,
    toolCategory: "command",
  };
}

/* ================================================================= tests */

test("factory retains the backend synchronously and delegates status verbatim", async () => {
  const harness = createHarness();
  // The lease itself is a synchronous object, not a promise, and its identity
  // is the manager-minted one.
  assert.equal(typeof (harness.lease as unknown as { then?: unknown }).then, "undefined");
  assert.deepEqual(harness.lease.identity, IDENTITY);
  assert.deepEqual(harness.lease.status(), harness.backend.status());
  assert.equal(harness.relays.length, 0);
  assert.equal(harness.probeCalls.length, 0);
  await expectPending(harness.lease.readiness, "readiness waits for the backend");

  harness.lease.requestStop();
  const error = await rejectionOf(harness.lease.readiness);
  assert.ok(error instanceof NativeCodexOwnedCompositeError);
  assert.equal(error.code, "stopped");
  harness.backend.settle();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), NOT_CREATED);
});

test("stop before readiness latches once and a late backend readiness creates nothing", async () => {
  const harness = createHarness();
  let outcome: unknown;
  void harness.lease.readiness.catch((error: unknown) => {
    outcome = error;
  });

  harness.lease.requestStop();
  await tick();
  assert.ok(outcome instanceof NativeCodexOwnedCompositeError);
  assert.equal(outcome.code, "stopped");
  assert.equal(harness.backend.stopCalls, 1);
  assert.equal(harness.relays.length, 0);
  assert.equal(harness.probeCalls.length, 0);

  harness.lease.requestStop();
  assert.equal(harness.backend.stopCalls, 1);

  // A late readiness answer must not create a relay or adopt a capability.
  harness.backend.resolveReady();
  await tick();
  assert.equal(harness.relays.length, 0);
  assert.equal(harness.probeCalls.length, 0);
  await expectPending(harness.lease.settlement, "settlement needs the backend proof");
  harness.backend.settle();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), NOT_CREATED);
});

test("readiness exposes the backend observer lane and the relay TUI lane", async () => {
  const harness = createHarness();
  harness.backend.resolveReady();
  await until(() => harness.relays.length === 1, "relay start");

  assert.equal(harness.probeCalls.length, 1);
  assert.equal(harness.probeCalls[0]?.backend, harness.backend.ready);
  assert.equal(harness.relays[0]?.input.backend, harness.backend.ready);
  await expectPending(harness.lease.readiness, "readiness waits for relay bind");

  harness.relays[0]!.resolveReady();
  const ready = await bounded(harness.lease.readiness, "composite readiness");
  assert.equal(ready.endpoint, BACKEND_ENDPOINT);
  assert.equal(ready.readObserverBearer(), BACKEND_BEARER);
  assert.deepEqual(ready.createTuiConnection(), RELAY_TUI);
  assert.notEqual(ready.createTuiConnection().endpoint, ready.endpoint);
  assert.ok(ready.tuiRootFacts);
  assert.deepEqual(ready.tuiRootFacts.current(), { phase: "empty" });

  harness.lease.requestStop();
  assert.equal(harness.backend.stopCalls, 1);
  assert.equal(harness.relays[0]?.stopCalls, 1);
  harness.backend.settle();
  harness.relays[0]!.resolveSettled();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), NOT_CREATED);
});

test("root facts retain a pre-readiness private candidate and publish one current bound snapshot", async () => {
  const harness = createHarness();
  harness.backend.resolveReady();
  await until(() => harness.relays.length === 1, "relay start");
  const relay = harness.relays[0]!;

  relay.emit(initializeEvent());
  relay.emit(startEvent("thread-a"));
  relay.emit(workEvent("thread-a", "turn-1"));
  relay.emit(itemEvent("item-1", "turn-1"));
  // Facts were ingested before readiness and before any TUI connection material
  // existed. Nothing was published or queued to a sink.
  relay.resolveReady();
  const ready = await bounded(harness.lease.readiness, "composite readiness");
  const source = ready.tuiRootFacts;
  assert.ok(source);

  const current = source.current();
  assert.deepEqual(current, {
    phase: "bound",
    connectionId: CONNECTION,
    rootThreadId: "thread-a",
    rootTurnId: "turn-1",
    tool: { itemId: "item-1", category: "command", phase: "started", turnId: "turn-1" },
    asyncInput: "none",
  });

  const seen: NativeCodexTuiRootFactsSnapshot[] = [];
  const unsubscribe = source.watch((snapshot) => seen.push(snapshot));
  assert.equal(seen.length, 1);
  assert.equal(seen[0], current);
  assert.equal(relay.stopCalls, 0);
  assert.equal(relay.detachCalls, 0);

  // Consumer disposal removes only its own watch: native forwarding, the relay
  // metadata tap, the backend, and settlement remain untouched.
  unsubscribe();
  relay.emit(workEvent("thread-a", "turn-2"));
  assert.equal(seen.length, 1);
  assert.equal(source.current().rootTurnId, "turn-2");
  assert.equal(source.current().tool, undefined);
  assert.equal(relay.stopCalls, 0);
  assert.equal(relay.detachCalls, 0);
  assert.equal(harness.backend.stopCalls, 0);
  await expectPending(harness.lease.settlement, "native resources are still live");

  harness.lease.requestStop();
  assert.equal(harness.backend.stopCalls, 1);
  assert.equal(relay.stopCalls, 1);
  harness.backend.settle();
  relay.resolveSettled();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), NOT_CREATED);
});

test("a real relay bind failure rejects with a closed composite error and stops both resources", async () => {
  const harness = createHarness();
  harness.backend.resolveReady();
  await until(() => harness.relays.length === 1, "relay start");
  const relay = harness.relays[0]!;

  relay.rejectReady();
  const error = await rejectionOf(harness.lease.readiness);
  assert.ok(error instanceof NativeCodexOwnedCompositeError);
  assert.equal(error.code, "relay-failed");
  assert.equal(harness.backend.stopCalls, 1);
  assert.equal(relay.stopCalls, 1);

  await expectPending(harness.lease.settlement, "relay close proof is still pending");
  harness.backend.settle();
  await expectPending(harness.lease.settlement, "backend proof alone cannot settle the relay");
  relay.resolveSettled();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), NOT_CREATED);
});

test("a synchronous relay refusal rejects closed and never leaves the backend unstopped", async () => {
  const harness = createHarness({
    startRelay: () => {
      throw new NativeCodexTuiRelayError("backend-endpoint-invalid");
    },
  });
  harness.backend.resolveReady();
  const error = await rejectionOf(harness.lease.readiness);
  assert.ok(error instanceof NativeCodexOwnedCompositeError);
  assert.equal(error.code, "relay-failed");
  assert.equal(harness.backend.stopCalls, 1);
  await expectPending(harness.lease.settlement, "settlement waits for the backend proof");
  harness.backend.settle();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), NOT_CREATED);
});

test("backend readiness failure propagates its closed error and starts no relay", async () => {
  const harness = createHarness();
  const backendError = new Error("owned Codex backend readiness failed: banner-invalid");
  harness.backend.readiness.reject(backendError);
  const error = await rejectionOf(harness.lease.readiness);
  assert.equal(error, backendError);
  assert.equal(harness.relays.length, 0);
  assert.equal(harness.probeCalls.length, 0);
  assert.equal(harness.backend.stopCalls, 0);
  await expectPending(harness.lease.settlement, "settlement follows the backend");
  harness.backend.settle();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), NOT_CREATED);
});

test("a backend settlement requests the relay stop and settlement waits for real relay close", async () => {
  const harness = createHarness();
  harness.backend.resolveReady();
  await until(() => harness.relays.length === 1, "relay start");
  const relay = harness.relays[0]!;
  relay.resolveReady();
  await bounded(harness.lease.readiness, "composite readiness");

  assert.equal(harness.backend.stopCalls, 0);
  assert.equal(relay.stopCalls, 0);
  const exited: OwnedCodexBackendSettlement = Object.freeze({
    status: "settled",
    child: "exited",
    code: 0,
    signal: null,
    stdout: "ended",
    stderr: "ended",
  });
  harness.backend.settle(exited);
  await until(() => relay.stopCalls === 1, "backend settlement requests relay stop");
  await expectPending(harness.lease.settlement, "relay sockets are still draining");
  relay.resolveSettled();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), exited);
});

test("the backend's force escalation bit is forwarded verbatim and never shortens relay settlement", async () => {
  const harness = createHarness();
  harness.backend.resolveReady();
  await until(() => harness.relays.length === 1, "relay start");
  const relay = harness.relays[0]!;
  relay.resolveReady();
  await bounded(harness.lease.readiness, "composite readiness");
  assert.equal(harness.lease.status().forceEscalationAttempted, false);

  harness.lease.requestStop();
  harness.backend.forceEscalationAttempted = true;
  assert.equal(harness.lease.status().forceEscalationAttempted, true, "forwarded from the backend's own status");
  assert.deepEqual(harness.lease.status(), harness.backend.status());
  // A force attempt is reporting only: settlement still needs the backend proof and real relay close.
  await expectPending(harness.lease.settlement, "no backend settlement yet");
  const exited: OwnedCodexBackendSettlement = Object.freeze({
    status: "settled",
    child: "exited",
    code: null,
    signal: "SIGKILL",
    stdout: "ended",
    stderr: "ended",
  });
  harness.backend.settle(exited);
  await expectPending(harness.lease.settlement, "relay sockets are still draining");
  relay.resolveSettled();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), exited);
  assert.equal(harness.lease.status().forceEscalationAttempted, true, "sticky after settlement");
});

test("a backend settlement before relay readiness rejects readiness and adopts no late capability", async () => {
  const harness = createHarness();
  harness.backend.resolveReady();
  await until(() => harness.relays.length === 1, "relay start");
  const relay = harness.relays[0]!;

  harness.backend.settle();
  await until(() => relay.stopCalls === 1, "backend settlement requests relay stop");
  const error = await rejectionOf(harness.lease.readiness);
  assert.ok(error instanceof NativeCodexOwnedCompositeError);
  assert.equal(error.code, "backend-ended");
  relay.resolveSettled();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), NOT_CREATED);
});

test("a confirmed backend exit before relay creation is never admitted", async () => {
  const probe = deferred<readonly string[]>();
  const harness = createHarness({ probe: () => probe.promise });
  harness.backend.resolveReady();
  await until(() => harness.probeCalls.length === 1, "census start");

  // The exact child exited, but both captured readers are still draining and
  // settlement is therefore still pending. No relay may ever be created.
  harness.backend.exit();
  probe.resolve([]);
  const error = await rejectionOf(harness.lease.readiness);
  assert.ok(error instanceof NativeCodexOwnedCompositeError);
  assert.equal(error.code, "backend-ended");
  assert.equal(harness.relays.length, 0);

  await expectPending(harness.lease.settlement, "exit without settlement is not proof");
  harness.backend.settle();
  await tick();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), NOT_CREATED);
});

test("a confirmed backend exit before relay readiness never fulfills the capability", async () => {
  const harness = createHarness();
  harness.backend.resolveReady();
  await until(() => harness.relays.length === 1, "relay start");
  const relay = harness.relays[0]!;

  // exitObserved=true while settlement is pending: the relay's readiness must
  // not be adopted into a usable TUI capability.
  harness.backend.exit();
  relay.resolveReady();
  const error = await rejectionOf(harness.lease.readiness);
  assert.ok(error instanceof NativeCodexOwnedCompositeError);
  assert.equal(error.code, "backend-ended");
  assert.equal(harness.backend.stopCalls, 1);
  assert.equal(relay.stopCalls, 1);

  harness.backend.settle();
  relay.resolveSettled();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), NOT_CREATED);
});

test("settlement waits for the probe's actual close proof even after both native proofs", async () => {
  const closed = deferred<void>();
  const harness = createHarness({ probeClosed: () => closed.promise });
  harness.backend.resolveReady();
  await until(() => harness.relays.length === 1, "relay start");
  const relay = harness.relays[0]!;

  // Readiness does not wait for the probe socket's close: the genuine TUI can
  // proceed while the read-only probe drains.
  relay.resolveReady();
  await bounded(harness.lease.readiness, "composite readiness");

  harness.backend.settle();
  relay.resolveSettled();
  await expectPending(harness.lease.settlement, "the owned probe is still open");

  closed.resolve();
  await tick();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), NOT_CREATED);
  assert.equal(relay.stopCalls, 1);
});

test("stop during the pre-attach census aborts and closes the probe, creates no relay, and waits for it", async () => {
  const probe = deferred<readonly string[]>();
  const harness = createHarness({ probe: () => probe.promise });
  harness.backend.resolveReady();
  await until(() => harness.probeCalls.length === 1, "census start");
  const signal = harness.probeCalls[0]!.signal;
  assert.equal(harness.relays.length, 0);

  harness.lease.requestStop();
  assert.equal(signal.aborted, true);
  assert.equal(harness.backend.stopCalls, 1);
  assert.equal(harness.relays.length, 0);
  const error = await rejectionOf(harness.lease.readiness);
  assert.ok(error instanceof NativeCodexOwnedCompositeError);
  assert.equal(error.code, "stopped");

  harness.backend.settle();
  await expectPending(harness.lease.settlement, "the probe has not finished closing yet");
  probe.reject(new Error("probe aborted"));
  await tick();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), NOT_CREATED);
  assert.equal(harness.relays.length, 0);
});

test("a failed or non-empty census withdraws root facts but never prevents the genuine TUI", async () => {
  const cases: Array<{
    readonly label: string;
    readonly probe: () => Promise<readonly string[]>;
    readonly withdrawal: string;
  }> = [
    {
      label: "non-empty loaded census",
      probe: () => Promise.resolve(["loaded-thread"]),
      withdrawal: "backend-not-empty",
    },
    {
      label: "failed census",
      probe: () => Promise.reject(new Error("census rpc failed")),
      withdrawal: "backend-attestation-unavailable",
    },
  ];

  for (const { label, probe, withdrawal } of cases) {
    const harness = createHarness({ probe });
    harness.backend.resolveReady();
    await until(() => harness.relays.length === 1, `${label}: relay start`);
    const relay = harness.relays[0]!;
    relay.resolveReady();
    const ready = await bounded(harness.lease.readiness, `${label}: readiness`);
    assert.deepEqual(ready.createTuiConnection(), RELAY_TUI, label);
    assert.ok(ready.tuiRootFacts, label);
    assert.deepEqual(ready.tuiRootFacts.current(), {
      phase: "withdrawn",
      withdrawal,
    }, label);

    harness.lease.requestStop();
    assert.equal(harness.backend.stopCalls, 1, label);
    assert.equal(relay.stopCalls, 1, label);
    harness.backend.settle();
    relay.resolveSettled();
    await bounded(harness.lease.settlement, `${label}: settlement`);
  }
});

test("abort after readiness stops both owned resources and settlement still requires both proofs", async () => {
  const harness = createHarness();
  harness.backend.resolveReady();
  await until(() => harness.relays.length === 1, "relay start");
  const relay = harness.relays[0]!;
  relay.resolveReady();
  await bounded(harness.lease.readiness, "composite readiness");

  harness.abort.abort();
  assert.equal(harness.backend.stopCalls, 1);
  assert.equal(relay.stopCalls, 1);
  harness.abort.abort();
  assert.equal(harness.backend.stopCalls, 1);
  assert.equal(relay.stopCalls, 1);

  await expectPending(harness.lease.settlement, "settlement needs both proofs");
  relay.resolveSettled();
  await expectPending(harness.lease.settlement, "backend proof is still missing");
  harness.backend.settle();
  assert.deepEqual(await bounded(harness.lease.settlement, "settlement"), NOT_CREATED);
});

test("the production census uses initialize plus thread/loaded/list and closes its own socket", async () => {
  const server = new FakeCodexAppServer({ threads: [], loadedIds: [], requireAuthorization: BACKEND_BEARER });
  const port = await server.listenLoopback();
  try {
    const ready: OwnedCodexBackendReady = Object.freeze({
      endpoint: `ws://127.0.0.1:${port}`,
      readObserverBearer: (): string => BACKEND_BEARER,
      createTuiConnection: (): OwnedCodexTuiConnection => BACKEND_TUI,
    });
    let relay: FakeRelay | undefined;
    const harness = createHarness({
      realProbe: true,
      startRelay: (input) => {
        relay = new FakeRelay(input);
        return relay;
      },
    });
    harness.backend.resolveReady(ready);
    await until(() => relay !== undefined, "relay start");
    const started = relay;
    assert.ok(started);
    await until(
      () => server.requests.some((request) => request.method === "thread/loaded/list"),
      "census request",
    );

    const methods = server.requests.map((request) => request.method);
    assert.deepEqual(methods, ["initialize", "thread/loaded/list"]);
    assert.equal(server.initializedSeen, true);
    assert.ok(server.initializeParams);
    assert.ok(server.handshakeInfo?.headers.authorization === `Bearer ${BACKEND_BEARER}`);
    assert.equal(server.requests.some((request) => request.method === "thread/start"), false);
    await until(() => server.connectionCount === 0, "probe socket close");

    started.resolveReady();
    const compositeReady = await bounded(harness.lease.readiness, "composite readiness");
    assert.deepEqual(compositeReady.tuiRootFacts?.current(), { phase: "empty" });

    harness.lease.requestStop();
    harness.backend.settle();
    started.resolveSettled();
    await bounded(harness.lease.settlement, "settlement");
  } finally {
    await server.stop();
  }
});

test("the production census withdraws a non-empty loaded set without blocking the TUI", async () => {
  const server = new FakeCodexAppServer({
    threads: [{ id: "loaded-thread", parentThreadId: null, status: { type: "idle" } }],
    loadedIds: ["loaded-thread"],
    requireAuthorization: BACKEND_BEARER,
  });
  const port = await server.listenLoopback();
  try {
    const ready: OwnedCodexBackendReady = Object.freeze({
      endpoint: `ws://127.0.0.1:${port}`,
      readObserverBearer: (): string => BACKEND_BEARER,
      createTuiConnection: (): OwnedCodexTuiConnection => BACKEND_TUI,
    });
    let relay: FakeRelay | undefined;
    const harness = createHarness({
      realProbe: true,
      startRelay: (input) => {
        relay = new FakeRelay(input);
        return relay;
      },
    });
    harness.backend.resolveReady(ready);
    await until(() => relay !== undefined, "relay start");
    const started = relay;
    assert.ok(started);
    await until(
      () => server.requests.some((request) => request.method === "thread/loaded/list"),
      "census request",
    );
    assert.deepEqual(server.requests.map((request) => request.method), ["initialize", "thread/loaded/list"]);

    started.resolveReady();
    const compositeReady = await bounded(harness.lease.readiness, "composite readiness");
    assert.deepEqual(compositeReady.createTuiConnection(), RELAY_TUI);
    assert.deepEqual(compositeReady.tuiRootFacts?.current(), {
      phase: "withdrawn",
      withdrawal: "backend-not-empty",
    });

    harness.lease.requestStop();
    harness.backend.settle();
    started.resolveSettled();
    await bounded(harness.lease.settlement, "settlement");
  } finally {
    await server.stop();
  }
});
