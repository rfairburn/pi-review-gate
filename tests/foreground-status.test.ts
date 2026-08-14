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

test("createStatusTracker gives meaningful progress a minimum display time and clears once", async () => {
  const calls: Array<{ key: string; text: string | undefined; at: number }> = [];
  const ctx = { ui: { setStatus: (key: string, text: string | undefined) => calls.push({ key, text, at: Date.now() }) } };
  const tracker = createStatusTracker(ctx, "review-gate", "reviewing changes", { minimumDisplayMs: 15 });

  tracker.update("Claude started");
  await delay(20);
  tracker.update("read · src/index.ts");
  await delay(20);
  await tracker.clear();
  tracker.update("ignored");
  await tracker.clear();

  assert.match(calls[0]?.text ?? "", /^reviewing changes \(0s\)$/);
  assert.match(calls[1]?.text ?? "", /^Claude started \(0s\)$/);
  assert.match(calls[2]?.text ?? "", /^read · src\/index\.ts \(0s\)$/);
  assert.equal((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0) >= 10, true);
  assert.equal((calls[2]?.at ?? 0) - (calls[1]?.at ?? 0) >= 10, true);
  assert.deepEqual(calls.at(-1) && { key: calls.at(-1)?.key, text: calls.at(-1)?.text }, {
    key: "review-gate",
    text: undefined,
  });
  assert.equal(calls.filter(({ text }) => text === undefined).length, 1);
});

test("createStatusTracker coalesces ambient lifecycle chatter", async () => {
  const calls: Array<string | undefined> = [];
  const ctx = { ui: { setStatus: (_key: string, text: string | undefined) => calls.push(text) } };
  const tracker = createStatusTracker(ctx, "review-gate", "asking reviewer", { minimumDisplayMs: 15 });

  tracker.update("ollama/model · model turn started");
  tracker.update("ollama/model · model reasoning");
  tracker.update("ollama/model · model composing response");
  await delay(20);
  await tracker.clear();

  assert.equal(calls.some((text) => text?.includes("turn started")), false);
  assert.equal(calls.some((text) => text?.includes("model reasoning")), false);
  assert.equal(calls.some((text) => text?.includes("model composing response")), true);
});

test("createStatusTracker discards backlog at completion and adds at most one dwell", async () => {
  const calls: Array<string | undefined> = [];
  const ctx = { ui: { setStatus: (_key: string, text: string | undefined) => calls.push(text) } };
  const tracker = createStatusTracker(ctx, "review-gate", "asking reviewer", { minimumDisplayMs: 25 });
  const clearStartedAt = Date.now();

  tracker.update("read · one.ts");
  tracker.update("read · two.ts");
  tracker.update("read · three.ts");
  await tracker.clear();

  assert.equal(Date.now() - clearStartedAt < 60, true);
  assert.equal(calls.some((text) => text?.includes("one.ts")), false);
  assert.equal(calls.some((text) => text?.includes("two.ts")), false);
  assert.equal(calls.some((text) => text?.includes("three.ts")), false);
  assert.equal(calls.at(-1), undefined);
});

test("createStatusTracker clears immediately when its review is aborted", async () => {
  const calls: Array<string | undefined> = [];
  const ctx = { ui: { setStatus: (_key: string, text: string | undefined) => calls.push(text) } };
  const tracker = createStatusTracker(ctx, "review-gate", "asking reviewer", { minimumDisplayMs: 1_000 });
  const controller = new AbortController();
  const startedAt = Date.now();
  const clearing = tracker.clear({ signal: controller.signal });

  controller.abort("escape");
  await clearing;

  assert.equal(Date.now() - startedAt < 100, true);
  assert.equal(calls.at(-1), undefined);
});

test("status helpers tolerate hosts without UI support", async () => {
  setStatus({}, "review-gate", "reviewing");
  const tracker = createStatusTracker({}, "review-gate", "reviewing", { minimumDisplayMs: 0 });
  tracker.update("still safe");
  await tracker.clear();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
