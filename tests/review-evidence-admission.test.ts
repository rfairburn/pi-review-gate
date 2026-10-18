import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import { createState } from "../src/state";
import { initGitRepo, waitFor } from "./helpers/background-controller-fixtures";

test("queued Start tasks retain admission policy while Add captures its own current policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-evidence-admission-"));
  const executor = join(root, "executor.cjs");
  const releaseGate = join(root, "release-gate");
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "const finish=()=>{",
      "if(prompt.includes('QUEUED_FIRST'))fs.writeFileSync('first.txt','first\\n');",
      "if(prompt.includes('QUEUED_SECOND'))fs.writeFileSync('second.txt','second\\n');",
      "if(prompt.includes('ADDED_CURRENT'))fs.writeFileSync('added.txt','added\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
      "};",
      "const gate=process.env.PI_REVIEW_EXECUTOR_TEST_GATE;",
      "const poll=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(poll);finish();}},10);",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: {
        activeReviewers: [],
        evidence: { worktreeToolOnly: true, snapshotFailureFallback: false },
      },
      externalAgents: {
        fake: {
          adapter: "run-as-binary",
          command: executor,
          env: { PI_REVIEW_EXECUTOR_TEST_GATE: releaseGate },
          execution: { protocol: "pi-review-executor-jsonl-v1" },
        },
      },
      execution: {
        maxWorkers: 1,
        workerResources: { default: { selection: { source: "external", id: "fake" }, maxConcurrent: 1 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    });
    controller = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });

    const started = await controller.start([
      { title: "first", instructions: "QUEUED_FIRST", acceptanceCriteria: ["first.txt exists"] },
      { title: "second", instructions: "QUEUED_SECOND", acceptanceCriteria: ["second.txt exists"] },
    ]);
    await waitFor(() => {
      const tasks = controller!.inspect(started.executionId).tasks;
      return tasks[0]?.state === "running" && tasks[1]?.state === "queued";
    });
    assert.deepEqual(controller.inspect(started.executionId).tasks.map((task) => task.definition.reviewEvidencePolicy), [
      { toolOnly: true, snapshotFailureFallback: false, scope: "worktree" },
      { toolOnly: true, snapshotFailureFallback: false, scope: "worktree" },
    ]);

    config.review!.evidence = { worktreeToolOnly: false, snapshotFailureFallback: true };
    const added = await controller.add(started.executionId, [
      { title: "added", instructions: "ADDED_CURRENT", acceptanceCriteria: ["added.txt exists"] },
    ]);
    assert.deepEqual(added.tasks[1]?.definition.reviewEvidencePolicy, {
      toolOnly: true,
      snapshotFailureFallback: false,
      scope: "worktree",
    });
    assert.deepEqual(added.tasks[2]?.definition.reviewEvidencePolicy, {
      toolOnly: false,
      snapshotFailureFallback: true,
      scope: "worktree",
    });

    await writeFile(releaseGate, "release\\n", "utf8");
    await waitFor(() => controller!.inspect(started.executionId).activeCount === 0);
    assert.deepEqual(controller.inspect(started.executionId).tasks.map((task) => task.definition.reviewEvidencePolicy), [
      { toolOnly: true, snapshotFailureFallback: false, scope: "worktree" },
      { toolOnly: true, snapshotFailureFallback: false, scope: "worktree" },
      { toolOnly: false, snapshotFailureFallback: true, scope: "worktree" },
    ]);
  } finally {
    await writeFile(releaseGate, "release\\n", "utf8").catch(() => undefined);
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
