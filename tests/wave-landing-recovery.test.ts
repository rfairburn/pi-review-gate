import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile, stat as fsStat } from "node:fs/promises";
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
  planWaveLanding,
  recoverLandingManifest,
  createTestSignedManifest,
  type RecoveryManifest,
  type RecoveryPathEntry,
} from "../src/execution/wave-landing";

/** Generate the artifact key for a path (same as controller). */
function artifactKey(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

/** Build controller-generated temp/backup paths for a manifest entry. */
function buildArtifactPaths(destPath: string, relPath: string, txId: string) {
  const ak = artifactKey(relPath);
  const dir = destPath.substring(0, destPath.lastIndexOf("/"));
  return {
    temp: join(dir, `.pi-landing-tmp-${txId}-${ak}`),
    backup: `${destPath}.pi-backup-${txId}-${ak}`,
  };
}

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

// ── Test: simulated process death after destination→backup rename is recovered ──

test("wave-landing recovery — process death after backup rename recovers to exact original", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-backup-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-backup-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file-a.txt"), "original-a\n", "utf8");
    await writeFile(join(sourceDir, "file-b.txt"), "original-b\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-backup-wave",
      artifactDir,
    });

    // Worker modifies both files.
    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "file-a.txt"), "modified-a\n", "utf8");
    await writeFile(join(worker.worktreeRoot, "file-b.txt"), "modified-b\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Get real blob IDs from the plan.
    const planPaths = new Map(plan.paths.map((p) => [p.path, p]));
    const fileAEntry = planPaths.get("file-a.txt")!;
    const fileBEntry = planPaths.get("file-b.txt")!;

    // Simulate a crash after backup rename: manually create a manifest
    // with backup_created phase, move the original to backup, and remove the destination.
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-backup";
    const fileA = buildArtifactPaths(join(sourceDir, "file-a.txt"), "file-a.txt", txId);
    const fileB = buildArtifactPaths(join(sourceDir, "file-b.txt"), "file-b.txt", txId);

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [
        {
          path: "file-a.txt",
          destination: join(sourceDir, "file-a.txt"),
          temp: fileA.temp,
          backup: fileA.backup,
          phase: "backup_created" as const,
          originalState: "present" as const,
          mode: fileAEntry.result!.mode,
          blobId: fileAEntry.result!.blobId!,
          baseBlobId: fileAEntry.base!.blobId ?? null,
        },
        {
          path: "file-b.txt",
          destination: join(sourceDir, "file-b.txt"),
          temp: fileB.temp,
          backup: fileB.backup,
          phase: "planned" as const,
          originalState: "present" as const,
          mode: fileBEntry.result!.mode,
          blobId: fileBEntry.result!.blobId!,
          baseBlobId: fileBEntry.base!.blobId ?? null,
        },
      ],
      createdDirs: [],
      state: "in_progress" as const,
    };

    // Simulate the crash state: backup exists, destination is gone.
    await writeFile(fileA.backup, "original-a\n", "utf8");
    // Remove the destination to simulate crash after rename.
    await rm(join(sourceDir, "file-a.txt"));
    // file-b.txt is untouched.

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);

    // Record source HEAD before recovery.
    const headBefore = await git(["rev-parse", "HEAD"], sourceDir);

    // Run recovery.
    const recoveryResult = await recoverLandingManifest(manifestPath);

    // Source HEAD should be unchanged.
    const headAfter = await git(["rev-parse", "HEAD"], sourceDir);
    assert.equal(headBefore, headAfter, "source HEAD should be unchanged after recovery");

    // file-a.txt should be restored from backup.
    const aContent = await readFile(join(sourceDir, "file-a.txt"), "utf8");
    assert.equal(aContent, "original-a\n", "file-a.txt should be restored to original content");

    // file-b.txt should be unchanged.
    const bContent = await readFile(join(sourceDir, "file-b.txt"), "utf8");
    assert.equal(bContent, "original-b\n", "file-b.txt should be unchanged");

    // Verify recovery result.
    assert.equal(recoveryResult.status, "recovered");
    assert.ok(recoveryResult.restoredPaths.includes("file-a.txt"));
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: "planned" phase crash window — backup rename happened but phase not updated ──

test("wave-landing recovery — planned phase with backup present restores from backup", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-planned-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-planned-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file.txt"), "original\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-planned-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "file.txt"), "modified\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);
    const planEntry = plan.paths[0];

    // Simulate crash: backup rename happened but phase update failed (still "planned").
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-planned";
    const art = buildArtifactPaths(join(sourceDir, "file.txt"), "file.txt", txId);

    // Backup exists, destination absent, temp exists.
    await writeFile(art.backup, "original\n", "utf8");
    await writeFile(art.temp, "modified\n", "utf8");
    await rm(join(sourceDir, "file.txt"));

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [{
        path: "file.txt",
        destination: join(sourceDir, "file.txt"),
        temp: art.temp,
        backup: art.backup,
        phase: "planned" as const, // Phase update failed after backup rename
        originalState: "present" as const,
        mode: planEntry.result!.mode,
        blobId: planEntry.result!.blobId!,
        baseBlobId: planEntry.base!.blobId ?? null,
      }],
      createdDirs: [],
      state: "in_progress" as const,
    };

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);

    // Run recovery.
    const recoveryResult = await recoverLandingManifest(manifestPath);

    // Should restore from backup.
    assert.equal(recoveryResult.status, "recovered");
    assert.ok(recoveryResult.restoredPaths.includes("file.txt"));

    // File should be restored to original content.
    const content = await readFile(join(sourceDir, "file.txt"), "utf8");
    assert.equal(content, "original\n", "file.txt should be restored to original content");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: simulated death after replacement install recovers modification/addition/deletion/symlink ──

test("wave-landing recovery — death after replacement install recovers all cases", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-replace-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-replace-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "to-modify.txt"), "original\n", "utf8");
    await writeFile(join(sourceDir, "to-delete.txt"), "to be deleted\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-replace-wave",
      artifactDir,
    });

    // Worker modifies, adds, deletes, and adds a symlink.
    const worker = await createWorkerWorktree(capture, "task-all");
    await writeFile(join(worker.worktreeRoot, "to-modify.txt"), "modified\n", "utf8");
    await writeFile(join(worker.worktreeRoot, "to-add.txt"), "new file\n", "utf8");
    await rm(join(worker.worktreeRoot, "to-delete.txt"));
    await writeFile(join(worker.worktreeRoot, "target.txt"), "target content\n", "utf8");
    await symlink("target.txt", join(worker.worktreeRoot, "link.txt"));
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-all", "All changes");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-all" });

    const result = await integrateWave(capture, [
      { taskId: "task-all", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Get the actual blob IDs from the plan for accurate manifest construction.
    const planPaths = new Map(plan.paths.map((p) => [p.path, p]));

    // Simulate a crash after replacement_installed for all paths.
    // Create backups and install the modified content.
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-replace";
    const modifyArt = buildArtifactPaths(join(sourceDir, "to-modify.txt"), "to-modify.txt", txId);
    const deleteArt = buildArtifactPaths(join(sourceDir, "to-delete.txt"), "to-delete.txt", txId);

    // Create backups.
    await writeFile(modifyArt.backup, "original\n", "utf8");
    await writeFile(deleteArt.backup, "to be deleted\n", "utf8");

    // Install the modified content (simulating replacement_installed).
    await writeFile(join(sourceDir, "to-modify.txt"), "modified\n", "utf8");
    await writeFile(join(sourceDir, "to-add.txt"), "new file\n", "utf8");
    // to-delete.txt: crash AFTER backup but BEFORE deletion — destination still exists.
    // link.txt was created as a symlink.
    await symlink("target.txt", join(sourceDir, "link.txt"));
    await writeFile(join(sourceDir, "target.txt"), "target content\n", "utf8");

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [
        {
          path: "to-modify.txt",
          destination: join(sourceDir, "to-modify.txt"),
          temp: modifyArt.temp,
          backup: modifyArt.backup,
          phase: "replacement_installed" as const,
          originalState: "present" as const,
          mode: "100644",
          blobId: planPaths.get("to-modify.txt")?.result?.blobId ?? "",
          baseBlobId: planPaths.get("to-modify.txt")?.base?.blobId ?? null,
        },
        {
          path: "to-add.txt",
          destination: join(sourceDir, "to-add.txt"),
          temp: "",
          backup: null,
          phase: "replacement_installed" as const,
          originalState: "absent" as const,
          mode: "100644",
          blobId: planPaths.get("to-add.txt")?.result?.blobId ?? "",
          baseBlobId: null,
        },
        {
          path: "to-delete.txt",
          destination: join(sourceDir, "to-delete.txt"),
          temp: deleteArt.temp,
          backup: deleteArt.backup,
          phase: "backup_created" as const,
          originalState: "present" as const,
          mode: "", // Real deletion manifests store mode "" (lp.result?.mode ?? "")
          blobId: "",
          baseBlobId: planPaths.get("to-delete.txt")?.base?.blobId ?? null,
        },
        {
          path: "link.txt",
          destination: join(sourceDir, "link.txt"),
          temp: "",
          backup: null,
          phase: "replacement_installed" as const,
          originalState: "absent" as const,
          mode: "120000",
          blobId: planPaths.get("link.txt")?.result?.blobId ?? "",
          baseBlobId: null,
        },
        {
          path: "target.txt",
          destination: join(sourceDir, "target.txt"),
          temp: "",
          backup: null,
          phase: "replacement_installed" as const,
          originalState: "absent" as const,
          mode: "100644",
          blobId: planPaths.get("target.txt")?.result?.blobId ?? "",
          baseBlobId: null,
        },
      ],
      createdDirs: [],
      state: "in_progress" as const,
    };

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);

    // Run recovery.
    const recoveryResult = await recoverLandingManifest(manifestPath);

    // to-modify.txt should be restored to original.
    const modifyContent = await readFile(join(sourceDir, "to-modify.txt"), "utf8");
    assert.equal(modifyContent, "original\n", "to-modify.txt should be restored to original");

    // to-add.txt should be removed (it was an addition).
    await assert.rejects(
      readFile(join(sourceDir, "to-add.txt"), "utf8"),
      { code: "ENOENT" },
      "to-add.txt should be removed",
    );

    // to-delete.txt: crash was after backup but before deletion.
    // Destination still has original content — recovery cleans up the backup.
    const deleteContent = await readFile(join(sourceDir, "to-delete.txt"), "utf8");
    assert.equal(deleteContent, "to be deleted\n", "to-delete.txt should still have original content");

    // link.txt should be removed (it was an addition).
    await assert.rejects(
      lstat(join(sourceDir, "link.txt")),
      { code: "ENOENT" },
      "link.txt should be removed",
    );

    // target.txt should be removed (it was an addition).
    await assert.rejects(
      readFile(join(sourceDir, "target.txt"), "utf8"),
      { code: "ENOENT" },
      "target.txt should be removed",
    );

    assert.equal(recoveryResult.status, "recovered", JSON.stringify(recoveryResult, null, 2));
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: concurrent destination modification causes recovery_required ──

test("wave-landing recovery — concurrent modification causes manual_required", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-concurrent-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-concurrent-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file-a.txt"), "original-a\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-concurrent-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "file-a.txt"), "modified-a\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Simulate crash state: backup exists, destination was modified by concurrent user.
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-concurrent";
    const art = buildArtifactPaths(join(sourceDir, "file-a.txt"), "file-a.txt", txId);

    await writeFile(art.backup, "original-a\n", "utf8");
    // Concurrent user modified the destination.
    await writeFile(join(sourceDir, "file-a.txt"), "concurrent modification\n", "utf8");

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [
        {
          path: "file-a.txt",
          destination: join(sourceDir, "file-a.txt"),
          temp: art.temp,
          backup: art.backup,
          phase: "replacement_installed" as const,
          originalState: "present" as const,
          mode: "100644",
          blobId: plan.paths[0].result?.blobId ?? "",
          baseBlobId: plan.paths[0].base?.blobId ?? null,
        },
      ],
      createdDirs: [],
      state: "in_progress" as const,
    };

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);

    // Run recovery.
    const recoveryResult = await recoverLandingManifest(manifestPath);

    // Should require manual intervention.
    assert.equal(recoveryResult.status, "manual_required");

    // Concurrent modification should be preserved.
    const aContent = await readFile(join(sourceDir, "file-a.txt"), "utf8");
    assert.equal(aContent, "concurrent modification\n", "concurrent modification should be preserved");

    // Backup should still exist.
    const backupContent = await readFile(art.backup, "utf8");
    assert.equal(backupContent, "original-a\n", "original backup should be preserved");

    // Manifest should be marked recovery_required.
    const manifestContent = await readFile(manifestPath, "utf8");
    const updatedManifest = JSON.parse(manifestContent);
    assert.equal(updatedManifest.state, "recovery_required");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: malformed manifest is rejected ──

test("wave-landing recovery — malformed manifest is rejected", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-malformed-");
  try {
    const manifestPath = join(artifactDir, "malformed.json");

    // Test: invalid JSON.
    await writeFile(manifestPath, "{invalid json", "utf8");
    const result1 = await recoverLandingManifest(manifestPath);
    assert.equal(result1.status, "rejected");
    assert.ok(result1.reason.includes("malformed JSON"));

    // Test: wrong version.
    await writeFile(manifestPath, JSON.stringify({ version: 2, paths: [] }), "utf8");
    const result2 = await recoverLandingManifest(manifestPath);
    assert.equal(result2.status, "rejected");
    assert.ok(result2.reason.includes("version"));

    // Test: missing required fields.
    await writeFile(manifestPath, JSON.stringify({ version: 1 }), "utf8");
    const result3 = await recoverLandingManifest(manifestPath);
    assert.equal(result3.status, "rejected");
    assert.ok(result3.reason.includes("required fields"));

    // Test: missing sourceIdentity.
    await writeFile(manifestPath, JSON.stringify({
      version: 1 as const,
      sourceRoot: "/tmp",
      baseCommit: "abc",
      integratedCommit: "def",
      integratedRef: "ref",
      paths: [],
    }), "utf8");
    const result4 = await recoverLandingManifest(manifestPath);
    assert.equal(result4.status, "rejected");
    assert.ok(result4.reason.includes("sourceIdentity"));

    // Test: non-existent manifest.
    const result5 = await recoverLandingManifest(join(artifactDir, "nonexistent.json"));
    assert.equal(result5.status, "rejected");
    assert.ok(result5.reason.includes("not found"));
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: path-escaping manifest is rejected ──

test("wave-landing recovery — path-escaping manifest is rejected", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-escape-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-escape-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-escape-wave",
      artifactDir,
    });

    const manifestPath = join(artifactDir, "escape.json");

    // Test: destination escapes source root.
    await writeFile(manifestPath, JSON.stringify({
      version: 1 as const,
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: capture.baseCommit,
      integratedRef: "ref",
      paths: [{
        path: "file.txt",
        destination: "/etc/passwd",
        temp: "",
        backup: null,
        phase: "planned" as const,
        originalState: "present" as const,
        mode: "100644",
        blobId: "abc",
        baseBlobId: null,
      }],
      createdDirs: [],
      state: "in_progress" as const,
    }), "utf8");

    const signedEscape = await createTestSignedManifest(
      artifactDir,
      JSON.parse(await readFile(manifestPath, "utf8")),
      "escape-destination",
    );
    const result = await recoverLandingManifest(signedEscape.manifestPath);
    assert.equal(result.status, "rejected");
    assert.ok(result.reason.includes("escapes source root") || result.reason.includes("does not match path"),
      `Path-escaping manifest should be rejected: ${result.reason}`);

    // Test: path traversal in path field.
    await writeFile(manifestPath, JSON.stringify({
      version: 1 as const,
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: capture.baseCommit,
      integratedRef: "ref",
      paths: [{
        path: "../etc/passwd",
        destination: join(sourceDir, "file.txt"),
        temp: "",
        backup: null,
        phase: "planned" as const,
        originalState: "present" as const,
        mode: "100644",
        blobId: "abc",
        baseBlobId: null,
      }],
      createdDirs: [],
      state: "in_progress" as const,
    }), "utf8");

    const signedPathTraversal = await createTestSignedManifest(
      artifactDir,
      JSON.parse(await readFile(manifestPath, "utf8")),
      "escape-path",
    );
    const result2 = await recoverLandingManifest(signedPathTraversal.manifestPath);
    assert.equal(result2.status, "rejected");
    assert.ok(result2.reason.includes("unsafe path") || result2.reason.includes("path traversal"));

    // Test: ".." traversal in destination path.
    await writeFile(manifestPath, JSON.stringify({
      version: 1 as const,
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: capture.baseCommit,
      integratedRef: "ref",
      paths: [{
        path: "file.txt",
        destination: join(sourceDir, "..", "victim"),
        temp: "",
        backup: null,
        phase: "planned" as const,
        originalState: "present" as const,
        mode: "100644",
        blobId: "abc",
        baseBlobId: null,
      }],
      createdDirs: [],
      state: "in_progress" as const,
    }), "utf8");

    const signedDestinationTraversal = await createTestSignedManifest(
      artifactDir,
      JSON.parse(await readFile(manifestPath, "utf8")),
      "escape-dotdot",
    );
    const result3 = await recoverLandingManifest(signedDestinationTraversal.manifestPath);
    assert.equal(result3.status, "rejected");
    assert.ok(result3.reason.includes("escapes source root") || result3.reason.includes("does not match path"),
      `".." traversal should be rejected: ${result3.reason}`);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: wrong root identity is rejected ──

test("wave-landing recovery — wrong root identity is rejected", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-wrongroot-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-wrongroot-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-wrongroot-wave",
      artifactDir,
    });

    // Create a different directory to use as wrong source root.
    const wrongDir = await mkTmp("pi-wl-rec-wrongdir-");
    await git(["init", "--quiet"], wrongDir);
    await writeFile(join(wrongDir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], wrongDir);
    await git(["commit", "--quiet", "-m", "init"], wrongDir);

    const manifestPath = join(artifactDir, "wrongroot.json");
    await writeFile(manifestPath, JSON.stringify({
      version: 1 as const,
      sourceRoot: wrongDir,
      sourceIdentity: capture.sourceIdentity, // Wrong identity — belongs to sourceDir, not wrongDir.
      baseCommit: capture.baseCommit,
      integratedCommit: capture.baseCommit,
      integratedRef: "ref",
      paths: [{
        path: "file.txt",
        destination: join(wrongDir, "file.txt"),
        temp: "",
        backup: null,
        phase: "planned" as const,
        originalState: "present" as const,
        mode: "100644",
        blobId: "abc",
        baseBlobId: null,
      }],
      createdDirs: [],
      state: "in_progress" as const,
    }), "utf8");

    const signedWrongRoot = await createTestSignedManifest(
      artifactDir,
      JSON.parse(await readFile(manifestPath, "utf8")),
      "wrong-root-identity",
    );
    const result = await recoverLandingManifest(signedWrongRoot.manifestPath);
    assert.equal(result.status, "rejected");
    assert.ok(result.reason.includes("identity mismatch"));

    await rm(wrongDir, { recursive: true, force: true });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: wrong version manifest is rejected ──

test("wave-landing recovery — wrong version manifest is rejected", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-version-");
  try {
    const manifestPath = join(artifactDir, "wrong-version.json");
    await writeFile(manifestPath, JSON.stringify({
      version: 99,
      sourceRoot: "/tmp",
      sourceIdentity: { dev: 1, ino: 1 },
      baseCommit: "abc",
      integratedCommit: "def",
      integratedRef: "ref",
      paths: [],
      createdDirs: [],
      state: "in_progress" as const,
    }), "utf8");

    const result = await recoverLandingManifest(manifestPath);
    assert.equal(result.status, "rejected");
    assert.ok(result.reason.includes("version"));
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: completed manifest cleanup cannot roll back landed files ──

test("wave-landing recovery — completed manifest cleanup does not roll back landed files", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-completed-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-completed-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file.txt"), "original\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-completed-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "file.txt"), "modified\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Simulate a completed manifest with stale backups.
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-completed";
    const art = buildArtifactPaths(join(sourceDir, "file.txt"), "file.txt", txId);

    // The file has been landed (modified content).
    await writeFile(join(sourceDir, "file.txt"), "modified\n", "utf8");
    // Stale backup exists.
    await writeFile(art.backup, "original\n", "utf8");

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [
        {
          path: "file.txt",
          destination: join(sourceDir, "file.txt"),
          temp: art.temp,
          backup: art.backup,
          phase: "cleanup" as const,
          originalState: "present" as const,
          mode: "100644",
          blobId: plan.paths[0].result?.blobId ?? "",
          baseBlobId: plan.paths[0].base?.blobId ?? null,
        },
      ],
      createdDirs: [],
      state: "completed" as const,
    };

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);

    // Run recovery on completed manifest.
    const recoveryResult = await recoverLandingManifest(manifestPath);

    // Should be terminal state — cleanup only.
    assert.equal(recoveryResult.status, "terminal");
    assert.equal(recoveryResult.state, "completed");

    // Landed file should NOT be rolled back.
    const fileContent = await readFile(join(sourceDir, "file.txt"), "utf8");
    assert.equal(fileContent, "modified\n", "landed file should not be rolled back");

    // Stale backup should be cleaned up.
    await assert.rejects(
      readFile(art.backup, "utf8"),
      { code: "ENOENT" },
      "stale backup should be cleaned up",
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: rolled_back manifest cleanup cannot delete user files ──

test("wave-landing recovery — rolled_back manifest cleanup does not delete user files", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-rolledback-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-rolledback-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file.txt"), "original\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-rolledback-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "file.txt"), "modified\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Simulate a rolled_back manifest with stale temps.
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-rolledback";
    const art = buildArtifactPaths(join(sourceDir, "file.txt"), "file.txt", txId);

    // User file exists.
    await writeFile(join(sourceDir, "file.txt"), "user content\n", "utf8");
    // Stale temp exists.
    await writeFile(art.temp, "temp content\n", "utf8");

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [
        {
          path: "file.txt",
          destination: join(sourceDir, "file.txt"),
          temp: art.temp,
          backup: null,
          phase: "rolled_back" as const,
          originalState: "present" as const,
          mode: "100644",
          blobId: plan.paths[0].result?.blobId ?? "",
          baseBlobId: plan.paths[0].base?.blobId ?? null,
        },
      ],
      createdDirs: [],
      state: "rolled_back" as const,
    };

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);

    // Run recovery on rolled_back manifest.
    const recoveryResult = await recoverLandingManifest(manifestPath);

    // Should be terminal state — cleanup only.
    assert.equal(recoveryResult.status, "terminal");
    assert.equal(recoveryResult.state, "rolled_back");

    // User file should NOT be deleted.
    const fileContent = await readFile(join(sourceDir, "file.txt"), "utf8");
    assert.equal(fileContent, "user content\n", "user file should not be deleted");

    // Stale temp should be cleaned up.
    await assert.rejects(
      readFile(art.temp, "utf8"),
      { code: "ENOENT" },
      "stale temp should be cleaned up",
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: manifest recovery transitions are atomic and idempotent ──

test("wave-landing recovery — transitions are atomic and idempotent", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-idempotent-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-idempotent-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file.txt"), "original\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-idempotent-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "file.txt"), "modified\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Create a manifest with backup_created phase and destination absent.
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-idempotent";
    const art = buildArtifactPaths(join(sourceDir, "file.txt"), "file.txt", txId);

    // Backup exists, destination is absent.
    await writeFile(art.backup, "original\n", "utf8");

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [
        {
          path: "file.txt",
          destination: join(sourceDir, "file.txt"),
          temp: art.temp,
          backup: art.backup,
          phase: "backup_created" as const,
          originalState: "present" as const,
          mode: "100644",
          blobId: plan.paths[0].result?.blobId ?? "",
          baseBlobId: plan.paths[0].base?.blobId ?? null,
        },
      ],
      createdDirs: [],
      state: "in_progress" as const,
    };

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);

    // First recovery: should restore the file.
    const result1 = await recoverLandingManifest(manifestPath);
    assert.equal(result1.status, "recovered");

    // Verify file was restored.
    const fileContent = await readFile(join(sourceDir, "file.txt"), "utf8");
    assert.equal(fileContent, "original\n", "file should be restored");

    // Second recovery: should be idempotent (manifest is now rolled_back).
    const result2 = await recoverLandingManifest(manifestPath);
    assert.equal(result2.status, "terminal");
    assert.equal(result2.state, "rolled_back");

    // File should still be there.
    const fileContent2 = await readFile(join(sourceDir, "file.txt"), "utf8");
    assert.equal(fileContent2, "original\n", "file should still be restored");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: executable file recovery preserves mode ──

test("wave-landing recovery — executable file recovery preserves mode", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-exec-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-exec-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "script.sh"), "#!/bin/sh\necho hi\n", "utf8");
    await chmod(join(sourceDir, "script.sh"), 0o755);
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-exec-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "script.sh"), "#!/bin/sh\necho modified\n", "utf8");
    await chmod(join(worker.worktreeRoot, "script.sh"), 0o755);
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Simulate crash: backup exists with original executable content, destination absent.
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-exec";
    const art = buildArtifactPaths(join(sourceDir, "script.sh"), "script.sh", txId);

    await writeFile(art.backup, "#!/bin/sh\necho hi\n", "utf8");
    await chmod(art.backup, 0o755);

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [
        {
          path: "script.sh",
          destination: join(sourceDir, "script.sh"),
          temp: art.temp,
          backup: art.backup,
          phase: "backup_created" as const,
          originalState: "present" as const,
          mode: "100755",
          blobId: plan.paths[0].result?.blobId ?? "",
          baseBlobId: plan.paths[0].base?.blobId ?? null,
        },
      ],
      createdDirs: [],
      state: "in_progress" as const,
    };

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);
    // manifest written via createTestSignedManifest

    // Run recovery.
    const recoveryResult = await recoverLandingManifest(manifestPath);
    assert.equal(recoveryResult.status, "recovered");

    // Verify executable bit is preserved.
    const stat = await fsStat(join(sourceDir, "script.sh"));
    assert.ok((stat.mode & 0o111) !== 0, "script.sh should be executable after recovery");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: binary file recovery preserves exact content ──

test("wave-landing recovery — binary file recovery preserves exact content", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-binary-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-binary-src-");
    await git(["init", "--quiet"], sourceDir);
    const originalData = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]);
    await writeFile(join(sourceDir, "data.bin"), originalData);
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-binary-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mod");
    const modifiedData = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0x00]);
    await writeFile(join(worker.worktreeRoot, "data.bin"), modifiedData);
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Simulate crash: backup exists with original binary content, destination absent.
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-binary";
    const art = buildArtifactPaths(join(sourceDir, "data.bin"), "data.bin", txId);

    await writeFile(art.backup, originalData);

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [
        {
          path: "data.bin",
          destination: join(sourceDir, "data.bin"),
          temp: art.temp,
          backup: art.backup,
          phase: "backup_created" as const,
          originalState: "present" as const,
          mode: "100644",
          blobId: plan.paths[0].result?.blobId ?? "",
          baseBlobId: plan.paths[0].base?.blobId ?? null,
        },
      ],
      createdDirs: [],
      state: "in_progress" as const,
    };

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);
    // manifest written via createTestSignedManifest

    // Run recovery.
    const recoveryResult = await recoverLandingManifest(manifestPath);
    assert.equal(recoveryResult.status, "recovered");

    // Verify binary content is exact.
    const fileData = await readFile(join(sourceDir, "data.bin"));
    assert.ok(fileData.equals(originalData), "binary content should match exactly");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: symlink recovery ──

test("wave-landing recovery — symlink recovery", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-symlink-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-symlink-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "target.txt"), "target content\n", "utf8");
    await symlink("target.txt", join(sourceDir, "link.txt"));
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-symlink-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mod");
    // Change the symlink target.
    await rm(join(worker.worktreeRoot, "link.txt"));
    await writeFile(join(worker.worktreeRoot, "other.txt"), "other content\n", "utf8");
    await symlink("other.txt", join(worker.worktreeRoot, "link.txt"));
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify symlink");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Simulate crash: backup exists with original symlink, destination absent.
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-symlink";
    const art = buildArtifactPaths(join(sourceDir, "link.txt"), "link.txt", txId);

    // Create backup as a symlink.
    await symlink("target.txt", art.backup);

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [
        {
          path: "link.txt",
          destination: join(sourceDir, "link.txt"),
          temp: art.temp,
          backup: art.backup,
          phase: "backup_created" as const,
          originalState: "symlink" as const,
          mode: "120000",
          blobId: plan.paths.find((p) => p.path === "link.txt")?.result?.blobId ?? "",
          baseBlobId: plan.paths.find((p) => p.path === "link.txt")?.base?.blobId ?? null,
        },
      ],
      createdDirs: [],
      state: "in_progress" as const,
    };

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);
    // manifest written via createTestSignedManifest

    // Run recovery.
    const recoveryResult = await recoverLandingManifest(manifestPath);
    assert.equal(recoveryResult.status, "recovered");

    // Verify symlink is restored.
    const linkStat = await lstat(join(sourceDir, "link.txt"));
    assert.ok(linkStat.isSymbolicLink(), "link.txt should be a symlink after recovery");
    const linkTarget = await readlink(join(sourceDir, "link.txt"));
    assert.equal(linkTarget, "target.txt", "symlink target should be restored");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: planned-phase post-rename addition crash recovery ──
// An addition killed after temp→destination rename while manifest phase is still planned
// must detect destination exact result plus missing temp/backup, remove that transaction-owned
// addition, and be idempotent.

test("wave-landing recovery — planned-phase post-rename addition crash recovery removes exact transaction-owned addition", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-addition-crash-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-addition-crash-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "readme\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-addition-crash-wave",
      artifactDir,
    });

    // Worker adds a new file.
    const worker = await createWorkerWorktree(capture, "task-add");
    await writeFile(join(worker.worktreeRoot, "new-file.txt"), "new content\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-add", "Add file");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-add" });

    const result = await integrateWave(capture, [
      { taskId: "task-add", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);
    const planEntry = plan.paths[0];

    // Simulate crash: addition rename happened (destination exists with result content)
    // but manifest phase is still "planned" and temp/backup are missing.
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-addition-crash";
    const art = buildArtifactPaths(join(sourceDir, "new-file.txt"), "new-file.txt", txId);

    // The destination exists with the exact result content (transaction-owned addition).
    await writeFile(join(sourceDir, "new-file.txt"), "new content\n", "utf8");
    // Temp and backup are missing (crash after rename).

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [{
        path: "new-file.txt",
        destination: join(sourceDir, "new-file.txt"),
        temp: art.temp,
        backup: null, // Addition has no backup
        phase: "planned" as const, // Phase update failed after rename
        originalState: "absent" as const,
        mode: planEntry.result!.mode,
        blobId: planEntry.result!.blobId!,
        baseBlobId: null,
      }],
      createdDirs: [],
      state: "in_progress" as const,
    };

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);
    // manifest written via createTestSignedManifest

    // Record source HEAD before recovery.
    const headBefore = await git(["rev-parse", "HEAD"], sourceDir);

    // Run recovery.
    const recoveryResult = await recoverLandingManifest(manifestPath);

    // Should clean up the transaction-owned addition.
    assert.equal(recoveryResult.status, "recovered");

    // The transaction-owned addition should be removed.
    await assert.rejects(
      readFile(join(sourceDir, "new-file.txt"), "utf8"),
      { code: "ENOENT" },
      "transaction-owned addition should be removed",
    );

    // Source HEAD should be unchanged.
    const headAfter = await git(["rev-parse", "HEAD"], sourceDir);
    assert.equal(headBefore, headAfter, "source HEAD should be unchanged");

    // Second call should be safe (idempotent).
    const result2 = await recoverLandingManifest(manifestPath);
    assert.equal(result2.status, "terminal");
    assert.equal(result2.state, "rolled_back");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: crafted valid-root manifest with victim backup/temp paths is rejected ──
// Prove that a crafted manifest pointing backup/temp at a normal victim file
// is rejected and the victim remains untouched.

test("wave-landing recovery — crafted valid-root manifest with victim backup/temp paths is rejected", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-crafted-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-crafted-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "readme\n", "utf8");
    await writeFile(join(sourceDir, "victim.txt"), "precious data\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-crafted-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "readme.md"), "modified\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Craft a manifest that points backup at the victim file.
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-crafted";
    const art = buildArtifactPaths(join(sourceDir, "readme.md"), "readme.md", txId);

    // Crafted manifest: backup points at victim.txt (inside source root but wrong path).
    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [{
        path: "readme.md",
        destination: join(sourceDir, "readme.md"),
        temp: art.temp,
        backup: join(sourceDir, "victim.txt"), // Points at victim — should be rejected
        phase: "backup_created" as const,
        originalState: "present" as const,
        mode: plan.paths[0].result!.mode,
        blobId: plan.paths[0].result!.blobId!,
        baseBlobId: plan.paths[0].base!.blobId ?? null,
      }],
      createdDirs: [],
      state: "in_progress" as const,
    };

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);
    // manifest written via createTestSignedManifest

    // Record victim content before recovery.
    const victimBefore = await readFile(join(sourceDir, "victim.txt"), "utf8");

    // Run recovery — should be rejected.
    const recoveryResult = await recoverLandingManifest(manifestPath);

    // Should be rejected due to backup path mismatch.
    assert.equal(recoveryResult.status, "rejected");
    assert.ok(recoveryResult.reason.includes("backup path does not match"),
      `Should reject backup path mismatch: ${recoveryResult.reason}`);

    // Victim should be untouched.
    const victimAfter = await readFile(join(sourceDir, "victim.txt"), "utf8");
    assert.equal(victimBefore, victimAfter, "victim file should be untouched");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: crafted manifest with originalState "present" cannot delete victim via planned-phase branch ──
// Proves the planned-phase deletion is gated on the controller's addition signature.

test("wave-landing recovery — crafted manifest with originalState present cannot delete victim via planned-phase branch", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-crafted-present-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-crafted-present-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "readme\n", "utf8");
    await writeFile(join(sourceDir, "victim.txt"), "precious data\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-crafted-present-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "readme.md"), "modified\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Craft a manifest claiming victim.txt is a modification (originalState: "present" as const, backup: null)
    // with blobId/mode matching the victim's content, phase: "planned".
    // The planned-phase branch should NOT delete the victim because originalState is not "absent".
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-crafted-present";
    const victimPath = join(sourceDir, "victim.txt");
    const victimArt = buildArtifactPaths(victimPath, "victim.txt", txId);

    // Compute the victim's actual blobId and mode to make destMatchesResult true.
    const victimData = await readFile(victimPath);
    const victimBlobId = createHash("sha1").update(`blob ${victimData.length}\0`).update(victimData).digest("hex");

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [{
        path: "victim.txt",
        destination: victimPath,
        temp: victimArt.temp,
        backup: null, // No backup — claims it's an addition but originalState is "present"
        phase: "planned" as const,
        originalState: "present" as const, // NOT "absent" — should prevent deletion
        mode: "100644",
        blobId: victimBlobId, // Matches victim content to trigger destMatchesResult
        baseBlobId: null,
      }],
      createdDirs: [],
      state: "in_progress" as const,
    };

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);
    // manifest written via createTestSignedManifest

    // Record victim content before recovery.
    const victimBefore = await readFile(victimPath, "utf8");

    // Run recovery.
    const recoveryResult = await recoverLandingManifest(manifestPath);

    // Should be recovered (not rejected) but victim should NOT be deleted.
    // The planned-phase branch is gated on originalState === "absent".
    assert.ok(
      recoveryResult.status === "recovered" || recoveryResult.status === "terminal",
      `Expected recovered or terminal, got ${recoveryResult.status}`,
    );

    // Victim should be untouched.
    const victimAfter = await readFile(victimPath, "utf8");
    assert.equal(victimBefore, victimAfter, "victim file should be untouched despite matching blobId/mode");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: manual_required preserves all artifacts for diagnosis ──
// When one path triggers manual_required, verify that temp artifacts for
// other paths are preserved (not cleaned up) for diagnosis.

test("wave-landing recovery — manual_required preserves temp artifacts for diagnosis", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-manual-preserve-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-manual-preserve-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file-a.txt"), "original-a\n", "utf8");
    await writeFile(join(sourceDir, "file-b.txt"), "original-b\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-manual-preserve-wave",
      artifactDir,
    });

    // Worker modifies both files.
    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "file-a.txt"), "modified-a\n", "utf8");
    await writeFile(join(worker.worktreeRoot, "file-b.txt"), "modified-b\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);
    const planPaths = new Map(plan.paths.map((p) => [p.path, p]));

    // Simulate crash state:
    // file-a.txt: concurrent modification (triggers manual_required)
    // file-b.txt: replacement_installed, destination matches result (would be restored)
    // Both have temp files present.
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-manual-preserve";
    const fileA = buildArtifactPaths(join(sourceDir, "file-a.txt"), "file-a.txt", txId);
    const fileB = buildArtifactPaths(join(sourceDir, "file-b.txt"), "file-b.txt", txId);

    // file-a.txt: concurrent modification (backup exists, dest differs from result)
    await writeFile(fileA.backup, "original-a\n", "utf8");
    await writeFile(join(sourceDir, "file-a.txt"), "concurrent modification\n", "utf8");
    // Temp file for file-a exists
    await writeFile(fileA.temp, "modified-a\n", "utf8");

    // file-b.txt: replacement_installed, dest matches result
    await writeFile(fileB.backup, "original-b\n", "utf8");
    await writeFile(join(sourceDir, "file-b.txt"), "modified-b\n", "utf8");
    // Temp file for file-b exists
    await writeFile(fileB.temp, "modified-b\n", "utf8");

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [
        {
          path: "file-a.txt",
          destination: join(sourceDir, "file-a.txt"),
          temp: fileA.temp,
          backup: fileA.backup,
          phase: "replacement_installed" as const,
          originalState: "present" as const,
          mode: planPaths.get("file-a.txt")?.result?.mode ?? "",
          blobId: planPaths.get("file-a.txt")?.result?.blobId ?? "",
          baseBlobId: planPaths.get("file-a.txt")?.base?.blobId ?? null,
        },
        {
          path: "file-b.txt",
          destination: join(sourceDir, "file-b.txt"),
          temp: fileB.temp,
          backup: fileB.backup,
          phase: "replacement_installed" as const,
          originalState: "present" as const,
          mode: planPaths.get("file-b.txt")?.result?.mode ?? "",
          blobId: planPaths.get("file-b.txt")?.result?.blobId ?? "",
          baseBlobId: planPaths.get("file-b.txt")?.base?.blobId ?? null,
        },
      ],
      createdDirs: [],
      state: "in_progress" as const,
    };

    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);
    // manifest written via createTestSignedManifest

    // Run recovery.
    const recoveryResult = await recoverLandingManifest(manifestPath);

    // Should require manual intervention due to file-a.txt concurrent modification.
    assert.equal(recoveryResult.status, "manual_required");

    // Verify that temp artifacts are preserved for diagnosis.
    // file-a temp should still exist.
    const fileATempStat = await fsStat(fileA.temp).catch(() => null);
    assert.ok(fileATempStat, "file-a temp should be preserved for diagnosis");

    // file-b temp should still exist (not cleaned up because manual_required).
    const fileBTempStat = await fsStat(fileB.temp).catch(() => null);
    assert.ok(fileBTempStat, "file-b temp should be preserved for diagnosis");

    // Backup for file-a should still exist.
    const fileABackupStat = await fsStat(fileA.backup).catch(() => null);
    assert.ok(fileABackupStat, "file-a backup should be preserved for diagnosis");

    // Concurrent modification should be preserved.
    const aContent = await readFile(join(sourceDir, "file-a.txt"), "utf8");
    assert.equal(aContent, "concurrent modification\n", "concurrent modification should be preserved");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: crafted manifest createdDirs never removed in terminal/recovery state ──
// A crafted valid manifest listing a user empty directory in createdDirs
// should never have that directory removed in any terminal/recovery state.

test("wave-landing recovery — crafted manifest createdDirs never removed in terminal states", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-createddirs-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-createddirs-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "file.txt"), "content\n", "utf8");
    // Create an empty user directory that a crafted manifest might list.
    const userEmptyDir = join(sourceDir, "user-empty-dir");
    await mkdir(userEmptyDir);
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-createddirs-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "file.txt"), "modified\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    // ── Test 1: completed state — crafted manifest lists user dir in createdDirs ──
    // Use a proper txId that matches the manifest filename format.
    const txIdCompleted = "test-tx-createddirs-completed";
    const artCompleted = buildArtifactPaths(join(sourceDir, "file.txt"), "file.txt", txIdCompleted);

    const manifestCompleted = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [
        {
          path: "file.txt",
          destination: join(sourceDir, "file.txt"),
          temp: artCompleted.temp,
          backup: artCompleted.backup,
          phase: "cleanup" as const,
          originalState: "present" as const,
          mode: plan.paths[0].result?.mode ?? "",
          blobId: plan.paths[0].result?.blobId ?? "",
          baseBlobId: plan.paths[0].base?.blobId ?? null,
        },
      ],
      createdDirs: [userEmptyDir], // Crafted: user dir listed as transaction-created
      state: "completed" as const,
    };

    const { manifestPath: manifestPathCompleted } = await createTestSignedManifest(landingDir, manifestCompleted, txIdCompleted);

    // Run recovery on completed manifest.
    const resultCompleted = await recoverLandingManifest(manifestPathCompleted);
    assert.equal(resultCompleted.status, "terminal");
    assert.equal(resultCompleted.state, "completed");

    // User empty dir should NOT be removed.
    const userDirStat1 = await fsStat(userEmptyDir).catch(() => null);
    assert.ok(userDirStat1, "user empty dir should NOT be removed in completed state");

    // ── Test 2: rolled_back state — same crafted manifest ──
    const txIdRolledBack = "test-tx-createddirs-rolledback";
    const artRolledBack = buildArtifactPaths(join(sourceDir, "file.txt"), "file.txt", txIdRolledBack);

    const manifestRolledBack = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [
        {
          path: "file.txt",
          destination: join(sourceDir, "file.txt"),
          temp: artRolledBack.temp,
          backup: null,
          phase: "rolled_back" as const,
          originalState: "present" as const,
          mode: plan.paths[0].result?.mode ?? "",
          blobId: plan.paths[0].result?.blobId ?? "",
          baseBlobId: plan.paths[0].base?.blobId ?? null,
        },
      ],
      createdDirs: [userEmptyDir], // Crafted: user dir listed as transaction-created
      state: "rolled_back" as const,
    };

    const { manifestPath: manifestPathRolledBack } = await createTestSignedManifest(landingDir, manifestRolledBack, txIdRolledBack);

    // Run recovery on rolled_back manifest.
    const resultRolledBack = await recoverLandingManifest(manifestPathRolledBack);
    assert.equal(resultRolledBack.status, "terminal");
    assert.equal(resultRolledBack.state, "rolled_back");

    // User empty dir should still NOT be removed.
    const userDirStat2 = await fsStat(userEmptyDir).catch(() => null);
    assert.ok(userDirStat2, "user empty dir should NOT be removed in rolled_back state");

    // ── Test 3: in_progress state with clean recovery — createdDirs never removed ──
    // A crafted valid manifest with state in_progress, a path that recovers cleanly
    // (phase "planned", no backup/temp, so recoverSinglePath returns "skipped"),
    // and createdDirs: [userEmptyDir]. After recoverLandingManifest returns "recovered",
    // the user empty dir must still exist.
    const txIdInProgress = "test-tx-createddirs-inprogress";
    const artInProgress = buildArtifactPaths(join(sourceDir, "file.txt"), "file.txt", txIdInProgress);

    const manifestInProgress: Omit<RecoveryManifest, "authTag"> = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [
        {
          path: "file.txt",
          destination: join(sourceDir, "file.txt"),
          temp: artInProgress.temp,
          backup: null,
          phase: "planned" as const, // No mutations performed — recoverSinglePath returns "skipped"
          originalState: "present" as const,
          mode: plan.paths[0].result?.mode ?? "",
          blobId: plan.paths[0].result?.blobId ?? "",
          baseBlobId: plan.paths[0].base?.blobId ?? null,
        },
      ],
      createdDirs: [userEmptyDir], // Crafted: user dir listed as transaction-created
      state: "in_progress" as const,
    };

    const { manifestPath: manifestPathInProgress } = await createTestSignedManifest(
      landingDir,
      manifestInProgress,
      txIdInProgress,
    );

    // Run recovery on in_progress manifest.
    const resultInProgress = await recoverLandingManifest(manifestPathInProgress);
    assert.equal(resultInProgress.status, "recovered");

    // User empty dir should still NOT be removed (even though recovery succeeded).
    const userDirStat3 = await fsStat(userEmptyDir).catch(() => null);
    assert.ok(userDirStat3, "user empty dir should NOT be removed in in_progress success recovery");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: unsigned manifest is rejected (no auth key) ───────────────────────
// A crafted manifest with exact victim blob/mode but no valid controller key
// must not delete/rename the victim.

test("wave-landing recovery — unsigned manifest (no auth key) is rejected", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-unsigned-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-unsigned-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "readme\n", "utf8");
    await writeFile(join(sourceDir, "victim.txt"), "precious data\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-unsigned-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "readme.md"), "modified\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Create a manifest WITHOUT an auth key (unsigned).
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-unsigned";
    const art = buildArtifactPaths(join(sourceDir, "readme.md"), "readme.md", txId);

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [{
        path: "readme.md",
        destination: join(sourceDir, "readme.md"),
        temp: art.temp,
        backup: art.backup,
        phase: "backup_created" as const,
        originalState: "present" as const,
        mode: plan.paths[0].result!.mode,
        blobId: plan.paths[0].result!.blobId!,
        baseBlobId: plan.paths[0].base!.blobId ?? null,
      }],
      createdDirs: [],
      state: "in_progress" as const,
      authTag: "", // Empty auth tag — no key to verify against
    };

    // Write the manifest directly without signing (no auth key in landing dir).
    const manifestPath = join(landingDir, `manifest-${txId}.json`);
    await writeFile(manifestPath, JSON.stringify(manifestData, null, 2), "utf8");

    // Record victim content before recovery.
    const victimBefore = await readFile(join(sourceDir, "victim.txt"), "utf8");

    // Run recovery — should be rejected due to missing auth key.
    const recoveryResult = await recoverLandingManifest(manifestPath);

    // Should be rejected.
    assert.equal(recoveryResult.status, "rejected");
    assert.ok(recoveryResult.reason.includes("authentication") || recoveryResult.reason.includes("key"),
      `Should reject unsigned manifest: ${recoveryResult.reason}`);

    // Victim should be untouched.
    const victimAfter = await readFile(join(sourceDir, "victim.txt"), "utf8");
    assert.equal(victimBefore, victimAfter, "victim file should be untouched");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: tampered manifest (wrong auth tag) is rejected ─────────────────────
// A manifest with a valid auth key but a tampered auth tag must be rejected.

test("wave-landing recovery — tampered manifest (wrong auth tag) is rejected", async () => {
  const artifactDir = await mkTmp("pi-wl-rec-tampered-");
  try {
    const sourceDir = await mkTmp("pi-wl-rec-tampered-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "readme\n", "utf8");
    await writeFile(join(sourceDir, "victim.txt"), "precious data\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "rec-tampered-wave",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-mod");
    await writeFile(join(worker.worktreeRoot, "readme.md"), "modified\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-mod" });

    const result = await integrateWave(capture, [
      { taskId: "task-mod", commitSha: candidate.commitSha },
    ]);
    assert.equal(result.status, "integrated");
    const integration = result as WaveIntegrationSuccess;

    const plan = await planWaveLanding(capture, integration.finalCommitSha, sourceDir);

    // Create a signed manifest, then tamper with the auth tag.
    const landingDir = join(capture.waveRoot, "landing");
    await mkdir(landingDir, { recursive: true });

    const txId = "test-tx-tampered";
    const art = buildArtifactPaths(join(sourceDir, "readme.md"), "readme.md", txId);

    const manifestData = {
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sourceRoot: sourceDir,
      sourceIdentity: capture.sourceIdentity,
      baseCommit: capture.baseCommit,
      integratedCommit: integration.finalCommitSha,
      integratedRef: plan.integratedRef,
      paths: [{
        path: "readme.md",
        destination: join(sourceDir, "readme.md"),
        temp: art.temp,
        backup: art.backup,
        phase: "backup_created" as const,
        originalState: "present" as const,
        mode: plan.paths[0].result!.mode,
        blobId: plan.paths[0].result!.blobId!,
        baseBlobId: plan.paths[0].base!.blobId ?? null,
      }],
      createdDirs: [],
      state: "in_progress" as const,
    };

    // Create a properly signed manifest first.
    const { manifestPath } = await createTestSignedManifest(landingDir, manifestData, txId);

    // Tamper with the auth tag.
    const manifestContent = await readFile(manifestPath, "utf8");
    const manifestObj = JSON.parse(manifestContent);
    manifestObj.authTag = "0000000000000000000000000000000000000000000000000000000000000000"; // Wrong tag
    await writeFile(manifestPath, JSON.stringify(manifestObj, null, 2), "utf8");

    // Record victim content before recovery.
    const victimBefore = await readFile(join(sourceDir, "victim.txt"), "utf8");

    // Run recovery — should be rejected due to wrong auth tag.
    const recoveryResult = await recoverLandingManifest(manifestPath);

    // Should be rejected.
    assert.equal(recoveryResult.status, "rejected");
    assert.ok(recoveryResult.reason.includes("Authentication tag mismatch") || recoveryResult.reason.includes("authentication"),
      `Should reject tampered manifest: ${recoveryResult.reason}`);

    // Victim should be untouched.
    const victimAfter = await readFile(join(sourceDir, "victim.txt"), "utf8");
    assert.equal(victimBefore, victimAfter, "victim file should be untouched");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
