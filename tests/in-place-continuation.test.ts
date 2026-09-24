/** #179: explicit same-worktree (in-place) continuation after a checkpoint
 *  staging failure. Every scenario drives the real wave, operation, and
 *  controller paths with a synthetic run-as-binary executor whose first turn
 *  leaves an absolute symlink that candidate staging rejects. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import { continueOperation, inspectOperation, verifyInPlaceContinuation } from "../src/execution/operation-actions";
import { readOperationRecord, type OperationRecord } from "../src/execution/operation-record";
import { transitionTaskState } from "../src/execution/task-state";
import { executeWave } from "../src/execution/wave-controller";
import { readWaveCaptureRecord } from "../src/execution/wave-repository";
import { createState } from "../src/state";
import { controllerInternals, initGitRepo, waitFor } from "./helpers/background-controller-fixtures";

const execFileAsync = promisify(execFile);

interface TurnLog {
  turn: number;
  cwd: string;
  operation: string;
  staged: string[];
  hasTaskFile: boolean;
  inPlaceDisclosure: boolean;
  resumedDisclosure: boolean;
  freshDisclosure: boolean;
  indexDisclosure: boolean;
  taskText: boolean;
}

/** Turn 1 writes tracked/untracked work plus an absolute symlink that
 *  candidate staging rejects (after `git add .` already staged the index).
 *  While the symlink exists, later turns append a marker and remove it only
 *  when the instruction says REMOVE_ESCAPE; once it is gone, turns (including
 *  post-review confirmation turns) change nothing. */
async function writeExecutor(dir: string, log: string): Promise<string> {
  const executor = join(dir, "in-place-executor.cjs");
  await writeFile(executor, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');",
    "let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    "const turn=Number(process.env.PI_REVIEW_EXECUTOR_TURN);const cwd=process.cwd();",
    "const staged=cp.execFileSync('git',['diff','--cached','--name-only'],{cwd,encoding:'utf8'}).split('\\n').filter(Boolean).sort();",
    "const entry={turn,cwd:fs.realpathSync(cwd),operation:process.env.PI_REVIEW_EXECUTOR_OPERATION,staged,",
    "hasTaskFile:fs.existsSync(path.join(cwd,'task.txt')),",
    "inPlaceDisclosure:prompt.includes('In-place continuation (explicitly requested)'),",
    "resumedDisclosure:prompt.includes('Your previous executor session is being resumed'),",
    "freshDisclosure:prompt.includes('This is a fresh executor session'),",
    "indexDisclosure:prompt.includes('may have staged changes in the Git index'),",
    "taskText:prompt.includes('INPLACE_TASK_SENTINEL')};",
    `fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(entry)+'\\n');`,
    "if(turn===1){fs.writeFileSync('task.txt','task work\\n');fs.appendFileSync('base.txt','edited\\n');fs.symlinkSync('/etc/hosts','escape');}",
    "else{let escape=false;try{fs.lstatSync('escape');escape=true;}catch{}",
    "if(escape){if(prompt.includes('REMOVE_ESCAPE'))fs.rmSync('escape',{force:true});fs.appendFileSync('task.txt',`turn ${turn}\\n`);}}",
    "console.log(JSON.stringify({type:'session',sessionId:'in-place-session'}));",
    "console.log(JSON.stringify({type:'assistant',text:`turn ${turn} done`}));",
    "});",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
  return executor;
}

function executorConfig(executor: string, enabled: boolean, reviewerLog?: string, reviewerVerdict = "pass"): ReviewGateConfig {
  return normalizeConfig({
    enabled,
    review: { activeReviewers: reviewerLog ? [{ source: "external", id: "recording-reviewer" }] : [] },
    externalAgents: {
      "in-place": {
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1", timeoutMs: 30000 },
      },
      ...(reviewerLog ? {
        "recording-reviewer": {
          adapter: "generic-cli",
          command: process.execPath,
          args: [],
          review: {
            args: [
              "-e",
              `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{require('node:fs').appendFileSync(${JSON.stringify(reviewerLog)},JSON.stringify(input)+'\\n');process.stdout.write(JSON.stringify({verdict:${JSON.stringify(reviewerVerdict)},summary:'reviewed',findings:[]}));});`,
            ],
            timeoutMs: 30000,
          },
        },
      } : {}),
    },
    execution: {
      maxWorkers: 1,
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 1 },
      workerResources: { "default": { selection: { source: "external", id: "in-place" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
  });
}

async function readLog(log: string): Promise<TurnLog[]> {
  if (!existsSync(log)) return [];
  return (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as TurnLog);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

/** Working-tree + index + HEAD fingerprint of the retained folder. */
async function folderState(worktree: string): Promise<string> {
  return [
    await git(worktree, "rev-parse", "HEAD"),
    await git(worktree, "status", "--porcelain=v1", "--untracked-files=all"),
    await git(worktree, "diff", "--cached", "--name-only"),
    await readFile(join(worktree, "task.txt"), "utf8"),
  ].join("\n--\n");
}

async function setupRoots(unique: string): Promise<{ root: string; tools: string; log: string; executor: string; cleanup: () => Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `pi-in-place-${unique}-`)));
  const tools = await realpath(await mkdtemp(join(tmpdir(), `pi-in-place-tools-${unique}-`)));
  await initGitRepo(root);
  const log = join(tools, "turns.jsonl");
  const executor = await writeExecutor(tools, log);
  return {
    root, tools, log, executor,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(tools, { recursive: true, force: true });
    },
  };
}

test("in-place continuation reuses exactly the retained folder after staging failure, repeats, and lands a verified candidate while the default stays strict", async () => {
  const fixture = await setupRoots("operation");
  try {
    const config = executorConfig(fixture.executor, false);
    const wave = await executeWave({
      cwd: fixture.root,
      tasks: [{ title: "in-place task", instructions: "INPLACE_TASK_SENTINEL write task.txt", acceptanceCriteria: ["task.txt exists"] }],
      config,
      maxWorkers: 1,
    });
    assert.notEqual(wave.landing?.status, "landed");
    const bundle = wave.taskResults[0]!.bundle!;
    const settled = await inspectOperation(bundle);
    // The worker recorded failed_critical with a checkpointing incident; the
    // lifecycle then settles the operation as paused without a checkpoint.
    assert.equal(settled.record.state, "paused_recoverable");
    assert.equal(settled.record.checkpoint, undefined, "staging failed before any checkpoint existed");
    assert.equal(settled.record.incidents.at(-1)?.stage, "checkpointing");
    assert.equal(settled.record.incidents.at(-1)?.terminalCode, "recovery_state_corrupt_or_unverifiable");
    await assert.rejects(
      continueOperation({ bundle: settled.bundle, instructions: "strict", instructionId: "strict-0", config }),
      /verified recovery checkpoint is missing/,
    );
    // Exercise the failed_critical bypass: the durable critical state is
    // explained by the checkpoint staging incident.
    const critical = await readOperationRecord(join(settled.record.artifactDir, "operation.json"));
    critical.state = "failed_critical";
    await writeFile(join(settled.record.artifactDir, "operation.json"), JSON.stringify(critical, null, 2), "utf8");
    const initial = await inspectOperation(bundle);
    const worktree = await realpath(join(wave.waveRoot, "workers", bundle.taskId));
    assert.equal(await realpath(initial.record.worktreeRoot), worktree);
    // The failed `git add .` already staged the executor's work.
    const stagedAfterFailure = (await git(worktree, "diff", "--cached", "--name-only")).split("\n").filter(Boolean).sort();
    assert.deepEqual(stagedAfterFailure, ["base.txt", "escape", "task.txt"]);
    const before = await folderState(worktree);

    // Strict default: refused, nothing ran, nothing mutated, no instruction.
    await assert.rejects(
      continueOperation({ bundle: initial.bundle, instructions: "strict", instructionId: "strict-1", config }),
      /cannot be continued automatically/,
    );
    assert.equal((await readLog(fixture.log)).length, 1);
    assert.equal(await folderState(worktree), before);
    assert.equal((await inspectOperation(bundle)).record.instructions.length, 0);

    // First explicit in-place attempt: the executor resumes its real session
    // in the same folder, sees the retained index, and fails staging again.
    const first = await continueOperation({
      bundle: (await inspectOperation(bundle)).bundle,
      instructions: "keep going in place",
      instructionId: "in-place-1",
      inPlace: true,
      config,
    });
    assert.equal(first.landing, undefined);
    assert.equal(first.lifecycle?.status, "executor_error");
    let turns = await readLog(fixture.log);
    assert.equal(turns.length, 2);
    const second = turns[1]!;
    assert.equal(second.cwd, worktree, "same retained folder");
    assert.equal(second.operation, "resume", "a valid adapter session is resumed");
    assert.deepEqual(second.staged, ["base.txt", "escape", "task.txt"], "the staged index was preserved");
    assert.equal(second.hasTaskFile, true, "untracked task files were preserved");
    assert.equal(second.inPlaceDisclosure && second.resumedDisclosure && second.indexDisclosure, true);
    assert.equal(second.freshDisclosure, false);
    const afterFirst = await readOperationRecord(join(first.inspection.record.artifactDir, "operation.json"));
    assert.equal(afterFirst.state, "paused_recoverable");
    assert.equal(afterFirst.checkpoint, undefined, "no synthetic checkpoint was invented");
    assert.equal(afterFirst.incidents.filter((incident) => incident.stage === "checkpointing").length, 2);
    assert.deepEqual(afterFirst.instructions.map(({ instructionId, inPlace }) => ({ instructionId, inPlace })), [
      { instructionId: "in-place-1", inPlace: true },
    ]);
    assert.equal(await realpath(afterFirst.worktreeRoot), worktree);
    assert.equal(existsSync(join(worktree, "escape")), true, "the retained folder is left for another explicit attempt");

    // Idempotency: an exact replay is a duplicate; a replay without the flag
    // is refused instead of silently reinterpreted.
    const replay = await continueOperation({
      bundle: first.inspection.bundle, instructions: "keep going in place", instructionId: "in-place-1", inPlace: true, config,
    });
    assert.equal(replay.duplicateInstruction, true);
    await assert.rejects(
      continueOperation({ bundle: first.inspection.bundle, instructions: "keep going", instructionId: "in-place-1", config }),
      /already recorded as an explicit in-place continuation/,
    );
    await assert.rejects(
      continueOperation({ bundle: first.inspection.bundle, instructions: "strict", instructionId: "strict-2", config }),
      /verified recovery checkpoint is missing/,
    );
    assert.equal((await readLog(fixture.log)).length, 2);

    // Without a recorded session the next attempt is a fresh model turn in
    // the same folder with a truthful hidden-state disclosure and the
    // authoritative task text; this time it fixes the staging blocker.
    const cleared = await readOperationRecord(join(first.inspection.record.artifactDir, "operation.json"));
    cleared.session = undefined;
    await writeFile(join(first.inspection.record.artifactDir, "operation.json"), JSON.stringify(cleared, null, 2), "utf8");
    const final = await continueOperation({
      bundle: (await inspectOperation(bundle)).bundle,
      instructions: "REMOVE_ESCAPE and finish",
      instructionId: "in-place-2",
      inPlace: true,
      config,
    });
    assert.equal(final.landing?.status, "landed", JSON.stringify(final.lifecycle, null, 2));
    turns = await readLog(fixture.log);
    assert.equal(turns.length, 3);
    const third = turns[2]!;
    assert.equal(third.cwd, worktree);
    assert.equal(third.operation, "start");
    assert.equal(third.inPlaceDisclosure && third.freshDisclosure && third.taskText, true);
    assert.equal(third.resumedDisclosure, false);
    assert.equal(await readFile(join(fixture.root, "task.txt"), "utf8"), "task work\nturn 2\nturn 3\n");
    assert.equal(await readFile(join(fixture.root, "base.txt"), "utf8"), "base\nedited\n");
    assert.equal(existsSync(join(fixture.root, "escape")), false);
    const landed = await readOperationRecord(join(final.inspection.record.artifactDir, "operation.json"));
    assert.equal(landed.state, "landed");
    assert.equal(landed.checkpoint?.verified, true, "the eventual candidate was checkpointed and verified");
    assert.ok(landed.incidents
      .filter((incident) => incident.terminalCode === "recovery_state_corrupt_or_unverifiable")
      .every((incident) => incident.resolution === "in_place_continuation_checkpoint_verified"));
  } finally {
    await fixture.cleanup();
  }
});

test("in-place continuation fails closed for missing, foreign, attached, live, uncertain, landing-recovery, and unrelated critical state without touching the folder", async () => {
  const fixture = await setupRoots("refusals");
  try {
    const config = executorConfig(fixture.executor, false);
    const wave = await executeWave({
      cwd: fixture.root,
      tasks: [{ title: "refusal task", instructions: "INPLACE_TASK_SENTINEL write task.txt", acceptanceCriteria: ["task.txt exists"] }],
      config,
      maxWorkers: 1,
    });
    const bundle = wave.taskResults[0]!.bundle!;
    const inspection = await inspectOperation(bundle);
    const recordPath = join(inspection.record.artifactDir, "operation.json");
    const originalRecord = await readFile(recordPath, "utf8");
    const worktree = await realpath(join(wave.waveRoot, "workers", bundle.taskId));
    const capture = await readWaveCaptureRecord(wave.waveRoot);
    const before = await folderState(worktree);
    const manifest = { landingStatus: undefined as string | undefined };

    // The unmodified retained state passes the read-only preflight.
    const preflight = await verifyInPlaceContinuation({ waveRoot: wave.waveRoot, record: inspection.record, capture, manifest });
    assert.equal(preflight.headCommit, capture.baseCommit);
    assert.equal(preflight.checkpointVerified, false);
    assert.equal(preflight.checkpointIncident?.stage, "checkpointing");

    const refuse = async (label: string, mutate: (record: OperationRecord) => void | Promise<void>, pattern: RegExp, landingStatus?: string) => {
      const record = JSON.parse(originalRecord) as OperationRecord;
      await mutate(record);
      await assert.rejects(
        verifyInPlaceContinuation({ waveRoot: wave.waveRoot, record, capture, manifest: { landingStatus } }),
        pattern,
        label,
      );
    };
    await refuse("live writer", (record) => {
      record.owner = { version: 1, instanceId: "live", hostPid: process.pid, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), status: "active" };
    }, /live or uncertain writer/);
    await refuse("uncertain writer", (record) => {
      record.owner = { version: 1, instanceId: "uncertain", hostPid: 0, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), status: "active" };
    }, /live or uncertain writer/);
    await refuse("unowned active state", (record) => {
      record.owner = undefined;
      record.state = "running";
    }, /predates durable writer ownership/);
    await refuse("landing recovery status", () => undefined, /never bypasses landing-rollback recovery/, "recovery_required");
    await refuse("landing rollback incident", (record) => {
      record.incidents.push({ ...record.incidents.at(-1)!, incidentId: "landing", cause: "landing_error", stage: "landing", terminalCode: "landing_rollback_incomplete" });
    }, /landing_rollback_incomplete/);
    await refuse("unrelated failed_critical", (record) => {
      record.state = "failed_critical";
      for (const incident of record.incidents) delete incident.terminalCode;
    }, /not explained by a durable checkpoint staging\/verification incident/);
    await refuse("failed_critical after a later non-checkpoint terminal incident", (record) => {
      record.state = "failed_critical";
      record.incidents.push({ ...record.incidents.at(-1)!, incidentId: "other", stage: "other", terminalCode: "other" as never });
    }, /latest terminal incident: other\/other/);
    const bypass = JSON.parse(originalRecord) as OperationRecord;
    bypass.state = "failed_critical";
    assert.equal(
      (await verifyInPlaceContinuation({ waveRoot: wave.waveRoot, record: bypass, capture, manifest })).checkpointIncident?.stage,
      "checkpointing",
      "failed_critical explained by a checkpoint staging incident is bypassable",
    );
    await refuse("landed", (record) => { record.state = "landed"; }, /already landed/);
    await refuse("foreign folder", (record) => {
      record.worktreeRoot = fixture.root;
      record.effectiveCwd = fixture.root;
    }, /is not this task's managed worktree/);

    // Attached HEAD (made unborn-symbolic without touching the index).
    await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/in-place-attached"], { cwd: worktree });
    await refuse("attached HEAD", () => undefined, /HEAD is attached/);
    await execFileAsync("git", ["update-ref", "--no-deref", "HEAD", capture.baseCommit], { cwd: worktree });

    // Missing folder: refused with guidance, never recreated.
    const moved = `${worktree}-moved`;
    await rename(worktree, moved);
    await assert.rejects(
      continueOperation({ bundle: inspection.bundle, instructions: "missing", instructionId: "missing-1", inPlace: true, config }),
      /retained worktree .* no longer exists.*never recreates/,
    );
    assert.equal(existsSync(worktree), false, "the missing folder was not recreated");
    await rename(moved, worktree);

    // The operation path refuses a live writer before any executor turn and
    // records no instruction.
    const live = JSON.parse(originalRecord) as OperationRecord;
    live.owner = { version: 1, instanceId: "live", hostPid: process.pid, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), status: "active" };
    await writeFile(recordPath, JSON.stringify(live, null, 2), "utf8");
    await assert.rejects(
      continueOperation({ bundle: (await inspectOperation(bundle)).bundle, instructions: "live", instructionId: "live-1", inPlace: true, config }),
      /live or uncertain writer/,
    );
    await writeFile(recordPath, originalRecord, "utf8");

    assert.equal((await readLog(fixture.log)).length, 1, "no refused attempt reached an executor");
    assert.equal(await folderState(worktree), before, "no refusal created, reset, checked out, cleaned, or staged anything");
    assert.equal((await readOperationRecord(recordPath)).instructions.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("controller in-place admission is explicit, gated, idempotent, and repeatable through normal landing", async () => {
  const fixture = await setupRoots("controller");
  const config = executorConfig(fixture.executor, true);
  const controller = new BackgroundExecutionController({ config, state: createState(), cwd: () => fixture.root, pi: {} });
  try {
    const started = await controller.start([{
      title: "controller in-place task",
      instructions: "INPLACE_TASK_SENTINEL write task.txt",
      acceptanceCriteria: ["task.txt exists"],
    }]);
    const executionId = started.executionId;
    const taskId = started.tasks[0]!.taskId;
    const task = () => controllerInternals(controller).groups.get(executionId)!.tasks.find((candidate) => candidate.taskId === taskId)!;
    const idle = () => !(controller as unknown as { runtimes: Map<string, unknown> }).runtimes.has(taskId);
    await waitFor(() => task().state === "paused_recoverable" && idle(), 30_000);
    const worktree = await realpath(join(task().waveRoot!, "workers", taskId));
    const recordPath = join(task().waveRoot!, "artifacts", taskId, "operation.json");

    // Strict default is admitted as before but refused at dispatch without
    // running the executor.
    await controller.continueTask({ executionId, taskId, instructions: "strict", instructionId: "strict-1", actor: "user" });
    await waitFor(() => task().state === "failed" && idle(), 30_000);
    const strict = task().commands.find((command) => command.instructionId === "strict-1")!;
    assert.equal(strict.status, "failed");
    assert.match(strict.error ?? "", /verified recovery checkpoint is missing/);
    assert.equal(strict.inPlace, undefined);
    assert.equal((await readLog(fixture.log)).length, 1);
    const before = await folderState(worktree);
    const commandCount = task().commands.length;

    const inPlace = (instructionId: string, instructions = "keep going in place") =>
      controller.continueTask({ executionId, taskId, instructions, instructionId, actor: "user", inPlace: true });

    // Gates refuse at admission, leaving task state and commands untouched.
    transitionTaskState(task(), "conflicted");
    await assert.rejects(inPlace("gate-1"), /outstanding landing conflict gate/);
    transitionTaskState(task(), "failed");
    const moved = `${worktree}-moved`;
    await rename(worktree, moved);
    await assert.rejects(inPlace("missing-1"), /no longer exists/);
    await rename(moved, worktree);
    const originalRecord = await readFile(recordPath, "utf8");
    const live = JSON.parse(originalRecord) as OperationRecord;
    live.owner = { version: 1, instanceId: "live", hostPid: process.pid, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), status: "active" };
    await writeFile(recordPath, JSON.stringify(live, null, 2), "utf8");
    await assert.rejects(inPlace("live-1"), /live writer/);
    await writeFile(recordPath, originalRecord, "utf8");
    await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/in-place-attached"], { cwd: worktree });
    await assert.rejects(inPlace("attached-1"), /HEAD is attached/);
    const base = (await readWaveCaptureRecord(task().waveRoot!)).baseCommit;
    await execFileAsync("git", ["update-ref", "--no-deref", "HEAD", base], { cwd: worktree });
    assert.equal(task().state, "failed");
    assert.equal(task().commands.length, commandCount);
    assert.equal(await folderState(worktree), before);
    assert.equal((await readLog(fixture.log)).length, 1);

    // Explicit admission: one canonical flag on the command; the pending
    // pointer carries only the instruction identity and text.
    await inPlace("in-place-1");
    const admitted = task().commands.filter((command) => command.instructionId === "in-place-1");
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0]!.inPlace, true);
    const pending = task().pendingContinuation;
    if (pending) assert.deepEqual(Object.keys(pending).sort(), ["instructionId", "instructions"]);
    await waitFor(() => task().state === "paused_recoverable" && admitted[0]!.status === "acknowledged" && idle(), 30_000);
    let turns = await readLog(fixture.log);
    assert.equal(turns.length, 2);
    assert.equal(turns[1]!.cwd, worktree);
    assert.deepEqual(turns[1]!.staged, ["base.txt", "escape", "task.txt"]);
    assert.equal(turns[1]!.inPlaceDisclosure, true);
    const operation = await readOperationRecord(recordPath);
    assert.equal(operation.state, "paused_recoverable");
    assert.equal(operation.checkpoint, undefined);
    assert.equal(operation.instructions.find((instruction) => instruction.instructionId === "in-place-1")?.inPlace, true);

    // Idempotent replay and mismatched replay.
    await inPlace("in-place-1");
    assert.equal(task().commands.filter((command) => command.instructionId === "in-place-1").length, 1);
    await assert.rejects(
      controller.continueTask({ executionId, taskId, instructions: "x", instructionId: "in-place-1", actor: "user" }),
      /already admitted as an explicit in-place continuation/,
    );
    await assert.rejects(inPlace("strict-1"), /without the in-place opt-in/);
    assert.equal((await readLog(fixture.log)).length, 2);

    // A second explicit attempt fixes the blocker; the verified candidate
    // follows the ordinary landing path.
    await inPlace("in-place-2", "REMOVE_ESCAPE and finish");
    await waitFor(() => task().state === "landed", 30_000);
    turns = await readLog(fixture.log);
    assert.equal(turns.length, 3);
    assert.equal(turns[2]!.cwd, worktree);
    assert.equal(await readFile(join(fixture.root, "task.txt"), "utf8"), "task work\nturn 2\nturn 3\n");
    assert.equal(existsSync(join(fixture.root, "escape")), false);
    const landed = await readOperationRecord(recordPath);
    assert.equal(landed.state, "landed");
    assert.equal(landed.checkpoint?.verified, true);
  } finally {
    await controller.shutdown().catch(() => undefined);
    await fixture.cleanup();
  }
});

test("an in-place candidate is checkpointed and passes through the ordinary review gate before landing", async () => {
  const fixture = await setupRoots("reviewed");
  try {
    const reviewerLog = join(fixture.tools, "reviews.jsonl");
    const config = executorConfig(fixture.executor, true, reviewerLog);
    const wave = await executeWave({
      cwd: fixture.root,
      tasks: [{ title: "reviewed in-place task", instructions: "INPLACE_TASK_SENTINEL write task.txt", acceptanceCriteria: ["task.txt exists"] }],
      config,
      maxWorkers: 1,
    });
    assert.notEqual(wave.landing?.status, "landed");
    assert.equal(existsSync(reviewerLog), false, "a failed checkpoint is never reviewed");
    const bundle = wave.taskResults[0]!.bundle!;
    const continued = await continueOperation({
      bundle: (await inspectOperation(bundle)).bundle,
      instructions: "REMOVE_ESCAPE and finish",
      instructionId: "reviewed-in-place-1",
      inPlace: true,
      config,
    });
    assert.equal(continued.landing?.status, "landed", JSON.stringify(continued.lifecycle, null, 2));
    const lifecycle = continued.lifecycle!;
    assert.equal(lifecycle.status, "accepted");
    const finalCycle = lifecycle.reviewCycles.at(-1);
    assert.ok(finalCycle, "the in-place candidate recorded a review cycle");
    assert.equal(lifecycle.acceptedCommitSha, finalCycle.candidateCommit);
    const reviews = (await readFile(reviewerLog, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string);
    assert.ok(reviews.length >= 1);
    assert.ok(reviews.some((review) => review.includes("task.txt")), "the reviewer saw the retained work");
    assert.ok(reviews.every((review) => !review.includes("/etc/hosts")), "the rejected symlink never reached review");
    assert.equal(await readFile(join(fixture.root, "task.txt"), "utf8"), "task work\nturn 2\n");
  } finally {
    await fixture.cleanup();
  }
});

/** Shared restore/shutdown fixture: runs the initial #179 wave to a checkpoint
 *  staging failure, admits an explicit in-place continuation that is never
 *  dispatched (worker capacity is cut to zero first), and stops the controller
 *  for application exit so a same-conversation restore sees
 *  stopped_for_application_exit with a queued in-place command. */
async function admittedUndispatchedFixture(unique: string, instructionId: string, instructions: string) {
  const fixture = await setupRoots(unique);
  const config = executorConfig(fixture.executor, true);
  const controller = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => fixture.root });
  const started = await controller.start([
    { title: `restore ${unique} task`, instructions: "INPLACE_TASK_SENTINEL write task.txt", acceptanceCriteria: ["task.txt exists"] },
  ]);
  const executionId = started.executionId;
  const taskId = started.tasks[0]!.taskId;
  const task = () => controllerInternals(controller).groups.get(executionId)!.tasks.find((candidate) => candidate.taskId === taskId)!;
  const idle = () => !(controller as unknown as { runtimes: Map<string, unknown> }).runtimes.has(taskId);
  await waitFor(() => task().state === "paused_recoverable" && idle(), 30_000);
  const worktree = await realpath(join(task().waveRoot!, "workers", taskId));
  // Hold the admitted continuation undispatched: no worker capacity.
  config.execution!.maxWorkers = 0;
  await controller.continueTask({ executionId, taskId, instructions, instructionId, actor: "user", inPlace: true });
  assert.equal(task().state, "queued", "precondition: the in-place continuation was admitted but not dispatched");
  const associations = controller.associations();
  await controller.shutdown();
  assert.equal(task().state, "stopped_for_application_exit");
  assert.equal(task().commands.find((command) => command.instructionId === instructionId)?.inPlace, true);
  return {
    fixture, controller, executionId, taskId, task, worktree, associations,
    cleanup: async () => {
      await controller.shutdown().catch(() => undefined);
      await fixture.cleanup();
    },
  };
}

test("restore re-verifies an admitted-but-undispatched in-place continuation and resumes it without substituting a strict auto-resume", async () => {
  const setup = await admittedUndispatchedFixture("restore-resume", "in-place-restore-1", "REMOVE_ESCAPE and finish");
  let restored: BackgroundExecutionController | undefined;
  try {
    const notifications: string[] = [];
    restored = new BackgroundExecutionController({
      pi: {},
      config: executorConfig(setup.fixture.executor, true),
      state: createState(),
      cwd: () => setup.fixture.root,
      notify: (message) => { notifications.push(message); },
    });
    await restored.restore(setup.associations);
    const restoredTask = () => controllerInternals(restored!).groups.get(setup.executionId)!.tasks
      .find((candidate) => candidate.taskId === setup.taskId)!;
    await waitFor(() => restoredTask().state === "landed", 60_000);
    const command = restoredTask().commands.find((candidate) => candidate.instructionId === "in-place-restore-1")!;
    assert.equal(command.inPlace, true, "the original in-place flag remains the canonical record after restore");
    assert.equal(command.status, "acknowledged");
    assert.equal(
      restoredTask().commands.some((candidate) => candidate.instructionId.startsWith("application-resume-")),
      false,
      "no strict system auto-resume was substituted for the admitted in-place instruction",
    );
    const turns = await readLog(setup.fixture.log);
    assert.ok(turns.length >= 2, "the restored continuation reached the executor");
    const resumed = turns.at(-1)!;
    assert.equal(resumed.cwd, setup.worktree, "the retained worktree was reused exactly");
    assert.equal(resumed.inPlaceDisclosure, true, "the executor was told this is an explicit in-place continuation");
    assert.ok(
      turns.slice(1).every((turn) => turn.inPlaceDisclosure),
      "every post-restart turn carried the in-place disclosure, never the strict resume preamble alone",
    );
    assert.equal(await readFile(join(setup.fixture.root, "task.txt"), "utf8"), "task work\nturn 2\n");
  } finally {
    await restored?.shutdown().catch(() => undefined);
    await setup.cleanup();
  }
});

test("restore fails closed and preserves the admitted in-place instruction when its re-verification refuses", async () => {
  const setup = await admittedUndispatchedFixture("restore-refuse", "in-place-refuse-1", "REMOVE_ESCAPE and finish");
  let restored: BackgroundExecutionController | undefined;
  try {
    // Divergence that appeared while the application was down: the retained
    // managed worktree no longer sits on a detached HEAD.
    await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/in-place-attached"], { cwd: setup.worktree });
    const notifications: string[] = [];
    restored = new BackgroundExecutionController({
      pi: {},
      config: executorConfig(setup.fixture.executor, true),
      state: createState(),
      cwd: () => setup.fixture.root,
      notify: (message) => { notifications.push(message); },
    });
    await restored.restore(setup.associations);
    const restoredTask = () => controllerInternals(restored!).groups.get(setup.executionId)!.tasks
      .find((candidate) => candidate.taskId === setup.taskId)!;
    const task = restoredTask();
    assert.equal(task.state, "paused_recoverable");
    assert.match(task.summary ?? "", /Admitted in-place continuation could not be re-verified after restart/);
    assert.ok(
      notifications.some((message) => message.includes(setup.taskId) && /admitted in-place continuation was not resumed after restart/.test(message)),
      "the orchestrator was notified about the refused re-verification",
    );
    assert.ok(
      task.activity.some((event) => event.phase === "recovery" && /In-place continuation re-verification refused after restart/.test(event.message)),
    );
    const command = task.commands.find((candidate) => candidate.instructionId === "in-place-refuse-1")!;
    assert.equal(command.inPlace, true, "the original instruction and flag are preserved, not overwritten");
    assert.equal(command.status, "queued");
    assert.deepEqual(task.pendingContinuation, { instructions: "REMOVE_ESCAPE and finish", instructionId: "in-place-refuse-1" });
    assert.equal(
      task.commands.some((candidate) => candidate.instructionId.startsWith("application-resume-")),
      false,
      "no strict auto-resume was queued behind the preserved instruction",
    );
    await waitFor(() => !(restored as unknown as { runtimes: Map<string, unknown> }).runtimes.has(setup.taskId), 10_000);
    assert.equal((await readLog(setup.fixture.log)).length, 1, "no executor ran after the refused restore");
    assert.equal(await git(setup.worktree, "symbolic-ref", "-q", "HEAD"), "refs/heads/in-place-attached", "the folder was never touched by the gate");
  } finally {
    await restored?.shutdown().catch(() => undefined);
    await setup.cleanup();
  }
});

test("restore refuses an admitted in-place continuation while the operation still has a live writer and preserves the original instruction", async () => {
  // Mechanism note: at restore time the loop's checkpoint backfill
  // (recoverTaskAssociation without inPlace) throws on inspectOperation's live
  // writer and pauses the task before restoreAdmittedInPlaceContinuation is
  // evaluated. The helper's own writer-quiescence gate is exercised at
  // admission time by the existing "live-1" refusal; this test pins that the
  // restore loop fails closed the same way without ever overwriting the
  // admitted in-place instruction with a strict auto-resume.
  const setup = await admittedUndispatchedFixture("restore-live", "in-place-live-1", "REMOVE_ESCAPE and finish");
  let restored: BackgroundExecutionController | undefined;
  try {
    const recordPath = join(setup.task().waveRoot!, "artifacts", setup.taskId, "operation.json");
    const originalRecord = await readFile(recordPath, "utf8");
    const live = JSON.parse(originalRecord) as OperationRecord;
    live.owner = { version: 1, instanceId: "live", hostPid: process.pid, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), status: "active" };
    await writeFile(recordPath, JSON.stringify(live, null, 2), "utf8");
    restored = new BackgroundExecutionController({
      pi: {},
      config: executorConfig(setup.fixture.executor, true),
      state: createState(),
      cwd: () => setup.fixture.root,
    });
    await restored.restore(setup.associations);
    const restoredTask = () => controllerInternals(restored!).groups.get(setup.executionId)!.tasks
      .find((candidate) => candidate.taskId === setup.taskId)!;
    const task = restoredTask();
    assert.equal(task.state, "paused_recoverable", "restore pauses the task while the writer is not proven quiescent");
    assert.ok(
      task.activity.some((event) => event.phase === "recovery" && /Checkpoint backfill refused: .*live writer/.test(event.message)),
      "the restore-time recovery refused on writer quiescence",
    );
    const command = task.commands.find((candidate) => candidate.instructionId === "in-place-live-1")!;
    assert.equal(command.inPlace, true, "the original instruction and flag are preserved, not overwritten");
    assert.equal(command.status, "queued");
    assert.deepEqual(task.pendingContinuation, { instructions: "REMOVE_ESCAPE and finish", instructionId: "in-place-live-1" });
    assert.equal(
      task.commands.some((candidate) => candidate.instructionId.startsWith("application-resume-")),
      false,
      "no strict auto-resume was queued while the writer is live",
    );
    await waitFor(() => !(restored as unknown as { runtimes: Map<string, unknown> }).runtimes.has(setup.taskId), 10_000);
    assert.equal((await readLog(setup.fixture.log)).length, 1, "no executor ran while the writer was live");
  } finally {
    await restored?.shutdown().catch(() => undefined);
    await setup.cleanup();
  }
});

test("a verified checkpoint refuses explicit in-place continuation instead of silently omitting checkpointed work", async () => {
  const fixture = await setupRoots("checkpointed");
  try {
    // A clean executor whose turn 1 stages successfully (checkpoint verified)
    // plus a reviewer that always errors: the wave settles unlanded with a
    // verified checkpoint and the retained worktree.
    const executor = join(fixture.tools, "checkpointed-executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "const turn=Number(process.env.PI_REVIEW_EXECUTOR_TURN);",
      "if(turn===1)fs.writeFileSync('task.txt','task work\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:'checkpointed-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:`turn ${turn} done`}));",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const reviewerLog = join(fixture.tools, "reviews.jsonl");
    const config = executorConfig(executor, true, reviewerLog, "error");
    const wave = await executeWave({
      cwd: fixture.root,
      tasks: [{ title: "checkpointed in-place task", instructions: "INPLACE_TASK_SENTINEL write task.txt", acceptanceCriteria: ["task.txt exists"] }],
      config,
      maxWorkers: 1,
    });
    assert.notEqual(wave.landing?.status, "landed");
    const bundle = wave.taskResults[0]!.bundle!;
    const inspection = await inspectOperation(bundle);
    assert.equal(inspection.record.state, "paused_recoverable", "precondition: the wave stopped unlanded");
    assert.equal(inspection.record.checkpoint?.verified, true, "precondition: a verified checkpoint exists");
    const worktreePath = join(wave.waveRoot, "workers", bundle.taskId);
    const capture = await readWaveCaptureRecord(wave.waveRoot);
    // The settled wave removed the clean worktree; recreate the retained
    // folder at its exact managed path, detached at the base, so it sits
    // behind the verified checkpoint (HEAD and tree at the base; the
    // checkpointed work lives only in its ref).
    await mkdir(dirname(worktreePath), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, capture.baseCommit], { cwd: capture.repositoryPath });
    const worktree = await realpath(worktreePath);
    const afterReset = [
      await git(worktree, "rev-parse", "HEAD"),
      await git(worktree, "status", "--porcelain=v1", "--untracked-files=all"),
    ].join("\n");
    const resumed = await inspectOperation(bundle);
    await assert.rejects(
      verifyInPlaceContinuation({ waveRoot: wave.waveRoot, record: resumed.record, capture, manifest: {} }),
      /verified recovery checkpoint .*in-place continuation is refused/,
    );
    await assert.rejects(
      continueOperation({
        bundle: resumed.bundle,
        instructions: "in place again",
        instructionId: "behind-1",
        inPlace: true,
        config,
      }),
      /in-place continuation is refused/,
    );
    // The refusal is read-only: nothing was reset, copied, or reconciled, and
    // no instruction was recorded. The checkpointed work stays intact in its
    // verified ref for the ordinary strict path.
    assert.equal([
      await git(worktree, "rev-parse", "HEAD"),
      await git(worktree, "status", "--porcelain=v1", "--untracked-files=all"),
    ].join("\n"), afterReset, "the refused admission never reset, copied, or reconciled the retained folder");
    assert.equal(
      (await readOperationRecord(join(resumed.record.artifactDir, "operation.json"))).instructions.some((instruction) => instruction.instructionId === "behind-1"),
      false,
      "the refused attempt recorded no instruction",
    );
    const strictGate = await inspectOperation(resumed.bundle);
    assert.equal(strictGate.record.checkpoint?.verified, true, "the ordinary strict Continue path remains available on the verified checkpoint");
  } finally {
    await fixture.cleanup();
  }
});
