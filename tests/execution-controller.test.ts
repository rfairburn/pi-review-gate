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

test("executeSubtask returns accepted_with_warnings and structured evidence for pass plus reviewer error", async () => {
  const fixture = await executionFixture(true, { mixedReviewerError: true, retainBundles: "on-failure" });
  const packet = await executeSubtask({
    task: task(),
    cwd: fixture.workspace,
    config: fixture.config,
    parentState: fixture.parentState,
  });

  assert.equal(packet.kind, "accepted_with_warnings");
  assert.equal(packet.reviewStatus, "accepted_with_warnings");
  assert.equal(packet.reviewReport?.aggregate, "pass_with_warnings");
  assert.deepEqual(packet.reviewReport?.reviewers.map((reviewer) => reviewer.verdict), ["pass", "error"]);
  assert.equal(packet.reviewReport?.reviewers[1]?.errorCategory, "process_exit");
  assert.ok(packet.bundleDir, "warning evidence should be retained for orchestrator inspection");
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

test("executeSubtask adopts parent workspace edits into an unreviewed child", async () => {
  const fixture = await executionFixture(false);
  await writeFile(join(fixture.workspace, "parent.txt"), "parent edit\n", "utf8");

  const packet = await executeSubtask({
    task: task(),
    cwd: fixture.workspace,
    config: fixture.config,
    parentState: fixture.parentState,
  });

  assert.equal(packet.kind, "completed_unreviewed");
  assert.deepEqual(packet.changedFiles, ["implemented.txt", "parent.txt"]);
  assert.equal(await readFile(join(fixture.workspace, "implemented.txt"), "utf8"), "implemented\n");
  const current = await workspaceSnapshot(fixture.workspace, fixture.config);
  assert.deepEqual(compareSnapshots(activeExchangeBaseline(fixture.parentState)!, current), []);
});

test("executeSubtask reviews adopted parent edits from the original parent baseline", async () => {
  const fixture = await executionFixture(true, { retainBundles: "always" });
  await writeFile(join(fixture.workspace, "parent.txt"), "parent edit\n", "utf8");
  const progress: Array<{ phase: string; message: string }> = [];

  const packet = await executeSubtask({
    task: task(),
    cwd: fixture.workspace,
    config: fixture.config,
    parentState: fixture.parentState,
    onUpdate: (update) => progress.push(update),
  });

  assert.equal(packet.kind, "accepted");
  assert.deepEqual(packet.changedFiles, ["implemented.txt", "parent.txt"]);
  assert.ok(packet.bundleDir);
  const reviewedPatch = await readFile(join(packet.bundleDir, "current", "cumulative.patch"), "utf8");
  assert.match(reviewedPatch, /parent\.txt/);
  assert.match(reviewedPatch, /parent edit/);
  assert.match(reviewedPatch, /implemented\.txt/);
  const subtaskMetadata = JSON.parse(await readFile(join(packet.bundleDir, "subtask.json"), "utf8"));
  assert.deepEqual(subtaskMetadata.adoptedParentChanges, [{ path: "parent.txt", status: "added" }]);
  assert.deepEqual(new Set(progress.map((update) => update.phase)), new Set(["starting", "executing", "reviewing", "confirming", "completing"]));
  assert.equal(progress.some((update) => /fake-reviewer started/.test(update.message)), true);
  assert.equal(progress.some((update) => /fake-reviewer finished · pass/.test(update.message)), true);
});

test("failed child execution preserves the parent baseline and can be adopted by a retry", async () => {
  const fixture = await executionFixture(false, { failFirst: true });
  await writeFile(join(fixture.workspace, "parent.txt"), "parent edit\n", "utf8");
  const originalBaseline = activeExchangeBaseline(fixture.parentState)!;

  const failed = await executeSubtask({
    task: task(),
    cwd: fixture.workspace,
    config: fixture.config,
    parentState: fixture.parentState,
  });

  assert.equal(failed.kind, "executor_error");
  assert.deepEqual(failed.changedFiles, [".executor-failed-once", "parent.txt", "partial.txt"]);
  assert.strictEqual(activeExchangeBaseline(fixture.parentState), originalBaseline);

  const retried = await executeSubtask({
    task: task(),
    cwd: fixture.workspace,
    config: fixture.config,
    parentState: fixture.parentState,
  });

  assert.equal(retried.kind, "completed_unreviewed");
  assert.deepEqual(retried.changedFiles, ["implemented.txt", "parent.txt", "partial.txt"]);
  const current = await workspaceSnapshot(fixture.workspace, fixture.config);
  assert.deepEqual(compareSnapshots(activeExchangeBaseline(fixture.parentState)!, current), []);
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

async function executionFixture(reviewed: boolean, options: {
  failFirst?: boolean;
  retainBundles?: "always" | "on-failure" | "never";
  mixedReviewerError?: boolean;
} = {}): Promise<{
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
    ...(options.failFirst ? [
      "const failureMarker = path.join(process.cwd(), '.executor-failed-once');",
      "if (op === 'start' && !fs.existsSync(failureMarker)) {",
      "  fs.writeFileSync(failureMarker, 'failed once\\n');",
      "  fs.writeFileSync(path.join(process.cwd(), 'partial.txt'), 'partial\\n');",
      "  process.exit(1);",
      "}",
      "if (op === 'start' && fs.existsSync(failureMarker)) fs.unlinkSync(failureMarker);",
    ] : []),
    "if (op === 'start') fs.writeFileSync(path.join(process.cwd(), 'implemented.txt'), 'implemented\\n');",
    "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID }));",
    "console.log(JSON.stringify({ type: 'assistant', text: op === 'start' ? 'Implemented the requested file.' : 'Verified the passing review; no further changes.' }));",
  ].join("\n"), "utf8");
  await chmod(executorPath, 0o755);
  const config = normalizeConfig({
    enabled: true,
    maxCorrectionCycles: 2,
    retainBundles: options.retainBundles ?? "never",
    review: {
      activeReviewers: reviewed
        ? [
            { source: "external" as const, id: "fake-reviewer" },
            ...(options.mixedReviewerError ? [{ source: "external" as const, id: "broken-reviewer" }] : []),
          ]
        : [],
    },
    externalAgents: [{
      id: "fake-reviewer",
      adapter: "generic-cli",
      command: process.execPath,
      review: {
        protocol: "pi-reviewer-json-v1",
        args: [resolve("scripts/fake-reviewer.cjs")],
        timeoutMs: 15000,
      },
    }, {
      id: "broken-reviewer",
      adapter: "generic-cli",
      command: process.execPath,
      review: {
        protocol: "pi-reviewer-json-v1",
        args: ["-e", "process.exit(1)"],
        timeoutMs: 15000,
      },
    }, {
      id: "fake-executor",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: {
        protocol: "pi-review-executor-jsonl-v1",
        args: [executorPath],
        timeoutMs: 15000,
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
