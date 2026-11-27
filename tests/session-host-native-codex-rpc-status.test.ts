/**
 * Owned-endpoint native Codex status observer acceptance.
 *
 * These run the real observer against the real fake backend over the
 * authenticated loopback WebSocket, with an injected virtual scheduler so every
 * refresh, cooldown, active re-arm, and reconnect is exercised deterministically
 * instead of by waiting. The contract under test is the one the sidebar card
 * consumes: five real categories with real values, honest unknowns, and no
 * control-plane authority.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_CODEX_RPC_ACTIVITY_READY,
  NATIVE_CODEX_RPC_ACTIVITY_WORKING,
  NATIVE_CODEX_RPC_MAX_DEPARTURE_RESTARTS,
  NATIVE_CODEX_RPC_STATUS_SUPPORT,
  NativeCodexRpcStatusObserver,
  combineNativeCodexInputAxes,
  countActiveNativeCodexDescendants,
  isActiveNativeCodexDescendantStatus,
  projectNativeCodexRootStatus,
  type NativeCodexRpcStatusDiagnosticCode,
  type NativeCodexRpcStatusObserverOptions,
  type NativeCodexRpcStatusScheduler,
} from "../src/session-host/native-codex-rpc-status";
import type { NativeStatusObservation } from "../src/session-host/native-status";
import {
  FAKE_MARKER,
  FakeCodexAppServer,
  type FakeCodexServerOptions,
  type FakeThread,
  activeStatus,
  idleStatus,
  systemErrorStatus,
} from "./session-host-native-codex-rpc-fixture";

const ROOT = "root-0000";
const CHILD_ACTIVE = "child-active";
const CHILD_DONE = "child-done";
const CHILD_PERSISTED = "child-persisted";
const NESTED = "child-nested";
const UNRELATED_ROOT = "other-root";
const FORK = "a-fork";

/* ------------------------------------------------------------- test seams */

/** Virtual timer seam: nothing in the observer runs on a wall clock. */
class FakeScheduler implements NativeCodexRpcStatusScheduler {
  #now = 0;
  #nextId = 1;
  readonly #timers = new Map<number, { due: number; callback: () => void }>();

  setTimer(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId += 1;
    this.#timers.set(id, { due: this.#now + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pendingTimerCount(): number {
    return this.#timers.size;
  }

  /** Runs every timer due within the next `ms`, in due order, re-entrantly. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextDue = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.#timers) {
        if (timer.due <= target && timer.due < nextDue) {
          nextDue = timer.due;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.#timers.get(nextId)!;
      this.#timers.delete(nextId);
      this.#now = timer.due;
      timer.callback();
      // A timer callback starts a real I/O walk; give it room to finish.
      await settle(15);
    }
    this.#now = target;
    await settle(15);
  }
}

function settle(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a running census to land. Mid-census publications are suppressed by
 * design, so a test that asserts the effect of a caller-side update has to let
 * the in-flight walk republish first rather than race it.
 */
async function awaitQuiet(observer: NativeCodexRpcStatusObserver): Promise<void> {
  for (let waited = 0; observer.censusInFlight && waited < 4_000; waited += 10) {
    await settle(10);
  }
  assert.equal(observer.censusInFlight, false, "the census should have landed");
}

interface Harness {
  readonly server: FakeCodexAppServer;
  readonly scheduler: FakeScheduler;
  readonly observations: NativeStatusObservation[];
  readonly diagnostics: NativeCodexRpcStatusDiagnosticCode[];
  readonly observer: NativeCodexRpcStatusObserver;
  latest(): NativeStatusObservation;
  requests(method: string): number;
  quiet(): Promise<void>;
  close(): Promise<void>;
}

const POPULATION: readonly FakeThread[] = [
  { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli", cwd: "/owned/worktree" },
  { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
  { id: CHILD_DONE, parentThreadId: ROOT, status: idleStatus, sourceKind: "subAgentThreadSpawn" },
  // Persisted but not loaded: the provider reports `notLoaded`, never a stale active.
  { id: CHILD_PERSISTED, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
  // A nested child legitimately runs in its own worktree, so it must still count.
  { id: NESTED, parentThreadId: CHILD_ACTIVE, status: activeStatus(), sourceKind: "subAgentThreadSpawn", cwd: "/owned/worktree-nested" },
  // Another operator's root in the SAME cwd, and a fork of our root: neither is ours.
  { id: UNRELATED_ROOT, parentThreadId: null, status: activeStatus(), sourceKind: "cli", cwd: "/owned/worktree" },
  { id: FORK, parentThreadId: null, status: activeStatus(), sourceKind: "cli", forkedFromId: ROOT, cwd: "/owned/worktree" },
];

async function startHarness(
  overrides: Partial<FakeCodexServerOptions> = {},
  observerOverrides: Partial<NativeCodexRpcStatusObserverOptions> = {},
): Promise<Harness> {
  const server = new FakeCodexAppServer({
    threads: POPULATION,
    loadedIds: [ROOT, CHILD_ACTIVE, CHILD_DONE, NESTED, UNRELATED_ROOT, FORK],
    backgroundTerminals: { [ROOT]: [] },
    requireAuthorization: "lease-token",
    ...overrides,
  });
  const port = await server.listenLoopback();
  const scheduler = new FakeScheduler();
  const observations: NativeStatusObservation[] = [];
  const diagnostics: NativeCodexRpcStatusDiagnosticCode[] = [];
  const observer = new NativeCodexRpcStatusObserver({
    endpoint: {
      kind: "loopback-ws",
      host: "127.0.0.1",
      port,
      authorization: { scheme: "bearer", token: () => "lease-token" },
    },
    rootThreadId: ROOT,
    generation: "gen-1",
    expectedCodexHome: "/owned/codex-home",
    // These suites state a positively empty async question queue; the input
    // axis needs that knowledge before it can be a positive none.
    asyncInput: "none",
    scheduler,
    onObservation: (observation) => observations.push(observation),
    onDiagnostic: (code) => diagnostics.push(code),
    ...observerOverrides,
  });
  await observer.start();
  return {
    server,
    scheduler,
    observations,
    diagnostics,
    observer,
    latest: () => observations[observations.length - 1] as NativeStatusObservation,
    requests: (method) => server.requests.filter((request) => request.method === method).length,
    quiet: async () => {
      await awaitQuiet(observer);
    },
    close: async () => {
      observer.dispose();
      await server.stop();
    },
  };
}

/* --------------------------------------------------------------- the card */

test("publishes the real card from wire-shaped metadata, with no placeholder churn", async () => {
  const h = await startHarness();
  try {
    const card = h.latest();
    assert.equal(card.busy, false, "idle is a positive Ready, not unknown");
    assert.equal(card.pendingInput, false, "no active flags is a positively reported none");
    assert.deepEqual(card.activity, [NATIVE_CODEX_RPC_ACTIVITY_READY]);
    assert.equal(card.activeTasks, 2, "only the live owned subagents count");
    assert.equal(card.activeShells, 0, "an authoritative empty page is a real zero");
    assert.deepEqual(card.support, NATIVE_CODEX_RPC_STATUS_SUPPORT);
    for (const category of Object.values(NATIVE_CODEX_RPC_STATUS_SUPPORT)) {
      assert.equal(category, "supported", "no category opts out to not-applicable");
    }
    // Exactly one publication for a healthy first pull: no blank-then-fill dance.
    assert.equal(h.observations.length, 1);

    const ancestorQuery = h.server.requests.find((request) => request.method === "thread/list");
    assert.ok(ancestorQuery !== undefined);
    assert.equal(ancestorQuery.params.ancestorThreadId, ROOT);
    assert.equal("cwd" in ancestorQuery.params, false, "a cwd filter would silently drop owned worktree children");
    assert.equal(ancestorQuery.params.useStateDbOnly, true);
    assert.deepEqual(ancestorQuery.params.sourceKinds,
      ["subAgent", "subAgentThreadSpawn", "subAgentReview", "subAgentCompact", "subAgentOther"]);
    assert.deepEqual(h.server.requests.find((request) => request.method === "thread/read")?.params,
      { threadId: ROOT, includeTurns: false });
  } finally {
    await h.close();
  }
});

test("agent and input follow the bound root's live status, including pending none", async () => {
  const h = await startHarness();
  try {
    h.server.setStatus(ROOT, activeStatus(["waitingOnApproval"]));
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: ["waitingOnApproval"] } });
    await settle(25);
    // Canonical waiting, asserted in full in its own case below.
    assert.deepEqual({ busy: h.latest().busy, pendingInput: h.latest().pendingInput, activity: h.latest().activity },
      { busy: false, pendingInput: true, activity: [NATIVE_CODEX_RPC_ACTIVITY_WORKING] });

    // A later status change is the only clearing witness for a non-subscriber.
    h.server.setStatus(ROOT, activeStatus([]));
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    await settle(25);
    assert.equal(h.latest().pendingInput, false, "active with no flags is a positive none");
    assert.equal(h.latest().busy, true);

    h.server.setStatus(ROOT, idleStatus);
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
    await settle(25);
    assert.equal(h.latest().busy, false);
    assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_READY]);
  } finally {
    await h.close();
  }
});

test("a blocked root is canonical waiting, and its open turn survives for the resume", async () => {
  const h = await startHarness();
  try {
    for (const flag of ["waitingOnApproval", "waitingOnUserInput"] as const) {
      h.server.setStatus(ROOT, activeStatus([flag]));
      h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [flag] } });
      await settle(25);

      const blocked = h.latest();
      assert.equal(blocked.pendingInput, true, `${flag} is a real pending prompt`);
      assert.equal(blocked.busy, false, `${flag} is waiting, not running`);
      assert.equal(h.observer.rootBlocked, true);
      assert.equal(h.observer.rootTurnActive, true, "the native turn is still open underneath the block");
      assert.equal(blocked.activeTasks, 2, "a block never zeroes the owned census");
      assert.equal(blocked.activeShells, 0);
      assert.deepEqual(blocked.activity, [NATIVE_CODEX_RPC_ACTIVITY_WORKING],
        "the underlying foreground keeps being reported while blocked");

      // The operator answers: the same open turn resumes to running. It must not
      // pass through Ready, because no turn end was ever observed.
      h.server.setStatus(ROOT, activeStatus([]));
      h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
      await settle(25);
      assert.equal(h.latest().busy, true, "the still-open turn resumes as running");
      assert.equal(h.latest().pendingInput, false);
      assert.equal(h.observer.rootTurnActive, true);
      assert.equal(h.observer.rootBlocked, false);
    }

    // Only a real turn end is Ready.
    h.server.setStatus(ROOT, idleStatus);
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
    await settle(25);
    assert.equal(h.latest().busy, false);
    assert.equal(h.latest().pendingInput, false);
    assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_READY]);
    assert.equal(h.observer.rootTurnActive, false);
  } finally {
    await h.close();
  }
});

test("background counts never hold the foreground running and a blocked child never blocks the root", async () => {
  const h = await startHarness();
  try {
    const card = h.latest();
    assert.equal(card.busy, false, "live owned work does not make the root itself run");
    assert.equal(card.pendingInput, false);
    assert.equal(card.activeTasks, 2);
    assert.equal(h.observer.rootTurnActive, false);

    // A child blocked on its own approval stays counted, and changes nothing on
    // the root's agent/input axes.
    h.server.setStatus(CHILD_ACTIVE, activeStatus(["waitingOnApproval"]));
    h.server.broadcast("thread/status/changed", {
      threadId: CHILD_ACTIVE,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    await settle(25);

    const after = h.latest();
    assert.equal(after.busy, false, "an unrelated pending question does not touch the root's agent axis");
    assert.equal(after.pendingInput, false, "the root is not the thread being asked");
    assert.equal(after.activeTasks, 2, "a child waiting on approval is still an active owned subagent");
    assert.equal(h.observer.rootBlocked, false);
  } finally {
    await h.close();
  }
});

test("systemError is neither Ready nor zero, and the other axes stay numeric", async () => {
  const h = await startHarness();
  try {
    h.server.setStatus(ROOT, systemErrorStatus);
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "systemError" } });
    await settle();
    const card = h.latest();
    assert.equal(card.busy, null);
    assert.equal(card.pendingInput, null);
    assert.deepEqual(card.activity, []);
    assert.equal(card.activeTasks, 2, "an unreadable root does not zero the census");
    assert.equal(card.activeShells, 0);
    assert.ok(h.diagnostics.includes("root-system-error"));
  } finally {
    await h.close();
  }
});

test("a descendant status edge recomputes the count while the root stays idle", async () => {
  const h = await startHarness();
  try {
    assert.equal(h.latest().activeTasks, 2);
    const censusBefore = h.requests("thread/list");

    // The root's status never changes here: only a child finishes.
    h.server.setStatus(CHILD_ACTIVE, idleStatus);
    h.server.setStatus(NESTED, idleStatus);
    h.server.broadcast("thread/status/changed", { threadId: CHILD_ACTIVE, status: { type: "idle" } });
    await settle(25);
    await h.scheduler.advance(300);
    await h.quiet();

    assert.equal(h.latest().activeTasks, 0, "completed-but-loaded children are excluded");
    assert.ok(h.requests("thread/list") > censusBefore, "the descendant edge must trigger a re-pull");
    assert.equal(h.latest().busy, false, "the root's own reading is untouched");
  } finally {
    await h.close();
  }
});

test("background shells reach a live zero while the root status never changes", async () => {
  const h = await startHarness();
  try {
    assert.equal(h.latest().activeShells, 0);

    // A turn starts, the command is backgrounded, and the turn ends. The root
    // status edges discover the terminal; nothing polls for it while idle.
    h.server.setStatus(ROOT, activeStatus());
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    h.server.setBackgroundTerminals(ROOT, [{ processId: "proc-1", command: "cargo build", cwd: "/owned/worktree" }]);
    await settle(25);
    h.observer.refresh();
    await settle(25);
    assert.equal(h.latest().activeShells, 1);
    assert.equal(h.latest().busy, true);

    h.server.setStatus(ROOT, idleStatus);
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
    await settle(25);
    assert.equal(h.latest().activeShells, 1, "the terminal outlives the turn; Ready must not fake it away");

    // The provider-scoped refresh is armed because work is known to be live.
    h.server.setBackgroundTerminals(ROOT, []);
    await h.scheduler.advance(2_000);
    await h.quiet();
    assert.equal(h.latest().activeShells, 0, "the live finish reaches zero without a poller");
    assert.equal(h.latest().busy, false);
    assert.equal(h.scheduler.pendingTimerCount, 1,
      "the chain stays armed only because owned subagents are still live, not because of a poller");

    // And once the provider reports nothing live anywhere on this row, the
    // chain stops on its own: an idle row generates no refresh traffic.
    h.server.setStatus(CHILD_ACTIVE, idleStatus);
    h.server.setStatus(NESTED, idleStatus);
    await h.scheduler.advance(2_000);
    await h.quiet();
    assert.equal(h.latest().activeTasks, 0);
    assert.equal(h.scheduler.pendingTimerCount, 0, "an idle row arms no further refresh");
    const quiet = h.server.rawInboundFrames.length;
    await h.scheduler.advance(10_000);
    await settle(25);
    assert.equal(h.server.rawInboundFrames.length, quiet, "no traffic at all once the row is known idle");
  } finally {
    await h.close();
  }
});

test("a broadcast burst coalesces into bounded censuses, never a poll storm", async () => {
  const h = await startHarness();
  try {
    const before = h.requests("thread/list");
    for (let index = 0; index < 40; index += 1) {
      h.server.broadcast("thread/status/changed", { threadId: CHILD_ACTIVE, status: { type: "active", activeFlags: [] } });
    }
    await settle();
    await h.scheduler.advance(500);
    await settle();
    const censuses = h.requests("thread/list") - before;
    assert.ok(censuses <= 2, `expected at most one trailing census, saw ${censuses}`);
    assert.equal(h.observer.censusInFlight, false);
  } finally {
    await h.close();
  }
});

test("unrelated threads cannot churn or enter the census", async () => {
  const h = await startHarness();
  try {
    const before = h.server.rawInboundFrames.length;
    h.server.broadcast("thread/status/changed", { threadId: "someone-elses-thread", status: { type: "active", activeFlags: [] } });
    h.server.broadcast("thread/started", {
      thread: { id: "another-else", parentThreadId: null, status: { type: "active", activeFlags: [] } },
    });
    await settle();
    assert.equal(h.server.rawInboundFrames.length, before, "no outbound request for unrelated traffic");
    assert.equal(h.observer.knownDescendantCount, 4, "only the bound lineage is tracked");
    assert.equal(h.server.requests.some((request) => JSON.stringify(request.params).includes("else")), false,
      "an unrelated thread never enters a census request");
  } finally {
    await h.close();
  }
});

test("known values are held while a healthy refresh is in flight", async () => {
  const h = await startHarness({ delayMs: { "thread/list": 60 } });
  try {
    const stable = h.latest();
    assert.equal(stable.activeTasks, 2);

    h.observer.refresh();
    // Mid-census: the row keeps its last good values rather than blanking.
    await settle(20);
    const mid = h.observations[h.observations.length - 1] as NativeStatusObservation;
    assert.equal(mid.activeTasks, 2);
    assert.equal(mid.activeShells, 0);
    assert.equal(mid.busy, false);

    await settle(120);
    assert.equal(h.observations[h.observations.length - 1], mid, "a healthy re-pull publishes nothing new");
  } finally {
    await h.close();
  }
});

test("a failed census withdraws its own axis instead of publishing a partial count", async () => {
  const h = await startHarness();
  try {
    assert.equal(h.latest().activeTasks, 2);
    h.server.failMethod("thread/list", 1);
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, null, "unknown, never a partial number and never zero");
    assert.equal(h.latest().activeShells, null,
      "a failed descendant listing leaves the set of threads that could own a terminal unknown, so the shell axis cannot claim a total either");
    assert.ok(h.diagnostics.includes("tasks-incomplete"));
    assert.ok(h.diagnostics.includes("shells-incomplete"));

    // Recovery: a later complete walk publishes a number again.
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, 2);
  } finally {
    await h.close();
  }
});

/* ------------------------------------- threads leaving mid-census vs faults */

const HELPER = "ephemeral-helper";

/** Every observation published from `index` on, with both counts read. */
function countsSince(h: Harness, index: number): { tasks: number | null; shells: number | null }[] {
  return h.observations.slice(index).map((card) => ({
    tasks: card.activeTasks ?? null,
    shells: card.activeShells ?? null,
  }));
}

test("a loaded helper that ends between the listing and its read keeps the task count", async () => {
  const h = await startHarness();
  try {
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, 0);
    // A concurrent native helper appears in the owned backend, loaded but not
    // persisted, and ends exactly while this census asks about it.
    h.server.setThread({ id: HELPER, parentThreadId: null, status: activeStatus(), ephemeral: true, sourceKind: "cli" });
    h.server.setLoaded(HELPER, true);
    h.server.onRequest = (method, params) => {
      if (method === "thread/read" && params.threadId === HELPER) h.server.removeThread(HELPER);
    };
    const mark = h.observations.length;
    const diagnosticMark = h.diagnostics.length;
    h.observer.refresh();
    await h.quiet();

    assert.ok(h.server.requests.some((request) => request.method === "thread/read" && request.params.threadId === HELPER),
      "the census really asked about the helper");
    for (const card of countsSince(h, mark)) {
      assert.notEqual(card.tasks, null, "an ordinary refresh never blanks bg tasks");
      assert.notEqual(card.shells, null, "an ordinary refresh never blanks bg shells");
    }
    assert.equal(h.latest().activeTasks, 2, "the count stays the complete, truthful owned count");
    assert.equal(h.latest().activeShells, 0);
    assert.deepEqual(h.diagnostics.slice(diagnosticMark), [], "a thread leaving is not a source fault");
  } finally {
    await h.close();
  }
});

test("a refused read of a loaded id that is still loaded withdraws tasks, as does an incomplete recheck", async () => {
  const h = await startHarness();
  try {
    assert.equal(h.latest().activeTasks, 2);
    h.server.setThread({ id: HELPER, parentThreadId: null, status: activeStatus(), ephemeral: true, sourceKind: "cli" });
    h.server.setLoaded(HELPER, true);
    // The provider refuses the read while still listing the thread: genuine.
    h.server.onRequest = (method, params) => (
      method === "thread/read" && params.threadId === HELPER ? "fail" : undefined
    );
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, null, "a genuine failure is unknown, never the old count or a zero");
    assert.equal(h.latest().activeShells, null, "membership never completed, so no shell total either");
    assert.ok(h.diagnostics.includes("tasks-incomplete"));

    // The helper ends, but the fresh listing that would prove it cannot complete.
    let ended = false;
    h.server.onRequest = (method, params) => {
      if (method === "thread/read" && params.threadId === HELPER) {
        h.server.removeThread(HELPER);
        ended = true;
        return undefined;
      }
      return method === "thread/loaded/list" && ended ? "fail" : undefined;
    };
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, null, "an unproved disappearance is still unknown");

    // Once nothing is refused, the complete count returns.
    h.server.onRequest = null;
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, 0);
  } finally {
    await h.close();
  }
});

test("an owned child unloaded before its terminal listing is re-counted, never blanked", async () => {
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
    ],
    loadedIds: [ROOT, CHILD_ACTIVE],
    pageSize: 1,
    backgroundTerminals: {
      [ROOT]: [{ processId: "p-root" }],
      [CHILD_ACTIVE]: [{ processId: "p-child-1" }, { processId: "p-child-2" }],
    },
  });
  try {
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 3);

    // The child's first terminal page lands, then it is unloaded before the
    // next page: the provider rejects that request for an unloaded thread.
    let childPages = 0;
    h.server.onRequest = (method, params) => {
      if (method !== "thread/backgroundTerminals/list" || params.threadId !== CHILD_ACTIVE) return;
      childPages += 1;
      if (childPages === 2) h.server.setLoaded(CHILD_ACTIVE, false);
    };
    const mark = h.observations.length;
    const diagnosticMark = h.diagnostics.length;
    h.observer.refresh();
    await h.quiet();

    assert.equal(childPages, 2, "the child was unloaded mid-listing");
    for (const card of countsSince(h, mark)) {
      assert.notEqual(card.shells, null, "an ordinary refresh never blanks bg shells");
      assert.notEqual(card.tasks, null, "an ordinary refresh never blanks bg tasks");
    }
    // The superseded walk published nothing; its fresh replacement saw the child
    // unloaded from the start, so neither its partial page nor its stale active
    // status is carried.
    assert.equal(h.latest().activeShells, 1, "an unloaded child owns no running terminal");
    assert.equal(h.latest().activeTasks, 0, "and is no longer an active sub-agent");
    assert.deepEqual(h.diagnostics.slice(diagnosticMark), []);

    // A later census agrees.
    h.server.onRequest = null;
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, 0);
    assert.equal(h.latest().activeShells, 1);
  } finally {
    await h.close();
  }
});

test("a refused terminal listing for a child that is still loaded withdraws shells", async () => {
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
    ],
    loadedIds: [ROOT, CHILD_ACTIVE],
    backgroundTerminals: {
      [ROOT]: [{ processId: "p-root" }],
      [CHILD_ACTIVE]: [{ processId: "p-child" }],
    },
  });
  try {
    assert.equal(h.latest().activeShells, 2);
    h.server.onRequest = (method, params) => (
      method === "thread/backgroundTerminals/list" && params.threadId === CHILD_ACTIVE ? "fail" : undefined
    );
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeShells, null, "a genuine refusal is unknown, never the old count or a partial one");
    assert.equal(h.latest().activeTasks, 1, "the task axis keeps its own complete count");
    assert.ok(h.diagnostics.includes("shells-incomplete"));

    h.server.onRequest = null;
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeShells, 2);
  } finally {
    await h.close();
  }
});

test("a departure that shifts a loaded page never publishes a false zero for the thread it hid", async () => {
  // Page size 1 over [root, helper, owned]: removing the helper while it is
  // being read shifts the owned ephemeral child behind the cursor, so the walk
  // that saw the departure never reaches it. That walk must not publish.
  const OWNED_EPHEMERAL = "owned-ephemeral";
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: OWNED_EPHEMERAL, parentThreadId: ROOT, status: activeStatus(), ephemeral: true, sourceKind: "subAgentThreadSpawn" },
    ],
    // The helper's slot precedes the owned child; it exists only once added.
    loadedIds: [ROOT, HELPER, OWNED_EPHEMERAL],
    // Loaded-only: the owned child is not in the persisted listing at all.
    persistedListing: [],
    pageSize: 1,
    backgroundTerminals: { [ROOT]: [], [OWNED_EPHEMERAL]: [{ processId: "p-owned" }] },
  });
  try {
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 1);

    h.server.setThread({ id: HELPER, parentThreadId: null, status: activeStatus(), ephemeral: true, sourceKind: "cli" });
    h.server.onRequest = (method, params) => {
      if (method === "thread/read" && params.threadId === HELPER) h.server.removeThread(HELPER);
    };
    const mark = h.observations.length;
    h.observer.refresh();
    await h.quiet();

    assert.ok(h.server.requests.some((request) => request.method === "thread/read" && request.params.threadId === HELPER));
    for (const card of countsSince(h, mark)) {
      assert.equal(card.tasks, 1, "never zero for an owned child the shrunken page hid, never unknown");
      assert.equal(card.shells, 1, "never zero for its running terminal, never unknown");
    }
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 1);
  } finally {
    await h.close();
  }
});

test("only a provider rejection can be a departure: a malformed page or a timeout stays a fault", async () => {
  const shells = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
    ],
    loadedIds: [ROOT, CHILD_ACTIVE],
    backgroundTerminals: { [ROOT]: [{ processId: "p-root" }], [CHILD_ACTIVE]: [{ processId: "p-child" }] },
  });
  try {
    assert.equal(shells.latest().activeShells, 2);
    // An undecodable terminal page, after which the child really is unloaded.
    shells.server.onRequest = (method, params) => {
      if (method !== "thread/backgroundTerminals/list" || params.threadId !== CHILD_ACTIVE) return undefined;
      shells.server.setLoaded(CHILD_ACTIVE, false);
      return { raw: { data: "not-a-page", nextCursor: null } };
    };
    shells.observer.refresh();
    await shells.quiet();
    assert.equal(shells.latest().activeShells, null, "a malformed page is never laundered into a departure");
    assert.ok(shells.diagnostics.includes("shells-incomplete"));
  } finally {
    await shells.close();
  }

  const tasks = await startHarness({}, { limits: { requestTimeoutMs: 60 } });
  try {
    assert.equal(tasks.latest().activeTasks, 2);
    tasks.server.setThread({ id: HELPER, parentThreadId: null, status: activeStatus(), ephemeral: true, sourceKind: "cli" });
    tasks.server.setLoaded(HELPER, true);
    // The read times out, and the helper really is gone by the time anyone looks.
    tasks.server.onRequest = (method, params) => {
      if (method !== "thread/read" || params.threadId !== HELPER) return undefined;
      tasks.server.removeThread(HELPER);
      return "ignore";
    };
    tasks.observer.refresh();
    await tasks.quiet();
    assert.equal(tasks.latest().activeTasks, null, "a timed-out read is never laundered into a departure");
    assert.ok(tasks.diagnostics.includes("tasks-incomplete"));
  } finally {
    await tasks.close();
  }
});

test("a walk superseded after its tally changed never leaks that tally into a later publication", async () => {
  const h = await startHarness();
  try {
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, 0);
    // A third owned child becomes active, so this walk's task tally is 3...
    h.server.setStatus(CHILD_DONE, activeStatus());
    // ...and while its terminal census is in flight a membership edge arrives,
    // before that census's answer, superseding the walk.
    let edged = false;
    h.server.onRequest = (method) => {
      if (method !== "thread/backgroundTerminals/list" || edged) return;
      edged = true;
      h.server.broadcast("thread/started", {
        thread: { id: "late-child", parentThreadId: ROOT, status: { type: "active", activeFlags: [] } },
      });
    };
    h.observer.refresh();
    await h.quiet();
    assert.equal(edged, true);
    assert.equal(h.scheduler.pendingTimerCount > 0, true, "the trailing census waits on its cooldown");

    // An unrelated caller-side update publishes during that cooldown.
    h.observer.observeAsyncInput("pending");
    assert.equal(h.latest().pendingInput, true);
    assert.equal(h.latest().activeTasks, 2, "the last committed task count, not the superseded tally");
    assert.equal(h.latest().activeShells, 0);

    // The trailing census then commits the real count.
    h.server.onRequest = null;
    await h.scheduler.advance(400);
    await h.quiet();
    assert.equal(h.latest().activeTasks, 3);
  } finally {
    await h.close();
  }
});

test("a source that keeps losing threads under every census is bounded and withdraws", async () => {
  const h = await startHarness();
  try {
    assert.equal(h.latest().activeTasks, 2);
    // Every census meets a fresh helper that ends exactly while it is read.
    let generation = 0;
    const addHelper = (): void => {
      generation += 1;
      const id = `${HELPER}-${generation}`;
      h.server.setThread({ id, parentThreadId: null, status: activeStatus(), ephemeral: true, sourceKind: "cli" });
      h.server.setLoaded(id, true);
    };
    addHelper();
    h.server.onRequest = (method, params) => {
      const id = String(params.threadId ?? "");
      if (method === "thread/read" && id.startsWith(`${HELPER}-`)) {
        h.server.removeThread(id);
        addHelper();
      }
    };
    const reads = (): number => h.server.requests.filter(
      (request) => request.method === "thread/read" && String(request.params.threadId).startsWith(`${HELPER}-`),
    ).length;
    h.observer.refresh();
    await h.quiet();
    assert.equal(reads(), NATIVE_CODEX_RPC_MAX_DEPARTURE_RESTARTS + 1,
      "the original census plus the bounded fresh restarts, then no more");
    assert.equal(h.latest().activeTasks, null, "a census that can never settle membership is unknown, not stale");
    assert.ok(h.diagnostics.includes("tasks-incomplete"));

    // Once the source settles, the next ordinary census counts again.
    h.server.onRequest = null;
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, 2);
  } finally {
    await h.close();
  }
});

test("a workspace contradiction is published even when a helper departure supersedes its walk", async () => {
  const h = await startHarness({}, { expectedWorkspace: "/owned/worktree" });
  try {
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, 0);
    h.server.setThread({ id: HELPER, parentThreadId: null, status: activeStatus(), ephemeral: true, sourceKind: "cli" });
    h.server.setLoaded(HELPER, true);
    // This census reads the root in another workspace; the helper then ends
    // while being read, and by the replacement census the root matches again.
    let contradicted = false;
    h.server.onRequest = (method, params) => {
      if (method !== "thread/read") return;
      if (params.threadId === ROOT && !contradicted) {
        contradicted = true;
        h.server.setThread({ ...POPULATION[0]!, cwd: "/owned/elsewhere" });
      } else if (params.threadId === HELPER) {
        h.server.removeThread(HELPER);
        h.server.setThread({ ...POPULATION[0]! });
      }
    };
    const mark = h.observations.length;
    h.observer.refresh();
    await h.quiet();

    assert.ok(h.diagnostics.includes("root-workspace-unverified"));
    const withdrawal = h.observations.slice(mark).find((card) => card.activeTasks === null);
    assert.ok(withdrawal !== undefined, "the contradiction's unknown reached the row");
    assert.equal(withdrawal.activeShells, null);
    assert.equal(withdrawal.busy, null);
    assert.equal(withdrawal.pendingInput, null);
    // The replacement census revalidated the root and committed fresh counts.
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, 0);
  } finally {
    await h.close();
  }
});

test("an unreadable root still withdraws shells when a helper departure supersedes its walk", async () => {
  const h = await startHarness();
  try {
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, 0);
    h.server.setThread({ id: HELPER, parentThreadId: null, status: activeStatus(), ephemeral: true, sourceKind: "cli" });
    h.server.setLoaded(HELPER, true);
    let unreadOnce = false;
    h.server.onRequest = (method, params) => {
      if (method !== "thread/read") return;
      if (params.threadId === ROOT && !unreadOnce) {
        unreadOnce = true;
        h.server.unreadable.add(ROOT);
      } else if (params.threadId === HELPER) {
        h.server.removeThread(HELPER);
        h.server.unreadable.delete(ROOT);
      }
    };
    const mark = h.observations.length;
    h.observer.refresh();
    await h.quiet();

    assert.ok(h.diagnostics.includes("root-read-failed"));
    const unavailable = h.observations.slice(mark).find((card) => card.activeShells === null);
    assert.ok(unavailable !== undefined, "the unreadable root's shell unknown reached the row");
    assert.equal(unavailable.activeTasks, 2, "the last proven task count is kept: an unreadable root revokes nothing");
    assert.equal(unavailable.busy, null);
    // The replacement census read the root and counts both axes again.
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, 0);
    assert.equal(h.latest().busy, false);
  } finally {
    await h.close();
  }
});

test("a child that departs during every terminal listing withdraws both axes at the retry bound", async () => {
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
    ],
    loadedIds: [ROOT, CHILD_ACTIVE],
    backgroundTerminals: { [ROOT]: [{ processId: "p-root" }], [CHILD_ACTIVE]: [{ processId: "p-child" }] },
  });
  try {
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 2);
    // Present (and active) for every task enumeration, gone at its terminal listing.
    let childListings = 0;
    h.server.onRequest = (method, params) => {
      if (method === "thread/read" && params.threadId === ROOT) h.server.setLoaded(CHILD_ACTIVE, true);
      if (method === "thread/backgroundTerminals/list" && params.threadId === CHILD_ACTIVE) {
        childListings += 1;
        h.server.setLoaded(CHILD_ACTIVE, false);
      }
    };
    const mark = h.observations.length;
    h.observer.refresh();
    await h.quiet();

    assert.equal(childListings, NATIVE_CODEX_RPC_MAX_DEPARTURE_RESTARTS + 1);
    for (const card of countsSince(h, mark).slice(0, -1)) {
      assert.equal(card.tasks, 1, "retries hold the last proven count");
    }
    assert.equal(h.latest().activeTasks, null, "a tally including a child proved gone is not published");
    assert.equal(h.latest().activeShells, null);
    assert.ok(h.diagnostics.includes("tasks-incomplete"));
    assert.ok(h.diagnostics.includes("shells-incomplete"));

    // A stable census recovers both axes.
    h.server.onRequest = null;
    h.server.setLoaded(CHILD_ACTIVE, true);
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 2);
  } finally {
    await h.close();
  }
});

test("a tally collected under a contradicted workspace never surfaces after revalidation", async () => {
  const h = await startHarness({}, { expectedWorkspace: "/owned/worktree", limits: { requestTimeoutMs: 800 } });
  try {
    assert.equal(h.latest().activeTasks, 2);
    // A complete census of the root in another workspace: unknown card.
    h.server.setThread({ ...POPULATION[0]!, cwd: "/owned/elsewhere" });
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, null);
    assert.equal(h.latest().activeShells, null);

    // The workspace matches again; the revalidating census is superseded by a
    // membership edge during its terminal collection, before it commits.
    h.server.setThread({ ...POPULATION[0]! });
    let edged = false;
    h.server.onRequest = (method) => {
      if (method !== "thread/backgroundTerminals/list" || edged) return;
      edged = true;
      h.server.broadcast("thread/started", {
        thread: { id: "late-child", parentThreadId: ROOT, status: { type: "active", activeFlags: [] } },
      });
    };
    h.observer.refresh();
    await h.quiet();
    assert.equal(edged, true);

    // A caller-side update during the cooldown publishes the revalidated root,
    // but no count from the contradicted census may ride along.
    h.observer.observeAsyncInput("pending");
    assert.equal(h.latest().pendingInput, true);
    assert.equal(h.latest().busy, false, "the revalidated root is visible");
    assert.equal(h.latest().activeTasks, null, "no tally from an unproved workspace");
    assert.equal(h.latest().activeShells, null);

    // That card is already on the row, so the next census holds nothing back:
    // a fresh close of the bound root, while that census's unrelated terminal
    // query is held, withdraws the visible Ready at once.
    const hold = holdFirst(h.server, "thread/backgroundTerminals/list");
    await h.scheduler.advance(400);
    await waitUntil(hold.held);
    assert.equal(hold.held(), true, "the replacement census reached its terminal query");
    const closeMark = h.observations.length;
    h.server.broadcast("thread/closed", { threadId: ROOT });
    await waitUntil(() => h.observations.length > closeMark, 300);
    assert.equal(h.observer.censusInFlight, true, "withdrawn before the held query resolves");
    assert.equal(h.latest().busy, null, "the closed root's foreground is unknown");
    assert.equal(h.latest().activeTasks, null, "both counts stay unknown");
    assert.equal(h.latest().activeShells, null);
    await h.quiet();

    // Only a validated census that completes commits counts again.
    h.server.onRequest = null;
    await h.scheduler.advance(400);
    await h.quiet();
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, 0);
  } finally {
    await h.close();
  }
});

test("a later shell fault never skips the recheck that keeps a still-loaded active child's task count", async () => {
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
      { id: CHILD_DONE, parentThreadId: ROOT, status: idleStatus, sourceKind: "subAgentThreadSpawn" },
    ],
    loadedIds: [ROOT, CHILD_ACTIVE, CHILD_DONE],
    backgroundTerminals: { [ROOT]: [{ processId: "p-root" }], [CHILD_ACTIVE]: [{ processId: "p-active" }] },
  });
  try {
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 2);
    // The active child's terminal request is refused while it stays loaded; the
    // idle child's terminal page that follows is undecodable (a hard fault).
    const order: string[] = [];
    h.server.onRequest = (method, params) => {
      if (method === "thread/backgroundTerminals/list" && params.threadId === CHILD_ACTIVE) {
        order.push("refused-active");
        return "fail";
      }
      if (method === "thread/backgroundTerminals/list" && params.threadId === CHILD_DONE) {
        order.push("malformed-idle");
        return { raw: { data: "not-a-page", nextCursor: null } };
      }
      if (method === "thread/loaded/list" && order.includes("malformed-idle")) order.push("recheck");
      return undefined;
    };
    const mark = h.diagnostics.length;
    h.observer.refresh();
    await h.quiet();
    assert.deepEqual(order, ["refused-active", "malformed-idle", "recheck"],
      "the loaded-list recheck still runs after the independent shell fault");
    assert.equal(h.latest().activeShells, null, "the shell fault keeps the total unavailable");
    assert.equal(h.latest().activeTasks, 1, "the recheck confirmed the active child, so its tally stands");
    assert.ok(h.diagnostics.slice(mark).includes("shells-incomplete"));
    assert.equal(h.diagnostics.slice(mark).includes("tasks-incomplete"), false);
  } finally {
    await h.close();
  }
});

test("an idle child's departure never withdraws an intact task count, with or without the retry bound", async () => {
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
      { id: CHILD_DONE, parentThreadId: ROOT, status: idleStatus, sourceKind: "subAgentThreadSpawn" },
    ],
    loadedIds: [ROOT, CHILD_ACTIVE, CHILD_DONE],
    backgroundTerminals: { [ROOT]: [{ processId: "p-root" }], [CHILD_ACTIVE]: [{ processId: "p-active" }] },
  });
  try {
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 2);

    // The idle child unloads at its terminal query while the active child is
    // refused but confirmed still loaded.
    h.server.onRequest = (method, params) => {
      if (method !== "thread/backgroundTerminals/list") return undefined;
      if (params.threadId === CHILD_DONE) {
        h.server.setLoaded(CHILD_DONE, false);
        return undefined;
      }
      return params.threadId === CHILD_ACTIVE ? "fail" : undefined;
    };
    let mark = h.diagnostics.length;
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeShells, null, "the still-loaded refusal is a real shell fault");
    assert.equal(h.latest().activeTasks, 1, "the departed child was idle: the active tally is intact");
    assert.equal(h.diagnostics.slice(mark).includes("tasks-incomplete"), false);

    // Idle-only churn on every attempt reaches the retry bound: shells only.
    let idleListings = 0;
    h.server.onRequest = (method, params) => {
      if (method === "thread/read" && params.threadId === ROOT) h.server.setLoaded(CHILD_DONE, true);
      if (method === "thread/backgroundTerminals/list" && params.threadId === CHILD_DONE) {
        idleListings += 1;
        h.server.setLoaded(CHILD_DONE, false);
      }
    };
    mark = h.diagnostics.length;
    h.observer.refresh();
    await h.quiet();
    assert.equal(idleListings, NATIVE_CODEX_RPC_MAX_DEPARTURE_RESTARTS + 1);
    assert.equal(h.latest().activeShells, null);
    assert.equal(h.latest().activeTasks, 1, "a spent bound over idle churn keeps the active tally");
    assert.equal(h.diagnostics.slice(mark).includes("tasks-incomplete"), false);
  } finally {
    await h.close();
  }
});

test("a deleted bound root withdraws the counts even when a departure retry is under way", async () => {
  const h = await startHarness();
  try {
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, 0);
    h.server.setThread({ id: HELPER, parentThreadId: null, status: activeStatus(), ephemeral: true, sourceKind: "cli" });
    h.server.setLoaded(HELPER, true);
    // After this census has read the live root, the helper ends while being read
    // and the bound root is deleted; the provider can no longer read it.
    let deleted = false;
    h.server.onRequest = (method, params) => {
      if (method !== "thread/read") return undefined;
      if (params.threadId === HELPER && !deleted) {
        deleted = true;
        h.server.removeThread(HELPER);
        h.server.broadcast("thread/deleted", { threadId: ROOT });
        return undefined;
      }
      return params.threadId === ROOT && deleted ? "fail" : undefined;
    };
    const mark = h.observations.length;
    h.observer.refresh();
    await h.quiet();
    // Let the trailing and provider-scoped censuses run as well.
    await h.scheduler.advance(2_000);
    await h.quiet();
    await h.scheduler.advance(2_000);
    await h.quiet();

    assert.equal(deleted, true);
    const since = h.observations.slice(mark);
    assert.ok(since.length > 0, "the deletion reached the row");
    for (const card of since) {
      assert.equal(card.activeTasks, null, "neither the old task count nor a zero after the root is deleted");
      assert.equal(card.activeShells, null, "neither the old shell count nor a zero after the root is deleted");
    }
    assert.equal(h.latest().busy, null);
  } finally {
    await h.close();
  }
});

test("an active child unloaded at its terminal query with a refused recheck withdraws both axes", async () => {
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
    ],
    loadedIds: [ROOT, CHILD_ACTIVE],
    backgroundTerminals: { [ROOT]: [{ processId: "p-root" }], [CHILD_ACTIVE]: [{ processId: "p-child" }] },
  });
  try {
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 2);
    // The active child is unloaded at its terminal query (rejected), and the
    // follow-up loaded listing that would resolve it is refused too.
    let unloaded = false;
    h.server.onRequest = (method, params) => {
      if (method === "thread/backgroundTerminals/list" && params.threadId === CHILD_ACTIVE) {
        unloaded = true;
        h.server.setLoaded(CHILD_ACTIVE, false);
        return undefined;
      }
      return method === "thread/loaded/list" && unloaded ? "fail" : undefined;
    };
    const diagnosticMark = h.diagnostics.length;
    h.observer.refresh();
    await h.quiet();
    assert.equal(unloaded, true);
    assert.equal(h.latest().activeShells, null, "the shell census could not complete");
    assert.equal(h.latest().activeTasks, null, "an unresolved active child cannot stay in the tally");
    assert.ok(h.diagnostics.slice(diagnosticMark).includes("shells-incomplete"));
    assert.ok(h.diagnostics.slice(diagnosticMark).includes("tasks-incomplete"));

    // A refusal the recheck positively finds still loaded stays shells-only.
    h.server.setLoaded(CHILD_ACTIVE, true);
    h.server.onRequest = null;
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 2);
    h.server.onRequest = (method, params) => (
      method === "thread/backgroundTerminals/list" && params.threadId === CHILD_ACTIVE ? "fail" : undefined
    );
    const stillLoadedMark = h.diagnostics.length;
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeShells, null);
    assert.equal(h.latest().activeTasks, 1, "a refusal confirmed still loaded keeps the task count");
    assert.equal(h.diagnostics.slice(stillLoadedMark).includes("tasks-incomplete"), false);
  } finally {
    await h.close();
  }
});

test("a departed child beside a still-loaded refused child withdraws both axes", async () => {
  const CHILD_TWO = "child-two";
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
      { id: CHILD_TWO, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
    ],
    loadedIds: [ROOT, CHILD_ACTIVE, CHILD_TWO],
    backgroundTerminals: {
      [ROOT]: [{ processId: "p-root" }],
      [CHILD_ACTIVE]: [{ processId: "p-one" }],
      [CHILD_TWO]: [{ processId: "p-two" }],
    },
  });
  try {
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, 3);
    // One child is unloaded at its terminal request; the other is refused while
    // staying loaded.
    h.server.onRequest = (method, params) => {
      if (method !== "thread/backgroundTerminals/list") return undefined;
      if (params.threadId === CHILD_ACTIVE) {
        h.server.setLoaded(CHILD_ACTIVE, false);
        return undefined;
      }
      return params.threadId === CHILD_TWO ? "fail" : undefined;
    };
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeShells, null, "the still-loaded refusal is a real shell fault");
    assert.equal(h.latest().activeTasks, null, "the departed child cannot stay in the published tally");
    assert.ok(h.diagnostics.includes("shells-incomplete"));
    assert.ok(h.diagnostics.includes("tasks-incomplete"));

    h.server.onRequest = null;
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 2);
  } finally {
    await h.close();
  }
});

test("a persisted but unloaded child never blocks a complete shell count", async () => {
  // The provider resolves background terminals against its IN-MEMORY threads and
  // rejects an unloaded id, so a historical child must simply be out of scope
  // rather than failing the row's whole shell axis forever.
  const h = await startHarness({
    backgroundTerminals: {
      [ROOT]: [{ processId: "p-root" }],
      [CHILD_ACTIVE]: [{ processId: "p-child" }],
    },
  });
  try {
    const card = h.latest();
    assert.equal(card.activeTasks, 2);
    assert.equal(card.activeShells, 2, "the count is complete although an owned child is not loaded");
    const queried = h.server.requests
      .filter((request) => request.method === "thread/backgroundTerminals/list")
      .map((request) => String((request.params as { threadId?: string }).threadId));
    assert.ok(queried.includes(ROOT));
    assert.ok(queried.includes(CHILD_ACTIVE));
    assert.equal(queried.includes(CHILD_PERSISTED), false,
      "an unloaded thread is never asked about: it cannot own a running terminal, and asking would fail the axis");
    assert.equal(h.diagnostics.includes("shells-incomplete"), false);
  } finally {
    await h.close();
  }
});

test("a membership failure withdraws the shell axis instead of finalizing it", async () => {
  // An owned child owns a running shell. When the descendant listing fails, the
  // threads that could hold a terminal are unknown, so no shell number is a
  // total — not on the first census, and not on a later one either.
  const h = await startHarness({
    failCalls: { "thread/list": 1 },
    backgroundTerminals: { [CHILD_ACTIVE]: [{ processId: "p-child" }] },
  });
  try {
    const first = h.latest();
    assert.equal(first.activeTasks, null);
    assert.equal(first.activeShells, null, "a first census that never proved membership cannot publish an empty-scope zero");
    assert.ok(h.diagnostics.includes("shells-incomplete"));

    // Recovery proves the real count...
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, 1);

    // ...and a later membership failure withdraws it again, rather than counting
    // over whatever descendant set happened to survive.
    h.server.failMethod("thread/list", 1);
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, null);
    assert.equal(h.latest().activeShells, null,
      "keeping the previous scope is not completeness once a membership read failed");
  } finally {
    await h.close();
  }
});

test("an unreadable or misidentified loaded child is never cached as unrelated", async () => {
  // The persisted listing is empty, so the owned child can only be found through
  // the loaded set — and its metadata cannot be decoded at all.
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
    ],
    loadedIds: [ROOT, CHILD_ACTIVE],
    rawResults: { "thread/list": { data: [], nextCursor: null } },
    unreadableThreadIds: [CHILD_ACTIVE],
  });
  try {
    assert.equal(h.latest().activeTasks, null, "an undecodable read proves nothing, so no count is published");
    assert.equal(h.latest().activeShells, null, "and the shell axis cannot be scoped over it either");
    assert.ok(h.diagnostics.includes("tasks-incomplete"));

    // The failed read must not have been remembered as unrelated: once the
    // metadata decodes, an ordinary healthy census counts the child.
    h.server.unreadable.delete(CHILD_ACTIVE);
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, 1, "the child is still eligible after a previously unreadable read");
    assert.equal(h.latest().activeShells, 0, "and the shell axis completes again");

    // A decodable row naming a DIFFERENT thread is rejected the same way, and is
    // equally not evidence of anything about this id.
    h.server.mismatched.add(CHILD_ACTIVE);
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, null, "an identity mismatch is not a negative ownership answer");
    assert.equal(h.latest().activeShells, null);

    h.server.mismatched.delete(CHILD_ACTIVE);
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, 1, "and the census recovers once the identity matches again");
  } finally {
    await h.close();
  }
});

test("an unreadable parent during ancestry resolution degrades instead of dismissing the chain", async () => {
  // Only the grandchild is listed, so proving its ancestry must read the
  // intermediate parent — and that read comes back undecodable.
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
      { id: NESTED, parentThreadId: CHILD_ACTIVE, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
    ],
    loadedIds: [ROOT, NESTED],
    persistedListing: [NESTED],
    unreadableThreadIds: [CHILD_ACTIVE],
  });
  try {
    assert.equal(h.latest().activeTasks, null, "an unreadable ancestor cannot settle the chain either way");
    assert.equal(h.latest().activeShells, null);
    assert.ok(h.diagnostics.includes("tasks-incomplete"));

    h.server.unreadable.delete(CHILD_ACTIVE);
    h.observer.refresh();
    await h.quiet();
    assert.equal(h.latest().activeTasks, 1,
      "the grandchild counts once its ancestry can actually be proved");
    assert.equal(h.latest().activeShells, 0);
  } finally {
    await h.close();
  }
});

test("positive tasks keep the recovery chain alive while the shell axis is unknown", async () => {
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
    ],
    loadedIds: [ROOT, CHILD_ACTIVE],
    backgroundTerminals: { [ROOT]: [{ processId: "p-root" }] },
  });
  try {
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 1);

    // Two consecutive terminal-read failures bracket the child finishing.
    h.server.failMethod("thread/backgroundTerminals/list", 2);
    await h.scheduler.advance(2_000);
    await h.quiet();
    assert.equal(h.latest().activeShells, null);
    assert.equal(h.latest().activeTasks, 1, "the task axis is unaffected by the shell failure");

    // The owned child finishes, with no broadcast at all.
    h.server.setStatus(CHILD_ACTIVE, idleStatus);
    await h.scheduler.advance(2_000);
    await h.quiet();
    assert.equal(h.latest().activeTasks, 0);
    assert.equal(h.latest().activeShells, null, "the second failure still withdraws");
    assert.equal(h.scheduler.pendingTimerCount, 1,
      "positively seen live work is work even while another axis is unknown");

    // The next scheduled census resolves the shell axis with no manual refresh.
    // The terminal itself finished in the meantime, which is what the row has to
    // discover for itself.
    h.server.setBackgroundTerminals(ROOT, []);
    await h.scheduler.advance(2_000);
    await h.quiet();
    assert.equal(h.latest().activeShells, 0);
    // ...and only a census that positively saw everything idle retires the chain.
    assert.equal(h.scheduler.pendingTimerCount, 0);
  } finally {
    await h.close();
  }
});

test("a rebind that recovers cancels the superseded reconnect attempt", async () => {
  const server = new FakeCodexAppServer({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
    ],
    requireAuthorization: "lease-token",
    failCalls: { initialize: 1 },
  });
  const port = await server.listenLoopback();
  const scheduler = new FakeScheduler();
  const observations: NativeStatusObservation[] = [];
  const observer = new NativeCodexRpcStatusObserver({
    endpoint: {
      kind: "loopback-ws",
      host: "127.0.0.1",
      port,
      authorization: { scheme: "bearer", token: () => "lease-token" },
    },
    rootThreadId: ROOT,
    generation: "gen-1",
    expectedCodexHome: "/owned/codex-home",
    // These suites state a positively empty async question queue; the input
    // axis needs that knowledge before it can be a positive none.
    asyncInput: "none",
    scheduler,
    onObservation: (observation) => observations.push(observation),
  });
  try {
    await assert.rejects(observer.start(), () => true);
    assert.equal(observer.connected, false);

    // A backoff attempt is scheduled; recover deliberately before it can fire.
    await observer.rebind({ generation: "gen-2" });
    assert.equal(observer.connected, true);
    assert.equal(server.upgradeCount, 2, "the failed attempt and its replacement");

    // Far beyond the old backoff: the superseded attempt must never dial again.
    await scheduler.advance(20_000);
    await settle(25);
    assert.equal(server.upgradeCount, 2, "a stale timer must not replace a live transport");
    assert.equal(server.connectionCount, 1, "exactly one WebSocket is open");
    assert.equal(observer.connected, true);

    observer.dispose();
    await settle(25);
    assert.equal(server.connectionCount, 0, "disposal reaches the one live connection");
  } finally {
    observer.dispose();
    await server.stop();
  }
});

test("an unusable cursor withdraws the aggregate instead of finalizing a truncated count", async () => {
  // A page cursor the client cannot read is never a signal that pagination ended.
  const persisted = await startHarness({
    rawResults: { "thread/list": { data: [], nextCursor: 7 } },
    backgroundTerminals: { [CHILD_ACTIVE]: [{ processId: "p-child" }] },
  });
  try {
    assert.equal(persisted.latest().activeTasks, null, "an unreadable cursor never ends the walk");
    assert.equal(persisted.latest().activeShells, null, "and no shell total is claimed over an unfinished walk");
    assert.ok(persisted.diagnostics.includes("tasks-incomplete"));
    assert.ok(persisted.diagnostics.includes("shells-incomplete"));
  } finally {
    await persisted.close();
  }

  const loaded = await startHarness({
    rawResults: { "thread/loaded/list": { data: [], nextCursor: false } },
  });
  try {
    assert.equal(loaded.latest().activeTasks, null, "an unreadable loaded-page cursor fails the census too");
  } finally {
    await loaded.close();
  }

  const terminals = await startHarness({
    backgroundTerminals: { [ROOT]: [{ processId: "p-root" }] },
    rawResults: { "thread/backgroundTerminals/list": { data: [], nextCursor: "x".repeat(10_000) } },
  });
  try {
    assert.equal(terminals.latest().activeShells, null, "an unreadable terminal cursor never publishes a count");
    assert.ok(terminals.diagnostics.includes("shells-incomplete"));
    assert.equal(terminals.latest().activeTasks, 2, "the task axis is independent and stays real");
  } finally {
    await terminals.close();
  }
});

test("one transient shell-read failure cannot strand the shell axis unknown", async () => {
  // An idle root, no subagents, one live background terminal: the shell is the
  // only work on this row, and the observer receives no terminal-completion
  // subscription, so recovery has to keep its own bounded witness.
  const h = await startHarness({
    threads: [{ id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" }],
    loadedIds: [ROOT],
    backgroundTerminals: { [ROOT]: [{ processId: "p-root" }] },
  });
  try {
    assert.equal(h.latest().activeTasks, 0);
    assert.equal(h.latest().activeShells, 1);

    // One failed terminal read withdraws the axis...
    h.server.failMethod("thread/backgroundTerminals/list", 1);
    await h.scheduler.advance(2_000);
    await h.quiet();
    assert.equal(h.latest().activeShells, null);
    assert.ok(h.diagnostics.includes("shells-incomplete"));

    // ...and the provider-scoped refresh recovers it with no root notification
    // and no manual refresh: a withdrawn value is not evidence of no work.
    await h.scheduler.advance(2_000);
    await h.quiet();
    assert.equal(h.latest().activeShells, 1, "the transient failure resolves on its own");

    // When the terminal really finishes, a COMPLETE read retires the witness and
    // the row goes quiet instead of polling forever.
    h.server.setBackgroundTerminals(ROOT, []);
    await h.scheduler.advance(2_000);
    await h.quiet();
    assert.equal(h.latest().activeShells, 0);
    assert.equal(h.scheduler.pendingTimerCount, 0, "the recovery chain ends once the work is positively resolved");
  } finally {
    await h.close();
  }
});

function h_requests(server: FakeCodexAppServer, method: string): number {
  return server.requests.filter((request) => request.method === method).length;
}

test("rebinding while a connect is pending establishes the replacement, not the retired attempt", async () => {
  const server = new FakeCodexAppServer({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
    ],
    requireAuthorization: "lease-token",
    delayMs: { initialize: 400 },
  });
  const port = await server.listenLoopback();
  const scheduler = new FakeScheduler();
  const observations: NativeStatusObservation[] = [];
  const observer = new NativeCodexRpcStatusObserver({
    endpoint: {
      kind: "loopback-ws",
      host: "127.0.0.1",
      port,
      authorization: { scheme: "bearer", token: () => "lease-token" },
    },
    rootThreadId: ROOT,
    generation: "gen-1",
    expectedCodexHome: "/owned/codex-home",
    // These suites state a positively empty async question queue; the input
    // axis needs that knowledge before it can be a positive none.
    asyncInput: "none",
    scheduler,
    onObservation: (observation) => observations.push(observation),
  });
  try {
    const starting = observer.start();
    // The retired attempt is expected to reject once it is invalidated.
    void starting.catch(() => undefined);
    await settle(20);
    assert.equal(observations.length, 0, "nothing publishes before a handshake completes");

    await observer.rebind({ generation: "gen-2" });

    assert.equal(observer.connected, true, "the replacement connection is the one that comes up");
    assert.equal(observer.generation, "gen-2");
    assert.equal(observer.rootThreadId, ROOT);
    const card = observations[observations.length - 1] as NativeStatusObservation;
    assert.equal(card.activeTasks, 1, "the replacement binding's census publishes");
    assert.equal(card.activeShells, 0);
    // Exactly two upgrades: the retired attempt and its replacement. A fenced-off
    // retired attempt that also scheduled recovery would show up here as a third.
    assert.equal(server.upgradeCount, 2, "the retired attempt does not start a second recovery chain");
    // One timer remains, and it is the legitimate armed refresh for the live
    // child: advancing it censuses again rather than reconnecting.
    assert.equal(scheduler.pendingTimerCount, 1);
    const censusesBefore = h_requests(server, "thread/list");
    await scheduler.advance(2_000);
    await settle(25);
    assert.ok(h_requests(server, "thread/list") > censusesBefore, "the armed refresh re-censuses the live child");
    assert.equal(observer.connected, true);
    assert.equal(server.upgradeCount, 2, "and it is a census, not a reconnect");
  } finally {
    observer.dispose();
    await server.stop();
  }
});

test("pages are followed and rows deduped before any number is published", async () => {
  const h = await startHarness({ pageSize: 1 });
  try {
    // With a page cap of 1, every listing must be followed to exhaustion.
    assert.equal(h.latest().activeTasks, 2);
    assert.ok(h.requests("thread/list") >= 4, "the ancestor query follows every page");
    assert.ok(h.requests("thread/loaded/list") >= 6);
    assert.ok(h.requests("thread/backgroundTerminals/list") >= 1);

    // A page cap that never terminates is a budget failure, not a zero.
    h.server.failMethod("thread/loaded/list", 0);
    const last = h.latest();
    assert.equal(last.activeTasks, 2);
  } finally {
    await h.close();
  }
});

test("a census with a tiny slice budget still completes the whole walk", async () => {
  // One row per page and two pages per slice: the census needs several slices,
  // and every one of them is ordinary work, never a degraded value.
  const h = await startHarness({ pageSize: 1 }, { limits: { maxCensusPages: 2 } });
  try {
    const card = h.latest();
    assert.equal(card.activeTasks, 2, "a slice budget is not a census ceiling");
    assert.equal(card.activeShells, 0, "and the shell scope is still walked in full");
    assert.equal(card.busy, false);
    assert.deepEqual(h.diagnostics, [], "suspension is not a diagnostic and never a degraded value");
    assert.ok(h.requests("thread/list") >= 4, "every page was followed, across slices");
  } finally {
    await h.close();
  }
});

/* -------------------------------------------------- census size and slices */

const IDLE_CHILD_COUNT = 17;
const IDLE_CHILDREN: readonly string[] = Array.from(
  { length: IDLE_CHILD_COUNT },
  (_unused, index) => `idle-child-${index}`,
);
const HISTORY_COUNT = 420;

function idleChildren(parentId: string, ids: readonly string[]): FakeThread[] {
  return ids.map((id) => ({
    id,
    parentThreadId: parentId,
    status: idleStatus,
    sourceKind: "subAgentThreadSpawn" as const,
  }));
}

test("more loaded owned threads than one slice affords still report a complete card", async () => {
  // Seventeen finished-but-loaded children plus the root is eighteen live
  // threads: more than the old shell-census bound, and a perfectly healthy row.
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      ...idleChildren(ROOT, IDLE_CHILDREN),
    ],
    loadedIds: [ROOT, ...IDLE_CHILDREN],
    backgroundTerminals: { [ROOT]: [] },
  });
  try {
    const card = h.latest();
    assert.equal(card.activeTasks, 0, "completed-but-loaded children never count");
    assert.equal(card.activeShells, 0, "every live thread was still asked");
    assert.equal(card.busy, false, "Ready stays known, not unknown");
    assert.deepEqual(card.activity, [NATIVE_CODEX_RPC_ACTIVITY_READY]);
    assert.deepEqual(h.diagnostics, [], "population size is not a failure");

    const queried = new Set(h.server.requests
      .filter((request) => request.method === "thread/backgroundTerminals/list")
      .map((request) => String((request.params as { threadId?: string }).threadId)));
    assert.equal(queried.size, IDLE_CHILD_COUNT + 1, "root plus every loaded owned thread");
    assert.equal(queried.has(IDLE_CHILDREN[IDLE_CHILD_COUNT - 1] as string), true,
      "the walk continues past the slice bound instead of stopping at it");

    // An idle child owns a real background terminal. Nothing is counted as a
    // task and the root is Ready, so only a complete scope can report the one.
    h.server.setBackgroundTerminals(IDLE_CHILDREN[5] as string, [{ processId: "p-idle" }]);
    h.observer.refresh();
    await settle(30);
    const withShell = h.latest();
    assert.equal(withShell.activeTasks, 0);
    assert.equal(withShell.activeShells, 1, "an idle child's running shell is never dropped");
    assert.equal(withShell.busy, false, "a background shell never makes the root run");
    assert.deepEqual(withShell.activity, [NATIVE_CODEX_RPC_ACTIVITY_READY]);
  } finally {
    await h.close();
  }
});

test("hundreds of historical persisted children still yield a complete census", async () => {
  // Ordinary persisted history: every one of these is unloaded, so none of them
  // counts as a task and none can own a terminal, but the provider's listing
  // still has to be walked to know that.
  const history = idleChildren(ROOT, Array.from({ length: HISTORY_COUNT }, (_unused, index) => `hist-${index}`));
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: CHILD_ACTIVE, parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
      ...history,
    ],
    loadedIds: [ROOT, CHILD_ACTIVE],
    pageSize: 50,
    backgroundTerminals: { [ROOT]: [], [CHILD_ACTIVE]: [{ processId: "p-child" }] },
  });
  try {
    const card = h.latest();
    assert.equal(card.activeTasks, 1, "only the live owned child counts");
    assert.equal(card.activeShells, 1, "the shell census is complete over the live scope");
    assert.equal(card.busy, false, "owned work never holds the root's foreground running");
    assert.equal(card.pendingInput, false);
    assert.deepEqual(h.diagnostics, [], "history size is not a budget failure");
    assert.equal(h.requests("thread/list"), Math.ceil((HISTORY_COUNT + 1) / 50),
      "every page exactly once: past the old eight-page ceiling, with no re-walk");
  } finally {
    await h.close();
  }
});

test("a deeper owned lineage is proved, not budgeted away", async () => {
  const chain = ["nested-1", "nested-2", "nested-3", "nested-4", "nested-5", "nested-6"];
  const threads: FakeThread[] = [{ id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" }];
  let parent = ROOT;
  for (const id of chain) {
    // Each level legitimately runs in its own worktree, so no cwd may filter it.
    threads.push({ id, parentThreadId: parent, status: idleStatus, sourceKind: "subAgentThreadSpawn", cwd: `/owned/${id}` });
    parent = id;
  }
  const h = await startHarness({
    threads,
    loadedIds: [ROOT, ...chain],
    // Only the deepest thread is listed, so every ancestor has to be read.
    persistedListing: [chain[chain.length - 1] as string],
  });
  try {
    assert.equal(h.latest().activeTasks, 0);
    assert.ok(h.requests("thread/read") >= chain.length, "the ancestry bridges were read, not assumed");

    h.server.setStatus(chain[chain.length - 1] as string, activeStatus());
    h.server.broadcast("thread/status/changed", {
      threadId: chain[chain.length - 1] as string,
      status: { type: "active", activeFlags: [] },
    });
    await settle(30);
    await h.quiet();
    assert.equal(h.latest().activeTasks, 1,
      "an owned descendant six hops down is still this row's subagent");
    assert.deepEqual(h.diagnostics, []);
  } finally {
    await h.close();
  }
});

test("a suspended slice never skips the loaded thread it stopped on", async () => {
  // Both children are ephemeral, so each one costs a metadata read, and the
  // slice budget affords exactly one read. The second child is the boundary.
  const h = await startHarness(
    {
      threads: [
        { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
        { id: "ephemeral-a", parentThreadId: ROOT, status: idleStatus, sourceKind: "subAgentThreadSpawn" },
        { id: "ephemeral-b", parentThreadId: ROOT, status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
      ],
      loadedIds: [ROOT, "ephemeral-a", "ephemeral-b"],
      persistedListing: [],
      backgroundTerminals: { ["ephemeral-b"]: [{ processId: "p-boundary" }] },
    },
    { limits: { maxDescendantReads: 1 } },
  );
  try {
    const card = h.latest();
    assert.equal(card.activeTasks, 1, "the child the walk suspended on is still counted");
    assert.equal(card.activeShells, 1, "and its running shell is inside the complete scope");
    assert.deepEqual(h.diagnostics, [], "a slice boundary is not a failure");
    assert.equal(h.requests("thread/read"), 3, "root plus both children, each exactly once");
  } finally {
    await h.close();
  }
});

test("memo eviction cannot silently drop a proven owned child", async () => {
  // More proven descendants than the cross-census ancestry memo can hold. The
  // memo is an optimization; the membership this census publishes is its own.
  const owned = Array.from({ length: 12 }, (_unused, index) => `owned-${index}`);
  const firstOwned = owned[0] as string;
  const h = await startHarness(
    {
      threads: [
        { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
        ...idleChildren(ROOT, owned).map((row) => ({ ...row, status: activeStatus() })),
      ],
      loadedIds: [ROOT, ...owned],
      backgroundTerminals: { [firstOwned]: [{ processId: "p-first-owned" }] },
    },
    { limits: { maxUnrelatedIds: 4 } },
  );
  try {
    const card = h.latest();
    assert.equal(card.activeTasks, owned.length,
      "every proven descendant is a member, whatever the bounded memo evicted");
    assert.equal(card.activeShells, 1, "the evicted-then-reproved child is still in the terminal scope");
    assert.deepEqual(h.diagnostics, [], "eviction is not a failure and must not be lossy");
    const queried = new Set(h.server.requests
      .filter((request) => request.method === "thread/backgroundTerminals/list")
      .map((request) => String((request.params as { threadId?: string }).threadId)));
    assert.equal(queried.has(firstOwned), true, "the first-owned child was asked, not forgotten");
  } finally {
    await h.close();
  }
});

test("a lineage deeper than the slice budget is proved across slices, not failed", async () => {
  // Seventy legitimate levels, two units of lineage work per slice: the proof
  // needs many slices and no depth ceiling may end it.
  const chain = Array.from({ length: 70 }, (_unused, index) => `deep-${index}`);
  const deepest = chain[chain.length - 1] as string;
  const threads: FakeThread[] = [{ id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" }];
  let parent = ROOT;
  for (const id of chain) {
    threads.push({
      id,
      parentThreadId: parent,
      status: id === deepest ? activeStatus() : idleStatus,
      sourceKind: "subAgentThreadSpawn",
    });
    parent = id;
  }
  const h = await startHarness(
    {
      threads,
      loadedIds: [ROOT, ...chain],
      // Only the deepest is listed, so the whole chain has to be walked up.
      persistedListing: [deepest],
    },
    { limits: { maxDescendantReads: 2 } },
  );
  try {
    const card = h.latest();
    assert.equal(card.activeTasks, 1, "an owned descendant seventy hops down counts");
    assert.equal(card.activeShells, 0, "the terminal census covers the full live scope");
    assert.deepEqual(h.diagnostics, [], "no depth ceiling and no budget failure");
    assert.equal(h.requests("thread/read"), chain.length, "root plus every ancestor, each exactly once");
  } finally {
    await h.close();
  }
});

test("a repeating page cursor is a source fault, not an endless walk or a count", async () => {
  // A cursor the walk already asked for is a provider loop. It fails the axis
  // like any other unreadable page, and it is detected instead of chased.
  const h = await startHarness({
    rawResults: {
      "thread/list": {
        data: [{ id: "loop-child", parentThreadId: ROOT, status: { type: "idle" } }],
        nextCursor: "the-same-cursor",
      },
    },
  });
  try {
    assert.equal(h.latest().activeTasks, null, "a looping cursor never becomes a count, let alone a zero");
    assert.equal(h.latest().activeShells, null, "and no shell total is claimed over an unfinished membership");
    assert.ok(h.diagnostics.includes("tasks-incomplete"));
    assert.ok(h.diagnostics.includes("shells-incomplete"));
    assert.equal(h.requests("thread/list"), 2, "the loop is detected on the repeat, not chased forever");
  } finally {
    await h.close();
  }
});

test("a parent cycle fails the census closed instead of counting or looping", async () => {
  const h = await startHarness({
    threads: [
      { id: ROOT, parentThreadId: null, status: idleStatus, sourceKind: "cli" },
      { id: "cycle-a", parentThreadId: "cycle-b", status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
      { id: "cycle-b", parentThreadId: "cycle-a", status: activeStatus(), sourceKind: "subAgentThreadSpawn" },
    ],
    loadedIds: [ROOT, "cycle-a", "cycle-b"],
    // The provider's own ancestor filter cannot place a cycle, so these ids only
    // surface through the loaded set.
    persistedListing: [],
  });
  try {
    assert.equal(h.latest().activeTasks, null, "a cycle proves nothing, so nothing is counted");
    assert.equal(h.latest().activeShells, null);
    assert.ok(h.diagnostics.includes("tasks-cycle"));
  } finally {
    await h.close();
  }
});

test("a streaming census keeps the last complete card until it lands", async () => {
  const h = await startHarness({ pageSize: 1, delayMs: { "thread/list": 20 } });
  try {
    const published = h.observations.length;
    const card = h.latest();
    assert.equal(card.activeTasks, 2);

    h.observer.refresh();
    await settle(60);
    assert.equal(h.observer.censusInFlight, true, "the walk is still streaming");
    assert.equal(h.observations.length, published,
      "a multi-slice census publishes nothing half-built, and blanks nothing");
    assert.deepEqual(h.latest(), card);

    await settle(500);
    assert.equal(h.observer.censusInFlight, false);
    assert.equal(h.observations.length, published, "a healthy re-pull still publishes nothing new");
  } finally {
    await h.close();
  }
});

test("a membership edge mid-walk restarts the enumeration instead of publishing it", async () => {
  const h = await startHarness({ pageSize: 1, delayMs: { "thread/list": 25 } });
  try {
    assert.equal(h.latest().activeTasks, 2);
    h.observer.refresh();
    await settle(40);
    assert.equal(h.observer.censusInFlight, true, "the census is part-way through its pages");

    // A new owned child starts while pages are in flight. It may sit behind a
    // page this walk already passed, so the walk is not publishable.
    h.server.setThread({
      id: "late-child",
      parentThreadId: ROOT,
      status: activeStatus(),
      sourceKind: "subAgentThreadSpawn",
    });
    h.server.setLoaded("late-child", true);
    h.server.broadcast("thread/started", {
      thread: { id: "late-child", parentThreadId: ROOT, status: { type: "active", activeFlags: [] } },
    });
    await settle(200);
    await h.scheduler.advance(400);
    await h.quiet();

    assert.equal(h.observer.censusInFlight, false);
    assert.equal(h.latest().activeTasks, 3,
      "the trailing census re-enumerated from the first page and found the new child");
    assert.equal(h.latest().activeShells, 0);
  } finally {
    await h.close();
  }
});

test("privacy: no command, cwd, preview, name, or model ever reaches an observation", async () => {
  const h = await startHarness();
  try {
    h.server.setBackgroundTerminals(ROOT, [{ processId: "proc-1", command: `${FAKE_MARKER} secret command`, cwd: `${FAKE_MARKER}/secret` }]);
    h.observer.refresh();
    await h.quiet();
    h.server.setStatus(ROOT, activeStatus(["waitingOnUserInput"]));
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: ["waitingOnUserInput"] } });
    await settle();

    const serialized = JSON.stringify(h.observations);
    assert.ok(serialized.length > 0);
    assert.ok(!serialized.includes(FAKE_MARKER), "no planted content reached any published snapshot");
    assert.ok(!serialized.includes("cargo"));
    assert.ok(!serialized.includes("worktree"));
    assert.ok(!serialized.includes("rollout"));
    assert.ok(!serialized.includes("nickname"));
    assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_WORKING]);
    assert.equal(h.latest().activeShells, 1);
  } finally {
    await h.close();
  }
});

test("server requests are counted and dropped: zero reply bytes, no implied pending input", async () => {
  const h = await startHarness();
  try {
    const baseline = h.server.rawInboundFrames.length;
    const ids = [
      h.server.sendServerRequest("item/commandExecution/requestApproval", { kind: "command" }),
      h.server.sendServerRequest("item/tool/requestUserInput", { questions: [] }),
      h.server.sendServerRequest("item/permissions/requestApproval", {}),
    ];
    await settle();
    assert.equal(h.observer.serverRequestCount, 3);
    assert.deepEqual(h.server.inboundFramesSince(baseline), [], "the observer answers nothing");
    assert.equal(h.server.repliedTo(ids), false);
    // Pending input comes from the provider's own status flags, never from seeing a request.
    assert.equal(h.latest().pendingInput, false);
  } finally {
    await h.close();
  }
});

test("the tool-type merge seam is authoritative for the caller and never implies work", async () => {
  const h = await startHarness();
  try {
    h.server.setStatus(ROOT, activeStatus());
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    await settle();
    assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_WORKING]);

    h.observer.observeToolActivity("Exec");
    assert.deepEqual(h.latest().activity, ["Exec"],
      "the caller's tool type reaches the card at once, not behind a census");
    await awaitQuiet(h.observer);
    assert.deepEqual(h.latest().activity, ["Exec"], "a landing census does not undo it");

    // The RPC lane keeps authority over Ready vs Working: once the root is idle
    // the caller's label is dropped, so no stale tool line can outlive the turn.
    h.server.setStatus(ROOT, idleStatus);
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
    await settle();
    assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_READY]);

    // A label is a bounded label, never a command line.
    h.server.setStatus(ROOT, activeStatus());
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    await settle();
    h.observer.observeToolActivity(`rm -rf ${FAKE_MARKER} && echo done`.repeat(6));
    await awaitQuiet(h.observer);
    const line = (h.latest().activity ?? [])[0] ?? "";
    assert.ok(line.length > 0 && line.length <= 120);
    assert.ok(!line.includes(FAKE_MARKER));
  } finally {
    await h.close();
  }
});

test("reconnect withdraws, then re-pulls the true state, including a child that finished meanwhile", async () => {
  const h = await startHarness();
  try {
    assert.equal(h.latest().activeTasks, 2);

    // The child finishes while the observer is blind.
    h.server.setStatus(CHILD_ACTIVE, idleStatus);
    h.server.setStatus(NESTED, idleStatus);
    h.server.dropClientConnections();
    await settle();

    assert.deepEqual(h.observations[h.observations.length - 1], {
      busy: null,
      pendingInput: null,
      activity: [],
      activeTasks: null,
      activeShells: null,
      support: NATIVE_CODEX_RPC_STATUS_SUPPORT,
    }, "a real disconnect withdraws every axis rather than republishing a stale number");
    assert.ok(h.diagnostics.includes("connection-lost"));

    await h.scheduler.advance(300);
    await settle(50);
    assert.equal(h.observer.connected, true);
    await h.quiet();
    assert.equal(h.latest().activeTasks, 0, "the reconnect re-pull sees the finished children");
    assert.equal(h.latest().activeShells, 0);
    assert.equal(h.latest().busy, false);
  } finally {
    await h.close();
  }
});

test("a rebinding retires the previous root's facts before the new pull lands", async () => {
  const h = await startHarness();
  try {
    assert.equal(h.latest().activeTasks, 2);
    await h.observer.rebind({ rootThreadId: CHILD_ACTIVE, generation: "gen-2" });

    assert.equal(h.observer.generation, "gen-2");
    assert.equal(h.observer.rootThreadId, CHILD_ACTIVE);
    // Under the new binding, CHILD_ACTIVE's own descendants are the nested child.
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().busy, true, "CHILD_ACTIVE is active on the fake backend");
    const ancestorQueries = h.server.requests.filter((request) => request.method === "thread/list");
    assert.equal(ancestorQueries[ancestorQueries.length - 1].params.ancestorThreadId, CHILD_ACTIVE);
  } finally {
    await h.close();
  }
});

test("a stale in-flight census can never publish after a rebinding", async () => {
  const h = await startHarness({ delayMs: { "thread/loaded/list": 80 } });
  try {
    const seen = h.observations.length;
    h.observer.refresh();
    await settle(10);
    await h.observer.rebind({ generation: "gen-9" });
    await settle(160);
    // Only publications belonging to the live binding appear.
    assert.ok(h.observations.length > seen);
    assert.equal(h.observations[h.observations.length - 1].activeTasks, 2);
    assert.equal(h.observer.generation, "gen-9");
  } finally {
    await h.close();
  }
});

test("disposal is bounded: no late timer, callback, or request survives it", async () => {
  const h = await startHarness({ pageSize: 1, delayMs: { "thread/list": 40 } });
  try {
    h.observer.refresh();
    await settle(10);
    h.observer.dispose();
    const observations = h.observations.length;
    const frames = h.server.rawInboundFrames.length;

    await h.scheduler.advance(10_000);
    await settle(80);
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    await settle();

    assert.equal(h.observations.length, observations, "no observation after dispose");
    assert.equal(h.server.rawInboundFrames.length, frames, "no request after dispose");
    assert.equal(h.scheduler.pendingTimerCount, 0, "no timer outlives dispose");
    assert.equal(h.observer.connected, false);
    assert.equal(h.observer.snapshot.activeTasks, null);
    await assert.rejects(() => h.observer.start(), RangeError);
    await h.observer.rebind({ generation: "gen-x" }).then(
      () => assert.fail("a disposed observer must not reconnect"),
      () => undefined,
    );
  } finally {
    await h.server.stop();
  }
});

test("the public surface is observation-only: no control call is reachable", () => {
  const methods: string[] = [];
  const accessors: string[] = [];
  for (const name of Object.getOwnPropertyNames(NativeCodexRpcStatusObserver.prototype)) {
    if (name === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(NativeCodexRpcStatusObserver.prototype, name);
    if (descriptor?.get !== undefined) accessors.push(name);
    else methods.push(name);
  }
  methods.sort();
  accessors.sort();
  assert.deepEqual(methods, [
    "dispose",
    "observeAsyncInput",
    "observeToolActivity",
    "rebind",
    "refresh",
    "start",
    "supersedeCensus",
  ], "the only callable behavior is start, a coalesced refresh or supersede, a rebinding, and the caller's tool-type and async-input merges");
  assert.deepEqual(accessors, [
    "censusInFlight",
    "connected",
    "generation",
    "knownDescendantCount",
    "rootBlocked",
    "rootThreadId",
    "rootTurnActive",
    "serverRequestCount",
    "snapshot",
  ], "everything else is a read-only fact, not a command");
  for (const forbidden of ["send", "call", "request", "subscribe", "resume", "terminate", "clean", "interrupt"]) {
    assert.equal(methods.includes(forbidden), false, `${forbidden} must not be reachable`);
  }
});

test("the root projection is one canonical waiting rule for every native status", () => {
  assert.deepEqual(projectNativeCodexRootStatus(null),
    { busy: null, pendingInput: null, rootTurnActive: null, blocked: false });
  assert.deepEqual(projectNativeCodexRootStatus({ kind: "active", activeFlags: [] }),
    { busy: true, pendingInput: false, rootTurnActive: true, blocked: false },
    "an unblocked active root is running");
  assert.deepEqual(projectNativeCodexRootStatus({ kind: "active", activeFlags: ["waitingOnApproval"] }),
    { busy: false, pendingInput: true, rootTurnActive: true, blocked: true });
  assert.deepEqual(projectNativeCodexRootStatus({ kind: "active", activeFlags: ["waitingOnUserInput"] }),
    { busy: false, pendingInput: true, rootTurnActive: true, blocked: true });
  assert.deepEqual(projectNativeCodexRootStatus({ kind: "active", activeFlags: ["waitingOnApproval", "waitingOnUserInput"] }),
    { busy: false, pendingInput: true, rootTurnActive: true, blocked: true });
  assert.deepEqual(projectNativeCodexRootStatus({ kind: "idle", activeFlags: [] }),
    { busy: false, pendingInput: false, rootTurnActive: false, blocked: false });
  assert.deepEqual(projectNativeCodexRootStatus({ kind: "systemError", activeFlags: [] }),
    { busy: null, pendingInput: null, rootTurnActive: null, blocked: false });
  assert.deepEqual(projectNativeCodexRootStatus({ kind: "notLoaded", activeFlags: [] }),
    { busy: null, pendingInput: null, rootTurnActive: null, blocked: false });
});

test("pure census helpers agree with the provider's active predicate", () => {
  assert.equal(isActiveNativeCodexDescendantStatus({ kind: "active", activeFlags: ["waitingOnApproval"] }), true);
  assert.equal(isActiveNativeCodexDescendantStatus({ kind: "active", activeFlags: [] }), true);
  assert.equal(isActiveNativeCodexDescendantStatus({ kind: "idle", activeFlags: [] }), false);
  assert.equal(isActiveNativeCodexDescendantStatus({ kind: "notLoaded", activeFlags: [] }), false);
  assert.equal(isActiveNativeCodexDescendantStatus({ kind: "systemError", activeFlags: [] }), false);
  const row = (kind: "active" | "idle" | "notLoaded") => ({
    threadId: kind,
    parentThreadId: ROOT,
    status: { kind, activeFlags: [] as const },
  });
  assert.equal(countActiveNativeCodexDescendants([row("active"), row("idle"), row("notLoaded"), row("active")]), 2);
  assert.equal(countActiveNativeCodexDescendants([]), 0);
});

/* ------------------------------------------- async input and supersede */

test("without stated async queue knowledge the input axis is unknown, never a guessed none", async () => {
  const h = await startHarness({}, { asyncInput: undefined });
  try {
    const card = h.latest();
    assert.equal(card.pendingInput, null, "an idle root alone cannot prove that no async question waits");
    assert.equal(card.busy, false, "the agent axis is untouched");
    assert.deepEqual(card.activity, [NATIVE_CODEX_RPC_ACTIVITY_READY]);
    assert.equal(card.activeTasks, 2, "unrelated known axes stay intact");
    assert.equal(card.activeShells, 0);
  } finally {
    await h.close();
  }
});

test("async pending combines with the provider input axis and never changes the agent axis", async () => {
  assert.equal(combineNativeCodexInputAxes(true, "none"), true);
  assert.equal(combineNativeCodexInputAxes(true, "unknown"), true, "a current provider block proves pending");
  assert.equal(combineNativeCodexInputAxes(null, "pending"), true);
  assert.equal(combineNativeCodexInputAxes(false, "pending"), true);
  assert.equal(combineNativeCodexInputAxes(false, "none"), false);
  assert.equal(combineNativeCodexInputAxes(false, "unknown"), null);
  assert.equal(combineNativeCodexInputAxes(null, "none"), null);

  const h = await startHarness();
  try {
    h.server.setStatus(ROOT, activeStatus([]));
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    await settle(25);
    h.observer.observeAsyncInput("pending");
    assert.equal(h.latest().pendingInput, true, "an own unanswered async question is pending");
    assert.equal(h.latest().busy, true, "the root keeps working while the question waits");
    assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_WORKING]);

    h.observer.observeAsyncInput("unknown");
    assert.equal(h.latest().pendingInput, null, "lost queue knowledge is unknown, not none");
    assert.equal(h.latest().busy, true);
    assert.equal(h.latest().activeTasks, 2, "an input-only gap leaves every other axis intact");

    h.observer.observeAsyncInput("none");
    assert.equal(h.latest().pendingInput, false);

    // A malformed state is unknown.
    h.observer.observeAsyncInput("bogus" as never);
    assert.equal(h.latest().pendingInput, null);
  } finally {
    await h.close();
  }
});

test("a superseded census that read the root before its own work never publishes a stale Ready", async () => {
  const h = await startHarness({ delayMs: { "thread/backgroundTerminals/list": 80 } });
  try {
    assert.equal(h.latest().busy, false, "the first census positively read an idle root");
    await h.quiet();
    const readsBefore = h.requests("thread/read");
    h.observer.refresh();
    // Wait until the in-flight census has read the still-idle root.
    for (let waited = 0; h.requests("thread/read") === readsBefore && waited < 2_000; waited += 5) {
      await settle(5);
    }
    assert.ok(h.observer.censusInFlight, "the census is held after its root read");
    // The root's own work starts; no broadcast has reached this lane yet.
    h.server.setStatus(ROOT, activeStatus([]));
    const mark = h.observations.length;
    h.observer.supersedeCensus();
    for (let waited = 0; h.latest().busy !== true && waited < 4_000; waited += 10) {
      await settle(10);
    }
    await h.quiet();
    assert.equal(h.latest().busy, true, "the re-pull saw the root's own work without a broadcast");
    assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_WORKING]);
    for (const observation of h.observations.slice(mark)) {
      assert.notEqual(observation.busy, false, "the superseded census never landed its stale idle read");
    }
  } finally {
    await h.close();
  }
});

/* ------------------------------------------- caller-supplied workspace proof */

const UNKNOWN_CARD = Object.freeze({
  busy: null,
  pendingInput: null,
  activity: [] as string[],
  activeTasks: null,
  activeShells: null,
});

function axes(observation: NativeStatusObservation): Record<string, unknown> {
  return {
    busy: observation.busy,
    pendingInput: observation.pendingInput,
    activity: observation.activity,
    activeTasks: observation.activeTasks,
    activeShells: observation.activeShells,
  };
}

test("an expected workspace the root's own read matches validates it and keeps the ordinary card", async () => {
  let validated = 0;
  const h = await startHarness({}, {
    expectedWorkspace: "/owned/worktree",
    onRootValidated: () => {
      validated += 1;
    },
  });
  try {
    assert.deepEqual(axes(h.latest()), {
      busy: false,
      pendingInput: false,
      activity: [NATIVE_CODEX_RPC_ACTIVITY_READY],
      activeTasks: 2,
      activeShells: 0,
    });
    assert.equal(h.observations.length, 1, "validation adds no extra publication");
    assert.equal(validated, 1, "the SAME root read validated the root once per census");
    assert.equal(h.requests("thread/read") >= 1, true);
    // The workspace never goes on the wire, and the root read is the ordinary one.
    assert.deepEqual(h.server.requests.find((request) => request.method === "thread/read")?.params,
      { threadId: ROOT, includeTurns: false });
    assert.equal(h.server.connectionCount, 1, "no additional observer connection");
    const surfaced = JSON.stringify(h.observations);
    assert.equal(surfaced.includes("/owned/worktree"), false);
  } finally {
    await h.close();
  }
});

test("a root in another workspace publishes nothing but unknown and is never validated", async () => {
  let validated = 0;
  const h = await startHarness({}, {
    expectedWorkspace: "/owned/elsewhere",
    onRootValidated: () => {
      validated += 1;
    },
  });
  try {
    assert.deepEqual(axes(h.latest()), UNKNOWN_CARD, "no Ready, zero, count, or input none for a wrong workspace");
    assert.equal(validated, 0);
    assert.ok(h.diagnostics.includes("root-workspace-unverified"));

    // Live provider traffic for the root still cannot surface anything.
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
    await h.scheduler.advance(500);
    await h.quiet();
    assert.deepEqual(axes(h.latest()), UNKNOWN_CARD);
    assert.equal(validated, 0);
  } finally {
    await h.close();
  }
});

test("an unreadable root proves nothing, and a later matching read of the same root validates it", async () => {
  let validated = 0;
  const h = await startHarness({ unreadableThreadIds: [ROOT] }, {
    expectedWorkspace: "/owned/worktree",
    onRootValidated: () => {
      validated += 1;
    },
  });
  try {
    assert.deepEqual(axes(h.latest()), UNKNOWN_CARD, "counts stay unknown until the root is proved");
    assert.equal(validated, 0);

    h.server.unreadable.delete(ROOT);
    h.observer.refresh();
    await h.scheduler.advance(500);
    await h.quiet();
    assert.equal(validated >= 1, true);
    assert.equal(h.latest().busy, false);
    assert.equal(h.latest().activeTasks, 2);

    // A root row naming another thread is a contrary answer, not a validation.
    h.server.mismatched.add(ROOT);
    h.observer.refresh();
    await h.scheduler.advance(500);
    await h.quiet();
    assert.deepEqual(axes(h.latest()), UNKNOWN_CARD);
  } finally {
    await h.close();
  }
});

test("an observer retired from inside its validation callback publishes nothing further", async () => {
  let observer: NativeCodexRpcStatusObserver | undefined;
  let validated = 0;
  const h = await startHarness({}, {
    expectedWorkspace: "/owned/worktree",
    onRootValidated: () => {
      validated += 1;
      observer?.dispose();
    },
  });
  try {
    // The first census validated before `observer` was captured; retire on the next.
    observer = h.observer;
    const before = h.observations.length;
    h.server.setStatus(ROOT, activeStatus([]));
    h.observer.refresh();
    await settle(100);
    assert.equal(validated, 2);
    assert.equal(h.observations.length, before, "a census whose caller retired it cannot publish");
    assert.equal(h.scheduler.pendingTimerCount, 0, "no timer survives the retirement");
  } finally {
    await h.close();
  }
});

test("a positive root contradiction after validation is reported; an unreadable read is not", async () => {
  let validated = 0;
  let contradicted = 0;
  const h = await startHarness({}, {
    expectedWorkspace: "/owned/worktree",
    onRootValidated: () => {
      validated += 1;
    },
    onRootContradicted: () => {
      contradicted += 1;
    },
  });
  try {
    assert.equal(validated, 1);
    assert.equal(contradicted, 0);

    // An unreadable answer proves nothing either way.
    h.server.unreadable.add(ROOT);
    h.observer.refresh();
    await h.scheduler.advance(500);
    await h.quiet();
    assert.equal(contradicted, 0, "a read gap is not a contradiction");
    h.server.unreadable.delete(ROOT);

    // The same root now reported in another workspace.
    h.server.setThread({ ...POPULATION[0]!, cwd: "/owned/elsewhere" });
    h.observer.refresh();
    await h.scheduler.advance(500);
    await h.quiet();
    assert.equal(contradicted, 1);
    assert.deepEqual(axes(h.latest()), UNKNOWN_CARD);

    // A readable row naming another thread is also a contradiction.
    h.server.setThread({ ...POPULATION[0]! });
    h.server.mismatched.add(ROOT);
    h.observer.refresh();
    await h.scheduler.advance(500);
    await h.quiet();
    assert.equal(contradicted, 2);
    assert.deepEqual(axes(h.latest()), UNKNOWN_CARD);
  } finally {
    await h.close();
  }
});

/* --------------------------------- provider conversation TITLE (issue #690) */

test("the validated root read reports its actual title, once per census, and nothing else carries it", async () => {
  const titles: (string | null)[] = [];
  const h = await startHarness({}, {
    expectedWorkspace: "/owned/worktree",
    onRootTitle: (title) => {
      titles.push(title);
    },
  });
  try {
    assert.equal(titles.length, 1, "one title per census that validated the root");
    assert.equal(typeof titles[0], "string", "the fixture root carries a provider title");
    assert.equal((titles[0] as string).length <= 80, true, "the host's own row-name bound is what a title must satisfy");

    // A second census re-reads and restates the same title; the status card is not
    // republished for a title, and no new connection or request method appears.
    const before = h.observations.length;
    h.observer.refresh();
    await h.scheduler.advance(500);
    await h.quiet();
    assert.equal(titles.length, 2, "the title travels with each validated root read");
    assert.equal(titles[1], titles[0]);
    assert.equal(h.observations.length, before, "a title is not a status publication");
    assert.equal(h.server.connectionCount, 1, "the title rides the observer's own single connection");
    const surfaced = JSON.stringify(h.observations);
    assert.equal(surfaced.includes(titles[0] as string), false, "a title never rides a status observation");
    assert.equal(surfaced.includes("/owned/worktree"), false);
  } finally {
    await h.close();
  }
});

test("a root that reports no title is a positive none, while an unvalidated root reports nothing at all", async () => {
  const titled = POPULATION.map((row) => (row.id === ROOT ? { ...row, name: null } : row));
  const seen: (string | null)[] = [];
  const matched = await startHarness({ threads: titled }, {
    expectedWorkspace: "/owned/worktree",
    onRootTitle: (title) => {
      seen.push(title);
    },
  });
  try {
    assert.deepEqual(seen, [null], "the provider positively saying it has no title is not unknown");
    assert.equal(matched.latest().busy, false, "the ordinary card is unchanged by a titleless root");
  } finally {
    await matched.close();
  }

  // A root the census never validated — wrong workspace, or an unreadable read —
  // reports NO title, which is never the same claim as "no title".
  const elsewhere: (string | null)[] = [];
  const wrongWorkspace = await startHarness({}, {
    expectedWorkspace: "/owned/elsewhere",
    onRootTitle: (title) => {
      elsewhere.push(title);
    },
  });
  try {
    assert.deepEqual(elsewhere, [], "a contrary root is never a source of this row's title");
  } finally {
    await wrongWorkspace.close();
  }

  const unread: (string | null)[] = [];
  const unreadableRoot = await startHarness({ unreadableThreadIds: [ROOT] }, {
    expectedWorkspace: "/owned/worktree",
    onRootTitle: (title) => {
      unread.push(title);
    },
  });
  try {
    assert.deepEqual(unread, [], "a read that failed claims nothing, not even an absence");
  } finally {
    await unreadableRoot.close();
  }
});

test("a rename edge re-runs the ordinary coalesced census, and the new title comes from the root read alone", async () => {
  const titles: (string | null)[] = [];
  const h = await startHarness({}, {
    expectedWorkspace: "/owned/worktree",
    onRootTitle: (title) => {
      titles.push(title);
    },
  });
  try {
    const initial = titles[0];
    assert.equal(typeof initial, "string");
    const readsBefore = h.requests("thread/read");

    // The provider renames the bound root and emits its own edge. The observer sends
    // nothing back and asks nothing new: the next ordinary census re-reads the root.
    h.server.setThread({ ...POPULATION[0]!, name: "Renamed by the operator" });
    h.server.broadcast("thread/name/updated", { threadId: ROOT, threadName: "Renamed by the operator" });
    await h.scheduler.advance(500);
    await h.quiet();

    assert.equal(h.requests("thread/read"), readsBefore + 1, "the edge is one coalesced refresh, not a new request path");
    assert.deepEqual(titles.slice(1), ["Renamed by the operator"], "the title comes from the root read, not the edge");
    assert.equal(JSON.stringify(h.observations).includes("Renamed by the operator"), false,
      "a title never rides a status observation");
    assert.deepEqual(axes(h.latest()), {
      busy: false,
      pendingInput: false,
      activity: [NATIVE_CODEX_RPC_ACTIVITY_READY],
      activeTasks: 2,
      activeShells: 0,
    }, "a rename moves no status axis");

    // A cleared name is a positive none on the next read.
    const cleared = h.requests("thread/read");
    h.server.setThread({ ...POPULATION[0]!, name: null });
    h.server.broadcast("thread/name/updated", { threadId: ROOT });
    await h.scheduler.advance(500);
    await h.quiet();
    assert.equal(h.requests("thread/read"), cleared + 1);
    assert.deepEqual(titles.slice(2), [null]);
  } finally {
    await h.close();
  }
});

test("a rename edge outside the bound root is not this row's evidence: no refresh, no title", async () => {
  const titles: (string | null)[] = [];
  const h = await startHarness({}, {
    expectedWorkspace: "/owned/worktree",
    onRootTitle: (title) => {
      titles.push(title);
    },
  });
  try {
    const readsBefore = h.requests("thread/read");
    const observationsBefore = h.observations.length;
    h.server.broadcast("thread/name/updated", { threadId: CHILD_ACTIVE, threadName: "Another thread's name" });
    h.server.broadcast("thread/name/updated", { threadId: UNRELATED_ROOT, threadName: "Someone else's name" });
    await h.scheduler.advance(500);
    await h.quiet();
    assert.equal(h.requests("thread/read"), readsBefore, "an unrelated rename never churns this row's census");
    assert.equal(h.observations.length, observationsBefore, "and publishes nothing");
    assert.equal(titles.length, 1, "the initial title only");
    assert.equal(JSON.stringify(h.observations).includes("Another thread"), false);
  } finally {
    await h.close();
  }
});

/* ------------------------- independent recovery during an unrelated census */

async function waitUntil(predicate: () => boolean, limitMs = 2_000): Promise<void> {
  for (let waited = 0; !predicate() && waited < limitMs; waited += 5) {
    await settle(5);
  }
}

/**
 * A provider answer to an earlier root `thread/read`, taken from a snapshot in
 * which the root was still idle, for delivery after a newer edge.
 */
function staleIdleRootAnswer(id: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      thread: {
        id: ROOT,
        sessionId: ROOT,
        forkedFromId: null,
        parentThreadId: null,
        preview: `${FAKE_MARKER} preview`,
        ephemeral: false,
        model: null,
        modelProvider: `${FAKE_MARKER}-provider`,
        createdAt: 1,
        updatedAt: 2,
        recencyAt: 2,
        status: { type: "idle" },
        path: `${FAKE_MARKER}/rollout-${ROOT}.jsonl`,
        cwd: "/owned/worktree",
        cliVersion: "0.169.0",
        originator: `${FAKE_MARKER}-originator`,
        source: { type: "cli" },
        threadSource: null,
        agentNickname: `${FAKE_MARKER}-nickname`,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
      },
    },
  });
}

/** Never answers the first request for `method` after arming; reports when it is held. */
function holdFirst(server: FakeCodexAppServer, method: string): { held: () => boolean } {
  let held = false;
  server.onRequest = (requested) => {
    if (requested !== method || held) return undefined;
    held = true;
    return "ignore";
  };
  return { held: () => held };
}

test("an owned async input recovery publishes at once behind a held terminal query, never with staged counts", async () => {
  const h = await startHarness({}, { limits: { requestTimeoutMs: 800 } });
  try {
    assert.deepEqual(axes(h.latest()), {
      busy: false,
      pendingInput: false,
      activity: [NATIVE_CODEX_RPC_ACTIVITY_READY],
      activeTasks: 2,
      activeShells: 0,
    });
    // Known -> unknown: the caller loses its queue knowledge outside any census.
    h.observer.observeAsyncInput("unknown");
    assert.equal(h.latest().pendingInput, null);

    // The next census stages a DIFFERENT tally (one owned child finished
    // without a broadcast), and its unrelated terminal query is held unanswered.
    h.server.setStatus(CHILD_ACTIVE, idleStatus);
    const hold = holdFirst(h.server, "thread/backgroundTerminals/list");
    h.observer.refresh();
    await waitUntil(hold.held);
    assert.equal(hold.held(), true, "the census reached its terminal query");
    assert.equal(h.observer.censusInFlight, true, "the census is held mid-walk");

    const mark = h.observations.length;
    h.observer.observeAsyncInput("none");
    assert.equal(h.observations.length, mark + 1, "the owned recovery is published at once, not after the census");
    assert.deepEqual(axes(h.latest()), {
      busy: false,
      pendingInput: false,
      activity: [NATIVE_CODEX_RPC_ACTIVITY_READY],
      activeTasks: 2,
      activeShells: 0,
    }, "only the last committed counts ride along; the staged tally of 1 never does");
    assert.equal(h.observer.censusInFlight, true, "the held query is still outstanding");

    // The held query times out: the census commits its own outcome only now.
    await h.quiet();
    assert.equal(h.latest().activeTasks, 1, "the staged tally is committed by its own census");
    assert.equal(h.latest().activeShells, null, "a timed-out terminal query withdraws shells");
    assert.equal(h.latest().pendingInput, false);

    // Ordinary recovery for the withdrawn axis, by the existing re-arm.
    h.server.onRequest = null;
    await h.scheduler.advance(2_500);
    await h.quiet();
    assert.equal(h.latest().activeShells, 0);
  } finally {
    await h.close();
  }
});

test("an owned tool label and its clear publish at once behind a held terminal query, never with staged counts", async () => {
  let validated = 0;
  const h = await startHarness({}, {
    expectedWorkspace: "/owned/worktree",
    limits: { requestTimeoutMs: 800 },
    onRootValidated: () => {
      validated += 1;
    },
  });
  try {
    assert.equal(validated, 1, "the root proof is established before the caller's label arrives");
    assert.deepEqual(axes(h.latest()), {
      busy: false,
      pendingInput: false,
      activity: [NATIVE_CODEX_RPC_ACTIVITY_READY],
      activeTasks: 2,
      activeShells: 0,
    });

    // The provider's own edge makes the root's turn live, and the census it
    // requests stages a DIFFERENT tally (one owned child finished without a
    // broadcast) while its unrelated terminal query is held unanswered.
    h.server.setStatus(CHILD_ACTIVE, idleStatus);
    const hold = holdFirst(h.server, "thread/backgroundTerminals/list");
    h.server.setStatus(ROOT, activeStatus());
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    await waitUntil(hold.held);
    assert.equal(hold.held(), true, "the census reached its terminal query");
    assert.equal(h.observer.censusInFlight, true, "the census is held mid-walk");
    assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_WORKING],
      "the provider's own edge already put the live turn on the row");

    const mark = h.observations.length;
    h.observer.observeToolActivity("Exec");
    assert.equal(h.observations.length, mark + 1, "the caller's tool type is published at once, not after the census");
    assert.deepEqual(axes(h.latest()), {
      busy: true,
      pendingInput: false,
      activity: ["Exec"],
      activeTasks: 2,
      activeShells: 0,
    }, "only the last committed counts ride along; the staged tally of 1 never does");

    // The clear is the caller's own fact too: back to the generic foreground.
    h.observer.observeToolActivity(null);
    assert.equal(h.observations.length, mark + 2, "the clear is published at once as well");
    assert.deepEqual(axes(h.latest()), {
      busy: true,
      pendingInput: false,
      activity: [NATIVE_CODEX_RPC_ACTIVITY_WORKING],
      activeTasks: 2,
      activeShells: 0,
    });
    assert.equal(h.observer.censusInFlight, true, "the held query is still outstanding");
    assert.deepEqual(
      new Set(h.observations.slice(mark).map((observation) => `${String(observation.activeTasks)}/${String(observation.activeShells)}`)),
      new Set(["2/0"]),
      "no publication during the held walk leaked a staged tally or an unknown",
    );

    // The held query times out: the census commits its own outcome only now.
    await h.quiet();
    assert.equal(h.latest().activeTasks, 1, "the staged tally is committed by its own census");
    assert.equal(h.latest().activeShells, null, "a timed-out terminal query withdraws shells");
    assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_WORKING]);

    // Ordinary recovery for the withdrawn axis, by the existing re-arm.
    h.server.onRequest = null;
    await h.scheduler.advance(2_500);
    await h.quiet();
    assert.equal(h.latest().activeShells, 0);
  } finally {
    await h.close();
  }
});

test("an owned tool label cannot publish an uncommitted census root status, nor a first-turn-stale foreground", async () => {
  const h = await startHarness({}, { limits: { requestTimeoutMs: 800 } });
  try {
    assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_READY]);

    // The fake moves the root to active with NO edge, so only the next census's
    // own root read learns it: that read's status is held until its commit.
    h.server.setStatus(ROOT, activeStatus());
    const hold = holdFirst(h.server, "thread/backgroundTerminals/list");
    h.observer.refresh();
    await waitUntil(hold.held);
    assert.equal(hold.held(), true, "the census reached its terminal query");
    assert.equal(h.observer.censusInFlight, true, "the census is held mid-walk");
    assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_READY],
      "the held census's own root status is not on the row yet");

    const mark = h.observations.length;
    h.observer.observeToolActivity("Exec");
    assert.equal(h.observations.length, mark,
      "a tool label never publishes an uncommitted root status ahead of its census");
    h.observer.observeToolActivity(null);
    assert.equal(h.observations.length, mark, "nor does its clear");
    assert.equal(h.observer.censusInFlight, true, "the held query is still outstanding");

    // Only that census's own commit lifts the hold; the label surfaces with it.
    h.observer.observeToolActivity("Exec");
    await h.quiet();
    assert.deepEqual(h.latest().activity, ["Exec"], "the label surfaces with the committed status");
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, null, "a timed-out terminal query withdraws shells");

    // The caller's first-turn witness fences every authority, this one included.
    const fenceMark = h.observations.length;
    h.observer.supersedeCensus();
    h.observer.observeToolActivity("Write");
    assert.equal(h.observations.length, fenceMark,
      "a tool label cannot republish a foreground the caller's own turn made stale");
    await h.quiet();
    assert.deepEqual(h.latest().activity, ["Write"],
      "the replacement census that proves the root's own work lifts the fence");
    assert.equal(h.latest().activeShells, 0);
  } finally {
    h.server.onRequest = null;
    await h.close();
  }
});

test("a fresh bound-root status edge recovers the foreground at once behind a held page query; other threads cannot", async () => {
  const h = await startHarness({}, { limits: { requestTimeoutMs: 800 } });
  try {
    assert.equal(h.latest().busy, false);
    // Known -> unknown by a provider edge for the bound root.
    h.server.setStatus(ROOT, systemErrorStatus);
    const hold = holdFirst(h.server, "thread/list");
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "systemError" } });
    await waitUntil(hold.held);
    assert.equal(hold.held(), true, "the refresh census reached its page query");
    assert.equal(h.observer.censusInFlight, true);
    assert.deepEqual(axes(h.latest()), {
      busy: null,
      pendingInput: null,
      activity: [],
      activeTasks: 2,
      activeShells: 0,
    }, "systemError is unknown, never Ready");

    // Status for threads that are not the bound root cannot cure the unknown.
    const mark = h.observations.length;
    h.server.broadcast("thread/status/changed", { threadId: UNRELATED_ROOT, status: { type: "idle" } });
    h.server.broadcast("thread/status/changed", { threadId: CHILD_ACTIVE, status: { type: "idle" } });
    await settle(40);
    assert.equal(h.observations.length, mark, "another thread's status publishes nothing");
    assert.equal(h.latest().busy, null);

    // The provider's own fresh edge for the bound root is the genuine recovery.
    const listsBefore = h.requests("thread/list");
    h.server.setStatus(ROOT, idleStatus);
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
    await waitUntil(() => h.observations.length > mark, 300);
    assert.equal(h.observer.censusInFlight, true, "recovered while the page query is still held");
    assert.equal(h.requests("thread/list"), listsBefore, "the census has not moved past its held page");
    assert.deepEqual(axes(h.latest()), {
      busy: false,
      pendingInput: false,
      activity: [NATIVE_CODEX_RPC_ACTIVITY_READY],
      activeTasks: 2,
      activeShells: 0,
    });

    // The held census still fails closed on its own axes when it lands.
    await h.quiet();
    assert.equal(h.latest().activeTasks, null);
    assert.equal(h.latest().activeShells, null);
    assert.equal(h.latest().busy, false, "the recovered foreground is not undone by the count failure");

    h.server.onRequest = null;
    await h.scheduler.advance(400);
    await h.quiet();
    assert.equal(h.latest().activeTasks, 2);
    assert.equal(h.latest().activeShells, 0);
  } finally {
    await h.close();
  }
});

test("a root status the in-flight census read itself stays held until the next eligible edge", async () => {
  const h = await startHarness({}, { limits: { requestTimeoutMs: 800 } });
  try {
    h.observer.observeAsyncInput("unknown");
    assert.equal(h.latest().pendingInput, null);
    // The root starts working with no broadcast: only the census root read sees it.
    h.server.setStatus(ROOT, activeStatus([]));
    const hold = holdFirst(h.server, "thread/backgroundTerminals/list");
    h.observer.refresh();
    await waitUntil(hold.held);
    assert.equal(h.observer.censusInFlight, true);

    const mark = h.observations.length;
    h.observer.observeAsyncInput("none");
    assert.equal(h.observations.length, mark,
      "the census's own uncommitted root read cannot ride out on an async recovery");
    assert.equal(h.latest().busy, false);
    assert.equal(h.latest().pendingInput, null);

    // The first eligible next edge: the provider's own fresh root status.
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    await waitUntil(() => h.observations.length > mark, 300);
    assert.equal(h.observer.censusInFlight, true);
    assert.deepEqual(axes(h.latest()), {
      busy: true,
      pendingInput: false,
      activity: [NATIVE_CODEX_RPC_ACTIVITY_WORKING],
      activeTasks: 2,
      activeShells: 0,
    });
    await h.quiet();
  } finally {
    await h.close();
  }
});

test("after a first-start supersession no async recovery republishes the superseded Ready mid-census", async () => {
  const h = await startHarness({}, { limits: { requestTimeoutMs: 600 } });
  try {
    const hold = holdFirst(h.server, "thread/backgroundTerminals/list");
    h.observer.refresh();
    await waitUntil(hold.held);
    assert.equal(h.observer.censusInFlight, true, "held after reading the still-idle root");

    h.server.setStatus(ROOT, activeStatus([]));
    const mark = h.observations.length;
    h.observer.supersedeCensus();
    h.observer.observeAsyncInput("pending");
    assert.equal(h.observations.length, mark, "the caller's own turn start makes the held idle unpublishable");

    for (let waited = 0; h.latest().busy !== true && waited < 4_000; waited += 10) {
      await settle(10);
    }
    await h.quiet();
    assert.equal(h.latest().busy, true, "the replacement census saw the root's own work");
    assert.equal(h.latest().pendingInput, true);
    for (const observation of h.observations.slice(mark)) {
      assert.notEqual(observation.busy, false, "the superseded idle never landed");
    }
  } finally {
    await h.close();
  }
});

test("a first validation made by the in-flight census is not published early by an edge or async state", async () => {
  const h = await startHarness({}, { expectedWorkspace: "/owned/worktree", limits: { requestTimeoutMs: 800 } });
  try {
    h.server.setThread({ ...POPULATION[0]!, cwd: "/owned/elsewhere" });
    h.observer.refresh();
    await h.quiet();
    assert.deepEqual(axes(h.latest()), UNKNOWN_CARD);

    // The root matches again; the revalidating census is held after its root read.
    h.server.setThread({ ...POPULATION[0]! });
    const hold = holdFirst(h.server, "thread/backgroundTerminals/list");
    h.observer.refresh();
    await waitUntil(hold.held);
    assert.equal(h.observer.censusInFlight, true);

    const mark = h.observations.length;
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
    await settle(40);
    h.observer.observeAsyncInput("pending");
    assert.equal(h.observations.length, mark, "the uncommitted first validation publishes nothing early");
    assert.deepEqual(axes(h.latest()), UNKNOWN_CARD);

    // Only that census's own commit lifts the mask.
    await h.quiet();
    assert.deepEqual(axes(h.latest()), {
      busy: false,
      pendingInput: true,
      activity: [NATIVE_CODEX_RPC_ACTIVITY_READY],
      activeTasks: 2,
      activeShells: null,
    });
  } finally {
    await h.close();
  }
});

test("a delayed pre-turn idle edge cannot undo first-start supersession", async () => {
  const h = await startHarness({}, { limits: { requestTimeoutMs: 2_000 } });
  try {
    let heldId: unknown;
    h.server.onRequest = (method, params) => {
      if (method !== "thread/read" || params.threadId !== ROOT || heldId !== undefined) return undefined;
      const frame = JSON.parse(h.server.rawInboundFrames[h.server.rawInboundFrames.length - 1]!) as { id: unknown };
      heldId = frame.id;
      return "ignore";
    };
    const mark = h.observations.length;
    h.server.setStatus(ROOT, activeStatus([]));
    h.observer.supersedeCensus();
    h.observer.observeAsyncInput("pending");
    await waitUntil(() => heldId !== undefined);
    assert.notEqual(heldId, undefined, "the post-start root read is held");

    // An idle edge queued before the turn on the RPC connection arrives late.
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
    await settle(30);
    assert.equal(h.observations.length, mark, "the ambiguous idle edge publishes nothing");

    const answer = JSON.parse(staleIdleRootAnswer(heldId)) as { result: { thread: Record<string, unknown> } };
    answer.result.thread.status = { type: "active", activeFlags: [] };
    h.server.onRequest = null;
    h.server.sendRaw(JSON.stringify(answer));
    await h.quiet();

    assert.ok(h.observations.slice(mark).every((observation) => observation.busy !== false),
      "the delayed idle edge never republished pre-turn Ready");
    assert.equal(h.latest().busy, true, "the post-start read was not discarded");
    assert.equal(h.latest().pendingInput, true);
  } finally {
    await h.close();
  }
});

test("a delayed root read that began before a newer root edge never republishes its stale Ready", async () => {
  const h = await startHarness({}, { limits: { requestTimeoutMs: 2_000 } });
  try {
    assert.equal(h.latest().busy, false);
    // Hold the next census's ROOT read and remember its request id, so the
    // provider's answer can be delivered from a snapshot taken BEFORE the edge.
    let heldId: unknown;
    h.server.onRequest = (method, params) => {
      if (method !== "thread/read" || params.threadId !== ROOT || heldId !== undefined) return undefined;
      const frame = JSON.parse(h.server.rawInboundFrames[h.server.rawInboundFrames.length - 1]!) as { id: unknown };
      heldId = frame.id;
      return "ignore";
    };
    h.observer.refresh();
    await waitUntil(() => heldId !== undefined);
    assert.notEqual(heldId, undefined, "the census root read is outstanding");
    assert.equal(h.observer.censusInFlight, true);

    // The provider's newer root edge is published at once, mid-census.
    const mark = h.observations.length;
    h.server.setStatus(ROOT, activeStatus([]));
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
    await waitUntil(() => h.observations.length > mark, 300);
    assert.equal(h.latest().busy, true, "the fresh edge is not held behind the census");
    assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_WORKING]);

    // The delayed answer to the earlier read arrives AFTER the edge, still idle.
    h.server.onRequest = null;
    h.server.sendRaw(staleIdleRootAnswer(heldId));
    await h.quiet();
    assert.ok(!h.diagnostics.includes("root-read-failed"), "the delayed answer was a readable root row");
    for (const observation of h.observations.slice(mark)) {
      assert.notEqual(observation.busy, false, "the stale idle read never overwrote the newer edge");
    }
    assert.deepEqual(axes(h.latest()), {
      busy: true,
      pendingInput: false,
      activity: [NATIVE_CODEX_RPC_ACTIVITY_WORKING],
      activeTasks: 2,
      activeShells: 0,
    });
  } finally {
    await h.close();
  }
});

test("a disconnect during a held census publishes the full withdrawal at once, never a staged count", async () => {
  const h = await startHarness({}, { limits: { requestTimeoutMs: 2_000 } });
  try {
    assert.equal(h.latest().activeTasks, 2);
    // The next census stages a different tally and is held at its terminal query.
    h.server.setStatus(CHILD_ACTIVE, idleStatus);
    const hold = holdFirst(h.server, "thread/backgroundTerminals/list");
    h.observer.refresh();
    await waitUntil(hold.held);
    assert.equal(h.observer.censusInFlight, true, "the census is held mid-walk");

    const mark = h.observations.length;
    h.server.dropClientConnections();
    await waitUntil(() => !h.observer.connected, 500);
    await settle(20);
    assert.equal(h.observer.connected, false);
    assert.equal(h.observations.length, mark + 1, "the withdrawal is not swallowed by the in-flight walk");
    assert.deepEqual(axes(h.latest()), UNKNOWN_CARD, "every axis is withdrawn; no staged tally rides along");
    assert.ok(h.diagnostics.includes("connection-lost"));
    assert.equal(h.observer.censusInFlight, false, "the retired walk ended without publishing");

    // The ordinary scheduled reconnect still re-pulls the truth.
    h.server.onRequest = null;
    await h.scheduler.advance(300);
    await waitUntil(() => h.observer.connected, 1_000);
    await h.quiet();
    assert.equal(h.latest().activeTasks, 1);
    assert.equal(h.latest().activeShells, 0);
  } finally {
    await h.close();
  }
});

for (const method of ["thread/archived", "thread/closed"] as const) {
  test(`a bound root ${method} edge during a held census withdraws the foreground at once and keeps committed counts`, async () => {
    const h = await startHarness({}, { limits: { requestTimeoutMs: 800 } });
    try {
      assert.equal(h.latest().busy, false);
      h.server.setStatus(CHILD_ACTIVE, idleStatus);
      const hold = holdFirst(h.server, "thread/backgroundTerminals/list");
      h.observer.refresh();
      await waitUntil(hold.held);
      assert.equal(h.observer.censusInFlight, true);

      // Another thread's edge is not this row's evidence.
      const mark = h.observations.length;
      h.server.broadcast(method, { threadId: UNRELATED_ROOT });
      await settle(30);
      assert.equal(h.observations.length, mark);

      h.server.broadcast(method, { threadId: ROOT });
      await waitUntil(() => h.observations.length > mark, 300);
      assert.equal(h.observer.censusInFlight, true, "withdrawn while the terminal query is still held");
      assert.deepEqual(axes(h.latest()), {
        busy: null,
        pendingInput: null,
        activity: [],
        activeTasks: 2,
        activeShells: 0,
      }, "the foreground is unknown; only the last committed counts remain");

      await h.quiet();
      assert.equal(h.latest().busy, null, "the earlier census read never resurrects the withdrawn root");
      assert.equal(h.latest().activeTasks, 1, "the staged tally commits only with its census");
    } finally {
      await h.close();
    }
  });
}

test("a bound root archive during the root read is not overwritten by that read", async () => {
  const h = await startHarness({}, { limits: { requestTimeoutMs: 2_000 } });
  try {
    let heldId: unknown;
    h.server.onRequest = (method, params) => {
      if (method !== "thread/read" || params.threadId !== ROOT || heldId !== undefined) return undefined;
      const frame = JSON.parse(h.server.rawInboundFrames[h.server.rawInboundFrames.length - 1]!) as { id: unknown };
      heldId = frame.id;
      return "ignore";
    };
    h.observer.refresh();
    await waitUntil(() => heldId !== undefined);
    const mark = h.observations.length;
    h.server.broadcast("thread/archived", { threadId: ROOT });
    await waitUntil(() => h.observations.length > mark, 300);
    assert.equal(h.latest().busy, null);

    // The earlier read is answered afterwards with the pre-archive idle snapshot.
    h.server.onRequest = null;
    h.server.sendRaw(staleIdleRootAnswer(heldId));
    await h.quiet();
    assert.ok(!h.diagnostics.includes("root-read-failed"), "the delayed answer was a readable root row");
    for (const observation of h.observations.slice(mark)) {
      assert.notEqual(observation.busy, false, "the pre-archive read never republished Ready");
    }
  } finally {
    await h.close();
  }
});

test("a root archive cannot publish a first validation the in-flight census has not committed", async () => {
  const h = await startHarness({}, { expectedWorkspace: "/owned/worktree", limits: { requestTimeoutMs: 800 } });
  try {
    h.server.setThread({ ...POPULATION[0]!, cwd: "/owned/elsewhere" });
    h.observer.refresh();
    await h.quiet();
    assert.deepEqual(axes(h.latest()), UNKNOWN_CARD);

    h.server.setThread({ ...POPULATION[0]! });
    h.observer.observeAsyncInput("pending");
    const hold = holdFirst(h.server, "thread/backgroundTerminals/list");
    h.observer.refresh();
    await waitUntil(hold.held);
    const mark = h.observations.length;
    h.server.broadcast("thread/archived", { threadId: ROOT });
    await settle(40);
    assert.equal(h.observations.length, mark, "the uncommitted validation stays masked");
    assert.deepEqual(axes(h.latest()), UNKNOWN_CARD);
    await h.quiet();
  } finally {
    await h.close();
  }
});

for (const failure of ["rejected", "unreadable"] as const) {
  test(`a ${failure} root read that began before a newer root edge never withdraws the recovered foreground`, async () => {
    const h = await startHarness({}, { limits: { requestTimeoutMs: 2_000 } });
    try {
      let heldId: unknown;
      h.server.onRequest = (method, params) => {
        if (method !== "thread/read" || params.threadId !== ROOT || heldId !== undefined) return undefined;
        const frame = JSON.parse(h.server.rawInboundFrames[h.server.rawInboundFrames.length - 1]!) as { id: unknown };
        heldId = frame.id;
        return "ignore";
      };
      h.observer.refresh();
      await waitUntil(() => heldId !== undefined);
      assert.equal(h.observer.censusInFlight, true);

      const mark = h.observations.length;
      h.server.setStatus(ROOT, activeStatus([]));
      h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "active", activeFlags: [] } });
      await waitUntil(() => h.observations.length > mark, 300);
      assert.equal(h.latest().busy, true, "the fresh edge recovered the foreground mid-census");

      // The earlier read now fails: no newer status and no workspace contradiction.
      h.server.onRequest = null;
      const answer = JSON.parse(staleIdleRootAnswer(heldId)) as { result: { thread: Record<string, unknown> } };
      h.server.sendRaw(failure === "rejected"
        ? JSON.stringify({ jsonrpc: "2.0", id: heldId, error: { code: -32603, message: "refused" } })
        : JSON.stringify({ jsonrpc: "2.0", id: heldId, result: { thread: { ...answer.result.thread, status: { type: "unheardOf" } } } }));
      await h.quiet();
      assert.ok(h.diagnostics.includes("root-read-failed"), "the read failure is still its own fact");
      for (const observation of h.observations.slice(mark)) {
        assert.equal(observation.busy, true, "the older failed read never erased the newer foreground");
      }
      assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_WORKING]);
      assert.equal(h.latest().activeShells, null, "an unread root still cannot prove shell liveness");
    } finally {
      await h.close();
    }
  });
}

test("a first-start Ready stays unpublished across an abandoned replacement and its cooldown", async () => {
  const h = await startHarness({}, { limits: { requestTimeoutMs: 400 } });
  try {
    // The published foreground is unknown.
    h.server.setStatus(ROOT, systemErrorStatus);
    h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "systemError" } });
    await settle(30);
    await h.quiet();
    await h.scheduler.advance(400);
    await h.quiet();
    assert.equal(h.latest().busy, null);

    // A census reads the root idle (uncommitted) and is held at its terminal query.
    h.server.setStatus(ROOT, idleStatus);
    let phase: "census" | "replacement" | "done" = "census";
    let censusHeld = false;
    let replacementVoided = false;
    h.server.onRequest = (method, params) => {
      if (phase === "census" && method === "thread/backgroundTerminals/list" && !censusHeld) {
        censusHeld = true;
        return "ignore";
      }
      if (phase === "replacement" && method === "thread/read" && params.threadId === ROOT) {
        // A descendant membership edge voids the replacement before its root read resolves.
        phase = "done";
        replacementVoided = true;
        h.server.broadcast("thread/started", {
          thread: { id: "late-child", parentThreadId: ROOT, status: { type: "active", activeFlags: [] } },
        });
        return "ignore";
      }
      return undefined;
    };
    h.observer.refresh();
    await waitUntil(() => censusHeld);
    assert.equal(h.observer.censusInFlight, true);

    // The root's own first turn begins; the caller supersedes the census.
    h.server.setStatus(ROOT, activeStatus([]));
    phase = "replacement";
    const mark = h.observations.length;
    h.observer.supersedeCensus();
    await waitUntil(() => replacementVoided, 2_000);
    assert.equal(replacementVoided, true, "the replacement was voided before its root read");
    await h.quiet();
    assert.equal(h.observer.censusInFlight, false, "the row is between censuses, in cooldown");

    h.observer.observeAsyncInput("pending");
    assert.equal(h.observations.length, mark, "the pre-turn idle never escapes during the cooldown");

    h.server.onRequest = null;
    await h.scheduler.advance(400);
    await h.quiet();
    assert.equal(h.latest().busy, true, "the next committed census reports the root's own work");
    assert.equal(h.latest().pendingInput, true);
    for (const observation of h.observations.slice(mark)) {
      assert.notEqual(observation.busy, false, "no observation ever showed the superseded Ready");
    }
  } finally {
    await h.close();
  }
});

test("a diagnostic raised by the first matching root row cannot publish a partial first card", async () => {
  let observer: NativeCodexRpcStatusObserver | null = null;
  let armed = false;
  const h = await startHarness({}, {
    expectedWorkspace: "/owned/worktree",
    onDiagnostic: (code) => {
      if (armed && code === "root-system-error") observer?.observeAsyncInput("pending");
    },
  });
  observer = h.observer;
  try {
    h.server.setThread({ ...POPULATION[0]!, cwd: "/owned/elsewhere" });
    h.observer.refresh();
    await h.quiet();
    assert.deepEqual(axes(h.latest()), UNKNOWN_CARD);

    // The root matches again, reporting systemError; its diagnostic callback
    // reacts by updating the async queue in the middle of the validating read.
    h.server.setThread({ ...POPULATION[0]!, status: systemErrorStatus });
    armed = true;
    const mark = h.observations.length;
    h.observer.refresh();
    await h.quiet();
    armed = false;
    assert.deepEqual(h.observations.slice(mark).map(axes), [{
      busy: null,
      pendingInput: true,
      activity: [],
      activeTasks: 2,
      activeShells: 0,
    }], "the first validated card appears once, complete, at the census commit");
  } finally {
    await h.close();
  }
});

test("a diagnostic that supersedes the census at commit keeps its staged counts and pre-turn Ready off the row", async () => {
  let observer: NativeCodexRpcStatusObserver | null = null;
  let armed = false;
  let superseded = 0;
  const h = await startHarness({}, {
    limits: { requestTimeoutMs: 600 },
    onDiagnostic: (code) => {
      if (!armed || code !== "shells-incomplete") return;
      // The caller observes the root's first turn from inside the sink.
      armed = false;
      superseded += 1;
      h.server.setStatus(ROOT, activeStatus([]));
      observer?.supersedeCensus();
    },
  });
  observer = h.observer;
  try {
    assert.deepEqual(axes(h.latest()), {
      busy: false,
      pendingInput: false,
      activity: [NATIVE_CODEX_RPC_ACTIVITY_READY],
      activeTasks: 2,
      activeShells: 0,
    });
    // The census stages a changed tally and its root terminal query fails.
    h.server.setStatus(CHILD_ACTIVE, idleStatus);
    let rootTerminalFailed = false;
    let replacementReadId: unknown;
    h.server.onRequest = (method, params) => {
      if (method === "thread/backgroundTerminals/list" && params.threadId === ROOT && !rootTerminalFailed) {
        rootTerminalFailed = true;
        return "fail";
      }
      if (method === "thread/read" && params.threadId === ROOT && superseded > 0 && replacementReadId === undefined) {
        const frame = JSON.parse(h.server.rawInboundFrames[h.server.rawInboundFrames.length - 1]!) as { id: unknown };
        replacementReadId = frame.id;
        return "ignore";
      }
      return undefined;
    };
    const mark = h.observations.length;
    armed = true;
    h.observer.refresh();
    await waitUntil(() => replacementReadId !== undefined);
    assert.equal(rootTerminalFailed, true);
    assert.equal(superseded, 1, "the sink superseded the census from its commit diagnostic");
    assert.notEqual(replacementReadId, undefined, "the replacement's root read is held");
    assert.equal(h.observations.length, mark, "nothing from the superseded walk landed");
    assert.equal(h.latest().activeTasks, 2, "the staged tally never reached the row");

    await h.quiet();
    for (const observation of h.observations.slice(mark)) {
      assert.notEqual(observation.busy, false, "the superseded walk's pre-turn Ready never landed");
    }
  } finally {
    await h.close();
  }
});

for (const withdrawal of ["systemError", "notLoaded", "thread/closed"] as const) {
  test(`a first-start fence survives a ${withdrawal} withdrawal and an unknown commit until the first own proving read`, async () => {
    const h = await startHarness({}, { limits: { requestTimeoutMs: 2_000 } });
    try {
      assert.equal(h.latest().busy, false, "the committed pre-turn card is Ready");
      // The root's first own turn begins; the replacement census's root read is held.
      let heldId: unknown;
      h.server.onRequest = (method, params) => {
        if (method !== "thread/read" || params.threadId !== ROOT || heldId !== undefined) return undefined;
        const frame = JSON.parse(h.server.rawInboundFrames[h.server.rawInboundFrames.length - 1]!) as { id: unknown };
        heldId = frame.id;
        return "ignore";
      };
      const mark = h.observations.length;
      h.server.setStatus(ROOT, activeStatus([]));
      h.observer.supersedeCensus();
      h.observer.observeAsyncInput("pending");
      await waitUntil(() => heldId !== undefined);
      assert.notEqual(heldId, undefined, "the replacement census is held at its own root read");
      assert.equal(h.observations.length, mark, "the pre-turn Ready is not republished");

      // A withdrawal edge publishes its actual unknown at once.
      if (withdrawal === "thread/closed") {
        h.server.broadcast("thread/closed", { threadId: ROOT });
      } else {
        h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: withdrawal } });
      }
      await waitUntil(() => h.observations.length > mark, 300);
      assert.equal(h.observer.censusInFlight, true);
      assert.equal(h.latest().busy, null, "the withdrawal's unknown is published immediately");
      assert.equal(h.latest().pendingInput, true);
      const afterWithdrawal = h.observations.length;

      // A pre-turn idle edge, queued on the RPC connection, arrives late.
      h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
      await settle(30);
      assert.equal(h.observations.length, afterWithdrawal, "the queued pre-turn idle cannot re-arm Ready");

      // The held read answers; it began before the withdrawal, so its status is
      // not applied, and its census commits with the root still unknown.
      const answer = JSON.parse(staleIdleRootAnswer(heldId)) as { result: { thread: Record<string, unknown> } };
      answer.result.thread.status = { type: "active", activeFlags: [] };
      h.server.onRequest = null;
      h.server.sendRaw(JSON.stringify(answer));
      await h.quiet();
      assert.equal(h.latest().busy, null, "the replacement committed with the root unknown");

      // That unknown commit proved nothing: another queued idle still cannot publish.
      const afterCommit = h.observations.length;
      h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
      await settle(30);
      assert.equal(h.observations.length, afterCommit, "an unknown commit does not lift the fence");

      // The first own proving read: the next census reads the root's own work.
      await h.scheduler.advance(400);
      await h.quiet();
      assert.equal(h.latest().busy, true, "the census's own read proved the root's work");
      assert.equal(h.latest().pendingInput, true);
      assert.deepEqual(h.latest().activity, [NATIVE_CODEX_RPC_ACTIVITY_WORKING]);
      for (const observation of h.observations.slice(mark)) {
        assert.notEqual(observation.busy, false, "no observation ever showed the pre-turn Ready");
      }

      // After that proof, an idle edge is ordinary evidence again.
      h.server.setStatus(ROOT, idleStatus);
      h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
      await waitUntil(() => h.latest().busy === false, 300);
      assert.equal(h.latest().busy, false, "a post-proof idle edge publishes Ready");
    } finally {
      await h.close();
    }
  });
}

for (const withdrawal of ["systemError", "notLoaded", "thread/closed"] as const) {
  test(`a ${withdrawal} withdrawal after the replacement's own known read keeps the first-start fence through its commit`, async () => {
    const h = await startHarness({}, { limits: { requestTimeoutMs: 600 } });
    try {
      assert.equal(h.latest().busy, false, "the committed pre-turn card is Ready");
      // The replacement's own root read applies a KNOWN status; an unrelated
      // terminal query of the same census is then held.
      h.server.setStatus(ROOT, activeStatus([]));
      const hold = holdFirst(h.server, "thread/backgroundTerminals/list");
      const readsBefore = h.requests("thread/read");
      const mark = h.observations.length;
      h.observer.supersedeCensus();
      h.observer.observeAsyncInput("pending");
      await waitUntil(hold.held);
      assert.equal(hold.held(), true, "the replacement is held after its root read");
      assert.ok(h.requests("thread/read") > readsBefore, "its own root read already answered");
      assert.equal(h.observer.censusInFlight, true);
      assert.equal(h.observations.length, mark, "nothing is published before that census commits");

      // The withdrawal arrives AFTER that proving read: unknown is published now.
      if (withdrawal === "thread/closed") {
        h.server.broadcast("thread/closed", { threadId: ROOT });
      } else {
        h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: withdrawal } });
      }
      await waitUntil(() => h.observations.length > mark, 300);
      assert.equal(h.observer.censusInFlight, true);
      assert.equal(h.latest().busy, null);

      // The held query times out; the census commits with the root unknown.
      await h.quiet();
      assert.equal(h.latest().busy, null, "the commit leaves the withdrawn root unknown");

      // Its read's proof is no longer current, so a queued pre-turn idle is ignored.
      const afterCommit = h.observations.length;
      h.server.broadcast("thread/status/changed", { threadId: ROOT, status: { type: "idle" } });
      await settle(30);
      assert.equal(h.observations.length, afterCommit, "the fence survived the unknown commit");

      // Only the next proving root read lifts it.
      h.server.onRequest = null;
      await h.scheduler.advance(400);
      await h.quiet();
      assert.equal(h.latest().busy, true, "the next census's own read proved the root's work");
      assert.equal(h.latest().pendingInput, true);
      for (const observation of h.observations.slice(mark)) {
        assert.notEqual(observation.busy, false, "no observation ever showed the pre-turn Ready");
      }
    } finally {
      await h.close();
    }
  });
}
