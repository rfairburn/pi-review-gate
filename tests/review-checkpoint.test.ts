import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { captureReviewCheckpoint, compareReviewCheckpoints, loadReviewCheckpoint, releaseReviewCheckpoint, type ReviewCheckpointDescriptor } from "../src/review-checkpoint";

const exec = promisify(execFile);
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  // Test fixtures remain inside this isolated worker root, never in a source checkout.
  const root = await mkdtemp(join(process.cwd(), ".review-checkpoint-test-"));
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = process.cwd();
  try { await run(root); } finally {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
    await rm(root, { recursive: true, force: true });
  }
}
async function git(root: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_EMAIL: "test@example.com" } });
}
async function capture(root: string, id: string): Promise<ReviewCheckpointDescriptor> {
  const result = await captureReviewCheckpoint(root, id);
  assert.equal(result.status, "ok", JSON.stringify(result));
  return result.value;
}

test("nested Git review checkpoints cover repository-relative sibling changes without following live bytes", async () => fixture(async (root) => {
  const repository = join(root, "repo");
  const cwd = join(repository, "nested", "selected");
  await mkdir(cwd, { recursive: true });
  await git(repository, "init", "-q");
  await writeFile(join(repository, "sibling.txt"), "committed sibling baseline\n");
  await git(repository, "add", "sibling.txt");
  await git(repository, "commit", "-qm", "base");

  const before = await capture(cwd, "nested-before");
  assert.equal(before.kind, "git");
  assert.equal((await loadReviewCheckpoint(cwd, before)).status, "ok");
  await writeFile(join(repository, "sibling.txt"), "frozen sibling after\n");
  await writeFile(join(repository, "eligible-sibling.txt"), Buffer.from([0, 255, 11]));
  const after = await capture(cwd, "nested-after");
  await writeFile(join(repository, "sibling.txt"), "later live sibling bytes\n");
  await writeFile(join(repository, "eligible-sibling.txt"), "later live untracked bytes\n");

  const compared = await compareReviewCheckpoints(cwd, before, after);
  assert.equal(compared.status, "ok", JSON.stringify(compared));
  if (compared.status === "ok") {
    assert.deepEqual(compared.value.changes.map((change) => change.path), ["eligible-sibling.txt", "sibling.txt"]);
    assert.equal(compared.value.changes.find((change) => change.path === "sibling.txt")?.old?.bytes?.toString(), "committed sibling baseline\n");
    assert.equal(compared.value.changes.find((change) => change.path === "sibling.txt")?.new?.bytes?.toString(), "frozen sibling after\n");
    assert.deepEqual(compared.value.changes.find((change) => change.path === "eligible-sibling.txt")?.new?.bytes, Buffer.from([0, 255, 11]));
  }

  const otherRepository = join(root, "other-repo");
  await mkdir(otherRepository);
  await git(otherRepository, "init", "-q");
  await writeFile(join(otherRepository, "other.txt"), "other repository\n");
  await git(otherRepository, "add", "other.txt");
  await git(otherRepository, "commit", "-qm", "other");
  const other = await capture(otherRepository, "nested-other");
  assert.equal((await loadReviewCheckpoint(otherRepository, before)).status, "failed");
  if (before.kind === "git" && other.kind === "git") {
    const tampered = { ...before, checkpoint: { ...before.checkpoint, gitDir: other.checkpoint.gitDir } };
    assert.equal((await loadReviewCheckpoint(cwd, tampered)).status, "failed");
  }
  assert.equal((await releaseReviewCheckpoint(cwd, before)).status, "ok");
  assert.equal((await releaseReviewCheckpoint(cwd, after)).status, "ok");
  assert.equal((await releaseReviewCheckpoint(otherRepository, other)).status, "ok");
}));

test("ambient Git repository redirects cannot hide nested parent-review changes", async () => fixture(async (root) => {
  const actual = join(root, "actual");
  const selected = join(actual, "nested");
  const unrelated = join(root, "unrelated");
  await mkdir(selected, { recursive: true });
  await mkdir(unrelated);
  for (const repository of [actual, unrelated]) {
    await git(repository, "init", "-q");
    await writeFile(join(repository, "tracked.txt"), "baseline\n");
    await git(repository, "add", "tracked.txt");
    await git(repository, "commit", "-qm", "baseline");
  }

  const priorDir = process.env.GIT_DIR;
  const priorWorktree = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_DIR = join(unrelated, ".git");
    process.env.GIT_WORK_TREE = unrelated;
    const before = await capture(selected, "redirect-before");
    assert.equal(before.kind, "git");
    if (before.kind !== "git") throw new Error("expected Git checkpoint");
    assert.equal(before.checkpoint.gitDir, await realpath(join(actual, ".git")));
    await writeFile(join(actual, "tracked.txt"), "actual repository changed\n");
    const after = await capture(selected, "redirect-after");
    const compared = await compareReviewCheckpoints(selected, before, after);
    assert.equal(compared.status, "ok", JSON.stringify(compared));
    if (compared.status === "ok") {
      assert.deepEqual(compared.value.changes.map((change) => change.path), ["tracked.txt"]);
      assert.equal(compared.value.changes[0]?.new?.bytes?.toString(), "actual repository changed\n");
    }
    assert.equal((await loadReviewCheckpoint(selected, before)).status, "ok");
    assert.equal((await releaseReviewCheckpoint(selected, before)).status, "ok");
    assert.equal((await releaseReviewCheckpoint(selected, after)).status, "ok");
  } finally {
    if (priorDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = priorDir;
    if (priorWorktree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = priorWorktree;
  }
}));

test("Git clean tracked bytes are referenced, while staged, unstaged and untracked bytes are recoverable", async () => fixture(async (root) => {
  await git(root, "init", "-q");
  await writeFile(join(root, "clean"), Buffer.alloc(1024 * 1024, 0x51));
  await writeFile(join(root, "edited"), "base");
  await writeFile(join(root, "ignored-tracked"), "tracked");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "base");
  await writeFile(join(root, ".gitignore"), "ignored*\n");
  await writeFile(join(root, "edited"), "staged");
  await git(root, "add", "edited");
  await writeFile(join(root, "edited"), "unstaged");
  await writeFile(join(root, "new"), Buffer.from([0, 255, 1]));
  await writeFile(join(root, "ignored-untracked"), "secret");
  const first = await capture(root, "first");
  assert.equal(first.kind, "git");
  assert.ok(first.kind === "git" && first.checkpoint.digest.length === 64);
  const loaded = await loadReviewCheckpoint(root, first);
  assert.equal(loaded.status, "ok");
  // The Git record contains patches/untracked content, but never the clean blob.
  const dir = first.kind === "git" ? first.checkpoint.gitDir : "";
  const record = await readFile(join(dir, "pi-review-gate", "checkpoints", "first", `arm-${first.kind === "git" ? first.checkpoint.armId : ""}`, "record.json"), "utf8");
  assert.ok(record.length < 100_000);
  assert.ok(!record.includes(Buffer.alloc(1024, 0x51).toString("base64")));
  await writeFile(join(root, "edited"), "later");
  await writeFile(join(root, "new"), "later");
  const second = await capture(root, "second");
  const result = await compareReviewCheckpoints(root, first, second);
  assert.equal(result.status, "ok", JSON.stringify(result));
  if (result.status === "ok") {
    assert.equal(result.value.changes.find((c) => c.path === "edited")?.old?.bytes?.toString(), "unstaged");
    assert.deepEqual(result.value.changes.find((c) => c.path === "new")?.old?.bytes, Buffer.from([0, 255, 1]));
    assert.ok(!result.value.changes.some((c) => c.path === "clean" || c.path === "ignored-tracked" || c.path === "ignored-untracked"));
  }
  assert.equal((await releaseReviewCheckpoint(root, first)).status, "ok");
  assert.equal((await loadReviewCheckpoint(root, first)).status, "failed");
  assert.equal((await releaseReviewCheckpoint(root, second)).status, "ok");
}));

test("Git tracked/untracked transitions with identical worktree content are not changes", async () => fixture(async (root) => {
  await git(root, "init", "-q");
  await writeFile(join(root, "file"), Buffer.from([0, 255, 42]));
  await chmod(join(root, "file"), 0o644);
  await git(root, "add", "file");
  await git(root, "commit", "-qm", "base");
  const tracked = await capture(root, "tracked");
  await git(root, "rm", "--cached", "--", "file");
  const untracked = await capture(root, "untracked");
  const toUntracked = await compareReviewCheckpoints(root, tracked, untracked);
  assert.equal(toUntracked.status, "ok", JSON.stringify(toUntracked));
  if (toUntracked.status === "ok") assert.deepEqual(toUntracked.value.changes, []);
  await git(root, "add", "file");
  const trackedAgain = await capture(root, "tracked-again");
  const toTracked = await compareReviewCheckpoints(root, untracked, trackedAgain);
  assert.equal(toTracked.status, "ok", JSON.stringify(toTracked));
  if (toTracked.status === "ok") assert.deepEqual(toTracked.value.changes, []);
  for (const checkpoint of [tracked, untracked, trackedAgain]) assert.equal((await releaseReviewCheckpoint(root, checkpoint)).status, "ok");
}));

test("Git tracked symlinks retain valid targets and reject lossy non-UTF-8 parent comparisons", async () => fixture(async (root) => {
  await git(root, "init", "-q");
  await symlink("original", join(root, "link"));
  await git(root, "add", "link");
  await git(root, "commit", "-qm", "base");
  const original = await capture(root, "original");
  await rm(join(root, "link"));
  await symlink("updated", join(root, "link"));
  const valid = await capture(root, "valid");
  const validComparison = await compareReviewCheckpoints(root, original, valid);
  assert.equal(validComparison.status, "ok", JSON.stringify(validComparison));
  if (validComparison.status === "ok") {
    assert.deepEqual(validComparison.value.changes.map((change) => change.path), ["link"]);
    assert.equal(validComparison.value.changes[0]?.old?.target, "original");
    assert.equal(validComparison.value.changes[0]?.new?.target, "updated");
  }

  // Install raw blob bytes through Git's index and checkout; no text decoding
  // by Node or the shell is involved in creating either actual symlink.
  const installTarget = async (byte: number): Promise<void> => {
    const blobPath = join(root, ".git", "target-bytes");
    await writeFile(blobPath, Buffer.from([byte]));
    const { stdout } = await exec("git", ["hash-object", "-w", blobPath], { cwd: root });
    await git(root, "update-index", "--add", "--cacheinfo", `120000,${stdout.trim()},link`);
    await git(root, "checkout-index", "-f", "--", "link");
    assert.deepEqual(await readlink(join(root, "link"), { encoding: "buffer" }), Buffer.from([byte]));
  };
  await installTarget(0xff);
  const invalidFirst = await capture(root, "invalid-first");
  await installTarget(0xfe);
  const invalidSecond = await capture(root, "invalid-second");
  const compared = await compareReviewCheckpoints(root, invalidFirst, invalidSecond);
  assert.equal(compared.status, "failed", JSON.stringify(compared));
  if (compared.status === "failed") {
    assert.equal(compared.reason, "raw_checkpoint_failed");
    assert.match(compared.detail, /tracked symlink target is not valid UTF-8: link/);
  }
  for (const checkpoint of [original, valid, invalidFirst, invalidSecond])
    assert.equal((await releaseReviewCheckpoint(root, checkpoint)).status, "ok");
}));

test("raw global excludes only with any project .gitignore; nested patterns stay local", async () => fixture(async (root) => {
  const template = join(root, "custom-template");
  await mkdir(join(template, "info"), { recursive: true });
  await writeFile(join(template, "info", "exclude"), "template-only.txt\n");
  const previousTemplate = process.env.GIT_TEMPLATE_DIR;
  process.env.GIT_TEMPLATE_DIR = template;
  const config = join(root, "global-config");
  const excludes = join(root, "global-excludes");
  await writeFile(excludes, "global.txt\n");
  await writeFile(config, `[core]\n excludesFile = ${excludes}\n`);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  try {
    await writeFile(join(root, "global.txt"), "included when no project ignore");
    await writeFile(join(root, "template-only.txt"), "must remain eligible");
    await writeFile(join(root, "ordinary"), "one");
    const noIgnore = await capture(root, "no-ignore");
    assert.equal(noIgnore.kind, "raw");
    const loaded = await loadReviewCheckpoint(root, noIgnore);
    assert.equal(loaded.status, "ok");
    if (loaded.status === "ok") assert.ok(loaded.value.kind === "raw" && loaded.value.entries.some((e) => e.path === "global.txt"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", ".gitignore"), "local.txt\n");
    await writeFile(join(root, "nested", "local.txt"), "omitted");
    await writeFile(join(root, "local.txt"), "kept");
    for (let i = 0; i < 64; i++) await writeFile(join(root, "nested", `ordinary-${i}`), `value-${i}`);
    const withIgnore = await capture(root, "with-ignore");
    const other = await loadReviewCheckpoint(root, withIgnore);
    assert.equal(other.status, "ok");
    if (other.status === "ok") {
      assert.equal(other.value.kind, "raw");
      const names = other.value.kind === "raw" ? other.value.entries.map((e) => e.path) : [];
      assert.ok(!names.includes("global.txt"));
      assert.ok(names.includes("template-only.txt"));
      assert.ok(!names.includes("nested/local.txt"));
      assert.ok(names.includes("local.txt"));
      assert.equal(names.filter((name) => name.startsWith("nested/ordinary-")).length, 64);
    }
    assert.equal((await releaseReviewCheckpoint(root, noIgnore)).status, "ok");
    assert.equal((await releaseReviewCheckpoint(root, withIgnore)).status, "ok");
  } finally {
    if (previousTemplate === undefined) delete process.env.GIT_TEMPLATE_DIR;
    else process.env.GIT_TEMPLATE_DIR = previousTemplate;
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
}));

test("raw frozen comparison selects changed files only; mode, symlink, missing and corrupt records fail closed", async () => fixture(async (root) => {
  await writeFile(join(root, "same"), "unchanged");
  await writeFile(join(root, "changed"), Buffer.from([0, 255]));
  await writeFile(join(root, "mode"), "same bytes");
  await symlink("same", join(root, "link"));
  const before = await capture(root, "before");
  await writeFile(join(root, "changed"), "after");
  await chmod(join(root, "mode"), 0o755);
  await rm(join(root, "link"));
  await symlink("changed", join(root, "link"));
  const after = await capture(root, "after");
  await writeFile(join(root, "changed"), "live must not be compared");
  const result = await compareReviewCheckpoints(root, before, after);
  assert.equal(result.status, "ok", JSON.stringify(result));
  if (result.status === "ok") {
    assert.deepEqual(result.value.changes.map((c) => c.path), ["changed", "link", "mode"]);
    assert.deepEqual(result.value.changes[0]?.old?.bytes, Buffer.from([0, 255]));
    assert.equal(result.value.changes[0]?.new?.bytes?.toString(), "after");
    assert.equal(result.value.changes[1]?.old?.target, "same");
    assert.equal(result.value.changes[1]?.new?.target, "changed");
  }
  assert.equal(before.kind, "raw");
  if (before.kind !== "raw") return;
  const record = join(root, ".pi-review-gate", "checkpoints", `${before.windowId}-${before.owner}`, "record.json");
  await writeFile(record, "corrupt");
  assert.equal((await loadReviewCheckpoint(root, before)).status, "failed");
  assert.equal((await releaseReviewCheckpoint(root, before)).status, "failed");
  assert.ok((await lstat(record)).isFile());
  await rm(record);
  assert.equal((await compareReviewCheckpoints(root, before, after)).status, "failed");
  assert.equal((await releaseReviewCheckpoint(root, after)).status, "ok");
}));

test("broken root or ancestor .git marker never falls back to raw capture", async () => fixture(async (root) => {
  const child = join(root, "child");
  await mkdir(child);
  await writeFile(join(root, ".git"), "gitdir: nowhere\n");
  assert.equal((await captureReviewCheckpoint(root, "broken-root")).status, "failed");
  assert.equal((await captureReviewCheckpoint(child, "broken-parent")).status, "failed");
}));
