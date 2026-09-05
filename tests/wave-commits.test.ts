import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureWaveBase, WaveCaptureResult } from "../src/execution/wave-repository";
import {
  createWorkerWorktree,
  removeWorktree,
} from "../src/execution/wave-worktrees";
import {
  normalizeCandidate,
  candidateRefName,
  buildCandidateReviewPatch,
  createCommitWithParent,
  CandidateCommit,
} from "../src/execution/wave-commits";

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

// Helper: create a committed source repo and capture it.
async function setupCapture(
  artifactDir: string,
  extraSetup?: (dir: string) => Promise<void>,
): Promise<{ sourceDir: string; capture: WaveCaptureResult }> {
  const sourceDir = await mkTmp("pi-wc-src-");
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

// ── Test: modified file changes ──────────────────────────────────────────────

test("wave-commits — modified file changes are captured", async () => {
  const artifactDir = await mkTmp("pi-wc-mod-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-mod");

    // Modify an existing file.
    await writeFile(join(worker.worktreeRoot, "app.js"), "console.log('modified');\n", "utf8");

    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-mod", "Modify app.js");

    // Candidate should differ from base.
    assert.equal(result.differsFromBase, true);

    // Verify the candidate commit has the base as sole parent.
    const parents = await git(["rev-parse", `${result.commitSha}^@`], worker.worktreeRoot);
    const parentList = parents.split("\n").filter(Boolean);
    assert.equal(parentList.length, 1, "candidate should have exactly one parent");
    assert.equal(parentList[0], capture.baseCommit, "sole parent should be wave base");

    // Verify the modified file content is in the candidate tree.
    const content = await git(["show", `${result.commitSha}:app.js`], worker.worktreeRoot);
    assert.ok(content.includes("console.log('modified')"), "modified content should be in candidate tree");

    // Worktree should be clean after normalization.
    const status = await git(["status", "--porcelain"], worker.worktreeRoot);
    assert.equal(status, "", "worktree should be clean after normalization");

    // HEAD should be at the candidate commit.
    const head = await git(["rev-parse", "HEAD"], worker.worktreeRoot);
    assert.equal(head, result.commitSha);

    // Candidate ref should be pinned.
    const refSha = await gitInRepo(["rev-parse", result.candidateRef], capture.repositoryPath);
    assert.equal(refSha, result.commitSha);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: new file changes ───────────────────────────────────────────────────

test("wave-commits — new untracked files are captured", async () => {
  const artifactDir = await mkTmp("pi-wc-new-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-new");

    // Add a new file.
    await writeFile(join(worker.worktreeRoot, "new-file.txt"), "new content\n", "utf8");

    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-new", "Add new file");

    assert.equal(result.differsFromBase, true);

    // Verify the new file is in the candidate tree.
    const content = await git(["show", `${result.commitSha}:new-file.txt`], worker.worktreeRoot);
    assert.ok(content.includes("new content"), "new content should be in candidate tree");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: deleted file changes ───────────────────────────────────────────────

test("wave-commits — deleted files are captured", async () => {
  const artifactDir = await mkTmp("pi-wc-del-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-del");

    // Delete an existing file.
    await rm(join(worker.worktreeRoot, "app.js"));

    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-del", "Delete app.js");

    assert.equal(result.differsFromBase, true);

    // Verify the file is not in the candidate tree.
    try {
      await git(["show", `${result.commitSha}:app.js`], worker.worktreeRoot);
      assert.fail("app.js should not exist in candidate tree");
    } catch {
      // Expected — file was deleted.
    }

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: mode changes ───────────────────────────────────────────────────────

test("wave-commits — mode changes are captured", async () => {
  const artifactDir = await mkTmp("pi-wc-mode-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-mode");

    // Change file mode to executable.
    await fs.chmod(join(worker.worktreeRoot, "app.js"), 0o755);

    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-mode", "Make app.js executable");

    assert.equal(result.differsFromBase, true);

    // Verify the mode in the candidate tree.
    const treeInfo = await git(["ls-tree", result.commitSha, "app.js"], worker.worktreeRoot);
    assert.ok(treeInfo.startsWith("100755"), "app.js should be executable in candidate tree");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: symlink changes ────────────────────────────────────────────────────

test("wave-commits — symlink changes are captured", async () => {
  const artifactDir = await mkTmp("pi-wc-symlink-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-symlink");

    // Create a new symlink.
    await symlink("app.js", join(worker.worktreeRoot, "link-to-app"));

    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-symlink", "Add symlink");

    assert.equal(result.differsFromBase, true);

    // Verify the symlink is in the candidate tree.
    const treeInfo = await git(["ls-tree", result.commitSha, "link-to-app"], worker.worktreeRoot);
    assert.ok(treeInfo.startsWith("120000"), "link-to-app should be a symlink in candidate tree");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: executor-created commits are flattened ─────────────────────────────

test("wave-commits — executor-created commits are flattened", async () => {
  const artifactDir = await mkTmp("pi-wc-flatten-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-flatten");

    // Simulate executor creating commits.
    await writeFile(join(worker.worktreeRoot, "step1.txt"), "step1\n", "utf8");
    await git(["add", "."], worker.worktreeRoot);
    await git(["commit", "--quiet", "-m", "executor step 1"], worker.worktreeRoot);

    await writeFile(join(worker.worktreeRoot, "step2.txt"), "step2\n", "utf8");
    await git(["add", "."], worker.worktreeRoot);
    await git(["commit", "--quiet", "-m", "executor step 2"], worker.worktreeRoot);

    // Verify executor created commits on top of base.
    const executorHead = await git(["rev-parse", "HEAD"], worker.worktreeRoot);
    assert.notEqual(executorHead, capture.baseCommit, "executor should have commits on top");

    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-flatten", "Flatten executor commits");

    // Candidate should have base as sole parent, not the executor's last commit.
    const parents = await git(["rev-parse", `${result.commitSha}^@`], worker.worktreeRoot);
    const parentList = parents.split("\n").filter(Boolean);
    assert.equal(parentList.length, 1, "candidate should have exactly one parent");
    assert.equal(parentList[0], capture.baseCommit, "sole parent should be wave base, not executor commit");

    // Both executor files should be in the candidate tree.
    const step1 = await git(["show", `${result.commitSha}:step1.txt`], worker.worktreeRoot);
    assert.ok(step1.includes("step1"), "step1 should be in candidate tree");
    const step2 = await git(["show", `${result.commitSha}:step2.txt`], worker.worktreeRoot);
    assert.ok(step2.includes("step2"), "step2 should be in candidate tree");

    // Source repo should not have the executor commits.
    const sourceRefs = await gitInRepo(["for-each-ref", "--format=%(refname:short)"], capture.repositoryPath);
    assert.ok(!sourceRefs.includes("executor"), "source repo should not have executor commits");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: correction re-normalization replaces candidate ref ─────────────────

test("wave-commits — re-normalization replaces candidate ref without stacking", async () => {
  const artifactDir = await mkTmp("pi-wc-re-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-re");

    // First normalization.
    await writeFile(join(worker.worktreeRoot, "v1.txt"), "v1\n", "utf8");
    const result1 = await normalizeCandidate(capture, worker.worktreeRoot, "task-re", "First version");

    // Make additional changes (simulating correction).
    await writeFile(join(worker.worktreeRoot, "v2.txt"), "v2\n", "utf8");
    await rm(join(worker.worktreeRoot, "v1.txt"));

    // Re-normalize.
    const result2 = await normalizeCandidate(capture, worker.worktreeRoot, "task-re", "Corrected version");

    // New candidate should be different from the first.
    assert.notEqual(result2.commitSha, result1.commitSha, "re-normalization should produce new commit");

    // Candidate ref should point to the new commit.
    const refSha = await gitInRepo(["rev-parse", result2.candidateRef], capture.repositoryPath);
    assert.equal(refSha, result2.commitSha, "candidate ref should point to new commit");

    // New candidate should still have base as sole parent.
    const parents = await git(["rev-parse", `${result2.commitSha}^@`], worker.worktreeRoot);
    const parentList = parents.split("\n").filter(Boolean);
    assert.equal(parentList.length, 1, "re-normalized candidate should have exactly one parent");
    assert.equal(parentList[0], capture.baseCommit, "sole parent should be wave base");

    // v2 should be in tree, v1 should not.
    const v2Content = await git(["show", `${result2.commitSha}:v2.txt`], worker.worktreeRoot);
    assert.ok(v2Content.includes("v2"), "v2 should be in candidate tree");
    try {
      await git(["show", `${result2.commitSha}:v1.txt`], worker.worktreeRoot);
      assert.fail("v1.txt should not exist in re-normalized candidate");
    } catch {
      // Expected.
    }

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: ignored files are excluded ─────────────────────────────────────────

test("wave-commits — ignored files are excluded from candidate", async () => {
  const artifactDir = await mkTmp("pi-wc-ignored-");
  try {
    const sourceDir = await mkTmp("pi-wc-ignored-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
    await writeFile(join(sourceDir, ".gitignore"), "*.log\ndist/\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-ignored",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-ignored");

    // Create an ignored file and a non-ignored file.
    await writeFile(join(worker.worktreeRoot, "debug.log"), "ignored\n", "utf8");
    await writeFile(join(worker.worktreeRoot, "src.ts"), "code\n", "utf8");

    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-ignored", "Add code");

    // src.ts should be in the candidate tree.
    const srcContent = await git(["show", `${result.commitSha}:src.ts`], worker.worktreeRoot);
    assert.ok(srcContent.includes("code"), "src.ts should be in candidate tree");

    // debug.log should NOT be in the candidate tree.
    try {
      await git(["show", `${result.commitSha}:debug.log`], worker.worktreeRoot);
      assert.fail("debug.log should not be in candidate tree");
    } catch {
      // Expected — ignored file excluded.
    }

    // Worktree should be clean (ignored files don't count).
    const status = await git(["status", "--porcelain"], worker.worktreeRoot);
    assert.equal(status, "", "worktree should be clean (ignored files excluded)");

    // Remove the ignored file before worktree removal (it makes worktree dirty).
    await rm(join(worker.worktreeRoot, "debug.log"), { force: true });
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: sole base parent ───────────────────────────────────────────────────

test("wave-commits — candidate has exactly the wave base as sole parent", async () => {
  const artifactDir = await mkTmp("pi-wc-parent-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-parent");

    await writeFile(join(worker.worktreeRoot, "change.txt"), "change\n", "utf8");

    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-parent", "Change");

    // Verify parent count.
    const parentCount = await git(["cat-file", "-p", result.commitSha], worker.worktreeRoot);
    const parentLines = parentCount.split("\n").filter((l) => l.startsWith("parent "));
    assert.equal(parentLines.length, 1, "candidate should have exactly one parent line");
    assert.ok(parentLines[0].includes(capture.baseCommit), "parent should be wave base");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: trailers in commit message ─────────────────────────────────────────

test("wave-commits — commit message includes Wave-Id and Task-Id trailers", async () => {
  const artifactDir = await mkTmp("pi-wc-trailers-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-trailers");

    await writeFile(join(worker.worktreeRoot, "trailers.txt"), "trailers\n", "utf8");

    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-trailers", "Test trailers");

    // Get the commit message.
    const message = await git(["log", "-1", "--format=%B", result.commitSha], worker.worktreeRoot);

    assert.ok(message.includes("Test trailers"), "message should contain title");
    assert.ok(message.includes("Wave-Id: test-wave"), "message should contain Wave-Id trailer");
    assert.ok(message.includes("Task-Id: task-trailers"), "message should contain Task-Id trailer");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: foreign worktree refusal ───────────────────────────────────────────

test("wave-commits — foreign worktree is refused before destructive reset", async () => {
  const artifactDir = await mkTmp("pi-wc-foreign-");
  try {
    const { capture } = await setupCapture(artifactDir);

    // Create a completely separate repo.
    const foreignDir = await mkTmp("pi-wc-foreign-repo-");
    await git(["init", "--quiet"], foreignDir);
    await writeFile(join(foreignDir, "foreign.txt"), "foreign\n", "utf8");
    await git(["add", "."], foreignDir);
    await git(["commit", "--quiet", "-m", "foreign init"], foreignDir);

    // Attempting to normalize the foreign repo should fail.
    // It may be refused for not being detached HEAD or for wrong common dir.
    await assert.rejects(
      normalizeCandidate(capture, foreignDir, "task-foreign", "Foreign"),
      /does not belong to the private repository|not on a detached HEAD/,
    );

    // Foreign repo should be untouched.
    const foreignHead = await git(["rev-parse", "HEAD"], foreignDir);
    assert.ok(foreignHead, "foreign repo should still have HEAD");

    await rm(foreignDir, { recursive: true, force: true });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: nested foreign repo under wave root is refused ─────────────────────

test("wave-commits — nested foreign repo under wave root is refused", async () => {
  const artifactDir = await mkTmp("pi-wc-nested-foreign-");
  try {
    const { capture } = await setupCapture(artifactDir);

    // Create a temporary source repo to populate the foreign bare repo.
    const tempSource = await mkTmp("pi-wc-nested-foreign-src-");
    await git(["init", "--quiet"], tempSource);
    await writeFile(join(tempSource, "foreign.txt"), "foreign\n", "utf8");
    await git(["add", "."], tempSource);
    await git(["commit", "--quiet", "-m", "foreign init"], tempSource);

    // Create a foreign bare repo nested under the wave root.
    const nestedForeignRepo = join(capture.waveRoot, "foreign-repo.git");
    await fs.mkdir(nestedForeignRepo, { recursive: true });
    await execFileAsync("git", ["init", "--bare", "--quiet"], {
      cwd: nestedForeignRepo,
      env: { ...process.env, ...GIT_ENV },
    });
    // Push the source commit into the foreign bare repo.
    await execFileAsync("git", ["push", nestedForeignRepo, "HEAD:refs/heads/main"], {
      cwd: tempSource,
      env: { ...process.env, ...GIT_ENV },
    });

    // Create a detached worktree from the foreign bare repo.
    const nestedForeignDir = join(capture.waveRoot, "foreign-wt");
    await execFileAsync("git", ["worktree", "add", "--detach", nestedForeignDir, "main"], {
      cwd: nestedForeignRepo,
      env: { ...process.env, ...GIT_ENV },
    });

    // Attempting to normalize the nested foreign worktree should fail.
    await assert.rejects(
      normalizeCandidate(capture, nestedForeignDir, "task-nested-foreign", "Nested foreign"),
      /does not belong to the private repository/,
    );

    // Clean up.
    await execFileAsync("git", ["worktree", "remove", "--force", nestedForeignDir], {
      cwd: nestedForeignRepo,
      env: { ...process.env, ...GIT_ENV },
    }).catch(() => {});
    await rm(nestedForeignDir, { recursive: true, force: true });
    await rm(nestedForeignRepo, { recursive: true, force: true });
    await rm(tempSource, { recursive: true, force: true });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: wrong-base worktree is refused ─────────────────────────────────────

test("wave-commits — wrong-base worktree is refused", async () => {
  const artifactDir = await mkTmp("pi-wc-wrong-base-");
  try {
    const { capture } = await setupCapture(artifactDir);

    // Create a different capture (different base).
    const otherSourceDir = await mkTmp("pi-wc-wrong-base-src-");
    await git(["init", "--quiet"], otherSourceDir);
    await writeFile(join(otherSourceDir, "other.txt"), "other\n", "utf8");
    await git(["add", "."], otherSourceDir);
    await git(["commit", "--quiet", "-m", "other init"], otherSourceDir);

    const otherCapture = await captureWaveBase({
      cwd: otherSourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "other-wave",
      artifactDir,
    });

    const otherWorker = await createWorkerWorktree(otherCapture, "task-other");

    // Attempting to normalize with the wrong capture should fail.
    await assert.rejects(
      normalizeCandidate(capture, otherWorker.worktreeRoot, "task-other", "Wrong base"),
      /does not belong to the private repository/,
    );

    await removeWorktree(otherWorker.worktreeRoot, otherCapture.repositoryPath);
    await rm(otherSourceDir, { recursive: true, force: true });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: title with newlines is rejected ────────────────────────────────────

test("wave-commits — title with newlines is rejected", async () => {
  const artifactDir = await mkTmp("pi-wc-title-nl-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-title-nl");

    await writeFile(join(worker.worktreeRoot, "x.txt"), "x\n", "utf8");

    // Title with newline.
    await assert.rejects(
      normalizeCandidate(capture, worker.worktreeRoot, "task-title-nl", "Title\nwith newline"),
      /Invalid title.*newlines/,
    );

    // Title with carriage return.
    await assert.rejects(
      normalizeCandidate(capture, worker.worktreeRoot, "task-title-nl", "Title\rwith cr"),
      /Invalid title.*newlines/,
    );

    // Reset worktree to clean state before removal.
    await git(["reset", "--hard", "HEAD"], worker.worktreeRoot);
    await rm(join(worker.worktreeRoot, "x.txt"), { force: true });
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: candidate ref name format ──────────────────────────────────────────

test("wave-commits — candidate ref name format", () => {
  assert.equal(
    candidateRefName("wave-1", "task-42"),
    "refs/pi-review-gate/waves/wave-1/candidates/task-42",
  );
});

// ── Test: candidate ref rejects invalid IDs ──────────────────────────────────

test("wave-commits — candidate ref rejects invalid IDs", () => {
  assert.throws(
    () => candidateRefName("bad/wave", "task-1"),
    /Invalid waveId/,
  );
  assert.throws(
    () => candidateRefName("wave-1", "bad/task"),
    /Invalid taskId/,
  );
});

// ── Test: no changes produces candidate identical to base tree ───────────────

test("wave-commits — no changes produces candidate with same tree as base", async () => {
  const artifactDir = await mkTmp("pi-wc-noc-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-noc");

    // Don't make any changes.
    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-noc", "No changes");

    assert.equal(result.differsFromBase, false, "no changes should produce same tree as base");

    // Tree should match base tree.
    const baseTree = await git(["rev-parse", `${capture.baseCommit}^{tree}`], worker.worktreeRoot);
    assert.equal(result.treeSha, baseTree, "tree should match base tree");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: invalid taskId rejected ────────────────────────────────────────────

test("wave-commits — invalid taskId is rejected", async () => {
  const artifactDir = await mkTmp("pi-wc-invalid-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-valid");

    await writeFile(join(worker.worktreeRoot, "x.txt"), "x\n", "utf8");

    // Slash in taskId.
    await assert.rejects(
      normalizeCandidate(capture, worker.worktreeRoot, "bad/task", "Invalid"),
      /Invalid taskId/,
    );

    // Empty taskId.
    await assert.rejects(
      normalizeCandidate(capture, worker.worktreeRoot, "", "Invalid"),
      /Invalid taskId/,
    );

    // Reset worktree to clean state before removal.
    await git(["reset", "--hard", "HEAD"], worker.worktreeRoot);
    await rm(join(worker.worktreeRoot, "x.txt"), { force: true });
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: invalid title rejected ─────────────────────────────────────────────

test("wave-commits — invalid title is rejected", async () => {
  const artifactDir = await mkTmp("pi-wc-title-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-title");

    await writeFile(join(worker.worktreeRoot, "x.txt"), "x\n", "utf8");

    // Empty title.
    await assert.rejects(
      normalizeCandidate(capture, worker.worktreeRoot, "task-title", ""),
      /Invalid title/,
    );

    // Reset worktree to clean state before removal.
    await git(["reset", "--hard", "HEAD"], worker.worktreeRoot);
    await rm(join(worker.worktreeRoot, "x.txt"), { force: true });
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: return type includes all fields ────────────────────────────────────

test("wave-commits — return type includes all required fields", async () => {
  const artifactDir = await mkTmp("pi-wc-rt-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-rt");

    await writeFile(join(worker.worktreeRoot, "x.txt"), "x\n", "utf8");

    const result: CandidateCommit = await normalizeCandidate(
      capture,
      worker.worktreeRoot,
      "task-rt",
      "Return type test",
    );

    assert.ok(typeof result.commitSha === "string" && result.commitSha.length === 40);
    assert.ok(typeof result.treeSha === "string" && result.treeSha.length === 40);
    assert.ok(typeof result.candidateRef === "string" && result.candidateRef.startsWith("refs/"));
    assert.ok(typeof result.differsFromBase === "boolean");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// Import fs for chmod
import * as fs from "node:fs/promises";

// ── Test: buildCandidateReviewPatch — basic text changes ─────────────────────

test("wave-commits — buildCandidateReviewPatch returns correct paths and patch", async () => {
  const artifactDir = await mkTmp("pi-wc-patch-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-patch");

    // Modify a file.
    await writeFile(join(worker.worktreeRoot, "app.js"), "console.log('modified');\n", "utf8");
    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-patch", "Modify app.js");

    const patch = await buildCandidateReviewPatch(
      capture.repositoryPath,
      capture.baseCommit,
      result.commitSha,
      1_000_000,
    );

    assert.ok(patch.changedPaths.includes("app.js"), "changedPaths should include app.js");
    assert.ok(patch.patch.includes("console.log('modified')"), "patch should contain modified content");
    assert.equal(patch.truncated, false, "patch should not be truncated");
    assert.equal(patch.omitted.length, 0, "no omitted paths");
    assert.ok(patch.totalBytes > 0, "totalBytes should be positive");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: buildCandidateReviewPatch — mode-only changes ──────────────────────

test("wave-commits — buildCandidateReviewPatch captures mode-only changes", async () => {
  const artifactDir = await mkTmp("pi-wc-patch-mode-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-patch-mode");

    // Change file mode to executable (content unchanged).
    await fs.chmod(join(worker.worktreeRoot, "app.js"), 0o755);
    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-patch-mode", "Make executable");

    const patch = await buildCandidateReviewPatch(
      capture.repositoryPath,
      capture.baseCommit,
      result.commitSha,
      1_000_000,
    );

    assert.ok(patch.changedPaths.includes("app.js"), "changedPaths should include app.js for mode change");
    assert.ok(patch.patch.includes("100644") || patch.patch.includes("100755"), "patch should contain mode info");
    assert.equal(patch.truncated, false);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: buildCandidateReviewPatch — binary changes ─────────────────────────

test("wave-commits — buildCandidateReviewPatch captures binary changes", async () => {
  const artifactDir = await mkTmp("pi-wc-patch-bin-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-patch-bin");

    // Add a binary file.
    await writeFile(join(worker.worktreeRoot, "data.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-patch-bin", "Add binary");

    const patch = await buildCandidateReviewPatch(
      capture.repositoryPath,
      capture.baseCommit,
      result.commitSha,
      1_000_000,
    );

    assert.ok(patch.changedPaths.includes("data.bin"), "changedPaths should include data.bin");
    // Binary patches contain Git binary diff markers or binary content.
    assert.ok(
      patch.patch.includes("GIT binary patch") || patch.patch.length > 0,
      "patch should contain binary diff content",
    );
    assert.equal(patch.truncated, false);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: buildCandidateReviewPatch — rejects non-base parent ────────────────

test("wave-commits — buildCandidateReviewPatch rejects candidate with wrong parent", async () => {
  const artifactDir = await mkTmp("pi-wc-patch-parent-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-patch-parent");

    // Create a two-commit chain: base -> commit1 -> commit2
    // Then try to use commit2 as candidate with base as expected parent.
    await writeFile(join(worker.worktreeRoot, "step1.txt"), "step1\n", "utf8");
    await git(["add", "."], worker.worktreeRoot);
    await git(["commit", "--quiet", "-m", "step1"], worker.worktreeRoot);

    await writeFile(join(worker.worktreeRoot, "step2.txt"), "step2\n", "utf8");
    await git(["add", "."], worker.worktreeRoot);
    await git(["commit", "--quiet", "-m", "step2"], worker.worktreeRoot);
    const commit2 = await git(["rev-parse", "HEAD"], worker.worktreeRoot);

    // commit2's parent is commit1, not the wave base.
    await assert.rejects(
      buildCandidateReviewPatch(
        capture.repositoryPath,
        capture.baseCommit,
        commit2,
        1_000_000,
      ),
      /parent is.*expected wave base/,
    );

    // Reset worktree.
    await git(["reset", "--hard", capture.baseCommit], worker.worktreeRoot);
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: buildCandidateReviewPatch — bounded truncation ─────────────────────

test("wave-commits — buildCandidateReviewPatch truncates patch at maxPatchBytes", async () => {
  const artifactDir = await mkTmp("pi-wc-patch-trunc-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-patch-trunc");

    // Create a large file to produce a large diff.
    const largeContent = "x".repeat(10_000) + "\n";
    await writeFile(join(worker.worktreeRoot, "large.txt"), largeContent, "utf8");
    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-patch-trunc", "Add large file");

    // Use a very small maxPatchBytes to force truncation.
    const patch = await buildCandidateReviewPatch(
      capture.repositoryPath,
      capture.baseCommit,
      result.commitSha,
      50, // Very small limit
    );

    assert.equal(patch.truncated, true, "patch should be truncated");
    assert.ok(patch.patch.length <= 50, "patch should be within maxPatchBytes");
    assert.ok(patch.totalBytes > 50, "totalBytes should exceed maxPatchBytes");
    assert.ok(patch.omitted.length > 0, "should have omitted paths");
    assert.ok(patch.changedPaths.length > 0, "should still have changedPaths");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: buildCandidateReviewPatch — no changes returns empty ───────────────

test("wave-commits — buildCandidateReviewPatch returns empty for identical trees", async () => {
  const artifactDir = await mkTmp("pi-wc-patch-empty-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-patch-empty");

    // No changes — normalize to get a candidate with same tree as base.
    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-patch-empty", "No changes");

    const patch = await buildCandidateReviewPatch(
      capture.repositoryPath,
      capture.baseCommit,
      result.commitSha,
      1_000_000,
    );

    assert.equal(patch.changedPaths.length, 0, "no changed paths");
    assert.equal(patch.patch, "", "empty patch");
    assert.equal(patch.truncated, false);
    assert.equal(patch.omitted.length, 0);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: buildCandidateReviewPatch — UTF-8 safe truncation ──────────────────

test("wave-commits — buildCandidateReviewPatch truncates multi-byte UTF-8 safely", async () => {
  const artifactDir = await mkTmp("pi-wc-patch-utf8-");
  try {
    const { capture } = await setupCapture(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-patch-utf8");

    // Create a file with multi-byte UTF-8 content (é = 0xC3 0xA9, € = 0xE2 0x82 0xAC).
    const content = "hello\né\nworld\n€\n";
    await writeFile(join(worker.worktreeRoot, "utf8.txt"), content, "utf8");
    const result = await normalizeCandidate(capture, worker.worktreeRoot, "task-patch-utf8", "Add UTF-8 file");

    // Use a small maxPatchBytes that will cut inside a multi-byte sequence.
    // Try several boundaries to find one that triggers the issue.
    for (const limit of [30, 35, 40, 45, 50, 55, 60]) {
      const patch = await buildCandidateReviewPatch(
        capture.repositoryPath,
        capture.baseCommit,
        result.commitSha,
        limit,
      );

      // The truncated patch must not contain U+FFFD (replacement character).
      assert.ok(
        !patch.patch.includes("\uFFFD"),
        `patch at limit ${limit} must not contain replacement character`,
      );

      // The truncated patch must not exceed maxPatchBytes in bytes.
      const patchBytes = Buffer.byteLength(patch.patch, "utf8");
      assert.ok(
        patchBytes <= limit,
        `patch at limit ${limit} must not exceed maxPatchBytes (got ${patchBytes})`,
      );
    }

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Security: staged symlink blob validation (not worktree) ─────────────────

test("wave-commits — validates staged symlink blob, not worktree symlink", async () => {
  const artifactDir = await mkTmp("pi-wc-sym-blob-");
  const outsideDir = await mkTmp("pi-wc-sym-blob-outside-");
  try {
    const sourceDir = await mkTmp("pi-wc-sym-blob-src-");
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);

    const capture = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-sym-blob",
      artifactDir,
    });

    const worker = await createWorkerWorktree(capture, "task-sym-blob");

    // Create an outside marker file.
    const markerPath = join(outsideDir, "marker.txt");
    await writeFile(markerPath, "OUTSIDE SECRET\n", "utf8");

    // Stage a symlink with an absolute (unsafe) target in the index
    // using update-index --cacheinfo.
    const unsafeTarget = markerPath;

    // Hash the unsafe symlink target into the repo.
    const { spawn } = await import("node:child_process");
    const hashResult = await new Promise<string>((resolve, reject) => {
      const child = spawn("git", ["hash-object", "--stdin", "--literal", "-w"], {
        cwd: capture.repositoryPath,
        env: { ...process.env, ...GIT_ENV, GIT_DIR: capture.repositoryPath },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d; });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) reject(new Error("hash-object failed"));
        else resolve(stdout.trim());
      });
      child.stdin.write(unsafeTarget);
      child.stdin.end();
    });

    // Stage the unsafe symlink in the worktree index.
    // Use --skip-worktree so that `git add .` in normalizeCandidate does NOT
    // overwrite the staged unsafe blob with the safe worktree symlink.
    await git(
      ["update-index", "--add", "--cacheinfo", "120000", hashResult, "escape-link"],
      worker.worktreeRoot,
    );
    await git(
      ["update-index", "--skip-worktree", "escape-link"],
      worker.worktreeRoot,
    );

    // Create a safe worktree symlink (different from the staged blob).
    // This simulates an index/worktree mismatch bypass attempt.
    await symlink("readme.md", join(worker.worktreeRoot, "escape-link"));

    // normalizeCandidate should reject the unsafe staged blob,
    // even though the worktree symlink is safe.
    await assert.rejects(
      normalizeCandidate(capture, worker.worktreeRoot, "task-sym-blob", "Unsafe symlink"),
      /Symlink target is absolute and rejected|escapes worktree root/,
    );

    // Verify the outside marker was NOT read.
    const markerContent = await readFile(markerPath, "utf8");
    assert.equal(markerContent, "OUTSIDE SECRET\n", "outside marker must be untouched");

    // Reset worktree to clean state.
    // First unmark skip-worktree, then reset.
    await git(["update-index", "--no-skip-worktree", "escape-link"], worker.worktreeRoot).catch(() => {});
    await rm(join(worker.worktreeRoot, "escape-link"), { force: true });
    await git(["reset", "--hard", capture.baseCommit], worker.worktreeRoot).catch(() => {});
    await git(["clean", "-fd"], worker.worktreeRoot).catch(() => {});
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

// ── createCommitWithParent: deterministic stdout capture ordering ───────────

/**
 * Build a scripted fake child process for createCommitWithParent's spawn seam.
 * The returned emitters let the test control event ordering exactly (data vs
 * exit vs close), which real subprocesses cannot guarantee under load.
 */
function makeScriptedChild(): {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdinText: () => string;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let stdinText = "";
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: {
      write: (chunk: unknown) => { stdinText += String(chunk); return true; },
      end: () => undefined,
    },
  });
  return {
    child: child as unknown as ChildProcessByStdio<Writable, Readable, Readable>,
    stdout,
    stderr,
    stdinText: () => stdinText,
  };
}

test("wave-commits — commit-tree capture waits for close and keeps the final SHA chunk", async () => {
  const fullSha = "324e5edc2725585dbaa20fe49a4fd3ac7967f0f0";
  const { child, stdout, stdinText } = makeScriptedChild();
  let resolved: string | undefined;
  let rejected: unknown;
  const settled = createCommitWithParent("/tmp", "tree-sha", "parent-sha", "candidate\n", () => child)
    .then((sha) => { resolved = sha; }, (error) => { rejected = error; });

  // Deterministic regression ordering for the CI race: the process reports
  // "exit" while the final stdout chunk is still in flight — here the SHA line
  // itself is split across the exit boundary. Settling on "exit" captures only
  // the truncated prefix (or nothing) and downstream update-ref receives an
  // empty new value ("fatal: : not a valid SHA1"); capture must wait for
  // "close", which fires only after every stdio stream has been drained.
  stdout.emit("data", Buffer.from(fullSha.slice(0, 8)));
  child.emit("exit", 0, null);
  stdout.emit("data", Buffer.from(fullSha.slice(8) + "\n"));
  child.emit("close", 0, null);

  await settled;
  assert.equal(rejected, undefined, "must not reject when close delivers the full output");
  assert.equal(resolved, fullSha, "resolved SHA must include the chunk that arrived after exit");
  assert.equal(stdinText(), "candidate\n", "commit message must still be written to stdin");
});

test("wave-commits — commit-tree without an object name fails closed", async () => {
  const { child } = makeScriptedChild();
  let rejected: unknown;
  const settled = createCommitWithParent("/tmp", "tree-sha", "parent-sha", "candidate\n", () => child)
    .catch((error) => { rejected = error; });
  // Zero exit with no stdout at all: must reject, never resolve an empty SHA.
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  await settled;
  assert.ok(rejected instanceof Error, "must reject instead of resolving an empty SHA");
  assert.match(rejected.message, /no valid object name/);
});

test("wave-commits — commit-tree failure still reports exit code and stderr", async () => {
  const { child, stderr } = makeScriptedChild();
  let rejected: unknown;
  const settled = createCommitWithParent("/tmp", "tree-sha", "parent-sha", "candidate\n", () => child)
    .catch((error) => { rejected = error; });
  stderr.emit("data", Buffer.from("fatal: bad tree\n"));
  child.emit("exit", 128, null);
  child.emit("close", 128, null);
  await settled;
  assert.ok(rejected instanceof Error);
  assert.match(rejected.message, /exited with code 128/);
  assert.match(rejected.message, /fatal: bad tree/);
});

// Import readFile for the test above
import { readFile } from "node:fs/promises";
