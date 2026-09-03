import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { compareSnapshots, createWorkspaceSnapshot } from "../src/capture";
import { normalizeConfig } from "../src/config";
import {
  BackgroundExecutionController,
  MAX_UNSETTLED_TASKS_PER_EXECUTION,
  isArchivableTaskState,
  type BackgroundExecutionGroup,
  type BackgroundFaultHooks,
  type BackgroundInspection,
  type BackgroundStateTransition,
  type BackgroundTaskRecord,
  formatWatchEvent,
} from "../src/execution/background-controller";
import { INLINE_SETTLED_TASK_LIMIT } from "../src/execution/background-group-store";
import { setDurableWriteFaultInjectionForTesting } from "../src/execution/durable-write";
import { transitionTaskState } from "../src/execution/task-state";
import { activeExchangeBaseline, beginAgentRun, createState, rememberUserRequest, setReviewWindowBaseline } from "../src/state";
import { sourceMutationCoordinator } from "../src/execution/source-mutation-lease";

const execFileAsync = promisify(execFile);

test("background tasks return immediately, land independently, and additions capture prior landings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-controller-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
    const executor = join(root, "executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>setTimeout(()=>{",
      "if(prompt.includes('FIRST_SENTINEL'))fs.writeFileSync('first.txt','first landed\\n');",
      "if(prompt.includes('PEER_SENTINEL'))fs.writeFileSync('peer.txt','peer landed\\n');",
      "if(prompt.includes('SECOND_SENTINEL'))fs.writeFileSync('second.txt',fs.existsSync('first.txt')?'saw first\\n':'missed first\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
      "},350));",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "fake",
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: {
        activeExecutor: { source: "external", id: "fake" },
        maxWorkers: 2,
      },
      retainBundles: "always",
    });
    const messages: string[] = [];
    const controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
      config,
      state: createState(),
      cwd: () => root,
    });

    const startedAt = Date.now();
    const first = await controller.start([
      {
        title: "first",
        instructions: "FIRST_SENTINEL",
        acceptanceCriteria: ["first.txt exists"],
      },
      {
        title: "peer",
        instructions: "PEER_SENTINEL",
        acceptanceCriteria: ["peer.txt exists"],
      },
    ]);
    assert.ok(Date.now() - startedAt < 300, "start should return before the deliberately delayed worker");
    assert.equal(first.activeCount, 2);
    assert.equal(first.tasks.length, 2);
    assert.equal(first.scheduling.dispatchPending, 0);
    assert.equal(first.scheduling.dispatchAssigned, 2);
    assert.equal(first.scheduling.configuredWorkerLimit, 2);
    assert.equal(first.scheduling.configuredPoolCapacity, 2);
    assert.equal(first.scheduling.estimatedImmediatelyAvailableSlots, 0);
    await waitFor(() => controller.inspect(first.executionId).tasks.every((task) => task.state === "landed"));
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "first landed\n");
    assert.equal(await readFile(join(root, "peer.txt"), "utf8"), "peer landed\n");
    await waitFor(() => messages.some((message) => /Landed paths: first\.txt/.test(message)));
    assert.ok(messages.every((message) => !/CAPTURING -> RUNNING.*task is ACTIVE/s.test(message)));
    assert.ok(messages.some((message) => /landed independently/.test(message)), "quiet mode still reports each task landing");
    assert.ok(messages.every((message) => !/Execution revision: \d+/.test(message)));
    assert.ok(messages.every((message) => !/Task timing \(ms\):/.test(message)));
    assert.ok(messages.every((message) => !/Post-settlement scheduler:/.test(message)));
    assert.ok(messages.some((message) => /Top-off opportunity: up to 1 additional task\(s\) may be submitted with SubtasksAdd/.test(message)));

    config.execution!.subtaskNotifications = "noisy";
    const toppedOff = await controller.add(first.executionId, [{
      title: "second",
      instructions: "SECOND_SENTINEL",
      acceptanceCriteria: ["second.txt records the prior landing"],
    }]);
    assert.equal(toppedOff.tasks.length, 3);
    assert.notEqual(toppedOff.tasks[0]?.taskId, toppedOff.tasks[2]?.taskId);
    await waitFor(() => controller.inspect(first.executionId).tasks.every((task) => task.state === "landed"));
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "saw first\n");
    assert.ok(messages.some((message) => message.includes(toppedOff.tasks[2]!.taskId) && /task is ACTIVE/s.test(message)));
    assert.ok(messages.some((message) => /landed independently/.test(message)));
    await waitFor(() => messages.some((message) => /Top-off opportunity: up to 2 additional task\(s\) may be submitted with SubtasksAdd/.test(message)));
    assert.equal(controller.inspect(first.executionId).activeCount, 0);
    const completedInspection = controller.inspect(first.executionId);
    assert.equal(completedInspection.peakConcurrency, 2);
    assert.ok(completedInspection.tasks.every((task) => task.timing.totalMs > 0));
    assert.ok(completedInspection.tasks.every((task) => (task.stateHistory?.length ?? 0) >= 3));
    assert.ok(messages.every((message) => !/Execution timing \(ms\):/.test(message)));
    const associations = controller.associations();
    await controller.shutdown();
    await controller.detach();
    const restored = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    await restored.restore(associations);
    const restoredAssociations = restored.associations();
    assert.deepEqual(restoredAssociations.waveRoots, []);
    assert.deepEqual(restoredAssociations.bundles, []);
    assert.deepEqual(restoredAssociations.groupRoots, []);
    assert.throws(() => restored.inspect(first.executionId), /Unknown execution group/);
    await restored.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settled tasks move to bounded archives and restore through stable task handles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-archive-"));
  let controller: BackgroundExecutionController | undefined;
  let restored: BackgroundExecutionController | undefined;
  const ownedRoots = new Set<string>();
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
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
      externalAgents: [{
        id: "archive",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] },
      }],
      execution: {
        activeExecutor: { source: "external", id: "archive" },
        maxWorkers: 2,
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
      externalAgents: [{
        id: "never-started",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", "process.stdin.resume()"] },
      }],
      execution: { activeExecutor: { source: "external", id: "never-started" }, maxWorkers: 1 },
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

test("parallel independent landings accumulate in the parent review checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-checkpoint-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });

    const executor = join(root, "checkpoint-executor.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "const task=prompt.includes('FIRST_CHECKPOINT')?['first.txt',100]:prompt.includes('SECOND_CHECKPOINT')?['second.txt',200]:['third.txt',350];",
      "setTimeout(()=>{fs.writeFileSync(task[0],task[0]+' landed\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));},task[1]);",
      "});",
    ].join("\n"), "utf8");

    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "checkpoint",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] },
      }],
      execution: {
        activeExecutor: { source: "external", id: "checkpoint" },
        maxWorkers: 3,
      },
    });
    const state = createState();
    rememberUserRequest(state, "create three files with parallel subtasks and one parent file");
    beginAgentRun(state);
    const originalBaseline = await createWorkspaceSnapshot(root, {
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
    });
    setReviewWindowBaseline(state, originalBaseline);
    await writeFile(join(root, "parent.txt"), "parent-authored\n", "utf8");

    controller = new BackgroundExecutionController({ config, state, cwd: () => root, pi: {} });
    const started = await controller.start([
      { title: "first", instructions: "FIRST_CHECKPOINT", acceptanceCriteria: ["first.txt exists"] },
      { title: "second", instructions: "SECOND_CHECKPOINT", acceptanceCriteria: ["second.txt exists"] },
      { title: "third", instructions: "THIRD_CHECKPOINT", acceptanceCriteria: ["third.txt exists"] },
    ]);
    await waitFor(() => controller!.inspect(started.executionId).tasks.every((task) => task.state === "landed"), 30_000);

    const checkpoint = activeExchangeBaseline(state);
    assert.ok(checkpoint);
    const current = await createWorkspaceSnapshot(root, {
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
      reuseUnchangedFrom: checkpoint,
    });
    assert.deepEqual(compareSnapshots(checkpoint, current).map((change) => change.path), ["parent.txt"]);
    const owned = controller.associations();
    assert.equal(owned.groupRoots?.length, 1);
    assert.equal(owned.waveRoots.length, 3);
    await controller.shutdown();
    await controller.cleanupSettledArtifacts();
    assert.deepEqual(controller.associations().groupRoots, []);
    assert.deepEqual(controller.associations().waveRoots, []);
    for (const path of [...(owned.groupRoots ?? []), ...owned.waveRoots]) {
      await assert.rejects(access(path), /ENOENT/);
    }
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("research tasks report without review or landing and quarantine accidental writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-research-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await writeFile(join(root, ".gitignore"), "ignored-research.txt\n", "utf8");
    await execFileAsync("git", ["add", "base.txt", ".gitignore"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
    const executor = join(root, "research-codex.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs'),readline=require('node:readline');let threadId='thread-'+process.pid,turn=0;",
      "const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');",
      "readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);",
      "if(request.method==='initialize')return send({jsonrpc:'2.0',id:request.id,result:{userAgent:'test-codex'}});",
      "if(request.method==='initialized')return;",
      "if(request.method==='thread/start'||request.method==='thread/resume')return send({jsonrpc:'2.0',id:request.id,result:{thread:{id:request.params.threadId||threadId}}});",
      "if(request.method==='turn/start'){const prompt=request.params.input?.[0]?.text||'';if(prompt.includes('DIRTY_RESEARCH'))fs.writeFileSync('ignored-research.txt','must not land\\n');",
      "const turnId='turn-'+(++turn),text=prompt.includes('LONG_RESEARCH')?'Summary: The captured baseline was found.\\n\\n## Details\\n'+('LONG_DETAIL '.repeat(120)):'Evidence-backed finding: base.txt contains the captured baseline.';send({jsonrpc:'2.0',id:request.id,result:{turn:{id:turnId}}});",
      "setImmediate(()=>{send({jsonrpc:'2.0',method:'item/completed',params:{item:{type:'agentMessage',text}}});send({jsonrpc:'2.0',method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[{type:'agentMessage',text}]}}});});return;}",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "researcher",
        adapter: "codex-cli",
        command: executor,
        execution: {},
      }],
      execution: {
        workerResources: [{
          resourceId: "researcher",
          selection: { source: "external", id: "researcher" },
          maxConcurrent: 2,
        }],
        routes: {
          execute: [],
          research: [{ resourceId: "researcher" }],
        },
        maxWorkers: 2,
      },
      retainBundles: "always",
    });
    const messages: string[] = [];
    const controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
      config,
      state: createState(),
      cwd: () => root,
    });

    const started = await controller.start([
      {
        title: "clean research",
        instructions: "Inspect base.txt and report evidence.",
        acceptanceCriteria: ["Return an evidence-backed report"],
        executorAllowedTools: ["read"],
      },
      {
        title: "dirty research",
        instructions: "DIRTY_RESEARCH",
        acceptanceCriteria: ["Return an evidence-backed report"],
        executorAllowedTools: ["read"],
      },
      {
        title: "long research",
        instructions: "LONG_RESEARCH",
        acceptanceCriteria: ["Return a detailed report with a bounded summary"],
        executorAllowedTools: ["read"],
      },
    ], "research");
    assert.equal(started.kind, "research");
    await waitFor(() => controller.inspect(started.executionId).activeCount === 0);
    const finished = controller.inspect(started.executionId);
    const clean = finished.tasks.find((task) => task.definition.title === "clean research")!;
    const dirty = finished.tasks.find((task) => task.definition.title === "dirty research")!;
    const long = finished.tasks.find((task) => task.definition.title === "long research")!;
    assert.equal(clean.state, "reported");
    assert.match(clean.report ?? "", /Evidence-backed finding/);
    const reportArtifact = await readFile(clean.reportPath!, "utf8");
    assert.match(reportArtifact, new RegExp(`Captured source commit: [0-9a-f]{40}`));
    assert.match(reportArtifact, /Workspace disposition: unchanged/);
    assert.match(reportArtifact, /Evidence-backed finding/);
    assert.equal(dirty.state, "failed");
    assert.match(dirty.error ?? "", /read-only contract/);
    await assert.rejects(readFile(join(root, "ignored-research.txt"), "utf8"), /ENOENT/);
    await waitFor(() => messages.some((message) => /completed without workspace changes/.test(message)));
    const cleanMessage = messages.find((message) => message.startsWith(`Research task ${clean.taskId} completed without workspace changes.`))!;
    assert.match(cleanMessage, /Complete report:\nEvidence-backed finding/);
    await waitFor(() => messages.some((message) => message.startsWith(`Research task ${long.taskId} completed without workspace changes.`)));
    const longMessage = messages.find((message) => message.startsWith(`Research task ${long.taskId} completed without workspace changes.`))!;
    assert.match(longMessage, /Full report: .*research-report\.md/);
    assert.match(longMessage, /too long to inline completely; no partial report excerpt is included/);
    assert.match(longMessage, /Summary: The captured baseline was found\./);
    assert.doesNotMatch(longMessage, /LONG_DETAIL/);
    await waitFor(() => messages.some((message) => /private changes were quarantined and main is unchanged/.test(message)));
    await assert.rejects(controller.forceMerge({
      executionId: started.executionId,
      taskId: dirty.taskId,
      mergeAnyhow: false,
      instructionId: "research-force-merge",
      actor: "model",
    }), /Research tasks have reports, not mergeable checkpoints/);

    const associations = controller.associations();
    await controller.shutdown();
    await controller.detach();
    const restored = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    await restored.restore(associations);
    assert.equal(restored.inspect(started.executionId).kind, "research");
    assert.equal(restored.inspect(started.executionId).tasks.find((task) => task.taskId === clean.taskId)?.state, "reported");
    await restored.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("noisy subtask notifications wake the orchestrator when active execution enters review", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-review-state-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
    const executor = join(root, "executor.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');",
      "fs.writeFileSync('reviewed.txt','ready\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'review-state-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:'done'}));",
    ].join("\n"), "utf8");
    const config = normalizeConfig({
      enabled: true,
      decider: {
        id: "passing",
        adapter: "generic-cli",
        command: process.execPath,
        args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'ok',findings:[]})),100))"],
        timeoutMs: 5_000,
      },
      externalAgents: [{
        id: "fake",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] },
      }],
      execution: {
        activeExecutor: { source: "external", id: "fake" },
        maxWorkers: 1,
        subtaskNotifications: "noisy",
      },
    });
    const messages: string[] = [];
    const widgets: unknown[] = [];
    controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
      config,
      state: createState(),
      cwd: () => root,
    });
    await controller.toggleExpandedView({
      ui: { setWidget: (_key: string, content: unknown) => widgets.push(content) },
    });
    const started = await controller.start([{
      title: "review transition",
      instructions: "write reviewed.txt",
      acceptanceCriteria: ["reviewed.txt exists"],
    }]);
    await waitFor(() => controller!.inspect(started.executionId).tasks[0]?.state === "landed", 30_000);
    assert.ok(messages.some((message) => /CAPTURING -> RUNNING.*task is ACTIVE/s.test(message)));
    assert.ok(messages.some((message) => /(?:CAPTURING|RUNNING) -> REVIEWING.*task is REVIEWING/s.test(message)));
    assert.ok(messages.some((message) => /NO TOOL ACTION IS NECESSARY/.test(message)));
    assert.ok(messages.some((message) => new RegExp(`No action for ${started.tasks[0]!.taskId} at (?:RUNNING|REVIEWING)`).test(message)));
    assert.ok(messages.every((message) => !/-> (?:CAPTURING|ACCEPTED|WAITING_TO_LAND|LANDING)/.test(message)));
    assert.ok(messages.every((message) => !/interaction reported a failure/.test(message)));
    const inspection = controller.inspect(started.executionId);
    assert.deepEqual(inspection.tasks[0]?.reviewStatus?.reviewers, ["passing"]);
    assert.doesNotMatch(renderWidget(widgets.at(-1)).join("\n"), /reviewers passing \(accepted\)/, "inactive landed tasks leave the active summary");
    assert.ok(widgets.some((content) => /passing (?:started|finished)/.test(renderWidget(content).join("\n"))));
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("steering unsupported by a live turn is applied after it settles even when review is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-deferred-steer-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
    const executor = join(root, "deferred-steer.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');",
      "const turn=Number(process.env.PI_REVIEW_EXECUTOR_TURN||'1');",
      "process.stdin.resume();process.stdin.on('end',()=>{",
      "fs.writeFileSync('deferred.txt',turn===1?'true\\n':'false\\n');",
      "setTimeout(()=>{",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'deferred-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:'turn '+turn+' complete'}));",
      "},500);",
      "});",
    ].join("\n"), "utf8");
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "deferred",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] },
      }],
      execution: { activeExecutor: { source: "external", id: "deferred" }, maxWorkers: 1 },
    });
    controller = new BackgroundExecutionController({ config, state: createState(), cwd: () => root, pi: {} });
    const started = await controller.start([{
      title: "deferred steering",
      instructions: "write true first",
      acceptanceCriteria: ["deferred.txt reflects the latest instruction"],
    }]);
    const taskId = started.tasks[0]!.taskId;
    await waitFor(() => controller!.inspect(started.executionId, taskId).tasks[0]?.state === "running");
    const queued = await controller.steer({
      executionId: started.executionId,
      taskId,
      instructions: "write false instead",
      instructionId: "deferred-steer",
      actor: "model",
    });
    assert.equal(queued.tasks[0]?.commands.at(-1)?.status, "queued");
    await waitFor(() => controller!.inspect(started.executionId, taskId).tasks[0]?.state === "landed", 30_000);
    assert.equal(await readFile(join(root, "deferred.txt"), "utf8"), "false\n");
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.commands.at(-1)?.status, "acknowledged");
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("queued steering is incorporated before startup and landing events distinguish partial from complete execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-steering-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
    const executor = join(root, "steerable-executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "const first=prompt.includes('FIRST_SENTINEL');",
      "if(first)fs.writeFileSync('first.txt','first\\n');",
      "else fs.writeFileSync('second.txt',prompt.includes('STEER_FALSE')?'false':'true');",
      "setTimeout(()=>{",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
      "},first?500:10);",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "steerable",
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: {
        activeExecutor: { source: "external", id: "steerable" },
        maxWorkers: 1,
        subtaskNotifications: "noisy",
      },
      retainBundles: "always",
    });
    const messages: string[] = [];
    controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
      config,
      state: createState(),
      cwd: () => root,
    });
    const started = await controller.start([
      { title: "first task", instructions: "FIRST_SENTINEL", acceptanceCriteria: ["first.txt exists"] },
      { title: "second task", instructions: "SECOND_SENTINEL", acceptanceCriteria: ["second.txt is false"] },
    ]);
    const secondId = started.tasks[1]!.taskId;
    const steered = await controller.steer({
      executionId: started.executionId,
      taskId: secondId,
      instructions: "STEER_FALSE: write false instead of true",
      instructionId: "queued-steer",
      actor: "model",
    });
    assert.equal(steered.tasks[0]?.commands.at(-1)?.status, "queued");

    const probe = await controller.start([{
      title: "invalid probe",
      instructions: "SECOND_SENTINEL",
      acceptanceCriteria: ["probe is cancelled"],
    }]);
    const interrupted = await controller.interrupt({
      executionId: probe.executionId,
      mode: "interrupt_as_failure",
      instructionId: "cancel-single-task-execution",
      actor: "user",
    });
    assert.equal(interrupted.tasks[0]?.state, "interrupted");
    assert.match(interrupted.tasks[0]?.summary ?? "", /before executor startup/);

    await waitFor(() => controller!.inspect(started.executionId).tasks[0]?.state === "landed", 60_000);
    await waitFor(() => messages.some((message) => /partial task completion, not completion of the whole group/.test(message)));
    assert.ok(messages.some((message) => message.includes(secondId) && /not landed/.test(message)));
    await waitFor(() => controller!.inspect(started.executionId).tasks.every((task) => task.state === "landed"), 60_000);
    await waitFor(() => messages.some((message) => /COMPLETE: 2\/2 tasks landed/.test(message)));
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "false");
    for (const task of started.tasks) {
      assert.ok(
        messages.some((message) => message.includes(task.taskId) && /CAPTURING -> RUNNING.*task is ACTIVE/s.test(message)),
        `${task.taskId} must independently notify when pool capacity lets it become active`,
      );
      assert.ok(
        messages.some((message) => message.includes(task.taskId) && /landed independently|continuation landed|force-merged and landed/.test(message)),
        `${task.taskId} must independently notify when landed`,
      );
    }
    assert.ok(messages.some((message) => /COMPLETE: 2\/2 tasks landed/.test(message)));
    assert.ok(messages.some((message) => /aggregate verification is now appropriate/.test(message)));
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupt quiesces a writer and force-merge lands its verified checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-interrupt-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
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
      externalAgents: [{
        id: "slow",
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: { activeExecutor: { source: "external", id: "slow" }, maxWorkers: 1 },
      retainBundles: "always",
    });
    const controller = new BackgroundExecutionController({ config, state: createState(), cwd: () => root, pi: {} });
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
    const interrupted = await controller.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_as_failure",
      instructionId: "interrupt-test",
      actor: "user",
    });
    assert.equal(interrupted.tasks[0]?.state, "interrupted");
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"));
    const landed = await controller.forceMerge({
      executionId: started.executionId,
      taskId,
      mergeAnyhow: false,
      instructionId: "force-test",
      actor: "user",
    });
    assert.equal(landed.tasks[0]?.state, "landed");
    assert.match(landed.tasks[0]?.summary ?? "", /manual workspace inspection is still required/i);
    assert.equal(await readFile(join(root, "draft.txt"), "utf8"), "recover me\n");
    await controller.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("force-merge fails promptly with an actionable outcome when a conflict gate blocks the source", async () => {
  const scenario = await setupInterruptedMergeTask("gate-blocked");
  const { root, controller, started, taskId } = scenario;
  let releaseGate: (() => void) | undefined;
  try {
    releaseGate = sourceMutationCoordinator.block(root, "unresolved conflict markers hold the source workspace");
    await assert.rejects(
      controller.forceMerge({
        executionId: started.executionId,
        taskId,
        mergeAnyhow: false,
        instructionId: "force-blocked",
        actor: "user",
      }),
      /conflict gate[\s\S]*SubtasksMarkClean/,
    );
    const task = controller.inspect(started.executionId, taskId).tasks[0]!;
    assert.equal(task.state, "interrupted", "the pre-merge state must survive a refused force-merge");
    const command = task.commands.find((candidate) => candidate.instructionId === "force-blocked")!;
    assert.equal(command.status, "failed");
    assert.match(command.error ?? "", /unresolved conflict markers hold the source workspace/);
    assert.match(command.error ?? "", /SubtasksMarkClean/);
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/);
    assert.equal(await readFile(join(root, "base.txt"), "utf8"), "base\n");
  } finally {
    releaseGate?.();
    await scenario.cleanup();
  }
});

test("shutdown cancels a force-merge waiting behind a held source mutation lease", async () => {
  const scenario = await setupInterruptedMergeTask("shutdown-cancel");
  const { root, controller, started, taskId } = scenario;
  const releaseLease = await sourceMutationCoordinator.acquire(root);
  try {
    const mergeOutcome = controller.forceMerge({
      executionId: started.executionId,
      taskId,
      mergeAnyhow: false,
      instructionId: "force-wait-shutdown",
      actor: "user",
    });
    // The rejection is asserted below; attach a handler now so the rejection is
    // never briefly unhandled while shutdown settles it.
    mergeOutcome.catch(() => undefined);
    await waitFor(() => controller.inspect(started.executionId, taskId).tasks[0]?.commands
      .some((candidate) => candidate.instructionId === "force-wait-shutdown") === true);
    await controller.shutdown();
    await assert.rejects(mergeOutcome, /shutting down/);
    const task = controller.inspect(started.executionId, taskId).tasks[0]!;
    assert.equal(task.state, "interrupted", "a cancelled force-merge must not claim a landing");
    const command = task.commands.find((candidate) => candidate.instructionId === "force-wait-shutdown")!;
    assert.equal(command.status, "failed");
    assert.match(command.error ?? "", /shutting down/);
    assert.match(task.summary ?? "", /no checkpoint landed and the main workspace is unchanged/i);
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/);
    assert.equal(await readFile(join(root, "base.txt"), "utf8"), "base\n");
  } finally {
    releaseLease();
    await scenario.cleanup();
  }
});

test("interrupt cancels a force-merge waiting behind a held source mutation lease", async () => {
  const scenario = await setupInterruptedMergeTask("interrupt-cancel");
  const { root, controller, started, taskId } = scenario;
  const releaseLease = await sourceMutationCoordinator.acquire(root);
  try {
    const mergeOutcome = controller.forceMerge({
      executionId: started.executionId,
      taskId,
      mergeAnyhow: false,
      instructionId: "force-wait-cancel",
      actor: "model",
    });
    // The rejection is asserted below; attach a handler now so the rejection is
    // never briefly unhandled while the interrupt quiesces the merge.
    mergeOutcome.catch(() => undefined);
    await waitFor(() => controller.inspect(started.executionId, taskId).tasks[0]?.commands
      .some((candidate) => candidate.instructionId === "force-wait-cancel") === true);
    const inspected = await controller.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_as_failure",
      instructionId: "interrupt-cancel-merge",
      actor: "user",
    });
    assert.equal(inspected.tasks[0]?.state, "interrupted");
    await assert.rejects(mergeOutcome, /interrupt/);
    const task = controller.inspect(started.executionId, taskId).tasks[0]!;
    const cancelCommand = task.commands.find((candidate) => candidate.instructionId === "interrupt-cancel-merge")!;
    assert.equal(cancelCommand.status, "acknowledged");
    const mergeCommand = task.commands.find((candidate) => candidate.instructionId === "force-wait-cancel")!;
    assert.equal(mergeCommand.status, "failed");
    assert.match(task.summary ?? "", /no checkpoint landed and the main workspace is unchanged/i);
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/);
    assert.equal(await readFile(join(root, "base.txt"), "utf8"), "base\n");
  } finally {
    releaseLease();
    await scenario.cleanup();
  }
});

test("restored conflict gates keep injecting until mark-clean validates resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-conflict-"));
  try {
    const path = join(root, "conflicted.txt");
    await writeFile(path, "<<<<<<< current workspace\nours\n=======\ntheirs\n>>>>>>> subtask\n", "utf8");
    const controller = new BackgroundExecutionController({
      pi: {},
      config: normalizeConfig({ enabled: true, review: { activeReviewers: [] } }),
      state: createState(),
      cwd: () => root,
    });
    await controller.restore({
      waveRoots: [],
      bundles: [],
      conflictGate: {
        executionId: "exec-restored",
        taskId: "task-restored",
        sourceRoot: root,
        paths: ["conflicted.txt"],
        activatedAt: new Date().toISOString(),
        manifestPath: join(root, "conflict-manifest.json"),
        reason: "restored conflict",
      },
    });
    assert.match(controller.criticalPrompt() ?? "", /CRITICAL REVIEW-GATE WORKSPACE CONFLICT/);
    await assert.rejects(controller.markClean(), /Conflict markers remain/);
    assert.ok(controller.criticalPrompt());
    await writeFile(path, "resolved\n", "utf8");
    assert.deepEqual(await controller.markClean(), { cleared: true, paths: ["conflicted.txt"] });
    assert.equal(controller.criticalPrompt(), undefined);
    await controller.shutdown();
    await controller.detach();
  } finally {
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
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
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
      externalAgents: [{
        id: "slow",
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: { activeExecutor: { source: "external", id: "slow" }, maxWorkers: 1 },
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

test("launch rejection never regresses a terminal state even with a pending interruption mode", async () => {
  const scenario = await setupFaultScenario({});
  const { controller, started, messages } = scenario;
  try {
    await waitFor(() => controller.inspect(started.executionId).tasks[0]?.state === "landed");
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      handleLaunchRejection: (group: BackgroundExecutionGroup, task: BackgroundTaskRecord, error: unknown) => Promise<void>;
    };
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    assert.equal(task.state, "landed");
    // Simulate interrupt() having set its mode while the launch promise is still
    // settling, followed by a post-terminal rejection reaching the launch catch.
    task.interruptionMode = "interrupt_as_failure";
    await internals.handleLaunchRejection(group, task, new Error("post-terminal bookkeeping rejection"));
    assert.equal(task.state, "landed", "a pending interruption mode must not regress a landed task");
    assert.ok((task.stateHistory ?? []).every((entry) => entry.state !== "interrupted" && entry.state !== "failed"));
    assert.ok(
      task.activity.some((event) => event.phase === "bookkeeping" && /already reached landed.*outcome is preserved.*post-terminal bookkeeping rejection/s.test(event.message)),
      "expected a bookkeeping activity entry preserving the landed outcome",
    );
    assert.ok(messages.some((message) => /already reached landed.*outcome is preserved/.test(message)));
    await controller.shutdown();
  } finally {
    await scenario.cleanup();
  }
});

test("interrupt before executor startup terminalizes a restored auto-queued continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-restore-continuation-"));
  let executionRoot: string | undefined;
  try {
    const executor = join(root, "executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{fs.writeFileSync('executor-ran.txt','launched\\n');console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "restore-fake",
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: { activeExecutor: { source: "external", id: "restore-fake" }, maxWorkers: 1 },
    });
    // Nothing may ever be dispatched in this scenario: every task stays queued.
    config.execution!.maxWorkers = 0;
    const original = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    const started = await original.start([{ title: "restored continuation", instructions: "original work", acceptanceCriteria: ["done"] }]);
    executionRoot = started.root;
    const associations = original.associations();
    await original.detach();

    // Simulate the prior application stopping for exit while holding a durable
    // continuation bundle, then restore with the same never-dispatch config.
    const manifestPath = join(started.root, "execution.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    const persistedTask = manifest.tasks[0] as Record<string, any>;
    persistedTask.state = "stopped_for_application_exit";
    persistedTask.bundle = {
      version: 1,
      operationId: "op-restored",
      waveId: "wave-restored",
      taskId: persistedTask.taskId,
      waveRoot: join(root, "wave-restored"),
      expectedRevision: 1,
    };
    manifest.integritySha256 = createHash("sha256").update(JSON.stringify({ ...manifest, integritySha256: undefined })).digest("hex");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const restored = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    await restored.restore(associations);
    const before = restored.inspect(started.executionId).tasks[0]!;
    assert.equal(before.state, "queued");
    assert.ok(before.pendingContinuation, "restore should auto-queue the durable continuation");
    const queuedContinue = before.commands.find((command) => command.action === "continue");
    assert.ok(queuedContinue, "restore should record the auto-queued continue command");
    assert.equal(queuedContinue!.status, "queued");

    await restored.interrupt({
      executionId: started.executionId,
      taskId: started.tasks[0]!.taskId,
      mode: "interrupt_as_failure",
      instructionId: "interrupt-restored-continuation",
      actor: "user",
    });

    const after = restored.inspect(started.executionId).tasks[0]!;
    assert.equal(after.state, "interrupted");
    assert.equal(after.pendingContinuation, undefined, "pendingContinuation must be cleared once the continuation can never dispatch");
    assert.equal(after.executorEntryId, undefined);
    const failedContinue = after.commands.find((command) => command.action === "continue");
    assert.equal(failedContinue!.status, "failed");
    assert.match(failedContinue!.error!, /interrupted before the queued continuation was dispatched/);
    assert.ok(after.activity.some((event) => event.phase === "continue" && /queued continuation instruction\(s\) failed/.test(event.message)));
    await assert.rejects(readFile(join(root, "executor-ran.txt"), "utf8"), /ENOENT/, "no continuation executor may launch");

    const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    const persistedAfter = persisted.tasks[0] as Record<string, any>;
    assert.equal(persistedAfter.state, "interrupted");
    assert.equal(persistedAfter.pendingContinuation, undefined);
    const persistedCommand = persistedAfter.commands.find((command: Record<string, any>) => command.action === "continue");
    assert.equal(persistedCommand.status, "failed");
    assert.match(persistedCommand.error, /interrupted before the queued continuation was dispatched/);

    await restored.shutdown();
  } finally {
    if (executionRoot) await rm(executionRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupt before executor startup terminalizes an ordinary queued continue command", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-queued-continue-"));
  let executionRoot: string | undefined;
  try {
    const executor = join(root, "executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{fs.writeFileSync('executor-ran.txt','launched\\n');console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "queued-continue-fake",
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: { activeExecutor: { source: "external", id: "queued-continue-fake" }, maxWorkers: 1 },
    });
    config.execution!.maxWorkers = 0;
    const controller = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    const started = await controller.start([{ title: "queued continue", instructions: "original work", acceptanceCriteria: ["done"] }]);
    executionRoot = started.root;
    const taskId = started.tasks[0]!.taskId;
    assert.equal(controller.inspect(started.executionId).tasks[0]!.state, "queued");

    // Attach a durable continuation bundle so a later user continue has a
    // checkpoint to reattach to; nothing is dispatched because maxWorkers is 0.
    const bundle = { version: 1 as const, operationId: "op-queued", waveId: "wave-queued", taskId, waveRoot: join(root, "wave-queued"), expectedRevision: 1 };
    (controller as unknown as { groups: Map<string, BackgroundExecutionGroup> }).groups.get(started.executionId)!.tasks[0]!.bundle = bundle;

    await controller.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_as_failure",
      instructionId: "interrupt-initial",
      actor: "user",
    });
    const queued = await controller.continueTask({
      executionId: started.executionId,
      taskId,
      bundle,
      instructions: "retry from checkpoint",
      instructionId: "continue-queued",
      actor: "user",
    });
    const before = queued.tasks[0]!;
    assert.equal(before.state, "queued");
    assert.ok(before.pendingContinuation);
    assert.equal(before.commands.find((command) => command.instructionId === "continue-queued")!.status, "queued");

    // pump() suspends while resolving the continuation route. Interrupt in that
    // window, before launch() has registered a runtime, so the scheduler must
    // discard its stale selection instead of launching a fresh run.
    config.execution!.maxWorkers = 1;
    const internals = controller as unknown as {
      pump: () => Promise<void>;
      runtimes: Map<string, unknown>;
    };
    const pumpPromise = internals.pump();
    await controller.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_with_merge",
      instructionId: "interrupt-queued-continue",
      actor: "user",
    });
    await pumpPromise;
    assert.equal(internals.runtimes.has(taskId), false, "an interrupted scheduler selection must not launch");

    const after = controller.inspect(started.executionId).tasks[0]!;
    assert.equal(after.state, "interrupted");
    assert.equal(after.pendingContinuation, undefined);
    const failedContinue = after.commands.find((command) => command.instructionId === "continue-queued");
    assert.equal(failedContinue!.status, "failed");
    assert.match(failedContinue!.error!, /interrupted before the queued continuation was dispatched/);
    await assert.rejects(readFile(join(root, "executor-ran.txt"), "utf8"), /ENOENT/, "no continuation executor may launch");

    const persisted = JSON.parse(await readFile(join(started.root, "execution.json"), "utf8")) as Record<string, any>;
    const persistedAfter = persisted.tasks[0] as Record<string, any>;
    assert.equal(persistedAfter.state, "interrupted");
    assert.equal(persistedAfter.pendingContinuation, undefined);
    const persistedCommand = persistedAfter.commands.find((command: Record<string, any>) => command.instructionId === "continue-queued");
    assert.equal(persistedCommand.status, "failed");
    assert.match(persistedCommand.error, /interrupted before the queued continuation was dispatched/);

    await controller.shutdown();
  } finally {
    if (executionRoot) await rm(executionRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("launch rejection cleanup terminalizes undelivered queued continuations and clears pendingContinuation", async () => {
  const scenario = await setupFaultScenario({});
  const { controller, started, messages } = scenario;
  try {
    await waitFor(() => controller.inspect(started.executionId).tasks[0]?.state === "landed");
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      handleLaunchRejection: (group: BackgroundExecutionGroup, task: BackgroundTaskRecord, error: unknown) => Promise<void>;
    };
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    const readPersistedTask = async (): Promise<Record<string, any>> => {
      const manifest = JSON.parse(await readFile(join(started.root, "execution.json"), "utf8")) as Record<string, any>;
      const entry = manifest.tasks[0] as Record<string, any>;
      if (entry.archived === true) {
        const archive = JSON.parse(await readFile(join(started.root, entry.archivePath), "utf8")) as Record<string, any>;
        return { state: entry.state, ...archive.task };
      }
      return entry;
    };
    const executorEntryIdBeforeCleanup = task.executorEntryId;
    const fabricateQueuedContinuation = (instructionId: string) => {
      task.state = "queued";
      task.interruptionMode = undefined;
      task.pendingContinuation = { instructions: "retry from checkpoint", instructionId };
      task.commands.push({
        instructionId,
        action: "continue",
        actor: "user",
        text: "retry from checkpoint",
        status: "queued",
        createdAt: new Date().toISOString(),
      });
      return task.commands.find((command) => command.instructionId === instructionId)!;
    };

    let command = fabricateQueuedContinuation("continue-failed-branch");
    await internals.handleLaunchRejection(group, task, new Error("continuation startup rejection"));
    assert.equal(task.state, "failed");
    assert.equal(task.pendingContinuation, undefined);
    assert.equal(command.status, "failed");
    assert.match(command.error!, /Task failed before the queued continuation was dispatched/);
    let persisted = await readPersistedTask();
    assert.equal(persisted.state, "failed");
    assert.equal(persisted.pendingContinuation, undefined);
    let persistedCommand = persisted.commands.find((entry: Record<string, any>) => entry.instructionId === "continue-failed-branch");
    assert.equal(persistedCommand.status, "failed");
    assert.match(persistedCommand.error, /Task failed before the queued continuation was dispatched/);

    command = fabricateQueuedContinuation("continue-interrupted-branch");
    task.interruptionMode = "interrupt_as_failure";
    await internals.handleLaunchRejection(group, task, new Error("post-interrupt startup rejection"));
    assert.equal(task.state, "interrupted");
    assert.equal(task.pendingContinuation, undefined);
    assert.equal(command.status, "failed");
    assert.match(command.error!, /Task was interrupted before the queued continuation was dispatched/);
    assert.ok(messages.some((message) => /queued continuation instruction\(s\) failed/.test(message)));
    persisted = await readPersistedTask();
    assert.equal(persisted.state, "interrupted");
    assert.equal(persisted.pendingContinuation, undefined);
    persistedCommand = persisted.commands.find((entry: Record<string, any>) => entry.instructionId === "continue-interrupted-branch");
    assert.equal(persistedCommand.status, "failed");
    assert.match(persistedCommand.error, /Task was interrupted before the queued continuation was dispatched/);

    // A terminal outcome must still be preserved while the undelivered
    // continuation is durably terminalized rather than left queued. The landed
    // task is durably archived, so the persisted truth lives in its archive.
    command = fabricateQueuedContinuation("continue-preserved-branch");
    task.state = "landed";
    await internals.handleLaunchRejection(group, task, new Error("post-terminal bookkeeping rejection"));
    assert.equal(task.state, "landed");
    assert.equal(task.pendingContinuation, undefined);
    assert.equal(command.status, "failed");
    assert.match(command.error!, /terminal outcome is preserved/);
    persisted = await readPersistedTask();
    assert.equal(persisted.state, "landed");
    assert.equal(persisted.pendingContinuation, undefined);
    persistedCommand = persisted.commands.find((entry: Record<string, any>) => entry.instructionId === "continue-preserved-branch");
    assert.equal(persistedCommand.status, "failed");
    assert.match(persistedCommand.error, /terminal outcome is preserved/);

    // No continuation executor launch occurred during any cleanup branch: the
    // runtime registry stays empty and no worker slot was ever taken.
    const internalsAfter = controller as unknown as { runtimes: Map<string, unknown>; active: number };
    assert.equal(internalsAfter.runtimes.has(task.taskId), false);
    assert.equal(internalsAfter.active, 0);
    assert.equal(task.executorEntryId, executorEntryIdBeforeCleanup);
    await controller.shutdown();
  } finally {
    await scenario.cleanup();
  }
});

test("interrupt during pre-dispatch continuation startup terminalizes the queued continuation with a runtime registered", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-predispatch-interrupt-"));
  let executionRoot: string | undefined;
  try {
    const executor = join(root, "executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{fs.writeFileSync('executor-ran.txt','launched\\n');console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "predispatch-fake",
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: { activeExecutor: { source: "external", id: "predispatch-fake" }, maxWorkers: 1 },
    });
    // Keep the restored task queued until the queued steering instruction that
    // deterministically pauses continuation preprocessing has been injected.
    config.execution!.maxWorkers = 0;
    const original = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    const started = await original.start([{ title: "pre-dispatch continuation", instructions: "original work", acceptanceCriteria: ["done"] }]);
    executionRoot = started.root;
    const associations = original.associations();
    await original.detach();

    const manifestPath = join(started.root, "execution.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    const persistedTask = manifest.tasks[0] as Record<string, any>;
    persistedTask.state = "stopped_for_application_exit";
    persistedTask.bundle = {
      version: 1,
      operationId: "op-predispatch",
      waveId: "wave-predispatch",
      taskId: persistedTask.taskId,
      waveRoot: join(root, "wave-predispatch"),
      expectedRevision: 1,
    };
    manifest.integritySha256 = createHash("sha256").update(JSON.stringify({ ...manifest, integritySha256: undefined })).digest("hex");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    let interruptTriggered = false;
    let interruptSettled: Promise<unknown> | undefined;
    const internalsRef: { current?: {
      groups: Map<string, BackgroundExecutionGroup>;
      runtimes: Map<string, unknown>;
      pump: () => Promise<void>;
    } } = { current: undefined };
    const controller = new BackgroundExecutionController({
      pi: {},
      config,
      state: createState(),
      cwd: () => root,
      faults: {
        save: async (context) => {
          const internals = internalsRef.current;
          const task = internals?.groups.get(started.executionId)?.tasks[0];
          if (
            !internals
            || interruptTriggered
            || !task?.pendingContinuation
            || !(context.taskStates ?? []).includes("queued")
            || !task.commands.some((command) => command.instructionId === "steer-pre-dispatch" && command.status === "acknowledged")
          ) {
            return;
          }
          interruptTriggered = true;
          // launch() registers the runtime synchronously right after the runner
          // suspends on this save; yield once so the runtime is observable.
          for (let i = 0; i < 200 && !internals.runtimes.has(task.taskId); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          if (!internals.runtimes.has(task.taskId)) return;
          // Do not await here (the hook is inside a save that interrupt()'s own
          // save chains behind); interrupt()'s synchronous prefix fails the queued
          // continuation and clears pendingContinuation before any await. The test
          // awaits the promise so every durable write has landed before reading disk.
          interruptSettled = controller.interrupt({
            executionId: started.executionId,
            taskId: task.taskId,
            mode: "interrupt_as_failure",
            instructionId: "interrupt-pre-dispatch",
            actor: "user",
          });
        },
      },
    });
    await controller.restore(associations);
    const internals = internalsRef.current = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      runtimes: Map<string, unknown>;
      pump: () => Promise<void>;
    };
    const task = internals.groups.get(started.executionId)!.tasks[0]!;
    const taskId = task.taskId;
    assert.equal(task.state, "queued");
    assert.ok(task.pendingContinuation);
    // A queued steering instruction forces continuation preprocessing through an
    // awaited durable save while the runtime is registered but the continue
    // command is still queued — the pre-dispatch window under test.
    task.commands.push({
      instructionId: "steer-pre-dispatch",
      action: "steer",
      actor: "user",
      text: "hold the dispatcher here",
      status: "queued",
      createdAt: new Date().toISOString(),
    });
    config.execution!.maxWorkers = 1;
    void internals.pump();

    await waitFor(() => interruptSettled !== undefined);
    // interrupt() resolves only after handleLaunchRejection's save and its own
    // final save, so the persisted manifest below is guaranteed to be current.
    await interruptSettled;
    const after = controller.inspect(started.executionId, taskId).tasks[0]!;
    assert.equal(after.state, "interrupted");
    assert.equal(after.pendingContinuation, undefined);
    const failedContinue = after.commands.find((command) => command.action === "continue");
    assert.equal(failedContinue!.status, "failed");
    assert.match(failedContinue!.error!, /interrupted before the queued continuation was dispatched/);
    // Already-incorporated steering keeps its acknowledged reality.
    assert.equal(after.commands.find((command) => command.instructionId === "steer-pre-dispatch")!.status, "acknowledged");
    await assert.rejects(readFile(join(root, "executor-ran.txt"), "utf8"), /ENOENT/, "no continuation executor may launch");

    const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    const persistedAfter = persisted.tasks[0] as Record<string, any>;
    assert.equal(persistedAfter.state, "interrupted");
    assert.equal(persistedAfter.pendingContinuation, undefined);
    const persistedCommand = persistedAfter.commands.find((command: Record<string, any>) => command.action === "continue");
    assert.equal(persistedCommand.status, "failed");
    assert.match(persistedCommand.error, /interrupted before the queued continuation was dispatched/);

    await controller.shutdown();
  } finally {
    if (executionRoot) await rm(executionRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("force-merge publish and wake failures after landing are recorded durably", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-force-merge-publish-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
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
      externalAgents: [{
        id: "slow",
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: { activeExecutor: { source: "external", id: "slow" }, maxWorkers: 1 },
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
      externalAgents: [{
        id: "tail-fake",
        adapter: "run-as-binary",
        command: join(root, "unused-executor.cjs"),
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: { activeExecutor: { source: "external", id: "tail-fake" }, maxWorkers: 1 },
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
      externalAgents: [{
        id: "tail-fail-fake",
        adapter: "run-as-binary",
        command: join(root, "unused-executor.cjs"),
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: { activeExecutor: { source: "external", id: "tail-fail-fake" }, maxWorkers: 1 },
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
      externalAgents: [{
        id: "tail-detach-fake",
        adapter: "run-as-binary",
        command: join(root, "unused-executor.cjs"),
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: { activeExecutor: { source: "external", id: "tail-detach-fake" }, maxWorkers: 1 },
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

async function setupInterruptedMergeTask(unique: string): Promise<{
  root: string;
  controller: BackgroundExecutionController;
  started: BackgroundInspection;
  taskId: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pi-review-background-merge-${unique}-`));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "base.txt"), "base\n", "utf8");
  await execFileAsync("git", ["add", "base.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
  const executor = join(root, "merge-executor.cjs");
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
    externalAgents: [{
      id: "slow-merge",
      adapter: "run-as-binary",
      command: executor,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: { activeExecutor: { source: "external", id: "slow-merge" }, maxWorkers: 1 },
    retainBundles: "always",
  });
  const controller = new BackgroundExecutionController({ config, state: createState(), cwd: () => root, pi: {} });
  const started = await controller.start([{
    title: "merge target",
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
  const interrupted = await controller.interrupt({
    executionId: started.executionId,
    taskId,
    mode: "interrupt_as_failure",
    instructionId: `setup-interrupt-${unique}`,
    actor: "user",
  });
  assert.equal(interrupted.tasks[0]?.state, "interrupted");
  return {
    root,
    controller,
    started,
    taskId,
    cleanup: async () => {
      await controller.shutdown().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function setupFaultScenario(faults: BackgroundFaultHooks): Promise<{
  root: string;
  controller: BackgroundExecutionController;
  started: BackgroundInspection;
  messages: string[];
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-fault-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "base.txt"), "base\n", "utf8");
  await execFileAsync("git", ["add", "base.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
  const executor = join(root, "fault-executor.cjs");
  await writeFile(executor, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    "fs.writeFileSync('fault.txt','landed before bookkeeping failure\\n');",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
    "});",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fault-fake",
      adapter: "run-as-binary",
      command: executor,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: { activeExecutor: { source: "external", id: "fault-fake" }, maxWorkers: 1 },
    retainBundles: "always",
  });
  const messages: string[] = [];
  const controller = new BackgroundExecutionController({
    pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
    config,
    state: createState(),
    cwd: () => root,
    notify: (message) => {
      messages.push(message);
    },
    faults,
  });
  const started = await controller.start([{
    title: "fault scenario",
    instructions: "LAND_SENTINEL",
    acceptanceCriteria: ["fault.txt exists"],
  }]);
  return {
    root,
    controller,
    started,
    messages,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

// ── Finding 15: bounded execution persistence and top-off scaling ──────────

/** Controller harness for bounded-scaling tests: an executor route exists but
 *  maxWorkers is 0, so nothing is ever dispatched and settlement is injected
 *  deterministically. */
function boundedScalingConfig() {
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "unstarted",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] },
    }],
    execution: {
      activeExecutor: { source: "external", id: "unstarted" },
      maxWorkers: 1,
    },
    retainBundles: "always",
  });
  // Nothing may ever dispatch in these tests: settlement is injected directly.
  config.execution!.maxWorkers = 0;
  return config;
}

function controllerInternals(controller: BackgroundExecutionController): {
  groups: Map<string, BackgroundExecutionGroup>;
  activeTasks: Map<string, unknown>;
  archivedTasks: Map<string, unknown>;
  save: (group: BackgroundExecutionGroup) => Promise<unknown>;
  wake: (task: BackgroundTaskRecord, kind: "completion" | "failure" | "state", content: string) => Promise<void>;
} {
  return controller as unknown as {
    groups: Map<string, BackgroundExecutionGroup>;
    activeTasks: Map<string, unknown>;
    archivedTasks: Map<string, unknown>;
    save: (group: BackgroundExecutionGroup) => Promise<unknown>;
    wake: (task: BackgroundTaskRecord, kind: "completion" | "failure" | "state", content: string) => Promise<void>;
  };
}

/** Settles the oldest unsettled task directly and saves the group. */
async function settleOldestUnsettled(
  controller: BackgroundExecutionController,
  executionId: string,
  label: string,
): Promise<BackgroundTaskRecord> {
  const internals = controllerInternals(controller);
  const group = internals.groups.get(executionId)!;
  const target = group.tasks.find((task) => !isArchivableTaskState(task.state));
  assert.ok(target, "an unsettled task is available to settle");
  transitionTaskState(target, "landed");
  target.summary = `settled outcome ${label}`;
  await internals.save(group);
  return target;
}

test("unsettled task admission is capped per execution while sequential settled top-offs continue", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-cap-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    controller = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    const cap = MAX_UNSETTLED_TASKS_PER_EXECUTION;
    const definitions = Array.from({ length: cap }, (_unused, index) => ({
      title: `task ${index}`,
      instructions: "bounded work",
      acceptanceCriteria: ["done"],
    }));
    const started = await controller.start(definitions);
    assert.equal(started.historicalCount, cap);
    assert.equal(started.tasks.length, cap);

    // Fail closed at the cap with a clear, actionable error and no partial state.
    await assert.rejects(
      () => controller!.add(started.executionId, [{ title: "over cap", instructions: "work", acceptanceCriteria: ["done"] }]),
      (error: Error) => /at most \d+ unsettled tasks are admitted per execution/.test(error.message)
        && error.message.includes(started.executionId),
    );
    assert.equal(controller.inspect(started.executionId).tasks.length, cap);
    await assert.rejects(
      () => controller!.start([{ title: "over cap start", instructions: "work", acceptanceCriteria: ["done"] }, ...definitions]),
      /At most \d+ unsettled tasks are admitted per execution/,
    );
    assert.throws(() => controller!.inspect("exec-never-created"), /Unknown execution group/);

    // Sequential top-offs after settlement remain supported without limit.
    const group = controllerInternals(controller).groups.get(started.executionId)!;
    const oldest = group.tasks[0]!;
    transitionTaskState(oldest, "landed");
    oldest.summary = "settled to free admission capacity";
    await controllerInternals(controller).save(group);
    const toppedOff = await controller.add(started.executionId, [{
      title: "after settle",
      instructions: "work",
      acceptanceCriteria: ["done"],
    }]);
    // The settled record stays inline within the bounded window; the admission
    // cap counts only the unsettled (128) tasks, all of which remain queued
    // for dispatch in this harness (maxWorkers 0).
    assert.equal(toppedOff.tasks.length, cap + 1);
    assert.equal(toppedOff.historicalCount, cap + 1);
    assert.equal(toppedOff.archivedCount, 0);
    assert.equal(controller.inspect(started.executionId).scheduling.globallyDispatchPending, cap);
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
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
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
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

test("archived-task reactivation and recovery adoption enforce the unsettled admission cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-cap-continue-"));
  let controller: BackgroundExecutionController | undefined;
  const ownedRoots = new Set<string>();
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    controller = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    const cap = MAX_UNSETTLED_TASKS_PER_EXECUTION;
    const started = await controller.start(Array.from({ length: cap }, (_unused, index) => ({
      title: `task ${index}`,
      instructions: "bounded work",
      acceptanceCriteria: ["done"],
    })));
    ownedRoots.add(started.root);
    const evictedTaskId = started.tasks[0]!.taskId;
    // Give the task a durable continuation bundle so it stays continuable
    // after eviction, exactly like a real landing.
    const waveRootDir = await realpath(await mkdtemp(join(tmpdir(), "wave-cap-continue-")));
    ownedRoots.add(waveRootDir);
    const internals = controllerInternals(controller);
    const firstGroup = internals.groups.get(started.executionId)!;
    const firstTask = firstGroup.tasks[0]!;
    firstTask.bundle = {
      version: 1,
      operationId: "op-cap-continue",
      waveId: "wave-cap-continue",
      taskId: firstTask.taskId,
      waveRoot: waveRootDir,
      expectedRevision: 1,
    };
    firstTask.waveRoot = waveRootDir;
    // 40 settlements: 8 evicted archives, 32 inline settled, 88 unsettled.
    for (let index = 0; index < 40; index += 1) {
      await settleOldestUnsettled(controller!, started.executionId, `settle ${index + 1}`);
    }
    // Fill the unsettled population to exactly the cap.
    await controller.add(started.executionId, Array.from({ length: 40 }, (_unused, index) => ({
      title: `top-off ${index + 1}`,
      instructions: "work",
      acceptanceCriteria: ["done"],
    })));
    assert.equal(controller.inspect(started.executionId).archivedCount, 8);

    // Reactivating an archived task is admission-capped like SubtasksAdd.
    await assert.rejects(
      () => controller!.continueTask({
        executionId: started.executionId,
        taskId: evictedTaskId,
        instructions: "resume",
        instructionId: "cap-probe",
        actor: "user",
      }),
      (error: Error) => /at most \d+ unsettled tasks are admitted per execution/.test(error.message)
        && error.message.includes(started.executionId),
    );
    // Settling one task frees exactly one slot: the same continuation succeeds.
    await settleOldestUnsettled(controller, started.executionId, "free one slot");
    const continued = await controller.continueTask({
      executionId: started.executionId,
      taskId: evictedTaskId,
      instructions: "resume",
      instructionId: "cap-probe-2",
      actor: "user",
    });
    assert.equal(continued.tasks[0]!.state, "queued");
    assert.equal(controller.inspect(started.executionId).archivedCount, 8);
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
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
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

test("continuing an inline settled task is capped like archive reactivation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-cap-inline-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    controller = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    const cap = MAX_UNSETTLED_TASKS_PER_EXECUTION;
    const started = await controller.start(Array.from({ length: cap }, (_unused, index) => ({
      title: `task ${index}`,
      instructions: "bounded work",
      acceptanceCriteria: ["done"],
    })));
    const internals = controllerInternals(controller);
    const group = internals.groups.get(started.executionId)!;
    // The NEWEST settled task stays inline (within the bounded window) — it is
    // the inline settled continuation case.
    const inlineSettled = group.tasks[32]!;
    inlineSettled.bundle = {
      version: 1,
      operationId: "op-inline-cap",
      waveId: "wave-inline-cap",
      taskId: inlineSettled.taskId,
      waveRoot: join(tmpdir(), "wave-inline-cap-unused"),
      expectedRevision: 1,
    };
    for (let index = 0; index < 33; index += 1) {
      await settleOldestUnsettled(controller, started.executionId, `settle ${index + 1}`);
    }
    // 32 inline settled, 1 archived, 95 unsettled: fill the cap exactly.
    await controller.add(started.executionId, Array.from({ length: 33 }, (_unused, index) => ({
      title: `top-off ${index + 1}`,
      instructions: "work",
      acceptanceCriteria: ["done"],
    })));
    assert.equal(controller.inspect(started.executionId).archivedCount, 1);

    // The settled INLINE task also re-enters the unsettled population when
    // continued: the shared admission cap refuses it at the cap.
    await assert.rejects(
      () => controller!.continueTask({
        executionId: started.executionId,
        taskId: inlineSettled.taskId,
        instructions: "resume",
        instructionId: "inline-cap-probe",
        actor: "user",
      }),
      (error: Error) => /at most \d+ unsettled tasks are admitted per execution/.test(error.message)
        && error.message.includes(started.executionId),
    );
    // Rejected continuation leaves inline state and aggregates untouched.
    const inspection = controller.inspect(started.executionId);
    assert.equal(inspection.archivedCount, 1);
    const stillInline = inspection.tasks.find((task) => task.taskId === inlineSettled.taskId);
    assert.equal(stillInline?.state, "landed");
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a bundle-less archived continuation leaves counts and inline state unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-bundleless-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
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
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
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

test("widget and dispatch traverse the controller-wide active index, not settled history", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-active-index-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    controller = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    const startedA = await controller.start([
      { title: "a1", instructions: "work", acceptanceCriteria: ["done"] },
      { title: "a2", instructions: "work", acceptanceCriteria: ["done"] },
      { title: "a3", instructions: "work", acceptanceCriteria: ["done"] },
    ]);
    const startedB = await controller.start([
      { title: "b1", instructions: "work", acceptanceCriteria: ["done"] },
      { title: "b2", instructions: "work", acceptanceCriteria: ["done"] },
    ]);
    const internals = controllerInternals(controller);
    const activeCount = () => internals.activeTasks.size;
    assert.equal(activeCount(), 5, "both groups' live tasks are indexed");
    assert.equal(controller.inspect(startedA.executionId).scheduling.globallyDispatchPending, 5);
    // Readiness checks read the same index.
    assert.equal(controller.reviewReadiness().length, 5);
    assert.ok(controller.reviewReadiness().every((task) => task.state === "queued"));

    // Settle two of A's tasks: the index drops them without touching B's.
    await settleOldestUnsettled(controller, startedA.executionId, "a1");
    await settleOldestUnsettled(controller, startedA.executionId, "a2");
    assert.equal(activeCount(), 3);
    assert.equal(controller.inspect(startedA.executionId).scheduling.globallyDispatchPending, 3);
    assert.equal(controller.inspect(startedA.executionId).scheduling.dispatchPending, 1);
    assert.equal(controller.inspect(startedB.executionId).scheduling.dispatchPending, 2);
    const readiness = controller.reviewReadiness();
    assert.equal(readiness.length, 3);
    assert.equal(readiness.filter((task) => task.executionId === startedA.executionId).length, 1);
    assert.equal(readiness.filter((task) => task.executionId === startedB.executionId).length, 2);
    assert.ok(readiness.every((task) => task.taskId !== startedA.tasks[0]!.taskId));

    // Widget rendering reads the same index: three active across both groups.
    const widgetContents: unknown[] = [];
    const widgetCtx = { ui: { setWidget: (_name: string, content: unknown) => { widgetContents.push(content); } } };
    await controller.toggleExpandedView(widgetCtx);
    const expandedComponent = widgetContents.at(-1) as () => { render(width: number): string[]; invalidate(): void };
    const rendered = expandedComponent().render(240);
    assert.ok(rendered[0]!.includes("3 active background subtasks"));

    // Settle everything, including across groups: the index empties and the
    // compact widget clears.
    await settleOldestUnsettled(controller, startedA.executionId, "a3");
    await settleOldestUnsettled(controller, startedB.executionId, "b1");
    await settleOldestUnsettled(controller, startedB.executionId, "b2");
    assert.equal(activeCount(), 0, "the active index reaches zero after settlement");
    assert.equal(controller.inspect(startedA.executionId).scheduling.globallyDispatchPending, 0);
    assert.deepEqual(controller.reviewReadiness(), []);
    widgetContents.length = 0;
    controller.setUiContext(widgetCtx);
    // The expanded view (toggled above) always renders; with an empty active
    // index it must report zero active tasks rather than settled history.
    const clearedComponent = widgetContents.at(-1) as () => { render(width: number): string[]; invalidate(): void };
    const cleared = clearedComponent().render(240);
    assert.ok(cleared[0]!.includes("0 active background subtasks"));
    assert.ok(cleared.some((line: string) => line.includes("No active background subtasks.")));
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("archive-reuse metadata for a save comes only from that group's bounded inline tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-prior-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
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
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
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

async function waitForLandedDurableRecord(
  started: BackgroundInspection,
  requiredPhase: string,
): Promise<void> {
  await waitForAsync(async () => {
    try {
      const archive = JSON.parse(
        await readFile(join(started.root, "tasks", `${started.tasks[0]?.taskId}.json`), "utf8"),
      ) as {
        task: { state: string; activity?: Array<{ phase: string; message: string }> };
      };
      if (archive.task?.state !== "landed") return false;
      return archive.task.activity?.some((event) => event.phase === requiredPhase && /landed outcome is preserved/.test(event.message)) === true;
    } catch {
      return false;
    }
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("timed out waiting for background task state");
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("timed out waiting for asynchronous background task state");
}

function collidingTaskRecord(taskId: string, createdAt: string, updatedAt: string, summary: string): BackgroundTaskRecord {
  return {
    taskId,
    definition: { title: "colliding archived task", instructions: "shared work", acceptanceCriteria: ["done"] },
    state: "landed",
    createdAt,
    updatedAt,
    generation: 0,
    summary,
    activity: [],
    nextActivitySequence: 1,
    stateHistory: [{ sequence: 1, state: "queued", at: createdAt, generation: 0 }],
    nextStateSequence: 2,
    commands: [],
  };
}

async function writePersistedExecutionGroupTasks(
  groupRoot: string,
  groupCwd: string,
  executionId: string,
  tasks: BackgroundTaskRecord[],
): Promise<void> {
  const payloads = tasks.map((task) => {
    const archiveUnsigned = {
      version: 1 as const,
      taskId: task.taskId,
      archivedAt: task.updatedAt,
      task,
    };
    const archiveIntegritySha256 = createHash("sha256").update(JSON.stringify(archiveUnsigned)).digest("hex");
    return {
      archiveUnsigned,
      archiveIntegritySha256,
      reference: {
        archived: true,
        taskId: task.taskId,
        title: task.definition.title,
        state: task.state as "landed",
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        summary: task.summary,
        timing: { queueMs: 1, captureMs: 0, executionMs: 0, reviewMs: 0, landingMs: 0, totalMs: 0 },
        archivePath: join("tasks", `${task.taskId}.json`),
        archiveIntegritySha256,
      },
    };
  });
  const unsigned = {
    version: 2 as const,
    revision: 0,
    executionId,
    kind: "execute" as const,
    root: groupRoot,
    cwd: groupCwd,
    createdAt: tasks[0]!.createdAt,
    updatedAt: tasks.at(-1)!.updatedAt,
    peakConcurrency: 1,
    tasks: payloads.map((payload) => payload.reference),
  };
  const snapshot = { ...unsigned, integritySha256: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") };
  await mkdir(join(groupRoot, "tasks"), { recursive: true });
  for (const payload of payloads) {
    await writeFile(
      join(groupRoot, "tasks", `${payload.reference.taskId}.json`),
      `${JSON.stringify({ ...payload.archiveUnsigned, integritySha256: payload.archiveIntegritySha256 }, null, 2)}\n`,
      "utf8",
    );
  }
  await writeFile(join(groupRoot, "execution.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

async function writePersistedExecutionGroup(
  groupRoot: string,
  groupCwd: string,
  executionId: string,
  task: BackgroundTaskRecord,
): Promise<void> {
  await writePersistedExecutionGroupTasks(groupRoot, groupCwd, executionId, [task]);
}

function renderWidget(content: unknown, width = 240): string[] {
  assert.equal(typeof content, "function");
  const component = (content as () => { render(width: number): string[] })();
  return component.render(width);
}

const WAKE_FAILURE_SECRET_SENTINEL = "WAKE_FAILURE_SECRET_SENTINEL_9f2b";
const WAKE_FAILURE_ERROR_SENTINEL = "WAKE_FAILURE_ERROR_SENTINEL_start";

/** Harness with a deliberately unresponsive executor so task state can be injected deterministically. */
async function setupBlockingFailureHarness(options: { notifications: "quiet" | "noisy" }): Promise<{
  root: string;
  controller: BackgroundExecutionController;
  started: BackgroundInspection;
  messages: string[];
  sentMessages: Array<{ content: string; details?: { diagnostic?: unknown } }>;
  internals: {
    groups: Map<string, BackgroundExecutionGroup>;
    handleLaunchRejection: (group: BackgroundExecutionGroup, task: BackgroundTaskRecord, error: unknown) => Promise<void>;
    wake: (task: BackgroundTaskRecord, kind: "completion" | "failure" | "state", content: string, eventSnapshot?: unknown) => Promise<void>;
    conflictGate?: unknown;
  };
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-wake-diag-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
    const executor = join(root, "blocking-executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "blocking-fake",
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: {
        activeExecutor: { source: "external", id: "blocking-fake" },
        maxWorkers: 1,
        subtaskNotifications: options.notifications,
      },
      retainBundles: "always",
    });
    const messages: string[] = [];
    const sentMessages: Array<{ content: string; details?: { diagnostic?: unknown } }> = [];
    controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string; details?: { diagnostic?: unknown } }) => {
        messages.push(message.content);
        sentMessages.push(message);
      } },
      config,
      state: createState(),
      cwd: () => root,
      notify: (message) => {
        messages.push(message);
      },
    });
    const started = await controller.start([{
      title: "wake diagnostic target",
      instructions: "write draft.txt",
      acceptanceCriteria: ["draft.txt exists"],
    }]);
    await waitFor(() => controller!.inspect(started.executionId).tasks[0]?.state === "running", 30_000);
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      handleLaunchRejection: (group: BackgroundExecutionGroup, task: BackgroundTaskRecord, error: unknown) => Promise<void>;
      wake: (task: BackgroundTaskRecord, kind: "completion" | "failure" | "state", content: string, eventSnapshot?: unknown) => Promise<void>;
      conflictGate?: unknown;
    };
    return {
      root,
      controller,
      started,
      messages,
      sentMessages,
      internals,
      cleanup: async () => {
        await controller?.shutdown().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function injectAdversarialTaskData(root: string, group: BackgroundExecutionGroup, task: BackgroundTaskRecord): void {
  const now = new Date().toISOString();
  task.bundle = {
    version: 1,
    operationId: "op-wake-diagnostic",
    waveId: "wave-wake-diagnostic",
    taskId: task.taskId,
    waveRoot: join(root, "wave-root"),
    expectedRevision: group.revision,
  };
  task.executorEntryId = `entry-${"x".repeat(5_000)}`;
  task.definition = {
    title: "t".repeat(5_000),
    instructions: WAKE_FAILURE_SECRET_SENTINEL.repeat(500),
    acceptanceCriteria: [WAKE_FAILURE_SECRET_SENTINEL.repeat(400)],
  } as unknown as BackgroundTaskRecord["definition"];
  task.summary = "s".repeat(90_000);
  task.error = `e${"e".repeat(90_000)} ${WAKE_FAILURE_SECRET_SENTINEL} ${"x".repeat(90_000)}`;
  task.result = { taskResults: [{ summary: WAKE_FAILURE_SECRET_SENTINEL.repeat(2_000) }] } as unknown as BackgroundTaskRecord["result"];
  task.commands = Array.from({ length: 60 }, (_unused, index) => ({
    instructionId: `steer-${index}`,
    action: "steer" as const,
    actor: "model" as const,
    text: WAKE_FAILURE_SECRET_SENTINEL.repeat(300),
    status: "queued" as const,
    createdAt: now,
  }));
  task.activity = Array.from({ length: 60 }, (_unused, index) => ({
    sequence: index + 1,
    at: now,
    // The last injected event survives the recent-activity window, so its
    // adversarial phase exercises the phase bound deterministically.
    phase: index === 59 ? "ph".repeat(5_000) : "executor",
    message: "a".repeat(2_000),
  }));
}

test("wake failure diagnostics are curated, bounded, and exclude secret task and command content", async () => {
  const scenario = await setupBlockingFailureHarness({ notifications: "noisy" });
  const { controller, started, messages, internals, cleanup } = scenario;
  try {
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    injectAdversarialTaskData(scenario.root, group, task);
    internals.conflictGate = {
      executionId: group.executionId,
      taskId: task.taskId,
      sourceRoot: scenario.root,
      paths: [...Array.from({ length: 24 }, (_unused, index) => `conflict-${index}-${"p".repeat(400)}`), "conflict-final.txt"],
      activatedAt: new Date().toISOString(),
      manifestPath: join(scenario.root, "conflict-manifest.json"),
      reason: `Forced task ${task.taskId} materialized conflicts.`,
    };
    const jsonEscapeTail = "\u0000".repeat(80_000);
    await internals.handleLaunchRejection(group, task, new Error(`${WAKE_FAILURE_ERROR_SENTINEL} worker exploded: ${jsonEscapeTail}`));

    const failureMessages = messages.filter((message) => message.includes("Failure recovery diagnostic"));
    assert.equal(failureMessages.length, 1, "exactly one failure wake with a curated diagnostic");
    const failureMessage = failureMessages[0]!;

    // The failure preamble is dedicated and bounded: no raw unbounded wake
    // content, no task-title or incomplete-task lists from the generic event.
    assert.match(failureMessage, /requires recovery attention at state FAILED/);
    assert.ok(!failureMessage.includes("Tasks not yet landed"), "the incomplete-task list is not part of failure notifications");
    assert.ok(!/t{500}/.test(failureMessage), "the adversarial task title run is truncated away");

    // Secret exclusion: instructions, acceptance criteria, command text, and
    // model output never reach the notification, even at field starts.
    for (const message of messages) {
      assert.ok(!message.includes(WAKE_FAILURE_SECRET_SENTINEL), "the secret sentinel must never appear in any notification");
      assert.ok(!/"instructions":/.test(message), "task instructions must not be serialized");
      assert.ok(!/"acceptanceCriteria":/.test(message), "acceptance criteria must not be serialized");
      assert.ok(!/"commands":/.test(message), "command records must not be serialized");
      assert.ok(!/"result":/.test(message), "model result output must not be serialized");
      assert.ok(!/"definition":/.test(message), "task definitions must not be serialized");
    }

    // The sentinel at the start of the worker error is allowed bounded error
    // content: it survives only inside per-field caps, never as a large run.
    const errorSentinelOccurrences = failureMessage.split(WAKE_FAILURE_ERROR_SENTINEL).length - 1;
    assert.ok(errorSentinelOccurrences >= 1, "the bounded worker error remains actionable");
    assert.ok(errorSentinelOccurrences <= 6, `the error sentinel appears only inside bounded fields, got ${errorSentinelOccurrences}`);
    assert.ok(!failureMessage.includes(jsonEscapeTail.slice(0, 1_000)), "the JSON-escaping error tail is truncated away");

    // Hard size bounds with visible truncation markers.
    assert.ok(failureMessage.length <= 16_100, `the final notification must stay under the cap, got ${failureMessage.length}`);
    const diagnosticJson = failureMessage.slice(failureMessage.indexOf("{", failureMessage.indexOf("Failure recovery diagnostic")));
    assert.ok(diagnosticJson.length <= 7_000, `the serialized diagnostic must stay under the JSON cap, got ${diagnosticJson.length}`);
    assert.ok(failureMessage.includes("…[truncated]"), "bounded fields carry a visible truncation marker");

    // The structured details payload is bounded by construction and identical
    // to the delivered (parseable) JSON text.
    const failureDetails = scenario.sentMessages.find((message) => message.content === failureMessage)?.details;
    assert.ok(failureDetails?.diagnostic, "the structured diagnostic is delivered via sendMessage details");
    const detailsJson = JSON.stringify(failureDetails.diagnostic);
    assert.ok(detailsJson.length <= 7_000, `the structured details diagnostic must stay bounded, got ${detailsJson.length}`);
    assert.ok(!detailsJson.includes(WAKE_FAILURE_SECRET_SENTINEL), "the secret sentinel never reaches the structured details");
    assert.deepEqual(JSON.parse(diagnosticJson), failureDetails.diagnostic, "the delivered JSON is parseable and matches the structured details");
    const detailsDiagnostic = failureDetails.diagnostic as {
      activity: Array<{ phase: string }>;
      recovery: { executorEntryId?: string };
    };
    for (const event of detailsDiagnostic.activity) {
      assert.ok(event.phase.length <= 113, `activity phases are field-bounded, got ${event.phase.length}`);
    }
    assert.ok((detailsDiagnostic.recovery.executorEntryId ?? "").length <= 133, "executorEntryId is field-bounded");

    // Positive controls: stable IDs, state, and recovery handles are present.
    assert.ok(failureMessage.includes(started.executionId), "the execution handle is present");
    assert.ok(failureMessage.includes(task.taskId), "the task handle is present");
    assert.match(failureMessage, /"taskState": "failed"/);
    assert.match(failureMessage, /"hasDurableBundle": true/);
    assert.ok(failureMessage.includes("SubtasksInspect"), "an inspect recovery action is present");
    assert.ok(failureMessage.includes("SubtasksContinue"), "a continue recovery action is present");
    assert.ok(failureMessage.includes("SubtasksForceMerge"), "a force-merge recovery action is present");
    assert.ok(failureMessage.includes("SubtasksInterrupt"), "an interrupt recovery action is present");
    assert.ok(failureMessage.includes("SubtasksMarkClean"), "the conflict-gate recovery action survives independent of the bounded message");
    assert.ok(
      detailsJson.includes("SubtasksMarkClean"),
      "the structured details carry the conflict-gate recovery action",
    );
    assert.ok(failureMessage.includes(join(scenario.root, "wave-root")), "the durable bundle wave root is present");
    assert.ok(failureMessage.includes("conflict-manifest.json"), "the conflict manifest path is present");
    assert.match(failureMessage, /"taskCount": 1/);

    // Bounded activity and conflict paths: counts, not full arrays, and each entry capped.
    const sequenceMatches = diagnosticJson.match(/"sequence":/g) ?? [];
    assert.ok(sequenceMatches.length <= 8, `activity is bounded to the most recent entries, got ${sequenceMatches.length}`);
    const pathMatches = diagnosticJson.match(/"conflict-\d+/g) ?? [];
    assert.ok(pathMatches.length <= 10, `conflict paths are bounded in count, got ${pathMatches.length}`);
  } finally {
    await cleanup();
  }
});

test("conflict-gate failure wakes keep SubtasksMarkClean recovery even when the bounded message truncates it away", async () => {
  const scenario = await setupBlockingFailureHarness({ notifications: "noisy" });
  const { controller, started, messages, internals, cleanup } = scenario;
  try {
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    task.bundle = {
      version: 1,
      operationId: "op-conflict-wake",
      waveId: "wave-conflict-wake",
      taskId: task.taskId,
      waveRoot: join(scenario.root, "wave-root"),
      expectedRevision: group.revision,
    };
    internals.conflictGate = {
      executionId: group.executionId,
      taskId: task.taskId,
      sourceRoot: scenario.root,
      // ~320 chars of fixed prompt prose plus 8 x 70-char paths exceeds the
      // 600-char message budget, so the free-text prompt truncates before the
      // SubtasksMarkClean instruction — exactly the regression scenario.
      paths: Array.from({ length: 8 }, (_unused, index) => `deeply/nested/conflicted/path/number-${index}-of-eight/` + "p".repeat(40)),
      activatedAt: new Date().toISOString(),
      manifestPath: join(scenario.root, "conflict-manifest.json"),
      reason: `Forced task ${task.taskId} materialized conflicts.`,
    };
    const prompt = controller.criticalPrompt()!;
    assert.ok(prompt.includes("SubtasksMarkClean"), "the raw critical prompt names the recovery action");
    assert.ok(prompt.length > 600, "the critical prompt exceeds the message budget so its tail is truncated");
    await internals.wake(task, "failure", prompt);

    const failureMessage = messages.find((message) => message.includes("Failure recovery diagnostic"));
    assert.ok(failureMessage, "the conflict-gate failure wake delivers the curated diagnostic");
    const messageField = failureMessage!.match(/"message": "([^"]*)"/)?.[1] ?? "";
    assert.ok(!messageField.includes("SubtasksMarkClean"), "the prompt tail (and its MarkClean instruction) is truncated out of the message field");
    assert.ok(failureMessage.includes("SubtasksMarkClean"), "the rendered recovery actions still name SubtasksMarkClean");
    const failureDetails = scenario.sentMessages.find((message) => message.content === failureMessage)?.details;
    assert.ok(failureDetails?.diagnostic, "the structured diagnostic is delivered");
    const detailsJson = JSON.stringify(failureDetails.diagnostic);
    assert.ok(detailsJson.includes("SubtasksMarkClean"), "the structured details carry the conflict-gate recovery action");
    assert.ok(detailsJson.length <= 7_000, `the structured details stay bounded, got ${detailsJson.length}`);
    const diagnosticJson = failureMessage!.slice(failureMessage!.indexOf("{", failureMessage!.indexOf("Failure recovery diagnostic")));
    assert.doesNotThrow(() => JSON.parse(diagnosticJson), "the delivered diagnostic stays parseable JSON");
    assert.ok(failureMessage!.includes("conflict-manifest.json"), "the conflict manifest path is present");
  } finally {
    await cleanup();
  }
});

test("quiet and noisy subtask notification modes both retain actionable wake failure recovery information", async () => {
  for (const notifications of ["quiet", "noisy"] as const) {
    const scenario = await setupBlockingFailureHarness({ notifications });
    const { controller, started, messages, internals, cleanup } = scenario;
    try {
      const group = internals.groups.get(started.executionId)!;
      const task = group.tasks[0]!;
      injectAdversarialTaskData(scenario.root, group, task);
      await internals.handleLaunchRejection(group, task, new Error("deterministic synthetic launch failure"));
      const failureMessage = messages.find((message) => message.includes("Failure recovery diagnostic"));
      assert.ok(failureMessage, `the ${notifications} mode delivers the failure notification with the curated diagnostic`);
      assert.ok(!failureMessage!.includes(WAKE_FAILURE_SECRET_SENTINEL), "the sentinel never reaches the notification");
      assert.ok(failureMessage!.includes(started.executionId), "the execution handle survives in both modes");
      assert.ok(failureMessage!.includes(task.taskId), "the task handle survives in both modes");
      assert.match(failureMessage!, /"taskState": "failed"/);
      assert.ok(failureMessage!.includes("SubtasksContinue"), "a continue recovery action survives in both modes");
      assert.ok(failureMessage!.includes("SubtasksInspect"), "an inspect recovery action survives in both modes");
      assert.ok(failureMessage!.length <= 16_100, "the notification stays bounded in both modes");
      const failureDetails = scenario.sentMessages.find((message) => message.content === failureMessage)?.details;
      assert.ok(failureDetails?.diagnostic, "the structured diagnostic is delivered in both modes");
      assert.ok(JSON.stringify(failureDetails.diagnostic).length <= 7_000, "the structured details diagnostic stays bounded in both modes");
    } finally {
      await cleanup();
    }
  }
});

// ── Watch-checkpoint event formatting (controller-owned; finding 14 boundary) ──

const watchConfig = normalizeConfig({
  enabled: true,
  review: { activeReviewers: [] },
  externalAgents: [{
    id: "fake",
    adapter: "run-as-binary",
    command: process.execPath,
    execution: { protocol: "pi-review-executor-jsonl-v1" as const },
  }],
  execution: {
    executorPool: [
      { entryId: "pi-entry", selection: { source: "pi", model: "gpt-x" }, maxConcurrent: 1 },
      { entryId: "external-fake", selection: { source: "external", id: "fake" }, maxConcurrent: 1 },
    ],
  },
});

test("formatWatchEvent renders a bounded checkpoint report for active tasks only", () => {
  const now = Date.now();
  const inspection = {
    executionId: "exec-1",
    kind: "execute",
    revision: 7,
    tasks: [
      {
        taskId: "task-1",
        definition: { title: "Task one" },
        state: "running",
        updatedAt: new Date(now - 5000).toISOString(),
        executorEntryId: "pi-entry",
        activity: [{ sequence: 3, at: new Date(now - 30_000).toISOString(), phase: "executing", message: "progress ".repeat(40) }],
        timing: { queueMs: 1000, captureMs: 2000, executionMs: 90_000, reviewMs: 0, landingMs: 0, totalMs: 93_000 },
        liveControl: { steer: true },
      },
      {
        taskId: "task-2",
        definition: { title: "Landed task" },
        state: "landed",
        updatedAt: new Date(now - 5000).toISOString(),
        activity: [],
        timing: { queueMs: 0, captureMs: 0, executionMs: 0, reviewMs: 0, landingMs: 0, totalMs: 0 },
      },
    ],
  };
  const single = formatWatchEvent([inspection] as unknown as BackgroundInspection[], watchConfig);
  assert.ok(single.startsWith("[pi-review-subtask-watch]"));
  assert.ok(single.includes("The requested one-shot checkpoint for execution exec-1 is due while work remains active."));
  assert.ok(single.includes("Execution exec-1: 1 active task(s), revision 7."));
  assert.ok(single.includes("- task-1 · Task one · running · gpt-x"));
  assert.ok(single.includes("elapsed 1m33s;"));
  assert.ok(single.includes("last recorded activity 30s ago;"));
  assert.ok(single.includes("controls: inspect yes, steer yes (live yes), interrupt yes"));
  assert.ok(single.includes("recent: executing · "));
  assert.ok(!single.includes("landed task") && !single.includes("Landed task"));

  const both = formatWatchEvent([inspection, { ...inspection, executionId: "exec-2" }] as unknown as BackgroundInspection[], watchConfig);
  assert.ok(both.includes("2 requested one-shot subtask checkpoints became due together"));
  assert.ok(both.includes("Execution exec-2:"));
});

test("formatWatchEvent falls back to updated time and the raw executor entry id", () => {
  const now = Date.now();
  const inspection = {
    executionId: "exec-3",
    kind: "research",
    revision: 1,
    tasks: [{
      taskId: "task-9",
      definition: { title: "Research one" },
      state: "queued",
      updatedAt: new Date(now - 125_000).toISOString(),
      executorEntryId: "unknown-entry",
      activity: [],
      timing: { queueMs: 5000, captureMs: 0, executionMs: 0, reviewMs: 0, landingMs: 0, totalMs: 5000 },
    }],
  };
  const text = formatWatchEvent([inspection] as unknown as BackgroundInspection[], watchConfig);
  assert.ok(text.includes("Research exec-3: 1 active task(s), revision 1."));
  assert.ok(text.includes("- task-9 · Research one · queued · unknown-entry"));
  assert.ok(text.includes("elapsed 5s;"));
  assert.ok(text.includes("last recorded activity 2m5s ago;"));
  assert.ok(text.includes("interrupt yes"));
  assert.ok(text.includes("recent: no recorded activity yet"));
});

test("BackgroundStateTransition remains exported from background-controller (compile-time probe)", () => {
  const transition: BackgroundStateTransition = {
    sequence: 1,
    state: "queued",
    at: "2024-01-01T00:00:00.000Z",
    generation: 0,
  };
  assert.equal(transition.state, "queued");
});

test("watch checkpoint delivery options come from the shared notification policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-watch-delivery-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
    const executor = join(root, "executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>setTimeout(()=>{",
      "if(prompt.includes('WATCH_SENTINEL'))fs.writeFileSync('watched.txt','watched landed\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
      "},400));",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "fake",
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" as const },
      }],
      execution: { activeExecutor: { source: "external", id: "fake" }, maxWorkers: 2 },
    });
    const contents: string[] = [];
    const deliveries: Array<{ deliverAs: string; triggerTurn: boolean } | undefined> = [];
    const controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }, options?: { deliverAs: "steer" | "followUp"; triggerTurn: boolean }) => {
        contents.push(message.content);
        deliveries.push(options);
      } },
      config,
      state: createState(),
      cwd: () => root,
    });
    const started = await controller.start([
      { title: "watched", instructions: "WATCH_SENTINEL", acceptanceCriteria: ["watched.txt exists"] },
    ]);
    controller.watch(started.executionId, 25);
    await waitFor(() => contents.some((content) => content.startsWith("[pi-review-subtask-watch]")));
    const watchIndex = contents.findIndex((content) => content.startsWith("[pi-review-subtask-watch]"));
    assert.deepEqual(deliveries[watchIndex], { deliverAs: "followUp", triggerTurn: true },
      "watch checkpoints follow up with a turn and never steer, matching watchCheckpointDelivery()");
    await controller.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
