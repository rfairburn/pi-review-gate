import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureWaveBase, WaveCaptureResult } from "../src/execution/wave-repository";
import { createWorkerWorktree, removeWorktree, workerRefName } from "../src/execution/wave-worktrees";
import { reviewerProgressLabel, runWaveWorkerLifecycle, type WaveWorkerLifecycleResult } from "../src/execution/wave-worker-lifecycle";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import type { WaveWorkerTask } from "../src/execution/wave-worker";

// ── helpers ──────────────────────────────────────────────────────────────────

async function mkTmp(prefix: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
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

async function gitInRepo(args: string[], repoPath: string): Promise<string> {
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
    cwd: repoPath,
    env: { ...process.env, ...GIT_ENV, GIT_DIR: repoPath },
  });
  return stdout.trim();
}

/** Create a committed source repo and capture it. */
async function setupCapture(artifactDir: string): Promise<{ sourceDir: string; capture: WaveCaptureResult }> {
  const sourceDir = await mkTmp("pi-wwl-src-");
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

function testTask(): WaveWorkerTask {
  return {
    title: "Test lifecycle task",
    instructions: "Create worker-output.txt with the requested content.",
    acceptanceCriteria: ["worker-output.txt exists with content"],
  };
}

/** Create a fake executor that writes a file and returns a response. */
async function createFakeExecutor(root: string, fileName = "worker-output.txt", content = "worker done", sessionId = "test-session-id"): Promise<{ command: string }> {
  const command = join(root, "fake-executor.cjs");
  await writeFile(command, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `fs.writeFileSync(path.join(process.cwd(), ${JSON.stringify(fileName)}), ${JSON.stringify(content)} + '\\n');`,
    `console.log(JSON.stringify({ type: 'session', sessionId: ${JSON.stringify(sessionId)} }));`,
    "console.log(JSON.stringify({ type: 'assistant', text: 'Implemented the change.' }));",
  ].join("\n"), "utf8");
  await chmod(command, 0o755);
  return { command };
}

/** Create a fake executor that does nothing. */
async function createNoOpExecutor(root: string): Promise<{ command: string }> {
  const command = join(root, "noop-executor.cjs");
  await writeFile(command, [
    "console.log(JSON.stringify({ type: 'session', sessionId: 'noop-session' }));",
    "console.log(JSON.stringify({ type: 'assistant', text: 'No changes needed.' }));",
  ].join("\n"), "utf8");
  await chmod(command, 0o755);
  return { command };
}

/** Build a config with a fake executor. */
function buildConfig(command: string, executorId = "fake-exec"): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    execution: {
      activeExecutor: { source: "external", id: executorId },
    },
    externalAgents: [{
      id: executorId,
      adapter: "run-as-binary",
      command: process.execPath,
      execution: {
        protocol: "pi-review-executor-jsonl-v1",
        args: [command],
        timeoutMs: 15000,
      },
    }],
  });
}

/** Build a config with a passing reviewer. */
function buildPassingReviewerConfig(executorCommand: string): ReviewGateConfig {
  return {
    ...buildConfig(executorCommand),
    enabled: true,
    decider: {
      id: "passing",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'all good',findings:[]})))",
      ],
      timeoutMs: 15000,
    },
  };
}

/** Build a config with a needs_changes reviewer. */
function buildNeedsChangesReviewerConfig(executorCommand: string): ReviewGateConfig {
  return {
    ...buildConfig(executorCommand),
    enabled: true,
    decider: {
      id: "blocking",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'x.ts',line:null,issue:'missing test',recommendation:'add coverage'}]})))",
      ],
      timeoutMs: 15000,
    },
  };
}

/** Build a config with a reviewer that errors. */
function buildErrorReviewerConfig(executorCommand: string): ReviewGateConfig {
  return {
    ...buildConfig(executorCommand),
    enabled: true,
    decider: {
      id: "erroring",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>{throw new Error('reviewer crash');})",
      ],
      timeoutMs: 15000,
    },
  };
}

function buildPassWithReviewerErrorConfig(executorCommand: string): ReviewGateConfig {
  const passing = buildPassingReviewerConfig(executorCommand).decider!;
  const erroring = buildErrorReviewerConfig(executorCommand).decider!;
  return {
    ...buildConfig(executorCommand),
    enabled: true,
    decider: undefined,
    reviewers: [passing, erroring],
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

test("review progress prefers model names over unique reviewer ids", () => {
  assert.equal(reviewerProgressLabel({
    id: "reviewer-7e86e3f2",
    adapter: "codex-cli",
    model: "openai-codex/gpt-5.6-luna",
  }), "openai-codex/gpt-5.6-luna");
  assert.equal(reviewerProgressLabel({
    id: "little-coder-openai-codex-gpt-5-6-luna",
    adapter: "little-coder-model",
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "high",
  }), "openai-codex/gpt-5.6-luna (high)");
  assert.equal(reviewerProgressLabel({
    id: "reviewer-without-model-metadata",
    adapter: "generic-cli",
    command: "reviewer",
  }), "reviewer-without-model-metadata");
});

test("lifecycle: pass + unchanged confirmation accepts and pins worker ref", async () => {
  const root = await mkTmp("pi-wwl-pass-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-pass");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-pass");
    await mkdir(artifactDir, { recursive: true });

    // Executor writes a file.
    const { command } = await createFakeExecutor(root);
    const config = buildPassingReviewerConfig(command);
    const updates: Array<{ phase: string; message: string }> = [];

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-pass",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      onUpdate: (update) => updates.push(update),
    });

    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);
    assert.ok(result.acceptedRef, "should have acceptedRef");
    assert.ok(result.acceptedCommitSha, "should have acceptedCommitSha");
    assert.equal(result.unreviewed, undefined, "should not be unreviewed");
    assert.equal(result.reviewCycles.length, 1, "should have exactly one review cycle");
    assert.equal(result.reviewCycles[0].verdict, "pass");
    assert.ok(updates.some((update) => update.phase === "reviewing" && update.message === "passing started"));
    assert.ok(updates.some((update) => update.phase === "reviewing" && update.message === "passing finished · pass"));

    // Verify the worker ref points to the accepted commit.
    const refSha = await gitInRepo(
      ["rev-parse", result.acceptedRef!],
      capture.repositoryPath,
    );
    assert.equal(refSha, result.acceptedCommitSha, "worker ref should point to accepted commit");

    // Verify result.json was written.
    const resultJson = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8"));
    assert.equal(resultJson.status, "accepted");
    assert.equal(resultJson.taskId, "task-pass");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: pass plus reviewer infrastructure error accepts with warnings and remains integration-eligible", async () => {
  const root = await mkTmp("pi-wwl-pass-warning-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-pass-warning");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-pass-warning");
    await mkdir(artifactDir, { recursive: true });
    const { command } = await createFakeExecutor(root);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-pass-warning",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config: buildPassWithReviewerErrorConfig(command),
    });

    assert.equal(result.status, "accepted_with_warnings");
    assert.ok(result.acceptedRef);
    assert.ok(result.acceptedCommitSha);
    assert.equal(result.reviewReport?.aggregate, "pass_with_warnings");
    assert.deepEqual(result.reviewReport?.reviewers.map((reviewer) => reviewer.verdict), ["pass", "error"]);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: pass then mutation causes re-review", async () => {
  const root = await mkTmp("pi-wwl-pass-mutate-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-mutate");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-mutate");
    await mkdir(artifactDir, { recursive: true });

    // Single executor: on start writes initial.txt; on resume also writes mutated.txt.
    // This simulates the executor making additional changes after the pass observation.
    const command = join(root, "mutate-executor.cjs");
    await writeFile(command, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const isResume = process.env.PI_REVIEW_EXECUTOR_OPERATION === 'resume';",
      "fs.writeFileSync(path.join(process.cwd(), 'initial.txt'), 'initial' + String.fromCharCode(10));",
      "if (isResume) {",
      "  fs.writeFileSync(path.join(process.cwd(), 'mutated.txt'), 'mutated' + String.fromCharCode(10));",
      "}",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'mutate-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: isResume ? 'Mutated after pass.' : 'Initial changes.' }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config = buildPassingReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-mutate",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    // The lifecycle should detect the mutation and re-review.
    // Since the resume executor also writes mutated.txt, the tree changes.
    // The second review should pass (same passing reviewer).
    // After the second pass, the confirmation is also a resume, so it also writes mutated.txt (same tree).
    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);
    assert.ok(result.reviewCycles.length >= 2, `should have at least 2 review cycles, got ${result.reviewCycles.length}`);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: needs_changes correction then pass", async () => {
  const root = await mkTmp("pi-wwl-correction-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-correct");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-correct");
    await mkdir(artifactDir, { recursive: true });

    // First executor: writes initial file.
    const firstCommand = join(root, "correct-first.cjs");
    await writeFile(firstCommand, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'initial.txt'), 'initial' + String.fromCharCode(10));",
      "console.log(JSON.stringify({ type: 'session', sessionId: 'correct-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Initial changes.' }));",
    ].join("\n"), "utf8");
    await chmod(firstCommand, 0o755);

    // Resume executor: writes corrected file (different content).
    const resumeCommand = join(root, "correct-resume.cjs");
    await writeFile(resumeCommand, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'corrected.txt'), 'corrected' + String.fromCharCode(10));",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Applied corrections.' }));",
    ].join("\n"), "utf8");
    await chmod(resumeCommand, 0o755);

    // Config: needs_changes reviewer, maxCorrectionCycles=2.
    const firstConfig = buildNeedsChangesReviewerConfig(firstCommand);
    firstConfig.maxCorrectionCycles = 2;

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-correct",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config: firstConfig,
    });

    // First review: needs_changes. Correction runs. Second review: needs_changes again (same reviewer).
    // Since the reviewer always returns needs_changes, it should hit the correction cap.
    assert.equal(result.status, "correction_cap", `expected correction_cap, got ${result.status}`);
    assert.ok(result.reviewCycles.length >= 1, "should have at least one review cycle");
    assert.equal(result.reviewCycles[0].verdict, "needs_changes");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: steering during review aborts reviewers and resumes the executor before fresh review", async () => {
  const root = await mkTmp("pi-wwl-review-steer-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-review-steer");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-review-steer");
    await mkdir(artifactDir, { recursive: true });
    const executor = join(root, "review-steer-executor.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');",
      "const turn=Number(process.env.PI_REVIEW_EXECUTOR_TURN||'1');",
      "fs.writeFileSync('steered.txt',turn===1?'true\\n':'false\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'review-steer-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:'turn '+turn+' complete'}));",
    ].join("\n"), "utf8");
    const config: ReviewGateConfig = {
      ...buildConfig(executor),
      enabled: true,
      decider: {
        id: "slow-pass",
        adapter: "generic-cli",
        command: process.execPath,
        args: ["-e", [
          "const fs=require('node:fs');const path=require('node:path');",
          "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{",
          "const request=fs.readFileSync(path.join(process.env.PI_REVIEW_GATE_BUNDLE_DIR,'request.md'),'utf8');",
          "const visible=request.includes('[steer:review-steer-1] Write false instead.')&&request.includes('Later updates supersede');",
          "process.stdout.write(JSON.stringify(visible?{verdict:'pass',summary:'authoritative steering visible',findings:[]}:{verdict:'needs_changes',summary:'steering missing',findings:[{severity:'blocking',issue:'steering missing',recommendation:'include steering'}]}));",
          "},2000))",
        ].join("")],
        timeoutMs: 5_000,
      },
    };
    let steered = false;
    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-review-steer",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      onLiveControl: (control) => {
        if (steered || control?.protocol !== "review-to-executor-handoff-v1") return;
        steered = true;
        void control.steer("Write false instead.", "review-steer-1");
      },
    });

    assert.equal(steered, true);
    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}: ${result.error ?? result.summary}`);
    assert.equal(await readFile(join(worker.worktreeRoot, "steered.txt"), "utf8"), "false\n");
    assert.ok(result.reviewCycles.every((cycle) => cycle.verdict === "pass"));
    const persisted = JSON.parse(await readFile(join(artifactDir, "task.json"), "utf8"));
    assert.deepEqual(persisted.task.authoritativeUpdates.map((item: { instructionId: string }) => item.instructionId), ["review-steer-1"]);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: correction cap reached", async () => {
  const root = await mkTmp("pi-wwl-cap-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-cap");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-cap");
    await mkdir(artifactDir, { recursive: true });

    // Executor that always writes a new file (different each time).
    const command = join(root, "cap-executor.cjs");
    await writeFile(command, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const turn = process.env.PI_REVIEW_EXECUTOR_TURN || '1';",
      "fs.writeFileSync(path.join(process.cwd(), `file-${turn}.txt`), `content-${turn}` + String.fromCharCode(10));",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'cap-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Changes applied.' }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config = buildNeedsChangesReviewerConfig(command);
    config.maxCorrectionCycles = 1;

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-cap",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "correction_cap", `expected correction_cap, got ${result.status}`);
    assert.ok(result.error?.includes("cap") || result.error?.includes("1"), `error should mention cap: ${result.error}`);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: review disabled returns completed_unreviewed", async () => {
  const root = await mkTmp("pi-wwl-disabled-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-disabled");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-disabled");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildConfig(command);
    config.enabled = false; // Disable review

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-disabled",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "completed_unreviewed", `expected completed_unreviewed, got ${result.status}`);
    assert.equal(result.unreviewed, true, "should be explicitly unreviewed");
    assert.ok(result.acceptedRef, "should have acceptedRef even when unreviewed");
    assert.ok(result.acceptedCommitSha, "should have acceptedCommitSha");
    assert.equal(result.reviewCycles.length, 0, "should have no review cycles");

    // Verify the worker ref was pinned.
    const refSha = await gitInRepo(
      ["rev-parse", result.acceptedRef!],
      capture.repositoryPath,
    );
    assert.equal(refSha, result.acceptedCommitSha, "worker ref should point to unreviewed commit");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: mode-only candidate is reviewed", async () => {
  const root = await mkTmp("pi-wwl-mode-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-mode");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-mode");
    await mkdir(artifactDir, { recursive: true });

    // Executor that changes file mode only.
    const command = join(root, "mode-executor.cjs");
    await writeFile(command, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.chmodSync(path.join(process.cwd(), 'app.js'), 0o755);",
      "console.log(JSON.stringify({ type: 'session', sessionId: 'mode-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Made executable.' }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config = buildPassingReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-mode",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);
    assert.equal(result.reviewCycles.length, 1, "should have one review cycle");
    assert.equal(result.reviewCycles[0].verdict, "pass");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: reviewer error returns review_error", async () => {
  const root = await mkTmp("pi-wwl-review-err-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-review-err");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-review-err");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildErrorReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-review-err",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "review_error", `expected review_error, got ${result.status}`);
    assert.ok(result.error, "should have error message");
    assert.ok(!result.acceptedRef, "should not have acceptedRef on review error");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: accepted ref hash matches the passed candidate", async () => {
  const root = await mkTmp("pi-wwl-ref-hash-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-ref-hash");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-ref-hash");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildPassingReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-ref-hash",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted");

    // The accepted ref should point to the passed candidate commit.
    const refSha = await gitInRepo(
      ["rev-parse", result.acceptedRef!],
      capture.repositoryPath,
    );
    assert.equal(refSha, result.acceptedCommitSha, "accepted ref should match accepted commit SHA");

    // The accepted commit should be the same as the one from the review cycle.
    assert.equal(result.reviewCycles[0].candidateCommit, result.acceptedCommitSha,
      "review cycle candidate should match accepted commit");

    // Verify the worker ref name format.
    const expectedRef = workerRefName(capture.waveId, "task-ref-hash");
    assert.equal(result.acceptedRef, expectedRef, "accepted ref should match expected format");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: no_changes executor returns no_changes", async () => {
  const root = await mkTmp("pi-wwl-noc-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-noc");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-noc");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createNoOpExecutor(root);
    const config = buildPassingReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-noc",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "no_changes", `expected no_changes, got ${result.status}`);
    assert.equal(result.reviewCycles.length, 0, "should have no review cycles");
    assert.ok(!result.acceptedRef, "should not have acceptedRef for no_changes");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: result.json written to artifact root", async () => {
  const root = await mkTmp("pi-wwl-result-json-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-result-json");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-result-json");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildPassingReviewerConfig(command);

    await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-result-json",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    // Verify result.json exists and has correct structure.
    const resultJson = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8"));
    assert.equal(resultJson.version, 1);
    assert.equal(resultJson.status, "accepted");
    assert.equal(resultJson.taskId, "task-result-json");
    assert.ok(resultJson.acceptedRef, "should have acceptedRef in result.json");
    assert.ok(resultJson.acceptedCommitSha, "should have acceptedCommitSha in result.json");
    assert.ok(Array.isArray(resultJson.reviewCycles), "should have reviewCycles array");
    assert.ok(resultJson.completedAt, "should have completedAt timestamp");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: no reviewers configured returns completed_unreviewed", async () => {
  const root = await mkTmp("pi-wwl-no-reviewers-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-no-reviewers");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-no-reviewers");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    // Config with no decider and no reviewers.
    const config = buildConfig(command);
    delete config.decider;
    config.reviewers = [];

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-no-reviewers",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "completed_unreviewed", `expected completed_unreviewed, got ${result.status}`);
    assert.equal(result.unreviewed, true);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: cancelled via abort signal", async () => {
  const root = await mkTmp("pi-wwl-cancel-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-cancel");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-cancel");
    await mkdir(artifactDir, { recursive: true });

    // Slow executor to give time for abort.
    const command = join(root, "cancel-executor.cjs");
    await writeFile(command, [
      "setTimeout(() => {",
      "  console.log(JSON.stringify({ type: 'session', sessionId: 'cancel-session' }));",
      "  console.log(JSON.stringify({ type: 'assistant', text: 'done' }));",
      "}, 60000);",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config = buildPassingReviewerConfig(command);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-cancel",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      signal: controller.signal,
    });

    assert.equal(result.status, "cancelled", `expected cancelled, got ${result.status}`);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: failed workers are not pinned", async () => {
  const root = await mkTmp("pi-wwl-no-pin-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-no-pin");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-no-pin");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildErrorReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-no-pin",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "review_error");
    assert.ok(!result.acceptedRef, "should not have acceptedRef on review error");

    // Verify no worker ref was created.
    const expectedRef = workerRefName(capture.waveId, "task-no-pin");
    const refExists = await gitInRepo(
      ["rev-parse", "--verify", expectedRef],
      capture.repositoryPath,
    ).catch(() => null);
    assert.equal(refExists, null, "no worker ref should exist for failed lifecycle");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: correction cap with no-progress detection", async () => {
  const root = await mkTmp("pi-wwl-no-progress-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-no-progress");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-no-progress");
    await mkdir(artifactDir, { recursive: true });

    // Executor that always writes the same file (no progress).
    const command = join(root, "no-progress-executor.cjs");
    await writeFile(command, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'same.txt'), 'same content' + String.fromCharCode(10));",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'np-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Same changes.' }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config = buildNeedsChangesReviewerConfig(command);
    config.maxCorrectionCycles = 3;

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-no-progress",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    // Should detect no progress and return correction_cap.
    assert.equal(result.status, "correction_cap", `expected correction_cap, got ${result.status}`);
    assert.ok(result.error?.includes("progress") || result.error?.includes("cap"),
      `error should mention progress or cap: ${result.error}`);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── Focused tests for lifecycle stabilization ────────────────────────────────

test("lifecycle: reviewer-blocked does not create artifact directory", async () => {
  const root = await mkTmp("pi-wwl-blocked-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-blocked");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-blocked");
    // Do NOT pre-create the artifact directory.

    // Config with duplicate enabled reviewer ids causes reviewer_blocked.
    const config = buildConfig(await createFakeExecutor(root).then((e) => e.command));
    config.enabled = true;
    config.decider = undefined;
    config.reviewers = [
      {
        id: "dup-reviewer",
        adapter: "generic-cli" as const,
        command: process.execPath,
        args: ["-e", "process.stdout.write('{}')"],
        timeoutMs: 15000,
      },
      {
        id: "dup-reviewer",
        adapter: "generic-cli" as const,
        command: process.execPath,
        args: ["-e", "process.stdout.write('{}')"],
        timeoutMs: 15000,
      },
    ];

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-blocked",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "reviewer_blocked");

    // Verify the artifact directory was NOT created.
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(artifactDir), /ENOENT/,
      "artifact directory should not be created for reviewer-blocked");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: reviewer receives task acceptance criteria in evidence", async () => {
  const root = await mkTmp("pi-wwl-evidence-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-evidence");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-evidence");
    await mkdir(artifactDir, { recursive: true });

    // Executor writes a file.
    const { command } = await createFakeExecutor(root);

    // Reviewer checks that the prompt contains acceptance criteria.
    const config: ReviewGateConfig = {
      ...buildConfig(command),
      enabled: true,
      decider: {
        id: "evidence-checker",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdin.resume();",
            "let s='';",
            "process.stdin.on('data',c=>s+=c);",
            "process.stdin.on('end',()=>{",
            "const ok=s.includes('Acceptance criteria:')",
            "&& s.includes('worker-output.txt exists with content')",
            "&& s.includes('Task instructions:')",
            "&& s.includes('Create worker-output.txt')",
            "&& s.includes('Workspace snapshot disclosure:')",
            "&& s.includes('Git-ignored files are not present');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'evidence complete',findings:[]}",
            ":{verdict:'needs_changes',summary:'missing evidence',findings:[]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-evidence",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: reviewer receives the executor's isolated path mapping", async () => {
  const root = await mkTmp("pi-wwl-review-paths-");
  try {
    const { sourceDir, capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-review-paths");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-review-paths");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root, "absolute-output.txt");
    const aliasRoot = sourceDir + "-lexical-alias";
    const expectedWorkerPath = join(worker.worktreeRoot, "absolute-output.txt");
    const config: ReviewGateConfig = {
      ...buildConfig(command),
      enabled: true,
      decider: {
        id: "path-mapping-checker",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdin.resume();",
            "let s='';",
            "process.stdin.on('data',c=>s+=c);",
            "process.stdin.on('end',()=>{",
            `const sourceRoot=${JSON.stringify(sourceDir)};`,
            `const aliasRoot=${JSON.stringify(aliasRoot)};`,
            `const workerPath=${JSON.stringify(expectedWorkerPath)};`,
            "const ok=!s.includes(sourceRoot)&&!s.includes(aliasRoot)&&s.includes(workerPath);",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'review paths are isolated',findings:[]}",
            ":{verdict:'needs_changes',summary:'review received source paths',findings:[{severity:'blocking',file:'session',line:null,issue:'source path leaked',recommendation:'rewrite it'}]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: sourceDir,
      sourceRootAliases: [aliasRoot],
      taskId: "task-review-paths",
      task: {
        title: `Create ${sourceDir}/absolute-output.txt`,
        instructions: `Create ${sourceDir}/absolute-output.txt and verify it via ${aliasRoot}/absolute-output.txt.`,
        acceptanceCriteria: [
          `${sourceDir}/absolute-output.txt exists`,
          `${aliasRoot}/absolute-output.txt has the requested content`,
        ],
        relevantContext: `The requested file is ${sourceDir}/absolute-output.txt.`,
      },
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: accepted HEAD equals exact passed candidate hash", async () => {
  const root = await mkTmp("pi-wwl-head-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-head");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-head");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildPassingReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-head",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted");

    // Verify the worktree HEAD is at the accepted commit.
    const headSha = await git(["rev-parse", "HEAD"], worker.worktreeRoot);
    assert.equal(headSha, result.acceptedCommitSha,
      "worktree HEAD should equal accepted commit SHA");

    // Verify the worker ref points to the same commit.
    const refSha = await gitInRepo(
      ["rev-parse", result.acceptedRef!],
      capture.repositoryPath,
    );
    assert.equal(refSha, result.acceptedCommitSha,
      "worker ref should equal accepted commit SHA");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: correction exchange history preserved across cycles", async () => {
  const root = await mkTmp("pi-wwl-exchange-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-exchange");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-exchange");
    await mkdir(artifactDir, { recursive: true });

    // Executor that always writes a file (different each time).
    const command = join(root, "exchange-executor.cjs");
    await writeFile(command, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const turn = process.env.PI_REVIEW_EXECUTOR_TURN || '1';",
      "fs.writeFileSync(path.join(process.cwd(), `file-${turn}.txt`), `content-${turn}` + String.fromCharCode(10));",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'exchange-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Changes applied.' }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    // Reviewer always returns needs_changes.
    const config = buildNeedsChangesReviewerConfig(command);
    config.maxCorrectionCycles = 2;

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-exchange",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "correction_cap");
    // Should have at least 2 review cycles (initial + 1 correction).
    assert.ok(result.reviewCycles.length >= 2,
      `should have at least 2 review cycles, got ${result.reviewCycles.length}`);

    // Each cycle should have a distinct candidate commit.
    const shas = result.reviewCycles.map((c) => c.candidateCommit);
    const uniqueShas = new Set(shas);
    assert.ok(uniqueShas.size >= 2,
      `should have at least 2 distinct candidate commits, got ${uniqueShas.size}`);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: invalid maxCorrectionCycles fails safely", async () => {
  const root = await mkTmp("pi-wwl-invalid-cap-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-invalid-cap");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-invalid-cap");
    // Do NOT pre-create the artifact directory.

    const { command } = await createFakeExecutor(root);
    const config = buildPassingReviewerConfig(command);

    // Test negative value.
    const result1 = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-invalid-cap",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      maxCorrectionCycles: -1,
    });
    assert.equal(result1.status, "review_error");
    assert.ok(result1.error?.includes("Invalid maxCorrectionCycles"),
      `error should mention invalid maxCorrectionCycles: ${result1.error}`);

    // Test non-integer value.
    const result2 = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-invalid-cap",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      maxCorrectionCycles: 1.5 as any,
    });
    assert.equal(result2.status, "review_error");

    // Verify artifact directory was NOT created for invalid values.
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(artifactDir), /ENOENT/,
      "artifact directory should not be created for invalid maxCorrectionCycles");

    // Test undefined (should use config default, not fail).
    // Use a separate artifact dir to avoid interference.
    const artifactDir2 = join(capture.waveRoot, "artifacts", "task-invalid-cap-2");
    const result3 = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-invalid-cap-2",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir: artifactDir2,
      config,
      maxCorrectionCycles: undefined,
    });
    // Should proceed normally (not review_error from validation).
    assert.notEqual(result3.status, "review_error",
      "undefined maxCorrectionCycles should use config default");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
