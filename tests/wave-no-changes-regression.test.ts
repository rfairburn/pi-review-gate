/**
 * Regression tests for the no_changes reporting bug.
 *
 * Reproduces the reported discrepancy: a batch run asked two workers to create
 * separate non-ignored index.html and about.html files, displayed both tasks as
 * no_changes and integration no_changes, yet the files existed in the source
 * workspace afterward.
 *
 * These tests verify:
 * - A worker that creates a new non-ignored file reports completed_unreviewed (not no_changes)
 * - Integration produces integrated status with mappings (not no_changes)
 * - Landing lists the files in appliedPaths
 * - A true no-op still reports no_changes/no_changes
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

// ── Fake executor builders ───────────────────────────────────────────────────

/**
 * Build a config with a file-writing fake executor that creates specific files
 * based on the task title. Used to reproduce the no_changes bug.
 */
function makeConfigWithFileWriter(): ReviewGateConfig {
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
      activeExecutor: { source: "external", id: "file-writer" },
      externalExecutors: [
        {
          id: "file-writer",
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
              // Extract the title from the prompt to determine which file to create
              // Parse title from "Subtask: <title>" line in the prompt
              '  const subtaskMatch=input.match(/Subtask:\\s*(.+)/);',
              '  const title=subtaskMatch?subtaskMatch[1].trim():"unknown";',
              // Create a file based on the title
              '  if(title.includes("index")){',
              '    fs.writeFileSync(path.join(cwd,"index.html"),"<h1>Index</h1>\\n");',
              '  }else if(title.includes("about")){',
              '    fs.writeFileSync(path.join(cwd,"about.html"),"<h1>About</h1>\\n");',
              '  }else{',
              '    fs.writeFileSync(path.join(cwd,"output.txt"),"done\\n");',
              '  }',
              '  process.stdout.write(JSON.stringify({type:"session",sessionId:"fake"})+"\\n");',
              '  process.stdout.write(JSON.stringify({type:"assistant",text:"Created file."})+"\\n");',
              "  process.exit(0);",
              "});",
            ].join(""),
          ],
          timeoutMs: 15000,
        },
      ],
    },
  };
}

/**
 * Build a config with a no-op executor that makes no filesystem changes.
 */
function makeConfigWithPromptTargetWriter(sourceRoot: string): ReviewGateConfig {
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
      activeExecutor: { source: "external", id: "prompt-target-writer" },
      externalExecutors: [{
        id: "prompt-target-writer",
        adapter: "run-as-binary",
        protocol: "pi-review-executor-jsonl-v1",
        command: process.execPath,
        env: { TEST_SOURCE_ROOT: sourceRoot },
        args: [
          "-e",
          [
            "let input='';",
            "process.stdin.on('data',(d)=>{input+=d;});",
            "process.stdin.on('end',()=>{",
            '  const fs=require("fs");',
            '  const path=require("path");',
            '  const match=input.match(/Create a file at (.+?\\/(?:index|about)\\.html)(?:\\s|$)/);',
            '  if(!match) process.exit(10);',
            '  const target=match[1];',
            '  const sourceTarget=path.join(process.env.TEST_SOURCE_ROOT,path.basename(target));',
            '  if(target===sourceTarget || fs.existsSync(sourceTarget)) process.exit(11);',
            '  fs.mkdirSync(path.dirname(target),{recursive:true});',
            '  fs.writeFileSync(target,"<h1>"+path.basename(target)+"</h1>\\n");',
            '  process.stdout.write(JSON.stringify({type:"session",sessionId:"prompt-writer"})+"\\n");',
            '  process.stdout.write(JSON.stringify({type:"assistant",text:"Created "+target})+"\\n");',
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      }],
    },
  };
}

function makeConfigWithNoOp(): ReviewGateConfig {
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
      activeExecutor: { source: "external", id: "noop" },
      externalExecutors: [
        {
          id: "noop",
          adapter: "run-as-binary",
          protocol: "pi-review-executor-jsonl-v1",
          command: process.execPath,
          args: [
            "-e",
            [
              "process.stdin.resume();",
              "process.stdin.on('end',()=>{",
              '  process.stdout.write(JSON.stringify({type:"session",sessionId:"noop"})+"\\n");',
              '  process.stdout.write(JSON.stringify({type:"assistant",text:"No changes needed."})+"\\n");',
              "  process.exit(0);",
              "});",
            ].join(""),
          ],
          timeoutMs: 15000,
        },
      ],
    },
  };
}

// ── Regression test: two-file parallel write must NOT report no_changes ──────

test("regression: two-file parallel write reports completed_unreviewed, integrated, landed (not no_changes)", async () => {
  const artifactDir = await mkTmp("pi-regression-art-");
  const sourceDir = await mkTmp("pi-regression-src-");

  try {
    // Initialize Git repo with a base file (no index.html or about.html)
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "base.txt"), "base content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "initial"], sourceDir);

    // Verify files don't exist before the wave
    await assert.rejects(
      access(join(sourceDir, "index.html")),
      { code: "ENOENT" },
      "index.html should not exist before wave",
    );
    await assert.rejects(
      access(join(sourceDir, "about.html")),
      { code: "ENOENT" },
      "about.html should not exist before wave",
    );

    const originalHead = await git(["rev-parse", "HEAD"], sourceDir);

    // Execute wave with two workers that create separate files
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        {
          title: "Create index.html",
          instructions: "Create index.html with HTML content.",
          acceptanceCriteria: ["index.html exists"],
        },
        {
          title: "Create about.html",
          instructions: "Create about.html with HTML content.",
          acceptanceCriteria: ["about.html exists"],
        },
      ],
      config: makeConfigWithFileWriter(),
      artifactDir,
      waveId: "regression-two-files",
    });

    // ── Verify worker statuses are NOT no_changes ──
    assert.equal(result.taskResults.length, 2);
    for (const tr of result.taskResults) {
      assert.ok(
        tr.status === "completed_unreviewed" || tr.status === "accepted",
        `Task ${tr.taskId} should be completed_unreviewed or accepted, got ${tr.status}`,
      );
      assert.ok(
        tr.acceptedCommitSha,
        `Task ${tr.taskId} should have acceptedCommitSha`,
      );
      assert.ok(
        tr.acceptedRef,
        `Task ${tr.taskId} should have acceptedRef`,
      );
    }

    // ── Verify integration is integrated (not no_changes) ──
    assert.ok(result.integration, "Integration should exist");
    assert.equal(
      result.integration.status,
      "integrated",
      `Integration should be integrated, got ${result.integration.status}`,
    );
    assert.ok(
      result.integration.workerMappings?.length === 2,
      `Should have 2 worker mappings, got ${result.integration.workerMappings?.length}`,
    );

    // ── Verify landing is landed with applied paths ──
    assert.ok(result.landing, "Landing should exist");
    assert.equal(
      result.landing.status,
      "landed",
      `Landing should be landed, got ${result.landing.status}`,
    );
    assert.ok(
      result.landing.appliedPaths?.includes("index.html"),
      "appliedPaths should include index.html",
    );
    assert.ok(
      result.landing.appliedPaths?.includes("about.html"),
      "appliedPaths should include about.html",
    );

    // ── Verify files exist in source after landing ──
    const indexContent = await readFile(join(sourceDir, "index.html"), "utf8");
    assert.ok(indexContent.includes("Index"), "index.html should contain Index");
    const aboutContent = await readFile(join(sourceDir, "about.html"), "utf8");
    assert.ok(aboutContent.includes("About"), "about.html should contain About");

    // ── Verify source HEAD unchanged ──
    const currentHead = await git(["rev-parse", "HEAD"], sourceDir);
    assert.equal(currentHead, originalHead, "Source HEAD should be unchanged");

    // ── Verify wave manifest agrees with results ──
    const manifestPath = join(result.waveRoot, "wave-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const mt of manifest.tasks) {
      assert.ok(
        mt.status === "completed_unreviewed" || mt.status === "accepted",
        `Manifest task ${mt.taskId} should be completed_unreviewed or accepted, got ${mt.status}`,
      );
    }
    assert.equal(manifest.integrationStatus, "integrated");
    assert.equal(manifest.landingStatus, "landed");
    assert.ok(manifest.landingAppliedPaths?.includes("index.html"));
    assert.ok(manifest.landingAppliedPaths?.includes("about.html"));

  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── Regression test: true no-op still reports no_changes ─────────────────────

test("regression: true no-op reports no_changes/no_changes without false file creation", async () => {
  const artifactDir = await mkTmp("pi-regression-noop-art-");
  const sourceDir = await mkTmp("pi-regression-noop-src-");

  try {
    // Initialize Git repo
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "base.txt"), "base content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "initial"], sourceDir);

    const originalHead = await git(["rev-parse", "HEAD"], sourceDir);

    // Execute wave with a no-op worker
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        {
          title: "No-op task",
          instructions: "Do nothing.",
          acceptanceCriteria: ["no changes needed"],
        },
      ],
      config: makeConfigWithNoOp(),
      artifactDir,
      waveId: "regression-noop",
    });

    // ── Verify worker reports no_changes ──
    assert.equal(result.taskResults.length, 1);
    assert.equal(
      result.taskResults[0].status,
      "no_changes",
      `No-op task should be no_changes, got ${result.taskResults[0].status}`,
    );

    // ── Verify integration is no_changes ──
    assert.ok(result.integration, "Integration should exist");
    assert.equal(
      result.integration.status,
      "no_changes",
      `Integration should be no_changes, got ${result.integration.status}`,
    );

    // ── Verify landing is landed with empty applied paths ──
    assert.ok(result.landing, "Landing should exist");
    assert.equal(
      result.landing.status,
      "landed",
      `Landing should be landed, got ${result.landing.status}`,
    );
    assert.equal(
      result.landing.appliedPaths?.length,
      0,
      "No-op landing should have 0 applied paths",
    );

    // ── Verify source HEAD unchanged ──
    const currentHead = await git(["rev-parse", "HEAD"], sourceDir);
    assert.equal(currentHead, originalHead, "Source HEAD should be unchanged");

    // ── Verify no new files created ──
    const headFiles = await git(["ls-tree", "-r", "--name-only", "HEAD"], sourceDir);
    assert.ok(!headFiles.includes("output.txt"), "No new files should be created");

  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── Regression test: ignored paths excluded ──────────────────────────────────

test("regression: ignored HTML paths remain excluded and not reported as landed", async () => {
  const artifactDir = await mkTmp("pi-regression-ignore-art-");
  const sourceDir = await mkTmp("pi-regression-ignore-src-");

  try {
    // Initialize Git repo with .gitignore
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "base.txt"), "base content\n", "utf8");
    await writeFile(join(sourceDir, ".gitignore"), "*.log\nbuild/\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "initial"], sourceDir);

    // Execute wave with a worker that creates both ignored and non-ignored files
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        {
          title: "Create files",
          instructions: "Create output.txt (not ignored) and debug.log (ignored).",
          acceptanceCriteria: ["output.txt exists"],
        },
      ],
      config: {
        ...makeConfigWithFileWriter(),
        execution: {
          ...makeConfigWithFileWriter().execution!,
          externalExecutors: [
            {
              id: "mixed-writer",
              adapter: "run-as-binary",
              protocol: "pi-review-executor-jsonl-v1",
              command: process.execPath,
              args: [
                "-e",
                [
                  "process.stdin.resume();",
                  "process.stdin.on('end',()=>{",
                  '  const fs=require("fs");',
                  '  const path=require("path");',
                  '  const cwd=process.cwd();',
                  '  fs.writeFileSync(path.join(cwd,"output.txt"),"output\\n");',
                  '  fs.writeFileSync(path.join(cwd,"debug.log"),"debug\\n");',
                  '  process.stdout.write(JSON.stringify({type:"session",sessionId:"fake"})+"\\n");',
                  '  process.stdout.write(JSON.stringify({type:"assistant",text:"Done."})+"\\n");',
                  "  process.exit(0);",
                  "});",
                ].join(""),
              ],
              timeoutMs: 15000,
            },
          ],
          activeExecutor: { source: "external", id: "mixed-writer" },
        },
      },
      artifactDir,
      waveId: "regression-ignore",
    });

    // ── Verify worker completed ──
    assert.equal(result.taskResults.length, 1);
    assert.ok(
      result.taskResults[0].status === "completed_unreviewed" || result.taskResults[0].status === "accepted",
      `Task should be completed, got ${result.taskResults[0].status}`,
    );

    // ── Verify only non-ignored file is in applied paths ──
    assert.ok(result.landing, "Landing should exist");
    assert.ok(
      result.landing.appliedPaths?.includes("output.txt"),
      "appliedPaths should include output.txt",
    );
    assert.ok(
      !result.landing.appliedPaths?.includes("debug.log"),
      "appliedPaths should NOT include debug.log (ignored)",
    );

  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── Regression test: non-Git source ──────────────────────────────────────────

test("regression: non-Git source two-file write reports correctly", async () => {
  const artifactDir = await mkTmp("pi-regression-nongit-art-");
  const sourceDir = await mkTmp("pi-regression-nongit-src-");

  try {
    // Create a non-Git directory with a base file
    await writeFile(join(sourceDir, "base.txt"), "base content\n", "utf8");

    // Execute wave with two workers
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        {
          title: "Create index.html",
          instructions: "Create index.html.",
          acceptanceCriteria: ["index.html exists"],
        },
        {
          title: "Create about.html",
          instructions: "Create about.html.",
          acceptanceCriteria: ["about.html exists"],
        },
      ],
      config: makeConfigWithFileWriter(),
      artifactDir,
      waveId: "regression-nongit",
    });

    // ── Verify workers completed ──
    assert.equal(result.taskResults.length, 2);
    for (const tr of result.taskResults) {
      assert.ok(
        tr.status === "completed_unreviewed" || tr.status === "accepted",
        `Task ${tr.taskId} should be completed, got ${tr.status}`,
      );
    }

    // ── Verify integration and landing ──
    assert.equal(result.integration?.status, "integrated");
    assert.equal(result.landing?.status, "landed");
    assert.ok(result.landing?.appliedPaths?.includes("index.html"));
    assert.ok(result.landing?.appliedPaths?.includes("about.html"));

    // ── Verify files exist ──
    const indexContent = await readFile(join(sourceDir, "index.html"), "utf8");
    assert.ok(indexContent.includes("Index"));
    const aboutContent = await readFile(join(sourceDir, "about.html"), "utf8");
    assert.ok(aboutContent.includes("About"));

  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

// ── Regression test: absolute source paths rewritten to worker paths ────────

test("regression: absolute source path aliases are rewritten to worker paths", async () => {
  const artifactDir = await mkTmp("pi-regression-abs-path-art-");
  const sourceDir = await mkTmp("pi-regression-abs-path-src-");
  const aliasDir = await mkTmp("pi-regression-abs-path-alias-");
  const sourceAlias = join(aliasDir, "workspace");

  try {
    await symlink(sourceDir, sourceAlias, "dir");
    // Initialize Git repo
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "base.txt"), "base content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "initial"], sourceDir);

    const originalHead = await git(["rev-parse", "HEAD"], sourceDir);
    const originalIndex = await git(["diff", "--cached", "--binary"], sourceDir);

    // This executor deliberately writes the absolute target extracted from
    // the prompt, reproducing the archived worker's behavior exactly.
    const result = await executeWave({
      cwd: sourceAlias,
      tasks: [
        {
          title: "Create index.html",
          instructions: `Create a file at ${sourceAlias}/index.html with HTML content.`,
          acceptanceCriteria: [`${sourceAlias}/index.html exists`],
        },
        {
          title: "Create about.html",
          instructions: `Create a file at ${sourceAlias}/about.html with HTML content.`,
          acceptanceCriteria: [`${sourceAlias}/about.html exists`],
        },
      ],
      config: makeConfigWithPromptTargetWriter(sourceDir),
      artifactDir,
      waveId: "regression-abs-path",
    });

    // ── Verify tasks completed (not no_changes) ──
    assert.equal(result.taskResults.length, 2);
    for (const tr of result.taskResults) {
      assert.ok(
        tr.status === "completed_unreviewed" || tr.status === "accepted",
        `Task ${tr.taskId} should be completed, got ${tr.status}`,
      );
    }

    // ── Verify integration is integrated (not no_changes) ──
    assert.equal(result.integration?.status, "integrated");
    assert.ok(result.integration?.workerMappings?.length === 2);

    // ── Verify landing is landed with applied paths ──
    assert.equal(result.landing?.status, "landed");
    assert.ok(result.landing?.appliedPaths?.includes("index.html"));
    assert.ok(result.landing?.appliedPaths?.includes("about.html"));

    // The fake executor exits before writing if either source target exists,
    // proving the source stayed untouched until guarded landing.
    const currentHead = await git(["rev-parse", "HEAD"], sourceDir);
    const currentIndex = await git(["diff", "--cached", "--binary"], sourceDir);
    assert.equal(currentHead, originalHead, "Source HEAD should be unchanged");
    assert.equal(currentIndex, originalIndex, "Source index should be unchanged");

    // ── Verify files exist in source after landing ──
    const indexContent = await readFile(join(sourceDir, "index.html"), "utf8");
    assert.equal(indexContent, "<h1>index.html</h1>\n");

    // ── Verify candidate trees show files were created in worker roots ──
    const manifestPath = join(result.waveRoot, "wave-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.integrationStatus, "integrated");
    assert.ok(manifest.tasks[0].candidateCommitSha, "Task 0 should have candidateCommitSha");
    assert.ok(manifest.tasks[1].candidateCommitSha, "Task 1 should have candidateCommitSha");
    await gitInRepo(["cat-file", "-e", `${manifest.tasks[0].candidateCommitSha}:index.html`], manifest.repositoryPath);
    await gitInRepo(["cat-file", "-e", `${manifest.tasks[1].candidateCommitSha}:about.html`], manifest.repositoryPath);

  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
    await rm(aliasDir, { recursive: true, force: true });
  }
});

// ── Unit test: rewriteSourcePaths boundary-safe rewriting ────────────────────

test("rewriteSourcePaths: boundary-safe rewriting does not match similar prefixes", async () => {
  const { rewriteSourcePaths } = await import("../src/execution/wave-worker");

  const sourceRoot = "/Users/robert/git/repo";
  const workerRoot = "/tmp/wave-abc/workers/task-0";

  // Exact source root should be rewritten
  assert.equal(
    rewriteSourcePaths("Create file at /Users/robert/git/repo/index.html", sourceRoot, workerRoot),
    "Create file at /tmp/wave-abc/workers/task-0/index.html",
  );

  // Similar prefix should NOT be rewritten
  assert.equal(
    rewriteSourcePaths("Create file at /Users/robert/git/repo-other/index.html", sourceRoot, workerRoot),
    "Create file at /Users/robert/git/repo-other/index.html",
  );

  // A matching suffix inside a different absolute path is not the source root.
  assert.equal(
    rewriteSourcePaths("Edit /mnt/Users/robert/git/repo/a.html", sourceRoot, workerRoot),
    "Edit /mnt/Users/robert/git/repo/a.html",
  );

  // Multiple occurrences should all be rewritten
  assert.equal(
    rewriteSourcePaths("Edit /Users/robert/git/repo/a.html and /Users/robert/git/repo/b.html", sourceRoot, workerRoot),
    "Edit /tmp/wave-abc/workers/task-0/a.html and /tmp/wave-abc/workers/task-0/b.html",
  );

  // Source root at end of string should be rewritten
  assert.equal(
    rewriteSourcePaths("Work in /Users/robert/git/repo", sourceRoot, workerRoot),
    "Work in /tmp/wave-abc/workers/task-0",
  );

  // Nested paths should be rewritten
  assert.equal(
    rewriteSourcePaths("Edit /Users/robert/git/repo/src/lib/util.ts", sourceRoot, workerRoot),
    "Edit /tmp/wave-abc/workers/task-0/src/lib/util.ts",
  );

  // No source root in text should be unchanged
  assert.equal(
    rewriteSourcePaths("Create a new file", sourceRoot, workerRoot),
    "Create a new file",
  );

  // Either path separator is accepted in task text.
  assert.equal(
    rewriteSourcePaths(String.raw`Edit C:\repo\src/file.ts`, String.raw`C:\repo`, String.raw`D:\wave\task-0`),
    String.raw`Edit D:\wave\task-0\src/file.ts`,
  );
});

// ── Unit test: rewriteSourcePaths nested CWD mapping ────────────────────────

test("rewriteSourcePaths: nested CWD mapping preserves relative structure", async () => {
  const { rewriteSourcePaths } = await import("../src/execution/wave-worker");

  // Simulate a nested CWD: source root is /repo, but cwd is /repo/src
  // The worker root should be /wave/workers/task-0
  // The effective cwd should be /wave/workers/task-0/src
  const sourceRoot = "/Users/robert/git/repo";
  const workerRoot = "/tmp/wave-abc/workers/task-0";

  // Paths in the nested CWD should be rewritten correctly
  assert.equal(
    rewriteSourcePaths("Edit /Users/robert/git/repo/src/index.ts", sourceRoot, workerRoot),
    "Edit /tmp/wave-abc/workers/task-0/src/index.ts",
  );

  // The source root itself should be rewritten
  assert.equal(
    rewriteSourcePaths("CWD is /Users/robert/git/repo/src", sourceRoot, workerRoot),
    "CWD is /tmp/wave-abc/workers/task-0/src",
  );
});

// ── Unit test: rewriteSourcePaths on correction feedback ────────────────────

test("correction feedback paths are rewritten and isolation remains authoritative", async () => {
  const { buildWaveWorkerContinuationPrompt } = await import("../src/execution/wave-worker");

  const sourceRoot = "/Users/robert/git/testworld2";
  const workerRoot = "/tmp/wave-xyz/workers/task-0";

  // Simulate correction feedback containing source absolute paths
  const feedback = [
    "Review found issues:",
    "- File /Users/robert/git/testworld2/index.html has a bug on line 5",
    "- Please fix /Users/robert/git/testworld2/src/app.ts",
  ].join("\n");

  const rewritten = buildWaveWorkerContinuationPrompt(feedback, sourceRoot, workerRoot);

  assert.ok(
    !rewritten.includes(sourceRoot),
    "Rewritten feedback should not contain source root",
  );
  assert.ok(
    rewritten.includes(workerRoot + "/index.html"),
    "Rewritten feedback should contain worker path for index.html",
  );
  assert.ok(
    rewritten.includes(workerRoot + "/src/app.ts"),
    "Rewritten feedback should contain worker path for src/app.ts",
  );
  assert.ok(
    rewritten.lastIndexOf("Workspace isolation (authoritative)") > rewritten.lastIndexOf("src/app.ts"),
    "the isolation directive must follow correction text",
  );
});

// ── Regression test: executor PWD matches actual cwd ────────────────────────

test("regression: executor subprocess PWD matches actual cwd", async () => {
  const artifactDir = await mkTmp("pi-regression-pwd-art-");
  const sourceDir = await mkTmp("pi-regression-pwd-src-");

  try {
    // Initialize Git repo
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "base.txt"), "base content\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "initial"], sourceDir);

    // Build a fake executor that reports its PWD.
    const result = await executeWave({
      cwd: sourceDir,
      tasks: [
        {
          title: "Check PWD",
          instructions: "Check the working directory.",
          acceptanceCriteria: ["PWD is correct"],
        },
      ],
      config: {
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
          activeExecutor: { source: "external", id: "pwd-checker" },
          externalExecutors: [
            {
              id: "pwd-checker",
              adapter: "run-as-binary",
              protocol: "pi-review-executor-jsonl-v1",
              command: process.execPath,
              args: [
                "-e",
                [
                  "process.stdin.resume();",
                  "process.stdin.on('end',()=>{",
                  '  const pwd=process.env.PWD;',
                  '  const cwd=process.cwd();',
                  // Write PWD to a file in cwd for verification
                  '  const fs=require("fs");',
                  '  fs.writeFileSync(cwd+"/pwd-output.txt", pwd+"\\n"+cwd+"\\n");',
                  '  process.stdout.write(JSON.stringify({type:"session",sessionId:"fake"})+"\\n");',
                  '  process.stdout.write(JSON.stringify({type:"assistant",text:"PWD: "+pwd})+"\\n");',
                  "  process.exit(0);",
                  "});",
                ].join(""),
              ],
              timeoutMs: 15000,
            },
          ],
        },
      },
      artifactDir,
      waveId: "regression-pwd",
    });

    // ── Verify task completed ──
    assert.equal(result.taskResults.length, 1);
    assert.ok(
      result.taskResults[0].status === "completed_unreviewed" || result.taskResults[0].status === "accepted",
      `Task should be completed, got ${result.taskResults[0].status}`,
    );

    // ── Verify PWD is NOT the source directory ──
    // The PWD should be the worker worktree, not the source.
    // We can verify this by checking the pwd-output.txt in the candidate tree.
    assert.equal(result.integration?.status, "integrated");
    assert.equal(result.landing?.status, "landed");
    assert.ok(result.landing?.appliedPaths?.includes("pwd-output.txt"));

    // Read the PWD output from the source (after landing)
    const pwdOutput = await readFile(join(sourceDir, "pwd-output.txt"), "utf8");
    const lines = pwdOutput.trim().split("\n");
    const pwdEnv = lines[0];
    const cwdActual = lines[1];

    // PWD should match actual cwd
    assert.equal(pwdEnv, cwdActual, "PWD env should match actual cwd");

    // PWD should NOT be the source directory
    assert.notEqual(pwdEnv, sourceDir, "PWD should not be the source directory");

  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});
