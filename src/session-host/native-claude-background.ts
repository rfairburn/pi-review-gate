/**
 * Bounded per-owned-run native Claude background membership ledger.
 *
 * This module turns positively observed native background edges — a confirmed
 * launch identity, a matching settle, or a complete root `Stop` membership
 * snapshot — into EXACT active task/shell counts for exactly one owned native
 * run. It performs no IO of any kind: no transport, no hook registration, no
 * process, filesystem, transcript, provider, or model work. It keeps only
 * opaque member ids and their closed `task`/`shell` kind — never descriptions,
 * commands, prompts, tool arguments, results, timestamps, or prose.
 *
 * Why a membership ledger instead of a per-event count: a native count that is
 * only ever read at a turn boundary cannot answer "how much background work is
 * running right now". A keyed set does, provided its starting point is known.
 * The owner explicitly authorizes a KNOWN-EMPTY fresh owned-launch baseline
 * (`initializeFreshOwnedRun`): the host spawned this provider child, so no
 * background member of this run can exist before its first launch edge. With
 * that positive starting point, a confirmed launch id and its matching
 * completion id give exact `1 → 0` membership — not merely a floor, and not an
 * `unknown` that only a snapshot could ever clear.
 *
 * What keeps that honest:
 * - `known` is a scope property, never an assumption. Only a fresh owned run, a
 *   complete root membership snapshot, or edges on top of one of those make the
 *   counts exact. A scope merely adopted mid-stream (`adoptRootSession`) tracks
 *   members but publishes nothing, because work may have started before this
 *   observer saw the scope.
 * - Any genuine coverage hole withdraws the counts to `unknown` and demands a
 *   full membership resync: a settle for an id this ledger never observed (its
 *   launch edge was lost), an over-capacity member set, a malformed snapshot, a
 *   caller-reported hook gap, or scope retirement. Withdrawal is never a
 *   fabricated zero and never a stale hold-over.
 * - Normal start/stop edges never make a known scope unknown. Losing the
 *   `known` flag requires evidence that the census has a hole.
 * - Every observation, resync, gap report, and retirement names the scope token
 *   it belongs to, and an operation for any other (or for no) scope mutates
 *   nothing. A retired run A can therefore never write into a later run B, and
 *   a baseline is only ever established on an unbound ledger: re-initializing an
 *   established run is refused, so a late or repeated initialization cannot
 *   fabricate `0`/`0` over live membership. Retiring the previous run is the
 *   explicit lifecycle transition a new baseline requires.
 * - "This id already settled" protection is replayed against every later start
 *   for as long as the ledger still remembers the id. A resync keeps it: ids the
 *   snapshot still lists become active again, ids it drops are remembered as
 *   settled exactly like an explicit settle, and ids it does not mention keep
 *   the protection they already had. A completion that arrives without its
 *   launch is remembered too — the missing edge makes the census unknown, it
 *   does not un-prove that the id finished. That memory is bounded, and the
 *   oldest entry is the first to go. Forgetting an id is not a hole in the census:
 *   the active set is still exactly what the ledger says it is, so a long healthy
 *   run keeps publishing exact counts past the bound. The cost is bounded and
 *   stated plainly — a delayed start for an id this ledger forgot can land as a
 *   member — and a complete root membership snapshot, which states the current
 *   set outright, corrects it. The bound is a memory bound, never a permanent
 *   unknown and never a reason to restart the run.
 * - Only ACTIVE members count. The provider's own snapshot filter admits only a
 *   `running` or `pending` entry that is not explicitly foregrounded, so
 *   completed, failed, and cancelled work reaches this ledger as a settle or as
 *   absence, never as a member. Foreground work is never a member: a
 *   `PreToolUse` `run_in_background` intent, or an agent that ran to completion
 *   in the foreground, produces no edge here.
 * - This ledger claims no ownership. Its counts are native provider
 *   observations, never Pi `backgroundTasks`/`backgroundShells`, never host
 *   background shells or subtasks, and never Stop/idle authority. It has no
 *   stop, kill, or cancel capability and no PID or process-name counting.
 * - A child (`SubagentStop`) snapshot is that hook's own whole array, not proof
 *   of root scope. This ledger cannot tell root from child scope; the caller
 *   must root-fence before calling {@link
 *   NativeClaudeBackgroundLedger.replaceFullRootMembers}.
 *
 * Native identity basis, stated timelessly on purpose (no build, no offsets):
 * the provider keys every background entry in one task-registry namespace — the
 * `backgroundTaskId` a backgrounded Bash command returns, the `agentId` an async
 * agent launch returns, and each member of the root `Stop`/`SubagentStop`
 * `background_tasks` snapshot — so a launch id and a later member id are
 * directly comparable, which is what makes `start → settle` arithmetic legal.
 * In that snapshot only the `shell` type label is a shell; every other live type
 * label is a task. Ids are opaque bounded text: their current shape is neither
 * documented nor enforced here, so a provider id-shape change cannot silently
 * discard genuine membership.
 */

import { isRecord } from "../record-guard";

/** Closed member-kind set: the two count categories this ledger can report. */
export const NATIVE_CLAUDE_BACKGROUND_KINDS = Object.freeze(["task", "shell"] as const);

export type NativeClaudeBackgroundKind = (typeof NATIVE_CLAUDE_BACKGROUND_KINDS)[number];

/** One active native background member: an opaque id and its closed kind. */
export interface NativeClaudeBackgroundMember {
  readonly id: string;
  readonly kind: NativeClaudeBackgroundKind;
}

/** Exact active counts. Only ever produced for a scope with known membership. */
export interface NativeClaudeBackgroundCounts {
  readonly tasks: number;
  readonly shells: number;
}

/**
 * Member bound. Matches the native hook lane's whole-snapshot admission bound,
 * so a snapshot the protocol can carry is one this ledger can hold. Exceeding
 * it is a closed failure that withdraws the counts, never a silent truncation.
 */
export const MAX_NATIVE_CLAUDE_BACKGROUND_MEMBERS = 64;

/**
 * Bound on "this id already settled" memory, so a delayed duplicate start
 * cannot resurrect finished work. It is a memory bound, not a run lifetime quota:
 * at the bound the oldest id is evicted, counts keep publishing, and the outcome
 * names the eviction. Beyond that bound protection is best-effort for the oldest
 * ids, which is the deliberate tradeoff — a complete root membership snapshot
 * re-anchors the whole set, so a wrong count cannot stand past that snapshot.
 */
export const MAX_NATIVE_CLAUDE_BACKGROUND_TOMBSTONES = 1024;

/**
 * Scope-token and member-id text bounds (UTF-8 bytes, no control characters).
 * The id bound is deliberately at least as wide as the native hook lane's own
 * wire bound (`MAX_NATIVE_HOOK_MEMBER_ID_BYTES`), so the ledger can never reject
 * an identity the protocol was willing to deliver.
 */
export const MAX_NATIVE_CLAUDE_BACKGROUND_SCOPE_TOKEN_BYTES = 128;
export const MAX_NATIVE_CLAUDE_BACKGROUND_MEMBER_ID_BYTES = 128;

/** Stable, payload-free reason code for one ledger outcome. */
export type NativeClaudeBackgroundReason =
  | "fresh-owned-run"
  | "root-session-adopted"
  | "duplicate-adopt"
  | "scope-mismatch"
  | "unbound-scope"
  | "scope-bound"
  | "duplicate-init"
  | "launch-observed"
  | "duplicate-start"
  | "late-start-after-settle"
  | "settle-observed"
  | "duplicate-settle"
  | "settle-unobserved"
  | "root-snapshot-applied"
  | "root-snapshot-empty"
  | "capacity"
  | "malformed-scope-token"
  | "malformed-member"
  | "malformed-snapshot"
  | "tombstone-capacity"
  | "coverage-gap";

/**
 * Explicit outcome, so a caller never republishes a stale reading as a fresh
 * observation:
 * - `applied`: membership changed while the set was exactly known, and `counts`
 *   is the new exact value.
 * - `tracked`: membership changed but nothing is publishable yet (a scope
 *   adopted mid-stream, or an edge on such a scope). `counts` is `null`.
 * - `ignored`: nothing was claimed from the input (duplicate edge, foreign or
 *   unbound scope, malformed input). State is unchanged and `counts` is simply
 *   the current reading.
 * - `invalid`: the input showed the census has a hole, so the counts are
 *   withdrawn to `null` (unknown) and a full membership resync is required.
 *   `counts` is always `null`.
 */
export type NativeClaudeBackgroundOutcome =
  | {
      readonly outcome: "applied";
      readonly reason: NativeClaudeBackgroundReason;
      readonly counts: NativeClaudeBackgroundCounts;
    }
  | {
      readonly outcome: "tracked";
      readonly reason: NativeClaudeBackgroundReason;
      readonly counts: null;
    }
  | {
      readonly outcome: "ignored";
      readonly reason: NativeClaudeBackgroundReason;
      readonly counts: NativeClaudeBackgroundCounts | null;
    }
  | {
      readonly outcome: "invalid";
      readonly reason: NativeClaudeBackgroundReason;
      readonly counts: null;
    };

/** Current reading. A complete snapshot: unknown counts are the explicit null. */
export interface NativeClaudeBackgroundSnapshot {
  /** Bound scope token, or null when no owned run/scope is bound. */
  readonly scopeToken: string | null;
  /** True only while the active set is exactly known. Never an assumption. */
  readonly membershipKnown: boolean;
  /** True while a full root membership snapshot is required to recover. */
  readonly needsResync: boolean;
  /** Exact active counts, or null for unknown — never a fabricated 0/0. */
  readonly counts: NativeClaudeBackgroundCounts | null;
  /** Current active members, in insertion order. Never a truncated view. */
  readonly members: readonly NativeClaudeBackgroundMember[];
}

/** True only for a value from the closed kind set. */
export function isNativeClaudeBackgroundKind(value: unknown): value is NativeClaudeBackgroundKind {
  return typeof value === "string"
    && (NATIVE_CLAUDE_BACKGROUND_KINDS as readonly string[]).includes(value);
}

function isBoundedOpaqueText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]/.test(value);
}

/** Validate one opaque member id. */
export function isValidNativeClaudeBackgroundMemberId(value: unknown): value is string {
  return isBoundedOpaqueText(value, MAX_NATIVE_CLAUDE_BACKGROUND_MEMBER_ID_BYTES);
}

const MEMBER_FIELDS: ReadonlySet<string> = new Set(["id", "kind"]);

/** A closed member object carries exactly an id and a kind, nothing else. */
function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/** Validate one caller-owned scope token. */
export function isValidNativeClaudeBackgroundScopeToken(value: unknown): value is string {
  return isBoundedOpaqueText(value, MAX_NATIVE_CLAUDE_BACKGROUND_SCOPE_TOKEN_BYTES);
}

/**
 * Read the closed membership projection off one already-sanitized native hook
 * event. Absent, malformed, over-capacity, or extra-field input is `null`
 * (unknown): this never returns a partial membership view, and it never reads
 * any other event field.
 */
export function readNativeClaudeBackgroundMembers(event: unknown): readonly NativeClaudeBackgroundMember[] | null {
  if (!isRecord(event)) return null;
  const raw = event.background_members;
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > MAX_NATIVE_CLAUDE_BACKGROUND_MEMBERS) return null;
  const members: NativeClaudeBackgroundMember[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, MEMBER_FIELDS)) return null;
    if (!isValidNativeClaudeBackgroundMemberId(entry.id)) return null;
    if (!isNativeClaudeBackgroundKind(entry.kind)) return null;
    if (seen.has(entry.id)) return null;
    seen.add(entry.id);
    members.push({ id: entry.id, kind: entry.kind });
  }
  return members;
}

/**
 * Read the closed positive-launch projection off one already-sanitized native
 * hook event. Absent, malformed, or extra-field input is `null` (unknown): an
 * unusable id never becomes a member, and no other event field is consulted.
 */
export function readNativeClaudeBackgroundLaunch(event: unknown): NativeClaudeBackgroundMember | null {
  if (!isRecord(event)) return null;
  const raw = event.background_started;
  if (raw === undefined) return null;
  if (!isRecord(raw) || !hasOnlyKeys(raw, MEMBER_FIELDS)) return null;
  if (!isValidNativeClaudeBackgroundMemberId(raw.id)) return null;
  if (!isNativeClaudeBackgroundKind(raw.kind)) return null;
  return { id: raw.id, kind: raw.kind };
}

/**
 * Exact active counts for one tracked member set. Membership is only ever
 * counted when the caller has established the set as complete.
 */
export function countNativeClaudeBackgroundMembers(
  members: Iterable<NativeClaudeBackgroundMember>,
): NativeClaudeBackgroundCounts {
  let tasks = 0;
  let shells = 0;
  for (const member of members) {
    if (member.kind === "shell") shells += 1;
    else tasks += 1;
  }
  return { tasks, shells };
}

/**
 * Per-owned-run membership ledger. One instance observes exactly one owned
 * native run; the caller owns scope binding, root-fencing, and publication,
 * and this class owns only the honest arithmetic of what it is handed.
 */
export class NativeClaudeBackgroundLedger {
  /** Bound scope token, or null while no owned run is bound. */
  #scopeToken: string | null = null;
  /** True only while the active set is exactly known (see `membershipKnown`). */
  #known = false;
  /** True while recovery requires a complete root membership snapshot. */
  #needsResync = false;
  /** Active members, keyed by opaque id, in insertion order. */
  #members = new Map<string, NativeClaudeBackgroundMember>();
  /** Recently settled ids, oldest first, so a late start cannot resurrect. */
  #settled: string[] = [];

  /** Current reading as one complete snapshot. */
  snapshot(): NativeClaudeBackgroundSnapshot {
    const members = [...this.#members.values()];
    return {
      scopeToken: this.#scopeToken,
      membershipKnown: this.#known,
      needsResync: this.#needsResync,
      counts: this.#known ? countNativeClaudeBackgroundMembers(members) : null,
      members,
    };
  }

  /** Exact counts for a known scope, or null. Never a fabricated zero. */
  counts(): NativeClaudeBackgroundCounts | null {
    if (!this.#known) return null;
    return countNativeClaudeBackgroundMembers(this.#members.values());
  }

  /**
   * Establish a KNOWN-EMPTY baseline for a fresh owned launch. The host spawned
   * this provider child, so no background member of this run can predate its
   * first launch edge: `0` tasks and `0` shells here is a positively known
   * starting point, not an absence of data.
   *
   * This only ever works on an unbound ledger. The same token again is an
   * idempotent no-op, and a foreign token is refused outright: a late or
   * repeated initialization can never wipe live membership back to `0`/`0`.
   * Starting a genuinely new run requires {@link
   * NativeClaudeBackgroundLedger.retireScope} first, which is the explicit
   * lifecycle transition this contract demands.
   */
  initializeFreshOwnedRun(scopeToken: unknown): NativeClaudeBackgroundOutcome {
    if (!isValidNativeClaudeBackgroundScopeToken(scopeToken)) return this.#ignored("malformed-scope-token");
    if (this.#scopeToken !== null) {
      return this.#ignored(this.#scopeToken === scopeToken ? "duplicate-init" : "scope-bound");
    }
    this.#scopeToken = scopeToken;
    this.#members.clear();
    this.#settled = [];
    this.#known = true;
    this.#needsResync = false;
    return { outcome: "applied", reason: "fresh-owned-run", counts: { tasks: 0, shells: 0 } };
  }

  /**
   * Bind a scope observed mid-stream. This never overwrites an established
   * baseline: an already-bound scope ignores a repeat adopt, and a foreign
   * scope token is refused rather than allowed to reset known membership. The
   * bound scope tracks members but publishes nothing until a complete root
   * snapshot arrives, because work may have started before this observer joined.
   */
  adoptRootSession(scopeToken: unknown): NativeClaudeBackgroundOutcome {
    if (!isValidNativeClaudeBackgroundScopeToken(scopeToken)) return this.#ignored("malformed-scope-token");
    if (this.#scopeToken !== null) {
      if (this.#scopeToken === scopeToken) return this.#ignored("duplicate-adopt");
      return this.#ignored("scope-mismatch");
    }
    this.#scopeToken = scopeToken;
    this.#members.clear();
    this.#settled = [];
    this.#known = false;
    this.#needsResync = true;
    return { outcome: "tracked", reason: "root-session-adopted", counts: null };
  }

  /**
   * Record one positively observed background launch. Only an actual successful
   * launch identity may reach here — never a `PreToolUse` intent and never a
   * foreground agent — and it must name the scope it belongs to. Duplicate ids
   * are idempotent, and an id already settled (by an edge or by a later
   * complete snapshot that no longer lists it) is refused: a delayed edge
   * cannot resurrect finished work.
   */
  observeStarted(scopeToken: unknown, member: unknown): NativeClaudeBackgroundOutcome {
    const refused = this.#fence(scopeToken);
    if (refused !== null) return refused;
    if (!isRecord(member)
      || !isValidNativeClaudeBackgroundMemberId(member.id)
      || !isNativeClaudeBackgroundKind(member.kind)) {
      return this.#ignored("malformed-member");
    }
    const id = member.id;
    if (this.#members.has(id)) return this.#ignored("duplicate-start");
    if (this.#settled.includes(id)) return this.#ignored("late-start-after-settle");
    if (this.#members.size >= MAX_NATIVE_CLAUDE_BACKGROUND_MEMBERS) {
      return this.#withdraw("capacity");
    }
    this.#members.set(id, { id, kind: member.kind });
    if (!this.#known) return { outcome: "tracked", reason: "launch-observed", counts: null };
    return { outcome: "applied", reason: "launch-observed", counts: this.counts() as NativeClaudeBackgroundCounts };
  }

  /**
   * Record one observed settle for a member id. Idempotent for a repeat. A
   * settle for an id this ledger never started and never saw in a complete
   * snapshot is evidence its launch edge was lost, so the census has a hole:
   * the counts withdraw to unknown and a full membership resync is required.
   * That hole does NOT cancel what the completion itself proves: the id
   * finished, so it is remembered under the same bounded, fail-closed replay
   * protection as any other settle before the counts withdraw. Forgetting an old
   * id because the memory is full is NOT that kind of hole: the active set is
   * still exactly known, so the counts stay exact and the outcome only names the
   * eviction. A delayed start for an evicted id can therefore land as a member,
   * and the next complete root membership snapshot corrects it — the bounded
   * memory never turns into a permanent ceiling or a demand to restart the run.
   */
  observeSettled(scopeToken: unknown, id: unknown): NativeClaudeBackgroundOutcome {
    const refused = this.#fence(scopeToken);
    if (refused !== null) return refused;
    if (!isValidNativeClaudeBackgroundMemberId(id)) return this.#ignored("malformed-member");
    if (!this.#members.has(id)) {
      if (this.#settled.includes(id)) return this.#ignored("duplicate-settle");
      // Reversed delivery: the completion arrived without its launch. Withdraw
      // the census, but never discard the finished-work evidence — an
      // unremembered id here is exactly the resurrection the contract forbids.
      this.#rememberSettled(id);
      return this.#withdraw("settle-unobserved");
    }
    this.#members.delete(id);
    // The settle was positively observed, so the member leaves the active set and
    // the census stays exactly known. Remembering it may evict the oldest id; that
    // costs one id's late-edge protection, not the census, so the outcome names it
    // and the counts stay published.
    const evicted = this.#rememberSettled(id);
    if (!this.#known) return { outcome: "tracked", reason: "settle-observed", counts: null };
    return {
      outcome: "applied",
      reason: evicted ? "tombstone-capacity" : "settle-observed",
      counts: this.counts() as NativeClaudeBackgroundCounts,
    };
  }

  /**
   * Replace the whole active set from one validated complete root membership
   * snapshot. This is the resync path: it establishes exact counts (including a
   * real `0`/`0` empty snapshot), clears the resync requirement, and outranks
   * this ledger's own settle memory for the ids it lists, because the provider
   * states the current set outright. It does NOT erase replay protection:
   * members the snapshot drops are remembered as settled, and ids already
   * remembered stay remembered unless the snapshot positively reactivates them,
   * within the memory's bound, which keeps the freshest ids. That is why a
   * complete snapshot is also the recovery from a memory-bound withdrawal: the
   * provider states the whole current set, so exact counts — including a real
   * empty set — come back without a new run. A malformed snapshot is a hole, so
   * it withdraws the counts instead of being accepted as empty.
   *
   * The caller must root-fence: a child-scope snapshot must never be passed
   * here as root state.
   */
  replaceFullRootMembers(scopeToken: unknown, members: unknown): NativeClaudeBackgroundOutcome {
    const refused = this.#fence(scopeToken);
    if (refused !== null) return refused;
    const parsed = readNativeClaudeBackgroundMembers({ background_members: members });
    if (parsed === null) return this.#withdraw("malformed-snapshot");
    const present = new Set(parsed.map((member) => member.id));
    // Members the snapshot no longer lists settled somewhere since the last
    // complete observation, so they earn the same delayed-edge protection.
    const dropped = [...this.#members.keys()].filter((id) => !present.has(id));
    const remembered = this.#settled.filter((id) => !present.has(id));
    // The memory stays bounded, and the freshest entries are the ones kept: the
    // ids just dropped are the most recently active, and a replay of an older
    // evicted id is exactly what the next complete snapshot corrects. Refusing
    // the resync here would strand a healthy run in `unknown` for good.
    const kept = [...remembered, ...dropped];
    this.#settled = kept.length > MAX_NATIVE_CLAUDE_BACKGROUND_TOMBSTONES
      ? kept.slice(kept.length - MAX_NATIVE_CLAUDE_BACKGROUND_TOMBSTONES)
      : kept;
    this.#members.clear();
    for (const member of parsed) this.#members.set(member.id, member);
    this.#known = true;
    this.#needsResync = false;
    const counts = countNativeClaudeBackgroundMembers(this.#members.values());
    return {
      outcome: "applied",
      reason: parsed.length === 0 ? "root-snapshot-empty" : "root-snapshot-applied",
      counts,
    };
  }

  /**
   * Withdraw the counts for a genuine observation hole: a confirmed hook-stream
   * gap, a lost relay, a retired child, or caller-side invalidation. Members are
   * retained only as internal context; nothing is relabeled zero, and a full
   * root membership snapshot is required before counts publish again.
   */
  noteCoverageGap(scopeToken: unknown): NativeClaudeBackgroundOutcome {
    const refused = this.#fence(scopeToken);
    if (refused !== null) return refused;
    return this.#withdraw("coverage-gap");
  }

  /**
   * Release the scope entirely (owned run ended or was replaced) and return the
   * post-retirement snapshot. Only the bound scope's own token retires it, so a
   * stale token from another run cannot tear down live state. Nothing is
   * carried into a later run: a new owned launch must state its own baseline.
   */
  retireScope(scopeToken: unknown): NativeClaudeBackgroundSnapshot {
    if (!isValidNativeClaudeBackgroundScopeToken(scopeToken)) return this.snapshot();
    if (this.#scopeToken === null || this.#scopeToken !== scopeToken) return this.snapshot();
    this.#scopeToken = null;
    this.#members.clear();
    this.#settled = [];
    this.#known = false;
    this.#needsResync = false;
    return this.snapshot();
  }

  // --- internals -----------------------------------------------------------

  /**
   * Reject anything that does not name the currently bound scope. Returns the
   * refusal outcome, or null when the operation may proceed.
   */
  #fence(scopeToken: unknown): NativeClaudeBackgroundOutcome | null {
    if (!isValidNativeClaudeBackgroundScopeToken(scopeToken)) return this.#ignored("malformed-scope-token");
    if (this.#scopeToken === null) return this.#ignored("unbound-scope");
    if (this.#scopeToken !== scopeToken) return this.#ignored("scope-mismatch");
    return null;
  }

  #withdraw(reason: NativeClaudeBackgroundReason): NativeClaudeBackgroundOutcome {
    this.#known = false;
    this.#needsResync = true;
    return { outcome: "invalid", reason, counts: null };
  }

  /**
   * Remember one settled id under the bounded replay memory, and report whether
   * holding it cost an older id's protection. The oldest id leaves first: it is
   * the least likely to be replayed, and the next complete root membership
   * snapshot re-anchors the census whatever a replayed evicted id does.
   */
  #rememberSettled(id: string): boolean {
    const overflowed = this.#settled.length >= MAX_NATIVE_CLAUDE_BACKGROUND_TOMBSTONES;
    if (overflowed) this.#settled.shift();
    this.#settled.push(id);
    return overflowed;
  }

  #ignored(reason: NativeClaudeBackgroundReason): NativeClaudeBackgroundOutcome {
    return { outcome: "ignored", reason, counts: this.counts() };
  }
}
