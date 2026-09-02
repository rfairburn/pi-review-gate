import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { continueOperation, inspectOperation, inspectWaveRoot } from "../src/execution/operation-actions";
import { executeWave } from "../src/execution/wave-controller";
import { readOperationRecord, writeOperationRecord } from "../src/execution/operation-record";
import type { ContinuationProgressUpdate } from "../src/execution/types";

const execFileAsync = promisify(execFile);

test("landed operation can rehydrate its checkpoint, continue, land, and deduplicate instruction ids", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-operation-actions-")));
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "README.md"), "base\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: root });

    const script = [
      "process.stdin.resume();process.stdin.on('end',()=>{",
      "const fs=require('node:fs'),path=require('node:path');",
      "const turn=process.env.PI_REVIEW_EXECUTOR_TURN;",
      "fs.appendFileSync(path.join(process.cwd(),'continued.txt'),`turn-${turn}\\n`);",
      "console.log(JSON.stringify({type:'session',sessionId:'durable-operation-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:`completed turn ${turn}`}));",
      "});",
    ].join("");
    const config = normalizeConfig({
      enabled: false,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "continuable",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", script], timeoutMs: 30_000 },
      }],
      execution: {
        activeExecutor: { source: "external", id: "continuable" },
        retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 1 },
      },
    });
    const wave = await executeWave({
      cwd: root,
      tasks: [{ title: "continuable", instructions: "write the turn marker", acceptanceCriteria: ["marker exists"] }],
      config,
      maxWorkers: 1,
    });
    assert.equal(wave.landing?.status, "landed");
    const waveInspection = await inspectWaveRoot(wave.waveRoot);
    assert.equal(waveInspection.ownership.status, "released");
    assert.equal(waveInspection.bundles.length, 1);
    assert.equal(waveInspection.manifest.tasks[0]?.task?.instructions, "write the turn marker");
    const bundle = wave.taskResults[0].bundle!;
    const inspection = await inspectOperation(bundle);
    assert.equal(inspection.record.state, "completed");
    assert.equal(inspection.record.checkpoint?.verified, true);

    const progress: ContinuationProgressUpdate[] = [];
    const continued = await continueOperation({
      bundle: inspection.bundle,
      instructions: "append the next turn marker",
      instructionId: "continuation-1",
      config,
      onUpdate: (update) => progress.push(update),
    });
    assert.equal(continued.landing?.status, "landed", JSON.stringify(continued, null, 2));
    assert.equal(await readFile(join(root, "continued.txt"), "utf8"), "turn-1\nturn-2\n");
    assert.equal(continued.inspection.record.instructions[0].status, "acknowledged");
    assert.ok(progress.some((update) => update.phase === "executing"));
    assert.ok(progress.some((update) => update.phase === "accepted"));
    assert.ok(progress.some((update) => update.phase === "integrating"));
    assert.ok(progress.some((update) => update.phase === "landing"));

    // The continuation manifest must be published durably: restrictive mode,
    // no temp litter.
    const manifestPath = join(wave.waveRoot, "wave-manifest.json");
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
    assert.equal(
      (await readdir(wave.waveRoot)).some((name) => name.startsWith("wave-manifest.json.tmp.")),
      false,
      "no continuation-manifest temp litter may survive",
    );

    const duplicate = await continueOperation({
      bundle: continued.inspection.bundle,
      instructions: "must not run twice",
      instructionId: "continuation-1",
      config,
    });
    assert.equal(duplicate.duplicateInstruction, true);
    assert.equal(await readFile(join(root, "continued.txt"), "utf8"), "turn-1\nturn-2\n");

    const tamperedRecord = await readOperationRecord(`${continued.inspection.record.artifactDir}/operation.json`);
    tamperedRecord.checkpoint!.treeSha = "0".repeat(40);
    await writeOperationRecord(tamperedRecord);
    const tamperedInspection = await inspectOperation(continued.inspection.bundle);
    assert.equal(tamperedInspection.checkpointVerification.status, "invalid");
    assert.ok(!tamperedInspection.safeActions.includes("continue"));
    await assert.rejects(
      continueOperation({
        bundle: tamperedInspection.bundle,
        instructions: "must not run from a corrupt checkpoint",
        instructionId: "continuation-corrupt",
        config,
      }),
      /checkpoint verification failed/i,
    );
    const blockedRecord = await readOperationRecord(`${continued.inspection.record.artifactDir}/operation.json`);
    assert.equal(blockedRecord.state, "failed_critical");
    assert.equal(blockedRecord.incidents.at(-1)?.terminalCode, "recovery_state_corrupt_or_unverifiable");
    assert.equal(await readFile(join(root, "continued.txt"), "utf8"), "turn-1\nturn-2\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuing one task lands only that task and leaves an already-landed sibling untouched", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-operation-order-")));
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "README.md"), "base\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: root });

    const script = [
      "let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{",
      "const fs=require('node:fs'),path=require('node:path');",
      "const turn=process.env.PI_REVIEW_EXECUTOR_TURN;",
      "const first=turn!=='1'||/First task/i.test(input);",
      "const file=first?'first.txt':'second.txt';",
      "fs.appendFileSync(path.join(process.cwd(),file),`turn-${turn}\\n`);",
      "console.log(JSON.stringify({type:'session',sessionId:first?'ordered-first':'ordered-second'}));",
      "console.log(JSON.stringify({type:'assistant',text:`completed ${file} turn ${turn}`}));",
      "});",
    ].join("");
    const config = normalizeConfig({
      enabled: false,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "ordered",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", script], timeoutMs: 30_000 },
      }],
      execution: {
        activeExecutor: { source: "external", id: "ordered" },
        retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 1 },
      },
    });
    const wave = await executeWave({
      cwd: root,
      tasks: [
        { title: "First task", instructions: "write first.txt", acceptanceCriteria: ["first marker exists"] },
        { title: "Second task", instructions: "write second.txt", acceptanceCriteria: ["second marker exists"] },
      ],
      config,
      maxWorkers: 2,
    });
    assert.equal(wave.landing?.status, "landed", JSON.stringify(wave, null, 2));

    const first = await inspectOperation(wave.taskResults[0].bundle!);
    const continued = await continueOperation({
      bundle: first.bundle,
      instructions: "Continue the First task and append its second marker.",
      instructionId: "continue-first-in-order",
      config,
    });

    assert.equal(continued.landing?.status, "landed", JSON.stringify(continued, null, 2));
    assert.equal(continued.integration?.status, "integrated", JSON.stringify(continued, null, 2));
    if (continued.integration?.status !== "integrated") assert.fail("continuation was not integrated");
    assert.deepEqual(
      continued.integration.workerMappings.map((mapping) => mapping.taskId),
      ["task-0"],
    );
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "turn-1\nturn-2\n");
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "turn-1\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a confirmed-dead writer can be reconciled and continued in a fresh executor session", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-operation-restart-")));
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "README.md"), "base\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: root });

    const script = [
      "process.stdin.resume();process.stdin.on('end',()=>{",
      "const fs=require('node:fs'),path=require('node:path');",
      "const turn=process.env.PI_REVIEW_EXECUTOR_TURN;",
      "fs.appendFileSync(path.join(process.cwd(),'restart.txt'),`turn-${turn}\\n`);",
      "console.log(JSON.stringify({type:'session',sessionId:`restart-${turn}`}));",
      "console.log(JSON.stringify({type:'assistant',text:`completed turn ${turn}`}));",
      "});",
    ].join("");
    const config = normalizeConfig({
      enabled: false,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "restartable",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", script], timeoutMs: 30_000 },
      }],
      execution: {
        activeExecutor: { source: "external", id: "restartable" },
        retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 1 },
      },
    });
    const wave = await executeWave({
      cwd: root,
      tasks: [{ title: "restartable", instructions: "write restart.txt", acceptanceCriteria: ["marker exists"] }],
      config,
      maxWorkers: 1,
    });
    assert.equal(wave.landing?.status, "landed", JSON.stringify(wave, null, 2));
    const originalBundle = wave.taskResults[0].bundle!;
    const originalInspection = await inspectOperation(originalBundle);
    const record = await readOperationRecord(originalInspection.record.artifactDir + "/operation.json");
    record.session = undefined;
    record.state = "running";
    record.owner = {
      version: 1,
      instanceId: "crashed-host",
      hostPid: 2_147_483_647,
      childPid: 2_147_483_646,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      status: "active",
    };
    await writeOperationRecord(record);

    const abandoned = await inspectOperation(originalBundle);
    assert.equal(abandoned.live, false);
    assert.ok(abandoned.safeActions.includes("continue"));
    const continued = await continueOperation({
      bundle: abandoned.bundle,
      instructions: "append after the application restart",
      instructionId: "restart-continuation",
      config,
    });
    assert.equal(continued.landing?.status, "landed", JSON.stringify(continued, null, 2));
    assert.equal(await readFile(join(root, "restart.txt"), "utf8"), "turn-1\nturn-2\n");
    assert.ok(continued.inspection.record.incidents.some((incident) => incident.stage === "application_restart"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
