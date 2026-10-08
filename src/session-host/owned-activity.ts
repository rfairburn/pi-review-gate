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
 *   until that incarnation itself resolves or releases them, so an old source
 *   settling or a newer empty source registering leaves the current ownership
 *   positive or unknown rather than zero.
 * - Registrations made before opt-in are replayed as uncertain: lifecycle
 *   acquisitions before activation were never observed, so an empty replay
 *   cannot establish an empty owned set. The source must authoritatively resolve
 *   it (for example after its own restore/resync).
 * - The snapshot is process-local and reload-durable: the state object is
 *   stored on a `globalThis` symbol, so a reporter reload (same native
 *   process) observes the same registrations and outstanding tokens. The wire
 *   generation/sequence fences remain owned by the reporter and protocol.
 * - Tokens are opaque bounded strings that never carry labels, commands,
 *   paths, arguments, or transcripts; only their positive count is exposed.
 * - A throwing listener is contained; observation failures can never break a
 *   job, task, review, or native call.
 */

import { randomUUID } from "node:crypto";

/** The two independently tracked categories published on the status frame. */
export type OwnedActivityCategory = "backgroundTasks" | "backgroundShells";

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
  /** Supersede this incarnation explicitly (tokens stay owned). */
  retire(): void;
}

/** Registration options for one source incarnation. */
export interface OwnedActivitySourceOptions {
  /**
   * Initial completeness state. True for a source whose owned set is not yet
   * authoritatively accounted for (for example work still being restored).
   */
  uncertain?: boolean;
  /**
   * Re-acquire the tokens of still-unsettled work when this registration lands
   * after activity. It must never release tokens, because only an actual
   * settlement event may do that.
   */
  resync?: () => void;
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
    entry = { id: handle.incarnation, tokens: new Set(), uncertain: options?.uncertain === true, retired: false };
    list.push(entry);
  } else if (options?.uncertain === true) {
    entry.uncertain = true;
  }
  // A newly installed incarnation supersedes every older one, but the
  // superseded incarnation's tokens AND uncertainty stay retained until that
  // incarnation itself resolves or releases them.
  for (const other of list) {
    if (other !== entry) other.retired = true;
  }
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
    if (mutate(state, entry)) notify(state);
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
      options: { ...options, uncertain: true },
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

/** Event-driven subscription; returns a no-op unsubscriber while the registry is inert. */
export function subscribeOwnedActivity(listener: () => void): () => void {
  const state = registryState(false);
  if (!state || !state.active || typeof listener !== "function") return () => undefined;
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
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
