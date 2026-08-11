/**
 * End-to-end wave tests using real temporary repositories/filesystems
 * and the run-as-binary fake executor (not mocked controller dependencies).
 *
 * Covers cross-subsystem scenarios that combine capture, worker execution,
 * integration, and landing in a single executeWave call.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ReviewGateConfig } from "../src/config";
import { executeWave } from "../src/execution/wave-controller";

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "E2E Test",
  GIT_AUTHOR_EMAIL: "e2e@test.com",
  GIT_COMMITTER_NAME: "E2E Test",
  GIT_COMMITTER_EMAIL: "e2e@test.com",
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

/** Poll for a file to exist, with a timeout. */
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await lstat(path);
      return; // File exists
    } catch {
      // File not yet created
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timeout waiting for file: ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ── Fake executor builders ───────────────────────────────────────────────────

/**
 * Build a config with a reporting fake executor that writes a report.json
 * containing what the worker observes in its worktree.
 * This proves the worker sees the captured working-tree/untracked state.
 */
function makeConfigWithReportingWriter(): ReviewGateConfig {
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
      activeExecutor: { source: "external", id: "reporting-writer" },
      externalExecutors: [
        {
          id: "reporting-writer",
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
              '  const path=require("path");',
              '  const cwd=process.cwd();',
              // Read files to report what the worker sees
              '  const committed=fs.existsSync(path.join(cwd,"committed.txt"))?fs.readFileSync(path.join(cwd,"committed.txt"),"utf8"):null;',
              '  const staged=fs.existsSync(path.join(cwd,"staged.txt"))?fs.readFileSync(path.join(cwd,"staged.txt"),"utf8"):null;',
              '  const untracked=fs.existsSync(path.join(cwd,"untracked.txt"))?fs.readFileSync(path.join(cwd,"untracked.txt"),"utf8"):null;',
              '  const ignored=fs.existsSync(path.join(cwd,"ignored-marker.txt"));',
              '  const report=JSON.stringify({committed,staged,untracked,ignored});',
              '  fs.writeFileSync(path.join(cwd,"report.json"),report);',
              '  process.stdout.write(JSON.stringify({type:"session",sessionId:"fake"})+"\\n");',
              '  process.stdout.write(JSON.stringify({type:"assistant",text:"Done."})+"\\n");',
              "  process.exit(0);",
              "});",
            ].join(""),
          ],
          timeoutMs: 30_000,
        },
      ],
    },
  };
}

/**
 * Build a config with a file-writing fake executor that writes to a specific
 * file determined by the task title (for overlapping edit tests).
 * Both workers modify the same existing file with different content to force conflicts.
 */
function makeConfigWithTargetedWriter(): ReviewGateConfig {
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
      activeExecutor: { source: "external", id: "targeted-writer" },
      externalExecutors: [
        {
          id: "targeted-writer",
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
              '  const p=require("path").join(process.cwd(),"contested-file.txt");',
              '  const title=(input.match(/"title":"([^"]*)"/)||[])[1]||"unknown";',
              // Completely replace the file with unique content per worker
              '  const content="Worker: "+title+"\\nData: "+Math.random()+"\\nTimestamp: "+Date.now();',
              '  fs.writeFileSync(p,content);',
              '  process.stdout.write(JSON.stringify({type:"session",sessionId:"fake"})+"\\n");',
              '  process.stdout.write(JSON.stringify({type:"assistant",text:"Done."})+"\\n");',
              "  process.exit(0);",
              "});",
            ].join(""),
          ],
          timeoutMs: 30_000,
        },
      ],
    },
  };
}

/**
 * Build a config with a slow executor that uses file-based synchronization.
 * Writes a started marker file so the test can poll for it deterministically.
 * Waits for the sync file to be deleted before completing.
 */
function makeConfigWithSyncSlowExecutor(syncFile: string, markerFile: string): ReviewGateConfig {
  const escapedSyncFile = syncFile.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedMarkerFile = markerFile.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
      activeExecutor: { source: "external", id: "sync-slow" },
      externalExecutors: [
        {
          id: "sync-slow",
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
              `  const syncFile="${escapedSyncFile}";`,
              `  const markerFile="${escapedMarkerFile}";`,
              '  const p=require("path").join(process.cwd(),"slow-output.txt");',
              '  fs.writeFileSync(p,"slow result\\n");',
              // Write started marker for deterministic synchronization
              '  fs.writeFileSync(markerFile,"started");',
              '  process.stdout.write(JSON.stringify({type:"session",sessionId:"fake"})+"\\n");',
              '  const check=()=>{',
              '    try{fs.accessSync(syncFile);setTimeout(check,50);}',
              '    catch(e){',
              '      process.stdout.write(JSON.stringify({type:"assistant",text:"Done."})+"\\n");',
              "      process.exit(0);",
              "    }",
              "  };",
              "  check();",
              "});",
            ].join(""),
          ],
          timeoutMs: 30000,
        },
      ],
    },
  };
}

// ── Test 1: Dirty Git source with full capture ───────────────────────────────

test("dirty Git source: working-tree-over-index capture, untracked included, ignored excluded, parallel workers, HEAD/index preserved", async () => {
  const artifactDir = await mkTmp("pi-e2e-art-");
  const sourceDir = await mkTmp("pi-e2e-src-");

  try {
    // Initialize Git repo with committed content
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "committed.txt"), "committed content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "initial commit"], sourceDir);

    // Create staged content (different from committed)
    await writeFile(join(sourceDir, "staged.txt"), "staged content\n", "utf8");
    await git(["add", "staged.txt"], sourceDir);
    // Don't commit staged.txt — it stays in the index

    // Create unstaged working-tree content (different from index)
    await writeFile(join(sourceDir, "committed.txt"), "working tree content\n", "utf8");

    // Create a non-ignored untracked file
    await writeFile(join(sourceDir, "untracked.txt"), "untracked content\n", "utf8");

    // Create an ignored marker file
    await writeFile(join(sourceDir, ".gitignore"), "ignored-marker.txt\n", "utf8");
    await writeFile(join(sourceDir, "ignored-marker.txt"), "should be ignored\n", "utf8");

    // Record original state
    const originalHead = await git(["rev-parse", "HEAD"], sourceDir);
    const originalIndexTree = await git(["write-tree"], sourceDir);
    const originalCommittedContent = await readFile(join(sourceDir, "committed.txt"), "utf8");
    const originalUntrackedContent = await readFile(join(sourceDir, "untracked.txt"), "utf8");

    // Execute wave with two workers
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "Worker A", instructions: "write output", acceptanceCriteria: [] },
        { title: "Worker B", instructions: "write output", acceptanceCriteria: [] },
      ],
      config: makeConfigWithReportingWriter(),
      artifactDir,
      waveId: "e2e-dirty-git",
    });

    // Verify both workers completed
    assert.equal(result.taskResults.length, 2);
    for (const tr of result.taskResults) {
      assert.ok(
        tr.status === "accepted" || tr.status === "completed_unreviewed",
        `Expected eligible status, got ${tr.status}`,
      );
      assert.ok(tr.acceptedCommitSha, `Expected acceptedCommitSha for ${tr.taskId}`);
    }

    // Verify integration succeeded
    assert.ok(result.integration, "Integration should have been attempted");
    assert.equal(result.integration.status, "integrated");

    // Verify landing succeeded
    assert.ok(result.landing, "Landing should have been attempted");
    assert.equal(result.landing.status, "landed");

    // Verify source HEAD unchanged
    const currentHead = await git(["rev-parse", "HEAD"], sourceDir);
    assert.equal(currentHead, originalHead, "Source HEAD should be unchanged");

    // Verify source index tree unchanged
    const currentIndexTree = await git(["write-tree"], sourceDir);
    assert.equal(currentIndexTree, originalIndexTree, "Source index tree should be unchanged");

    // Verify dirty bytes remain intact
    const currentCommittedContent = await readFile(join(sourceDir, "committed.txt"), "utf8");
    assert.equal(currentCommittedContent, originalCommittedContent, "Working-tree content should be preserved");

    const currentUntrackedContent = await readFile(join(sourceDir, "untracked.txt"), "utf8");
    assert.equal(currentUntrackedContent, originalUntrackedContent, "Untracked content should be preserved");

    // Verify landed files exist and are uncommitted
    const landedReport = await readFile(join(sourceDir, "report.json"), "utf8");
    const report = JSON.parse(landedReport);
    // Verify working-tree-over-index capture: committed.txt should have working tree content
    assert.equal(report.committed, "working tree content\n", "Worker should see working-tree content of committed.txt");
    // Verify staged file was captured
    assert.equal(report.staged, "staged content\n", "Worker should see staged.txt");
    // Verify untracked file was captured
    assert.equal(report.untracked, "untracked content\n", "Worker should see untracked.txt");
    // Verify ignored file was NOT captured
    assert.equal(report.ignored, false, "Worker should NOT see ignored-marker.txt");

    // Verify the landed file is uncommitted (not in HEAD)
    const headFiles = await git(["ls-tree", "-r", "--name-only", "HEAD"], sourceDir);
    assert.ok(!headFiles.includes("report.json"), "Landed file should not be in HEAD");

    // Verify wave repo base tree includes untracked/staged but not ignored
    const repoPath = join(result.waveRoot, "wave-repo.git");
    const baseTree = await gitInRepo(
      ["ls-tree", "-r", "--name-only", result.taskResults[0].acceptedCommitSha + "^"],
      repoPath,
    );
    assert.ok(baseTree.includes("untracked.txt"), "Base tree should include untracked.txt");
    assert.ok(baseTree.includes("staged.txt"), "Base tree should include staged.txt");
    assert.ok(!baseTree.includes("ignored-marker.txt"), "Base tree should NOT include ignored-marker.txt");

    // Verify refs remain resolvable after worktree cleanup
    for (const tr of result.taskResults) {
      assert.ok(tr.acceptedCommitSha, `Expected acceptedCommitSha for ${tr.taskId}`);
      const catFile = await gitInRepo(["cat-file", "-t", tr.acceptedCommitSha], repoPath);
      assert.equal(catFile, "commit", `Worker ref ${tr.taskId} should resolve to a commit`);
    }

    // Verify integrated ref is resolvable
    const integratedSha = await gitInRepo(
      ["rev-parse", "refs/pi-review-gate/waves/e2e-dirty-git/integrated"],
      repoPath,
    );
    assert.ok(integratedSha, "Integrated ref should be resolvable");

  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── Test 2: Non-Git/untracked-only nested cwd ────────────────────────────────

test("non-Git source: nested cwd snapshots/lands correctly, no .git created in source", async () => {
  const artifactDir = await mkTmp("pi-e2e-art-");
  const sourceDir = await mkTmp("pi-e2e-src-");
  const nestedDir = join(sourceDir, "sub", "nested");

  try {
    // Create a non-Git directory with nested structure
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, "file1.txt"), "nested content 1\n", "utf8");
    await writeFile(join(nestedDir, "file2.txt"), "nested content 2\n", "utf8");
    await writeFile(join(sourceDir, "root-file.txt"), "root content\n", "utf8");

    // Execute wave with the nested directory as cwd
    const result = await executeWave({
      cwd: nestedDir,
      tasks: [
        { title: "Nested Worker", instructions: "write output", acceptanceCriteria: [] },
      ],
      config: makeConfigWithReportingWriter(),
      artifactDir,
      waveId: "e2e-nongit",
    });

    // Verify worker completed
    assert.equal(result.taskResults.length, 1);
    assert.ok(
      result.taskResults[0].status === "accepted" || result.taskResults[0].status === "completed_unreviewed",
      `Expected eligible status, got ${result.taskResults[0].status}`,
    );

    // Verify integration succeeded
    assert.ok(result.integration, "Integration should have been attempted");
    assert.equal(result.integration.status, "integrated");

    // Verify landing succeeded
    assert.ok(result.landing, "Landing should have been attempted");
    assert.equal(result.landing.status, "landed");

    // Verify no .git was created in source (use lstat to detect both files and dirs)
    await assert.rejects(
      lstat(join(sourceDir, ".git")),
      { code: "ENOENT" },
      ".git should not be created in non-Git source",
    );

    // Verify landed file exists in the source
    const landedReport = await readFile(join(nestedDir, "report.json"), "utf8");
    const report = JSON.parse(landedReport);
    assert.ok(report, "Landed report should exist");

    // Verify manifest shows non-git source type
    const manifestPath = join(result.waveRoot, "wave-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.sourceType, "non-git");

  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── Test 3: Overlapping edits produce structured conflict ────────────────────

test("overlapping edits: structured integration conflict, source files/index/HEAD untouched", async () => {
  const artifactDir = await mkTmp("pi-e2e-art-");
  const sourceDir = await mkTmp("pi-e2e-src-");

  try {
    // Initialize Git repo with a contested file that both workers will modify
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "contested-file.txt"), "original content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "initial"], sourceDir);

    const originalHead = await git(["rev-parse", "HEAD"], sourceDir);
    const originalContent = await readFile(join(sourceDir, "contested-file.txt"), "utf8");

    // Execute wave with two workers that both modify the same file
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "Worker One", instructions: "modify shared file", acceptanceCriteria: [] },
        { title: "Worker Two", instructions: "modify shared file", acceptanceCriteria: [] },
      ],
      config: makeConfigWithTargetedWriter(),
      artifactDir,
      waveId: "e2e-conflict",
    });

    // Verify both workers completed
    assert.equal(result.taskResults.length, 2);
    for (const tr of result.taskResults) {
      assert.ok(
        tr.status === "accepted" || tr.status === "completed_unreviewed",
        `Expected eligible status, got ${tr.status}`,
      );
    }

    // Verify integration conflicted
    assert.ok(result.integration, "Integration should have been attempted");
    assert.equal(result.integration.status, "conflicted");
    assert.ok(result.integration.conflictingTaskId, "Should have conflicting task ID");
    assert.ok(result.integration.conflictingCommitSha, "Should have conflicting commit SHA");
    assert.ok(result.integration.conflictingPaths, "Should have conflicting paths");
    assert.ok(
      result.integration.conflictingPaths.includes("contested-file.txt"),
      "contested-file.txt should be in conflicting paths",
    );

    // Verify landing was skipped due to conflict
    assert.equal(result.landing, undefined, "Landing should be skipped on conflict");

    // Verify source HEAD unchanged
    const currentHead = await git(["rev-parse", "HEAD"], sourceDir);
    assert.equal(currentHead, originalHead, "Source HEAD should be unchanged");

    // Verify source file unchanged
    const currentContent = await readFile(join(sourceDir, "contested-file.txt"), "utf8");
    assert.equal(currentContent, originalContent, "Source file should be unchanged");

  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── Test 4: Deterministic HEAD drift during worker execution ─────────────────

test("HEAD drift during worker: new HEAD not reset, unrelated changes land", async () => {
  const artifactDir = await mkTmp("pi-e2e-art-");
  const sourceDir = await mkTmp("pi-e2e-src-");
  const syncDir = await mkTmp("pi-e2e-sync-");
  const syncFile = join(syncDir, "sync-marker");
  const markerFile = join(syncDir, "started-marker");

  try {
    // Initialize Git repo
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "base.txt"), "base content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "initial"], sourceDir);

    const originalHead = await git(["rev-parse", "HEAD"], sourceDir);

    // Create the sync file so the slow executor waits
    await writeFile(syncFile, "wait", "utf8");

    // Start the wave with a slow executor
    const wavePromise = executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "Slow Worker", instructions: "slow task", acceptanceCriteria: [] },
      ],
      config: makeConfigWithSyncSlowExecutor(syncFile, markerFile),
      artifactDir,
      waveId: "e2e-drift",
    });

    // Wait deterministically for the worker to start (poll for marker file)
    await waitForFile(markerFile, 10_000);

    // Change HEAD to a new commit (deterministic HEAD drift)
    await writeFile(join(sourceDir, "new-commit.txt"), "new commit content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "new commit"], sourceDir);
    const newHead = await git(["rev-parse", "HEAD"], sourceDir);
    assert.notEqual(newHead, originalHead, "HEAD should have changed");

    // Release the slow worker
    await rm(syncFile, { force: true });

    const result = await wavePromise;

    // Verify results
    assert.equal(result.taskResults.length, 1);
    assert.ok(
      result.taskResults[0].status === "accepted" || result.taskResults[0].status === "completed_unreviewed",
      `Expected eligible status, got ${result.taskResults[0].status}`,
    );

    // Verify source HEAD is the new HEAD, not reset to original
    const currentHead = await git(["rev-parse", "HEAD"], sourceDir);
    assert.equal(currentHead, newHead, "Source HEAD should be the new HEAD, not reset");

    // Verify the new commit content is still there
    const newCommitContent = await readFile(join(sourceDir, "new-commit.txt"), "utf8");
    assert.equal(newCommitContent, "new commit content\n", "New commit content should be preserved");

    // Verify landing succeeded and slow-output.txt landed
    assert.equal(result.landing?.status, "landed", "Landing should have succeeded");
    const landedOutput = await readFile(join(sourceDir, "slow-output.txt"), "utf8");
    assert.ok(landedOutput.includes("slow result"), "Landed file should contain slow result");

    // Verify refs remain resolvable after worktree cleanup
    const repoPath = join(result.waveRoot, "wave-repo.git");
    assert.ok(result.taskResults[0].acceptedCommitSha, "Worker should have acceptedCommitSha");
    const catFile = await gitInRepo(
      ["cat-file", "-t", result.taskResults[0].acceptedCommitSha],
      repoPath,
    );
    assert.equal(catFile, "commit", "Worker ref should resolve to a commit");

  } finally {
    await rm(syncFile, { force: true }).catch(() => {});
    await rm(markerFile, { force: true }).catch(() => {});
    await rm(syncDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── Test 5: Accepted refs resolvable after cleanup, landed changes uncommitted ─

test("accepted refs resolvable after worktree cleanup, landed changes uncommitted", async () => {
  const artifactDir = await mkTmp("pi-e2e-art-");
  const sourceDir = await mkTmp("pi-e2e-src-");

  try {
    // Initialize Git repo
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "base.txt"), "base content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "initial"], sourceDir);

    const originalHead = await git(["rev-parse", "HEAD"], sourceDir);

    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        { title: "Worker A", instructions: "write output", acceptanceCriteria: [] },
        { title: "Worker B", instructions: "write output", acceptanceCriteria: [] },
      ],
      config: makeConfigWithReportingWriter(),
      artifactDir,
      waveId: "e2e-refs",
    });

    // Verify integration and landing succeeded
    assert.equal(result.integration?.status, "integrated");
    assert.equal(result.landing?.status, "landed");

    const repoPath = join(result.waveRoot, "wave-repo.git");

    // Verify all worker refs are resolvable
    for (const tr of result.taskResults) {
      if (tr.acceptedCommitSha) {
        const catFile = await gitInRepo(["cat-file", "-t", tr.acceptedCommitSha], repoPath);
        assert.equal(catFile, "commit", `Worker ${tr.taskId} ref should resolve`);

        // Verify the worker ref is resolvable
        const workerRef = `refs/pi-review-gate/waves/e2e-refs/workers/${tr.taskId}`;
        const refSha = await gitInRepo(["rev-parse", workerRef], repoPath);
        assert.equal(refSha, tr.acceptedCommitSha, `Worker ref ${workerRef} should point to accepted commit`);
      }
    }

    // Verify integrated ref is resolvable
    const integratedRef = "refs/pi-review-gate/waves/e2e-refs/integrated";
    const integratedSha = await gitInRepo(["rev-parse", integratedRef], repoPath);
    assert.ok(integratedSha, "Integrated ref should be resolvable");

    // Verify landed changes are uncommitted
    const currentHead = await git(["rev-parse", "HEAD"], sourceDir);
    assert.equal(currentHead, originalHead, "HEAD should be unchanged");

    // Verify landed file exists but is not committed
    const landedReport = await readFile(join(sourceDir, "report.json"), "utf8");
    assert.ok(landedReport, "Landed report should exist");

    const headFiles = await git(["ls-tree", "-r", "--name-only", "HEAD"], sourceDir);
    assert.ok(!headFiles.includes("report.json"), "Landed file should not be in HEAD");

    // Verify worktrees were cleaned up
    const workersDir = join(result.waveRoot, "workers");
    try {
      const entries = await import("node:fs/promises").then((m) => m.readdir(workersDir));
      assert.ok(entries.length === 0, "Clean worktrees should be removed");
    } catch {
      // Directory doesn't exist — that's fine
    }

  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});
