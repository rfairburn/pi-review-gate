import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { BackgroundExecutionController, type BackgroundExecutionGroup } from "../src/execution/background-controller";
import { readGroup, serializeGroupSnapshot, writeGroupSnapshot } from "../src/execution/background-group-store";
import { inspectOperation } from "../src/execution/operation-actions";
import { readOperationRecord, writeOperationRecord, type ReattachmentBundle } from "../src/execution/operation-record";
import { createState } from "../src/state";

const exec = promisify(execFile);
const git = async (root: string, ...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
const internals = (controller: BackgroundExecutionController) => controller as unknown as {
  groups: Map<string, BackgroundExecutionGroup>; runtimes: Map<string, unknown>;
};
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for deterministic task settlement");
    await new Promise((done) => setTimeout(done, 20));
  }
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "accepted-recovery-")));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, "add", "base.txt");
  await git(root, "commit", "-qm", "base");
  const head = await git(root, "rev-parse", "HEAD");
  const calls = join(root, "calls.txt");
  const script = [
    "const fs=require('node:fs');let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{",
    `fs.appendFileSync(${JSON.stringify(calls)},'turn\\n');`,
    "const prior=fs.readFileSync('base.txt','utf8');",
    "fs.writeFileSync('base.txt',prompt.includes('NEXT_CANDIDATE')||prior==='next\\n'?'next\\n':'accepted\\n');",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'implemented'}));});",
  ].join("");
  const reviewer = [
    "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
    `fs.writeFileSync(${JSON.stringify(join(root, "base.txt"))},'parent\\n');`,
    "process.stdout.write(JSON.stringify({verdict:'pass',summary:'accepted exact candidate',findings:[]}));});",
  ].join("");
  const config = normalizeConfig({
    enabled: true, retainBundles: "always",
    reviewers: ["first", "second"].map((id) => ({
      id, adapter: "generic-cli", command: process.execPath, args: ["-e", reviewer], timeoutMs: 10_000,
    })),
    externalAgents: [{ id: "worker", adapter: "run-as-binary", command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", script] } }],
    execution: { activeExecutor: { source: "external", id: "worker" }, maxWorkers: 1,
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 1 } },
  });
  let faults = 0;
  const make = (inject = false) => new BackgroundExecutionController({
    pi: {}, config, state: createState(), cwd: () => root,
    faults: inject ? { materializeLandingConflicts: async ({ executionId, taskId }) => {
      const group = controller.inspect(executionId);
      const durable = (await readGroup(group.root)).group.tasks.find((task) => task.taskId === taskId)!;
      assert.equal(durable.result?.taskResults[0]?.status, "accepted");
      assert.ok(durable.result?.taskResults[0]?.acceptedCommitSha);
      assert.ok(durable.bundle);
      assert.equal(await readFile(join(root, "base.txt"), "utf8"), "parent\n");
      assert.equal(await git(root, "rev-parse", "HEAD"), head);
      faults++;
      throw new Error("Injected materializer PREPARATION failure (no source mutation)");
    } } : undefined,
  });
  const controller = make(true);
  const started = await controller.start([{ title: "reviewed recovery", instructions: "Write accepted to base.txt", acceptanceCriteria: ["exact candidate reviewed twice"] }]);
  const taskId = started.tasks[0]!.taskId;
  await waitFor(() => controller.inspect(started.executionId).tasks[0]?.state === "failed" && !internals(controller).runtimes.size);
  assert.equal(faults, 1);
  const task = controller.inspect(started.executionId).tasks[0]!;
  const bundle = (await inspectOperation(task.bundle!)).bundle;
  const roots = new Set([root, started.root, task.waveRoot!]);
  const controllers = [controller];
  return {
    root, calls, head, config, controller, started, taskId, bundle,
    newController() { const next = make(); controllers.push(next); return next; },
    async cleanup() {
      for (const item of controllers) { await item.shutdown(); await item.detach(); }
      for (const path of roots) await rm(path, { recursive: true, force: true });
    },
  };
}

test("accepted result survives materializer preparation failure, restart and clean-only force landing", async () => {
  const f = await fixture();
  try {
    const before = f.controller.inspect(f.started.executionId).tasks[0]!;
    assert.match(before.error!, /PREPARATION failure/);
    assert.equal(before.result!.taskResults[0]!.status, "accepted");
    const review = JSON.parse(await readFile(join(before.waveRoot!, "artifacts", f.taskId, "result.json"), "utf8"));
    assert.equal(review.reviewReport.reviewers.length, 2);
    const inspection = await inspectOperation(before.bundle!);
    assert.equal(inspection.checkpointVerification.status, "verified");
    assert.equal(inspection.manifest.sourceWorkspace.disposition, "unchanged");
    const calls = await readFile(f.calls, "utf8");
    const associations = f.controller.associations();
    await f.controller.detach();
    const restored = f.newController();
    await restored.restore(associations);
    const task = (await restored.inspectTask(f.started.executionId, f.taskId)).tasks[0]!;
    assert.equal(task.state, "failed");
    assert.equal(task.result!.taskResults[0]!.acceptedCommitSha, before.result!.taskResults[0]!.acceptedCommitSha);
    assert.deepEqual(task.result!.taskResults[0]!.reviewReport, before.result!.taskResults[0]!.reviewReport);
    assert.deepEqual(task.result!.taskResults[0]!.reviewCycles, before.result!.taskResults[0]!.reviewCycles);
    const force = { executionId: f.started.executionId, taskId: f.taskId, actor: "user" as const, mergeAnyhow: false };
    await assert.rejects(restored.forceMerge({ ...force, instructionId: "conflict-check" }), /main remains unchanged/);
    assert.equal(await readFile(join(f.root, "base.txt"), "utf8"), "parent\n");
    assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
    // Remove only the test's parent edit, making the retained candidate land cleanly.
    await writeFile(join(f.root, "base.txt"), "base\n");
    const landed = await restored.forceMerge({ ...force, instructionId: "safe-reland" });
    assert.equal(landed.tasks[0]!.state, "landed");
    assert.equal(await readFile(join(f.root, "base.txt"), "utf8"), "accepted\n");
    assert.equal(await readFile(f.calls, "utf8"), calls, "recovery must not execute the accepted worker again");
  } finally { await f.cleanup(); }
});

test("legacy failed record backfills from its owned artifact on restart and direct force-merge", async () => {
  const f = await fixture();
  try {
    const associations = f.controller.associations();
    await f.controller.detach();
    const group = (await readGroup(f.started.root)).group;
    group.tasks[0]!.bundle = undefined;
    group.tasks[0]!.result = undefined;
    await writeGroupSnapshot(group.root, serializeGroupSnapshot(group, new Map()));
    const restored = f.newController();
    await restored.restore(associations);
    assert.equal(restored.list().length, 1, "legacy bundle must not create a duplicate execution");
    assert.equal(restored.inspect(group.executionId).historicalCount, 1);
    let task = restored.inspect(group.executionId).tasks[0]!;
    assert.equal(task.bundle!.operationId, f.bundle.operationId);
    assert.ok(task.result!.taskResults[0]!.acceptedCommitSha);
    const live = internals(restored).groups.get(group.executionId)!.tasks[0]!;
    live.bundle = undefined; live.result = undefined;
    task = (await restored.inspectTask(group.executionId, f.taskId)).tasks[0]!;
    assert.ok(task.bundle, "SubtasksInspect backfills even without a restart");
    live.bundle = undefined; live.result = undefined;
    const calls = await readFile(f.calls, "utf8");
    const conflicted = await restored.forceMerge({ executionId: group.executionId, taskId: f.taskId,
      mergeAnyhow: true, instructionId: "direct-backfill", actor: "user" });
    assert.equal(conflicted.tasks[0]!.state, "conflicted", "ForceMerge also backfills without prior inspection");
    assert.ok(conflicted.conflictGate);
    assert.match(await readFile(join(f.root, "base.txt"), "utf8"), /<<<<<<< current workspace/);
    await assert.rejects(restored.markClean(), /Conflict markers remain/);
    await writeFile(join(f.root, "base.txt"), "accepted\n");
    assert.equal((await restored.markClean()).cleared, true);
    assert.equal(restored.inspect(group.executionId).tasks[0]!.state, "landed");
    assert.equal(await readFile(f.calls, "utf8"), calls);
  } finally { await f.cleanup(); }
});

test("explicit matching reattachment without old bundle validates identity, revision and source before association", async () => {
  const f = await fixture();
  try {
    f.config.execution!.maxWorkers = 0;
    const group = internals(f.controller).groups.get(f.started.executionId)!;
    const task = group.tasks[0]!;
    task.bundle = undefined; task.result = undefined;
    const calls = await readFile(f.calls, "utf8");
    const request = (bundle: ReattachmentBundle, executionId = group.executionId, taskId = f.taskId) => f.controller.continueTask({
      executionId, taskId, bundle, instructions: "deliberate continuation", instructionId: "reattach", actor: "user",
    });
    for (const bundle of [
      { ...f.bundle, taskId: "task-foreign" }, { ...f.bundle, waveId: "foreign-wave" },
      { ...f.bundle, operationId: "foreign-operation" }, { ...f.bundle, version: 2 } as unknown as ReattachmentBundle,
      { ...f.bundle, expectedRevision: -1 }, { ...f.bundle, expectedRevision: f.bundle.expectedRevision + 1 },
      { ...f.bundle, expectedRevision: f.bundle.expectedRevision - 1 }, { ...f.bundle, waveRoot: f.root },
    ]) {
      await assert.rejects(request(bundle));
      assert.equal(task.bundle, undefined);
      assert.equal(task.pendingContinuation, undefined);
      assert.equal(group.tasks.length, 1);
    }
    await assert.rejects(request(f.bundle, "exec-foreign"), /ownership/);
    await assert.rejects(request(f.bundle, group.executionId, "task-unknown"));
    const manifestPath = join(f.bundle.waveRoot, "wave-manifest.json");
    const manifestText = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(manifestText), sourceRoot: f.started.root }));
    await assert.rejects(request(f.bundle), /source\/task ownership/);
    assert.equal(task.bundle, undefined);
    await writeFile(manifestPath, manifestText);
    const resultPath = join(f.bundle.waveRoot, "artifacts", f.taskId, "result.json");
    const resultText = await readFile(resultPath, "utf8");
    const result = JSON.parse(resultText);
    for (const tampered of [
      { ...result, acceptedCommitSha: f.head },
      { ...result, acceptedRef: result.acceptedRef.replace(f.taskId, "task-foreign") },
      { ...result, bundle: { ...result.bundle, operationId: "foreign-operation" } },
      { ...result, reviewCycles: result.reviewCycles.map((cycle: object) => ({ ...cycle, candidateRef: "refs/foreign" })) },
    ]) {
      await writeFile(resultPath, JSON.stringify(tampered));
      await assert.rejects(request(f.bundle));
      assert.equal(task.bundle, undefined, "unverified accepted evidence must not establish an association");
    }
    await writeFile(resultPath, resultText);
    const ownedRoot = task.waveRoot;
    task.waveRoot = undefined;
    await assert.rejects(request(f.bundle), /ownership anchor/);
    task.waveRoot = ownedRoot;
    const opPath = join(f.bundle.waveRoot, "artifacts", f.taskId, "operation.json");
    const op = await readOperationRecord(opPath);
    const originalRef = op.checkpoint!.ref;
    op.checkpoint!.ref = originalRef.replace(f.taskId, "task-foreign");
    await writeOperationRecord(op);
    const current = { ...f.bundle, expectedRevision: op.revision };
    await assert.rejects(request(current), /not verified/);
    assert.equal(task.bundle, undefined);
    op.checkpoint!.ref = originalRef;
    await writeOperationRecord(op);
    const accepted = await request({ ...f.bundle, expectedRevision: op.revision });
    assert.equal(accepted.tasks[0]!.state, "queued");
    assert.equal(accepted.tasks[0]!.taskId, f.taskId);
    assert.equal(accepted.historicalCount, 1);
    assert.equal(f.controller.list().length, 1);
    assert.ok(accepted.tasks[0]!.result!.taskResults[0]!.acceptedCommitSha);
    assert.equal(await readFile(f.calls, "utf8"), calls);
    await assert.rejects(f.controller.forceMerge({ executionId: group.executionId, taskId: f.taskId,
      mergeAnyhow: true, instructionId: "live-guard", actor: "user" }), /live or queued writer/);
    await f.controller.interrupt({ executionId: group.executionId, taskId: f.taskId,
      mode: "interrupt_as_failure", instructionId: "stop-queued", actor: "user" });
  } finally { await f.cleanup(); }
});

test("accepted continuation handoff survives preparation failure and force-lands the new generation", async () => {
  const f = await fixture();
  try {
    const before = f.controller.inspect(f.started.executionId).tasks[0]!.result!.taskResults[0]!.acceptedCommitSha;
    await f.controller.continueTask({ executionId: f.started.executionId, taskId: f.taskId,
      instructions: "NEXT_CANDIDATE", instructionId: "new-candidate", actor: "user" });
    await waitFor(() => !internals(f.controller).runtimes.size
      && f.controller.inspect(f.started.executionId).tasks[0]?.state === "failed");
    const task = f.controller.inspect(f.started.executionId).tasks[0]!;
    assert.notEqual(task.result!.taskResults[0]!.acceptedCommitSha, before);
    assert.ok(task.result!.taskResults[0]!.acceptedRef?.includes("-g1/workers/"));
    assert.equal(task.result!.taskResults[0]!.status, "accepted");
    const calls = await readFile(f.calls, "utf8");
    const associations = f.controller.associations();
    await f.controller.detach();
    const restored = f.newController();
    await restored.restore(associations);
    const current = (await restored.inspectTask(f.started.executionId, f.taskId)).tasks[0]!;
    assert.equal(current.result!.taskResults[0]!.acceptedCommitSha, task.result!.taskResults[0]!.acceptedCommitSha);
    assert.equal((await inspectOperation(current.bundle!)).checkpointVerification.status, "verified");
    await writeFile(join(f.root, "base.txt"), "base\n");
    const landed = await restored.forceMerge({ executionId: f.started.executionId, taskId: f.taskId,
      mergeAnyhow: false, instructionId: "force-new-generation", actor: "user" });
    assert.equal(landed.tasks[0]!.state, "landed");
    assert.equal(await readFile(join(f.root, "base.txt"), "utf8"), "next\n");
    assert.equal(await readFile(f.calls, "utf8"), calls);
  } finally { await f.cleanup(); }
});

test("recovery reserves continuation admission against overlapping continuations and force-merge", async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  const controller = f.controller as unknown as {
    recoverTaskAssociation: (group: BackgroundExecutionGroup, task: BackgroundExecutionGroup["tasks"][number], bundle?: ReattachmentBundle) => Promise<void>;
    continuationAdmissions: Set<string>;
    pendingForceMerges: Map<string, unknown>;
  };
  const recover = controller.recoverTaskAssociation.bind(f.controller);
  try {
    f.config.execution!.maxWorkers = 0;
    const calls = await readFile(f.calls, "utf8");
    const request = (instructionId: string, bundle?: ReattachmentBundle) => f.controller.continueTask({
      executionId: f.started.executionId, taskId: f.taskId, bundle,
      instructions: "Deliberate continuation", instructionId, actor: "user",
    });
    const force = (instructionId: string) => f.controller.forceMerge({
      executionId: f.started.executionId, taskId: f.taskId, mergeAnyhow: false, instructionId, actor: "user",
    });
    function pauseRecovery() {
      let entered!: () => void;
      const reached = new Promise<void>((done) => { entered = done; });
      const blocked = new Promise<void>((done) => { release = done; });
      controller.recoverTaskAssociation = async (...args) => {
        await recover(...args);
        entered();
        await blocked;
      };
      return reached;
    }

    const verifying = pauseRecovery();
    const first = request("only-admitted-continuation");
    await verifying;
    assert.ok(controller.continuationAdmissions.has(f.taskId));
    await assert.rejects(request("overlapping-implicit-continuation"), /continuation admission in progress/);
    await assert.rejects(request("overlapping-explicit-continuation", f.bundle), /continuation admission in progress/);
    await assert.rejects(force("overlapping-force"), /continuation admission in progress/);
    assert.equal(controller.pendingForceMerges.size, 0);
    assert.equal(f.controller.inspect(f.started.executionId).tasks[0]!.commands.length, 0);
    release!();
    const admitted = (await first).tasks[0]!;
    assert.equal(admitted.state, "queued");
    assert.equal(admitted.pendingContinuation?.instructionId, "only-admitted-continuation");
    assert.deepEqual(admitted.commands.map((command) => command.instructionId), ["only-admitted-continuation"]);
    assert.equal(controller.continuationAdmissions.size, 0);
    await assert.rejects(request("after-admission"), /already active/);
    assert.equal(controller.continuationAdmissions.size, 0, "rejected admissions release their reservation");

    await f.controller.interrupt({ executionId: f.started.executionId, taskId: f.taskId,
      mode: "interrupt_as_failure", instructionId: "stop-admitted", actor: "user" });
    const forceVerifying = pauseRecovery();
    const merging = assert.rejects(force("force-wins-admission"), /main remains unchanged/);
    await forceVerifying;
    assert.ok(controller.pendingForceMerges.has(f.taskId));
    await assert.rejects(request("continue-during-force"), /force-merge in progress/);
    assert.equal(controller.continuationAdmissions.size, 0);
    release!();
    await merging;
    const stopped = f.controller.inspect(f.started.executionId).tasks[0]!;
    assert.equal(stopped.pendingContinuation, undefined);
    assert.equal(stopped.commands.filter((command) => command.action === "continue").length, 1);
    assert.equal(stopped.commands.find((command) => command.action === "continue")?.status, "failed");
    assert.equal(controller.pendingForceMerges.size, 0);
    assert.equal(await readFile(f.calls, "utf8"), calls);
    assert.equal(await readFile(join(f.root, "base.txt"), "utf8"), "parent\n");
    assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
  } finally {
    release?.();
    controller.recoverTaskAssociation = recover;
    await f.cleanup();
  }
});

test("verified association never turns uncertain landing recovery into force-merge permission", async () => {
  const f = await fixture();
  try {
    const path = join(f.bundle.waveRoot, "wave-manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...manifest, landingStatus: "recovery_required" }));
    const task = internals(f.controller).groups.get(f.started.executionId)!.tasks[0]!;
    task.bundle = undefined; task.result = undefined;
    await f.controller.inspectTask(f.started.executionId, f.taskId);
    assert.equal((await inspectOperation(task.bundle!)).manifest.sourceWorkspace.disposition, "recovery_required");
    await assert.rejects(f.controller.forceMerge({ executionId: f.started.executionId, taskId: f.taskId,
      mergeAnyhow: true, instructionId: "unsafe-reland", actor: "user" }), /unresolved landing recovery/);
    assert.equal(await readFile(join(f.root, "base.txt"), "utf8"), "parent\n");
    assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
  } finally { await f.cleanup(); }
});
