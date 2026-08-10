import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureWaveBase, WaveCaptureResult } from "../src/execution/wave-repository";
import { createWorkerWorktree, removeWorktree } from "../src/execution/wave-worktrees";
import { runWaveWorker, resumeWaveWorker, buildWaveWorkerPrompt, type WaveWorkerTask, type WaveWorkerResult, type WaveWorkerContinuationInput } from "../src/execution/wave-worker";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { resolve } from "node:path";

// ── helpers ──────────────────────────────────────────────────────────────────

async function mkTmp(prefix: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** Create a committed source repo and capture it. */
async function setupCapture(artifactDir: string): Promise<{ sourceDir: string; capture: WaveCaptureResult }> {
  const sourceDir = await mkTmp("pi-ww-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await writeFile(join(sourceDir, "app.js"), "console.log('hi');\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);
  const capture = await captureWaveBase({
    cwd: sourceDir,
    maxSnapshotBytes: 1_000_000,
    waveId: "test-wave",
    artifactDir,
  });
  return { sourceDir, capture };
}

async function git(args: string[], cwd: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const GIT_ENV = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout.trim();
}

/** Create a fake executor that writes a file and returns a response. */
async function createFakeExecutor(root: string, artifactDir = root): Promise<{ command: string; capture: string }> {
  const command = join(root, "fake-executor.cjs");
  const capture = join(artifactDir, "executor-capture.json");
  await writeFile(command, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const capture = process.env.CAPTURE_PATH || ${JSON.stringify(capture)};`,
    "fs.writeFileSync(capture, JSON.stringify({",
    "  cwd: process.cwd(),",
    "  argv: process.argv.slice(2),",
    "}));",
    "// Write a file to simulate work",
    "fs.writeFileSync(path.join(process.cwd(), 'worker-output.txt'), 'worker done\\n');",
    "// Output in run-as-binary protocol format",
    "console.log(JSON.stringify({ type: 'session', sessionId: 'test-session-id' }));",
    "console.log(JSON.stringify({ type: 'assistant', text: 'Implemented the change.' }));",
  ].join("\n"), "utf8");
  await chmod(command, 0o755);
  return { command, capture };
}

/** Create a fake executor that fails with a non-zero exit code. */
async function createFailingExecutor(root: string): Promise<{ command: string }> {
  const command = join(root, "failing-executor.cjs");
  await writeFile(command, [
    "console.log(JSON.stringify({ type: 'session', sessionId: 'fail-session' }));",
    "console.log(JSON.stringify({ type: 'assistant', text: '' }));",
    "process.exit(1);",
  ].join("\n"), "utf8");
  await chmod(command, 0o755);
  return { command };
}

/** Create a fake executor that times out. */
async function createTimeoutExecutor(root: string): Promise<{ command: string }> {
  const command = join(root, "timeout-executor.cjs");
  await writeFile(command, [
    "setTimeout(() => {",
    "  console.log(JSON.stringify({ type: 'session', sessionId: 'to-session' }));",
    "  console.log(JSON.stringify({ type: 'assistant', text: 'done' }));",
    "}, 60000);",
  ].join("\n"), "utf8");
  await chmod(command, 0o755);
  return { command };
}

/** Create a fake executor that produces no output. */
async function createEmptyExecutor(root: string): Promise<{ command: string }> {
  const command = join(root, "empty-executor.cjs");
  await writeFile(command, [
    "// Produces no output",
  ].join("\n"), "utf8");
  await chmod(command, 0o755);
  return { command };
}

function testTask(): WaveWorkerTask {
  return {
    title: "Test wave worker task",
    instructions: "Create worker-output.txt with the requested content.",
    acceptanceCriteria: ["worker-output.txt exists with content"],
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

test("wave-worker prompt discloses snapshot contents and tells model not to commit", () => {
  const prompt = buildWaveWorkerPrompt(testTask());

  // Prompt should disclose snapshot contents.
  assert.ok(
    prompt.includes("non-ignored untracked files"),
    "prompt should mention non-ignored untracked files",
  );
  assert.ok(
    prompt.includes("Git-ignored files are not present"),
    "prompt should state Git-ignored files are absent",
  );

  // Prompt should tell model not to manage commits.
  assert.ok(
    prompt.includes("Do not manage Git commits"),
    "prompt should tell model not to manage commits",
  );

  // Prompt should include task info.
  assert.ok(
    prompt.includes("Test wave worker task"),
    "prompt should include task title",
  );
  assert.ok(
    prompt.includes("Acceptance criteria:"),
    "prompt should include acceptance criteria header",
  );
  assert.ok(
    prompt.includes("worker-output.txt exists with content"),
    "prompt should include acceptance criteria items",
  );
});

test("wave-worker runs one executor turn and normalizes to candidate", async () => {
  const root = await mkTmp("pi-ww-run-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-1");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-1");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root, artifactDir);
    const config = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "little-coder", model: "test-model" },
      },
      externalAgents: [{
        id: "fake-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 5000,
        },
      }],
    });

    // Override the executor adapter to use our fake.
    const fakeConfig: ReviewGateConfig = {
      ...config,
      execution: {
        ...config.execution,
        activeExecutor: { source: "external", id: "fake-exec" },
      },
    };

    const result = await runWaveWorker({
      taskId: "task-1",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config: fakeConfig,
    });

    assert.equal(result.status, "completed", "result should be completed");
    assert.equal(result.taskId, "task-1");
    assert.ok(result.candidate, "result should have candidate");
    assert.ok(result.candidate.differsFromBase, "candidate should differ from base");
    assert.equal(result.adapter, "run-as-binary");
    assert.ok(result.summary.includes("Implemented the change"), "summary should contain executor response");

    // Verify the worker output file is in the candidate tree.
    const content = await git(
      ["show", `${result.candidate.commitSha}:worker-output.txt`],
      worker.worktreeRoot,
    );
    assert.ok(content.includes("worker done"), "worker-output.txt should be in candidate tree");

    // Verify executor capture log is NOT in the candidate tree.
    const tree = await git(
      ["ls-tree", "-r", "--name-only", result.candidate.commitSha],
      worker.worktreeRoot,
    );
    assert.ok(!tree.includes("executor-capture.json"), "executor capture log should not be in candidate tree");

    // Verify artifact isolation: artifacts should be in the artifact dir, not the worktree.
    const completionArtifact = JSON.parse(await readFile(join(artifactDir, "completion.json"), "utf8"));
    assert.equal(completionArtifact.status, "completed");
    assert.equal(completionArtifact.taskId, "task-1");

    // Verify task.json was written.
    const taskArtifact = JSON.parse(await readFile(join(artifactDir, "task.json"), "utf8"));
    assert.equal(taskArtifact.taskId, "task-1");
    assert.equal(taskArtifact.task.title, "Test wave worker task");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wave-worker returns no_changes when executor makes no modifications", async () => {
  const root = await mkTmp("pi-ww-noc-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-noc");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-noc");
    await mkdir(artifactDir, { recursive: true });

    // Create a fake executor that does not modify any files.
    const command = join(root, "no-op-executor.cjs");
    await writeFile(command, [
      "console.log(JSON.stringify({ type: 'session', sessionId: 'noc-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'No changes needed.' }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "noop-exec" },
      },
      externalAgents: [{
        id: "noop-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 5000,
        },
      }],
    });

    const result = await runWaveWorker({
      taskId: "task-noc",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "no_changes", "result should be no_changes");
    assert.ok(result.candidate, "result should have candidate");
    assert.equal(result.candidate.differsFromBase, false, "candidate should not differ from base");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wave-worker returns executor_error on non-zero exit", async () => {
  const root = await mkTmp("pi-ww-err-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-err");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-err");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFailingExecutor(root);
    const config: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "fail-exec" },
      },
      externalAgents: [{
        id: "fail-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 5000,
        },
      }],
    });

    const result = await runWaveWorker({
      taskId: "task-err",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "executor_error", "result should be executor_error");
    assert.ok(result.error, "result should have error message");
    assert.ok(!result.candidate, "result should not have candidate on error");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wave-worker returns timeout on executor timeout", async () => {
  const root = await mkTmp("pi-ww-to-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-to");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-to");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createTimeoutExecutor(root);
    const config: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "to-exec" },
      },
      externalAgents: [{
        id: "to-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 500, // Short timeout
        },
      }],
    });

    const result = await runWaveWorker({
      taskId: "task-to",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "timeout", "result should be timeout");
    assert.ok(result.error, "result should have error message");
    assert.ok(!result.candidate, "result should not have candidate on timeout");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wave-worker returns cancelled on abort signal", async () => {
  const root = await mkTmp("pi-ww-cancel-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-cancel");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-cancel");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createTimeoutExecutor(root);
    const config: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "cancel-exec" },
      },
      externalAgents: [{
        id: "cancel-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 30_000,
        },
      }],
    });

    const controller = new AbortController();
    // Abort after a brief delay.
    setTimeout(() => controller.abort(), 100);

    const result = await runWaveWorker({
      taskId: "task-cancel",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      signal: controller.signal,
    });

    assert.equal(result.status, "cancelled", "result should be cancelled");
    assert.ok(result.error, "result should have error message");
    assert.ok(!result.candidate, "result should not have candidate on cancel");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wave-worker returns executor_error on empty response", async () => {
  const root = await mkTmp("pi-ww-empty-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-empty");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-empty");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createEmptyExecutor(root);
    const config: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "empty-exec" },
      },
      externalAgents: [{
        id: "empty-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 5000,
        },
      }],
    });

    const result = await runWaveWorker({
      taskId: "task-empty",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "executor_error", "result should be executor_error");
    assert.ok(result.error, "result should have error message");
    assert.ok(!result.candidate, "result should not have candidate on empty response");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wave-worker validates artifact directory is under waveRoot", async () => {
  const root = await mkTmp("pi-ww-artifact-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-artifact");

    // Artifact dir outside waveRoot should fail.
    const outsideArtifactDir = await mkTmp("pi-ww-outside-");

    const { command } = await createFakeExecutor(root);
    const config: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "artifact-exec" },
      },
      externalAgents: [{
        id: "artifact-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 5000,
        },
      }],
    });

    await assert.rejects(
      runWaveWorker({
        taskId: "task-artifact",
        task: testTask(),
        capture,
        worktree: worker,
        artifactDir: outsideArtifactDir,
        config,
      }),
      /not within|not under wave root/,
    );

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
    await rm(outsideArtifactDir, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wave-worker validates artifact directory is outside worktree", async () => {
  const root = await mkTmp("pi-ww-artifact2-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-artifact2");

    // Artifact dir inside worktree should fail.
    const insideArtifactDir = join(worker.worktreeRoot, "artifacts");
    await mkdir(insideArtifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "artifact2-exec" },
      },
      externalAgents: [{
        id: "artifact2-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 5000,
        },
      }],
    });

    await assert.rejects(
      runWaveWorker({
        taskId: "task-artifact2",
        task: testTask(),
        capture,
        worktree: worker,
        artifactDir: insideArtifactDir,
        config,
      }),
      /must be outside the worktree/,
    );

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wave-worker executor runs in effectiveCwd, not worktreeRoot", async () => {
  const root = await mkTmp("pi-ww-cwd-");
  try {
    // Create a source repo with a subdirectory.
    const sourceDir = await mkTmp("pi-ww-cwd-src-");
    await git(["init", "--quiet"], sourceDir);
    const subDir = join(sourceDir, "src");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "app.js"), "console.log('hi');\n", "utf8");
    await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: subDir, // cwd is the subdirectory
      maxSnapshotBytes: 1_000_000,
      waveId: "cwd-wave",
      artifactDir: root,
    });

    const worker = await createWorkerWorktree(capture, "task-cwd");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-cwd");
    await mkdir(artifactDir, { recursive: true });

    // Create a fake executor that records its cwd.
    const capturePath = join(root, "cwd-capture.json");
    const command = join(root, "cwd-executor.cjs");
    await writeFile(command, [
      "const fs = require('node:fs');",
      `const capturePath = ${JSON.stringify(capturePath)};`,
      "fs.writeFileSync(capturePath, JSON.stringify({ cwd: process.cwd() }));",
      "fs.writeFileSync('worker-output.txt', 'done\\n');",
      "console.log(JSON.stringify({ type: 'session', sessionId: 'cwd-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'done' }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "cwd-exec" },
      },
      externalAgents: [{
        id: "cwd-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 5000,
        },
      }],
    });

    const result = await runWaveWorker({
      taskId: "task-cwd",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "completed");

    // Verify the executor ran in the effectiveCwd (subdirectory), not worktreeRoot.
    const cwdCapture = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(cwdCapture.cwd, worker.effectiveCwd, "executor should run in effectiveCwd");
    assert.notEqual(cwdCapture.cwd, worker.worktreeRoot, "executor should not run in worktreeRoot");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wave-worker does not mutate source repository", async () => {
  const root = await mkTmp("pi-ww-source-");
  try {
    const { sourceDir, capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-source");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-source");
    await mkdir(artifactDir, { recursive: true });

    // Record source state before.
    const beforeRefs = await git(["for-each-ref", "--format=%(refname)"], sourceDir);

    const { command } = await createFakeExecutor(root, artifactDir);
    const config: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "source-exec" },
      },
      externalAgents: [{
        id: "source-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 5000,
        },
      }],
    });

    const result = await runWaveWorker({
      taskId: "task-source",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "completed");

    // Verify source repo was not mutated.
    const afterRefs = await git(["for-each-ref", "--format=%(refname)"], sourceDir);
    assert.equal(beforeRefs, afterRefs, "source repo refs should not change");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wave-worker result type carries all required fields", async () => {
  const root = await mkTmp("pi-ww-type-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-type");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-type");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root, artifactDir);
    const config: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "type-exec" },
      },
      externalAgents: [{
        id: "type-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 5000,
        },
      }],
    });

    const result: WaveWorkerResult = await runWaveWorker({
      taskId: "task-type",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.ok(typeof result.status === "string", "status should be a string");
    assert.ok(typeof result.taskId === "string", "taskId should be a string");
    assert.ok(typeof result.title === "string", "title should be a string");
    assert.ok(typeof result.summary === "string", "summary should be a string");
    assert.ok(typeof result.adapter === "string", "adapter should be a string");
    assert.ok(result.session, "result should have session");
    assert.ok(result.turn, "result should have turn");
    assert.ok(result.candidate, "result should have candidate");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wave-worker progress callbacks are invoked", async () => {
  const root = await mkTmp("pi-ww-progress-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-progress");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-progress");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root, artifactDir);
    const config: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "progress-exec" },
      },
      externalAgents: [{
        id: "progress-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 5000,
        },
      }],
    });

    const phases: string[] = [];
    const result = await runWaveWorker({
      taskId: "task-progress",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      onUpdate: (update) => phases.push(update.phase),
    });

    assert.equal(result.status, "completed");
    assert.ok(phases.includes("starting"), "should have starting phase");
    assert.ok(phases.includes("executing"), "should have executing phase");
    assert.ok(phases.includes("completing"), "should have completing phase");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── continuation (resume) tests ─────────────────────────────────────────────

test("resumeWaveWorker resumes the exact prior session", async () => {
  const root = await mkTmp("pi-ww-resume-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-resume");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-resume");
    await mkdir(artifactDir, { recursive: true });

    // Create a fake executor that records the session ID it receives.
    const capturePath = join(root, "resume-capture.json");
    const command = join(root, "resume-executor.cjs");
    await writeFile(command, [
      "const fs = require('node:fs');",
      `const capturePath = ${JSON.stringify(capturePath)};`,
      "fs.writeFileSync(capturePath, JSON.stringify({",
      "  sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID,",
      "  operation: process.env.PI_REVIEW_EXECUTOR_OPERATION,",
      "}));",
      "// Write a file to simulate work",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'correction.txt'), 'corrected\\n');",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Applied corrections.' }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "resume-exec" },
      },
      externalAgents: [{
        id: "resume-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 5000,
        },
      }],
    });

    // First run: initial turn.
    const firstResult = await runWaveWorker({
      taskId: "task-resume",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(firstResult.status, "completed");
    assert.ok(firstResult.session, "first result should have session");
    assert.ok(firstResult.candidate, "first result should have candidate");

    // Resume with the prior session.
    const resumeResult = await resumeWaveWorker({
      taskId: "task-resume",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      priorResult: firstResult,
      feedback: "Please fix the issue.",
      turn: 2,
    });

    assert.equal(resumeResult.status, "completed");

    // Verify the adapter received the exact prior session ID.
    const resumeCapture = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(resumeCapture.sessionId, firstResult.session!.id, "adapter should receive the exact prior session ID");
    assert.equal(resumeCapture.operation, "resume", "adapter should receive resume operation");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumeWaveWorker correction changes produce replacement sole-base-parent candidate", async () => {
  const root = await mkTmp("pi-ww-resume2-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-resume2");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-resume2");
    await mkdir(artifactDir, { recursive: true });

    // First run executor: writes initial file.
    const firstCommand = join(root, "resume2-first.cjs");
    await writeFile(firstCommand, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'initial.txt'), 'initial content\\n');",
      "console.log(JSON.stringify({ type: 'session', sessionId: 'first-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Initial changes.' }));",
    ].join("\n"), "utf8");
    await chmod(firstCommand, 0o755);

    const firstConfig: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "resume2-first" },
      },
      externalAgents: [{
        id: "resume2-first",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [firstCommand],
          timeoutMs: 5000,
        },
      }],
    });

    // First run.
    const firstResult = await runWaveWorker({
      taskId: "task-resume2",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config: firstConfig,
    });

    assert.equal(firstResult.status, "completed");
    const firstCandidate = firstResult.candidate!;

    // Resume executor: writes different correction file.
    const resumeCommand = join(root, "resume2-correction.cjs");
    await writeFile(resumeCommand, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'correction.txt'), 'corrected content\\n');",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Applied corrections.' }));",
    ].join("\n"), "utf8");
    await chmod(resumeCommand, 0o755);

    const resumeConfig: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "resume2-correction" },
      },
      externalAgents: [{
        id: "resume2-correction",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [resumeCommand],
          timeoutMs: 5000,
        },
      }],
    });

    // Resume with corrections.
    const resumeResult = await resumeWaveWorker({
      taskId: "task-resume2",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config: resumeConfig,
      priorResult: firstResult,
      feedback: "Please fix the issue.",
      turn: 2,
    });

    assert.equal(resumeResult.status, "completed");
    const resumeCandidate = resumeResult.candidate!;

    // The new candidate should have a different SHA (correction changed files).
    assert.notEqual(resumeCandidate.commitSha, firstCandidate.commitSha, "resume candidate should differ from first");

    // The candidate ref should be the same (replacement).
    assert.equal(resumeCandidate.candidateRef, firstCandidate.candidateRef, "candidate ref should be the same");

    // Verify the candidate has the wave base as its sole parent.
    const parentCount = await git(
      ["cat-file", "-p", resumeCandidate.commitSha],
      worker.worktreeRoot,
    ).then((output) => output.split("\n").filter((l) => l.startsWith("parent ")).length);
    assert.equal(parentCount, 1, "candidate should have exactly one parent");

    const parentSha = await git(
      ["rev-parse", `${resumeCandidate.commitSha}^`],
      worker.worktreeRoot,
    );
    assert.equal(parentSha, capture.baseCommit, "sole parent should be the wave base");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumeWaveWorker unchanged confirmation reports no_changes only when truly unchanged relative to base", async () => {
  const root = await mkTmp("pi-ww-resume3-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-resume3");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-resume3");
    await mkdir(artifactDir, { recursive: true });

    // Create a fake executor that does NOT modify any files (confirmation).
    const command = join(root, "resume3-executor.cjs");
    await writeFile(command, [
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'No changes needed, confirming.' }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "resume3-exec" },
      },
      externalAgents: [{
        id: "resume3-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 5000,
        },
      }],
    });

    // First run: make some changes.
    const firstCommand = join(root, "resume3-first.cjs");
    await writeFile(firstCommand, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'initial.txt'), 'initial\\n');",
      "console.log(JSON.stringify({ type: 'session', sessionId: 'first-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Initial changes.' }));",
    ].join("\n"), "utf8");
    await chmod(firstCommand, 0o755);

    const firstConfig: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "resume3-first" },
      },
      externalAgents: [{
        id: "resume3-first",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [firstCommand],
          timeoutMs: 5000,
        },
      }],
    });

    const firstResult = await runWaveWorker({
      taskId: "task-resume3",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config: firstConfig,
    });

    assert.equal(firstResult.status, "completed");
    assert.ok(firstResult.candidate!.differsFromBase, "first candidate should differ from base");

    // The worktree is already at the first candidate state (normalizeCandidate reset HEAD).
    // The executor does not modify files, so the tree should still differ from base.
    const resumeResult = await resumeWaveWorker({
      taskId: "task-resume3",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      priorResult: firstResult,
      feedback: "Confirm the changes are correct.",
      turn: 2,
    });

    // Since the worktree still has the initial.txt file (differs from base),
    // the status should be "completed", not "no_changes".
    assert.equal(resumeResult.status, "completed", "should be completed when tree differs from base");
    assert.ok(resumeResult.candidate!.differsFromBase, "candidate should differ from base");

    // The treeSha should be the same as the prior candidate (no changes made).
    assert.equal(resumeResult.candidate!.treeSha, firstResult.candidate!.treeSha, "treeSha should be unchanged");

    // Now test the actual no_changes branch: create a new worktree and resume
    // with an executor that reverts all changes (deletes initial.txt).
    const revertWorker = await createWorkerWorktree(capture, "task-resume3-revert");
    const revertArtifactDir = join(capture.waveRoot, "artifacts", "task-resume3-revert");
    await mkdir(revertArtifactDir, { recursive: true });

    // First run on the revert worktree: make some changes.
    const revertFirstCommand = join(root, "resume3-revert-first.cjs");
    await writeFile(revertFirstCommand, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'initial.txt'), 'initial\\n');",
      "console.log(JSON.stringify({ type: 'session', sessionId: 'revert-first-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Initial changes.' }));",
    ].join("\n"), "utf8");
    await chmod(revertFirstCommand, 0o755);

    const revertFirstConfig: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "resume3-revert-first" },
      },
      externalAgents: [{
        id: "resume3-revert-first",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [revertFirstCommand],
          timeoutMs: 5000,
        },
      }],
    });

    const revertFirstResult = await runWaveWorker({
      taskId: "task-resume3-revert",
      task: testTask(),
      capture,
      worktree: revertWorker,
      artifactDir: revertArtifactDir,
      config: revertFirstConfig,
    });

    assert.equal(revertFirstResult.status, "completed");
    assert.ok(revertFirstResult.candidate!.differsFromBase, "revert first candidate should differ from base");

    // Resume executor: deletes the file created in the first run.
    const revertCommand = join(root, "resume3-revert.cjs");
    await writeFile(revertCommand, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const filePath = path.join(process.cwd(), 'initial.txt');",
      "if (fs.existsSync(filePath)) fs.unlinkSync(filePath);",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Reverted all changes.' }));",
    ].join("\n"), "utf8");
    await chmod(revertCommand, 0o755);

    const revertConfig: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "resume3-revert" },
      },
      externalAgents: [{
        id: "resume3-revert",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [revertCommand],
          timeoutMs: 5000,
        },
      }],
    });

    const revertResumeResult = await resumeWaveWorker({
      taskId: "task-resume3-revert",
      task: testTask(),
      capture,
      worktree: revertWorker,
      artifactDir: revertArtifactDir,
      config: revertConfig,
      priorResult: revertFirstResult,
      feedback: "Revert all changes.",
      turn: 2,
    });

    // Since the executor deleted the file, the tree should match the base.
    assert.equal(revertResumeResult.status, "no_changes", "should be no_changes when tree matches base");
    assert.equal(revertResumeResult.candidate!.differsFromBase, false, "candidate should not differ from base");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
    await removeWorktree(revertWorker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumeWaveWorker failure paths do not pin accepted refs", async () => {
  const root = await mkTmp("pi-ww-resume4-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-resume4");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-resume4");
    await mkdir(artifactDir, { recursive: true });

    // First run: successful.
    const firstCommand = join(root, "resume4-first.cjs");
    await writeFile(firstCommand, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'initial.txt'), 'initial\\n');",
      "console.log(JSON.stringify({ type: 'session', sessionId: 'first-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Initial changes.' }));",
    ].join("\n"), "utf8");
    await chmod(firstCommand, 0o755);

    const firstConfig: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "resume4-first" },
      },
      externalAgents: [{
        id: "resume4-first",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [firstCommand],
          timeoutMs: 5000,
        },
      }],
    });

    const firstResult = await runWaveWorker({
      taskId: "task-resume4",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config: firstConfig,
    });

    assert.equal(firstResult.status, "completed");

    // Resume with a failing executor (non-zero exit).
    const failCommand = join(root, "resume4-fail.cjs");
    await writeFile(failCommand, [
      "console.log(JSON.stringify({ type: 'session', sessionId: 'fail-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: '' }));",
      "process.exit(1);",
    ].join("\n"), "utf8");
    await chmod(failCommand, 0o755);

    const failConfig: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "resume4-fail" },
      },
      externalAgents: [{
        id: "resume4-fail",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [failCommand],
          timeoutMs: 5000,
        },
      }],
    });

    const failResult = await resumeWaveWorker({
      taskId: "task-resume4",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config: failConfig,
      priorResult: firstResult,
      feedback: "Please fix.",
      turn: 2,
    });

    assert.equal(failResult.status, "executor_error");
    assert.ok(!failResult.candidate, "failure should not produce a candidate");

    // Verify no accepted worker ref was created.
    const acceptedRef = `refs/pi-review-gate/waves/${capture.waveId}/workers/task-resume4`;
    const refExists = await git(
      ["rev-parse", "--verify", acceptedRef],
      worker.worktreeRoot,
    ).catch(() => null);
    assert.equal(refExists, null, "no accepted worker ref should exist");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumeWaveWorker returns cancelled on abort signal", async () => {
  const root = await mkTmp("pi-ww-resume5-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-resume5");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-resume5");
    await mkdir(artifactDir, { recursive: true });

    // First run: successful.
    const firstCommand = join(root, "resume5-first.cjs");
    await writeFile(firstCommand, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'initial.txt'), 'initial\\n');",
      "console.log(JSON.stringify({ type: 'session', sessionId: 'first-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Initial changes.' }));",
    ].join("\n"), "utf8");
    await chmod(firstCommand, 0o755);

    const firstConfig: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "resume5-first" },
      },
      externalAgents: [{
        id: "resume5-first",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [firstCommand],
          timeoutMs: 5000,
        },
      }],
    });

    const firstResult = await runWaveWorker({
      taskId: "task-resume5",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config: firstConfig,
    });

    assert.equal(firstResult.status, "completed");

    // Resume with a slow executor and abort.
    const slowCommand = join(root, "resume5-slow.cjs");
    await writeFile(slowCommand, [
      "setTimeout(() => {",
      "  console.log(JSON.stringify({ type: 'session', sessionId: 'slow-session' }));",
      "  console.log(JSON.stringify({ type: 'assistant', text: 'done' }));",
      "}, 60000);",
    ].join("\n"), "utf8");
    await chmod(slowCommand, 0o755);

    const slowConfig: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "resume5-slow" },
      },
      externalAgents: [{
        id: "resume5-slow",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [slowCommand],
          timeoutMs: 30_000,
        },
      }],
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const cancelResult = await resumeWaveWorker({
      taskId: "task-resume5",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config: slowConfig,
      priorResult: firstResult,
      feedback: "Please fix.",
      turn: 2,
      signal: controller.signal,
    });

    assert.equal(cancelResult.status, "cancelled");
    assert.ok(!cancelResult.candidate, "cancelled should not produce a candidate");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumeWaveWorker rejects turn < 2", async () => {
  const root = await mkTmp("pi-ww-resume6-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-resume6");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-resume6");
    await mkdir(artifactDir, { recursive: true });

    const fakeResult: WaveWorkerResult = {
      status: "completed",
      taskId: "task-resume6",
      title: "Test",
      summary: "done",
      session: { adapter: "test", id: "test-session" },
      candidate: {
        commitSha: capture.baseCommit,
        treeSha: capture.baseCommit,
        candidateRef: "refs/test",
        differsFromBase: false,
      },
      adapter: "test",
    };

    const dummyConfig: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "dummy-exec" },
      },
      externalAgents: [{
        id: "dummy-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [join(root, "dummy.cjs")],
          timeoutMs: 5000,
        },
      }],
    });

    await assert.rejects(
      resumeWaveWorker({
        taskId: "task-resume6",
        task: testTask(),
        capture,
        worktree: worker,
        artifactDir,
        config: dummyConfig,
        priorResult: fakeResult,
        feedback: "fix",
        turn: 1,
      }),
      /turn must be >= 2/,
    );

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumeWaveWorker requires prior session and candidate", async () => {
  const root = await mkTmp("pi-ww-resume7-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-resume7");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-resume7");
    await mkdir(artifactDir, { recursive: true });

    const dummyConfig7: ReviewGateConfig = normalizeConfig({
      enabled: true,
      execution: {
        activeExecutor: { source: "external", id: "dummy-exec7" },
      },
      externalAgents: [{
        id: "dummy-exec7",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [join(root, "dummy7.cjs")],
          timeoutMs: 5000,
        },
      }],
    });

    const noSessionResult: WaveWorkerResult = {
      status: "completed",
      taskId: "task-resume7",
      title: "Test",
      summary: "done",
      adapter: "test",
    };

    await assert.rejects(
      resumeWaveWorker({
        taskId: "task-resume7",
        task: testTask(),
        capture,
        worktree: worker,
        artifactDir,
        config: dummyConfig7,
        priorResult: noSessionResult,
        feedback: "fix",
        turn: 2,
      }),
      /prior result with a session/,
    );

    const noCandidateResult: WaveWorkerResult = {
      status: "completed",
      taskId: "task-resume7",
      title: "Test",
      summary: "done",
      session: { adapter: "test", id: "test-session" },
      adapter: "test",
    };

    await assert.rejects(
      resumeWaveWorker({
        taskId: "task-resume7",
        task: testTask(),
        capture,
        worktree: worker,
        artifactDir,
        config: dummyConfig7,
        priorResult: noCandidateResult,
        feedback: "fix",
        turn: 2,
      }),
      /prior result with a candidate/,
    );

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
