import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { GitWorktreeCoordinator } from "../src/execution/wave-worktrees";

// Deterministic lease-semantics coverage for the coordinator itself. Production
// boundary coverage — the production worktree APIs held at the administration
// invocation boundary, including removal's post-wait cleanliness revalidation —
// is in wave-worktrees.test.ts.

/**
 * Resolve the next event-loop turn. The coordinator's grant path below is
 * promise-only (no filesystem resolution), so a grant that is going to happen
 * without waiting for the held lease happens in the microtask drain before this
 * barrier. It is an ordering barrier, not a wall-clock race assertion.
 */
function nextTurn(): Promise<void> {
  return new Promise((resolveTurn) => setImmediate(resolveTurn));
}

/**
 * A coordinator whose key resolution does not touch the filesystem, so tests
 * can observe queue state deterministically. Production keys come from the
 * canonical repository root.
 */
function createCoordinator(): GitWorktreeCoordinator {
  return new GitWorktreeCoordinator(async (repoPath) => resolve(repoPath));
}

/** Settle a promise without masking a cancellation rejection. */
async function settle(promise: Promise<unknown>): Promise<void> {
  await promise.then(() => undefined, () => undefined);
}

// ── Same repository: registration mutations exclude each other ───────────────

test("git worktree coordination — same repository mutations exclude each other", async () => {
  const coordinator = createCoordinator();
  const repoPath = "/repos/shared";
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolveGate) => {
    releaseFirst = resolveGate;
  });

  const first = coordinator.run(repoPath, undefined, async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  await nextTurn();

  const second = coordinator.run(repoPath, undefined, async () => {
    events.push("second");
  });

  // A shared-administration mutation must not observe another's partially
  // created or removed registration, so the second operation cannot have
  // started while the first holds the lease.
  await nextTurn();
  assert.deepEqual(events, ["first:start"], "a queued mutation must not start early");

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(
    events,
    ["first:start", "first:end", "second"],
    "the queued mutation runs only after the holder releases",
  );
});

// ── Different repositories: no shared lease ─────────────────────────────────

test("git worktree coordination — different repositories stay independent", async () => {
  const coordinator = createCoordinator();
  let releaseHolder!: () => void;
  const holderGate = new Promise<void>((resolveGate) => {
    releaseHolder = resolveGate;
  });

  const holder = coordinator.run("/repos/one", undefined, async () => {
    await holderGate;
  });
  await nextTurn();

  let otherRan = false;
  const otherAbort = new AbortController();
  const other = coordinator.run("/repos/two", otherAbort.signal, async () => {
    otherRan = true;
  });
  // Granting needs only microtasks, so the next turn establishes whether the
  // other repository progressed while the first repository's lease is held.
  await nextTurn();
  otherAbort.abort();
  await settle(other);
  assert.equal(otherRan, true, "a different repository must not queue behind this lease");

  releaseHolder();
  await holder;
});

// ── Cancellation: queued work is never admitted ─────────────────────────────

test("git worktree coordination — a cancelled queued mutation never runs", async () => {
  const coordinator = createCoordinator();
  const repoPath = "/repos/shared";
  let releaseHolder!: () => void;
  const holderGate = new Promise<void>((resolveGate) => {
    releaseHolder = resolveGate;
  });

  const holder = coordinator.run(repoPath, undefined, async () => {
    await holderGate;
  });
  await nextTurn();

  const queuedAbort = new AbortController();
  let queuedRan = false;
  const queued = coordinator.run(repoPath, queuedAbort.signal, async () => {
    queuedRan = true;
  });
  await nextTurn();

  queuedAbort.abort();
  await assert.rejects(queued, { name: "AbortError" });
  assert.equal(queuedRan, false, "cancelled queued work must not run its operation");

  // The cancelled waiter must not consume or wedge the lease: a later caller is
  // still ordered behind the holder and then runs normally.
  let followerRan = false;
  const follower = coordinator.run(repoPath, undefined, async () => {
    followerRan = true;
  });
  releaseHolder();
  await Promise.all([holder, follower]);
  assert.equal(followerRan, true, "the cancelled waiter must not wedge later callers");
});

// ── Failures: the lease is released ─────────────────────────────────────────

test("git worktree coordination — a failed mutation releases the lease", async () => {
  const coordinator = createCoordinator();
  const repoPath = "/repos/shared";

  await assert.rejects(
    coordinator.run(repoPath, undefined, async () => {
      throw new Error("worktree preparation failed");
    }),
    /worktree preparation failed/,
  );

  let followerRan = false;
  const followerAbort = new AbortController();
  const follower = coordinator.run(repoPath, followerAbort.signal, async () => {
    followerRan = true;
  });
  await nextTurn();
  followerAbort.abort();
  await settle(follower);
  assert.equal(followerRan, true, "a failed mutation must release the repository lease");
});
