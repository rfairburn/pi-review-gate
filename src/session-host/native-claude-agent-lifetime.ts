/**
 * Private per-agent lifetime and ownership projection for ONE owned native
 * Claude run (native Claude sidebar status source phase).
 *
 * Why this exists next to the membership ledger instead of inside it: the
 * provider's `background_tasks` array — on `Stop` and on `SubagentStop` alike —
 * is an IN-FLIGHT census. Claude Code 2.1.325 emits only entries whose status is
 * `running` or `pending`, and an agent whose own model turn has ended while it
 * still owns background work is simply not in it. The ledger therefore answers
 * "what is in flight" exactly, and it must keep doing that. What it cannot
 * answer is "which agents of this run are still alive", because a live Claude
 * agent is not the same thing as an in-flight array member: an agent that has
 * parked waiting on work it owns, an agent whose owned work has just settled and
 * is about to wake it, and an agent whose final turn has ended but whose own
 * completion has not been accounted for yet are all LIVE, and all absent from
 * every in-flight snapshot.
 *
 * So this projection owns the identity/lifetime question and nothing else. An
 * agent enters the counted set on its first positive execution edge and leaves it
 * ONLY on a positively established actual end. Nothing else removes it: not a
 * turn boundary, not a snapshot that stops listing it, not the interval between
 * its owned work settling and its execution resuming. Inside the window the
 * sub-state is diagnostic and never changes whether it is counted.
 *
 * The actual end is a conjunction, scoped to ONE execution window, and every
 * conjunct is a positive native edge rather than an absence:
 * - the agent's turn ended at a boundary whose own payload showed it owned
 *   NOTHING still running or pending. The boundary payload lists the ending
 *   agent itself as `running`; that self-membership is the provider serializing
 *   the boundary from inside the turn and is NOT pending work — and members
 *   owned by other agents or by the root are irrelevant, because the array is
 *   session-wide and an agent's end has never required the rest of the session
 *   to be empty.
 * - the agent's OWN completion was recorded as terminal in the same window.
 * A newer positive execution edge supersedes the window: its candidate boundary
 * and its completion evidence are discarded and a fresh window opens, so a
 * completion belonging to an earlier turn can never close a later one, and an id
 * whose window had closed is counted again when it positively resumes.
 *
 * What this projection deliberately does NOT do:
 * - It claims no end from an agent's turn boundary alone. A turn that ends while
 *   the agent still owns running or pending work is a PARK, not a death, and a
 *   genuinely blocking question or a `pending` owned member keeps the agent live.
 * - It claims no end from a completion record alone, and never treats a
 *   historical completed record as alive: only an execution edge creates an
 *   agent, and retention of finished work is not liveness.
 * - It requires no delivery to the root, no empty session-wide snapshot, and no
 *   "everything else settled" condition. Those happened to be visible in one
 *   observed trace; they are not what an agent's end means, and a root question
 *   can delay a delivery while other work settles.
 * - It performs no IO and holds no path, command, prompt, description, output,
 *   status text, or timestamp. Ids are the provider's opaque task-registry keys,
 *   validated with the same bound the membership ledger and the hook lane use, so
 *   one identity cannot be admitted here and rejected there.
 * - It has no cap on how many healthy agents a run may have, and no timer, quiet
 *   interval, or debounce. The only bound is on how long ENDED ids stay
 *   remembered, which costs a long-forgotten id its reopen path; it never caps,
 *   truncates, or hides a live agent.
 * - It is display evidence only. It grants no Stop, kill, cancel, or ownership
 *   authority anywhere, and it never reports a Pi/host background task.
 *
 * Scope discipline mirrors the ledger's: every operation names the caller's
 * scope token, an operation for any other (or for no) scope mutates nothing, and
 * a scope boundary clears the census outright rather than carrying agents across
 * a conversation this observer cannot see through.
 */

/**
 * Two different uncertainties live in this projection, and they do not license
 * the same conclusions:
 *
 * - A KNOWN agent's lifetime crosses a gap ({@link
 *   NativeClaudeAgentLifetime.observeAgentGap}): the identity is positively
 *   established, only its state is unobservable. A caller that can positively key
 *   that identity in a fresh exact census counts it through that membership and
 *   still states an exact total.
 * - The projection's own identity lane has a hole no agent can be attributed to
 *   ({@link NativeClaudeAgentLifetime.noteCoverageGap} with the `identity-lane`
 *   width): the edge that MAKES an identity known went unobserved, so an agent
 *   this projection has never heard of may exist right now — parked, and absent
 *   from every in-flight snapshot by design. Keying every identity this projection
 *   DOES hold is then not completeness, and no total over them is defensible.
 *   {@link NativeClaudeAgentLifetime.identityCoverageIsUncertain} states that
 *   second condition, and nothing short of a boundary that starts this run's agent
 *   census from its beginning ({@link NativeClaudeAgentLifetime.clearAgents} with
 *   the `fresh-census` boundary, or {@link NativeClaudeAgentLifetime.retireScope})
 *   restores it: a keyed or empty snapshot, an agent's own resumed edge, a boundary
 *   that only retires the agents it still holds, and any unrelated transition all
 *   say nothing about an identity that was never named.
 */

import {
  isValidNativeClaudeBackgroundMemberId,
  isValidNativeClaudeBackgroundScopeToken,
} from "./native-claude-background";

/**
 * One position in one append-ordered source file.
 *
 * This is the only ordering fact this projection is allowed to use, and it is
 * deliberately not a clock: `sourceToken` names the exact bound file the position
 * belongs to (a replacement, a truncation-and-restart, or a different file is a
 * different token, and positions from two tokens are never compared), while
 * `offset` is where a record starts inside that file. Append order inside one
 * positively identified file is a producer fact; the moment a consumer happened
 * to read a record is not, and this projection refuses to confuse the two.
 */
export interface NativeClaudeAgentLifetimeMark {
  readonly sourceToken: string;
  readonly offset: number;
}

/**
 * Diagnostic sub-state of one counted agent. Every value here is COUNTED; the
 * state exists so a caller (and a focused test) can see which part of the
 * lifetime the evidence supports, and it never changes a count by itself.
 *
 * - `live` — an execution edge is newer than this window's turn boundary.
 * - `parked` — the turn ended while the agent still owns running/pending work,
 *   or its boundary payload carried no readable membership array, which this
 *   projection treats as "may still own something": no candidate end is claimed
 *   from evidence it cannot read.
 * - `pendingWake` — the turn ended, what it owned has since settled, and
 *   execution has not resumed yet. This is the interval an in-flight-only census
 *   loses the agent in; it is a counted state, never a gap.
 * - `ending` — the turn ended owning nothing, and one (not both) of the actual
 *   end's own-window conjuncts has been witnessed.
 */
export type NativeClaudeAgentLifetimeState = "live" | "parked" | "pendingWake" | "ending";

/** One counted agent with the sub-state its evidence currently supports. */
export interface NativeClaudeAgentLifetimeEntry {
  readonly id: string;
  readonly state: NativeClaudeAgentLifetimeState;
}

/** The complete reading. Unknown is the ABSENCE of an entry, never a `0`. */
export interface NativeClaudeAgentLifetimeSnapshot {
  readonly scopeToken: string | null;
  readonly agents: readonly NativeClaudeAgentLifetimeEntry[];
}

/** Stable, payload-free reason code for one projection outcome. */
export type NativeClaudeAgentLifetimeReason =
  /** A new identity entered the counted set. */
  | "established"
  /** An id whose window had closed was positively resumed and counts again. */
  | "reopened"
  /** A further execution edge for an already counted id. */
  | "execution-edge"
  /** A known agent positively launched background work. */
  | "ownership-observed"
  /** A turn boundary with nothing owned still in flight: a candidate end. */
  | "turn-ended"
  /** A turn boundary with owned work still running or pending: a park. */
  | "parked"
  /** An owned member or the agent's own completion was recorded terminal. */
  | "settled"
  /** The actual-end conjunction completed and the id stopped being counted. */
  | "agent-ended"
  /** Every counted identity was marked uncertain by a loss of evidence. */
  | "coverage-gap"
  /** The edge named an identity this projection has never seen start. */
  | "unknown-agent"
  /** The edge carried an unusable identity. */
  | "malformed-identity"
  /** Nothing this projection tracks moved. */
  | "no-change"
  /** Every agent fact was cleared at a scope boundary. */
  | "scope-cleared";

/**
 * Explicit outcome for every operation. `changed` is the only thing a caller
 * needs to know about publication; `liveIds` is the whole current counted set,
 * so a caller never has to reconstruct it from a delta.
 */
export interface NativeClaudeAgentLifetimeOutcome {
  readonly changed: boolean;
  readonly reason: NativeClaudeAgentLifetimeReason;
  readonly liveIds: readonly string[];
  /**
   * The identities whose ACTUAL end this very operation established, in the order
   * they closed; empty for every operation that closed no window. A caller that
   * owns a per-child claim (a child's own evidence gap, say) needs the identity
   * that ended, not a diff of the counted set: an id can leave the exact-census
   * publication for reasons that are not its end, and an end must never be
   * inferred from an absence.
   */
  readonly endedIds: readonly string[];
}

/**
 * How many ENDED ids stay remembered, oldest evicted first. This is a memory
 * bound on finished work only: it never bounds, ranks, or drops a counted agent,
 * and losing an ended id to it costs only that id's reopen path — a later edge
 * for an unremembered id establishes nothing, which is the same inert outcome the
 * projection already produces for an identity it has never seen.
 */
export const MAX_NATIVE_CLAUDE_AGENT_ENDED_MEMORY = 1024;

/**
 * Which of this projection's two sources of evidence a whole-projection hole
 * covers. The widths differ in what they can hide, so the caller states one.
 *
 * - `identity-lane` — the lane that carries every agent's identity edge (the
 *   provider's `SubagentStart`) went unobservable. An agent may have started and
 *   parked inside the hole without this projection ever learning it existed.
 * - `completion-source` — only the file an agent's own terminal completion is
 *   read from was lost. Identity edges still arrive on the surviving lane, so
 *   every identity this run holds is still the whole set it holds; what is
 *   stranded is each counted agent's own end.
 */
export type NativeClaudeAgentLifetimeGapWidth = "identity-lane" | "completion-source";

/**
 * What a scope boundary means for the projection's identity coverage. Retiring the
 * agents it still holds and restoring the certainty that the set is COMPLETE are
 * different facts, and only one of them is entailed by a boundary.
 *
 * - `retire` — a boundary this observer cannot see through (a conversation ended,
 *   a rebound transcript, a source it describes as a resumed or compacted history).
 *   The tracked agents belong to the conversation being replaced and are dropped,
 *   but an agent that was hidden inside an earlier hole is no more accounted for
 *   here than it was before: the gap is CARRIED.
 * - `fresh-census` — a boundary that positively states a brand-new conversation
 *   began (the provider's own `startup`/`clear`). Every agent of what follows has
 *   to arrive on a start edge this projection actually receives, so the identity
 *   hole ends with the conversation it belonged to.
 */
export type NativeClaudeAgentLifetimeBoundary = "retire" | "fresh-census";

/** No operation closed a window, so no identity ended. */
const NO_ENDED_IDS: readonly string[] = Object.freeze([]);

/** One agent's tracked lifetime. Internal; never handed out. */
interface AgentRecord {
  readonly id: string;
  /** True while this id is inside its counting window. */
  counted: boolean;
  /** Execution-window generation. Bumped by every positive execution edge. */
  window: number;
  /** True once this window's turn boundary has been witnessed. */
  turnEnded: boolean;
  /**
   * True when this window's boundary payload carried no readable membership
   * array, so this observer cannot show the agent owned nothing. It is reported
   * as still potentially owning work and no candidate end is claimed.
   */
  boundaryUnreadable: boolean;
  /**
   * Sequence of this window's candidate actual-end boundary, or 0 when this
   * window has none. Reset when a newer execution edge opens a new window.
   */
  boundarySeq: number;
  /**
   * Sequence of this window's own terminal completion record, or 0 when none has
   * been seen. Reset with the window, which is what stops an earlier turn's
   * completion from closing a resumed one.
   */
  completionSeq: number;
  /** A member this agent positively launched and has not seen settle. */
  readonly owned: Set<string>;
  /**
   * Byte offset the bound source had when this window opened, or null when this
   * observer could not positively size it. A completion may only close a window
   * when its own record starts at or after this position inside the SAME source:
   * a record already written when the window opened was produced by an earlier
   * turn, however late it was read.
   */
  windowFloor: NativeClaudeAgentLifetimeMark | null;
  /**
   * False while this agent's lifetime crosses an evidence gap this observer cannot
   * see through. Its identity and counted state are PRESERVED — a gap is not a
   * death — but it is not offered as part of an exact live census, so the count
   * publishes unknown instead of a number a lost transition could contradict.
   */
  trusted: boolean;
}

/**
 * Per-owned-run agent lifetime projection. One instance observes exactly one
 * owned native run; the caller owns scope binding, the root/child fence, and
 * publication, and this class owns only which agent identities are alive.
 */
export class NativeClaudeAgentLifetime {
  #scopeToken: string | null = null;
  /** Monotonic arrival sequence. Orders evidence WITHIN this projection only. */
  #seq = 0;
  readonly #agents = new Map<string, AgentRecord>();
  /** Ended ids, oldest first, bounded: the reopen memory. */
  #ended: string[] = [];
  /**
   * True while a hole this projection cannot attribute to ANY identity stands:
   * the lane that carries `SubagentStart` — the one edge that makes an agent
   * known — went unobservable, so an agent may exist that this projection has
   * never heard of. A per-agent gap never sets it (that agent is known); nothing
   * but a boundary that starts the run's agent census over clears it.
   */
  #unattributableIdentityGap = false;

  /**
   * The counted set this projection may publish as exact, in first-seen order.
   * Empty means positively none. An agent whose lifetime crosses an evidence gap
   * is deliberately absent here while it stays counted — see
   * {@link NativeClaudeAgentLifetime.hasUnresolvedCounted} — because a gap is not
   * a death and must not silently shrink the census either.
   */
  liveIds(): readonly string[] {
    const ids: string[] = [];
    for (const record of this.#agents.values()) {
      if (record.counted && record.trusted) ids.push(record.id);
    }
    return ids;
  }

  /**
   * True while at least one counted agent's lifetime crosses a gap this observer
   * cannot see through. Its identity and its counted state are preserved, but no
   * exact live census can be stated until that agent's own evidence resumes, so
   * the caller must publish unknown for that axis rather than a number a lost
   * transition could contradict.
   */
  hasUnresolvedCounted(): boolean {
    for (const record of this.#agents.values()) {
      if (record.counted && !record.trusted) return true;
    }
    return false;
  }

  /**
   * True while an agent this projection has NEVER seen may exist: the hole in the
   * identity lane cannot be attributed to any counted agent, so the counted set is
   * not the whole agent set and no total over it is defensible. This is deliberately
   * independent of {@link hasUnresolvedCounted}: a known agent whose own evidence
   * resumed says nothing about an identity that was never named, so a keyed or
   * empty in-flight snapshot, an agent's own edge, every unrelated transition, and
   * even a retirement that merely drops the agents this projection still holds all
   * leave this true. Only {@link clearAgents} with the `fresh-census` boundary — a
   * boundary that positively states a brand-new conversation began, whose agents
   * must each arrive on a start edge this projection receives — and
   * {@link retireScope} clear it.
   */
  identityCoverageIsUncertain(): boolean {
    return this.#unattributableIdentityGap;
  }

  /**
   * Mark every currently counted agent's lifetime uncertain: a loss of the hook
   * lane or of the source an agent's completion is read from. Nothing here ends
   * or forgets an agent — the identities and their counted state survive the gap —
   * and each one is restored by its OWN next positive edge.
   *
   * `width` says what this caller actually lost, because the two losses hide
   * different things. An `identity-lane` hole additionally makes this projection's
   * own agent set incomplete ({@link identityCoverageIsUncertain}): the caller
   * cannot show it saw a start edge that arrived during the hole. A
   * `completion-source` hole strands each counted agent's END and nothing else —
   * identity edges kept arriving on the surviving lane — so it leaves the counted
   * set complete and never widens the uncertainty past the agents already known.
   */
  noteCoverageGap(
    scopeToken: unknown,
    width: NativeClaudeAgentLifetimeGapWidth,
  ): NativeClaudeAgentLifetimeOutcome {
    const refused = this.#fence(scopeToken);
    if (refused !== null) return refused;
    // The hole is a fact about the projection's coverage whether or not a counted
    // agent's state moved: with nothing counted yet, an agent can still have
    // started inside the hole unseen.
    if (width === "identity-lane") this.#unattributableIdentityGap = true;
    let changed = false;
    for (const record of this.#agents.values()) {
      if (!record.counted || !record.trusted) continue;
      // Not just a flag: the window's candidate boundary and completion evidence
      // are retired with the certainty that supported them. A boundary witnessed
      // BEFORE the hole says nothing about what happened DURING it, and leaving it
      // in place would let a completion read afterwards combine with pre-gap
      // evidence to close an identity that has not been observed since.
      this.#openWindow(record, null);
      changed = true;
    }
    return this.#outcome(changed, changed ? "coverage-gap" : "no-change");
  }

  /**
   * Mark ONE counted agent's lifetime uncertain: the evidence that speaks for that
   * agent and no other — its own named child transcript — was lost, replaced, or
   * truncated. Other agents keep their standing, and this agent keeps its identity
   * and its counted state; only its eligibility to be published as part of an exact
   * live census goes, until its own evidence resumes.
   *
   * This is a KNOWN agent's scoped uncertainty and stays that: the identity is
   * positively established, so it never widens into
   * {@link identityCoverageIsUncertain}. A caller that can positively key this id in
   * a fresh exact census may therefore still state an exact total over the agents it
   * holds.
   */
  observeAgentGap(scopeToken: unknown, agentId: unknown): NativeClaudeAgentLifetimeOutcome {
    const refused = this.#fence(scopeToken);
    if (refused !== null) return refused;
    const record = this.#known(agentId);
    if (record === null) return this.#outcome(false, "unknown-agent");
    if (!record.counted || !record.trusted) return this.#outcome(false, "no-change");
    this.#openWindow(record, null);
    return this.#outcome(true, "coverage-gap");
  }

  /** True when this identity is one this projection has positively seen start. */
  knowsAgent(id: unknown): boolean {
    return typeof id === "string" && this.#agents.has(id);
  }

  /** The complete reading, ids and diagnostic states only. */
  snapshot(): NativeClaudeAgentLifetimeSnapshot {
    const agents: NativeClaudeAgentLifetimeEntry[] = [];
    for (const record of this.#agents.values()) {
      if (!record.counted) continue;
      agents.push({ id: record.id, state: this.#stateOf(record) });
    }
    return { scopeToken: this.#scopeToken, agents };
  }

  /**
   * Record the ONE edge that establishes an agent identity for this run: the
   * provider's own `SubagentStart` naming it. This is what makes the identity
   * known, and it is the only edge that creates a record.
   *
   * A repeat for a counted agent is a fresh execution edge in the same window; an
   * edge for an id whose window had closed reopens it and counts it again.
   *
   * `mark` is the bound source's position at the instant this edge arrived, and it
   * becomes the new window's floor. Without it this observer cannot order a
   * completion against this window at all, so the agent is preserved but reported
   * as unresolved rather than closed on evidence it cannot place.
   */
  observeAgentStart(
    scopeToken: unknown,
    agentId: unknown,
    mark: NativeClaudeAgentLifetimeMark | null,
  ): NativeClaudeAgentLifetimeOutcome {
    return this.#edge(scopeToken, agentId, true, mark);
  }

  /**
   * Record an execution edge for an agent this projection already knows: a
   * child-scoped `PreToolUse`/`PostToolUse`, or a child-scoped launch result.
   *
   * An identity this projection has never seen start is NOT admitted: the edge
   * attributes to no agent of this run, so it establishes nothing and changes
   * nothing. The agent's own start edge is what makes it known, and while it runs
   * the provider's own in-flight census still lists it.
   *
   * A positive edge for a known identity is also what restores an agent whose
   * lifetime was left uncertain by a gap: the caller is now seeing that agent's
   * own lane again.
   */
  observeAgentActivity(
    scopeToken: unknown,
    agentId: unknown,
    mark: NativeClaudeAgentLifetimeMark | null,
  ): NativeClaudeAgentLifetimeOutcome {
    return this.#edge(scopeToken, agentId, false, mark);
  }

  /**
   * Record that a known agent positively launched background work. This is
   * simultaneously an execution edge (the launch result IS the agent's own tool
   * edge) and the only way ownership enters this projection.
   */
  observeOwnership(
    scopeToken: unknown,
    agentId: unknown,
    memberId: unknown,
    mark: NativeClaudeAgentLifetimeMark | null,
  ): NativeClaudeAgentLifetimeOutcome {
    const refused = this.#fence(scopeToken);
    if (refused !== null) return refused;
    if (!isValidNativeClaudeBackgroundMemberId(memberId)) return this.#outcome(false, "malformed-identity");
    const record = this.#known(agentId);
    if (record === null) return this.#outcome(false, "unknown-agent");
    this.#openWindow(record, mark);
    if (record.owned.has(memberId)) return this.#outcome(false, "no-change");
    record.owned.add(memberId);
    return this.#outcome(true, "ownership-observed");
  }

  /**
   * Record one `SubagentStop` boundary for a known agent, together with what the
   * boundary payload itself listed as running or pending.
   *
   * `inFlight` is that payload's member ids. `null` means the payload carried no
   * readable membership array: this observer cannot tell whether the agent owned
   * anything, so no candidate end is claimed and the agent stays counted.
   *
   * The boundary agent's OWN id inside `inFlight` is the provider serializing the
   * boundary from within the turn; it is excluded here exactly as the contract
   * excludes it, and it is never treated as pending work. Members this agent does
   * not own are irrelevant to its end.
   *
   * `mark` is this boundary's own position in the bound source. It is what lets an
   * identity a gap left unresolved restart its evidence HERE, on a floor this
   * observer actually holds, rather than inheriting a boundary and a floor
   * witnessed before the hole.
   */
  observeTurnEnd(
    scopeToken: unknown,
    agentId: unknown,
    inFlight: readonly string[] | null,
    mark: NativeClaudeAgentLifetimeMark | null = null,
  ): NativeClaudeAgentLifetimeOutcome {
    const refused = this.#fence(scopeToken);
    if (refused !== null) return refused;
    const record = this.#known(agentId);
    if (record === null) return this.#outcome(false, "unknown-agent");
    // The boundary is that agent's own lane speaking again, so it is what restores
    // an identity a gap had left uncertain — but recovery starts at THIS boundary's
    // own position. An identity left unresolved by a gap, or a window that never
    // got a floor, cannot inherit pre-gap boundary and completion evidence: that
    // evidence describes a turn this observer can no longer place. A clean window
    // that already has its floor keeps its evidence, since a boundary is not newer
    // execution work.
    if (!record.trusted || record.windowFloor === null) this.#openWindow(record, mark);
    record.turnEnded = true;
    record.boundaryUnreadable = inFlight === null;
    const stillOwned = inFlight === null
      // An unreadable payload cannot show that the agent owned nothing, so it
      // cannot stand as a candidate end either.
      ? true
      : [...record.owned].some((id) => inFlight.includes(id));
    record.boundarySeq = stillOwned ? 0 : ++this.#seq;
    return this.#outcome(true, stillOwned ? "parked" : "turn-ended");
  }

  /**
   * Record one positively read terminal settlement for a member id.
   *
   * For a member an agent owns, that is the edge that turns a park into a
   * pending wake: the owned work ended, the agent is still addressable, and it
   * stays counted until its own end is established. Whether that record was read
   * early or late changes nothing about it, so no position is required here.
   *
   * For the agent's OWN id, `mark` is mandatory and the admission is fenced:
   * the record may only close the window it can be PROVEN to belong to, which is
   * the one whose floor sits at or before this record's own start inside the same
   * positively identified source. A completion written before a resumed window
   * opened was produced by an earlier turn however late it is consumed, so
   * consumption time is never treated as emission time, and an unfenceable record
   * closes nothing.
   */
  observeSettled(
    scopeToken: unknown,
    memberId: unknown,
    mark: NativeClaudeAgentLifetimeMark | null,
  ): NativeClaudeAgentLifetimeOutcome {
    const refused = this.#fence(scopeToken);
    if (refused !== null) return refused;
    if (!isValidNativeClaudeBackgroundMemberId(memberId)) return this.#outcome(false, "malformed-identity");
    let changed = false;
    const ended: string[] = [];
    const own = this.#agents.get(memberId);
    if (own !== undefined && own.counted && own.completionSeq === 0 && this.#admitsCompletion(own, mark)) {
      own.completionSeq = ++this.#seq;
      changed = true;
      this.#closeIfEnded(own, ended);
    }
    for (const record of this.#agents.values()) {
      if (!record.counted || record.id === memberId) continue;
      if (!record.owned.delete(memberId)) continue;
      changed = true;
      this.#closeIfEnded(record, ended);
    }
    if (!changed) return this.#outcome(false, "no-change");
    return this.#outcome(true, ended.length > 0 ? "agent-ended" : "settled", ended);
  }

  /**
   * Clear every agent fact at a scope boundary this observer cannot see through
   * (a new conversation, a rebound transcript, a session end). The scope token
   * stays bound so this run can establish new identities; nothing carries across.
   *
   * `boundary` states what this boundary proves about IDENTITY coverage, which is a
   * separate question from which agents it retires. A `retire` boundary drops the
   * tracked agents and CARRIES an unattributable identity hole: replacing the
   * agents this projection holds says nothing about an agent it never learned
   * existed, and a resumed or compacted history is exactly such a boundary. Only a
   * `fresh-census` boundary — one that positively states a brand-new conversation
   * began — ends the hole, because from there on every agent of this run has to
   * arrive on a start edge this projection actually receives.
   */
  clearAgents(
    scopeToken: unknown,
    boundary: NativeClaudeAgentLifetimeBoundary,
  ): NativeClaudeAgentLifetimeOutcome {
    const refused = this.#fence(scopeToken);
    if (refused !== null) return refused;
    const had = this.#agents.size > 0;
    this.#agents.clear();
    this.#ended = [];
    if (boundary === "fresh-census") {
      // A positively new conversation: its agent census starts here, and every
      // agent in it is named by a start edge this projection receives from now on.
      this.#unattributableIdentityGap = false;
    }
    return this.#outcome(had, had ? "scope-cleared" : "no-change");
  }

  /**
   * Release the scope entirely. Nothing is carried into a later run — including
   * the identity hole, which belongs to the run being released: a later run binds a
   * different scope and every agent in it arrives on a start edge this projection
   * receives under that scope.
   */
  retireScope(scopeToken: unknown): void {
    if (!isValidNativeClaudeBackgroundScopeToken(scopeToken)) return;
    if (this.#scopeToken !== scopeToken) return;
    this.#scopeToken = null;
    this.#agents.clear();
    this.#ended = [];
    this.#unattributableIdentityGap = false;
  }

  // --- internals -----------------------------------------------------------

  /**
   * Bind on first use; refuse anything that does not name this run's scope. A
   * foreign token mutates nothing, so a retired run can never write into a later
   * one and a later run can never be written by a retired one.
   */
  #fence(scopeToken: unknown): NativeClaudeAgentLifetimeOutcome | null {
    if (!isValidNativeClaudeBackgroundScopeToken(scopeToken)) return this.#refused();
    if (this.#scopeToken === null) this.#scopeToken = scopeToken;
    else if (this.#scopeToken !== scopeToken) return this.#refused();
    return null;
  }

  #refused(): NativeClaudeAgentLifetimeOutcome {
    return { changed: false, reason: "no-change", liveIds: this.liveIds(), endedIds: NO_ENDED_IDS };
  }

  /** Look up a KNOWN identity, refusing to invent one. */
  #known(agentId: unknown): AgentRecord | null {
    if (typeof agentId !== "string" || !isValidNativeClaudeBackgroundMemberId(agentId)) return null;
    return this.#agents.get(agentId) ?? null;
  }

  /**
   * Apply one positive execution edge. `canEstablish` is true only for the
   * provider's own agent-start edge; every other edge requires an identity this
   * projection already knows.
   */
  #edge(
    scopeToken: unknown,
    agentId: unknown,
    canEstablish: boolean,
    mark: NativeClaudeAgentLifetimeMark | null,
  ): NativeClaudeAgentLifetimeOutcome {
    const refused = this.#fence(scopeToken);
    if (refused !== null) return refused;
    if (!isValidNativeClaudeBackgroundMemberId(agentId)) return this.#outcome(false, "malformed-identity");
    const id = agentId;
    const existing = this.#agents.get(id);
    if (existing === undefined) {
      if (!canEstablish) return this.#outcome(false, "unknown-agent");
      this.#agents.set(id, {
        id,
        counted: true,
        window: 1,
        turnEnded: false,
        boundaryUnreadable: false,
        boundarySeq: 0,
        completionSeq: 0,
        owned: new Set(),
        windowFloor: mark,
        trusted: mark !== null,
      });
      return this.#outcome(true, "established");
    }
    if (!existing.counted) {
      // A positively observed resumption of an id whose window had closed is
      // counted again; the closed window's evidence is already gone.
      this.#dropEnded(id);
      this.#openWindow(existing, mark);
      existing.counted = true;
      return this.#outcome(true, "reopened");
    }
    this.#openWindow(existing, mark);
    return this.#outcome(true, "execution-edge");
  }

  /**
   * Open (or re-open) one execution window: the previous window's candidate
   * boundary and completion evidence are discarded, because a newer execution edge
   * has superseded the turn they described. The new window's floor is the source
   * position of THIS edge, so only records written after it can describe it.
   *
   * A positive edge is also that agent's own lane speaking again, so it restores an
   * identity a gap had left uncertain — but only when the edge itself could be
   * placed in the source. An edge this observer cannot position reopens the window
   * and leaves it unresolved rather than pretending the ordering problem went away.
   */
  #openWindow(record: AgentRecord, mark: NativeClaudeAgentLifetimeMark | null): void {
    record.window += 1;
    record.turnEnded = false;
    record.boundaryUnreadable = false;
    record.boundarySeq = 0;
    record.completionSeq = 0;
    record.windowFloor = mark;
    record.trusted = mark !== null;
  }

  /**
   * True when a completion record can be PROVEN to belong to this window: both
   * positions come from one positively identified append-ordered source, and the
   * record starts at or after the position that source had when the window opened.
   * Anything else — no window floor, no record position, or a source whose identity
   * changed in between — admits nothing, because an end this observer cannot place
   * in order is an end it has not established.
   */
  #admitsCompletion(record: AgentRecord, mark: NativeClaudeAgentLifetimeMark | null): boolean {
    const floor = record.windowFloor;
    if (floor === null || mark === null) return false;
    if (mark.sourceToken !== floor.sourceToken) return false;
    return mark.offset >= floor.offset;
  }

  /**
   * Close the window when its own end conjunction is complete, and name the id to
   * the caller's `ended` collection when it does: an established end is a fact
   * some callers may act on, and only on THAT identity.
   */
  #closeIfEnded(record: AgentRecord, ended: string[]): boolean {
    // An identity across an evidence gap is preserved and counted, never closed: its
    // own end is a claim this observer can no longer support, and an exact zero
    // would be a count the gap could contradict.
    if (!record.counted || !record.trusted) return false;
    if (!record.turnEnded) return false;
    if (record.owned.size > 0) return false;
    if (record.boundarySeq === 0 || record.completionSeq === 0) return false;
    record.counted = false;
    record.owned.clear();
    ended.push(record.id);
    this.#ended.push(record.id);
    while (this.#ended.length > MAX_NATIVE_CLAUDE_AGENT_ENDED_MEMORY) {
      const evicted = this.#ended.shift();
      if (evicted === undefined) break;
      const stale = this.#agents.get(evicted);
      if (stale !== undefined && !stale.counted) {
        this.#agents.delete(evicted);
        break;
      }
    }
    return true;
  }

  #dropEnded(id: string): void {
    const at = this.#ended.indexOf(id);
    if (at >= 0) this.#ended.splice(at, 1);
  }

  #stateOf(record: AgentRecord): NativeClaudeAgentLifetimeState {
    if (!record.turnEnded) return "live";
    if (record.owned.size > 0 || record.boundaryUnreadable) return "parked";
    if (record.boundarySeq > 0 || record.completionSeq > 0) return "ending";
    return "pendingWake";
  }

  #outcome(
    changed: boolean,
    reason: NativeClaudeAgentLifetimeReason,
    endedIds: readonly string[] = NO_ENDED_IDS,
  ): NativeClaudeAgentLifetimeOutcome {
    return { changed, reason, liveIds: this.liveIds(), endedIds };
  }
}
