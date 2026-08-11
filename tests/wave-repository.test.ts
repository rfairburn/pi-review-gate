import assert from "node:assert/strict";
import { execFile, execSync } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  captureWaveBase,
  discoverWaveSource,
  enumerateWaveSourcePaths,
} from "../src/execution/wave-repository";

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
  return stdout;
}

async function gitInRepo(args: string[], repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    env: { ...process.env, ...GIT_ENV, GIT_DIR: repoPath },
  });
  return stdout.trim();
}

async function mkTmp(prefix: string): Promise<string> {
  const raw = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(join(tmpdir(), prefix)),
  );
  return realpath(raw);
}

// ── Discovery tests ─────────────────────────────────────────────────────────

test("discoverWaveSource — committed repo", async () => {
  const dir = await mkTmp("pi-wg-committed-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "readme.md"), "# hello\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const result = await discoverWaveSource(dir);

    assert.equal(result.sourceType, "git-committed");
    assert.equal(result.isGit, true);
    assert.equal(result.gitTopLevel, dir);
    assert.equal(result.captureRoot, dir);
    assert.equal(result.relativeCwd, ".");
    assert.equal(result.headUnborn, false);
    assert.ok(result.headCommit, "should have a HEAD commit");
    assert.ok(result.headCommit!.length === 40, "commit should be 40 hex chars");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverWaveSource — unborn repo", async () => {
  const dir = await mkTmp("pi-wg-unborn-");
  try {
    await git(["init", "--quiet"], dir);

    const result = await discoverWaveSource(dir);

    assert.equal(result.sourceType, "git-unborn");
    assert.equal(result.isGit, true);
    assert.equal(result.headUnborn, true);
    assert.equal(result.headCommit, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverWaveSource — non-Git directory", async () => {
  const dir = await mkTmp("pi-wg-nongit-");
  try {
    await writeFile(join(dir, "data.txt"), "plain\n", "utf8");

    const result = await discoverWaveSource(dir);

    assert.equal(result.sourceType, "non-git");
    assert.equal(result.isGit, false);
    assert.equal(result.headCommit, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: basic committed Git source ─────────────────────────────────────

test("capture — committed Git source produces base commit with parent", async () => {
  const dir = await mkTmp("pi-cb-committed-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "readme.md"), "# hello\n", "utf8");
    await writeFile(join(dir, "app.js"), "console.log('hi');\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-committed",
    });

    assert.equal(result.waveId, "test-committed");
    assert.ok(result.repositoryPath);
    assert.ok(result.baseCommit);
    assert.equal(result.baseRef, "refs/pi-review-gate/waves/test-committed/base");
    assert.equal(result.discovery.sourceType, "git-committed");
    assert.ok(result.entries.length >= 2, "should have at least readme.md and app.js");
    assert.ok(result.totalBytes > 0);

    // Verify the ref is pinned.
    const refSha = await gitInRepo(["rev-parse", result.baseRef], result.repositoryPath);
    assert.equal(refSha, result.baseCommit);

    // Verify the base commit has a parent (the source HEAD).
    const parentSha = await gitInRepo(["rev-parse", `${result.baseCommit}^`], result.repositoryPath);
    assert.equal(parentSha, result.discovery.headCommit, "parent should be source HEAD");

    // Verify the tree contains the expected files.
    const treePaths = await gitInRepo(
      ["ls-tree", "-r", "--name-only", result.baseCommit],
      result.repositoryPath,
    );
    const paths = treePaths.split("\n").filter(Boolean);
    assert.ok(paths.includes("readme.md"), "tree should contain readme.md");
    assert.ok(paths.includes("app.js"), "tree should contain app.js");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: unborn Git source (root commit) ────────────────────────────────

test("capture — unborn Git source produces root commit", async () => {
  const dir = await mkTmp("pi-cb-unborn-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "init.txt"), "init\n", "utf8");
    await git(["add", "."], dir);
    // No commit — unborn.

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-unborn",
    });

    assert.equal(result.discovery.sourceType, "git-unborn");
    assert.ok(result.baseCommit);

    // Verify it's a root commit (no parent).
    try {
      await gitInRepo(["rev-parse", `${result.baseCommit}^`], result.repositoryPath);
      assert.fail("should have no parent");
    } catch {
      // Expected — no parent for root commit.
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: non-Git source (root commit) ───────────────────────────────────

test("capture — non-Git source produces root commit", async () => {
  const dir = await mkTmp("pi-cb-nongit-");
  try {
    await writeFile(join(dir, "data.txt"), "data\n", "utf8");
    await writeFile(join(dir, "config.json"), "{}\n", "utf8");

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-nongit",
    });

    assert.equal(result.discovery.sourceType, "non-git");
    assert.ok(result.baseCommit);

    // Verify root commit.
    try {
      await gitInRepo(["rev-parse", `${result.baseCommit}^`], result.repositoryPath);
      assert.fail("should have no parent");
    } catch {
      // Expected.
    }

    // Verify tree contents.
    const treePaths = await gitInRepo(
      ["ls-tree", "-r", "--name-only", result.baseCommit],
      result.repositoryPath,
    );
    const paths = treePaths.split("\n").filter(Boolean);
    assert.ok(paths.includes("data.txt"));
    assert.ok(paths.includes("config.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: dirty working-tree bytes override index bytes ──────────────────

test("capture — dirty working-tree bytes override index bytes", async () => {
  const dir = await mkTmp("pi-cb-dirty-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "original\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Modify the file (dirty working tree).
    await writeFile(join(dir, "file.txt"), "modified content\n", "utf8");

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-dirty",
    });

    // Get the blob content from the captured repo.
    const fileEntry = result.entries.find((e) => e.path === "file.txt");
    assert.ok(fileEntry, "file.txt should be in entries");

    // Read raw blob bytes to preserve trailing newline.
    const blobContent = await readFile(
      join(result.repositoryPath, "objects", fileEntry.blobId.slice(0, 2), fileEntry.blobId.slice(2)),
    );
    // Decompress: git stores blobs as zlib-compressed.
    const { inflateSync } = await import("zlib");
    const decompressed = inflateSync(blobContent);
    // Skip the header (e.g., "blob 17\0") to get raw content.
    const nullIdx = decompressed.indexOf(0);
    const rawContent = decompressed.slice(nullIdx + 1).toString("utf8");
    assert.equal(rawContent, "modified content\n", "should capture dirty bytes, not index bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: staged-new and untracked inclusion ─────────────────────────────

test("capture — staged-new file is included", async () => {
  const dir = await mkTmp("pi-cb-staged-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "existing.txt"), "existing\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Stage a new file (not committed).
    await writeFile(join(dir, "staged.txt"), "staged\n", "utf8");
    await git(["add", "staged.txt"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-staged",
    });

    assert.ok(result.entries.find((e) => e.path === "staged.txt"), "staged file should be included");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — untracked file is included", async () => {
  const dir = await mkTmp("pi-cb-untracked-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "tracked.txt"), "tracked\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Create an untracked file.
    await writeFile(join(dir, "untracked.txt"), "untracked\n", "utf8");

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-untracked",
    });

    assert.ok(result.entries.find((e) => e.path === "untracked.txt"), "untracked file should be included");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: tracked deletion ───────────────────────────────────────────────

test("capture — tracked deletion is represented (file omitted from tree)", async () => {
  const dir = await mkTmp("pi-cb-deleted-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "keep.txt"), "keep\n", "utf8");
    await writeFile(join(dir, "delete-me.txt"), "delete\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Delete the file from the working tree.
    await rm(join(dir, "delete-me.txt"));

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-deleted",
    });

    // delete-me.txt should NOT be in the entries (omitted because absent from filesystem).
    assert.ok(
      !result.entries.find((e) => e.path === "delete-me.txt"),
      "deleted file should be omitted from tree",
    );
    assert.ok(
      result.entries.find((e) => e.path === "keep.txt"),
      "kept file should be in tree",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: ignored exclusion ──────────────────────────────────────────────

test("capture — ignored file is excluded", async () => {
  const dir = await mkTmp("pi-cb-ignored-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, ".gitignore"), "*.log\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Create an ignored file.
    await writeFile(join(dir, "debug.log"), "ignored\n", "utf8");

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-ignored",
    });

    assert.ok(
      !result.entries.find((e) => e.path === "debug.log"),
      "ignored file should be excluded",
    );
    assert.ok(
      result.entries.find((e) => e.path === ".gitignore"),
      ".gitignore itself should be included",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: binary bytes ───────────────────────────────────────────────────

test("capture — binary content is captured correctly", async () => {
  const dir = await mkTmp("pi-cb-binary-");
  try {
    await git(["init", "--quiet"], dir);
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80]);
    await writeFile(join(dir, "binary.bin"), binaryData);
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-binary",
    });

    const fileEntry = result.entries.find((e) => e.path === "binary.bin");
    assert.ok(fileEntry, "binary.bin should be in entries");
    assert.equal(fileEntry.size, 6, "size should be 6 bytes");
    assert.equal(fileEntry.mode, "100644");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: executable mode ────────────────────────────────────────────────

test("capture — executable mode is preserved", async () => {
  const dir = await mkTmp("pi-cb-exec-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "script.sh"), "#!/bin/sh\necho hi\n", "utf8");
    // Make it executable.
    await chmod(join(dir, "script.sh"), 0o755);
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-exec",
    });

    const fileEntry = result.entries.find((e) => e.path === "script.sh");
    assert.ok(fileEntry, "script.sh should be in entries");
    assert.equal(fileEntry.mode, "100755", "executable file should have mode 100755");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: symlink mode/target ────────────────────────────────────────────

test("capture — symlink mode and target are preserved", async () => {
  const dir = await mkTmp("pi-cb-symlink-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "target.txt"), "target content\n", "utf8");
    await symlink("target.txt", join(dir, "link.txt"));
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-symlink",
    });

    const linkEntry = result.entries.find((e) => e.path === "link.txt");
    assert.ok(linkEntry, "link.txt should be in entries");
    assert.equal(linkEntry.mode, "120000", "symlink should have mode 120000");

    // Verify the blob content is the symlink target.
    const blobContent = await gitInRepo(
      ["cat-file", "-p", linkEntry.blobId],
      result.repositoryPath,
    );
    assert.equal(blobContent, "target.txt", "blob should contain symlink target");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: parent relation for committed Git ──────────────────────────────

test("capture — parent relation for committed Git source", async () => {
  const dir = await mkTmp("pi-cb-parent-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);
    const sourceHead = (await git(["rev-parse", "HEAD"], dir)).trim();

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-parent",
    });

    // Verify the base commit's parent is the source HEAD.
    const parentSha = await gitInRepo(
      ["rev-parse", `${result.baseCommit}^`],
      result.repositoryPath,
    );
    assert.equal(parentSha, sourceHead, "parent should be source HEAD");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: size-limit failure ─────────────────────────────────────────────

test("capture — tracked files are always captured regardless of size limit", async () => {
  const dir = await mkTmp("pi-cb-size-");
  try {
    await git(["init", "--quiet"], dir);
    const bigData = Buffer.alloc(1024, "x");
    await writeFile(join(dir, "big.bin"), bigData);
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 100,
      waveId: "test-tracked-size",
    });

    assert.equal(result.entries.find((entry) => entry.path === "big.bin")?.size, bigData.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — staged files are always captured regardless of size limit", async () => {
  const dir = await mkTmp("pi-cb-staged-size-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "base.txt"), "base\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const bigData = Buffer.alloc(1024, "s");
    await writeFile(join(dir, "staged.bin"), bigData);
    await git(["add", "staged.bin"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 100,
      waveId: "test-staged-size",
    });

    assert.equal(result.entries.find((entry) => entry.path === "staged.bin")?.size, bigData.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — untracked size-limit failure rejects explicitly", async () => {
  const dir = await mkTmp("pi-cb-untracked-size-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "tracked.txt"), "tracked\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const bigData = Buffer.alloc(1024, "u");
    await writeFile(join(dir, "untracked.bin"), bigData);

    await assert.rejects(
      captureWaveBase({
        cwd: dir,
        maxSnapshotBytes: 100,
        waveId: "test-untracked-size",
      }),
      /Snapshot size limit exceeded for untracked files.*untracked\.bin/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: unsupported entries fail ───────────────────────────────────────

test("capture — unsupported entry type fails explicitly", async () => {
  const dir = await mkTmp("pi-cb-unsupported-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Create a FIFO (named pipe) which is unsupported.
    execSync(`mkfifo "${join(dir, "myfifo")}"`, { env: { ...process.env, ...GIT_ENV } });

    // Hash a dummy blob to get a valid SHA for the cacheinfo entry.
    const tmpFile = join(dir, ".dummy-for-sha");
    await writeFile(tmpFile, "dummy");
    const { stdout: dummySha } = await execFileAsync("git", ["hash-object", "-w", tmpFile], {
      cwd: dir,
      env: { ...process.env, ...GIT_ENV },
    });
    await rm(tmpFile);

    // Add the FIFO to the index using cacheinfo so it appears in enumeration.
    await git(["update-index", "--add", "--cacheinfo", "100755", dummySha.trim(), "myfifo"], dir);

    await assert.rejects(
      captureWaveBase({
        cwd: dir,
        maxSnapshotBytes: 1_000_000,
        waveId: "test-unsupported",
      }),
      /Unsupported entry type/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: source worktree/index/HEAD remain untouched ─────────────────────

test("capture — source worktree, index, and HEAD remain untouched", async () => {
  const dir = await mkTmp("pi-cb-untouched-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Record state before capture.
    const beforeHead = await git(["rev-parse", "HEAD"], dir);
    const beforeStatus = await git(["status", "--porcelain"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-untouched",
    });

    // Verify source HEAD unchanged.
    const afterHead = await git(["rev-parse", "HEAD"], dir);
    assert.equal(afterHead.trim(), beforeHead.trim(), "HEAD should be unchanged");

    // Verify working tree still clean.
    const afterStatus = await git(["status", "--porcelain"], dir);
    assert.equal(afterStatus.trim(), beforeStatus.trim(), "working tree should be unchanged");

    // Verify the private repo is NOT in the source directory.
    assert.ok(!result.repositoryPath.startsWith(dir), "private repo should not be in source dir");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: waveId generation ──────────────────────────────────────────────

test("capture — waveId is generated when omitted", async () => {
  const dir = await mkTmp("pi-cb-waveid-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
    });

    assert.ok(result.waveId, "waveId should be generated");
    assert.ok(result.waveId.length > 0, "waveId should not be empty");
    assert.ok(result.baseRef.includes(result.waveId), "baseRef should contain waveId");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: artifactDir usage ──────────────────────────────────────────────

test("capture — artifactDir is used as parent for wave root", async () => {
  const dir = await mkTmp("pi-cb-artifact-");
  const artifactDir = await mkTmp("pi-cb-artifact-root-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-artifact",
      artifactDir,
    });

    // waveRoot should be a child directory under artifactDir.
    assert.ok(result.waveRoot.startsWith(artifactDir), "waveRoot should be under artifactDir");
    assert.notEqual(result.waveRoot, artifactDir, "waveRoot should not equal artifactDir");
    assert.ok(result.repositoryPath.startsWith(result.waveRoot), "repo should be under waveRoot");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Capture: provenance completeness ────────────────────────────────────────

test("capture — provenance includes all required fields", async () => {
  const dir = await mkTmp("pi-cb-provenance-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "a.txt"), "a\n", "utf8");
    await writeFile(join(dir, "b.txt"), "b\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-provenance",
    });

    // Check all required fields.
    assert.ok(result.waveId, "waveId");
    assert.ok(result.repositoryPath, "repositoryPath");
    assert.ok(result.waveRoot, "waveRoot");
    assert.ok(result.baseCommit, "baseCommit");
    assert.ok(result.baseRef, "baseRef");
    assert.ok(result.discovery, "discovery");
    assert.ok(Array.isArray(result.entries), "entries");
    assert.ok(typeof result.totalBytes === "number", "totalBytes");
    assert.ok(Array.isArray(result.paths), "paths");

    // Check entry structure.
    for (const entry of result.entries) {
      assert.ok(entry.path, "entry.path");
      assert.ok(["100644", "100755", "120000"].includes(entry.mode), `entry.mode: ${entry.mode}`);
      assert.ok(entry.blobId, "entry.blobId");
      assert.ok(typeof entry.size === "number", "entry.size");
    }

    // Check paths match entries.
    assert.equal(result.paths.length, result.entries.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: empty source ──────────────────────────────────────────────────

test("capture — empty source produces valid root commit with empty tree", async () => {
  const dir = await mkTmp("pi-cb-empty-");
  try {
    await git(["init", "--quiet"], dir);
    // No files at all.

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-empty",
    });

    assert.ok(result.baseCommit);
    assert.deepEqual(result.entries, [], "should have no entries");
    assert.equal(result.totalBytes, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: nested directory structure ─────────────────────────────────────

test("capture — nested directory structure is preserved in tree", async () => {
  const dir = await mkTmp("pi-cb-nested-");
  try {
    await git(["init", "--quiet"], dir);
    await mkdir(join(dir, "a", "b", "c"), { recursive: true });
    await writeFile(join(dir, "a", "b", "c", "deep.txt"), "deep\n", "utf8");
    await writeFile(join(dir, "a", "top.txt"), "top\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-nested",
    });

    const treePaths = await gitInRepo(
      ["ls-tree", "-r", "--name-only", result.baseCommit],
      result.repositoryPath,
    );
    const paths = treePaths.split("\n").filter(Boolean);
    assert.ok(paths.includes("a/b/c/deep.txt"), "deep file should be in tree");
    assert.ok(paths.includes("a/top.txt"), "top file should be in tree");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Capture: special filenames (newlines) ────────────────────────────────────

test("capture — filenames with newlines are handled correctly", async () => {
  const dir = await mkTmp("pi-cb-newline-");
  try {
    await git(["init", "--quiet"], dir);
    const weirdName = "line1\nline2.txt";
    await writeFile(join(dir, weirdName), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-newline",
    });

    // Verify the file is in the tree.
    const entry = result.entries.find((e) => e.path === weirdName);
    assert.ok(entry, "file with newline in name should be in entries");

    // Verify via ls-tree with -z delimiter.
    const { stdout } = await execFileAsync("git", ["ls-tree", "-r", "-z", "--name-only", result.baseCommit], {
      cwd: result.repositoryPath,
      env: { ...process.env, ...GIT_ENV, GIT_DIR: result.repositoryPath },
    });
    const paths = stdout.split("\0").filter(Boolean);
    assert.ok(paths.includes(weirdName), "file with newline should be in tree");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Validation: invalid maxSnapshotBytes ────────────────────────────────────

test("capture — rejects negative maxSnapshotBytes", async () => {
  const dir = await mkTmp("pi-cb-invalid-size-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: -1 }),
      /Invalid maxSnapshotBytes/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — rejects NaN maxSnapshotBytes", async () => {
  const dir = await mkTmp("pi-cb-invalid-nan-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: NaN }),
      /Invalid maxSnapshotBytes/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — rejects Infinity maxSnapshotBytes", async () => {
  const dir = await mkTmp("pi-cb-invalid-inf-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: Infinity }),
      /Invalid maxSnapshotBytes/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — rejects non-integer maxSnapshotBytes", async () => {
  const dir = await mkTmp("pi-cb-invalid-float-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 100.5 }),
      /Invalid maxSnapshotBytes/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Validation: invalid waveId ──────────────────────────────────────────────

test("capture — rejects waveId with slash", async () => {
  const dir = await mkTmp("pi-cb-invalid-waveid-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, waveId: "bad/id" }),
      /Invalid waveId/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — rejects waveId with dots", async () => {
  const dir = await mkTmp("pi-cb-invalid-waveid-dots-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, waveId: ".." }),
      /Invalid waveId/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — rejects waveId with git-forbidden characters", async () => {
  const dir = await mkTmp("pi-cb-invalid-waveid-git-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    // ~ is forbidden by git check-ref-format.
    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, waveId: "a~b" }),
      /Invalid waveId/,
    );

    // : is forbidden.
    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, waveId: "a:b" }),
      /Invalid waveId/,
    );

    // ^ is forbidden.
    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, waveId: "a^b" }),
      /Invalid waveId/,
    );

    // @ is forbidden.
    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, waveId: "@" }),
      /Invalid waveId/,
    );

    // Leading dot is forbidden.
    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, waveId: ".hidden" }),
      /Invalid waveId/,
    );

    // Trailing .lock is forbidden.
    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, waveId: "a.lock" }),
      /Invalid waveId/,
    );

    // Single dot is forbidden.
    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, waveId: "." }),
      /Invalid waveId/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — rejects empty waveId", async () => {
  const dir = await mkTmp("pi-cb-invalid-waveid-empty-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, waveId: "" }),
      /Invalid waveId/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Cleanup: failure removes wave root under artifactDir ────────────────────

test("capture — failure after wave-root creation cleans up wave root", async () => {
  const dir = await mkTmp("pi-cb-cleanup-");
  const artifactDir = await mkTmp("pi-cb-cleanup-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "tracked.txt"), "tracked\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Create an untracked file larger than the limit.
    const bigData = Buffer.alloc(1024, "x");
    await writeFile(join(dir, "big.bin"), bigData);

    await assert.rejects(
      captureWaveBase({
        cwd: dir,
        maxSnapshotBytes: 100,
        waveId: "test-cleanup",
        artifactDir,
      }),
      /Snapshot size limit exceeded for untracked files/,
    );

    // Verify the wave root was cleaned up — no leftover directories in artifactDir.
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(artifactDir));
    assert.equal(entries.length, 0, "artifactDir should be empty after cleanup");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Actual-byte accounting ──────────────────────────────────────────────────

test("capture — totalBytes reflects actual file bytes, not stale stat", async () => {
  const dir = await mkTmp("pi-cb-actualbytes-");
  try {
    await git(["init", "--quiet"], dir);
    // Write a file with known content.
    const content = "hello world\n";
    await writeFile(join(dir, "file.txt"), content, "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-actualbytes",
    });

    // totalBytes should equal the actual byte length of the file content.
    const expectedBytes = Buffer.byteLength(content, "utf8");
    assert.equal(result.totalBytes, expectedBytes, "totalBytes should match actual file bytes");

    // The entry size should also match.
    const entry = result.entries.find((e) => e.path === "file.txt");
    assert.ok(entry, "file.txt should be in entries");
    assert.equal(entry.size, expectedBytes, "entry.size should match actual bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Validation: artifactDir safety ──────────────────────────────────────────

test("capture — rejects empty artifactDir", async () => {
  const dir = await mkTmp("pi-cb-artifact-empty-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, artifactDir: "" }),
      /Invalid artifactDir/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — rejects artifactDir inside source tree", async () => {
  const dir = await mkTmp("pi-cb-artifact-inside-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // artifactDir pointing inside the source tree should be rejected.
    await assert.rejects(
      captureWaveBase({
        cwd: dir,
        maxSnapshotBytes: 1_000_000,
        artifactDir: join(dir, "artifacts"),
      }),
      /Invalid artifactDir/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — rejects artifactDir symlink pointing inside source tree", async () => {
  const dir = await mkTmp("pi-cb-artifact-symlink-");
  const outsideDir = await mkTmp("pi-cb-artifact-symlink-outside-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Create a symlink outside the source that points inside it.
    const linkPath = join(outsideDir, "link-to-source");
    await symlink(dir, linkPath);

    // The symlink resolves inside the source tree and should be rejected.
    await assert.rejects(
      captureWaveBase({
        cwd: dir,
        maxSnapshotBytes: 1_000_000,
        artifactDir: linkPath,
      }),
      /Invalid artifactDir/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

// ── Torn-snapshot detection: retry on mid-capture mutation ──────────────────

// Import the test seam and error class.
import * as waveRepo from "../src/execution/wave-repository";
const WaveCaptureError = waveRepo.WaveCaptureError;
// Cast to allow mutation of the test seam (TypeScript treats namespace imports as read-only).
const waveRepoMutable = waveRepo as unknown as { __testOnly_mutateSourceBetweenCaptureAndVerify: ((d: any, e: any) => Promise<void> | void) | undefined };

test("capture — one-time mid-capture mutation causes retry and succeeds", async () => {
  const dir = await mkTmp("pi-cb-retry-");
  const artifactDir = await mkTmp("pi-cb-retry-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "original\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    let mutationCount = 0;
    waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = async (discovery) => {
      mutationCount += 1;
      if (mutationCount === 1) {
        // Mutate on first attempt only — second attempt should see stable source.
        await writeFile(join(dir, "file.txt"), "mutated\n", "utf8");
      }
    };

    try {
      const result = await captureWaveBase({
        cwd: dir,
        maxSnapshotBytes: 1_000_000,
        waveId: "test-retry",
        artifactDir,
      });

      // Should have succeeded on second attempt with the mutated content.
      assert.equal(result.waveId, "test-retry");
      assert.ok(result.entries.find((e) => e.path === "file.txt"));

      // Verify the captured content is the mutated version.
      const fileEntry = result.entries.find((e) => e.path === "file.txt")!;
      const blobContent = await gitInRepo(
        ["cat-file", "-p", fileEntry.blobId],
        result.repositoryPath,
      );
      // git cat-file -p strips trailing newlines from output.
      assert.equal(blobContent, "mutated", "should capture the mutated content");
    } finally {
      waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = undefined;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("capture — continuous mutation exhausts retries with classified error", async () => {
  const dir = await mkTmp("pi-cb-exhaust-");
  const artifactDir = await mkTmp("pi-cb-exhaust-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "v1\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    let version = 1;
    waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = async () => {
      version += 1;
      await writeFile(join(dir, "file.txt"), `v${version}\n`, "utf8");
    };

    try {
      await assert.rejects(
        captureWaveBase({
          cwd: dir,
          maxSnapshotBytes: 1_000_000,
          waveId: "test-exhaust",
          artifactDir,
          maxCaptureAttempts: 2,
        }),
        (err: unknown) => {
          assert.ok(err instanceof waveRepo.WaveCaptureError, "should be WaveCaptureError");
          assert.equal((err as waveRepo.WaveCaptureError).code, "workspace_changing_during_capture");
          return true;
        },
      );

      // Verify no wave roots leaked in artifactDir.
      const entries = await import("node:fs/promises").then((fs) => fs.readdir(artifactDir));
      assert.equal(entries.length, 0, "artifactDir should be empty — no leaked wave roots");
    } finally {
      waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = undefined;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("capture — abort during verification cancels immediately and removes artifacts", async () => {
  const dir = await mkTmp("pi-cb-abort-");
  const artifactDir = await mkTmp("pi-cb-abort-artifact-");
  const controller = new AbortController();
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = () => {
      controller.abort();
    };
    try {
      await assert.rejects(
        captureWaveBase({
          cwd: dir,
          maxSnapshotBytes: 1_000_000,
          waveId: "test-abort",
          artifactDir,
          signal: controller.signal,
        }),
        (error: unknown) => {
          assert.ok(error instanceof WaveCaptureError);
          assert.equal((error as InstanceType<typeof WaveCaptureError>).code, "cancelled");
          return true;
        },
      );
      const entries = await import("node:fs/promises").then((fs) => fs.readdir(artifactDir));
      assert.deepEqual(entries, [], "cancelled capture should not leak a wave root");
    } finally {
      waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = undefined;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("capture — HEAD drift detected and causes retry", async () => {
  const dir = await mkTmp("pi-cb-head-drift-");
  const artifactDir = await mkTmp("pi-cb-head-drift-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    let headMutated = false;
    waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = async () => {
      if (!headMutated) {
        headMutated = true;
        // Modify existing file and commit to change HEAD (no path-set change).
        await writeFile(join(dir, "file.txt"), "modified\n", "utf8");
        await git(["add", "."], dir);
        await git(["commit", "--quiet", "-m", "second"], dir);
      }
    };

    try {
      const result = await captureWaveBase({
        cwd: dir,
        maxSnapshotBytes: 1_000_000,
        waveId: "test-head-drift",
        artifactDir,
      });

      // Should have succeeded on second attempt.
      assert.equal(result.waveId, "test-head-drift");
    } finally {
      waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = undefined;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("capture — path-set drift detected and causes retry", async () => {
  const dir = await mkTmp("pi-cb-path-drift-");
  const artifactDir = await mkTmp("pi-cb-path-drift-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    let pathMutated = false;
    waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = async () => {
      if (!pathMutated) {
        pathMutated = true;
        // Add a new file to change the path set (one-time only).
        await writeFile(join(dir, "extra.txt"), "extra\n", "utf8");
      }
    };

    try {
      const result = await captureWaveBase({
        cwd: dir,
        maxSnapshotBytes: 1_000_000,
        waveId: "test-path-drift",
        artifactDir,
      });

      // Should have succeeded on second attempt with the extra file.
      assert.equal(result.waveId, "test-path-drift");
      assert.ok(result.entries.find((e) => e.path === "extra.txt"));
    } finally {
      waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = undefined;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("capture — untracked-to-indexed classification drift causes retry", async () => {
  const dir = await mkTmp("pi-cb-classification-drift-");
  const artifactDir = await mkTmp("pi-cb-classification-drift-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "base.txt"), "base\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);
    await writeFile(join(dir, "later-staged.bin"), Buffer.alloc(64, "x"));

    let attempts = 0;
    waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = async () => {
      attempts += 1;
      if (attempts === 1) await git(["add", "later-staged.bin"], dir);
    };

    try {
      const result = await captureWaveBase({
        cwd: dir,
        maxSnapshotBytes: 100,
        waveId: "test-classification-drift",
        artifactDir,
      });

      assert.equal(attempts, 2, "classification change should force a fresh capture");
      assert.equal(result.entries.find((entry) => entry.path === "later-staged.bin")?.size, 64);
    } finally {
      waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = undefined;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("capture — failed attempt repositories are removed; only successful one remains", async () => {
  const dir = await mkTmp("pi-cb-cleanup-retry-");
  const artifactDir = await mkTmp("pi-cb-cleanup-retry-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "original\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    let mutationCount = 0;
    waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = async () => {
      mutationCount += 1;
      if (mutationCount < 3) {
        // Mutate on first two attempts.
        await writeFile(join(dir, "file.txt"), `mutated${mutationCount}\n`, "utf8");
      }
    };

    try {
      const result = await captureWaveBase({
        cwd: dir,
        maxSnapshotBytes: 1_000_000,
        waveId: "test-cleanup-retry",
        artifactDir,
      });

      // Only one wave root should remain (the successful one).
      const entries = await import("node:fs/promises").then((fs) => fs.readdir(artifactDir));
      assert.equal(entries.length, 1, "only one wave root should remain");
      assert.equal(result.waveRoot, join(artifactDir, entries[0]));
    } finally {
      waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = undefined;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Validation: maxCaptureAttempts ──────────────────────────────────────────

test("capture — rejects negative maxCaptureAttempts", async () => {
  const dir = await mkTmp("pi-cb-invalid-attempts-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, maxCaptureAttempts: -1 }),
      /Invalid maxCaptureAttempts/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — rejects zero maxCaptureAttempts", async () => {
  const dir = await mkTmp("pi-cb-invalid-attempts-zero-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, maxCaptureAttempts: 0 }),
      /Invalid maxCaptureAttempts/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — rejects non-integer maxCaptureAttempts", async () => {
  const dir = await mkTmp("pi-cb-invalid-attempts-float-");
  try {
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");

    await assert.rejects(
      captureWaveBase({ cwd: dir, maxSnapshotBytes: 1_000_000, maxCaptureAttempts: 2.5 }),
      /Invalid maxCaptureAttempts/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture — default maxCaptureAttempts is 3", async () => {
  const dir = await mkTmp("pi-cb-default-attempts-");
  const artifactDir = await mkTmp("pi-cb-default-attempts-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "v1\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    let mutationCount = 0;
    waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = async () => {
      mutationCount += 1;
      await writeFile(join(dir, "file.txt"), `v${mutationCount + 1}\n`, "utf8");
    };

    try {
      // With default 3 attempts, continuous mutation should exhaust.
      await assert.rejects(
        captureWaveBase({
          cwd: dir,
          maxSnapshotBytes: 1_000_000,
          artifactDir,
        }),
        (err: unknown) => {
          assert.ok(err instanceof waveRepo.WaveCaptureError);
          assert.equal((err as waveRepo.WaveCaptureError).code, "workspace_changing_during_capture");
          // Should have tried 3 times.
          assert.equal(mutationCount, 3, "should have attempted 3 times");
          return true;
        },
      );
    } finally {
      waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = undefined;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("capture — file-to-directory drift detected and causes retry", async () => {
  const dir = await mkTmp("pi-cb-file-to-dir-");
  const artifactDir = await mkTmp("pi-cb-file-to-dir-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    let mutated = false;
    waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = async () => {
      if (!mutated) {
        mutated = true;
        // Replace file with a directory (still tracked in Git index).
        await rm(join(dir, "file.txt"));
        await mkdir(join(dir, "file.txt"));
      }
    };

    try {
      // First attempt: capture succeeds, verification detects type change, retries.
      // Second attempt: buildTreeFromPaths throws "Unsupported entry type" for the directory.
      // This is a non-consistency error — thrown immediately.
      await assert.rejects(
        captureWaveBase({
          cwd: dir,
          maxSnapshotBytes: 1_000_000,
          waveId: "test-file-to-dir",
          artifactDir,
          maxCaptureAttempts: 2,
        }),
        /Unsupported entry type/,
      );

      // Verify no wave roots leaked.
      const entries = await import("node:fs/promises").then((fs) => fs.readdir(artifactDir));
      assert.equal(entries.length, 0, "artifactDir should be empty — no leaked wave roots");
    } finally {
      waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = undefined;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("capture — unborn-to-committed source identity drift detected", async () => {
  const dir = await mkTmp("pi-cb-unborn-drift-");
  const artifactDir = await mkTmp("pi-cb-unborn-drift-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    // No commit — unborn.

    let mutated = false;
    waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = async () => {
      if (!mutated) {
        mutated = true;
        // Commit to change sourceType from unborn to committed.
        await git(["add", "."], dir);
        await git(["commit", "--quiet", "-m", "init"], dir);
      }
    };

    try {
      const result = await captureWaveBase({
        cwd: dir,
        maxSnapshotBytes: 1_000_000,
        waveId: "test-unborn-drift",
        artifactDir,
      });

      // Should have succeeded on second attempt with committed source.
      assert.equal(result.waveId, "test-unborn-drift");
      assert.equal(result.discovery.sourceType, "git-committed");
    } finally {
      waveRepoMutable.__testOnly_mutateSourceBetweenCaptureAndVerify = undefined;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Security: symlinked ancestor rejection during capture ───────────────────

test("capture — rejects symlinked ancestor directory before reading file bytes", async () => {
  const dir = await mkTmp("pi-cb-sym-ancestor-");
  const outsideDir = await mkTmp("pi-cb-sym-ancestor-outside-");
  const artifactDir = await mkTmp("pi-cb-sym-ancestor-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    // Create a tracked file under a real directory.
    await mkdir(join(dir, "subdir"), { recursive: true });
    await writeFile(join(dir, "subdir", "file.txt"), "original content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Create an outside marker file.
    const markerPath = join(outsideDir, "marker.txt");
    await writeFile(markerPath, "OUTSIDE SECRET DATA\n", "utf8");

    // Replace the real directory with a symlink to the outside directory.
    // The tracked path "subdir/file.txt" now resolves to outside/marker.txt
    // if the symlink is followed.
    await rm(join(dir, "subdir"), { recursive: true, force: true });
    await symlink(outsideDir, join(dir, "subdir"));

    // Capture must reject the symlinked ancestor before reading any bytes.
    // The symlink may be caught either by the ancestor check or by the
    // symlink target validation (absolute target escapes capture root).
    await assert.rejects(
      captureWaveBase({
        cwd: dir,
        maxSnapshotBytes: 1_000_000,
        waveId: "test-sym-ancestor",
        artifactDir,
      }),
      /symbolic link|Symlink.*rejected|escapes capture root/,
    );

    // Verify the outside marker was NOT read.
    const markerContent = await readFile(markerPath, "utf8");
    assert.equal(markerContent, "OUTSIDE SECRET DATA\n", "outside marker must be untouched");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("capture — sourceIdentity is captured with dev and ino", async () => {
  const dir = await mkTmp("pi-cb-identity-");
  const artifactDir = await mkTmp("pi-cb-identity-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-identity",
      artifactDir,
    });

    assert.ok(result.sourceIdentity, "sourceIdentity should be present");
    assert.ok(typeof result.sourceIdentity.dev === "number", "dev should be a number");
    assert.ok(typeof result.sourceIdentity.ino === "number", "ino should be a number");
    assert.ok(result.sourceIdentity.dev > 0, "dev should be positive");
    assert.ok(result.sourceIdentity.ino > 0, "ino should be positive");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("capture — safe in-root relative symlinks continue to work", async () => {
  const dir = await mkTmp("pi-cb-safe-symlink-");
  const artifactDir = await mkTmp("pi-cb-safe-symlink-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "target.txt"), "target content\n", "utf8");
    await symlink("target.txt", join(dir, "link.txt"));
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-safe-symlink",
      artifactDir,
    });

    const linkEntry = result.entries.find((e) => e.path === "link.txt");
    assert.ok(linkEntry, "link.txt should be in entries");
    assert.equal(linkEntry.mode, "120000", "symlink should have mode 120000");

    // Verify the blob content is the symlink target.
    const blobContent = await gitInRepo(
      ["cat-file", "-p", linkEntry.blobId],
      result.repositoryPath,
    );
    assert.equal(blobContent, "target.txt", "blob should contain symlink target");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("capture — rejects capture when source identity is unstable (ino=0)", async () => {
  // On platforms with stable inodes (macOS, Linux), this test verifies that
  // the identity check is in place. We verify the captured identity has
  // non-zero dev and ino values.
  const dir = await mkTmp("pi-cb-unstable-identity-");
  const artifactDir = await mkTmp("pi-cb-unstable-identity-artifact-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const result = await captureWaveBase({
      cwd: dir,
      maxSnapshotBytes: 1_000_000,
      waveId: "test-unstable-identity",
      artifactDir,
    });

    // Verify the identity is stable (non-zero dev and ino).
    assert.ok(result.sourceIdentity.dev > 0, "dev should be non-zero on stable platforms");
    assert.ok(result.sourceIdentity.ino > 0, "ino should be non-zero on stable platforms");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

// ── Test: malformed .git metadata causes capture_failed, not non-Git fallback ──
// Only the explicit "not a git repository" probe result may classify a source
// as non-Git. Malformed/inaccessible .git metadata/config and other probe
// failures must produce classified capture_failed, never filesystem fallback
// that could include ignored secrets.

test("discoverWaveSource — malformed .git config causes capture_failed, not non-Git fallback", async () => {
  const dir = await mkTmp("pi-dr-malformed-");
  try {
    // Initialize a valid Git repo.
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Corrupt the .git/config to make it malformed.
    await writeFile(join(dir, ".git", "config"), "{{not valid git config}}\n", "utf8");

    // discoverWaveSource should throw (capture_failed), not return non-git.
    await assert.rejects(
      discoverWaveSource(dir),
      /Git discovery failed/,
      "Malformed .git config should cause capture_failed, not non-Git fallback",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverWaveSource — inaccessible .git directory causes capture_failed, not non-Git fallback", async () => {
  const dir = await mkTmp("pi-dr-inaccessible-");
  try {
    // Initialize a valid Git repo.
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Replace .git with a regular file (simulates corrupted/inaccessible .git).
    // This causes git rev-parse to fail with an error that is NOT "not a git repository".
    await rm(join(dir, ".git"), { recursive: true, force: true });
    await writeFile(join(dir, ".git"), "not a git directory\n", "utf8");

    // discoverWaveSource should throw (capture_failed), not return non-git.
    await assert.rejects(
      discoverWaveSource(dir),
      /Git discovery failed/,
      "Inaccessible .git directory should cause capture_failed, not non-Git fallback",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
