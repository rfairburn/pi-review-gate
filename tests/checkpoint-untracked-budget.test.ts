// #462: the real Git arm path enforces the remaining untracked byte budget
// before allocating or reading an entry, and bounds every native read request.
// Fixtures are small or sparse files in owned temporary repositories; nothing
// here allocates or reads an oversized file, and no native abort is recreated.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdtemp, realpath, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, afterEach, mock, test } from "node:test";
import { armGitCheckpoint, checkpointRefForWindow, decodeGitCheckpointRecord } from "../src/git-checkpoint";
import { UNTRACKED_READ_CHUNK_BYTES } from "../src/checkpoint/capture";
import { DEFAULT_MAX_UNTRACKED_BYTES } from "../src/checkpoint/run-git";
import { isEligibleReviewCaptureFailure } from "../src/review-evidence";

const fsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
const exec = promisify(execFile);
const roots: string[] = [];
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env, GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Budget Test", GIT_AUTHOR_EMAIL: "budget@example.invalid",
  GIT_COMMITTER_NAME: "Budget Test", GIT_COMMITTER_EMAIL: "budget@example.invalid",
};

afterEach(() => mock.restoreAll());
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function initRepo(): Promise<string> {
  const repo = await mkdtemp(join(await realpath(tmpdir()), "prg-untracked-budget-"));
  roots.push(repo);
  await exec("git", ["init", "-q"], { cwd: repo, env: GIT_ENV });
  await writeFile(join(repo, "README.md"), "# budget\n");
  await exec("git", ["add", "README.md"], { cwd: repo, env: GIT_ENV });
  await exec("git", ["commit", "-q", "-m", "owned fixture baseline"], { cwd: repo, env: GIT_ENV });
  return repo;
}

async function pinGone(repo: string, windowId: string): Promise<boolean> {
  try {
    await exec("git", ["rev-parse", "--verify", "--quiet", checkpointRefForWindow(windowId)], { cwd: repo, env: GIT_ENV });
    return false;
  } catch { return true; }
}

async function scratchGone(repo: string, windowId: string): Promise<boolean> {
  return stat(join(repo, ".git", "pi-review-gate", "checkpoints", windowId)).then(() => false, () => true);
}

type ReadImpl = (handle: FileHandle, path: string, args: unknown[], original: (...args: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }>) => Promise<{ bytesRead: number; buffer: Buffer }>;

/**
 * Observe the production capture's own allocations and native read requests.
 * Allocations at or above `refuseAllocAtLeast` throw instead of allocating, so
 * a missing preflight fails the test without exhausting memory.
 */
async function observeCapture(options: { refuseAllocAtLeast?: number; read?: ReadImpl } = {}) {
  const allocations: number[] = [];
  const reads: Array<{ path: string; length: number; position: number }> = [];
  const handles = new WeakMap<object, string>();
  const alloc = Buffer.alloc.bind(Buffer);
  mock.method(Buffer, "alloc", (size: number, ...rest: unknown[]) => {
    allocations.push(size);
    if (options.refuseAllocAtLeast !== undefined && size >= options.refuseAllocAtLeast) {
      throw new Error(`test refused disallowed ${size}-byte allocation`);
    }
    return (alloc as (...args: unknown[]) => Buffer)(size, ...rest);
  });
  const open = fsPromises.open;
  mock.method(fsPromises, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    handles.set(handle, String(args[0]));
    return handle;
  });
  const probe = await open(__filename, "r");
  const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }> };
  await probe.close();
  const read = proto.read;
  mock.method(proto, "read", function (this: FileHandle, ...args: unknown[]) {
    const path = handles.get(this) ?? "<unobserved>";
    reads.push({ path, length: Number(args[2]), position: Number(args[3]) });
    const original = (...forwarded: unknown[]) => read.apply(this, forwarded);
    return options.read ? options.read(this, path, args, original) : original(...args);
  });
  return { allocations, reads };
}

test("a single oversized untracked file is refused typed before its allocation or read", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "a-small.txt"), "small\n");
  await writeFile(join(repo, "z-big.bin"), Buffer.alloc(4097, 1));
  const observed = await observeCapture({ refuseAllocAtLeast: 4097 });
  const result = await armGitCheckpoint(repo, "budget-single", { maxUntrackedBytes: 4096 });
  mock.restoreAll();
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.reason, "untracked_too_large");
  assert.match(result.detail ?? "", /z-big\.bin is 4097 bytes/);
  assert.equal(isEligibleReviewCaptureFailure(result), true, "confirmed owned cleanup keeps the typed size failure eligible");
  assert.deepEqual(observed.reads.filter((r) => r.path.endsWith("z-big.bin")), [], "oversized bytes must never be read");
  assert.ok(observed.allocations.every((size) => size < 4097), "oversized buffer must never be allocated");
  assert.ok(observed.reads.some((r) => r.path.endsWith("a-small.txt")), "earlier fitting entries are still captured exactly");
  assert.ok(await pinGone(repo, "budget-single"));
  assert.ok(await scratchGone(repo, "budget-single"));
});

test("a sparse untracked file over the default cap is refused from its size without allocation or read", async () => {
  const repo = await initRepo();
  // Sparse: the file reports DEFAULT+1 bytes without storing or reading them.
  await writeFile(join(repo, "sparse.bin"), "");
  await truncate(join(repo, "sparse.bin"), DEFAULT_MAX_UNTRACKED_BYTES + 1);
  const observed = await observeCapture({ refuseAllocAtLeast: 64 * 1024 * 1024 });
  const result = await armGitCheckpoint(repo, "budget-sparse");
  mock.restoreAll();
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.reason, "untracked_too_large");
  assert.equal(isEligibleReviewCaptureFailure(result), true);
  assert.deepEqual(observed.reads.filter((r) => r.path.endsWith("sparse.bin")), []);
  assert.ok(observed.allocations.every((size) => size < 64 * 1024 * 1024));
  assert.ok(await pinGone(repo, "budget-sparse"));
});

test("cumulative untracked files are refused when the next one exceeds the remaining budget", async () => {
  const repo = await initRepo();
  // Each file alone fits the 4096-byte cap; together they do not.
  await writeFile(join(repo, "a.txt"), Buffer.alloc(3000, 0x61));
  await writeFile(join(repo, "b.txt"), Buffer.alloc(3100, 0x62));
  const observed = await observeCapture({ refuseAllocAtLeast: 3100 });
  const result = await armGitCheckpoint(repo, "budget-cumulative", { maxUntrackedBytes: 4096 });
  mock.restoreAll();
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.reason, "untracked_too_large");
  assert.match(result.detail ?? "", /b\.txt is 3100 bytes, exceeding the 1096-byte/);
  assert.equal(isEligibleReviewCaptureFailure(result), true);
  assert.ok(observed.reads.some((r) => r.path.endsWith("a.txt")));
  assert.deepEqual(observed.reads.filter((r) => r.path.endsWith("b.txt")), [], "the entry that cannot fit is never read");
  assert.ok(!observed.allocations.includes(3100), "the entry that cannot fit is never allocated");
  assert.ok(await pinGone(repo, "budget-cumulative"));
  assert.ok(await scratchGone(repo, "budget-cumulative"));
});

test("exact-cap, empty, and below-limit captures keep exact bytes; zero budget still admits empty files", async () => {
  const repo = await initRepo();
  const one = randomBytes(2048);
  const two = randomBytes(2048);
  await writeFile(join(repo, "one.bin"), one);
  await writeFile(join(repo, "two.bin"), two);
  await writeFile(join(repo, "empty.txt"), "");
  const exact = await armGitCheckpoint(repo, "budget-exact", { maxUntrackedBytes: 4096 });
  assert.equal(exact.status, "ok");
  if (exact.status !== "ok") return;
  assert.equal(exact.value.stats.untrackedRawBytes, 4096);
  const record = decodeGitCheckpointRecord(exact.value.encoded);
  const content = (path: string) => Buffer.from(record.untracked.find((e) => e.path === path)!.contentB64!, "base64");
  assert.deepEqual(content("one.bin"), one);
  assert.deepEqual(content("two.bin"), two);
  assert.equal(content("empty.txt").length, 0);

  const below = await armGitCheckpoint(repo, "budget-below", { maxUntrackedBytes: 4097 });
  assert.equal(below.status, "ok");
  const over = await armGitCheckpoint(repo, "budget-over-by-one", { maxUntrackedBytes: 4095 });
  assert.equal(over.status, "failed");
  if (over.status === "failed") assert.equal(over.reason, "untracked_too_large");

  const emptyOnly = await initRepo();
  await writeFile(join(emptyOnly, "empty.txt"), "");
  const zero = await armGitCheckpoint(emptyOnly, "budget-zero", { maxUntrackedBytes: 0 });
  assert.equal(zero.status, "ok");
  await writeFile(join(emptyOnly, "byte.txt"), "x");
  const zeroOver = await armGitCheckpoint(emptyOnly, "budget-zero-over", { maxUntrackedBytes: 0 });
  assert.equal(zeroOver.status, "failed");
  if (zeroOver.status === "failed") assert.equal(zeroOver.reason, "untracked_too_large");
});

test("native read requests are bounded chunks and partial reads still produce exact bytes", async () => {
  const repo = await initRepo();
  const size = UNTRACKED_READ_CHUNK_BYTES * 2 + 4099;
  const bytes = Buffer.alloc(size);
  for (let i = 0; i + 4 <= size; i += 4096) bytes.writeUInt32BE(i, i);
  await writeFile(join(repo, "chunked.bin"), bytes);
  let partials = 0;
  const observed = await observeCapture({
    read: async (_handle, path, args, original) => {
      // Short-change the first two requests: the loop must resume at the
      // exact offset rather than assume a full chunk.
      if (path.endsWith("chunked.bin") && partials < 2) {
        partials += 1;
        return original(args[0], args[1], Math.min(Number(args[2]), 7 * partials), args[3]);
      }
      return original(...args);
    },
  });
  const result = await armGitCheckpoint(repo, "budget-chunked");
  mock.restoreAll();
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const chunked = observed.reads.filter((r) => r.path.endsWith("chunked.bin"));
  assert.ok(chunked.length >= 5, `expected chunked reads, saw ${chunked.length}`);
  assert.ok(chunked.every((r) => r.length > 0 && r.length <= UNTRACKED_READ_CHUNK_BYTES), JSON.stringify(chunked));
  assert.ok(UNTRACKED_READ_CHUNK_BYTES < 2 ** 31 - 1);
  assert.deepEqual(chunked.slice(0, 3).map((r) => r.position), [0, 7, 21]);
  const record = decodeGitCheckpointRecord(result.value.encoded);
  assert.ok(Buffer.from(record.untracked.find((e) => e.path === "chunked.bin")!.contentB64!, "base64").equals(bytes));
});

test("a short read (unexpected EOF) is a race, not an eligible size failure", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "short.bin"), Buffer.alloc(1000, 7));
  await observeCapture({
    read: async (_handle, path, args, original) => path.endsWith("short.bin") && Number(args[3]) > 0
      ? { bytesRead: 0, buffer: args[0] as Buffer } : original(args[0], args[1], Math.min(Number(args[2]), 10), args[3]),
  });
  const result = await armGitCheckpoint(repo, "budget-short");
  mock.restoreAll();
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.reason, "untracked_capture_race");
  assert.equal(isEligibleReviewCaptureFailure(result), false);
  assert.ok(await pinGone(repo, "budget-short"));
});

test("growth and replacement races remain typed races and never become eligible size failures", async () => {
  // Grows past the remaining budget after the pre-stat: identity wins.
  const grown = await initRepo();
  await writeFile(join(grown, "grow.txt"), "x".repeat(100));
  const grow = await armGitCheckpoint(grown, "budget-grow", {
    maxUntrackedBytes: 200,
    faultHooks: { beforeUntrackedRead: async (absolute) => { await appendFile(absolute, "y".repeat(500)); } },
  });
  assert.equal(grow.status, "failed");
  if (grow.status === "failed") {
    assert.equal(grow.reason, "untracked_capture_race");
    assert.equal(isEligibleReviewCaptureFailure(grow), false);
  }
  assert.ok(await pinGone(grown, "budget-grow"));

  // Replaced by a different inode before the open.
  const replaced = await initRepo();
  await writeFile(join(replaced, "swap.txt"), "original\n");
  const swap = await armGitCheckpoint(replaced, "budget-swap", {
    faultHooks: {
      beforeUntrackedRead: async (absolute) => {
        await writeFile(`${absolute}.next`, "replacement\n");
        await rename(`${absolute}.next`, absolute);
      },
    },
  });
  assert.equal(swap.status, "failed");
  if (swap.status === "failed") {
    assert.equal(swap.reason, "untracked_capture_race");
    assert.equal(isEligibleReviewCaptureFailure(swap), false);
  }

  // Grows during the bounded read: the post-read identity check refuses it.
  const during = await initRepo();
  await writeFile(join(during, "during.txt"), "z".repeat(64));
  let appended = false;
  await observeCapture({
    read: async (_handle, path, args, original) => {
      if (path.endsWith("during.txt") && !appended) { appended = true; await appendFile(path, "more"); }
      return original(...args);
    },
  });
  const mid = await armGitCheckpoint(during, "budget-during");
  mock.restoreAll();
  assert.equal(mid.status, "failed");
  if (mid.status === "failed") {
    assert.equal(mid.reason, "untracked_capture_race");
    assert.equal(isEligibleReviewCaptureFailure(mid), false);
  }
  assert.ok(await pinGone(during, "budget-during"));
});

test("cancellation during an over-budget capture is aborted, not an eligible size failure", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "a.txt"), "a".repeat(100));
  await writeFile(join(repo, "b.txt"), "b".repeat(500));
  const controller = new AbortController();
  const observed = await observeCapture();
  const result = await armGitCheckpoint(repo, "budget-abort", {
    maxUntrackedBytes: 200,
    signal: controller.signal,
    faultHooks: { beforeUntrackedRead: (absolute) => { if (absolute.endsWith("a.txt")) controller.abort(); } },
  });
  mock.restoreAll();
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.reason, "aborted");
  assert.equal(isEligibleReviewCaptureFailure(result), false);
  assert.deepEqual(observed.reads.filter((r) => r.path.endsWith("b.txt")), []);
  assert.ok(await pinGone(repo, "budget-abort"));
  assert.ok(await scratchGone(repo, "budget-abort"));
});

test("an over-budget refusal with unconfirmed owned cleanup is not fallback eligible", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, "big.txt"), "x".repeat(500));
  const remove = fsPromises.rm;
  mock.method(fsPromises, "rm", async (...args: Parameters<typeof remove>) => {
    if (args[1]?.recursive === true && String(args[0]).includes(join("checkpoints", "budget-cleanup", "arm-"))) {
      throw Object.assign(new Error("injected owned scratch cleanup failure"), { code: "EACCES" });
    }
    return remove(...args);
  });
  const result = await armGitCheckpoint(repo, "budget-cleanup", { maxUntrackedBytes: 100 });
  mock.restoreAll();
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.reason, "untracked_too_large");
  assert.equal(result.evidenceCaptureFailure, undefined);
  assert.equal(isEligibleReviewCaptureFailure(result), false);
});
