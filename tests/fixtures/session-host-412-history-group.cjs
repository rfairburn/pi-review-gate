"use strict";
/*
 * Synthetic owned history producer for the #412 combined restore regressions.
 *
 * Runs in its own Node process so the durable execution records it creates are
 * never shadowed by this test process's live owned-activity registry. It uses
 * the REAL production BackgroundExecutionController and group store:
 *
 *   mode "queued":  admits one execute task and leaves it queued (no worker is
 *                   ever dispatched because the fixture's maxWorkers is 0), so
 *                   the record is genuine admitted current work.
 *   mode "settled": admits one task and records an offline landed outcome, so
 *                   the record is genuine settled history.
 *
 * Output (stdout, one line): HISTORY_GROUP <json>
 *   { root, executionId, taskId, mode, associations }
 */
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");

const DIST = join(process.cwd(), "dist-test", "src");
const { BackgroundExecutionController } = require(join(DIST, "execution", "background-controller.js"));
const { transitionTaskState } = require(join(DIST, "execution", "task-state.js"));
const { normalizeConfig } = require(join(DIST, "config.js"));
const { createState } = require(join(DIST, "state.js"));

async function main() {
  const input = JSON.parse(process.argv[2] ?? "{}");
  const workspace = input.workspace;
  const mode = input.mode;
  if (typeof workspace !== "string" || (mode !== "queued" && mode !== "settled")) {
    throw new Error("usage: session-host-412-history-group.cjs <workspace> <queued|settled>");
  }
  execFileSync("git", ["-C", workspace, "rev-parse"], { stdio: "ignore" });
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      worker: {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: ["unused"] },
      },
    },
    execution: {
      maxWorkers: 1,
      workerResources: { worker: { selection: { source: "external", id: "worker" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "worker" }], research: [] },
      retryPolicy: { maxRetries: 0, maxSameIncidentRepeats: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    },
  });
  // Fixture boundary: never dispatch an executor. The durable queued record is
  // exactly what an offline admission leaves behind.
  config.execution.maxWorkers = 0;
  const controller = new BackgroundExecutionController({
    pi: {},
    config,
    state: createState(),
    cwd: () => workspace,
  });
  try {
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
    const started = await controller.start([{
      title: `synthetic ${mode} history`,
      instructions: "synthetic owned history for the #412 combined regression",
      acceptanceCriteria: ["record exists"],
    }]);
    const task = started.tasks[0];
    if (mode === "settled") {
      const group = controller.groups.get(started.executionId);
      if (!group) throw new Error("synthetic group missing before settlement");
      const record = group.tasks.find((candidate) => candidate.taskId === task.taskId);
      transitionTaskState(record, "landed");
      record.summary = "synthetic settled history";
      await controller.save(group);
    }
    process.stdout.write(`HISTORY_GROUP ${JSON.stringify({
      root: started.root,
      executionId: started.executionId,
      taskId: task.taskId,
      mode,
      associations: controller.associations(),
    })}\n`);
  } finally {
    await controller.detach().catch(() => undefined);
  }
}

main().then(() => process.exit(0), (error) => {
  process.stderr.write(`HISTORY_GROUP_ERROR ${String(error && error.stack || error)}\n`);
  process.exit(1);
});
