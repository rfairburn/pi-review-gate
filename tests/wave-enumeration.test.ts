import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
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

async function mkTmp(prefix: string): Promise<string> {
  const raw = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(join(tmpdir(), prefix)),
  );
  return realpath(raw);
}

// ── Git: dirty / staged membership ───────────────────────────────────────────

test("enumeration — staged file appears even without commit", async () => {
  const dir = await mkTmp("pi-we-staged-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "a.txt"), "a\n", "utf8");
    await git(["add", "a.txt"], dir);
    // Do NOT commit — file is staged only.

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    assert.deepEqual(paths, ["a.txt"], "staged file should be listed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enumeration — dirty (modified) tracked file stays listed", async () => {
  const dir = await mkTmp("pi-we-dirty-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "a.txt"), "original\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Modify the file (dirty working tree).
    await writeFile(join(dir, "a.txt"), "modified\n", "utf8");

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    assert.ok(paths.includes("a.txt"), "dirty tracked file should remain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enumeration — deleted tracked file still appears", async () => {
  const dir = await mkTmp("pi-we-deleted-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "a.txt"), "a\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Delete the file from working tree.
    await rm(join(dir, "a.txt"));

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    assert.ok(paths.includes("a.txt"), "deleted tracked file should still be listed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Git: ignored vs untracked ────────────────────────────────────────────────

test("enumeration — ignored untracked file is absent", async () => {
  const dir = await mkTmp("pi-we-ignored-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, ".gitignore"), "*.log\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Create an ignored untracked file.
    await writeFile(join(dir, "debug.log"), "ignored\n", "utf8");

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    assert.ok(!paths.includes("debug.log"), "ignored untracked file should be absent");
    assert.ok(paths.includes(".gitignore"), ".gitignore itself should be listed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enumeration — non-ignored untracked file is present", async () => {
  const dir = await mkTmp("pi-we-untracked-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "readme.md"), "# hi\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Create a non-ignored untracked file.
    await writeFile(join(dir, "new.txt"), "new\n", "utf8");

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    assert.ok(paths.includes("new.txt"), "non-ignored untracked file should be present");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Git: tracked file matching ignore rules ──────────────────────────────────

test("enumeration — tracked file that now matches .gitignore stays eligible", async () => {
  const dir = await mkTmp("pi-we-tracked-ignore-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "data.log"), "data\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    // Now add an ignore rule that matches the already-tracked file.
    await writeFile(join(dir, ".gitignore"), "*.log\n", "utf8");

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    assert.ok(paths.includes("data.log"), "tracked file matching ignore should remain eligible");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Git: unborn repo ─────────────────────────────────────────────────────────

test("enumeration — unborn repo lists staged files", async () => {
  const dir = await mkTmp("pi-we-unborn-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "init.txt"), "init\n", "utf8");
    await git(["add", "."], dir);
    // No commit — unborn.

    const discovery = await discoverWaveSource(dir);
    assert.equal(discovery.sourceType, "git-unborn");

    const paths = await enumerateWaveSourcePaths(discovery);
    assert.ok(paths.includes("init.txt"), "unborn repo should list staged files");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enumeration — empty unborn repo returns empty list", async () => {
  const dir = await mkTmp("pi-we-empty-");
  try {
    await git(["init", "--quiet"], dir);

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    assert.deepEqual(paths, [], "empty unborn repo should return empty list");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Git: metadata exclusion ──────────────────────────────────────────────────

test("enumeration — .git metadata is never returned", async () => {
  const dir = await mkTmp("pi-we-meta-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "file.txt"), "f\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    for (const p of paths) {
      assert.ok(!p.startsWith(".git"), `path ${p} should not be .git metadata`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Non-Git: nested ignore rules ─────────────────────────────────────────────

test("enumeration — non-Git source honours nested .gitignore", async () => {
  const dir = await mkTmp("pi-we-nongit-nested-");
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "readme.md"), "# hi\n", "utf8");
    await writeFile(join(dir, "src", "main.ts"), "export {}\n", "utf8");
    await writeFile(join(dir, "src", "build.log"), "log\n", "utf8");

    // Root .gitignore
    await writeFile(join(dir, ".gitignore"), "*.log\n", "utf8");
    // Nested .gitignore
    await writeFile(join(dir, "src", ".gitignore"), "*.tmp\n", "utf8");
    await writeFile(join(dir, "src", "cache.tmp"), "tmp\n", "utf8");

    const discovery = await discoverWaveSource(dir);
    assert.equal(discovery.sourceType, "non-git");

    const paths = await enumerateWaveSourcePaths(discovery);

    assert.ok(paths.includes("readme.md"), "readme should be present");
    assert.ok(paths.includes("src/main.ts"), "main.ts should be present");
    assert.ok(!paths.includes("src/build.log"), "build.log should be ignored by root .gitignore");
    assert.ok(!paths.includes("src/cache.tmp"), "cache.tmp should be ignored by nested .gitignore");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enumeration — non-Git source returns sorted paths", async () => {
  const dir = await mkTmp("pi-we-nongit-sort-");
  try {
    await writeFile(join(dir, "z.txt"), "z\n", "utf8");
    await writeFile(join(dir, "a.txt"), "a\n", "utf8");
    await writeFile(join(dir, "m.txt"), "m\n", "utf8");

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    assert.deepEqual(paths, ["a.txt", "m.txt", "z.txt"], "paths should be sorted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Stability / normalization ────────────────────────────────────────────────

test("enumeration — paths are normalized with forward slashes", async () => {
  const dir = await mkTmp("pi-we-normalize-");
  try {
    await git(["init", "--quiet"], dir);
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "a", "b", "c.txt"), "c\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    assert.ok(paths.includes("a/b/c.txt"), "path should use forward slashes");
    for (const p of paths) {
      assert.ok(!p.includes("\\"), `path ${p} should not contain backslashes`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enumeration — result is deterministic across calls", async () => {
  const dir = await mkTmp("pi-we-deterministic-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "x.txt"), "x\n", "utf8");
    await writeFile(join(dir, "y.txt"), "y\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const discovery = await discoverWaveSource(dir);
    const paths1 = await enumerateWaveSourcePaths(discovery);
    const paths2 = await enumerateWaveSourcePaths(discovery);

    assert.deepEqual(paths1, paths2, "results should be identical across calls");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Temporary metadata cleanup ───────────────────────────────────────────────

test("enumeration — non-Git temp metadata is cleaned up", async () => {
  const dir = await mkTmp("pi-we-cleanup-");
  try {
    await writeFile(join(dir, "file.txt"), "f\n", "utf8");

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    assert.ok(paths.includes("file.txt"));

    // Verify no .git directory was created in the source.
    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(dir),
    );
    assert.ok(
      !entries.includes(".git"),
      "no .git directory should be created in non-Git source",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Non-Git: nested .git metadata ────────────────────────────────────────────

test("enumeration — non-Git source omits nested .git directories", async () => {
  const dir = await mkTmp("pi-we-nested-git-");
  try {
    await mkdir(join(dir, "submodule", ".git", "objects"), { recursive: true });
    await writeFile(join(dir, "readme.md"), "# hi\n", "utf8");
    await writeFile(join(dir, "submodule", ".git", "config"), "[core]\n", "utf8");
    await writeFile(join(dir, "submodule", "code.ts"), "export {}\n", "utf8");

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    assert.ok(paths.includes("readme.md"), "readme should be present");
    assert.ok(paths.includes("submodule/code.ts"), "code.ts should be present");
    for (const p of paths) {
      assert.ok(
        !p.includes(".git"),
        `path ${p} should not contain .git metadata`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Unusual filenames ────────────────────────────────────────────────────────

test("enumeration — handles filenames with spaces", async () => {
  const dir = await mkTmp("pi-we-spaces-");
  try {
    await git(["init", "--quiet"], dir);
    await writeFile(join(dir, "my file.txt"), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    assert.ok(paths.includes("my file.txt"), "file with spaces should be listed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enumeration — handles filenames with newlines", async () => {
  const dir = await mkTmp("pi-we-newline-");
  try {
    await git(["init", "--quiet"], dir);
    const weirdName = "line1\nline2.txt";
    await writeFile(join(dir, weirdName), "content\n", "utf8");
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", "init"], dir);

    const discovery = await discoverWaveSource(dir);
    const paths = await enumerateWaveSourcePaths(discovery);

    assert.ok(paths.includes(weirdName), "file with newline in name should be listed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
