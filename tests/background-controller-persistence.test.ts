import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BackgroundExecutionController,
} from "../src/execution/background-controller";
import type { BackgroundExecutionGroup } from "../src/execution/background-controller";
import { normalizeConfig } from "../src/config";
import { INLINE_SETTLED_TASK_LIMIT } from "../src/execution/background-group-store";
import { setDurableWriteFaultInjectionForTesting } from "../src/execution/durable-write";
import { createState } from "../src/state";
import { transitionTaskState } from "../src/execution/task-state";
import {
  boundedScalingConfig,
  collidingTaskRecord,
  controllerInternals,
  initGitRepo,
  settleOldestUnsettled,
  setupFaultScenario,
  waitFor,
  waitForAsync,
  waitForLandedDurableRecord,
  writePersistedExecutionGroup,
  writePersistedExecutionGroupTasks,
} from "./helpers/background-controller-fixtures";


test("settled tasks move to bounded archives and restore through stable task handles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-archive-"));
  let controller: BackgroundExecutionController | undefined;
  let restored: BackgroundExecutionController | undefined;
  const ownedRoots = new Set<string>();
  try {
    await initGitRepo(root);
    const executor = join(root, "archive-executor.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>setTimeout(()=>{",
      "if(prompt.includes('ARCHIVE_FAST'))fs.writeFileSync('archived.txt','archived landing\\n');",
      "else fs.writeFileSync('still-running.txt','eventually landed\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
      "},prompt.includes('ARCHIVE_FAST')?25:30000));",
    ].join("\n"), "utf8");
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "archive": {
          adapter: "run-as-binary",
          command: process.execPath,
          execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] }
        }
      },
      execution: {
maxWorkers: 2,
workerResources: { "default": { selection: { source: "external", id: "archive" }, maxConcurrent: 2 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
      retainBundles: "always",
    });
    controller = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    const started = await controller.start([
      { title: "archive me", instructions: "ARCHIVE_FAST", acceptanceCriteria: ["archived.txt exists"] },
      { title: "remain active", instructions: "ARCHIVE_SLOW", acceptanceCriteria: ["still-running.txt exists"] },
    ]);
    ownedRoots.add(started.root);
    const archivedTaskId = started.tasks[0]!.taskId;
    await waitFor(() => controller!.inspect(started.executionId, archivedTaskId).tasks[0]?.state === "landed", 30_000);
    await waitForAsync(async () => {
      const current = JSON.parse(await readFile(join(started.root, "execution.json"), "utf8")) as {
        tasks: Array<Record<string, unknown>>;
      };
      return current.tasks.some((task) => task.taskId === archivedTaskId && task.archived === true);
    });

    const manifest = JSON.parse(await readFile(join(started.root, "execution.json"), "utf8")) as {
      version: number;
      tasks: Array<Record<string, unknown>>;
    };
    assert.equal(manifest.version, 3);
    const reference = manifest.tasks.find((task) => task.taskId === archivedTaskId)!;
    assert.equal(reference.archived, true);
    assert.equal(reference.state, "landed");
    assert.equal("activity" in reference, false);
    assert.equal("definition" in reference, false);
    assert.match(String(reference.archivePath), /^tasks\/task-[0-9a-f-]+\.json$/);
    const archive = JSON.parse(await readFile(join(started.root, String(reference.archivePath)), "utf8")) as {
      task: { taskId: string; activity: unknown[]; result?: unknown };
    };
    assert.equal(archive.task.taskId, archivedTaskId);
    assert.ok(archive.task.activity.length > 0);
    assert.ok(archive.task.result);

    await controller.shutdown();
    const associations = controller.associations();
    for (const value of [...associations.groupRoots ?? [], ...associations.waveRoots]) ownedRoots.add(value);
    await controller.detach();
    controller = undefined;
    config.execution!.maxWorkers = 0;
    restored = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    await restored.restore(associations);
    const restoredTask = restored.inspect(started.executionId, archivedTaskId).tasks[0]!;
    assert.equal(restoredTask.state, "landed");
    assert.equal(restoredTask.taskId, archivedTaskId);
    assert.ok(restoredTask.result, "task-specific inspection hydrates the settled archive after restart");
    assert.ok(restoredTask.timing.totalMs > 0);
  } finally {
    await restored?.shutdown().catch(() => undefined);
    await controller?.shutdown().catch(() => undefined);
    for (const owned of ownedRoots) await rm(owned, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("restore rejects cross-cwd groups before their archive metadata reaches controller state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-cwd-restore-"));
  const fixtureRoots: string[] = [];
  try {
    const config = normalizeConfig({ enabled: true, review: { activeReviewers: [] } });
    const collidingTaskId = "task-collide-cwd-restore";
    const collidingUpdatedAt = "2024-01-01T00:00:00.000Z";
    const collidingCreatedAt = "2023-12-31T23:59:00.000Z";

    const validRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-")));
    const mismatchedRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-")));
    const malformedRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-")));
    const foreignWorkspace = await realpath(await mkdtemp(join(tmpdir(), "pi-review-cwd-foreign-")));
    fixtureRoots.push(validRoot, mismatchedRoot, malformedRoot, foreignWorkspace);

    // Both groups persist an archived task with the SAME task id and updatedAt
    // but different archive bodies (and therefore different integrity hashes).
    const validTask = collidingTaskRecord(collidingTaskId, collidingCreatedAt, collidingUpdatedAt, "valid archive body");
    const mismatchedTask = collidingTaskRecord(collidingTaskId, collidingCreatedAt, collidingUpdatedAt, "mismatched archive body");
    await writePersistedExecutionGroup(validRoot, root, "exec-cwd-valid", validTask);
    await writePersistedExecutionGroup(mismatchedRoot, foreignWorkspace, "exec-cwd-mismatched", mismatchedTask);
    await writeFile(join(malformedRoot, "execution.json"), "{not json", "utf8");

    const validArchivePath = join(validRoot, "tasks", `${collidingTaskId}.json`);
    const validManifestPath = join(validRoot, "execution.json");
    const validManifestBefore = await readFile(validManifestPath, "utf8");

    const notifications: string[] = [];
    const restored = new BackgroundExecutionController({
      pi: {},
      config,
      state: createState(),
      cwd: () => root,
      notify: (message) => {
        notifications.push(message);
      },
    });
    try {
      await restored.restore({
        waveRoots: [],
        bundles: [],
        groupRoots: [validRoot, mismatchedRoot, malformedRoot],
      });

      // Fail-closed behavior: the cross-cwd and malformed groups are rejected...
      assert.ok(notifications.some((message) => message.includes(mismatchedRoot) && /was not restored/.test(message)));
      assert.ok(notifications.some((message) => message.includes(malformedRoot) && /was not restored/.test(message)));
      assert.throws(() => restored.inspect("exec-cwd-mismatched"), /Unknown execution group/);
      // ...while the valid same-cwd group still restores.
      assert.deepEqual(restored.associations().groupRoots, [validRoot]);
      const validInspection = restored.inspect("exec-cwd-valid");
      assert.equal(validInspection.tasks.length, 1);
      assert.equal(validInspection.tasks[0]?.taskId, collidingTaskId);
      assert.equal(validInspection.tasks[0]?.state, "landed");
      assert.equal(validInspection.tasks[0]?.summary, "valid archive body");

      // The rejected group must not leave archive metadata behind: colliding
      // task id + matching updatedAt must not let the foreign archive hash win.
      // Touching the valid group forces a re-save; a contaminated controller
      // would persist the foreign archiveIntegritySha256 without rewriting the
      // archive file, corrupting the persisted manifest.
      await restored.add("exec-cwd-valid", [{
        title: "contamination trigger",
        instructions: "force a save of the restored group",
        acceptanceCriteria: ["done"],
      }]);
      const manifestAfter = JSON.parse(await readFile(validManifestPath, "utf8")) as {
        tasks: Array<{ archived?: boolean; taskId: string; archiveIntegritySha256?: string }>;
      };
      const reference = manifestAfter.tasks.find((task) => task.taskId === collidingTaskId)!;
      assert.ok(reference.archived, "archived task stays archived after re-save");
      const archiveOnDisk = JSON.parse(await readFile(validArchivePath, "utf8")) as { integritySha256: string };
      assert.equal(
        reference.archiveIntegritySha256,
        archiveOnDisk.integritySha256,
        "persisted archive reference must keep the valid group's own archive hash",
      );
      // The legacy archive was migrated to an execution-bound version-2
      // document built from the valid group's own record — never from the
      // rejected foreign group's colliding body.
      const migratedArchive = JSON.parse(await readFile(validArchivePath, "utf8")) as {
        version: number;
        executionId: string;
        task: { summary: string };
      };
      assert.equal(migratedArchive.version, 2);
      assert.equal(migratedArchive.executionId, "exec-cwd-valid");
      assert.equal(migratedArchive.task.summary, "valid archive body");
      assert.notEqual(await readFile(validManifestPath, "utf8"), validManifestBefore);

      // The rewritten manifest still restores cleanly for the valid group.
      await restored.shutdown();
      await restored.detach();
      const reread = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
      try {
        await reread.restore({ waveRoots: [], bundles: [], groupRoots: [validRoot] });
        assert.deepEqual(notifications.filter((message) => message.includes(validRoot) && /was not restored/.test(message)), []);
        const rereadInspection = reread.inspect("exec-cwd-valid");
        assert.equal(rereadInspection.tasks[0]?.state, "landed");
      } finally {
        await reread.shutdown().catch(() => undefined);
        await reread.detach().catch(() => undefined);
      }
    } finally {
      await restored.shutdown().catch(() => undefined);
      await restored.detach().catch(() => undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const owned of fixtureRoots) await rm(owned, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("restored active tasks bound routine history without losing cumulative timing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-bounds-"));
  let executionRoot: string | undefined;
  let restored: BackgroundExecutionController | undefined;
  try {
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "never-started": {
          adapter: "run-as-binary",
          command: process.execPath,
          execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", "process.stdin.resume()"] }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "never-started" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    });
    config.execution!.maxWorkers = 0;
    const controller = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    const started = await controller.start([{ title: "bounded", instructions: "wait", acceptanceCriteria: ["remain queued"] }]);
    executionRoot = started.root;
    const associations = controller.associations();
    await controller.detach();

    const manifestPath = join(started.root, "execution.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    const task = manifest.tasks[0] as Record<string, any>;
    const startMs = Date.now() - 100_000;
    task.createdAt = new Date(startMs).toISOString();
    task.updatedAt = new Date(startMs + 100_000).toISOString();
    task.state = "queued";
    task.activity = Array.from({ length: 350 }, (_, index) => ({
      sequence: index + 1,
      at: new Date(startMs + index).toISOString(),
      phase: "routine",
      message: `routine progress ${index}`,
    }));
    task.nextActivitySequence = 351;
    task.stateHistory = Array.from({ length: 101 }, (_, index) => ({
      sequence: index + 1,
      state: index % 2 === 0 ? "queued" : "running",
      at: new Date(startMs + index * 1_000).toISOString(),
      generation: 0,
    }));
    task.nextStateSequence = 102;
    delete task.timingAccumulator;
    const unsigned = { ...manifest, integritySha256: undefined };
    manifest.integritySha256 = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    restored = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    await restored.restore(associations);
    const inspection = restored.inspect(started.executionId, started.tasks[0]!.taskId).tasks[0]!;
    assert.equal(inspection.activity.length, 200);
    assert.equal(inspection.activity[0]?.sequence, 151);
    assert.equal(inspection.stateHistory?.length, 64);
    assert.equal(inspection.stateHistory?.[0]?.sequence, 38);
    assert.ok(inspection.timing.queueMs >= 50_000, "timing includes queued intervals discarded from detailed history");
    assert.ok(inspection.timing.executionMs >= 50_000, "timing includes execution intervals discarded from detailed history");
    assert.ok(inspection.timing.totalMs >= 100_000);
  } finally {
    await restored?.shutdown().catch(() => undefined);
    if (executionRoot) await rm(executionRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("post-landing parent checkpoint failure preserves the landed outcome", async () => {
  const scenario = await setupFaultScenario({
    checkpointParent: () => {
      throw new Error("ENOSPC: parent checkpoint write failed");
    },
  });
  const { root, controller, started, messages } = scenario;
  try {
    await waitFor(() => controller.inspect(started.executionId).tasks[0]?.state === "landed");
    assert.equal(await readFile(join(root, "fault.txt"), "utf8"), "landed before bookkeeping failure\n");
    await waitForLandedDurableRecord(started, "bookkeeping");
    const task = controller.inspect(started.executionId).tasks[0]!;
    assert.equal(task.state, "landed");
    assert.ok((task.stateHistory ?? []).every((entry) => entry.state !== "failed"));
    assert.ok(
      task.activity.some((event) => event.phase === "bookkeeping" && /post-landing parent checkpoint failed.*ENOSPC/s.test(event.message)),
      "expected a bookkeeping activity entry for the parent checkpoint failure",
    );
    assert.ok(messages.some((message) => /landed, but parent checkpoint failed afterward \(landing preserved\)/.test(message)));
    assert.ok(controller.inspect(started.executionId).activeCount === 0);
    await controller.shutdown();
  } finally {
    await scenario.cleanup();
  }
});

test("post-landing durable save failure still persists the landed outcome on retry", async () => {
  let landedSaveCalls = 0;
  const scenario = await setupFaultScenario({
    save: (context) => {
      if (context.taskStates?.includes("landed") && landedSaveCalls++ === 0) {
        throw new Error("EIO: disk full while writing execution.json");
      }
    },
  });
  const { root, controller, started } = scenario;
  try {
    await waitFor(() => controller.inspect(started.executionId).tasks[0]?.state === "landed");
    assert.equal(await readFile(join(root, "fault.txt"), "utf8"), "landed before bookkeeping failure\n");
    await waitForLandedDurableRecord(started, "bookkeeping");
    const task = controller.inspect(started.executionId).tasks[0]!;
    assert.equal(task.state, "landed");
    assert.ok((task.stateHistory ?? []).every((entry) => entry.state !== "failed"));
    assert.ok(
      task.activity.some((event) => event.phase === "bookkeeping" && /post-landing durable save failed.*disk full/s.test(event.message)),
      "expected a bookkeeping activity entry for the durable save failure",
    );
    await controller.shutdown();
  } finally {
    await scenario.cleanup();
  }
});

test("post-landing association publish failure preserves the landed outcome", async () => {
  const scenario = await setupFaultScenario({
    publishAssociations: (context) => {
      if (context.taskStates?.includes("landed")) {
        throw new Error("association publish socket closed");
      }
    },
  });
  const { root, controller, started } = scenario;
  try {
    await waitFor(() => controller.inspect(started.executionId).tasks[0]?.state === "landed");
    assert.equal(await readFile(join(root, "fault.txt"), "utf8"), "landed before bookkeeping failure\n");
    await waitForLandedDurableRecord(started, "bookkeeping");
    const task = controller.inspect(started.executionId).tasks[0]!;
    assert.equal(task.state, "landed");
    assert.ok((task.stateHistory ?? []).every((entry) => entry.state !== "failed"));
    assert.ok(
      task.activity.some((event) => event.phase === "bookkeeping" && /post-landing association publish failed.*socket closed/s.test(event.message)),
      "expected a bookkeeping activity entry for the association publish failure",
    );
    await controller.shutdown();
  } finally {
    await scenario.cleanup();
  }
});

test("post-landing wake failure preserves the landed outcome", async () => {
  const scenario = await setupFaultScenario({
    wake: (context) => {
      if (context.taskState === "landed") {
        throw new Error("wake transport unavailable");
      }
    },
  });
  const { root, controller, started, messages } = scenario;
  try {
    await waitFor(() => controller.inspect(started.executionId).tasks[0]?.state === "landed");
    assert.equal(await readFile(join(root, "fault.txt"), "utf8"), "landed before bookkeeping failure\n");
    await waitForLandedDurableRecord(started, "bookkeeping");
    const task = controller.inspect(started.executionId).tasks[0]!;
    assert.equal(task.state, "landed");
    assert.ok((task.stateHistory ?? []).every((entry) => entry.state !== "failed"));
    assert.ok(
      task.activity.some((event) => event.phase === "bookkeeping" && /post-landing completion wake failed.*wake transport unavailable/s.test(event.message)),
      "expected a bookkeeping activity entry for the wake failure",
    );
    assert.ok(messages.some((message) => /landed, but completion wake failed afterward \(landing preserved\)/.test(message)));
    await controller.shutdown();
  } finally {
    await scenario.cleanup();
  }
});

test("force-merge save failure after landing preserves the landed outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-force-merge-fault-"));
  try {
    await initGitRepo(root);
    const executor = join(root, "slow-executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
      "fs.writeFileSync('draft.txt','recover me\\n');",
      "setTimeout(()=>console.log(JSON.stringify({type:'assistant',text:'late completion'})),30000);",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "slow": {
          adapter: "run-as-binary",
          command: executor,
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "slow" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
      retainBundles: "always",
    });
    let landedSaveCalls = 0;
    const controller = new BackgroundExecutionController({
      pi: {},
      config,
      state: createState(),
      cwd: () => root,
      faults: {
        save: (context) => {
          if (context.taskStates?.includes("landed") && landedSaveCalls++ === 0) {
            throw new Error("EIO: force-merge save failed");
          }
        },
      },
    });
    const started = await controller.start([{
      title: "recover interrupted edit",
      instructions: "write draft.txt",
      acceptanceCriteria: ["draft.txt exists"],
    }]);
    const taskId = started.tasks[0]!.taskId;
    await waitFor(() => controller.inspect(started.executionId, taskId).tasks[0]?.state === "running");
    await waitForAsync(async () => {
      const waveRoot = controller.inspect(started.executionId, taskId).tasks[0]?.waveRoot;
      if (!waveRoot) return false;
      return readFile(join(waveRoot, "workers", taskId, "draft.txt"), "utf8").then(() => true, () => false);
    });
    await controller.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_as_failure",
      instructionId: "interrupt-test",
      actor: "user",
    });
    const landed = await controller.forceMerge({
      executionId: started.executionId,
      taskId,
      mergeAnyhow: false,
      instructionId: "force-test",
      actor: "user",
    });
    assert.equal(landed.tasks[0]?.state, "landed");
    assert.equal(await readFile(join(root, "draft.txt"), "utf8"), "recover me\n");
    assert.ok((landed.tasks[0]?.stateHistory ?? []).every((entry) => entry.state !== "failed"));
    assert.ok(
      (landed.tasks[0]?.activity ?? []).some((event) => event.phase === "bookkeeping" && /post-landing durable save failed.*force-merge save failed/s.test(event.message)),
      "expected a bookkeeping activity entry for the force-merge save failure",
    );
    await waitForAsync(async () => {
      const persisted = JSON.parse(await readFile(join(landed.root, "execution.json"), "utf8")) as { tasks: Array<{ taskId: string; state: string }> };
      return persisted.tasks.some((entry) => entry.taskId === taskId && entry.state === "landed");
    });
    await controller.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("force-merge publish and wake failures after landing are recorded durably", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-force-merge-publish-"));
  try {
    await initGitRepo(root);
    const executor = join(root, "slow-executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
      "fs.writeFileSync('draft.txt','recover me\\n');",
      "setTimeout(()=>console.log(JSON.stringify({type:'assistant',text:'late completion'})),30000);",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "slow": {
          adapter: "run-as-binary",
          command: executor,
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "slow" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
      retainBundles: "always",
    });
    const controller = new BackgroundExecutionController({
      pi: {},
      config,
      state: createState(),
      cwd: () => root,
      faults: {
        publishAssociations: (context) => {
          if (context.taskStates?.includes("landed")) {
            throw new Error("association publish endpoint down");
          }
        },
        wake: (context) => {
          if (context.taskState === "landed") {
            throw new Error("wake transport refused");
          }
        },
      },
    });
    const started = await controller.start([{
      title: "recover interrupted edit",
      instructions: "write draft.txt",
      acceptanceCriteria: ["draft.txt exists"],
    }]);
    const taskId = started.tasks[0]!.taskId;
    await waitFor(() => controller.inspect(started.executionId, taskId).tasks[0]?.state === "running");
    await waitForAsync(async () => {
      const waveRoot = controller.inspect(started.executionId, taskId).tasks[0]?.waveRoot;
      if (!waveRoot) return false;
      return readFile(join(waveRoot, "workers", taskId, "draft.txt"), "utf8").then(() => true, () => false);
    });
    await controller.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_as_failure",
      instructionId: "interrupt-test",
      actor: "user",
    });
    const landed = await controller.forceMerge({
      executionId: started.executionId,
      taskId,
      mergeAnyhow: false,
      instructionId: "force-test",
      actor: "user",
    });
    assert.equal(landed.tasks[0]?.state, "landed");
    assert.equal(await readFile(join(root, "draft.txt"), "utf8"), "recover me\n");
    assert.ok((landed.tasks[0]?.stateHistory ?? []).every((entry) => entry.state !== "failed"));
    const activity = landed.tasks[0]?.activity ?? [];
    assert.ok(
      activity.some((event) => event.phase === "bookkeeping" && /post-landing association publish failed.*endpoint down/s.test(event.message)),
      "expected a bookkeeping activity entry for the association publish failure",
    );
    assert.ok(
      activity.some((event) => event.phase === "bookkeeping" && /post-landing completion wake failed.*wake transport refused/s.test(event.message)),
      "expected a bookkeeping activity entry for the wake failure",
    );
    await waitForAsync(async () => {
      try {
        const archive = JSON.parse(await readFile(join(landed.root, "tasks", `${taskId}.json`), "utf8")) as {
          task: { state: string; activity?: Array<{ phase: string; message: string }> };
        };
        return archive.task?.state === "landed"
          && archive.task.activity?.some((event) => event.phase === "bookkeeping" && /association publish failed.*endpoint down/.test(event.message)) === true
          && archive.task.activity?.some((event) => event.phase === "bookkeeping" && /completion wake failed.*wake transport refused/.test(event.message)) === true;
      } catch {
        return false;
      }
    });
    await controller.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settled save tails prune by exact identity and overlapping saves serialize without loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-save-tails-"));
  try {
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "tail-fake": {
          adapter: "run-as-binary",
          command: join(root, "unused-executor.cjs"),
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "tail-fake" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    });
    // Keep every task queued: saves happen without dispatching any executor.
    config.execution!.maxWorkers = 0;
    const controller = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    const internals = () => controller as unknown as {
      saveTails: Map<string, Promise<void>>;
      groups: Map<string, BackgroundExecutionGroup>;
    };
    const settle = () => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    const started = await controller.start([{ title: "tail base", instructions: "work", acceptanceCriteria: ["done"] }]);
    await settle();
    assert.equal(internals().saveTails.size, 0, "a settled save tail must prune itself");

    // Overlapping saves chain onto the registered tail: the older tail must
    // never delete a newer one, and every write must land in revision order.
    const additions = await Promise.all([
      controller.add(started.executionId, [{ title: "tail a", instructions: "a", acceptanceCriteria: ["a"] }]),
      controller.add(started.executionId, [{ title: "tail b", instructions: "b", acceptanceCriteria: ["b"] }]),
      controller.add(started.executionId, [{ title: "tail c", instructions: "c", acceptanceCriteria: ["c"] }]),
    ]);
    assert.equal(additions.length, 3);
    await settle();
    assert.equal(internals().saveTails.size, 0, "overlapping settled tails must all prune");
    const group = internals().groups.get(started.executionId)!;
    const persisted = JSON.parse(await readFile(join(started.root, "execution.json"), "utf8")) as {
      revision: number;
      tasks: Array<{ definition: { title: string } }>;
    };
    assert.equal(persisted.tasks.length, 4, "every overlapping save must be durably recorded");
    assert.equal(persisted.revision, group.revision, "the final persisted revision must match the latest save");

    await controller.shutdown();
    await controller.detach();
    assert.equal(internals().saveTails.size, 0, "shutdown and detach must leave no stale save-tail entries");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed save tail propagates to its caller, prunes, and does not wedge later saves", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-save-tail-failure-"));
  try {
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "tail-fail-fake": {
          adapter: "run-as-binary",
          command: join(root, "unused-executor.cjs"),
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "tail-fail-fake" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    });
    // Keep every task queued: saves happen without dispatching any executor.
    config.execution!.maxWorkers = 0;
    const controller = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    const internals = () => controller as unknown as {
      saveTails: Map<string, Promise<void>>;
      groups: Map<string, BackgroundExecutionGroup>;
    };
    const settle = () => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    let failSaves = false;
    controller.setFaultHooks({
      save: () => {
        if (failSaves) throw new Error("durable save exploded");
      },
    });
    const started = await controller.start([{ title: "failure base", instructions: "work", acceptanceCriteria: ["done"] }]);
    await settle();
    assert.equal(internals().saveTails.size, 0);

    failSaves = true;
    await assert.rejects(
      () => controller.add(started.executionId, [{ title: "doomed", instructions: "x", acceptanceCriteria: ["x"] }]),
      /durable save exploded/,
      "a save failure must remain visible to its caller",
    );
    await settle();
    assert.equal(internals().saveTails.size, 0, "a failed tail must also prune instead of lingering");

    failSaves = false;
    const recovered = await controller.add(started.executionId, [{ title: "recovered", instructions: "y", acceptanceCriteria: ["y"] }]);
    assert.equal(recovered.tasks.length, 3);
    await settle();
    assert.equal(internals().saveTails.size, 0);
    const group = internals().groups.get(started.executionId)!;
    const persisted = JSON.parse(await readFile(join(started.root, "execution.json"), "utf8")) as {
      revision: number;
      tasks: Array<{ definition: { title: string } }>;
    };
    assert.equal(persisted.revision, group.revision, "the recovery save must persist the current revision");
    assert.deepEqual(persisted.tasks.map((task) => task.definition.title).sort(), ["doomed", "failure base", "recovered"]);

    await controller.shutdown();
    await controller.detach();
    assert.equal(internals().saveTails.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated group creation and detach/shutdown quiesce save tails before clearing bookkeeping", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-save-tail-detach-"));
  try {
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "tail-detach-fake": {
          adapter: "run-as-binary",
          command: join(root, "unused-executor.cjs"),
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "tail-detach-fake" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    });
    // Keep every task queued: saves happen without dispatching any executor.
    config.execution!.maxWorkers = 0;
    const controller = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    const internals = () => controller as unknown as {
      saveTails: Map<string, Promise<void>>;
      groups: Map<string, BackgroundExecutionGroup>;
    };
    const settle = () => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));

    // Repeated group creation and removal must keep the tail map bounded.
    for (let round = 0; round < 3; round += 1) {
      const started = await controller.start([{ title: `round ${round}`, instructions: "work", acceptanceCriteria: ["done"] }]);
      await settle();
      assert.equal(internals().saveTails.size, 0);
      await controller.detach();
      assert.equal(internals().saveTails.size, 0, "detach must leave no save-tail entries");
      assert.equal(controller.list().length, 0);
      assert.equal(internals().groups.size, 0);
    }

    // A group creation already awaiting filesystem setup must not attach after
    // detach has completed its empty-map quiescence check.
    const startingDuringDetach = controller.start([
      { title: "starting during detach", instructions: "work", acceptanceCriteria: ["done"] },
    ]);
    const detachDuringStart = controller.detach();
    await assert.rejects(startingDuringDetach, /shutdown or controller detach/);
    await detachDuringStart;
    await settle();
    assert.equal(internals().saveTails.size, 0);
    assert.equal(internals().groups.size, 0);

    // A later detach must supersede a restore already awaiting its own
    // initial detach; restore must not reattach a group afterward.
    await controller.start([
      { title: "restore race", instructions: "work", acceptanceCriteria: ["done"] },
    ]);
    const associations = controller.associations();
    await controller.detach();
    const restoring = controller.restore(associations);
    const supersedingDetach = controller.detach();
    await Promise.all([restoring, supersedingDetach]);
    await settle();
    assert.equal(internals().groups.size, 0);
    assert.equal(internals().saveTails.size, 0);

    // The attachment guard rejects saves through a stale group reference.
    const stale = await controller.start([{ title: "stale ref", instructions: "work", acceptanceCriteria: ["done"] }]);
    await settle();
    const staleGroup = internals().groups.get(stale.executionId)!;
    await controller.detach();
    await assert.rejects(
      () => (controller as unknown as { save: (group: BackgroundExecutionGroup) => Promise<unknown> }).save(staleGroup),
      /was detached before it could be saved/,
    );
    assert.equal(internals().saveTails.size, 0);

    // An operation invoked right after detach must not register a save in any
    // await gap between the final empty-tail check and group removal; saves
    // through detached groups are rejected by the attachment guard.
    const race = await controller.start([{ title: "detach race", instructions: "work", acceptanceCriteria: ["done"] }]);
    await settle();
    let racedSaveHooks = 0;
    controller.setFaultHooks({ save: () => { racedSaveHooks += 1; } });
    const detachingEmptyMap = controller.detach();
    const racedAdd = controller.add(race.executionId, [{ title: "too late", instructions: "work", acceptanceCriteria: ["done"] }]);
    await assert.rejects(racedAdd);
    await detachingEmptyMap;
    await settle();
    assert.equal(racedSaveHooks, 0, "no save may start after detach's final empty-tail check");
    assert.equal(internals().saveTails.size, 0);
    assert.equal(internals().groups.size, 0);
    controller.setFaultHooks(undefined);

    // Detach must quiesce an already-registered, still-pending save tail
    // before dropping its bookkeeping and group state: gate the save fault
    // hook, which runs inside the registered chain before the durable write.
    const gated = await controller.start([{ title: "gated base", instructions: "work", acceptanceCriteria: ["done"] }]);
    await settle();
    let releaseDetachSave!: () => void;
    let detachGateCalls = 0;
    controller.setFaultHooks({
      save: () => {
        detachGateCalls += 1;
        if (detachGateCalls === 1) return new Promise<void>((resolveGate) => { releaseDetachSave = resolveGate; });
        return undefined;
      },
    });
    const pendingAdd = controller.add(gated.executionId, [{ title: "late writer", instructions: "z", acceptanceCriteria: ["z"] }]);
    await settle();
    assert.equal(internals().saveTails.size, 1, "the in-flight save's tail must be registered while it writes");
    let detached = false;
    const detaching = controller.detach().then(() => { detached = true; });
    await settle();
    assert.equal(detached, false, "detach must wait for an in-flight save tail");
    assert.equal(internals().groups.size, 1, "group state must not be dropped before tails quiesce");
    releaseDetachSave();
    await pendingAdd;
    await detaching;
    controller.setFaultHooks(undefined);
    await settle();
    assert.equal(internals().saveTails.size, 0, "detach must clear tail bookkeeping once writes quiesce");
    assert.equal(internals().groups.size, 0);

    // Shutdown must also wait for a registered in-flight tail: gate the save
    // fault hook, which now runs inside the registered chain before the write.
    const resumed = await controller.start([{ title: "shutdown base", instructions: "work", acceptanceCriteria: ["done"] }]);
    await settle();
    let releaseSave!: () => void;
    controller.setFaultHooks({
      save: () => new Promise<void>((resolveGate) => { releaseSave = resolveGate; }),
    });
    let shutdownDone = false;
    const shuttingDown = controller.shutdown().then(() => { shutdownDone = true; });
    await settle();
    assert.equal(shutdownDone, false, "shutdown must wait for the in-flight registered save tail");
    assert.equal(internals().saveTails.size, 1, "the gated save's tail must be registered while in flight");
    releaseSave();
    controller.setFaultHooks(undefined);
    await shuttingDown;
    assert.equal(internals().saveTails.size, 0, "shutdown must leave no save-tail entries after writes quiesce");
    const persisted = JSON.parse(await readFile(join(resumed.root, "execution.json"), "utf8")) as {
      tasks: Array<{ state: string }>;
    };
    assert.equal(persisted.tasks[0]?.state, "stopped_for_application_exit", "the gated shutdown save must land in order");
    await controller.detach();
    assert.equal(internals().saveTails.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy v2 manifests with many settled stubs restore lazily and rewrite to the bounded v3 format", async () => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-v2-many-")));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-review-background-v2-workspace-"));
  let restored: BackgroundExecutionController | undefined;
  try {
    const records = Array.from({ length: 40 }, (_unused, index) => collidingTaskRecord(
      `task-legacy-${index}`,
      new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
      new Date(Date.parse("2024-01-02T00:00:00.000Z") + index * 1_000).toISOString(),
      `legacy summary ${index}`,
    ));
    await writePersistedExecutionGroupTasks(fixtureRoot, workspaceRoot, "exec-legacy-v2", records);
    const archiveBytesBefore = await readFile(join(fixtureRoot, "tasks", `${records[0]!.taskId}.json`), "utf8");

    restored = new BackgroundExecutionController({
      pi: {},
      config: normalizeConfig({ enabled: true, review: { activeReviewers: [] } }),
      state: createState(),
      cwd: () => workspaceRoot,
    });
    await restored.restore({ waveRoots: [], bundles: [], groupRoots: [fixtureRoot] });

    // Only the bounded recent settled window hydrates; older settled tasks stay
    // archive-only behind truthful aggregates.
    const inspection = restored.inspect("exec-legacy-v2");
    assert.equal(inspection.tasks.length, INLINE_SETTLED_TASK_LIMIT);
    assert.equal(inspection.historicalCount, 40);
    assert.equal(inspection.archivedCount, 40 - INLINE_SETTLED_TASK_LIMIT);
    assert.equal(inspection.activeCount, 0);

    // Exact historical task handles load their integrity-checked archives.
    const historical = await restored.inspectTask("exec-legacy-v2", records[0]!.taskId);
    assert.equal(historical.tasks[0]!.taskId, records[0]!.taskId);
    assert.equal(historical.tasks[0]!.state, "landed");
    assert.equal(historical.tasks[0]!.summary, "legacy summary 0");

    // Restore rewrote the manifest to the bounded v3 format with exact totals.
    const manifest = JSON.parse(await readFile(join(fixtureRoot, "execution.json"), "utf8")) as {
      version: number;
      totalTaskCount: number;
      settledArchivedCount: number;
      tasks: Array<Record<string, unknown>>;
    };
    assert.equal(manifest.version, 3);
    assert.equal(manifest.totalTaskCount, 40);
    assert.equal(manifest.settledArchivedCount, 40 - INLINE_SETTLED_TASK_LIMIT);
    assert.equal(manifest.tasks.length, INLINE_SETTLED_TASK_LIMIT);
    // Evicted archive documents were preserved byte-for-byte (never deleted to
    // achieve boundedness).
    assert.equal(await readFile(join(fixtureRoot, "tasks", `${records[0]!.taskId}.json`), "utf8"), archiveBytesBefore);
  } finally {
    await restored?.shutdown().catch(() => undefined);
    await restored?.detach().catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("archived history inspection and recovery fail closed on tampered or missing archives", async () => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-v2-tamper-")));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-review-background-v2-tamper-"));
  let restored: BackgroundExecutionController | undefined;
  try {
    const records = Array.from({ length: 40 }, (_unused, index) => collidingTaskRecord(
      `task-legacy-${index}`,
      new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
      new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
      `legacy summary ${index}`,
    ));
    await writePersistedExecutionGroupTasks(fixtureRoot, workspaceRoot, "exec-legacy-tamper", records);
    restored = new BackgroundExecutionController({
      pi: {},
      config: normalizeConfig({ enabled: true, review: { activeReviewers: [] } }),
      state: createState(),
      cwd: () => workspaceRoot,
    });
    await restored.restore({ waveRoots: [], bundles: [], groupRoots: [fixtureRoot] });

    // Tamper one evicted archive (its content is no longer manifest-covered).
    const tamperedPath = join(fixtureRoot, "tasks", `${records[0]!.taskId}.json`);
    const tampered = JSON.parse(await readFile(tamperedPath, "utf8")) as { task: { summary: string } };
    tampered.task.summary = "tampered outcome";
    await writeFile(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => restored!.inspectTask("exec-legacy-tamper", records[0]!.taskId),
      /failed its integrity check/,
    );
    await assert.rejects(
      () => restored!.continueTask({
        executionId: "exec-legacy-tamper",
        taskId: records[0]!.taskId,
        instructions: "resume",
        instructionId: "tamper-probe",
        actor: "user",
      }),
      /failed its integrity check/,
      "recovery must stay fail-closed on a tampered archive",
    );

    // A missing archive keeps the unknown-task failure instead of a wrong match.
    await rm(join(fixtureRoot, "tasks", `${records[1]!.taskId}.json`));
    await assert.rejects(
      () => restored!.inspectTask("exec-legacy-tamper", records[1]!.taskId),
      new RegExp(`Unknown task ${records[1]!.taskId}`),
    );
  } finally {
    await restored?.shutdown().catch(() => undefined);
    await restored?.detach().catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("routine saves write only the manifest and changed archives, reusing settled archives", async () => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-v2-writes-")));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-review-background-v2-writes-"));
  let restored: BackgroundExecutionController | undefined;
  const writes: string[] = [];
  try {
    const records = Array.from({ length: 40 }, (_unused, index) => collidingTaskRecord(
      `task-legacy-${index}`,
      new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
      new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
      `legacy summary ${index}`,
    ));
    await writePersistedExecutionGroupTasks(fixtureRoot, workspaceRoot, "exec-legacy-writes", records);
    const evictedArchiveBytesBefore = await readFile(join(fixtureRoot, "tasks", `${records[0]!.taskId}.json`), "utf8");
    setDurableWriteFaultInjectionForTesting((stage, path) => {
      if (stage === "before_rename") writes.push(path);
    });
    try {
      restored = new BackgroundExecutionController({
        pi: {},
        config: normalizeConfig({ enabled: true, review: { activeReviewers: [] } }),
        state: createState(),
        cwd: () => workspaceRoot,
      });
      await restored.restore({ waveRoots: [], bundles: [], groupRoots: [fixtureRoot] });
      // Restore's rewrite persists the bounded manifest, migrates the 32
      // inline window archives to execution-bound version-2 documents (one
      // bounded write per legacy task), writes the authenticated membership
      // index for the 8 evicted legacy stubs, and never rewrites the evicted
      // archives themselves.
      const written = writes.map((path) => path.slice(fixtureRoot.length + 1)).sort();
      assert.deepEqual(written, [
        "execution.json",
        "tasks/index.json",
        ...Array.from({ length: INLINE_SETTLED_TASK_LIMIT }, (_unused, index) => `tasks/task-legacy-${index + 8}.json`),
      ].sort());
      // The evicted stubs' own archives were reused verbatim, never rewritten.
      assert.equal(await readFile(join(fixtureRoot, "tasks", `${records[0]!.taskId}.json`), "utf8"), evictedArchiveBytesBefore);

      // A top-off writes only the manifest; the settled archives are untouched.
      writes.length = 0;
      const added = await restored.add("exec-legacy-writes", [{
        title: "fresh top-off",
        instructions: "work",
        acceptanceCriteria: ["done"],
      }]);
      assert.deepEqual(writes, [join(fixtureRoot, "execution.json")]);

      // Settling the new task produces exactly one archive write plus the manifest;
      // the oldest window archive (task-legacy-8) is evicted without a rewrite
      // because its migrated archive already exists on disk.
      writes.length = 0;
      const internals = controllerInternals(restored);
      const group = internals.groups.get("exec-legacy-writes")!;
      const task = group.tasks.find((candidate) => candidate.taskId === added.tasks.at(-1)!.taskId)!;
      transitionTaskState(task, "landed");
      task.summary = "newly settled";
      task.updatedAt = new Date(Date.parse("2024-02-01T00:00:00.000Z")).toISOString();
      await internals.save(group);
      assert.deepEqual(writes.sort(), [
        join(fixtureRoot, "execution.json"),
        join(fixtureRoot, "tasks", `${task.taskId}.json`),
      ]);
      // The migrated archives are execution-bound version-2 documents.
      const migrated = JSON.parse(await readFile(join(fixtureRoot, "tasks", "task-legacy-8.json"), "utf8")) as { version: number; executionId: string };
      assert.equal(migrated.version, 2);
      assert.equal(migrated.executionId, "exec-legacy-writes");
    } finally {
      setDurableWriteFaultInjectionForTesting(undefined);
    }
    const manifest = JSON.parse(await readFile(join(fixtureRoot, "execution.json"), "utf8")) as { totalTaskCount: number; settledArchivedCount: number };
    assert.equal(manifest.totalTaskCount, 41);
    assert.equal(manifest.settledArchivedCount, 40 - INLINE_SETTLED_TASK_LIMIT + 1);
  } finally {
    await restored?.shutdown().catch(() => undefined);
    await restored?.detach().catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("compaction keeps recovery wave roots and evicted landed tasks stay continuable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-continue-"));
  let controller: BackgroundExecutionController | undefined;
  const ownedRoots = new Set<string>();
  try {
    await initGitRepo(root);
    controller = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    ownedRoots.add(root);
    const started = await controller.start([{ title: "seed task", instructions: "seed", acceptanceCriteria: ["done"] }]);
    ownedRoots.add(started.root);
    const executionId = started.executionId;
    const seedTaskId = started.tasks[0]!.taskId;
    const waveRootDir = await realpath(await mkdtemp(join(tmpdir(), "wave-continue-root-")));
    ownedRoots.add(waveRootDir);
    const internals = controllerInternals(controller);
    const group = internals.groups.get(executionId)!;
    const seed = group.tasks[0]!;
    seed.bundle = {
      version: 1,
      operationId: "op-continue-evicted",
      waveId: "wave-continue-evicted",
      taskId: seed.taskId,
      waveRoot: waveRootDir,
      expectedRevision: 1,
    };
    seed.waveRoot = waveRootDir;
    transitionTaskState(seed, "landed");
    seed.summary = "settled seed with a durable continuation bundle";
    await internals.save(group);
    // Push the seed out of the bounded inline window with 32 newer settlements.
    for (let index = 0; index < 32; index += 1) {
      await controller.add(executionId, [{
        title: `later task ${index + 1}`,
        instructions: "work",
        acceptanceCriteria: ["done"],
      }]);
      await settleOldestUnsettled(controller, executionId, `later ${index + 1}`);
    }

    const manifest = JSON.parse(await readFile(join(started.root, "execution.json"), "utf8")) as {
      settledArchivedCount: number;
      tasks: Array<Record<string, unknown>>;
    };
    assert.equal(manifest.settledArchivedCount, 1);
    assert.ok(!manifest.tasks.some((task) => task.taskId === seedTaskId), "the seed task was evicted from the inline window");
    // Compaction must keep the recovery wave root the archived continuation
    // bundle points into.
    await access(waveRootDir);
    const archive = JSON.parse(
      await readFile(join(started.root, "tasks", `${seedTaskId}.json`), "utf8"),
    ) as { task: { bundle?: { operationId: string }; waveRoot?: string } };
    assert.equal(archive.task.bundle?.operationId, "op-continue-evicted");
    assert.equal(archive.task.waveRoot, waveRootDir);

    // Exact-handle continuation lazily re-admits the settled task and stays
    // continuable from its retained checkpoint workspace.
    const continued = await controller.continueTask({
      executionId,
      taskId: seedTaskId,
      instructions: "resume the evicted task",
      instructionId: "continue-evicted-1",
      actor: "user",
    });
    const continuedTask = continued.tasks.find((task) => task.taskId === seedTaskId)!;
    assert.equal(continuedTask.state, "queued");
    assert.equal(continued.tasks.find((task) => task.taskId === seedTaskId)!.bundle?.operationId, "op-continue-evicted");
    await access(waveRootDir);
    const inspection = controller.inspect(executionId);
    assert.equal(inspection.historicalCount, 33);
    assert.equal(inspection.archivedCount, 0, "re-admission retires the archive-only representation");
    assert.equal(inspection.scheduling.globallyDispatchPending, 1);
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    for (const owned of ownedRoots) await rm(owned, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("archive reuse and membership stay scoped per execution across same-cwd colliding handles", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-review-background-collide-"));
  const rootA = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-collide-a-")));
  const rootB = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-collide-b-")));
  let controller: BackgroundExecutionController | undefined;
  try {
    // Two same-cwd executions persist the SAME taskId and updatedAt with
    // different archive bodies.
    const sharedTaskId = "task-collide-same-cwd";
    const createdAt = "2023-12-31T23:59:00.000Z";
    const updatedAt = "2024-01-01T00:00:00.000Z";
    await writePersistedExecutionGroupTasks(rootA, workspaceRoot, "exec-collide-a", [
      collidingTaskRecord(sharedTaskId, createdAt, updatedAt, "group A outcome"),
    ]);
    await writePersistedExecutionGroupTasks(rootB, workspaceRoot, "exec-collide-b", [
      collidingTaskRecord(sharedTaskId, createdAt, updatedAt, "group B outcome"),
    ]);
    controller = new BackgroundExecutionController({
      pi: {},
      config: normalizeConfig({ enabled: true, review: { activeReviewers: [] } }),
      state: createState(),
      cwd: () => workspaceRoot,
    });
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [rootA, rootB] });
    // Force a save of each group; archive reuse must stay execution-scoped.
    await controller.add("exec-collide-a", [{ title: "a top-off", instructions: "work", acceptanceCriteria: ["done"] }]);
    await controller.add("exec-collide-b", [{ title: "b top-off", instructions: "work", acceptanceCriteria: ["done"] }]);
    for (const [executionId, groupRoot, expectedSummary] of [
      ["exec-collide-a", rootA, "group A outcome"],
      ["exec-collide-b", rootB, "group B outcome"],
    ] as const) {
      const manifest = JSON.parse(await readFile(join(groupRoot, "execution.json"), "utf8")) as {
        tasks: Array<{ taskId: string; archiveIntegritySha256?: string }>;
      };
      const reference = manifest.tasks.find((task) => task.taskId === sharedTaskId)!;
      const archiveOnDisk = JSON.parse(await readFile(join(groupRoot, "tasks", `${sharedTaskId}.json`), "utf8")) as {
        integritySha256: string;
        executionId: string;
      };
      assert.equal(reference.archiveIntegritySha256, archiveOnDisk.integritySha256, `${executionId} references its own archive hash`);
      assert.equal(archiveOnDisk.executionId, executionId);
      const historical = await controller.inspectTask(executionId, sharedTaskId);
      assert.equal(historical.tasks[0]!.summary, expectedSummary);
    }
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("execution-bound archives reject foreign handles planted into another execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-foreign-"));
  let controllerA: BackgroundExecutionController | undefined;
  let controllerB: BackgroundExecutionController | undefined;
  const ownedRoots = new Set<string>();
  try {
    await initGitRepo(root, {});
    controllerA = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    controllerB = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    const startedA = await controllerA.start([{ title: "a seed", instructions: "seed", acceptanceCriteria: ["done"] }]);
    const startedB = await controllerB.start([{ title: "b seed", instructions: "seed", acceptanceCriteria: ["done"] }]);
    ownedRoots.add(startedA.root);
    ownedRoots.add(startedB.root);
    const evictedTaskId = startedA.tasks[0]!.taskId;
    for (let index = 0; index < 32; index += 1) {
      await controllerA.add(startedA.executionId, [{ title: `later ${index + 1}`, instructions: "work", acceptanceCriteria: ["done"] }]);
      await settleOldestUnsettled(controllerA, startedA.executionId, `later ${index + 1}`);
    }
    // Copy execution A's evicted archive under execution B's root with the
    // same handle: it must never authenticate there.
    await mkdir(join(startedB.root, "tasks"), { recursive: true });
    await writeFile(
      join(startedB.root, "tasks", `${evictedTaskId}.json`),
      await readFile(join(startedA.root, "tasks", `${evictedTaskId}.json`), "utf8"),
      "utf8",
    );
    await assert.rejects(
      () => controllerB!.inspectTask(startedB.executionId, evictedTaskId),
      new RegExp(`does not belong to execution ${startedB.executionId}`),
    );
    // The owning execution still resolves its own archive.
    const historical = await controllerA!.inspectTask(startedA.executionId, evictedTaskId);
    assert.equal(historical.tasks[0]!.taskId, evictedTaskId);
    assert.equal(historical.tasks[0]!.state, "landed");
  } finally {
    await controllerA?.shutdown().catch(() => undefined);
    await controllerA?.detach().catch(() => undefined);
    await controllerB?.shutdown().catch(() => undefined);
    await controllerB?.detach().catch(() => undefined);
    for (const owned of ownedRoots) await rm(owned, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("the membership index keeps legacy evicted handles recoverable across restarts and fails closed when tampered", async () => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-v2-index-")));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-review-background-v2-index-"));
  let restored: BackgroundExecutionController | undefined;
  try {
    const records = Array.from({ length: 40 }, (_unused, index) => collidingTaskRecord(
      `task-legacy-${index}`,
      new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
      new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
      `legacy summary ${index}`,
    ));
    await writePersistedExecutionGroupTasks(fixtureRoot, workspaceRoot, "exec-legacy-index", records);
    const first = new BackgroundExecutionController({
      pi: {},
      config: normalizeConfig({ enabled: true, review: { activeReviewers: [] } }),
      state: createState(),
      cwd: () => workspaceRoot,
    });
    await first.restore({ waveRoots: [], bundles: [], groupRoots: [fixtureRoot] });
    await first.detach();

    // Second restore: the v3 manifest no longer references the evicted legacy
    // stubs, but the durable membership index authenticates their handles.
    restored = new BackgroundExecutionController({
      pi: {},
      config: normalizeConfig({ enabled: true, review: { activeReviewers: [] } }),
      state: createState(),
      cwd: () => workspaceRoot,
    });
    // Review pass 3: the restored handles exactly match the durable index, so
    // the restart must NOT rewrite the potentially lifetime-sized index — only
    // the bounded manifest save should occur.
    const secondRestoreWrites: string[] = [];
    setDurableWriteFaultInjectionForTesting((stage, path) => {
      if (stage === "before_rename") secondRestoreWrites.push(path);
    });
    try {
      await restored.restore({ waveRoots: [], bundles: [], groupRoots: [fixtureRoot] });
      assert.deepEqual(
        secondRestoreWrites.map((path) => path.slice(fixtureRoot.length + 1)).sort(),
        ["execution.json"],
      );
    } finally {
      setDurableWriteFaultInjectionForTesting(undefined);
    }
    const historical = await restored.inspectTask("exec-legacy-index", records[0]!.taskId);
    assert.equal(historical.tasks[0]!.taskId, records[0]!.taskId);
    assert.equal(historical.tasks[0]!.state, "landed");
    assert.equal(historical.tasks[0]!.summary, "legacy summary 0");
    await restored.detach();

    // A tampered membership index fails closed at restore.
    const indexPath = join(fixtureRoot, "tasks", "index.json");
    const tampered = JSON.parse(await readFile(indexPath, "utf8")) as {
      entries: Record<string, { archiveIntegritySha256: string }>;
      integritySha256: string;
    };
    tampered.entries[records[0]!.taskId]!.archiveIntegritySha256 = "f".repeat(64);
    await writeFile(indexPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    const notifications: string[] = [];
    const hardened = new BackgroundExecutionController({
      pi: {},
      config: normalizeConfig({ enabled: true, review: { activeReviewers: [] } }),
      state: createState(),
      cwd: () => workspaceRoot,
      notify: (message: string) => {
        notifications.push(message);
      },
    });
    try {
      await hardened.restore({ waveRoots: [], bundles: [], groupRoots: [fixtureRoot] });
      assert.ok(notifications.some((message) => message.includes(fixtureRoot) && /was not restored/.test(message)));
      assert.throws(() => hardened.inspect("exec-legacy-index"), /Unknown execution group/);
    } finally {
      await hardened.shutdown().catch(() => undefined);
      await hardened.detach().catch(() => undefined);
    }
  } finally {
    await restored?.shutdown().catch(() => undefined);
    await restored?.detach().catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("re-admitted legacy tasks rebind to a fresh archive and keep their stable handle across re-eviction and restart", async () => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-v2-readmit-")));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-review-background-v2-readmit-"));
  let restored: BackgroundExecutionController | undefined;
  try {
    const records = Array.from({ length: 40 }, (_unused, index) => collidingTaskRecord(
      `task-legacy-${index}`,
      new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
      new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
      `legacy summary ${index}`,
    ));
    records[0]!.bundle = {
      version: 1,
      operationId: "op-readmit",
      waveId: "wave-readmit",
      taskId: records[0]!.taskId,
      waveRoot: join(tmpdir(), "wave-readmit-unused"),
      expectedRevision: 1,
    };
    await writePersistedExecutionGroupTasks(fixtureRoot, workspaceRoot, "exec-legacy-readmit", records);
    restored = new BackgroundExecutionController({
      pi: {},
      config: normalizeConfig({ enabled: true, review: { activeReviewers: [] } }),
      state: createState(),
      cwd: () => workspaceRoot,
    });
    await restored.restore({ waveRoots: [], bundles: [], groupRoots: [fixtureRoot] });

    // Re-admit the legacy evicted task and settle it again: its archive must
    // be rewritten as an execution-bound version-2 document.
    const continued = await restored.continueTask({
      executionId: "exec-legacy-readmit",
      taskId: records[0]!.taskId,
      instructions: "resume the legacy task",
      instructionId: "readmit-1",
      actor: "user",
    });
    assert.equal(continued.tasks[0]!.state, "queued");
    const internals = controllerInternals(restored);
    const group = internals.groups.get("exec-legacy-readmit")!;
    const readmitted = group.tasks.find((task) => task.taskId === records[0]!.taskId)!;
    transitionTaskState(readmitted, "landed");
    readmitted.summary = "re-settled after continuation";
    readmitted.updatedAt = new Date(Date.parse("2024-03-01T00:00:00.000Z")).toISOString();
    await internals.save(group);

    // Push it out of the inline window again with 33 newer settlements.
    for (let index = 0; index < 33; index += 1) {
      await restored.add("exec-legacy-readmit", [{ title: `post ${index + 1}`, instructions: "work", acceptanceCriteria: ["done"] }]);
      await settleOldestUnsettled(restored, "exec-legacy-readmit", `post ${index + 1}`);
    }

    // The stable handle resolves the REWRITTEN archive, not the stale legacy
    // membership hash.
    const historical = await restored.inspectTask("exec-legacy-readmit", records[0]!.taskId);
    assert.equal(historical.tasks[0]!.taskId, records[0]!.taskId);
    assert.equal(historical.tasks[0]!.state, "landed");
    assert.equal(historical.tasks[0]!.summary, "re-settled after continuation");
    // The membership index no longer vouches for the superseded archive.
    const index = JSON.parse(await readFile(join(fixtureRoot, "tasks", "index.json"), "utf8")) as {
      entries: Record<string, unknown>;
    };
    assert.ok(!(records[0]!.taskId in index.entries));
    assert.ok(records[1]!.taskId in index.entries);

    // Restart: the handle still resolves through its bound archive.
    await restored.detach();
    const second = new BackgroundExecutionController({
      pi: {},
      config: normalizeConfig({ enabled: true, review: { activeReviewers: [] } }),
      state: createState(),
      cwd: () => workspaceRoot,
    });
    try {
      await second.restore({ waveRoots: [], bundles: [], groupRoots: [fixtureRoot] });
      const again = await second.inspectTask("exec-legacy-readmit", records[0]!.taskId);
      assert.equal(again.tasks[0]!.summary, "re-settled after continuation");
    } finally {
      await second.shutdown().catch(() => undefined);
      await second.detach().catch(() => undefined);
    }
  } finally {
    await restored?.shutdown().catch(() => undefined);
    await restored?.detach().catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a bundle-less archived continuation leaves counts and inline state unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-bundleless-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root, {});
    controller = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    const started = await controller.start([{ title: "bundleless seed", instructions: "seed", acceptanceCriteria: ["done"] }]);
    const archivedTaskId = started.tasks[0]!.taskId;
    for (let index = 0; index < 33; index += 1) {
      await controller.add(started.executionId, [{ title: `filler ${index + 1}`, instructions: "work", acceptanceCriteria: ["done"] }]);
      await settleOldestUnsettled(controller, started.executionId, `settle ${index + 1}`);
    }
    const before = controller.inspect(started.executionId);
    assert.equal(before.archivedCount, 1);
    assert.equal(before.historicalCount, 34);

    // No bundle (the settled record never produced one): the continuation
    // fails without re-admitting the record or touching any aggregate.
    await assert.rejects(
      () => controller!.continueTask({
        executionId: started.executionId,
        taskId: archivedTaskId,
        instructions: "resume",
        instructionId: "bundleless-probe",
        actor: "user",
      }),
      /has no durable continuation bundle/,
    );
    const internals = controllerInternals(controller);
    assert.equal(internals.groups.get(started.executionId)!.tasks.some((task) => task.taskId === archivedTaskId), false);
    const after = controller.inspect(started.executionId);
    assert.equal(after.archivedCount, 1);
    assert.equal(after.historicalCount, 34);
    // A later unrelated save keeps the record archive-only in the manifest.
    await controller.add(started.executionId, [{ title: "unrelated", instructions: "work", acceptanceCriteria: ["done"] }]);
    const manifest = JSON.parse(await readFile(join(started.root, "execution.json"), "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
    assert.ok(!manifest.tasks.some((task) => task.taskId === archivedTaskId && task.archived !== true));
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a save tail never evicts a task that a continuation reactivated", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-race-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root, {});
    controller = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    const started = await controller.start(Array.from({ length: 33 }, (_unused, index) => ({
      title: `race task ${index}`,
      instructions: "work",
      acceptanceCriteria: ["done"],
    })));
    const internals = controllerInternals(controller);
    const group = internals.groups.get(started.executionId)!;
    const reactivated = group.tasks[0]!;
    reactivated.bundle = {
      version: 1,
      operationId: "op-race",
      waveId: "wave-race",
      taskId: reactivated.taskId,
      waveRoot: join(tmpdir(), "wave-race-unused"),
      expectedRevision: 1,
    };
    // Settle tasks[0..31] with awaited saves (oldest updatedAt first), leaving
    // tasks[32] unsettled.
    for (let index = 0; index < 32; index += 1) {
      await settleOldestUnsettled(controller, started.executionId, `settle ${index + 1}`);
    }

    // Gate the evicting save inside its durable tail.
    let gateEntered = 0;
    let releaseSave!: () => void;
    const gate = new Promise<void>((resolveGate) => { releaseSave = resolveGate; });
    controller.setFaultHooks({
      save: () => {
        gateEntered += 1;
        return gateEntered === 1 ? gate : undefined;
      },
    });
    try {
      const racer = group.tasks[32]!;
      transitionTaskState(racer, "landed");
      racer.summary = "settled behind the gate";
      const gatedSave = internals.save(group);
      await waitFor(() => gateEntered === 1);
      // Reactivate the task the gated save serialized for eviction.
      const continuedPromise = controller.continueTask({
        executionId: started.executionId,
        taskId: reactivated.taskId,
        instructions: "reactivate while the older save is pending",
        instructionId: "race-continue",
        actor: "user",
      });
      releaseSave();
      await gatedSave;
      await continuedPromise;

      // The manifest keeps the reactivated task inline and queued; no stale
      // eviction survives, and the aggregates stay truthful.
      const manifest = JSON.parse(await readFile(join(started.root, "execution.json"), "utf8")) as {
        settledArchivedCount: number;
        tasks: Array<Record<string, unknown>>;
      };
      const handle = manifest.tasks.find((task) => task.taskId === reactivated.taskId)!;
      assert.equal(handle.archived, undefined);
      assert.equal(handle.state, "queued");
      assert.equal(manifest.settledArchivedCount, 0);
      const inspection = controller.inspect(started.executionId);
      assert.equal(inspection.archivedCount, 0);
      assert.equal(inspection.tasks.find((task) => task.taskId === reactivated.taskId)?.state, "queued");
    } finally {
      controller.setFaultHooks(undefined);
      releaseSave();
    }
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown wave-root retirement validates archives and never deletes on tampered content", async () => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-v2-wavescan-")));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-review-background-v2-wavescan-"));
  const legitWaveRoot = await realpath(await mkdtemp(join(tmpdir(), "wave-cleanup-legit-")));
  const decoyWaveRoot = await realpath(await mkdtemp(join(tmpdir(), "wave-cleanup-decoy-")));
  let restored: BackgroundExecutionController | undefined;
  try {
    const records = Array.from({ length: 40 }, (_unused, index) => collidingTaskRecord(
      `task-legacy-${index}`,
      new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
      new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
      `legacy summary ${index}`,
    ));
    records[1]!.waveRoot = legitWaveRoot;
    await writePersistedExecutionGroupTasks(fixtureRoot, workspaceRoot, "exec-legacy-wavescan", records);
    // Tamper one evicted archive so it claims the decoy wave root while its
    // integrity hash no longer matches: shutdown must skip it entirely.
    const tamperedPath = join(fixtureRoot, "tasks", `${records[0]!.taskId}.json`);
    const tampered = JSON.parse(await readFile(tamperedPath, "utf8")) as { task: { waveRoot?: string } };
    tampered.task.waveRoot = decoyWaveRoot;
    await writeFile(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

    restored = new BackgroundExecutionController({
      pi: {},
      config: normalizeConfig({ enabled: true, review: { activeReviewers: [] } }),
      state: createState(),
      cwd: () => workspaceRoot,
    });
    await restored.restore({ waveRoots: [], bundles: [], groupRoots: [fixtureRoot] });
    await restored.shutdown();

    // The validated archive's wave root was retired at whole-group cleanup...
    await assert.rejects(() => access(legitWaveRoot));
    // ...the tampered archive's claimed wave root was never touched...
    await access(decoyWaveRoot);
    // ...and the group root itself was still removed.
    await assert.rejects(() => access(fixtureRoot));
  } finally {
    await restored?.shutdown().catch(() => undefined);
    await restored?.detach().catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(legitWaveRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(decoyWaveRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("archive-reuse metadata for a save comes only from that group's bounded inline tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-prior-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root, {});
    controller = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    const startedA = await controller.start([
      { title: "a1", instructions: "work", acceptanceCriteria: ["done"] },
      { title: "a2", instructions: "work", acceptanceCriteria: ["done"] },
    ]);
    const startedB = await controller.start([
      { title: "b1", instructions: "work", acceptanceCriteria: ["done"] },
    ]);
    await settleOldestUnsettled(controller, startedA.executionId, "a1");
    await settleOldestUnsettled(controller, startedA.executionId, "a2");
    await settleOldestUnsettled(controller, startedB.executionId, "b1");

    // Plant archive metadata the old controller-wide scan would have picked
    // up: one phantom entry attributed to A for a task A never held, and one
    // foreign entry for B.
    const internals = controllerInternals(controller);
    const cache = internals.archivedTasks as Map<string, { updatedAt: string; integritySha256: string; executionId?: string }>;
    const bogus = { updatedAt: "2024-01-01T00:00:00.000Z", integritySha256: "f".repeat(64) };
    cache.set(`${startedA.executionId}:task-phantom`, { ...bogus, executionId: startedA.executionId });
    cache.set(`${startedB.executionId}:task-foreign`, { ...bogus, executionId: startedB.executionId });

    const groupA = internals.groups.get(startedA.executionId)!;
    const groupB = internals.groups.get(startedB.executionId)!;
    const priorArchivesOf = (controller as unknown as {
      priorArchivesFor(g: BackgroundExecutionGroup): Map<string, unknown>;
    }).priorArchivesFor.bind(controller);
    const priorA = priorArchivesOf(groupA);
    assert.deepEqual(
      [...priorA.keys()].sort(),
      [startedA.tasks[0]!.taskId, startedA.tasks[1]!.taskId].sort(),
      "A's reuse metadata contains exactly A's bounded inline tasks — no phantom, no foreign entries",
    );
    const priorB = priorArchivesOf(groupB);
    assert.deepEqual([...priorB.keys()], [startedB.tasks[0]!.taskId]);

    // And a real save of A still reuses A's own archives end to end.
    const writes: string[] = [];
    setDurableWriteFaultInjectionForTesting((stage, path) => {
      if (stage === "before_rename") writes.push(path);
    });
    try {
      await controller.add(startedA.executionId, [{ title: "a3", instructions: "work", acceptanceCriteria: ["done"] }]);
      assert.deepEqual(writes, [join(startedA.root, "execution.json")]);
      const manifest = JSON.parse(await readFile(join(startedA.root, "execution.json"), "utf8")) as {
        tasks: Array<{ taskId: string; archiveIntegritySha256?: string }>;
      };
      for (const taskId of [startedA.tasks[0]!.taskId, startedA.tasks[1]!.taskId]) {
        const reference = manifest.tasks.find((task) => task.taskId === taskId)!;
        const archiveOnDisk = JSON.parse(await readFile(join(startedA.root, "tasks", `${taskId}.json`), "utf8")) as { integritySha256: string };
        assert.equal(reference.archiveIntegritySha256, archiveOnDisk.integritySha256);
      }
    } finally {
      setDurableWriteFaultInjectionForTesting(undefined);
    }
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("sequential top-offs keep manifest bytes, inline state, and widget work bounded (finding 15 soak)", async () => {
  const SOAK_TOP_OFFS = 220;
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-soak-"));
  let controller: BackgroundExecutionController | undefined;
  let restored: BackgroundExecutionController | undefined;
  const ownedRoots = new Set<string>();
  try {
    await initGitRepo(root);
    controller = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
      notify: () => undefined,
    });
    const started = await controller.start([{ title: "seed task", instructions: "seed", acceptanceCriteria: ["done"] }]);
    ownedRoots.add(started.root);
    const executionId = started.executionId;
    const manifestPath = join(started.root, "execution.json");
    const firstSettledTaskId = started.tasks[0]!.taskId;
    let sizeAfterWindow = 0;
    for (let index = 0; index < SOAK_TOP_OFFS; index += 1) {
      await settleOldestUnsettled(controller, executionId, `top-off ${index + 1}`);
      if (index === 40) sizeAfterWindow = (await stat(manifestPath)).size;
      if (index < SOAK_TOP_OFFS - 1) {
        await controller.add(executionId, [{
          title: `top-off ${index + 1}`,
          instructions: `top-off work ${index + 1}`,
          acceptanceCriteria: ["done"],
        }]);
      }
      // Bounded in-memory inline state despite lifetime completions, and the
      // active-task index tracks exactly the live population.
      const live = controllerInternals(controller).groups.get(executionId)!;
      assert.ok(
        live.tasks.length <= INLINE_SETTLED_TASK_LIMIT + 1,
        `inline task window must stay bounded after ${index + 1} top-offs (got ${live.tasks.length})`,
      );
      assert.equal(
        controllerInternals(controller).activeTasks.size,
        index < SOAK_TOP_OFFS - 1 ? 1 : 0,
        `active-task index must track exactly the live population (top-off ${index + 1})`,
      );
    }

    // Bounded durable manifest independent of lifetime completions.
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: number;
      totalTaskCount: number;
      settledArchivedCount: number;
      tasks: Array<Record<string, unknown>>;
    };
    assert.equal(manifest.version, 3);
    assert.equal(manifest.totalTaskCount, SOAK_TOP_OFFS);
    assert.equal(manifest.settledArchivedCount, SOAK_TOP_OFFS - INLINE_SETTLED_TASK_LIMIT);
    assert.equal(manifest.tasks.length, INLINE_SETTLED_TASK_LIMIT);
    assert.ok(manifest.tasks.every((task) => task.archived === true));
    const finalSize = (await stat(manifestPath)).size;
    assert.ok(
      finalSize <= sizeAfterWindow + 4096,
      `manifest bytes must stay bounded across sequential top-offs (${sizeAfterWindow} -> ${finalSize})`,
    );

    // Every historical archive remains independently addressable on disk.
    const archiveFiles = await readdir(join(started.root, "tasks"));
    assert.equal(archiveFiles.length, SOAK_TOP_OFFS);
    const evictedArchive = JSON.parse(
      await readFile(join(started.root, "tasks", `${firstSettledTaskId}.json`), "utf8"),
    ) as { task: { taskId: string; state: string; summary: string } };
    assert.equal(evictedArchive.task.taskId, firstSettledTaskId);
    assert.equal(evictedArchive.task.state, "landed");

    // Truthful aggregate counts in inspection and completion notifications.
    const inspection = controller!.inspect(executionId);
    assert.equal(inspection.historicalCount, SOAK_TOP_OFFS);
    assert.equal(inspection.archivedCount, SOAK_TOP_OFFS - INLINE_SETTLED_TASK_LIMIT);
    assert.equal(inspection.activeCount, 0);
    assert.equal(inspection.tasks.length, INLINE_SETTLED_TASK_LIMIT);
    assert.equal(inspection.scheduling.globallyDispatchPending, 0);
    const notificationCollector: string[] = [];
    (controller as unknown as { input: { notify?: (message: string) => void } }).input.notify = (message) => notificationCollector.push(message);
    const internals = controllerInternals(controller!);
    const completionTask = inspection.tasks[0]!;
    await internals.wake(completionTask, "completion", `Task ${completionTask.taskId} landed.`);
    assert.ok(
      notificationCollector.some((message) => message.includes(`Execution ${executionId} COMPLETE: ${SOAK_TOP_OFFS}/${SOAK_TOP_OFFS} tasks landed.`)),
      "completion aggregates must be truthful from persisted counts",
    );
    assert.ok(
      notificationCollector.some((message) => message.includes(`${SOAK_TOP_OFFS - INLINE_SETTLED_TASK_LIMIT} earlier task(s) landed and are archived`)),
      "completion notifications must disclose archive-only omissions",
    );

    // Widget updates stay bounded: the indicator traverses only the bounded
    // inline window, and an expanded live-view render succeeds from it.
    const widgetContents: unknown[] = [];
    const widgetCtx = { ui: { setWidget: (_name: string, content: unknown) => { widgetContents.push(content); } } };
    await controller!.toggleExpandedView(widgetCtx);
    assert.equal(widgetContents.length, 1);
    const expandedComponent = widgetContents[0] as () => { render(width: number): string[]; invalidate(): void };
    const rendered = expandedComponent().render(240);
    assert.ok(rendered[0]!.includes("0 active background subtasks"));
    assert.ok(rendered.some((line: string) => line.includes("No active background subtasks.")));

    // Restart: restore must not eagerly hydrate historical archives, and exact
    // historical lookup must lazily load and integrity-check the archive.
    const associations = controller!.associations();
    for (const groupRoot of associations.groupRoots ?? []) ownedRoots.add(groupRoot);
    await controller!.detach();
    controller = undefined;
    restored = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    await restored.restore(associations);
    const restoredGroup = controllerInternals(restored).groups.get(executionId)!;
    assert.ok(restoredGroup.tasks.length <= INLINE_SETTLED_TASK_LIMIT, "restore must not eagerly hydrate historical archives");
    assert.equal(restoredGroup.totalTaskCount, SOAK_TOP_OFFS);
    assert.equal(restoredGroup.settledArchivedCount, SOAK_TOP_OFFS - INLINE_SETTLED_TASK_LIMIT);
    const historical = await restored.inspectTask(executionId, firstSettledTaskId);
    assert.equal(historical.tasks[0]!.taskId, firstSettledTaskId);
    assert.equal(historical.tasks[0]!.state, "landed");
    assert.ok(historical.tasks[0]!.summary!.includes("settled outcome"));
    assert.equal(historical.historicalCount, SOAK_TOP_OFFS);
    assert.equal(historical.archivedCount, SOAK_TOP_OFFS - INLINE_SETTLED_TASK_LIMIT);
    // Stable aggregate counts survive the restart.
    const restoredInspection = restored.inspect(executionId);
    assert.equal(restoredInspection.historicalCount, SOAK_TOP_OFFS);
    assert.equal(restoredInspection.archivedCount, SOAK_TOP_OFFS - INLINE_SETTLED_TASK_LIMIT);
  } finally {
    await restored?.shutdown().catch(() => undefined);
    await restored?.detach().catch(() => undefined);
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    for (const owned of ownedRoots) await rm(owned, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
