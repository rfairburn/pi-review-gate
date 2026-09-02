import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  compareSnapshots,
  createPathSnapshot,
  createWorkspaceSnapshot,
  fsFaultCode,
  fsFaultReason,
  gitWarningPathRelativeToCwd,
  MAX_SNAPSHOT_OMISSIONS,
  parseGitDirectoryWarnings,
  recordSnapshotOmission,
  type FileSnapshot,
  type SnapshotOmission,
  type WorkspaceSnapshot,
} from "../src/capture";

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

test("reuseUnchangedFrom never reuses an unreadable presence record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-unreadable-"));
  try {
    await writeFile(join(dir, "a.txt"), "hello\n", "utf8");
    const first = await createWorkspaceSnapshot(dir, snapshotOptions);
    const real = first.files.get("a.txt")!;
    // Simulate a transient read failure persisted into a prior snapshot: full
    // stat identity but no hash. A chained capture must re-inspect the file.
    const poisoned: WorkspaceSnapshot = {
      ...first,
      files: new Map([[
        "a.txt",
        { ...real, sha256: null, content: undefined, omittedReason: "unreadable" },
      ]]),
    };
    const second = await createWorkspaceSnapshot(dir, { ...snapshotOptions, reuseUnchangedFrom: poisoned });
    assert.equal(second.files.get("a.txt")?.content, "hello\n");
    assert.equal(second.files.get("a.txt")?.omittedReason, undefined);
    assert.equal(second.files.get("a.txt")?.sha256, real.sha256);
    assert.deepEqual(second.omissions, []);
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

test("a failed gitlink inspection keeps a presence record instead of reporting deletion", async (t) => {
  if (process.platform === "win32") t.skip("requires a POSIX sh shim on PATH");
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-gitlink-fault-"));
  const shimDir = await mkdtemp(join(tmpdir(), "pi-review-gate-git-shim-"));
  try {
    const git = (args: string[], cwd = dir) => execFileAsync("git", args, { cwd, env: gitEnv() });
    await git(["init", "--quiet"]);
    await writeFile(join(dir, "keep.txt"), "keep\n", "utf8");
    await execFileAsync("git", ["add", "keep.txt"], { cwd: dir, env: gitEnv() });
    await execFileAsync("git", ["commit", "--quiet", "-m", "seed"], { cwd: dir, env: gitEnv() });
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir, env: gitEnv() })).stdout.trim();
    await mkdir(join(dir, "submodule"));
    await execFileAsync("git", ["update-index", "--add", "--cacheinfo", `160000,${head},submodule`],
      { cwd: dir, env: gitEnv() });

    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(before.files.get("submodule")?.entryType, "gitlink");

    // A PATH shim makes only `git ls-files --stage` fail (exit 128) with the
    // message historically treated as a benign non-repository signal; every
    // other command (including discovery) reaches the real git. This forces
    // the gitlink metadata inspection to fail while the directory is still
    // verifiably present.
    const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
    const shim = join(shimDir, "git");
    await writeFile(shim,
      `#!/bin/sh\n`
      + `if [ "$1" = "ls-files" ] && [ "$2" = "--stage" ]; then\n`
      + `  echo "fatal: not a git repository (simulated concurrent metadata loss)" >&2\n`
      + `  exit 128\n`
      + `fi\n`
      + `exec '${realGit}' "$@"\n`,
      { mode: 0o755 });
    const previousPath = process.env.PATH;
    let after: WorkspaceSnapshot;
    try {
      process.env.PATH = `${shimDir}:${previousPath}`;
      after = await createWorkspaceSnapshot(dir, snapshotOptions);
    } finally {
      process.env.PATH = previousPath;
    }

    const entry = after.files.get("submodule");
    assert.equal(entry?.exists, true, "the gitlink directory was verified present");
    assert.equal(entry?.omittedReason, "unreadable");
    assert.equal(entry?.entryType, "gitlink");
    const omission = after.omissions.find((record) => record.path === "submodule");
    assert.equal(omission?.kind, "directory");
    assert.equal(omission?.reason, "unreadable");
    const statuses = compareSnapshots(before, after).map((change) => [change.path, change.status]);
    assert.ok(!statuses.some(([path, status]) => path === "submodule" && status === "deleted"),
      "a failed gitlink inspection must never be reported as deleted");
    assert.deepEqual(statuses, [["submodule", "modified"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
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

test("a deterministic inspection race cannot capture a replacement symlink target", async (t) => {
  if (process.platform === "win32") t.skip("symlink creation varies on Windows");
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-symlink-race-"));
  const outside = join(tmpdir(), `pi-review-gate-secret-${Date.now()}.txt`);
  try {
    await writeFile(join(dir, "victim.txt"), "inside\n", "utf8");
    await writeFile(join(dir, "sibling.txt"), "sibling\n", "utf8");
    await writeFile(outside, "outside secret\n", "utf8");
    let swapped = false;
    const snapshot = await createWorkspaceSnapshot(dir, {
      ...snapshotOptions,
      captureFaults: {
        beforeInspectFile: async ({ relativePath, absolutePath }) => {
          if (relativePath !== "victim.txt" || swapped) return;
          swapped = true;
          await rm(absolutePath);
          await symlink(outside, absolutePath);
        },
      },
    });
    assert.equal(snapshot.files.get("sibling.txt")?.content, "sibling\n");
    assert.equal(snapshot.files.get("victim.txt")?.omittedReason, "unreadable");
    assert.equal(snapshot.files.get("victim.txt")?.content, undefined);
    assert.equal(snapshot.omissions.find((entry) => entry.path === "victim.txt")?.reason, "unreadable");
    assert.doesNotMatch(JSON.stringify([...snapshot.files.values()]), /outside secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("in-place growth during inspection cannot bypass snapshot bounds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-growth-race-"));
  try {
    await writeFile(join(dir, "victim.txt"), "x", "utf8");
    await writeFile(join(dir, "sibling.txt"), "sibling\n", "utf8");
    const snapshot = await createWorkspaceSnapshot(dir, {
      maxFileBytes: 8,
      maxSnapshotBytes: 32,
      captureFaults: {
        beforeInspectFile: async ({ relativePath, absolutePath }) => {
          if (relativePath === "victim.txt") await writeFile(absolutePath, "a".repeat(64), "utf8");
        },
      },
    });
    assert.equal(snapshot.files.get("victim.txt")?.omittedReason, "unreadable");
    assert.equal(snapshot.files.get("victim.txt")?.content, undefined);
    assert.equal(snapshot.files.get("sibling.txt")?.content, "sibling\n");
    assert.doesNotMatch(JSON.stringify([...snapshot.files.values()]), /aaaa/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeFileSnapshot(relativePath: string, content: string): FileSnapshot {
  return {
    relativePath,
    absolutePath: `/workspace/${relativePath}`,
    exists: true,
    size: Buffer.byteLength(content),
    mtimeMs: 1,
    sha256: createHash("sha256").update(content).digest("hex"),
    isBinary: false,
    content,
  };
}

test("fault classifier maps errno codes deterministically to missing vs unreadable", () => {
  // Only ENOENT/ENOTDIR mean the entry vanished during capture.
  assert.equal(fsFaultReason(enoent()), "missing");
  assert.equal(fsFaultReason(enotdir()), "missing");
  // EACCES/EPERM/ELOOP and unknown/transient conditions are unreadable.
  for (const code of ["EACCES", "EPERM", "ELOOP", "EIO", "EBUSY", "ETXTBSY", "EMFILE", "UNKNOWN"]) {
    assert.equal(fsFaultReason({ code }), "unreadable", code);
  }
  assert.equal(fsFaultReason(new Error("plain")), "unreadable");
  assert.equal(fsFaultReason("not an object"), "unreadable");
  assert.equal(fsFaultCode(enoent()), "ENOENT");
  assert.equal(fsFaultCode({ code: "" }), undefined);
  assert.equal(fsFaultCode(new Error("plain")), undefined);
});

function enoent(): Error {
  const error = new Error("no such file or directory");
  (error as Error & { code?: string }).code = "ENOENT";
  return error;
}

function enotdir(): Error {
  const error = new Error("not a directory");
  (error as Error & { code?: string }).code = "ENOTDIR";
  return error;
}

test("snapshot survives an unreadable file, captures siblings, and keeps the file present", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-unreadable-file-"));
  try {
    await writeFile(join(dir, "protected.txt"), "protected content\n", "utf8");
    await writeFile(join(dir, "sibling.txt"), "keep me\n", "utf8");
    await chmod(join(dir, "protected.txt"), 0o000);

    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    const protectedFile = snapshot.files.get("protected.txt");
    assert.equal(protectedFile?.exists, true, "unreadable file must keep existence");
    assert.equal(protectedFile?.omittedReason, "unreadable");
    assert.equal(protectedFile?.content, undefined);
    assert.equal(snapshot.files.get("sibling.txt")?.content, "keep me\n", "siblings stay captured");
    assert.deepEqual(snapshot.omissions.filter((entry) => entry.path === "protected.txt"), [{
      path: "protected.txt",
      kind: "file",
      reason: "unreadable",
      errorCode: "EACCES",
    }]);
    assert.equal(snapshot.omissionsTruncated, false);
  } finally {
    await chmod(join(dir, "protected.txt"), 0o644).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an existing-but-unreadable file is reported as modified, never as deleted", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-unreadable-compare-"));
  try {
    await writeFile(join(dir, "protected.txt"), "before\n", "utf8");
    await writeFile(join(dir, "sibling.txt"), "same\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);

    await chmod(join(dir, "protected.txt"), 0o000);
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);

    const changes = compareSnapshots(before, after);
    assert.deepEqual(changes.filter((change) => change.status === "deleted"), [],
      "unreadable existing files must not be reported as deleted");
    const protectedChange = changes.find((change) => change.path === "protected.txt");
    assert.equal(protectedChange?.status, "modified");
    assert.equal(protectedChange?.diffOmittedReason, "unreadable");
    assert.equal(changes.some((change) => change.path === "sibling.txt"), false);
  } finally {
    await chmod(join(dir, "protected.txt"), 0o644).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot survives an unreadable directory with a typed directory omission", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-unreadable-dir-"));
  try {
    await mkdir(join(dir, "protected"));
    await writeFile(join(dir, "protected", "inside.txt"), "hidden\n", "utf8");
    await writeFile(join(dir, "root.txt"), "visible\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);

    await chmod(join(dir, "protected"), 0o000);
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);

    assert.equal(after.files.get("root.txt")?.content, "visible\n", "siblings stay captured");
    assert.equal(after.files.has("protected/inside.txt"), false);
    const omission = after.omissions.find((entry) => entry.path === "protected");
    assert.equal(omission?.kind, "directory");
    assert.equal(omission?.reason, "unreadable");
    assert.equal(omission?.errorCode, "EACCES");

    // Children of the unreadable directory must not be misreported as deleted.
    assert.deepEqual(compareSnapshots(before, after).filter((change) => change.status === "deleted"),
      [], "children under an unreadable directory must not be reported deleted");
  } finally {
    await chmod(join(dir, "protected"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareSnapshots never reports children of an unreadable directory as deleted", () => {
  const before: WorkspaceSnapshot = {
    cwd: "/workspace",
    capturedAt: "2026-01-01T00:00:00.000Z",
    files: new Map([
      ["dir/a.txt", makeFileSnapshot("dir/a.txt", "a")],
      ["kept.txt", makeFileSnapshot("kept.txt", "k")],
    ]),
    omissions: [],
    omissionsTruncated: false,
  };
  const after: WorkspaceSnapshot = {
    cwd: "/workspace",
    capturedAt: "2026-01-01T00:00:01.000Z",
    files: new Map([["kept.txt", makeFileSnapshot("kept.txt", "k")]]),
    omissions: [{ path: "dir", kind: "directory", reason: "unreadable", errorCode: "EACCES" }],
    omissionsTruncated: false,
  };
  assert.deepEqual(compareSnapshots(before, after), [],
    "missing children under an unreadable directory must not be reported deleted");
});

test("a tracked file deleted before capture is a missing omission and still compares as deleted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-missing-"));
  await initGit(dir);
  try {
    await writeFile(join(dir, "tracked.txt"), "tracked\n", "utf8");
    await writeFile(join(dir, "kept.txt"), "kept\n", "utf8");
    await gitAddCommit(dir, "seed");

    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(before.files.get("tracked.txt")?.content, "tracked\n");
    assert.deepEqual(before.omissions, []);

    // git ls-files -co still lists the cached tracked file, so capture sees the
    // file vanish between discovery and lstat: a deterministic missing omission.
    await rm(join(dir, "tracked.txt"));
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);

    assert.equal(after.files.has("tracked.txt"), false);
    assert.equal(after.files.get("kept.txt")?.content, "kept\n", "siblings stay captured");
    assert.deepEqual(after.omissions.filter((entry) => entry.path === "tracked.txt"), [{
      path: "tracked.txt",
      kind: "file",
      reason: "missing",
      errorCode: "ENOENT",
    }]);
    assert.deepEqual(compareSnapshots(before, after).map((change) => [change.path, change.status]),
      [["tracked.txt", "deleted"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot omission ledger is bounded and flags truncation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-omission-bound-"));
  await initGit(dir);
  try {
    const count = MAX_SNAPSHOT_OMISSIONS + 5;
    await Promise.all(Array.from({ length: count }, (_, index) =>
      writeFile(join(dir, `gone-${String(index).padStart(4, "0")}.txt`), `${index}\n`, "utf8")));
    await gitAddCommit(dir, "seed");
    await Promise.all(Array.from({ length: count }, (_, index) =>
      rm(join(dir, `gone-${String(index).padStart(4, "0")}.txt`))));

    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(snapshot.omissions.length, MAX_SNAPSHOT_OMISSIONS);
    assert.equal(snapshot.omissionsTruncated, true);
    assert.ok(snapshot.omissions.every((entry) => entry.reason === "missing"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("git discovery warnings yield unreadable-directory omissions even when git succeeds", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-git-unreadable-"));
  await initGit(dir);
  try {
    await mkdir(join(dir, "protected"), { recursive: true });
    await writeFile(join(dir, "protected", "inside.txt"), "hidden\n", "utf8");
    await writeFile(join(dir, "keep.txt"), "keep\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(before.files.get("protected/inside.txt")?.content, "hidden\n");

    await chmod(join(dir, "protected"), 0o000);
    // git ls-files -co exits successfully while warning that it could not
    // open the directory; capture must still record the omission so the
    // child is never misreported as deleted.
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);

    assert.equal(after.files.get("keep.txt")?.content, "keep\n", "siblings stay captured");
    assert.equal(after.files.has("protected/inside.txt"), false);
    const omission = after.omissions.find((entry) => entry.path === "protected");
    assert.equal(omission?.kind, "directory");
    assert.equal(omission?.reason, "unreadable");
    assert.deepEqual(
      compareSnapshots(before, after).filter((change) => change.status === "deleted"),
      [],
      "git-discovered unreadable directories must not surface as child deletions",
    );
  } finally {
    await chmod(join(dir, "protected"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("git discovery warnings are captured cwd-relative when cwd is a repository subdirectory", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const repo = await mkdtemp(join(tmpdir(), "pi-review-gate-git-subdir-"));
  await initGit(repo);
  try {
    // cwd will be repo/sub, but Git's warning path for the unreadable
    // directory is repo-relative ("sub/protected"), so the snapshot must
    // still record a cwd-relative omission covering "protected/inside.txt".
    await mkdir(join(repo, "sub", "protected"), { recursive: true });
    await writeFile(join(repo, "sub", "protected", "inside.txt"), "hidden\n", "utf8");
    await writeFile(join(repo, "sub", "keep.txt"), "keep\n", "utf8");
    // A different directory that collides with the repository-relative form of
    // the unreadable path: cwd-relative "sub/protected/..." (repo/sub/sub/...).
    await mkdir(join(repo, "sub", "sub", "protected"), { recursive: true });
    await writeFile(join(repo, "sub", "sub", "protected", "really-gone.txt"), "gone\n", "utf8");
    const sub = join(repo, "sub");
    const before = await createWorkspaceSnapshot(sub, snapshotOptions);
    assert.equal(before.files.get("protected/inside.txt")?.content, "hidden\n");
    assert.equal(before.files.get("sub/protected/really-gone.txt")?.content, "gone\n");

    await chmod(join(repo, "sub", "protected"), 0o000);
    await rm(join(repo, "sub", "sub", "protected", "really-gone.txt"));
    const after = await createWorkspaceSnapshot(sub, snapshotOptions);

    assert.equal(after.files.get("keep.txt")?.content, "keep\n", "siblings stay captured");
    assert.equal(after.omissions.some((omission) =>
      omission.path === "protected" && omission.kind === "directory" && omission.reason === "unreadable"),
      true, "the audit must record the unreadable directory in cwd-relative form");
    // The repo-relative warning path must not leak into the cwd namespace:
    // a genuine deletion at cwd-relative sub/protected/really-gone.txt stays
    // reported while children of the unreadable repo/sub/protected stay
    // suppressed.
    assert.deepEqual(
      compareSnapshots(before, after)
        .filter((change) => change.status === "deleted")
        .map((change) => change.path),
      ["sub/protected/really-gone.txt"],
      "only the genuine sibling deletion is reported; unreadable children are not",
    );
  } finally {
    await chmod(join(repo, "sub", "protected"), 0o755).catch(() => undefined);
    await rm(repo, { recursive: true, force: true });
  }
});

test("parseGitDirectoryWarnings extracts unreadable entries from git stderr", () => {
  assert.deepEqual(parseGitDirectoryWarnings(
    "warning: could not open directory 'protected/': Permission denied\n",
  ), [{ path: "protected", kind: "directory" }]);
  assert.deepEqual(parseGitDirectoryWarnings(
    "warning: unable to access 'nested/dir': Permission denied\n"
    + "warning: unable to access 'other': Not a directory\n",
  ), [{ path: "nested/dir", kind: "file" }, { path: "other", kind: "file" }]);
  assert.deepEqual(parseGitDirectoryWarnings("warning: something else entirely\n"), []);
  assert.deepEqual(parseGitDirectoryWarnings(""), []);
  // Duplicates collapse and a root-level warning becomes ".".
  assert.deepEqual(parseGitDirectoryWarnings(
    "warning: could not open directory 'a': EACCES\n"
    + "warning: could not open directory 'a': EACCES\n"
    + "warning: could not open directory '/': EACCES\n",
  ), [{ path: "a", kind: "directory" }, { path: ".", kind: "directory" }]);
});

test("git warning paths are normalized to the capture cwd", () => {
  assert.equal(gitWarningPathRelativeToCwd("sub/protected", "sub/"), "protected");
  assert.equal(gitWarningPathRelativeToCwd("sub/protected/", "sub/"), "protected");
  assert.equal(gitWarningPathRelativeToCwd("sub/sub/protected", "sub/"), "sub/protected");
  assert.equal(gitWarningPathRelativeToCwd("other/protected", "sub/"), undefined);
  assert.equal(gitWarningPathRelativeToCwd("../outside", "sub/"), undefined);
  assert.equal(gitWarningPathRelativeToCwd("/outside/excludes", "sub/"), undefined);
  // At the repository root the prefix is empty and paths pass through.
  assert.equal(gitWarningPathRelativeToCwd("protected", ""), "protected");
  assert.equal(gitWarningPathRelativeToCwd("./", ""), ".");
  // The capture root itself becoming unreadable maps to ".".
  assert.equal(gitWarningPathRelativeToCwd("sub/", "sub/"), ".");
});

test("an unreadable directory is recorded after missing-entry overflow", () => {
  const omissions: SnapshotOmission[] = [];
  let truncated = false;
  for (let index = 0; index <= MAX_SNAPSHOT_OMISSIONS; index += 1) {
    truncated = recordSnapshotOmission(omissions, truncated, "file", `gone-${index}.txt`, enoent());
  }
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  truncated = recordSnapshotOmission(omissions, truncated, "directory", "protected", denied);

  assert.equal(truncated, true);
  assert.equal(omissions.length, MAX_SNAPSHOT_OMISSIONS);
  assert.ok(omissions.some((entry) =>
    entry.path === "." && entry.kind === "directory" && entry.reason === "unreadable"),
    "an unreadable directory after overflow must install the root-level sentinel");
});

test("compareSnapshots suppresses all deletions when a root-level unreadable-directory sentinel is present", () => {
  const before: WorkspaceSnapshot = {
    cwd: "/workspace",
    capturedAt: "2026-01-01T00:00:00.000Z",
    files: new Map([
      ["somewhere/deep/a.txt", makeFileSnapshot("somewhere/deep/a.txt", "a")],
      ["kept.txt", makeFileSnapshot("kept.txt", "k")],
    ]),
    omissions: [],
    omissionsTruncated: false,
  };
  const after: WorkspaceSnapshot = {
    cwd: "/workspace",
    capturedAt: "2026-01-01T00:00:01.000Z",
    files: new Map([["kept.txt", makeFileSnapshot("kept.txt", "k")]]),
    // Root-level sentinel: at least one unreadable directory could not be
    // recorded, so its scope is unknown and every deletion is unverified.
    omissions: [{ path: ".", kind: "directory", reason: "unreadable" }],
    omissionsTruncated: true,
  };
  assert.deepEqual(
    compareSnapshots(before, after).filter((change) => change.status === "deleted"),
    [],
    "an overflowed ledger must not let unreadable paths surface as deletions",
  );
});

test("an unreadable directory met after the omission ledger overflows installs a root-level sentinel", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-omission-sentinel-"));
  const unreadable: string[] = [];
  try {
    // Fill the ledger with unreadable-directory omissions (one per directory)
    // and leave one extra directory to overflow past MAX_SNAPSHOT_OMISSIONS.
    const dirCount = MAX_SNAPSHOT_OMISSIONS + 1;
    for (let index = 0; index < dirCount; index += 1) {
      const name = `d${String(index).padStart(4, "0")}`;
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, "inside.txt"), `${index}\n`, "utf8");
      unreadable.push(name);
    }
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(before.omissions.length, 0);

    await Promise.all(unreadable.map((name) => chmod(join(dir, name), 0o000)));
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);

    assert.equal(after.omissions.length, MAX_SNAPSHOT_OMISSIONS, "ledger stays bounded");
    assert.equal(after.omissionsTruncated, true);
    const sentinel = after.omissions.find((omission) =>
      omission.path === "." && omission.kind === "directory" && omission.reason === "unreadable");
    assert.ok(sentinel, "overflow must install a conservative root-level sentinel");
    assert.deepEqual(
      compareSnapshots(before, after).filter((change) => change.status === "deleted"),
      [],
      "children of overflowed unreadable directories must not be reported deleted",
    );
  } finally {
    await Promise.all(unreadable.map((name) => chmod(join(dir, name), 0o755).catch(() => undefined)));
    await rm(dir, { recursive: true, force: true });
  }
});

test("createPathSnapshot classifies unreadable existing paths as unreadable, not missing", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-path-unreadable-"));
  try {
    await writeFile(join(dir, "protected.txt"), "protected\n", "utf8");
    await chmod(join(dir, "protected.txt"), 0o000);
    const snapshot = await createPathSnapshot(dir, "protected.txt", snapshotOptions);
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.omittedReason, "unreadable");
    assert.equal(snapshot.content, undefined);
  } finally {
    await chmod(join(dir, "protected.txt"), 0o644).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("createPathSnapshot classifies a deleted path as missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-path-missing-"));
  try {
    const snapshot = await createPathSnapshot(dir, "absent.txt", snapshotOptions);
    assert.equal(snapshot.exists, false);
    assert.equal(snapshot.omittedReason, "missing");
    assert.equal(snapshot.sha256, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function gitEnv(): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

async function initGit(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet"], { cwd: dir, env: gitEnv() });
}

async function gitAddCommit(dir: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: dir, env: gitEnv() });
  await execFileAsync("git", ["commit", "--quiet", "-m", message], { cwd: dir, env: gitEnv() });
}
