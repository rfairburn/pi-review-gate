/*
 * Test-only bounded-retry cleanup for test-owned temporary files and
 * directories (#113).
 *
 * On Windows a process that has just been terminated (TerminateJobObject,
 * hard kill) can keep its file handles — e.g. redirected stdout/stderr —
 * open briefly while the kernel finishes teardown, so an immediate rmSync of
 * the files it owned fails with EPERM (sharing violation) or EBUSY even
 * though nothing is wrong. rmWithRetry tolerates that bounded window by
 * retrying ONLY transient handle-contention errors; any other error, and
 * exhaustion of the attempt budget, rethrows the original error, so a
 * persistent cleanup failure can never hide as success.
 */
import { rmSync } from "node:fs";

export interface RmWithRetryOptions {
  /** Delete a directory tree recursively (default false). */
  recursive?: boolean;
  /** Maximum deletion attempts, first attempt included (default 10). */
  maxAttempts?: number;
  /** Delay between attempts in milliseconds (default 250). */
  retryDelayMs?: number;
}

/** Transient handle-contention codes. Anything else (EACCES, ENOTDIR, ...)
 *  is a real problem and must fail immediately. */
const RETRYABLE_CODES = new Set(["EPERM", "EBUSY"]);

/**
 * Delete a test-owned temp path, tolerating bounded transient handle
 * contention. A missing path is not an error (force semantics). The wait
 * between attempts yields to the event loop, so both OS-side handle release
 * and scheduled unblockers can make progress while retrying.
 */
export async function rmWithRetry(path: string, options: RmWithRetryOptions = {}): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 10;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const rmOptions: Parameters<typeof rmSync>[1] = { force: true };
  if (options.recursive) rmOptions.recursive = true;
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(path, rmOptions);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (typeof code !== "string" || !RETRYABLE_CODES.has(code) || attempt >= maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

const NO_BODY_ERROR = Symbol("no-body-error");

/**
 * Run `body`, then delete the test-owned temp paths with bounded retry.
 *
 * Error precedence keeps failures honest: a body failure always wins over a
 * cleanup failure (a throw from `finally` would otherwise mask the real
 * assertion error — exactly how a transient Windows EPERM once surfaced as
 * the host-death test's only failure), while a persistent cleanup error still
 * fails the test when the body passed. Cleanup runs even when the body
 * failed, so a failing test does not leak its temp files any more than a
 * passing one does.
 */
export async function runWithTempCleanup(
  paths: string[],
  options: { recursive?: boolean },
  body: () => Promise<void>,
): Promise<void> {
  let bodyError: unknown = NO_BODY_ERROR;
  try {
    await body();
  } catch (err) {
    bodyError = err;
  } finally {
    for (const path of paths) {
      try {
        await rmWithRetry(path, options);
      } catch (cleanupErr) {
        if (bodyError === NO_BODY_ERROR) throw cleanupErr;
      }
    }
  }
  if (bodyError !== NO_BODY_ERROR) throw bodyError;
}
