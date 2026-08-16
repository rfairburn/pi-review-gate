import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutorPoolEntry } from "../src/config";
import { ExecutorPoolScheduler } from "../src/execution/executor-pool";

const entries: ExecutorPoolEntry[] = [
  { entryId: "qwen", selection: { source: "external", id: "qwen" }, maxConcurrent: 1 },
  { entryId: "deepseek", selection: { source: "external", id: "deepseek" }, maxConcurrent: 2 },
  { entryId: "luna", selection: { source: "external", id: "luna" }, maxConcurrent: 4 },
];

test("executor pool assigns fresh work in strict priority order up to each capacity", () => {
  const scheduler = new ExecutorPoolScheduler(entries);
  const leases = Array.from({ length: 7 }, () => scheduler.tryAcquire());
  assert.deepEqual(leases.map((lease) => lease?.entry.entryId), [
    "qwen",
    "deepseek",
    "deepseek",
    "luna",
    "luna",
    "luna",
    "luna",
  ]);
  assert.equal(scheduler.tryAcquire(), undefined);
  leases.forEach((lease) => lease?.release());
});

test("released high-priority capacity is preferred for the next fresh task", () => {
  const scheduler = new ExecutorPoolScheduler(entries);
  const primary = scheduler.tryAcquire()!;
  const overflow = scheduler.tryAcquire()!;
  assert.equal(overflow.entry.entryId, "deepseek");
  primary.release();
  const next = scheduler.tryAcquire()!;
  assert.equal(next.entry.entryId, "qwen");
  overflow.release();
  next.release();
});

test("failover only acquires a lower-priority executor", async () => {
  const scheduler = new ExecutorPoolScheduler(entries);
  const primary = scheduler.tryAcquire()!;
  const fallback = await scheduler.acquireAfter(primary.priority);
  assert.equal(fallback?.entry.entryId, "deepseek");
  assert.equal(await scheduler.acquireAfter(entries.length - 1), undefined);
  primary.release();
  fallback?.release();
});
