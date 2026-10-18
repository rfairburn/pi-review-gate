"use strict";
/*
 * Isolated real-executor regression for #412.
 *
 * Uses the REAL production BackgroundExecutionController, the real
 * run-as-binary adapter, and a real blocking OS child. It intentionally does
 * not load the synthetic native-host harness: this scenario proves executor
 * startup and positive quiescence (readiness acknowledgement keyed to the exact
 * pid, then that pid's exit acknowledgement), while the host/reporter/broker/
 * sidebar chain is covered by the other scenarios.
 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const DIST = join(process.cwd(), "dist-test");
const { BackgroundExecutionController } = require(join(DIST, "src", "execution", "background-controller.js"));
const { normalizeConfig } = require(join(DIST, "src", "config.js"));
const { createState } = require(join(DIST, "src", "state.js"));
const { activateOwnedActivity, activeActivitySnapshot } = require(join(DIST, "src", "session-host", "owned-activity.js"));
const { registerReviewActivitySource } = require(join(DIST, "src", "activation", "review-activity.js"));
const WORKER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-412-running-worker.cjs");
const FAIL_AFTER_READY = process.env.PRG_412_EXECUTOR_FAIL_AFTER_READY === "1";

function filesIn(directory) {
  try { return readdirSync(directory); } catch { return []; }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function waitUntil(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!predicate()) throw new Error(`bounded wait expired: ${label}`);
}

function executorConfig(readyDir, exitDir) {
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      worker: {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [WORKER_FIXTURE],
          env: { PRG_412_WORKER_READY_DIR: readyDir, PRG_412_WORKER_EXIT_DIR: exitDir },
        },
      },
    },
    execution: {
      maxWorkers: 1,
      workerResources: { worker: { selection: { source: "external", id: "worker" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "worker" }], research: [] },
      retryPolicy: { maxRetries: 0, maxSameIncidentRepeats: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    },
  });
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), "prg-412-real-executor-"));
  const readyDir = join(scratch, "worker-ready");
  const exitDir = join(scratch, "worker-exit");
  const workspace = join(scratch, "workspace");
  mkdirSync(readyDir);
  mkdirSync(exitDir);
  mkdirSync(workspace);
  writeFileSync(join(workspace, "base.txt"), "base\n", "utf8");
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "synthetic@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Synthetic"], { cwd: workspace });
  execFileSync("git", ["add", "base.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });

  let controller;
  const roots = [];
  try {
    activateOwnedActivity();
    registerReviewActivitySource();
    controller = new BackgroundExecutionController({
      pi: {},
      config: executorConfig(readyDir, exitDir),
      state: createState(),
      cwd: () => workspace,
    });
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const steps = [];
    for (const cycle of [1, 2]) {
      const readyBefore = new Set(filesIn(readyDir));
      const started = await controller.start([{
        title: `synthetic real executor ${cycle}`,
        instructions: "hold admitted work until the regression interrupts it",
        acceptanceCriteria: ["interrupted"],
      }]);
      roots.push(started.root);
      const executionId = started.executionId;
      const taskId = started.tasks[0].taskId;
      try {
        await waitUntil(() => filesIn(readyDir).some((file) => !readyBefore.has(file)),
          `task ${cycle} executor process readiness`, 20_000);
      } catch (error) {
        const inspection = controller.inspect(executionId, taskId);
        throw new Error(`${error.message}; state=${inspection.tasks[0]?.state}; readyFiles=${JSON.stringify(filesIn(readyDir))}`);
      }
      const readyFile = filesIn(readyDir).find((file) => !readyBefore.has(file));
      assert.ok(readyFile, `task ${cycle} readiness evidence exists`);
      const workerPid = readyFile.split(".")[0];
      if (FAIL_AFTER_READY) {
        // Controlled failure-path regression: the worker is genuinely running
        // here, so cleanup must terminate it before fixtures are removed.
        throw new Error("injected assertion failure immediately after executor readiness");
      }
      const running = controller.inspect(executionId, taskId);
      assert.equal(running.tasks[0]?.state, "running",
        `task ${cycle} is actually executing (worker ${workerPid} acknowledged readiness)`);
      assert.equal(activeActivitySnapshot().activeTasks, 1, `task ${cycle} canonical activity is 1 while executing`);
      const interrupted = await controller.interrupt({
        executionId,
        taskId,
        mode: "interrupt_as_failure",
        instructionId: `synthetic-412-real-interrupt-${cycle}`,
        actor: "user",
      });
      assert.equal(interrupted.tasks[0]?.state, "interrupted", `task ${cycle} interruption returned interrupted`);
      await waitUntil(() => filesIn(exitDir).includes(`${workerPid}.exit`),
        `task ${cycle} exact executor process exit acknowledgement`, 20_000);
      await waitUntil(() => activeActivitySnapshot().activeTasks === 0, `task ${cycle} canonical activity zero`, 8_000);
      const settled = controller.inspect(executionId, taskId);
      assert.equal(settled.tasks[0]?.state, "interrupted", `task ${cycle} remains quiesced after verified exit`);
      steps.push({
        cycle,
        workerPid,
        readyFile,
        exitFile: `${workerPid}.exit`,
        stateBefore: running.tasks[0]?.state,
        stateAfter: settled.tasks[0]?.state,
        activeBefore: 1,
        activeAfter: activeActivitySnapshot().activeTasks,
      });
    }
    process.stdout.write(`SCENARIO_RESULT ${JSON.stringify({ scenario: "real-executor", ok: true, result: { steps } })}\n`);
  } finally {
    const failures = [];
    // Shut down while runtime ownership is still available: detach() alone
    // clears the controller maps without terminating their children.
    try { await controller?.shutdown(); } catch (error) { failures.push(error); }
    try {
      await waitUntil(() => filesIn(readyDir).every((file) => {
        const pid = Number(file.split(".")[0]);
        if (!filesIn(exitDir).includes(`${pid}.exit`)) return false;
        return !pidAlive(pid);
      }), "all acknowledged executor processes exited", 20_000);
    } catch (error) { failures.push(error); }
    if (failures.length === 0) {
      try { await controller?.detach(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      process.stderr.write(`EXECUTOR_FIXTURES_RETAINED ${scratch}\n`);
      throw new AggregateError(failures, `executor settlement failed; fixtures retained at ${scratch}`);
    }
    // Positive settlement evidence is emitted before any fixture is removed.
    process.stderr.write(`EXECUTOR_SETTLED ${filesIn(readyDir).map((file) => file.split(".")[0]).join(",")}\n`);
    for (const root of roots) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* already gone */ }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (error) => {
  process.stderr.write(`SCENARIO_ERROR real-executor ${String(error && error.stack || error)}\n`);
  process.exit(1);
});
