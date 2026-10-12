/**
 * Focused synthetic tests for background-execution owned-work telemetry
 * (src/execution/background-controller.ts).
 *
 * The pure ownership predicate is exercised directly, and real controllers
 * (with no worker capacity) cover the authoritative-lifecycle rules: execution
 * telemetry is UNKNOWN before and during every restore, UNKNOWN after a failed
 * or association-refusing restore, and only a successful completion establishes
 * zero. No executor process, PTY, or shell is spawned.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BackgroundExecutionController, taskOwnsUnsettledWork } from "../src/execution/background-controller";
import { readGroup } from "../src/execution/background-group-store";
import { createOperationRecord, createReattachmentBundle, writeOperationRecord } from "../src/execution/operation-record";
import { transitionTaskState } from "../src/execution/task-state";
import { createState } from "../src/state";
import {
  activateOwnedActivity,
  activeActivitySnapshot,
  ownedActivitySnapshot,
  registerOwnedActivitySource,
  __test as ownedActivityTest,
} from "../src/session-host/owned-activity";
import { boundedScalingConfig, controllerInternals, initGitRepo, settleOldestUnsettled } from "./helpers/background-controller-fixtures";

type ActivityCensusProbe = {
  currentActivityCensusInFlight?: Promise<void>;
  ownedActivity: { retired: boolean };
};

function activityCensusProbe(controller: BackgroundExecutionController): ActivityCensusProbe {
  return controller as unknown as ActivityCensusProbe;
}

async function waitForCurrentActivityCensus(controller: BackgroundExecutionController): Promise<void> {
  const probe = activityCensusProbe(controller);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const inFlight = probe.currentActivityCensusInFlight;
    if (inFlight) await inFlight;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!probe.currentActivityCensusInFlight) return;
  }
  assert.fail("current-source activity census did not settle after bounded lifecycle-event turns");
}

test("task ownership predicate retains bundle-less started work until an archivable outcome", () => {
  // Active/queued logical work.
  assert.equal(taskOwnsUnsettledWork({ state: "queued" }, false, false), true);
  assert.equal(taskOwnsUnsettledWork({ state: "running", generation: 1 }, false, false), true);
  // A live runtime or force-merge is owned regardless of state.
  assert.equal(taskOwnsUnsettledWork({ state: "stopped_for_application_exit" }, true, false), true);
  assert.equal(taskOwnsUnsettledWork({ state: "failed" }, false, true), true);

  // Bundle-less started work is NOT settled: in-place settlement clears the
  // bundle while its executor loop can retain an unverified child owner, and
  // wave recovery can fail before a bundle is assigned.
  assert.equal(
    taskOwnsUnsettledWork({ state: "paused_recoverable", generation: 1 }, false, false),
    true,
    "a started in-place task that cleared its bundle stays owned",
  );
  assert.equal(
    taskOwnsUnsettledWork({ state: "stopped_for_application_exit", generation: 3 }, false, false),
    true,
    "a started task stopped at application exit stays owned",
  );
  assert.equal(
    taskOwnsUnsettledWork({ state: "paused_recoverable", inplaceResult: { operationRecord: "/op.json" } }, false, false),
    true,
    "an in-place operation record is an ownership anchor",
  );
  assert.equal(
    taskOwnsUnsettledWork({ state: "failed", waveRoot: "/wave" }, false, false),
    true,
    "a failed task with a wave anchor stays owned",
  );
  assert.equal(
    taskOwnsUnsettledWork({ state: "failed", bundle: { operationId: "op-1" } }, false, false),
    true,
    "a durable continuation bundle is an ownership anchor",
  );

  // Undispatched work and authoritative settled outcomes release.
  assert.equal(
    taskOwnsUnsettledWork({ state: "failed" }, false, false),
    false,
    "an undispatched failed task (generation 0, no anchors) is settled",
  );
  assert.equal(
    taskOwnsUnsettledWork({ state: "stopped_for_application_exit" }, false, false),
    false,
    "an undispatched queued task stopped at application exit is settled",
  );
  assert.equal(
    taskOwnsUnsettledWork({ state: "landed", generation: 2, waveRoot: "/wave", bundle: { operationId: "op-1" } }, false, false),
    false,
    "an archivable outcome releases even with former anchors",
  );
});

test("every restore invalidates completeness before its first await", async () => {
  ownedActivityTest.resetOwnedActivityForTests();
  try {
    activateOwnedActivity();
    registerOwnedActivitySource("backgroundTasks", "review");
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => process.cwd(),
    });

    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "unknown before the first restore");

    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0, "a complete restore establishes zero");

    // A subsequent restore must invalidate the prior zero synchronously, before
    // its first await, even though it has no current tasks.
    const pending = controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    assert.equal(
      ownedActivitySnapshot().backgroundTasks,
      null,
      "the new restore invalidates completeness before any asynchronous work",
    );
    await pending;
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0, "successful completion re-establishes zero");

    const missingRoot = join(tmpdir(), `prg-missing-group-${randomUUID()}`);
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [missingRoot] });
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "a failed restore keeps execution unknown");

    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
  }
});

test("a restored group root and its matching sidecar bundle do not duplicate the task", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-root-bundle-restore-"));
  const roots: string[] = [];
  const controllers: BackgroundExecutionController[] = [];
  ownedActivityTest.resetOwnedActivityForTests();
  try {
    await initGitRepo(workspace);
    activateOwnedActivity();
    registerOwnedActivitySource("backgroundTasks", "review");
    const seed = new BackgroundExecutionController({
      pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => workspace,
    });
    controllers.push(seed);
    await seed.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const started = await seed.start([{ title: "root plus bundle", instructions: "seed", acceptanceCriteria: ["done"] }]);
    roots.push(started.root);
    const seedInternals = controllerInternals(seed);
    const group = seedInternals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    const waveRoot = join(workspace, `wave-${randomUUID()}`);
    const artifactDir = join(waveRoot, "artifacts", task.taskId);
    await mkdir(artifactDir, { recursive: true });
    const operation = createOperationRecord({
      waveId: `wave-${randomUUID()}`,
      taskId: task.taskId,
      title: task.definition.title,
      worktreeRoot: workspace,
      effectiveCwd: workspace,
      artifactDir,
      retryBudget: 0,
    });
    operation.state = "landed";
    await writeOperationRecord(operation);
    task.waveRoot = waveRoot;
    task.bundle = createReattachmentBundle(operation, waveRoot);
    task.generation = 1;
    transitionTaskState(task, "landed");
    await seedInternals.save(group);

    const associations = seed.associations();
    assert.deepEqual(associations.groupRoots, [started.root], "the sidecar retains the exact group root");
    assert.deepEqual(associations.bundles, [task.bundle], "the sidecar retains the exact matching recovery bundle");
    await seed.detach();

    const restored = new BackgroundExecutionController({
      pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => workspace,
    });
    controllers.push(restored);
    await restored.restore(associations);
    await waitForCurrentActivityCensus(restored);

    const restoredGroups = [...controllerInternals(restored).groups.values()];
    assert.equal(restoredGroups.length, 1, "the matching bundle is not adopted into a second execution group");
    assert.equal(restoredGroups[0]?.root, started.root, "the original authenticated group root remains authoritative");
    const matchingTasks = restoredGroups.flatMap((candidate) => candidate.tasks)
      .filter((candidate) => candidate.taskId === task.taskId);
    assert.equal(matchingTasks.length, 1, "the task identity appears exactly once across restored roots");
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "a complete root-plus-bundle restore preserves the authenticated inactive outcome");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0,
      "the released operation ownership remains known without duplicate adoption");
  } finally {
    for (const controller of controllers) await controller.detach().catch(() => undefined);
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    ownedActivityTest.resetOwnedActivityForTests();
  }
});

test("an empty non-authoritative restore fallback cannot invent activity zero", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-active-intent-fallback-"));
  const roots: string[] = [];
  ownedActivityTest.resetOwnedActivityForTests();
  try {
    await initGitRepo(workspace);
    activateOwnedActivity();
    registerOwnedActivitySource("backgroundTasks", "review");
    const controller = new BackgroundExecutionController({
      pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => workspace,
    });
    await controller.restore({ waveRoots: [], bundles: [] }, { authoritative: false });
    assert.equal(activeActivitySnapshot().activeTasks, null, "empty fallback data is not an authoritative inventory");
    const started = await controller.start([{ title: "fallback cannot prove zero", instructions: "run", acceptanceCriteria: ["done"] }]);
    roots.push(started.root);
    await waitForCurrentActivityCensus(controller);
    assert.equal(activeActivitySnapshot().activeTasks, null, "a known current task cannot make incomplete fallback data authoritative");
    await controller.detach();
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    ownedActivityTest.resetOwnedActivityForTests();
  }
});

test("a foreign-session root keeps current-source activity unknown", async () => {
  const sourceWorkspace = await mkdtemp(join(tmpdir(), "pi-review-active-intent-foreign-source-"));
  const currentWorkspace = await mkdtemp(join(tmpdir(), "pi-review-active-intent-foreign-current-"));
  const roots: string[] = [];
  const controllers: BackgroundExecutionController[] = [];
  ownedActivityTest.resetOwnedActivityForTests();
  try {
    await initGitRepo(sourceWorkspace);
    await initGitRepo(currentWorkspace);
    activateOwnedActivity();
    registerOwnedActivitySource("backgroundTasks", "review");
    const seed = new BackgroundExecutionController({
      pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => sourceWorkspace,
    });
    controllers.push(seed);
    await seed.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const foreign = await seed.start([{ title: "foreign queued task", instructions: "run", acceptanceCriteria: ["done"] }]);
    roots.push(foreign.root);
    const associations = seed.associations();
    await seed.detach();

    const current = new BackgroundExecutionController({
      pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => currentWorkspace,
    });
    controllers.push(current);
    await current.restore(associations);
    assert.equal(activeActivitySnapshot().activeTasks, null, "a root bound to another session cwd is not adopted as current authority");
    const admitted = await current.start([{ title: "current queued task", instructions: "run", acceptanceCriteria: ["done"] }]);
    roots.push(admitted.root);
    await waitForCurrentActivityCensus(current);
    assert.equal(activeActivitySnapshot().activeTasks, null, "a current task cannot mask the foreign retained root");
  } finally {
    for (const controller of controllers) await controller.detach().catch(() => undefined);
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await rm(sourceWorkspace, { recursive: true, force: true });
    await rm(currentWorkspace, { recursive: true, force: true });
    ownedActivityTest.resetOwnedActivityForTests();
  }
});

test("a refused inner association recovery keeps execution unknown, never zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-owned-recovery-"));
  ownedActivityTest.resetOwnedActivityForTests();
  try {
    await initGitRepo(root);
    // Opt in before the controller lifecycle so its registration is installed
    // (not replayed) and can be authoritatively resolved by a real restore.
    activateOwnedActivity();
    registerOwnedActivitySource("backgroundTasks", "review");
    const controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
    });
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0, "a clean restore establishes zero");

    const started = await controller.start([{ title: "seed task", instructions: "seed", acceptanceCriteria: ["done"] }]);
    // Give the queued execute task a wave anchor that does not exist on disk, so
    // its recovery backfill is refused while readGroup itself succeeds.
    const internals = controllerInternals(controller);
    const group = internals.groups.get(started.executionId)!;
    group.tasks[0]!.waveRoot = join(root, "missing-wave-root");
    await internals.save(group);
    const associations = controller.associations();

    // The next restore marks execution unknown at entry, then refuses the inner
    // association recovery: it must NOT finish as a complete (zero) restore.
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: associations.groupRoots });
    assert.equal(
      ownedActivitySnapshot().backgroundTasks,
      null,
      "an unresolved association recovery cannot finish as a complete (zero) restore",
    );

    await controller.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    // Git/controller-created descendants have no per-entry creation/settlement
    // receipts here. Retain them rather than recursively claiming their ownership.
    console.info(`owned-recovery fixture retained (descendant ownership unproven): ${root}`);
  }
});

test("a durability-only restore save failure keeps activity known and ownership uncertain", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-activity-save-failure-"));
  const roots: string[] = [];
  const controllers: BackgroundExecutionController[] = [];
  ownedActivityTest.resetOwnedActivityForTests();
  try {
    activateOwnedActivity();
    registerOwnedActivitySource("backgroundTasks", "review");
    const prior = new BackgroundExecutionController({
      pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => workspace,
    });
    controllers.push(prior);
    await prior.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const priorTask = await prior.start([{ title: "settled before restore", instructions: "seed", acceptanceCriteria: ["done"] }]);
    roots.push(priorTask.root);
    await settleOldestUnsettled(prior, priorTask.executionId, "seed terminal record");
    assert.equal(activeActivitySnapshot().activeTasks, 0);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0);
    const priorHandle = activityCensusProbe(prior).ownedActivity;
    const associations = prior.associations();
    await prior.detach();

    let failRestoreSave = true;
    const notices: string[] = [];
    const restored = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => workspace,
      faults: {
        save: (context) => {
          if (failRestoreSave && context.executionId === priorTask.executionId) {
            failRestoreSave = false;
            throw new Error("controlled group durability fault");
          }
        },
      },
      notify: (message) => { notices.push(message); },
    });
    controllers.push(restored);
    await restored.restore(associations);

    assert.equal(priorHandle.retired, true, "the prior zero source remains retained as a distinct retired incarnation");
    assert.equal(failRestoreSave, false, "the failure was injected after authenticated group classification");
    assert.equal(activeActivitySnapshot().activeTasks, 0, "durability alone does not poison the complete activity census");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "the failed persistence refresh keeps cleanup ownership unknown");
    assert.match(notices.join("\n"), /restored in memory but could not be durably saved.*controlled group durability fault/);

    const next = await restored.start([{ title: "admitted after restore", instructions: "run", acceptanceCriteria: ["done"] }]);
    roots.push(next.root);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "a subsequent admitted task has a known positive activity count");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "activity recovery never resolves cleanup ownership");

    await settleOldestUnsettled(restored, next.executionId, "new task terminal");
    assert.equal(activeActivitySnapshot().activeTasks, 0, "settlement restores the known zero activity value");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "retained ownership uncertainty remains independent");

    const missingRoot = join(tmpdir(), `pi-review-execution-missing-${randomUUID()}`);
    await restored.restore({ waveRoots: [], bundles: [], groupRoots: [missingRoot] });
    assert.equal(activeActivitySnapshot().activeTasks, null, "an unreadable authoritative root remains unknown");
    const afterUnreadableRoot = await restored.start([{ title: "one visible task is not a full census", instructions: "run", acceptanceCriteria: ["done"] }]);
    roots.push(afterUnreadableRoot.root);
    await waitForCurrentActivityCensus(restored);
    assert.equal(activeActivitySnapshot().activeTasks, null, "a known current task cannot mask the still-unreadable retained root");

    const orphanedBundle = {
      version: 1 as const,
      operationId: "operation-unadopted",
      waveId: "wave-unadopted",
      taskId: `task-${randomUUID()}`,
      waveRoot: join(workspace, "missing-legacy-wave"),
      expectedRevision: 0,
    };
    await restored.restore({ waveRoots: [], bundles: [orphanedBundle], groupRoots: [] });
    assert.equal(activeActivitySnapshot().activeTasks, null, "an unadopted legacy bundle remains activity-unknown");
    const taskWithOrphanedBundle = await restored.start([{ title: "orphaned legacy inventory", instructions: "run", acceptanceCriteria: ["done"] }]);
    roots.push(taskWithOrphanedBundle.root);
    await waitForCurrentActivityCensus(restored);
    assert.equal(activeActivitySnapshot().activeTasks, null, "a new known task cannot erase an unmatched retained legacy bundle");
  } finally {
    for (const controller of controllers) await controller.detach().catch(() => undefined);
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    ownedActivityTest.resetOwnedActivityForTests();
  }
});

test("a later admitted-task update reauthenticates every root after a transient restore read failure", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-activity-census-recovery-"));
  const roots: string[] = [];
  const controllers: BackgroundExecutionController[] = [];
  let heldManifest: string | undefined;
  ownedActivityTest.resetOwnedActivityForTests();
  try {
    activateOwnedActivity();
    registerOwnedActivitySource("backgroundTasks", "review");
    const seed = new BackgroundExecutionController({
      pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => workspace,
    });
    controllers.push(seed);
    await seed.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    for (let index = 0; index < 5; index += 1) {
      const started = await seed.start([{ title: `terminal seed ${index}`, instructions: "seed", acceptanceCriteria: ["done"] }]);
      roots.push(started.root);
      await settleOldestUnsettled(seed, started.executionId, `terminal seed ${index}`);
    }
    const associations = seed.associations();
    assert.equal(associations.groupRoots?.length, 5, "the retained inventory contains five distinct authenticated group roots");
    await seed.detach();

    const temporarilyUnreadableRoot = roots[2]!;
    const manifest = join(temporarilyUnreadableRoot, "execution.json");
    heldManifest = join(temporarilyUnreadableRoot, `execution.json.held-${randomUUID()}`);
    await rename(manifest, heldManifest);

    const current = new BackgroundExecutionController({
      pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => workspace,
    });
    controllers.push(current);
    await current.restore(associations);
    assert.equal(activeActivitySnapshot().activeTasks, null, "the initial authenticated inventory was not fully readable");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "the unreadable record keeps ownership unknown");

    await rename(heldManifest, manifest);
    heldManifest = undefined;
    const admitted = await current.start([{ title: "current admitted task", instructions: "run", acceptanceCriteria: ["done"] }]);
    roots.push(admitted.root);
    await waitForCurrentActivityCensus(current);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the fresh census counts the one current task only after authenticating every retained root");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "the current-source activity census does not resolve cleanup ownership");

    await settleOldestUnsettled(current, admitted.executionId, "current task settled");
    await waitForCurrentActivityCensus(current);
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the later settlement leaves a known zero after full inventory proof");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "cleanup uncertainty remains independent after settlement");
  } finally {
    if (heldManifest) await rename(heldManifest, join(roots[2]!, "execution.json")).catch(() => undefined);
    for (const controller of controllers) await controller.detach().catch(() => undefined);
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    ownedActivityTest.resetOwnedActivityForTests();
  }
});

test("a repaired current census accepts authenticated archive-index overlap with an inline task", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-activity-census-stale-index-"));
  const roots: string[] = [];
  const controllers: BackgroundExecutionController[] = [];
  let heldManifest: string | undefined;
  ownedActivityTest.resetOwnedActivityForTests();
  try {
    await initGitRepo(workspace);
    activateOwnedActivity();
    registerOwnedActivitySource("backgroundTasks", "review");
    const seed = new BackgroundExecutionController({
      pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => workspace,
    });
    controllers.push(seed);
    await seed.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const archivedSeed = await seed.start([{ title: "archive-index seed", instructions: "seed", acceptanceCriteria: ["done"] }]);
    roots.push(archivedSeed.root);
    const archivedSeedTaskId = archivedSeed.tasks[0]!.taskId;
    await settleOldestUnsettled(seed, archivedSeed.executionId, "archive-index seed settled");
    const internals = controllerInternals(seed) as ReturnType<typeof controllerInternals> & {
      legacyArchiveHandles: Map<string, {
        entries: Map<string, { integritySha256: string; updatedAt: string }>;
        persisted: boolean;
      }>;
    };
    const archiveHandle = internals.archivedTasks.get(`${archivedSeed.executionId}:${archivedSeedTaskId}`) as
      { integritySha256: string; updatedAt: string } | undefined;
    assert.ok(archiveHandle, "the settled inline seed has a genuine production-written archive handle");
    internals.legacyArchiveHandles.set(archivedSeed.executionId, {
      entries: new Map([[archivedSeedTaskId, {
        integritySha256: archiveHandle!.integritySha256,
        updatedAt: archiveHandle!.updatedAt,
      }]]),
      persisted: false,
    });

    // The production save writes this authenticated index before its manifest,
    // then retires the now-inline legacy handle in memory. The durable index is
    // therefore legitimately stale until the next index rewrite.
    await internals.save(internals.groups.get(archivedSeed.executionId)!);
    assert.equal(internals.legacyArchiveHandles.get(archivedSeed.executionId)?.entries.has(archivedSeedTaskId), false,
      "the save retired the redundant in-memory legacy membership");
    const overlap = await readGroup(archivedSeed.root);
    assert.ok(overlap.archiveIndex?.entries[archivedSeedTaskId], "the production writer created an authenticated stale index entry");
    assert.ok(overlap.group.tasks.some((task) => task.taskId === archivedSeedTaskId),
      "the same task remains authenticated inline by the manifest and archive");
    assert.ok(overlap.legacyArchives.has(archivedSeedTaskId),
      "readGroup merges the valid stale index membership with its inline task");
    assert.equal(overlap.archiveIndex!.entries[archivedSeedTaskId]!.archiveIntegritySha256,
      overlap.archives.get(archivedSeedTaskId)?.integritySha256,
      "the redundant index entry authenticates the same durable archive as the inline reference");

    const associations = seed.associations();
    await seed.detach();
    const manifest = join(archivedSeed.root, "execution.json");
    heldManifest = join(archivedSeed.root, `execution.json.held-${randomUUID()}`);
    await rename(manifest, heldManifest);

    const current = new BackgroundExecutionController({
      pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => workspace,
    });
    controllers.push(current);
    await current.restore(associations);
    await waitForCurrentActivityCensus(current);
    assert.equal(activeActivitySnapshot().activeTasks, null, "the unreadable authenticated root keeps activity unknown");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "the unreadable root keeps cleanup ownership unknown");

    await rename(heldManifest, manifest);
    heldManifest = undefined;
    const admitted = await current.start([{ title: "post-repair live task", instructions: "run", acceptanceCriteria: ["done"] }]);
    roots.push(admitted.root);
    await waitForCurrentActivityCensus(current);
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "a real admission reauthenticates the repaired root despite its valid stale inline/index overlap");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "the activity census does not resolve the independently uncertain cleanup-ownership channel");

    await settleOldestUnsettled(current, admitted.executionId, "post-repair task settled");
    await waitForCurrentActivityCensus(current);
    assert.equal(activeActivitySnapshot().activeTasks, 0, "settlement returns the complete authenticated census to known zero");
    assert.equal(ownedActivitySnapshot().backgroundTasks, null, "cleanup ownership remains uncertain after activity settles");
  } finally {
    for (const controller of controllers) await controller.detach().catch(() => undefined);
    if (heldManifest) await rename(heldManifest, join(roots[0]!, "execution.json")).catch(() => undefined);
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    ownedActivityTest.resetOwnedActivityForTests();
  }
});

test("a new host session cannot drop queued intent from a hidden admitted root", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-activity-census-session-owner-"));
  const roots: string[] = [];
  let heldManifest: string | undefined;
  ownedActivityTest.resetOwnedActivityForTests();
  try {
    activateOwnedActivity();
    registerOwnedActivitySource("backgroundTasks", "review");
    const controller = new BackgroundExecutionController({
      pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => workspace,
    });
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] }, { sessionOwner: "session-a" });
    const admittedA = await controller.start([{ title: "session A queued task", instructions: "run", acceptanceCriteria: ["done"] }]);
    roots.push(admittedA.root);
    await waitForCurrentActivityCensus(controller);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "session A has one admitted queued task");

    const manifestA = join(admittedA.root, "execution.json");
    heldManifest = join(admittedA.root, `execution.json.session-switch-held-${randomUUID()}`);
    await rename(manifestA, heldManifest);
    const sessionSwitch = controller.restore({ waveRoots: [], bundles: [], groupRoots: [] }, { sessionOwner: "session-b" });
    assert.equal(activeActivitySnapshot().activeTasks, null, "the new session invalidates the prior activity proof before its first await");
    await sessionSwitch;
    await waitForCurrentActivityCensus(controller);
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "session B remains unknown while session A's retained admitted manifest is unreadable");

    await rename(heldManifest, manifestA);
    heldManifest = undefined;
    const admittedB = await controller.start([{ title: "session B queued task", instructions: "run", acceptanceCriteria: ["done"] }]);
    roots.push(admittedB.root);
    await waitForCurrentActivityCensus(controller);
    assert.equal(activeActivitySnapshot().activeTasks, 2,
      "a real session B admission reauthenticates the repaired session A root and counts both queued intents");

    await settleOldestUnsettled(controller, admittedB.executionId, "session B task settled");
    await waitForCurrentActivityCensus(controller);
    assert.equal(activeActivitySnapshot().activeTasks, 1,
      "settling session B releases only its intent while the retained session A task remains queued");
    await controller.detach();
  } finally {
    if (heldManifest) await rename(heldManifest, join(roots[0]!, "execution.json")).catch(() => undefined);
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    ownedActivityTest.resetOwnedActivityForTests();
  }
});

test("a detached in-flight current-source census cannot resolve a rebound source", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-activity-census-owner-race-"));
  const roots: string[] = [];
  const controllers: BackgroundExecutionController[] = [];
  let heldManifest: string | undefined;
  let releaseCensus: () => void = () => undefined;
  ownedActivityTest.resetOwnedActivityForTests();
  try {
    activateOwnedActivity();
    registerOwnedActivitySource("backgroundTasks", "review");
    const seed = new BackgroundExecutionController({
      pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => workspace,
    });
    controllers.push(seed);
    await seed.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const saved = await seed.start([{ title: "settled inventory seed", instructions: "seed", acceptanceCriteria: ["done"] }]);
    roots.push(saved.root);
    await settleOldestUnsettled(seed, saved.executionId, "settled inventory seed");
    const associations = seed.associations();
    await seed.detach();

    const manifest = join(saved.root, "execution.json");
    heldManifest = join(saved.root, `execution.json.held-${randomUUID()}`);
    await rename(manifest, heldManifest);
    let markCensusEntered!: () => void;
    const censusEntered = new Promise<void>((resolve) => { markCensusEntered = resolve; });
    const censusGate = new Promise<void>((resolve) => { releaseCensus = resolve; });
    const current = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => workspace,
      faults: { currentActivityCensus: async () => { markCensusEntered(); await censusGate; } },
    });
    controllers.push(current);
    await current.restore(associations);
    assert.equal(activeActivitySnapshot().activeTasks, null, "the initial source inventory is incomplete");
    await rename(heldManifest, manifest);
    heldManifest = undefined;

    const admitted = await current.start([{ title: "queued before rebind", instructions: "run", acceptanceCriteria: ["done"] }]);
    roots.push(admitted.root);
    await censusEntered;
    const oldHandle = activityCensusProbe(current).ownedActivity;
    const pendingCensus = activityCensusProbe(current).currentActivityCensusInFlight;
    assert.ok(pendingCensus, "the event-triggered census is held at its read-only barrier");

    await current.detach();
    const replacement = new BackgroundExecutionController({
      pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => workspace,
    });
    controllers.push(replacement);
    await replacement.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    assert.equal(oldHandle.retired, true, "the replacement owns a distinct source incarnation");

    releaseCensus();
    await pendingCensus;
    await waitForCurrentActivityCensus(current);
    assert.equal(activeActivitySnapshot().activeTasks, null, "the stale census cannot clear the retired source or the replacement's unknown count");
  } finally {
    releaseCensus();
    if (heldManifest) await rename(heldManifest, join(roots[0]!, "execution.json")).catch(() => undefined);
    for (const controller of controllers) await controller.detach().catch(() => undefined);
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    ownedActivityTest.resetOwnedActivityForTests();
  }
});
