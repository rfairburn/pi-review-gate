/*
 * Focused regression for the test-owned temp-cleanup contract (#113).
 *
 * A just-terminated process can keep its file handles (e.g. redirected
 * stdout/stderr) open briefly on Windows, so an immediate rmSync of the files
 * it owned fails with EPERM. The cleanup helpers in
 * tests/helpers/temp-file-cleanup.ts must therefore: tolerate bounded
 * transient handle contention (EPERM/EBUSY), still fail persistent and
 * non-contention errors, and never let a cleanup failure mask a body failure.
 *
 * Platform notes: forcing a REAL transient EPERM on unlink needs the macOS
 * immutable flag (chflags uchg); those cases skip elsewhere, where the native
 * Windows suite exercises the same helper against real handle contention.
 * The permission-based cases need a non-root Unix user (root bypasses
 * directory write permissions, so EACCES would never occur for it).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { rmWithRetry, runWithTempCleanup } from "./helpers/temp-file-cleanup";

const SKIP_MAC = { skip: process.platform === "darwin" ? false : "chflags (uchg/nouchg) is macOS-only" };
const SKIP_UNIX_NON_ROOT = {
  skip:
    process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0
      ? false
      : "needs a non-root Unix user for chmod-based EACCES",
};

describe("rmWithRetry: bounded retry over transient handle contention (#113)", () => {
  it("deletes an existing temp file and treats a missing path as clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-review-rmretry-"));
    try {
      const file = join(dir, "present.txt");
      writeFileSync(file, "x");
      await rmWithRetry(file);
      assert.equal(existsSync(file), false, "file deleted");
      // force semantics: a path that was never created is not an error.
      await rmWithRetry(join(dir, "never-existed.txt"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries transient EPERM until the handle is released, then deletes", SKIP_MAC, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-review-rmretry-"));
    const file = join(dir, "contended.txt");
    writeFileSync(file, "x");
    assert.equal(spawnSync("chflags", ["uchg", file]).status, 0, "immutable flag set");
    try {
      // Release the flag from the event loop: a synchronous retry loop would
      // starve it and never observe the release, so this also proves the
      // helper yields between attempts.
      setTimeout(() => spawnSync("chflags", ["nouchg", file]), 300);
      const started = Date.now();
      await rmWithRetry(file, { maxAttempts: 20, retryDelayMs: 100 });
      assert.equal(existsSync(file), false, "deleted once the handle was released");
      assert.ok(
        Date.now() - started >= 300,
        "retried past the release point instead of failing on the first EPERM",
      );
    } finally {
      spawnSync("chflags", ["nouchg", file]); // idempotent; keep dir cleanup flag-free
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails with the original error when the contention persists past the budget", SKIP_MAC, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-review-rmretry-"));
    const file = join(dir, "stuck.txt");
    writeFileSync(file, "x");
    assert.equal(spawnSync("chflags", ["uchg", file]).status, 0, "immutable flag set");
    try {
      const started = Date.now();
      await assert.rejects(
        rmWithRetry(file, { maxAttempts: 4, retryDelayMs: 50 }),
        (err: NodeJS.ErrnoException) => err.code === "EPERM",
        "persistent EPERM must surface as the original error after the budget",
      );
      assert.ok(Date.now() - started >= 150, "retried the full budget before giving up"); // 3 delays x 50ms
      assert.equal(existsSync(file), true, "not deleted: the failure is real");
    } finally {
      spawnSync("chflags", ["nouchg", file]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not retry non-retryable errors", SKIP_UNIX_NON_ROOT, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-review-rmretry-ro-"));
    try {
      const file = join(dir, "denied.txt");
      writeFileSync(file, "x");
      chmodSync(dir, 0o555); // unlink needs write permission on the parent dir -> EACCES
      const started = Date.now();
      await assert.rejects(
        rmWithRetry(file, { maxAttempts: 4, retryDelayMs: 300 }),
        (err: NodeJS.ErrnoException) => err.code === "EACCES",
      );
      assert.ok(Date.now() - started < 300, "a non-retryable error must not burn the retry budget");
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runWithTempCleanup: cleanup errors never mask body failures (#113)", () => {
  it("leaves a passing body untouched and deletes every path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-review-rmretry-"));
    try {
      const a = join(dir, "a.txt");
      const b = join(dir, "b.txt");
      writeFileSync(a, "x");
      writeFileSync(b, "y");
      let bodyRan = false;
      await runWithTempCleanup([a, b], {}, async () => { bodyRan = true; });
      assert.equal(bodyRan, true, "body ran");
      assert.equal(existsSync(a), false, "first path cleaned up");
      assert.equal(existsSync(b), false, "second path cleaned up");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the body failure even when cleanup also fails", SKIP_UNIX_NON_ROOT, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-review-rmretry-mask-"));
    try {
      const file = join(dir, "masked.txt");
      writeFileSync(file, "x");
      chmodSync(dir, 0o555); // cleanup will fail with EACCES
      const bodyError = new Error("BODY-ASSERTION-FAILED");
      await assert.rejects(
        runWithTempCleanup([file], {}, async () => { throw bodyError; }),
        (err: unknown) => err === bodyError,
        "the body error must win over the cleanup error",
      );
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still fails when the body passed but cleanup persistently fails", SKIP_UNIX_NON_ROOT, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-review-rmretry-mask-"));
    try {
      const file = join(dir, "persistent.txt");
      writeFileSync(file, "x");
      chmodSync(dir, 0o555); // cleanup will fail with EACCES
      await assert.rejects(
        runWithTempCleanup([file], {}, async () => {}),
        (err: NodeJS.ErrnoException) => err.code === "EACCES",
        "a persistent cleanup error must still fail the test",
      );
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs cleanup even when the body failed, and reports the body failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-review-rmretry-"));
    try {
      const file = join(dir, "leak.txt");
      writeFileSync(file, "x");
      const bodyError = new Error("BODY-FAILED-BUT-CLEANUP-RUNS");
      await assert.rejects(
        runWithTempCleanup([file], {}, async () => { throw bodyError; }),
        (err: unknown) => err === bodyError,
      );
      assert.equal(existsSync(file), false, "cleanup ran despite the body failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not fail a passing body over transient contention", SKIP_MAC, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-review-rmretry-"));
    const file = join(dir, "transient.txt");
    writeFileSync(file, "x");
    assert.equal(spawnSync("chflags", ["uchg", file]).status, 0, "immutable flag set");
    try {
      setTimeout(() => spawnSync("chflags", ["nouchg", file]), 300);
      await runWithTempCleanup([file], {}, async () => {}); // body assertions "passed"
      assert.equal(existsSync(file), false, "cleaned up after the contention cleared");
    } finally {
      spawnSync("chflags", ["nouchg", file]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
