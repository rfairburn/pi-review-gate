import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureWaveBase } from "../src/execution/wave-repository";
import {
  createWorkerWorktree,
  pinCommit,
} from "../src/execution/wave-worktrees";
import { normalizeCandidate } from "../src/execution/wave-commits";
import { integrateWave } from "../src/execution/wave-integration";
import {
  planWaveLanding,
  executeWaveLanding,
} from "../src/execution/wave-landing";
import { createWorkspaceSnapshot, compareSnapshots, type WorkspaceSnapshot } from "../src/capture";

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

async function mkTmp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

// ── Selective checkpoint tests ───────────────────────────────────────────────

/**
 * Build a selective checkpoint: start from the pre-wave parent baseline
 * and update only the paths that were successfully landed by the wave.
 * Ownership-safe: if parent already changed a path before the wave,
 * leave the baseline entry so parent review sees baseline→final.
 * This is the same logic as in tool.ts.
 */
function buildSelectiveCheckpoint(
  preWaveBaseline: WorkspaceSnapshot,
  preWaveSnapshot: WorkspaceSnapshot,
  afterSnapshot: WorkspaceSnapshot,
  wavePaths: string[],
  sourceRoot: string,
): { snapshot: WorkspaceSnapshot; parentOwnedOverlapPaths: string[] } {
  const waveAbsolutePaths = new Set<string>();
  for (const relPath of wavePaths) {
    const absPath = resolve(sourceRoot, relPath);
    waveAbsolutePaths.add(absPath);
  }

  const mergedFiles = new Map(preWaveBaseline.files);
  const parentOwnedOverlapPaths: string[] = [];

  for (const [key, afterFile] of afterSnapshot.files) {
    if (!waveAbsolutePaths.has(afterFile.absolutePath)) continue;

    const baselineFile = preWaveBaseline.files.get(key);
    const preWaveFile = preWaveSnapshot.files.get(key);
    const parentChanged = isParentOwnedChange(baselineFile, preWaveFile);

    if (parentChanged) {
      parentOwnedOverlapPaths.push(afterFile.relativePath);
    } else {
      mergedFiles.set(key, afterFile);
    }
  }

  for (const [key, baselineFile] of preWaveBaseline.files) {
    if (!waveAbsolutePaths.has(baselineFile.absolutePath)) continue;
    if (!afterSnapshot.files.has(key)) {
      const preWaveFile = preWaveSnapshot.files.get(key);
      const parentChanged = isParentOwnedChange(baselineFile, preWaveFile);
      if (parentChanged) {
        parentOwnedOverlapPaths.push(baselineFile.relativePath);
      } else {
        mergedFiles.delete(key);
      }
    }
  }

  return {
    snapshot: {
      cwd: preWaveBaseline.cwd,
      capturedAt: afterSnapshot.capturedAt,
      files: mergedFiles,
      omissions: afterSnapshot.omissions,
      omissionsTruncated: afterSnapshot.omissionsTruncated,
    },
    parentOwnedOverlapPaths,
  };
}

function isParentOwnedChange(
  baselineFile: unknown,
  preWaveFile: unknown,
): boolean {
  if (!baselineFile && !preWaveFile) return false;
  if (!baselineFile || !preWaveFile) return true;
  const bf = baselineFile as Record<string, unknown>;
  const pf = preWaveFile as Record<string, unknown>;
  return bf.content !== pf.content || bf.sha256 !== pf.sha256 || bf.isBinary !== pf.isBinary;
}

test("selective checkpoint: pre-wave parent edit remains visible while landed child paths are checkpointed", async () => {
  const dir = await mkTmp("pi-sc-src-");
  await git(["init", "--quiet"], dir);

  // Create initial files.
  await writeFile(join(dir, "parent-edited.txt"), "original parent content\n", "utf8");
  await writeFile(join(dir, "child-path.txt"), "original child content\n", "utf8");
  await writeFile(join(dir, "unrelated.txt"), "unrelated content\n", "utf8");
  await git(["add", "."], dir);
  await git(["commit", "--quiet", "-m", "init"], dir);

  // Take the pre-wave baseline snapshot.
  const preWaveBaseline = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  // Simulate a parent edit before the wave (e.g., parent modified parent-edited.txt).
  await writeFile(join(dir, "parent-edited.txt"), "parent edited content\n", "utf8");

  // Take the pre-wave snapshot (after parent edit, before wave).
  const preWaveSnapshot = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  // Simulate the wave landing: only child-path.txt is changed by the wave.
  await writeFile(join(dir, "child-path.txt"), "landed child content\n", "utf8");

  // Take the post-landing snapshot.
  const afterSnapshot = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  // Build selective checkpoint with only child-path.txt as landed.
  const result = buildSelectiveCheckpoint(preWaveBaseline, preWaveSnapshot, afterSnapshot, ["child-path.txt"], dir);
  const selectiveSnapshot = result.snapshot;

  // Compare pre-wave baseline with selective checkpoint.
  const changes = compareSnapshots(preWaveBaseline, selectiveSnapshot);

  // Only child-path.txt should be changed (landed by the wave).
  // parent-edited.txt should NOT be changed (pre-wave parent edit preserved).
  // unrelated.txt should NOT be changed.
  const changedPaths = changes.map((c) => c.path);
  assert.ok(changedPaths.includes("child-path.txt"), "child-path.txt should be checkpointed");
  assert.ok(!changedPaths.includes("parent-edited.txt"), "parent-edited.txt should NOT be checkpointed (pre-wave parent edit preserved)");
  assert.ok(!changedPaths.includes("unrelated.txt"), "unrelated.txt should NOT be checkpointed");
  assert.equal(changes.length, 1, "Only one file should be changed");

  // Verify the content of the checkpointed child path.
  const childChange = changes.find((c) => c.path === "child-path.txt");
  assert.equal(childChange?.status, "modified");
  assert.equal(childChange?.newContent, "landed child content\n");
});

test("selective checkpoint: handles additions correctly", async () => {
  const dir = await mkTmp("pi-sc-add-");
  await git(["init", "--quiet"], dir);

  await writeFile(join(dir, "existing.txt"), "existing content\n", "utf8");
  await git(["add", "."], dir);
  await git(["commit", "--quiet", "-m", "init"], dir);

  const preWaveBaseline = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  // No parent edits — preWaveSnapshot same as baseline.
  const preWaveSnapshot = preWaveBaseline;

  // Simulate wave landing: add a new file.
  await writeFile(join(dir, "new-file.txt"), "new file content\n", "utf8");

  const afterSnapshot = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  const result = buildSelectiveCheckpoint(preWaveBaseline, preWaveSnapshot, afterSnapshot, ["new-file.txt"], dir);
  const selectiveSnapshot = result.snapshot;

  const changes = compareSnapshots(preWaveBaseline, selectiveSnapshot);
  const changedPaths = changes.map((c) => c.path);
  assert.ok(changedPaths.includes("new-file.txt"), "new-file.txt should be checkpointed");
  assert.equal(changes[0]?.status, "added");
});

test("selective checkpoint: handles deletions correctly", async () => {
  const dir = await mkTmp("pi-sc-del-");
  await git(["init", "--quiet"], dir);

  await writeFile(join(dir, "to-delete.txt"), "will be deleted\n", "utf8");
  await writeFile(join(dir, "keep.txt"), "keep this\n", "utf8");
  await git(["add", "."], dir);
  await git(["commit", "--quiet", "-m", "init"], dir);

  const preWaveBaseline = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  // No parent edits — preWaveSnapshot same as baseline.
  const preWaveSnapshot = preWaveBaseline;

  // Simulate wave landing: delete a file.
  await rm(join(dir, "to-delete.txt"));

  const afterSnapshot = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  const result = buildSelectiveCheckpoint(preWaveBaseline, preWaveSnapshot, afterSnapshot, ["to-delete.txt"], dir);
  const selectiveSnapshot = result.snapshot;

  const changes = compareSnapshots(preWaveBaseline, selectiveSnapshot);
  const changedPaths = changes.map((c) => c.path);
  assert.ok(changedPaths.includes("to-delete.txt"), "to-delete.txt should be checkpointed as deleted");
  assert.equal(changes[0]?.status, "deleted");
});

test("selective checkpoint: no change when no paths landed", async () => {
  const dir = await mkTmp("pi-sc-noc-");
  await git(["init", "--quiet"], dir);

  await writeFile(join(dir, "file.txt"), "content\n", "utf8");
  await git(["add", "."], dir);
  await git(["commit", "--quiet", "-m", "init"], dir);

  const preWaveBaseline = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  // No changes made.
  const afterSnapshot = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  const result = buildSelectiveCheckpoint(preWaveBaseline, preWaveBaseline, afterSnapshot, [], dir);
  const selectiveSnapshot = result.snapshot;

  const changes = compareSnapshots(preWaveBaseline, selectiveSnapshot);
  assert.equal(changes.length, 0, "No changes when no paths landed");
});

// ── Ownership-safe overlap checkpoint test ───────────────────────────────────

test("selective checkpoint: overlapping pre-wave parent edit + worker edit retains baseline entry and reports overlap", async () => {
  const dir = await mkTmp("pi-sc-overlap-");
  await git(["init", "--quiet"], dir);

  // Create initial files.
  await writeFile(join(dir, "shared.txt"), "original shared\n", "utf8");
  await writeFile(join(dir, "worker-only.txt"), "original worker\n", "utf8");
  await git(["add", "."], dir);
  await git(["commit", "--quiet", "-m", "init"], dir);

  // Take the pre-wave baseline snapshot.
  const preWaveBaseline = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  // Simulate a parent edit before the wave on shared.txt.
  await writeFile(join(dir, "shared.txt"), "parent edited shared\n", "utf8");

  // Take the pre-wave snapshot (after parent edit, before wave).
  const preWaveSnapshot = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  // Simulate the wave landing: both shared.txt and worker-only.txt are changed.
  await writeFile(join(dir, "shared.txt"), "worker landed shared\n", "utf8");
  await writeFile(join(dir, "worker-only.txt"), "worker landed only\n", "utf8");

  // Take the post-landing snapshot.
  const afterSnapshot = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  // Build selective checkpoint with both paths as landed.
  const result = buildSelectiveCheckpoint(preWaveBaseline, preWaveSnapshot, afterSnapshot, ["shared.txt", "worker-only.txt"], dir);
  const selectiveSnapshot = result.snapshot;

  // Compare pre-wave baseline with selective checkpoint.
  const changes = compareSnapshots(preWaveBaseline, selectiveSnapshot);
  const changedPaths = changes.map((c) => c.path);

  // worker-only.txt should be checkpointed (parent didn't touch it).
  assert.ok(changedPaths.includes("worker-only.txt"), "worker-only.txt should be checkpointed");

  // shared.txt should NOT be checkpointed (parent already changed it).
  // The baseline entry is retained so parent review sees baseline→final.
  assert.ok(!changedPaths.includes("shared.txt"), "shared.txt should NOT be checkpointed (parent-owned overlap)");

  // shared.txt should be reported as a parent-owned overlap path.
  assert.ok(result.parentOwnedOverlapPaths.includes("shared.txt"), "shared.txt should be in parentOwnedOverlapPaths");
  assert.equal(result.parentOwnedOverlapPaths.length, 1, "Only shared.txt should be an overlap");

  // Verify the checkpointed worker-only path.
  const workerChange = changes.find((c) => c.path === "worker-only.txt");
  assert.equal(workerChange?.status, "modified");
  assert.equal(workerChange?.newContent, "worker landed only\n");
});

test("selective checkpoint: already-applied overlap path follows same ownership rule", async () => {
  const dir = await mkTmp("pi-sc-already-applied-");
  await git(["init", "--quiet"], dir);

  await writeFile(join(dir, "shared.txt"), "original\n", "utf8");
  await git(["add", "."], dir);
  await git(["commit", "--quiet", "-m", "init"], dir);

  const preWaveBaseline = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  // Parent edits shared.txt before the wave.
  await writeFile(join(dir, "shared.txt"), "parent edited\n", "utf8");

  const preWaveSnapshot = await createWorkspaceSnapshot(dir, {
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
  });

  // Wave lands shared.txt (already applied — same content as parent edit).
  // In this case, the after snapshot matches the pre-wave snapshot.
  const afterSnapshot = preWaveSnapshot;

  // Build selective checkpoint with shared.txt as already-applied.
  const result = buildSelectiveCheckpoint(preWaveBaseline, preWaveSnapshot, afterSnapshot, ["shared.txt"], dir);

  // shared.txt should be reported as a parent-owned overlap path.
  assert.ok(result.parentOwnedOverlapPaths.includes("shared.txt"), "shared.txt should be in parentOwnedOverlapPaths");

  // The checkpoint should retain the baseline entry (not the after snapshot).
  const changes = compareSnapshots(preWaveBaseline, result.snapshot);
  assert.ok(!changes.find((c) => c.path === "shared.txt"), "shared.txt should NOT be checkpointed (parent-owned overlap)");
});

// ── Integration error distinct from conflict ─────────────────────────────────

test("integrateWave throws on infrastructure error, not conflict", async () => {
  const artifactDir = await mkTmp("pi-ie-art-");
  const sourceDir = await mkTmp("pi-ie-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  const capture = await captureWaveBase({
    cwd: sourceDir,
    maxSnapshotBytes: 1_000_000,
    waveId: "ie-test",
    artifactDir,
  });

  try {
    // Try to integrate with a non-existent commit SHA — should throw.
    await assert.rejects(
      async () => integrateWave(capture, [
        { taskId: "task-0", commitSha: "0000000000000000000000000000000000000000" },
      ]),
      /Worker commit.*is not pinned/,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── Conflict result retains provenance ───────────────────────────────────────

test("conflict result retains successfullyIntegrated mappings and worktree", async () => {
  const artifactDir = await mkTmp("pi-cp-art-");
  const sourceDir = await mkTmp("pi-cp-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  const capture = await captureWaveBase({
    cwd: sourceDir,
    maxSnapshotBytes: 1_000_000,
    waveId: "cp-test",
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

// ── AbortSignal in executeWaveLanding ────────────────────────────────────────

test("executeWaveLanding respects abort signal before source mutation", async () => {
  const artifactDir = await mkTmp("pi-ab-art-");
  const sourceDir = await mkTmp("pi-ab-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);

  const capture = await captureWaveBase({
    cwd: sourceDir,
    maxSnapshotBytes: 1_000_000,
    waveId: "ab-test",
    artifactDir,
  });

  try {
    // Create a worker with changes.
    const worker = await createWorkerWorktree(capture, "task-0");
    await writeFile(join(worker.worktreeRoot, "new-file.txt"), "new content\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-0", "Task 0");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-0" });

    // Integrate.
    const integrationResult = await integrateWave(capture, [
      { taskId: "task-0", commitSha: candidate.commitSha },
    ]);
    assert.equal(integrationResult.status, "integrated");

    // Plan landing.
    const plan = await planWaveLanding(capture, integrationResult.finalCommitSha, capture.discovery.captureRoot);
    assert.equal(plan.conflicts.length, 0);

    // Abort before landing.
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      executeWaveLanding(plan, capture, controller.signal),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );

    assert.equal(await readFile(join(sourceDir, "readme.md"), "utf8"), "# hello\n");
    await assert.rejects(readFile(join(sourceDir, "new-file.txt")), { code: "ENOENT" });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});
