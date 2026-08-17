import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureWaveBase, WaveCaptureResult } from "../src/execution/wave-repository";
import {
  createWorkerWorktree,
  removeWorktree,
  pinCommit,
  workerRefName,
  integrationRefName,
} from "../src/execution/wave-worktrees";
import { normalizeCandidate } from "../src/execution/wave-commits";
import {
  integrateWave,
  type SelectedWorker,
  type WaveIntegrationResult,
  type WaveIntegrationSuccess,
  type WaveIntegrationConflict,
  type WaveIntegrationNoChanges,
} from "../src/execution/wave-integration";

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

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
  const { mkdtemp, realpath } = await import("node:fs/promises");
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/**
 * Full setup: create source repo, capture wave, create workers,
 * normalize candidates, and pin them under worker refs.
 */
async function setupIntegration(
  artifactDir: string,
  taskCount: number,
): Promise<{
  sourceDir: string;
  capture: WaveCaptureResult;
  workers: Array<{ taskId: string; commitSha: string; worktreeRoot: string }>;
}> {
  const sourceDir = await mkTmp("pi-wi-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  const capture = await captureWaveBase({
    cwd: sourceDir,
    maxSnapshotBytes: 1_000_000,
    waveId: "test-wave",
    artifactDir,
  });

  const workers: Array<{ taskId: string; commitSha: string; worktreeRoot: string }> = [];

  for (let i = 0; i < taskCount; i++) {
    const taskId = `task-${i}`;
    const worker = await createWorkerWorktree(capture, taskId);

    // Each worker modifies a different file to avoid conflicts.
    await writeFile(join(worker.worktreeRoot, `file-${i}.txt`), `content-${i}\n`, "utf8");

    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, taskId, `Task ${i}`);

    // Pin the candidate under the worker ref (simulating accepted worker).
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId });

    workers.push({
      taskId,
      commitSha: candidate.commitSha,
      worktreeRoot: worker.worktreeRoot,
    });
  }

  return { sourceDir, capture, workers };
}

// ── Test: deterministic non-conflicting order ────────────────────────────────

test("wave-integration — deterministic non-conflicting order", async () => {
  const artifactDir = await mkTmp("pi-wi-order-");
  try {
    const { capture, workers } = await setupIntegration(artifactDir, 3);

    // Integrate in declared order: task-0, task-1, task-2.
    const selected: SelectedWorker[] = workers.map((w) => ({
      taskId: w.taskId,
      commitSha: w.commitSha,
    }));

    const result = await integrateWave(capture, selected);

    assert.equal(result.status, "integrated");
    const success = result as WaveIntegrationSuccess;

    // Verify order.
    assert.equal(success.workerMappings.length, 3);
    assert.equal(success.workerMappings[0].taskId, "task-0");
    assert.equal(success.workerMappings[0].order, 1);
    assert.equal(success.workerMappings[1].taskId, "task-1");
    assert.equal(success.workerMappings[1].order, 2);
    assert.equal(success.workerMappings[2].taskId, "task-2");
    assert.equal(success.workerMappings[2].order, 3);

    // Verify the integrated ref is pinned.
    const refSha = await gitInRepo(
      ["rev-parse", success.integratedRef],
      capture.repositoryPath,
    );
    assert.equal(refSha, success.finalCommitSha);

    // Verify the history contains the three worker commits plus the wave base.
    // The wave base is parented by the source HEAD, so total = source commits + base + 3 workers.
    assert.ok(success.worktree);
    const log = await git(["log", "--format=%H", "HEAD"], success.worktree);
    const commits = log.split("\n").filter(Boolean);
    assert.ok(commits.length >= 3, "should have at least 3 commits in history");

    // git log is newest-first, so the last 3 commits (most recent) are the worker commits in reverse order.
    assert.equal(commits[0], success.workerMappings[2].integratedCommitSha, "most recent should be task-2");
    assert.equal(commits[1], success.workerMappings[1].integratedCommitSha, "second most recent should be task-1");
    assert.equal(commits[2], success.workerMappings[0].integratedCommitSha, "third most recent should be task-0");

    // Verify validation status.
    assert.equal(success.validationStatus, "not_run");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: first-hash preservation ────────────────────────────────────────────

test("wave-integration — first worker commit hash is preserved", async () => {
  const artifactDir = await mkTmp("pi-wi-first-");
  try {
    const { capture, workers } = await setupIntegration(artifactDir, 2);

    const selected: SelectedWorker[] = workers.map((w) => ({
      taskId: w.taskId,
      commitSha: w.commitSha,
    }));

    const result = await integrateWave(capture, selected);
    const success = result as WaveIntegrationSuccess;

    // First worker's integrated hash should equal its original hash.
    assert.equal(
      success.workerMappings[0].integratedCommitSha,
      success.workerMappings[0].originalCommitSha,
      "first worker hash should be preserved",
    );
    assert.equal(
      success.workerMappings[0].integratedCommitSha,
      workers[0].commitSha,
      "first worker integrated hash should match original",
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: later cherry-pick hashes differ from originals ─────────────────────

test("wave-integration — later cherry-pick hashes differ from originals", async () => {
  const artifactDir = await mkTmp("pi-wi-cherry-");
  try {
    const { capture, workers } = await setupIntegration(artifactDir, 3);

    const selected: SelectedWorker[] = workers.map((w) => ({
      taskId: w.taskId,
      commitSha: w.commitSha,
    }));

    const result = await integrateWave(capture, selected);
    const success = result as WaveIntegrationSuccess;

    // First worker hash is preserved.
    assert.equal(
      success.workerMappings[0].integratedCommitSha,
      success.workerMappings[0].originalCommitSha,
    );

    // Later workers have different integrated hashes (cherry-picked).
    for (let i = 1; i < success.workerMappings.length; i++) {
      assert.notEqual(
        success.workerMappings[i].integratedCommitSha,
        success.workerMappings[i].originalCommitSha,
        `worker ${i} integrated hash should differ from original (cherry-pick)`,
      );
    }
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: overlapping conflict diagnostics ───────────────────────────────────

test("wave-integration — overlapping conflict returns structured diagnostics", async () => {
  const artifactDir = await mkTmp("pi-wi-conflict-");
  try {
    const { capture, workers } = await setupIntegration(artifactDir, 2);

    // Make both workers modify the same file to cause a conflict.
    // Re-normalize the second worker to modify the same file as the first.
    const worker0 = workers[0];
    const worker1 = workers[1];

    // Modify the same file in worker 1's worktree.
    await writeFile(join(worker1.worktreeRoot, "file-0.txt"), "conflicting-content\n", "utf8");
    const newCandidate = await normalizeCandidate(
      capture,
      worker1.worktreeRoot,
      worker1.taskId,
      "Task 1 conflicting",
      { commitSha: worker1.commitSha },
    );

    // Re-pin using a new task ID since worker refs are immutable.
    const newTaskId = `${worker1.taskId}-v2`;
    await pinCommit(capture, newCandidate.commitSha, { type: "worker", taskId: newTaskId });

    const selected: SelectedWorker[] = [
      { taskId: worker0.taskId, commitSha: worker0.commitSha },
      { taskId: newTaskId, commitSha: newCandidate.commitSha },
    ];

    const result = await integrateWave(capture, selected);

    assert.equal(result.status, "conflicted");
    const conflict = result as WaveIntegrationConflict;

    // Verify conflict diagnostics.
    assert.equal(conflict.conflictingTaskId, newTaskId);
    assert.equal(conflict.conflictingCommitSha, newCandidate.commitSha);
    assert.ok(conflict.conflictingPaths.length > 0, "should have conflicting paths");
    assert.ok(conflict.conflictingPaths.includes("file-0.txt"), "should include conflicting file");
    assert.ok(conflict.gitDiagnostics.length > 0, "should have git diagnostics");

    // Verify first worker was successfully integrated.
    assert.equal(conflict.successfullyIntegrated.length, 1);
    assert.equal(conflict.successfullyIntegrated[0].taskId, worker0.taskId);

    // Verify the integrated ref was NOT pinned.
    const integratedRef = integrationRefName(capture.waveId);
    try {
      await gitInRepo(["rev-parse", "--verify", integratedRef], capture.repositoryPath);
      assert.fail("integrated ref should not be pinned on conflict");
    } catch {
      // Expected — ref should not exist.
    }

    // Verify the worktree is preserved.
    assert.ok(conflict.worktree, "worktree path should be preserved");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: ref mismatch rejection ─────────────────────────────────────────────

test("wave-integration — ref mismatch is rejected", async () => {
  const artifactDir = await mkTmp("pi-wi-ref-mismatch-");
  try {
    const { capture, workers } = await setupIntegration(artifactDir, 1);

    // Try to integrate with a commit SHA that doesn't match the pinned ref.
    const selected: SelectedWorker[] = [
      {
        taskId: workers[0].taskId,
        commitSha: "0000000000000000000000000000000000000000", // Wrong SHA.
      },
    ];

    await assert.rejects(
      integrateWave(capture, selected),
      /does not match pinned ref/,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: unpinned worker rejection ──────────────────────────────────────────

test("wave-integration — unpinned worker is rejected", async () => {
  const artifactDir = await mkTmp("pi-wi-unpinned-");
  try {
    const { capture, workers } = await setupIntegration(artifactDir, 1);

    // Try to integrate a task that was never pinned.
    const selected: SelectedWorker[] = [
      {
        taskId: "nonexistent-task",
        commitSha: workers[0].commitSha,
      },
    ];

    await assert.rejects(
      integrateWave(capture, selected),
      /not pinned/,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: wrong-parent rejection ─────────────────────────────────────────────

test("wave-integration — wrong-parent commit is rejected", async () => {
  const artifactDir = await mkTmp("pi-wi-wrong-parent-");
  try {
    const { capture, workers } = await setupIntegration(artifactDir, 1);

    // Create a commit with a different parent (not the wave base).
    // Create a commit chain: base -> intermediate -> badCommit.
    const worker = workers[0];
    const treeSha = await git(["rev-parse", `${capture.baseCommit}^{tree}`], worker.worktreeRoot);
    const intermediateCommit = await git(
      ["commit-tree", treeSha, "-p", capture.baseCommit, "-m", "intermediate"],
      worker.worktreeRoot,
    );
    const badCommit = await git(
      ["commit-tree", treeSha, "-p", intermediateCommit, "-m", "bad parent"],
      worker.worktreeRoot,
    );

    // Pin the bad commit under a new worker ref (worker refs are immutable).
    const badTaskId = `${worker.taskId}-bad`;
    await pinCommit(capture, badCommit, { type: "worker", taskId: badTaskId });

    const selected: SelectedWorker[] = [
      { taskId: badTaskId, commitSha: badCommit },
    ];

    await assert.rejects(
      integrateWave(capture, selected),
      /expected wave base/,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: empty input returns no_changes ─────────────────────────────────────

test("wave-integration — empty input returns no_changes", async () => {
  const artifactDir = await mkTmp("pi-wi-empty-");
  try {
    const sourceDir = await mkTmp("pi-wi-empty-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "empty-wave",
      artifactDir,
    });

    const result = await integrateWave(capture, []);

    assert.equal(result.status, "no_changes");
    const noChanges = result as WaveIntegrationNoChanges;

    assert.equal(noChanges.baseCommitSha, capture.baseCommit);
    assert.equal(noChanges.workerMappings.length, 0);
    assert.equal(noChanges.validationStatus, "not_run");

    // Verify the integrated ref is pinned to the base.
    const refSha = await gitInRepo(
      ["rev-parse", noChanges.integratedRef],
      capture.repositoryPath,
    );
    assert.equal(refSha, capture.baseCommit);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: stable worker refs remain unchanged after integration ──────────────

test("wave-integration — stable worker refs remain unchanged after integration", async () => {
  const artifactDir = await mkTmp("pi-wi-stable-");
  try {
    const { capture, workers } = await setupIntegration(artifactDir, 3);

    // Record the original worker ref SHAs.
    const originalRefShas = new Map<string, string>();
    for (const w of workers) {
      const ref = workerRefName(capture.waveId, w.taskId);
      const sha = await gitInRepo(["rev-parse", ref], capture.repositoryPath);
      originalRefShas.set(w.taskId, sha);
    }

    // Integrate.
    const selected: SelectedWorker[] = workers.map((w) => ({
      taskId: w.taskId,
      commitSha: w.commitSha,
    }));
    await integrateWave(capture, selected);

    // Verify worker refs are unchanged.
    for (const w of workers) {
      const ref = workerRefName(capture.waveId, w.taskId);
      const sha = await gitInRepo(["rev-parse", ref], capture.repositoryPath);
      assert.equal(
        sha,
        originalRefShas.get(w.taskId),
        `worker ref for ${w.taskId} should be unchanged`,
      );
    }
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: source workspace untouched ─────────────────────────────────────────

test("wave-integration — source workspace files/index/HEAD remain untouched", async () => {
  const artifactDir = await mkTmp("pi-wi-source-");
  try {
    const sourceDir = await mkTmp("pi-wi-source-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
    await writeFile(join(sourceDir, "app.js"), "console.log('hi');\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    // Record source state before integration.
    const originalHead = await git(["rev-parse", "HEAD"], sourceDir);
    const originalStatus = await git(["status", "--porcelain"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "source-wave",
      artifactDir,
    });

    // Create and pin a worker.
    const worker = await createWorkerWorktree(capture, "task-src");
    await writeFile(join(worker.worktreeRoot, "new.txt"), "new\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-src", "Task");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-src" });

    // Integrate.
    const result = await integrateWave(capture, [
      { taskId: "task-src", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");

    // Verify source workspace is untouched.
    const afterHead = await git(["rev-parse", "HEAD"], sourceDir);
    const afterStatus = await git(["status", "--porcelain"], sourceDir);

    assert.equal(afterHead, originalHead, "source HEAD should be unchanged");
    assert.equal(afterStatus, originalStatus, "source status should be unchanged");

    // Verify source files are unchanged.
    const readmeContent = await readFile(join(sourceDir, "readme.md"), "utf8");
    assert.equal(readmeContent, "# hello\n");
    const appContent = await readFile(join(sourceDir, "app.js"), "utf8");
    assert.equal(appContent, "console.log('hi');\n");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: single worker integration ──────────────────────────────────────────

test("wave-integration — single worker integration preserves hash", async () => {
  const artifactDir = await mkTmp("pi-wi-single-");
  try {
    const { capture, workers } = await setupIntegration(artifactDir, 1);

    const selected: SelectedWorker[] = [
      { taskId: workers[0].taskId, commitSha: workers[0].commitSha },
    ];

    const result = await integrateWave(capture, selected);
    const success = result as WaveIntegrationSuccess;

    assert.equal(success.workerMappings.length, 1);
    assert.equal(success.finalCommitSha, workers[0].commitSha);
    assert.equal(success.workerMappings[0].integratedCommitSha, workers[0].commitSha);

    // Verify the integrated ref points to the original commit.
    const refSha = await gitInRepo(
      ["rev-parse", success.integratedRef],
      capture.repositoryPath,
    );
    assert.equal(refSha, workers[0].commitSha);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: integration order independent of completion timing ─────────────────

test("wave-integration — integration order is declared input order", async () => {
  const artifactDir = await mkTmp("pi-wi-declared-");
  try {
    const { capture, workers } = await setupIntegration(artifactDir, 3);

    // Integrate in reverse order: task-2, task-1, task-0.
    const selected: SelectedWorker[] = [
      { taskId: "task-2", commitSha: workers[2].commitSha },
      { taskId: "task-1", commitSha: workers[1].commitSha },
      { taskId: "task-0", commitSha: workers[0].commitSha },
    ];

    const result = await integrateWave(capture, selected);
    const success = result as WaveIntegrationSuccess;

    // Verify the declared order is preserved.
    assert.equal(success.workerMappings[0].taskId, "task-2");
    assert.equal(success.workerMappings[1].taskId, "task-1");
    assert.equal(success.workerMappings[2].taskId, "task-0");

    // Verify the first in declared order is preserved.
    assert.equal(success.workerMappings[0].integratedCommitSha, workers[2].commitSha);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: conflict at first cherry-pick (second worker) ──────────────────────

test("wave-integration — conflict at second worker preserves first", async () => {
  const artifactDir = await mkTmp("pi-wi-conflict-second-");
  try {
    const { capture, workers } = await setupIntegration(artifactDir, 2);

    // Make both workers modify the same file.
    const worker0 = workers[0];
    const worker1 = workers[1];

    await writeFile(join(worker1.worktreeRoot, "file-0.txt"), "conflict\n", "utf8");
    const newCandidate = await normalizeCandidate(
      capture,
      worker1.worktreeRoot,
      worker1.taskId,
      "Task 1 conflict",
      { commitSha: worker1.commitSha },
    );
    // Use a new task ID since worker refs are immutable.
    const newTaskId = `${worker1.taskId}-v2`;
    await pinCommit(capture, newCandidate.commitSha, { type: "worker", taskId: newTaskId });

    const selected: SelectedWorker[] = [
      { taskId: worker0.taskId, commitSha: worker0.commitSha },
      { taskId: newTaskId, commitSha: newCandidate.commitSha },
    ];

    const result = await integrateWave(capture, selected);
    const conflict = result as WaveIntegrationConflict;

    // First worker should be in successfullyIntegrated.
    assert.equal(conflict.successfullyIntegrated.length, 1);
    assert.equal(conflict.successfullyIntegrated[0].taskId, worker0.taskId);
    assert.equal(conflict.successfullyIntegrated[0].integratedCommitSha, worker0.commitSha);

    // Conflicting worker should be identified.
    assert.equal(conflict.conflictingTaskId, newTaskId);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: identical sibling patches retain redundant commits ─────────────────

test("wave-integration — identical sibling patches integrate without conflict", async () => {
  const artifactDir = await mkTmp("pi-wi-identical-");
  try {
    const { capture, workers } = await setupIntegration(artifactDir, 2);

    // Make both workers produce identical trees (same single file change).
    const worker0 = workers[0];
    const worker1 = workers[1];

    // Remove worker 1's own file so its tree matches worker 0's exactly.
    await rm(join(worker1.worktreeRoot, "file-1.txt"));
    await writeFile(join(worker1.worktreeRoot, "file-0.txt"), "content-0\n", "utf8");
    const newCandidate = await normalizeCandidate(
      capture,
      worker1.worktreeRoot,
      worker1.taskId,
      "Task 1 identical",
      { commitSha: worker1.commitSha },
    );
    // Use a new task ID since worker refs are immutable.
    const newTaskId = `${worker1.taskId}-v2`;
    await pinCommit(capture, newCandidate.commitSha, { type: "worker", taskId: newTaskId });

    // Assert both candidates have identical trees (true empty cherry-pick).
    const tree0 = await gitInRepo(["rev-parse", `${worker0.commitSha}^{tree}`], capture.repositoryPath);
    const tree1 = await gitInRepo(["rev-parse", `${newCandidate.commitSha}^{tree}`], capture.repositoryPath);
    assert.equal(tree0, tree1, "both candidates should have identical trees");

    const selected: SelectedWorker[] = [
      { taskId: worker0.taskId, commitSha: worker0.commitSha },
      { taskId: newTaskId, commitSha: newCandidate.commitSha },
    ];

    const result = await integrateWave(capture, selected);

    // Should integrate successfully, not conflict.
    assert.equal(result.status, "integrated");
    const success = result as WaveIntegrationSuccess;

    // First worker hash is preserved.
    assert.equal(success.workerMappings[0].integratedCommitSha, worker0.commitSha);

    // Second worker has a different integrated hash (empty-kept cherry-pick commit).
    assert.notEqual(
      success.workerMappings[1].integratedCommitSha,
      success.workerMappings[1].originalCommitSha,
      "second worker integrated hash should differ (empty-kept commit)",
    );

    // Both workers are in the mappings.
    assert.equal(success.workerMappings.length, 2);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
