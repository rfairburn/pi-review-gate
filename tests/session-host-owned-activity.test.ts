/**
 * Focused tests for the opt-in owned-activity registry
 * (src/session-host/owned-activity.ts) and the automatic-review telemetry
 * helper (src/activation/review-activity.ts).
 *
 * These are pure, synthetic, in-memory assertions over the shared registry
 * contract: no process, PTY, shell, timer, file, or native API is exercised,
 * and no count is inferred from an empty tracker.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  activateOwnedActivity,
  activeActivitySnapshot,
  isOwnedActivityActive,
  ownedActivitySnapshot,
  refreshOwnedActivityIntent,
  registerOwnedActivitySource,
  subscribeOwnedActivity,
  OWNED_ACTIVITY_STATE_KEY,
  type OwnedActivitySourceHandle,
  __test as ownedActivityTest,
} from "../src/session-host/owned-activity";
import {
  beginOwnedReviewActivity,
  endOwnedReviewActivity,
  registerReviewActivitySource,
  __test as reviewActivityTest,
} from "../src/activation/review-activity";

const SHELLS = "backgroundShells" as const;
const TASKS = "backgroundTasks" as const;

interface RawRegistryEntry {
  id: string;
  revision: number;
  intentRevision?: number;
  intentTokens: Set<string>;
  intentUncertain?: boolean;
  retired: boolean;
}

/** Raw access to one category/source entry, for exact fence assertions. */
function rawSourceEntry(category: string, source: string, index = 0): RawRegistryEntry {
  const registry = (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] as {
    sources: Map<string, Map<string, RawRegistryEntry[]>>;
  };
  return registry.sources.get(category)!.get(source)![index]!;
}

function rawTaskEntry(source: string, index = 0): RawRegistryEntry {
  return rawSourceEntry(TASKS, source, index);
}

/**
 * Mandatory regression shape for a callback-bearing record whose DERIVED intent
 * cache was lost while its uncertainty flag still claimed a known value: the
 * first fresh read is incomplete, so the channel must become refreshably
 * uncertain WITHOUT fabricating a token set, coercing a zero, or touching
 * ownership. A source readiness observation ALONE must then let that exact
 * incarnation's own authoritative callback rebuild the fresh actual inventory
 * (zero or nonzero), with no second explicit refresh, new work, new source, or
 * restart.
 */
async function assertLostCacheIncompleteReadRecoversFromReadiness(
  expectedInventory: readonly string[],
): Promise<void> {
  activateOwnedActivity();
  registerReviewActivitySource();
  let healthy = false;
  let calls = 0;
  const execution = registerOwnedActivitySource(TASKS, "execution", {
    refreshActivity: () => {
      calls += 1;
      if (!healthy) return { status: "incomplete" };
      return { status: "complete", intentTokens: new Set(expectedInventory) };
    },
  });
  // A real ownership obligation that must survive every step untouched.
  execution.acquire("cleanup-owner");
  const entry = rawTaskEntry("execution");
  const incarnation = entry.id;
  // Lose ONLY the derived ephemeral cache: identity, ownership, the uncertainty
  // flag (still claiming a known value), and the refresher all stay intact.
  delete (entry as unknown as { intentTokens?: Set<string> }).intentTokens;
  assert.equal(entry.intentUncertain, false, "the record still claims a known activity value");
  assert.equal(activeActivitySnapshot().activeTasks, null, "a lost derived cache is unknown, never zero");
  assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "the protected ownership token is present");

  // The initial fresh (forced) query happens to be temporarily incomplete.
  await refreshOwnedActivityIntent();
  assert.equal(entry.intentUncertain, true,
    "a callback-bearing record with a missing derived cache becomes refreshably uncertain");
  assert.equal(entry.intentTokens, undefined, "the invalidation never fabricates a derived set");
  assert.equal(rawTaskEntry("execution").id, incarnation, "the exact incarnation identity is preserved");
  assert.equal(activeActivitySnapshot().activeTasks, null, "incomplete stays unknown, never a fabricated zero");
  assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "ownership is untouched by the uncertainty mark");

  // No self-retry loop: the one follow-up is the already-coalesced pass for the
  // new uncertainty cause, and a still-incomplete refresher schedules nothing more.
  await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
  const passes = ownedActivityTest.ownedActivityIntentRefreshPassCount();
  const callsAfterIncomplete = calls;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ownedActivityTest.ownedActivityIntentRefreshPassCount(), passes,
    "an incomplete refresher never starts another pass on its own");
  assert.equal(calls, callsAfterIncomplete, "the same owner is not re-read without a real event");
  assert.equal(activeActivitySnapshot().activeTasks, null, "still truthfully unknown");
  assert.equal(entry.intentTokens, undefined, "and still without a fabricated set");

  // From here ONLY a source readiness observation: the registry coalesces one
  // automatic pass that asks this exact owner's authoritative callback.
  healthy = true;
  execution.requestIntentRefresh();
  await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();

  assert.ok(calls > callsAfterIncomplete, "the readiness event reached the owner's own authoritative callback");
  assert.equal(activeActivitySnapshot().activeTasks, expectedInventory.length,
    "the fresh actual inventory is observed without a second explicit refresh");
  assert.deepEqual([...rawTaskEntry("execution").intentTokens!], [...expectedInventory]);
  assert.equal(rawTaskEntry("execution").intentUncertain, false, "the rebuilt inventory is authoritatively known");
  assert.equal(rawTaskEntry("execution").id, incarnation, "no recovery replaces the incarnation");
  assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "the protected ownership token is untouched");
}

/** Shape of a reload-durable record written by an earlier module copy. */
interface LegacyRegistryRecord {
  id: string;
  tokens: Set<string>;
  uncertain: boolean;
  retired: boolean;
  intentTokens: Set<string>;
  intentUncertain: boolean;
  revision: number;
  refreshActivity?: () => Promise<{ status: "complete"; intentTokens: Set<string> }>;
}

describe("owned-activity registry", () => {
  beforeEach(() => {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
  });

  afterEach(() => {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
  });

  it("stays inert until an authenticated reporter opts in", () => {
    let resyncRuns = 0;
    const shell = registerOwnedActivitySource(SHELLS, "background-shell", { resync: () => { resyncRuns += 1; } });
    const execution = registerOwnedActivitySource(TASKS, "execution", { uncertain: true });
    const review = registerOwnedActivitySource(TASKS, "review");
    shell.acquire("job-1");
    let notified = 0;
    const unsubscribe = subscribeOwnedActivity(() => { notified += 1; });

    assert.equal(isOwnedActivityActive(), false, "no reporter bootstrap: never active");
    assert.deepEqual(ownedActivitySnapshot(), { backgroundTasks: null, backgroundShells: null });
    assert.equal((globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY], undefined,
      "inert registration creates no process-local container");
    assert.equal(resyncRuns, 0, "pre-activation registration never observes");
    assert.equal(notified, 0, "no listener exists while inert");

    // Activation replays the inert registrations (running each resync once) but
    // the acquisition attempted while inert was never observed.
    activateOwnedActivity();
    assert.equal(isOwnedActivityActive(), true);
    assert.equal(resyncRuns, 1, "activation replays the inert registration exactly once");
    assert.equal(notified, 0, "a subscription attempted while inert never existed");
    assert.deepEqual(ownedActivitySnapshot(), { backgroundTasks: null, backgroundShells: null },
      "a pre-opt-in registration cannot establish completeness: no zero is claimed");

    shell.resolveUncertainty();
    assert.equal(ownedActivitySnapshot().backgroundShells, 0);
    execution.resolveUncertainty();
    review.resolveUncertainty();
    assert.deepEqual(ownedActivitySnapshot(), { backgroundTasks: 0, backgroundShells: 0 });

    shell.acquire("job-1");
    assert.equal(ownedActivitySnapshot().backgroundShells, 1);
    unsubscribe();
  });

  it("never claims zero for work that predates opt-in", () => {
    // A review may already be running, and a shell may already have been reaped
    // out of its map, before activation. The empty registration replay must stay
    // unknown for each until its source authoritatively resolves it.
    const shell = registerOwnedActivitySource(SHELLS, "background-shell");
    const execution = registerOwnedActivitySource(TASKS, "execution", { uncertain: true });
    const review = registerOwnedActivitySource(TASKS, "review");
    activateOwnedActivity();
    execution.resolveUncertainty();
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "a pre-opt-in review cannot be assumed absent");
    assert.equal(ownedActivitySnapshot().backgroundShells, null, "a pre-opt-in reaped shell cannot be assumed absent");

    review.resolveUncertainty();
    shell.resolveUncertainty();
    assert.deepEqual(ownedActivitySnapshot(), { backgroundTasks: 0, backgroundShells: 0 });
  });

  it("reports a known zero only when every expected source has a current incarnation", () => {
    activateOwnedActivity();

    registerOwnedActivitySource(SHELLS, "background-shell");
    assert.deepEqual(ownedActivitySnapshot(), { backgroundTasks: null, backgroundShells: 0 });

    registerOwnedActivitySource(TASKS, "execution");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "review source still missing: tasks unknown");

    registerOwnedActivitySource(TASKS, "review");
    assert.deepEqual(ownedActivitySnapshot(), { backgroundTasks: 0, backgroundShells: 0 });
  });

  it("keeps a reaped job positive until its actual settlement releases it", () => {
    activateOwnedActivity();
    const shell = registerOwnedActivitySource(SHELLS, "background-shell");
    registerOwnedActivitySource(TASKS, "execution");
    registerOwnedActivitySource(TASKS, "review");

    shell.acquire("job-1");
    assert.equal(ownedActivitySnapshot().backgroundShells, 1);

    // reapAll() clears the job map without an exit, and the removed job's later
    // close must still release its own token. Simulate the clear with no event.
    assert.equal(ownedActivitySnapshot().backgroundShells, 1, "reap without settlement is still owned");

    shell.release("job-1");
    assert.equal(ownedActivitySnapshot().backgroundShells, 0, "the actual close settles to a known zero");
  });

  it("degrades a failed source registration to unknown, never zero", () => {
    activateOwnedActivity();
    const shell = registerOwnedActivitySource(SHELLS, "background-shell", {
      resync: () => { throw new Error("source failed"); },
    });
    registerOwnedActivitySource(TASKS, "execution");
    registerOwnedActivitySource(TASKS, "review");

    assert.equal(ownedActivitySnapshot().backgroundShells, null, "a throwing resync is unknown");
    shell.acquire("job-1");
    assert.equal(ownedActivitySnapshot().backgroundShells, null,
      "sticky uncertainty outranks the outstanding token");

    shell.resolveUncertainty();
    assert.equal(ownedActivitySnapshot().backgroundShells, 1, "explicit re-establishment exposes the outstanding token");
  });

  it("fences incarnations: a stale handle can never release or unsettle a newer one", () => {
    activateOwnedActivity();
    const execution = registerOwnedActivitySource(TASKS, "execution");

    const older = registerOwnedActivitySource(TASKS, "review");
    older.acquire("review-run-a");
    const current = registerOwnedActivitySource(TASKS, "review");
    current.acquire("review-run-b");

    assert.equal(older.retired, true, "a newer incarnation supersedes the older one");
    assert.equal(current.retired, false);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 2, "superseded tokens stay owned until their settlement");

    older.release("review-run-a");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "an old source settling leaves current ownership positive");
    older.markUncertain();
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "a superseded incarnation's uncertainty keeps the source unknown");
    older.resolveUncertainty();
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "only the older incarnation itself clears its uncertainty");

    current.release("review-run-b");
    execution.resolveUncertainty();
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0);
  });

  it("keeps an older incarnation's uncertainty when a newer empty source registers", () => {
    activateOwnedActivity();
    const execution = registerOwnedActivitySource(TASKS, "execution");
    const older = registerOwnedActivitySource(TASKS, "review");
    // The older source could not account for its ownership (for example a failed
    // restore) and holds no known tokens.
    older.markUncertain();
    const current = registerOwnedActivitySource(TASKS, "review");
    assert.equal(older.retired, true);
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "a newer certain empty source cannot erase the older incarnation's unknown ownership");

    older.resolveUncertainty();
    execution.resolveUncertainty();
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0);
  });

  it("releases exactly the review run that owns a token, never another", () => {
    activateOwnedActivity();
    registerReviewActivitySource();
    const execution = registerOwnedActivitySource(TASKS, "execution");

    const firstRun = beginOwnedReviewActivity();
    const secondRun = beginOwnedReviewActivity();
    assert.equal(ownedActivitySnapshot().backgroundTasks, 2);

    // A session reset/restore that only knows the first run must not release
    // a newer run's ownership.
    endOwnedReviewActivity(firstRun);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
    endOwnedReviewActivity(undefined);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "an absent token releases nothing");

    endOwnedReviewActivity(secondRun);
    execution.resolveUncertainty();
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0);
  });

  it("marks detachment uncertainty as unknown while retaining outstanding ownership", () => {
    activateOwnedActivity();
    const execution = registerOwnedActivitySource(TASKS, "execution", { uncertain: true });
    registerOwnedActivitySource(TASKS, "review");

    execution.resolveUncertainty();
    execution.acquire("task-orphan");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);

    // A detached controller clears its active index without proving settlement.
    execution.markUncertain();
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "cleared tracking can never publish zero");

    execution.markUncertain();
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "uncertainty is sticky");

    execution.resolveUncertainty();
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "the retained token is still owned after re-establishment");
  });

  it("notifies subscribers only on real ownership changes and contains listener failures", () => {
    activateOwnedActivity();
    const shell = registerOwnedActivitySource(SHELLS, "background-shell");
    registerOwnedActivitySource(TASKS, "execution");
    registerOwnedActivitySource(TASKS, "review");

    let notifications = 0;
    const unsubscribe = subscribeOwnedActivity(() => { notifications += 1; });
    const unsubscribeThrowing = subscribeOwnedActivity(() => { throw new Error("reader failed"); });
    const snapshot = ownedActivitySnapshot();

    shell.acquire("job-a");
    assert.equal(notifications, 1, "a new token notifies");
    shell.acquire("job-a");
    assert.equal(notifications, 1, "a duplicate token is not a change");
    shell.release("absent");
    assert.equal(notifications, 1, "releasing an unknown token is not a change");
    shell.release("job-a");
    assert.equal(notifications, 2, "a real release notifies");
    assert.deepEqual(ownedActivitySnapshot(), { backgroundTasks: 0, backgroundShells: 0 });
    assert.deepEqual(snapshot, { backgroundTasks: 0, backgroundShells: 0 });
    unsubscribeThrowing();
    unsubscribe();
  });

  it("retains a review run through source supersession and releases its exact original owner", () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    registerReviewActivitySource();
    const oldRun = beginOwnedReviewActivity();
    const newerSource = registerOwnedActivitySource(TASKS, "review");
    newerSource.acquire("newer-review-run");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 2);
    endOwnedReviewActivity(oldRun);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
    endOwnedReviewActivity(oldRun);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "duplicate old completion cannot release newer work");
    newerSource.release("newer-review-run");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0);
  });

  it("treats corrupt retained observation state as unknown without overwriting it or breaking mutations", () => {
    activateOwnedActivity();
    const shell = registerOwnedActivitySource(SHELLS, "background-shell");
    const corrupt = { active: true, sources: new Map([[SHELLS, true]]), listeners: new Set() };
    (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] = corrupt;
    assert.deepEqual(ownedActivitySnapshot(), { backgroundTasks: null, backgroundShells: null });
    assert.doesNotThrow(() => { shell.acquire("owned"); shell.release("owned"); shell.markUncertain(); });
    assert.doesNotThrow(() => activateOwnedActivity());
    assert.equal((globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY], corrupt);
  });

  it("contains a throwing process-local registry accessor and preserves the foreign property", () => {
    const getter = () => { throw Error("foreign observation failure"); };
    Object.defineProperty(globalThis, OWNED_ACTIVITY_STATE_KEY, { configurable: true, get: getter });
    assert.deepEqual(ownedActivitySnapshot(), { backgroundTasks: null, backgroundShells: null });
    assert.doesNotThrow(() => activateOwnedActivity());
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, OWNED_ACTIVITY_STATE_KEY)?.get, getter);
  });

  it("keeps registrations and tokens across reporter re-activation", () => {
    activateOwnedActivity();
    const shell = registerOwnedActivitySource(SHELLS, "background-shell");
    registerOwnedActivitySource(TASKS, "execution");
    registerOwnedActivitySource(TASKS, "review");
    shell.acquire("job-reload");

    // A reporter reload re-runs activation in the same native process. Sources
    // registered while active stay certain; only inert registrations replay as
    // unknown.
    activateOwnedActivity();
    assert.deepEqual(ownedActivitySnapshot(), { backgroundTasks: 0, backgroundShells: 1 });

    shell.release("job-reload");
    assert.equal(ownedActivitySnapshot().backgroundShells, 0);
  });
});

describe("owned-activity handle isolation", () => {
  beforeEach(() => {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
  });

  it("ignores mutations from a handle whose source was never installed", () => {
    activateOwnedActivity();
    const unknown = registerOwnedActivitySource(TASKS, "not-a-host-source") as OwnedActivitySourceHandle;
    registerOwnedActivitySource(TASKS, "execution");
    registerOwnedActivitySource(TASKS, "review");
    unknown.acquire("token");
    unknown.markUncertain();
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0, "an unknown source contributes nothing");
  });
});

describe("owned-activity activity-intent channel", () => {
  beforeEach(() => {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
  });

  afterEach(() => {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
  });

  it("stays positively known while ownership is uncertain, and releases on a stop", () => {
    activateOwnedActivity();
    const execution = registerOwnedActivitySource(TASKS, "execution");
    registerOwnedActivitySource(TASKS, "review");
    registerOwnedActivitySource(SHELLS, "background-shell");
    assert.deepEqual(activeActivitySnapshot(), { activeTasks: 0, activeShells: 0 });

    // A cleanup obligation alone is not activity.
    execution.acquire("task-1");
    assert.equal(activeActivitySnapshot().activeTasks, 0, "a retained ownership token is not activity");
    execution.acquireIntent("task-1");
    assert.equal(activeActivitySnapshot().activeTasks, 1);

    // Ownership uncertainty must not keep activity unknown once activity is known.
    execution.markUncertain();
    assert.equal(ownedActivitySnapshot().backgroundTasks, null);
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "ownership uncertainty never contaminates a positively known activity count");

    // A stop releases activity while ownership stays unknown/retained.
    execution.releaseIntent("task-1");
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "a stopped task releases activity even with uncertain ownership");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null);
  });

  it("keeps activity uncertainty independent and sticky until resolved", () => {
    activateOwnedActivity();
    const execution = registerOwnedActivitySource(TASKS, "execution");
    registerOwnedActivitySource(TASKS, "review");
    registerOwnedActivitySource(SHELLS, "background-shell");
    execution.resolveUncertainty();
    execution.markIntentUncertain();
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0, "ownership stays positively known");
    assert.equal(activeActivitySnapshot().activeTasks, null, "activity completeness is independent");
    execution.acquireIntent("task-2");
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "sticky activity uncertainty outranks an outstanding token");
    execution.resolveIntentUncertainty();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "only an authoritative re-establishment exposes the retained activity token");
  });

  it("scopes intent tokens to their own incarnation", () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    const older = registerOwnedActivitySource(TASKS, "review");
    older.acquireIntent("run-a");
    const current = registerOwnedActivitySource(TASKS, "review");
    current.acquireIntent("run-b");
    assert.equal(activeActivitySnapshot().activeTasks, 2,
      "superseded activity stays counted until it actually settles");
    older.releaseIntent("run-b");
    assert.equal(activeActivitySnapshot().activeTasks, 2,
      "a stale handle cannot release a newer incarnation's activity token");
    older.releaseIntent("run-a");
    assert.equal(activeActivitySnapshot().activeTasks, 1);
  });

  it("keeps old pre-intent global records valid for ownership and unknown for activity", () => {
    // A record written by an earlier code incarnation carries no intent data.
    const entry = (id: string, tokens: string[]) => ({ id, tokens: new Set(tokens), uncertain: false, retired: false });
    const oldState = {
      active: true,
      sources: new Map([
        [TASKS, new Map([
          ["execution", [entry("exec-old", ["task-old"])]],
          ["review", [entry("rev-old", [])]],
        ])],
        [SHELLS, new Map([["background-shell", [entry("sh-old", [])]]])],
      ]),
      listeners: new Set<() => void>(),
    };
    (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] = oldState;

    assert.deepEqual(ownedActivitySnapshot(), { backgroundTasks: 1, backgroundShells: 0 },
      "old ownership counts stay valid and usable");
    assert.deepEqual(activeActivitySnapshot(), { activeTasks: null, activeShells: null },
      "an unobserved pre-intent activity set is unknown, never a fabricated zero");
    assert.equal(isOwnedActivityActive(), true);

    // A new incarnation installs alongside the old record without wiping it.
    registerOwnedActivitySource(TASKS, "execution");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "the old ownership token is retained");
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "a pre-intent incarnation keeps the activity source genuinely unknown");
  });
});

describe("owned-activity authoritative intent refresh", () => {
  beforeEach(() => {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
  });

  afterEach(async () => {
    // Drain any pass scheduled by this test so it cannot bleed into the next
    // test's pass count.
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
  });

  it("recovers a pre-opt-in in-flight review at activation without a prompt or new task", async () => {
    // The review run begins while the registry is still inert (pre-opt-in), so
    // its acquisition was never observed. Activation must recover it from the
    // review module's own inventory — no fresh admission, prompt, or task.
    let execution: ReturnType<typeof registerOwnedActivitySource> | undefined;
    execution = registerOwnedActivitySource(TASKS, "execution", {
      resync: () => { execution?.resolveUncertainty(); },
      refreshActivity: () => ({ status: "complete", intentTokens: new Set<string>() }),
    } as unknown as Parameters<typeof registerOwnedActivitySource>[2]);
    const run = beginOwnedReviewActivity();
    assert.deepEqual(ownedActivitySnapshot(), { backgroundTasks: null, backgroundShells: null });

    activateOwnedActivity();
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1,
      "the replayed registration's resync re-acquires the in-flight run");
    assert.equal(activeActivitySnapshot().activeTasks, 1, "activity recovers too");

    endOwnedReviewActivity(run);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0);
    assert.equal(activeActivitySnapshot().activeTasks, 0);
  });

  it("recovers a deliberately stale registry from the review source's own inventory", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    registerReviewActivitySource();
    const run = beginOwnedReviewActivity();
    assert.equal(activeActivitySnapshot().activeTasks, 1);

    // The registry telemetry diverges from the source's own state: the review
    // module still knows its in-flight run, but the registry is uncertain.
    assert.ok(ownedActivityTest.markCurrentSourceIntentUncertainForTests(TASKS, "review"),
      "the exact current incarnation is marked uncertain");
    assert.equal(activeActivitySnapshot().activeTasks, null, "the stale registry publishes unknown");

    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the pass recovers the exact nonzero value from the source's own state");

    endOwnedReviewActivity(run);
    assert.equal(activeActivitySnapshot().activeTasks, 0);
  });

  it("replaces obsolete tokens with the source's exact inventory on a complete refresh", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    registerOwnedActivitySource(TASKS, "review");
    const shell = registerOwnedActivitySource(SHELLS, "background-shell", {
      refreshActivity: () => ({ status: "complete", intentTokens: new Set(["job-real"]) }),
    });
    shell.acquireIntent("job-stale");
    shell.markIntentUncertain();
    assert.equal(activeActivitySnapshot().activeShells, null);

    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeShells, 1,
      "the exact current inventory replaces the stale token");

    shell.releaseIntent("job-real");
    assert.equal(activeActivitySnapshot().activeShells, 0);
  });

  it("keeps an incomplete refresher unknown without retrying or fabricating zero", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    registerOwnedActivitySource(TASKS, "review");
    const shell = registerOwnedActivitySource(SHELLS, "background-shell", {
      refreshActivity: () => ({ status: "incomplete" }),
    });
    shell.markIntentUncertain();
    assert.equal(activeActivitySnapshot().activeShells, null);

    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(ownedActivityTest.ownedActivityIntentRefreshPassCount(), 1, "one coalesced pass");
    assert.equal(activeActivitySnapshot().activeShells, null, "incomplete stays unknown, never zero");

    // No retry loop: an incomplete result schedules nothing further.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ownedActivityTest.ownedActivityIntentRefreshPassCount(), 1, "no automatic retry");

    shell.resolveIntentUncertainty();
    assert.equal(activeActivitySnapshot().activeShells, 0);
  });

  it("coalesces uncertainty that appears mid-pass into exactly one follow-up pass", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    const review = registerOwnedActivitySource(TASKS, "review", {
      refreshActivity: () => ({ status: "complete", intentTokens: new Set<string>() }),
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const shell = registerOwnedActivitySource(SHELLS, "background-shell", {
      refreshActivity: async () => {
        await firstGate;
        return { status: "complete", intentTokens: new Set<string>() };
      },
    });
    shell.markIntentUncertain();
    const pass = refreshOwnedActivityIntent(); // explicit pass, in flight
    review.markIntentUncertain(); // appears while the pass is in flight
    releaseFirst();
    await pass;
    assert.equal(ownedActivityTest.ownedActivityIntentRefreshPassCount(), 1);
    assert.equal(activeActivitySnapshot().activeShells, 0, "the first candidate recovered");
    assert.equal(activeActivitySnapshot().activeTasks, null, "the mid-pass uncertainty is still unknown");

    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(ownedActivityTest.ownedActivityIntentRefreshPassCount(), 2, "exactly one follow-up pass");
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the follow-up recovers the second source");
  });

  it("fences a stale refresh result when the incarnation is retired mid-pass", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const older = registerOwnedActivitySource(TASKS, "review", {
      refreshActivity: async () => {
        await gate;
        return { status: "complete", intentTokens: new Set(["run-old"]) };
      },
    });
    older.acquireIntent("run-stale");
    older.markIntentUncertain();
    const retiredView = rawTaskEntry("review");
    const intentRevisionBefore = retiredView.intentRevision!;
    assert.equal(typeof intentRevisionBefore, "number",
      "a new incarnation carries the independent intent fence from birth");
    const revisionBefore = retiredView.revision;
    const pass = refreshOwnedActivityIntent();
    // A newer incarnation supersedes the candidate before its result arrives.
    registerOwnedActivitySource(TASKS, "review");
    assert.equal(retiredView.intentRevision, intentRevisionBefore + 1,
      "source replacement advances the retired incarnation's intent fence");
    assert.ok(retiredView.revision > revisionBefore, "and its common revision");
    release();
    await pass;
    assert.equal(older.retired, true);
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "the stale result is fenced: the retired candidate stays unknown");

    older.releaseIntent("run-stale");
    older.resolveIntentUncertainty();
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the retired incarnation settles through its own handle");
  });

  it("recovers activity when a throwing resync left the source incomplete", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    registerOwnedActivitySource(TASKS, "review");
    const shell = registerOwnedActivitySource(SHELLS, "background-shell", {
      resync: () => { throw new Error("source cannot prove its state"); },
      refreshActivity: () => ({ status: "complete", intentTokens: new Set<string>() }),
    });
    assert.equal(ownedActivitySnapshot().backgroundShells, null, "ownership stays unknown");
    assert.equal(activeActivitySnapshot().activeShells, null,
      "a throwing resync marks the activity channel incomplete too — never a fabricated zero");

    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeShells, 0,
      "the authoritative refresher re-establishes the exact zero");
  });

  it("revalidates each result immediately before applying it", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const review = registerOwnedActivitySource(TASKS, "review", {
      refreshActivity: async () => {
        await firstGate;
        return { status: "complete", intentTokens: new Set<string>() };
      },
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const shell = registerOwnedActivitySource(SHELLS, "background-shell", {
      refreshActivity: async () => {
        await secondGate;
        return { status: "complete", intentTokens: new Set<string>() };
      },
    });
    review.markIntentUncertain();
    shell.markIntentUncertain();
    const pass = refreshOwnedActivityIntent();
    releaseFirst();
    // Let the first worker finish its fence check (microtasks drain first).
    await new Promise((resolve) => setImmediate(resolve));
    // The first source acquires new work AFTER its result was fenced but
    // BEFORE the apply loop runs (the second worker is still pending).
    review.acquireIntent("run-late");
    releaseSecond();
    await pass;
    assert.equal(activeActivitySnapshot().activeShells, 0, "the second source's fresh result applies");
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "the first source's stale result is revalidated at apply time and rejected");
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the follow-up pass recovers the changed source from its own inventory");
  });

  it("schedules a follow-up when new uncertainty arrives during an auto-scheduled pass", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const shell = registerOwnedActivitySource(SHELLS, "background-shell", {
      refreshActivity: async () => {
        await gate;
        return { status: "complete", intentTokens: new Set<string>() };
      },
    });
    shell.markIntentUncertain(); // schedules the coalesced pass
    // Let the auto-scheduled pass start; it blocks on the gate.
    await new Promise((resolve) => setImmediate(resolve));
    const review = registerOwnedActivitySource(TASKS, "review", {
      refreshActivity: () => ({ status: "complete", intentTokens: new Set<string>() }),
    });
    review.markIntentUncertain(); // arrives while the pass is in flight
    release();
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(ownedActivityTest.ownedActivityIntentRefreshPassCount(), 2, "exactly one follow-up pass");
    assert.equal(activeActivitySnapshot().activeShells, 0);
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the mid-pass uncertainty is recovered");
  });

  it("recovers a source registered uncertain while a pass is in flight", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const shell = registerOwnedActivitySource(SHELLS, "background-shell", {
      refreshActivity: async () => {
        await gate;
        return { status: "complete", intentTokens: new Set<string>() };
      },
    });
    shell.markIntentUncertain();
    await new Promise((resolve) => setImmediate(resolve)); // pass now in flight, blocked
    registerOwnedActivitySource(TASKS, "review", {
      intentUncertain: true,
      refreshActivity: () => ({ status: "complete", intentTokens: new Set<string>() }),
    });
    release();
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(ownedActivityTest.ownedActivityIntentRefreshPassCount(), 2, "exactly one follow-up pass");
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the mid-pass registration is recovered");
  });

  it("recovers a retired source's retained uncertain inventory through its own refresher", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    const older = registerOwnedActivitySource(TASKS, "review", {
      refreshActivity: () => ({ status: "complete", intentTokens: new Set(["run-retained"]) }),
    });
    older.acquireIntent("run-retained");
    older.markIntentUncertain();
    // Source replacement retires the uncertain incarnation; its retained work is
    // only provable by its own source state, never by the newer source's emptiness.
    registerOwnedActivitySource(TASKS, "review");
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "retired uncertainty keeps the category unknown");
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the retired incarnation's exact inventory is recovered through its own refresher");
    older.releaseIntent("run-retained");
    assert.equal(activeActivitySnapshot().activeTasks, 0, "later settlement releases the retained token");
  });

  it("awaits an already-running refresh pass before returning", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const shell = registerOwnedActivitySource(SHELLS, "background-shell", {
      refreshActivity: async () => {
        await gate;
        return { status: "complete", intentTokens: new Set<string>() };
      },
    });
    shell.markIntentUncertain();
    await new Promise((resolve) => setImmediate(resolve)); // auto-scheduled pass in flight, blocked
    const pass = refreshOwnedActivityIntent(); // must coalesce onto the in-flight pass
    assert.equal(activeActivitySnapshot().activeShells, null, "still unknown while blocked");
    release();
    await pass;
    assert.equal(activeActivitySnapshot().activeShells, 0, "the awaited pass settled before returning");
  });

  it("retains an older pre-opt-in incarnation's work when a newer same-name source registers", async () => {
    // The older incarnation holds real work in its own state: its resync
    // re-acquires the token and its refresher proves the exact inventory.
    const oldWork = "old-work";
    let older: OwnedActivitySourceHandle | undefined;
    older = registerOwnedActivitySource(TASKS, "execution", {
      resync: () => { older?.acquireIntent(oldWork); },
      refreshActivity: () => ({ status: "complete", intentTokens: new Set([oldWork]) }),
    } as unknown as Parameters<typeof registerOwnedActivitySource>[2]);
    // A newer same-name incarnation with an authoritatively empty inventory.
    registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => ({ status: "complete", intentTokens: new Set<string>() }),
    });
    registerReviewActivitySource();

    activateOwnedActivity();
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the older incarnation's held work survives the newer empty registration");
  });

  it("keeps older incomplete pre-opt-in evidence unknown despite a newer empty same-name source", async () => {
    // The older incarnation cannot prove its inventory.
    registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => ({ status: "incomplete" }),
    });
    // A newer same-name incarnation that is authoritatively empty.
    registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => ({ status: "complete", intentTokens: new Set<string>() }),
    });
    registerReviewActivitySource();

    activateOwnedActivity();
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "newer emptiness is not proof that the older incarnation's work is absent");
  });

  it("keeps a retired proven-empty observation as proof across repeated forced reload passes", async () => {
    activateOwnedActivity();
    // A previously exact-proven, sealed, quiescent empty incarnation. A
    // current-only callback would fail for a retired handle; a forced reload
    // pass must therefore leave this proof alone instead of degrading it.
    let retiredRefreshCalls = 0;
    const resolvedOld = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => {
        retiredRefreshCalls += 1;
        return { status: "incomplete" };
      },
    });
    registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => ({ status: "complete", intentTokens: new Set<string>() }),
    });
    registerReviewActivitySource();
    resolvedOld.resolveIntentUncertainty();
    assert.equal(resolvedOld.retired, true, "the newer incarnation retired the old one");
    assert.equal(activeActivitySnapshot().activeTasks, 0);

    // Repeated full reload/replacement passes: the resolved old emptiness stays
    // the exact proof it already was and is never re-driven.
    for (let pass = 0; pass < 3; pass += 1) {
      await refreshOwnedActivityIntent();
      assert.equal(activeActivitySnapshot().activeTasks, 0,
        `forced pass ${pass + 1} keeps the exact proven zero`);
    }
    assert.equal(retiredRefreshCalls, 0, "a resolved retired incarnation is not re-read by a forced pass");
  });

  it("forces an uncertain retained owner through its own proof and never through replacement emptiness", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "review");
    let proveEmpty = false;
    const unproven = registerOwnedActivitySource(TASKS, "execution", {
      intentUncertain: true,
      refreshActivity: () => (proveEmpty
        ? { status: "complete", intentTokens: new Set<string>() }
        : { status: "incomplete" }),
    });
    unproven.acquireIntent("execution-live");
    const replacement = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => ({ status: "complete", intentTokens: new Set<string>() }),
    });
    replacement.resolveIntentUncertainty();
    assert.equal(unproven.retired, true);
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "retained old intent is never cleared by a newer source's emptiness");

    // A forced reload pass re-drives the exact uncertain owner; while it cannot
    // prove itself the channel stays unknown even though the replacement is a
    // known empty source.
    for (let pass = 0; pass < 2; pass += 1) {
      await refreshOwnedActivityIntent();
      assert.equal(activeActivitySnapshot().activeTasks, null,
        `forced pass ${pass + 1} keeps the unproven old owner unknown`);
    }

    // Only its own complete proof resolves it (here: its work actually stopped).
    proveEmpty = true;
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the exact old owner's own complete proof establishes the truth");
  });

  it("re-drives a retained positive retired owner to its own truth, never to replacement emptiness", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "review");
    let inventory: "positive" | "empty" | "unreadable" = "positive";
    const retainedOwner = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => {
        if (inventory === "empty") return { status: "complete", intentTokens: new Set<string>() };
        if (inventory === "unreadable") return { status: "incomplete" };
        return { status: "complete", intentTokens: new Set(["execution-run"]) };
      },
    });
    retainedOwner.acquireIntent("execution-run");
    retainedOwner.resolveIntentUncertainty();
    const replacement = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => ({ status: "complete", intentTokens: new Set<string>() }),
    });
    replacement.resolveIntentUncertainty();
    assert.equal(retainedOwner.retired, true);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the retained positive is initially known");

    // The registry telemetry keeps claiming a known value; only the exact old
    // owner can prove its retained work actually settled.
    inventory = "empty";
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the exact owner's complete empty proof establishes zero, not replacement emptiness");
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 0, "a repeated pass keeps that proven zero");

    // A retained positive whose canonical inventory becomes unreadable must not
    // stay falsely known.
    retainedOwner.acquireIntent("execution-run");
    assert.equal(activeActivitySnapshot().activeTasks, 1, "a retained positive is known again");
    inventory = "unreadable";
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "an unreadable retained inventory invalidates the cached positive to unknown");
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, null, "repeated passes stay unknown");

    // The same owner recovering its inventory establishes the real truth again.
    inventory = "positive";
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the reachable exact-owner inventory restores the real nonzero value");
  });

  it("replays resync after every install so no intermediate observation reports zero", async () => {
    // A source that starts empty and whose resync establishes busy work.
    let handle: OwnedActivitySourceHandle | undefined;
    handle = registerOwnedActivitySource(TASKS, "execution", {
      resync: () => { handle?.acquireIntent("busy-work"); },
      refreshActivity: () => ({ status: "complete", intentTokens: new Set(["busy-work"]) }),
    } as unknown as Parameters<typeof registerOwnedActivitySource>[2]);
    registerReviewActivitySource();

    activateOwnedActivity();
    // Production-timing subscriber: the reporter subscribes right after
    // activation, before the coalesced pass runs.
    const observed: Array<number | null> = [];
    const unsubscribe = subscribeOwnedActivity(() => { observed.push(activeActivitySnapshot().activeTasks); });
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    unsubscribe();
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the resynced busy work is known");
    assert.ok(!observed.includes(0),
      `no observation may report zero: ${JSON.stringify(observed)}`);
  });

  it("preserves authoritative current intent when an ownership-only mutation races a forced pass", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "review");
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalEntered!: () => void;
    const readEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const execution = registerOwnedActivitySource(TASKS, "execution", {
      // The canonical owning source knows one real task.
      refreshActivity: async () => {
        signalEntered();
        await readGate;
        return { status: "complete" as const, intentTokens: new Set(["task-1"]) };
      },
    });
    const entry = rawTaskEntry("execution");
    // The registry's derived set is poisoned to a "known" zero. Only a fresh
    // authoritative read can repair it — and an ownership-only observation
    // must never be the reason that repair is thrown away.
    assert.deepEqual([...entry.intentTokens], [], "the poisoned mirror holds no token");
    assert.equal(entry.intentUncertain, false, "the poisoned mirror claims a known value");
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the poisoned known zero before the pass");
    const revisionBefore = entry.revision;
    const intentRevisionBefore = entry.intentRevision;

    const pass = refreshOwnedActivityIntent();
    await readEntered;
    // Ownership-only mutation while the canonical read is in flight: a cleanup
    // anchor is admitted. It moves cleanup accounting, not activity intent.
    execution.acquire("new-cleanup-obligation");
    assert.equal(entry.revision, revisionBefore + 1, "the ownership channel advances the common revision");
    assert.equal(entry.intentRevision, intentRevisionBefore,
      "an ownership-only mutation never advances the independent intent fence");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "the cleanup anchor is owned");

    releaseRead();
    await pass;
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the fresh complete read is committed despite the ownership-only race");
    assert.deepEqual([...entry.intentTokens], ["task-1"], "the real authoritative inventory replaced the poison");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "cleanup ownership is untouched by the intent commit");

    execution.release("new-cleanup-obligation");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "settling cleanup never releases actual activity");
  });

  it("rejects a stale source count when an actual intent admission races the forced pass", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "review");
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalEntered!: () => void;
    const readEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const execution = registerOwnedActivitySource(TASKS, "execution", {
      // The captured read says "nothing admitted" — already stale once work starts.
      refreshActivity: async () => {
        signalEntered();
        await readGate;
        return { status: "complete" as const, intentTokens: new Set<string>() };
      },
    });
    const entry = rawTaskEntry("execution");
    execution.acquireIntent("task-real");
    assert.equal(activeActivitySnapshot().activeTasks, 1);
    const intentRevisionBefore = entry.intentRevision!;
    assert.equal(typeof intentRevisionBefore, "number",
      "a new incarnation carries the independent intent fence from birth");

    const pass = refreshOwnedActivityIntent();
    await readEntered;
    // A REAL activity admission during the read advances the intent fence.
    execution.acquireIntent("task-racing-admission");
    assert.equal(entry.intentRevision, intentRevisionBefore + 1,
      "an actual intent mutation advances the independent intent fence");
    assert.equal(activeActivitySnapshot().activeTasks, 2, "the admission publishes immediately");

    releaseRead();
    await pass;
    assert.equal(activeActivitySnapshot().activeTasks, 2,
      "the stale empty count is rejected and the current real work is preserved");
    assert.deepEqual([...entry.intentTokens].sort(), ["task-racing-admission", "task-real"]);
  });

  it("rejects a stale nonzero source count when the work's own release races the forced pass", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "review");
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalEntered!: () => void;
    const readEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const execution = registerOwnedActivitySource(TASKS, "execution", {
      // The captured read still counts the task that settles below.
      refreshActivity: async () => {
        signalEntered();
        await readGate;
        return { status: "complete" as const, intentTokens: new Set(["task-1"]) };
      },
    });
    execution.acquireIntent("task-1");
    assert.equal(activeActivitySnapshot().activeTasks, 1);

    const pass = refreshOwnedActivityIntent();
    await readEntered;
    execution.releaseIntent("task-1"); // the task's own observed stop
    assert.equal(activeActivitySnapshot().activeTasks, 0);

    releaseRead();
    await pass;
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the stale census never resurrects settled work");
  });

  it("keeps an established authoritative intent count through pure ownership uncertainty", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "review");
    const execution = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => ({ status: "complete", intentTokens: new Set(["task-live"]) }),
    });
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the source's own inventory establishes the count");

    // Ownership-only events: raised uncertainty, an admitted cleanup anchor, and
    // its later settlement. None of them is activity evidence.
    execution.markUncertain();
    assert.equal(ownedActivitySnapshot().backgroundTasks, null);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "ownership uncertainty never poisons current intent");
    execution.acquire("cleanup-anchor");
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "a forced pass still commits the source's own current inventory");
    execution.release("cleanup-anchor");
    execution.resolveUncertainty();
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0, "ownership accounting settles independently");
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the running task is never released by cleanup accounting");
  });

  it("fences a legacy reload record by its common revision and re-reads it once", async () => {
    // A record written by an earlier code incarnation carries no independent
    // intent fence, and a closure from that module copy can advance only the
    // common revision — even for an ownership-only observation. Such a record
    // must therefore stay fenced by the common revision (fail closed): the
    // ambiguous read is discarded (never committed) and exactly one bounded fresh
    // pass re-reads the owner under a stable fence.
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalEntered!: () => void;
    const readEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const legacyEntry = (id: string, extra: Partial<LegacyRegistryRecord> = {}): LegacyRegistryRecord => ({
      id,
      tokens: new Set<string>(),
      uncertain: false,
      retired: false,
      intentTokens: new Set<string>(), // poisoned known zero
      intentUncertain: false,
      revision: 0,
      ...extra,
    });
    const legacyExecution = legacyEntry("exec-legacy", {
      refreshActivity: async () => {
        signalEntered();
        await readGate;
        return { status: "complete" as const, intentTokens: new Set(["task-real"]) };
      },
    });
    (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] = {
      active: true,
      sources: new Map([
        [TASKS, new Map([
          ["execution", [legacyExecution]],
          ["review", [legacyEntry("rev-legacy")]],
        ])],
        [SHELLS, new Map([["background-shell", [legacyEntry("sh-legacy")]]])],
      ]),
      listeners: new Set<() => void>(),
    };
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the legacy record's poisoned known zero");
    let reads = 0;
    legacyExecution.refreshActivity = async () => {
      reads += 1;
      if (reads === 1) { signalEntered(); await readGate; }
      return { status: "complete" as const, intentTokens: new Set([reads === 1 ? "task-stale" : "task-real"]) };
    };

    const pass = refreshOwnedActivityIntent();
    await readEntered;
    // The older module copy's ownership-only closure advances only `revision`.
    legacyExecution.revision += 1;
    releaseRead();
    await pass;
    assert.equal(reads, 2,
      "the ambiguous legacy read is discarded and one bounded fresh pass re-reads the owner");
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the stable legacy fence then commits fresh authoritative inventory, never the cached poison");
    assert.deepEqual([...legacyExecution.intentTokens], ["task-real"],
      "the discarded read's stale token is never committed");
  });

  it("supersedes an obsolete held read so the initiating refresh reads the healthy replacement", async () => {
    // The probe shape, in its normal multi-source configuration: the real review
    // source (with its own immediate refresher) is captured alongside a held
    // execution read. Replacing execution fences only that read out; it must not
    // block the already-usable review outcome, and the ORIGINAL refresh call must
    // establish the healthy replacement's inventory before returning.
    activateOwnedActivity();
    registerReviewActivitySource();
    let releaseOldRead!: () => void;
    const oldReadGate = new Promise<void>((resolve) => { releaseOldRead = resolve; });
    let signalOldRead!: () => void;
    const oldReadEntered = new Promise<void>((resolve) => { signalOldRead = resolve; });
    const older = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: async () => {
        signalOldRead();
        await oldReadGate; // an obsolete read that answers only after the test ends
        return { status: "complete" as const, intentTokens: new Set(["obsolete-task"]) };
      },
    });
    const original = refreshOwnedActivityIntent();
    await oldReadEntered;

    // A healthy replacement becomes the current incarnation; the old owner is
    // retired with an advanced intent fence, so its pending read can publish
    // nothing.
    const healthy = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => ({ status: "complete", intentTokens: new Set(["healthy-task"]) }),
    });
    assert.equal(older.retired, true);
    const oldFence = rawTaskEntry("execution", 0).intentRevision;

    // The original refresh settles and establishes the healthy current inventory
    // BEFORE the obsolete callback is released.
    await original;
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the healthy current owner's fresh complete inventory is read and committed");
    assert.deepEqual([...rawTaskEntry("execution", 1).intentTokens], ["healthy-task"]);
    assert.deepEqual([...rawTaskEntry("execution", 0).intentTokens], [],
      "the retired proven-empty owner stays empty");
    assert.equal(healthy.retired, false);

    // Later explicit requests stay healthy too.
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 1);

    // Releasing the obsolete read changes nothing: its late result is rejected.
    releaseOldRead();
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the late obsolete result never resurrects its token");
    assert.deepEqual([...rawTaskEntry("execution", 0).intentTokens], [],
      "and never writes to the retired owner");
    assert.equal(rawTaskEntry("execution", 0).intentRevision, oldFence,
      "the retired owner's fence is untouched by its own late read");
  });

  it("supersedes an obsolete held read for a healthy replacement that proves an exact zero", async () => {
    activateOwnedActivity();
    registerReviewActivitySource();
    let releaseOldRead!: () => void;
    const oldReadGate = new Promise<void>((resolve) => { releaseOldRead = resolve; });
    let signalOldRead!: () => void;
    const oldReadEntered = new Promise<void>((resolve) => { signalOldRead = resolve; });
    registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: async () => {
        signalOldRead();
        await oldReadGate;
        return { status: "complete" as const, intentTokens: new Set(["obsolete-task"]) };
      },
    });
    const original = refreshOwnedActivityIntent();
    await oldReadEntered;

    registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => ({ status: "complete", intentTokens: new Set<string>() }),
    });
    await original;
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the healthy replacement's authoritative empty inventory is committed, never blocked");

    releaseOldRead();
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the late obsolete nonzero result cannot resurrect settled inventory");
  });

  it("never certifies cached poison when a readiness change fences the only fresh proof", async () => {    activateOwnedActivity();
    registerReviewActivitySource();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalEntered!: () => void;
    const readEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let reads = 0;
    const execution = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: async () => {
        reads += 1;
        if (reads === 1) { signalEntered(); await readGate; }
        return { status: "complete" as const, intentTokens: new Set(["task-1"]) };
      },
    });
    // The registry claims a poisoned known zero while the source owns real work.
    assert.equal(activeActivitySnapshot().activeTasks, 0);

    const pass = refreshOwnedActivityIntent();
    await readEntered;
    // A readiness/lifecycle generation change during the read is NOT an
    // authoritative intent observation: the fenced read is not proof of current
    // intent, and the explicit refresh must never return the cached wrong zero.
    execution.requestIntentRefresh();
    releaseRead();
    await pass;
    assert.notEqual(activeActivitySnapshot().activeTasks, 0,
      "the explicit refresh never certifies the cached known zero");
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "one bounded fresh pass establishes the source's actual inventory");
    assert.equal(reads, 2, "the readiness-fenced read is discarded and re-read once");
    assert.deepEqual([...rawTaskEntry("execution").intentTokens], ["task-1"]);
  });

  it("releases a finite read deadline so the same owner's next healthy read can complete", async () => {
    // A first call to the owner's own refresher never answers and no unrelated
    // generation event arrives. The pass's finite read deadline must release only
    // that ephemeral lease: the channel becomes truthfully unknown, the SAME owner
    // is re-read by the caller's own bounded fresh pass, and a queued explicit
    // request completes too. The late answer is never committed.
    activateOwnedActivity();
    registerReviewActivitySource();
    ownedActivityTest.setIntentRefreshReadDeadlineForTests(25);
    let calls = 0;
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    let signalFirstRead!: () => void;
    const firstReadEntered = new Promise<void>((resolve) => { signalFirstRead = resolve; });
    const execution = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: async () => {
        calls += 1;
        if (calls === 1) {
          signalFirstRead();
          await firstReadGate; // never answers before the deadline
          return { status: "complete" as const, intentTokens: new Set(["late-obsolete-task"]) };
        }
        return { status: "complete" as const, intentTokens: new Set(["task-real"]) };
      },
    });
    execution.acquire("cleanup-owner");
    // The registry's derived set is a poisoned known zero before the read.
    assert.equal(activeActivitySnapshot().activeTasks, 0);

    const first = refreshOwnedActivityIntent();
    await firstReadEntered;
    const queued = refreshOwnedActivityIntent(); // queued while the old read is held

    await Promise.all([first, queued]);
    assert.ok(calls >= 2, `the same owner was re-read after the deadline (calls=${calls})`);
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the healthy read committed the real authoritative inventory");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "real ownership is untouched");

    // The late reply of the timed-out read must never commit.
    releaseFirstRead();
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the late timed-out result is rejected");
    assert.deepEqual([...rawTaskEntry("execution").intentTokens], ["task-real"],
      "only the healthy read's inventory is committed");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
  });

  it("releases a finite read deadline so a healthy empty read establishes zero", async () => {
    activateOwnedActivity();
    registerReviewActivitySource();
    ownedActivityTest.setIntentRefreshReadDeadlineForTests(25);
    let calls = 0;
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    let signalFirstRead!: () => void;
    const firstReadEntered = new Promise<void>((resolve) => { signalFirstRead = resolve; });
    const execution = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: async () => {
        calls += 1;
        if (calls === 1) {
          signalFirstRead();
          await firstReadGate;
          return { status: "complete" as const, intentTokens: new Set(["late-obsolete-task"]) };
        }
        return { status: "complete" as const, intentTokens: new Set<string>() };
      },
    });
    execution.acquire("cleanup-owner");
    execution.acquireIntent("task-ghost"); // poisoned known positive before the read
    assert.equal(activeActivitySnapshot().activeTasks, 1);

    const first = refreshOwnedActivityIntent();
    await firstReadEntered;
    await first;
    assert.ok(calls >= 2, `the same owner was re-read after the deadline (calls=${calls})`);
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the healthy empty read established the exact zero");

    releaseFirstRead();
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the late nonzero reply cannot resurrect work");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "ownership is unchanged throughout");
  });

  it("does not retry a non-responding source endlessly and stays truthfully unknown", async () => {
    activateOwnedActivity();
    registerReviewActivitySource();
    ownedActivityTest.setIntentRefreshReadDeadlineForTests(20);
    let calls = 0;
    const execution = registerOwnedActivitySource(TASKS, "execution", {
      // Never answers: only the finite read deadline can release the lease.
      refreshActivity: () => {
        calls += 1;
        return new Promise<never>(() => undefined);
      },
    });
    execution.acquire("cleanup-owner");
    execution.acquireIntent("task-ghost"); // a cached value that must not survive as proof
    assert.equal(activeActivitySnapshot().activeTasks, 1);

    await refreshOwnedActivityIntent();
    assert.equal(calls, 2, "the finite deadline allows exactly one re-read, never an endless retry");
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "a source that cannot answer leaves its channel truthfully unknown, never a cached count");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "ownership is untouched by the expired read");

    // Repeated explicit requests stay bounded and never fabricate a value.
    const before = calls;
    await refreshOwnedActivityIntent();
    assert.ok(calls > before, "a later explicit request may re-read the same owner");
    assert.equal(activeActivitySnapshot().activeTasks, null);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
  });

  it("fences an admission during missing-cache recovery instead of rebuilding a stale empty set", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    registerReviewActivitySource();
    // A held shell read keeps the pass open after the review inventory was read.
    let releaseShellRead!: () => void;
    const shellGate = new Promise<void>((resolve) => { releaseShellRead = resolve; });
    let signalShellRead!: () => void;
    const shellEntered = new Promise<void>((resolve) => { signalShellRead = resolve; });
    registerOwnedActivitySource(SHELLS, "background-shell", {
      refreshActivity: async () => {
        signalShellRead();
        await shellGate;
        return { status: "complete" as const, intentTokens: new Set<string>() };
      },
    });
    const reviewEntry = rawTaskEntry("review");
    delete (reviewEntry as unknown as { intentTokens?: Set<string> }).intentTokens;
    assert.equal(activeActivitySnapshot().activeTasks, null, "the lost cache is unknown");

    const pass = refreshOwnedActivityIntent();
    await shellEntered; // the review's (empty) inventory has been captured

    // A real review admission during recovery: the captured empty inventory is
    // now obsolete, and an incremental event must never rebuild the missing Set.
    const run = beginOwnedReviewActivity();
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "the missing-cache channel stays unknown, never an incrementally rebuilt value");

    releaseShellRead();
    await pass;
    assert.notEqual(activeActivitySnapshot().activeTasks, 0,
      "the stale empty inventory never commits as a known zero");

    // Authoritative recovery from the review source's own inventory re-establishes
    // the live run; ownership is intact throughout.
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the live review is established from its own authoritative inventory");
    assert.deepEqual([...rawTaskEntry("review").intentTokens], [run]);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "the review's ownership token is intact");

    endOwnedReviewActivity(run);
    assert.equal(activeActivitySnapshot().activeTasks, 0);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0);
  });

  it("fences a release during missing-cache recovery instead of rebuilding a stale positive set", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "execution");
    registerReviewActivitySource();
    const run = beginOwnedReviewActivity();
    assert.equal(activeActivitySnapshot().activeTasks, 1);
    let releaseShellRead!: () => void;
    const shellGate = new Promise<void>((resolve) => { releaseShellRead = resolve; });
    let signalShellRead!: () => void;
    const shellEntered = new Promise<void>((resolve) => { signalShellRead = resolve; });
    registerOwnedActivitySource(SHELLS, "background-shell", {
      refreshActivity: async () => {
        signalShellRead();
        await shellGate;
        return { status: "complete" as const, intentTokens: new Set<string>() };
      },
    });
    const reviewEntry = rawTaskEntry("review");
    delete (reviewEntry as unknown as { intentTokens?: Set<string> }).intentTokens;

    const pass = refreshOwnedActivityIntent();
    await shellEntered; // the review's positive inventory has been captured
    endOwnedReviewActivity(run); // the work actually stopped during recovery

    releaseShellRead();
    await pass;
    assert.notEqual(activeActivitySnapshot().activeTasks, 1,
      "the stale positive inventory never commits as still-running work");

    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "authoritative recovery establishes the stopped inventory");
    assert.deepEqual([...rawTaskEntry("review").intentTokens], []);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0,
      "the run's own settlement released its ownership");
  });

  it("preserves a newer authoritative observation when an unrelated read expires", async () => {
    activateOwnedActivity();
    registerReviewActivitySource();
    ownedActivityTest.setIntentRefreshReadDeadlineForTests(25);
    let executionCalls = 0;
    let releaseExecutionFirst!: () => void;
    const executionGate = new Promise<void>((resolve) => { releaseExecutionFirst = resolve; });
    let signalExecutionFirst!: () => void;
    const executionEntered = new Promise<void>((resolve) => { signalExecutionFirst = resolve; });
    registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: async () => {
        executionCalls += 1;
        if (executionCalls === 1) {
          signalExecutionFirst();
          await executionGate;
          return { status: "complete" as const, intentTokens: new Set<string>() };
        }
        return { status: "complete" as const, intentTokens: new Set<string>() };
      },
    });
    let shellInventory: string[] = ["job-live"];
    let shellCalls = 0;
    let releaseShellFirst!: () => void;
    const shellGate = new Promise<void>((resolve) => { releaseShellFirst = resolve; });
    const shell = registerOwnedActivitySource(SHELLS, "background-shell", {
      refreshActivity: async () => {
        shellCalls += 1;
        // Only the first (obsolete) read is held past the deadline; the bounded
        // fresh pass afterwards reads the owner's real inventory immediately.
        if (shellCalls === 1) await shellGate;
        return { status: "complete" as const, intentTokens: new Set(shellInventory) };
      },
    });
    shell.acquireIntent("job-live");
    assert.equal(activeActivitySnapshot().activeShells, 1);

    const seen: Array<{ shells: number | null; shellUncertain: boolean; shellTokens: string[] }> = [];
    const unsubscribe = subscribeOwnedActivity(() => {
      const entry = rawSourceEntry(SHELLS, "background-shell");
      seen.push({
        shells: activeActivitySnapshot().activeShells,
        shellUncertain: entry.intentUncertain === true,
        shellTokens: [...entry.intentTokens],
      });
    });

    const pass = refreshOwnedActivityIntent();
    await executionEntered; // both reads are now pending
    // A newer AUTHORITATIVE shell observation while its own read is obsolete.
    shell.acquireIntent("job-second");
    shellInventory = ["job-live", "job-second"];

    // The finite deadline expires while execution is still pending: the obsolete
    // shell read must never invalidate the newer known observation.
    await pass;
    assert.ok(seen.length > 0, "the expiry published a derived change");
    assert.ok(seen.every((snapshot) => snapshot.shellUncertain === false),
      `no expiry may poison the shell channel: ${JSON.stringify(seen)}`);
    assert.ok(seen.every((snapshot) => snapshot.shellTokens.includes("job-live")),
      `the newer shell tokens are never dropped: ${JSON.stringify(seen)}`);
    assert.equal(activeActivitySnapshot().activeShells, 2,
      "the shell's newer authoritative observation stays known");
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the expired execution read was re-read once and truthfully established");

    // Late replies of the expired reads can never overwrite the newer state.
    releaseExecutionFirst();
    releaseShellFirst();
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    unsubscribe();
    assert.equal(activeActivitySnapshot().activeShells, 2);
    assert.equal(activeActivitySnapshot().activeTasks, 0);
    assert.deepEqual([...rawSourceEntry(SHELLS, "background-shell").intentTokens].sort(),
      ["job-live", "job-second"]);
  });

  it("marks a timed-out retired owner's cached positive unknown and preserves its tokens", async () => {
    // A retired incarnation with retained positive intent stays a forced-refresh
    // candidate; when its own callback never answers, its cached count is not
    // fresh proof. The expired read under its still-current fence becomes unknown
    // while its retained tokens and ownership are never cleared.
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "review");
    ownedActivityTest.setIntentRefreshReadDeadlineForTests(25);
    let releaseOldRead!: () => void;
    const oldReadGate = new Promise<void>((resolve) => { releaseOldRead = resolve; });
    let oldReads = 0;
    const older = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: async () => {
        oldReads += 1;
        await oldReadGate; // never answers before the finite deadlines
        return { status: "complete" as const, intentTokens: new Set(["task-old"]) };
      },
    });
    older.acquireIntent("task-old");
    older.acquire("cleanup-owner");
    assert.equal(activeActivitySnapshot().activeTasks, 1);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);

    // A healthy empty replacement retires the old owner; its retained positive
    // intent remains its only proof.
    registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => ({ status: "complete", intentTokens: new Set<string>() }),
    });
    assert.equal(older.retired, true);

    await refreshOwnedActivityIntent();
    assert.ok(oldReads >= 2, `the finite deadline allowed its bounded re-read (reads=${oldReads})`);
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "a timed-out read under the retired owner's own fence is not fresh proof");
    assert.deepEqual([...rawTaskEntry("execution", 0).intentTokens], ["task-old"],
      "retained intent tokens are never cleared");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "retained ownership is untouched");

    // Let the coalesced follow-up settle (it also expires) BEFORE releasing the
    // held replies, so every late reply belongs to a finished pass.
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, null);

    releaseOldRead();
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, null, "late replies cannot publish a count");
    assert.deepEqual([...rawTaskEntry("execution", 0).intentTokens], ["task-old"]);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
  });

  it("rebuilds a lost derived intent cache from the owning source's complete inventory", async () => {
    activateOwnedActivity();
    registerReviewActivitySource();
    let inventory: string[] = ["task-real"];
    let reads = 0;
    const execution = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => {
        reads += 1;
        return { status: "complete", intentTokens: new Set(inventory) };
      },
    });
    // A cleanup obligation that must survive every rebuild untouched.
    execution.acquire("cleanup-owner");
    const entry = rawTaskEntry("execution");
    const incarnation = entry.id;

    // Lose ONLY the derived ephemeral cache: identity, ownership, and the
    // authoritative refresher all stay intact (the confirmed probe shape).
    const dropCache = (): void => {
      delete (entry as unknown as { intentTokens?: Set<string> }).intentTokens;
    };
    dropCache();
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "a lost derived cache is unknown, never a fabricated zero");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "ownership is untouched by the lost cache");

    await refreshOwnedActivityIntent();
    assert.equal(reads, 1, "the live owning source is asked despite the missing cache");
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the complete exact-owning read rebuilt the derived intent set");
    assert.deepEqual([...rawTaskEntry("execution").intentTokens], ["task-real"]);
    assert.equal(rawTaskEntry("execution").id, incarnation, "the exact incarnation identity is preserved");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "the protected ownership token is untouched");

    // Repeated loss, including an authoritative empty inventory and a larger one.
    for (const [nextInventory, expected] of [[[], 0], [["task-a", "task-b"], 2]] as const) {
      inventory = [...nextInventory];
      dropCache();
      assert.equal(activeActivitySnapshot().activeTasks, null, "each lost cache starts unknown");
      await refreshOwnedActivityIntent();
      assert.equal(activeActivitySnapshot().activeTasks, expected,
        `the source's own current inventory rebuilds ${expected}`);
      await refreshOwnedActivityIntent();
      assert.equal(activeActivitySnapshot().activeTasks, expected, "repeated explicit passes keep the rebuilt value");
      assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "ownership still settles only through its own owner");
    }
    assert.equal(rawTaskEntry("execution").id, incarnation, "no rebuild replaces the incarnation");
  });

  for (const scenario of [
    { label: "an actual zero inventory", inventory: [] as readonly string[], expected: 0 },
    { label: "an actual nonzero inventory", inventory: ["task-real"] as readonly string[], expected: 1 },
  ]) {
    it(`recovers a lost-cache incomplete read from readiness alone (${scenario.label})`, async () => {
      await assertLostCacheIncompleteReadRecoversFromReadiness(scenario.inventory);
      assert.equal(activeActivitySnapshot().activeTasks, scenario.expected);
    });
  }

  it("marks a lost-cache timed-out read uncertain so the same owner can still prove its inventory", async () => {
    // The finite deadline releases only the ephemeral read lease. A
    // callback-bearing record whose derived cache is lost must then be
    // refreshably uncertain (never a fabricated set or a cached value), so its
    // own later authoritative read can establish the real inventory.
    activateOwnedActivity();
    registerReviewActivitySource();
    ownedActivityTest.setIntentRefreshReadDeadlineForTests(25);
    let healthy = false;
    let calls = 0;
    const execution = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: () => {
        calls += 1;
        if (!healthy) return new Promise<never>(() => undefined); // never answers
        return { status: "complete" as const, intentTokens: new Set(["task-real"]) };
      },
    });
    execution.acquire("cleanup-owner");
    const entry = rawTaskEntry("execution");
    delete (entry as unknown as { intentTokens?: Set<string> }).intentTokens;
    assert.equal(activeActivitySnapshot().activeTasks, null);

    await refreshOwnedActivityIntent();
    assert.ok(calls >= 2, `the finite deadline allows one bounded re-read (calls=${calls})`);
    assert.equal(entry.intentUncertain, true, "the expired read marks the missing-cache channel uncertain");
    assert.equal(entry.intentTokens, undefined, "the expiry never fabricates a derived set");
    assert.equal(activeActivitySnapshot().activeTasks, null, "never a cached or fabricated count");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "ownership is untouched by the expired read");

    healthy = true;
    execution.requestIntentRefresh();
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "readiness alone lets the owner establish its real inventory");
    assert.deepEqual([...rawTaskEntry("execution").intentTokens!], ["task-real"]);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
  });

  it("marks a lost-cache readiness-fenced read unproven and rebuilds it from the owner", async () => {
    activateOwnedActivity();
    registerReviewActivitySource();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalEntered!: () => void;
    const readEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let reads = 0;
    const execution = registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: async () => {
        reads += 1;
        if (reads === 1) { signalEntered(); await readGate; }
        return { status: "complete" as const, intentTokens: new Set(["task-real"]) };
      },
    });
    execution.acquire("cleanup-owner");
    const entry = rawTaskEntry("execution");
    delete (entry as unknown as { intentTokens?: Set<string> }).intentTokens;
    assert.equal(activeActivitySnapshot().activeTasks, null);

    const pass = refreshOwnedActivityIntent();
    await readEntered;
    // A readiness/lifecycle generation change is not an authoritative intent
    // observation: the fenced read is discarded. For a missing-cache record that
    // discard IS an unproven activity channel, not a silent no-op.
    execution.requestIntentRefresh();
    releaseRead();
    await pass;
    assert.equal(reads, 2,
      "the readiness-fenced lost-cache read is unproven, so the initiator re-reads the owner once");
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the bounded fresh pass rebuilds the real inventory from the owner");
    assert.deepEqual([...rawTaskEntry("execution").intentTokens!], ["task-real"]);
    assert.equal(rawTaskEntry("execution").intentUncertain, false, "the rebuilt inventory is known");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "ownership is unchanged throughout");

    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 1, "later coalesced passes keep the recovered value");
  });

  it("marks a lost-cache legacy-fence discard unproven so its fresh pass can rebuild it", async () => {
    // A record written by an earlier code incarnation keeps the common-revision
    // fence. When its missing derived cache makes a read ambiguous (an older
    // copy's ownership-only closure advanced the fence), the channel must fall
    // back to truthful unknown — with the refresher still able to rebuild it —
    // instead of silently staying an unproven legacy unknown.
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalEntered!: () => void;
    const readEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const legacyEntry = (id: string): Record<string, unknown> => ({
      id,
      tokens: new Set<string>(),
      uncertain: false,
      retired: false,
      intentTokens: new Set<string>(),
      intentUncertain: false,
      revision: 0,
    });
    const legacyExecution: Record<string, unknown> = legacyEntry("exec-legacy-lost-cache");
    // Only the derived cache is missing; the refresher is authoritative.
    delete legacyExecution.intentTokens;
    (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] = {
      active: true,
      sources: new Map([
        [TASKS, new Map([
          ["execution", [legacyExecution]],
          ["review", [legacyEntry("rev-legacy-lost-cache")]],
        ])],
        [SHELLS, new Map([["background-shell", [legacyEntry("sh-legacy-lost-cache")]]])],
      ]),
      listeners: new Set<() => void>(),
    };
    let reads = 0;
    legacyExecution.refreshActivity = async () => {
      reads += 1;
      if (reads === 1) { signalEntered(); await readGate; }
      return { status: "complete" as const, intentTokens: new Set(["task-real"]) };
    };
    assert.equal(activeActivitySnapshot().activeTasks, null, "the missing cache is unknown");

    const pass = refreshOwnedActivityIntent();
    await readEntered;
    // The older module copy's ownership-only closure advances only `revision`.
    legacyExecution.revision = (legacyExecution.revision as number) + 1;
    releaseRead();
    await pass;
    assert.equal(reads, 2,
      "the ambiguous lost-cache read is discarded and one bounded fresh pass re-reads the owner");
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the stable fence then rebuilds the real authoritative inventory");
    assert.deepEqual([...(legacyExecution.intentTokens as Set<string>)], ["task-real"]);
    assert.equal(legacyExecution.intentUncertain, false, "the rebuilt inventory is authoritatively known");
    assert.deepEqual([...(legacyExecution.tokens as Set<string>)], [],
      "the ownership channel is untouched by activity recovery");
  });

  it("keeps a no-callback legacy record intent-unknown without fabricating history", async () => {
    // A pre-intent reload record carries no authoritative refresher, so no
    // current inventory can ever prove it: it stays unknown, its ownership is
    // retained, and no derived set/history is invented for it.
    const legacyExecution = {
      id: "exec-no-callback",
      tokens: new Set(["legacy-owner"]),
      uncertain: false,
      retired: false,
      revision: 0,
    };
    const review = {
      id: "rev-no-callback",
      tokens: new Set<string>(),
      uncertain: false,
      retired: false,
      intentTokens: new Set<string>(),
      intentUncertain: false,
      revision: 0,
    };
    const shell = {
      id: "sh-no-callback",
      tokens: new Set<string>(),
      uncertain: false,
      retired: false,
      intentTokens: new Set<string>(),
      intentUncertain: false,
      revision: 0,
    };
    (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] = {
      active: true,
      sources: new Map([
        [TASKS, new Map([["execution", [legacyExecution]], ["review", [review]]])],
        [SHELLS, new Map([["background-shell", [shell]]])],
      ]),
      listeners: new Set<() => void>(),
    };

    assert.equal(activeActivitySnapshot().activeTasks, null, "no callback: activity is unknown");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "its retained ownership stays valid");
    for (let pass = 0; pass < 2; pass += 1) {
      await refreshOwnedActivityIntent();
      assert.equal(activeActivitySnapshot().activeTasks, null,
        `explicit pass ${pass + 1} cannot invent a value for a record with no authoritative callback`);
      assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "ownership is never cleared by activity refresh");
      assert.equal("intentTokens" in legacyExecution, false, "no derived history is fabricated for the legacy record");
    }
    assert.equal("intentUncertain" in legacyExecution, false,
      "a record that can never prove its own inventory is left entirely untouched");
  });

  it("still coalesces fresh requests onto a still-current in-flight read", async () => {
    activateOwnedActivity();
    registerOwnedActivitySource(TASKS, "review");
    let calls = 0;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalEntered!: () => void;
    const readEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    registerOwnedActivitySource(TASKS, "execution", {
      refreshActivity: async () => {
        calls += 1;
        signalEntered();
        await readGate;
        return { status: "complete" as const, intentTokens: new Set(["task-live"]) };
      },
    });
    const first = refreshOwnedActivityIntent();
    await readEntered;
    const second = refreshOwnedActivityIntent();
    // Give the second request every chance to start a duplicate read.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, "a still-current read is awaited, never duplicated or superseded");

    releaseRead();
    await Promise.all([first, second]);
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "both requests settle onto the same still-current inventory");
  });
});
