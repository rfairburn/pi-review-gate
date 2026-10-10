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
  /** Legacy field retained for reload compatibility; it does not gate retries. */
  reconciliationAttempted?: boolean;
  /** True only while this exact incarnation's retired census is in flight. */
  reconciliationInFlight?: boolean;
  /** Changed on any same-incarnation mutation; fences stale async reads. */
  revision?: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
          if (entry.reconciliationAttempted !== undefined && typeof entry.reconciliationAttempted !== "boolean") return false;
          if (entry.reconciliationInFlight !== undefined && typeof entry.reconciliationInFlight !== "boolean") return false;
          if (entry.revision !== undefined && (typeof entry.revision !== "number"
            || !Number.isSafeInteger(entry.revision) || entry.revision < 0)) return false;
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
      intentUncertain: options?.intentUncertain === true,
      ...(options?.reconcileRetired ? { reconcileRetired: options.reconcileRetired } : {}),
      reconciliationInFlight: false,
      revision: 0,
    };
    list.push(entry);
  } else {
    if (options?.uncertain === true) entry.uncertain = true;
    // Never fabricate intent data for a pre-intent entry: its activity set was
    // never observed, so it stays unknown rather than becoming a known zero.
    if (entry.intentTokens !== undefined && options?.intentUncertain === true) entry.intentUncertain = true;
    if (options?.reconcileRetired) entry.reconcileRetired = options.reconcileRetired;
  }
  // A newly installed incarnation supersedes every older one, but the
  // superseded incarnation's tokens AND uncertainty stay retained until that
  // incarnation itself resolves or releases them.
  for (const other of list) {
    if (other !== entry) {
      other.retired = true;
      other.revision = (other.revision ?? 0) + 1;
    }
  }
  entry.revision = (entry.revision ?? 0) + 1;
  if (options?.resync) {
    // A throwing resync leaves ownership unaccounted for: sticky unknown.
    try {
      options.resync();
    } catch {
      entry.uncertain = true;
    }
  }
  notify(state);
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
  // Replay source registrations made while the registry was still inert.
  for (const registration of pendingRegistrations.splice(0)) {
    installRegistration(state, registration.handle, registration.options);
  }
  if (!wasActive) notify(state);
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
  ): void => {
    const state = registryState(false);
    if (!state || !state.active) return;
    const entry = findIncarnation(state, category, source, incarnation);
    if (!entry) return; // not installed: no observation
    if (mutate(state, entry)) {
      entry.revision = (entry.revision ?? 0) + 1;
      notify(state);
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
    if (!entry || entry.intentTokens === undefined) return;
    if (mutate(state, entry)) {
      entry.revision = (entry.revision ?? 0) + 1;
      notify(state);
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
      withIntentEntry((_state, entry) => {
        if (entry.intentUncertain === true) return false;
        entry.intentUncertain = true;
        return true;
      });
    },
    resolveIntentUncertainty(): void {
      withIntentEntry((_state, entry) => {
        if (entry.intentUncertain !== true) return false;
        entry.intentUncertain = false;
        return true;
      });
    },
    retire(): void {
      withEntry((_state, entry) => {
        if (entry.retired) return false;
        entry.retired = true;
        return true;
      });
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
    const existing = pendingRegistrations.findIndex((entry) =>
      entry.handle.category === category && entry.handle.source === source);
    const registration: PendingRegistration = {
      handle,
      // Neither channel's pre-opt-in acquisitions were observed: both replay
      // as uncertain until the source authoritatively resolves them.
      options: { ...options, uncertain: true, intentUncertain: true },
    };
    if (existing >= 0) pendingRegistrations[existing] = registration;
    else pendingRegistrations.push(registration);
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
): boolean {
  if (!tokens) return false; // Legacy pre-intent entries remain unknown without invented history.
  const markUnknown = (): boolean => {
    if (isUncertain()) return false;
    setUncertain(true);
    entry.revision = (entry.revision ?? 0) + 1;
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
    entry.revision = (entry.revision ?? 0) + 1;
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
        () => entry.uncertain, (uncertain) => { entry.uncertain = uncertain; }) || changed;
      // Never fabricate independent activity history for a legacy record.
      if (entry.intentTokens !== undefined) {
        changed = applyRetiredChannel(entry, intent, entry.intentTokens,
          () => entry.intentUncertain === true, (uncertain) => { entry.intentUncertain = uncertain; }) || changed;
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
  },
  EXPECTED_SOURCES,
  MAX_OWNED_TOKEN_LENGTH,
});
