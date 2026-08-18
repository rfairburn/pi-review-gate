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

test("capacity snapshots can model a completing lease before its asynchronous release", () => {
  const scheduler = new ExecutorPoolScheduler(entries);
  const qwen = scheduler.tryAcquire()!;
  const deepseek = scheduler.tryAcquire()!;
  assert.deepEqual(scheduler.capacitySnapshot(), {
    totalCapacity: 7,
    activeLeases: 2,
    availableSlots: 5,
    entries: [
      { entryId: "qwen", priority: 0, capacity: 1, activeLeases: 1, availableSlots: 0 },
      { entryId: "deepseek", priority: 1, capacity: 2, activeLeases: 1, availableSlots: 1 },
      { entryId: "luna", priority: 2, capacity: 4, activeLeases: 0, availableSlots: 4 },
    ],
  });
  const afterQwen = scheduler.capacitySnapshot("qwen");
  assert.equal(afterQwen.activeLeases, 1);
  assert.equal(afterQwen.availableSlots, 6);
  qwen.release();
  deepseek.release();
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

test("live reconfiguration preserves running leases while new work uses current priority and capacity", () => {
  const scheduler = new ExecutorPoolScheduler(entries);
  const qwen = scheduler.tryAcquire()!;
  const deepseek = scheduler.tryAcquire()!;

  scheduler.reconfigure([
    { entryId: "luna", selection: { source: "external", id: "luna" }, maxConcurrent: 1 },
    { entryId: "qwen", selection: { source: "external", id: "qwen" }, maxConcurrent: 2 },
  ]);

  const firstCurrent = scheduler.tryAcquire()!;
  const secondCurrent = scheduler.tryAcquire()!;
  assert.equal(firstCurrent.entry.entryId, "luna");
  assert.equal(secondCurrent.entry.entryId, "qwen");
  assert.equal(scheduler.activeCount("qwen"), 2);
  assert.equal(scheduler.activeCount("deepseek"), 1, "removed entries retain only their running lease count");

  qwen.release();
  deepseek.release();
  firstCurrent.release();
  secondCurrent.release();
});

test("waiting failover recomputes from current settings by stable entry id", async () => {
  const scheduler = new ExecutorPoolScheduler(entries.slice(0, 2));
  const qwen = scheduler.tryAcquire()!;
  const deepseek = scheduler.tryAcquire()!;
  const deepseekSecond = scheduler.tryAcquire()!;
  const waiting = scheduler.acquireAfter(qwen);

  scheduler.reconfigure([
    { entryId: "luna", selection: { source: "external", id: "luna" }, maxConcurrent: 1 },
  ]);

  const fallback = await waiting;
  assert.equal(fallback?.entry.entryId, "luna", "removing the failed entry restarts failover at current top priority");
  qwen.release();
  deepseek.release();
  deepseekSecond.release();
  fallback?.release();
});
