import assert from "node:assert/strict";
import test from "node:test";
import { SourceMutationCoordinator } from "../src/execution/source-mutation-lease";

test("source mutation coordinator serializes writers and holds queued landings behind a conflict gate", async () => {
  const coordinator = new SourceMutationCoordinator();
  const first = await coordinator.acquire("/tmp/review-gate-lease-test");
  let secondEntered = false;
  const secondPromise = coordinator.acquire("/tmp/review-gate-lease-test").then((release) => {
    secondEntered = true;
    return release;
  });
  await tick();
  assert.equal(secondEntered, false);
  const unblock = coordinator.block("/tmp/review-gate-lease-test", "resolve conflict");
  first();
  await tick();
  assert.equal(secondEntered, false, "a waiter queued before the gate must recheck it after acquiring the lease");
  assert.deepEqual(coordinator.blocked("/tmp/review-gate-lease-test"), { blocked: true, reason: "resolve conflict" });
  unblock();
  const second = await secondPromise;
  assert.equal(secondEntered, true);
  second();
  assert.deepEqual(coordinator.blocked("/tmp/review-gate-lease-test"), { blocked: false });
});

async function tick(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
}
