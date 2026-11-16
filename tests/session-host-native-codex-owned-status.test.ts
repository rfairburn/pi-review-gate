/**
 * The owning host's Codex status consumer: legacy hook lane first, owned read-only
 * RPC lane after THIS run's own capability.
 *
 * These run the real consumer against the real root-facts state machine and the
 * repository's fake Codex app-server over a real authenticated loopback WebSocket,
 * so the assertions are about actual wire behaviour (a census that really ran, a
 * socket that really closed) rather than a mocked observer.
 *
 * What these tests do NOT prove: that a live Codex TUI, relay, and backend produce
 * a fresh root on a real machine, or that the owning manager/Main wiring arms this
 * consumer for a real row. Those are the manager, relay, and Main suites.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  NativeOwnedCodexBackendObservationSource,
  NativeStatusObserver,
} from "../src/session-host/instances";
import type { NativeHookEvent, NativeHookFailure } from "../src/session-host/native-hook-protocol";
import { createNativeStatusObserver } from "../src/session-host/native-observer-factory";
import {
  NATIVE_CODEX_OWNED_TOOL_LABELS,
  createOwnedNativeCodexStatusObserver,
} from "../src/session-host/native-codex-owned-status";
import {
  NATIVE_CODEX_RPC_STATUS_SUPPORT,
  type NativeCodexRpcStatusLimits,
} from "../src/session-host/native-codex-rpc-status";
import {
  createNativeCodexTuiRootFactsBinder,
  type NativeCodexTuiRootFactsBinder,
  type NativeCodexTuiRootFactsSnapshot,
  type NativeCodexTuiRootFactsSource,
} from "../src/session-host/native-codex-tui-root-facts";
import type { NativeCodexTuiRelayMetadataEvent } from "../src/session-host/native-codex-tui-relay";
import type { NativeStatusObservation, NativeStatusSupportMap } from "../src/session-host/native-status";
import {
  FakeCodexAppServer,
  activeStatus,
  idleStatus,
  type FakeCodexServerOptions,
  type FakeThread,
} from "./session-host-native-codex-rpc-fixture";

/* ------------------------------------------------------------- fixtures */

const ROOT = "root-owned-0001";
const CHILD = "child-owned-0002";
const TURN_ONE = "turn-owned-1";
const TURN_TWO = "turn-owned-2";
const CONNECTION = "conn-owned-1";
const BEARER = "owned-observer-bearer-never-public";

const POPULATION: readonly FakeThread[] = [
  { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli", cwd: "/owned/worktree" },
  { id: CHILD, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
];

/** Short bounds so a real-timer test still lands quickly. */
const LIMITS: Partial<NativeCodexRpcStatusLimits> = Object.freeze({
  refreshCooldownMs: 10,
  activeRefreshIntervalMs: 50,
  reconnectBackoffMs: 20,
  reconnectMaxBackoffMs: 40,
  requestTimeoutMs: 2_000,
});

function settle(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => boolean, message: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${message}`);
    await settle(10);
  }
}

/* ------------------------------------------------ relay-shaped metadata */

function initializeEvent(connectionId = CONNECTION): NativeCodexTuiRelayMetadataEvent {
  return Object.freeze({
    kind: "genuine-tui-initialize",
    connectionId,
    sequence: 1,
    clientName: "codex-tui",
    humanApprovalRequired: true,
  });
}

function threadStartEvent(
  threadId: string,
  extra: Partial<Extract<NativeCodexTuiRelayMetadataEvent, { kind: "thread-candidate" }>> = {},
): NativeCodexTuiRelayMetadataEvent {
  return Object.freeze({
    kind: "thread-candidate",
    connectionId: CONNECTION,
    sequence: 2,
    origin: "thread-start",
    requestIdKind: "native",
    threadId,
    ...extra,
  });
}

function turnWorkTargetEvent(
  threadId: string,
  turnId: string,
  requestIdKind: "native" | "native-helper" = "native",
): NativeCodexTuiRelayMetadataEvent {
  return Object.freeze({
    kind: "turn-work-target",
    connectionId: CONNECTION,
    sequence: 3,
    requestIdKind,
    threadId,
    turnId,
  });
}

function itemPhaseEvent(
  phase: "started" | "completed",
  itemId: string,
  category: "command" | "file-change" | "mcp-tool" | "dynamic-tool" | "web-search",
  threadId: string | undefined,
  turnId: string | undefined,
): NativeCodexTuiRelayMetadataEvent {
  return Object.freeze({
    kind: "item-phase",
    connectionId: CONNECTION,
    sequence: 4,
    phase,
    itemKind: "commandExecution",
    itemId,
    toolCategory: category,
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId === undefined ? {} : { turnId }),
  });
}

/** The full fresh-root proof, in the order the relay and composite produce it. */
function bindFreshRoot(facts: NativeCodexTuiRootFactsBinder, threadId = ROOT, turnId = TURN_ONE): void {
  facts.attestEmptyBackend();
  facts.observe(initializeEvent());
  facts.observe(threadStartEvent(threadId));
  facts.observe(turnWorkTargetEvent(threadId, turnId));
}

/* ------------------------------------------------------------- harness */

interface Harness {
  readonly server: FakeCodexAppServer;
  readonly facts: NativeCodexTuiRootFactsBinder;
  readonly observations: NativeStatusObservation[];
  readonly consumer: NativeStatusObserver;
  readonly legacy: NativeStatusObserver;
  /** Deliver this run's one private capability, as the manager would. */
  deliverCap(overrides?: Partial<NativeOwnedCodexBackendObservationSource>): void;
  latest(): NativeStatusObservation;
  /** How many WebSocket upgrades the fake backend actually served. */
  dials(): number;
  close(): Promise<void>;
}

async function startHarness(
  serverOptions: Partial<FakeCodexServerOptions> = {},
  options: { readonly capEndpoint?: string } = {},
): Promise<Harness> {
  const server = new FakeCodexAppServer({
    threads: POPULATION,
    loadedIds: [ROOT, CHILD],
    backgroundTerminals: { [ROOT]: [] },
    requireAuthorization: BEARER,
    ...serverOptions,
  });
  const port = await server.listenLoopback();
  const facts = createNativeCodexTuiRootFactsBinder();
  const observations: NativeStatusObservation[] = [];
  const emit = (observation: NativeStatusObservation): void => {
    observations.push(observation);
  };
  // The exact legacy source the factory would build, so the pre-switch lane is the
  // real controller and not a stand-in.
  const legacy = createNativeStatusObserver({ rowId: "row-owned", backend: "codex", emit });
  const consumer = createOwnedNativeCodexStatusObserver({ legacy, emit, limits: LIMITS });
  let delivered = false;
  return {
    server,
    facts,
    observations,
    consumer,
    legacy,
    deliverCap: (overrides) => {
      if (delivered) {
        // A duplicate delivery is still offered the same object the manager holds.
        consumer.observeOwnedCodexBackend?.(makeSource(port, facts, overrides));
        return;
      }
      delivered = true;
      consumer.observeOwnedCodexBackend?.(makeSource(port, facts, overrides));
    },
    latest: () => observations[observations.length - 1] as NativeStatusObservation,
    dials: () => server.upgradeCount,
    close: async () => {
      consumer.dispose();
      await server.stop();
    },
  };
}

function makeSource(
  port: number,
  facts: NativeCodexTuiRootFactsSource,
  overrides: Partial<NativeOwnedCodexBackendObservationSource> = {},
): NativeOwnedCodexBackendObservationSource {
  return Object.freeze({
    leaseId: "lease-owned-1",
    generation: 3,
    endpoint: `ws://127.0.0.1:${port}`,
    readObserverBearer: () => BEARER,
    tuiRootFacts: facts,
    ...overrides,
  });
}

/**
 * A source the test drives directly, so a snapshot that contradicts the adopted
 * binding can be delivered on purpose. The real binder cannot produce one (it is
 * sticky), which is exactly why the consumer's own fence needs its own proof.
 */
class ControllableFacts implements NativeCodexTuiRootFactsSource {
  #current: NativeCodexTuiRootFactsSnapshot = Object.freeze({ phase: "empty" as const });
  #listener: ((snapshot: NativeCodexTuiRootFactsSnapshot) => void) | undefined;
  unsubscribeCount = 0;

  current(): NativeCodexTuiRootFactsSnapshot {
    return this.#current;
  }

  watch(listener: (snapshot: NativeCodexTuiRootFactsSnapshot) => void): () => void {
    if (this.#listener !== undefined) return () => undefined;
    this.#listener = listener;
    listener(this.#current);
    return () => {
      if (this.#listener !== listener) return;
      this.#listener = undefined;
      this.unsubscribeCount += 1;
    };
  }

  publish(snapshot: NativeCodexTuiRootFactsSnapshot): void {
    this.#current = snapshot;
    this.#listener?.(snapshot);
  }

  get watching(): boolean {
    return this.#listener !== undefined;
  }
}

const LEGACY_CODEX_SUPPORT: NativeStatusSupportMap = Object.freeze({
  agent: "supported",
  input: "unsupported",
  tasks: "unsupported",
  shells: "unsupported",
  activity: "supported",
});

const HOOK_FAILURE: NativeHookFailure = Object.freeze({ backend: "codex", reason: "input-invalid" });
const HOOK_EVENT: NativeHookEvent = Object.freeze({
  backend: "codex" as const,
  hook_event_name: "SessionStart" as const,
  session_id: "session-owned",
});

/* ------------------------------------------------------------------ tests */

test("the run stays the exact legacy Codex source until its own capability arrives", async () => {
  const h = await startHarness();
  try {
    assert.deepEqual(h.consumer.support, LEGACY_CODEX_SUPPORT,
      "the consumer states the legacy source's own declaration, not the RPC one");

    // The relay can already have proved a fresh root: nothing is adopted, and
    // nothing is dialed, before this run's capability is delivered.
    bindFreshRoot(h.facts);
    assert.equal(h.dials(), 0, "no read-only connection before the capability");
    assert.equal(h.observations.length, 0, "no pre-capability publication at all");

    // The legacy lane is live and unchanged.
    h.consumer.acceptFailure(HOOK_FAILURE);
    assert.equal(h.observations.length, 1);
    assert.deepEqual(h.observations[0]!.support, LEGACY_CODEX_SUPPORT);

    // A launch baseline is whatever the live lane can state: the legacy Codex
    // source states none, so this stays the same refusal it always was.
    h.consumer.observeOwnedStartup?.();
    assert.equal(h.observations.length, 1);

    // The switch: one complete unknown snapshot under the RPC declaration.
    h.deliverCap();
    assert.equal(h.observations.length, 2);
    const switched = h.observations[1]!;
    assert.deepEqual(switched.support, NATIVE_CODEX_RPC_STATUS_SUPPORT);
    assert.equal(switched.busy, null);
    assert.equal(switched.pendingInput, null);
    assert.equal(switched.activeTasks, null);
    assert.equal(switched.activeShells, null);
    assert.deepEqual(switched.activity, []);
    assert.deepEqual(h.consumer.support, NATIVE_CODEX_RPC_STATUS_SUPPORT);
    assert.equal(h.dials(), 0, "a bound root alone does not dial before the capability attaches its watcher");

    // Exclusive: the retired hook lane can add no fact to the RPC lane.
    h.consumer.acceptFailure(HOOK_FAILURE);
    h.consumer.acceptHook(HOOK_EVENT);
    assert.equal(h.observations.length, 2, "no hook/RPC axis blend");
  } finally {
    await h.close();
  }
});

test("the capability attaches the current facts and publishes the real five-axis card", async () => {
  const h = await startHarness();
  try {
    h.deliverCap();
    // A candidate is not a root: still nothing beyond the switch.
    h.facts.attestEmptyBackend();
    h.facts.observe(initializeEvent());
    h.facts.observe(threadStartEvent(ROOT));
    assert.equal(h.dials(), 0, "a candidate thread is never dialed as a root");
    assert.equal(h.observations.length, 1);

    // This connection's own first successful turn names the root.
    h.facts.observe(turnWorkTargetEvent(ROOT, TURN_ONE));
    await until(() => h.observations.some((o) => o.activeTasks !== null), "the first census to land");
    const card = h.latest();
    assert.equal(card.busy, false, "an idle owned root is a positive Ready");
    assert.equal(card.pendingInput, false);
    assert.equal(card.activeTasks, 1, "the census ran against the bound root, not a placeholder");
    assert.equal(card.activeShells, 0, "an authoritative empty page is a real zero");
    assert.deepEqual(card.activity, ["Ready"]);
    assert.deepEqual(card.support, NATIVE_CODEX_RPC_STATUS_SUPPORT);

    const read = h.server.requests.find((request) => request.method === "thread/read");
    assert.equal(read?.params.threadId, ROOT, "the read is scoped to the proven root");
    const ancestor = h.server.requests.find((request) => request.method === "thread/list");
    assert.equal(ancestor?.params.ancestorThreadId, ROOT);

    // Live provider traffic keeps updating the same lane.
    h.server.setStatus(ROOT, activeStatus([]));
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    await until(() => h.latest().busy === true, "the active root to reach the row");
    assert.deepEqual(h.latest().activity, ["Working"]);

    h.server.setBackgroundTerminals(ROOT, [{ processId: "proc-1" }]);
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    await until(() => h.latest().activeShells === 1, "the background terminal census to land");
  } finally {
    await h.close();
  }
});

test("a late attach labels the running root tool, a new turn clears it, and a child never labels", async () => {
  const h = await startHarness();
  try {
    // The provider is already executing the second turn when the consumer attaches.
    h.server.setStatus(ROOT, activeStatus([]));
    bindFreshRoot(h.facts);
    h.facts.observe(turnWorkTargetEvent(ROOT, TURN_ONE));
    h.deliverCap();
    await until(() => h.observations.some((o) => o.busy === true), "the active root census");

    // A rooted tool start for the NEXT turn, before that turn's own response.
    h.facts.observe(itemPhaseEvent("started", "item-cmd-1", "command", ROOT, TURN_TWO));
    assert.deepEqual(h.latest().activity, ["Working"], "an unconfirmed turn's tool is not published yet");

    h.facts.observe(turnWorkTargetEvent(ROOT, TURN_TWO));
    await until(() => h.latest().activity?.[0] === NATIVE_CODEX_OWNED_TOOL_LABELS.command, "the running tool label");
    assert.equal(h.latest().busy, true, "the label never replaces the provider's own agent axis");

    // A completed tool clears the label; it never claims Ready by itself.
    h.facts.observe(itemPhaseEvent("completed", "item-cmd-1", "command", ROOT, TURN_TWO));
    await until(() => h.latest().activity?.[0] === "Working", "the label to clear on completion");
    assert.equal(h.latest().busy, true, "the turn is still open underneath");

    // A helper/child thread's own tool never becomes the root's label.
    h.facts.observe(itemPhaseEvent("started", "item-child", "file-change", CHILD, TURN_TWO));
    await settle(40);
    assert.notEqual(h.latest().activity?.[0], NATIVE_CODEX_OWNED_TOOL_LABELS["file-change"],
      "a child thread is not the root");

    // A new root turn with no tool clears the previous label.
    h.facts.observe(itemPhaseEvent("started", "item-cmd-2", "web-search", ROOT, TURN_TWO));
    await until(() => h.latest().activity?.[0] === NATIVE_CODEX_OWNED_TOOL_LABELS["web-search"], "the second tool");
    h.facts.observe(turnWorkTargetEvent(ROOT, `${TURN_TWO}-next`));
    await until(() => h.latest().activity?.[0] === "Working", "the new turn to clear the label");
  } finally {
    await h.close();
  }
});

test("a permanent facts withdrawal closes the real read-only socket and publishes one unknown snapshot", async () => {
  const h = await startHarness();
  try {
    bindFreshRoot(h.facts);
    h.deliverCap();
    await until(() => h.observations.some((o) => o.activeTasks !== null), "the first census");
    const before = h.observations.length;
    assert.equal(h.server.connectionCount, 1, "one live read-only connection");

    h.facts.observe(Object.freeze({
      kind: "generation-closed",
      connectionId: CONNECTION,
      sequence: 9,
      reason: "client-closed",
    } as NativeCodexTuiRelayMetadataEvent));

    // One unknown snapshot, and the socket this consumer opened is really gone.
    assert.equal(h.observations.length, before + 1);
    assert.deepEqual(h.observations[before]!.support, NATIVE_CODEX_RPC_STATUS_SUPPORT);
    assert.equal(h.observations[before]!.busy, null);
    assert.deepEqual(h.observations[before]!.activity, []);
    await until(() => h.server.connectionCount === 0, "the read-only WebSocket's own close at the peer");

    // The consumer detached only ITSELF: the retained facts source is still a
    // working source for whoever holds it, which is what "observation loss is not
    // transport authority" means from this side.
    assert.equal(h.facts.current().phase, "withdrawn");
    let redelivered: string | undefined;
    const second = h.facts.watch((snapshot) => {
      redelivered = snapshot.phase;
    });
    assert.equal(redelivered, "withdrawn", "the source still serves a fresh consumer");
    second();

    // Later provider traffic reaches nothing, and a second withdrawal adds nothing.
    h.server.setStatus(ROOT, activeStatus([]));
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    h.facts.observe(threadStartEvent("another-thread"));
    await settle(60);
    assert.equal(h.observations.length, before + 1, "no publish after a sticky withdrawal");
    assert.equal(h.server.upgradeCount, 1, "a withdrawn consumer never dials again");
  } finally {
    await h.close();
  }
});

test("a duplicate or different capability never adopts again or dials a second transport", async () => {
  const h = await startHarness();
  try {
    bindFreshRoot(h.facts);
    h.deliverCap();
    await until(() => h.server.upgradeCount >= 1, "the first transport");
    const observations = h.observations.length;

    h.deliverCap({ leaseId: "lease-owned-2", generation: 4 });
    h.deliverCap();
    await settle(80);
    assert.equal(h.observations.length, observations, "no second switch announcement");
    assert.equal(h.server.upgradeCount, 1, "one transport per run");
  } finally {
    await h.close();
  }
});

test("invalidate and dispose close the live socket and retire every later publish", async () => {
  for (const mode of ["invalidate", "dispose"] as const) {
    const h = await startHarness();
    try {
      bindFreshRoot(h.facts);
      h.deliverCap();
      await until(() => h.observations.some((o) => o.activeTasks !== null), "the first census");
      const before = h.observations.length;

      if (mode === "invalidate") h.consumer.invalidate!();
      else h.consumer.dispose();

      await until(() => h.server.connectionCount === 0, `the socket closed by ${mode}`);
      h.server.setStatus(ROOT, activeStatus([]));
      h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
      h.facts.observe(turnWorkTargetEvent(ROOT, "turn-late"));
      await settle(80);
      assert.equal(h.observations.length, before, `${mode} stops every later publication`);

      // Idempotent, and the retired hook lane stays retired.
      h.consumer.dispose();
      h.consumer.acceptFailure(HOOK_FAILURE);
      assert.equal(h.observations.length, before);
    } finally {
      await h.close();
    }
  }
});

test("an endpoint this host cannot describe withdraws status without dialing, throwing, or leaking", async () => {
  const h = await startHarness();
  try {
    bindFreshRoot(h.facts);
    // A malformed banner endpoint on this run's own capability: the observation
    // lane withdraws; nothing else is involved.
    h.deliverCap({ endpoint: "ws://attacker.example:9999/?token=leak" });
    await settle(80);
    assert.equal(h.dials(), 0, "a refused endpoint is never dialed");
    assert.equal(h.observations.length, 2, "the switch snapshot is still the honest unknown");
    assert.deepEqual(h.latest().support, NATIVE_CODEX_RPC_STATUS_SUPPORT);
    assert.equal(h.latest().busy, null);

    // A capability that is not a usable source behaves the same way.
    const other = await startHarness();
    try {
      other.consumer.observeOwnedCodexBackend?.(null as unknown as NativeOwnedCodexBackendObservationSource);
      assert.equal(other.dials(), 0);
      assert.deepEqual(other.latest().support, NATIVE_CODEX_RPC_STATUS_SUPPORT);
    } finally {
      await other.close();
    }
  } finally {
    await h.close();
  }
});

test("one provider axis failing stays that axis failing, with no fabricated zero", async () => {
  const h = await startHarness({ failCalls: { "thread/backgroundTerminals/list": 1 } });
  try {
    bindFreshRoot(h.facts);
    h.deliverCap();
    await until(() => h.observations.some((o) => o.activeTasks !== null), "the census to land");
    const card = h.latest();
    assert.equal(card.activeShells, null, "a failed shell census is unknown, never 0");
    assert.equal(card.busy, false, "the agent axis keeps its positively read value");
    assert.equal(card.pendingInput, false);
    assert.equal(card.activeTasks, 1, "the task axis keeps its positively read value");
  } finally {
    await h.close();
  }
});

test("no endpoint, bearer, or provider detail crosses a published observation", async () => {
  const h = await startHarness();
  try {
    bindFreshRoot(h.facts);
    h.deliverCap();
    await until(() => h.observations.some((o) => o.activeTasks !== null), "the first census");
    h.server.setStatus(ROOT, activeStatus(["waitingOnApproval"]));
    h.server.broadcast("thread/status/changed", {
      threadId: ROOT,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    await until(() => h.latest().pendingInput === true, "the blocked root");
    const wire = JSON.stringify(h.observations);
    assert.equal(wire.includes(BEARER), false, "the private bearer never enters an observation");
    assert.equal(wire.includes("127.0.0.1"), false, "the owned endpoint never enters an observation");
    assert.equal(wire.includes("ws://"), false);
    // The blocked root is the canonical waiting shape, not a fake Ready or zero.
    assert.equal(h.latest().busy, false);
    assert.equal(h.latest().pendingInput, true);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------- the adopted binding fence */

test("a bound snapshot naming another connection or root withdraws instead of editing the live card", async () => {
  for (const other of ["connection", "root"] as const) {
    const server = new FakeCodexAppServer({
      threads: POPULATION,
      loadedIds: [ROOT, CHILD],
      backgroundTerminals: { [ROOT]: [] },
      requireAuthorization: BEARER,
    });
    const port = await server.listenLoopback();
    const facts = new ControllableFacts();
    const observations: NativeStatusObservation[] = [];
    const emit = (observation: NativeStatusObservation): void => {
      observations.push(observation);
    };
    const legacy = createNativeStatusObserver({ rowId: "row-fence", backend: "codex", emit });
    const consumer = createOwnedNativeCodexStatusObserver({ legacy, emit, limits: LIMITS });
    try {
      consumer.observeOwnedCodexBackend?.(makeSource(port, facts));
      facts.publish(Object.freeze({
        phase: "bound" as const,
        connectionId: CONNECTION,
        rootThreadId: ROOT,
        rootTurnId: TURN_ONE,
      }));
      await until(() => observations.some((o) => o.activeTasks !== null), `the first census (${other})`);
      const before = observations.length;
      assert.equal(server.connectionCount, 1);

      // The same consumer, one generation later (or one root later), with a running
      // tool: neither may edit the card this observer was dialed for.
      facts.publish(Object.freeze({
        phase: "bound" as const,
        ...(other === "connection"
          ? { connectionId: "conn-owned-2", rootThreadId: ROOT }
          : { connectionId: CONNECTION, rootThreadId: "root-another" }),
        rootTurnId: TURN_TWO,
        tool: Object.freeze({ itemId: "item-other", category: "command" as const, phase: "started" as const }),
      }));

      assert.equal(observations.length, before + 1, `one withdrawal snapshot (${other})`);
      const withdrawn = observations[before]!;
      assert.equal(withdrawn.busy, null);
      assert.equal(withdrawn.pendingInput, null);
      assert.equal(withdrawn.activeTasks, null);
      assert.equal(withdrawn.activeShells, null);
      assert.deepEqual(withdrawn.activity, [], "the other binding's tool never reaches this card");
      assert.deepEqual(withdrawn.support, NATIVE_CODEX_RPC_STATUS_SUPPORT);
      assert.equal(facts.unsubscribeCount, 1, "the consumer detached only itself");
      await until(() => server.connectionCount === 0, `the read-only socket's peer close (${other})`);

      // Sticky: a further bound snapshot adds nothing and never re-dials.
      facts.publish(Object.freeze({
        phase: "bound" as const,
        connectionId: CONNECTION,
        rootThreadId: ROOT,
        rootTurnId: TURN_ONE,
      }));
      await settle(80);
      assert.equal(observations.length, before + 1, `no publication after the binding loss (${other})`);
      assert.equal(server.upgradeCount, 1, "a lost binding never dials again");
    } finally {
      consumer.dispose();
      await server.stop();
    }
  }
});

/* --------------------------------------------------- recovery of the label */

test("a recovered read-only connection restores the retained running tool with no new relay event", async () => {
  const h = await startHarness();
  try {
    h.server.setStatus(ROOT, activeStatus([]));
    bindFreshRoot(h.facts);
    h.deliverCap();
    await until(() => h.observations.some((o) => o.busy === true), "the active root census");
    h.facts.observe(itemPhaseEvent("started", "item-cmd-keep", "command", ROOT, TURN_ONE));
    await until(() => h.latest().activity?.[0] === NATIVE_CODEX_OWNED_TOOL_LABELS.command, "the running tool label");
    const atLoss = h.observations.length;

    // The provider stream drops. Every axis collapses to unknown — the row is never
    // left holding a stale Exec as if it were fresh.
    h.server.dropClientConnections();
    await until(
      () => h.observations.slice(atLoss).some((o) => o.busy === null && o.activeTasks === null),
      "the loss to be published",
    );
    const afterLoss = h.observations.length;

    // The reconnect re-pulls the SAME still-running tool. No relay event is sent:
    // only the consumer's own retained current fact can put the label back.
    await until(
      () => h.latest().busy === true && h.latest().activity?.[0] === NATIVE_CODEX_OWNED_TOOL_LABELS.command,
      "the retained tool to be restored after recovery",
    );
    assert.ok(h.dials() >= 2, "the lane really reconnected rather than replaying");
    assert.ok(h.observations.length > afterLoss, "the restored card is a real later publication");

    // Clearing still behaves: a completion clears the label and never claims Ready.
    h.facts.observe(itemPhaseEvent("completed", "item-cmd-keep", "command", ROOT, TURN_ONE));
    await until(() => h.latest().activity?.[0] === "Working", "the completion to clear the label");
    assert.equal(h.latest().busy, true, "the provider's turn is still open underneath");
  } finally {
    await h.close();
  }
});

