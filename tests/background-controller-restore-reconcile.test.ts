/**
 * #781 — the shared restore classification through the real controller.
 *
 * These cases drive an actual `BackgroundExecutionController` restore against
 * durable groups and real artifact retention, so the classification is pinned
 * to what the production save/restore path really produces — including
 * retained completed history whose wave and bundle roots cleanup already
 * collected, and an in-flight task whose wave root is gone (which must stay a
 * bounded failure, never "collected work").
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

const execFileAsync = promisify(execFile);
/** Git inside a test's own captured fixture repository. */
const fixtureGit = (cwd: string, ...args: string[]): Promise<string> =>
  execFileAsync("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).then((out) => out.stdout.trim());

import { BackgroundExecutionController } from "../src/execution/background-controller";
import { ownedTaskArchiveIsPositivelyAbsent } from "../src/execution/background-group-store";
import type { ExecutionRestoreResult } from "../src/execution/restore-reconciliation";
import { captureWaveBase } from "../src/execution/wave-repository";
import { createWorkerWorktree } from "../src/execution/wave-worktrees";
import { normalizeCandidate } from "../src/execution/wave-commits";
import { researchWorktree } from "../src/execution/research-task-lifecycle";
import { createOperationRecord, createReattachmentBundle, writeOperationRecord } from "../src/execution/operation-record";
import { normalizeConfig } from "../src/config";
import { createState } from "../src/state";
import type { BackgroundTaskRecord } from "../src/execution/task-state";
import type { ExecutionAssociationsSnapshot } from "../src/session-state";
import { boundedScalingConfig, collidingTaskRecord, controllerInternals, initGitRepo, settleOldestUnsettled } from "./helpers/background-controller-fixtures";

/** One private temporary root per case, with `os.tmpdir()` pointed at it. */
async function privateTempRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-review-restore-"));
  const tempKey = process.platform === "win32" ? "TEMP" : "TMPDIR";
  const previousTemp = process.env[tempKey];
  t.after(async () => {
    if (previousTemp === undefined) delete process.env[tempKey];
    else process.env[tempKey] = previousTemp;
    await rm(root, { recursive: true, force: true });
  });
  const canonical = await realpath(root);
  process.env[tempKey] = canonical;
  return canonical;
}

/** A saved version-3 group with inline task records, as restore reads them. */
async function writeSavedGroup(
  groupRoot: string,
  groupCwd: string,
  executionId: string,
  tasks: BackgroundTaskRecord[],
  kind: "execute" | "research" = "execute",
): Promise<void> {
  const unsigned = {
    version: 3 as const,
    revision: 0,
    executionId,
    kind,
    root: groupRoot,
    cwd: groupCwd,
    sessionCwd: groupCwd,
    createdAt: tasks[0]!.createdAt,
    updatedAt: tasks.at(-1)!.updatedAt,
    peakConcurrency: 1,
    totalTaskCount: tasks.length,
    settledArchivedCount: 0,
    tasks,
  };
  const snapshot = { ...unsigned, integritySha256: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") };
  await writeFile(join(groupRoot, "execution.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

function settledTask(taskId: string, waveRoot: string): BackgroundTaskRecord {
  const at = "2026-05-05T05:05:05.000Z";
  const task = collidingTaskRecord(taskId, at, at, "landed outcome for the report");
  task.state = "reported";
  task.waveRoot = waveRoot;
  task.bundle = { version: 1, operationId: `op-${taskId}`, waveId: `wave-${taskId}`, taskId, waveRoot, expectedRevision: 2 };
  return task;
}

function inflightTask(taskId: string, waveRoot: string): BackgroundTaskRecord {
  const at = "2026-05-05T05:05:05.000Z";
  const task = collidingTaskRecord(taskId, at, at, "implementation work interrupted by restart");
  task.state = "paused_recoverable";
  task.waveRoot = waveRoot;
  task.bundle = { version: 1, operationId: `op-${taskId}`, waveId: `wave-${taskId}`, taskId, waveRoot, expectedRevision: 2 };
  return task;
}

function waitingTask(taskId: string): BackgroundTaskRecord {
  const at = "2026-05-05T05:05:05.000Z";
  const task = collidingTaskRecord(taskId, at, at, "queued for the next worker slot");
  task.state = "queued";
  return task;
}

function controllerFor(workspaceRoot: string, notifications: string[]): BackgroundExecutionController {
  return new BackgroundExecutionController({
    pi: {},
    config: boundedScalingConfig(),
    state: createState(),
    cwd: () => workspaceRoot,
    notify: (message) => {
      notifications.push(message);
    },
  });
}

/**
 * A configuration whose research route is live and whose worker budget allows
 * one dispatch, so "the continuation never ran" is a real outcome here rather
 * than a consequence of dispatch being impossible.
 */
function researchDispatchController(workspaceRoot: string, notifications: string[]): BackgroundExecutionController {
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      unstarted: {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] },
      },
    },
    execution: {
      maxWorkers: 1,
      workerResources: { default: { selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [{ resourceId: "default" }] },
    },
    retainBundles: "always",
  });
  return new BackgroundExecutionController({
    pi: {},
    config,
    state: createState(),
    cwd: () => workspaceRoot,
    notify: (message) => {
      notifications.push(message);
    },
  });
}

test("restore after real artifact retention reconciles the collected wave and bundle of retained completed history", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const groupRoot = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const waveRoot = await mkdtemp(join(tmpdir(), "wave-"));
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    await writeSavedGroup(groupRoot, workspaceRoot, "exec-retained", [
      settledTask("task-settled", waveRoot),
      waitingTask("task-queued"),
    ]);
    // The persisted record written before artifact cleanup ran.
    const persisted: ExecutionAssociationsSnapshot = {
      waveRoots: [waveRoot],
      bundles: [settledTask("task-settled", waveRoot).bundle!],
      groupRoots: [groupRoot],
    };

    controller = controllerFor(workspaceRoot, notifications);
    // Production retention: the settled task's owned wave root is removed and
    // its dead references cleared; the group stays for its unsettled task.
    await controller.restore(persisted);
    await controller.cleanupSettledArtifacts();
    await assert.rejects(() => lstat(waveRoot), "retention removed the collected wave root");
    assert.equal(controller.inspect("exec-retained", "task-settled").tasks[0]?.waveRoot, undefined);

    await controller.detach();
    const notificationsAfter: string[] = [];
    controller = controllerFor(workspaceRoot, notificationsAfter);
    const result: ExecutionRestoreResult = await controller.restore(persisted);

    assert.equal(result.recovery.complete, true, "collected completed history is not a failed restore");
    assert.equal(result.recovery.reconciled, 2, "the collected wave root and its bundle are reconciled out");
    assert.deepEqual(result.recovery.reasons, []);
    assert.deepEqual(result.associations.waveRoots, []);
    assert.deepEqual(result.associations.bundles, []);
    assert.deepEqual(result.associations.groupRoots, [groupRoot], "the surviving group stays required");
    assert.deepEqual(
      notificationsAfter.filter((message) => /was not restored|was not adopted|could not be re-verified|could not be durably saved/.test(message)),
      [],
      "collected completed work is never announced as a failure, by any path",
    );

    const retained = controller.inspect("exec-retained", "task-settled").tasks[0]!;
    assert.equal(retained.state, "reported", "the task and its report history survive their dead artifacts");
    assert.equal(retained.summary, "landed outcome for the report");
    assert.equal(controller.inspect("exec-retained").tasks.some((task) => task.taskId === "task-queued"), true,
      "the group's remaining unsettled task is preserved");
    await access(join(groupRoot, "execution.json"));
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("a missing in-flight wave and bundle stay a bounded failure, never collected work", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const groupRoot = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const waveRoot = await mkdtemp(join(tmpdir(), "wave-"));
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    await writeSavedGroup(groupRoot, workspaceRoot, "exec-inflight", [inflightTask("task-active", waveRoot)]);
    const persisted: ExecutionAssociationsSnapshot = {
      waveRoots: [waveRoot],
      bundles: [inflightTask("task-active", waveRoot).bundle!],
      groupRoots: [groupRoot],
    };
    // The reproduced loss: the in-flight task's wave root is gone.
    await rm(waveRoot, { recursive: true, force: true });

    controller = controllerFor(workspaceRoot, notifications);
    const result = await controller.restore(persisted);

    assert.equal(result.recovery.complete, false, "a task-specific inability to continue is a failure, not a hidden reference");
    assert.equal(result.recovery.reconciled, 0);
    assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["bundle-in-flight"],
      "the wave the required bundle names is protected by that bundle, so it is kept without a duplicate reason");
    assert.match(result.recovery.reasons[0]!.detail, /could not re-authenticate|Recovery|no such file/);
    assert.deepEqual(result.associations.waveRoots, [waveRoot], "the reference is kept, not silently dropped");
    assert.equal(result.associations.bundles.length, 1);
    assert.ok(notifications.some((message) => /could not be re-verified/.test(message) && message.includes("task-active")),
      "the session gets a bounded signal for the unproven association");

    const stalled = controller.inspect("exec-inflight", "task-active").tasks[0]!;
    assert.equal(stalled.waveRoot, waveRoot, "an unsettled task's references are never normalized away");
    assert.equal(stalled.state, "paused_recoverable", "the recoverable task and its gate stay intact");
    await access(join(groupRoot, "execution.json"));
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("an existing group whose manifest is missing is a failed read, not a verified absence", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const groupRoot = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    await writeSavedGroup(groupRoot, workspaceRoot, "exec-broken", [waitingTask("task-1")]);
    await rm(join(groupRoot, "execution.json"));
    controller = controllerFor(workspaceRoot, notifications);
    const result = await controller.restore({ waveRoots: [], bundles: [], groupRoots: [groupRoot] });

    assert.equal(result.recovery.complete, false);
    assert.equal(result.recovery.reconciled, 0);
    assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["group-unavailable"]);
    assert.deepEqual(result.associations.groupRoots, [groupRoot], "a group that may still be recoverable is never dropped");
    assert.ok(notifications.some((message) => message.includes(groupRoot) && /was not restored/.test(message)),
      "a genuinely unreadable record keeps its full failure diagnostic");
    await access(groupRoot);
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("a disappeared group directory with no usable references is not by itself a failed restore", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const goneRoot = join(temporaryRoot, "pi-review-execution-collected");
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    controller = controllerFor(workspaceRoot, notifications);
    const result = await controller.restore({ waveRoots: [], bundles: [], groupRoots: [goneRoot] });

    assert.equal(result.recovery.complete, true, "cleanup collecting a group directory is a foreseeable state, not a failure");
    assert.equal(result.recovery.reconciled, 1);
    assert.deepEqual(result.associations.groupRoots, []);
    assert.deepEqual(notifications, [], "a verified-gone group does not call the failure notifier");
    assert.deepEqual(await readdir(workspaceRoot), []);
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("a bundle whose wave root survives is still handed to canonical adoption, never called collected", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const waveRoot = await mkdtemp(join(temporaryRoot, "wave-survivor-"));
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    const bundle = { version: 1 as const, operationId: "op-orphan", waveId: "wave-orphan", taskId: "task-orphan", waveRoot, expectedRevision: 1 };
    controller = controllerFor(workspaceRoot, notifications);
    const result = await controller.restore({ waveRoots: [waveRoot], bundles: [bundle], groupRoots: [] });

    assert.equal(result.recovery.complete, false);
    assert.equal(result.recovery.reconciled, 0, "a surviving wave root is never cleanup authority");
    assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["bundle-unrecoverable"],
      "the surviving wave is kept silently because the required bundle already reports it");
    assert.deepEqual(result.associations.waveRoots, [waveRoot]);
    assert.equal(result.associations.bundles.length, 1);
    assert.ok(notifications.some((message) => /legacy execution bundle was not adopted/.test(message)),
      "canonical adoption still ran and reported its own outcome");
    await access(waveRoot);
    assert.deepEqual((await readdir(temporaryRoot)).filter((entry) => entry.startsWith("pi-review-execution-")), [],
      "no execution root was adopted or created by the restore");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("an attached group whose restore rewrite fails is never reported as safe to persist", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const groupRoot = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    await writeSavedGroup(groupRoot, workspaceRoot, "exec-durable", [waitingTask("task-1")]);
    controller = controllerFor(workspaceRoot, notifications);
    let failed = false;
    controller.setFaultHooks({
      save: (context) => {
        if (failed || context.executionId !== "exec-durable") return undefined;
        failed = true;
        throw new Error("injected durable rewrite failure");
      },
    });
    const result = await controller.restore({ waveRoots: [], bundles: [], groupRoots: [groupRoot] });

    assert.equal(result.recovery.complete, false,
      "the attached root is present in memory, so only the walk's own failure can close the record");
    assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["group-not-durable"]);
    assert.match(result.recovery.reasons[0]!.detail, /injected durable rewrite failure/);
    assert.ok(notifications.some((message) => /could not be durably saved/.test(message)),
      "Pi keeps its detailed notify for the same fact");
  } finally {
    controller?.setFaultHooks(undefined);
    await controller?.detach().catch(() => undefined);
  }
});

test("a group-only snapshot whose manifest names an unproven in-flight operation stays incomplete", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const groupRoot = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const waveRoot = await mkdtemp(join(tmpdir(), "wave-"));
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    await writeSavedGroup(groupRoot, workspaceRoot, "exec-manifest-only", [inflightTask("task-active", waveRoot)]);
    await rm(waveRoot, { recursive: true, force: true });
    controller = controllerFor(workspaceRoot, notifications);
    // The persisted record carries only the group: the failed wave and bundle
    // are known only from the group manifest, so no reference comparison sees
    // the failure at all.
    const result = await controller.restore({ waveRoots: [], bundles: [], groupRoots: [groupRoot] });

    assert.equal(result.recovery.complete, false);
    assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["association-unverified"]);
    assert.match(result.recovery.reasons[0]!.id, /task-active/);
    assert.equal(controller.inspect("exec-manifest-only", "task-active").tasks[0]?.waveRoot, waveRoot,
      "the recoverable task and its references are preserved");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("a detach that supersedes the restore's own reconciliation yields restore-superseded, never a stale complete result", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const groupRoot = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const waveRoot = await mkdtemp(join(tmpdir(), "wave-"));
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    await writeSavedGroup(groupRoot, workspaceRoot, "exec-superseded", [settledTask("task-settled", waveRoot)]);
    await rm(waveRoot, { recursive: true, force: true });
    controller = controllerFor(workspaceRoot, notifications);
    const persisted: ExecutionAssociationsSnapshot = {
      waveRoots: [waveRoot],
      bundles: [settledTask("task-settled", waveRoot).bundle!],
      groupRoots: [groupRoot],
    };
    let release!: () => void;
    const paused = new Promise<void>((resolvePaused) => {
      release = resolvePaused;
    });
    let entered!: () => void;
    const enteredProbe = new Promise<void>((resolveEntered) => {
      entered = resolveEntered;
    });
    controller.setFaultHooks({
      restoreReconciling: async () => {
        entered();
        await paused;
      },
    });
    // The reconciliation would reconcile both collected references to an empty
    // required set; a host's live-reference comparison cannot see that this
    // result was proven against a runtime another owner already replaced.
    const restoring = controller.restore(persisted);
    await enteredProbe;
    await controller.detach();
    release();
    const result = await restoring;

    assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["restore-superseded"]);
    assert.equal(result.recovery.complete, false);
    assert.equal(result.recovery.reconciled, 0);
    assert.deepEqual(result.associations, persisted, "the incoming record is reported unchanged");
  } finally {
    controller?.setFaultHooks(undefined);
    await controller?.detach().catch(() => undefined);
  }
});

test("a gone group with a gated bundle and a collapsed same-root gate pair keeps every gated reference", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const sourceRoot = join(temporaryRoot, "gated-target");
  const goneGroup = join(temporaryRoot, "pi-review-execution-collected");
  const waveA = join(temporaryRoot, "wave-gone-a");
  const waveB = join(temporaryRoot, "wave-gone-b");
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    await mkdir(sourceRoot);
    const gate = (taskId: string, paths: string[]) => ({
      executionId: "exec-gated", taskId, sourceRoot, paths,
      activatedAt: "2026-01-01T00:00:00.000Z", manifestPath: join(sourceRoot, "manifest.json"), reason: "conflict",
    });
    const bundles = [
      { version: 1 as const, operationId: "op-a", waveId: "wave-a", taskId: "task-a", waveRoot: waveA, expectedRevision: 2 },
      { version: 1 as const, operationId: "op-b", waveId: "wave-b", taskId: "task-b", waveRoot: waveB, expectedRevision: 2 },
    ];
    const persisted: ExecutionAssociationsSnapshot = {
      waveRoots: [waveA, waveB],
      bundles,
      groupRoots: [goneGroup],
      conflictGates: [gate("task-a", ["a.ts"]), gate("task-b", ["b.ts"])],
    };
    controller = controllerFor(workspaceRoot, notifications);
    const result = await controller.restore(persisted);

    assert.equal(result.recovery.complete, false);
    assert.equal(result.recovery.reconciled, 0);
    assert.deepEqual(result.associations.groupRoots, [goneGroup]);
    assert.ok(result.recovery.reasons.some((reason) => reason.code === "group-unavailable"));
    assert.deepEqual(result.associations.waveRoots, [waveA, waveB],
      "a gated bundle's wave root is never reconciled out before the bundle pass sees the gate");
    assert.deepEqual(result.associations.bundles, bundles, "both gated bundles stay required");
    assert.equal(result.associations.conflictGates?.length, 2, "both persisted gate records survive");
    assert.deepEqual(result.recovery.reasons.map((reason) => reason.code).includes("gate-collapsed"), true,
      "the gate the one-per-root store could not install is reported, not dropped");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("an orphan bundle cleanup already collected is accounted for, not announced as an adoption failure", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const collectedWave = join(temporaryRoot, "legacy-wave-collected");
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    controller = controllerFor(workspaceRoot, notifications);
    const result = await controller.restore({
      waveRoots: [collectedWave],
      bundles: [{ version: 1 as const, operationId: "operation-collected", waveId: "wave-collected", taskId: "task-gone", waveRoot: collectedWave, expectedRevision: 0 }],
      groupRoots: [],
    });

    assert.equal(result.recovery.complete, true, "positively collected work is a settled restore, not a failed one");
    assert.equal(result.recovery.reconciled, 2);
    assert.deepEqual(result.associations, { waveRoots: [], bundles: [], groupRoots: [] });
    assert.deepEqual(notifications, [], "no false 'was not adopted' failure for work cleanup already collected");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("the shared classification leaves a settled window with live wave roots untouched", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const groupRoot = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    // Every settled task keeps a live wave root, and the group also holds an
    // unsettled task: nothing here is collected, so nothing is reconciled and
    // the restored window is preserved as-is.
    const waves = await Promise.all([0, 1, 2].map((index) => mkdtemp(join(temporaryRoot, `wave-live-${index}-`))));
    const tasks = waves.map((wave, index) => settledTask(`task-settled-${index}`, wave));
    tasks.push(waitingTask("task-live"));
    await writeSavedGroup(groupRoot, workspaceRoot, "exec-window", tasks);
    controller = controllerFor(workspaceRoot, notifications);
    const result = await controller.restore({
      waveRoots: waves,
      bundles: tasks.slice(0, 3).map((task) => task.bundle!),
      groupRoots: [groupRoot],
    });
    assert.equal(result.recovery.complete, true);
    assert.equal(result.recovery.reconciled, 0);
    assert.deepEqual(result.associations.waveRoots, waves);
    assert.deepEqual(result.associations.bundles.length, 3);
    assert.deepEqual([...controller.associations().waveRoots].sort(), [...waves].sort(),
      "live wave roots are never dropped by reconciliation");
    assert.equal(controller.inspect("exec-window").tasks.length, 4,
      "the restored settled window and its unsettled task are preserved as-is");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("a detach during the pre-adoption probe stops the old walk before it attaches a group or publishes", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  // A surviving wave root: the bundle is not collected work, so canonical
  // adoption would otherwise be attempted for it.
  const survivingWave = await mkdtemp(join(temporaryRoot, "wave-surviving-"));
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    controller = controllerFor(workspaceRoot, notifications);
    const publishSpy = controller as unknown as {
      publishAssociations: () => Promise<void>;
      groups: Map<string, { root: string }>;
    };
    const originalPublish = publishSpy.publishAssociations.bind(controller);
    let publishes = 0;
    publishSpy.publishAssociations = async () => {
      publishes += 1;
      return originalPublish();
    };
    const orphan = { version: 1 as const, operationId: "op-probe", waveId: "wave-probe", taskId: "task-probe", waveRoot: survivingWave, expectedRevision: 0 };
    let release!: () => void;
    const paused = new Promise<void>((resolvePaused) => {
      release = resolvePaused;
    });
    let entered!: () => void;
    const enteredProbe = new Promise<void>((resolveEntered) => {
      entered = resolveEntered;
    });
    controller.setFaultHooks({
      restoreAdopting: async () => {
        entered();
        await paused;
      },
    });
    const restoring = controller.restore({ waveRoots: [survivingWave], bundles: [orphan], groupRoots: [] });
    await enteredProbe;
    // The probe is still awaiting. The detach completes, capturing a new epoch;
    // adopting now would attach and publish this old task under the new owner.
    await controller.detach();
    release();
    const result = await restoring;

    assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["restore-superseded"]);
    assert.equal(publishSpy.groups.size, 0, "the superseded walk attached no group");
    assert.equal(publishes, 0, "the superseded walk published nothing");
    assert.deepEqual(controller.list(), [], "no adopted task is visible to the new owner");
    assert.deepEqual(result.associations, { waveRoots: [survivingWave], bundles: [orphan], groupRoots: [] },
      "the incoming record is reported unchanged");
  } finally {
    controller?.setFaultHooks(undefined);
    await controller?.detach().catch(() => undefined);
  }
});

test("a group-only snapshot whose research manifest names a missing wave and bundle stays incomplete", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const groupRoot = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const waveRoot = await mkdtemp(join(tmpdir(), "wave-"));
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    const task = inflightTask("task-research", waveRoot);
    await writeSavedGroup(groupRoot, workspaceRoot, "exec-research-manifest-only", [task], "research");
    await rm(waveRoot, { recursive: true, force: true });
    controller = controllerFor(workspaceRoot, notifications);
    // Only the group is in the persisted record: the missing wave and bundle are
    // known only from the group manifest, so no reference comparison sees them.
    const result = await controller.restore({ waveRoots: [], bundles: [], groupRoots: [groupRoot] });

    assert.equal(result.recovery.complete, false,
      "a recoverable research task whose recorded recovery path is gone is never a complete restore");
    assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["association-unverified"]);
    assert.match(result.recovery.reasons[0]!.id, /task-research/);
    const inspection = controller.inspect("exec-research-manifest-only", "task-research");
    assert.equal(inspection.tasks[0]?.waveRoot, waveRoot, "the research task and its references are preserved, not rewritten");
    assert.equal(inspection.tasks[0]?.bundle?.waveRoot, waveRoot);
    assert.ok(notifications.some((message) => /could not be re-verified/.test(message)),
      "the session gets its bounded signal for the lost recovery path");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("a salvage-retaining task evicted from the inline window still protects its archived wave and bundle", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  await initGitRepo(workspaceRoot);
  const waveRoot = await mkdtemp(join(temporaryRoot, "wave-salvaged-"));
  const notifications: string[] = [];
  let seed: BackgroundExecutionController | undefined;
  let restored: BackgroundExecutionController | undefined;
  try {
    seed = controllerFor(workspaceRoot, notifications);
    await seed.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const started = await seed.start([{ title: "salvage retained history", instructions: "seed", acceptanceCriteria: ["done"] }]);
    const executionId = started.executionId;
    const taskId = started.tasks[0]!.taskId;
    const seedInternals = controllerInternals(seed) as ReturnType<typeof controllerInternals> & {
      archivedTasks: Map<string, { integritySha256: string; updatedAt: string }>;
      legacyArchiveHandles: Map<string, { entries: Map<string, { integritySha256: string; updatedAt: string }>; persisted: boolean }>;
    };
    const group = seedInternals.groups.get(executionId)!;
    const task = group.tasks.find((candidate) => candidate.taskId === taskId)!;
    // A force-merge salvage whose ambiguous paths still anchor retained source
    // evidence: artifact cleanup must never treat this task's wave as collected.
    task.waveRoot = waveRoot;
    task.bundle = { version: 1, operationId: `op-${taskId}`, waveId: `wave-${taskId}`, taskId, waveRoot, expectedRevision: 2 };
    task.commands = [{
      instructionId: "cmd-salvage",
      action: "force_merge",
      actor: "user",
      status: "delivered",
      createdAt: "2026-05-05T05:05:05.000Z",
      salvage: {
        reason: "checkpoint unavailable",
        sourceKind: "worktree",
        candidateCommit: "a".repeat(40),
        candidateRef: "refs/review-gate/candidate",
        attributedPaths: [],
        baselineOnlyPaths: [],
        ambiguousPaths: ["keep.ts"],
      },
    }];
    await settleOldestUnsettled(seed, executionId, "salvage retained outcome");

    // Compaction: the settled record leaves the group's inline window and
    // survives only as its authenticated archive, discoverable by exact handle
    // through the durable membership index the production writer just wrote.
    const handle = seedInternals.archivedTasks.get(`${executionId}:${taskId}`) as
      { integritySha256: string; updatedAt: string } | undefined;
    assert.ok(handle, "the settled task has a genuine production-written archive handle");
    seedInternals.legacyArchiveHandles.set(executionId, {
      entries: new Map([[taskId, { integritySha256: handle!.integritySha256, updatedAt: handle!.updatedAt }]]),
      persisted: false,
    });
    const seedGroup = seedInternals.groups.get(executionId)!;
    await seedInternals.save(seedGroup);
    const bundle = seedGroup.tasks.find((candidate) => candidate.taskId === taskId)!.bundle!;
    const evicted = seedGroup.tasks.findIndex((candidate) => candidate.taskId === taskId);
    seedGroup.tasks.splice(evicted, 1);
    seedGroup.settledArchivedCount = (seedGroup.settledArchivedCount ?? 0) + 1;
    await seedInternals.save(seedGroup);
    const groupRoot = seedGroup.root;
    await seed.detach();
    seed = undefined;

    // The wave root is genuinely reclaimed, and an older snapshot still names
    // both of the compacted task's references.
    await rm(waveRoot, { recursive: true, force: true });
    restored = controllerFor(workspaceRoot, notifications);
    const result = await restored.restore({ waveRoots: [waveRoot], bundles: [bundle], groupRoots: [groupRoot] });

    assert.equal(result.recovery.complete, false, "an archive-only owner is never proven collected");
    assert.deepEqual(result.associations.waveRoots, [waveRoot], "the archived owner's wave root stays required");
    assert.deepEqual(result.associations.bundles, [bundle], "the archived owner's bundle stays required");
    // The exact archived history is still readable by handle, which is what the
    // retention requirement is protecting: the same authenticated exact-handle
    // reader the shared rule consults.
    const internals = restored as unknown as {
      groups: Map<string, object>;
      loadArchivedTask: (group: object, taskId: string) => Promise<BackgroundTaskRecord | undefined>;
    };
    const archived = await internals.loadArchivedTask(internals.groups.get(executionId)!, taskId);
    assert.equal(archived?.taskId, taskId, "the compacted task remains readable from its archive");
    assert.equal(archived?.waveRoot, waveRoot);
    assert.ok(archived?.commands.some((command) => command.action === "force_merge"),
      "the salvage provenance survives in the archive");

    // Retention can clear a salvage task's bundle while keeping its wave
    // reference. Restoring that wave-only snapshot has no task id to look the
    // archive owner up by, so the reference stays required: nothing here may
    // infer that a retained archive released it.
    await restored.detach();
    restored = undefined;
    const waveOnly = controllerFor(workspaceRoot, notifications);
    restored = waveOnly;
    const waveOnlyResult = await waveOnly.restore({ waveRoots: [waveRoot], bundles: [], groupRoots: [groupRoot] });
    assert.equal(waveOnlyResult.recovery.complete, false,
      "a wave-only reference cannot be proven collected while archives are retained");
    assert.deepEqual(waveOnlyResult.associations.waveRoots, [waveRoot], "the wave-only reference stays required");
    assert.ok(waveOnlyResult.recovery.reasons.some((reason) => /no exact task handle to verify against retained archives/.test(reason.detail)),
      "the shared rule reports the missing exact handle rather than pruning the reference");
  } finally {
    await seed?.detach().catch(() => undefined);
    await restored?.detach().catch(() => undefined);
  }
});

// #781: modern evicted archives are discovered by exact task handle alone. When
// the archive leaf is obscured rather than verified absent, the lookup is not
// evidence that the archive released its references.
test("an evicted modern archive with an obscured leaf keeps its wave and bundle references required", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  await initGitRepo(workspaceRoot);
  const waveRoot = await mkdtemp(join(temporaryRoot, "wave-obscured-archive-"));
  const notifications: string[] = [];
  let seed: BackgroundExecutionController | undefined;
  let restored: BackgroundExecutionController | undefined;
  try {
    seed = controllerFor(workspaceRoot, notifications);
    await seed.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const started = await seed.start([{ title: "compacted salvage history", instructions: "seed", acceptanceCriteria: ["done"] }]);
    const executionId = started.executionId;
    const taskId = started.tasks[0]!.taskId;
    const seedInternals = controllerInternals(seed) as ReturnType<typeof controllerInternals> & {
      archivedTasks: Map<string, { integritySha256: string; updatedAt: string }>;
    };
    const group = seedInternals.groups.get(executionId)!;
    const task = group.tasks.find((candidate) => candidate.taskId === taskId)!;
    task.waveRoot = waveRoot;
    task.bundle = { version: 1, operationId: `op-${taskId}`, waveId: `wave-${taskId}`, taskId, waveRoot, expectedRevision: 2 };
    task.commands = [{
      instructionId: "cmd-salvage-obscured",
      action: "force_merge",
      actor: "user",
      status: "delivered",
      createdAt: "2026-05-05T05:05:05.000Z",
      salvage: {
        reason: "checkpoint unavailable",
        sourceKind: "worktree",
        candidateCommit: "a".repeat(40),
        candidateRef: "refs/review-gate/candidate",
        attributedPaths: [],
        baselineOnlyPaths: [],
        ambiguousPaths: ["keep.ts"],
      },
    }];
    await settleOldestUnsettled(seed, executionId, "salvage retained outcome");

    // Modern compaction: the settled record leaves the inline window and is
    // discoverable only by exact task handle — no legacy membership handle.
    assert.ok(seedInternals.archivedTasks.get(`${executionId}:${taskId}`),
      "precondition: the production writer archived the evicted task");
    const seedGroup = seedInternals.groups.get(executionId)!;
    await seedInternals.save(seedGroup);
    const bundle = seedGroup.tasks.find((candidate) => candidate.taskId === taskId)!.bundle!;
    seedGroup.tasks.splice(seedGroup.tasks.findIndex((candidate) => candidate.taskId === taskId), 1);
    seedGroup.settledArchivedCount = (seedGroup.settledArchivedCount ?? 0) + 1;
    await seedInternals.save(seedGroup);
    const groupRoot = seedGroup.root;
    await seed.detach();
    seed = undefined;

    // The archive leaf is obscured: a dangling symlink where the archive lives,
    // which `readFile` reports as ENOENT. The wave root is genuinely reclaimed.
    const archivePath = join(groupRoot, "tasks", `${taskId}.json`);
    await rm(archivePath, { force: true });
    await symlink(join(temporaryRoot, "already-removed-by-compaction.json"), archivePath);
    await rm(waveRoot, { recursive: true, force: true });

    restored = controllerFor(workspaceRoot, notifications);
    const result = await restored.restore({ waveRoots: [waveRoot], bundles: [bundle], groupRoots: [groupRoot] });

    assert.equal(result.recovery.complete, false,
      "an obscured archive lookup never proves its references were released");
    assert.deepEqual(result.associations.waveRoots, [waveRoot],
      "the obscured archive's wave root stays required even though the wave really is gone");
    assert.deepEqual(result.associations.bundles, [bundle],
      "the obscured archive's persisted bundle stays required");
    // The mechanism, read directly: the exact validated archive path is not
    // positively absent, so an `undefined` archive read is not "no claimant".
    assert.equal(await ownedTaskArchiveIsPositivelyAbsent(groupRoot, taskId), false,
      "a dangling symlink at the archive path is an obscured lookup, not verified absence");

    // Contrast: with the archive genuinely gone at that same path, the exact
    // handle lookup finds no owner and both references are collected work.
    await restored.detach();
    restored = undefined;
    await rm(archivePath, { force: true });
    const cleared = controllerFor(workspaceRoot, notifications);
    restored = cleared;
    const clearedResult = await cleared.restore({ waveRoots: [waveRoot], bundles: [bundle], groupRoots: [groupRoot] });
    assert.deepEqual(clearedResult.associations.bundles, [],
      "a verified-absent archive releases the bundle reference");
    assert.deepEqual(clearedResult.associations.waveRoots, [],
      "a verified-absent archive releases the wave reference with it");
  } finally {
    await seed?.detach().catch(() => undefined);
    await restored?.detach().catch(() => undefined);
  }
});


test("a group-only execute snapshot whose non-settled task names a bundle but no wave root stays incomplete", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const undispatched = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    // The legitimate counterpart: an undispatched task legitimately has neither
    // field and is verified by its record alone.
    const neither = inflightTask("task-undispatched", join(temporaryRoot, "wave-undispatched"));
    neither.waveRoot = undefined;
    neither.bundle = undefined;
    await writeSavedGroup(undispatched, workspaceRoot, "exec-undispatched", [neither]);

    controller = controllerFor(workspaceRoot, notifications);
    // Every non-settled shape that names a recovery bundle without its wave
    // ownership anchor: canonical recovery refuses the bundle, so none of them
    // may read as verified or stay dispatchable after the restart.
    for (const state of ["paused_recoverable", "stopped_for_application_exit", "queued"] as const) {
      const groupRoot = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
      const executionId = `exec-${state}`;
      const bundleOnly = inflightTask(`task-${state}`, join(temporaryRoot, `wave-${state}`));
      bundleOnly.waveRoot = undefined;
      bundleOnly.state = state;
      await writeSavedGroup(groupRoot, workspaceRoot, executionId, [bundleOnly]);

      const result = await controller.restore({ waveRoots: [], bundles: [], groupRoots: [groupRoot] });
      assert.deepEqual(result.recovery.reasons.map((reason) => reason.code), ["association-unverified"],
        `${state}: the missing wave anchor reaches the existing structured failure path`);
      assert.match(result.recovery.reasons[0]!.id, new RegExp(`task-${state}`));
      const kept: BackgroundTaskRecord = controller.inspect(executionId, `task-${state}`).tasks[0]!;
      assert.equal(kept.state, "paused_recoverable", `${state}: an unverified recovery path is never left dispatchable`);
      assert.equal(kept.pendingContinuation, undefined, `${state}: no continuation is invented for an unverified bundle`);
      assert.equal(kept.waveRoot, undefined, `${state}: the record is preserved, not rewritten`);
      assert.equal(kept.bundle?.operationId, `op-task-${state}`, `${state}: the recorded bundle is preserved`);
    }

    const verified = await controller.restore({ waveRoots: [], bundles: [], groupRoots: [undispatched] });
    assert.equal(verified.recovery.complete, true, "an undispatched task with neither field stays verified");
    assert.deepEqual(verified.recovery.reasons, []);
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("two distinct same-root gates stay an owner hold that protects their work, refuses MarkClean, and ends with the owner", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const siblingGroup = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const installedGroup = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const sourceRoot = await mkdtemp(join(temporaryRoot, "target-"));
  const siblingWave = await mkdtemp(join(tmpdir(), "wave-sibling-"));
  const installedWave = await mkdtemp(join(tmpdir(), "wave-installed-"));
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    const gate = (executionId: string, taskId: string, paths: string[]) => ({
      executionId, taskId, sourceRoot, paths,
      activatedAt: "2026-01-01T00:00:00.000Z", manifestPath: join(sourceRoot, "manifest.json"), reason: "conflict",
    });
    await writeSavedGroup(siblingGroup, workspaceRoot, "exec-sibling", [settledTask("task-sibling", siblingWave)]);
    await writeSavedGroup(installedGroup, workspaceRoot, "exec-installed", [settledTask("task-installed", installedWave)]);
    const persisted: ExecutionAssociationsSnapshot = {
      waveRoots: [siblingWave, installedWave],
      bundles: [settledTask("task-sibling", siblingWave).bundle!, settledTask("task-installed", installedWave).bundle!],
      groupRoots: [siblingGroup, installedGroup],
      // Two DISTINCT gates for one source root: the store can install one.
      conflictGates: [gate("exec-sibling", "task-sibling", ["s.ts"]), gate("exec-installed", "task-installed", ["i.ts"])],
    };
    controller = controllerFor(workspaceRoot, notifications);
    const result = await controller.restore(persisted);

    assert.equal(result.recovery.complete, false);
    assert.ok(result.recovery.reasons.some((reason) => reason.code === "gate-collapsed"),
      "the gate the one-per-root store could not install is reported, not dropped");
    assert.equal(result.associations.conflictGates?.length, 2, "both gate records survive for this owner");
    const holds = (controller as unknown as { restoreOmittedSiblingGates: Map<string, unknown> }).restoreOmittedSiblingGates;
    assert.equal(holds.size, 1, "the omitted sibling stays an owner-specific hold, not a discarded record");

    // Shutdown/cleanup protection: the sibling's group is entirely settled and
    // carries no live gate, so only the hold can keep it intact.
    await controller.cleanupSettledArtifacts();
    assert.ok((await lstat(siblingWave)).isDirectory(), "the held sibling's wave root is never cleaned");
    const held = controller.inspect("exec-sibling", "task-sibling").tasks[0]!;
    assert.equal(held.waveRoot, siblingWave, "the held sibling's task keeps its references");
    assert.ok(held.bundle !== undefined);
    assert.ok(controller.list().some((group) => group.executionId === "exec-sibling"),
      "the held sibling's group is never retired");

    // No clearance can release the held root: the sibling's conflict was never
    // validated, so refusing is the only safe outcome.
    await assert.rejects(() => controller!.markClean(), /MarkClean refused/);

    await controller.detach();
    assert.equal(holds.size, 0, "an owner-specific hold never outlives its owner");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("an absent wave-only reference stays unresolved while a required gate has no restored task, even though its group is gone", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const goneGroup = join(temporaryRoot, "pi-review-execution-gone");
  const sourceRoot = await mkdtemp(join(temporaryRoot, "target-"));
  const orphanWave = join(temporaryRoot, "wave-orphan");   // never created: positively absent
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    const persisted: ExecutionAssociationsSnapshot = {
      waveRoots: [orphanWave],
      bundles: [],
      groupRoots: [goneGroup],
      conflictGates: [{
        executionId: "exec-gone", taskId: "task-gone", sourceRoot, paths: ["x.ts"],
        activatedAt: "2026-01-01T00:00:00.000Z", manifestPath: join(sourceRoot, "manifest.json"), reason: "conflict",
      }],
    };
    controller = controllerFor(workspaceRoot, notifications);
    const result = await controller.restore(persisted);

    assert.deepEqual(result.associations.groupRoots, [goneGroup],
      "the gone group directory may own the task this gate still protects");
    assert.deepEqual(result.associations.waveRoots, [orphanWave],
      "a required gate with no restored task keeps its wave-only reference required, even with the group gone");
    assert.equal(result.recovery.complete, false);
    assert.ok(
      result.recovery.reasons.some((reason) => reason.code === "group-unavailable" && /no restored task to anchor it/.test(reason.detail)),
      "the shared result says why the missing group cannot be proven released",
    );

    await controller.detach();
    controller = controllerFor(workspaceRoot, notifications);
    const ungated = await controller.restore({ ...persisted, conflictGates: undefined });
    assert.equal(ungated.recovery.complete, true);
    assert.deepEqual(ungated.associations.groupRoots, []);
    assert.deepEqual(ungated.associations.waveRoots, [],
      "with no required gate, the same absent wave-only reference is collected work");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("a replacing restore drops the outgoing owner's sibling holds instead of merging them, so the new owner's MarkClean stands on its own record", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const siblingGroup = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const installedGroup = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const sourceRoot = await mkdtemp(join(temporaryRoot, "target-"));
  const siblingWave = await mkdtemp(join(tmpdir(), "wave-owner-sibling-"));
  const installedWave = await mkdtemp(join(tmpdir(), "wave-owner-installed-"));
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    await writeFile(join(sourceRoot, "i.ts"), "cleared\n", "utf8");
    const gate = (executionId: string, taskId: string, paths: string[]) => ({
      executionId, taskId, sourceRoot, paths,
      activatedAt: "2026-01-01T00:00:00.000Z", manifestPath: join(sourceRoot, "manifest.json"), reason: "conflict",
    });
    const gateSibling = gate("exec-sibling", "task-sibling", ["s.ts"]);
    const gateInstalled = gate("exec-installed", "task-installed", ["i.ts"]);
    await writeSavedGroup(siblingGroup, workspaceRoot, "exec-sibling", [settledTask("task-sibling", siblingWave)]);
    await writeSavedGroup(installedGroup, workspaceRoot, "exec-installed", [settledTask("task-installed", installedWave)]);
    const persisted: ExecutionAssociationsSnapshot = {
      waveRoots: [siblingWave, installedWave],
      bundles: [settledTask("task-sibling", siblingWave).bundle!, settledTask("task-installed", installedWave).bundle!],
      groupRoots: [siblingGroup, installedGroup],
      conflictGates: [gateSibling, gateInstalled],
    };
    controller = controllerFor(workspaceRoot, notifications);
    const first = await controller.restore(persisted);
    assert.equal(first.recovery.reasons.filter((reason) => reason.code === "gate-collapsed").length, 1);
    const holds = (controller as unknown as { restoreOmittedSiblingGates: Map<string, unknown> }).restoreOmittedSiblingGates;
    assert.equal(holds.size, 1, "the first owner holds the gate its store could not install");
    await assert.rejects(() => controller!.markClean(), /MarkClean refused/);

    // A replacing restore on the SAME controller, with no explicit detach in
    // between, carries only the installed gate. The outgoing owner's hold is
    // not merged into this owner's state.
    const second = await controller.restore({ ...persisted, waveRoots: [installedWave], bundles: [settledTask("task-installed", installedWave).bundle!], conflictGates: [gateInstalled] });
    assert.equal(second.recovery.complete, true, "this owner's own record carries no collapse");
    assert.deepEqual(second.recovery.reasons.filter((reason) => reason.code === "gate-collapsed"), []);
    assert.equal(holds.size, 0, "the outgoing owner's sibling hold never carries into the replacing owner");

    // The hazard: had that hold survived, this owner's clearance would refuse
    // on the outgoing owner's task.
    const cleaned = await controller.markClean();
    assert.equal(cleaned.cleared, true, "the new owner clears the gate its own record established");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("a required gate is anchored only by its own execution's task, never by a matching task id in another execution", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const liveGroup = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const goneGroup = join(temporaryRoot, "pi-review-execution-gone");
  const sourceRoot = await mkdtemp(join(temporaryRoot, "target-"));
  const orphanWave = join(temporaryRoot, "wave-cross-execution");   // never created: positively absent
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    // A different authenticated execution restored the SAME task id.
    await writeSavedGroup(liveGroup, workspaceRoot, "exec-live", [waitingTask("task-gone")]);
    const persisted = (gateExecutionId: string): ExecutionAssociationsSnapshot => ({
      waveRoots: [orphanWave],
      bundles: [],
      groupRoots: [goneGroup, liveGroup],
      conflictGates: [{
        executionId: gateExecutionId, taskId: "task-gone", sourceRoot, paths: ["x.ts"],
        activatedAt: "2026-01-01T00:00:00.000Z", manifestPath: join(sourceRoot, "manifest.json"), reason: "conflict",
      }],
    });
    controller = controllerFor(workspaceRoot, notifications);
    const foreign = await controller.restore(persisted("exec-gone"));
    assert.deepEqual(foreign.associations.groupRoots, [goneGroup, liveGroup]);
    assert.deepEqual(foreign.associations.waveRoots, [orphanWave],
      "a task id restored under another execution never proves this gate's work was released");
    assert.equal(foreign.recovery.complete, false);
    assert.ok(
      foreign.recovery.reasons.some((reason) => reason.code === "group-unavailable" && /no restored task to anchor it/.test(reason.detail)),
      "the absent group stays required while the gate has no task in its own execution",
    );

    // The exact execution/task pair is what anchors it.
    await controller.detach();
    controller = controllerFor(workspaceRoot, notifications);
    const anchored = await controller.restore(persisted("exec-live"));
    assert.equal(anchored.recovery.complete, true);
    assert.deepEqual(anchored.associations.groupRoots, [liveGroup]);
    assert.deepEqual(anchored.associations.waveRoots, [],
      "with its own execution's task restored, the gate anchors its work and the absent wave-only reference reconciles");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("a restored research continuation whose wave directory survives without its recovery metadata is paused before dispatch", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  const groupRoot = await mkdtemp(join(temporaryRoot, "pi-review-execution-"));
  const waveRoot = await mkdtemp(join(temporaryRoot, "wave-research-"));   // exists, but holds no capture record
  const notifications: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    const task = waitingTask("task-research");
    const researchResult: NonNullable<BackgroundTaskRecord["researchResult"]> = {
      status: "completed",
      taskId: "task-research",
      title: "survey the sources",
      summary: "one turn recorded",
      adapter: "unit-test",
      bundle: { version: 1, operationId: "op-research", waveId: "wave-research", taskId: "task-research", waveRoot, expectedRevision: 0 },
    };
    task.waveRoot = waveRoot;
    task.researchResult = researchResult;
    task.bundle = researchResult.bundle!;
    task.pendingContinuation = { instructions: "finish the report with the captured evidence", instructionId: "cmd-queued-research" };
    task.commands = [{
      instructionId: "cmd-queued-research",
      action: "continue",
      actor: "model",
      text: "finish the report with the captured evidence",
      status: "queued",
      createdAt: "2026-05-05T05:05:05.000Z",
    }];
    await writeSavedGroup(groupRoot, workspaceRoot, "exec-research", [task], "research");
    controller = controllerFor(workspaceRoot, notifications);
    const result = await controller.restore({ waveRoots: [waveRoot], bundles: [task.bundle!], groupRoots: [groupRoot] });

    assert.equal(result.recovery.complete, false,
      "a surviving wave directory is not a verified research association");
    const reason = result.recovery.reasons.find((entry) => entry.id.includes("task-research"));
    assert.ok(reason !== undefined, `expected a research association reason, got ${JSON.stringify(result.recovery.reasons)}`);
    assert.equal(reason!.kind, "bundle");
    assert.equal(reason!.code, "bundle-in-flight");

    const kept = controller.inspect("exec-research", "task-research").tasks[0]!;
    assert.equal(kept.state, "paused_recoverable",
      "the continuation is never dispatchable on an association this restore could not re-authenticate");
    assert.equal(kept.pendingContinuation?.instructions, "finish the report with the captured evidence",
      "the runner clears the pending instruction before reading metadata, so it must survive here");
    assert.equal(kept.pendingContinuation?.instructionId, "cmd-queued-research");
    assert.deepEqual(kept.commands, [task.commands![0]],
      "the queued instruction is neither delivered nor re-queued under a new id");
    assert.equal(kept.waveRoot, waveRoot, "the surviving wave reference is preserved");
    assert.deepEqual(await readdir(waveRoot), [], "the wave directory itself is left untouched");

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(controllerInternals(controller).activeTasks.size, 0,
      "no executor runs for an unverified research continuation");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

/** A persisted continuation whose top-level recovery anchors are both gone. */
function anchorlessContinuation(taskId: string, state: "queued" | "stopped_for_application_exit"): BackgroundTaskRecord {
  const task = waitingTask(taskId);
  task.state = state;
  task.pendingContinuation = { instructions: "finish the interrupted work", instructionId: "cmd-lost-anchor" };
  task.commands = [{
    instructionId: "cmd-lost-anchor",
    action: "continue",
    actor: "model",
    text: "finish the interrupted work",
    status: "queued",
    createdAt: "2026-05-05T05:05:05.000Z",
  }];
  return task;
}

test("a pending continuation with no top-level wave or bundle is dispatched work, never an undispatched task", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  for (const kind of ["execute", "research"] as const) {
    for (const state of ["queued", "stopped_for_application_exit"] as const) {
      const workspaceRoot = await mkdtemp(join(temporaryRoot, `workspace-${kind}-${state}-`));
      const groupRoot = await mkdtemp(join(temporaryRoot, `pi-review-execution-${kind}-${state}-`));
      const notifications: string[] = [];
      let controller: BackgroundExecutionController | undefined;
      try {
        const task = anchorlessContinuation(`task-${kind}-${state}`, state);
        await writeSavedGroup(groupRoot, workspaceRoot, `exec-${kind}-${state}`, [task], kind);
        controller = controllerFor(workspaceRoot, notifications);
        const result = await controller.restore({ waveRoots: [], bundles: [], groupRoots: [groupRoot] });

        assert.equal(result.recovery.complete, false,
          `${kind}/${state}: a pending continuation is not a fresh task`);
        assert.ok(
          result.recovery.reasons.some((reason) => reason.code === "association-unverified"),
          `${kind}/${state}: the missing anchor is reported, got ${JSON.stringify(result.recovery.reasons)}`,
        );

        const kept = controller.inspect(`exec-${kind}-${state}`, task.taskId).tasks[0]!;
        assert.equal(kept.state, "paused_recoverable",
          `${kind}/${state}: the continuation is never dispatchable without its recovery anchor`);
        assert.equal(kept.pendingContinuation?.instructions, "finish the interrupted work");
        assert.equal(kept.pendingContinuation?.instructionId, "cmd-lost-anchor");
        assert.deepEqual(kept.commands, [task.commands[0]],
          `${kind}/${state}: the pending command is neither delivered nor re-queued under a new id`);
        assert.equal(kept.commands[0]!.status, "queued");
        assert.equal(kept.commands[0]!.deliveredAt, undefined);
        await controller.detach();
        controller = undefined;
      } finally {
        await controller?.detach().catch(() => undefined);
      }
    }
  }
});

test("a restored research continuation is refused when the prior-result checkpoint the runner needs is missing or different", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  await initGitRepo(workspaceRoot);
  const taskId = "task-research-cp";
  let controller: BackgroundExecutionController | undefined;
  try {
    // A real captured wave with a real, verified on-disk recovery checkpoint.
    const capture = await captureWaveBase({
      cwd: workspaceRoot,
      maxSnapshotBytes: 1_000_000,
      waveId: "wave-research-cp",
      artifactDir: await mkdtemp(join(temporaryRoot, "artifacts-")),
    });
    const worktree = await createWorkerWorktree(capture, taskId);
    const research = researchWorktree(capture, taskId);
    assert.equal(await realpath(worktree.worktreeRoot), await realpath(research.worktreeRoot));
    const candidate = await normalizeCandidate(capture, worktree.worktreeRoot, taskId, "survey the sources");
    assert.equal(candidate.differsFromBase, false, "an unchanged worktree checkpoints without a diff");
    const operation = createOperationRecord({
      waveId: capture.waveId,
      taskId,
      title: "survey the sources",
      worktreeRoot: research.worktreeRoot,
      effectiveCwd: research.effectiveCwd,
      artifactDir: join(capture.waveRoot, "artifacts", taskId),
      retryBudget: 0,
    });
    operation.state = "landed";
    const checkpoint = {
      checkpointId: `${capture.waveId}/${taskId}:${candidate.commitSha.slice(0, 12)}`,
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
      ref: candidate.candidateRef,
      differsFromBase: candidate.differsFromBase,
      createdAt: "2026-05-05T05:05:05.000Z",
      verified: true,
      changedPaths: [],
    };
    operation.checkpoint = checkpoint;
    await writeOperationRecord(operation);
    const bundle = createReattachmentBundle(operation, capture.waveRoot);

    const restoreWith = async (priorCheckpoint: typeof checkpoint | undefined) => {
      const groupRoot = await mkdtemp(join(temporaryRoot, "pi-review-execution-cp-"));
      const task = waitingTask(taskId);
      task.waveRoot = capture.waveRoot;
      task.bundle = bundle;
      task.researchResult = {
        status: "completed",
        taskId,
        title: "survey the sources",
        summary: "one turn recorded",
        adapter: "unit-test",
        bundle,
        checkpoint: priorCheckpoint,
      };
      task.pendingContinuation = { instructions: "keep going with the captured evidence", instructionId: "cmd-cp" };
      task.commands = [{
        instructionId: "cmd-cp",
        action: "continue",
        actor: "model",
        text: "keep going with the captured evidence",
        status: "queued",
        createdAt: "2026-05-05T05:05:05.000Z",
      }];
      await writeSavedGroup(groupRoot, workspaceRoot, "exec-research-cp", [task], "research");
      await controller?.detach();
      controller = researchDispatchController(workspaceRoot, []);
      const result = await controller.restore({ waveRoots: [capture.waveRoot], bundles: [bundle], groupRoots: [groupRoot] });
      return { result, controller };
    };

    // Missing prior-result checkpoint.
    const missing = await restoreWith(undefined);
    assert.equal(missing.result.recovery.complete, false,
      "a valid operation checkpoint alone does not make a no-candidate continuation resumable");
    assert.ok(
      missing.result.recovery.reasons.some((reason) => /unchanged verified recovery checkpoint/.test(reason.detail)),
      `the refusal names the checkpoint pair, got ${JSON.stringify(missing.result.recovery.reasons)}`,
    );
    const paused = missing.controller.inspect("exec-research-cp", taskId).tasks[0]!;
    assert.equal(paused.state, "paused_recoverable");
    assert.equal(paused.pendingContinuation?.instructions, "keep going with the captured evidence");
    assert.equal(paused.commands[0]!.status, "queued");
    assert.equal(paused.commands[0]!.deliveredAt, undefined, "the command is never marked delivered");

    // A prior-result checkpoint that differs from the operation's.
    const mismatched = await restoreWith({ ...checkpoint, checkpointId: "wave-research-cp/other:000000000000" });
    assert.equal(mismatched.result.recovery.complete, false);
    assert.ok(
      mismatched.result.recovery.reasons.some((reason) => /does not match the prior durable result/.test(reason.detail)),
      `the mismatch is reported, got ${JSON.stringify(mismatched.result.recovery.reasons)}`,
    );
    const stillPaused = mismatched.controller.inspect("exec-research-cp", taskId).tasks[0]!;
    assert.equal(stillPaused.state, "paused_recoverable");
    assert.equal(stillPaused.commands[0]!.deliveredAt, undefined);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(controllerInternals(mismatched.controller).activeTasks.size, 0,
      "the research route is live, so this zero means the continuation really was not dispatched");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("a restored research continuation with a dirty retained worktree is paused instead of consuming its command", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  await initGitRepo(workspaceRoot);
  const taskId = "task-research-dirty";
  let controller: BackgroundExecutionController | undefined;
  try {
    // A wave whose checkpoints are valid AND matching: the only thing wrong is
    // that the retained private worktree is no longer unchanged.
    const capture = await captureWaveBase({
      cwd: workspaceRoot,
      maxSnapshotBytes: 1_000_000,
      waveId: "wave-research-dirty",
      artifactDir: await mkdtemp(join(temporaryRoot, "artifacts-")),
    });
    const worktree = await createWorkerWorktree(capture, taskId);
    const research = researchWorktree(capture, taskId);
    const candidate = await normalizeCandidate(capture, worktree.worktreeRoot, taskId, "survey the sources");
    const operation = createOperationRecord({
      waveId: capture.waveId,
      taskId,
      title: "survey the sources",
      worktreeRoot: research.worktreeRoot,
      effectiveCwd: research.effectiveCwd,
      artifactDir: join(capture.waveRoot, "artifacts", taskId),
      retryBudget: 0,
    });
    operation.state = "landed";
    const checkpoint = {
      checkpointId: `${capture.waveId}/${taskId}:${candidate.commitSha.slice(0, 12)}`,
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
      ref: candidate.candidateRef,
      differsFromBase: candidate.differsFromBase,
      createdAt: "2026-05-05T05:05:05.000Z",
      verified: true,
      changedPaths: [],
    };
    operation.checkpoint = checkpoint;
    await writeOperationRecord(operation);
    const bundle = createReattachmentBundle(operation, capture.waveRoot);

    // The retained worktree changed after the prior turn.
    const stray = join(research.worktreeRoot, "scratch-after-the-turn.txt");
    await writeFile(stray, "left behind by hand\n", "utf8");

    const groupRoot = await mkdtemp(join(temporaryRoot, "pi-review-execution-dirty-"));
    const task = waitingTask(taskId);
    task.waveRoot = capture.waveRoot;
    task.bundle = bundle;
    task.researchResult = {
      status: "completed",
      taskId,
      title: "survey the sources",
      summary: "one turn recorded",
      adapter: "unit-test",
      bundle,
      checkpoint,
    };
    task.pendingContinuation = { instructions: "keep going with the captured evidence", instructionId: "cmd-dirty" };
    task.commands = [{
      instructionId: "cmd-dirty",
      action: "continue",
      actor: "model",
      text: "keep going with the captured evidence",
      status: "queued",
      createdAt: "2026-05-05T05:05:05.000Z",
    }];
    await writeSavedGroup(groupRoot, workspaceRoot, "exec-research-dirty", [task], "research");

    controller = researchDispatchController(workspaceRoot, []);
    const result = await controller.restore({ waveRoots: [capture.waveRoot], bundles: [bundle], groupRoots: [groupRoot] });

    assert.equal(result.recovery.complete, false,
      "a pinned checkpoint proves committed contents, not the retained worktree");
    assert.ok(
      result.recovery.reasons.some((reason) => /private workspace changed after the prior turn/.test(reason.detail)),
      `the refusal names the changed workspace, got ${JSON.stringify(result.recovery.reasons)}`,
    );

    const kept = controller.inspect("exec-research-dirty", taskId).tasks[0]!;
    assert.equal(kept.state, "paused_recoverable",
      "the continuation is never dispatchable into a workspace the runner would refuse");
    assert.equal(kept.pendingContinuation?.instructions, "keep going with the captured evidence");
    assert.equal(kept.commands[0]!.status, "queued");
    assert.equal(kept.commands[0]!.deliveredAt, undefined, "the command is never marked delivered");
    await assert.rejects(controller.continueTask({
      executionId: "exec-research-dirty", taskId, actor: "model",
      instructionId: "manual-retry-dirty-research", instructions: "Try the same research again",
    }), /private workspace changed after the prior turn/);
    const afterRetry = controller.inspect("exec-research-dirty", taskId).tasks[0]!;
    assert.equal(afterRetry.state, "paused_recoverable");
    assert.deepEqual(afterRetry.pendingContinuation, kept.pendingContinuation);
    assert.deepEqual(afterRetry.commands, kept.commands);

    assert.equal(await readFile(stray, "utf8"), "left behind by hand\n",
      "restore never cleans or overwrites the changed workspace");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(controllerInternals(controller).activeTasks.size, 0,
      "the research route is live, so this zero means the continuation really was not dispatched");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("a restored research continuation whose retained worktree has HEAD attached is refused before its command is consumed", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  await initGitRepo(workspaceRoot);
  const taskId = "task-research-attached";
  let controller: BackgroundExecutionController | undefined;
  try {
    // A fully valid wave: verified checkpoint, matching prior result, and a
    // perfectly clean working tree. The only defect is Git HEAD attachment.
    const capture = await captureWaveBase({
      cwd: workspaceRoot,
      maxSnapshotBytes: 1_000_000,
      waveId: "wave-research-attached",
      artifactDir: await mkdtemp(join(temporaryRoot, "artifacts-")),
    });
    const worktree = await createWorkerWorktree(capture, taskId);
    const research = researchWorktree(capture, taskId);
    const candidate = await normalizeCandidate(capture, worktree.worktreeRoot, taskId, "survey the sources");
    const operation = createOperationRecord({
      waveId: capture.waveId,
      taskId,
      title: "survey the sources",
      worktreeRoot: research.worktreeRoot,
      effectiveCwd: research.effectiveCwd,
      artifactDir: join(capture.waveRoot, "artifacts", taskId),
      retryBudget: 0,
    });
    operation.state = "landed";
    const checkpoint = {
      checkpointId: `${capture.waveId}/${taskId}:${candidate.commitSha.slice(0, 12)}`,
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
      ref: candidate.candidateRef,
      differsFromBase: candidate.differsFromBase,
      createdAt: "2026-05-05T05:05:05.000Z",
      verified: true,
      changedPaths: [],
    };
    operation.checkpoint = checkpoint;
    await writeOperationRecord(operation);
    const bundle = createReattachmentBundle(operation, capture.waveRoot);

    // Attach HEAD to a branch in the retained worktree; contents stay unchanged.
    await fixtureGit(research.worktreeRoot, "switch", "-c", "attached-by-hand");
    assert.equal(await fixtureGit(research.worktreeRoot, "status", "--porcelain"), "",
      "the working tree is clean, so only the Git ownership check can catch this");

    const groupRoot = await mkdtemp(join(temporaryRoot, "pi-review-execution-attached-"));
    const task = waitingTask(taskId);
    task.waveRoot = capture.waveRoot;
    task.bundle = bundle;
    task.researchResult = {
      status: "completed",
      taskId,
      title: "survey the sources",
      summary: "one turn recorded",
      adapter: "unit-test",
      bundle,
      checkpoint,
    };
    task.pendingContinuation = { instructions: "keep going with the captured evidence", instructionId: "cmd-attached" };
    task.commands = [{
      instructionId: "cmd-attached",
      action: "continue",
      actor: "model",
      text: "keep going with the captured evidence",
      status: "queued",
      createdAt: "2026-05-05T05:05:05.000Z",
    }];
    await writeSavedGroup(groupRoot, workspaceRoot, "exec-research-attached", [task], "research");

    controller = researchDispatchController(workspaceRoot, []);
    const result = await controller.restore({ waveRoots: [capture.waveRoot], bundles: [bundle], groupRoots: [groupRoot] });

    assert.equal(result.recovery.complete, false,
      "a clean working tree does not make an attached-HEAD workspace resumable");
    assert.ok(
      result.recovery.reasons.some((reason) => /must use detached HEAD/.test(reason.detail)),
      `the refusal names the runner's detached-HEAD policy, got ${JSON.stringify(result.recovery.reasons)}`,
    );

    const kept = controller.inspect("exec-research-attached", taskId).tasks[0]!;
    assert.equal(kept.state, "paused_recoverable",
      "the continuation is never dispatchable into a workspace the runner would refuse");
    assert.equal(kept.pendingContinuation?.instructions, "keep going with the captured evidence");
    assert.equal(kept.commands[0]!.status, "queued");
    assert.equal(kept.commands[0]!.deliveredAt, undefined, "the command is never marked delivered");

    // Restore refuses; it never repairs the workspace behind the owner's back.
    assert.equal(await fixtureGit(research.worktreeRoot, "symbolic-ref", "--short", "HEAD"), "attached-by-hand");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(controllerInternals(controller).activeTasks.size, 0,
      "the research route is live, so this zero means the continuation really was not dispatched");
  } finally {
    await controller?.detach().catch(() => undefined);
  }
});

test("a wave this restore proves collected by clearing its own settled claimant is not reported as an unclaimed orphan", async (t) => {
  const temporaryRoot = await privateTempRoot(t);
  const workspaceRoot = await mkdtemp(join(temporaryRoot, "workspace-"));
  await initGitRepo(workspaceRoot);
  const waveRoot = await mkdtemp(join(temporaryRoot, "wave-collected-"));
  const notifications: string[] = [];
  let seed: BackgroundExecutionController | undefined;
  let restored: BackgroundExecutionController | undefined;
  try {
    seed = controllerFor(workspaceRoot, notifications);
    await seed.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const started = await seed.start([{ title: "collected completed history", instructions: "seed", acceptanceCriteria: ["done"] }]);
    const executionId = started.executionId;
    const taskId = started.tasks[0]!.taskId;
    const seedInternals = controllerInternals(seed);
    const group = seedInternals.groups.get(executionId)!;
    const task = group.tasks.find((candidate) => candidate.taskId === taskId)!;
    // A settled task that names only its wave: retention already cleared any
    // bundle, so the incoming snapshot carries the wave with no bundle either.
    task.waveRoot = waveRoot;
    task.bundle = undefined;
    await settleOldestUnsettled(seed, executionId, "landed outcome for the report");
    const settled = group.tasks.find((candidate) => candidate.taskId === taskId)!;
    settled.bundle = undefined;
    assert.ok(settled.waveRoot === undefined || settled.waveRoot === waveRoot);
    // Unrelated compacted history in the same authenticated group: archives are
    // retained, which is what previously made the wave look unverifiable.
    group.settledArchivedCount = (group.settledArchivedCount ?? 0) + 1;
    await seedInternals.save(group);
    const groupRoot = group.root;
    await seed.detach();
    seed = undefined;

    // The wave is genuinely reclaimed, and the persisted record still names it.
    await rm(waveRoot, { recursive: true, force: true });
    restored = controllerFor(workspaceRoot, notifications);
    const result = await restored.restore({ waveRoots: [waveRoot], bundles: [], groupRoots: [groupRoot] });

    assert.equal(result.recovery.complete, true,
      "a wave this restore itself proved collected is reconciled out, not kept as an orphan");
    assert.deepEqual(result.associations.waveRoots, [],
      "the collected wave does not survive the first save and keep hosted persistence closed");
    assert.ok(result.recovery.reconciled >= 1, "the wave is counted as reconciled work");
    assert.deepEqual(result.recovery.reasons.filter((reason) => reason.kind === "wave"), [],
      "no wave reason is reported for work this walk verified as collected");

    // The genuinely unclaimed archive case is unchanged: with no inline claimant
    // at all, a wave-only reference stays required while archives are retained.
    await restored.detach();
    restored = undefined;
    const orphan = join(temporaryRoot, "wave-never-claimed");   // never created
    restored = controllerFor(workspaceRoot, notifications);
    const unclaimed = await restored.restore({ waveRoots: [orphan], bundles: [], groupRoots: [groupRoot] });
    assert.equal(unclaimed.recovery.complete, false,
      "a wave no inline or carried claimant names is still not proven released");
    assert.deepEqual(unclaimed.associations.waveRoots, [orphan]);
    assert.ok(unclaimed.recovery.reasons.some((reason) => /no exact task handle to verify against retained archives/.test(reason.detail)),
      `the archive control still applies, got ${JSON.stringify(unclaimed.recovery.reasons)}`);
  } finally {
    await seed?.detach().catch(() => undefined);
    await restored?.detach().catch(() => undefined);
  }
});
