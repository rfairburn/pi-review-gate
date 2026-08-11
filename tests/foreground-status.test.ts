import assert from "node:assert/strict";
import test from "node:test";
import { createStatusTracker, setStatus } from "../src/pi";

test("setStatus writes and clears a keyed UI status", () => {
  const calls: Array<[string, string | undefined]> = [];
  const ctx = { ui: { setStatus: (key: string, text: string | undefined) => calls.push([key, text]) } };

  setStatus(ctx, "review-gate", "reviewing");
  setStatus(ctx, "review-gate", undefined);

  assert.deepEqual(calls, [["review-gate", "reviewing"], ["review-gate", undefined]]);
});

test("createStatusTracker publishes progress and clears once", () => {
  const calls: Array<[string, string | undefined]> = [];
  const ctx = { ui: { setStatus: (key: string, text: string | undefined) => calls.push([key, text]) } };
  const tracker = createStatusTracker(ctx, "review-gate", "reviewing changes");

  tracker.update("Claude started");
  tracker.clear();
  tracker.update("ignored");
  tracker.clear();

  assert.match(calls[0]?.[1] ?? "", /^reviewing changes \(0s\)$/);
  assert.match(calls[1]?.[1] ?? "", /^Claude started \(0s\)$/);
  assert.deepEqual(calls.at(-1), ["review-gate", undefined]);
  assert.equal(calls.filter(([, text]) => text === undefined).length, 1);
});

test("status helpers tolerate hosts without UI support", () => {
  setStatus({}, "review-gate", "reviewing");
  const tracker = createStatusTracker({}, "review-gate", "reviewing");
  tracker.update("still safe");
  tracker.clear();
});
