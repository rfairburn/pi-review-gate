import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compareSnapshots, createWorkspaceSnapshot } from "../src/capture";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { executeSubtask } from "../src/execution/controller";
import {
  activeExchangeBaseline,
  beginAgentRun,
  createState,
  rememberUserRequest,
  setReviewWindowBaseline,
} from "../src/state";

test("executeSubtask runs a fake binary through pass and unchanged acceptance", async () => {
  const fixture = await executionFixture(true);
  const packet = await executeSubtask({
    task: task(),
    cwd: fixture.workspace,
    config: fixture.config,
    parentState: fixture.parentState,
  });

  assert.equal(packet.kind, "accepted");
  assert.equal(packet.reviewStatus, "accepted");
  assert.deepEqual(packet.changedFiles, ["implemented.txt"]);
  assert.equal(await readFile(join(fixture.workspace, "implemented.txt"), "utf8"), "implemented\n");
  const current = await workspaceSnapshot(fixture.workspace, fixture.config);
  assert.deepEqual(compareSnapshots(activeExchangeBaseline(fixture.parentState)!, current), []);
});

test("executeSubtask can complete explicitly without review", async () => {
  const fixture = await executionFixture(false);
  const packet = await executeSubtask({
    task: task(),
    cwd: fixture.workspace,
    config: fixture.config,
    parentState: fixture.parentState,
  });

  assert.equal(packet.kind, "completed_unreviewed");
  assert.equal(packet.reviewStatus, "not_run");
  assert.equal(packet.reviewDisabledReason, "no_enabled_reviewers");
  assert.equal(packet.reviewCycles, 0);
  assert.deepEqual(packet.changedFiles, ["implemented.txt"]);
});

test("executeSubtask refuses delegation after parent workspace edits", async () => {
  const fixture = await executionFixture(false);
  await writeFile(join(fixture.workspace, "parent.txt"), "parent edit\n", "utf8");

  const packet = await executeSubtask({
    task: task(),
    cwd: fixture.workspace,
    config: fixture.config,
    parentState: fixture.parentState,
  });

  assert.equal(packet.kind, "blocked");
  assert.equal(packet.error, "dirty_parent_exchange");
  await assert.rejects(readFile(join(fixture.workspace, "implemented.txt"), "utf8"));
});

test("executeSubtask does not mistake an invalid reviewer selection for review disabled", async () => {
  const fixture = await executionFixture(false);
  fixture.config.review = { activeReviewers: [{ source: "external", id: "missing-reviewer" }] };

  const packet = await executeSubtask({
    task: task(),
    cwd: fixture.workspace,
    config: fixture.config,
    parentState: fixture.parentState,
  });

  assert.equal(packet.kind, "blocked");
  assert.equal(packet.error, "invalid_reviewer_selection");
  assert.match(packet.summary, /unknown enabled reviewer ids: external:missing-reviewer/);
  await assert.rejects(readFile(join(fixture.workspace, "implemented.txt"), "utf8"));
});

async function executionFixture(reviewed: boolean): Promise<{
  workspace: string;
  config: ReviewGateConfig;
  parentState: ReturnType<typeof createState>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-review-execution-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "original.txt"), "original\n", "utf8");
  const executorPath = join(root, "fake-executor.cjs");
  await writeFile(executorPath, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const op = process.env.PI_REVIEW_EXECUTOR_OPERATION;",
    "if (op === 'start') fs.writeFileSync(path.join(process.cwd(), 'implemented.txt'), 'implemented\\n');",
    "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID }));",
    "console.log(JSON.stringify({ type: 'assistant', text: op === 'start' ? 'Implemented the requested file.' : 'Verified the passing review; no further changes.' }));",
  ].join("\n"), "utf8");
  await chmod(executorPath, 0o755);
  const config = normalizeConfig({
    enabled: true,
    maxCorrectionCycles: 2,
    retainBundles: "never",
    review: {
      activeReviewers: reviewed ? [{ source: "external", id: "fake-reviewer" }] : [],
    },
    externalAgents: [{
      id: "fake-reviewer",
      adapter: "generic-cli",
      command: process.execPath,
      review: {
        protocol: "pi-reviewer-json-v1",
        args: [resolve("scripts/fake-reviewer.cjs")],
        timeoutMs: 5000,
      },
    }, {
      id: "fake-executor",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: {
        protocol: "pi-review-executor-jsonl-v1",
        args: [executorPath],
        timeoutMs: 5000,
      },
    }],
    execution: {
      activeExecutor: { source: "external", id: "fake-executor" },
    },
  });
  const parentState = createState();
  rememberUserRequest(parentState, "Implement the project");
  beginAgentRun(parentState);
  setReviewWindowBaseline(parentState, await workspaceSnapshot(workspace, config));
  return { workspace, config, parentState };
}

function task() {
  return {
    title: "Implement fixture",
    instructions: "Create implemented.txt with the requested content.",
    acceptanceCriteria: ["implemented.txt exists"],
  };
}

function workspaceSnapshot(cwd: string, config: ReviewGateConfig) {
  return createWorkspaceSnapshot(cwd, {
    maxFileBytes: config.maxFileBytes,
    maxSnapshotBytes: config.maxSnapshotBytes,
  });
}
