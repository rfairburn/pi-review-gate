/**
 * Focused tests for the private per-agent lifetime and ownership projection.
 *
 * These pin the IDENTITY/LIFETIME half of the native Claude task count — which
 * agents of one owned run are alive — independently of the membership ledger,
 * which answers a different question (what the provider currently lists as
 * in flight). The ordering here follows the observed native flow: an agent
 * starts, launches one background shell, its model turn ends while that shell is
 * still running (a park, not a death), the shell settles and is routed back to
 * it (a pending wake), the SAME id resumes, its final turn ends owning nothing,
 * and only then does its own completion record close it.
 *
 * Everything is synthetic: no provider, model, transcript, filesystem, or hook
 * lane is involved. Ids are opaque fixtures.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_NATIVE_CLAUDE_AGENT_ENDED_MEMORY,
  NativeClaudeAgentLifetime,
  type NativeClaudeAgentLifetimeState,
} from "../src/session-host/native-claude-agent-lifetime";

const SCOPE = "native-claude-run-test";
const OTHER_SCOPE = "native-claude-run-other";
const AGENT_A = "a1live00001";
const AGENT_D = "a2live00002";
const SHELL_B = "b8k3n1p4q";
const SHELL_C = "b0zzzzzzzz";

/**
 * One source position, used at a single offset throughout most of this file.
 *
 * A window's floor and the completion that closes it sit at the SAME offset here,
 * which is what `>=` admits: those tests are about identity, ownership, and state,
 * and they stay that way. The ordering itself — that a record written before a
 * window opened cannot close it however late it is read — is what the dedicated
 * fence tests below pin with real, distinct offsets.
 */
const M = { sourceToken: "root-src", offset: 0 } as const;

function statesOf(lifetime: NativeClaudeAgentLifetime): Record<string, NativeClaudeAgentLifetimeState> {
  const out: Record<string, NativeClaudeAgentLifetimeState> = {};
  for (const entry of lifetime.snapshot().agents) out[entry.id] = entry.state;
  return out;
}

test("a positive agent start is the counted edge, and a repeat never duplicates it", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  assert.deepEqual(lifetime.liveIds(), []);

  assert.deepEqual(lifetime.observeAgentStart(SCOPE, AGENT_A, M).liveIds, [AGENT_A]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "live" });

  // The same id starting again is one live agent, not two.
  const again = lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  assert.deepEqual(again.liveIds, [AGENT_A]);
  assert.equal(again.reason, "execution-edge");

  // Two distinct agents are two.
  assert.deepEqual(lifetime.observeAgentStart(SCOPE, AGENT_D, M).liveIds, [AGENT_A, AGENT_D]);
});

test("an identity this projection never saw start is never invented", () => {
  const lifetime = new NativeClaudeAgentLifetime();

  // A child tool edge, an ownership edge, a boundary, and a settlement for an
  // unknown identity all attribute to nothing: they establish no agent, and a
  // settlement for an unknown id is not an end either.
  assert.equal(lifetime.observeAgentActivity(SCOPE, AGENT_A, M).reason, "unknown-agent");
  assert.equal(lifetime.observeOwnership(SCOPE, AGENT_A, SHELL_B, M).reason, "unknown-agent");
  assert.equal(lifetime.observeTurnEnd(SCOPE, AGENT_A, []).reason, "unknown-agent");
  assert.equal(lifetime.observeSettled(SCOPE, SHELL_B, M).reason, "no-change");
  assert.deepEqual(lifetime.liveIds(), []);
  assert.deepEqual(lifetime.snapshot().agents, []);

  // An unusable identity is refused on every lane, and never becomes a member.
  // (A single space is a valid opaque id here, exactly as it is for the
  // membership ledger's bounded-text rule; the hook lane's own token reader is
  // what turns an empty or whitespace-only provider field into absence.)
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  for (const bad of ["", "x".repeat(200), "with\nnewline", 7, null, undefined]) {
    assert.equal(lifetime.observeAgentStart(SCOPE, bad, M).reason, "malformed-identity");
    assert.equal(lifetime.observeAgentActivity(SCOPE, bad, M).reason, "malformed-identity");
    assert.equal(lifetime.observeOwnership(SCOPE, AGENT_A, bad, M).reason, "malformed-identity");
    assert.equal(lifetime.observeSettled(SCOPE, bad, M).reason, "malformed-identity");
  }
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
});

test("a turn boundary while owned work runs is a park, and never an end", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  lifetime.observeOwnership(SCOPE, AGENT_A, SHELL_B, M);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "live" });

  // The boundary payload still lists the shell the agent owns: parked.
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A, SHELL_B]);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "parked" });

  // A `pending` owned member — blocked, waiting on the user — is the same park.
  const blocked = new NativeClaudeAgentLifetime();
  blocked.observeAgentStart(SCOPE, AGENT_A, M);
  blocked.observeOwnership(SCOPE, AGENT_A, SHELL_B, M);
  blocked.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A, SHELL_B]);
  assert.deepEqual(blocked.liveIds(), [AGENT_A]);

  // A boundary payload this observer cannot read proves nothing either: no
  // candidate end is claimed from an unreadable array.
  const unreadable = new NativeClaudeAgentLifetime();
  unreadable.observeAgentStart(SCOPE, AGENT_A, M);
  unreadable.observeTurnEnd(SCOPE, AGENT_A, null);
  assert.deepEqual(unreadable.liveIds(), [AGENT_A]);
  assert.deepEqual(statesOf(unreadable), { [AGENT_A]: "parked" });

  // A completion record for the agent with no candidate boundary in its window
  // does not end it either.
  const completionOnly = new NativeClaudeAgentLifetime();
  completionOnly.observeAgentStart(SCOPE, AGENT_A, M);
  completionOnly.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A]);
  const before = completionOnly.liveIds();
  assert.deepEqual(before, [AGENT_A]);
  assert.deepEqual(statesOf(completionOnly), { [AGENT_A]: "ending" });
  completionOnly.observeSettled(SCOPE, SHELL_B, M);
  assert.deepEqual(completionOnly.liveIds(), [AGENT_A], "a stranger's settlement ends nothing");
});

test("an owned settlement turns a park into a pending wake, still counted", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  lifetime.observeOwnership(SCOPE, AGENT_A, SHELL_B, M);
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A, SHELL_B]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "parked" });

  // The shell finishes. The agent is still addressable and about to be woken:
  // this is the interval an in-flight-only census loses it in.
  lifetime.observeSettled(SCOPE, SHELL_B, M);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "pendingWake" });

  // Repeating the settlement changes nothing.
  const repeat = lifetime.observeSettled(SCOPE, SHELL_B, M);
  assert.equal(repeat.changed, false);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
});

test("the actual end needs its boundary and its own completion in the same window", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  lifetime.observeOwnership(SCOPE, AGENT_A, SHELL_B, M);
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A, SHELL_B]);
  lifetime.observeSettled(SCOPE, SHELL_B, M);

  // The resumed turn ends owning nothing: a candidate boundary, still counted.
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "live" });
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A]);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "ending" });

  // The agent's own completion record, in this same window, closes it.
  const ended = lifetime.observeSettled(SCOPE, AGENT_A, M);
  assert.equal(ended.reason, "agent-ended");
  assert.deepEqual(ended.liveIds, []);
  assert.deepEqual(lifetime.snapshot().agents, []);

  // A later settlement for a finished id is inert.
  assert.equal(lifetime.observeSettled(SCOPE, AGENT_A, M).changed, false);
});

test("a candidate boundary with owned work still unsettled never ends the agent", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  lifetime.observeOwnership(SCOPE, AGENT_A, SHELL_B, M);
  lifetime.observeOwnership(SCOPE, AGENT_A, SHELL_C, M);
  // The payload lists one owned shell running and omits the other, which this
  // observer has no positive terminal record for: the agent still owns it, and a
  // snapshot omission is never a settlement.
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A, SHELL_B]);
  lifetime.observeSettled(SCOPE, SHELL_B, M);
  lifetime.observeSettled(SCOPE, AGENT_A, M);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A], "unsettled owned work outvotes the conjunction");
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "parked" });

  // The last owned member settles exactly. This window's boundary was never a
  // candidate (it listed owned work), so nothing ends the agent: its recorded
  // completion is one conjunct with no candidate to pair with.
  lifetime.observeSettled(SCOPE, SHELL_C, M);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "ending" });

  // Its next turn ends owning nothing and its own completion lands in that same
  // window: that is the end.
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A]);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
  assert.equal(lifetime.observeSettled(SCOPE, AGENT_A, M).reason, "agent-ended");
  assert.deepEqual(lifetime.liveIds(), []);
});

test("a newer execution edge supersedes the window its evidence described", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  // Turn one ends owning nothing, and a completion is recorded for it.
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A]);
  lifetime.observeSettled(SCOPE, AGENT_A, M);
  assert.deepEqual(lifetime.liveIds(), []);

  // The SAME id positively resumes: it is counted again, in a fresh window whose
  // own evidence is empty.
  const reopened = lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  assert.equal(reopened.reason, "reopened");
  assert.deepEqual(reopened.liveIds, [AGENT_A]);

  // A child tool edge alone also reopens a closed window.
  const viaActivity = new NativeClaudeAgentLifetime();
  viaActivity.observeAgentStart(SCOPE, AGENT_A, M);
  viaActivity.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A]);
  viaActivity.observeSettled(SCOPE, AGENT_A, M);
  assert.deepEqual(viaActivity.liveIds(), []);
  viaActivity.observeAgentActivity(SCOPE, AGENT_A, M);
  assert.deepEqual(viaActivity.liveIds(), [AGENT_A]);

  // The resumed turn's candidate boundary alone cannot close it: the earlier
  // turn's completion was discarded with its window, so a fresh completion is
  // required.
  viaActivity.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A]);
  assert.deepEqual(viaActivity.liveIds(), [AGENT_A]);
  viaActivity.observeSettled(SCOPE, AGENT_A, M);
  assert.deepEqual(viaActivity.liveIds(), []);
});

test("a completion recorded before the resumed window's boundary cannot close it", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  lifetime.observeOwnership(SCOPE, AGENT_A, SHELL_B, M);
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A, SHELL_B]);
  // Both the owned shell and the agent's own record land while the agent is
  // parked. Neither can end it: the boundary that closed that turn listed owned
  // work, so it was never a candidate.
  lifetime.observeSettled(SCOPE, SHELL_B, M);
  lifetime.observeSettled(SCOPE, AGENT_A, M);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "ending" });

  // The agent resumes. Its new window has no completion of its own, so even a
  // fresh candidate boundary leaves it counted until a record from THIS window
  // arrives.
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A]);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
  lifetime.observeSettled(SCOPE, AGENT_A, M);
  assert.deepEqual(lifetime.liveIds(), []);
});

test("one agent's end never removes another agent or an unrelated member", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  lifetime.observeAgentStart(SCOPE, AGENT_D, M);
  lifetime.observeOwnership(SCOPE, AGENT_D, SHELL_C, M);

  // D's turn ends with its own shell still running: a park. A owns nothing, so
  // the very same session-wide members — D itself and C, neither of which A
  // launched — do not keep A from being a candidate for its own end.
  lifetime.observeTurnEnd(SCOPE, AGENT_D, [AGENT_A, AGENT_D, SHELL_C]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "live", [AGENT_D]: "parked" });
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A, AGENT_D, SHELL_C]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "ending", [AGENT_D]: "parked" });

  // A's own completion closes A and only A.
  const ended = lifetime.observeSettled(SCOPE, AGENT_A, M);
  assert.equal(ended.reason, "agent-ended");
  assert.deepEqual(ended.liveIds, [AGENT_D]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_D]: "parked" });

  // D's end needs D's own evidence, and it lands independently.
  lifetime.observeSettled(SCOPE, SHELL_C, M);
  assert.deepEqual(statesOf(lifetime), { [AGENT_D]: "pendingWake" });
  lifetime.observeAgentStart(SCOPE, AGENT_D, M);
  lifetime.observeTurnEnd(SCOPE, AGENT_D, [AGENT_D]);
  assert.deepEqual(lifetime.liveIds(), [AGENT_D]);
  lifetime.observeSettled(SCOPE, AGENT_D, M);
  assert.deepEqual(lifetime.liveIds(), []);
});

test("a member is attributed to the agent that launched it, and never to another", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  lifetime.observeAgentStart(SCOPE, AGENT_D, M);
  lifetime.observeOwnership(SCOPE, AGENT_A, SHELL_B, M);

  // A's boundary lists B running: A parks. D's boundary lists B too (the array
  // is session-wide), but D never launched it, so D's turn ending is a clean
  // candidate for D and never a park.
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A, AGENT_D, SHELL_B]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "parked", [AGENT_D]: "live" });
  lifetime.observeTurnEnd(SCOPE, AGENT_D, [AGENT_A, AGENT_D, SHELL_B]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "parked", [AGENT_D]: "ending" });

  // B settling is A's wake edge, and nothing for D.
  lifetime.observeSettled(SCOPE, SHELL_B, M);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "pendingWake", [AGENT_D]: "ending" });
});

test("an execution edge re-opens the turn window without duplicating the agent", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "ending" });

  // A further child tool edge is a new execution edge: the candidate boundary
  // goes away, and the agent is live again — still exactly one.
  lifetime.observeAgentActivity(SCOPE, AGENT_A, M);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "live" });

  // Its completion alone cannot end the live turn.
  lifetime.observeSettled(SCOPE, AGENT_A, M);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
});

test("a scope token fences every operation, and a boundary clears the census", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);

  // A foreign scope mutates nothing: a retired run cannot write into a later one
  // and a later run cannot be written by a retired one.
  assert.equal(lifetime.observeAgentStart(OTHER_SCOPE, AGENT_D, M).changed, false);
  assert.equal(lifetime.observeAgentActivity(OTHER_SCOPE, AGENT_A, M).changed, false);
  assert.equal(lifetime.observeOwnership(OTHER_SCOPE, AGENT_A, SHELL_B, M).changed, false);
  assert.equal(lifetime.observeTurnEnd(OTHER_SCOPE, AGENT_A, []).changed, false);
  assert.equal(lifetime.observeSettled(OTHER_SCOPE, AGENT_A, M).changed, false);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
  assert.equal(lifetime.snapshot().scopeToken, SCOPE);

  // A conversation boundary drops every agent fact but keeps the scope bound.
  const cleared = lifetime.clearAgents(SCOPE, "fresh-census");
  assert.equal(cleared.changed, true);
  assert.deepEqual(lifetime.liveIds(), []);
  assert.equal(lifetime.snapshot().scopeToken, SCOPE);
  assert.deepEqual(lifetime.observeAgentStart(SCOPE, AGENT_D, M).liveIds, [AGENT_D]);

  // Retirement unbinds it outright.
  lifetime.retireScope(SCOPE);
  assert.equal(lifetime.snapshot().scopeToken, null);
  assert.deepEqual(lifetime.liveIds(), []);
  assert.equal(lifetime.observeAgentStart(SCOPE, AGENT_A, M).changed, true, "a new scope binds");
});

test("no cap, no timer: every healthy agent of a long run stays counted", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  const ids: string[] = [];
  for (let index = 0; index < 400; index += 1) {
    const id = `a${String(index).padStart(8, "0")}`;
    ids.push(id);
    lifetime.observeAgentStart(SCOPE, id, M);
  }
  assert.equal(lifetime.liveIds().length, 400);

  // Ended ids are the only bounded memory. Filling it evicts finished records,
  // and never a counted one.
  for (const id of ids) {
    lifetime.observeTurnEnd(SCOPE, id, [id]);
    lifetime.observeSettled(SCOPE, id, M);
  }
  assert.deepEqual(lifetime.liveIds(), []);
  lifetime.observeAgentStart(SCOPE, AGENT_A, M);
  for (let index = 0; index < MAX_NATIVE_CLAUDE_AGENT_ENDED_MEMORY + 8; index += 1) {
    const id = `z${String(index).padStart(8, "0")}`;
    lifetime.observeAgentStart(SCOPE, id, M);
    lifetime.observeTurnEnd(SCOPE, id, [id]);
    lifetime.observeSettled(SCOPE, id, M);
  }
  assert.deepEqual(lifetime.liveIds(), [AGENT_A], "the live agent outlived the ended memory");
});

/**
 * The ordering and trust halves of the projection. A completion may only close the
 * execution window that PRODUCED it, and that is decided by position inside one
 * positively identified append-ordered source — never by the order a consumer
 * happened to read records in. Separately, an evidence gap preserves an agent's
 * identity and its counted state but makes it unstateable, so a count is never
 * rebuilt from a lifetime this observer could not watch.
 */

const SRC = { sourceToken: "root-src", offset: 100 } as const;
const LATER = { sourceToken: "root-src", offset: 500 } as const;
const EARLIER = { sourceToken: "root-src", offset: 40 } as const;
const OTHER_FILE = { sourceToken: "replaced-src", offset: 600 } as const;

test("a completion is admitted only by its own position against the window's floor", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, SRC);
  lifetime.observeOwnership(SCOPE, AGENT_A, SHELL_B, SRC);
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A]);
  lifetime.observeSettled(SCOPE, SHELL_B, SRC);

  // A record that starts BEFORE this window opened was produced by an earlier turn,
  // however late it is consumed.
  assert.equal(lifetime.observeSettled(SCOPE, AGENT_A, EARLIER).reason, "no-change");
  assert.deepEqual(lifetime.liveIds(), [AGENT_A], "an unfenceable completion closes nothing");

  // A record at or after the floor belongs to this window.
  assert.equal(lifetime.observeSettled(SCOPE, AGENT_A, LATER).reason, "agent-ended");
  assert.deepEqual(lifetime.liveIds(), []);
});

test("positions from two different sources are never compared", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, SRC);
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A]);
  // A higher offset inside a DIFFERENT file proves nothing about this one: a
  // replacement or a restart is not a later record in the file it replaced.
  assert.equal(lifetime.observeSettled(SCOPE, AGENT_A, OTHER_FILE).reason, "no-change");
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
  assert.equal(lifetime.observeSettled(SCOPE, AGENT_A, LATER).reason, "agent-ended");
});

test("a window this observer could not position is preserved as unresolved, never closed", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, SRC);
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A]);
  // The resumed window arrived with no readable source position: nothing can be
  // ordered against it, so no completion closes it and it is not offered as exact.
  assert.equal(lifetime.observeAgentActivity(SCOPE, AGENT_A, null).reason, "execution-edge");
  assert.equal(lifetime.hasUnresolvedCounted(), true);
  assert.deepEqual(lifetime.liveIds(), []);
  assert.equal(lifetime.observeSettled(SCOPE, AGENT_A, LATER).reason, "no-change");

  // That agent's own next positioned edge makes its lifetime observable again.
  assert.equal(lifetime.observeAgentActivity(SCOPE, AGENT_A, LATER).reason, "execution-edge");
  assert.equal(lifetime.hasUnresolvedCounted(), false);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
});

test("a gap preserves every counted identity and restores only on its own evidence", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, SRC);
  lifetime.observeAgentStart(SCOPE, AGENT_D, SRC);
  assert.deepEqual(lifetime.liveIds(), [AGENT_A, AGENT_D]);

  assert.equal(lifetime.noteCoverageGap(SCOPE, "identity-lane").reason, "coverage-gap");
  // Preserved, counted, and unstateable: a gap is not two deaths and never a zero.
  assert.deepEqual(lifetime.liveIds(), []);
  assert.equal(lifetime.hasUnresolvedCounted(), true);
  assert.deepEqual(
    statesOf(lifetime),
    { [AGENT_A]: "live", [AGENT_D]: "live" },
    "the identities and their states survive the gap intact",
  );

  assert.equal(lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A], SRC).reason, "turn-ended");
  assert.deepEqual(lifetime.liveIds(), [AGENT_A], "only the agent whose own lane resumed is exact");
  assert.equal(lifetime.hasUnresolvedCounted(), true);
});

test("one agent's own lost source never reaches another agent", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, SRC);
  lifetime.observeAgentStart(SCOPE, AGENT_D, SRC);

  assert.equal(lifetime.observeAgentGap(SCOPE, AGENT_A).reason, "coverage-gap");
  assert.deepEqual(lifetime.liveIds(), [AGENT_D]);
  assert.equal(lifetime.hasUnresolvedCounted(), true);

  // An unknown identity has no lane to lose, and a gap never invents one.
  assert.equal(lifetime.observeAgentGap(SCOPE, SHELL_B).reason, "unknown-agent");
  assert.deepEqual(lifetime.liveIds(), [AGENT_D]);
});

/**
 * A gap retires the END EVIDENCE, not just a flag. A boundary witnessed before a
 * hole says nothing about what happened inside it, so a completion read afterwards
 * must not combine with it to close an identity that has not been observed since —
 * that would turn "I stopped watching" into an exact zero. Recovery is a NEW
 * positioned boundary, and only a completion above that boundary's own floor can
 * close it.
 */

function startedWithCleanBoundary(lifetime: NativeClaudeAgentLifetime): void {
  lifetime.observeAgentStart(SCOPE, AGENT_A, SRC);
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A], SRC);
  // A clean boundary alone: counted, one conjunct short.
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
}

for (const kind of ["global", "agent-specific"] as const) {
  test(`a ${kind} gap retires a clean boundary so a later completion cannot close the agent`, () => {
    const lifetime = new NativeClaudeAgentLifetime();
    startedWithCleanBoundary(lifetime);

    if (kind === "global") assert.equal(lifetime.noteCoverageGap(SCOPE, "identity-lane").reason, "coverage-gap");
    else assert.equal(lifetime.observeAgentGap(SCOPE, AGENT_A).reason, "coverage-gap");

    // Preserved and counted, but unstateable.
    assert.equal(lifetime.hasUnresolvedCounted(), true);
    assert.deepEqual(lifetime.liveIds(), []);

    // The completion this window was one conjunct short of. Pre-gap evidence is
    // gone, and an untrusted identity closes on nothing at all.
    assert.equal(lifetime.observeSettled(SCOPE, AGENT_A, LATER).reason, "no-change");
    assert.equal(lifetime.hasUnresolvedCounted(), true, "still preserved, never silently ended");
    assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "live" });

    // Recovery is a fresh boundary at its own position.
    assert.equal(lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A], LATER).reason, "turn-ended");
    assert.equal(lifetime.hasUnresolvedCounted(), false);
    assert.deepEqual(lifetime.liveIds(), [AGENT_A]);

    // A completion below the recovered boundary's floor is not this window's.
    assert.equal(lifetime.observeSettled(SCOPE, AGENT_A, SRC).reason, "no-change");
    assert.deepEqual(lifetime.liveIds(), [AGENT_A]);

    // Above it, it closes.
    assert.equal(lifetime.observeSettled(SCOPE, AGENT_A, { sourceToken: "root-src", offset: 900 }).reason, "agent-ended");
    assert.deepEqual(lifetime.liveIds(), []);
  });
}

test("an unresolved agent is never closed by a member settlement either", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, SRC);
  lifetime.observeOwnership(SCOPE, AGENT_A, SHELL_B, SRC);
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A]);
  assert.equal(lifetime.observeSettled(SCOPE, SHELL_B, SRC).reason, "settled");
  assert.deepEqual(lifetime.liveIds(), [AGENT_A], "a pending wake is still one live agent");

  lifetime.noteCoverageGap(SCOPE, "identity-lane");
  assert.equal(lifetime.hasUnresolvedCounted(), true);

  // A second settlement of the same owned member during the hole must not be read
  // as the agent's own end.
  const outcome = lifetime.observeSettled(SCOPE, SHELL_B, SRC);
  assert.notEqual(outcome.reason, "agent-ended");
  assert.equal(lifetime.hasUnresolvedCounted(), true);
  // `live`, not `pendingWake`: the gap retired the boundary that had shown the
  // park, so this observer no longer knows WHERE in its life this agent is. That
  // is the honest reading of a hole, and it keeps the agent counted either way.
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "live" });
});

test("a member settling late never drags a resumed agent back into a pending wake", () => {
  // Native callback arrival is not provider emission time. An agent can be
  // positively re-started BEFORE the file-derived evidence for a member it owned
  // in the PRIOR window is read. That late settle still settles the member — a
  // member's end is monotone — but it must not be read as anything about the
  // agent's CURRENT window: no state regression, no extra start required, and no
  // unknown.
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, SRC);
  lifetime.observeOwnership(SCOPE, AGENT_A, SHELL_B, SRC);
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A, SHELL_B]);
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "parked" });

  // The same agent is positively re-started while B is still unobserved.
  assert.equal(lifetime.observeAgentStart(SCOPE, AGENT_A, LATER).reason, "execution-edge");
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "live" }, "the current window is live work");

  // B's completion lands now, after that start.
  assert.equal(lifetime.observeSettled(SCOPE, SHELL_B, LATER).reason, "settled");
  assert.deepEqual(lifetime.liveIds(), [AGENT_A], "one agent, still one task");
  assert.deepEqual(statesOf(lifetime), { [AGENT_A]: "live" }, "a late settle never re-parks or re-wakes A");

  // A's own window closes on its own evidence, with no third start.
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A], LATER);
  assert.equal(lifetime.observeSettled(SCOPE, AGENT_A, { sourceToken: "root-src", offset: 900 }).reason, "agent-ended");
  assert.deepEqual(lifetime.liveIds(), []);
});

/**
 * Two uncertainties, two consequences. A KNOWN agent's evidence can go dark while
 * the projection still holds the complete identity set; a hole in the lane that
 * carries `SubagentStart` can hide an identity that was never named at all. The
 * second is not a bigger version of the first: no amount of keying the identities
 * this projection does hold makes the set complete, so the caller must be able to
 * tell them apart.
 */
test("a hole in the identity lane is not attributable to any agent, and nothing unrelated closes it", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, SRC);
  assert.equal(lifetime.identityCoverageIsUncertain(), false, "every identity so far arrived on its own edge");

  // The lane that carries every agent's start edge went dark. An agent may have
  // started and parked inside the hole without ever being named here.
  assert.equal(lifetime.noteCoverageGap(SCOPE, "identity-lane").reason, "coverage-gap");
  assert.equal(lifetime.identityCoverageIsUncertain(), true);

  // A resumed agent says everything about ITSELF and nothing about an identity that
  // was never named: the hole stands after its own edge, and after a complete
  // census-style settle of everything this projection can name.
  assert.equal(lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A], LATER).reason, "turn-ended");
  assert.equal(lifetime.hasUnresolvedCounted(), false, "A's own lifetime is observable again");
  assert.equal(lifetime.identityCoverageIsUncertain(), true, "an unrelated agent's recovery repairs nothing");

  assert.equal(lifetime.observeSettled(SCOPE, AGENT_A, { sourceToken: "root-src", offset: 900 }).reason, "agent-ended");
  assert.deepEqual(lifetime.liveIds(), []);
  assert.equal(lifetime.identityCoverageIsUncertain(), true, "an empty counted set is not proof of none");

  // Retiring the agents this projection still holds is NOT a boundary that starts
  // the census over: a resumed or compacted history replaces the conversation
  // without proving that an agent hidden inside the hole went away, so the hole is
  // carried even though the tracked census is dropped.
  assert.equal(lifetime.clearAgents(SCOPE, "retire").reason, "scope-cleared");
  assert.deepEqual(lifetime.liveIds(), []);
  assert.equal(lifetime.identityCoverageIsUncertain(), true, "a retire carries the hole");
  assert.equal(lifetime.observeAgentActivity(SCOPE, AGENT_A, SRC).reason, "unknown-agent");

  // A boundary that positively states a brand-new conversation began IS one: from
  // here every agent of this run has to arrive on a start edge this projection
  // receives, so the identity hole ends with the conversation it was in.
  assert.equal(lifetime.clearAgents(SCOPE, "fresh-census").reason, "no-change");
  assert.equal(lifetime.identityCoverageIsUncertain(), false);
  assert.equal(lifetime.observeAgentStart(SCOPE, AGENT_A, SRC).reason, "established");
  assert.deepEqual(lifetime.liveIds(), [AGENT_A]);
});

test("a completion-source hole strands ends, never identities", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, SRC);

  // The file an agent's own completion is read from is gone. Identity edges kept
  // arriving on the surviving lane, so the counted set is still the whole set.
  assert.equal(lifetime.noteCoverageGap(SCOPE, "completion-source").reason, "coverage-gap");
  assert.equal(lifetime.hasUnresolvedCounted(), true, "A's own end is now unprovable");
  assert.equal(
    lifetime.identityCoverageIsUncertain(),
    false,
    "no identity could have gone unnamed inside a hole in the other lane",
  );
});

test("one known agent's lost lane is a scoped uncertainty, never an identity hole", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, SRC);
  lifetime.observeAgentStart(SCOPE, AGENT_D, SRC);

  // A's named child transcript was replaced. Both identities are still positively
  // established, so a caller that can key them may still state an exact total.
  assert.equal(lifetime.observeAgentGap(SCOPE, AGENT_A).reason, "coverage-gap");
  assert.equal(lifetime.hasUnresolvedCounted(), true);
  assert.equal(lifetime.identityCoverageIsUncertain(), false);

  // A foreign scope token mutates nothing, and cannot open an identity hole either.
  assert.equal(lifetime.noteCoverageGap(OTHER_SCOPE, "identity-lane").changed, false);
  assert.equal(lifetime.identityCoverageIsUncertain(), false);
});

test("an established end names the identity that ended, and no other", () => {
  const lifetime = new NativeClaudeAgentLifetime();
  lifetime.observeAgentStart(SCOPE, AGENT_A, SRC);
  lifetime.observeAgentStart(SCOPE, AGENT_D, SRC);
  lifetime.observeOwnership(SCOPE, AGENT_D, SHELL_B, SRC);

  // A clean boundary alone is one conjunct short: nothing ended, nothing named.
  lifetime.observeTurnEnd(SCOPE, AGENT_A, [AGENT_A], SRC);
  assert.deepEqual(lifetime.observeSettled(SCOPE, SHELL_C, SRC).endedIds, []);

  // A's own completion closes A — and names A, and only A.
  const closed = lifetime.observeSettled(SCOPE, AGENT_A, { sourceToken: "root-src", offset: 900 });
  assert.equal(closed.reason, "agent-ended");
  assert.deepEqual(closed.endedIds, [AGENT_A]);
  assert.deepEqual(closed.liveIds, [AGENT_D], "D stays counted on its own evidence");

  // A repeat of the same settlement is not a second end.
  assert.deepEqual(lifetime.observeSettled(SCOPE, AGENT_A, { sourceToken: "root-src", offset: 900 }).endedIds, []);

  // Retirement and a scope boundary clear the identity hole outright, so a later
  // run never inherits an uncertainty about a conversation it cannot see.
  const retired = new NativeClaudeAgentLifetime();
  retired.observeAgentStart(SCOPE, AGENT_A, SRC);
  retired.noteCoverageGap(SCOPE, "identity-lane");
  assert.equal(retired.identityCoverageIsUncertain(), true);
  retired.retireScope(SCOPE);
  assert.equal(retired.identityCoverageIsUncertain(), false);
});
