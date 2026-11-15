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
  NATIVE_CODEX_RPC_STATUS_SUPPORT,
  NativeCodexRpcStatusObserver,
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
    await awaitQuiet(h.observer);
    assert.deepEqual(h.latest().activity, ["Exec"],
      "the caller's tool type reaches the card once the in-flight census republishes");

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
  assert.deepEqual(methods, ["dispose", "observeToolActivity", "rebind", "refresh", "start"],
    "the only callable behavior is start, a coalesced refresh, a rebinding, and the caller's tool-type merge");
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
