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
