import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { continueOperation, inspectOperation } from "../src/execution/operation-actions";
import { executeWave } from "../src/execution/wave-controller";

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
    const bundle = wave.taskResults[0].bundle!;
    const inspection = await inspectOperation(bundle);
    assert.equal(inspection.record.state, "completed");
    assert.equal(inspection.record.checkpoint?.verified, true);

    const continued = await continueOperation({
      bundle: inspection.bundle,
      instructions: "append the next turn marker",
      instructionId: "continuation-1",
      config,
    });
    assert.equal(continued.landing?.status, "landed", JSON.stringify(continued, null, 2));
    assert.equal(await readFile(join(root, "continued.txt"), "utf8"), "turn-1\nturn-2\n");
    assert.equal(continued.inspection.record.instructions[0].status, "acknowledged");

    const duplicate = await continueOperation({
      bundle: continued.inspection.bundle,
      instructions: "must not run twice",
      instructionId: "continuation-1",
      config,
    });
    assert.equal(duplicate.duplicateInstruction, true);
    assert.equal(await readFile(join(root, "continued.txt"), "utf8"), "turn-1\nturn-2\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
