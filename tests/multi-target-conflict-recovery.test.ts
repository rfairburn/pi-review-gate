import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import {
  type BackgroundFaultHooks,
  BackgroundExecutionController,
  type BackgroundTaskDefinition,
} from "../src/execution/background-controller";
import { sourceMutationCoordinator } from "../src/execution/source-mutation-lease";
import { createState } from "../src/state";

// Issue #25 regression coverage (tests only): two different target repositories
// conflict concurrently through the real controller/capture/landing pipeline.
// The controller currently holds a single `conflictGate`/`releaseConflictBlock`
// pair, so the second gate overwrites the first gate's record and the first
// target's block is leaked (inline landing path) or released prematurely
// (continuation activation path). These tests reproduce that lifecycle with the
// established fake-executor transport seam and controlled target mutations, and
// assert the agreed contract without copying any gate state machine:
//
// - while unresolved, both conflicts stay inspectable per execution and both
//   targets stay blocked for source mutations;
// - neither group's workspace target is redirected;
// - recovery through the existing no-arg `markClean` API can complete both
//   resolved conflicts, and follow-up work in a previously conflicted target
//   is not stranded.
//
// No partial-clear policy is asserted: as long as both gates are gone and both
// tasks are landed after resolving both workspaces, any safe multi-gate
// recovery implementation satisfies these tests.

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function makeRepo(prefix: string, baseName: string, baseContent: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, baseName), baseContent, "utf8");
  await git(root, "add", baseName);
  await git(root, "commit", "-qm", "base");
  return root;
}

async function samePath(a: string, b: string): Promise<boolean> {
  return (await realpath(a)) === (await realpath(b));
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function task(title: string, instructions: string): BackgroundTaskDefinition {
  return { title, instructions, acceptanceCriteria: [`${title} marker landed`] };
}

type ExecutorAction = {
  sentinel: string;
  file: string;
  /** Content written to `shared.txt` inside the executor's own worktree (candidate side). */
  worktreeShared?: string;
  /** Absolute path of the target repository file mutated during the executor turn (current side). */
  targetShared?: string;
  /** Content written to `targetShared` so the landing revalidation finds a conflict. */
  targetSharedContent?: string;
};

/**
 * Fake executor seam (same transport protocol as the existing explicit
 * workspace harness): writes the marker file whose sentinel appears in the
 * prompt, optionally changes `shared.txt` in the worker worktree so the
 * candidate commit modifies it, and optionally mutates a prepared target
 * repository file so the landing plan conflicts against the earlier capture.
 */
async function writeConflictExecutorScript(root: string, actions: ExecutorAction[]): Promise<string> {
  const script = join(root, `executor-conflict-${actions.map((a) => a.sentinel.toLowerCase()).join("-")}.cjs`);
  await writeFile(script, [
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    `process.stdin.on('end',()=>{const actions=${JSON.stringify(actions)};`,
    "for(const action of actions){if(prompt.includes(action.sentinel)){",
    "fs.writeFileSync(action.file,'landed\\n');",
    "if(action.worktreeShared!==undefined){fs.writeFileSync('shared.txt',action.worktreeShared);}",
    "if(action.targetShared!==undefined){fs.writeFileSync(action.targetShared,action.targetSharedContent);}}}",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));});",
  ].join("\n"), "utf8");
  return script;
}

function executionConfig(script: string): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "multi-target-fake",
      adapter: "run-as-binary" as const,
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [script] },
    }],
    execution: {
      maxWorkers: 2,
      workerResources: [{ resourceId: "default", selection: { source: "external", id: "multi-target-fake" }, maxConcurrent: 2 }],
    },
    retainBundles: "always",
  });
}

function makeController(config: ReviewGateConfig, cwd: () => string): BackgroundExecutionController {
  return new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd });
}

/**
 * Deterministic settlement-race regression harness (issue #25 review): holds
 * the production conflicted-failure wake inside the existing fault-hook seam,
 * which runs after the gate is published and the task state is durably
 * conflicted but before the landing settles. While the wake is held, the test
 * resolves the conflict and completes markClean; releasing the barrier then
 * lets the settled landing-conflict result race the already-resolved landing.
 * The settled barrier must never regress the resolved landing. A one-shot
 * latch on the next association publish after release deterministically
 * signals that settlement (and its trailing durable bookkeeping) completed.
 */
function settlementRaceHooks() {
  let releaseConflictWake: () => void = () => undefined;
  const conflictWakeHeld = new Promise<void>((done) => { releaseConflictWake = done; });
  let wakeHeld = false;
  let settlementReleased = false;
  let signalSettlement!: () => void;
  const settled = new Promise<void>((done) => { signalSettlement = done; });
  return {
    hooks: {
      wake: ({ kind, taskState }) => {
        if (!settlementReleased && kind === "failure" && taskState === "conflicted") {
          wakeHeld = true;
          return conflictWakeHeld;
        }
        return undefined;
      },
      publishAssociations: () => {
        if (settlementReleased) signalSettlement();
        return undefined;
      },
    } satisfies BackgroundFaultHooks,
    waitUntilHeld: () => waitUntil(() => wakeHeld, "the conflicted failure wake to be held by the settlement barrier"),
    releaseSettlement: () => {
      settlementReleased = true;
      releaseConflictWake();
      return settled;
    },
    releaseForShutdown: () => releaseConflictWake(),
  };
}

function resolvedLandingAssertions(
  controller: BackgroundExecutionController,
  executionId: string,
  stage: string,
): void {
  const inspection = controller.inspect(executionId);
  assert.equal(inspection.conflictGate, undefined, `execution ${executionId} must have no remaining conflict gate ${stage}`);
  const task = inspection.tasks[0];
  assert.ok(task, `execution ${executionId} must still expose its task ${stage}`);
  assert.equal(task.state, "landed", `task ${task.taskId} must stay landed ${stage}; history=[${(task.stateHistory ?? []).map((h) => h.state).join(" -> ")}]`);
  assert.equal(task.summary, "Conflict resolution was validated and marked landed.", `the validated-resolution summary must survive ${stage}`);
}

function resolutionOutcomeAssertions(
  outcome: { cleared: boolean; paths: string[] },
  controller: BackgroundExecutionController,
  executionId: string,
): void {
  assert.ok(outcome.cleared, "markClean must clear the resolved conflict while the landing settlement is held");
  assert.ok(outcome.paths.includes("shared.txt"), "markClean must report the resolved conflict path");
  resolvedLandingAssertions(controller, executionId, "before settlement resumes");
}

async function resolveAndMarkClean(
  target: string,
  controller: BackgroundExecutionController,
  executionId: string,
): Promise<{ cleared: boolean; paths: string[] }> {
  await writeFile(join(target, "shared.txt"), "resolved\n", "utf8");
  const outcome = await controller.markClean();
  resolutionOutcomeAssertions(outcome, controller, executionId);
  return outcome;
}

async function removeOwned(roots: Iterable<string>): Promise<void> {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Policy-agnostic recovery drain: resolve workspaces first, then call the
 * existing no-arg markClean API until it reports nothing left to clear. Works
 * whether a corrected implementation clears all resolved gates in one call or
 * one gate per call, without prescribing a partial-clear policy.
 */
async function drainMarkClean(controller: BackgroundExecutionController): Promise<string[]> {
  const cleared: string[] = [];
  for (let call = 0; call < 8; call += 1) {
    const outcome = await controller.markClean();
    if (!outcome.cleared) break;
    cleared.push(...outcome.paths);
  }
  return cleared;
}

/**
 * continueTask refuses admission while the previous launch's runtime handle is
 * still settling after a landing; retry only through that brief settling window.
 */
async function continueWhenIdle(
  controller: BackgroundExecutionController,
  input: {
    executionId: string;
    taskId: string;
    instructions: string;
    instructionId: string;
    actor: "user";
  },
  what: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await controller.continueTask(input);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/already active/.test(error.message) || Date.now() > deadline) {
        throw new Error(`Could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}

test("concurrent landing conflicts on two independent targets stay inspectable, blocked, and recoverable", async () => {
  const parent = await makeRepo("multi-conflict-parent-", "base.txt", "parent base\n");
  const targetA = await makeRepo("multi-conflict-target-a-", "shared.txt", "base\n");
  const targetB = await makeRepo("multi-conflict-target-b-", "shared.txt", "base\n");
  const script = await writeConflictExecutorScript(parent, [
    {
      sentinel: "CONFLICT_A",
      file: "a-landed.txt",
      worktreeShared: "worker a\n",
      targetShared: join(targetA, "shared.txt"),
      targetSharedContent: "user a\n",
    },
    {
      sentinel: "CONFLICT_B",
      file: "b-landed.txt",
      worktreeShared: "worker b\n",
      targetShared: join(targetB, "shared.txt"),
      targetSharedContent: "user b\n",
    },
    { sentinel: "FOLLOWUP_A", file: "followup-landed.txt" },
  ]);
  const config = executionConfig(script);
  const controller = makeController(config, () => parent);
  const owned = [parent, targetA, targetB];
  try {
    const groupA = await controller.start([task("conflict-a", "CONFLICT_A")], "execute", targetA);
    owned.push(groupA.root);
    await waitUntil(
      () => controller.inspect(groupA.executionId).tasks[0]?.state === "conflicted",
      "target A's landing to materialize conflicts",
    );
    const groupB = await controller.start([task("conflict-b", "CONFLICT_B")], "execute", targetB);
    owned.push(groupB.root);
    await waitUntil(
      () => controller.inspect(groupB.executionId).tasks[0]?.state === "conflicted",
      "target B's landing to materialize conflicts",
    );

    // While both conflicts are unresolved, both gates must remain inspectable
    // on their own executions — the second gate must not overwrite the first.
    const inspectionA = controller.inspect(groupA.executionId);
    const inspectionB = controller.inspect(groupB.executionId);
    const gateA = inspectionA.conflictGate;
    const gateB = inspectionB.conflictGate;
    assert.ok(gateA, "target A's conflict gate must remain inspectable while unresolved");
    assert.ok(gateB, "target B's conflict gate must remain inspectable while unresolved");
    assert.equal(gateA!.executionId, groupA.executionId);
    assert.equal(gateB!.executionId, groupB.executionId);
    assert.equal(gateA!.taskId, inspectionA.tasks[0]!.taskId);
    assert.equal(gateB!.taskId, inspectionB.tasks[0]!.taskId);
    assert.deepEqual([...gateA!.paths], ["shared.txt"]);
    assert.deepEqual([...gateB!.paths], ["shared.txt"]);
    assert.equal(inspectionA.tasks[0]?.state, "conflicted");
    assert.equal(inspectionB.tasks[0]?.state, "conflicted");

    // Neither target is redirected and neither target is unblocked while its
    // conflict markers remain unresolved.
    assert.ok(await samePath(inspectionA.cwd, targetA), "group A's workspace target must not be redirected");
    assert.ok(await samePath(inspectionB.cwd, targetB), "group B's workspace target must not be redirected");
    assert.ok(await samePath(gateA!.sourceRoot, targetA));
    assert.ok(await samePath(gateB!.sourceRoot, targetB));
    assert.equal(sourceMutationCoordinator.blocked(targetA).blocked, true, "target A must stay blocked while its conflict is unresolved");
    assert.equal(sourceMutationCoordinator.blocked(targetB).blocked, true, "target B must stay blocked while its conflict is unresolved");
    assert.match(await readFile(join(targetA, "shared.txt"), "utf8"), /^<<<<<<< /m);
    assert.match(await readFile(join(targetB, "shared.txt"), "utf8"), /^<<<<<<< /m);

    // Recovery: resolve both materialized conflicts, then complete both gates
    // through the existing no-arg markClean API.
    await writeFile(join(targetA, "shared.txt"), "resolved a\n", "utf8");
    await writeFile(join(targetB, "shared.txt"), "resolved b\n", "utf8");
    const clearedPaths = await drainMarkClean(controller);
    assert.ok(clearedPaths.includes("shared.txt"), "markClean must clear the resolved conflict paths");

    for (const executionId of [groupA.executionId, groupB.executionId]) {
      const inspection = controller.inspect(executionId);
      assert.equal(inspection.conflictGate, undefined, `execution ${executionId} must have no remaining conflict gate after recovery`);
      const landed = inspection.tasks.every((t) => t.state === "landed");
      assert.ok(
        landed,
        `every task in ${executionId} must be landed after recovery; states: ` +
          inspection.tasks.map((t) => `${t.taskId}=${t.state} history=[${(t.stateHistory ?? []).map((h) => h.state).join(" -> ")}]`).join("; "),
      );
    }
    assert.equal(sourceMutationCoordinator.blocked(targetA).blocked, false, "resolved target A must be released after recovery");
    assert.equal(sourceMutationCoordinator.blocked(targetB).blocked, false, "resolved target B must be released after recovery");

    // Subsequent work in a previously conflicted target is not stranded.
    await controller.add(groupA.executionId, [task("followup-a", "FOLLOWUP_A")]);
    await waitUntil(
      () => readFile(join(targetA, "followup-landed.txt"), "utf8").then(() => true, () => false),
      "post-recovery follow-up work to land in target A",
    );
    await assert.rejects(readFile(join(targetB, "followup-landed.txt"), "utf8"), /ENOENT/, "the follow-up belongs to group A's target only");
  } finally {
    await controller.shutdown().catch(() => undefined);
    await controller.detach().catch(() => undefined);
    await removeOwned(owned);
  }
});

test("markClean completing while a fresh conflict's settlement is held keeps the resolved landing", async () => {
  const parent = await makeRepo("settle-fresh-parent-", "base.txt", "parent base\n");
  const targetA = await makeRepo("settle-fresh-target-a-", "shared.txt", "base\n");
  const script = await writeConflictExecutorScript(parent, [
    {
      sentinel: "CONFLICT_A",
      file: "a-landed.txt",
      worktreeShared: "worker a\n",
      targetShared: join(targetA, "shared.txt"),
      targetSharedContent: "user a\n",
    },
  ]);
  const config = executionConfig(script);
  const controller = makeController(config, () => parent);
  const race = settlementRaceHooks();
  controller.setFaultHooks(race.hooks);
  const owned = [parent, targetA];
  try {
    const group = await controller.start([task("conflict-a", "CONFLICT_A")], "execute", targetA);
    owned.push(group.root);
    // The fault hook holds the production conflicted-failure wake only after
    // the gate is published and the task state is durably conflicted, so the
    // held barrier guarantees the landing has not settled yet.
    await race.waitUntilHeld();
    const heldInspection = controller.inspect(group.executionId);
    assert.ok(heldInspection.conflictGate, "the conflict gate must be published before the settlement barrier releases");
    assert.equal(heldInspection.tasks[0]?.state, "conflicted");
    assert.equal(sourceMutationCoordinator.blocked(targetA).blocked, true, "the target must stay blocked while settlement is held unresolved");

    // Resolve the materialized conflict and complete the gate while the
    // landing settlement is still held behind the barrier.
    await resolveAndMarkClean(targetA, controller, group.executionId);
    assert.equal(sourceMutationCoordinator.blocked(targetA).blocked, false, "the resolved target must be released while settlement is still held");

    // Let the held settlement finish: the landing still reports conflicted,
    // and the settled result must not regress the already-resolved landing.
    await race.releaseSettlement();
    resolvedLandingAssertions(controller, group.executionId, "after settlement completed");
    assert.equal(sourceMutationCoordinator.blocked(targetA).blocked, false, "the resolved target must stay released after settlement completed");
  } finally {
    race.releaseForShutdown();
    await controller.shutdown().catch(() => undefined);
    await controller.detach().catch(() => undefined);
    await removeOwned(owned);
  }
});

test("markClean completing while a continuation conflict's settlement is held keeps the resolved landing", async () => {
  const parent = await makeRepo("settle-continue-parent-", "base.txt", "parent base\n");
  const targetA = await makeRepo("settle-continue-target-a-", "shared.txt", "base\n");
  const script = await writeConflictExecutorScript(parent, [
    { sentinel: "CLEAN_A", file: "a-landed.txt" },
    {
      sentinel: "CONTINUE_A",
      file: "a-continued.txt",
      worktreeShared: "worker a continued\n",
      targetShared: join(targetA, "shared.txt"),
      targetSharedContent: "user a continued\n",
    },
  ]);
  const config = executionConfig(script);
  const controller = makeController(config, () => parent);
  const race = settlementRaceHooks();
  controller.setFaultHooks(race.hooks);
  const owned = [parent, targetA];
  try {
    const group = await controller.start([task("clean-a", "CLEAN_A")], "execute", targetA);
    owned.push(group.root);
    await waitUntil(
      () => controller.inspect(group.executionId).tasks[0]?.state === "landed",
      "the initial task to land cleanly before the continuation",
    );
    const taskA = controller.inspect(group.executionId).tasks[0]!.taskId;
    await continueWhenIdle(controller, {
      executionId: group.executionId,
      taskId: taskA,
      instructions: "CONTINUE_A",
      instructionId: "continue-conflict-a",
      actor: "user",
    }, "the continuation admission");
    // The continuation's conflicted-failure wake is held after its gate is
    // published; its landing settlement cannot finish while the barrier holds.
    await race.waitUntilHeld();
    const heldInspection = controller.inspect(group.executionId);
    assert.ok(heldInspection.conflictGate, "the continuation conflict gate must be published before the settlement barrier releases");
    assert.equal(heldInspection.tasks[0]?.state, "conflicted");
    assert.equal(sourceMutationCoordinator.blocked(targetA).blocked, true, "the target must stay blocked while the continuation settlement is held unresolved");

    await resolveAndMarkClean(targetA, controller, group.executionId);
    assert.equal(sourceMutationCoordinator.blocked(targetA).blocked, false, "the resolved target must be released while settlement is still held");

    await race.releaseSettlement();
    resolvedLandingAssertions(controller, group.executionId, "after settlement completed");
    assert.equal(sourceMutationCoordinator.blocked(targetA).blocked, false, "the resolved target must stay released after settlement completed");
  } finally {
    race.releaseForShutdown();
    await controller.shutdown().catch(() => undefined);
    await controller.detach().catch(() => undefined);
    await removeOwned(owned);
  }
});

test("a continuation conflict on a second target must not release or overwrite the first target's active gate", async () => {
  const parent = await makeRepo("multi-continue-parent-", "base.txt", "parent base\n");
  const targetA = await makeRepo("multi-continue-target-a-", "shared.txt", "base\n");
  const targetB = await makeRepo("multi-continue-target-b-", "shared.txt", "base\n");
  const script = await writeConflictExecutorScript(parent, [
    {
      sentinel: "CONFLICT_A",
      file: "a-landed.txt",
      worktreeShared: "worker a\n",
      targetShared: join(targetA, "shared.txt"),
      targetSharedContent: "user a\n",
    },
    { sentinel: "CLEAN_B", file: "b-landed.txt" },
    {
      sentinel: "CONTINUE_B",
      file: "b-continued.txt",
      worktreeShared: "worker b continued\n",
      targetShared: join(targetB, "shared.txt"),
      targetSharedContent: "user b continued\n",
    },
    { sentinel: "FOLLOWUP_A", file: "followup-landed.txt" },
  ]);
  const config = executionConfig(script);
  const controller = makeController(config, () => parent);
  const owned = [parent, targetA, targetB];
  try {
    const groupA = await controller.start([task("conflict-a", "CONFLICT_A")], "execute", targetA);
    owned.push(groupA.root);
    await waitUntil(
      () => controller.inspect(groupA.executionId).tasks[0]?.state === "conflicted",
      "target A's landing to materialize conflicts",
    );

    const groupB = await controller.start([task("clean-b", "CLEAN_B")], "execute", targetB);
    owned.push(groupB.root);
    await waitUntil(
      () => controller.inspect(groupB.executionId).tasks[0]?.state === "landed",
      "target B's initial task to land cleanly",
    );
    const taskB = controller.inspect(groupB.executionId).tasks[0]!.taskId;

    // The continuation of target B's task conflicts while target A's gate is
    // active: continuation gate activation must not release target A's block
    // and must not discard target A's gate record.
    await continueWhenIdle(controller, {
      executionId: groupB.executionId,
      taskId: taskB,
      instructions: "CONTINUE_B",
      instructionId: "continue-conflict-b",
      actor: "user",
    }, "target B's continuation admission");
    await waitUntil(
      () => controller.inspect(groupB.executionId).tasks[0]?.state === "conflicted",
      "target B's continuation to materialize conflicts",
    );

    const inspectionA = controller.inspect(groupA.executionId);
    const inspectionB = controller.inspect(groupB.executionId);
    const gateA = inspectionA.conflictGate;
    const gateB = inspectionB.conflictGate;
    assert.ok(gateA, "target A's conflict gate must remain inspectable after the continuation gate activates");
    assert.equal(gateA!.executionId, groupA.executionId, "target A's gate must not be overwritten by target B's continuation gate");
    assert.equal(gateA!.taskId, inspectionA.tasks[0]!.taskId);
    assert.ok(gateB, "target B's continuation conflict gate must be inspectable");
    assert.equal(inspectionB.tasks[0]?.state, "conflicted");
    assert.equal(inspectionA.tasks[0]?.state, "conflicted");
    assert.ok(await samePath(inspectionA.cwd, targetA), "group A's workspace target must not be redirected");
    assert.equal(sourceMutationCoordinator.blocked(targetA).blocked, true, "target A must stay blocked while its conflict is unresolved, even after another target's continuation gate activates");
    assert.equal(sourceMutationCoordinator.blocked(targetB).blocked, true, "target B must stay blocked while its conflict is unresolved");
    assert.match(await readFile(join(targetA, "shared.txt"), "utf8"), /^<<<<<<< /m);
    assert.match(await readFile(join(targetB, "shared.txt"), "utf8"), /^<<<<<<< /m);

    // Recovery: resolve both workspaces, then complete both gates through the
    // existing no-arg markClean API.
    await writeFile(join(targetA, "shared.txt"), "resolved a\n", "utf8");
    await writeFile(join(targetB, "shared.txt"), "resolved b\n", "utf8");
    const clearedPaths = await drainMarkClean(controller);
    assert.ok(clearedPaths.includes("shared.txt"), "markClean must clear the resolved conflict paths");

    for (const executionId of [groupA.executionId, groupB.executionId]) {
      const inspection = controller.inspect(executionId);
      assert.equal(inspection.conflictGate, undefined, `execution ${executionId} must have no remaining conflict gate after recovery`);
      const landed = inspection.tasks.every((t) => t.state === "landed");
      assert.ok(
        landed,
        `every task in ${executionId} must be landed after recovery; states: ` +
          inspection.tasks.map((t) => `${t.taskId}=${t.state} history=[${(t.stateHistory ?? []).map((h) => h.state).join(" -> ")}]`).join("; "),
      );
    }
    assert.equal(sourceMutationCoordinator.blocked(targetA).blocked, false, "resolved target A must be released after recovery");
    assert.equal(sourceMutationCoordinator.blocked(targetB).blocked, false, "resolved target B must be released after recovery");

    await controller.add(groupA.executionId, [task("followup-a", "FOLLOWUP_A")]);
    await waitUntil(
      () => readFile(join(targetA, "followup-landed.txt"), "utf8").then(() => true, () => false),
      "post-recovery follow-up work to land in target A",
    );
  } finally {
    await controller.shutdown().catch(() => undefined);
    await controller.detach().catch(() => undefined);
    await removeOwned(owned);
  }
});