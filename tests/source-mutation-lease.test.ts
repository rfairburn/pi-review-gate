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

test("an aborted queued lease is pruned after its predecessor settles", async () => {
  const coordinator = new SourceMutationCoordinator();
  const root = "/tmp/review-gate-aborted-lease";
  const releaseFirst = await coordinator.acquire(root);
  const abort = new AbortController();
  const waiting = coordinator.acquire(root, abort.signal);
  abort.abort(new Error("cancel waiting mutation"));
  await assert.rejects(waiting, /cancel waiting mutation/);

  releaseFirst();
  await tick();
  const tails = (coordinator as unknown as { tails: Map<string, Promise<void>> }).tails;
  assert.equal(tails.size, 0, "an aborted waiter has no release callback, so acquire must prune its own settled tail");

  const releaseNext = await coordinator.acquire(root);
  releaseNext();
});

test("source mutation coordinator shares leases and gates across nested workspace paths", async () => {
  const coordinator = new SourceMutationCoordinator();
  const root = "/tmp/review-gate-nested/repo";
  const cwd = `${root}/packages/app`;

  // A lease held on the capture root must hold a patching session that runs
  // from a subdirectory of it.
  const releaseRoot = await coordinator.acquire(root);
  let nestedEntered = false;
  const nestedPromise = coordinator.acquire(cwd).then((release) => {
    nestedEntered = true;
    return release;
  });
  await tick();
  assert.equal(nestedEntered, false);
  releaseRoot();
  const releaseNested = await nestedPromise;
  releaseNested();

  // A conflict gate on the capture root must also block subdirectory acquirers
  // and be visible through blocked().
  const unblock = coordinator.block(root, "resolve conflict");
  let blockedEntered = false;
  const blockedPromise = coordinator.acquire(cwd).then((release) => {
    blockedEntered = true;
    return release;
  });
  await tick();
  assert.equal(blockedEntered, false);
  assert.deepEqual(coordinator.blocked(cwd), { blocked: true, reason: "resolve conflict" });
  unblock();
  const releaseBlocked = await blockedPromise;
  releaseBlocked();
});

async function tick(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
}
