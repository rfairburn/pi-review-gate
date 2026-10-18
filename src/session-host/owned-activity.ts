/**
 * Opt-in process-local owned background-work registry (native session cards).
 *
 * The authenticated session-host status companion publishes bounded
 * `backgroundTasks` / `backgroundShells` counts from the actual lifecycle
 * telemetry of work this native process owns. That telemetry is not derivable
 * from a single tracker:
 *
 * - background shell jobs (`src/background-shell`) live in a module-private
 *   map that `reapAll()` clears BEFORE the owned child's asynchronous close
 *   callback fires, and removed jobs' later settlement is deliberately not
 *   republished as a lifecycle event;
 * - execution tasks (`src/execution/background-controller`) are indexed by an
 *   in-memory active-task map that `detach()` clears, while aborted or
 *   unrecovered runtimes/operations may still be settling;
 * - the automatic review gate (`src/activation/review-turn`) mirrors a single
 *   runtime boolean.
 *
 * This module is the small, pure, process-local meeting point for those
 * sources. It owns no IO, timers, processes, or native APIs. Sources register
 * an INCARNATION-SCOPED handle and publish POSITIVE ownership tokens through
 * it; a token is released only when the underlying owned work is actually
 * settled. Readers (the reporter) subscribe for event-driven snapshots.
 *
 * Two independent channels are published from the same incarnations:
 *
 * - the OWNERSHIP channel (`backgroundTasks` / `backgroundShells`) answers
 *   "does this process still own unsettled background work?" It retains
 *   tokens for cleanup/recovery anchors and is the conservative gate the
 *   idle-stop confirmation and shutdown preflight must read;
 * - the ACTIVITY-INTENT channel (`activeTasks` / `activeShells`) answers
 *   "is background work admitted or running right now?" It is acquired when
 *   work is admitted/starting and released as soon as the work is observed
 *   stopped, independently of any retained ownership. It never fabricates a
 *   cleanup obligation, and a settled stop releases it even while ownership
 *   stays positive.
 *
 * The two channels have SEPARATE completeness flags: cleanup ownership
 * uncertainty must not by itself keep activity positive or unknown once
 * activity is positively known stopped, and a genuinely unobserved activity
 * set stays unknown rather than being reported as zero.
 *
 * They also have SEPARATE GENERATION FENCES. A fresh activity read is committed
 * only while the exact incarnation's own intent-generation fence still holds,
 * so an ownership-only event (admitting or releasing a cleanup anchor, or
 * ownership uncertainty being raised/cleared) can never discard an
 * authoritative, fresher intent read merely because cleanup accounting moved.
 * Actual intent mutations, source readiness/retirement/re-registration, and
 * fresh intent commits/invalidations advance that fence. The common revision
 * still advances on EVERY same-incarnation mutation and remains the fence for
 * ownership accounting and retired reconciliation, so a reload-durable record
 * written before the intent fence existed (whose older closures can only
 * advance the common revision) keeps fail-closed fencing.

 * Safety contract (fail closed):
 *
 * - The registry is INERT until the reporter opts in with a valid
 *   authenticated bootstrap (`activateOwnedActivity`). Before that, every
 *   mutation is a no-op, no listener exists, `ownedActivitySnapshot()` returns
 *   unknown, and ordinary standalone runs observe no behavioural change.
 * - Counts are published per category only when EVERY expected source has a
 *   current (non-retired) incarnation AND no retained incarnation of that
 *   source is uncertain. A missing, failed, or uncertain source is UNKNOWN
 *   (null), never zero; a superseded incarnation's missing associations are not
 *   accounted for by a newer one.
 * - A category is zero only when all expected sources are current, none is
 *   uncertain, and every owned token has been released by its actual
 *   settlement. Cleared tracking maps, reaped jobs, and detached controllers
 *   never imply zero.
 * - Every registration is an incarnation with its own token set and
 *   uncertainty flag, and handles can only mutate their own incarnation. A
 *   stale handle from an older session/reload can therefore never release or
 *   resolve a newer incarnation's ownership (nor clear its own uncertainty from
 *   a newer handle). Tokens AND uncertainty of retired incarnations are retained
 *   until that exact incarnation releases them or its optional event-driven proof
 *   callback establishes a complete channel-specific census. A newer empty
 *   source can never resolve another incarnation's ownership or activity.
 * - Explicit activity refreshes are FORCED FRESH passes: each current
 *   incarnation is asked to prove its own current inventory even when registry
 *   or source telemetry claims a known value, so a poisoned or obsolete
 *   ephemeral mirror is repairable from the real owning source. A complete
 *   result replaces only that incarnation's derived intent tokens; a genuine
 *   fresh failure invalidates only its derived activity channel to unknown
 *   (never a cached known value presented as freshly confirmed); a read
 *   superseded by a newer same-incarnation observation is discarded. Ownership
 *   tokens, ownership uncertainty, and durable records are never touched, and
 *   an already-resolved retired observation remains its own proof. A record whose
 *   DERIVED intent cache was lost (its `intentTokens` Set deleted) is rebuilt
 *   from a fresh complete read of its own authoritative refresher — a lost
 *   ephemeral cache is not a statement about owned work; only a record with no
 *   authoritative callback stays intent-unknown. In-flight
 *   reads are tracked per candidate: a pending read whose fence moved never
 *   blocks settled outcomes or a fresh request, and a forced refresh completes
 *   one bounded fresh pass when a current source could not be established. The
 *   read phase is additionally bounded by ONE finite pass deadline (no polling,
 *   no retry loop): a source that never answers has only its ephemeral read lease
 *   released, its channel truthfully becomes unknown, and the caller's already
 *   queued/new fresh pass re-reads the same owner; a late answer never commits.
 * - Registrations made before opt-in are replayed as uncertain: lifecycle
 *   acquisitions before activation were never observed, so an empty replay
 *   cannot establish an empty owned set. The source must authoritatively resolve
 *   it (for example after its own restore/resync).
 * - The snapshot is process-local and reload-durable: the state object is
 *   stored on a `globalThis` symbol, so a reporter reload (same native
 *   process) observes the same registrations, outstanding tokens, and any
 *   exact-incarnation read-only census callback. The wire
 *   generation/sequence fences remain owned by the reporter and protocol.
 * - Tokens are opaque bounded strings that never carry labels, commands,
 *   paths, arguments, or transcripts; only their positive count is exposed.
 * - A throwing listener is contained; observation failures can never break a
 *   job, task, review, or native call.
 */

import { randomUUID } from "node:crypto";
import { isRecord } from "../record-guard";

/** The two independently tracked categories published on the status frame. */
export type OwnedActivityCategory = "backgroundTasks" | "backgroundShells";

/**
 * The independent activity-intent snapshot. A positive value counts admitted
 * or currently running work; null is UNKNOWN, never zero. This channel is
 * separate from {@link OwnedActivitySnapshot}: a task that stopped but still
 * owns cleanup artifacts reads zero here while its ownership count stays
 * positive.
 */
export interface ActiveActivitySnapshot {
  /**
   * Logical execution tasks admitted/queued or actively capturing, running,
   * reviewing, accepted, waiting to land, or landing, plus any in-flight
   * force-merge. Accepted continuations count in their queued/active state;
   * admission validation and cleanup-only anchors are not activity.
   */
  readonly activeTasks: number | null;
  /** Owned background shell jobs whose process work is starting or running. */
  readonly activeShells: number | null;
}

/** Bounded nullable counts; null always means UNKNOWN, never zero. */
export interface OwnedActivitySnapshot {
  /**
   * Logical owned work units: active/queued execution tasks plus active
   * top-level automatic reviews, and any unsettled owned task runtime or
   * unverified operation association. This is a count of owned work, not of
   * PIDs or processes; a single task may own several processes.
   */
  readonly backgroundTasks: number | null;
  /**
   * Owned background shell jobs whose public ChildProcess close/exit handling
   * has not yet confirmed settlement.
   */
  readonly backgroundShells: number | null;
}

/**
 * An incarnation-scoped registration. Only its own tokens/uncertainty are
 * mutable through it; a stale handle cannot affect a newer incarnation.
 */
export interface OwnedActivitySourceHandle {
  readonly category: OwnedActivityCategory;
  readonly source: string;
  /** Opaque identity of this registration; the stale-source generation fence. */
  readonly incarnation: string;
  /** True once a newer registration for the same source superseded this one. */
  readonly retired: boolean;
  /** Start owning one positive token (scoped to this incarnation). */
  acquire(token: string): void;
  /** Release one token after its actual settlement (scoped to this incarnation). */
  release(token: string): void;
  /** Sticky uncertainty for THIS incarnation only. */
  markUncertain(): void;
  /** Authoritative re-establishment for THIS incarnation only. */
  resolveUncertainty(): void;
  /** Start reporting one positive activity-intent token (scoped to this incarnation). */
  acquireIntent(token: string): void;
  /** Stop reporting one activity-intent token (scoped to this incarnation). */
  releaseIntent(token: string): void;
  /** Sticky ACTIVITY-INTENT uncertainty for THIS incarnation only. */
  markIntentUncertain(): void;
  /** Authoritative activity-intent re-establishment for THIS incarnation only. */
  resolveIntentUncertainty(): void;
  /** Observe a source readiness/lifecycle change; invalidate pending intent reads. */
  requestIntentRefresh(): void;
  /** Supersede this incarnation explicitly (tokens stay owned). */
  retire(): void;
}

/** Opaque positive tokens retained by one exact source incarnation. */
export interface RetiredOwnedActivityTokens {
  readonly ownership: readonly string[];
  /** Undefined only for a legacy pre-intent registry entry. */
  readonly intent: readonly string[] | undefined;
}

/** One independently complete or incomplete, read-only census channel. */
export type RetiredOwnedActivityChannel =
  | {
    /** True only when the callback accounted for the complete exact inventory. */
    readonly complete: true;
    /** All tokens that remain owned after the census. */
    readonly tokens: readonly string[];
    /** Existing tokens removed only with channel-specific validated proof. */
    readonly released: readonly string[];
  }
  | {
    /** This channel could not be completely established; retained tokens stay untouched. */
    readonly complete: false;
  };

/** Exact outcome for a census invalidated by its source/controller revision fence. */
export const RETIRED_ACTIVITY_CENSUS_DISCARDED: unique symbol = Symbol.for(
  "pi-review-gate.session-host.owned-activity.retired-census-discarded.v1",
) as never;

/** Result returned by a retired source's asynchronous, read-only census. */
export type RetiredOwnedActivityReconciliation =
  | {
    /** Missing or incomplete channels remain unknown; the other channel is independent. */
    readonly ownership?: RetiredOwnedActivityChannel;
    readonly intent?: RetiredOwnedActivityChannel;
  }
  | typeof RETIRED_ACTIVITY_CENSUS_DISCARDED;

/** Reload-durable callback for one source incarnation's retired census. */
export type RetiredOwnedActivityReconciler = (
  retained: RetiredOwnedActivityTokens,
) => Promise<RetiredOwnedActivityReconciliation>;

/**
 * Complete, verified exact current activity intent tokens from one owning
 * source's own authoritative state, or incomplete when the source cannot yet
 * prove its full inventory. A complete result replaces the registry's stored
 * tokens for that exact incarnation and clears its intent uncertainty; an
 * incomplete result (or a throw) leaves the count unknown — never zero.
 */
export type OwnedActivityIntentRefresh =
  | {
      readonly status: "complete";
      readonly intentTokens: ReadonlySet<string>;
      /**
       * Owning-source freshness predicate, evaluated again immediately before
       * application: source-local changes (controller generation, session cwd,
       * readiness) after the read make the result stale even when no registry
       * mutation happened. A throwing or false fence rejects the result.
       */
      readonly isCurrent?: () => boolean;
    }
  | {
      readonly status: "incomplete";
    };

/** Authoritative activity refresher for one source incarnation. */
export type OwnedActivityIntentRefresher = () => Promise<OwnedActivityIntentRefresh> | OwnedActivityIntentRefresh;

/** Registration options for one source incarnation. */
export interface OwnedActivitySourceOptions {
  /**
   * Initial completeness state. True for a source whose owned set is not yet
   * authoritatively accounted for (for example work still being restored).
   */
  uncertain?: boolean;
  /**
   * Independent initial completeness state for the activity-intent channel.
   * True while the source's admitted/running set is not yet authoritatively
   * accounted for (for example during a restore).
   */
  intentUncertain?: boolean;
  /**
   * Re-acquire the tokens of still-unsettled work when this registration lands
   * after activity. It must never release tokens, because only an actual
   * settlement event may do that.
   */
  resync?: () => void;
  /** Optional read-only census for this exact source after it is retired. */
  reconcileRetired?: RetiredOwnedActivityReconciler;
  /**
   * Optional authoritative activity refresher for this exact incarnation. It
   * must derive the complete exact token set from this source's own canonical
   * inventory on every invocation (never from a cached mirror or a telemetry
   * boolean), and report incomplete when it genuinely cannot establish it.
   *
   * The registry invokes it from two distinct passes, both applying results
   * through the same commit-time fences as ordinary mutations: the automatic
   * coalesced pass while this incarnation's activity is uncertain, and the
   * explicit forced fresh pass (session_start / safe reconnect / reload) for
   * every current incarnation regardless of any known/unknown claim.
   */
  refreshActivity?: OwnedActivityIntentRefresher;
}

/** Process-local registry state, stored on this symbol and shared across reloads. */
export const OWNED_ACTIVITY_STATE_KEY = Symbol.for("pi-review-gate.session-host.owned-activity.v1");

/**
 * The host subsystems that can own background work in this process. A category
 * stays unknown until every one of its sources has a current incarnation; this
 * is the completeness signal, so an absent or failed source can never read as
 * zero.
 */
const EXPECTED_SOURCES: Readonly<Record<OwnedActivityCategory, readonly string[]>> = Object.freeze({
  backgroundTasks: Object.freeze(["execution", "review"]),
  backgroundShells: Object.freeze(["background-shell"]),
});

/** Maximum length of an accepted source name or ownership token (opaque ids). */
const MAX_OWNED_TOKEN_LENGTH = 192;

interface SourceIncarnation {
  id: string;
  /** Positive ownership tokens whose actual settlement has not been observed. */
  tokens: Set<string>;
  /** Sticky for this incarnation: ownership is not accounted for. */
  uncertain: boolean;
  /** True once a newer incarnation of the same source superseded this one. */
  retired: boolean;
  /**
   * Positive activity-intent tokens. Undefined only for a pre-intent global
   * record written by an earlier code incarnation; such an incarnation's
   * activity set was never observed and stays unknown (it never weakens the
   * ownership channel).
   */
  intentTokens?: Set<string>;
  /** Sticky activity-intent uncertainty; undefined for a pre-intent record. */
  intentUncertain?: boolean;
  /** Optional reload-durable census closure retained with this source. */
  reconcileRetired?: RetiredOwnedActivityReconciler;
  /** Authoritative activity refresher retained with this source incarnation. */
  refreshActivity?: OwnedActivityIntentRefresher;
  /** Legacy field retained for reload compatibility; it does not gate retries. */
  reconciliationAttempted?: boolean;
  /** True only while this exact incarnation's retired census is in flight. */
  reconciliationInFlight?: boolean;
  /**
   * Changed on any same-incarnation mutation; fences stale async ownership
   * accounting, retired reconciliation, and legacy intent reads.
   */
  revision?: number;
  /**
   * Independent generation fence for the activity-intent channel. It advances
   * only for intent-generational events: an actual intent acquire/release, an
   * intent uncertainty/invalidation or fresh intent commit, a source readiness
   * observation, or retirement/(re)registration. Undefined only for a record
   * written by an earlier code incarnation that predates this fence: such a
   * record's closures can only advance {@link revision}, so intent reads for it
   * stay fenced by that common revision (fail closed) instead of by a field it
   * could never advance.
   */
  intentRevision?: number;
  /**
   * Generation of AUTHORITATIVE intent-value observations for this incarnation:
   * a real intent acquire/release, an intent uncertainty raise/clear, a fresh
   * intent commit/invalidation, or an intent-channel retired-census application.
   * Readiness, registration, and retirement do NOT advance it. It is not a value
   * mirror (no token/fingerprint is stored): it only lets a discarded fresh read
   * distinguish "a newer authoritative intent value superseded this read, keep
   * it" from "a non-authoritative generation change invalidated the only fresh
   * proof, so fall back to truthful unknown". Undefined for pre-fence records.
   */
  intentAuthorityRevision?: number;
}

interface RegistryState {
  active: boolean;
  sources: Map<OwnedActivityCategory, Map<string, SourceIncarnation[]>>;
  listeners: Set<() => void>;
}

interface PendingRegistration {
  handle: OwnedActivitySourceHandle;
  options: OwnedActivitySourceOptions | undefined;
}

/**
 * Registrations made before the reporter opted in, held per module copy in its
 * own memory (not on `globalThis`): nothing is observed and no global container
 * is created until a valid authenticated bootstrap activates the registry. In
 * the shipped host the reporter activates before the review gate (and its
 * sources) loads, so registrations land directly.
 */
const pendingRegistrations: PendingRegistration[] = [];

function isCategory(value: unknown): value is OwnedActivityCategory {
  return value === "backgroundTasks" || value === "backgroundShells";
}

function isExpectedSource(category: OwnedActivityCategory, source: unknown): source is string {
  return typeof source === "string" && EXPECTED_SOURCES[category].includes(source);
}

function isValidToken(token: unknown): token is string {
  return typeof token === "string" && token.length > 0 && token.length <= MAX_OWNED_TOKEN_LENGTH;
}

/** Normalize only a real owned count; anything else is unknown (null), never zero. */
function normalizeOwnedCount(value: number): number {
  return value === 0 ? 0 : value; // normalizes -0
}

function isRegistryState(value: unknown): value is RegistryState {
  try {
    if (!isRecord(value) || typeof value.active !== "boolean"
      || !(value.sources instanceof Map) || !(value.listeners instanceof Set)) return false;
    for (const [category, bySource] of value.sources) {
      if (!isCategory(category) || !(bySource instanceof Map)) return false;
      for (const [source, list] of bySource) {
        if (!isExpectedSource(category, source) || !Array.isArray(list)) return false;
        for (const entry of list) {
          if (!isRecord(entry) || !isValidToken(entry.id) || !(entry.tokens instanceof Set)
            || typeof entry.uncertain !== "boolean" || typeof entry.retired !== "boolean"
            || !Number.isSafeInteger(entry.tokens.size) || entry.tokens.size < 0) return false;
          // Old global records predate the activity-intent channel: their
          // absence is accepted (activity unknown) so ownership stays usable.
          if (entry.intentTokens !== undefined
            && (!(entry.intentTokens instanceof Set)
              || !Number.isSafeInteger(entry.intentTokens.size) || entry.intentTokens.size < 0)) return false;
          if (entry.intentUncertain !== undefined && typeof entry.intentUncertain !== "boolean") return false;
          if (entry.reconcileRetired !== undefined && typeof entry.reconcileRetired !== "function") return false;
          if (entry.refreshActivity !== undefined && typeof entry.refreshActivity !== "function") return false;
          if (entry.reconciliationAttempted !== undefined && typeof entry.reconciliationAttempted !== "boolean") return false;
          if (entry.reconciliationInFlight !== undefined && typeof entry.reconciliationInFlight !== "boolean") return false;
          if (entry.revision !== undefined && (typeof entry.revision !== "number"
            || !Number.isSafeInteger(entry.revision) || entry.revision < 0)) return false;
          // Pre-fence records predate the independent intent generation: their
          // absence is accepted and their intent reads fall back to `revision`.
          if (entry.intentRevision !== undefined && (typeof entry.intentRevision !== "number"
            || !Number.isSafeInteger(entry.intentRevision) || entry.intentRevision < 0)) return false;
          if (entry.intentAuthorityRevision !== undefined
            && (typeof entry.intentAuthorityRevision !== "number"
              || !Number.isSafeInteger(entry.intentAuthorityRevision) || entry.intentAuthorityRevision < 0)) return false;
        }
      }
    }
    return true;
  } catch {
    return false; // Foreign/corrupt observation state must never break real work.
  }
}

/** Reads (and optionally creates) the process-local state without any IO. */
function registryState(create: boolean): RegistryState | undefined {
  try {
    const storage = globalThis as Record<PropertyKey, unknown>;
    const existing = storage[OWNED_ACTIVITY_STATE_KEY];
    if (isRegistryState(existing)) return existing;
    if (!create || existing !== undefined) return undefined; // foreign/corrupt: never overwrite
    const state: RegistryState = { active: false, sources: new Map(), listeners: new Set() };
    storage[OWNED_ACTIVITY_STATE_KEY] = state;
    return state;
  } catch {
    return undefined; // Accessor/property failures remain unknown and untouched.
  }
}

function sourceIncarnations(
  state: RegistryState,
  category: OwnedActivityCategory,
  source: string,
): SourceIncarnation[] | undefined {
  return state.sources.get(category)?.get(source);
}

function findIncarnation(
  state: RegistryState,
  category: OwnedActivityCategory,
  source: string,
  incarnation: string,
): SourceIncarnation | undefined {
  return sourceIncarnations(state, category, source)?.find((entry) => entry.id === incarnation);
}

function notify(state: RegistryState): void {
  for (const listener of [...state.listeners]) {
    try {
      listener();
    } catch {
      // A reader failure is contained: telemetry never breaks owned work.
    }
  }
}

/**
 * The activity-intent generation fence for one exact incarnation. New records
 * carry their own `intentRevision`, advanced only by intent-generational events.
 * A record written before that field existed cannot be advanced by its older
 * closures, so its intent reads stay fenced by the common revision: every
 * same-incarnation mutation (ownership-only included) invalidates them, and a
 * discarded fresh read is then reported as truthful unknown rather than
 * certifying a cached value.
 */
function intentGenerationFence(entry: SourceIncarnation): number {
  return entry.intentRevision ?? entry.revision ?? 0;
}

/**
 * Advance the independent intent generation of a NEW record. Never initialize
 * the field on an existing pre-fence record: an older module copy's closures
 * advance only `revision`, so a lazily added field would silently stop fencing
 * their mutations and let a stale read look current.
 */
function bumpIntentGeneration(entry: SourceIncarnation): void {
  if (entry.intentRevision !== undefined) entry.intentRevision += 1;
}

/**
 * Record one AUTHORITATIVE intent-value observation (never readiness, never
 * registration/retirement, never an ownership-only event). Pre-fence records have
 * no such generation and keep their common-revision fail-closed handling.
 */
function bumpIntentAuthority(entry: SourceIncarnation): void {
  if (entry.intentAuthorityRevision !== undefined) entry.intentAuthorityRevision += 1;
}

/** Bumped whenever an intent-uncertain cause is added; fences stale reschedules. */
let intentUncertainSeq = 0;
let intentRefreshScheduled = false;
let intentRefreshPassesRun = 0;

/**
 * Conservative finite READ/PASS deadline for one authoritative intent read.
 *
 * This is ordinary bounded bookkeeping, not polling and not a retry loop: ONE
 * deadline per pass. A source that never answers has only its EPHEMERAL read
 * lease released — its channel becomes truthfully unknown (never a cached known
 * value), and the caller's already-queued/new explicit fresh pass may re-read the
 * same owner from scratch. The late answer of an expired read is never committed
 * (its outcome lands in a finished pass and the commit-time fences still apply).
 * Ownership tokens, durable records, and every other channel are untouched.
 */
const INTENT_REFRESH_READ_DEADLINE_MS = 30_000;
/** Test-overridable copy of the finite read deadline (no user setting). */
let intentRefreshReadDeadlineMs = INTENT_REFRESH_READ_DEADLINE_MS;

/**
 * Ephemeral, per-pass read bookkeeping for the ONE coalesced refresh engine (no
 * second scheduler, queue, timer, poll, or telemetry mirror). Pending reads are
 * tracked separately from completed outcomes so that:
 *
 * - a pass that still has a pending read which can commit is genuinely
 *   awaited/coalesced (the same still-current source read is never duplicated);
 * - a pending read that a moved intent-generation fence (source replacement,
 *   retirement, or a newer generation) made unpublishable never blocks the
 *   outcomes that already settled, nor a fresh request. Once no pending read can
 *   commit, the pass's read gate is released with the settled outcomes applied;
 *   any still-pending fenced reads are abandoned harmlessly (late results stay
 *   discarded as stale), and the initiating caller runs ONE bounded fresh pass so
 *   the current sources are actually read;
 * - the read phase is also bounded by one finite deadline, so a source that never
 *   answers releases only its own ephemeral read lease: that channel becomes
 *   truthfully unknown and a fresh pass may re-read it immediately.
 *
 * Nothing durable, owned, or counted is aborted here — only this pass's own
 * read bookkeeping is fenced off.
 */
interface ActiveIntentRefreshPass {
  readonly candidates: readonly IntentRefreshCandidate[];
  /** Resolves when this pass finished applying every outcome it could establish. */
  readonly settled: Promise<IntentRefreshPassResult>;
  /** Indices whose refresher has not answered yet. */
  readonly pending: Set<number>;
  /** Releases the read-phase wait; resolves once no pending read can commit. */
  resolveGate: () => void;
  /** True once the read phase was released. */
  gateOpen: boolean;
  /** True once the synchronous apply loop began. */
  applying: boolean;
  /** True once the finite read deadline expired for still-pending reads. */
  deadlineExpired: boolean;
  /** One-shot finite read deadline; cleared as soon as the pass settles. */
  deadlineTimer?: ReturnType<typeof setTimeout>;
  /**
   * True when fenced or timed-out reads were still pending at gate release. New
   * requests must then run their own pass instead of coalescing onto this pass.
   */
  supersededSignalled: boolean;
}

/** One pass's outcome report to its waiting callers. */
interface IntentRefreshPassResult {
  /** A new uncertainty cause appeared mid-pass: exactly one follow-up pass. */
  readonly reschedule: boolean;
  /**
   * True when at least one captured read could not be established for a current
   * source (abandoned while pending, or discarded as unproven). A FORCED caller
   * then runs one bounded follow-up fresh pass before returning, so an explicit
   * refresh never returns while a current source's fresh data is still missing.
   */
  readonly incompleteRead: boolean;
  /** True when the finite read deadline expired (an ephemeral lease was released). */
  readonly deadlineExpired: boolean;
}

/** The one pass fresh requests coalesce onto; undefined when none is in flight. */
let intentRefreshActive: ActiveIntentRefreshPass | undefined;

/**
 * True when this exact captured read can still be applied: its incarnation still
 * carries an authoritative refresher and its intent-generation fence has not
 * moved. A retired incarnation stays readable (its own refresher is its proof), so
 * retirement is not disqualifying by itself — retirement always advances that
 * fence. A missing DERIVED cache is not disqualifying either: a complete read
 * rebuilds it from the owning source's own inventory.
 */
function candidateCanStillCommit(candidate: IntentRefreshCandidate): boolean {
  if (candidate.entry.refreshActivity === undefined) return false;
  return intentGenerationFence(candidate.entry) === candidate.fence;
}

function intentRefreshUsablePending(pass: ActiveIntentRefreshPass): boolean {
  for (const index of pass.pending) {
    const candidate = pass.candidates[index];
    if (candidate !== undefined && candidateCanStillCommit(candidate)) return true;
  }
  return false;
}

/**
 * Release the read-phase wait once no PENDING read can still commit. Reads that
 * already settled keep their outcomes; fenced reads still in flight are abandoned
 * (their late results are rejected by the commit-time fences). Event-driven: it is
 * called when a read settles and from real mutation paths, never from a timer.
 */
function releaseIntentRefreshGate(pass: ActiveIntentRefreshPass): void {
  if (pass.gateOpen || pass.applying) return;
  const state = registryState(false);
  if (state?.active && intentRefreshUsablePending(pass)) return;
  pass.gateOpen = true;
  if (pass.pending.size > 0) pass.supersededSignalled = true;
  pass.resolveGate();
}

/**
 * Event-driven supersession: called only from real mutation paths (never from a
 * pass's own commit). It releases an in-flight pass whose pending reads were all
 * fenced out, so a source replacement/retirement/generation change can never
 * strand fresh requests behind obsolete read bookkeeping.
 */
function noteIntentRefreshSupersession(): void {
  const pass = intentRefreshActive;
  if (pass === undefined) return;
  releaseIntentRefreshGate(pass);
}

/**
 * Finite read deadline: release only the expired reads' ephemeral lease. Each
 * timed-out read leaves its exact current channel truthfully UNKNOWN (never a
 * cached known value, never a fabricated zero), and the pass gate is released so
 * the caller's own bounded fresh pass can re-read the same owner immediately. No
 * ownership token, ownership uncertainty, record, or durable state is touched,
 * and the late answer of an expired read is never applied.
 */
function expireIntentRefreshReads(pass: ActiveIntentRefreshPass): void {
  if (pass.applying || pass.pending.size === 0) return;
  pass.deadlineExpired = true;
  let invalidated = false;
  for (const index of [...pass.pending]) {
    const candidate = pass.candidates[index];
    pass.pending.delete(index);
    // Retirement superseding this read preserves the retired owner's retained
    // proof. A read captured under an ALREADY-retired owner's still-current fence,
    // however, genuinely timed out: its cached inventory is not fresh proof, so
    // it becomes truthfully unknown (retained tokens and ownership are untouched).
    // Newer authoritative observations are preserved and pre-fence records stay
    // fail-closed.
    if (candidate !== undefined
      && (!candidate.entry.retired || candidateCanStillCommit(candidate))
      && (candidate.legacyFence
        || candidate.entry.intentAuthorityRevision === candidate.authority)
      && markIntentUnproven(candidate.entry)) {
      invalidated = true;
    }
  }
  if (invalidated) {
    const state = registryState(false);
    if (state?.active) notify(state);
  }
  // Timed-out reads are abandoned exactly like fenced-out ones: queued requests
  // must not wait on them, and the pass settles with whatever it could establish.
  pass.supersededSignalled = true;
  releaseIntentRefreshGate(pass);
}

/** One eligible incarnation for an authoritative intent-refresh pass. */
interface IntentRefreshCandidate {
  category: OwnedActivityCategory;
  source: string;
  entry: SourceIncarnation;
  /** Intent-generation fence captured when this candidate was snapshotted. */
  fence: number;
  /**
   * Authoritative intent-value observation generation captured with this read. A
   * discard whose generation did not move was invalidated by a non-authoritative
   * readiness/generation change, so the cached value is not fresh proof.
   */
  authority: number | undefined;
  /**
   * True when this record predates the independent intent fence, so its fence is
   * the common revision and an ownership-only mutation is indistinguishable from
   * an intent event.
   */
  legacyFence: boolean;
}

/**
 * One candidate's fresh-read outcome, kept distinct so a superseded read can
 * never be confused with a fresh source failure:
 *
 * - `applied`: the complete exact inventory to commit behind the fences;
 * - `incomplete`: a fresh read that could not establish the inventory while its
 *   own fence still held — the derived activity channel must become unknown;
 * - `stale`: a newer observation superseded the read, which is preserved (and,
 *   for a pre-fence record, distrusted to unknown).
 */
type IntentRefreshOutcome =
  | { readonly kind: "stale"; readonly candidate: IntentRefreshCandidate }
  | {
    readonly kind: "incomplete";
    readonly candidate: IntentRefreshCandidate;
    readonly entry: SourceIncarnation;
  }
  | {
    readonly kind: "applied";
    readonly candidate: IntentRefreshCandidate;
    readonly entry: SourceIncarnation;
    readonly tokens: Set<string>;
    readonly isCurrent?: () => boolean;
  };

/**
 * Snapshot the exact eligible incarnations for one pass.
 *
 * An AUTOMATIC pass (the coalesced scheduler) is uncertainty-only: it exists
 * to repair telemetry the registry itself knows is unknown. A FORCED pass (the
 * explicit `refreshOwnedActivityIntent()` call the authenticated reporter makes
 * on session_start, safe reconnect, and every reload) freshly invokes every
 * CURRENT exact incarnation that can prove its own inventory, even when the
 * registry's and the source's own telemetry booleans claim the value is
 * already known: an independently diverged or poisoned ephemeral mirror is
 * exactly what the explicit event repairs.
 *
 * A RETIRED incarnation is not re-read by a forced pass once its activity is
 * already PROVEN EMPTY: exact empty after its own owner proved it and the seal
 * held. That emptiness IS proof, and re-driving such a retired handle through a
 * current-only callback would fabricate a fresh failure and degrade it on every
 * reload. A retired incarnation that is still uncertain, or that retains a
 * positive token set (work whose settlement nobody observed), is still asked —
 * its own refresher or retired-census path is the only proof of that work, so a
 * ghost positive or a newly unreadable retained inventory becomes the truth
 * (zero or unknown) instead of staying falsely known. A newer source's
 * emptiness is never substituted for that exact owner's evidence. Sources
 * without an authoritative refresher stay as they are; a forced pass never
 * invents a value.
 *
 * A record whose DERIVED intent cache is missing (its `intentTokens` Set was lost or
 * deleted) is still asked when it carries an authoritative refresher: a complete
 * exact-owning read must REBUILD that derived set from the source's own current
 * inventory (zero or nonzero), because a lost ephemeral cache is not a statement
 * about the work. Such a record never becomes a fabricated "legacy" unknown: only
 * a record with NO authoritative callback stays intent-unknown, since no current
 * inventory could ever prove it. The rebuild is committed behind the same exact
 * incarnation/generation fences and never touches ownership, records, or any
 * other channel.
 */
function intentRefreshCandidates(state: RegistryState, force: boolean): IntentRefreshCandidate[] {
  const candidates: IntentRefreshCandidate[] = [];
  for (const [category, bySource] of state.sources) {
    for (const [source, list] of bySource) {
      for (const entry of list) {
        if (entry.refreshActivity === undefined) continue;
        const retained = entry.intentTokens;
        if (!force) {
          // Automatic passes exist only to repair known uncertainty.
          if (entry.intentUncertain !== true) continue;
        } else if (entry.retired
          && entry.intentUncertain !== true
          && retained !== undefined && retained.size === 0) {
          // Already-resolved retired emptiness stays its own settled proof.
          continue;
        }
        candidates.push({
          category,
          source,
          entry,
          fence: intentGenerationFence(entry),
          authority: entry.intentAuthorityRevision,
          legacyFence: entry.intentRevision === undefined,
        });
      }
    }
  }
  return candidates;
}

/**
 * True when ANY incarnation (current or retired) is intent-uncertain with an
 * authoritative refresher. A retired incarnation's retained inventory is only
 * provable by its own source state — a newer source's emptiness is not proof
 * about the older work — so retired uncertainty stays refreshable too.
 */
function hasRefreshableIntentUncertainty(state: RegistryState): boolean {
  return intentRefreshCandidates(state, false).length > 0;
}

/**
 * Mark one incarnation's activity-intent channel uncertain, bumping the
 * uncertainty sequence so an in-flight refresh pass schedules exactly one
 * follow-up for a cause that appeared while it ran.
 */
function markEntryIntentUncertain(entry: SourceIncarnation): boolean {
  if (entry.intentUncertain === true) return false;
  entry.intentUncertain = true;
  intentUncertainSeq += 1;
  return true;
}

/**
 * Bump the uncertainty sequence when a refreshable uncertain incarnation is
 * mutated in a way that can invalidate an in-flight pass's fence: any
 * same-incarnation mutation, retirement, or (re)registration. This is what
 * turns "a result was rejected by its fence" into exactly one follow-up pass.
 * Incomplete results alone never bump: they get no retry.
 */
function noteRefreshableUncertainty(entry: SourceIncarnation): void {
  if (entry.intentUncertain === true && entry.refreshActivity !== undefined) intentUncertainSeq += 1;
}

/**
 * Mark one exact incarnation's activity-intent channel unproven. Both fences
 * advance: the invalidation is itself an intent-generational event, and the
 * common revision keeps ownership/retired reconciliation conservative.
 *
 * A record with neither an intent cache nor an authoritative refresher is a
 * pre-intent legacy record: its activity set was never observed, so it stays
 * UNKNOWN and untouched (never marked, never given a derived set). A
 * CALLBACK-bearing record whose DERIVED cache is missing (`intentTokens`
 * deleted) is different: the invalidation says nothing about the work, so its
 * channel must become refreshably uncertain — exactly like an invalidated cached
 * set — so its own authoritative refresher can rebuild it later from the real
 * inventory. No token is allocated, no zero is coerced, and ownership is never
 * touched by this uncertainty mark.
 */
function markIntentUnproven(entry: SourceIncarnation): boolean {
  // Only a record that can never prove its own inventory stays untouched.
  if (entry.intentTokens === undefined && entry.refreshActivity === undefined) return false;
  if (!markEntryIntentUncertain(entry)) return false;
  entry.revision = (entry.revision ?? 0) + 1;
  bumpIntentGeneration(entry);
  // Invalidating the only fresh proof IS an authoritative value observation
  // (unknown), so a concurrent read cannot mistake it for a readiness change.
  bumpIntentAuthority(entry);
  noteIntentRefreshSupersession();
  return true;
}

/**
 * A fresh intent read for a PRE-FENCE record was superseded. Its common-revision
 * fence cannot distinguish an ownership-only mutation from an actual intent
 * event, so the cached value is not proof: fall back to truthful unknown instead
 * of certifying it. The coalesced scheduler then gets exactly one bounded
 * follow-up attempt while the record stays uncertain; a repeated discard is
 * already-unknown and schedules nothing further, so this can never poll or loop.
 */
function markLegacyDiscardUnproven(
  state: RegistryState,
  candidate: IntentRefreshCandidate,
): boolean {
  if (!candidate.legacyFence) return false;
  const liveState = registryState(false);
  if (liveState !== state || !liveState.active) return false;
  const liveEntry = findIncarnation(liveState, candidate.category, candidate.source, candidate.entry.id);
  // A missing DERIVED cache is not disqualifying here either; only a record with
  // no authoritative refresher stays unknown, and `markIntentUnproven` decides.
  if (liveEntry === undefined) return false;
  if (intentGenerationFence(liveEntry) === candidate.fence) return false; // nothing superseded it
  return markIntentUnproven(liveEntry);
}

/**
 * Handle one discarded fresh intent read for a FENCED record. A retired
 * incarnation keeps its retained proof untouched, an already-unproven entry needs
 * nothing, and a NEWER AUTHORITATIVE intent-value observation (a real
 * acquire/release or intent-uncertainty change, or a fresh commit) is preserved.
 * Otherwise the only fresh proof was invalidated by a non-authoritative readiness
 * or generation change, so the cached value is NOT fresh proof: the channel falls
 * back to truthful unknown (never a cached known count) and its own coalesced
 * refresh recovers it. No value mirror is consulted — only the observation
 * generation.
 */
function markNewIntentDiscardUnproven(
  candidate: IntentRefreshCandidate,
  entry: SourceIncarnation,
): boolean {
  if (entry.retired) return false;
  // A missing DERIVED cache does not disqualify the invalidation: a
  // callback-bearing record must still become refreshably uncertain, while a
  // record with no authoritative refresher stays unknown (see
  // {@link markIntentUnproven}).
  if (entry.intentUncertain === true) return false;
  if (entry.intentAuthorityRevision !== candidate.authority) return false;
  return markIntentUnproven(entry);
}

/**
 * One discarded read. A pre-fence record keeps its common-revision fail-closed
 * handling; a fenced record distinguishes a newer authoritative intent value from
 * a readiness/generation invalidation.
 */
function markIntentDiscardUnproven(
  state: RegistryState,
  candidate: IntentRefreshCandidate,
  entry: SourceIncarnation,
): boolean {
  if (candidate.legacyFence) return markLegacyDiscardUnproven(state, candidate);
  return markNewIntentDiscardUnproven(candidate, entry);
}

/**
 * Schedule ONE coalesced authoritative activity-intent refresh pass. No timer
 * and no retry loop: a pass that finds only incomplete sources leaves the
 * counts unknown until a later genuine lifecycle event (registration, restore,
 * settlement, or an explicit session_start) schedules another one.
 */
function scheduleOwnedActivityIntentRefresh(): void {
  const state = registryState(false);
  if (!state?.active || intentRefreshScheduled) return;
  // Coalesce onto a pass that can still publish; a pass whose pending reads were
  // all fenced out can never publish them, so it must never latch the scheduler
  // off.
  if (intentRefreshActive !== undefined && !intentRefreshActive.supersededSignalled) return;
  if (!hasRefreshableIntentUncertainty(state)) return;
  intentRefreshScheduled = true;
  setImmediate(() => {
    intentRefreshScheduled = false;
    // Re-check at fire time: an explicit pass or a concurrent settlement may
    // have recovered every candidate since the schedule, and a stray pass
    // would only burn a redundant read.
    const state = registryState(false);
    if (!state?.active || !hasRefreshableIntentUncertainty(state)) return;
    void runOwnedActivityIntentRefreshPass({ force: false });
  });
}

/**
 * One bounded, coalesced authoritative intent-refresh pass. Each refresher must
 * return its complete exact activity-intent token set or incomplete; a complete
 * result is applied only while the registry state, incarnation identity, and the
 * exact incarnation's INTENT-GENERATION fence all still hold — revalidated
 * immediately before each application — replacing only that incarnation's
 * derived intent tokens and clearing its intent uncertainty. Ownership-only
 * mutations advance the common revision alone, so they can never discard a
 * valid fresh intent read. A FRESH read that cannot establish
 * an inventory (incomplete, throw, malformed, rejected by its own source
 * freshness predicate) invalidates that incarnation's derived activity channel
 * to unknown instead of leaving a previously cached known value pretending to be
 * freshly confirmed; retained ownership tokens and
 * uncertainty are untouched. A read superseded by a newer same-incarnation
 * intent event is stale/discarded, because that newer observation is
 * authoritative; for a pre-fence record — whose fence is the common revision, so
 * an ownership-only mutation is indistinguishable — the cached value is not
 * proof and the channel falls back to truthful unknown. Ownership tokens,
 * durable records, and every other channel are never modified. A new
 * uncertainty cause that appears while the pass is in flight gets exactly one
 * follow-up pass; fresh failed reads do not schedule themselves.
 *
 * An IN-FLIGHT pass is awaited/coalesced while at least one PENDING read can
 * still commit, so the same still-current source read is never duplicated. That
 * wait is finite: the read phase carries ONE deadline after which only the
 * ephemeral read lease is released (the channel becomes truthfully unknown and
 * the caller re-reads the same owner).
 * Pending reads are tracked separately from completed outcomes: a read fenced
 * out by a source replacement/retirement/readiness generation stops blocking
 * (its late result is never applied), the outcomes that already arrived are
 * applied, and a FORCED caller then runs ONE bounded fresh pass so current
 * sources are actually read. Only ephemeral read bookkeeping is released — never
 * owned work, durable state, or another scheduler.
 *
 * `force` selects the candidate set: an automatic pass is uncertainty-only,
 * while a forced pass freshly asks every eligible incarnation (see
 * {@link intentRefreshCandidates}).
 */
async function runOwnedActivityIntentRefreshPass(options: { force: boolean }): Promise<void> {
  // Coalesce callers onto an in-flight pass that still has a PENDING read which
  // can commit: an awaited refresh (the reporter's session_start hook) must not
  // return while its authoritative read is pending, and two current requests must
  // never duplicate the same still-current source read. That wait is bounded,
  // because a read fenced out by a source replacement/retirement/readiness
  // generation is released by {@link releaseIntentRefreshGate}.
  //
  // A FORCED caller is never satisfied by another pass (it runs its own fresh
  // pass afterwards). When its own pass could not establish a current source's
  // fresh data — a pending read was abandoned, or the only fresh proof was
  // invalidated by a non-authoritative readiness/generation change — it runs ONE
  // more bounded fresh pass, so an explicit refresh never returns while current
  // fresh data is still missing, and never reports a cached value as fresh.
  // Bounded: each pass can lose its usable reads at most once per attempt, and a
  // source that ignores its finite read deadline is re-read only ONCE before the
  // caller returns truthfully unknown instead of retrying it endlessly.
  let deadlineRetries = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const active = intentRefreshActive;
    if (active !== undefined && !active.supersededSignalled) {
      await active.settled;
      if (!options.force) return; // an automatic caller is covered by that pass
      continue;
    }
    const state = registryState(false);
    if (!state?.active) return;
    // Snapshot candidates BEFORE any async work: reentrant registration during
    // the pass cannot duplicate or extend this exact candidate set. Retired
    // incarnations with a refresher are candidates too: their retained inventory
    // is only provable by their own source state, never by a newer source.
    const candidates = intentRefreshCandidates(state, options.force);
    if (candidates.length === 0) return;
    const result = await startIntentRefreshPass(state, candidates);
    if (!options.force) return;
    if (!result.incompleteRead) return;
    if (result.deadlineExpired) {
      deadlineRetries += 1;
      // A source that cannot answer its own finite read twice is not retried
      // endlessly: its channel stays truthfully unknown for a later event.
      if (deadlineRetries > 1) return;
    }
  }
}

/**
 * Read one candidate's authoritative inventory, applying the fences at read
 * completion. A failed fence is a stale/discarded read (a newer observation won);
 * a fence that still holds after a failed read is a genuine fresh source failure.
 */
async function readIntentCandidate(
  state: RegistryState,
  candidate: IntentRefreshCandidate,
): Promise<IntentRefreshOutcome> {
  const fenced = (): SourceIncarnation | undefined => {
    const liveState = registryState(false);
    if (liveState !== state || !liveState.active) return undefined;
    const liveEntry = findIncarnation(liveState, candidate.category, candidate.source, candidate.entry.id);
    if (liveEntry === undefined || liveEntry.refreshActivity === undefined
      || intentGenerationFence(liveEntry) !== candidate.fence) return undefined;
    return liveEntry;
  };
  const failed = (): IntentRefreshOutcome => {
    const liveEntry = fenced();
    // Retirement is NOT a fence: a retired incarnation's retained inventory is
    // exactly what its refresher proves, and the intent-generation fence still
    // rejects any settlement that raced this read.
    return liveEntry === undefined
      ? { kind: "stale", candidate }
      : { kind: "incomplete", candidate, entry: liveEntry };
  };
  let result: OwnedActivityIntentRefresh;
  try {
    result = await candidate.entry.refreshActivity!();
  } catch {
    return failed();
  }
  if (result?.status !== "complete") return failed();
  const reported = result.intentTokens;
  if (!(reported instanceof Set)) return failed();
  const exact = new Set<string>();
  for (const token of reported) {
    // Malformed output is never proof; it is an unusable fresh read.
    if (!isValidToken(token)) return failed();
    exact.add(token);
  }
  const liveEntry = fenced();
  if (liveEntry === undefined) return { kind: "stale", candidate };
  return { kind: "applied", candidate, entry: liveEntry, tokens: exact, isCurrent: result.isCurrent };
}

/**
 * Start one pass over an already-snapshotted candidate set and apply every
 * outcome it could establish. Its reads settle independently: a pending read
 * fenced out by a mutation never blocks the outcomes that already arrived (or a
 * fresh request), and the late result of an abandoned read is never applied.
 */
async function startIntentRefreshPass(
  state: RegistryState,
  candidates: IntentRefreshCandidate[],
): Promise<IntentRefreshPassResult> {
  const seqAtStart = intentUncertainSeq;
  const outcomes: Array<IntentRefreshOutcome | undefined> = new Array(candidates.length);
  let record!: ActiveIntentRefreshPass;
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  const pass = (async (): Promise<IntentRefreshPassResult> => {
    // Yield so the pass is installed as the active pass before any read settles.
    await Promise.resolve();
    releaseIntentRefreshGate(record);
    await gate;
    // Every usable capture has answered: the apply loop below is synchronous, so
    // this pass can no longer be superseded mid-commit.
    record.applying = true;
    let changed = false;
    // A fresh proof discarded as unproven (readiness/generation invalidation), an
    // expired read lease, or a CURRENT refreshable incarnation this pass never
    // asked (a replacement that arrived while an old read was in flight) means a
    // forced caller still needs one bounded fresh pass.
    let incompleteRead = record.deadlineExpired;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const outcome: IntentRefreshOutcome = outcomes[index] ?? { kind: "stale", candidate };
      // A stale/discarded read never publishes anything of its own. A newer
      // AUTHORITATIVE intent value superseding it is preserved; a readiness or
      // generation invalidation (or an ambiguous pre-fence discard) leaves the
      // cached value unproven and falls back to truthful unknown.
      if (outcome.kind === "stale") {
        if (markIntentDiscardUnproven(state, outcome.candidate, outcome.candidate.entry)) {
          changed = true;
          incompleteRead = true;
        }
        continue;
      }
      // Revalidate IMMEDIATELY before committing: a fast source can pass its
      // fence, then acquire new work or be retired while another source is
      // still pending. The captured intent-generation fence must still hold at
      // apply time.
      const liveState = registryState(false);
      if (liveState !== state || !liveState.active) break;
      if (intentGenerationFence(outcome.entry) !== outcome.candidate.fence) {
        if (markIntentDiscardUnproven(state, outcome.candidate, outcome.entry)) {
          changed = true;
          incompleteRead = true;
        }
        continue;
      }
      if (outcome.kind === "incomplete") {
        // A fresh forced read that genuinely could not establish this source's
        // inventory means the previously cached known value is NOT proof. Only
        // the derived ephemeral activity channel is invalidated; every retained
        // positive ownership token, ownership uncertainty, and durable record
        // is untouched. No retry is requested here: this is a fresh failed read,
        // not a newly discovered uncertainty cause to chase.
        if (markIntentUnproven(outcome.entry)) changed = true;
        continue;
      }
      // The owning source's own freshness predicate, evaluated at commit time:
      // controller/session changes after its read make the result stale even
      // when no registry mutation happened. A throwing fence is stale proof.
      // A complete result its own source rejects is NOT current fresh data: the
      // cached derived value is unproven, so the channel must fall back to
      // truthful unknown instead of continuing to certify the cached count.
      let current = true;
      try {
        current = outcome.isCurrent === undefined || outcome.isCurrent();
      } catch {
        current = false;
      }
      if (!current) {
        if (markIntentUnproven(outcome.entry)) changed = true;
        continue;
      }
      // The commit REBUILDS a missing derived intent set from this fresh complete
      // inventory (a lost/deleted ephemeral cache is not a statement about the
      // work); only a record with no authoritative callback is left unknown. The
      // record identity, ownership tokens, uncertainty, and durable state are
      // untouched.
      const existing = outcome.entry.intentTokens;
      const rebuilt = existing === undefined;
      const tokens = existing ?? new Set<string>();
      const replaced = rebuilt || tokens.size !== outcome.tokens.size
        || [...outcome.tokens].some((token) => !tokens.has(token));
      tokens.clear();
      for (const token of outcome.tokens) tokens.add(token);
      if (rebuilt) outcome.entry.intentTokens = tokens;
      const resolved = outcome.entry.intentUncertain !== false;
      outcome.entry.intentUncertain = false;
      outcome.entry.revision = (outcome.entry.revision ?? 0) + 1;
      // A fresh intent commit is itself an intent-generation event: advance the
      // independent fence and its authoritative-value generation so no older
      // in-flight read can overwrite it.
      bumpIntentGeneration(outcome.entry);
      bumpIntentAuthority(outcome.entry);
      // A verified-unchanged result still consumed a fresh read but publishes
      // no derived change; notifying subscribers (and the wire frame) for it
      // would be meaningless churn.
      if (replaced || resolved) changed = true;
    }
    intentRefreshPassesRun += 1;
    // A current refreshable incarnation that appeared while this pass was reading
    // was never asked; a forced caller must establish it now. (A retired owner's
    // abandoned read stays its own proof: a newer source's emptiness is not
    // evidence about it, and its own later event re-reads it.)
    if (!incompleteRead && registryState(false) === state && state.active) {
      incompleteRead = intentRefreshCandidates(state, true)
        .some((candidate) => !candidates.some((prior) => prior.entry === candidate.entry));
    }
    if (changed) notify(state);
    // A new uncertainty cause that appeared while this pass was in flight gets
    // exactly one follow-up pass. Incomplete refreshers never reschedule.
    return {
      reschedule: intentUncertainSeq !== seqAtStart,
      incompleteRead,
      deadlineExpired: record.deadlineExpired,
    };
  })();
  record = {
    candidates,
    settled: pass,
    pending: new Set(candidates.map((_candidate, index) => index)),
    resolveGate,
    gateOpen: false,
    applying: false,
    deadlineExpired: false,
    supersededSignalled: false,
  };
  intentRefreshActive = record;
  // ONE finite read deadline per pass: ephemeral read bookkeeping only. It never
  // commits anything itself and never retries; it just releases the lease so the
  // caller's own bounded fresh pass can re-read the same owner.
  record.deadlineTimer = setTimeout(() => {
    record.deadlineTimer = undefined;
    expireIntentRefreshReads(record);
  }, intentRefreshReadDeadlineMs);
  if (typeof (record.deadlineTimer as { unref?: () => void }).unref === "function") {
    (record.deadlineTimer as unknown as { unref: () => void }).unref();
  }
  // Start every read independently. Each one releases the pass gate when it
  // settles, so a fenced pending read can neither block settled outcomes nor a
  // fresh request.
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    void (async () => {
      let outcome: IntentRefreshOutcome;
      try {
        outcome = await readIntentCandidate(state, candidate);
      } catch {
        outcome = { kind: "stale", candidate };
      }
      outcomes[index] = outcome;
      record.pending.delete(index);
      releaseIntentRefreshGate(record);
    })();
  }
  let result: IntentRefreshPassResult;
  try {
    result = await pass;
  } finally {
    // The finite read deadline covers only this pass's ephemeral reads.
    if (record.deadlineTimer !== undefined) {
      clearTimeout(record.deadlineTimer);
      record.deadlineTimer = undefined;
    }
    // Clear the slot only while it is still THIS pass: an abandoned pass that a
    // newer request superseded must never clear the newer pass's slot.
    if (intentRefreshActive === record) intentRefreshActive = undefined;
  }
  // A new uncertainty cause that appeared while this pass was in flight gets
  // exactly one follow-up pass (scheduled here, in the same synchronous tail that
  // cleared the slot, so no caller observes a half-settled engine).
  if (result.reschedule) scheduleOwnedActivityIntentRefresh();
  return result;
}

/**
 * Run one bounded, coalesced authoritative activity-intent refresh pass now.
 * A forced fresh pass is the DEFAULT: the authenticated reporter awaits this on
 * session_start, safe reconnect, and reload, and the transport calls it with no
 * arguments. Each eligible CURRENT owning source is asked freshly, even when
 * registry/source telemetry currently claims a known value, so an independently
 * poisoned or obsolete mirror recovers to the source's actual current zero or
 * nonzero value without a prompt, new task, manual refresh, or polling. Also
 * asked: any retained incarnation whose own activity is still uncertain, since
 * only its exact state can prove it. Complete valid results replace only that
 * incarnation's derived ephemeral intent tokens behind the existing
 * registry/source commit-time fences; a fresh read that genuinely cannot
 * establish an inventory, or that its own source freshness predicate rejects,
 * invalidates only that incarnation's activity channel
 * to unknown (never zero, never a cached known value passed off as fresh); a
 * read superseded by a newer AUTHORITATIVE intent value is discarded in favor of
 * that newer value, while a read invalidated by a readiness/generation change
 * (or an ambiguous pre-fence discard) falls back to truthful unknown. A pending
 * read fenced out mid-pass never blocks settled outcomes, and the initiating
 * forced caller then runs one bounded fresh pass so current sources are actually
 * read before it returns. Ownership
 * tokens, ownership uncertainty, durable records, and an ownership-only
 * mutation never invalidate a valid fresh intent read. Already-resolved retired
 * observations, sources without a refresher, and ownership/durable recovery
 * state are never modified, and a retained positive is never cleared by another
 * source's emptiness. `{ force: false }` is the internal uncertainty-only pass
 * the coalesced scheduler uses.
 */
export async function refreshOwnedActivityIntent(options?: { force?: boolean }): Promise<void> {
  await runOwnedActivityIntentRefreshPass({ force: options?.force !== false });
}

function installRegistration(
  state: RegistryState,
  handle: OwnedActivitySourceHandle,
  options: OwnedActivitySourceOptions | undefined,
): void {
  let bySource = state.sources.get(handle.category);
  if (!bySource) {
    bySource = new Map();
    state.sources.set(handle.category, bySource);
  }
  let list = bySource.get(handle.source);
  if (!list) {
    list = [];
    bySource.set(handle.source, list);
  }
  let entry = list.find((candidate) => candidate.id === handle.incarnation);
  if (!entry) {
    entry = {
      id: handle.incarnation,
      tokens: new Set(),
      uncertain: options?.uncertain === true,
      retired: false,
      intentTokens: new Set(),
      intentUncertain: false,
      ...(options?.reconcileRetired ? { reconcileRetired: options.reconcileRetired } : {}),
      ...(options?.refreshActivity ? { refreshActivity: options.refreshActivity } : {}),
      reconciliationInFlight: false,
      revision: 0,
      // A NEW record owns the independent intent-generation fence from birth.
      // Pre-fence records loaded from an older module copy must never gain it
      // lazily (their older closures could not advance it).
      intentRevision: 0,
      intentAuthorityRevision: 0,
    };
    list.push(entry);
    if (options?.intentUncertain === true) markEntryIntentUncertain(entry);
  } else {
    if (options?.uncertain === true) entry.uncertain = true;
    // Never fabricate intent data for a pre-intent entry: its activity set was
    // never observed, so it stays unknown rather than becoming a known zero.
    if (entry.intentTokens !== undefined && options?.intentUncertain === true) {
      markEntryIntentUncertain(entry);
    }
    if (options?.reconcileRetired) entry.reconcileRetired = options.reconcileRetired;
    if (options?.refreshActivity) {
      entry.refreshActivity = options.refreshActivity;
      noteRefreshableUncertainty(entry);
    }
  }
  // A newly installed incarnation supersedes every older one, but the
  // superseded incarnation's tokens AND uncertainty stay retained until that
  // incarnation itself resolves or releases them. Retiring a refreshable
  // uncertain incarnation invalidates any in-flight result for it: note it so
  // exactly one follow-up pass consults its own refresher.
  for (const other of list) {
    if (other !== entry) {
      other.retired = true;
      other.revision = (other.revision ?? 0) + 1;
      // Source replacement is an intent-generational event: a read for the older
      // incarnation must not be mistaken for current intent data.
      bumpIntentGeneration(other);
      noteRefreshableUncertainty(other);
    }
  }
  entry.revision = (entry.revision ?? 0) + 1;
  // (Re)registration is an intent-generational event for the installed record.
  bumpIntentGeneration(entry);
  if (options?.resync) {
    // A throwing resync leaves ownership unaccounted for: sticky unknown. The
    // source cannot prove its own current state, so the activity-intent channel
    // is incomplete too when it carries intent data — the authoritative refresh
    // pass can still recover it from the source's own knowledge.
    try {
      options.resync();
    } catch {
      entry.uncertain = true;
      if (entry.intentTokens !== undefined) markEntryIntentUncertain(entry);
    }
  }
  // A registration/supersession may have invalidated every read an in-flight
  // pass is waiting on (for example a replaced source whose old read never
  // answers): release fresh requests instead of stranding them.
  noteIntentRefreshSupersession();
  notify(state);
  scheduleOwnedActivityIntentRefresh();
}

function categoryCount(state: RegistryState | undefined, category: OwnedActivityCategory): number | null {
  if (!state || !state.active) return null;
  const bySource = state.sources.get(category);
  let total = 0;
  for (const source of EXPECTED_SOURCES[category]) {
    const list = bySource?.get(source);
    if (!list || list.length === 0) return null; // source absent: unknown
    let current: SourceIncarnation | undefined;
    for (const entry of list) {
      if (!entry.retired) current = entry;
    }
    // Unknown when this source has no current incarnation, or when ANY retained
    // incarnation is uncertain: a superseded incarnation's missing associations
    // are not accounted for by a newer one, and its known tokens cannot substitute
    // for ownership that was never observed. This never lets an old handle mutate
    // the current source; it only keeps the category honest.
    if (!current || list.some((entry) => entry.uncertain)) return null;
    // Tokens AND uncertainty of retired incarnations stay retained until that
    // incarnation itself resolves or releases them.
    for (const entry of list) total += entry.tokens.size;
  }
  return Number.isSafeInteger(total) && total >= 0 ? normalizeOwnedCount(total) : null;
}

/**
 * Independent activity-intent count. This deliberately does NOT consult the
 * ownership channel's uncertainty: a retained cleanup obligation cannot keep
 * activity unknown once every source's activity set is positively known. A
 * pre-intent or activity-uncertain incarnation keeps its source unknown.
 */
function categoryIntentCount(state: RegistryState | undefined, category: OwnedActivityCategory): number | null {
  if (!state || !state.active) return null;
  const bySource = state.sources.get(category);
  let total = 0;
  for (const source of EXPECTED_SOURCES[category]) {
    const list = bySource?.get(source);
    if (!list || list.length === 0) return null; // source absent: unknown
    let current: SourceIncarnation | undefined;
    for (const entry of list) {
      if (!entry.retired) current = entry;
    }
    if (!current) return null;
    for (const entry of list) {
      // A pre-intent incarnation and a sticky activity uncertainty both mean
      // the source's admitted/running set was never authoritatively observed.
      if (entry.intentTokens === undefined || entry.intentUncertain === true) return null;
      total += entry.intentTokens.size;
    }
  }
  return Number.isSafeInteger(total) && total >= 0 ? normalizeOwnedCount(total) : null;
}

/**
 * Opt this process into owned-activity observation. Called by the reporter only
 * after a valid authenticated bootstrap exists; idempotent across reloads.
 */
export function activateOwnedActivity(): void {
  const state = registryState(true);
  if (!state) return;
  const wasActive = state.active;
  state.active = true;
  // Retain every incarnation before any resync can establish completeness:
  // a newer same-name registration must not discard an older source's
  // callback and inventory, and replay must not transiently publish zero
  // from a newer empty source while older work is still active.
  const pending = pendingRegistrations.splice(0);
  for (const registration of pending) {
    installRegistration(state, registration.handle, {
      ...registration.options,
      resync: undefined,
    });
  }
  for (const registration of pending) {
    try {
      registration.options?.resync?.();
    } catch {
      // A throwing resync leaves that incarnation's state unaccounted for:
      // sticky unknown on both channels, with one follow-up pass allowed to
      // consult its own refresher.
      const entry = findIncarnation(state, registration.handle.category,
        registration.handle.source, registration.handle.incarnation);
      if (entry) {
        entry.uncertain = true;
        if (entry.intentTokens !== undefined) markEntryIntentUncertain(entry);
        entry.revision = (entry.revision ?? 0) + 1;
        bumpIntentGeneration(entry);
        bumpIntentAuthority(entry);
        noteIntentRefreshSupersession();
        noteRefreshableUncertainty(entry);
      }
    }
  }
  if (!wasActive || pending.length > 0) notify(state);
  // A replayed pre-opt-in registration lands uncertain; let the coalesced pass
  // recover what each source authoritatively knows right now.
  scheduleOwnedActivityIntentRefresh();
}

/** True only once an authenticated reporter has opted in. */
export function isOwnedActivityActive(): boolean {
  return registryState(false)?.active === true;
}

function createSourceHandle(
  category: OwnedActivityCategory,
  source: string,
  incarnation: string,
): OwnedActivitySourceHandle {
  const withEntry = (
    mutate: (state: RegistryState, entry: SourceIncarnation) => boolean,
    options?: { intentGeneration?: boolean },
  ): void => {
    const state = registryState(false);
    if (!state || !state.active) return;
    const entry = findIncarnation(state, category, source, incarnation);
    if (!entry) return; // not installed: no observation
    if (mutate(state, entry)) {
      entry.revision = (entry.revision ?? 0) + 1;
      // Ownership-only mutations advance the common revision alone. Only an
      // intent-generational event (an actual intent change, readiness, or
      // retirement) advances the independent intent fence, so a cleanup-anchor
      // acquire/release or ownership uncertainty can never discard a valid,
      // fresher authoritative intent read.
      if (options?.intentGeneration === true) bumpIntentGeneration(entry);
      // A retirement/readiness/intent event can invalidate every read an
      // in-flight pass is still waiting on; release those waiters instead of
      // stranding fresh requests behind an obsolete read.
      noteIntentRefreshSupersession();
      noteRefreshableUncertainty(entry);
      notify(state);
      scheduleOwnedActivityIntentRefresh();
    }
  };
  // Activity-intent mutations are scoped like ownership mutations, but a
  // pre-intent entry has no activity data to mutate: it stays unknown.
  const withIntentEntry = (
    mutate: (state: RegistryState, entry: SourceIncarnation) => boolean,
  ): void => {
    const state = registryState(false);
    if (!state || !state.active) return;
    const entry = findIncarnation(state, category, source, incarnation);
    if (!entry) return;
    let changed: boolean;
    if (entry.intentTokens === undefined) {
      // A record with NO authoritative refresher is a pre-intent legacy record:
      // its activity set was never observed, so it stays unknown and untouched.
      if (entry.refreshActivity === undefined) return;
      // A callback-bearing record whose DERIVED cache is missing cannot be
      // rebuilt incrementally (a single event is not a complete inventory), but
      // this IS a real intent event: keep the channel unknown and advance the
      // existing mutation fences, so a captured inventory can never rebuild stale
      // data. The coalesced scheduler then recovers it authoritatively.
      markEntryIntentUncertain(entry);
      changed = true;
    } else {
      changed = mutate(state, entry);
    }
    if (changed) {
      entry.revision = (entry.revision ?? 0) + 1;
      // An actual intent mutation is an intent-generational event AND an
      // authoritative intent-value observation.
      bumpIntentGeneration(entry);
      bumpIntentAuthority(entry);
      noteIntentRefreshSupersession();
      noteRefreshableUncertainty(entry);
      notify(state);
      scheduleOwnedActivityIntentRefresh();
    }
  };
  const handle: OwnedActivitySourceHandle = {
    category,
    source,
    incarnation,
    get retired(): boolean {
      const state = registryState(false);
      if (!state) return false;
      return findIncarnation(state, category, source, incarnation)?.retired === true;
    },
    acquire(token: string): void {
      if (!isValidToken(token)) return;
      withEntry((_state, entry) => {
        if (entry.tokens.has(token)) return false;
        entry.tokens.add(token);
        return true;
      });
    },
    release(token: string): void {
      if (!isValidToken(token)) return;
      withEntry((_state, entry) => entry.tokens.delete(token));
    },
    markUncertain(): void {
      withEntry((_state, entry) => {
        if (entry.uncertain) return false;
        entry.uncertain = true;
        return true;
      });
    },
    resolveUncertainty(): void {
      withEntry((_state, entry) => {
        if (!entry.uncertain) return false;
        entry.uncertain = false;
        return true;
      });
    },
    acquireIntent(token: string): void {
      if (!isValidToken(token)) return;
      withIntentEntry((_state, entry) => {
        const tokens = entry.intentTokens!;
        if (tokens.has(token)) return false;
        tokens.add(token);
        return true;
      });
    },
    releaseIntent(token: string): void {
      if (!isValidToken(token)) return;
      withIntentEntry((_state, entry) => entry.intentTokens!.delete(token));
    },
    markIntentUncertain(): void {
      withIntentEntry((_state, entry) => markEntryIntentUncertain(entry));
    },
    resolveIntentUncertainty(): void {
      withIntentEntry((_state, entry) => {
        if (entry.intentUncertain !== true) return false;
        entry.intentUncertain = false;
        return true;
      });
    },
    requestIntentRefresh(): void {
      // A genuine readiness/lifecycle observation invalidates any pending
      // intent read for this incarnation (intent-generation bump) and lets the
      // coalesced scheduler retry diverged registry telemetry — even when the
      // source's own uncertainty boolean is false. Incomplete refresh results
      // never call this: they get no retry.
      withEntry(() => true, { intentGeneration: true });
    },
    retire(): void {
      // Retirement is an intent-generational event (a pending intent read must
      // not be applied to a superseded owner) as well as a common-revision
      // mutation. It applies to pre-fence records too: their token/uncertainty
      // accounting is retained either way.
      withEntry((_state, entry) => {
        if (entry.retired) return false;
        entry.retired = true;
        return true;
      }, { intentGeneration: true });
    },
  };
  return handle;
}

/**
 * Register one expected work source for a category. Returns an
 * incarnation-scoped handle. Unknown source/category names are ignored (fail
 * closed); an unknown name returns an inert handle.
 */
export function registerOwnedActivitySource(
  category: OwnedActivityCategory,
  source: string,
  options?: OwnedActivitySourceOptions,
): OwnedActivitySourceHandle {
  const incarnation = randomUUID();
  const handle = createSourceHandle(category, source, incarnation);
  if (!isCategory(category) || !isExpectedSource(category, source)) return handle;
  const state = registryState(false);
  if (!state || !state.active) {
    // Inert: remembered in this module copy's memory only, with no global
    // container and no observation. Replayed by activateOwnedActivity().
    // Pre-opt-in lifecycle acquisitions were never observed, so replaying the
    // registration alone cannot establish that the owned set is empty (a review
    // may already be running, or a shell may already have been reaped out of its
    // map). Fail closed as uncertain until the source authoritatively resolves.
    // Every pre-opt-in incarnation is retained: a newer same-name
    // registration must not discard an older source's callback and inventory.
    // Newer emptiness is never proof that older work is absent, so all of
    // them replay at activation (older ones retired but retained).
    const registration: PendingRegistration = {
      handle,
      // Neither channel's pre-opt-in acquisitions were observed: both replay
      // as uncertain until the source authoritatively resolves them.
      options: { ...options, uncertain: true, intentUncertain: true },
    };
    pendingRegistrations.push(registration);
    return handle;
  }
  installRegistration(state, handle, options);
  return handle;
}

/** Current bounded counts; both categories are null until observation is active and complete. */
export function ownedActivitySnapshot(): OwnedActivitySnapshot {
  const state = registryState(false);
  return {
    backgroundTasks: categoryCount(state, "backgroundTasks"),
    backgroundShells: categoryCount(state, "backgroundShells"),
  };
}

/**
 * Current bounded activity-intent counts, independent of ownership. Both are
 * null until observation is active and the activity sets are complete.
 */
export function activeActivitySnapshot(): ActiveActivitySnapshot {
  const state = registryState(false);
  return {
    activeTasks: categoryIntentCount(state, "backgroundTasks"),
    activeShells: categoryIntentCount(state, "backgroundShells"),
  };
}

/** Event-driven subscription; returns a no-op unsubscriber while the registry is inert. */
export function subscribeOwnedActivity(listener: () => void): () => void {
  const state = registryState(false);
  if (!state || !state.active || typeof listener !== "function") return () => undefined;
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

function validatedReconciliationChannel(value: unknown): { tokens: string[]; released: string[] } | undefined {
  try {
    if (!isRecord(value) || value.complete !== true) return undefined;
    const rawTokens = value.tokens;
    const rawReleased = value.released;
    if (!Array.isArray(rawTokens) || !Array.isArray(rawReleased)) return undefined;
    const tokens: unknown[] = Array.from(rawTokens);
    const released: unknown[] = Array.from(rawReleased);
    if (tokens.some((token) => !isValidToken(token)) || released.some((token) => !isValidToken(token))) return undefined;
    if (new Set(tokens).size !== tokens.length || new Set(released).size !== released.length) return undefined;
    return { tokens: tokens as string[], released: released as string[] };
  } catch {
    return undefined; // A hostile or malformed result is incomplete, never proof.
  }
}

function applyRetiredChannel(
  entry: SourceIncarnation,
  result: ReturnType<typeof validatedReconciliationChannel>,
  tokens: Set<string> | undefined,
  isUncertain: () => boolean,
  setUncertain: (uncertain: boolean) => void,
  intentChannel: boolean,
): boolean {
  if (!tokens) return false; // Legacy pre-intent entries remain unknown without invented history.
  // The common revision always advances (ownership accounting and retired
  // reconciliation stay fenced by any mutation). An intent-channel census result
  // is also an intent-generational event, so it advances that fence too and an
  // older in-flight intent read cannot overwrite it.
  const bump = (): void => {
    entry.revision = (entry.revision ?? 0) + 1;
    if (intentChannel) {
      bumpIntentGeneration(entry);
      // A retired-census intent result is an authoritative value observation.
      bumpIntentAuthority(entry);
    }
    // Retired-census application moves this record's fence, so any in-flight pass
    // still waiting only on this read can no longer publish.
    noteIntentRefreshSupersession();
  };
  const markUnknown = (): boolean => {
    if (isUncertain()) return false;
    setUncertain(true);
    bump();
    return true;
  };
  try {
    if (!result) return markUnknown();
    const next = new Set(result.tokens);
    const released = new Set(result.released);
    // A retained positive can disappear only with explicit per-channel proof.
    for (const prior of tokens) {
      if (!next.has(prior) && !released.has(prior)) return markUnknown();
    }
    for (const proof of released) {
      if (!tokens.has(proof) || next.has(proof)) return markUnknown();
    }
    const changed = isUncertain() || tokens.size !== next.size || [...tokens].some((token) => !next.has(token));
    if (!changed) return false;
    tokens.clear();
    for (const token of next) tokens.add(token);
    setUncertain(false);
    bump();
    return true;
  } catch {
    // Unexpected application failures invalidate only this exact channel and
    // never alter its retained positive tokens.
    return markUnknown();
  }
}

/**
 * Bounded, event-driven recovery of retired execution telemetry. Each call
 * snapshots the eligible exact retired sources once, reads each independently,
 * and never restarts the pass if registration changes that snapshot. The caller
 * is the authenticated reporter's existing session_start hook and awaits this
 * before ordinary association restoration. Failed, incomplete, or stale reads
 * may be retried by a later explicit session_start; no timer or polling is used.
 * Review and shell sources, legacy entries without callbacks, and the current
 * incarnation are never queried.
 */
export async function reconcileRetiredExecutionActivity(): Promise<void> {
  const state = registryState(false);
  if (!state?.active) return;
  const sources = state.sources;
  const bySource = sources.get("backgroundTasks");
  const list = bySource?.get("execution");
  if (!list) return;
  const sourceSnapshot = [...list];
  const sameSourceSnapshot = (): boolean => {
    const currentState = registryState(false);
    const currentBySource = currentState?.sources.get("backgroundTasks");
    const currentList = currentBySource?.get("execution");
    return currentState === state && currentState.active
      && currentState.sources === sources && currentBySource === bySource
      && currentList === list && currentList.length === sourceSnapshot.length
      && currentList.every((entry, index) => entry === sourceSnapshot[index]);
  };
  const candidates = sourceSnapshot.flatMap((entry) => {
    const reconcile = entry.reconcileRetired;
    const provenCompleteEmpty = !entry.uncertain && entry.tokens.size === 0
      && entry.intentTokens !== undefined && entry.intentUncertain !== true
      && entry.intentTokens.size === 0;
    if (!entry.retired || typeof reconcile !== "function" || entry.reconciliationInFlight === true
      || provenCompleteEmpty) return [];
    return [{
      entry,
      reconcile,
      revision: entry.revision ?? 0,
      retained: {
        ownership: [...entry.tokens],
        intent: entry.intentTokens === undefined ? undefined : [...entry.intentTokens],
      } satisfies RetiredOwnedActivityTokens,
    }];
  });
  if (candidates.length === 0) return;

  // Reserve the complete candidate snapshot before invoking any callback.
  // Reentrant events (including callbacks which re-enter this function) can
  // therefore never duplicate an exact source's in-flight read.
  for (const candidate of candidates) candidate.entry.reconciliationInFlight = true;
  const pending: Array<{
    candidate: typeof candidates[number];
    result: Promise<RetiredOwnedActivityReconciliation>;
  }> = [];
  try {
    for (const candidate of candidates) {
      // A synchronous callback may re-enter registration. Discard the rest of
      // this pass rather than reading a candidate set that no longer exists.
      if (!sameSourceSnapshot()) break;
      const { entry, reconcile, revision, retained } = candidate;
      if (!entry.retired || entry.reconcileRetired !== reconcile
        || (entry.revision ?? 0) !== revision) continue;
      try {
        pending.push({ candidate, result: reconcile(retained) });
      } catch {
        // A synchronous failure is isolated to this owner; independent owners
        // in the same captured pass still get their one read.
        pending.push({ candidate, result: Promise.reject(new Error("retired census failed")) });
      }
    }
    const settled = await Promise.allSettled(pending.map(({ result }) => result));
    // A changed registry/source list invalidates every result from this captured
    // pass. Do not restart or add newly registered owners until another event.
    if (!sameSourceSnapshot()) return;

    const applicable = settled.flatMap((outcome, index) => {
      const candidate = pending[index]!.candidate;
      const { entry, reconcile, revision } = candidate;
      if (sourceSnapshot.includes(entry) && entry.retired
        && entry.reconcileRetired === reconcile && (entry.revision ?? 0) === revision) {
        return [{ entry, candidate, outcome }];
      }
      return [];
    });
    let changed = false;
    for (const { entry, candidate, outcome } of applicable) {
      if (outcome.status === "fulfilled" && outcome.value === RETIRED_ACTIVITY_CENSUS_DISCARDED) continue;
      const readChannel = (channel: "ownership" | "intent"): ReturnType<typeof validatedReconciliationChannel> => {
        try {
          if (outcome.status !== "fulfilled" || !isRecord(outcome.value)) return undefined;
          return validatedReconciliationChannel(outcome.value[channel]);
        } catch {
          // A throwing accessor invalidates only this channel; read the other independently.
          return undefined;
        }
      };
      const ownership = readChannel("ownership");
      const intent = readChannel("intent");
      // Normalize all result properties and arrays before checking the fences;
      // applying these plain snapshots must not execute result accessors.
      if (!sameSourceSnapshot() || !entry.retired || entry.reconcileRetired !== candidate.reconcile
        || (entry.revision ?? 0) !== candidate.revision) continue;
      // Missing, rejected, malformed, and explicitly incomplete channels all
      // invalidate only this exact old channel. A complete independent channel
      // can still resolve, and no incomplete result can release retained tokens.
      changed = applyRetiredChannel(entry, ownership, entry.tokens,
        () => entry.uncertain, (uncertain) => { entry.uncertain = uncertain; }, false) || changed;
      // Never fabricate independent activity history for a legacy record.
      if (entry.intentTokens !== undefined) {
        changed = applyRetiredChannel(entry, intent, entry.intentTokens,
          () => entry.intentUncertain === true, (uncertain) => { entry.intentUncertain = uncertain; }, true) || changed;
      }
    }
    if (changed) notify(state);
  } finally {
    // Clear even on rejection/stale snapshots so a later explicit lifecycle
    // event can retry. This scheduling bit is not a source mutation/revision.
    for (const candidate of candidates) candidate.entry.reconciliationInFlight = false;
  }
}

/** Test seam: drop the process-local state and inert pending registrations. */
export const __test = Object.freeze({
  resetOwnedActivityForTests(): void {
    delete (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY];
    pendingRegistrations.length = 0;
    intentRefreshScheduled = false;
    const active = intentRefreshActive;
    if (active?.deadlineTimer !== undefined) clearTimeout(active.deadlineTimer);
    intentRefreshActive = undefined;
    intentRefreshPassesRun = 0;
    intentUncertainSeq = 0;
    intentRefreshReadDeadlineMs = INTENT_REFRESH_READ_DEADLINE_MS;
  },
  /** Test seam: shrink the finite read deadline so bounded recovery stays fast. */
  setIntentRefreshReadDeadlineForTests(milliseconds: number): void {
    intentRefreshReadDeadlineMs = Number.isSafeInteger(milliseconds) && milliseconds > 0
      ? milliseconds
      : INTENT_REFRESH_READ_DEADLINE_MS;
  },
  /** Test seam: number of completed intent-refresh passes in this module copy. */
  ownedActivityIntentRefreshPassCount(): number {
    return intentRefreshPassesRun;
  },
  /**
   * Test seam: await any in-flight or scheduled intent-refresh pass (bounded,
   * so a test cannot hang on a foreign scheduling loop).
   */
  async settleOwnedActivityIntentRefreshForTests(): Promise<void> {
    for (let i = 0; i < 16; i++) {
      const active = intentRefreshActive;
      if (active !== undefined) { await active.settled; continue; }
      if (intentRefreshScheduled) { await new Promise((resolve) => setImmediate(resolve)); continue; }
      return;
    }
  },
  /**
   * Test seam: deliberately mark the current incarnation of one expected
   * source intent-uncertain through the same mutation path as a real handle,
   * simulating registry telemetry that diverged from the source's own state.
   */
  markCurrentSourceIntentUncertainForTests(category: string, source: string): boolean {
    const state = registryState(false);
    if (!state?.active || !isCategory(category) || !isExpectedSource(category, source)) return false;
    let changed = false;
    for (const entry of state.sources.get(category)?.get(source) ?? []) {
      if (entry.retired || entry.intentTokens === undefined) continue;
      if (markEntryIntentUncertain(entry)) {
        entry.revision = (entry.revision ?? 0) + 1;
        bumpIntentGeneration(entry);
        bumpIntentAuthority(entry);
        noteIntentRefreshSupersession();
        changed = true;
      }
    }
    if (changed) {
      notify(state);
      scheduleOwnedActivityIntentRefresh();
    }
    return changed;
  },
  EXPECTED_SOURCES,
  MAX_OWNED_TOKEN_LENGTH,
});
