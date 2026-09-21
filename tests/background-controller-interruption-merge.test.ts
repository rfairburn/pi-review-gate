import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BackgroundExecutionController,
} from "../src/execution/background-controller";
import type { BackgroundExecutionGroup, BackgroundTaskRecord } from "../src/execution/background-controller";
import { normalizeConfig } from "../src/config";
import { createState } from "../src/state";
import { sourceMutationCoordinator } from "../src/execution/source-mutation-lease";
import {
  initGitRepo,
  setupFaultScenario,
  setupInterruptedMergeTask,
  waitFor,
  waitForAsync,
} from "./helpers/background-controller-fixtures";


test("interrupt quiesces a writer and force-merge lands its verified checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-interrupt-"));
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
      externalAgents: {
        "restore-fake": {
          adapter: "run-as-binary",
          command: executor,
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "restore-fake" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
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
      externalAgents: {
        "queued-continue-fake": {
          adapter: "run-as-binary",
          command: executor,
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "queued-continue-fake" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
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
      externalAgents: {
        "predispatch-fake": {
          adapter: "run-as-binary",
          command: executor,
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "predispatch-fake" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
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
