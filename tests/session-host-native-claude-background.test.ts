/**
 * Focused tests for the bounded native Claude background membership ledger.
 *
 * The ledger is the counter core behind exact LIVE background counts: a known
 * fresh owned-run baseline plus positively observed launch/settle edges and
 * complete root membership snapshots. These tests pin the exact-count path, the
 * idempotence of duplicate and reversed edges, replay protection that survives
 * a resync, scope fencing between an old run and a later one, the withdrawal
 * rules that keep a genuine coverage hole from becoming a fabricated zero, the
 * bounded settled-id memory that keeps a long run exact instead of permanently
 * unknown, and the absence of any provider content in ledger state.
 *
 * No provider process, transcript, filesystem, network, or model call is used.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_NATIVE_CLAUDE_BACKGROUND_MEMBERS,
  MAX_NATIVE_CLAUDE_BACKGROUND_MEMBER_ID_BYTES,
  MAX_NATIVE_CLAUDE_BACKGROUND_TOMBSTONES,
  NativeClaudeBackgroundLedger,
  countNativeClaudeBackgroundMembers,
  isNativeClaudeBackgroundKind,
  readNativeClaudeBackgroundLaunch,
  readNativeClaudeBackgroundMembers,
} from "../src/session-host/native-claude-background";

const SCOPE = "owned-run-1";
const SCOPE_B = "owned-run-2";
// The shape the installed provider actually issues (Fw/Y1): a one-character
// type prefix plus 8 base36 characters.
const SHELL_A = "b8k3n1p4q";
const SHELL_B = "b0zzzzzzzz";
const TASK_A = "a1a2b3c4d";

function freshLedger(scopeToken = SCOPE): NativeClaudeBackgroundLedger {
  const ledger = new NativeClaudeBackgroundLedger();
  const outcome = ledger.initializeFreshOwnedRun(scopeToken);
  assert.equal(outcome.outcome, "applied");
  assert.deepEqual(outcome.counts, { tasks: 0, shells: 0 });
  return ledger;
}

test("no scope means no claim: edges before any baseline publish nothing", () => {
  const ledger = new NativeClaudeBackgroundLedger();
  assert.deepEqual(ledger.snapshot(), {
    scopeToken: null,
    membershipKnown: false,
    needsResync: false,
    counts: null,
    members: [],
  });
  assert.deepEqual(ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" }), {
    outcome: "ignored",
    reason: "unbound-scope",
    counts: null,
  });
  assert.deepEqual(ledger.observeSettled(SCOPE, SHELL_A), {
    outcome: "ignored",
    reason: "unbound-scope",
    counts: null,
  });
  assert.deepEqual(ledger.replaceFullRootMembers(SCOPE, []), {
    outcome: "ignored",
    reason: "unbound-scope",
    counts: null,
  });
  assert.deepEqual(ledger.noteCoverageGap(SCOPE), {
    outcome: "ignored",
    reason: "unbound-scope",
    counts: null,
  });
  assert.equal(ledger.counts(), null);
});

test("a fresh owned run is a positively known empty baseline, never an assumed zero", () => {
  const ledger = new NativeClaudeBackgroundLedger();
  const outcome = ledger.initializeFreshOwnedRun(SCOPE);
  assert.deepEqual(outcome, {
    outcome: "applied",
    reason: "fresh-owned-run",
    counts: { tasks: 0, shells: 0 },
  });
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.scopeToken, SCOPE);
  assert.equal(snapshot.membershipKnown, true);
  assert.equal(snapshot.needsResync, false);
  assert.deepEqual(snapshot.counts, { tasks: 0, shells: 0 });

  // A malformed scope token never establishes (or replaces) a baseline.
  const other = new NativeClaudeBackgroundLedger();
  assert.equal(other.initializeFreshOwnedRun("").outcome, "ignored");
  assert.equal(other.initializeFreshOwnedRun(42).reason, "malformed-scope-token");
  assert.equal(other.initializeFreshOwnedRun("x\u0000\u001b[7my".repeat(200)).reason, "malformed-scope-token");
  assert.equal(other.snapshot().scopeToken, null);
  // A control character is not an opaque token.
  assert.equal(other.initializeFreshOwnedRun("bad\u0001id").reason, "malformed-scope-token");
  assert.equal(other.snapshot().scopeToken, null);
});

test("initialization cannot overwrite an established baseline or a live run", () => {
  const ledger = freshLedger();
  ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" });

  // The same token again is an idempotent no-op, not a reset to 0/0.
  assert.deepEqual(ledger.initializeFreshOwnedRun(SCOPE), {
    outcome: "ignored",
    reason: "duplicate-init",
    counts: { tasks: 0, shells: 1 },
  });
  // A foreign token is refused while a run is bound: no fabricated empty census.
  assert.deepEqual(ledger.initializeFreshOwnedRun(SCOPE_B), {
    outcome: "ignored",
    reason: "scope-bound",
    counts: { tasks: 0, shells: 1 },
  });
  assert.deepEqual(ledger.counts(), { tasks: 0, shells: 1 });
  assert.equal(ledger.snapshot().scopeToken, SCOPE);

  // Retirement is the explicit lifecycle transition a new baseline requires.
  assert.equal(ledger.retireScope(SCOPE).scopeToken, null);
  assert.deepEqual(ledger.initializeFreshOwnedRun(SCOPE_B).counts, { tasks: 0, shells: 0 });
});

test("launch edges on a known baseline keep exact task and shell counts, then settle back to zero", () => {
  const ledger = freshLedger();

  assert.deepEqual(ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" }), {
    outcome: "applied",
    reason: "launch-observed",
    counts: { tasks: 0, shells: 1 },
  });
  assert.deepEqual(ledger.observeStarted(SCOPE, { id: TASK_A, kind: "task" }), {
    outcome: "applied",
    reason: "launch-observed",
    counts: { tasks: 1, shells: 1 },
  });
  assert.deepEqual(ledger.observeStarted(SCOPE, { id: SHELL_B, kind: "shell" }), {
    outcome: "applied",
    reason: "launch-observed",
    counts: { tasks: 1, shells: 2 },
  });
  assert.deepEqual(ledger.counts(), { tasks: 1, shells: 2 });

  // Settling in any order stays exact, and the last member leaving is a real 0.
  assert.deepEqual(ledger.observeSettled(SCOPE, TASK_A), {
    outcome: "applied",
    reason: "settle-observed",
    counts: { tasks: 0, shells: 2 },
  });
  assert.deepEqual(ledger.observeSettled(SCOPE, SHELL_B), {
    outcome: "applied",
    reason: "settle-observed",
    counts: { tasks: 0, shells: 1 },
  });
  assert.deepEqual(ledger.observeSettled(SCOPE, SHELL_A), {
    outcome: "applied",
    reason: "settle-observed",
    counts: { tasks: 0, shells: 0 },
  });
  assert.deepEqual(ledger.snapshot().members, []);
  assert.equal(ledger.snapshot().needsResync, false);
});

test("duplicate and reversed edges are idempotent and never resurrect settled work", () => {
  const ledger = freshLedger();
  ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" });

  const duplicate = ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" });
  assert.equal(duplicate.outcome, "ignored");
  assert.equal(duplicate.reason, "duplicate-start");
  assert.deepEqual(duplicate.counts, { tasks: 0, shells: 1 });

  assert.deepEqual(ledger.observeSettled(SCOPE, SHELL_A), {
    outcome: "applied",
    reason: "settle-observed",
    counts: { tasks: 0, shells: 0 },
  });
  // A replayed settle is not news.
  assert.equal(ledger.observeSettled(SCOPE, SHELL_A).reason, "duplicate-settle");
  // A delayed start edge for finished work cannot resurrect it.
  const resurrect = ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" });
  assert.equal(resurrect.outcome, "ignored");
  assert.equal(resurrect.reason, "late-start-after-settle");
  assert.deepEqual(ledger.counts(), { tasks: 0, shells: 0 });

  // Reversed delivery: a settle whose launch edge was lost is a real hole.
  const gap = ledger.observeSettled(SCOPE, "b11111111");
  assert.equal(gap.outcome, "invalid");
  assert.equal(gap.reason, "settle-unobserved");
  assert.equal(gap.counts, null);
  assert.equal(ledger.snapshot().membershipKnown, false);
  assert.equal(ledger.snapshot().needsResync, true);
  // Edges alone cannot rebuild a withdrawn census.
  assert.deepEqual(ledger.observeStarted(SCOPE, { id: "b22222222", kind: "shell" }), {
    outcome: "tracked",
    reason: "launch-observed",
    counts: null,
  });
  assert.equal(ledger.counts(), null);
  // Only a complete membership snapshot recovers it, and it outranks the
  // settle memory: the provider states the current set outright.
  assert.deepEqual(ledger.replaceFullRootMembers(SCOPE, [
    { id: "b22222222", kind: "shell" },
    { id: SHELL_A, kind: "shell" },
  ]), {
    outcome: "applied",
    reason: "root-snapshot-applied",
    counts: { tasks: 0, shells: 2 },
  });
});

test("replay protection survives a resync: delayed starts and completions after a snapshot", () => {
  const ledger = freshLedger();
  ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" });
  ledger.observeSettled(SCOPE, SHELL_A);

  // An empty root snapshot must not erase the protection A already earned.
  assert.deepEqual(ledger.replaceFullRootMembers(SCOPE, []), {
    outcome: "applied",
    reason: "root-snapshot-empty",
    counts: { tasks: 0, shells: 0 },
  });
  assert.deepEqual(ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" }), {
    outcome: "ignored",
    reason: "late-start-after-settle",
    counts: { tasks: 0, shells: 0 },
  });
  assert.deepEqual(ledger.counts(), { tasks: 0, shells: 0 });

  // A member the snapshot dropped settled, so its later completion is a replay,
  // not an unobserved hole: healthy counts stay exact instead of withdrawing.
  const other = freshLedger();
  other.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" });
  other.observeStarted(SCOPE, { id: TASK_A, kind: "task" });
  assert.deepEqual(other.replaceFullRootMembers(SCOPE, [{ id: TASK_A, kind: "task" }]), {
    outcome: "applied",
    reason: "root-snapshot-applied",
    counts: { tasks: 1, shells: 0 },
  });
  assert.deepEqual(other.observeSettled(SCOPE, SHELL_A), {
    outcome: "ignored",
    reason: "duplicate-settle",
    counts: { tasks: 1, shells: 0 },
  });
  assert.deepEqual(other.counts(), { tasks: 1, shells: 0 });
  assert.equal(other.snapshot().needsResync, false);

  // A snapshot that positively lists an id outranks the memory and reactivates
  // it, and the reactivated id is then settleable normally.
  assert.deepEqual(other.replaceFullRootMembers(SCOPE, [
    { id: TASK_A, kind: "task" },
    { id: SHELL_A, kind: "shell" },
  ]), {
    outcome: "applied",
    reason: "root-snapshot-applied",
    counts: { tasks: 1, shells: 1 },
  });
  assert.deepEqual(other.observeSettled(SCOPE, SHELL_A), {
    outcome: "applied",
    reason: "settle-observed",
    counts: { tasks: 1, shells: 0 },
  });
});

test("an unobserved launch's completion retains bounded replay protection across resync", () => {
  const ledger = freshLedger();
  // Reversed delivery: the completion arrives with no launch edge. The census
  // withdraws, but the finished-work evidence is kept.
  assert.equal(ledger.observeSettled(SCOPE, SHELL_A).reason, "settle-unobserved");
  assert.equal(ledger.observeSettled(SCOPE, SHELL_A).reason, "duplicate-settle");
  assert.equal(ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" }).reason,
    "late-start-after-settle");
  // A resync must not launder that protection away.
  assert.deepEqual(ledger.replaceFullRootMembers(SCOPE, []).counts, { tasks: 0, shells: 0 });
  assert.equal(ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" }).reason,
    "late-start-after-settle");
  assert.deepEqual(ledger.counts(), { tasks: 0, shells: 0 });

  // The same memory is bounded here too: an unremembered completion keeps its
  // replay protection while the memory holds it, and the census recovers from a
  // complete root snapshot instead of staying closed for the rest of the run.
  const bounded = freshLedger();
  for (let index = 0; index < MAX_NATIVE_CLAUDE_BACKGROUND_TOMBSTONES; index += 1) {
    assert.equal(bounded.observeSettled(SCOPE, `b${index}`).reason, "settle-unobserved");
  }
  // One more unobserved completion is still a census hole (that reason stands),
  // and the bounded memory simply makes room for the newer evidence.
  assert.equal(bounded.observeSettled(SCOPE, "boverflow").reason, "settle-unobserved");
  assert.equal(bounded.counts(), null);
  assert.equal(bounded.snapshot().needsResync, true);
  // Edges alone cannot rebuild the census; the provider's whole set can.
  assert.equal(bounded.observeStarted(SCOPE, { id: "bnew00000", kind: "shell" }).outcome, "tracked");
  assert.equal(bounded.counts(), null);
  assert.deepEqual(bounded.replaceFullRootMembers(SCOPE, [{ id: "bnew00000", kind: "shell" }]), {
    outcome: "applied",
    reason: "root-snapshot-applied",
    counts: { tasks: 0, shells: 1 },
  });
  assert.equal(bounded.snapshot().needsResync, false);
  assert.deepEqual(bounded.replaceFullRootMembers(SCOPE, []).counts, { tasks: 0, shells: 0 });
});

test("a complete root membership snapshot replaces membership exactly, including a real empty set", () => {
  const ledger = freshLedger();
  ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" });
  ledger.observeStarted(SCOPE, { id: TASK_A, kind: "task" });

  // Mixed kinds: the provider's own labels collapse to task/shell counts.
  assert.deepEqual(ledger.replaceFullRootMembers(SCOPE, [
    { id: TASK_A, kind: "task" },
    { id: "m77777777", kind: "task" },
    { id: SHELL_A, kind: "shell" },
  ]), {
    outcome: "applied",
    reason: "root-snapshot-applied",
    counts: { tasks: 2, shells: 1 },
  });
  assert.deepEqual(ledger.snapshot().members, [
    { id: TASK_A, kind: "task" },
    { id: "m77777777", kind: "task" },
    { id: SHELL_A, kind: "shell" },
  ]);

  // The same snapshot again is a consistent, non-claiming repeat.
  const repeat = ledger.replaceFullRootMembers(SCOPE, [
    { id: TASK_A, kind: "task" },
    { id: "m77777777", kind: "task" },
    { id: SHELL_A, kind: "shell" },
  ]);
  assert.deepEqual(repeat.counts, { tasks: 2, shells: 1 });

  // An empty array is a positively observed zero, not an absence of data.
  assert.deepEqual(ledger.replaceFullRootMembers(SCOPE, []), {
    outcome: "applied",
    reason: "root-snapshot-empty",
    counts: { tasks: 0, shells: 0 },
  });
  assert.deepEqual(ledger.snapshot().members, []);
});

test("a malformed snapshot withdraws the counts instead of being accepted as empty", () => {
  const ledger = freshLedger();
  ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" });
  ledger.observeStarted(SCOPE, { id: TASK_A, kind: "task" });

  const malformed: unknown[] = [
    null,
    undefined,
    "not-an-array",
    { 0: { id: SHELL_A, kind: "shell" } },
    [{ id: SHELL_A }],
    [{ kind: "shell" }],
    [{ id: SHELL_A, kind: "agent" }],
    [{ id: SHELL_A, kind: "shell", description: "SECRET DESCRIPTION" }],
    [{ id: "", kind: "shell" }],
    [{ id: `${"x".repeat(MAX_NATIVE_CLAUDE_BACKGROUND_MEMBER_ID_BYTES + 1)}`, kind: "shell" }],
    [{ id: "bad\u0001id", kind: "shell" }],
    [{ id: SHELL_A, kind: "shell" }, { id: SHELL_A, kind: "task" }],
    Array.from({ length: MAX_NATIVE_CLAUDE_BACKGROUND_MEMBERS + 1 }, (_unused, index) => ({
      id: `b${index}`,
      kind: "shell" as const,
    })),
  ];
  for (const snapshot of malformed) {
    const outcome = ledger.replaceFullRootMembers(SCOPE, snapshot);
    assert.equal(outcome.outcome, "invalid", "malformed membership is never accepted as a count");
    assert.equal(outcome.reason, "malformed-snapshot");
    assert.equal(outcome.counts, null);
    assert.equal(ledger.counts(), null);
    assert.equal(ledger.snapshot().needsResync, true);
  }

  // Recovery is exact once a well-formed complete snapshot arrives.
  assert.deepEqual(ledger.replaceFullRootMembers(SCOPE, [{ id: TASK_A, kind: "task" }]), {
    outcome: "applied",
    reason: "root-snapshot-applied",
    counts: { tasks: 1, shells: 0 },
  });
});

test("member capacity overflow is a closed failure that demands resync, never a truncated count", () => {
  const ledger = freshLedger();
  const ids = Array.from({ length: MAX_NATIVE_CLAUDE_BACKGROUND_MEMBERS }, (_unused, index) => `b${index}`);
  for (const id of ids) {
    assert.equal(ledger.observeStarted(SCOPE, { id, kind: "shell" }).outcome, "applied");
  }
  assert.deepEqual(ledger.counts(), { tasks: 0, shells: MAX_NATIVE_CLAUDE_BACKGROUND_MEMBERS });

  const overflow = ledger.observeStarted(SCOPE, { id: "boverflow", kind: "shell" });
  assert.equal(overflow.outcome, "invalid");
  assert.equal(overflow.reason, "capacity");
  assert.equal(overflow.counts, null);
  assert.equal(ledger.snapshot().membershipKnown, false);
  assert.equal(ledger.snapshot().needsResync, true);

  // A complete snapshot inside the bound rebuilds exact counts.
  assert.equal(ledger.replaceFullRootMembers(SCOPE, ids.slice(0, 3).map((id) => ({ id, kind: "shell" as const }))).counts
    ?.shells, 3);
  assert.equal(ledger.replaceFullRootMembers(SCOPE, ids.map((id) => ({ id, kind: "shell" as const }))).reason,
    "root-snapshot-applied");
  // A snapshot over the bound is malformed, not silently truncated.
  assert.equal(ledger.replaceFullRootMembers(SCOPE,
    Array.from({ length: MAX_NATIVE_CLAUDE_BACKGROUND_MEMBERS + 1 }, (_unused, index) => ({
      id: `b${index}`,
      kind: "shell" as const,
    })),
  ).reason, "malformed-snapshot");
});

test("a run keeps exact counts past the settled-id memory bound, and a resync re-anchors it", () => {
  const ledger = freshLedger();
  const ids = Array.from(
    { length: MAX_NATIVE_CLAUDE_BACKGROUND_TOMBSTONES + 1 },
    (_unused, index) => `b${index}`,
  );
  for (const id of ids) {
    ledger.observeStarted(SCOPE, { id, kind: "shell" });
    assert.deepEqual(ledger.counts(), { tasks: 0, shells: 1 });
    const settled = ledger.observeSettled(SCOPE, id);
    // Every settle stays exact. Only the last one names the eviction, and an
    // eviction is a memory event, never a hole in the census.
    assert.equal(settled.outcome, "applied");
    assert.deepEqual(settled.counts, { tasks: 0, shells: 0 });
    assert.equal(settled.reason, id === ids[ids.length - 1] ? "tombstone-capacity" : "settle-observed");
  }
  assert.equal(ledger.snapshot().membershipKnown, true);
  assert.equal(ledger.snapshot().needsResync, false);
  assert.deepEqual(ledger.counts(), { tasks: 0, shells: 0 });

  // Every id still inside the bounded memory keeps its late-edge protection: a
  // replayed old start is refused and nothing publishes a resurrected count.
  for (const id of ids.slice(1)) {
    assert.equal(ledger.observeStarted(SCOPE, { id, kind: "shell" }).reason, "late-start-after-settle");
  }
  assert.deepEqual(ledger.counts(), { tasks: 0, shells: 0 });

  // The evicted id is the stated cost of a bounded memory: a delayed start for it
  // can land as a member. A complete root snapshot corrects it, so no wrong count
  // is left standing, and the run never needed a restart.
  assert.deepEqual(ledger.observeStarted(SCOPE, { id: ids[0], kind: "shell" }).counts, { tasks: 0, shells: 1 });
  assert.deepEqual(ledger.replaceFullRootMembers(SCOPE, []).counts, { tasks: 0, shells: 0 });
  assert.equal(ledger.snapshot().membershipKnown, true);

  // Ordinary live edges keep working exactly afterwards.
  assert.deepEqual(ledger.observeStarted(SCOPE, { id: "bnew00000", kind: "task" }).counts, { tasks: 1, shells: 0 });
  assert.deepEqual(ledger.observeSettled(SCOPE, "bnew00000").counts, { tasks: 0, shells: 0 });

  // Crossing the bound a second time changes nothing about publishability.
  for (let index = 0; index < MAX_NATIVE_CLAUDE_BACKGROUND_TOMBSTONES; index += 1) {
    ledger.observeStarted(SCOPE, { id: `c${index}`, kind: "shell" });
    assert.equal(ledger.observeSettled(SCOPE, `c${index}`).outcome, "applied");
  }
  assert.deepEqual(ledger.counts(), { tasks: 0, shells: 0 });
  assert.equal(ledger.snapshot().membershipKnown, true);
});

test("a mid-stream adopted scope tracks members but publishes nothing until a complete snapshot", () => {
  const ledger = new NativeClaudeBackgroundLedger();
  assert.deepEqual(ledger.adoptRootSession(SCOPE), {
    outcome: "tracked",
    reason: "root-session-adopted",
    counts: null,
  });
  assert.equal(ledger.snapshot().scopeToken, SCOPE);
  assert.equal(ledger.snapshot().membershipKnown, false);
  assert.deepEqual(ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" }), {
    outcome: "tracked",
    reason: "launch-observed",
    counts: null,
  });
  assert.equal(ledger.counts(), null, "work may have started before this observer joined");
  assert.deepEqual(ledger.observeSettled(SCOPE, SHELL_A), {
    outcome: "tracked",
    reason: "settle-observed",
    counts: null,
  });

  assert.deepEqual(ledger.replaceFullRootMembers(SCOPE, [{ id: TASK_A, kind: "task" }]), {
    outcome: "applied",
    reason: "root-snapshot-applied",
    counts: { tasks: 1, shells: 0 },
  });
  // Edges after that resync are exact again. (A different id: SHELL_A was
  // settled, so a later start for it stays refused as a delayed edge.)
  assert.deepEqual(ledger.observeStarted(SCOPE, { id: SHELL_B, kind: "shell" }).counts, { tasks: 1, shells: 1 });
});

test("every operation is fenced to its own scope: a retired run cannot mutate a later one", () => {
  const ledger = freshLedger();
  ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" });
  ledger.observeSettled(SCOPE, SHELL_A);
  assert.equal(ledger.retireScope(SCOPE).scopeToken, null);

  // A new owned run binds cleanly.
  assert.deepEqual(ledger.initializeFreshOwnedRun(SCOPE_B).counts, { tasks: 0, shells: 0 });

  // Nothing stale from run A can reach run B.
  assert.deepEqual(ledger.observeStarted(SCOPE, { id: SHELL_B, kind: "shell" }), {
    outcome: "ignored",
    reason: "scope-mismatch",
    counts: { tasks: 0, shells: 0 },
  });
  assert.deepEqual(ledger.observeSettled(SCOPE, SHELL_B), {
    outcome: "ignored",
    reason: "scope-mismatch",
    counts: { tasks: 0, shells: 0 },
  });
  assert.deepEqual(ledger.replaceFullRootMembers(SCOPE, [{ id: SHELL_B, kind: "shell" }]), {
    outcome: "ignored",
    reason: "scope-mismatch",
    counts: { tasks: 0, shells: 0 },
  });
  assert.deepEqual(ledger.noteCoverageGap(SCOPE), {
    outcome: "ignored",
    reason: "scope-mismatch",
    counts: { tasks: 0, shells: 0 },
  });
  // A stale token cannot retire the live run either.
  assert.equal(ledger.retireScope(SCOPE).scopeToken, SCOPE_B);
  assert.deepEqual(ledger.counts(), { tasks: 0, shells: 0 });
  assert.equal(ledger.snapshot().membershipKnown, true);

  // And the fenced operations left no trace: run B still behaves exactly.
  assert.deepEqual(ledger.observeStarted(SCOPE_B, { id: SHELL_B, kind: "shell" }).counts, { tasks: 0, shells: 1 });
  assert.equal(ledger.retireScope(SCOPE_B).scopeToken, null);
  // A retired scope's own token no longer matches anything.
  assert.deepEqual(ledger.observeSettled(SCOPE_B, SHELL_B), {
    outcome: "ignored",
    reason: "unbound-scope",
    counts: null,
  });
});

test("scope binding cannot be overwritten by a foreign token", () => {
  const ledger = freshLedger();
  ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" });

  // A repeat adopt of the same scope is not news and keeps the baseline.
  assert.equal(ledger.adoptRootSession(SCOPE).reason, "duplicate-adopt");
  assert.deepEqual(ledger.counts(), { tasks: 0, shells: 1 });
  // A foreign scope token is refused rather than allowed to reset known state.
  assert.equal(ledger.adoptRootSession(SCOPE_B).reason, "scope-mismatch");
  assert.deepEqual(ledger.counts(), { tasks: 0, shells: 1 });
  assert.equal(ledger.snapshot().scopeToken, SCOPE);
});

test("a genuine coverage gap withdraws counts and only resync restores them", () => {
  const ledger = freshLedger();
  ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" });
  assert.deepEqual(ledger.counts(), { tasks: 0, shells: 1 });

  const gap = ledger.noteCoverageGap(SCOPE);
  assert.deepEqual(gap, { outcome: "invalid", reason: "coverage-gap", counts: null });
  assert.equal(ledger.snapshot().membershipKnown, false);
  assert.equal(ledger.snapshot().needsResync, true);
  assert.equal(ledger.counts(), null, "a gap is never relabeled zero or held as a stale count");

  assert.deepEqual(ledger.replaceFullRootMembers(SCOPE, []), {
    outcome: "applied",
    reason: "root-snapshot-empty",
    counts: { tasks: 0, shells: 0 },
  });
  assert.equal(ledger.snapshot().needsResync, false);
});

test("malformed edges claim nothing, and ledger state holds no provider content", () => {
  const ledger = freshLedger();
  const malformed: unknown[] = [
    null,
    undefined,
    {},
    { id: SHELL_A },
    { kind: "shell" },
    { id: SHELL_A, kind: "agent" },
    { id: 7, kind: "shell" },
    { id: "", kind: "shell" },
    { id: `${"y".repeat(MAX_NATIVE_CLAUDE_BACKGROUND_MEMBER_ID_BYTES + 1)}`, kind: "shell" },
    { id: "bad\u0001id", kind: "shell" },
  ];
  for (const edge of malformed) {
    assert.deepEqual(ledger.observeStarted(SCOPE, edge), {
      outcome: "ignored",
      reason: "malformed-member",
      counts: { tasks: 0, shells: 0 },
    });
    assert.deepEqual(ledger.observeSettled(SCOPE, edge), {
      outcome: "ignored",
      reason: "malformed-member",
      counts: { tasks: 0, shells: 0 },
    });
  }
  // A bare id is not a member: a launch edge needs the closed id/kind pair.
  assert.deepEqual(ledger.observeStarted(SCOPE, SHELL_A), {
    outcome: "ignored",
    reason: "malformed-member",
    counts: { tasks: 0, shells: 0 },
  });
  // A well-formed id this ledger never started is not malformed input: it is a
  // settle whose launch edge was lost, so it withdraws the counts.
  assert.deepEqual(ledger.observeSettled(SCOPE, "b99999999"), {
    outcome: "invalid",
    reason: "settle-unobserved",
    counts: null,
  });
  assert.deepEqual(ledger.replaceFullRootMembers(SCOPE, []).counts, { tasks: 0, shells: 0 });
  assert.deepEqual(ledger.snapshot().members, []);

  ledger.observeStarted(SCOPE, { id: SHELL_A, kind: "shell" });
  ledger.observeStarted(SCOPE, { id: TASK_A, kind: "task" });
  const serialized = JSON.stringify(ledger.snapshot());
  assert.deepEqual(JSON.parse(serialized).members, [
    { id: SHELL_A, kind: "shell" },
    { id: TASK_A, kind: "task" },
  ]);
  // Only opaque ids and kinds are retained: no command, description, prompt,
  // tool argument, result, timestamp, or path field exists anywhere.
  for (const key of ["command", "description", "prompt", "tool_input", "tool_response", "time", "cwd", "token"]) {
    assert.ok(!serialized.includes(key), `ledger state carries no ${key} field`);
  }
});

test("closed kind guard, membership reader, and launch reader stay strict and content-free", () => {
  assert.equal(isNativeClaudeBackgroundKind("shell"), true);
  assert.equal(isNativeClaudeBackgroundKind("task"), true);
  assert.equal(isNativeClaudeBackgroundKind("agent"), false);
  assert.equal(isNativeClaudeBackgroundKind(undefined), false);

  assert.deepEqual(readNativeClaudeBackgroundMembers({
    background_members: [{ id: SHELL_A, kind: "shell" }],
    prompt: "SECRET PROMPT",
  }), [{ id: SHELL_A, kind: "shell" }]);
  assert.deepEqual(readNativeClaudeBackgroundMembers({ background_members: [] }), []);
  // Absent, malformed, duplicated, or over-capacity input is unknown: never a
  // shortened membership view and never a zero.
  assert.equal(readNativeClaudeBackgroundMembers({}), null);
  assert.equal(readNativeClaudeBackgroundMembers(null), null);
  assert.equal(readNativeClaudeBackgroundMembers({ background_members: "[]" }), null);
  assert.equal(readNativeClaudeBackgroundMembers({ background_members: [{ id: SHELL_A }] }), null);
  assert.equal(readNativeClaudeBackgroundMembers({ background_members: [{ id: SHELL_A, kind: "subagent" }] }), null);
  assert.equal(readNativeClaudeBackgroundMembers({
    background_members: [{ id: SHELL_A, kind: "shell" }, { id: SHELL_A, kind: "shell" }],
  }), null);
  assert.equal(readNativeClaudeBackgroundMembers({
    background_members: Array.from({ length: MAX_NATIVE_CLAUDE_BACKGROUND_MEMBERS + 1 }, (_unused, index) => ({
      id: `b${index}`,
      kind: "shell",
    })),
  }), null);
  // A member object carrying extra provider fields is rejected outright.
  assert.equal(readNativeClaudeBackgroundMembers({
    background_members: [{ id: SHELL_A, kind: "shell", command: "SECRET COMMAND" }],
  }), null);

  assert.deepEqual(readNativeClaudeBackgroundLaunch({ background_started: { id: TASK_A, kind: "task" } }),
    { id: TASK_A, kind: "task" });
  assert.equal(readNativeClaudeBackgroundLaunch({}), null);
  assert.equal(readNativeClaudeBackgroundLaunch({ background_started: { id: TASK_A } }), null);
  assert.equal(readNativeClaudeBackgroundLaunch({ background_started: { id: TASK_A, kind: "agent" } }), null);
  assert.equal(readNativeClaudeBackgroundLaunch({ background_started: { id: TASK_A, kind: "task", prompt: "x" } }), null);

  assert.deepEqual(countNativeClaudeBackgroundMembers([
    { id: SHELL_A, kind: "shell" },
    { id: TASK_A, kind: "task" },
    { id: "m11111111", kind: "task" },
  ]), { tasks: 2, shells: 1 });
  assert.deepEqual(countNativeClaudeBackgroundMembers([]), { tasks: 0, shells: 0 });
});
