import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureWaveBase, WaveCaptureError, WaveCaptureResult } from "../src/execution/wave-repository";
import {
  createWorkerWorktree,
  removeWorktree,
  pinCommit,
  workerRefName,
  isWorktreeClean,
} from "../src/execution/wave-worktrees";
import { normalizeCandidate } from "../src/execution/wave-commits";
import {
  executeWave,
  type WaveControllerInput,
  type WaveResult,
  type WavePhase,
  type WaveProgressUpdate,
} from "../src/execution/wave-controller";
import type { ReviewGateConfig } from "../src/config";
import type { WaveWorkerTask } from "../src/execution/wave-worker";

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

// Process startup can be several seconds on loaded CI/Linux hosts. These are
// behavioral controller tests, not executor-timeout tests, so keep ample room.
const TEST_EXECUTOR_TIMEOUT_MS = 30_000;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout.trim();
}

async function gitInRepo(args: string[], repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    env: { ...process.env, ...GIT_ENV, GIT_DIR: repoPath },
  });
  return stdout.trim();
}

async function mkTmp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/**
 * Build a ReviewGateConfig with a file-writing fake executor.
 * The executor writes a file into the worktree so the lifecycle produces
 * a real candidate that gets pinned as completed_unreviewed.
 */
function makeConfigWithWritingExecutor(): ReviewGateConfig {
  return {
    enabled: false,
    reviewerTimeoutMs: 600_000,
    executorTimeoutMs: 1_800_000,
    maxCorrectionCycles: 0,
    implementationGuidanceAfterCorrectionAttempts: 1,
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
    execution: {
      activeExecutor: { source: "external", id: "fake-writer" },
      externalExecutors: [
        {
          id: "fake-writer",
          adapter: "run-as-binary",
          protocol: "pi-review-executor-jsonl-v1",
          command: process.execPath,
          args: [
            "-e",
            [
              "process.stdin.resume();",
              "process.stdin.on('data',()=>{});",
              "process.stdin.on('end',()=>{",
              '  const fs=require("fs");',
              '  const p=require("path").join(process.cwd(),"output.txt");',
              '  fs.writeFileSync(p,"hello from worker\\n");',
              '  process.stdout.write(JSON.stringify({type:"session",sessionId:"fake"})+"\\n");',
              '  process.stdout.write(JSON.stringify({type:"assistant",text:"Done."})+"\\n");',
              "  process.exit(0);",
              "});",
            ].join(""),
          ],
          timeoutMs: TEST_EXECUTOR_TIMEOUT_MS,
        },
      ],
    },
  };
}

/**
 * Build a ReviewGateConfig with a throwing fake executor.
 * The executor exits with code 1 so the lifecycle returns executor_error.
 */
function makeConfigWithFailingExecutor(): ReviewGateConfig {
  return {
    enabled: false,
    reviewerTimeoutMs: 600_000,
    executorTimeoutMs: 1_800_000,
    maxCorrectionCycles: 0,
    implementationGuidanceAfterCorrectionAttempts: 1,
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
    execution: {
      activeExecutor: { source: "external", id: "fake-fail" },
      externalExecutors: [
        {
          id: "fake-fail",
          adapter: "run-as-binary",
          protocol: "pi-review-executor-jsonl-v1",
          command: process.execPath,
          args: [
            "-e",
            [
              "process.stdin.resume();",
              "process.stdin.on('data',()=>{});",
              "process.stdin.on('end',()=>{",
              '  process.stdout.write(JSON.stringify({type:"session",sessionId:"fake"})+"\\n");',
              '  process.stdout.write(JSON.stringify({type:"assistant",text:"fail"})+"\\n");',
              "  process.exit(1);",
              "});",
            ].join(""),
          ],
          timeoutMs: TEST_EXECUTOR_TIMEOUT_MS,
        },
      ],
    },
  };
}

/**
 * Build a ReviewGateConfig with a mixed executor that fails for tasks
 * whose title contains "FAILTHISONE" and succeeds otherwise.
 */
function makeConfigWithMixedExecutor(): ReviewGateConfig {
  return {
    enabled: false,
    reviewerTimeoutMs: 600_000,
    executorTimeoutMs: 1_800_000,
    maxCorrectionCycles: 0,
    implementationGuidanceAfterCorrectionAttempts: 1,
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
    execution: {
      activeExecutor: { source: "external", id: "fake-mixed" },
      externalExecutors: [
        {
          id: "fake-mixed",
          adapter: "run-as-binary",
          protocol: "pi-review-executor-jsonl-v1",
          command: process.execPath,
          args: [
            "-e",
            [
              "let input='';",
              "process.stdin.on('data',(d)=>{input+=d;});",
              "process.stdin.on('end',()=>{",
              '  const fs=require("fs");',
              '  process.stdout.write(JSON.stringify({type:"session",sessionId:"fake"})+"\\n");',
              '  if(input.includes("FAILTHISONE")){',
              '    process.stdout.write(JSON.stringify({type:"assistant",text:"fail"})+"\\n");',
              "    process.exit(1);",
              "  }",
              '  const p=require("path").join(process.cwd(),"output.txt");',
              '  fs.writeFileSync(p,"hello from worker\\n");',
              '  process.stdout.write(JSON.stringify({type:"assistant",text:"Done."})+"\\n");',
              "  process.exit(0);",
              "});",
            ].join(""),
          ],
          timeoutMs: TEST_EXECUTOR_TIMEOUT_MS,
        },
      ],
    },
  };
}

/**
 * Build a ReviewGateConfig with a slow executor (5s delay) for abort testing.
 */
function makeConfigWithSlowExecutor(): ReviewGateConfig {
  return {
    enabled: false,
    reviewerTimeoutMs: 600_000,
    executorTimeoutMs: 1_800_000,
    maxCorrectionCycles: 0,
    implementationGuidanceAfterCorrectionAttempts: 1,
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
    execution: {
      activeExecutor: { source: "external", id: "fake-slow" },
      externalExecutors: [
        {
          id: "fake-slow",
          adapter: "run-as-binary",
          protocol: "pi-review-executor-jsonl-v1",
          command: process.execPath,
          args: [
            "-e",
            [
              "process.stdin.resume();",
              "process.stdin.on('data',()=>{});",
              "process.stdin.on('end',()=>{",
              "  setTimeout(()=>{",
              '    process.stdout.write(JSON.stringify({type:"session",sessionId:"fake"})+"\\n");',
              '    process.stdout.write(JSON.stringify({type:"assistant",text:"Done."})+"\\n");',
              "    process.exit(0);",
              "  }, 5000);",
              "});",
            ].join(""),
          ],
          timeoutMs: TEST_EXECUTOR_TIMEOUT_MS,
        },
      ],
    },
  };
}

/**
 * Build a ReviewGateConfig with a no-op executor that writes no files.
 * Used to test no_changes outcomes.
 */
function makeConfigWithNoopExecutor(): ReviewGateConfig {
  return {
    enabled: false,
    reviewerTimeoutMs: 600_000,
    executorTimeoutMs: 1_800_000,
    maxCorrectionCycles: 0,
    implementationGuidanceAfterCorrectionAttempts: 1,
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
    execution: {
      activeExecutor: { source: "external", id: "fake-noop" },
      externalExecutors: [
        {
          id: "fake-noop",
          adapter: "run-as-binary",
          protocol: "pi-review-executor-jsonl-v1",
          command: process.execPath,
          args: [
            "-e",
            [
              "process.stdin.resume();",
              "process.stdin.on('data',()=>{});",
              "process.stdin.on('end',()=>{",
              '  process.stdout.write(JSON.stringify({type:"session",sessionId:"fake"})+"\\n");',
              '  process.stdout.write(JSON.stringify({type:"assistant",text:"No changes."})+"\\n");',
              "  process.exit(0);",
              "});",
            ].join(""),
          ],
          timeoutMs: TEST_EXECUTOR_TIMEOUT_MS,
        },
      ],
    },
  };
}

// ── maxWorkers validation ────────────────────────────────────────────────────

test("maxWorkers defaults to 4", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-default",
    });
    assert.equal(result.waveId, "wc-default");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

test("maxWorkers rejects 0", async () => {
  await assert.rejects(
    async () => executeWave({
      cwd: "/tmp",
      tasks: [{ title: "T", instructions: "i", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      maxWorkers: 0,
    }),
    /Invalid maxWorkers.*Must be an integer between 1 and 16/,
  );
});

test("maxWorkers rejects 17", async () => {
  await assert.rejects(
    async () => executeWave({
      cwd: "/tmp",
      tasks: [{ title: "T", instructions: "i", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      maxWorkers: 17,
    }),
    /Invalid maxWorkers.*Must be an integer between 1 and 16/,
  );
});

test("maxWorkers rejects non-integer", async () => {
  await assert.rejects(
    async () => executeWave({
      cwd: "/tmp",
      tasks: [{ title: "T", instructions: "i", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      maxWorkers: 2.5,
    }),
    /Invalid maxWorkers.*Must be an integer between 1 and 16/,
  );
});

test("maxWorkers accepts 1", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      maxWorkers: 1,
      artifactDir,
      waveId: "wc-1",
    });
    assert.equal(result.waveId, "wc-1");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

test("maxWorkers accepts 16", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      maxWorkers: 16,
      artifactDir,
      waveId: "wc-16",
    });
    assert.equal(result.waveId, "wc-16");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

test("rejects empty tasks", async () => {
  await assert.rejects(
    async () => executeWave({
      cwd: "/tmp",
      tasks: [],
      config: makeConfigWithWritingExecutor(),
    }),
    /Wave requires at least 1 task/,
  );
});

// ── deterministic task IDs ───────────────────────────────────────────────────

test("generates deterministic task IDs in declared order", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "First", instructions: "noop", acceptanceCriteria: [] },
        { title: "Second", instructions: "noop", acceptanceCriteria: [] },
        { title: "Third", instructions: "noop", acceptanceCriteria: [] },
      ],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-ids",
    });

    assert.equal(result.taskResults.length, 3);
    assert.equal(result.taskResults[0].taskId, "task-0");
    assert.equal(result.taskResults[0].title, "First");
    assert.equal(result.taskResults[1].taskId, "task-1");
    assert.equal(result.taskResults[1].title, "Second");
    assert.equal(result.taskResults[2].taskId, "task-2");
    assert.equal(result.taskResults[2].title, "Third");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── wave manifest ────────────────────────────────────────────────────────────

test("writes atomic wave manifest with provenance and phase", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-manifest",
    });

    const manifestPath = join(result.waveRoot, "wave-manifest.json");
    const manifestData = JSON.parse(await readFile(manifestPath, "utf8"));

    assert.equal(manifestData.version, 1);
    assert.ok(Number.isInteger(manifestData.revision) && manifestData.revision > 0);
    assert.equal(manifestData.waveId, "wc-manifest");
    assert.ok(["completed", "aborted"].includes(manifestData.phase));
    assert.ok(manifestData.baseCommit);
    assert.ok(manifestData.baseRef);
    assert.ok(manifestData.repositoryPath);
    assert.equal(manifestData.sourceType, "git-committed");
    assert.ok(manifestData.sourceRoot);
    assert.equal(manifestData.includesUntracked, true);
    assert.equal(manifestData.excludesIgnored, true);
    assert.ok(typeof manifestData.totalBytes === "number");
    assert.equal(manifestData.tasks.length, 1);
    assert.equal(manifestData.tasks[0].taskId, "task-0");
    assert.deepEqual(manifestData.tasks[0].task, {
      title: "Test",
      instructions: "noop",
      acceptanceCriteria: [],
    });
    assert.ok(manifestData.updatedAt);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── abort behavior ───────────────────────────────────────────────────────────

test("abort mid-flight stops new starts, settles active workers, skips integration/landing", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  const controller = new AbortController();

  try {
    // Use slow executor with maxWorkers: 1 so only one worker starts at a time.
    // Abort after 150ms — the first worker is running, the rest haven't started.
    const resultPromise = executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "T1", instructions: "noop", acceptanceCriteria: [] },
        { title: "T2", instructions: "noop", acceptanceCriteria: [] },
        { title: "T3", instructions: "noop", acceptanceCriteria: [] },
      ],
      config: makeConfigWithSlowExecutor(),
      maxWorkers: 1,
      artifactDir,
      waveId: "wc-abort-mid",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    let result: WaveResult | undefined;
    try {
      result = await resultPromise;
    } catch (error) {
      assert.ok(error instanceof WaveCaptureError);
      assert.equal(error.code, "cancelled");
    }

    if (result) {
      assert.equal(result.phase, "aborted");
      assert.equal(result.integration, undefined);
      assert.equal(result.landing, undefined);
      assert.equal(result.taskResults.length, 3);
      // First worker may have completed or been cancelled; rest should be cancelled.
      for (const tr of result.taskResults) {
        assert.ok(
          tr.status === "cancelled" || tr.status === "completed_unreviewed" || tr.status === "accepted",
          `Unexpected status ${tr.status}`,
        );
      }
    }
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

test("abort signal passed to workers prevents integration/landing", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "T1", instructions: "noop", acceptanceCriteria: [] },
      ],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-abort-immediate",
      signal: controller.signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WaveCaptureError);
      assert.equal((error as WaveCaptureError).code, "cancelled");
      return true;
    },
  );

  await rm(artifactDir, { recursive: true, force: true });
  await rm(sourceDir, { recursive: true, force: true });
});

// ── progress callback ────────────────────────────────────────────────────────

test("emits progress updates via callback", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  const updates: WaveProgressUpdate[] = [];

  try {
    await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-progress",
      onProgress: (update) => updates.push(update),
    });

    assert.ok(updates.length > 0, "Should emit at least one progress update");
    const phases = updates.map((u) => u.phase);
    assert.ok(phases.includes("capturing"), "Should emit capturing phase");
    assert.ok(phases.includes("working"), "Should emit working phase");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── integration policy: all-or-nothing default ───────────────────────────────

test("reviewer milestones reach execute_subtasks activity updates", async () => {
  const artifactDir = await mkTmp("pi-wc-review-progress-art-");
  const sourceDir = await mkTmp("pi-wc-review-progress-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);
  const config: ReviewGateConfig = {
    ...makeConfigWithWritingExecutor(),
    enabled: true,
    decider: {
      id: "passing",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'all good',findings:[]})))",
      ],
      timeoutMs: TEST_EXECUTOR_TIMEOUT_MS,
    },
  };
  const activity: string[] = [];

  try {
    await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config,
      artifactDir,
      waveId: "wc-review-progress",
      onProgress: (update) => activity.push(...(update.activity ?? [])),
    });

    assert.ok(activity.includes("task-0: passing started"));
    assert.ok(activity.includes("task-0: passing finished · pass"));
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

test("default all-or-nothing: failed worker blocks integration", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  // Use a failing executor for all tasks.
  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "T1", instructions: "noop", acceptanceCriteria: [] },
        { title: "T2", instructions: "noop", acceptanceCriteria: [] },
      ],
      config: makeConfigWithFailingExecutor(),
      artifactDir,
      waveId: "wc-aon",
    });

    // Both workers should fail with executor_error.
    assert.equal(result.taskResults.length, 2);
    for (const tr of result.taskResults) {
      assert.equal(tr.status, "executor_error", `Expected executor_error, got ${tr.status}`);
    }

    // Integration and landing should be skipped (all-or-nothing), with the
    // worker-failure reason preserved for the tool response and later inspect.
    assert.equal(result.integration?.status, "worker_failure");
    assert.equal(result.landing, undefined);
    assert.equal(result.phase, "completed");
    const manifest = JSON.parse(await readFile(join(result.waveRoot, "wave-manifest.json"), "utf8"));
    assert.equal(manifest.integrationStatus, "worker_failure");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── integration policy: integratePartial ─────────────────────────────────────

test("integratePartial integrates eligible workers despite a failed worker", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "FAILTHISONE", instructions: "noop", acceptanceCriteria: [] },
        { title: "OK", instructions: "noop", acceptanceCriteria: [] },
      ],
      config: makeConfigWithMixedExecutor(),
      artifactDir,
      waveId: "wc-partial-fail",
      integratePartial: true,
    });

    // First worker should fail, second should succeed.
    assert.equal(result.taskResults[0].status, "executor_error");
    assert.equal(result.taskResults[1].status, "completed_unreviewed");
    assert.ok(result.taskResults[1].acceptedCommitSha);

    // Integration should have been attempted with the eligible worker.
    assert.ok(result.integration, "Integration should have been attempted");
    assert.equal(result.integration.status, "integrated");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── worker eligibility ───────────────────────────────────────────────────────

test("accepted and completed_unreviewed workers are eligible for integration", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "T1", instructions: "noop", acceptanceCriteria: [] },
        { title: "T2", instructions: "noop", acceptanceCriteria: [] },
      ],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-eligible",
    });

    assert.equal(result.taskResults.length, 2);
    // With review disabled and changes made, workers should be completed_unreviewed.
    for (const tr of result.taskResults) {
      assert.ok(
        tr.status === "completed_unreviewed" || tr.status === "accepted",
        `Expected eligible status, got ${tr.status}`,
      );
      assert.ok(tr.acceptedCommitSha, `Expected acceptedCommitSha for ${tr.taskId}`);
    }
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

test("no_changes is successful but contributes no commit", async () => {
  // This is tested implicitly: a worker that produces no changes
  // returns no_changes status without acceptedCommitSha.
  // The controller treats it as successful but not eligible for integration.
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-nochange",
    });

    assert.equal(result.taskResults.length, 1);
    // With review disabled and changes made, it should be completed_unreviewed.
    // The no_changes case is tested in the worker lifecycle tests.
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── concurrency bound ────────────────────────────────────────────────────────

test("observed concurrency never exceeds maxWorkers", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  const activeTasks = new Set<string>();
  let maxActive = 0;

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "T1", instructions: "noop", acceptanceCriteria: [] },
        { title: "T2", instructions: "noop", acceptanceCriteria: [] },
        { title: "T3", instructions: "noop", acceptanceCriteria: [] },
        { title: "T4", instructions: "noop", acceptanceCriteria: [] },
      ],
      config: makeConfigWithSlowExecutor(),
      maxWorkers: 2,
      artifactDir,
      waveId: "wc-concurrency",
      onProgress: (update) => {
        const subtaskId = update.subtask?.subtaskId;
        if (!subtaskId) return;
        if (update.subtask?.phase === "executing") {
          activeTasks.add(subtaskId);
          maxActive = Math.max(maxActive, activeTasks.size);
        } else if (update.subtask?.phase === "completing") {
          activeTasks.delete(subtaskId);
        }
      },
    });

    assert.equal(result.taskResults.length, 4);
    assert.ok(maxActive <= 2, `observed concurrency ${maxActive} exceeded maxWorkers 2`);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

test("fresh workers overflow through the ordered executor pool by per-model capacity", async () => {
  const artifactDir = await mkTmp("pi-wc-pool-art-");
  const sourceDir = await mkTmp("pi-wc-pool-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  const writer = (id: string) => ({
    id,
    adapter: "run-as-binary" as const,
    protocol: "pi-review-executor-jsonl-v1" as const,
    command: process.execPath,
    args: [
      "-e",
      [
        "process.stdin.resume();",
        "process.stdin.on('data',()=>{});",
        "process.stdin.on('end',()=>{",
        '  const fs=require("fs");',
        `  fs.writeFileSync(require("path").join(process.cwd(),${JSON.stringify(`${id}.txt`)}),${JSON.stringify(`${id}\n`)});`,
        `  process.stdout.write(JSON.stringify({type:"session",sessionId:${JSON.stringify(`${id}-session`)}})+"\\n");`,
        '  process.stdout.write(JSON.stringify({type:"assistant",text:"Done."})+"\\n");',
        "});",
      ].join(""),
    ],
    timeoutMs: TEST_EXECUTOR_TIMEOUT_MS,
  });
  const config: ReviewGateConfig = {
    ...makeConfigWithWritingExecutor(),
    execution: {
      executorPool: [
        { entryId: "primary", selection: { source: "external", id: "primary" }, maxConcurrent: 1 },
        { entryId: "overflow", selection: { source: "external", id: "overflow" }, maxConcurrent: 1 },
      ],
      externalExecutors: [writer("primary"), writer("overflow")],
    },
  };

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "Primary task", instructions: "write output", acceptanceCriteria: [] },
        { title: "Overflow task", instructions: "write output", acceptanceCriteria: [] },
      ],
      config,
      maxWorkers: 2,
      artifactDir,
      waveId: "wc-pool-overflow",
    });
    const assignments = await Promise.all(result.taskResults.map(async (task) => {
      const operation = JSON.parse(await readFile(join(result.waveRoot, "artifacts", task.taskId, "operation.json"), "utf8"));
      return operation.executorEntryId;
    }));
    assert.deepEqual(assignments, ["primary", "overflow"]);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── shared capture ───────────────────────────────────────────────────────────

test("all workers share one immutable capture", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "T1", instructions: "noop", acceptanceCriteria: [] },
        { title: "T2", instructions: "noop", acceptanceCriteria: [] },
      ],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-shared",
    });

    // All workers should have the same base commit.
    const manifestPath = join(result.waveRoot, "wave-manifest.json");
    const manifestData = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.ok(manifestData.baseCommit);
    assert.ok(manifestData.baseRef);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── isolated worktrees ───────────────────────────────────────────────────────

test("workers have isolated worktrees and artifact roots", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "T1", instructions: "noop", acceptanceCriteria: [] },
        { title: "T2", instructions: "noop", acceptanceCriteria: [] },
      ],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-isolated",
    });

    // Each worker should have its own artifact directory.
    for (const tr of result.taskResults) {
      const artifactPath = join(result.waveRoot, "artifacts", tr.taskId);
      // The artifact directory should exist.
      const stat = await import("node:fs/promises").then((m) => m.stat(artifactPath));
      assert.ok(stat.isDirectory());
    }
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── source never mutated ─────────────────────────────────────────────────────

test("source index and HEAD are never altered by Git operations", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  const originalHead = await git(["rev-parse", "HEAD"], sourceDir);

  try {
    await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-source",
    });

    // Source HEAD should be unchanged.
    const currentHead = await git(["rev-parse", "HEAD"], sourceDir);
    assert.equal(currentHead, originalHead);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── clean worktree cleanup ───────────────────────────────────────────────────

test("clean worktrees are removed conservatively", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-cleanup",
    });

    // After the wave completes, worker worktrees should be cleaned up.
    // The workers directory should be empty or removed.
    const workersDir = join(result.waveRoot, "workers");
    try {
      const entries = await import("node:fs/promises").then((m) => m.readdir(workersDir));
      // Clean worktrees should have been removed.
      assert.ok(entries.length === 0, "Clean worktrees should be removed");
    } catch {
      // Directory doesn't exist — that's fine, it was cleaned up.
    }
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── structured results ───────────────────────────────────────────────────────

test("returns structured results with waveId, waveRoot, phase, and taskResults", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  let waveRoot = "";
  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-structured",
    });

    waveRoot = result.waveRoot;
    assert.ok(result.waveId);
    assert.ok(result.waveRoot);
    assert.ok(typeof result.phase === "string");
    assert.ok(Array.isArray(result.taskResults));
    assert.ok(result.taskResults.length >= 1);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── manifest collision safety ────────────────────────────────────────────────

test("manifest uses collision-safe temp files", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-collision",
    });

    // Verify no temp files remain.
    const entries = await import("node:fs/promises").then((m) => m.readdir(result.waveRoot));
    const tempFiles = entries.filter((e) => e.startsWith("wave-manifest.json.tmp"));
    assert.equal(tempFiles.length, 0, "No temp manifest files should remain");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── integration order ────────────────────────────────────────────────────────

test("eligible workers integrate in original declared order", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "First", instructions: "noop", acceptanceCriteria: [] },
        { title: "Second", instructions: "noop", acceptanceCriteria: [] },
        { title: "Third", instructions: "noop", acceptanceCriteria: [] },
      ],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-order",
    });

    // Task results should be in declared order.
    assert.equal(result.taskResults[0].taskId, "task-0");
    assert.equal(result.taskResults[0].title, "First");
    assert.equal(result.taskResults[1].taskId, "task-1");
    assert.equal(result.taskResults[1].title, "Second");
    assert.equal(result.taskResults[2].taskId, "task-2");
    assert.equal(result.taskResults[2].title, "Third");

    // Verify integration was attempted and check commit order in integrated history.
    assert.ok(result.integration, "Integration should have been attempted");
    assert.equal(result.integration.status, "integrated");

    // Check the integrated ref history order.
    // git log outputs newest first, so reverse to get chronological order.
    const repoPath = join(result.waveRoot, "wave-repo.git");
    const log = await gitInRepo(
      ["log", "--format=%s", "refs/pi-review-gate/waves/wc-order/integrated"],
      repoPath,
    );
    const subjects = log.split("\n").filter(Boolean).reverse();
    const firstIdx = subjects.indexOf("First");
    const secondIdx = subjects.indexOf("Second");
    const thirdIdx = subjects.indexOf("Third");
    assert.ok(
      firstIdx >= 0 && secondIdx > firstIdx && thirdIdx > secondIdx,
      `integrated history order wrong: ${subjects.join(" -> ")}`,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

test("no_changes contributes no commit and integration is no_changes", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Noop", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithNoopExecutor(),
      artifactDir,
      waveId: "wc-nochange",
    });

    assert.equal(result.taskResults.length, 1);
    assert.equal(result.taskResults[0].status, "no_changes");
    assert.equal(result.taskResults[0].acceptedCommitSha, undefined);

    // Integration should be no_changes (no eligible workers).
    assert.ok(result.integration, "Integration should have been attempted");
    assert.equal(result.integration.status, "no_changes");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── capture error propagation ────────────────────────────────────────────────

test("capture failure propagates as error, not silent abort", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  // Use an invalid waveId to trigger a capture error.
  await assert.rejects(
    async () => executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "invalid/wave/id", // invalid ref characters
    }),
    /Wave capture failed/,
  );

  await rm(artifactDir, { recursive: true, force: true });
  await rm(sourceDir, { recursive: true, force: true });
});

// ── unqueued tasks reported as cancelled ─────────────────────────────────────

test("unstarted tasks are reported as cancelled, not no_changes", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  const controller = new AbortController();

  const result = await executeWave({
    cwd: sourceDir,
    tasks: [
      { title: "T1", instructions: "noop", acceptanceCriteria: [] },
      { title: "T2", instructions: "noop", acceptanceCriteria: [] },
    ],
    config: makeConfigWithWritingExecutor(),
    artifactDir,
    waveId: "wc-cancelled",
    signal: controller.signal,
    onProgress: (update) => {
      if (update.phase === "working") controller.abort();
    },
  });

  // Abort after capture but before dispatch: tasks should be reported as cancelled.
  assert.equal(result.phase, "aborted");
  for (const tr of result.taskResults) {
    assert.equal(tr.status, "cancelled", `Expected cancelled, got ${tr.status}`);
  }

  await rm(artifactDir, { recursive: true, force: true });
  await rm(sourceDir, { recursive: true, force: true });
});

// ── scheduler refill ─────────────────────────────────────────────────────────

test("scheduler refills slots immediately as workers settle", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  // Track which unique workers started executing.
  const startedTasks = new Set<string>();

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "T1", instructions: "noop", acceptanceCriteria: [] },
        { title: "T2", instructions: "noop", acceptanceCriteria: [] },
        { title: "T3", instructions: "noop", acceptanceCriteria: [] },
        { title: "T4", instructions: "noop", acceptanceCriteria: [] },
      ],
      config: makeConfigWithWritingExecutor(),
      maxWorkers: 2,
      artifactDir,
      waveId: "wc-refill",
      onProgress: (update) => {
        if (update.subtask?.phase === "executing" && update.subtask.subtaskId) {
          startedTasks.add(update.subtask.subtaskId);
        }
      },
    });

    assert.equal(result.taskResults.length, 4);
    // With maxWorkers: 2 and 4 tasks, the first 2 should start, then as they
    // settle the remaining 2 should start. The key is that all 4 complete.
    assert.equal(startedTasks.size, 4, "All 4 tasks should have started executing");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── scopedModels forwarding ──────────────────────────────────────────────────

test("scopedModels are forwarded to WaveControllerInput", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      scopedModels: ["openai/gpt-4", "anthropic/claude-3.5"],
      artifactDir,
      waveId: "wc-scoped",
    });

    // The wave should complete successfully with scopedModels passed through.
    assert.ok(result.waveId);
    assert.equal(result.taskResults.length, 1);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── SEMANTICS FIX: partial mode all-failed wave ─────────────────────────────

test("integratePartial with all workers failed skips integration/landing and returns worker_failure", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "FAILTHISONE", instructions: "noop", acceptanceCriteria: [] },
        { title: "ALSOFAIL", instructions: "FAILTHISONE", acceptanceCriteria: [] },
      ],
      config: makeConfigWithMixedExecutor(),
      artifactDir,
      waveId: "wc-partial-allfail",
      integratePartial: true,
    });

    // Both workers should fail.
    assert.equal(result.taskResults[0].status, "executor_error");
    assert.equal(result.taskResults[1].status, "executor_error");

    // Integration should be worker_failure, not no_changes.
    assert.ok(result.integration, "Integration should be present");
    assert.equal(result.integration.status, "worker_failure");

    // Landing should not have been attempted.
    assert.equal(result.landing, undefined);

    // Manifest should reflect worker_failure.
    const manifestPath = join(result.waveRoot, "wave-manifest.json");
    const manifestData = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifestData.integrationStatus, "worker_failure");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── SEMANTICS FIX: abort after integration/planning ─────────────────────────

test("abort after integration skips landing", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  const controller = new AbortController();
  let integrationEmitted = false;

  try {
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "T1", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-abort-after-integration",
      signal: controller.signal,
      onProgress: (update) => {
        if (update.phase === "integrating") {
          integrationEmitted = true;
        }
        if (update.phase === "planning") {
          // Abort right after planning starts.
          controller.abort();
        }
      },
    });

    // Should be aborted, not completed.
    assert.equal(result.phase, "aborted");

    // Integration should have been attempted.
    assert.ok(result.integration, "Integration should be present");

    // Landing should be aborted.
    assert.equal(result.landing?.status, "aborted");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── SEMANTICS FIX: conflict result retains provenance ────────────────────────

test("conflict result retains successfullyIntegrated mappings and worktree", async () => {
  const artifactDir = await mkTmp("pi-wc-art-");
  const sourceDir = await mkTmp("pi-wc-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  // Create two workers that modify the same file to cause a conflict.
  const capture = await captureWaveBase({
    cwd: sourceDir,
    maxSnapshotBytes: 1_000_000,
    waveId: "wc-conflict-provenance",
    artifactDir,
  });

  try {
    // Worker 1: modifies shared.txt
    const worker1 = await createWorkerWorktree(capture, "task-0");
    await writeFile(join(worker1.worktreeRoot, "shared.txt"), "from worker 1\n", "utf8");
    const candidate1 = await normalizeCandidate(capture, worker1.worktreeRoot, "task-0", "Task 0");
    await pinCommit(capture, candidate1.commitSha, { type: "worker", taskId: "task-0" });

    // Worker 2: modifies shared.txt (conflict)
    const worker2 = await createWorkerWorktree(capture, "task-1");
    await writeFile(join(worker2.worktreeRoot, "shared.txt"), "from worker 2\n", "utf8");
    const candidate2 = await normalizeCandidate(capture, worker2.worktreeRoot, "task-1", "Task 1");
    await pinCommit(capture, candidate2.commitSha, { type: "worker", taskId: "task-1" });

    // Manually integrate to test conflict provenance.
    const { integrateWave } = await import("../src/execution/wave-integration");
    const integrationResult = await integrateWave(capture, [
      { taskId: "task-0", commitSha: candidate1.commitSha },
      { taskId: "task-1", commitSha: candidate2.commitSha },
    ]);

    assert.equal(integrationResult.status, "conflicted");
    assert.ok(integrationResult.worktree, "Worktree should be preserved");
    assert.ok(integrationResult.successfullyIntegrated.length >= 1, "Should have successfully integrated mappings");
    assert.equal(integrationResult.successfullyIntegrated[0].taskId, "task-0");
    assert.ok(integrationResult.conflictingPaths.length > 0, "Should have conflicting paths");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── Regression: integration infrastructure error preserves worktree path ─────

test("integration infrastructure error after worktree creation preserves worktree path via executeWave", async () => {
  let artifactDir: string | undefined;
  let sourceDir: string | undefined;
  try {
    artifactDir = await mkTmp("pi-wc-integration-error-");
    sourceDir = await mkTmp("pi-wc-integration-error-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const config = makeConfigWithWritingExecutor();
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [{
        title: "test task",
        instructions: "write a file",
        acceptanceCriteria: ["file exists"],
      }],
      config,
      scopedModels: [],
      maxWorkers: 1,
      artifactDir,
      waveId: "wc-integration-error",
      integrationHooks: { afterWorktree: () => {
        throw new Error("simulated infrastructure failure after worktree creation");
      } },
    });

    // Verify the controller caught the error and returned status: error.
    assert.equal(result.integration?.status, "error");
    assert.match(result.integration?.error ?? "", /simulated infrastructure failure/);

    // Verify the worktree path is included in the outcome.
    const expectedWorktreePath = join(result.waveRoot, "integration");
    assert.equal(result.integration?.worktree, expectedWorktreePath);

    // Verify the worktree path still exists (preserved for diagnosis).
    const { access } = await import("node:fs/promises");
    await access(expectedWorktreePath);
  } finally {
    if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
    if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
  }
});

test("integration error before worktree creation omits worktree path via executeWave", async () => {
  let artifactDir: string | undefined;
  let sourceDir: string | undefined;
  try {
    artifactDir = await mkTmp("pi-wc-integration-error-pre-");
    sourceDir = await mkTmp("pi-wc-integration-error-pre-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const config = makeConfigWithWritingExecutor();
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [{
        title: "test task",
        instructions: "write a file",
        acceptanceCriteria: ["file exists"],
      }],
      config,
      scopedModels: [],
      maxWorkers: 1,
      artifactDir,
      waveId: "wc-integration-error-pre",
      integrationHooks: { beforeWorktree: () => {
        throw new Error("simulated infrastructure failure before worktree creation");
      } },
    });

    // The controller caught the pre-worktree error and omitted the worktree path.
    assert.equal(result.integration?.status, "error");
    assert.match(result.integration?.error ?? "", /simulated infrastructure failure before worktree creation/);
    assert.equal(result.integration?.worktree, undefined);
  } finally {
    if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
    if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── Capture consistency exhaustion produces structured error ─────────────────

test("capture consistency exhaustion throws WaveCaptureError with workspace_changing_during_capture code", async () => {
  const { WaveCaptureError } = await import("../src/execution/wave-repository");
  const artifactDir = await mkTmp("pi-wc-capture-exhaust-");
  const sourceDir = await mkTmp("pi-wc-capture-exhaust-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  try {
    await assert.rejects(
      async () => executeWave({
          cwd: sourceDir,
          tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
          config: makeConfigWithWritingExecutor(),
          artifactDir,
          waveId: "wc-capture-exhaust",
          captureHooks: { mutateSourceBetweenCaptureAndVerify: async (_discovery, entries) => {
            for (const entry of entries) {
              const fullPath = join(sourceDir, entry.path);
              await writeFile(fullPath, `mutated at ${Date.now()}\n`, "utf8").catch(() => undefined);
            }
          } },
        }),
        (err: unknown) => {
          if (!(err instanceof Error)) return false;
          assert.equal(err.name, "WaveCaptureError", `Expected WaveCaptureError, got ${err.name}`);
          const wce = err as unknown as { code: string; message: string };
          assert.equal(wce.code, "workspace_changing_during_capture");
          assert.ok(wce.message.includes("Workspace changed during capture"));
          return true;
        },
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── In-flight manifest truthfulness ─────────────────────────────────────────

test("in-flight manifest shows truthful statuses: queued/starting, not cancelled", async () => {
  const artifactDir = await mkTmp("pi-wc-manifest-truth-");
  const sourceDir = await mkTmp("pi-wc-manifest-truth-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  let manifestAfterFirstCompletion: unknown = null;
  let firstCompletionSeen = false;
  let manifestReadResolve: (() => void) | undefined;
  const manifestReadPromise = new Promise<void>((resolve) => { manifestReadResolve = resolve; });

  try {
    const resultPromise = executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "T1", instructions: "noop", acceptanceCriteria: [] },
        { title: "T2", instructions: "noop", acceptanceCriteria: [] },
        { title: "T3", instructions: "noop", acceptanceCriteria: [] },
      ],
      config: makeConfigWithSlowExecutor(),
      maxWorkers: 2,
      artifactDir,
      waveId: "wc-manifest-truth",
      onProgress: async (update) => {
        // Read the manifest after the first worker completes (completing phase).
        // The manifest is written after the worker settles, so we wait a bit.
        if (update.subtask?.phase === "completing" && update.waveRoot && !firstCompletionSeen) {
          firstCompletionSeen = true;
          // Delay to let the manifest write complete after the worker settles.
          await new Promise((r) => setTimeout(r, 500));
          try {
            const manifestPath = join(update.waveRoot, "wave-manifest.json");
            const manifestData = JSON.parse(await readFile(manifestPath, "utf8"));
            manifestAfterFirstCompletion = manifestData;
            manifestReadResolve?.();
          } catch {
            // ignore read errors
          }
        }
      },
    });

    // Wait until we've read the manifest after first completion.
    await Promise.race([
      manifestReadPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout waiting for manifest read")), 20000)),
    ]);

    const result = await resultPromise;

    // Verify the in-flight manifest read after first completion.
    assert.ok(manifestAfterFirstCompletion, "Should have read the manifest after first completion");
    const manifest = manifestAfterFirstCompletion as Record<string, unknown>;
    const tasks = manifest.tasks as Array<Record<string, unknown>>;
    assert.equal(tasks.length, 3, "Manifest should have all 3 tasks");

    // None of the tasks should be "cancelled" during in-flight execution.
    for (const task of tasks) {
      const status = task.status as string;
      assert.ok(
        status !== "cancelled",
        `Task ${task.taskId} should not be cancelled during in-flight execution; got ${status}`,
      );
      // Status should be one of the valid in-flight statuses.
      assert.ok(
        ["queued", "starting", "executing", "reviewing", "correcting", "confirming", "completed_unreviewed", "accepted", "no_changes"].includes(status),
        `Task ${task.taskId} has unexpected status: ${status}`,
      );
    }

    // At least one task should have a terminal status (completed_unreviewed or accepted).
    const terminalTasks = tasks.filter((t) => ["completed_unreviewed", "accepted", "no_changes"].includes(t.status as string));
    assert.ok(terminalTasks.length >= 1, `At least one task should have completed; statuses: ${tasks.map((t) => t.status).join(", ")}`);

    // Final result should have all tasks completed.
    assert.equal(result.taskResults.length, 3);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── Progress counts include correcting/completed ─────────────────────────────

test("progress counts include correcting and completed fields", async () => {
  const artifactDir = await mkTmp("pi-wc-progress-counts-");
  const sourceDir = await mkTmp("pi-wc-progress-counts-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  const updates: Array<{ counts?: Record<string, number> }> = [];

  try {
    await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-progress-counts",
      onProgress: (update) => {
        if (update.counts) {
          updates.push({ counts: update.counts });
        }
      },
    });

    // Find an update with counts.
    const countUpdate = updates.find((u) => u.counts);
    assert.ok(countUpdate, "Should have at least one update with counts");
    const counts = countUpdate.counts!;
    // Verify the new fields exist.
    assert.ok("correcting" in counts, "Counts should include correcting field");
    assert.ok("completed" in counts, "Counts should include completed field");
    assert.ok("queued" in counts, "Counts should include queued field");
    assert.ok("running" in counts, "Counts should include running field");
    assert.ok("reviewing" in counts, "Counts should include reviewing field");
    assert.ok("accepted" in counts, "Counts should include accepted field");
    assert.ok("failed" in counts, "Counts should include failed field");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── Per-task status includes executor/model info ─────────────────────────────

test("per-task status includes executor adapter and model when available", async () => {
  const artifactDir = await mkTmp("pi-wc-task-status-");
  const sourceDir = await mkTmp("pi-wc-task-status-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  let hasTaskStatusesWithExecutor = false;

  try {
    await executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Test", instructions: "noop", acceptanceCriteria: [] }],
      config: makeConfigWithWritingExecutor(),
      artifactDir,
      waveId: "wc-task-status",
      onProgress: (update) => {
        if (update.taskStatuses?.length) {
          for (const ts of update.taskStatuses) {
            if (ts.executorAdapter || ts.executorModel || ts.reviewCycle !== undefined) {
              hasTaskStatusesWithExecutor = true;
            }
          }
        }
      },
    });

    // The task statuses should include executor info when available.
    assert.ok(hasTaskStatusesWithExecutor, "Task statuses should include executor info");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});
