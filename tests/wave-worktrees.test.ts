import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureWaveBase, WaveCaptureResult } from "../src/execution/wave-repository";
import {
  createWorkerWorktree,
  createIntegrationWorktree,
  gitWorktreeCoordinator,
  isWorktreeClean,
  removeWorktree,
  pinCommit,
  workerRefName,
  integrationRefName,
} from "../src/execution/wave-worktrees";

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

/** Resolve the next event-loop turn (a microtask-drain ordering barrier). */
function nextTurn(): Promise<void> {
  return new Promise((resolveTurn) => setImmediate(resolveTurn));
}

// Helper: create a committed source repo and capture it.
async function setupCapture(artifactDir: string, extraSetup?: (dir: string) => Promise<void>): Promise<{ sourceDir: string; capture: WaveCaptureResult }> {
  const sourceDir = await mkTmp("pi-wt-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await writeFile(join(sourceDir, "app.js"), "console.log('hi');\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);
  if (extraSetup) {
    await extraSetup(sourceDir);
  }
  const capture = await captureWaveBase({
    cwd: sourceDir,
    maxSnapshotBytes: 1_000_000,
    waveId: "test-wave",
    artifactDir,
  });
  return { sourceDir, capture };
}

// ── Test: two isolated worker filesystems from the same base ─────────────────

test("worktrees — two isolated worker filesystems from the same base", async () => {
  const artifactDir = await mkTmp("pi-wt-artifact-");
  try {
    const { sourceDir, capture } = await setupCapture(artifactDir);

    const worker1 = await createWorkerWorktree(capture, "task-1");
    const worker2 = await createWorkerWorktree(capture, "task-2");

    // Both should be rooted under the wave root.
    assert.ok(worker1.worktreeRoot.startsWith(capture.waveRoot));
    assert.ok(worker2.worktreeRoot.startsWith(capture.waveRoot));

    // They should be separate directories.
    assert.notEqual(worker1.worktreeRoot, worker2.worktreeRoot);

    // Both should have the same base commit.
    const head1 = await git(["rev-parse", "HEAD"], worker1.worktreeRoot);
    const head2 = await git(["rev-parse", "HEAD"], worker2.worktreeRoot);
    assert.equal(head1, capture.baseCommit);
    assert.equal(head2, capture.baseCommit);

    // Modify worker1 and verify worker2 is unaffected.
    await writeFile(join(worker1.worktreeRoot, "worker1-only.txt"), "w1\n", "utf8");
    const w2Files = await import("node:fs/promises").then((fs) => fs.readdir(worker2.worktreeRoot));
    assert.ok(!w2Files.includes("worker1-only.txt"), "worker2 should not have worker1's file");

    // Clean up worker1 (reset to clean state before removal).
    await git(["reset", "--hard", "HEAD"], worker1.worktreeRoot);
    await rm(join(worker1.worktreeRoot, "worker1-only.txt"), { force: true });

    await removeWorktree(worker1.worktreeRoot, capture.repositoryPath);
    await removeWorktree(worker2.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: concurrent registrations for one captured repository ──────────────

test("worktrees — concurrent worker registrations all land in shared administration", async () => {
  const artifactDir = await mkTmp("pi-wt-concurrent-");
  try {
    const { capture } = await setupCapture(artifactDir);

    // Start four preparations at once against one captured repository, as a
    // refilling worker pool does. Every registration shares the repository's
    // worktree administration, so a partially written entry must never be
    // observed by another preparation.
    const workers = await Promise.all(
      ["task-0", "task-1", "task-2", "task-3"].map((taskId) =>
        createWorkerWorktree(capture, taskId)
      ),
    );

    const registrations = await gitInRepo(["worktree", "list", "--porcelain"], capture.repositoryPath);
    const canonicalRepository = await realpath(capture.repositoryPath);
    for (const worker of workers) {
      // Each worktree is a working checkout at the captured base commit.
      const head = await git(["rev-parse", "HEAD"], worker.worktreeRoot);
      assert.equal(head, capture.baseCommit, `${worker.worktreeRoot} should be at the base commit`);
      assert.ok(
        registrations.includes(worker.worktreeRoot),
        `${worker.worktreeRoot} should be registered in the shared administration`,
      );
      // The registration metadata another preparation reads while enumerating
      // is complete: a readable, non-empty commondir that resolves to the
      // capture repository. A partially published entry would instead let a
      // concurrent enumeration see an empty or wrong common directory.
      const gitDir = await git(["rev-parse", "--absolute-git-dir"], worker.worktreeRoot);
      const commondir = await readFile(join(gitDir, "commondir"), "utf8");
      assert.notEqual(
        commondir.trim(),
        "",
        `${worker.worktreeRoot} should publish a non-empty commondir`,
      );
      const commonDir = await git(["rev-parse", "--git-common-dir"], worker.worktreeRoot);
      assert.equal(
        await realpath(resolve(worker.worktreeRoot, commonDir)),
        canonicalRepository,
        `${worker.worktreeRoot} should resolve to the captured repository`,
      );
    }

    for (const worker of workers) {
      await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
    }
    const remaining = await gitInRepo(["worktree", "list", "--porcelain"], capture.repositoryPath);
    for (const worker of workers) {
      assert.ok(
        !remaining.includes(worker.worktreeRoot),
        `${worker.worktreeRoot} should be deregistered after removal`,
      );
    }
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Production administration boundary: same repository excludes ────────────

test("worktrees — administration boundary excludes same-repository preparations", async () => {
  const artifactDir = await mkTmp("pi-wt-boundary-exclude-");
  const { capture } = await setupCapture(artifactDir);
  const entries: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolveGate) => {
    releaseFirst = resolveGate;
  });
  let firstEntered!: () => void;
  const firstInside = new Promise<void>((resolveInside) => {
    firstEntered = resolveInside;
  });

  try {
    // Barrier at the administration invocation boundary: the first preparation
    // holds the lease while it is inside, before its Git command runs.
    gitWorktreeCoordinator.beforeOperation = async (repoPath) => {
      entries.push(repoPath);
      if (entries.length === 1) {
        firstEntered();
        await firstGate;
      }
    };

    const first = createWorkerWorktree(capture, "task-first");
    await firstInside;

    // A same-repository preparation cannot enter that boundary while it is held.
    const follower = createIntegrationWorktree(capture);
    await nextTurn();
    assert.equal(entries.length, 1, "a queued same-repository preparation must not enter");
    assert.equal(entries[0], capture.repositoryPath, "the boundary is per captured repository");
    await assert.rejects(
      stat(join(capture.waveRoot, "integration")),
      "a queued preparation must not create its worktree directory",
    );

    releaseFirst();
    const [worker, integration] = await Promise.all([first, follower]);
    assert.equal(entries.length, 2, "the waiting preparation enters after the holder releases");

    // Both preparations complete genuine registrations in the shared
    // administration, with readable common-directory metadata.
    for (const root of [worker.worktreeRoot, integration.worktreeRoot]) {
      const head = await git(["rev-parse", "HEAD"], root);
      assert.equal(head, capture.baseCommit, `${root} should be at the base commit`);
      const gitDir = await git(["rev-parse", "--absolute-git-dir"], root);
      const commondir = await readFile(join(gitDir, "commondir"), "utf8");
      assert.notEqual(commondir.trim(), "", `${root} should publish a non-empty commondir`);
    }
    const registrations = await gitInRepo(["worktree", "list", "--porcelain"], capture.repositoryPath);
    assert.ok(registrations.includes(worker.worktreeRoot));
    assert.ok(registrations.includes(integration.worktreeRoot));

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
    await removeWorktree(integration.worktreeRoot, capture.repositoryPath);
  } finally {
    delete gitWorktreeCoordinator.beforeOperation;
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Production administration boundary: queued cancellation ─────────────────

test("worktrees — administration boundary never admits a cancelled queued preparation", async () => {
  const artifactDir = await mkTmp("pi-wt-boundary-cancel-");
  const { capture } = await setupCapture(artifactDir);
  const entries: string[] = [];
  let releaseHolder!: () => void;
  const holderGate = new Promise<void>((resolveGate) => {
    releaseHolder = resolveGate;
  });
  let holderEntered!: () => void;
  const holderInside = new Promise<void>((resolveInside) => {
    holderEntered = resolveInside;
  });
  const cancelledRoot = join(capture.waveRoot, "workers", "task-cancelled");

  try {
    gitWorktreeCoordinator.beforeOperation = async (repoPath) => {
      entries.push(repoPath);
      if (entries.length === 1) {
        holderEntered();
        await holderGate;
      }
    };

    const holder = createWorkerWorktree(capture, "task-holder");
    await holderInside;

    const controller = new AbortController();
    const cancelled = createWorkerWorktree(capture, "task-cancelled", controller.signal);
    await nextTurn();
    controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.equal(entries.length, 1, "a cancelled queued preparation must not enter");
    await assert.rejects(
      stat(cancelledRoot),
      "a cancelled queued preparation must not create its worktree directory",
    );

    // The cancelled waiter neither wedges the lease nor consumes it.
    releaseHolder();
    const held = await holder;
    const after = await createWorkerWorktree(capture, "task-after");
    assert.equal(entries.length, 2, "a later preparation is admitted after the holder releases");
    const registrations = await gitInRepo(["worktree", "list", "--porcelain"], capture.repositoryPath);
    assert.ok(registrations.includes(held.worktreeRoot));
    assert.ok(registrations.includes(after.worktreeRoot));

    await removeWorktree(held.worktreeRoot, capture.repositoryPath);
    await removeWorktree(after.worktreeRoot, capture.repositoryPath);
  } finally {
    delete gitWorktreeCoordinator.beforeOperation;
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Production boundary: failed-creation cleanup precedes the follower ──────

test("worktrees — failed creation cleans up before the waiting preparation enters", async () => {
  const artifactDir = await mkTmp("pi-wt-boundary-cleanup-");
  const { capture } = await setupCapture(artifactDir);
  const failedRoot = join(capture.waveRoot, "workers", "task-failing");
  const entries: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolveGate) => {
    releaseFirst = resolveGate;
  });
  let firstEntered!: () => void;
  const firstInside = new Promise<void>((resolveInside) => {
    firstEntered = resolveInside;
  });
  let followerSawLeftovers: boolean | undefined;

  try {
    gitWorktreeCoordinator.beforeOperation = async (repoPath) => {
      entries.push(repoPath);
      if (entries.length === 1) {
        firstEntered();
        await firstGate;
        return;
      }
      // The follower only reaches the boundary after the failed creation's
      // cleanup has finished, so its registration and directory must be gone.
      const directoryLeft = await stat(failedRoot).then(() => true, () => false);
      const registrations = await gitInRepo(["worktree", "list", "--porcelain"], capture.repositoryPath);
      followerSawLeftovers = directoryLeft || registrations.includes(failedRoot);
    };

    // A capture whose base commit is not a Git object makes `git worktree add`
    // fail after the creation has acquired the lease.
    const failingCapture: WaveCaptureResult = {
      ...capture,
      baseCommit: "0".repeat(capture.baseCommit.length),
    };
    const failing = createWorkerWorktree(failingCapture, "task-failing");
    await firstInside;

    const follower = createWorkerWorktree(capture, "task-follower");
    await nextTurn();
    assert.equal(entries.length, 1, "the follower must wait for the failing preparation");

    releaseFirst();
    await assert.rejects(failing, "creation at an invalid base commit must fail");
    const followed = await follower;
    assert.equal(entries.length, 2, "the follower enters only after cleanup and release");
    assert.equal(
      followerSawLeftovers,
      false,
      "failed-creation cleanup must finish before the follower enters",
    );
    await assert.rejects(stat(failedRoot), "the failed creation must not leave its directory");
    assert.equal(
      await git(["rev-parse", "HEAD"], followed.worktreeRoot),
      capture.baseCommit,
      "the follower registration is complete",
    );

    await removeWorktree(followed.worktreeRoot, capture.repositoryPath);
  } finally {
    delete gitWorktreeCoordinator.beforeOperation;
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Production boundary: removal revalidates cleanliness after waiting ──────

test("worktrees — removal revalidates cleanliness after waiting and preserves ignored data", async () => {
  const artifactDir = await mkTmp("pi-wt-boundary-removal-");
  const { capture } = await setupCapture(artifactDir, async (dir) => {
    await writeFile(join(dir, ".gitignore"), "*.log\n", "utf8");
    await git(["add", ".gitignore"], dir);
    await git(["commit", "--quiet", "-m", "ignore logs"], dir);
  });
  const entries: string[] = [];
  let releaseHolder!: () => void;
  const holderGate = new Promise<void>((resolveGate) => {
    releaseHolder = resolveGate;
  });
  let holderEntered!: () => void;
  const holderInside = new Promise<void>((resolveInside) => {
    holderEntered = resolveInside;
  });

  try {
    const worker = await createWorkerWorktree(capture, "task-queued-removal");

    // Hold the repository's administration boundary with a real preparation,
    // then queue a removal behind it.
    gitWorktreeCoordinator.beforeOperation = async (repoPath) => {
      entries.push(repoPath);
      if (entries.length === 1) {
        holderEntered();
        await holderGate;
      }
    };
    const holder = createIntegrationWorktree(capture);
    await holderInside;

    const removal = removeWorktree(worker.worktreeRoot, capture.repositoryPath);
    await nextTurn();
    assert.equal(
      entries.length,
      1,
      "removal's cleanliness check must not run before the lease is granted",
    );

    // Recovery data in an ignored path appears while the removal waits. Git's
    // own non-force removal would delete it; the revalidation must refuse.
    await writeFile(join(worker.worktreeRoot, "recovery.log"), "retained\n", "utf8");
    releaseHolder();
    await assert.rejects(removal, /Refusing to remove dirty worktree/);
    assert.equal(
      await readFile(join(worker.worktreeRoot, "recovery.log"), "utf8"),
      "retained\n",
      "ignored recovery data must be preserved",
    );
    assert.ok(
      (await gitInRepo(["worktree", "list", "--porcelain"], capture.repositoryPath))
        .includes(worker.worktreeRoot),
      "the preserved worktree stays registered",
    );

    const integration = await holder;
    await rm(join(worker.worktreeRoot, "recovery.log"), { force: true });
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
    await removeWorktree(integration.worktreeRoot, capture.repositoryPath);
  } finally {
    delete gitWorktreeCoordinator.beforeOperation;
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("worktrees — removal revalidates cleanliness inside the lease, not before it", async () => {
  const artifactDir = await mkTmp("pi-wt-boundary-check-order-");
  const { capture } = await setupCapture(artifactDir, async (dir) => {
    await writeFile(join(dir, ".gitignore"), "*.log\n", "utf8");
    await git(["add", ".gitignore"], dir);
    await git(["commit", "--quiet", "-m", "ignore logs"], dir);
  });
  const worker = await createWorkerWorktree(capture, "task-check-order");
  const recoveryPath = join(worker.worktreeRoot, "recovery.log");
  let injected = false;

  try {
    // Recovery data appears while the removal holds the lease, at the boundary
    // between the lease grant and the leased operation. A removal that
    // revalidated cleanliness before waiting would already hold a stale clean
    // result and delete the ignored data; revalidating inside the lease refuses.
    gitWorktreeCoordinator.beforeOperation = async (repoPath) => {
      if (injected || repoPath !== capture.repositoryPath) return;
      injected = true;
      await writeFile(recoveryPath, "retained\n", "utf8");
    };

    await assert.rejects(
      removeWorktree(worker.worktreeRoot, capture.repositoryPath),
      /Refusing to remove dirty worktree/,
    );
    assert.equal(await readFile(recoveryPath, "utf8"), "retained\n", "ignored data must survive");
    assert.ok(
      (await gitInRepo(["worktree", "list", "--porcelain"], capture.repositoryPath))
        .includes(worker.worktreeRoot),
      "the refused removal must keep the worktree registered",
    );

    await rm(recoveryPath, { force: true });
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    delete gitWorktreeCoordinator.beforeOperation;
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: nested requested cwd ──────────────────────────────────────────────

test("worktrees — nested requested cwd is preserved", async () => {
  const artifactDir = await mkTmp("pi-wt-nested-");
  try {
    const sourceDir = await mkTmp("pi-wt-nested-src-");
    await git(["init", "--quiet"], sourceDir);
    await mkdir(join(sourceDir, "src", "lib"), { recursive: true });
    await writeFile(join(sourceDir, "src", "lib", "index.ts"), "export {};\n", "utf8");
    await writeFile(join(sourceDir, "package.json"), "{}\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    // Capture from a nested cwd.
    const capture = await captureWaveBase({
      cwd: join(sourceDir, "src", "lib"),
      maxSnapshotBytes: 1_000_000,
      waveId: "test-nested",
      artifactDir,
    });

    assert.equal(capture.discovery.relativeCwd, "src/lib");

    const worker = await createWorkerWorktree(capture, "task-nested");

    // Effective cwd should be under the worktree root with the relative path.
    assert.ok(worker.effectiveCwd.startsWith(worker.worktreeRoot));
    assert.ok(worker.effectiveCwd.endsWith("src/lib"));

    // The effective cwd directory should exist (created by createWorkerWorktree).
    const { stat } = await import("node:fs/promises");
    const cwdStat = await stat(worker.effectiveCwd);
    assert.ok(cwdStat.isDirectory());

    // Worktree is already clean (src/lib existed from checkout, not created by us).
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: integration worktree ──────────────────────────────────────────────

test("worktrees — integration worktree is separate from worker worktrees", async () => {
  const artifactDir = await mkTmp("pi-wt-integration-");
  try {
    const { capture } = await setupCapture(artifactDir);

    const worker = await createWorkerWorktree(capture, "task-1");
    const integration = await createIntegrationWorktree(capture);

    // Integration should be at a different path.
    assert.notEqual(worker.worktreeRoot, integration.worktreeRoot);
    assert.ok(integration.worktreeRoot.endsWith("integration"));

    // Both should be at the base commit.
    const workerHead = await git(["rev-parse", "HEAD"], worker.worktreeRoot);
    const intHead = await git(["rev-parse", "HEAD"], integration.worktreeRoot);
    assert.equal(workerHead, capture.baseCommit);
    assert.equal(intHead, capture.baseCommit);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
    await removeWorktree(integration.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: dirty removal refusal ─────────────────────────────────────────────

test("worktrees — dirty worktree removal is refused", async () => {
  const artifactDir = await mkTmp("pi-wt-dirty-");
  try {
    const { capture } = await setupCapture(artifactDir);

    const worker = await createWorkerWorktree(capture, "task-dirty");

    // Make the worktree dirty.
    await writeFile(join(worker.worktreeRoot, "dirty.txt"), "dirty\n", "utf8");

    const clean = await isWorktreeClean(worker.worktreeRoot);
    assert.equal(clean, false, "worktree should be dirty");

    // Removal should refuse.
    await assert.rejects(
      removeWorktree(worker.worktreeRoot, capture.repositoryPath),
      /Refusing to remove dirty worktree/,
    );

    // Worktree should still exist.
    const { stat } = await import("node:fs/promises");
    const s = await stat(worker.worktreeRoot);
    assert.ok(s.isDirectory(), "worktree should still exist after refused removal");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: clean removal ─────────────────────────────────────────────────────

test("worktrees — clean worktree is removed successfully", async () => {
  const artifactDir = await mkTmp("pi-wt-clean-");
  try {
    const { capture } = await setupCapture(artifactDir);

    const worker = await createWorkerWorktree(capture, "task-clean");

    const clean = await isWorktreeClean(worker.worktreeRoot);
    assert.equal(clean, true, "worktree should be clean");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);

    // Worktree should be gone.
    const { access } = await import("node:fs/promises");
    await assert.rejects(
      access(worker.worktreeRoot),
      { code: "ENOENT" },
      "worktree should be removed",
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: ignored files make worktree dirty ─────────────────────────────────

test("worktrees — ignored files are detected as dirty", async () => {
  const artifactDir = await mkTmp("pi-wt-ignored-");
  try {
    const sourceDir = await mkTmp("pi-wt-ignored-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
    await writeFile(join(sourceDir, ".gitignore"), "*.log\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-ignored",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-ignored");

    // Worktree should be clean initially.
    assert.equal(await isWorktreeClean(worker.worktreeRoot), true);

    // Create an ignored file.
    await writeFile(join(worker.worktreeRoot, "debug.log"), "ignored\n", "utf8");

    // Worktree should now be dirty (ignored file detected).
    assert.equal(await isWorktreeClean(worker.worktreeRoot), false, "ignored file should make worktree dirty");

    // Removal should refuse.
    await assert.rejects(
      removeWorktree(worker.worktreeRoot, capture.repositoryPath),
      /Refusing to remove dirty worktree/,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: invalid IDs ───────────────────────────────────────────────────────

test("worktrees — invalid task IDs are rejected", async () => {
  const artifactDir = await mkTmp("pi-wt-invalid-");
  try {
    const { capture } = await setupCapture(artifactDir);

    // Slash in task ID.
    await assert.rejects(
      createWorkerWorktree(capture, "bad/task"),
      /Invalid taskId/,
    );

    // Dot-dot in task ID.
    await assert.rejects(
      createWorkerWorktree(capture, ".."),
      /Invalid taskId/,
    );

    // Empty task ID.
    await assert.rejects(
      createWorkerWorktree(capture, ""),
      /Invalid taskId/,
    );

    // Git-forbidden characters.
    await assert.rejects(
      createWorkerWorktree(capture, "a~b"),
      /Invalid taskId/,
    );

    await assert.rejects(
      createWorkerWorktree(capture, "a:b"),
      /Invalid taskId/,
    );

    await assert.rejects(
      createWorkerWorktree(capture, ".hidden"),
      /Invalid taskId/,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: commit pinning ────────────────────────────────────────────────────

test("worktrees — commit pinning verifies object type", async () => {
  const artifactDir = await mkTmp("pi-wt-pin-");
  try {
    const { capture } = await setupCapture(artifactDir);

    // Pin the base commit (should succeed).
    const ref = await pinCommit(capture, capture.baseCommit, { type: "worker", taskId: "task-pin" });
    assert.equal(ref, "refs/pi-review-gate/waves/test-wave/workers/task-pin");

    // Verify the ref is set.
    const pinnedSha = await gitInRepo(["rev-parse", ref], capture.repositoryPath);
    assert.equal(pinnedSha, capture.baseCommit);

    // Pinning a non-commit object should fail.
    // Get a blob SHA from the tree.
    const treeOutput = await gitInRepo(
      ["ls-tree", "-r", "--name-only", capture.baseCommit],
      capture.repositoryPath,
    );
    const firstFile = treeOutput.split("\n")[0];
    const blobSha = await gitInRepo(
      ["rev-parse", `${capture.baseCommit}:${firstFile}`],
      capture.repositoryPath,
    );

    await assert.rejects(
      pinCommit(capture, blobSha, { type: "worker", taskId: "task-blob" }),
      /not a commit/,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: pinned commit survival after worktree removal ─────────────────────

test("worktrees — pinned commit survives worktree removal", async () => {
  const artifactDir = await mkTmp("pi-wt-survival-");
  try {
    const { capture } = await setupCapture(artifactDir);

    const worker = await createWorkerWorktree(capture, "task-survival");

    // Create a new commit in the worktree.
    await writeFile(join(worker.worktreeRoot, "new-file.txt"), "new\n", "utf8");
    await git(["add", "."], worker.worktreeRoot);
    await git(["commit", "--quiet", "-m", "worker commit"], worker.worktreeRoot);
    const newCommit = await git(["rev-parse", "HEAD"], worker.worktreeRoot);

    // Pin the new commit.
    const ref = await pinCommit(capture, newCommit, { type: "worker", taskId: "task-survival" });

    // Make the worktree clean before removal.
    await git(["reset", "--hard", "HEAD"], worker.worktreeRoot);

    // Remove the worktree.
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);

    // The pinned commit should still be reachable.
    const pinnedSha = await gitInRepo(["rev-parse", ref], capture.repositoryPath);
    assert.equal(pinnedSha, newCommit, "pinned commit should survive worktree removal");

    // Verify the commit object still exists.
    const objectType = await gitInRepo(["cat-file", "-t", newCommit], capture.repositoryPath);
    assert.equal(objectType, "commit", "commit object should still exist");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: ref name helpers ──────────────────────────────────────────────────

test("worktrees — ref name helpers produce correct paths", async () => {
  assert.equal(
    workerRefName("wave-1", "task-42"),
    "refs/pi-review-gate/waves/wave-1/workers/task-42",
  );
  assert.equal(
    integrationRefName("wave-1"),
    "refs/pi-review-gate/waves/wave-1/integrated",
  );
});

// ── Test: integration pinning ───────────────────────────────────────────────

test("worktrees — integration commit pinning", async () => {
  const artifactDir = await mkTmp("pi-wt-int-pin-");
  try {
    const { capture } = await setupCapture(artifactDir);

    const ref = await pinCommit(capture, capture.baseCommit, { type: "integration" });
    assert.equal(ref, "refs/pi-review-gate/waves/test-wave/integrated");

    const pinnedSha = await gitInRepo(["rev-parse", ref], capture.repositoryPath);
    assert.equal(pinnedSha, capture.baseCommit);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: worker ref rejects invalid taskId ─────────────────────────────────

test("worktrees — pinCommit rejects invalid taskId for worker", async () => {
  const artifactDir = await mkTmp("pi-wt-pin-invalid-");
  try {
    const { capture } = await setupCapture(artifactDir);

    await assert.rejects(
      pinCommit(capture, capture.baseCommit, { type: "worker", taskId: "bad/task" }),
      /Invalid taskId/,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: source workspace untouched ────────────────────────────────────────

test("worktrees — source workspace and Git metadata are untouched", async () => {
  const artifactDir = await mkTmp("pi-wt-untouched-");
  try {
    const { sourceDir, capture } = await setupCapture(artifactDir);

    // Record source state.
    const beforeHead = await git(["rev-parse", "HEAD"], sourceDir);
    const beforeStatus = await git(["status", "--porcelain"], sourceDir);

    // Create and remove a worktree.
    const worker = await createWorkerWorktree(capture, "task-untouched");
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);

    // Verify source unchanged.
    const afterHead = await git(["rev-parse", "HEAD"], sourceDir);
    const afterStatus = await git(["status", "--porcelain"], sourceDir);
    assert.equal(afterHead, beforeHead, "source HEAD should be unchanged");
    assert.equal(afterStatus, beforeStatus, "source status should be unchanged");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: worktree paths stay under wave root ───────────────────────────────

test("worktrees — worktree paths stay under wave root", async () => {
  const artifactDir = await mkTmp("pi-wt-containment-");
  try {
    const { capture } = await setupCapture(artifactDir);

    const worker = await createWorkerWorktree(capture, "task-contain");
    assert.ok(worker.worktreeRoot.startsWith(capture.waveRoot));
    assert.ok(worker.effectiveCwd.startsWith(capture.waveRoot));

    const integration = await createIntegrationWorktree(capture);
    assert.ok(integration.worktreeRoot.startsWith(capture.waveRoot));
    assert.ok(integration.effectiveCwd.startsWith(capture.waveRoot));

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
    await removeWorktree(integration.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: ref helpers reject invalid waveId ─────────────────────────────────

test("worktrees — ref helpers reject invalid waveId", async () => {
  // workerRefName rejects invalid waveId.
  assert.throws(
    () => workerRefName("bad/wave", "task-1"),
    /Invalid waveId/,
  );

  // integrationRefName rejects invalid waveId.
  assert.throws(
    () => integrationRefName(".."),
    /Invalid waveId/,
  );
});

// ── Test: nested effective cwd created for empty directory ──────────────────

test("worktrees — nested effective cwd created when no files tracked there", async () => {
  const artifactDir = await mkTmp("pi-wt-empty-cwd-");
  try {
    const sourceDir = await mkTmp("pi-wt-empty-cwd-src-");
    await git(["init", "--quiet"], sourceDir);
    // Create a file at the root only — the nested dir has no tracked files.
    await writeFile(join(sourceDir, "root.txt"), "root\n", "utf8");
    await mkdir(join(sourceDir, "empty", "nested"), { recursive: true });
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    // Capture from the empty nested directory.
    const capture = await captureWaveBase({
      cwd: join(sourceDir, "empty", "nested"),
      maxSnapshotBytes: 1_000_000,
      waveId: "test-empty-cwd",
      artifactDir,
    });

    assert.equal(capture.discovery.relativeCwd, "empty/nested");

    const worker = await createWorkerWorktree(capture, "task-empty-cwd");

    // The effective cwd should exist even though no files are tracked there.
    const { stat } = await import("node:fs/promises");
    const cwdStat = await stat(worker.effectiveCwd);
    assert.ok(cwdStat.isDirectory(), "effective cwd should exist");

    // Worktree should be clean (empty dir doesn't show in git status).
    const clean = await isWorktreeClean(worker.worktreeRoot);
    assert.equal(clean, true, "worktree should be clean");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Security: immutable pinCommit ───────────────────────────────────────────

test("worktrees — pinCommit is idempotent for the same SHA", async () => {
  const artifactDir = await mkTmp("pi-wt-pin-idem-");
  try {
    const { capture } = await setupCapture(artifactDir);

    // Pin the base commit.
    const ref1 = await pinCommit(capture, capture.baseCommit, { type: "worker", taskId: "task-idem" });

    // Pin the same SHA again — should succeed (idempotent).
    const ref2 = await pinCommit(capture, capture.baseCommit, { type: "worker", taskId: "task-idem" });

    assert.equal(ref1, ref2, "ref names should be the same");

    // Verify the ref still points to the same SHA.
    const pinnedSha = await gitInRepo(["rev-parse", ref1], capture.repositoryPath);
    assert.equal(pinnedSha, capture.baseCommit, "ref should still point to original SHA");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("worktrees — pinCommit refuses replacing with different SHA", async () => {
  const artifactDir = await mkTmp("pi-wt-pin-replace-");
  try {
    const { capture } = await setupCapture(artifactDir);

    // Pin the base commit.
    const ref = await pinCommit(capture, capture.baseCommit, { type: "worker", taskId: "task-replace" });

    // Create a different commit.
    const worker = await createWorkerWorktree(capture, "task-diff");
    await writeFile(join(worker.worktreeRoot, "new.txt"), "new\n", "utf8");
    await git(["add", "."], worker.worktreeRoot);
    await git(["commit", "--quiet", "-m", "different commit"], worker.worktreeRoot);
    const differentCommit = await git(["rev-parse", "HEAD"], worker.worktreeRoot);

    // Attempting to pin a different SHA to the same ref should fail.
    await assert.rejects(
      pinCommit(capture, differentCommit, { type: "worker", taskId: "task-replace" }),
      /Refusing to replace stable ref/,
    );

    // Verify the original ref is unchanged.
    const pinnedSha = await gitInRepo(["rev-parse", ref], capture.repositoryPath);
    assert.equal(pinnedSha, capture.baseCommit, "ref should still point to original SHA");

    // Reset worktree to clean state.
    await git(["reset", "--hard", capture.baseCommit], worker.worktreeRoot);
    await rm(join(worker.worktreeRoot, "new.txt"), { force: true });
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("worktrees — integration pinCommit is immutable", async () => {
  const artifactDir = await mkTmp("pi-wt-int-pin-immutable-");
  try {
    const { capture } = await setupCapture(artifactDir);

    // Pin the integration commit.
    const ref = await pinCommit(capture, capture.baseCommit, { type: "integration" });
    assert.equal(ref, "refs/pi-review-gate/waves/test-wave/integrated");

    // Create a different commit.
    const worker = await createWorkerWorktree(capture, "task-int-diff");
    await writeFile(join(worker.worktreeRoot, "new.txt"), "new\n", "utf8");
    await git(["add", "."], worker.worktreeRoot);
    await git(["commit", "--quiet", "-m", "different commit"], worker.worktreeRoot);
    const differentCommit = await git(["rev-parse", "HEAD"], worker.worktreeRoot);

    // Attempting to pin a different SHA to the integration ref should fail.
    await assert.rejects(
      pinCommit(capture, differentCommit, { type: "integration" }),
      /Refusing to replace stable ref/,
    );

    // Verify the original ref is unchanged.
    const pinnedSha = await gitInRepo(["rev-parse", ref], capture.repositoryPath);
    assert.equal(pinnedSha, capture.baseCommit, "integration ref should still point to original SHA");

    // Reset worktree to clean state.
    await git(["reset", "--hard", capture.baseCommit], worker.worktreeRoot);
    await rm(join(worker.worktreeRoot, "new.txt"), { force: true });
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
