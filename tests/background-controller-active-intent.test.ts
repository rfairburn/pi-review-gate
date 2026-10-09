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
import { mkdtemp, rm } from "node:fs/promises";
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
import { registerReviewActivitySource, __test as reviewActivityTest } from "../src/activation/review-activity";
import {
  activateOwnedActivity,
  activeActivitySnapshot,
  ownedActivitySnapshot,
  subscribeOwnedActivity,
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

test("a failed restore keeps activity genuinely unknown rather than zero", async () => {
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
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [join(root, "missing-group-root")] });
    assert.equal(activeActivitySnapshot().activeTasks, null, "an unreadable group leaves activity unknown, never zero");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null);
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
