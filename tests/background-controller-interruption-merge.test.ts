import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { ConflictGateStore, type ConflictGate } from "../src/execution/conflict-gate-store";
import { operationOwnershipStatus, operationRecordPath, readOperationRecord } from "../src/execution/operation-record";
import { denyProcessGroupSignals, mockRootPid, readMockEvents, writeMockClaudeCli } from "./helpers/claude-mock-cli";
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

test("force-merge fails promptly with an actionable outcome when its own conflict gate blocks the source", async () => {
  const scenario = await setupInterruptedMergeTask("gate-blocked");
  const { root, controller, started, taskId } = scenario;
  try {
    // The controller's own gate, installed through the production install
    // boundary: its exact reason stays in the refusal (single-owner behavior).
    installOwnGate(controller, ownGate(root, started.executionId, taskId, "unresolved conflict markers hold the source workspace"));
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
    assert.equal(command.error, "Force-merge refused: the source workspace is blocked by an active conflict gate (unresolved conflict markers hold the source workspace). Resolve the conflicts and call SubtasksMarkClean before retrying force-merge.");
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/);
    assert.equal(await readFile(join(root, "base.txt"), "utf8"), "base\n");
  } finally {
    await controller.shutdown().catch(() => undefined);
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("force-merge blocked only by another owner's gate refuses generically without disclosing or releasing it (#682)", async () => {
  const scenario = await setupInterruptedMergeTask("gate-foreign");
  const { root, controller, started, taskId } = scenario;
  // Another owner's gate store on a nested root of this workspace.
  const foreign = new ConflictGateStore();
  try {
    foreign.install(ownGate(join(root, "pkg"), "exec-foreign", "task-FOREIGN-682", `FOREIGN-GATE-SECRET-682 ${join(root, "foreign-secret-path.txt")}`));
    // Plus an anonymous raw coordinator holder on the exact root.
    const releaseAnonymous = sourceMutationCoordinator.block(root, "FOREIGN-GATE-SECRET-682 anonymous");
    try {
      const refusal = await controller.forceMerge({
        executionId: started.executionId,
        taskId,
        mergeAnyhow: false,
        instructionId: "force-foreign",
        actor: "user",
      }).then(() => assert.fail("force-merge must be refused"), (error: unknown) => error as Error);
      assert.equal(refusal.message, FOREIGN_REFUSAL);
      assert.doesNotMatch(refusal.message, FOREIGN_SECRET);
      const task = controller.inspect(started.executionId, taskId).tasks[0]!;
      assert.equal(task.state, "interrupted");
      const command = task.commands.find((candidate) => candidate.instructionId === "force-foreign")!;
      assert.equal(command.status, "failed");
      assert.equal(command.error, FOREIGN_REFUSAL);
      assert.doesNotMatch(JSON.stringify(task), FOREIGN_SECRET);
      assert.doesNotMatch(await readFile(join(started.root, "execution.json"), "utf8"), FOREIGN_SECRET);
      await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/);
    } finally {
      releaseAnonymous();
    }
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, true, "the foreign gate survives the refusal");
    assert.equal(foreign.size, 1);
  } finally {
    foreign.clear();
    await scenario.cleanup();
  }
});

test("force-merge with own and foreign gates on overlapping roots reports only its own reason; clearing either leaves the other (#682)", async () => {
  const scenario = await setupInterruptedMergeTask("gate-mixed");
  const { root, controller, started, taskId } = scenario;
  const foreign = new ConflictGateStore();
  try {
    // The foreign holder activates first so it is the first overlapping blocker.
    foreign.install(ownGate(root, "exec-foreign", "task-FOREIGN-682", `FOREIGN-GATE-SECRET-682 ${join(root, "foreign-secret-path.txt")}`));
    installOwnGate(controller, ownGate(join(root, "nested"), started.executionId, taskId, "own gate reason"));
    const refusal = await controller.forceMerge({
      executionId: started.executionId,
      taskId,
      mergeAnyhow: false,
      instructionId: "force-mixed",
      actor: "user",
    }).then(() => assert.fail("force-merge must be refused"), (error: unknown) => error as Error);
    assert.match(refusal.message, /active conflict gate \(own gate reason\)/);
    assert.doesNotMatch(refusal.message, FOREIGN_SECRET);
    const task = controller.inspect(started.executionId, taskId).tasks[0]!;
    assert.doesNotMatch(JSON.stringify(task), FOREIGN_SECRET);
    assert.doesNotMatch(await readFile(join(started.root, "execution.json"), "utf8"), FOREIGN_SECRET);

    // Detaching this owner releases only its own holder.
    await controller.shutdown();
    await controller.detach();
    assert.deepEqual(sourceMutationCoordinator.blockedFor(root, foreign), { blocked: true, ownReason: foreign.list()[0]!.reason, foreign: false });
  } finally {
    foreign.clear();
    await scenario.cleanup();
  }
  assert.equal(sourceMutationCoordinator.blocked(root).blocked, false);
});

test("interrupt_with_merge quiesces the writer but redacts another owner's gate from the merge refusal (#682)", async () => {
  const scenario = await setupInterruptedMergeTask("gate-foreign-interrupt", undefined, { interruptInSetup: false });
  const { root, controller, started, taskId } = scenario;
  const foreign = new ConflictGateStore();
  try {
    foreign.install(ownGate(root, "exec-foreign", "task-FOREIGN-682", `FOREIGN-GATE-SECRET-682 ${join(root, "foreign-secret-path.txt")}`));
    const refusal = await controller.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_with_merge",
      instructionId: "interrupt-merge-foreign",
      actor: "user",
    }).then(() => assert.fail("the merge half must be refused"), (error: unknown) => error as Error);
    assert.equal(refusal.message, FOREIGN_REFUSAL);
    const task = controller.inspect(started.executionId, taskId).tasks[0]!;
    // Stop settlement stays truthful: the writer quiesced and the interrupt was
    // acknowledged; only the merge was refused, generically.
    assert.equal(task.state, "interrupted");
    assert.equal(task.commands.find((candidate) => candidate.instructionId === "interrupt-merge-foreign")?.status, "acknowledged");
    const merge = task.commands.find((candidate) => candidate.instructionId === "interrupt-merge-foreign-force-merge")!;
    assert.equal(merge.status, "failed");
    assert.equal(merge.error, FOREIGN_REFUSAL);
    assert.doesNotMatch(JSON.stringify(task), FOREIGN_SECRET);
    assert.doesNotMatch(await readFile(join(started.root, "execution.json"), "utf8"), FOREIGN_SECRET);
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"), /ENOENT/);
    assert.equal(foreign.size, 1);
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, true, "the foreign gate survives");
  } finally {
    foreign.clear();
    await scenario.cleanup();
  }
});

test("mark-clean releases only this owner's gate and reports an overlapping foreign gate without claiming queued landings were released (#682)", async () => {
  const scenario = await setupInterruptedMergeTask("gate-markclean-foreign");
  const { root, controller, started, taskId } = scenario;
  const foreign = new ConflictGateStore();
  try {
    await writeFile(join(root, "conflicted.txt"), "resolved\n", "utf8");
    installOwnGate(controller, ownGate(root, started.executionId, taskId, "own gate reason"));
    foreign.install(ownGate(join(root, "pkg"), "exec-foreign", "task-FOREIGN-682", `FOREIGN-GATE-SECRET-682 ${join(root, "foreign-secret-path.txt")}`));
    assert.deepEqual(await controller.markClean(), { cleared: true, paths: ["conflicted.txt"] });
    const task = controller.inspect(started.executionId, taskId).tasks[0]!;
    const landed = task.activity.filter((event) => event.phase === "landed").map((event) => event.message);
    assert.ok(landed.includes("Conflict resolution validated; this session's conflict gate was cleared. Another overlapping conflict gate was still active at clearance."));
    assert.ok(!landed.includes("Conflict resolution validated; queued landing attempts released."));
    assert.doesNotMatch(JSON.stringify(task), FOREIGN_SECRET);
    assert.equal(controller.associations().conflictGates?.length ?? 0, 0, "this owner's gate cleared");
    assert.equal(foreign.size, 1, "the foreign gate is untouched");
    assert.deepEqual(foreign.blockedState(root), { blocked: true, ownReason: foreign.list()[0]!.reason, foreign: false }, "only the foreign block remains");
  } finally {
    foreign.clear();
    await controller.shutdown().catch(() => undefined);
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("mark-clean keeps the existing release activity when no other owner holds the workspace", async () => {
  const scenario = await setupInterruptedMergeTask("gate-markclean-own");
  const { root, controller, started, taskId } = scenario;
  try {
    await writeFile(join(root, "conflicted.txt"), "resolved\n", "utf8");
    installOwnGate(controller, ownGate(root, started.executionId, taskId, "own gate reason"));
    assert.deepEqual(await controller.markClean(), { cleared: true, paths: ["conflicted.txt"] });
    const task = controller.inspect(started.executionId, taskId).tasks[0]!;
    assert.ok(task.activity.some((event) => event.phase === "landed" && event.message === "Conflict resolution validated; queued landing attempts released."));
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, false);
  } finally {
    await controller.shutdown().catch(() => undefined);
    await controller.detach().catch(() => undefined);
    await scenario.cleanup();
  }
});

const FOREIGN_SECRET = /FOREIGN-GATE-SECRET-682|foreign-secret-path|task-FOREIGN-682|exec-foreign/;
const FOREIGN_REFUSAL = "Force-merge refused: the source workspace is blocked by an active conflict gate held outside this session; nothing was merged. Retry after that gate is cleared.";

function ownGate(sourceRoot: string, executionId: string, taskId: string, reason: string): ConflictGate {
  return {
    executionId,
    taskId,
    sourceRoot,
    paths: ["conflicted.txt"],
    activatedAt: new Date().toISOString(),
    manifestPath: join(sourceRoot, "conflict-manifest.json"),
    reason,
  };
}

function installOwnGate(controller: BackgroundExecutionController, gate: ConflictGate): void {
  (controller as unknown as { setConflictGate: (gate: ConflictGate) => void }).setConflictGate(gate);
}

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

test("a restored stopped task whose durable bundle has no wave ownership anchor is never re-queued", async () => {
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
    // continuation bundle whose wave ownership anchor is gone.
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
    // Re-queuing is not verification: the continuation runner would consume this
    // bundle directly, so the task is paused for inspection instead.
    assert.equal(before.state, "paused_recoverable");
    assert.equal(before.pendingContinuation, undefined, "no continuation is auto-queued for an unverified bundle");
    assert.equal(before.bundle?.operationId, "op-restored", "the durable bundle is preserved for inspection");
    assert.equal(before.commands.some((command) => command.action === "continue"), false,
      "no system continuation command is invented for the unverified path");
    assert.match(before.summary ?? "", /verification failed/);

    // Re-enable the dispatcher: the unverified task must stay out of the queue
    // and its executor must never launch.
    const internals = restored as unknown as { runtimes: Map<string, unknown>; pump: () => Promise<void> };
    config.execution!.maxWorkers = 1;
    await internals.pump();
    await waitFor(() => true);
    assert.equal(internals.runtimes.size, 0, "no continuation runtime is registered");
    assert.equal(restored.inspect(started.executionId).tasks[0]!.state, "paused_recoverable");
    await assert.rejects(readFile(join(root, "executor-ran.txt"), "utf8"), /ENOENT/, "no continuation executor may launch");

    const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    const persistedAfter = persisted.tasks[0] as Record<string, any>;
    assert.equal(persistedAfter.state, "paused_recoverable");
    assert.equal(persistedAfter.bundle.operationId, "op-restored", "the bundle survives the failed verification durably");

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

test("a restored queued task whose recovery path failed is never dispatchable and registers no runtime", async () => {
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
    const original = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    const started = await original.start([{ title: "pre-dispatch continuation", instructions: "original work", acceptanceCriteria: ["done"] }]);
    executionRoot = started.root;
    const associations = original.associations();
    await original.detach();

    // A task already queued by the prior run that names a durable recovery
    // bundle with no wave ownership anchor. Its pending instruction stays for
    // inspection, but an unverified recovery path must never stay dispatchable.
    const manifestPath = join(started.root, "execution.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    const persistedTask = manifest.tasks[0] as Record<string, any>;
    persistedTask.state = "queued";
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

    const controller = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    await controller.restore(associations);
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      runtimes: Map<string, unknown>;
      pump: () => Promise<void>;
    };
    const task = internals.groups.get(started.executionId)!.tasks[0]!;
    assert.equal(task.state, "paused_recoverable", "a queued task with a failed recovery path is paused, never dispatchable");
    assert.equal(task.bundle?.operationId, "op-predispatch", "the recorded bundle is preserved for inspection");
    assert.match(task.summary ?? "", /verification failed/);

    // The dispatcher is fully enabled: an unverified task must not be picked up,
    // must register no runtime, and must never launch its executor.
    config.execution!.maxWorkers = 1;
    await internals.pump();
    await waitFor(() => true);
    assert.equal(internals.runtimes.size, 0, "no continuation runtime is registered");
    assert.equal(internals.groups.get(started.executionId)!.tasks[0]!.state, "paused_recoverable");
    await assert.rejects(readFile(join(root, "executor-ran.txt"), "utf8"), /ENOENT/, "no continuation executor may launch");

    const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    const persistedAfter = persisted.tasks[0] as Record<string, any>;
    assert.equal(persistedAfter.state, "paused_recoverable");
    assert.equal(persistedAfter.bundle.operationId, "op-predispatch", "the bundle survives the failed verification durably");

    await controller.shutdown();
  } finally {
    if (executionRoot) await rm(executionRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// #310: an explicit interrupt whose owned Claude shutdown cannot be verified
// must never become a durable acknowledgement, a quiescence claim, a
// cancellation checkpoint, or an interrupt-with-merge landing. The real
// controller, recovery loop, Claude adapter, and installed Agent SDK drive an
// owned local mock CLI; the operating system's refusal (EPERM) of group-wide
// signals and probes is injected for that CLI's process group only.
test("interrupt_with_merge never acknowledges or merges a Claude writer whose owned shutdown is unverified (#310)", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-claude-310-"));
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-background-claude-310-cli-"));
  const marker = join(scratch, "events.log");
  const blocked = new Set<number>();
  const restoreKill = denyProcessGroupSignals(blocked);
  let rootPid: number | undefined;
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const cli = await writeMockClaudeCli(scratch);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "claude-mock": { adapter: "claude-cli", command: cli, env: { CLAUDE_MOCK_MARKER: marker }, execution: { model: "mock-model" } },
      },
      execution: {
        maxWorkers: 1,
        workerResources: { "default": { selection: { source: "external", id: "claude-mock" }, maxConcurrent: 1 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
      },
      retainBundles: "always",
    });
    controller = new BackgroundExecutionController({ config, state: createState(), cwd: () => root, pi: {} });
    const started = await controller.start([{ title: "unverified shutdown", instructions: "work", acceptanceCriteria: ["none"] }]);
    const taskId = started.tasks[0]!.taskId;
    const internals = controller as unknown as {
      runtimes: Map<string, { control?: { capabilities: { interrupt: boolean } } }>;
      groups: Map<string, BackgroundExecutionGroup>;
    };
    await waitForAsync(async () => (await readMockEvents(marker)).includes("user:1"));
    await waitFor(() => internals.runtimes.get(taskId)?.control?.capabilities.interrupt === true);
    rootPid = mockRootPid(await readMockEvents(marker));
    assert.ok(rootPid !== undefined);
    blocked.add(rootPid);
    const task = internals.groups.get(started.executionId)!.tasks.find((candidate) => candidate.taskId === taskId)!;
    const persistedCommand = async () => {
      const snapshot = JSON.parse(await readFile(join(started.root, "execution.json"), "utf8")) as unknown;
      return findByInstructionId(snapshot, "interrupt-310");
    };

    const interrupting = controller.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_with_merge",
      instructionId: "interrupt-310",
      actor: "user",
    });
    // While the adapter is still trying to verify shutdown, neither memory nor
    // persistence may show an acknowledgement.
    await waitForAsync(async () => (await readMockEvents(marker)).includes("control:interrupt"));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    const pendingCommand = task.commands.find((command) => command.instructionId === "interrupt-310")!;
    assert.equal(pendingCommand.status, "delivered");
    assert.equal(pendingCommand.acknowledgedAt, undefined);
    const pendingPersisted = await persistedCommand();
    assert.notEqual(pendingPersisted?.status, "acknowledged");
    assert.equal(pendingPersisted?.acknowledgedAt, undefined);

    const settled = await interrupting;
    const command = task.commands.find((candidate) => candidate.instructionId === "interrupt-310")!;
    assert.equal(command.status, "failed");
    assert.equal(command.acknowledgedAt, undefined);
    assert.match(command.error ?? "", /Writer quiescence was not verified/);
    const persisted = await persistedCommand();
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.acknowledgedAt, undefined);
    const settledTask = settled.tasks[0]!;
    assert.match(settledTask.summary ?? "", /Writer quiescence was not verified/);
    assert.doesNotMatch(settledTask.summary ?? "", /quiesced\.|acknowledged interrupt/i);
    assert.equal(task.activity?.some((event) => /Writer quiesced/.test(event.message)), false);
    // No interrupt-with-merge landing was attempted.
    assert.equal(task.commands.some((candidate) => candidate.instructionId === "interrupt-310-force-merge"), false);
    assert.equal(settledTask.state === "landed", false);

    // The operation keeps the possibly live writer's ownership and records why.
    const artifactDir = join(settledTask.waveRoot!, "artifacts", taskId);
    const operation = await readOperationRecord(operationRecordPath(artifactDir));
    assert.equal(operation.state, "failed_critical");
    assert.equal(operation.checkpoint, undefined);
    assert.equal(operation.incidents.at(-1)?.stage, "executor_shutdown");
    assert.equal(operation.owner?.status, "active");
    assert.equal(operation.owner?.childExitedAt, undefined);
    assert.equal(operationOwnershipStatus(operation).processAlive, true);
    const processResults = await findFiles(artifactDir, "process-result.json");
    assert.ok(processResults.length > 0);
    const terminationErrors = await Promise.all(processResults.map(async (path) =>
      (JSON.parse(await readFile(path, "utf8")) as { terminationError?: string }).terminationError));
    assert.ok(terminationErrors.some((value) => /EPERM/.test(value ?? "")));
  } finally {
    restoreKill();
    if (rootPid !== undefined) {
      try {
        process.kill(-rootPid, "SIGKILL");
      } catch {
        // Already gone (ESRCH): nothing of ours remains.
      }
    }
    await controller?.shutdown().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

function findByInstructionId(value: unknown, instructionId: string): { status?: string; acknowledgedAt?: string } | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findByInstructionId(entry, instructionId);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.instructionId === instructionId && record.action === "interrupt") return record as { status?: string; acknowledgedAt?: string };
  for (const entry of Object.values(record)) {
    const found = findByInstructionId(entry, instructionId);
    if (found) return found;
  }
  return undefined;
}

async function findFiles(dir: string, name: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await findFiles(path, name));
    else if (entry.name === name) found.push(path);
  }
  return found;
}
