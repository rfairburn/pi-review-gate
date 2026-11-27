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
  notLoadedStatus,
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
  options: { readonly capEndpoint?: string; readonly onRootToolStarted?: (threadId: string, category: string) => void } = {},
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
  const consumer = createOwnedNativeCodexStatusObserver({
    legacy,
    emit,
    limits: LIMITS,
    ...(options.onRootToolStarted === undefined ? {} : { onRootToolStarted: options.onRootToolStarted }),
  });
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
    // A connected-only source dials nothing.
    h.facts.observe(initializeEvent());
    await settle(30);
    assert.equal(h.dials(), 0, "no thread is proven before the fresh candidate");
    assert.equal(h.observations.length, 1);

    // The fresh candidate starts the one read-only observer; the first own turn
    // later binds the same thread on the same observer.
    h.facts.attestEmptyBackend();
    h.facts.observe(threadStartEvent(ROOT));
    h.facts.observe(turnWorkTargetEvent(ROOT, TURN_ONE));
    await until(() => h.observations.some((o) => o.activeTasks !== null), "the first census to land");
    await settle(30);
    assert.equal(h.dials(), 1, "binding the candidate never redials");
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

test("#736: each newly started bound-root tool item is reported once with its category; children and repeats never are", async () => {
  const reported: Array<[string, string]> = [];
  const h = await startHarness({}, { onRootToolStarted: (threadId, category) => { reported.push([threadId, category]); } });
  try {
    h.server.setStatus(ROOT, activeStatus([]));
    bindFreshRoot(h.facts);
    h.facts.observe(turnWorkTargetEvent(ROOT, TURN_ONE));
    h.deliverCap();
    await until(() => h.observations.some((o) => o.busy === true), "the active root census");
    h.facts.observe(turnWorkTargetEvent(ROOT, TURN_TWO));
    h.facts.observe(itemPhaseEvent("started", "item-cmd-1", "command", ROOT, TURN_TWO));
    await until(() => reported.length === 1, "the first rooted tool start");
    h.facts.observe(itemPhaseEvent("completed", "item-cmd-1", "command", ROOT, TURN_TWO));
    h.facts.observe(itemPhaseEvent("started", "item-child", "file-change", CHILD, TURN_TWO));
    h.facts.observe(itemPhaseEvent("started", "item-ws", "web-search", ROOT, TURN_TWO));
    await until(() => reported.length === 2, "the second rooted tool start");
    await settle(40);
    assert.deepEqual(reported, [[ROOT, "command"], [ROOT, "web-search"]],
      "a completion, a child thread's tool, and a repeat report nothing");
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
    // The upgrade only says the transport opened: the census that first replaces the
    // switch snapshot's unknown axes publishes later, so a baseline taken on the dial
    // can still count that census as a new publication. Wait for the published census
    // itself — unlike the switch snapshot, which keeps `activeTasks` null — before
    // snapshotting and before either duplicate is offered.
    await until(() => h.observations.some((o) => o.activeTasks !== null), "the first census to publish");
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


/* ------------------------------------------- fresh pre-prompt startup census */

const FRESH_POPULATION: readonly FakeThread[] = [
  { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli", cwd: "/owned/worktree" },
];

function freshServer(extra: Partial<FakeCodexServerOptions> = {}): Partial<FakeCodexServerOptions> {
  return { threads: FRESH_POPULATION, loadedIds: [ROOT], backgroundTerminals: { [ROOT]: [] }, ...extra };
}

function freshCandidate(facts: NativeCodexTuiRootFactsBinder, threadId = ROOT): void {
  facts.attestEmptyBackend();
  facts.observe(initializeEvent());
  facts.observe(threadStartEvent(threadId));
}

function asyncQuestions(threadId: string, itemId: string, count: number, turnId = TURN_ONE): NativeCodexTuiRelayMetadataEvent {
  return Object.freeze({
    kind: "async-questions",
    connectionId: CONNECTION,
    sequence: 20,
    itemId,
    questionCount: count,
    threadId,
    turnId,
  });
}

function asyncReply(threadId: string, itemId: string, index: number): NativeCodexTuiRelayMetadataEvent {
  return Object.freeze({
    kind: "async-question-reply",
    connectionId: CONNECTION,
    sequence: 21,
    answers: Object.freeze([Object.freeze({ itemId, index })]),
    threadId,
    turnId: TURN_ONE,
  });
}

test("a fresh unprompted candidate reaches a positively read Ready, none, 0, 0 before any turn", async () => {
  const h = await startHarness(freshServer());
  try {
    h.deliverCap();
    freshCandidate(h.facts);
    assert.equal(h.facts.current().phase, "candidate", "no own turn exists");
    await until(() => h.observations.some((o) => o.activeShells !== null), "the pre-prompt census");
    const card = h.latest();
    assert.deepEqual(
      { busy: card.busy, pendingInput: card.pendingInput, activeTasks: card.activeTasks, activeShells: card.activeShells, activity: card.activity },
      { busy: false, pendingInput: false, activeTasks: 0, activeShells: 0, activity: ["Ready"] },
    );
    const read = h.server.requests.find((request) => request.method === "thread/read");
    assert.deepEqual(read?.params, { threadId: ROOT, includeTurns: false }, "the read is the candidate's own");
    assert.equal(h.server.requests.find((request) => request.method === "thread/list")?.params.ancestorThreadId, ROOT);
    assert.equal(h.server.requests.find((request) => request.method === "thread/backgroundTerminals/list")?.params.threadId, ROOT);
    // Read-only: nothing that starts, resumes, or answers anything was sent.
    for (const request of h.server.requests) {
      assert.ok(["initialize", "thread/read", "thread/list", "thread/loaded/list", "thread/backgroundTerminals/list"].includes(request.method),
        `unexpected ${request.method}`);
    }

    // The first own turn binds the SAME thread on the SAME observer: no redial,
    // and a re-pull replaces any census that may predate that work.
    const readsBefore = h.server.requests.filter((request) => request.method === "thread/read").length;
    h.server.setStatus(ROOT, activeStatus([]));
    h.facts.observe(turnWorkTargetEvent(ROOT, TURN_ONE));
    await until(() => h.latest().busy === true, "the own turn's work reaches the row without a broadcast");
    assert.ok(h.server.requests.filter((request) => request.method === "thread/read").length > readsBefore);
    assert.equal(h.dials(), 1, "the bound root keeps the candidate's observer");
    assert.equal(h.server.connectionCount, 1);
  } finally {
    await h.close();
  }
});

test("no pre-prompt Ready without the fresh proof or a complete census", async () => {
  // No empty-backend witness: no candidate binding, nothing dialed.
  const unattested = await startHarness(freshServer());
  try {
    unattested.deliverCap();
    unattested.facts.observe(initializeEvent());
    unattested.facts.observe(threadStartEvent(ROOT));
    await settle(60);
    assert.equal(unattested.dials(), 0);
    assert.equal(unattested.observations.length, 1);
    assert.equal(unattested.latest().busy, null);
  } finally {
    await unattested.close();
  }

  // A non-empty backend census withdraws.
  const notEmpty = await startHarness(freshServer());
  try {
    notEmpty.deliverCap();
    notEmpty.facts.withdraw("backend-not-empty");
    notEmpty.facts.observe(initializeEvent());
    notEmpty.facts.observe(threadStartEvent(ROOT));
    await settle(60);
    assert.equal(notEmpty.dials(), 0);
    assert.equal(notEmpty.latest().busy, null);
    assert.equal(notEmpty.latest().activeShells, null);
  } finally {
    await notEmpty.close();
  }

  // Only a helper start: nothing is a candidate.
  const helper = await startHarness(freshServer());
  try {
    helper.deliverCap();
    helper.facts.attestEmptyBackend();
    helper.facts.observe(initializeEvent());
    helper.facts.observe(threadStartEvent(ROOT, { requestIdKind: "native-helper", ephemeral: true }));
    await settle(60);
    assert.equal(helper.dials(), 0);
  } finally {
    await helper.close();
  }

  // A failed terminal census and an unreadable root stay unknown, never zero/Ready.
  const failing = await startHarness(freshServer({ failCalls: { "thread/backgroundTerminals/list": 1 } }));
  try {
    failing.deliverCap();
    freshCandidate(failing.facts);
    await until(() => failing.observations.some((o) => o.activeTasks !== null), "the census");
    assert.equal(failing.latest().activeShells, null);
    assert.equal(failing.latest().activeTasks, 0);
  } finally {
    await failing.close();
  }
  const notLoaded = await startHarness(freshServer({
    threads: [{ id: ROOT, parentThreadId: null, status: notLoadedStatus, sourceKind: "cli" }],
  }));
  try {
    notLoaded.deliverCap();
    freshCandidate(notLoaded.facts);
    await until(() => notLoaded.observations.some((o) => o.activeTasks !== null), "the census");
    assert.equal(notLoaded.latest().busy, null, "a root that is not loaded is not Ready");
    assert.equal(notLoaded.latest().pendingInput, null);
    assert.equal(notLoaded.latest().activeShells, null);
  } finally {
    await notLoaded.close();
  }
});

test("the candidate observer withdraws on a second primary, advanced selection, or foreign work", async () => {
  for (const contradiction of [
    threadStartEvent("thread-second"),
    threadStartEvent("thread-resumed", { origin: "thread-resume" }),
    turnWorkTargetEvent("thread-foreign", "turn-foreign"),
  ]) {
    const h = await startHarness(freshServer());
    try {
      h.deliverCap();
      freshCandidate(h.facts);
      await until(() => h.observations.some((o) => o.activeShells !== null), "the pre-prompt census");
      const before = h.observations.length;
      h.facts.observe(contradiction);
      assert.equal(h.observations.length, before + 1);
      assert.equal(h.latest().busy, null);
      assert.equal(h.latest().pendingInput, null);
      assert.equal(h.latest().activeShells, null);
      await until(() => h.server.connectionCount === 0, "the read-only socket's close");
      assert.equal(h.dials(), 1, "never redialed");
    } finally {
      await h.close();
    }
  }
});

test("an own async question stays input pending while the root keeps working, until its committed reply", async () => {
  const h = await startHarness(freshServer());
  try {
    h.deliverCap();
    freshCandidate(h.facts);
    h.server.setStatus(ROOT, activeStatus([]));
    h.facts.observe(turnWorkTargetEvent(ROOT, TURN_ONE));
    await until(() => h.latest().busy === true, "the working root");
    assert.equal(h.latest().pendingInput, false);

    h.facts.observe(asyncQuestions(ROOT, "call-q", 2));
    assert.equal(h.latest().pendingInput, true, "a published unanswered question is pending");
    assert.equal(h.latest().busy, true, "the root keeps working; pending never forces busy false");

    // Root work, tool completion, an unrelated helper question, and a provider
    // status refresh never clear it.
    h.facts.observe(itemPhaseEvent("started", "tool-1", "command", ROOT, TURN_ONE));
    h.facts.observe(itemPhaseEvent("completed", "tool-1", "command", ROOT, TURN_ONE));
    h.facts.observe(asyncQuestions("helper-thread", "call-h", 1));
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    await settle(60);
    assert.equal(h.latest().pendingInput, true);
    assert.equal(h.latest().busy, true);

    h.facts.observe(asyncReply(ROOT, "call-q", 0));
    assert.equal(h.latest().pendingInput, true, "the second question still waits");
    h.facts.observe(asyncReply(ROOT, "call-q", 1));
    assert.equal(h.latest().pendingInput, false);

    // An input-only gap is unknown and leaves every other axis intact.
    h.facts.observe(Object.freeze({
      kind: "async-input-unreadable",
      connectionId: CONNECTION,
      sequence: 30,
      source: "questions",
      threadId: ROOT,
      turnId: TURN_ONE,
    } as NativeCodexTuiRelayMetadataEvent));
    assert.equal(h.latest().pendingInput, null);
    assert.equal(h.latest().busy, true);
    assert.equal(h.latest().activeTasks, 0);
    assert.equal(h.latest().activeShells, 0);

    // An independent CURRENT provider block still proves pending over the gap,
    // and once it clears the input axis returns to unknown, not none.
    h.server.setStatus(ROOT, activeStatus(["waitingOnUserInput"]));
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: ["waitingOnUserInput"] } });
    await until(() => h.latest().pendingInput === true, "the provider block");
    assert.equal(h.latest().busy, false, "a provider block keeps its canonical waiting shape");
    h.server.setStatus(ROOT, activeStatus([]));
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    await until(() => h.latest().busy === true, "the block to clear");
    assert.equal(h.latest().pendingInput, null);

    // The turn's own live terminal retires the native queue: knowledge is complete again.
    h.facts.observe(Object.freeze({
      kind: "turn-terminal",
      connectionId: CONNECTION,
      sequence: 31,
      threadId: ROOT,
      turnId: TURN_ONE,
      status: "completed",
    } as NativeCodexTuiRelayMetadataEvent));
    assert.equal(h.latest().pendingInput, false);
    assert.equal(h.dials(), 1);
  } finally {
    await h.close();
  }
});

/* ======================================= exact restore and private identity */

const RESTORED = "7a3c9a52-41d4-4f55-9a0e-8b0b6f3d2c11";
const FRESH_UUID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const WORKSPACE = "/owned/restore-workspace";
const OTHER_WORKSPACE = "/owned/someone-elses-workspace";

interface IdentityHarness {
  readonly server: FakeCodexAppServer;
  readonly facts: NativeCodexTuiRootFactsBinder;
  readonly observations: NativeStatusObservation[];
  /** Every identity report, accepted or not, in order. */
  readonly identities: Array<string | null>;
  /** Every title report, accepted or not, in order. */
  readonly titles: Array<{ readonly conversationId: string; readonly title: string | null }>;
  readonly consumer: NativeStatusObserver;
  deliverCap(facts?: NativeCodexTuiRootFactsSource): void;
  latest(): NativeStatusObservation;
  dials(): number;
  close(): Promise<void>;
}

async function startIdentityHarness(options: {
  readonly threads: readonly FakeThread[];
  readonly loadedIds: readonly string[];
  readonly resume?: string;
  readonly workspace?: string;
  /** Owner acceptance for each identity report; defaults to accepting. */
  readonly accept?: (conversationId: string | null) => boolean;
  /** Owner acceptance for each title report; defaults to accepting. */
  readonly acceptTitle?: (conversationId: string, title: string | null) => boolean;
}): Promise<IdentityHarness> {
  const server = new FakeCodexAppServer({
    threads: options.threads,
    loadedIds: options.loadedIds,
    backgroundTerminals: Object.fromEntries(options.threads.map((thread) => [thread.id, []])),
    requireAuthorization: BEARER,
  });
  const port = await server.listenLoopback();
  // The composite configures the retained binder with the same B for a restore.
  const facts = createNativeCodexTuiRootFactsBinder(
    options.resume === undefined ? undefined : { resumeConversationId: options.resume },
  );
  const observations: NativeStatusObservation[] = [];
  const identities: Array<string | null> = [];
  const titles: Array<{ readonly conversationId: string; readonly title: string | null }> = [];
  const emit = (observation: NativeStatusObservation): void => {
    observations.push(observation);
  };
  const legacy = createNativeStatusObserver({ rowId: "row-restore", backend: "codex", emit });
  const consumer = createOwnedNativeCodexStatusObserver({
    legacy,
    emit,
    limits: LIMITS,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.resume === undefined ? {} : { resumeConversationId: options.resume }),
    onConversationIdentity: (conversationId) => {
      identities.push(conversationId);
      return options.accept === undefined ? true : options.accept(conversationId);
    },
    onConversationTitle: (conversationId, title) => {
      titles.push({ conversationId, title });
      return options.acceptTitle === undefined ? true : options.acceptTitle(conversationId, title);
    },
  });
  return {
    server,
    facts,
    observations,
    identities,
    titles,
    consumer,
    deliverCap: (override) => consumer.observeOwnedCodexBackend?.(makeSource(port, override ?? facts)),
    latest: () => observations[observations.length - 1] as NativeStatusObservation,
    dials: () => server.upgradeCount,
    close: async () => {
      consumer.dispose();
      await server.stop();
    },
  };
}

function resumeEvent(
  threadId: string,
  extra: Partial<Extract<NativeCodexTuiRelayMetadataEvent, { kind: "thread-candidate" }>> = {},
): NativeCodexTuiRelayMetadataEvent {
  return threadStartEvent(threadId, { origin: "thread-resume", requestedThreadId: threadId, ...extra });
}

/** The restored candidate proof, in the order the composite and relay produce it. */
function restoredCandidate(facts: NativeCodexTuiRootFactsBinder, threadId = RESTORED): void {
  facts.attestEmptyBackend();
  facts.observe(initializeEvent());
  facts.observe(resumeEvent(threadId));
}

function restoredThread(cwd: string, status = idleStatus): FakeThread {
  return { id: RESTORED, parentThreadId: null, status, sourceKind: "cli", cwd };
}

async function censusLanded(h: IdentityHarness): Promise<void> {
  await until(
    () => h.server.requests.some((request) => request.method === "thread/backgroundTerminals/list")
      || h.server.requests.filter((request) => request.method === "thread/read").length > 0,
    "the first census",
  );
  await settle(80);
}

test("a restored candidate B confirms its identity before any prompt and reads none, Ready, 0, 0", async () => {
  const h = await startIdentityHarness({
    threads: [restoredThread(WORKSPACE)],
    loadedIds: [RESTORED],
    resume: RESTORED,
    workspace: WORKSPACE,
  });
  try {
    h.deliverCap();
    restoredCandidate(h.facts);
    assert.equal(h.facts.current().phase, "candidate");
    assert.equal(h.facts.current().asyncInput, "none", "a restored native UI starts with an empty question queue");
    await until(() => h.identities.length === 1, "the private identity confirmation");
    assert.deepEqual(h.identities, [RESTORED], "the exact restored root, before the first prompt");
    await until(() => h.observations.some((o) => o.activeShells !== null), "the pre-prompt census");
    assert.deepEqual(
      { busy: h.latest().busy, pendingInput: h.latest().pendingInput, activeTasks: h.latest().activeTasks, activeShells: h.latest().activeShells, activity: h.latest().activity },
      { busy: false, pendingInput: false, activeTasks: 0, activeShells: 0, activity: ["Ready"] },
    );
    assert.deepEqual(
      h.server.requests.find((request) => request.method === "thread/read")?.params,
      { threadId: RESTORED, includeTurns: false },
    );
    for (const request of h.server.requests) {
      assert.ok(["initialize", "thread/read", "thread/list", "thread/loaded/list", "thread/backgroundTerminals/list"].includes(request.method),
        `unexpected ${request.method}`);
    }

    // The first own turn binds the SAME B on the SAME observer and supersedes
    // any census that may predate it; the identity is not reported twice.
    h.server.setStatus(RESTORED, activeStatus([]));
    h.facts.observe(turnWorkTargetEvent(RESTORED, TURN_ONE));
    await until(() => h.latest().busy === true, "the own turn's work without a broadcast");
    assert.equal(h.dials(), 1, "never redialed");
    assert.equal(h.server.connectionCount, 1, "no second observer connection for the identity");
    await settle(120);
    assert.deepEqual(h.identities, [RESTORED], "an accepted identity is reported once");

    // No id or path ever rides on a published observation.
    const surfaced = JSON.stringify(h.observations);
    assert.equal(surfaced.includes(RESTORED), false);
    assert.equal(surfaced.includes(WORKSPACE), false);
  } finally {
    await h.close();
  }
});

test("a restored B whose saved workspace is not this row's never confirms and publishes nothing but unknown", async () => {
  const h = await startIdentityHarness({
    threads: [restoredThread(OTHER_WORKSPACE)],
    loadedIds: [RESTORED],
    resume: RESTORED,
    workspace: WORKSPACE,
  });
  try {
    h.deliverCap();
    restoredCandidate(h.facts);
    await censusLanded(h);
    h.server.broadcast("thread/status/changed", { threadId: RESTORED, status: { type: "idle" } });
    await settle(120);
    assert.deepEqual(h.identities, [], "a wrong workspace is never a confirmation");
    for (const observation of h.observations) {
      assert.equal(observation.busy, null);
      assert.equal(observation.pendingInput, null);
      assert.equal(observation.activeTasks, null);
      assert.equal(observation.activeShells, null);
      assert.deepEqual(observation.activity, []);
    }
    // Missing initial proof is not a loss: a later withdrawal reports no null.
    h.facts.withdraw("metadata-unavailable");
    await settle(30);
    assert.deepEqual(h.identities, []);
  } finally {
    await h.close();
  }
});

test("a restore consumer never dials an unexpected root, an unusable B, or a root without a workspace", async () => {
  // A source naming another thread for a restoring row (the real binder cannot
  // produce one; the consumer's own fence is what is proved here).
  const foreign = await startIdentityHarness({
    threads: [restoredThread(WORKSPACE), { id: FRESH_UUID, parentThreadId: null, status: idleStatus, sourceKind: "cli", cwd: WORKSPACE }],
    loadedIds: [RESTORED, FRESH_UUID],
    resume: RESTORED,
    workspace: WORKSPACE,
  });
  try {
    const controllable = new ControllableFacts();
    foreign.deliverCap(controllable);
    controllable.publish(Object.freeze({ phase: "candidate" as const, connectionId: CONNECTION, candidateThreadId: FRESH_UUID, asyncInput: "none" as const }));
    await settle(80);
    assert.equal(foreign.dials(), 0);
    assert.deepEqual(foreign.identities, []);
    assert.equal(controllable.watching, false, "the watcher detached on the withdrawal");
  } finally {
    await foreign.close();
  }

  // No workspace to prove against: a restore cannot be observed or confirmed.
  const noWorkspace = await startIdentityHarness({
    threads: [restoredThread(WORKSPACE)],
    loadedIds: [RESTORED],
    resume: RESTORED,
  });
  try {
    noWorkspace.deliverCap();
    restoredCandidate(noWorkspace.facts);
    await settle(80);
    assert.equal(noWorkspace.dials(), 0);
    assert.deepEqual(noWorkspace.identities, []);
    assert.equal(noWorkspace.latest().busy, null);
  } finally {
    await noWorkspace.close();
  }

  // An expectation that is not one exact provider UUID is never matched.
  const unusable = await startIdentityHarness({
    threads: [{ id: "not-a-uuid", parentThreadId: null, status: idleStatus, sourceKind: "cli", cwd: WORKSPACE }],
    loadedIds: ["not-a-uuid"],
    resume: "not-a-uuid",
    workspace: WORKSPACE,
  });
  try {
    unusable.deliverCap();
    restoredCandidate(unusable.facts, "not-a-uuid");
    await settle(80);
    assert.equal(unusable.dials(), 0);
    assert.deepEqual(unusable.identities, []);
  } finally {
    await unusable.close();
  }
});

test("an accepted live identity survives an unknown input gap and is withdrawn with null on source loss", async () => {
  const h = await startIdentityHarness({
    threads: [restoredThread(WORKSPACE)],
    loadedIds: [RESTORED],
    resume: RESTORED,
    workspace: WORKSPACE,
  });
  try {
    h.deliverCap();
    restoredCandidate(h.facts);
    h.server.setStatus(RESTORED, activeStatus([]));
    h.facts.observe(turnWorkTargetEvent(RESTORED, TURN_ONE));
    await until(() => h.latest().busy === true, "the working restored root");
    assert.deepEqual(h.identities, [RESTORED]);

    // An unknown input axis alone is not a root identity loss.
    h.facts.observe(Object.freeze({
      kind: "async-input-unreadable",
      connectionId: CONNECTION,
      sequence: 30,
      source: "questions",
      threadId: RESTORED,
      turnId: TURN_ONE,
    } as NativeCodexTuiRelayMetadataEvent));
    assert.equal(h.latest().pendingInput, null);
    assert.equal(h.latest().busy, true);
    assert.deepEqual(h.identities, [RESTORED], "no null for an input gap");

    // A live source loss withdraws status and clears the accepted identity once.
    h.facts.observe(initializeEvent("conn-second"));
    assert.equal(h.facts.current().phase, "withdrawn");
    assert.deepEqual(h.identities, [RESTORED, null]);
    assert.equal(h.latest().busy, null);
    assert.equal(h.latest().activeTasks, null);
    await until(() => h.server.connectionCount === 0, "the read-only socket's close");
    await settle(30);
    assert.deepEqual(h.identities, [RESTORED, null], "reported once, never repeated");
  } finally {
    await h.close();
  }
});

test("an identity refused before activation is retried by the next validated read, then deduplicated", async () => {
  let accepting = false;
  const h = await startIdentityHarness({
    threads: [restoredThread(WORKSPACE)],
    loadedIds: [RESTORED],
    resume: RESTORED,
    workspace: WORKSPACE,
    accept: () => accepting,
  });
  try {
    h.deliverCap();
    restoredCandidate(h.facts);
    await until(() => h.identities.length === 1, "the first (refused) report");
    accepting = true;
    // The next census's own root read is the retry; no timer or queue exists.
    h.server.broadcast("thread/status/changed", { threadId: RESTORED, status: { type: "idle" } });
    await until(() => h.identities.length === 2, "the retried report");
    assert.deepEqual(h.identities, [RESTORED, RESTORED]);
    h.server.broadcast("thread/status/changed", { threadId: RESTORED, status: { type: "idle" } });
    await settle(150);
    assert.deepEqual(h.identities, [RESTORED, RESTORED], "accepted once, then deduplicated");
  } finally {
    await h.close();
  }
});

test("owner retirement never clears the saved identity and no callback follows it", async () => {
  for (const retire of ["invalidate", "dispose"] as const) {
    const h = await startIdentityHarness({
      threads: [restoredThread(WORKSPACE)],
      loadedIds: [RESTORED],
      resume: RESTORED,
      workspace: WORKSPACE,
    });
    try {
      h.deliverCap();
      restoredCandidate(h.facts);
      await until(() => h.identities.length === 1, `${retire}: identity`);
      const published = h.observations.length;
      if (retire === "invalidate") h.consumer.invalidate?.();
      else h.consumer.dispose();
      h.facts.withdraw("generation-closed");
      h.server.broadcast("thread/status/changed", { threadId: RESTORED, status: { type: "idle" } });
      await settle(120);
      assert.deepEqual(h.identities, [RESTORED], `${retire}: no null and no later report`);
      assert.equal(h.observations.length, published, `${retire}: nothing published after retirement`);
    } finally {
      await h.close();
    }
  }
});

test("a fresh root reports its identity only with real workspace corroboration", async () => {
  const freshThread = (cwd: string): FakeThread => ({ id: FRESH_UUID, parentThreadId: null, status: idleStatus, sourceKind: "cli", cwd });

  const matched = await startIdentityHarness({ threads: [freshThread(WORKSPACE)], loadedIds: [FRESH_UUID], workspace: WORKSPACE });
  try {
    matched.deliverCap();
    freshCandidate(matched.facts, FRESH_UUID);
    await until(() => matched.identities.length === 1, "the fresh identity");
    assert.deepEqual(matched.identities, [FRESH_UUID], "a fresh candidate is confirmed before its first prompt");
    await until(() => matched.observations.some((o) => o.activeShells !== null), "the census");
    assert.equal(matched.latest().busy, false);
  } finally {
    await matched.close();
  }

  const elsewhere = await startIdentityHarness({ threads: [freshThread(OTHER_WORKSPACE)], loadedIds: [FRESH_UUID], workspace: WORKSPACE });
  try {
    elsewhere.deliverCap();
    freshCandidate(elsewhere.facts, FRESH_UUID);
    await censusLanded(elsewhere);
    assert.deepEqual(elsewhere.identities, []);
    assert.equal(elsewhere.latest().busy, null);
    assert.equal(elsewhere.latest().activeShells, null);
  } finally {
    await elsewhere.close();
  }

  // A caller that supplies no workspace keeps the old fresh behavior exactly and
  // never reports an identity it could not corroborate.
  const legacyShape = await startIdentityHarness({ threads: [freshThread(OTHER_WORKSPACE)], loadedIds: [FRESH_UUID] });
  try {
    legacyShape.deliverCap();
    freshCandidate(legacyShape.facts, FRESH_UUID);
    await until(() => legacyShape.observations.some((o) => o.activeShells !== null), "the census");
    assert.equal(legacyShape.latest().busy, false, "unchanged fresh card");
    assert.deepEqual(legacyShape.identities, []);
  } finally {
    await legacyShape.close();
  }
});

test("the legacy lane never reports an identity for a restoring row", async () => {
  const h = await startIdentityHarness({
    threads: [restoredThread(WORKSPACE)],
    loadedIds: [RESTORED],
    resume: RESTORED,
    workspace: WORKSPACE,
  });
  try {
    // No capability is ever delivered: the row stays on the legacy hook lane.
    restoredCandidate(h.facts);
    h.consumer.acceptHook(HOOK_EVENT);
    h.consumer.acceptFailure(HOOK_FAILURE);
    await settle(60);
    assert.equal(h.dials(), 0);
    assert.deepEqual(h.identities, []);
  } finally {
    await h.close();
  }
});

/* ============================ contradiction and the bound connection's own end */

function generationClosed(reason: string, connectionId = CONNECTION): NativeCodexTuiRelayMetadataEvent {
  return Object.freeze({ kind: "generation-closed", connectionId, sequence: 40, reason } as NativeCodexTuiRelayMetadataEvent);
}

/** Both orders in which the adopted connection's stream can end. */
const STREAM_ENDS = ["client-closed", "backend-closed"] as const;

/**
 * A restore whose exact B the owner ACCEPTED, either still the pre-prompt
 * candidate or already bound by its first own turn.
 */
async function acceptedRestore(stage: "candidate" | "bound" = "bound"): Promise<IdentityHarness> {
  const h = await startIdentityHarness({
    threads: [restoredThread(WORKSPACE)],
    loadedIds: [RESTORED],
    resume: RESTORED,
    workspace: WORKSPACE,
  });
  h.deliverCap();
  restoredCandidate(h.facts);
  if (stage === "bound") h.facts.observe(turnWorkTargetEvent(RESTORED, TURN_ONE));
  await until(() => h.identities.length === 1 && h.observations.some((o) => o.activeShells !== null), "the accepted identity");
  return h;
}

test("a positive root contradiction after confirmation clears the accepted identity; a read gap does not", async () => {
  for (const contradiction of ["workspace", "root"] as const) {
    const h = await acceptedRestore();
    try {
      // A transient unreadable read keeps the identity.
      h.server.unreadable.add(RESTORED);
      h.server.broadcast("thread/status/changed", { threadId: RESTORED, status: { type: "idle" } });
      await settle(150);
      assert.deepEqual(h.identities, [RESTORED], `${contradiction}: no null for a read gap`);
      h.server.unreadable.delete(RESTORED);

      if (contradiction === "workspace") h.server.setThread(restoredThread(OTHER_WORKSPACE));
      else h.server.mismatched.add(RESTORED);
      h.server.broadcast("thread/status/changed", { threadId: RESTORED, status: { type: "idle" } });
      await until(() => h.identities.length === 2, `${contradiction}: the explicit loss`);
      assert.deepEqual(h.identities, [RESTORED, null]);
      await until(() => h.latest().busy === null && h.latest().activeShells === null, `${contradiction}: unknown status`);
      assert.equal(h.latest().activeTasks, null);

      // Disposal afterwards reports nothing further.
      h.consumer.dispose();
      await settle(30);
      assert.deepEqual(h.identities, [RESTORED, null]);
    } finally {
      await h.close();
    }
  }
});

test("either stream-end order before PTY exit keeps the identity through the owner's retirement", async () => {
  for (const reason of STREAM_ENDS) {
    for (const stage of ["candidate", "bound"] as const) {
      for (const retire of ["invalidate", "dispose"] as const) {
        const label = `${reason}/${stage}/${retire}`;
        const h = await acceptedRestore(stage);
        try {
          const before = h.observations.length;
          h.facts.observe(generationClosed(reason));
          // Status is withdrawn exactly as for any withdrawal: one unknown snapshot,
          // and the read-only socket really closes.
          assert.equal(h.observations.length, before + 1, label);
          assert.equal(h.latest().busy, null, label);
          assert.equal(h.latest().pendingInput, null, label);
          assert.equal(h.latest().activeTasks, null, label);
          assert.equal(h.latest().activeShells, null, label);
          await until(() => h.server.connectionCount === 0, `${label}: the read-only socket's close`);
          assert.deepEqual(h.identities, [RESTORED], `${label}: the connection end alone clears nothing`);
          assert.equal(h.facts.current().phase, "withdrawn", `${label}: status stays withdrawn`);
          const requests = h.server.requests.length;

          // The owner then sees the PTY exit and retires the run: still nothing.
          if (retire === "invalidate") h.consumer.invalidate?.();
          else h.consumer.dispose();
          h.facts.observe(initializeEvent("conn-after-retire"));
          h.server.broadcast("thread/status/changed", { threadId: RESTORED, status: { type: "idle" } });
          await settle(60);
          assert.deepEqual(h.identities, [RESTORED], `${label}: retirement never clears the saved identity`);
          assert.equal(h.observations.length, before + 1, `${label}: nothing published after retirement`);
          assert.equal(h.dials(), 1, `${label}: never redialed`);
          assert.equal(h.server.connectionCount, 0, `${label}: no reconnection`);
          assert.equal(h.server.requests.length, requests, `${label}: no request after the close`);
        } finally {
          await h.close();
        }
      }
    }
  }
});

test("after either stream end, any later connection or event clears the held identity once", async () => {
  const later: Array<{ readonly label: string; readonly event: NativeCodexTuiRelayMetadataEvent }> = [
    { label: "a new genuine connection", event: initializeEvent("conn-reconnected") },
    { label: "a stray event on the closed connection", event: turnWorkTargetEvent(RESTORED, TURN_TWO) },
    { label: "a second selection on the closed connection", event: resumeEvent(RESTORED) },
    { label: "a new selection on the closed connection", event: threadStartEvent(FRESH_UUID) },
    {
      label: "a metadata loss",
      event: Object.freeze({ kind: "metadata-unavailable", connectionId: "conn-reconnected", sequence: 41, scope: "connection", reason: "compressed-stream" } as NativeCodexTuiRelayMetadataEvent),
    },
    {
      label: "a stray metadata loss on the closed connection",
      event: Object.freeze({ kind: "metadata-unavailable", connectionId: CONNECTION, sequence: 41, scope: "connection", reason: "compressed-stream" } as NativeCodexTuiRelayMetadataEvent),
    },
    { label: "a stray second close on the closed connection", event: generationClosed("client-closed") },
  ];
  for (const reason of STREAM_ENDS) {
    for (const stage of ["candidate", "bound"] as const) {
      for (const { label: what, event } of later) {
        const label = `${reason}/${stage}: ${what}`;
        const h = await acceptedRestore(stage);
        try {
          h.facts.observe(generationClosed(reason));
          assert.deepEqual(h.identities, [RESTORED], `${label}: held`);
          const published = h.observations.length;
          h.facts.observe(event);
          assert.deepEqual(h.identities, [RESTORED, null], `${label}: a later event ends the hold as a live loss`);
          assert.equal(h.observations.length, published, `${label}: status was already withdrawn; nothing republished`);
          assert.equal(h.facts.current().phase, "withdrawn", `${label}: status stays withdrawn`);
          // The consumer detached: the source serves a new watcher again.
          let delivered = false;
          const unsubscribe = h.facts.watch(() => {
            delivered = true;
          });
          assert.equal(delivered, true, `${label}: watcher detached`);
          unsubscribe();
          h.facts.observe(initializeEvent("conn-third"));
          await settle(30);
          assert.deepEqual(h.identities, [RESTORED, null], `${label}: reported once`);
          assert.equal(h.observations.length, published, `${label}: never recreates status`);
          assert.equal(h.dials(), 1, `${label}: no status rebind, no redial`);

          // Disposal afterwards reports nothing further.
          h.consumer.dispose();
          await settle(10);
          assert.deepEqual(h.identities, [RESTORED, null], `${label}: nothing after retirement`);
        } finally {
          await h.close();
        }
      }
    }
  }
});

test("any other close reason is an ordinary live loss of the accepted identity", async () => {
  for (const reason of ["handshake-timeout", "backend-handshake-rejected", "preflight-overflow", "relay-stopped"]) {
    const h = await acceptedRestore();
    try {
      h.facts.observe(generationClosed(reason));
      assert.deepEqual(h.identities, [RESTORED, null], reason);
      assert.equal(h.latest().busy, null, reason);
      // No identity-only watcher stays attached.
      let delivered = false;
      const unsubscribe = h.facts.watch(() => {
        delivered = true;
      });
      assert.equal(delivered, true, `${reason}: watcher detached`);
      unsubscribe();
      h.facts.observe(initializeEvent("conn-reconnected"));
      await settle(30);
      assert.deepEqual(h.identities, [RESTORED, null], `${reason}: reported once`);
    } finally {
      await h.close();
    }
  }

  // A close of a stream end on a connection that never was the adopted one is
  // the source's own loss, never a hold.
  const foreign = await acceptedRestore();
  try {
    foreign.facts.observe(generationClosed("backend-closed", "conn-foreign"));
    assert.deepEqual(foreign.identities, [RESTORED, null], "foreign close");
    assert.equal(foreign.latest().busy, null, "foreign close");
  } finally {
    await foreign.close();
  }
});

test("a stream end with no accepted identity is never a hold and never a null", async () => {
  for (const reason of STREAM_ENDS) {
    // The restored B is the initial seed, but its workspace never matched.
    const unconfirmed = await startIdentityHarness({
      threads: [restoredThread(OTHER_WORKSPACE)],
      loadedIds: [RESTORED],
      resume: RESTORED,
      workspace: WORKSPACE,
    });
    try {
      unconfirmed.deliverCap();
      restoredCandidate(unconfirmed.facts);
      await censusLanded(unconfirmed);
      unconfirmed.facts.observe(generationClosed(reason));
      unconfirmed.facts.observe(initializeEvent("conn-reconnected"));
      await settle(30);
      assert.deepEqual(unconfirmed.identities, [], reason);
      let delivered = false;
      const unsubscribe = unconfirmed.facts.watch(() => {
        delivered = true;
      });
      assert.equal(delivered, true, `${reason}: no identity was held, so nothing stayed attached`);
      unsubscribe();
    } finally {
      await unconfirmed.close();
    }

    // A validated B the owner REFUSED is reported but never accepted.
    const refused = await startIdentityHarness({
      threads: [restoredThread(WORKSPACE)],
      loadedIds: [RESTORED],
      resume: RESTORED,
      workspace: WORKSPACE,
      accept: () => false,
    });
    try {
      refused.deliverCap();
      restoredCandidate(refused.facts);
      await until(() => refused.identities.length === 1, `${reason}: the refused report`);
      refused.facts.observe(generationClosed(reason));
      await until(() => refused.server.connectionCount === 0, `${reason}: the read-only socket's close`);
      assert.equal(refused.latest().busy, null, `${reason}: refused`);
      refused.facts.observe(initializeEvent("conn-reconnected"));
      refused.consumer.dispose();
      await settle(30);
      assert.deepEqual(refused.identities, [RESTORED], `${reason}: a refused identity gets no hold and no null`);
      let delivered = false;
      const unsubscribe = refused.facts.watch(() => {
        delivered = true;
      });
      assert.equal(delivered, true, `${reason}: refused: nothing stayed attached`);
      unsubscribe();
    } finally {
      await refused.close();
    }
  }
});

/* ================================= provider conversation TITLE (issue #690) */

test("the accepted root's actual title is reported once, after its identity, and never on an observation", async () => {
  const h = await startIdentityHarness({
    threads: [{ ...restoredThread(WORKSPACE), name: "Investigate the flaky census" }],
    loadedIds: [RESTORED],
    resume: RESTORED,
    workspace: WORKSPACE,
  });
  try {
    h.deliverCap();
    restoredCandidate(h.facts);
    await until(() => h.identities.length === 1, "the identity");
    await until(() => h.titles.length === 1, "the title from the same validated root read");
    assert.deepEqual(h.identities, [RESTORED]);
    assert.deepEqual(h.titles, [{ conversationId: RESTORED, title: "Investigate the flaky census" }]);
    assert.equal(JSON.stringify(h.observations).includes("Investigate the flaky census"), false,
      "a title never rides a status observation");

    // A later census of the same root restates nothing new.
    h.server.broadcast("thread/status/changed", { threadId: RESTORED, status: idleStatus });
    await settle(150);
    assert.equal(h.titles.length, 1, "an unchanged title is never republished");

    // The provider's own rename reaches this consumer only as a new read value.
    h.server.setThread({ ...restoredThread(WORKSPACE), name: "Investigate the flaky census, take two" });
    h.server.broadcast("thread/name/updated", { threadId: RESTORED, threadName: "Investigate the flaky census, take two" });
    await until(() => h.titles.length === 2, "the renamed title from the next root read");
    assert.deepEqual(h.titles[1], {
      conversationId: RESTORED,
      title: "Investigate the flaky census, take two",
    });
    assert.deepEqual(h.identities, [RESTORED], "a rename is not a new identity");
  } finally {
    await h.close();
  }
});

test("a root that positively reports no title says so, and a refused identity receives no title at all", async () => {
  const titled = await startIdentityHarness({
    threads: [{ ...restoredThread(WORKSPACE), name: null }],
    loadedIds: [RESTORED],
    resume: RESTORED,
    workspace: WORKSPACE,
  });
  try {
    titled.deliverCap();
    restoredCandidate(titled.facts);
    await until(() => titled.titles.length === 1, "the positive no-title answer");
    assert.deepEqual(titled.titles, [{ conversationId: RESTORED, title: null }]);
  } finally {
    await titled.close();
  }

  const refused = await startIdentityHarness({
    threads: [{ ...restoredThread(WORKSPACE), name: "Never shown" }],
    loadedIds: [RESTORED],
    resume: RESTORED,
    workspace: WORKSPACE,
    accept: () => false,
  });
  try {
    refused.deliverCap();
    restoredCandidate(refused.facts);
    await until(() => refused.identities.length >= 1, "a refused identity report");
    await settle(150);
    assert.deepEqual(refused.titles, [], "a title without an accepted conversation is never offered");
  } finally {
    await refused.close();
  }
});

test("a refused title is retried by the next validated root read, never by a timer of its own", async () => {
  let accept = false;
  const h = await startIdentityHarness({
    threads: [{ ...restoredThread(WORKSPACE), name: "First offer" }],
    loadedIds: [RESTORED],
    resume: RESTORED,
    workspace: WORKSPACE,
    acceptTitle: () => accept,
  });
  try {
    h.deliverCap();
    restoredCandidate(h.facts);
    await until(() => h.titles.length === 1, "the first offer");
    await settle(150);
    assert.equal(h.titles.length, 1, "a refused title is not retried while nothing new arrives");

    accept = true;
    h.server.broadcast("thread/status/changed", { threadId: RESTORED, status: idleStatus });
    await until(() => h.titles.length === 2, "the next validated read retries it");
    assert.deepEqual(h.titles[1], { conversationId: RESTORED, title: "First offer" });
  } finally {
    await h.close();
  }
});

test("retirement reports no title, and nothing can follow it", async () => {
  for (const retire of ["invalidate", "dispose"] as const) {
    const h = await startIdentityHarness({
      threads: [{ ...restoredThread(WORKSPACE), name: "Before retirement" }],
      loadedIds: [RESTORED],
      resume: RESTORED,
      workspace: WORKSPACE,
    });
    try {
      h.deliverCap();
      restoredCandidate(h.facts);
      await until(() => h.titles.length === 1, `${retire}: the title`);
      const titlesBefore = h.titles.length;
      const identitiesBefore = h.identities.length;
      if (retire === "invalidate") h.consumer.invalidate?.();
      else h.consumer.dispose();
      await settle(150);
      assert.equal(h.titles.length, titlesBefore, `${retire}: retirement never reports a title`);
      assert.equal(h.identities.length, identitiesBefore, `${retire}: retirement never clears the saved identity`);

      h.server.setThread({ ...restoredThread(WORKSPACE), name: "After retirement" });
      h.server.broadcast("thread/name/updated", { threadId: RESTORED, threadName: "After retirement" });
      await settle(150);
      assert.equal(h.titles.length, titlesBefore, `${retire}: no callback follows retirement`);
    } finally {
      await h.close();
    }
  }
});
