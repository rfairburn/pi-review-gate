import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { compareSnapshots, createWorkspaceSnapshot } from "../src/capture";

const execFileAsync = promisify(execFile);

const snapshotOptions = {
  maxFileBytes: 1024 * 1024,
  maxSnapshotBytes: 10 * 1024 * 1024,
};

test("snapshot comparison detects added, modified, and deleted files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-capture-"));
  try {
    await writeFile(join(dir, "modified.txt"), "before\n", "utf8");
    await writeFile(join(dir, "deleted.txt"), "remove me\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);

    await writeFile(join(dir, "modified.txt"), "after\n", "utf8");
    await rm(join(dir, "deleted.txt"));
    await writeFile(join(dir, "added.txt"), "new\n", "utf8");

    const after = await createWorkspaceSnapshot(dir, snapshotOptions);
    const changes = compareSnapshots(before, after);

    assert.deepEqual(
      changes.map((change) => [change.path, change.status]),
      [
        ["added.txt", "added"],
        ["deleted.txt", "deleted"],
        ["modified.txt", "modified"],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot omits binary content but still detects changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-binary-"));
  try {
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);

    await writeFile(join(dir, "nested", "blob.bin"), Buffer.from([0, 1, 2, 4]));
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);
    const [change] = compareSnapshots(before, after);

    assert.equal(change.path, "nested/blob.bin");
    assert.equal(change.binary, true);
    assert.equal(change.diffOmittedReason, "binary");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot recognizes text-safe binary magic, retains exact hashes, and ignores filename extensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-binary-magic-"));
  try {
    const binaryFixtures = new Map<string, Buffer>([
      ["archive.data", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("ASCII ZIP payload")])],
      ["document.data", Buffer.from("%PDF-1.7\nASCII-only fixture\n", "ascii")],
      ["image.data", Buffer.from("GIF89aASCII-only fixture", "ascii")],
      ["audio.data", Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, ...Buffer.from("audio", "ascii")])],
    ]);
    for (const [name, content] of binaryFixtures) await writeFile(join(dir, name), content);
    await writeFile(join(dir, "plain.zip"), "ordinary UTF-8 text despite its extension\n", "utf8");
    const magicLikeText = new Map([
      ["initials.txt", "MZ is a pair of initials, not an executable.\n"],
      ["bitmap-notes.txt", "BM can also begin an ordinary text sentence.\n"],
      ["metadata-notes.txt", "ID3 metadata is described here as text.\n"],
      ["compression-notes.txt", "BZh9 is only a header fragment here.\n"],
    ]);
    for (const [name, content] of magicLikeText) await writeFile(join(dir, name), content, "utf8");

    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    for (const [name, content] of binaryFixtures) {
      const file = snapshot.files.get(name);
      assert.equal(file?.isBinary, true, `${name} should be classified from magic bytes`);
      assert.equal(file?.omittedReason, "binary");
      assert.equal(file?.content, undefined);
      assert.equal(file?.sha256, createHash("sha256").update(content).digest("hex"));
    }
    assert.equal(snapshot.files.get("plain.zip")?.isBinary, false);
    assert.equal(snapshot.files.get("plain.zip")?.content, "ordinary UTF-8 text despite its extension\n");
    for (const [name, content] of magicLikeText) {
      assert.equal(snapshot.files.get(name)?.isBinary, false, `${name} should not match a partial signature`);
      assert.equal(snapshot.files.get(name)?.content, content);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("oversized magic-identified binaries remain binary and hash-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-binary-oversized-"));
  try {
    const content = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "ascii"),
      Buffer.alloc(128, 0x41),
    ]);
    await writeFile(join(dir, "large.pdf"), content);
    const snapshot = await createWorkspaceSnapshot(dir, {
      maxFileBytes: 32,
      maxSnapshotBytes: 1024,
    });
    const file = snapshot.files.get("large.pdf");
    assert.equal(file?.isBinary, true);
    assert.equal(file?.omittedReason, "binary");
    assert.equal(file?.content, undefined);
    assert.equal(file?.sha256, createHash("sha256").update(content).digest("hex"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot reuses unchanged file hashes and content from a prior snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-"));
  try {
    await writeFile(join(dir, "unchanged.txt"), "unchanged\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    const after = await createWorkspaceSnapshot(dir, {
      ...snapshotOptions,
      reuseUnchangedFrom: before,
    });

    assert.equal(after.files.get("unchanged.txt"), before.files.get("unchanged.txt"));
    assert.deepEqual(compareSnapshots(before, after), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot cache does not miss a same-size rewrite with restored mtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-identity-"));
  try {
    const path = join(dir, "value.txt");
    await writeFile(path, "before\n", "utf8");
    const beforeStat = await stat(path);
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    await writeFile(path, "after!\n", "utf8");
    await utimes(path, beforeStat.atime, beforeStat.mtime);
    const after = await createWorkspaceSnapshot(dir, {
      ...snapshotOptions,
      reuseUnchangedFrom: before,
    });
    assert.deepEqual(compareSnapshots(before, after).map((change) => change.path), ["value.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot honors an already-aborted signal before discovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-abort-"));
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      createWorkspaceSnapshot(dir, { ...snapshotOptions, signal: controller.signal }),
      /abort|cancel/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot records a tracked symlink target without reading the external file", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions vary on Windows");
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-symlink-"));
  const outside = join(dir, "..", `outside-${Date.now()}.txt`);
  try {
    await writeFile(outside, "outside secret\n", "utf8");
    await symlink(outside, join(dir, "link"));
    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    const link = snapshot.files.get("link");
    assert.equal(link?.entryType, "symlink");
    assert.equal(link?.linkTarget, outside);
    assert.equal(link?.content, undefined);
    assert.ok(!JSON.stringify(link).includes("outside secret"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("snapshot comparison detects symlink retargeting and executable-mode changes", async (t) => {
  if (process.platform === "win32") t.skip("Unix modes and symlinks are required");
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-entry-metadata-"));
  try {
    await writeFile(join(dir, "a"), "a", "utf8");
    await writeFile(join(dir, "b"), "b", "utf8");
    await writeFile(join(dir, "script.sh"), "#!/bin/sh\n", "utf8");
    await chmod(join(dir, "script.sh"), 0o644);
    await symlink("a", join(dir, "link"));
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);

    await rm(join(dir, "link"));
    await symlink("b", join(dir, "link"));
    await chmod(join(dir, "script.sh"), 0o755);
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);
    const changes = compareSnapshots(before, after);

    assert.deepEqual(changes.map((change) => change.path), ["link", "script.sh"]);
    assert.equal(changes[0]?.oldContent, "a");
    assert.equal(changes[0]?.newContent, "b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot represents tracked gitlinks without traversing their directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-gitlink-"));
  const git = (args: string[]) => execFileAsync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  try {
    await git(["init", "--quiet"]);
    await writeFile(join(dir, "base.txt"), "one\n", "utf8");
    await git(["add", "base.txt"]);
    await git(["commit", "--quiet", "-m", "one"]);
    const first = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await mkdir(join(dir, "submodule"));
    await writeFile(join(dir, "submodule", "secret.txt"), "must not be traversed\n", "utf8");
    await git(["update-index", "--add", "--cacheinfo", `160000,${first},submodule`]);

    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    const gitlink = before.files.get("submodule");
    assert.equal(gitlink?.entryType, "gitlink");
    assert.equal(gitlink?.gitObjectId, first);
    assert.equal(before.files.has("submodule/secret.txt"), false);

    await writeFile(join(dir, "base.txt"), "two\n", "utf8");
    await git(["add", "base.txt"]);
    await git(["commit", "--quiet", "-m", "two"]);
    const second = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["update-index", "--cacheinfo", `160000,${second},submodule`]);
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.deepEqual(compareSnapshots(before, after).map((change) => change.path), ["base.txt", "submodule"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
