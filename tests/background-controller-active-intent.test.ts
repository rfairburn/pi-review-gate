/**
 * Focused controller-level regressions for the ACTIVITY-INTENT channel
 * (src/execution/background-controller.ts) added for #339.
 *
 * The pure predicate is exercised directly, and real controllers (with no
 * worker capacity, so nothing ever dispatches) cover the lifecycle sequence the
 * feature exists for: Start/queued is activity, a stopped/paused/failed task is
 * NOT activity even while the conservative ownership channel still reports the
 * retained cleanup/recovery anchor, an admitted Continue is activity while a
 * rejected or duplicate one publishes nothing, an executing force-merge is
 * activity, and an idle conflict gate is not. No executor process, PTY, or shell
 * is spawned.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BackgroundExecutionController,
  taskHasActiveIntent,
  type BackgroundExecutionGroup,
  type BackgroundTaskRecord,
} from "../src/execution/background-controller";
import { transitionTaskState } from "../src/execution/task-state";
import { createState } from "../src/state";
import {
  beginOwnedReviewActivity,
  endOwnedReviewActivity,
  registerReviewActivitySource,
  __test as reviewActivityTest,
} from "../src/activation/review-activity";
import {
  OWNED_ACTIVITY_STATE_KEY,
  activateOwnedActivity,
  activeActivitySnapshot,
  ownedActivitySnapshot,
  refreshOwnedActivityIntent,
  registerOwnedActivitySource,
  subscribeOwnedActivity,
  type OwnedActivityIntentRefresh,
  __test as ownedActivityTest,
} from "../src/session-host/owned-activity";
import { boundedScalingConfig, initGitRepo, settleOldestUnsettled } from "./helpers/background-controller-fixtures";

type IntentObservation = { active: number | null; owned: number | null };
const observed: IntentObservation[] = [];

test("activity-intent predicate counts admitted/running work but not retained cleanup", () => {
  for (const state of ["queued", "capturing", "running", "reviewing", "accepted", "waiting_to_land", "landing"] as const) {
    assert.equal(taskHasActiveIntent({ state }, false), true, `${state} is activity`);
  }
  for (const state of [
    "landed",
    "reported",
    "failed",
    "interrupted",
    "conflicted",
    "paused_recoverable",
    "stopped_for_application_exit",
  ] as const) {
    assert.equal(taskHasActiveIntent({ state }, false), false, `${state} is not activity`);
  }
  // Retained cleanup anchors (a resumable bundle/wave/generation) are not part of
  // this predicate at all; only admitted work and real operations count. A
  // pending continuation VALIDATION is not activity either: only the accepted,
  // queued transition counts (covered by the controller regressions below).
  assert.equal(taskHasActiveIntent({ state: "failed" }, true), true, "an executing force-merge is activity");
  assert.equal(taskHasActiveIntent({ state: "landed" }, true), true);
});

test("Start, stop/failure, Continue, and force-merge move activity intent independently of ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    // Opt in before the controller lifecycle so both channels install directly
    // and a clean restore authoritatively establishes zero.
    activateOwnedActivity();
    registerReviewActivitySource();
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      pendingForceMerges: Map<string, unknown>;
      syncActiveIntent: (task: BackgroundTaskRecord) => void;
      save: (group: BackgroundExecutionGroup) => Promise<unknown>;
    };
    assert.equal(activeActivitySnapshot().activeTasks, 0, "a clean restore establishes zero activity");

    // Start: accepted/queued work counts immediately, before any dispatch.
    const started = await controller.start([{
      title: "intent target",
      instructions: "do the thing",
      acceptanceCriteria: ["done"],
    }]);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "queued work counts immediately");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);

    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    assert.equal(task.state, "queued");

    // Give the task a durable recovery anchor, then stop it: activity must fall
    // to zero while the conservative ownership channel stays positive.
    task.waveRoot = join(root, "retained-wave");
    task.generation = 1;
    await internals.save(group);
    transitionTaskState(task, "failed");
    await internals.save(group);
    assert.equal(activeActivitySnapshot().activeTasks, 0, "a failed task is not activity");
    assert.equal(
      ownedActivitySnapshot().backgroundTasks,
      1,
      "the retained ownership anchor is unchanged and still gates a stop",
    );

    // A rejected Continue (no durable bundle) leaves the count at zero, and the
    // validation window must never publish a positive intent value.
    observed.length = 0;
    const unsubscribeRejected = subscribeOwnedActivity(() => {
      observed.push({ active: activeActivitySnapshot().activeTasks, owned: ownedActivitySnapshot().backgroundTasks });
    });
    await assert.rejects(controller.continueTask({
      executionId: group.executionId,
      taskId: task.taskId,
      instructions: "finish",
      instructionId: "intent-rejected-continue",
      actor: "user",
    }));
    unsubscribeRejected();
    assert.equal(activeActivitySnapshot().activeTasks, 0, "a rejected Continue stays zero");
    assert.ok(
      observed.every((entry) => entry.active === null || entry.active <= 0),
      `a rejected Continue never publishes positive activity during validation: ${JSON.stringify(observed)}`,
    );

    // An admitted Continue returns the task to queued activity.
    task.bundle = {
      version: 1,
      operationId: "op-intent",
      waveId: "wave-intent",
      taskId: task.taskId,
      waveRoot: join(root, "wave-intent"),
      expectedRevision: 1,
    };
    await internals.save(group);
    assert.equal(activeActivitySnapshot().activeTasks, 0, "a resumable bundle anchor alone is not activity");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
    const continued = await controller.continueTask({
      executionId: group.executionId,
      taskId: task.taskId,
      instructions: "finish",
      instructionId: "intent-admitted-continue",
      actor: "user",
    });
    assert.equal(continued.tasks[0]?.state, "queued");
    assert.equal(activeActivitySnapshot().activeTasks, 1, "an admitted Continue counts");

    // A duplicate replay of the admitted instruction is refused by the active
    // guard and neither strands nor doubles the count.
    await assert.rejects(controller.continueTask({
      executionId: group.executionId,
      taskId: task.taskId,
      instructions: "finish",
      instructionId: "intent-admitted-continue",
      actor: "user",
    }), /already active/);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "a duplicate Continue leaves activity exactly once");

    // An admitted Continue that then fails releases activity again.
    transitionTaskState(task, "failed");
    await internals.save(group);
    assert.equal(activeActivitySnapshot().activeTasks, 0, "a failed admitted continuation releases activity");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);

    // An idle conflict gate with no active writer is not activity.
    transitionTaskState(task, "conflicted");
    await internals.save(group);
    assert.equal(activeActivitySnapshot().activeTasks, 0, "an idle conflict gate is not activity");

    // An actual force-merge operation is activity while it executes, even though
    // the task's terminal state has not changed.
    internals.pendingForceMerges.set(task.taskId, { abort: new AbortController(), done: Promise.resolve(), acquired: false });
    internals.syncActiveIntent(task);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "an executing force-merge counts");
    internals.pendingForceMerges.delete(task.taskId);
    internals.syncActiveIntent(task);
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the settled force-merge releases activity");

    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected archive-only Continue publishes no activity and leaves ownership unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-archive-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root, {});
    activateOwnedActivity();
    registerReviewActivitySource();
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    const internals = controller as unknown as { groups: Map<string, BackgroundExecutionGroup> };
    const started = await controller.start([{ title: "archive seed", instructions: "seed", acceptanceCriteria: ["done"] }]);
    const archivedTaskId = started.tasks[0]!.taskId;
    for (let index = 0; index < 33; index += 1) {
      await controller.add(started.executionId, [{ title: `filler ${index + 1}`, instructions: "work", acceptanceCriteria: ["done"] }]);
      await settleOldestUnsettled(controller, started.executionId, `settle ${index + 1}`);
    }
    assert.equal(internals.groups.get(started.executionId)!.tasks.some((candidate) => candidate.taskId === archivedTaskId), false,
      "the seed record is archive-only");
    const beforeActive = activeActivitySnapshot().activeTasks;
    const beforeOwned = ownedActivitySnapshot().backgroundTasks;

    observed.length = 0;
    const unsubscribe = subscribeOwnedActivity(() => {
      observed.push({ active: activeActivitySnapshot().activeTasks, owned: ownedActivitySnapshot().backgroundTasks });
    });
    const rejected = {
      executionId: started.executionId,
      taskId: archivedTaskId,
      instructions: "resume",
      instructionId: "archive-only-rejected",
      actor: "user" as const,
    };
    await assert.rejects(controller.continueTask(rejected), /has no durable continuation bundle/);
    // An idempotent replay of the same rejected admission must also stay silent.
    await assert.rejects(controller.continueTask(rejected), /has no durable continuation bundle/);
    unsubscribe();

    assert.equal(activeActivitySnapshot().activeTasks, beforeActive,
      "a rejected archive-only Continue does not change activity");
    assert.equal(ownedActivitySnapshot().backgroundTasks, beforeOwned,
      "ownership is unchanged by the refusal");
    assert.ok(
      observed.every((entry) => entry.active === null || beforeActive === null || entry.active <= beforeActive),
      `an archive-only refusal never publishes positive activity: ${JSON.stringify(observed)}`,
    );
    assert.equal(internals.groups.get(started.executionId)!.tasks.some((candidate) => candidate.taskId === archivedTaskId), false,
      "the archive-only record is never inserted inline");
    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed restore keeps ownership unknown while a fresh runtime reports truthful idle activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-restore-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    activateOwnedActivity();
    registerReviewActivitySource();
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    const pending = controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    assert.equal(activeActivitySnapshot().activeTasks, null, "a restore invalidates activity completeness before its first await");
    await pending;
    assert.equal(activeActivitySnapshot().activeTasks, 0);
    // A claimed root this restore cannot read attached no group: it is a
    // retained cleanup-ownership obligation, not work the CURRENT runtime
    // admitted or resumed. Activity therefore stays a truthful known zero while
    // ownership stays separately fail-closed (unknown, never zero).
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [join(root, "missing-group-root")] });
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "an unreadable historical root cannot manufacture current-runtime activity");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "the same unreadable root keeps cleanup ownership unknown, never zero");
    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stopped task with a failed cleanup-association recovery reports zero activity, not unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-recovery-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    activateOwnedActivity();
    registerReviewActivitySource();
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      save: (group: BackgroundExecutionGroup) => Promise<unknown>;
    };
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const started = await controller.start([{ title: "recovery", instructions: "work", acceptanceCriteria: ["done"] }]);
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    // A stopped task whose retained cleanup association cannot be recovered:
    // ownership must stay unknown, but its observed stopped state is not activity.
    transitionTaskState(task, "stopped_for_application_exit");
    task.waveRoot = join(root, "missing-wave-root");
    task.generation = 1;
    await internals.save(group);
    const associations = controller.associations();
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: associations.groupRoots });
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "an unresolved cleanup association keeps ownership unknown");
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "a known stopped task reports zero activity even when ownership recovery failed");
    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

/** The live execution source entry in the global registry state (test corruption seam). */
function currentExecutionEntry(): {
  intentTokens: Set<string>;
  intentUncertain?: boolean;
  refreshActivity?: () => Promise<OwnedActivityIntentRefresh> | OwnedActivityIntentRefresh;
} {
  const registry = (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] as {
    sources: Map<string, Map<string, Array<{
      retired: boolean;
      intentTokens?: Set<string>;
      intentUncertain?: boolean;
      refreshActivity?: () => Promise<OwnedActivityIntentRefresh> | OwnedActivityIntentRefresh;
    }>>>;
  };
  const entry = registry.sources.get("backgroundTasks")!.get("execution")!
    .find((candidate) => !candidate.retired)!;
  assert.ok(entry.intentTokens, "the execution source carries intent data");
  return entry as {
    intentTokens: Set<string>;
    intentUncertain?: boolean;
    refreshActivity?: () => Promise<OwnedActivityIntentRefresh> | OwnedActivityIntentRefresh;
  };
}

test("a corrupted registry token set recovers to the exact census inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-corrupt-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    activateOwnedActivity();
    registerReviewActivitySource();
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });

    // Idle: the registry entry carries a stale token the source never held.
    currentExecutionEntry().intentTokens.add("execution:stale");
    assert.ok(ownedActivityTest.markCurrentSourceIntentUncertainForTests("backgroundTasks", "execution"));
    assert.equal(activeActivitySnapshot().activeTasks, null, "the corrupted entry publishes unknown");
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the exact idle census replaces the corrupted token set — never a stale positive");

    // Running: the registry loses the real token while work is held.
    const started = await controller.start([{
      title: "corrupt target",
      instructions: "work",
      acceptanceCriteria: ["done"],
    }]);
    assert.equal(activeActivitySnapshot().activeTasks, 1);
    currentExecutionEntry().intentTokens.clear();
    assert.ok(ownedActivityTest.markCurrentSourceIntentUncertainForTests("backgroundTasks", "execution"));
    assert.equal(activeActivitySnapshot().activeTasks, null);
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the census restores the exact running token the registry lost");
    void started;

    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed session generation keeps the authoritative refresh fail-closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-generation-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    let currentCwd = root;
    activateOwnedActivity();
    registerReviewActivitySource();
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => currentCwd,
    });
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const started = await controller.start([{
      title: "generation target",
      instructions: "work",
      acceptanceCriteria: ["done"],
    }]);
    assert.equal(activeActivitySnapshot().activeTasks, 1);

    // The session generation moved: the census must refuse to speak for a
    // different cwd rather than publish a stale or fabricated value.
    currentCwd = join(root, "elsewhere");
    assert.ok(ownedActivityTest.markCurrentSourceIntentUncertainForTests("backgroundTasks", "execution"));
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "a stale-generation census is incomplete — unknown, never zero");

    // A later genuine readiness observation (the session returns) recovers it.
    currentCwd = root;
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the recovered generation publishes the exact value again");
    void started;

    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a settling save recovers diverged registry telemetry without an explicit refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-savetail-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    activateOwnedActivity();
    registerReviewActivitySource();
    // Gateable save fault seam: while the gate is held, every save tail stays pending.
    let saveGate: Promise<void> | undefined;
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
      faults: { save: async () => { await saveGate; } },
    });
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      save: (group: BackgroundExecutionGroup) => Promise<unknown>;
    };

    // Held work: a queued task is positively known.
    const started = await controller.start([{
      title: "save-tail target",
      instructions: "work",
      acceptanceCriteria: ["done"],
    }]);
    assert.equal(activeActivitySnapshot().activeTasks, 1);
    const group = internals.groups.get(started.executionId)!;

    // Hold an unchanged group's save: the automatic pass must come back incomplete.
    let releaseSave!: () => void;
    saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const heldSave = internals.save(group);
    void heldSave.catch(() => undefined);
    assert.ok(ownedActivityTest.markCurrentSourceIntentUncertainForTests("backgroundTasks", "execution"));
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "a pending save tail keeps the census incomplete — unknown, never zero");
    const passesAfterIncomplete = ownedActivityTest.ownedActivityIntentRefreshPassCount();

    // Incomplete alone does not retry.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ownedActivityTest.ownedActivityIntentRefreshPassCount(), passesAfterIncomplete,
      "an incomplete result schedules no retry");

    // The save settles: the genuine readiness observation retries automatically.
    releaseSave();
    saveGate = undefined;
    await heldSave;
    await new Promise((resolve) => setImmediate(resolve)); // let the tail's settle hook schedule
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the settled save recovers the exact held work without an explicit refresh");

    // Stopped work: the same readiness observation recovers an exact zero.
    const task = group.tasks[0]!;
    transitionTaskState(task, "failed");
    await internals.save(group);
    assert.equal(activeActivitySnapshot().activeTasks, 0);
    let releaseSave2!: () => void;
    saveGate = new Promise<void>((resolve) => { releaseSave2 = resolve; });
    const heldSave2 = internals.save(group);
    void heldSave2.catch(() => undefined);
    assert.ok(ownedActivityTest.markCurrentSourceIntentUncertainForTests("backgroundTasks", "execution"));
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "the pending save tail keeps the stopped-work census incomplete too");
    releaseSave2();
    saveGate = undefined;
    await heldSave2;
    await new Promise((resolve) => setImmediate(resolve));
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the settled save recovers the exact zero without an explicit refresh");

    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale execution census result is fenced by its own freshness predicate at apply time", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-commit-race-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    let currentCwd = root;
    activateOwnedActivity();
    registerReviewActivitySource();
    // Gateable census fault seam: holds the execution census mid-read.
    let censusGate: Promise<void> | undefined;
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => currentCwd,
      faults: { currentActivityCensus: async () => { await censusGate; } },
    });
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      save: (group: BackgroundExecutionGroup) => Promise<unknown>;
    };
    const started = await controller.start([{
      title: "commit race target",
      instructions: "work",
      acceptanceCriteria: ["done"],
    }]);
    assert.equal(activeActivitySnapshot().activeTasks, 1);

    // A second source with a gated refresher keeps the apply loop pending.
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const shell = registerOwnedActivitySource("backgroundShells", "background-shell", {
      refreshActivity: async () => {
        await secondGate;
        return { status: "complete", intentTokens: new Set<string>() };
      },
    });
    shell.markIntentUncertain();
    assert.ok(ownedActivityTest.markCurrentSourceIntentUncertainForTests("backgroundTasks", "execution"));

    // Observe the execution refresher's completion so the session change lands
    // AFTER the census finished (past its own final fence) but BEFORE the
    // apply loop runs while the second source is still pending.
    const executionEntry = currentExecutionEntry();
    assert.ok(executionEntry.refreshActivity !== undefined, "the execution source carries a refresher");
    const originalRefresher = executionEntry.refreshActivity!;
    let censusResult: OwnedActivityIntentRefresh | undefined;
    let resolveCensusDone!: () => void;
    const censusDone = new Promise<void>((resolve) => { resolveCensusDone = resolve; });
    executionEntry.refreshActivity = async () => {
      censusResult = await originalRefresher();
      resolveCensusDone();
      return censusResult;
    };

    let releaseCensus!: () => void;
    censusGate = new Promise<void>((resolve) => { releaseCensus = resolve; });
    const pass = refreshOwnedActivityIntent();
    releaseCensus();
    await censusDone;
    assert.equal(censusResult?.status, "complete", "the census finished complete before the session change");

    // The session generation moves AFTER the census finished but BEFORE the
    // apply loop runs: no registry mutation happens, so only the owning
    // source's freshness predicate can reject the stale result.
    currentCwd = join(root, "elsewhere");
    releaseSecond();
    await pass;
    assert.equal(activeActivitySnapshot().activeShells, 0, "the second source's fresh result applies");
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "the stale execution census is rejected by its own freshness predicate");

    // A later genuine readiness observation recovers the actual inventory.
    currentCwd = root;
    const group = internals.groups.get(started.executionId)!;
    await internals.save(group);
    await new Promise((resolve) => setImmediate(resolve));
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the genuine readiness observation recovers the exact inventory");

    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a diverged registry recovers from the controller's own census without source-local uncertainty", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-divergence-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    activateOwnedActivity();
    registerReviewActivitySource();
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      save: (group: BackgroundExecutionGroup) => Promise<unknown>;
      activityIntentTokens?: unknown;
      activityIntentUncertain?: unknown;
    };
    const started = await controller.start([{
      title: "divergence target",
      instructions: "do the thing",
      acceptanceCriteria: ["done"],
    }]);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "queued work is positively known");

    // The registry telemetry diverges from the source's own state: the loaded
    // registry entry is uncertain, while the controller keeps NO source-side
    // telemetry mirror to disagree with (or to "repair" the source from).
    // Recovery must come from the source's authoritative read-only census.
    assert.equal("activityIntentUncertain" in internals, false,
      "the controller keeps no source-local intent-uncertainty mirror");
    assert.equal("activityIntentTokens" in internals, false,
      "the controller keeps no source-local intent-token mirror");
    assert.ok(ownedActivityTest.markCurrentSourceIntentUncertainForTests("backgroundTasks", "execution"),
      "the exact current incarnation is marked uncertain");
    assert.equal(activeActivitySnapshot().activeTasks, null, "the diverged registry publishes unknown");

    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the census reconstructs the exact nonzero value from the source's own state");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);

    // The zero case: with no active work, the same recovery establishes an exact zero.
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    transitionTaskState(task, "failed");
    await internals.save(group);
    assert.equal(activeActivitySnapshot().activeTasks, 0);
    assert.ok(ownedActivityTest.markCurrentSourceIntentUncertainForTests("backgroundTasks", "execution"));
    assert.equal(activeActivitySnapshot().activeTasks, null);
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the census reconstructs the exact zero, never a fabricated one");

    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a restored saved conversation without historical groupRoots stays truthfully idle, then counts real work repeatedly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-restored-no-roots-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    activateOwnedActivity();
    registerReviewActivitySource();
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      save: (group: BackgroundExecutionGroup) => Promise<unknown>;
    };
    // Exactly the production shape of a restored session-state snapshot whose
    // optional `groupRoots` field is absent: no historical roster is claimed.
    // The prior runtime's idle/busy/unknown/unreadable history is NOT this
    // runtime's activity — restoration attaches no old process and replays no
    // prior busy/unknown value.
    await controller.restore({ waveRoots: [], bundles: [] });
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "a runtime that admitted and resumed nothing starts as a known idle zero");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "an absent historical roster cannot prove an empty owned set: ownership stays fail-closed");

    // The reporter's explicit startup/reconnect refresh is a forced fresh pass
    // and must confirm (never manufacture) that truthful zero.
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the forced fresh pass confirms the exact zero");

    // First real work after the historical path counts immediately and settles
    // back to the known zero.
    const first = await controller.start([{ title: "first", instructions: "work", acceptanceCriteria: ["done"] }]);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the first admission after the historical path counts");
    await settleOldestUnsettled(controller, first.executionId, "first settled");
    assert.equal(activeActivitySnapshot().activeTasks, 0, "settlement returns to the known zero");

    // Repeated work: a second admission plus a prompt-driven automatic review
    // both count, and each settles independently.
    const second = await controller.start([{ title: "second", instructions: "work", acceptanceCriteria: ["done"] }]);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the second admission counts too");
    const reviewRun = beginOwnedReviewActivity();
    assert.equal(activeActivitySnapshot().activeTasks, 2, "a running automatic review counts alongside the task");
    endOwnedReviewActivity(reviewRun);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the finished review releases only its own intent");
    await settleOldestUnsettled(controller, second.executionId, "second settled");
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the second settlement is a known zero again");

    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 0, "repeated forced passes keep the exact zero");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "activity recovery never fabricates an ownership resolution for historical absence");
    void internals;
    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit refresh repeatedly recovers poisoned registry telemetry to the real value", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-poison-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    activateOwnedActivity();
    registerReviewActivitySource();
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      activityIntentTokens?: unknown;
      activityIntentUncertain?: unknown;
      currentActivityCensusInFlight?: unknown;
      currentActivityCensusDirty?: unknown;
    };
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    assert.equal(activeActivitySnapshot().activeTasks, 0);

    // There is exactly ONE derived activity-telemetry representation: the
    // registry's incarnation-scoped intent set. The controller keeps no token
    // mirror, no uncertainty boolean, and no second census scheduler/publication
    // queue that could diverge from it.
    for (const removed of [
      "activityIntentTokens",
      "activityIntentUncertain",
      "currentActivityCensusInFlight",
      "currentActivityCensusDirty",
    ]) {
      assert.equal(removed in internals, false,
        `the controller keeps no redundant source-side ${removed} telemetry/scheduler state`);
    }

    // Poison the canonical registry telemetry while the real work inventory is
    // untouched: the entry claims a known (wrong) token set, so no automatic
    // pass can be trusted to repair it — only a forced fresh source read can.
    const poisonRegistry = (registryTokens: string[]): void => {
      const entry = currentExecutionEntry();
      entry.intentTokens.clear();
      for (const token of registryTokens) entry.intentTokens.add(token);
      entry.intentUncertain = false;
    };

    const started = await controller.start([{ title: "poison target", instructions: "work", acceptanceCriteria: ["done"] }]);
    assert.equal(activeActivitySnapshot().activeTasks, 1);
    const ownedAfterStart = ownedActivitySnapshot().backgroundTasks;
    assert.equal(ownedAfterStart, 1, "the ownership channel independently counts the admitted work");

    // Nonzero: a lost real token reads as a fabricated zero, an injected token
    // set reads as a fabricated positive. Both recover to the actual 1.
    poisonRegistry([]);
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the poisoned registry under-reports the real work");
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the forced fresh pass restores the real nonzero value");
    poisonRegistry(["execution:ghost-1", "execution:ghost-2"]);
    assert.equal(activeActivitySnapshot().activeTasks, 2, "the poisoned registry over-reports");
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 1, "a repeated fresh pass restores the same real value");
    assert.equal(ownedActivitySnapshot().backgroundTasks, ownedAfterStart,
      "intent recovery never rewrites the independent ownership channel");

    // Zero: the same poisoning repeatedly recovers to the actual zero.
    await settleOldestUnsettled(controller, started.executionId, "poison target settled");
    assert.equal(activeActivitySnapshot().activeTasks, 0);
    const ownedAfterSettlement = ownedActivitySnapshot().backgroundTasks;
    for (const injected of [["execution:ghost-zero"], ["execution:ghost-a", "execution:ghost-b", "execution:ghost-c"]]) {
      poisonRegistry(injected);
      assert.ok((activeActivitySnapshot().activeTasks ?? 0) > 0, "the poisoned registry claims idle work");
      await refreshOwnedActivityIntent();
      assert.equal(activeActivitySnapshot().activeTasks, 0,
        "every fresh pass independently recovers the exact zero, never a fabricated one");
      assert.equal(ownedActivitySnapshot().backgroundTasks, ownedAfterSettlement,
        "repeated intent recovery leaves ownership untouched");
    }
    // The same recovery holds regardless of what the telemetry claims: a stale
    // known registry set is not trusted either. Only the source's canonical
    // work inventory decides, so repeated fresh passes stay exact.
    const staleEntry = currentExecutionEntry();
    staleEntry.intentTokens.clear();
    staleEntry.intentTokens.add("execution:ghost-stale");
    staleEntry.intentUncertain = false;
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the stale registry claims a known positive");
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the fresh pass establishes the real zero regardless of the stale telemetry claim");
    // The source itself carries no counter to poison: its bookkeeping is the
    // canonical controller runtime state that the read-only census derives.
    assert.equal(currentExecutionEntry().intentTokens.size, 0,
      "the single canonical registry set now holds the exact zero");
    void internals.groups;
    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh census that cannot read its own current record invalidates activity, then recovers repeatedly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-unreadable-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    activateOwnedActivity();
    registerReviewActivitySource();
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    const internals = controller as unknown as { groups: Map<string, BackgroundExecutionGroup> };
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const started = await controller.start([{ title: "unreadable target", instructions: "work", acceptanceCriteria: ["done"] }]);
    assert.equal(activeActivitySnapshot().activeTasks, 1);
    const ownedWhileLive = ownedActivitySnapshot().backgroundTasks;
    assert.equal(ownedWhileLive, 1);

    const manifest = join(started.root, "execution.json");
    const heldManifest = join(started.root, `execution.json.held-${randomUUID()}`);
    await rename(manifest, heldManifest);
    // The registry still carries the previously known value, but the source's
    // fresh census genuinely cannot read its own current authenticated record.
    // A fresh explicit pass must NOT re-assert that cached value as freshly
    // confirmed: the derived activity channel becomes truthfully unknown.
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the cache still claims the known value");
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "a genuine fresh read failure invalidates activity instead of re-publishing the cache");
    assert.equal(ownedActivitySnapshot().backgroundTasks, ownedWhileLive,
      "the positive ownership token is retained, never dropped by an activity failure");
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, null, "repeated fresh failures stay unknown");

    await rename(heldManifest, manifest);
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "a reachable complete census recovers the exact nonzero value");
    assert.equal(ownedActivitySnapshot().backgroundTasks, ownedWhileLive,
      "activity recovery never rewrites ownership");

    // The same sequence for the known-zero case.
    await settleOldestUnsettled(controller, started.executionId, "unreadable target settled");
    assert.equal(activeActivitySnapshot().activeTasks, 0);
    const ownedAfterSettlement = ownedActivitySnapshot().backgroundTasks;
    await rename(manifest, heldManifest);
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "an unreadable settled record is unknown, never a cached zero passed off as fresh");
    await rename(heldManifest, manifest);
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the reachable census recovers the exact zero again");
    assert.equal(ownedActivitySnapshot().backgroundTasks, ownedAfterSettlement,
      "repeated recoveries leave ownership untouched");
    void internals.groups;
    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("work starting or settling during a forced census is never overwritten by the stale read", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-resync-race-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    activateOwnedActivity();
    registerReviewActivitySource();
    let gate: Promise<void> | undefined;
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
      faults: {
        currentActivityCensus: async () => {
          entered?.();
          await gate;
        },
      },
    });
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    assert.equal(activeActivitySnapshot().activeTasks, 0);

    // A start lands while the forced census is already past its canonical read
    // point. The read is now stale: it must preserve the newer exact token
    // instead of overwriting it with the older zero.
    let signalEntered!: () => void;
    const enteredOnce = new Promise<void>((resolve) => { signalEntered = resolve; });
    entered = signalEntered;
    let releaseCensus!: () => void;
    gate = new Promise<void>((resolve) => { releaseCensus = resolve; });
    const duringStart = refreshOwnedActivityIntent();
    await enteredOnce;
    const started = await controller.start([{ title: "race target", instructions: "work", acceptanceCriteria: ["done"] }]);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the admission is published before the stale read returns");
    releaseCensus();
    await duringStart;
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the stale census read never overwrites the newer admitted token");

    // A settlement races the same way: the newer zero survives.
    let signalSettledRead!: () => void;
    const settledReadEntered = new Promise<void>((resolve) => { signalSettledRead = resolve; });
    entered = signalSettledRead;
    let releaseSecond!: () => void;
    gate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const duringSettle = refreshOwnedActivityIntent();
    await settledReadEntered;
    await settleOldestUnsettled(controller, started.executionId, "race target settled");
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the settlement is published before the stale read returns");
    releaseSecond();
    await duringSettle;
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the stale census read never resurrects the settled task");

    // A later complete pass still establishes the exact current value.
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 0);
    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a detached controller with an unsettled runtime never reports a false zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-detached-runtime-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    activateOwnedActivity();
    registerReviewActivitySource();
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      runtimes: Map<string, { abort: AbortController; promise: Promise<void>; controlStatus: "pending" }>;
      activityIntentTokens?: unknown;
      activityIntentUncertain?: unknown;
      currentActivityCensusInFlight?: unknown;
      save: (group: BackgroundExecutionGroup) => Promise<unknown>;
    };
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const started = await controller.start([{ title: "detached runtime", instructions: "work", acceptanceCriteria: ["done"] }]);
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    // A genuinely live owned runtime that never settles: the executor handle is
    // registered exactly as launch() does, and the task record names it.
    transitionTaskState(task, "running");
    internals.runtimes.set(task.taskId, {
      abort: new AbortController(),
      promise: new Promise<void>(() => undefined),
      controlStatus: "pending",
    });
    await internals.save(group);
    assert.equal(internals.runtimes.has(task.taskId), true, "a live owned runtime is held unsettled");
    assert.equal(activeActivitySnapshot().activeTasks, 1);

    await controller.detach();
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "detaching with an unsettled runtime leaves activity unknown, never zero");
    // The live maps are empty after detach but nobody observed that runtime
    // settle: repeated forced fresh passes must not invent a zero from the
    // cleared maps. Only that exact owner's settlement/reconciliation may.
    for (let pass = 0; pass < 3; pass += 1) {
      // A lost live-owner record cannot be discharged by telemetry. The only
      // derived representation is the registry's incarnation-scoped set, and
      // poisoning it with a ghost claim must not let the empty live maps read as
      // zero while the retained unresolved runtime is still unproven.
      const poisoned = currentExecutionEntry();
      poisoned.intentTokens.clear();
      poisoned.intentTokens.add("execution:ghost-detached");
      poisoned.intentUncertain = false;
      assert.ok((activeActivitySnapshot().activeTasks ?? 0) > 0,
        "the poisoned registry claims a positive before the forced pass");
      await refreshOwnedActivityIntent();
      assert.equal(activeActivitySnapshot().activeTasks, null,
        `forced pass ${pass + 1} cannot prove the detached runtime stopped`);
    }
    assert.equal("activityIntentTokens" in internals, false,
      "there is no source-side token mirror to clear or poison");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "ownership stays independently unknown as well");
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("verified cleanup retires the retained root so a forced pass establishes zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-cleanup-retire-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  try {
    await initGitRepo(root);
    activateOwnedActivity();
    registerReviewActivitySource();
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      retiredCensus?: { roots: Map<string, unknown> };
      activityIntentTokens?: unknown;
    };
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const started = await controller.start([{ title: "cleanup target", instructions: "work", acceptanceCriteria: ["done"] }]);
    assert.equal(activeActivitySnapshot().activeTasks, 1);
    // A restore/detach retains this controller's own established roots; the
    // restored roster re-attaches the same group, so the retained root carries a
    // verified execution identity rather than a historical reference.
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [started.root] });
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the re-attached retained root still counts its admitted queued work");
    assert.equal(internals.retiredCensus?.roots.has(started.root), true,
      "the attached group's root is retained with its own execution identity");

    await settleOldestUnsettled(controller, started.executionId, "cleanup target settled");
    assert.equal(activeActivitySnapshot().activeTasks, 0);
    // The existing verified cleanup (all tasks settled, artifacts removed) both
    // releases ownership and retires the retained root, so the lost-work fence
    // can never misinterpret already-cleaned work.
    await controller.cleanupSettledArtifacts();
    assert.equal(internals.retiredCensus?.roots.has(started.root), false,
      "verified cleanup retires only its own settled retained root");
    assert.equal(currentExecutionEntry().intentTokens.size, 0,
      "the single canonical registry set holds the settled zero");
    assert.equal("activityIntentTokens" in internals, false,
      "the controller keeps no source-side token mirror");

    // Poison the sole canonical set: the fresh pass must still derive the real
    // zero from the canonical controller runtime state.
    const poisoned = currentExecutionEntry();
    poisoned.intentTokens.add("execution:ghost-after-cleanup");
    poisoned.intentUncertain = false;
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "after verified cleanup the forced pass establishes the real zero, not unknown");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0,
      "and the ownership channel is settled too");
    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a poisoned registry ghost never blocks a retired owner's canonical retained proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-active-intent-retired-ghost-"));
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  const controllers: BackgroundExecutionController[] = [];
  try {
    await initGitRepo(root);
    activateOwnedActivity();
    registerReviewActivitySource();
    const old = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    controllers.push(old);
    const internals = old as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      activityIntentTokens?: unknown;
      activityIntentUncertain?: unknown;
    };
    await old.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const started = await old.start([{ title: "retired ghost target", instructions: "work", acceptanceCriteria: ["done"] }]);
    const taskId = started.tasks[0]!.taskId;
    assert.equal(activeActivitySnapshot().activeTasks, 1);

    // Poison the sole canonical set with a ghost. The controller keeps no
    // source-side mirror, so the fresh current-source read is the only repair
    // path, and it replaces the set with the real queued token.
    const poisonedEntry = currentExecutionEntry();
    poisonedEntry.intentTokens.add("execution:ghost");
    poisonedEntry.intentUncertain = false;
    await refreshOwnedActivityIntent();
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the current source replaces the poisoned registry set with the real queued token");
    assert.deepEqual([...currentExecutionEntry().intentTokens], [taskId],
      "the single canonical set holds exactly the real queued token, with no ghost anywhere");
    assert.equal("activityIntentTokens" in internals, false,
      "no source-side mirror can survive a refresh because none exists");
    assert.equal("activityIntentUncertain" in internals, false,
      "the source keeps no uncertainty mirror to diverge from the registry");

    await old.detach();
    const replacement = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    controllers.push(replacement);
    await replacement.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "the retired owner's retained queued work remains counted after replacement restoration");

    // Repeated forced passes must reach the retired owner's canonical retained
    // inventory and report its real queued intent — never unknown because of a
    // derived-telemetry ghost, and never a replacement source's emptiness.
    for (let pass = 0; pass < 3; pass += 1) {
      await refreshOwnedActivityIntent();
      assert.equal(activeActivitySnapshot().activeTasks, 1,
        `forced pass ${pass + 1} reconstructs the retired owner's actual queued intent`);
    }
    assert.equal(internals.groups.has(started.executionId), false, "the old live map is gone after detach");
    assert.equal(taskId.length > 0, true);
  } finally {
    for (const controller of controllers) await controller.detach().catch(() => undefined);
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});
