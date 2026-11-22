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

test("several holders on one root are independent: each release frees only itself, idempotently (#682)", async () => {
  const coordinator = new SourceMutationCoordinator();
  const root = "/tmp/review-gate-two-holders";
  const ownerA = {};
  const ownerB = {};
  const releaseA = coordinator.block(root, "A reason", ownerA);
  const releaseB = coordinator.block(root, "B reason", ownerB);
  assert.notEqual(releaseA, releaseB, "every block invocation gets its own releaser");
  let entered = false;
  const waiting = coordinator.acquire(root).then((release) => {
    entered = true;
    return release;
  });
  await tick();
  assert.equal(entered, false);

  // B clears, then releases again (duplicate): A's block still holds.
  releaseB();
  releaseB();
  await tick();
  assert.equal(entered, false, "B's release (even repeated) cannot free A's block");
  assert.deepEqual(coordinator.blocked(root), { blocked: true, reason: "A reason" });
  assert.deepEqual(coordinator.blockedFor(root, ownerB), { blocked: true, foreign: true });
  assert.deepEqual(coordinator.blockedFor(root, ownerA), { blocked: true, ownReason: "A reason", foreign: false });

  // A re-blocks, then B blocks again: both must release before progress.
  const releaseB2 = coordinator.block(root, "B again", ownerB);
  releaseA();
  releaseA();
  await tick();
  assert.equal(entered, false, "a later holder keeps the root blocked after A releases");
  releaseB2();
  const release = await waiting;
  assert.equal(entered, true, "releasing every holder lets the waiter acquire");
  release();
  assert.deepEqual(coordinator.blocked(root), { blocked: false });
  assert.deepEqual(coordinator.blockedFor(root, ownerA), { blocked: false, foreign: false });
});

test("holders on nested roots are independent and acquisition waits for all of them (#682)", async () => {
  const coordinator = new SourceMutationCoordinator();
  const root = "/tmp/review-gate-nested-holders/repo";
  const nested = `${root}/pkg`;
  const ownerA = {};
  const ownerB = {};
  const releaseA = coordinator.block(root, "A reason", ownerA);
  const releaseB = coordinator.block(nested, "B reason", ownerB);
  // Owner-scoped reasons never cross owners; unowned askers see only foreign.
  assert.deepEqual(coordinator.blockedFor(nested, ownerB), { blocked: true, ownReason: "B reason", foreign: true });
  assert.deepEqual(coordinator.blockedFor(nested, ownerA), { blocked: true, ownReason: "A reason", foreign: true });
  assert.deepEqual(coordinator.blockedFor(nested, {}), { blocked: true, foreign: true });

  let nestedEntered = false;
  const nestedWaiter = coordinator.acquire(nested).then((release) => {
    nestedEntered = true;
    return release;
  });
  releaseB();
  releaseB();
  await tick();
  assert.equal(nestedEntered, false, "the ancestor holder still blocks the nested root");
  assert.deepEqual(coordinator.blockedFor(nested, ownerB), { blocked: true, foreign: true });
  releaseA();
  (await nestedWaiter)();
  assert.equal(nestedEntered, true);

  // Reverse order: the nested holder outlives the ancestor's release.
  const releaseRoot = coordinator.block(root, "A again", ownerA);
  const releaseNested = coordinator.block(nested, "B again", ownerB);
  let rootEntered = false;
  const rootWaiter = coordinator.acquire(root).then((release) => {
    rootEntered = true;
    return release;
  });
  releaseRoot();
  await tick();
  assert.equal(rootEntered, false, "the nested holder still blocks its ancestor");
  releaseNested();
  (await rootWaiter)();
  assert.equal(rootEntered, true);
  assert.deepEqual(coordinator.blocked(root), { blocked: false });
});

async function tick(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
}
