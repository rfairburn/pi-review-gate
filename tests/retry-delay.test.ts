import assert from "node:assert/strict";
import test from "node:test";
import { computeRetryDelay } from "../src/execution/retry-delay";
import { executionRetryDelay } from "../src/execution/wave-worker-lifecycle";

test("retry delay uses explicit retry-number, cap, and jitter-rounding vectors", () => {
  const originalRandom = Math.random;
  const draws = [0, 0.5, 0.999, 0.5];
  let drawCount = 0;
  Math.random = () => draws[drawCount++]!;
  try {
    assert.equal(computeRetryDelay(10, 100, false, 0), 10, "retry numbers below one retain the first-step ceiling");
    assert.equal(computeRetryDelay(10, 100, false, 1), 10, "retry 1 uses the base delay");
    assert.equal(computeRetryDelay(10, 100, false, 3), 40, "retry 3 doubles twice");
    assert.equal(computeRetryDelay(10, 100, false, 8), 100, "exponential growth is capped");
    assert.equal(computeRetryDelay(10, 100, true, 2), 10, "uncapped jitter at the lower bound is floored");
    assert.equal(computeRetryDelay(10, 100, true, 2), 15, "uncapped fractional jitter is floored");
    assert.equal(computeRetryDelay(10, 100, true, 2), 19, "uncapped jitter remains below its ceiling");
    assert.equal(computeRetryDelay(10, 13, true, 8), 9, "capped fractional jitter is floored from the cap");
    assert.equal(drawCount, 4, "only jittered calculations draw randomness, once each");
  } finally {
    Math.random = originalRandom;
  }
});

test("lifecycle retry wrapper preserves zero-base, wait, and abort outcomes", async () => {
  const originalRandom = Math.random;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let randomDraws = 0;
  const delays: number[] = [];
  const cleared: unknown[] = [];
  Math.random = () => {
    randomDraws += 1;
    return 0.5;
  };
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
    delays.push(Number(delay ?? 0));
    queueMicrotask(() => callback());
    return { fakeTimer: true } as unknown as NodeJS.Timeout;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((timer: NodeJS.Timeout) => {
    cleared.push(timer);
  }) as typeof globalThis.clearTimeout;

  try {
    await executionRetryDelay(0, 50, true, 1);
    assert.equal(randomDraws, 0, "the lifecycle wrapper returns before drawing when base is zero");
    assert.equal(delays.length, 0, "zero base does not schedule a wait");

    await executionRetryDelay(10, 50, true, 3);
    assert.equal(randomDraws, 1);
    assert.deepEqual(delays, [30], "retry 3 has a 40ms ceiling and .5 jitter gives 30ms");

    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
      delays.push(Number(delay ?? 0));
      return { fakeTimer: true } as unknown as NodeJS.Timeout;
    }) as typeof globalThis.setTimeout;
    const controller = new AbortController();
    const reason = new Error("preserve this abort identity");
    const waiting = executionRetryDelay(10, 12, false, 1, controller.signal);
    controller.abort(reason);
    await assert.rejects(waiting, (error: unknown) => error === reason);
    assert.deepEqual(delays, [30, 10], "the abortable wrapper schedules its computed delay");
    assert.equal(cleared.length, 1, "aborting clears the scheduled timer");
  } finally {
    Math.random = originalRandom;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
