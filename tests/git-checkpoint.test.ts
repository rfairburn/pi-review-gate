import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import {
  armGitCheckpoint,
  compareToGitCheckpoint,
  checkpointRefForWindow,
  decodeGitCheckpointDescriptor,
  decodeGitCheckpointRecord,
  encodeGitCheckpointDescriptor,
  encodeGitCheckpointRecord,
  loadGitCheckpoint,
  restoreGitCheckpoint,
  releaseGitCheckpointPin,
  verifyGitCheckpointPin,
  type GitCheckpointDescriptor,
  type GitCheckpointReleaseOptions,
} from "../src/git-checkpoint";

const execFileAsync = promisify(execFile);

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo, env: GIT_ENV });
  return stdout;
}

/** Run a git command that may exit non-zero; returns { code, stdout, stderr }. */
async function gitTolerant(repo: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: repo, env: GIT_ENV });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** Recursively collect file bytes under a directory as relative path → Buffer. */
async function collectFiles(dir: string, prefix = ""): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // directory absent → empty snapshot
  }
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [key, value] of await collectFiles(join(dir, entry.name), rel)) out.set(key, value);
    } else if (entry.isFile()) {
      out.set(rel, await readFile(join(dir, entry.name)));
    }
  }
  return out;
}

let tmpCount = 0;
const tmpDirs: string[] = [];

async function mkTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `prg193-${++tmpCount}-`));
  tmpDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** Fresh repo with a committed README and a large clean file. */
async function initRepo(): Promise<string> {
  const repo = await mkTmp();
  await git(repo, "init", "-q");
  await writeFile(join(repo, "README.md"), "# test\n");
  await writeFile(join(repo, "large-clean.bin"), randomBytes(1024 * 1024));
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "initial");
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", message);
}

function indexPath(repo: string): string {
  return join(repo, ".git", "index");
}

/** Head of the current branch (full oid). */
async function headOid(repo: string): Promise<string> {
  return (await git(repo, "rev-parse", "HEAD")).trim();
}

test("arm produces a small durable record and leaves index/worktree untouched", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "notes-tracked.txt"), "tracked base\n");
  await commitAll(repo, "add notes");
  // Tracked-but-ignored log.txt: tracked FIRST, then ignored.
  await writeFile(join(repo, "log.txt"), "log v1\n");
  await commitAll(repo, "add log");
  await writeFile(join(repo, ".gitignore"), "secret*\nlog.txt\n");
  await commitAll(repo, "ignore rules");
  // Now the armed dirty state: one staged change, one unstaged change.
  await writeFile(join(repo, "README.md"), "# test\nstaged line\n");
  await git(repo, "add", "README.md");
  await writeFile(join(repo, "notes-tracked.txt"), "tracked base\nunstaged line\n");
  // Untracked + ignored-untracked.
  await writeFile(join(repo, "notes.txt"), "untracked baseline\n");
  await writeFile(join(repo, "secret.txt"), "ignored secret\n");

  const base = await headOid(repo);
  const indexBefore = await readFile(indexPath(repo));
  const statusBefore = await git(repo, "status", "--porcelain");

  const result = await armGitCheckpoint(repo, "window-arm-small");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const { record, stats } = result.value;

  // The large clean file must not be retained: record is far smaller than it.
  assert.ok(stats.recordBytes < 50 * 1024, `record too large: ${stats.recordBytes}`);
  assert.equal(record.base, base);
  assert.equal(record.ref, checkpointRefForWindow("window-arm-small"));
  // Only the non-ignored untracked path is captured.
  assert.deepEqual(record.untracked.map((e) => e.path), ["notes.txt"]);
  assert.equal(Buffer.from(record.untracked[0]!.contentB64!, "base64").toString("utf8"), "untracked baseline\n");
  // Both patches are present and binary-safe base64.
  const staged = Buffer.from(record.stagedPatchB64, "base64").toString("utf8");
  assert.match(staged, /README\.md/);
  const unstaged = Buffer.from(record.unstagedPatchB64, "base64").toString("utf8");
  assert.match(unstaged, /notes-tracked\.txt/);

  // Capture left the index bytes and worktree state untouched.
  assert.deepEqual(await readFile(indexPath(repo)), indexBefore);
  assert.equal(await git(repo, "status", "--porcelain"), statusBefore);
});

test("restore exactly reconstructs staged, unstaged, and untracked state", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f1.txt"), "one\n");
  await writeFile(join(repo, "f2.bin"), randomBytes(64 * 1024));
  // log.txt is tracked first, then ignored (tracked-but-ignored).
  await writeFile(join(repo, "log.txt"), "log v1\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base files");
  await writeFile(join(repo, ".gitignore"), "secret*\nlog.txt\n");
  await commitAll(repo, "ignore rules");

  // Armed state: staged f1 change, unstaged f1+f2+log changes, untracked notes.
  const armedF1 = "one\nstaged\nunstaged\n";
  const armedF2 = randomBytes(64 * 1024);
  const armedLog = "log v2\n";
  await writeFile(join(repo, "f1.txt"), "one\nstaged\n");
  await git(repo, "add", "f1.txt");
  await writeFile(join(repo, "f1.txt"), armedF1);
  await writeFile(join(repo, "f2.bin"), armedF2);
  await writeFile(join(repo, "log.txt"), armedLog);
  await mkdir(join(repo, "sub/dir"), { recursive: true });
  await writeFile(join(repo, "sub/dir/deep.txt"), "deep untracked\n");
  await writeFile(join(repo, "notes.txt"), "note base\n");
  await writeFile(join(repo, "secret.txt"), "secret base\n");

  const arm = await armGitCheckpoint(repo, "window-restore");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;
  const encoded = arm.value.encoded;

  // Reference patches captured with plain git at arm time.
  const stagedRef = await git(repo, "diff", "--cached", "--binary");
  const unstagedRef = await git(repo, "diff", "--binary");

  // Destroy everything: worktree, index, and the ignored file.
  await writeFile(join(repo, "f1.txt"), "destroyed\n");
  await writeFile(join(repo, "f2.bin"), Buffer.alloc(64 * 1024));
  await writeFile(join(repo, "log.txt"), "log v3\n");
  await writeFile(join(repo, "notes.txt"), "note destroyed\n");
  await rm(join(repo, "sub/dir/deep.txt"));
  await writeFile(join(repo, "secret.txt"), "secret changed\n");
  await writeFile(join(repo, "newfile.txt"), "newer data\n");
  await git(repo, "reset", "-q"); // index back to HEAD

  const result = await restoreGitCheckpoint(repo, encoded);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const report = result.value;

  assert.equal(await readFile(join(repo, "f1.txt"), "utf8"), armedF1);
  assert.deepEqual(await readFile(join(repo, "f2.bin")), armedF2);
  assert.equal(await readFile(join(repo, "log.txt"), "utf8"), armedLog);
  assert.equal(await readFile(join(repo, "notes.txt"), "utf8"), "note base\n");
  assert.equal(await readFile(join(repo, "sub/dir/deep.txt"), "utf8"), "deep untracked\n");
  // Ignored untracked content is never touched and never reported.
  assert.equal(await readFile(join(repo, "secret.txt"), "utf8"), "secret changed\n");
  assert.ok(!report.leftBehind.includes("secret.txt"));
  // Newer non-ignored untracked data is preserved and reported.
  assert.equal(await readFile(join(repo, "newfile.txt"), "utf8"), "newer data\n");
  assert.deepEqual(report.leftBehind, ["newfile.txt"]);

  // Index and worktree converged exactly on the armed state.
  assert.equal(await git(repo, "diff", "--cached", "--binary"), stagedRef);
  assert.equal(await git(repo, "diff", "--binary"), unstagedRef);
});

test("restore works after HEAD moves, gc --prune=now, and a fresh process", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f1.txt"), "one\n");
  await commitAll(repo, "base f1");
  const armedF1 = "one\nstaged\nunstaged\n";
  await writeFile(join(repo, "f1.txt"), "one\nstaged\n");
  await git(repo, "add", "f1.txt");
  await writeFile(join(repo, "f1.txt"), armedF1);
  await writeFile(join(repo, "notes.txt"), "untracked baseline\n");

  const arm = await armGitCheckpoint(repo, "window-gc");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;
  const recordFile = join(await mkTmp(), "record.json");
  await writeFile(recordFile, arm.value.encoded);
  const base = arm.value.record.base;

  // Move HEAD forward and run an aggressive GC. The owned pin ref must keep
  // the baseline commit alive.
  await writeFile(join(repo, "f1.txt"), "moved\n");
  await commitAll(repo, "move head");
  assert.notEqual(await headOid(repo), base);
  await git(repo, "gc", "--prune=now", "-q");
  const baseStillPresent = await gitTolerant(repo, "cat-file", "-e", `${base}^{commit}`);
  assert.equal(baseStillPresent.code, 0, "pin ref failed to keep the base commit alive through gc");

  // Destroy the worktree and index.
  await writeFile(join(repo, "f1.txt"), "destroyed\n");
  await rm(join(repo, "notes.txt"));
  await git(repo, "reset", "-q");

  // Restore from a FRESH node process using only the durable record file.
  const modulePath = join(__dirname, "..", "src", "git-checkpoint.js");
  const resultFile = join(await mkTmp(), "result.json");
  const childScript = [
    "const m = require(process.argv[1]);",
    "const fs = require('fs');",
    "(async () => {",
    "  const encoded = fs.readFileSync(process.argv[2], 'utf8');",
    "  const res = await m.restoreGitCheckpoint(process.argv[3], encoded);",
    "  fs.writeFileSync(process.argv[4], JSON.stringify(res.status === 'ok' ? { ok: true } : res));",
    "  process.exit(res.status === 'ok' ? 0 : 1);",
    "})().catch((e) => { console.error(e); process.exit(2); });",
  ].join("\n");
  let childCode = 0;
  try {
    execFileSync(process.execPath, ["-e", childScript, modulePath, recordFile, repo, resultFile], { stdio: "pipe" });
  } catch (error) {
    const err = error as { code?: number | string };
    childCode = typeof err.code === "number" ? err.code : 1;
  }
  assert.equal(childCode, 0, `fresh-process restore failed: ${await readFile(resultFile, "utf8").catch(() => "?")}`);

  // Exact reconstruction in the parent process.
  assert.equal(await readFile(join(repo, "f1.txt"), "utf8"), armedF1);
  assert.equal(await readFile(join(repo, "notes.txt"), "utf8"), "untracked baseline\n");
  const stagedAfter = await git(repo, "diff", "--cached", "--binary");
  assert.match(stagedAfter, /f1\.txt/);
  const unstagedAfter = await git(repo, "diff", "--binary");
  assert.match(unstagedAfter, /f1\.txt/);
});

test("restore reconstructs staged and unstaged deletions", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "keep.txt"), "keep\n");
  await writeFile(join(repo, "del-staged.txt"), "staged delete\n");
  await writeFile(join(repo, "del-unstaged.txt"), "unstaged delete\n");
  await commitAll(repo, "three files");

  // Staged deletion: removed from index, still present in worktree.
  await git(repo, "rm", "--cached", "-q", "del-staged.txt");
  // Unstaged deletion: removed from worktree only.
  await rm(join(repo, "del-unstaged.txt"));

  const arm = await armGitCheckpoint(repo, "window-delete");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;
  // The staged-deleted file is untracked from Git's view and must be captured.
  assert.ok(arm.value.record.untracked.some((e) => e.path === "del-staged.txt"));

  // Destroy: different content everywhere, index reset.
  await writeFile(join(repo, "keep.txt"), "destroyed\n");
  await writeFile(join(repo, "del-staged.txt"), "wrong\n");
  await writeFile(join(repo, "del-unstaged.txt"), "wrong\n");
  await git(repo, "reset", "-q");

  const result = await restoreGitCheckpoint(repo, arm.value.encoded);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  assert.equal(await readFile(join(repo, "keep.txt"), "utf8"), "keep\n");
  // Staged delete: the worktree file is part of the armed state (captured as
  // untracked at arm) and comes back with its exact bytes.
  assert.equal(await readFile(join(repo, "del-staged.txt"), "utf8"), "staged delete\n");
  // Unstaged delete: the deletion IS the armed worktree state — the file must
  // stay gone while the index keeps the entry.
  await assert.rejects(lstat(join(repo, "del-unstaged.txt")));
  const lsFiles = (await git(repo, "ls-files", "-z")).split("\0").filter(Boolean).sort();
  assert.ok(!lsFiles.includes("del-staged.txt"));
  assert.ok(lsFiles.includes("del-unstaged.txt"));
});

test("restore reconstructs staged and worktree-only renames", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "old-name.txt"), "rename me\n");
  await writeFile(join(repo, "b.txt"), "worktree rename source\n");
  await commitAll(repo, "pre-rename");

  // Staged rename.
  await git(repo, "mv", "old-name.txt", "new-name.txt");
  // Worktree rename: staged in the index, then unstaged for b.txt so the
  // worktree keeps c.txt while b.txt is an unstaged deletion.
  await git(repo, "mv", "b.txt", "c.txt");
  await git(repo, "reset", "-q", "--", "b.txt");

  const arm = await armGitCheckpoint(repo, "window-rename");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;

  // Destroy.
  await rm(join(repo, "new-name.txt"));
  await rm(join(repo, "c.txt"));
  await writeFile(join(repo, "old-name.txt"), "resurrected wrongly\n");
  await git(repo, "reset", "-q");

  const result = await restoreGitCheckpoint(repo, arm.value.encoded);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  assert.equal(await readFile(join(repo, "new-name.txt"), "utf8"), "rename me\n");
  await assert.rejects(lstat(join(repo, "old-name.txt")));
  // c.txt was staged-added while b.txt stayed in the index but left the
  // worktree: after restore c.txt is back with exact bytes and b.txt is gone.
  assert.equal(await readFile(join(repo, "c.txt"), "utf8"), "worktree rename source\n");
  await assert.rejects(lstat(join(repo, "b.txt")));
});

test("restore is byte-exact for staged and unstaged binary changes", async () => {
  const repo = await initRepo();
  const baseBin = randomBytes(1024 * 1024);
  await writeFile(join(repo, "big.bin"), baseBin);
  await commitAll(repo, "binary base");

  // Staged change: flip a chunk in the middle.
  const stagedBin = Buffer.from(baseBin);
  stagedBin.fill(0xa5, 512 * 1024, 512 * 1024 + 4096);
  await writeFile(join(repo, "big.bin"), stagedBin);
  await git(repo, "add", "big.bin");
  // Unstaged change: flip a different chunk.
  const armedBin = Buffer.from(stagedBin);
  armedBin.fill(0x5a, 64 * 1024, 64 * 1024 + 8192);
  await writeFile(join(repo, "big.bin"), armedBin);
  // Large untracked binary.
  const armedUntrackedBin = randomBytes(512 * 1024);
  await writeFile(join(repo, "untracked.bin"), armedUntrackedBin);

  const arm = await armGitCheckpoint(repo, "window-binary");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;

  // Destroy.
  await writeFile(join(repo, "big.bin"), Buffer.alloc(1024 * 1024));
  await rm(join(repo, "untracked.bin"));
  await git(repo, "reset", "-q");

  const result = await restoreGitCheckpoint(repo, arm.value.encoded);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  assert.deepEqual(await readFile(join(repo, "big.bin")), armedBin);
  assert.deepEqual(await readFile(join(repo, "untracked.bin")), armedUntrackedBin);
  // The staged delta is still exactly the staged bytes vs HEAD.
  const stagedAfter = await git(repo, "diff", "--cached", "--binary");
  assert.match(stagedAfter, /GIT binary patch/);
});

test("restore reconstructs worktree and index file modes", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "script.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(repo, "script.sh"), 0o755);
  await git(repo, "add", "script.sh");
  await writeFile(join(repo, "plain.sh"), "#!/bin/sh\necho plain\n");
  await git(repo, "add", "plain.sh");
  await git(repo, "commit", "-q", "-m", "scripts");

  // Staged mode change on plain.sh (644 → 755 in the index only).
  await git(repo, "update-index", "--chmod=+x", "plain.sh");
  // Unstaged mode change on script.sh (755 → 644 in the worktree only).
  await chmod(join(repo, "script.sh"), 0o644);

  const arm = await armGitCheckpoint(repo, "window-mode");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;

  // Destroy content and modes.
  await writeFile(join(repo, "script.sh"), "wrong\n");
  await chmod(join(repo, "script.sh"), 0o600);
  await writeFile(join(repo, "plain.sh"), "wrong\n");
  await chmod(join(repo, "plain.sh"), 0o644);
  await git(repo, "reset", "-q");

  const result = await restoreGitCheckpoint(repo, arm.value.encoded);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  // Armed worktree state: both files at 644 (the unstaged mode changes).
  assert.equal(await readFile(join(repo, "script.sh"), "utf8"), "#!/bin/sh\necho hi\n");
  assert.equal((await stat(join(repo, "script.sh"))).mode & 0o7777, 0o644);
  assert.equal(await readFile(join(repo, "plain.sh"), "utf8"), "#!/bin/sh\necho plain\n");
  assert.equal((await stat(join(repo, "plain.sh"))).mode & 0o7777, 0o644);
  // Armed index state: both at 755 (script.sh committed +x, plain.sh staged +x).
  // ls-files -s line format: "<mode> <oid> <stage>\t<path>"
  const stage = (await git(repo, "ls-files", "-s", "plain.sh", "script.sh")).trim().split("\n");
  for (const line of stage) {
    assert.equal(line.split(" ")[0], "100755");
  }
});

test("restore reconstructs tracked and untracked symlink targets", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "t1.txt"), "target one\n");
  await writeFile(join(repo, "t2.txt"), "target two\n");
  await git(repo, "add", "t1.txt", "t2.txt");
  await git(repo, "commit", "-q", "-m", "targets");
  await symlink("t1.txt", join(repo, "link1"));
  await git(repo, "add", "link1");
  await git(repo, "commit", "-q", "-m", "symlink");

  // Unstaged retarget of the tracked symlink.
  await rm(join(repo, "link1"));
  await symlink("t2.txt", join(repo, "link1"));
  // Untracked symlink.
  await writeFile(join(repo, "notes.txt"), "untracked baseline\n");
  await symlink("notes.txt", join(repo, "u-link"));

  const arm = await armGitCheckpoint(repo, "window-symlink");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;
  const uLinkEntry = arm.value.record.untracked.find((e) => e.path === "u-link");
  assert.equal(uLinkEntry?.kind, "symlink");
  assert.equal(uLinkEntry?.target, "notes.txt");

  // Destroy: retarget both symlinks and break the untracked one.
  await rm(join(repo, "link1"));
  await symlink("t1.txt", join(repo, "link1"));
  await rm(join(repo, "u-link"));
  await symlink("/nonexistent-target", join(repo, "u-link"));

  const result = await restoreGitCheckpoint(repo, arm.value.encoded);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  // Armed state: link1 retargeted to t2.txt (the unstaged change).
  assert.equal(await readlink(join(repo, "link1")), "t2.txt");
  assert.equal(await readlink(join(repo, "u-link")), "notes.txt");
});

test("malformed, missing, and mismatched pins fail closed without mutation", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f.txt"), "v1\n");
  await commitAll(repo, "base f");
  await writeFile(join(repo, "f.txt"), "v2 staged\n");
  await git(repo, "add", "f.txt");

  const arm = await armGitCheckpoint(repo, "window-pin");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;
  const encoded = arm.value.encoded;
  const ref = checkpointRefForWindow("window-pin");

  const snapshot = async () => ({
    index: await readFile(indexPath(repo)),
    status: await git(repo, "status", "--porcelain"),
  });
  const assertUnchanged = async (before: { index: Buffer; status: string }) => {
    assert.deepEqual(await readFile(indexPath(repo)), before.index);
    assert.equal(await git(repo, "status", "--porcelain"), before.status);
  };

  // 1. Malformed record (corrupted JSON).
  const before1 = await snapshot();
  const badJson = encoded.slice(0, encoded.length - 2) + "x}";
  const malformed = await restoreGitCheckpoint(repo, badJson);
  assert.equal(malformed.status, "failed");
  if (malformed.status === "failed") assert.equal(malformed.reason, "malformed_record");
  await assertUnchanged(before1);

  // 2. Valid record whose pin ref was deleted.
  await git(repo, "update-ref", "-d", ref);
  const before2 = await snapshot();
  const missing = await restoreGitCheckpoint(repo, encoded);
  assert.equal(missing.status, "failed");
  if (missing.status === "failed") assert.equal(missing.reason, "pin_ref_missing");
  await assertUnchanged(before2);

  // 3. Pin ref moved to a different commit.
  await commitAll(repo, "extra commit");
  const otherHead = await headOid(repo);
  await git(repo, "update-ref", ref, otherHead);
  const before3 = await snapshot();
  const mismatch = await restoreGitCheckpoint(repo, encoded);
  assert.equal(mismatch.status, "failed");
  if (mismatch.status === "failed") assert.equal(mismatch.reason, "pin_ref_mismatch");

  // compare fails closed on the same conditions.
  const cmpMissing = await compareToGitCheckpoint(repo, encoded);
  assert.equal(cmpMissing.status, "failed");
  if (cmpMissing.status === "failed") assert.equal(cmpMissing.reason, "pin_ref_mismatch");

  // No mutation happened across attempts 3 and the compare.
  await assertUnchanged(before3);
});

test("capture races and aborts fail closed and clean up the pin", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "notes.txt"), "untracked baseline\n");

  // Race: the untracked file changes between pre-stat and read.
  const raced = await armGitCheckpoint(repo, "window-race", {
    faultHooks: {
      beforeUntrackedRead: async (absolutePath) => {
        await writeFile(absolutePath, "changed mid-capture\n");
      },
    },
  });
  assert.equal(raced.status, "failed");
  if (raced.status === "failed") assert.equal(raced.reason, "untracked_capture_race");
  const refGone = await gitTolerant(repo, "rev-parse", "--verify", "--quiet", checkpointRefForWindow("window-race"));
  assert.notEqual(refGone.code, 0, "owned pin ref must be removed after a failed arm");
  const scratchGone = await stat(join(repo, ".git", "pi-review-gate", "checkpoints", "window-race")).then(
    () => false,
    () => true,
  );
  assert.ok(scratchGone, "owned scratch must be removed after a failed arm");

  // Abort before any Git work.
  const controller = new AbortController();
  controller.abort();
  const aborted = await armGitCheckpoint(repo, "window-abort", { signal: controller.signal });
  assert.equal(aborted.status, "failed");
  if (aborted.status === "failed") assert.equal(aborted.reason, "aborted");
});

test("interleaved git add between the two diffs fails closed instead of publishing an empty-patch baseline", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f.txt"), "v1\n");
  await commitAll(repo, "base f");
  // An unstaged tracked edit exists throughout the arm.
  await writeFile(join(repo, "f.txt"), "v2 edited\n");

  const ref = checkpointRefForWindow("window-add-race");
  // Sentinels: if the hook never runs, the post-failure assertions below
  // cannot match and the test fails.
  let indexAfterHook = Buffer.alloc(0);
  let fileAfterHook = Buffer.alloc(0);
  let statusAfterHook = "";
  const raced = await armGitCheckpoint(repo, "window-add-race", {
    faultHooks: {
      betweenPatchCaptures: async () => {
        const base = await headOid(repo);
        // Pre-add the index still equals base, so the staged patch arm just
        // captured is empty...
        assert.equal(await git(repo, "diff", "--cached", "--binary", base), "");
        // The race: stage the edit after the staged diff but before the
        // unstaged diff.
        await git(repo, "add", "f.txt");
        // ...and post-add the worktree equals the index, so the unstaged
        // patch arm is about to capture is empty too. Two empty patches would
        // replay as a clean base although this edit existed throughout.
        assert.equal(await git(repo, "diff", "--binary"), "");
        indexAfterHook = await readFile(indexPath(repo));
        fileAfterHook = await readFile(join(repo, "f.txt"));
        statusAfterHook = await git(repo, "status", "--porcelain");
      },
    },
  });
  assert.equal(raced.status, "failed");
  if (raced.status === "failed") assert.equal(raced.reason, "capture_inconsistent");

  // The checkpoint machinery itself must not have touched the live index or
  // worktree beyond the injected race: bytes are exactly what the hook left.
  assert.deepEqual(await readFile(indexPath(repo)), indexAfterHook);
  assert.deepEqual(await readFile(join(repo, "f.txt")), fileAfterHook);
  assert.equal(await git(repo, "status", "--porcelain"), statusAfterHook);

  // No owned pin ref and no published record/scratch survive the failure.
  const refGone = await gitTolerant(repo, "rev-parse", "--verify", "--quiet", ref);
  assert.notEqual(refGone.code, 0, "owned pin ref must be removed after an inconsistent capture");
  const scratchGone = await stat(join(repo, ".git", "pi-review-gate", "checkpoints", "window-add-race")).then(
    () => false,
    () => true,
  );
  assert.ok(scratchGone, "owned scratch must be removed after an inconsistent capture");
});

test("tracked worktree edit between the two diffs fails closed before publishing a record", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f.txt"), "v1\n");
  await commitAll(repo, "base f");
  // An unstaged tracked edit exists throughout the arm.
  await writeFile(join(repo, "f.txt"), "v2 edited\n");

  const ref = checkpointRefForWindow("window-wt-race");
  // Sentinels: if the hook never runs, the post-failure assertions below
  // cannot match and the test fails.
  let indexAfterHook = Buffer.alloc(0);
  let fileAfterHook = Buffer.alloc(0);
  let statusAfterHook = "";
  const raced = await armGitCheckpoint(repo, "window-wt-race", {
    faultHooks: {
      betweenPatchCaptures: async () => {
        // The race: rewrite the tracked file after the pre-capture signature
        // but before the unstaged diff is captured. The index never moves.
        await writeFile(join(repo, "f.txt"), "v3 raced\n");
        indexAfterHook = await readFile(indexPath(repo));
        fileAfterHook = await readFile(join(repo, "f.txt"));
        statusAfterHook = await git(repo, "status", "--porcelain");
      },
    },
  });
  assert.equal(raced.status, "failed");
  if (raced.status === "failed") assert.equal(raced.reason, "capture_inconsistent");

  // The checkpoint machinery itself must not have touched the live index or
  // worktree beyond the injected race: bytes are exactly what the hook left.
  assert.deepEqual(await readFile(indexPath(repo)), indexAfterHook);
  assert.deepEqual(await readFile(join(repo, "f.txt")), fileAfterHook);
  assert.equal(await git(repo, "status", "--porcelain"), statusAfterHook);

  // No owned pin ref and no published record/scratch survive the failure.
  const refGone = await gitTolerant(repo, "rev-parse", "--verify", "--quiet", ref);
  assert.notEqual(refGone.code, 0, "owned pin ref must be removed after an inconsistent capture");
  const scratchGone = await stat(join(repo, ".git", "pi-review-gate", "checkpoints", "window-wt-race")).then(
    () => false,
    () => true,
  );
  assert.ok(scratchGone, "owned scratch must be removed after an inconsistent capture");
});

test("arm succeeds with a split index and leaves the live index and shared part untouched", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f.txt"), "v1\n");
  await commitAll(repo, "base f");

  // Enable a split index: most entries move to $GIT_DIR/sharedindex.<oid>
  // and the live index keeps only the delta.
  await git(repo, "config", "core.splitIndex", "true");
  await git(repo, "update-index", "--split-index");
  const sharedBefore = (await readdir(join(repo, ".git"))).filter((n) => n.startsWith("sharedindex."));
  assert.ok(sharedBefore.length > 0, "test setup: split index must create a shared part");

  // An unstaged tracked edit exists throughout the arm.
  await writeFile(join(repo, "f.txt"), "v2 edited\n");
  const indexBefore = await readFile(indexPath(repo));

  // Premise for the consistency check: write-tree against an out-of-dir copy
  // of the split index must still see the FULL entry set — the shared part
  // is resolved via the git dir, not relative to the copy. A delta-only read
  // would silently weaken the index-stability check.
  const copyPath = join(await mkTmp(), "index-copy");
  await copyFile(indexPath(repo), copyPath);
  const { stdout: treeOut } = await execFileAsync("git", ["write-tree"], {
    cwd: repo,
    env: { ...GIT_ENV, GIT_INDEX_FILE: copyPath },
  });
  const treePaths = (await git(repo, "ls-tree", "-r", "--name-only", treeOut.trim()))
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(treePaths, (await git(repo, "ls-files")).split("\n").filter(Boolean).sort());

  const arm = await armGitCheckpoint(repo, "window-split");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;
  // The index equals HEAD: only the unstaged delta is captured.
  assert.equal(arm.value.stats.stagedPatchBytes, 0);
  assert.ok(arm.value.stats.unstagedPatchBytes > 0);

  // The live index bytes and the shared part are untouched by the arm.
  assert.deepEqual(await readFile(indexPath(repo)), indexBefore);
  const sharedAfter = (await readdir(join(repo, ".git"))).filter((n) => n.startsWith("sharedindex."));
  assert.deepEqual(sharedAfter, sharedBefore);
});

test("unsafe window ids are rejected", async () => {
  const repo = await initRepo();
  for (const id of ["../evil", "", "a/b", "ends.", "..hidden"]) {
    const result = await armGitCheckpoint(repo, id);
    assert.equal(result.status, "failed", `expected failure for ${JSON.stringify(id)}`);
    if (result.status === "failed") assert.equal(result.reason, "unsafe_window_id");
  }
});

test("fail-closed gates refuse unsafe repository states", async () => {
  // not_a_git_repository: a plain directory.
  const plain = await mkTmp();
  const notRepo = await armGitCheckpoint(plain, "w1");
  assert.equal(notRepo.status, "unsupported");
  if (notRepo.status === "unsupported") assert.equal(notRepo.reason, "not_a_git_repository");

  // not_repository_root: a subdirectory of a real repo.
  const repo = await initRepo();
  await mkdir(join(repo, "sub"), { recursive: true });
  const sub = await armGitCheckpoint(join(repo, "sub"), "w2");
  assert.equal(sub.status, "unsupported");
  if (sub.status === "unsupported") assert.equal(sub.reason, "not_repository_root");

  // unborn_head: initialized but no commits.
  const unborn = await mkTmp();
  await git(unborn, "init", "-q");
  const unbornResult = await armGitCheckpoint(unborn, "w3");
  assert.equal(unbornResult.status, "unsupported");
  if (unbornResult.status === "unsupported") assert.equal(unbornResult.reason, "unborn_head");

  // diff_program_configured: a diff driver with an external command.
  const diffRepo = await initRepo();
  await git(diffRepo, "config", "diff.mytool.command", "/bin/echo-evil");
  const diffResult = await armGitCheckpoint(diffRepo, "w4");
  assert.equal(diffResult.status, "unsupported");
  if (diffResult.status === "unsupported") assert.equal(diffResult.reason, "diff_program_configured");

  // filter_or_eol_configured: autocrlf.
  const crlfRepo = await initRepo();
  await git(crlfRepo, "config", "core.autocrlf", "true");
  const crlfResult = await armGitCheckpoint(crlfRepo, "w5");
  assert.equal(crlfResult.status, "unsupported");
  if (crlfResult.status === "unsupported") assert.equal(crlfResult.reason, "filter_or_eol_configured");

  // filter_or_eol_configured: a clean/smudge filter.
  const filterRepo = await initRepo();
  await git(filterRepo, "config", "filter.lfs.smudge", "git-lfs smudge %s");
  const filterResult = await armGitCheckpoint(filterRepo, "w6");
  assert.equal(filterResult.status, "unsupported");
  if (filterResult.status === "unsupported") assert.equal(filterResult.reason, "filter_or_eol_configured");

  // text_attribute_in_use: a tracked file with the text attribute.
  const attrRepo = await initRepo();
  await writeFile(join(attrRepo, ".gitattributes"), "*.txt text\n");
  await writeFile(join(attrRepo, "doc.txt"), "text file\n");
  await commitAll(attrRepo, "attrs");
  const attrResult = await armGitCheckpoint(attrRepo, "w7");
  assert.equal(attrResult.status, "unsupported");
  if (attrResult.status === "unsupported") assert.equal(attrResult.reason, "text_attribute_in_use");

  // assume_unchanged_entry.
  const assumeRepo = await initRepo();
  await git(assumeRepo, "update-index", "--assume-unchanged", "README.md");
  const assumeResult = await armGitCheckpoint(assumeRepo, "w8");
  assert.equal(assumeResult.status, "unsupported");
  if (assumeResult.status === "unsupported") assert.equal(assumeResult.reason, "assume_unchanged_entry");

  // skip_worktree_entry.
  const skipRepo = await initRepo();
  await git(skipRepo, "update-index", "--skip-worktree", "README.md");
  const skipResult = await armGitCheckpoint(skipRepo, "w9");
  assert.equal(skipResult.status, "unsupported");
  if (skipResult.status === "unsupported") assert.equal(skipResult.reason, "skip_worktree_entry");

  // unmerged_index_entry: a real merge conflict.
  const mergeRepo = await initRepo();
  await writeFile(join(mergeRepo, "conflict.txt"), "base\n");
  await commitAll(mergeRepo, "conflict base");
  await git(mergeRepo, "checkout", "-q", "-b", "side");
  await writeFile(join(mergeRepo, "conflict.txt"), "side\n");
  await commitAll(mergeRepo, "side change");
  await git(mergeRepo, "checkout", "-q", "-");
  await writeFile(join(mergeRepo, "conflict.txt"), "main\n");
  await commitAll(mergeRepo, "main change");
  await gitTolerant(mergeRepo, "merge", "side"); // conflict
  const mergeResult = await armGitCheckpoint(mergeRepo, "w10");
  assert.equal(mergeResult.status, "unsupported");
  if (mergeResult.status === "unsupported") assert.equal(mergeResult.reason, "unmerged_index_entry");

  // submodule_tracked: a tracked gitlink.
  const subInner = await mkTmp();
  await git(subInner, "init", "-q");
  await writeFile(join(subInner, "inner.txt"), "inner\n");
  await commitAll(subInner, "inner");
  const subOuter = await initRepo();
  // Recent git refuses file-transport submodule clones by default.
  await git(subOuter, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subInner, "sub");
  await commitAll(subOuter, "add submodule");
  const subResult = await armGitCheckpoint(subOuter, "w11");
  assert.equal(subResult.status, "unsupported");
  if (subResult.status === "unsupported") assert.equal(subResult.reason, "submodule_tracked");
});

test("compare reports tracked and untracked deltas lazily", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f.txt"), "v1\n");
  await commitAll(repo, "base f");
  await writeFile(join(repo, "u.txt"), "u1\n");
  await writeFile(join(repo, "m.txt"), "m1\n");

  const arm = await armGitCheckpoint(repo, "window-cmp");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;
  const encoded = arm.value.encoded;

  // No changes yet: everything empty.
  const clean = await compareToGitCheckpoint(repo, encoded);
  assert.equal(clean.status, "ok");
  if (clean.status === "ok") {
    assert.deepEqual(clean.value.trackedChanges, []);
    assert.deepEqual(clean.value.untrackedAdded, []);
    assert.deepEqual(clean.value.untrackedRemoved, []);
    assert.deepEqual(clean.value.untrackedModified, []);
  }

  // Now: modify a tracked file, add/remove/modify untracked.
  await writeFile(join(repo, "f.txt"), "v2\n");
  await writeFile(join(repo, "n.txt"), "n1\n");
  await rm(join(repo, "u.txt"));
  await writeFile(join(repo, "m.txt"), "m2\n");

  const full = await compareToGitCheckpoint(repo, encoded, {}, true);
  assert.equal(full.status, "ok");
  if (full.status !== "ok") return;
  assert.deepEqual(full.value.trackedChanges, [
    { path: "f.txt", status: "modified", oldBytes: Buffer.from("v1\n"), newBytes: Buffer.from("v2\n") },
  ]);
  assert.deepEqual(full.value.untrackedAdded, ["n.txt"]);
  assert.deepEqual(full.value.untrackedRemoved, ["u.txt"]);
  assert.deepEqual(full.value.untrackedModified, ["m.txt"]);

  // Without includeContents no blob bytes are materialized.
  const namesOnly = await compareToGitCheckpoint(repo, encoded);
  assert.equal(namesOnly.status, "ok");
  if (namesOnly.status === "ok") {
    assert.deepEqual(namesOnly.value.trackedChanges, [{ path: "f.txt", status: "modified" }]);
  }

  // Compare must not mutate the repository.
  assert.equal(await readFile(join(repo, "f.txt"), "utf8"), "v2\n");
});

test("compare leaves index bytes untouched and restore backs up the original index", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f.txt"), "base\n");
  await commitAll(repo, "add tracked file");
  const armed = await armGitCheckpoint(repo, "window-index-bytes");
  assert.equal(armed.status, "ok");
  if (armed.status !== "ok") return;

  // Seed a tree cache, then invalidate it by staging a new version. Plain
  // write-tree can rewrite this live index even with optional locks disabled.
  await git(repo, "write-tree");
  await writeFile(join(repo, "f.txt"), "staged change\n");
  await git(repo, "add", "f.txt");
  const before = await readFile(indexPath(repo));

  const compared = await compareToGitCheckpoint(repo, armed.value.encoded, {}, true);
  assert.equal(compared.status, "ok");
  if (compared.status === "ok") {
    assert.deepEqual(compared.value.trackedChanges, [{
      path: "f.txt", status: "modified", oldBytes: Buffer.from("base\n"), newBytes: Buffer.from("staged change\n"),
    }]);
  }
  assert.deepEqual(await readFile(indexPath(repo)), before, "comparison must not refresh the live index");

  const restored = await restoreGitCheckpoint(repo, armed.value.encoded);
  assert.equal(restored.status, "ok");
  if (restored.status !== "ok") return;
  assert.deepEqual(await readFile(join(restored.value.scratchDir, "index-backup")), before,
    "restore must back up the original live index bytes before its atomic swap");
  assert.equal(await readFile(join(repo, "f.txt"), "utf8"), "base\n");
});

test("release removes the pin and scratch idempotently", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "notes.txt"), "untracked baseline\n");
  const arm = await armGitCheckpoint(repo, "window-rel");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;
  const base = arm.value.record.base;
  const armId = arm.value.descriptor.armId;

  const ref = checkpointRefForWindow("window-rel");
  const scratch = join(repo, ".git", "pi-review-gate", "checkpoints", "window-rel");
  assert.equal((await gitTolerant(repo, "rev-parse", "--verify", "--quiet", ref)).code, 0);
  await stat(scratch);

  // Destructive release requires BOTH owner proofs. An unguarded (or
  // malformed) call must fail closed and remove nothing: without the guards
  // it could delete a different owner's pin for the same window id —
  // including a newer generation armed at the very same commit.
  const unguarded = await releaseGitCheckpointPin(repo, "window-rel", {} as GitCheckpointReleaseOptions);
  assert.equal(unguarded.status, "failed");
  if (unguarded.status === "failed") assert.equal(unguarded.reason, "release_owner_required");
  const badOwner = await releaseGitCheckpointPin(repo, "window-rel", { expectedBase: "not-an-oid" } as GitCheckpointReleaseOptions);
  assert.equal(badOwner.status, "failed");
  if (badOwner.status === "failed") assert.equal(badOwner.reason, "release_owner_required");
  const badGeneration = await releaseGitCheckpointPin(repo, "window-rel", { expectedBase: base, armId: "not-a-nonce" });
  assert.equal(badGeneration.status, "failed");
  if (badGeneration.status === "failed") assert.equal(badGeneration.reason, "release_owner_required");
  assert.equal(
    (await gitTolerant(repo, "rev-parse", "--verify", "--quiet", ref)).code,
    0,
    "unguarded release must not delete the pin",
  );
  await stat(scratch);

  const first = await releaseGitCheckpointPin(repo, "window-rel", { expectedBase: base, armId });
  assert.equal(first.status, "ok");
  if (first.status === "ok") assert.equal(first.value.released, true);
  assert.notEqual((await gitTolerant(repo, "rev-parse", "--verify", "--quiet", ref)).code, 0);
  await assert.rejects(stat(scratch));

  const second = await releaseGitCheckpointPin(repo, "window-rel", { expectedBase: base, armId });
  assert.equal(second.status, "ok");
  if (second.status === "ok") assert.equal(second.value.released, false);
});

test("oversized patches fail closed and clean up", async () => {
  const repo = await initRepo();
  const big = randomBytes(10 * 1024);
  await writeFile(join(repo, "big.txt"), big);
  await commitAll(repo, "big base");
  await writeFile(join(repo, "big.txt"), randomBytes(10 * 1024));
  await git(repo, "add", "big.txt");

  const result = await armGitCheckpoint(repo, "window-overflow", { maxPatchBytes: 1024 });
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reason, "patch_too_large");
  const refGone = await gitTolerant(repo, "rev-parse", "--verify", "--quiet", checkpointRefForWindow("window-overflow"));
  assert.notEqual(refGone.code, 0);
  const scratchGone = await stat(join(repo, ".git", "pi-review-gate", "checkpoints", "window-overflow")).then(
    () => false,
    () => true,
  );
  assert.ok(scratchGone);
});

test("restore reports both sides of a rename-shaped deviation", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "p.txt"), "identical bytes\n");
  await chmod(join(repo, "p.txt"), 0o755);
  await commitAll(repo, "clean p");

  const arm = await armGitCheckpoint(repo, "window-renamedge");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;

  // Deviation shaped like a rename: stage a byte-identical copy Q and delete
  // P from the worktree only. Rename detection would collapse this pair to
  // the post-image name and drop P from the changed set.
  await copyFile(join(repo, "p.txt"), join(repo, "q.txt"));
  await git(repo, "add", "q.txt");
  await rm(join(repo, "p.txt"));

  const result = await restoreGitCheckpoint(repo, arm.value.encoded);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  // P must be re-created with its exact bytes and mode; Q must be removed.
  assert.equal(await readFile(join(repo, "p.txt"), "utf8"), "identical bytes\n");
  assert.equal((await stat(join(repo, "p.txt"))).mode & 0o7777, 0o755);
  await assert.rejects(lstat(join(repo, "q.txt")));
  // Both sides of the pair were materialized.
  assert.ok(result.value.materializedPaths.includes("p.txt"), "p.txt missing from materializedPaths");
  assert.ok(result.value.materializedPaths.includes("q.txt"), "q.txt missing from materializedPaths");
});

test("leftBehind reports leftovers that the index swap re-tracks", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "p.txt"), "armed\n");
  await commitAll(repo, "p base");

  // Armed state: P tracked in the index with an unstaged worktree deletion.
  await rm(join(repo, "p.txt"));
  const arm = await armGitCheckpoint(repo, "window-leftbehind");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;

  // Later: P is removed from the index and re-created with newer bytes.
  await git(repo, "rm", "--cached", "-q", "p.txt");
  await writeFile(join(repo, "p.txt"), "newer\n");

  const result = await restoreGitCheckpoint(repo, arm.value.encoded);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  // The newer file is preserved (never destroyed) and surfaced: after the
  // swap P is tracked again, so only the pre-swap listing can see it.
  assert.equal(await readFile(join(repo, "p.txt"), "utf8"), "newer\n");
  assert.deepEqual(result.value.leftBehind, ["p.txt"]);
});

test("materialization refuses to write through symlinked parent directories", async () => {
  const repo = await initRepo();
  await mkdir(join(repo, "d"));
  await writeFile(join(repo, "d/f.txt"), "content\n");
  await commitAll(repo, "d/f");

  const arm = await armGitCheckpoint(repo, "window-contain");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;

  // Replace the tracked parent directory with a symlink pointing outside the
  // repository. A restore that writes d/f.txt must fail closed instead of
  // following the link and clobbering files outside repo.root.
  const outside = await mkTmp();
  const indexBefore = await readFile(indexPath(repo));
  await rm(join(repo, "d"), { recursive: true, force: true });
  await symlink(outside, join(repo, "d"));

  const result = await restoreGitCheckpoint(repo, arm.value.encoded);
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reason, "restore_path_conflict");

  // Nothing was written outside the repository and the live index is intact.
  await assert.rejects(lstat(join(outside, "f.txt")));
  assert.deepEqual(await readFile(indexPath(repo)), indexBefore);
});

test("restore accepts legal top-level names that begin with dots", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "..env"), "dot-dot env\n");
  await commitAll(repo, "dotdot file");

  const arm = await armGitCheckpoint(repo, "window-dotdot");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;

  await writeFile(join(repo, "..env"), "destroyed\n");

  const result = await restoreGitCheckpoint(repo, arm.value.encoded);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  // A name that merely begins with dots is contained, not traversal.
  assert.equal(await readFile(join(repo, "..env"), "utf8"), "dot-dot env\n");
});

test("restore recreates a tracked symlink whose parent directory was removed", async () => {
  const repo = await initRepo();
  await mkdir(join(repo, "d"));
  await writeFile(join(repo, "target.txt"), "target\n");
  await symlink("../target.txt", join(repo, "d/link"));
  await commitAll(repo, "nested symlink");

  const arm = await armGitCheckpoint(repo, "window-nested-link");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;

  // Only the symlink lived in d; removing the directory must be recoverable.
  await rm(join(repo, "d"), { recursive: true, force: true });

  const result = await restoreGitCheckpoint(repo, arm.value.encoded);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(await readlink(join(repo, "d/link")), "../target.txt");
});

test("abort during capture removes the owned pin ref", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "a.txt"), "a\n");
  await writeFile(join(repo, "b.txt"), "b\n");

  const controller = new AbortController();
  const aborted = await armGitCheckpoint(repo, "window-abort-cleanup", {
    signal: controller.signal,
    faultHooks: {
      beforeUntrackedRead: () => {
        controller.abort();
      },
    },
  });
  assert.equal(aborted.status, "failed");
  if (aborted.status === "failed") assert.equal(aborted.reason, "aborted");
  const refGone = await gitTolerant(
    repo,
    "rev-parse",
    "--verify",
    "--quiet",
    checkpointRefForWindow("window-abort-cleanup"),
  );
  assert.notEqual(refGone.code, 0, "owned pin ref must be removed after an aborted arm");
});

test("fail-closed gates refuse attribute-driven byte conversions", async () => {
  // ident: checkout expands $Id$ to $Id:<blob>$, so the armed worktree bytes
  // are not the stored blob and are not reconstructible from it.
  const identRepo = await initRepo();
  await writeFile(join(identRepo, ".gitattributes"), "doc.txt ident\n");
  await writeFile(join(identRepo, "doc.txt"), "$Id$\n");
  await commitAll(identRepo, "ident attribute");
  const ident = await armGitCheckpoint(identRepo, "window-ident");
  assert.equal(ident.status, "unsupported");
  if (ident.status === "unsupported") assert.equal(ident.reason, "filter_or_eol_configured");

  // working-tree-encoding: the index stores UTF-8 while the worktree file is
  // UTF-16LE, so writing blob bytes would corrupt the worktree file.
  const wteRepo = await initRepo();
  await writeFile(join(wteRepo, ".gitattributes"), "utf16.txt working-tree-encoding=UTF-16LE\n");
  await writeFile(join(wteRepo, "utf16.txt"), Buffer.from("hello\n", "utf16le"));
  await git(wteRepo, "add", ".");
  await git(wteRepo, "commit", "-q", "-m", "working-tree-encoding attribute");
  const wte = await armGitCheckpoint(wteRepo, "window-wte");
  assert.equal(wte.status, "unsupported");
  if (wte.status === "unsupported") assert.equal(wte.reason, "filter_or_eol_configured");
});

test("unrepresentable path bytes are refused at the record boundary", () => {
  // U+FFFD is what lossy UTF-8 decoding produces for invalid Git path bytes.
  // Such a path cannot be mapped back to a real worktree entry, so the module
  // must refuse it instead of materializing a stray file under a mangled name.
  const record = {
    format: "prg-git-checkpoint/v2" as const,
    armId: "0123456789abcdef",
    base: "a".repeat(40),
    ref: checkpointRefForWindow("window-fffd"),
    objectFormat: "sha1" as const,
    stagedPatchB64: "",
    unstagedPatchB64: "",
    untracked: [
      {
        path: "bad\uFFFDname.txt",
        kind: "file" as const,
        mode: 0o100644,
        dev: 1,
        ino: 2,
        size: 1,
        mtimeMs: 1,
        ctimeMs: 1,
        contentB64: "AQ==",
      },
    ],
  };
  const encoded = encodeGitCheckpointRecord(record);
  assert.throws(() => decodeGitCheckpointRecord(encoded), /malformed checkpoint record/);
});

test("symlink targets that are not valid UTF-8 are refused at the record boundary", () => {
  // U+FFFD marks a lossy decode of raw symlink-target bytes; such a target
  // cannot be recreated byte-for-byte, so records carrying one are malformed.
  const record = {
    format: "prg-git-checkpoint/v2" as const,
    armId: "0123456789abcdef",
    base: "a".repeat(40),
    ref: checkpointRefForWindow("window-fffd-target"),
    objectFormat: "sha1" as const,
    stagedPatchB64: "",
    unstagedPatchB64: "",
    untracked: [
      {
        path: "link",
        kind: "symlink" as const,
        mode: 0o120777,
        dev: 1,
        ino: 3,
        size: 4,
        mtimeMs: 1,
        ctimeMs: 1,
        target: "bad\uFFFDtarget",
      },
    ],
  };
  const encoded = encodeGitCheckpointRecord(record);
  assert.throws(() => decodeGitCheckpointRecord(encoded), /malformed checkpoint record/);
});

test("unpaired UTF-16 surrogates in record strings are refused at the record boundary", () => {
  // JSON.parse preserves lone surrogate escapes; fs would silently encode
  // them as EF BF BD bytes, so they are not representable and must be
  // rejected rather than materialized by restore.
  const base = {
    format: "prg-git-checkpoint/v2" as const,
    armId: "0123456789abcdef",
    ref: checkpointRefForWindow("window-surrogate"),
    objectFormat: "sha1" as const,
    stagedPatchB64: "",
    unstagedPatchB64: "",
  };
  const badTarget = encodeGitCheckpointRecord({
    ...base,
    base: "a".repeat(40),
    untracked: [
      { path: "link", kind: "symlink" as const, mode: 0o120777, dev: 1, ino: 3, size: 4, mtimeMs: 1, ctimeMs: 1, target: "bad\ud800target" },
    ],
  });
  assert.throws(() => decodeGitCheckpointRecord(badTarget), /malformed checkpoint record/);
  const badPath = encodeGitCheckpointRecord({
    ...base,
    base: "a".repeat(40),
    untracked: [
      { path: "bad\ud800.txt", kind: "file" as const, mode: 0o100644, dev: 1, ino: 2, size: 1, mtimeMs: 1, ctimeMs: 1, contentB64: "AQ==" },
    ],
  });
  assert.throws(() => decodeGitCheckpointRecord(badPath), /malformed checkpoint record/);
});

test("symlink capture races fail closed and clean up the pin", async () => {
  const repo = await initRepo();
  await symlink("nowhere", join(repo, "u-link"));

  // Replace the symlink between its pre-stat and the readlink target read.
  const raced = await armGitCheckpoint(repo, "window-link-race", {
    faultHooks: {
      beforeUntrackedRead: async (absolutePath) => {
        await rm(absolutePath);
        await symlink("elsewhere", absolutePath);
      },
    },
  });
  assert.equal(raced.status, "failed");
  if (raced.status === "failed") assert.equal(raced.reason, "untracked_capture_race");
  const refGone = await gitTolerant(repo, "rev-parse", "--verify", "--quiet", checkpointRefForWindow("window-link-race"));
  assert.notEqual(refGone.code, 0, "owned pin ref must be removed after a raced arm");
});

test("duplicate-id arm attempts fail without touching a successful baseline", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f.txt"), "v1\n");
  await commitAll(repo, "base f");
  // A staged change well over the tiny cap used below: a duplicate arm that
  // were allowed to capture would fail on patch size.
  await writeFile(join(repo, "f.txt"), `v1\n${"x".repeat(4096)}\n`);
  await git(repo, "add", "f.txt");
  await writeFile(join(repo, "notes.txt"), "untracked baseline\n");

  const first = await armGitCheckpoint(repo, "window-dup");
  assert.equal(first.status, "ok");
  if (first.status !== "ok") return;
  const { record } = first.value;
  const ref = checkpointRefForWindow("window-dup");
  const windowScratch = join(repo, ".git", "pi-review-gate", "checkpoints", "window-dup");

  const snapshotBaseline = async () => ({
    refTarget: (await git(repo, "rev-parse", "--verify", ref)).trim(),
    scratch: await collectFiles(windowScratch),
    index: await readFile(indexPath(repo)),
    status: await git(repo, "status", "--porcelain"),
  });
  const before = await snapshotBaseline();
  assert.equal(before.refTarget, record.base);

  // 1. Plain duplicate-id arm: explicit safe failure, nothing touched.
  const dup = await armGitCheckpoint(repo, "window-dup");
  assert.equal(dup.status, "failed");
  if (dup.status === "failed") assert.equal(dup.reason, "pin_ref_exists");

  // 2. Duplicate-id arm that would fail on patch capture: the CAS refusal
  //    happens before any capture, so it reports pin_ref_exists too.
  const wouldOverflow = await armGitCheckpoint(repo, "window-dup", { maxPatchBytes: 16 });
  assert.equal(wouldOverflow.status, "failed");
  if (wouldOverflow.status === "failed") assert.equal(wouldOverflow.reason, "pin_ref_exists");

  // The successful baseline is byte-identical and still verifiable.
  const after = await snapshotBaseline();
  assert.deepEqual(after, before);
  const verify = await verifyGitCheckpointPin(repo, record);
  assert.equal(verify.status, "ok");

  // Move HEAD and prune aggressively: the first baseline's pin survives GC.
  await writeFile(join(repo, "f.txt"), "moved\n");
  await commitAll(repo, "move head");
  await git(repo, "gc", "--prune=now", "-q");
  const gcVerify = await verifyGitCheckpointPin(repo, record);
  assert.equal(gcVerify.status, "ok");
  assert.equal((await git(repo, "rev-parse", "--verify", ref)).trim(), record.base);
});

test("concurrent same-id arms leave exactly one verifiable baseline after gc", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f.txt"), "v1\n");
  await commitAll(repo, "base f");
  await writeFile(join(repo, "f.txt"), "v2 staged\n");
  await git(repo, "add", "f.txt");
  await writeFile(join(repo, "notes.txt"), "untracked baseline\n");

  const results = await Promise.all([
    armGitCheckpoint(repo, "window-conc"),
    armGitCheckpoint(repo, "window-conc"),
  ]);
  const oks = results.filter((r) => r.status === "ok");
  const fails = results.filter((r) => r.status !== "ok");
  assert.equal(oks.length, 1, `expected exactly one successful arm, got ${JSON.stringify(results.map((r) => r.status))}`);
  assert.equal(fails.length, 1);
  assert.equal(fails[0]!.status, "failed");
  if (fails[0]!.status === "failed") assert.equal(fails[0]!.reason, "pin_ref_exists");
  const winner = oks[0]!.value;

  // The loser must not have left its own state behind: exactly one arm
  // scratch subdirectory exists in the shared window dir.
  const windowScratch = join(repo, ".git", "pi-review-gate", "checkpoints", "window-conc");
  const entries = await readdir(windowScratch);
  assert.equal(entries.length, 1);
  assert.ok(entries[0]!.startsWith("arm-"));

  // Move HEAD and prune aggressively: the winner's pin keeps its baseline alive.
  await writeFile(join(repo, "f.txt"), "moved\n");
  await commitAll(repo, "move head");
  await git(repo, "gc", "--prune=now", "-q");

  const verify = await verifyGitCheckpointPin(repo, winner.record);
  assert.equal(verify.status, "ok");
  assert.equal(
    (await git(repo, "rev-parse", "--verify", checkpointRefForWindow("window-conc"))).trim(),
    winner.record.base,
  );
});

test("release with an owner guard refuses to remove a different checkpoint", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f.txt"), "v1\n");
  await commitAll(repo, "base f");
  await writeFile(join(repo, "f.txt"), "v2 staged\n");
  await git(repo, "add", "f.txt");

  const first = await armGitCheckpoint(repo, "window-guard");
  assert.equal(first.status, "ok");
  if (first.status !== "ok") return;
  const firstBase = first.value.record.base;
  const firstArmId = first.value.descriptor.armId;
  const ref = checkpointRefForWindow("window-guard");
  const windowScratch = join(repo, ".git", "pi-review-gate", "checkpoints", "window-guard");

  // The first generation is released and a newer checkpoint owns the same id.
  const relFirst = await releaseGitCheckpointPin(repo, "window-guard", { expectedBase: firstBase, armId: firstArmId });
  assert.equal(relFirst.status, "ok");
  if (relFirst.status === "ok") assert.equal(relFirst.value.released, true);

  await commitAll(repo, "new head");
  const second = await armGitCheckpoint(repo, "window-guard");
  assert.equal(second.status, "ok");
  if (second.status !== "ok") return;
  const secondBase = second.value.record.base;
  const secondArmId = second.value.descriptor.armId;
  assert.notEqual(secondBase, firstBase);
  assert.notEqual(secondArmId, firstArmId);

  const newerSnapshot = async () => ({
    refTarget: (await git(repo, "rev-parse", "--verify", ref)).trim(),
    scratch: await collectFiles(windowScratch),
  });
  const before = await newerSnapshot();
  assert.equal(before.refTarget, secondBase);

  // A stale release naming the OLD owner (base AND generation) must fail
  // and remove nothing; here the base check fires first.
  const stale = await releaseGitCheckpointPin(repo, "window-guard", { expectedBase: firstBase, armId: firstArmId });
  assert.equal(stale.status, "failed");
  if (stale.status === "failed") assert.equal(stale.reason, "pin_ref_mismatch");
  assert.deepEqual(await newerSnapshot(), before);

  // The correct owner (base AND generation) releases cleanly.
  const relSecond = await releaseGitCheckpointPin(repo, "window-guard", { expectedBase: secondBase, armId: secondArmId });
  assert.equal(relSecond.status, "ok");
  if (relSecond.status === "ok") assert.equal(relSecond.value.released, true);
  assert.notEqual((await gitTolerant(repo, "rev-parse", "--verify", "--quiet", ref)).code, 0);
  await assert.rejects(stat(windowScratch));

  // Guarded release of an already-released window is idempotent.
  const again = await releaseGitCheckpointPin(repo, "window-guard", { expectedBase: secondBase, armId: secondArmId });
  assert.equal(again.status, "ok");
  if (again.status === "ok") assert.equal(again.value.released, false);
});

test("arm publishes a durable record and returns a compact sidecar descriptor", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f.txt"), "v1\n");
  await commitAll(repo, "base f");

  // Staged change carrying a distinctive sentinel, plus a large untracked
  // payload: the record must be large while the descriptor stays compact.
  const stagedSentinel = "STAGED-SENTINEL-9f3a";
  await writeFile(join(repo, "f.txt"), `v1\n${stagedSentinel}\n`);
  await git(repo, "add", "f.txt");
  const untrackedPayload = Buffer.concat([Buffer.from("UNTRACKED-SENTINEL-77b2\n"), randomBytes(256 * 1024)]);
  await writeFile(join(repo, "big-untracked.bin"), untrackedPayload);

  const arm = await armGitCheckpoint(repo, "window-descriptor");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;
  const { record, descriptor, stats } = arm.value;

  // Descriptor fields: identity + integrity only.
  assert.equal(descriptor.format, "prg-git-checkpoint-descriptor/v1");
  assert.equal(descriptor.windowId, "window-descriptor");
  assert.match(descriptor.armId, /^[0-9a-f]{16}$/);
  assert.equal(record.armId, descriptor.armId);
  assert.equal(descriptor.base, record.base);
  assert.equal(descriptor.ref, checkpointRefForWindow("window-descriptor"));
  assert.equal(descriptor.objectFormat, "sha1");
  assert.match(descriptor.digest, /^[0-9a-f]{64}$/);
  assert.ok(isAbsolute(descriptor.gitDir));

  // Compact: bounded size and no patch/untracked content anywhere.
  const descriptorJson = encodeGitCheckpointDescriptor(descriptor);
  const descriptorBytes = Buffer.byteLength(descriptorJson, "utf8");
  assert.ok(descriptorBytes < 1024, `descriptor too large: ${descriptorBytes}`);
  assert.ok(!descriptorJson.includes(stagedSentinel), "descriptor must not carry staged patch content");
  assert.ok(!descriptorJson.includes("UNTRACKED-SENTINEL"), "descriptor must not carry untracked content");

  // The record is far larger: it carries the 256 KiB untracked payload.
  assert.ok(stats.recordBytes > 300 * 1024, `record unexpectedly small: ${stats.recordBytes}`);
  assert.ok(stats.recordBytes > descriptorBytes * 8, "descriptor must be compact relative to the record");

  // The published record lives in the arm's owned scratch dir and hashes to
  // the descriptor digest — a sidecar needs only the descriptor.
  const recordPath = join(
    descriptor.gitDir,
    "pi-review-gate",
    "checkpoints",
    "window-descriptor",
    `arm-${descriptor.armId}`,
    "record.json",
  );
  const published = await readFile(recordPath);
  assert.equal(createHash("sha256").update(published).digest("hex"), descriptor.digest);
  assert.equal(published.toString("utf8"), arm.value.encoded);

  // Round-trip through the strict decoder.
  assert.deepEqual(decodeGitCheckpointDescriptor(descriptorJson), descriptor);
});

test("fresh process loads from the descriptor after HEAD move and gc, restoring exact bytes", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f1.txt"), "one\n");
  await commitAll(repo, "base f1");
  const armedF1 = "one\nstaged\nunstaged\n";
  await writeFile(join(repo, "f1.txt"), "one\nstaged\n");
  await git(repo, "add", "f1.txt");
  await writeFile(join(repo, "f1.txt"), armedF1);
  const untrackedBytes = Buffer.concat([Buffer.from("untracked baseline\n"), randomBytes(64 * 1024)]);
  await writeFile(join(repo, "notes.bin"), untrackedBytes);

  const arm = await armGitCheckpoint(repo, "window-descriptor-gc");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;
  const base = arm.value.record.base;

  // The sidecar stores ONLY the compact descriptor — never the record.
  const sidecarFile = join(await mkTmp(), "sidecar.json");
  await writeFile(sidecarFile, encodeGitCheckpointDescriptor(arm.value.descriptor), "utf8");

  // Reference state captured at arm time (exact patches).
  const stagedRef = await git(repo, "diff", "--cached", "--binary");
  const unstagedRef = await git(repo, "diff", "--binary");

  // Move HEAD forward and run an aggressive GC. The owned pin ref must keep
  // the baseline commit alive.
  await writeFile(join(repo, "f1.txt"), "moved\n");
  await commitAll(repo, "move head");
  assert.notEqual(await headOid(repo), base);
  await git(repo, "gc", "--prune=now", "-q");

  // Destroy the worktree and index.
  await writeFile(join(repo, "f1.txt"), "destroyed\n");
  await rm(join(repo, "notes.bin"));
  await git(repo, "reset", "-q");

  // FRESH node process: descriptor → loadGitCheckpoint → restore, nothing
  // else. The full record never crosses the process boundary as a file.
  const modulePath = join(__dirname, "..", "src", "git-checkpoint.js");
  const resultFile = join(await mkTmp(), "result.json");
  const childScript = [
    "const m = require(process.argv[1]);",
    "const fs = require('fs');",
    "(async () => {",
    "  const descriptor = m.decodeGitCheckpointDescriptor(fs.readFileSync(process.argv[2], 'utf8'));",
    "  const loaded = await m.loadGitCheckpoint(process.argv[3], descriptor);",
    "  if (loaded.status !== 'ok') { fs.writeFileSync(process.argv[4], JSON.stringify(loaded)); process.exit(1); }",
    "  const res = await m.restoreGitCheckpoint(process.argv[3], loaded.value.encoded);",
    "  fs.writeFileSync(process.argv[4], JSON.stringify(res.status === 'ok' ? { ok: true } : res));",
    "  process.exit(res.status === 'ok' ? 0 : 1);",
    "})().catch((e) => { console.error(e); process.exit(2); });",
  ].join("\n");
  let childCode = 0;
  try {
    execFileSync(process.execPath, ["-e", childScript, modulePath, sidecarFile, repo, resultFile], { stdio: "pipe" });
  } catch (error) {
    const err = error as { code?: number | string };
    childCode = typeof err.code === "number" ? err.code : 1;
  }
  assert.equal(childCode, 0, `fresh-process descriptor load+restore failed: ${await readFile(resultFile, "utf8").catch(() => "?")}`);

  // Exact reconstruction of the armed state in the parent process. HEAD has
  // moved, so the staged delta is measured against the armed base commit.
  assert.equal(await readFile(join(repo, "f1.txt"), "utf8"), armedF1);
  assert.deepEqual(await readFile(join(repo, "notes.bin")), untrackedBytes);
  assert.equal(await git(repo, "diff", "--cached", "--binary", base), stagedRef);
  assert.equal(await git(repo, "diff", "--binary"), unstagedRef);
});

test("load fails closed on missing, corrupted, mismatched, and foreign data without mutating anything", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f.txt"), "v1\n");
  await commitAll(repo, "base f");
  await writeFile(join(repo, "f.txt"), "v2 staged\n");
  await git(repo, "add", "f.txt");
  await writeFile(join(repo, "notes.txt"), "untracked baseline\n");

  const arm = await armGitCheckpoint(repo, "window-load-fail");
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") return;
  const { record, descriptor } = arm.value;
  const encoded = arm.value.encoded;
  const ref = checkpointRefForWindow("window-load-fail");
  const recordPath = join(
    descriptor.gitDir,
    "pi-review-gate",
    "checkpoints",
    "window-load-fail",
    `arm-${descriptor.armId}`,
    "record.json",
  );
  const sidecarFile = join(await mkTmp(), "sidecar.json");
  await writeFile(sidecarFile, encodeGitCheckpointDescriptor(descriptor), "utf8");

  // Sanity: a clean load succeeds and returns the full record in memory.
  const ok = await loadGitCheckpoint(repo, descriptor);
  assert.equal(ok.status, "ok");
  if (ok.status === "ok") {
    assert.deepEqual(ok.value.record, record);
    assert.equal(ok.value.encoded, encoded);
  }

  // 1. Wrong checkout: the same descriptor in a different repository.
  const otherRepo = await initRepo();
  const wrongRepo = await loadGitCheckpoint(otherRepo, descriptor);
  assert.equal(wrongRepo.status, "failed");
  if (wrongRepo.status === "failed") assert.equal(wrongRepo.reason, "wrong_repository");

  // Case 1 never touched the sidecar or the published record.
  assert.equal((await readFile(sidecarFile)).toString("utf8"), encodeGitCheckpointDescriptor(descriptor));
  assert.equal((await readFile(recordPath)).toString("utf8"), encoded);

  // 4. Truncated record file: digest mismatch before any decode.
  await writeFile(recordPath, encoded.slice(0, 64), "utf8");
  const truncated = await loadGitCheckpoint(repo, descriptor);
  assert.equal(truncated.status, "failed");
  if (truncated.status === "failed") assert.equal(truncated.reason, "checkpoint_digest_mismatch");

  // 5. Record file missing entirely.
  await rm(recordPath);
  const noData = await loadGitCheckpoint(repo, descriptor);
  assert.equal(noData.status, "failed");
  if (noData.status === "failed") assert.equal(noData.reason, "checkpoint_data_missing");

  // 6. Structurally invalid record with a matching digest: strict decode
  //    still fails closed.
  const badJson = "{ definitely not json";
  const forgedDescriptor = { ...descriptor, digest: createHash("sha256").update(badJson, "utf8").digest("hex") };
  await writeFile(recordPath, badJson, "utf8");
  const malformed = await loadGitCheckpoint(repo, forgedDescriptor);
  assert.equal(malformed.status, "failed");
  if (malformed.status === "failed") assert.equal(malformed.reason, "malformed_record");

  // 7. Valid record with a tampered field and matching digest: the
  //    descriptor/record cross-check fails (the digest alone cannot bind the
  //    identity fields to the descriptor).
  const tampered = JSON.parse(encoded) as Record<string, unknown>;
  tampered.base = "b".repeat(40);
  const tamperedJson = JSON.stringify(tampered);
  const forged2 = { ...descriptor, digest: createHash("sha256").update(tamperedJson, "utf8").digest("hex") };
  await writeFile(recordPath, tamperedJson, "utf8");
  const fieldMismatch = await loadGitCheckpoint(repo, forged2);
  assert.equal(fieldMismatch.status, "failed");
  if (fieldMismatch.status === "failed") assert.equal(fieldMismatch.reason, "descriptor_record_mismatch");

  // 8. Structurally invalid descriptors are refused before any I/O.
  const badArm = await loadGitCheckpoint(repo, { ...descriptor, armId: "ZZ" });
  assert.equal(badArm.status, "failed");
  if (badArm.status === "failed") assert.equal(badArm.reason, "malformed_descriptor");
  for (const [field, value] of [
    ["windowId", "../evil"],
    ["ref", checkpointRefForWindow("another-window")],
    ["digest", "xyz"],
    ["gitDir", "relative/path"],
  ] as const) {
    const bad = await loadGitCheckpoint(repo, { ...descriptor, [field]: value });
    assert.equal(bad.status, "failed", `expected malformed_descriptor for ${field}`);
    if (bad.status === "failed") assert.equal(bad.reason, "malformed_descriptor");
  }
  assert.throws(() => decodeGitCheckpointDescriptor("not json"), /malformed checkpoint descriptor/);

  // 8b. Over-sized record: refused before buffering (the load path bounds
  // memory the way arm bounds its large captures). With tiny configured
  // caps the load cap is 2 * (2*16 + 16) = 96 bytes, so a 97-byte file
  // must fail at the size gate — before any digest/decode work.
  await writeFile(recordPath, "x".repeat(97), "utf8");
  const oversized = await loadGitCheckpoint(repo, descriptor, { maxPatchBytes: 16, maxUntrackedBytes: 16 });
  assert.equal(oversized.status, "failed");
  if (oversized.status === "failed") {
    assert.equal(oversized.reason, "malformed_record");
    assert.match(oversized.detail ?? "", /above the \d+-byte load cap/);
  }

  // 8c. Non-regular targets are refused before any read: a planted symlink
  // to a character device reports size 0 to stat but would read unbounded,
  // and a direct symlink is not the regular file publishRecordDurable
  // publishes (O_NOFOLLOW rejects it at open).
  await rm(recordPath);
  await symlink("/dev/zero", recordPath);
  const special = await loadGitCheckpoint(repo, descriptor);
  assert.equal(special.status, "failed");
  if (special.status === "failed") {
    assert.equal(special.reason, "malformed_record");
    assert.match(special.detail ?? "", /not a regular file/);
  }
  await rm(recordPath);
  await symlink(join(repo, "f.txt"), recordPath);
  const linked = await loadGitCheckpoint(repo, descriptor);
  assert.equal(linked.status, "failed");
  if (linked.status === "failed") {
    assert.equal(linked.reason, "malformed_record");
    assert.match(linked.detail ?? "", /symlink/);
  }
  // A symlink loop at the record path is planted data too: it fails closed
  // at the pre-read stat as malformed_record, not a git failure.
  await rm(recordPath);
  await symlink(recordPath, recordPath);
  const looped = await loadGitCheckpoint(repo, descriptor);
  assert.equal(looped.status, "failed");
  if (looped.status === "failed") {
    assert.equal(looped.reason, "malformed_record");
    assert.match(looped.detail ?? "", /symlink/);
  }
  // Remove the planted symlink so the healed load below writes a fresh
  // regular file.
  await rm(recordPath);

  // Restoring the published record makes the load verifiable again (the pin
  // was never destroyed above, so its generation proof is intact).
  await writeFile(recordPath, encoded, "utf8");
  const healed = await loadGitCheckpoint(repo, descriptor);
  assert.equal(healed.status, "ok");

  // 9. Pin moved to a different commit (run last: it leaves the pin moved,
  // so no further loads follow).
  await commitAll(repo, "extra commit");
  const otherHead = await headOid(repo);
  await git(repo, "update-ref", ref, otherHead);
  const moved = await loadGitCheckpoint(repo, descriptor);
  assert.equal(moved.status, "failed");
  if (moved.status === "failed") assert.equal(moved.reason, "pin_ref_mismatch");

  // 10. Pin deleted.
  await git(repo, "update-ref", "-d", ref);
  const missingPin = await loadGitCheckpoint(repo, descriptor);
  assert.equal(missingPin.status, "failed");
  if (missingPin.status === "failed") assert.equal(missingPin.reason, "pin_ref_missing");
});

test("stale same-base owner cannot release a newer arm reusing the window id", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f.txt"), "v1\n");
  await commitAll(repo, "base f");
  await writeFile(join(repo, "f.txt"), "v2 staged\n");
  await git(repo, "add", "f.txt");

  const first = await armGitCheckpoint(repo, "window-stale");
  assert.equal(first.status, "ok");
  if (first.status !== "ok") return;
  const { record: firstRecord, descriptor: firstDescriptor } = first.value;

  // Release the first generation properly.
  const relFirst = await releaseGitCheckpointPin(repo, "window-stale", {
    expectedBase: firstRecord.base,
    armId: firstDescriptor.armId,
  });
  assert.equal(relFirst.status, "ok");
  if (relFirst.status === "ok") assert.equal(relFirst.value.released, true);

  // Re-arm at the SAME commit (no new HEAD): same base, new generation.
  const second = await armGitCheckpoint(repo, "window-stale");
  assert.equal(second.status, "ok");
  if (second.status !== "ok") return;
  const { record: secondRecord, descriptor: secondDescriptor } = second.value;
  assert.equal(secondRecord.base, firstRecord.base, "test premise: both generations pin the same commit");
  assert.notEqual(secondDescriptor.armId, firstDescriptor.armId);

  const ref = checkpointRefForWindow("window-stale");
  const windowScratch = join(repo, ".git", "pi-review-gate", "checkpoints", "window-stale");
  const snapshot = async () => ({
    refTarget: (await git(repo, "rev-parse", "--verify", ref)).trim(),
    scratch: await collectFiles(windowScratch),
  });
  const before = await snapshot();
  assert.equal(before.refTarget, secondRecord.base);

  // The stale owner holds the SAME base but an OLD generation nonce: refused
  // by the generation proof, and nothing is touched.
  const stale = await releaseGitCheckpointPin(repo, "window-stale", {
    expectedBase: firstRecord.base,
    armId: firstDescriptor.armId,
  });
  assert.equal(stale.status, "failed");
  if (stale.status === "failed") assert.equal(stale.reason, "release_owner_stale");
  assert.deepEqual(await snapshot(), before);

  // A correct base with a wrong generation is refused the same way.
  const wrongGen = await releaseGitCheckpointPin(repo, "window-stale", {
    expectedBase: secondRecord.base,
    armId: firstDescriptor.armId,
  });
  assert.equal(wrongGen.status, "failed");
  if (wrongGen.status === "failed") assert.equal(wrongGen.reason, "release_owner_stale");
  assert.deepEqual(await snapshot(), before);

  // A wrong base with the correct generation is refused by the base gate.
  const initialBase = (await git(repo, "rev-parse", "HEAD~1")).trim();
  const wrongBase = await releaseGitCheckpointPin(repo, "window-stale", {
    expectedBase: initialBase,
    armId: secondDescriptor.armId,
  });
  assert.equal(wrongBase.status, "failed");
  if (wrongBase.status === "failed") assert.equal(wrongBase.reason, "pin_ref_mismatch");
  assert.deepEqual(await snapshot(), before);

  // Missing generation data is refused before any Git work.
  const missingData = await releaseGitCheckpointPin(repo, "window-stale", {
    expectedBase: secondRecord.base,
  } as GitCheckpointReleaseOptions);
  assert.equal(missingData.status, "failed");
  if (missingData.status === "failed") assert.equal(missingData.reason, "release_owner_required");

  // The current owner releases cleanly; the stale owner's data now refers to
  // a gone pin and is an idempotent no-op that touches nothing.
  const relSecond = await releaseGitCheckpointPin(repo, "window-stale", {
    expectedBase: secondRecord.base,
    armId: secondDescriptor.armId,
  });
  assert.equal(relSecond.status, "ok");
  if (relSecond.status === "ok") assert.equal(relSecond.value.released, true);
  assert.notEqual((await gitTolerant(repo, "rev-parse", "--verify", "--quiet", ref)).code, 0);
  await assert.rejects(stat(windowScratch));

  const staleAfter = await releaseGitCheckpointPin(repo, "window-stale", {
    expectedBase: firstRecord.base,
    armId: firstDescriptor.armId,
  });
  assert.equal(staleAfter.status, "ok");
  if (staleAfter.status === "ok") assert.equal(staleAfter.value.released, false);
});

test("load refuses a stale same-base record that survived an interrupted release", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f1.txt"), "one\n");
  await commitAll(repo, "base f1");
  // Arm A: staged + unstaged state at the base commit.
  await writeFile(join(repo, "f1.txt"), "one\nA-staged\n");
  await git(repo, "add", "f1.txt");
  await writeFile(join(repo, "f1.txt"), "one\nA-staged\nA-unstaged\n");
  const armA = await armGitCheckpoint(repo, "window-stale-load");
  assert.equal(armA.status, "ok");
  if (armA.status !== "ok") return;
  const descriptorA = armA.value.descriptor;
  const encodedA = armA.value.encoded;

  // Release A cleanly and re-arm B at the SAME commit (same base).
  const relA = await releaseGitCheckpointPin(repo, "window-stale-load", { expectedBase: descriptorA.base, armId: descriptorA.armId });
  assert.equal(relA.status, "ok");
  if (relA.status === "ok") assert.equal(relA.value.released, true);
  const armB = await armGitCheckpoint(repo, "window-stale-load");
  assert.equal(armB.status, "ok");
  if (armB.status !== "ok") return;
  const descriptorB = armB.value.descriptor;
  assert.notEqual(descriptorB.armId, descriptorA.armId);

  // Simulate a stale record that survived the release (best-effort rm
  // failure, or a crash between the ref delete and the scratch removal):
  // recreate arm A's exact published record in its owned directory.
  const staleDir = join(descriptorA.gitDir, "pi-review-gate", "checkpoints", "window-stale-load", `arm-${descriptorA.armId}`);
  await mkdir(staleDir, { recursive: true });
  await writeFile(join(staleDir, "record.json"), encodedA, "utf8");

  // The stale descriptor must fail closed at the generation gate: its data is
  // intact and digest-valid, but the pin now belongs to arm B.
  const staleLoad = await loadGitCheckpoint(repo, descriptorA);
  assert.equal(staleLoad.status, "failed");
  if (staleLoad.status === "failed") assert.equal(staleLoad.reason, "pin_generation_mismatch");

  // The current generation loads fine from its own descriptor.
  const freshLoad = await loadGitCheckpoint(repo, descriptorB);
  assert.equal(freshLoad.status, "ok");
  if (freshLoad.status === "ok") assert.equal(freshLoad.value.record.armId, descriptorB.armId);

  // Load never mutates: the stale record is still in place after both loads.
  assert.deepEqual(await readFile(join(staleDir, "record.json")), Buffer.from(encodedA, "utf8"));

  // The raw-record entry points are generation-gated too: persisting the
  // encoded record instead of the descriptor must not bypass the proof.
  // Drift the worktree first so a stale restore would clobber newer data if
  // it were allowed to run.
  await writeFile(join(repo, "f1.txt"), "one\nA-staged\nnewer-work\n");
  const indexBefore = await readFile(indexPath(repo));
  const fileBefore = await readFile(join(repo, "f1.txt"), "utf8");
  const staleRestore = await restoreGitCheckpoint(repo, encodedA);
  assert.equal(staleRestore.status, "failed");
  if (staleRestore.status === "failed") assert.equal(staleRestore.reason, "pin_generation_mismatch");
  const staleCompare = await compareToGitCheckpoint(repo, encodedA);
  assert.equal(staleCompare.status, "failed");
  if (staleCompare.status === "failed") assert.equal(staleCompare.reason, "pin_generation_mismatch");
  // The newer worktree data survived: neither entry point mutated anything.
  assert.deepEqual(await readFile(indexPath(repo)), indexBefore);
  assert.equal(await readFile(join(repo, "f1.txt"), "utf8"), fileBefore);

  // The current owner releases cleanly.
  const relB = await releaseGitCheckpointPin(repo, "window-stale-load", { expectedBase: descriptorB.base, armId: descriptorB.armId });
  assert.equal(relB.status, "ok");
});

test("failed-arm cleanup never deletes a newer generation's same-base pin", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "f1.txt"), "one\n");
  await commitAll(repo, "base f1");
  const ref = checkpointRefForWindow("window-cleanup-race");

  let armCId = "";
  let descriptorD: GitCheckpointDescriptor | undefined;
  // Arm C in flight; the deterministic seam between its two patch captures
  // plays the concurrent owner: delete C's pin (documented operator-recovery
  // form) and re-arm D at the SAME commit. C's scratch stays until C's own
  // cleanup removes it — that removal is part of what we assert below.
  const armC = await armGitCheckpoint(repo, "window-cleanup-race", {
    faultHooks: {
      betweenPatchCaptures: async () => {
        const base = await headOid(repo);
        const subject = (await git(repo, "log", "-g", "-1", "--format=%gs", ref)).trim();
        assert.match(subject, /^prg-git-checkpoint arm-[0-9a-f]{16}$/);
        armCId = subject.slice("prg-git-checkpoint arm-".length);
        // Expected-value delete of C's own pin: the documented recovery form.
        await git(repo, "update-ref", "--no-deref", "-d", ref, base);
        const armD = await armGitCheckpoint(repo, "window-cleanup-race");
        assert.equal(armD.status, "ok");
        if (armD.status !== "ok") throw new Error("re-arm D failed");
        descriptorD = armD.value.descriptor;
        // Dirty the tracked worktree so C's post-seam unstaged diff can no
        // longer match its pre-capture signature: C must fail with
        // capture_inconsistent and run cleanup against a pin that D owns.
        await writeFile(join(repo, "f1.txt"), "one\nraced\n");
      },
    },
  });
  assert.equal(armC.status, "failed");
  if (armC.status !== "failed") return;
  assert.equal(armC.reason, "capture_inconsistent");
  assert.ok(descriptorD !== undefined, "re-arm D did not complete");
  const d = descriptorD;

  // The NEWER generation's pin must survive C's cleanup: a base-only CAS in
  // the old cleanup would have deleted it here (same base commit).
  assert.equal((await git(repo, "rev-parse", "--verify", ref)).trim(), await headOid(repo));
  const subjectAfter = (await git(repo, "log", "-g", "-1", "--format=%gs", ref)).trim();
  assert.equal(subjectAfter, `prg-git-checkpoint arm-${d.armId}`);

  // D's record is intact and loads; C's scratch is gone.
  const loadD = await loadGitCheckpoint(repo, d);
  assert.equal(loadD.status, "ok");
  await assert.rejects(stat(join(repo, ".git", "pi-review-gate", "checkpoints", "window-cleanup-race", `arm-${armCId}`)));

  // The current owner can still release cleanly.
  const relD = await releaseGitCheckpointPin(repo, "window-cleanup-race", { expectedBase: d.base, armId: d.armId });
  assert.equal(relD.status, "ok");
});
