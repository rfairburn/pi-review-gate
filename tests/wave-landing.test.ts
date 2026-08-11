import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureWaveBase, WaveCaptureResult } from "../src/execution/wave-repository";
import {
  createWorkerWorktree,
  pinCommit,
} from "../src/execution/wave-worktrees";
import { normalizeCandidate } from "../src/execution/wave-commits";
import {
  integrateWave,
  type SelectedWorker,
  type WaveIntegrationSuccess,
} from "../src/execution/wave-integration";
import {
  executeWaveLanding,
  planWaveLanding,
  validatePathSafe,
  type LandingPlan,
  type LandingPath,
} from "../src/execution/wave-landing";

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
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/**
 * Full setup: create source repo, capture wave, create workers,
 * normalize candidates, pin them, and integrate.
 */
async function setupLanding(
  artifactDir: string,
  taskCount: number,
): Promise<{
  sourceDir: string;
  capture: WaveCaptureResult;
  integration: WaveIntegrationSuccess;
}> {
  const sourceDir = await mkTmp("pi-wl-src-");
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

  const workers: Array<{ taskId: string; commitSha: string }> = [];

  for (let i = 0; i < taskCount; i++) {
    const taskId = `task-${i}`;
    const worker = await createWorkerWorktree(capture, taskId);

    // Each worker modifies a different file.
    await writeFile(join(worker.worktreeRoot, `file-${i}.txt`), `content-${i}\n`, "utf8");

    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, taskId, `Task ${i}`);
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId });

    workers.push({ taskId, commitSha: candidate.commitSha });
  }

  const selected: SelectedWorker[] = workers.map((w) => ({
    taskId: w.taskId,
    commitSha: w.commitSha,
  }));

  const result = await integrateWave(capture, selected);
  assert.equal(result.status, "integrated");

  return {
    sourceDir,
    capture,
    integration: result as WaveIntegrationSuccess,
  };
}

test("wave landing supports SHA-256 object-format repositories", async (t) => {
  const sourceDir = await mkTmp("pi-wl-sha256-src-");
  const artifactDir = await mkTmp("pi-wl-sha256-artifact-");
  try {
    try {
      await git(["init", "--quiet", "--object-format=sha256"], sourceDir);
    } catch {
      t.skip("installed Git does not support SHA-256 repositories");
      return;
    }
    await writeFile(join(sourceDir, "base.txt"), "base\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "base"], sourceDir);
    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      artifactDir,
      waveId: "sha256-wave",
    });
    assert.equal(capture.baseCommit.length, 64);
    const worker = await createWorkerWorktree(capture, "task-sha256");
    await writeFile(join(worker.worktreeRoot, "result.txt"), "result\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-sha256", "SHA-256 task");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-sha256" });
    const integrated = await integrateWave(capture, [{ taskId: "task-sha256", commitSha: candidate.commitSha }]);
    assert.equal(integrated.status, "integrated");
    if (integrated.status !== "integrated") return;
    const plan = await planWaveLanding(capture, integrated.finalCommitSha, sourceDir);
    const landed = await executeWaveLanding(plan, capture);
    assert.equal(landed.status, "landed");
    assert.equal(await readFile(join(sourceDir, "result.txt"), "utf8"), "result\n");
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: modify action (current == base) ────────────────────────────────────

test("wave-landing — modify action when current equals base", async () => {
  const artifactDir = await mkTmp("pi-wl-modify-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // The wave added file-0.txt. Source still has the base state (readme.md only).
    // file-0.txt is a new file in the wave, absent in base, present in result.
    // Source doesn't have it → apply.
    assert.equal(plan.paths.length, 1);
    const path = plan.paths[0] as LandingPath;
    assert.equal(path.path, "file-0.txt");
    assert.equal(path.action, "apply");
    assert.equal(path.base, null);
    assert.ok(path.result !== null);
    assert.equal(path.result!.blobId!.length, 40);
    assert.equal(path.result!.mode, "100644");

    assert.equal(plan.changedPaths.length, 1);
    assert.equal(plan.changedPaths[0], "file-0.txt");
    assert.equal(plan.conflicts.length, 0);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: add action (new file) ──────────────────────────────────────────────

test("wave-landing — add action for new file", async () => {
  const artifactDir = await mkTmp("pi-wl-add-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // file-0.txt is new (absent in base, present in result).
    // Source doesn't have it → apply.
    const path = plan.paths[0] as LandingPath;
    assert.equal(path.action, "apply");
    assert.equal(path.base, null);
    assert.ok(path.result !== null);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: delete action ──────────────────────────────────────────────────────

test("wave-landing — delete action when file removed in wave", async () => {
  const artifactDir = await mkTmp("pi-wl-delete-");
  try {
    const sourceDir = await mkTmp("pi-wl-delete-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "to-delete.txt"), "will be deleted\n", "utf8");
    await writeFile(join(sourceDir, "keep.txt"), "keep\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "delete-wave",
      artifactDir,
    });

    // Create a worker that deletes to-delete.txt.
    const worker = await createWorkerWorktree(capture, "task-del");
    await rm(join(worker.worktreeRoot, "to-delete.txt"));
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-del", "Delete");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-del" });

    const result = await integrateWave(capture, [
      { taskId: "task-del", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // to-delete.txt: present in base, absent in result, present on source → apply (delete).
    const deletePath = plan.paths.find((p) => p.path === "to-delete.txt")!;
    assert.equal(deletePath.action, "apply");
    assert.ok(deletePath.base !== null);
    assert.equal(deletePath.result, null);

    assert.ok(plan.changedPaths.includes("to-delete.txt"));
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: mode change action ─────────────────────────────────────────────────

test("wave-landing — mode change action", async () => {
  const artifactDir = await mkTmp("pi-wl-mode-");
  try {
    const sourceDir = await mkTmp("pi-wl-mode-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "script.sh"), "#!/bin/sh\necho hi\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "mode-wave",
      artifactDir,
    });

    // Create a worker that makes the script executable.
    const worker = await createWorkerWorktree(capture, "task-mode");
    await chmod(join(worker.worktreeRoot, "script.sh"), 0o755);
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mode", "Make executable");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mode" });

    const result = await integrateWave(capture, [
      { taskId: "task-mode", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // script.sh: base mode 100644, result mode 100755, source mode 100644 → apply.
    const path = plan.paths[0] as LandingPath;
    assert.equal(path.path, "script.sh");
    assert.equal(path.action, "apply");
    assert.equal(path.base!.mode, "100644");
    assert.equal(path.result!.mode, "100755");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: symlink action ─────────────────────────────────────────────────────

test("wave-landing — symlink action", async () => {
  const artifactDir = await mkTmp("pi-wl-symlink-");
  try {
    const sourceDir = await mkTmp("pi-wl-symlink-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "target.txt"), "target content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "symlink-wave",
      artifactDir,
    });

    // Create a worker that adds a symlink.
    const worker = await createWorkerWorktree(capture, "task-sym");
    await symlink("target.txt", join(worker.worktreeRoot, "link.txt"));
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-sym", "Add symlink");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-sym" });

    const result = await integrateWave(capture, [
      { taskId: "task-sym", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // link.txt: absent in base, present in result (symlink), absent on source → apply.
    const linkPath = plan.paths.find((p) => p.path === "link.txt")!;
    assert.equal(linkPath.action, "apply");
    assert.equal(linkPath.base, null);
    assert.equal(linkPath.result!.mode, "120000");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: escaping symlink rejected ──────────────────────────────────────────

test("wave-landing execute — escaping symlink is rejected at candidate normalization", async () => {
  const artifactDir = await mkTmp("pi-wl-escape-sym-");
  try {
    const sourceDir = await mkTmp("pi-wl-escape-sym-src-");
    const outsideDir = await mkTmp("pi-wl-escape-sym-out-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "target.txt"), "target content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const markerPath = join(outsideDir, "marker.txt");
    await writeFile(markerPath, "secret\n", "utf8");

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "escape-sym-wave",
      artifactDir,
    });

    // Worker adds a symlink pointing outside the source root (absolute target).
    const worker = await createWorkerWorktree(capture, "task-escape");
    await symlink(markerPath, join(worker.worktreeRoot, "link.txt"));

    // Candidate normalization rejects the escaping symlink before pinning.
    await assert.rejects(
      normalizeCandidate(capture, worker.worktreeRoot, "task-escape", "Add escaping symlink"),
      /Symlink target is absolute and rejected/,
    );

    // The outside marker must be unchanged.
    assert.equal(await readFile(markerPath, "utf8"), "secret\n");

    // No link.txt was created in the source directory.
    await assert.rejects(
      lstat(join(sourceDir, "link.txt")),
      /ENOENT/,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: binary file action ─────────────────────────────────────────────────

test("wave-landing — binary file action", async () => {
  const artifactDir = await mkTmp("pi-wl-binary-");
  try {
    const sourceDir = await mkTmp("pi-wl-binary-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "data.bin"), Buffer.from([0x00, 0x01, 0x02, 0xFF]));
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "binary-wave",
      artifactDir,
    });

    // Create a worker that modifies the binary file.
    const worker = await createWorkerWorktree(capture, "task-bin");
    await writeFile(join(worker.worktreeRoot, "data.bin"), Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]));
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-bin", "Modify binary");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-bin" });

    const result = await integrateWave(capture, [
      { taskId: "task-bin", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // data.bin: present in base, present in result, source == base → apply.
    const path = plan.paths[0] as LandingPath;
    assert.equal(path.path, "data.bin");
    assert.equal(path.action, "apply");
    assert.ok(path.base!.blobId !== path.result!.blobId, "blob IDs should differ");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: already-applied path ───────────────────────────────────────────────

test("wave-landing — already-applied path (current == result)", async () => {
  const artifactDir = await mkTmp("pi-wl-applied-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    // Manually apply the change to the source filesystem.
    await writeFile(join(sourceDir, "file-0.txt"), "content-0\n", "utf8");

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // file-0.txt: absent in base, present in result, source has same content → already_applied.
    const path = plan.paths[0] as LandingPath;
    assert.equal(path.action, "already_applied");
    assert.equal(path.base, null);
    assert.ok(path.result !== null);

    assert.equal(plan.changedPaths.length, 0);
    assert.equal(plan.conflicts.length, 0);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: local same-path drift conflict ─────────────────────────────────────

test("wave-landing — local same-path drift conflict", async () => {
  const artifactDir = await mkTmp("pi-wl-drift-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    // Modify the source file to something different from both base and result.
    await writeFile(join(sourceDir, "readme.md"), "# modified locally\n", "utf8");

    // The wave added file-0.txt, but readme.md was also modified locally.
    // Since readme.md is not in the wave delta, it should not appear.
    // file-0.txt is new → apply.
    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Only file-0.txt should be in the plan (readme.md is not in the wave delta).
    assert.equal(plan.paths.length, 1);
    assert.equal(plan.paths[0].path, "file-0.txt");
    assert.equal(plan.paths[0].action, "apply");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: newly-created path collision ───────────────────────────────────────

test("wave-landing — newly-created path collision conflict", async () => {
  const artifactDir = await mkTmp("pi-wl-collision-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    // Create the file that the wave wants to add, with different content.
    await writeFile(join(sourceDir, "file-0.txt"), "different content\n", "utf8");

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // file-0.txt: absent in base, present in result, source has different content → conflict.
    const path = plan.paths[0] as LandingPath;
    assert.equal(path.action, "conflict");
    assert.ok(path.conflictReason?.includes("Newly created path"));

    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].path, "file-0.txt");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: unrelated local edits allowed ──────────────────────────────────────

test("wave-landing — unrelated local edits do not block", async () => {
  const artifactDir = await mkTmp("pi-wl-unrelated-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    // Create an unrelated file on the source filesystem.
    await writeFile(join(sourceDir, "unrelated.txt"), "unrelated\n", "utf8");

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Only file-0.txt should be in the plan.
    assert.equal(plan.paths.length, 1);
    assert.equal(plan.paths[0].path, "file-0.txt");
    assert.equal(plan.paths[0].action, "apply");
    assert.equal(plan.conflicts.length, 0);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: source HEAD drift recorded but not blocking ────────────────────────

test("wave-landing — source HEAD drift recorded but not blocking", async () => {
  const artifactDir = await mkTmp("pi-wl-head-drift-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    // Make a new commit on the source to create HEAD drift.
    await writeFile(join(sourceDir, "new-commit.txt"), "new\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "drift commit"], sourceDir);

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // HEAD drift should be recorded.
    assert.equal(plan.headDrift.drifted, true);
    assert.ok(plan.headDrift.capturedHead !== undefined);
    assert.ok(plan.headDrift.currentHead !== undefined);
    assert.notEqual(plan.headDrift.capturedHead, plan.headDrift.currentHead);

    // But the plan should still succeed (drift does not block).
    assert.equal(plan.paths.length, 1);
    assert.equal(plan.paths[0].action, "apply");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: renamed paths as delete+add ────────────────────────────────────────

test("wave-landing — renamed paths appear as delete+add (no rename detection)", async () => {
  const artifactDir = await mkTmp("pi-wl-rename-");
  try {
    const sourceDir = await mkTmp("pi-wl-rename-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "original.txt"), "original content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rename-wave",
      artifactDir,
    });

    // Create a worker that "renames" the file (delete old, add new).
    const worker = await createWorkerWorktree(capture, "task-rename");
    await rm(join(worker.worktreeRoot, "original.txt"));
    await writeFile(join(worker.worktreeRoot, "renamed.txt"), "original content\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-rename", "Rename");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-rename" });

    const result = await integrateWave(capture, [
      { taskId: "task-rename", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Should see two paths: original.txt (delete) and renamed.txt (add).
    assert.equal(plan.paths.length, 2);

    const deletePath = plan.paths.find((p) => p.path === "original.txt")!;
    assert.equal(deletePath.action, "apply");
    assert.ok(deletePath.base !== null);
    assert.equal(deletePath.result, null);

    const addPath = plan.paths.find((p) => p.path === "renamed.txt")!;
    assert.equal(addPath.action, "apply");
    assert.equal(addPath.base, null);
    assert.ok(addPath.result !== null);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: integrated ref mismatch ────────────────────────────────────────────

test("wave-landing — integrated ref mismatch throws", async () => {
  const artifactDir = await mkTmp("pi-wl-ref-mismatch-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    // Try to plan with a wrong commit SHA.
    await assert.rejects(
      planWaveLanding(capture, "0000000000000000000000000000000000000000", sourceDir),
      /Ref mismatch/,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: source index/files unchanged by planning ───────────────────────────

test("wave-landing — source index and files unchanged by planning", async () => {
  const artifactDir = await mkTmp("pi-wl-unchanged-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    // Record source state before planning.
    const originalHead = await git(["rev-parse", "HEAD"], sourceDir);
    const originalStatus = await git(["status", "--porcelain"], sourceDir);
    const originalReadme = await readFile(join(sourceDir, "readme.md"), "utf8");

    // Run the plan.
    await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Verify source is unchanged.
    const afterHead = await git(["rev-parse", "HEAD"], sourceDir);
    const afterStatus = await git(["status", "--porcelain"], sourceDir);
    const afterReadme = await readFile(join(sourceDir, "readme.md"), "utf8");

    assert.equal(afterHead, originalHead, "source HEAD should be unchanged");
    assert.equal(afterStatus, originalStatus, "source status should be unchanged");
    assert.equal(afterReadme, originalReadme, "source files should be unchanged");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: modify conflict (source differs from both base and result) ─────────

test("wave-landing — modify conflict when source differs from both base and result", async () => {
  const artifactDir = await mkTmp("pi-wl-modify-conflict-");
  try {
    const sourceDir = await mkTmp("pi-wl-modify-conflict-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "config.json"), '{"version": 1}\n', "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "modify-conflict-wave",
      artifactDir,
    });

    // Create a worker that modifies config.json.
    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "config.json"), '{"version": 2}\n', "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify config");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    // Modify the source file to something different from both base and result.
    await writeFile(join(sourceDir, "config.json"), '{"version": 3}\n', "utf8");

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // config.json: present in base, present in result, source differs from both → conflict.
    const path = plan.paths[0] as LandingPath;
    assert.equal(path.action, "conflict");
    assert.ok(path.conflictReason?.includes("differs from both"));

    assert.equal(plan.conflicts.length, 1);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: delete already applied (file already removed from source) ──────────

test("wave-landing — delete already applied when file already removed from source", async () => {
  const artifactDir = await mkTmp("pi-wl-del-applied-");
  try {
    const sourceDir = await mkTmp("pi-wl-del-applied-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "to-delete.txt"), "will be deleted\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "del-applied-wave",
      artifactDir,
    });

    // Create a worker that deletes the file.
    const worker = await createWorkerWorktree(capture, "task-del");
    await rm(join(worker.worktreeRoot, "to-delete.txt"));
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-del", "Delete");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-del" });

    const result = await integrateWave(capture, [
      { taskId: "task-del", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    // Manually delete the file from source.
    await rm(join(sourceDir, "to-delete.txt"));

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // to-delete.txt: present in base, absent in result, absent on source → already_applied.
    const path = plan.paths[0] as LandingPath;
    assert.equal(path.action, "already_applied");
    assert.ok(path.base !== null);
    assert.equal(path.result, null);

    assert.equal(plan.changedPaths.length, 0);
    assert.equal(plan.conflicts.length, 0);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: modify already applied (source == result) ──────────────────────────

test("wave-landing — modify already applied when source matches result", async () => {
  const artifactDir = await mkTmp("pi-wl-mod-applied-");
  try {
    const sourceDir = await mkTmp("pi-wl-mod-applied-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "config.json"), '{"version": 1}\n', "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "mod-applied-wave",
      artifactDir,
    });

    // Create a worker that modifies config.json.
    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "config.json"), '{"version": 2}\n', "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    // Manually apply the change to source.
    await writeFile(join(sourceDir, "config.json"), '{"version": 2}\n', "utf8");

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // config.json: source == result → already_applied.
    const path = plan.paths[0] as LandingPath;
    assert.equal(path.action, "already_applied");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: multiple paths with mixed actions ──────────────────────────────────

test("wave-landing — multiple paths with mixed actions", async () => {
  const artifactDir = await mkTmp("pi-wl-mixed-");
  try {
    const sourceDir = await mkTmp("pi-wl-mixed-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "keep.txt"), "keep\n", "utf8");
    await writeFile(join(sourceDir, "to-delete.txt"), "delete me\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "mixed-wave",
      artifactDir,
    });

    // Worker 1: add a new file.
    const worker1 = await createWorkerWorktree(capture, "task-add");
    await writeFile(join(worker1.worktreeRoot, "new.txt"), "new\n", "utf8");
    const candidate1 = await normalizeCandidate(capture, worker1.worktreeRoot, "task-add", "Add");
    await pinCommit(capture, candidate1.commitSha, { type: "worker", taskId: "task-add" });

    // Worker 2: delete a file.
    const worker2 = await createWorkerWorktree(capture, "task-del");
    await rm(join(worker2.worktreeRoot, "to-delete.txt"));
    const candidate2 = await normalizeCandidate(capture, worker2.worktreeRoot, "task-del", "Delete");
    await pinCommit(capture, candidate2.commitSha, { type: "worker", taskId: "task-del" });

    const result = await integrateWave(capture, [
      { taskId: "task-add", commitSha: candidate1.commitSha },
      { taskId: "task-del", commitSha: candidate2.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    // Pre-apply the delete on source.
    await rm(join(sourceDir, "to-delete.txt"));

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // new.txt: apply, to-delete.txt: already_applied.
    const newPath = plan.paths.find((p) => p.path === "new.txt")!;
    assert.equal(newPath.action, "apply");

    const delPath = plan.paths.find((p) => p.path === "to-delete.txt")!;
    assert.equal(delPath.action, "already_applied");

    assert.equal(plan.changedPaths.length, 1);
    assert.equal(plan.changedPaths[0], "new.txt");
    assert.equal(plan.conflicts.length, 0);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: plan returns correct integrated ref and commit ─────────────────────

test("wave-landing — plan returns correct integrated ref and commit", async () => {
  const artifactDir = await mkTmp("pi-wl-ref-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    assert.equal(plan.integratedCommitSha, integration.finalCommitSha);
    assert.ok(plan.integratedRef.includes("test-wave"));
    assert.ok(plan.integratedRef.includes("integrated"));
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: no changes wave produces empty plan ────────────────────────────────

test("wave-landing — no changes wave produces empty plan", async () => {
  const artifactDir = await mkTmp("pi-wl-noc-");
  try {
    const sourceDir = await mkTmp("pi-wl-noc-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "noc-wave",
      artifactDir,
    });

    // Integrate with empty selection.
    const result = await integrateWave(capture, []);
    assert.equal(result.status, "no_changes");

    // Plan landing with the base commit (no changes).
    const plan = await planWaveLanding(capture, capture.baseCommit, sourceDir);

    assert.equal(plan.paths.length, 0);
    assert.equal(plan.conflicts.length, 0);
    assert.equal(plan.changedPaths.length, 0);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: delete path with local drift is a conflict ─────────────────────────

test("wave-landing — delete path with local drift is a conflict", async () => {
  const artifactDir = await mkTmp("pi-wl-del-drift-");
  try {
    const sourceDir = await mkTmp("pi-wl-del-drift-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "to-delete.txt"), "will be deleted\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "del-drift-wave",
      artifactDir,
    });

    // Create a worker that deletes the file.
    const worker = await createWorkerWorktree(capture, "task-del");
    await rm(join(worker.worktreeRoot, "to-delete.txt"));
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-del", "Delete");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-del" });

    const result = await integrateWave(capture, [
      { taskId: "task-del", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    // Locally modify the file on source (drift from base).
    await writeFile(join(sourceDir, "to-delete.txt"), "locally modified\n", "utf8");

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // to-delete.txt: present in base, absent in result, source differs from base → conflict.
    const path = plan.paths[0] as LandingPath;
    assert.equal(path.action, "conflict");
    assert.ok(path.conflictReason?.includes("locally modified"));

    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].path, "to-delete.txt");
    assert.equal(plan.changedPaths.length, 0, "conflict should not be in changedPaths");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: literal filenames with glob metacharacters ─────────────────────────

test("wave-landing — literal filenames with glob metacharacters handled correctly", async () => {
  const artifactDir = await mkTmp("pi-wl-glob-");
  try {
    const sourceDir = await mkTmp("pi-wl-glob-src-");
    await git(["init", "--quiet"], sourceDir);
    // Create a file with glob metacharacters in the name.
    await writeFile(join(sourceDir, "test[1].txt"), "glob content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "glob-wave",
      artifactDir,
    });

    // Create a worker that modifies the file.
    const worker = await createWorkerWorktree(capture, "task-glob");
    await writeFile(join(worker.worktreeRoot, "test[1].txt"), "modified glob\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-glob", "Modify glob");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-glob" });

    const result = await integrateWave(capture, [
      { taskId: "task-glob", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // test[1].txt should be found and classified as apply.
    assert.equal(plan.paths.length, 1);
    assert.equal(plan.paths[0].path, "test[1].txt");
    assert.equal(plan.paths[0].action, "apply");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: symlinked ancestor directory is rejected ───────────────────────────

test("wave-landing — symlinked ancestor directory causes conflict", async () => {
  const artifactDir = await mkTmp("pi-wl-sym-anc-");
  try {
    const sourceDir = await mkTmp("pi-wl-sym-anc-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "real.txt"), "real content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "sym-anc-wave",
      artifactDir,
    });

    // Create a worker that adds a file under a new directory.
    const worker = await createWorkerWorktree(capture, "task-sym");
    await mkdir(join(worker.worktreeRoot, "subdir"), { recursive: true });
    await writeFile(join(worker.worktreeRoot, "subdir", "inner.txt"), "inner\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-sym", "Add nested");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-sym" });

    const result = await integrateWave(capture, [
      { taskId: "task-sym", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    // Create a symlinked ancestor on source.
    await mkdir(join(sourceDir, "realdir"), { recursive: true });
    await writeFile(join(sourceDir, "realdir", "inner.txt"), "inner\n", "utf8");
    await symlink("realdir", join(sourceDir, "subdir"));

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // subdir/inner.txt should be a conflict due to symlinked ancestor.
    const path = plan.paths.find((p) => p.path === "subdir/inner.txt")!;
    assert.equal(path.action, "conflict");
    assert.ok(path.conflictReason?.includes("symbolic link"));
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: directory replacement is rejected ──────────────────────────────────

test("wave-landing — directory where file expected causes conflict", async () => {
  const artifactDir = await mkTmp("pi-wl-dir-replace-");
  try {
    const sourceDir = await mkTmp("pi-wl-dir-replace-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file.txt"), "file content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "dir-replace-wave",
      artifactDir,
    });

    // Create a worker that modifies the file.
    const worker = await createWorkerWorktree(capture, "task-dir");
    await writeFile(join(worker.worktreeRoot, "file.txt"), "modified\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-dir", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-dir" });

    const result = await integrateWave(capture, [
      { taskId: "task-dir", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    // Replace the file with a directory on source.
    await rm(join(sourceDir, "file.txt"));
    await mkdir(join(sourceDir, "file.txt"), { recursive: true });

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // file.txt should be a conflict (directory where file expected).
    const path = plan.paths[0] as LandingPath;
    assert.equal(path.action, "conflict");
    assert.ok(path.conflictReason?.includes("directory"));
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: repeated ancestor segment names with symlinked inner ancestor ──────

test("wave-landing — repeated ancestor segment names with symlinked inner ancestor", async () => {
  const artifactDir = await mkTmp("pi-wl-repeated-anc-");
  try {
    const sourceDir = await mkTmp("pi-wl-repeated-anc-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "readme\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "repeated-anc-wave",
      artifactDir,
    });

    // Create a worker that adds a file under sub/sub/.
    const worker = await createWorkerWorktree(capture, "task-rep");
    await mkdir(join(worker.worktreeRoot, "sub", "sub"), { recursive: true });
    await writeFile(join(worker.worktreeRoot, "sub", "sub", "new.txt"), "new\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-rep", "Add nested");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-rep" });

    const result = await integrateWave(capture, [
      { taskId: "task-rep", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    // Create sub/ as a real directory, but sub/sub/ as a symlink to outside sourceRoot.
    const outsideDir = await mkTmp("pi-wl-outside-");
    await mkdir(join(sourceDir, "sub"), { recursive: true });
    await symlink(outsideDir, join(sourceDir, "sub", "sub"));

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // sub/sub/new.txt should be a conflict due to symlinked inner ancestor.
    const path = plan.paths.find((p) => p.path === "sub/sub/new.txt")!;
    assert.equal(path.action, "conflict");
    assert.ok(path.conflictReason?.includes("symbolic link"));

    await rm(outsideDir, { recursive: true, force: true });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: external symlink file compared by raw target ───────────────────────

test("wave-landing — external symlink file compared by raw target, not resolved path", async () => {
  const artifactDir = await mkTmp("pi-wl-ext-sym-");
  try {
    const sourceDir = await mkTmp("pi-wl-ext-sym-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "readme\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "ext-sym-wave",
      artifactDir,
    });

    // Create a worker that adds a symlink pointing to a relative target.
    const worker = await createWorkerWorktree(capture, "task-sym");
    await symlink("readme.md", join(worker.worktreeRoot, "link.md"));
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-sym", "Add symlink");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-sym" });

    const result = await integrateWave(capture, [
      { taskId: "task-sym", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    // Pre-apply the exact same symlink on source.
    await symlink("readme.md", join(sourceDir, "link.md"));

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // link.md should be already_applied (source matches result by raw target).
    const path = plan.paths[0] as LandingPath;
    assert.equal(path.action, "already_applied");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: filename with double dots is allowed ───────────────────────────────

test("wave-landing — filename with double dots (file..txt) is allowed", async () => {
  const artifactDir = await mkTmp("pi-wl-dots-");
  try {
    const sourceDir = await mkTmp("pi-wl-dots-src-");
    await git(["init", "--quiet"], sourceDir);
    // Create a file with double dots in the name.
    await writeFile(join(sourceDir, "file..txt"), "double dots\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "dots-wave",
      artifactDir,
    });

    // Create a worker that modifies the file.
    const worker = await createWorkerWorktree(capture, "task-dots");
    await writeFile(join(worker.worktreeRoot, "file..txt"), "modified double dots\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-dots", "Modify dots");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-dots" });

    const result = await integrateWave(capture, [
      { taskId: "task-dots", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // file..txt should be found and classified as apply.
    assert.equal(plan.paths.length, 1);
    assert.equal(plan.paths[0].path, "file..txt");
    assert.equal(plan.paths[0].action, "apply");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: filename with leading dash ─────────────────────────────────────────

test("wave-landing — filename with leading dash is handled correctly", async () => {
  const artifactDir = await mkTmp("pi-wl-dash-");
  try {
    const sourceDir = await mkTmp("pi-wl-dash-src-");
    await git(["init", "--quiet"], sourceDir);
    // Create a file with a leading dash in the name.
    await writeFile(join(sourceDir, "-dash.txt"), "dash content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "dash-wave",
      artifactDir,
    });

    // Create a worker that modifies the file.
    const worker = await createWorkerWorktree(capture, "task-dash");
    await writeFile(join(worker.worktreeRoot, "-dash.txt"), "modified dash\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-dash", "Modify dash");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-dash" });

    const result = await integrateWave(capture, [
      { taskId: "task-dash", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // -dash.txt should be found and classified as apply.
    assert.equal(plan.paths.length, 1);
    assert.equal(plan.paths[0].path, "-dash.txt");
    assert.equal(plan.paths[0].action, "apply");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: filename with tab character ────────────────────────────────────────

test("wave-landing — filename with tab character is handled correctly", async () => {
  const artifactDir = await mkTmp("pi-wl-tab-");
  try {
    const sourceDir = await mkTmp("pi-wl-tab-src-");
    await git(["init", "--quiet"], sourceDir);
    // Create a file with a tab in the name.
    const tabFileName = "file\twith\ttabs.txt";
    await writeFile(join(sourceDir, tabFileName), "tab content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "tab-wave",
      artifactDir,
    });

    // Create a worker that modifies the file.
    const worker = await createWorkerWorktree(capture, "task-tab");
    await writeFile(join(worker.worktreeRoot, tabFileName), "modified tab\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-tab", "Modify tab");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-tab" });

    const result = await integrateWave(capture, [
      { taskId: "task-tab", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // file\twith\ttabs.txt should be found and classified as apply.
    assert.equal(plan.paths.length, 1);
    assert.equal(plan.paths[0].path, tabFileName);
    assert.equal(plan.paths[0].action, "apply");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: filename with newline character ────────────────────────────────────

test("wave-landing — filename with newline character is handled correctly", async () => {
  const artifactDir = await mkTmp("pi-wl-newline-");
  try {
    const sourceDir = await mkTmp("pi-wl-newline-src-");
    await git(["init", "--quiet"], sourceDir);
    // Create a file with a newline in the name.
    const newlineFileName = "file\nwith\nnewlines.txt";
    await writeFile(join(sourceDir, newlineFileName), "newline content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "newline-wave",
      artifactDir,
    });

    // Create a worker that modifies the file.
    const worker = await createWorkerWorktree(capture, "task-newline");
    await writeFile(join(worker.worktreeRoot, newlineFileName), "modified newline\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-newline", "Modify newline");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-newline" });

    const result = await integrateWave(capture, [
      { taskId: "task-newline", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // file\nwith\nnewlines.txt should be found and classified as apply.
    assert.equal(plan.paths.length, 1);
    assert.equal(plan.paths[0].path, newlineFileName);
    assert.equal(plan.paths[0].action, "apply");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: wrong source root is rejected ──────────────────────────────────────

test("wave-landing — wrong source root is rejected", async () => {
  const artifactDir = await mkTmp("pi-wl-wrong-root-");
  try {
    const sourceDir = await mkTmp("pi-wl-wrong-root-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "wrong-root-wave",
      artifactDir,
    });

    // Create a different directory to use as wrong source root.
    const wrongDir = await mkTmp("pi-wl-wrong-dir-");
    await git(["init", "--quiet"], wrongDir);
    await writeFile(join(wrongDir, "readme.md"), "# hello\n", "utf8");
    await git(["add", "."], wrongDir);
    await git(["commit", "--quiet", "-m", "init"], wrongDir);

    // Integrate with empty selection (no changes).
    const result = await integrateWave(capture, []);
    assert.equal(result.status, "no_changes");

    // Try to plan with the wrong source root.
    await assert.rejects(
      planWaveLanding(capture, capture.baseCommit, wrongDir),
      /Source root identity mismatch/,
    );

    await rm(wrongDir, { recursive: true, force: true });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: plan includes sourceRoot and baseCommit ────────────────────────────

test("wave-landing — plan includes sourceRoot and baseCommit", async () => {
  const artifactDir = await mkTmp("pi-wl-plan-fields-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Plan should include sourceRoot and baseCommit.
    assert.equal(plan.sourceRoot, sourceDir);
    assert.equal(plan.baseCommit, capture.baseCommit);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: symlink alias to different root is rejected ────────────────────────

test("wave-landing — symlink alias to different root is rejected", async () => {
  const artifactDir = await mkTmp("pi-wl-sym-alias-");
  try {
    // Create the actual source directory.
    const actualSourceDir = await mkTmp("pi-wl-sym-alias-actual-");
    await git(["init", "--quiet"], actualSourceDir);
    await writeFile(join(actualSourceDir, "readme.md"), "# hello\n", "utf8");
    await git(["add", "."], actualSourceDir);
    await git(["commit", "--quiet", "-m", "init"], actualSourceDir);

    // Create a symlink that points to the actual source.
    const symlinkDir = await mkTmp("pi-wl-sym-link-");
    const symlinkPath = join(symlinkDir, "alias");
    await symlink(actualSourceDir, symlinkPath);

    // Capture through the symlink — the capture root will resolve to the real path.
    const capture = await captureWaveBase({
      cwd: symlinkPath,
      maxSnapshotBytes: 1_000_000,
      waveId: "sym-alias-wave",
      artifactDir,
    });

    // Integrate with empty selection (no changes).
    const result = await integrateWave(capture, []);
    assert.equal(result.status, "no_changes");

    // Create a completely different directory.
    const differentDir = await mkTmp("pi-wl-different-");
    await git(["init", "--quiet"], differentDir);
    await writeFile(join(differentDir, "readme.md"), "# hello\n", "utf8");
    await git(["add", "."], differentDir);
    await git(["commit", "--quiet", "-m", "init"], differentDir);

    // Try to plan with a different source root — should be rejected.
    await assert.rejects(
      planWaveLanding(capture, capture.baseCommit, differentDir),
      /Source root identity mismatch/,
    );

    await rm(differentDir, { recursive: true, force: true });
    await rm(symlinkDir, { recursive: true, force: true });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: validatePathSafe rejects traversal but allows double-dot names ─────

test("wave-landing — validatePathSafe rejects traversal but allows double-dot names", () => {
  // Traversal paths should be rejected.
  assert.throws(() => validatePathSafe("a/../b"), /path traversal/);
  assert.throws(() => validatePathSafe(".."), /path traversal/);
  assert.throws(() => validatePathSafe("foo/../../bar"), /path traversal/);

  // Harmless double-dot names should be allowed.
  assert.doesNotThrow(() => validatePathSafe("file..txt"));
  assert.doesNotThrow(() => validatePathSafe("a/..b/c"));
  assert.doesNotThrow(() => validatePathSafe("..hidden"));
  assert.doesNotThrow(() => validatePathSafe("file...txt"));

  // Absolute paths should be rejected.
  assert.throws(() => validatePathSafe("/etc/passwd"), /absolute/);

  // NUL bytes should be rejected.
  assert.throws(() => validatePathSafe("file\0.txt"), /NUL/);
});

// ── Execution tests ──────────────────────────────────────────────────────────

import * as waveLanding from "../src/execution/wave-landing";

// ── Test: successful mixed landing (add + modify + delete) ───────────────────

test("wave-landing execute — successful mixed landing", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-mixed-");
  try {
    const sourceDir = await mkTmp("pi-wl-exec-mixed-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "keep.txt"), "keep\n", "utf8");
    await writeFile(join(sourceDir, "to-delete.txt"), "delete me\n", "utf8");
    await writeFile(join(sourceDir, "to-modify.txt"), "original\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "exec-mixed-wave",
      artifactDir,
    });

    // Worker 1: add new file.
    const worker1 = await createWorkerWorktree(capture, "task-add");
    await writeFile(join(worker1.worktreeRoot, "new.txt"), "new content\n", "utf8");
    const candidate1 = await normalizeCandidate(capture, worker1.worktreeRoot, "task-add", "Add");
    await pinCommit(capture, candidate1.commitSha, { type: "worker", taskId: "task-add" });

    // Worker 2: delete and modify.
    const worker2 = await createWorkerWorktree(capture, "task-mod");
    await rm(join(worker2.worktreeRoot, "to-delete.txt"));
    await writeFile(join(worker2.worktreeRoot, "to-modify.txt"), "modified\n", "utf8");
    const candidate2 = await normalizeCandidate(capture, worker2.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate2.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-add", commitSha: candidate1.commitSha },
      { taskId: "task-mod", commitSha: candidate2.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);
    const execResult = await waveLanding.executeWaveLanding(plan, capture);

    assert.equal(execResult.status, "landed");
    assert.ok(execResult.appliedPaths.includes("new.txt"));
    assert.ok(execResult.appliedPaths.includes("to-delete.txt"));
    assert.ok(execResult.appliedPaths.includes("to-modify.txt"));

    // Verify filesystem state.
    const newContent = await readFile(join(sourceDir, "new.txt"), "utf8");
    assert.equal(newContent, "new content\n");

    const modContent = await readFile(join(sourceDir, "to-modify.txt"), "utf8");
    assert.equal(modContent, "modified\n");

    // to-delete.txt should be gone.
    await assert.rejects(
      readFile(join(sourceDir, "to-delete.txt"), "utf8"),
      { code: "ENOENT" },
    );

    // Verify changes are uncommitted.
    const status = await git(["status", "--porcelain"], sourceDir);
    assert.ok(status.length > 0, "should have uncommitted changes");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: already-applied no-op ──────────────────────────────────────────────

test("wave-landing execute — already-applied no-op", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-noop-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    // Pre-apply the change.
    await writeFile(join(sourceDir, "file-0.txt"), "content-0\n", "utf8");

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);
    assert.equal(plan.paths[0].action, "already_applied");

    const execResult = await waveLanding.executeWaveLanding(plan, capture);
    assert.equal(execResult.status, "landed");
    assert.equal(execResult.appliedPaths.length, 0);
    assert.ok(execResult.alreadyAppliedPaths.includes("file-0.txt"));
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: mode fidelity (executable bit) ─────────────────────────────────────

test("wave-landing execute — mode fidelity (executable bit)", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-mode-");
  try {
    const sourceDir = await mkTmp("pi-wl-exec-mode-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "script.sh"), "#!/bin/sh\necho hi\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "exec-mode-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mode");
    await chmod(join(worker.worktreeRoot, "script.sh"), 0o755);
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mode", "Make executable");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mode" });

    const result = await integrateWave(capture, [
      { taskId: "task-mode", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);
    const execResult = await waveLanding.executeWaveLanding(plan, capture);

    assert.equal(execResult.status, "landed");

    // Verify executable bit.
    const stat = await import("node:fs/promises").then(m => m.stat(join(sourceDir, "script.sh")));
    assert.ok((stat.mode & 0o111) !== 0, "script.sh should be executable");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: symlink fidelity ───────────────────────────────────────────────────

test("wave-landing execute — symlink fidelity", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-symlink-");
  try {
    const sourceDir = await mkTmp("pi-wl-exec-symlink-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "target.txt"), "target content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "exec-symlink-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-sym");
    await symlink("target.txt", join(worker.worktreeRoot, "link.txt"));
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-sym", "Add symlink");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-sym" });

    const result = await integrateWave(capture, [
      { taskId: "task-sym", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);
    const execResult = await waveLanding.executeWaveLanding(plan, capture);

    assert.equal(execResult.status, "landed");

    // Verify symlink.
    const linkStat = await import("node:fs/promises").then(m => m.lstat(join(sourceDir, "link.txt")));
    assert.ok(linkStat.isSymbolicLink(), "link.txt should be a symlink");
    const linkTarget = await import("node:fs/promises").then(m => m.readlink(join(sourceDir, "link.txt")));
    assert.equal(linkTarget, "target.txt");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: binary fidelity ────────────────────────────────────────────────────

test("wave-landing execute — binary fidelity", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-binary-");
  try {
    const sourceDir = await mkTmp("pi-wl-exec-binary-src-");
    await git(["init", "--quiet"], sourceDir);
    const originalData = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
    await writeFile(join(sourceDir, "data.bin"), originalData);
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "exec-binary-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-bin");
    const newData = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0x00]);
    await writeFile(join(worker.worktreeRoot, "data.bin"), newData);
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-bin", "Modify binary");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-bin" });

    const result = await integrateWave(capture, [
      { taskId: "task-bin", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);
    const execResult = await waveLanding.executeWaveLanding(plan, capture);

    assert.equal(execResult.status, "landed");

    // Verify binary content.
    const fileData = await readFile(join(sourceDir, "data.bin"));
    assert.ok(fileData.equals(newData), "binary content should match exactly");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: index/HEAD preservation ────────────────────────────────────────────

test("wave-landing execute — index and HEAD preserved", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-head-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    const originalHead = await git(["rev-parse", "HEAD"], sourceDir);
    const originalStatus = await git(["status", "--porcelain"], sourceDir);

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);
    await waveLanding.executeWaveLanding(plan, capture);

    const afterHead = await git(["rev-parse", "HEAD"], sourceDir);
    const afterStatus = await git(["status", "--porcelain"], sourceDir);

    assert.equal(afterHead, originalHead, "HEAD should be unchanged");
    // Status should now show uncommitted changes (the landed file).
    assert.notEqual(afterStatus, originalStatus, "status should show uncommitted changes");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: path drift between plan and execution ──────────────────────────────

test("wave-landing execute — path drift causes conflict", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-drift-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);
    assert.equal(plan.paths[0].action, "apply");

    // Modify the source filesystem between plan and execute.
    await writeFile(join(sourceDir, "file-0.txt"), "different content\n", "utf8");

    const execResult = await waveLanding.executeWaveLanding(plan, capture);
    assert.equal(execResult.status, "conflicted");
    assert.ok(execResult.conflicts.length > 0);

    // Source should be unchanged (no mutation performed).
    const content = await readFile(join(sourceDir, "file-0.txt"), "utf8");
    assert.equal(content, "different content\n");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: injected failure after multiple replacements (all-or-nothing rollback) ──

test("wave-landing execute — injected failure causes full rollback", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-rollback-");
  try {
    const sourceDir = await mkTmp("pi-wl-exec-rollback-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file-a.txt"), "a\n", "utf8");
    await writeFile(join(sourceDir, "file-b.txt"), "b\n", "utf8");
    await writeFile(join(sourceDir, "file-c.txt"), "c\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "exec-rollback-wave",
      artifactDir,
    });

    // Worker modifies all three files.
    const worker = await createWorkerWorktree(capture, "task-all");
    await writeFile(join(worker.worktreeRoot, "file-a.txt"), "A\n", "utf8");
    await writeFile(join(worker.worktreeRoot, "file-b.txt"), "B\n", "utf8");
    await writeFile(join(worker.worktreeRoot, "file-c.txt"), "C\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-all", "Modify all");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-all" });

    const result = await integrateWave(capture, [
      { taskId: "task-all", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    const execResult = await waveLanding.executeWaveLanding(plan, capture, undefined, { failAfterNPaths: 1 });
    assert.equal(execResult.status, "rolled_back");
    assert.ok(execResult.appliedPaths.length >= 1, "should have applied at least 1 path before failure");

    // Verify all files are restored to original state.
    const aContent = await readFile(join(sourceDir, "file-a.txt"), "utf8");
    const bContent = await readFile(join(sourceDir, "file-b.txt"), "utf8");
    const cContent = await readFile(join(sourceDir, "file-c.txt"), "utf8");
    assert.equal(aContent, "a\n", "file-a.txt should be restored");
    assert.equal(bContent, "b\n", "file-b.txt should be restored");
    assert.equal(cContent, "c\n", "file-c.txt should be restored");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: mid-mutation failure (after backup rename) proves all-or-nothing ──

test("wave-landing execute — mid-mutation failure after backup rename causes full rollback", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-midmut-rollback-");
  try {
    const sourceDir = await mkTmp("pi-wl-exec-midmut-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file-x.txt"), "x\n", "utf8");
    await writeFile(join(sourceDir, "file-y.txt"), "y\n", "utf8");
    await writeFile(join(sourceDir, "file-z.txt"), "z\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "exec-midmut-wave",
      artifactDir,
    });

    // Worker modifies all three files.
    const worker = await createWorkerWorktree(capture, "task-all");
    await writeFile(join(worker.worktreeRoot, "file-x.txt"), "X\n", "utf8");
    await writeFile(join(worker.worktreeRoot, "file-y.txt"), "Y\n", "utf8");
    await writeFile(join(worker.worktreeRoot, "file-z.txt"), "Z\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-all", "Modify all");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-all" });

    const result = await integrateWave(capture, [
      { taskId: "task-all", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Inject failure after backup rename of the second path (file-y.txt).
    // This tests the mid-mutation rollback gap: backup is done but temp rename hasn't happened.
    const execResult = await waveLanding.executeWaveLanding(plan, capture, undefined, { failAfterBackupOf: "file-y.txt" });
    assert.equal(execResult.status, "rolled_back");

    // Verify ALL files are restored to original state, including file-x.txt
    // which had its backup rename succeed before the failure.
    const xContent = await readFile(join(sourceDir, "file-x.txt"), "utf8");
    const yContent = await readFile(join(sourceDir, "file-y.txt"), "utf8");
    const zContent = await readFile(join(sourceDir, "file-z.txt"), "utf8");
    assert.equal(xContent, "x\n", "file-x.txt should be restored despite backup rename succeeding");
    assert.equal(yContent, "y\n", "file-y.txt should be restored despite backup rename succeeding");
    assert.equal(zContent, "z\n", "file-z.txt should be unchanged");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: recovery manifest contents and state ───────────────────────────────

test("wave-landing execute — recovery manifest contents and state", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-manifest-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);
    const execResult = await waveLanding.executeWaveLanding(plan, capture);

    assert.equal(execResult.status, "landed");
    assert.ok(execResult.manifestPath.length > 0);

    // Read and verify manifest.
    const manifestContent = await readFile(execResult.manifestPath, "utf8");
    const manifest = JSON.parse(manifestContent);

    assert.equal(manifest.version, 1);
    assert.ok(manifest.timestamp);
    assert.equal(manifest.sourceRoot, sourceDir);
    assert.equal(manifest.baseCommit, capture.baseCommit);
    assert.equal(manifest.integratedCommit, integration.finalCommitSha);
    assert.equal(manifest.state, "completed");
    assert.ok(manifest.paths.length > 0);

    // Verify path entries.
    const pathEntry = manifest.paths[0];
    assert.equal(pathEntry.path, "file-0.txt");
    assert.ok(pathEntry.destination);
    assert.ok(pathEntry.blobId);
    assert.equal(pathEntry.mode, "100644");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: parent directory creation and rollback ─────────────────────────────

test("wave-landing execute — parent directory creation and rollback", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-dir-");
  try {
    const sourceDir = await mkTmp("pi-wl-exec-dir-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "readme\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "exec-dir-wave",
      artifactDir,
    });

    // Worker adds a file in a new subdirectory.
    const worker = await createWorkerWorktree(capture, "task-dir");
    await mkdir(join(worker.worktreeRoot, "newdir", "subdir"), { recursive: true });
    await writeFile(join(worker.worktreeRoot, "newdir", "subdir", "deep.txt"), "deep\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-dir", "Add nested");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-dir" });

    const result = await integrateWave(capture, [
      { taskId: "task-dir", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);
    const execResult = await waveLanding.executeWaveLanding(plan, capture);

    assert.equal(execResult.status, "landed");

    // Verify the file exists.
    const content = await readFile(join(sourceDir, "newdir", "subdir", "deep.txt"), "utf8");
    assert.equal(content, "deep\n");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: no use of git apply/patch ──────────────────────────────────────────

test("wave-landing execute — no git apply or patch used", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-nopatch-");
  try {
    const { sourceDir, capture, integration } = await setupLanding(artifactDir, 1);

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);
    await waveLanding.executeWaveLanding(plan, capture);

    // Verify the file was landed without git apply.
    // The source repo should have the file as an untracked/unstaged change.
    const status = await git(["status", "--porcelain"], sourceDir);
    assert.ok(status.includes("file-0.txt"), "file-0.txt should appear in git status");

    // Verify the index was not modified (file is untracked, not staged).
    const indexFiles = await git(["ls-files"], sourceDir);
    assert.ok(!indexFiles.includes("file-0.txt"), "file-0.txt should not be in the index");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: concurrent destination modification before rollback triggers recovery_required ──

test("wave-landing execute — concurrent destination modification triggers recovery_required", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-concurrent-");
  try {
    const sourceDir = await mkTmp("pi-wl-exec-concurrent-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file-a.txt"), "a\n", "utf8");
    await writeFile(join(sourceDir, "file-b.txt"), "b\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "concurrent-wave",
      artifactDir,
    });

    // Worker modifies both files.
    const worker = await createWorkerWorktree(capture, "task-all");
    await writeFile(join(worker.worktreeRoot, "file-a.txt"), "A\n", "utf8");
    await writeFile(join(worker.worktreeRoot, "file-b.txt"), "B\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-all", "Modify all");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-all" });

    const result = await integrateWave(capture, [
      { taskId: "task-all", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // After the first path is applied, simulate a concurrent modification of the destination.
    // This should cause the rollback to detect the concurrent modification and return recovery_required.
    const execResult = await waveLanding.executeWaveLanding(plan, capture, undefined, {
      afterApplyPath: async (_relPath: string, destPath: string) => {
        await writeFile(destPath, "concurrent modification\n", "utf8");
      },
      failAfterNPaths: 1,
    });

      // Should get recovery_required, not rolled_back.
      assert.equal(execResult.status, "recovery_required");

      // Diagnostics should contain information about the failure.
      assert.ok(execResult.diagnostics.failedAtPath !== null || execResult.diagnostics.appliedPaths.length > 0);
      assert.ok(execResult.diagnostics.rollbackError.includes("Concurrent modification"));
      assert.ok(execResult.diagnostics.manifestPath.length > 0);

      // Verify the concurrent modification was preserved (not overwritten by rollback).
      const aContent = await readFile(join(sourceDir, "file-a.txt"), "utf8");
      assert.equal(aContent, "concurrent modification\n", "concurrent modification should be preserved");

      // Verify the backup of the original content still exists.
      const manifestContent = await readFile(execResult.diagnostics.manifestPath, "utf8");
      const manifest = JSON.parse(manifestContent);
      assert.equal(manifest.state, "recovery_required");

      // Find the backup path for file-a.txt — it must exist.
      const fileAEntry = manifest.paths.find((p: any) => p.path === "file-a.txt");
      assert.ok(fileAEntry, "manifest should have entry for file-a.txt");
      assert.ok(fileAEntry.backup, "manifest entry should have a backup path");
      const backupContent = await readFile(fileAEntry.backup, "utf8");
      assert.equal(backupContent, "a\n", "original backup should be preserved");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Security: source root identity binding (rename-and-symlink-retarget) ─────

test("wave-landing — rejects source root replaced by symlink via dev+ino check", async () => {
  const artifactDir = await mkTmp("pi-wl-identity-");
  try {
    const sourceDir = await mkTmp("pi-wl-identity-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
    await writeFile(join(sourceDir, "victim.txt"), "victim data\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-identity",
      artifactDir,
    });

    // Record the captured identity.
    const capturedIdentity = capture.sourceIdentity;
    assert.ok(capturedIdentity, "sourceIdentity should be captured");

    // Integrate with empty selection (no changes).
    const result = await integrateWave(capture, []);
    assert.equal(result.status, "no_changes");

    // Create a fake victim directory.
    const fakeDir = await mkTmp("pi-wl-identity-fake-");
    await git(["init", "--quiet"], fakeDir);
    await writeFile(join(fakeDir, "readme.md"), "# fake\n", "utf8");
    await git(["add", "."], fakeDir);
    await git(["commit", "--quiet", "-m", "fake init"], fakeDir);

    // Rename the real source directory and plant a symlink at the old path.
    const renamedSource = sourceDir + ".renamed";
    await fs.rename(sourceDir, renamedSource);
    await symlink(fakeDir, sourceDir);

    // Planning should reject because the dev+ino of the current sourceDir
    // (now a symlink to fakeDir) does not match the captured identity.
    await assert.rejects(
      planWaveLanding(capture, capture.baseCommit, sourceDir),
      /Source root identity mismatch/,
    );

    // Verify the victim file in the renamed source is untouched.
    const victimContent = await readFile(join(renamedSource, "victim.txt"), "utf8");
    assert.equal(victimContent, "victim data\n", "victim file must be untouched");

    // Restore the original source directory.
    await rm(sourceDir);
    await fs.rename(renamedSource, sourceDir);

    await rm(fakeDir, { recursive: true, force: true });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// Import fs for rename
import * as fs from "node:fs/promises";

// ── Test: late abort after final path application rolls back, never lands ────
// An abort signal fired after the last path is applied but before durable
// completion must cause a rollback (or recovery_required), never "landed".

test("wave-landing execute — late abort after final path application rolls back", async () => {
  const artifactDir = await mkTmp("pi-wl-exec-lateabort-");
  try {
    const sourceDir = await mkTmp("pi-wl-exec-lateabort-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file-a.txt"), "a\n", "utf8");
    await writeFile(join(sourceDir, "file-b.txt"), "b\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "lateabort-wave",
      artifactDir,
    });

    // Worker modifies both files.
    const worker = await createWorkerWorktree(capture, "task-all");
    await writeFile(join(worker.worktreeRoot, "file-a.txt"), "A\n", "utf8");
    await writeFile(join(worker.worktreeRoot, "file-b.txt"), "B\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-all", "Modify all");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-all" });

    const result = await integrateWave(capture, [
      { taskId: "task-all", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Use the afterApplyPath seam to abort after the last path is applied.
    const controller = new AbortController();
    let applyCount = 0;
    const totalApplyPaths = plan.paths.filter((p) => p.action === "apply").length;

    const execResult = await waveLanding.executeWaveLanding(plan, capture, controller.signal, {
      afterApplyPath: async () => {
        applyCount++;
        if (applyCount >= totalApplyPaths) controller.abort();
      },
    });

      // Must NOT be landed — should be rolled_back or recovery_required.
      assert.ok(
        execResult.status === "rolled_back" || execResult.status === "recovery_required",
        `Late abort must not land: got ${execResult.status}`,
      );

      // Verify files are restored to original state (rolled back).
      const aContent = await readFile(join(sourceDir, "file-a.txt"), "utf8");
      const bContent = await readFile(join(sourceDir, "file-b.txt"), "utf8");
      assert.equal(aContent, "a\n", "file-a.txt should be restored after late abort");
      assert.equal(bContent, "b\n", "file-b.txt should be restored after late abort");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
