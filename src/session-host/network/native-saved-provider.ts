/**
 * Native owner Saved catalog view (optional Saved window phase).
 *
 * One {@link OwnerSavedCatalogView} over the owner's EXISTING branded native
 * Saved paths: `listSavedSessions` (under this view's own freshness scope),
 * `searchSavedSessions` (the exact native matcher), the owning-host service's
 * `validateSavedConversationDeletion` (non-mutating delete preparation only),
 * and its guarded mutation primitives `startSavedConversation` and
 * `deleteSavedConversation`. Nothing here re-implements listing, search,
 * filtering, ordering, admission, deletion validation, launch, or trash/unlink.
 *
 * Importing this module reads, writes, and starts nothing. Creating a view
 * mints one in-memory freshness scope and nothing else: no listing, callback,
 * timer, store, manager, history, cache, lease, or queue. The roster bridge
 * creates at most one view per channel binding, lazily, and disposes it with
 * that binding.
 *
 * Boundaries:
 *
 * - The view holds ONE current native catalog and ONE immutable result array.
 *   `list` replaces both; `search` (exact current catalog id) replaces the
 *   result only; `window` slices the SAME result. Catalog, result, and entry
 *   ids are random opaque identifiers minted here and never derived from a
 *   file, path, or row. Entry ids are minted lazily per result index the first
 *   time a window exposes it and stay stable for that result.
 * - Entries carry exactly the native row's `id`, `file`, `caption`, and `cwd`,
 *   unchanged. `projectDir`, dates, issues, the search text, and the catalog
 *   itself never leave this module. A display string is never request
 *   authority: Resume and Delete resolve only an exact run + catalog + result
 *   + entry id back to the owner's own branded row.
 * - Owner run: captured on the first authorized operation and compared on
 *   every operation and after every injected callback. Ordinary inventory
 *   revisions and row changes are not Saved authority, and nothing reads a
 *   viewer's focus, selection, geometry, or native conversation tuple.
 * - `stillAuthorized` is the bridge's synchronous re-proof (transport, grant,
 *   channel, exact run, and for delete the live server delete policy). Reads
 *   and the delete preparation check it after their callbacks. Resume and
 *   confirmed Delete hand ONE authorization closure to the service's guarded
 *   primitive, which calls it as its final caller check and then performs only
 *   its own non-reentrant native identity/live validation and the handoff or
 *   mutation (Delete repeats that boundary before trash AND before the unlink
 *   fallback). The closure does in-memory checks of this view's target, the
 *   active operation, and the captured run, then exactly one guard call, then
 *   the in-memory checks again: it never reads the inventory or calls a native
 *   validator, so nothing injected runs between authorization and mutation.
 * - Reads are fenced by a read-slot generation and the caller's abort signal;
 *   a superseded or aborted read never commits. Abort retires reads only and
 *   never cancels an accepted resume or delete, and `dispose()` releases read
 *   and prepared state only.
 * - A refusal is reported only when it was positively decided before any
 *   native handoff (resume) or mutation stage (delete). After that, failure or
 *   loss is `unconfirmed`/`unknown`; a completed outcome is reported truthfully
 *   even if the view or policy changed afterward. No raw error, refusal text,
 *   or payload is ever returned.
 */

import { randomUUID } from "node:crypto";

import type { OwningHostInventorySnapshot } from "../owning-host-service";
import {
  createSavedCatalogFreshnessScope,
  isSavedSessionCatalog,
  listSavedSessions,
  searchSavedSessions,
  type ListSavedSessionsOptions,
  type SavedSessionCatalog,
  type SavedSessionDeletionRefusalReason,
  type SavedSessionRow,
} from "../saved-sessions";
import {
  isOwnerSavedIdentifier,
  isOwnerSavedQuery,
  isOwnerSavedScalar,
  isOwnerSavedText,
  type OwnerSavedAuthorizationGuard,
  type OwnerSavedCatalogView,
  type OwnerSavedDeleteFacts,
  type OwnerSavedDeleteRefusalReason,
  type OwnerSavedDeleteRequest,
  type OwnerSavedEntry,
  type OwnerSavedListRequest,
  type OwnerSavedResumeFacts,
  type OwnerSavedResumeRefusalReason,
  type OwnerSavedResumeRequest,
  type OwnerSavedSearchRequest,
  type OwnerSavedWindowFacts,
  type OwnerSavedWindowRefusalReason,
  type OwnerSavedWindowRequest,
} from "./peer-saved";

/**
 * The caller authorization a guarded owner primitive calls as its final caller
 * check (structurally the service's `SavedMutationAuthorization`).
 */
export type NativeSavedMutationAuthorization = () => boolean;

/**
 * The closed facts of one guarded native Resume, read structurally (the
 * service's `GuardedSavedResumeResult`): `refused` is decided before any
 * handoff; every other status follows an actual handoff.
 */
export type NativeSavedResumeAnswer =
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "started"; readonly id: string }
  | { readonly status: "not-ready" | "failed" | "duplicate" | "unknown" };

/**
 * The closed facts of one guarded native Delete, read structurally (the
 * service's `GuardedSavedDeletionResult`): `refused` is decided before any
 * trash or unlink was invoked.
 */
export type NativeSavedDeletionAnswer =
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "deleted"; readonly method: "trash" | "unlink" }
  | {
    readonly status: "unconfirmed";
    readonly trashInvoked: boolean;
    readonly unlinkInvoked: boolean;
    readonly fallbackRefusal?: string;
  }
  | { readonly status: "unknown" };

/**
 * The only owning-host service operations this view uses, structurally:
 * `OwningHostService` satisfies it. The two guarded primitives own the final
 * authorization -> native validation -> handoff/mutation ordering.
 */
export interface NativeSavedCatalogHost {
  readInventorySnapshot(): OwningHostInventorySnapshot | undefined;
  /** Non-mutating native deletion preflight, used only to PREPARE a delete. */
  validateSavedConversationDeletion(
    catalog: SavedSessionCatalog,
    row: SavedSessionRow,
  ): SavedSessionDeletionRefusalReason | undefined;
  startSavedConversation(
    catalog: SavedSessionCatalog,
    row: SavedSessionRow,
    authorize: NativeSavedMutationAuthorization,
  ): Promise<NativeSavedResumeAnswer>;
  deleteSavedConversation(
    catalog: SavedSessionCatalog,
    row: SavedSessionRow,
    authorize: NativeSavedMutationAuthorization,
  ): NativeSavedDeletionAnswer;
}

/**
 * The owner's current native listing inputs (agent directory, resolved public
 * Pi SDK path, expected version). The view always supplies its own signal and
 * freshness scope.
 */
export type NativeSavedCatalogReadOptions = Omit<ListSavedSessionsOptions, "signal" | "freshnessScope">;

export interface NativeSavedCatalogViewOptions {
  /** The owner's ONE existing owning-host service. */
  readonly host: NativeSavedCatalogHost;
  /**
   * The current owner-native listing inputs, read at every `list`. `undefined`
   * means Saved is unavailable right now; nothing is repaired, created, or
   * migrated on its behalf.
   */
  readonly readCatalogOptions: () => NativeSavedCatalogReadOptions | undefined;
  /** Test seam; defaults to the production `listSavedSessions`. */
  readonly listCatalog?: typeof listSavedSessions;
}

/** One immutable result over the current catalog, with lazily minted entry ids. */
interface ResultState {
  readonly resultId: string;
  readonly rows: readonly SavedSessionRow[];
  readonly idsByIndex: Map<number, string>;
  readonly rowsById: Map<string, SavedSessionRow>;
}

/** The view's one current native catalog and its one current result. */
interface CatalogState {
  readonly catalogId: string;
  readonly catalog: SavedSessionCatalog;
  result: ResultState;
}

/** One exact entry of the current catalog/result, resolved by opaque ids only. */
interface EntryTarget {
  readonly state: CatalogState;
  readonly result: ResultState;
  readonly entryId: string;
  readonly row: SavedSessionRow;
}

/** Outcome of one run + authorization proof. */
type Proof = "ok" | "retired" | "unobservable" | "stale" | "unauthorized";

/**
 * Why the most recent call of one guarded authorization closure said no:
 * `memory` = this view's own target/operation/run no longer held; `guard` =
 * the caller's guard refused. Used only to choose an honest coarse reason.
 */
interface AuthorizationRecord {
  calls: number;
  lastRefusal: "memory" | "guard" | undefined;
}

const UNAVAILABLE: OwnerSavedWindowFacts = Object.freeze({ kind: "unavailable" as const });
const WINDOW_UNKNOWN: OwnerSavedWindowFacts = Object.freeze({ kind: "unknown" as const });
const RESUME_UNKNOWN: OwnerSavedResumeFacts = Object.freeze({ kind: "unknown" as const });
const RESUME_UNCONFIRMED: OwnerSavedResumeFacts = Object.freeze({ kind: "unconfirmed" as const });
const DELETE_UNKNOWN: OwnerSavedDeleteFacts = Object.freeze({ kind: "unknown" as const });
const DELETE_UNCONFIRMED: OwnerSavedDeleteFacts = Object.freeze({ kind: "unconfirmed" as const });
const CONFIRMATION_REQUIRED: OwnerSavedDeleteFacts = Object.freeze({ kind: "confirmation-required" as const });

function windowRefused(reason: OwnerSavedWindowRefusalReason): OwnerSavedWindowFacts {
  return Object.freeze({ kind: "refused" as const, reason });
}

function resumeRefused(reason: OwnerSavedResumeRefusalReason): OwnerSavedResumeFacts {
  return Object.freeze({ kind: "refused" as const, reason });
}

function deleteRefused(reason: OwnerSavedDeleteRefusalReason): OwnerSavedDeleteFacts {
  return Object.freeze({ kind: "refused" as const, reason });
}

function mintId(): string {
  return randomUUID();
}

/** A bounded window position: a safe offset and a positive safe count. */
function isWindowRange(offset: unknown, count: unknown): boolean {
  return isOwnerSavedScalar(offset) && isOwnerSavedScalar(count) && count >= 1;
}

/**
 * Existing native admission reasons mapped onto the fixed coarse resume
 * reasons. `not-authorized` and `unavailable` are handled by the caller.
 */
function resumeReasonFor(reason: unknown): OwnerSavedResumeRefusalReason {
  if (reason === "stale-catalog" || reason === "unknown-row") return "stale";
  if (reason === "known-owned-duplicate") return "duplicate";
  return "admission";
}

/** Existing native deletion reasons mapped onto the fixed coarse delete reasons. */
function deleteReasonFor(reason: unknown): OwnerSavedDeleteRefusalReason {
  if (reason === "stale-catalog" || reason === "unknown-row") return "stale";
  if (reason === "known-owned-duplicate" || reason === "unknown-live-binding") return "active";
  return "admission";
}

/**
 * Create one owner Saved catalog view over the existing native Saved APIs.
 * Construction mints this view's freshness scope and performs no read, write,
 * listing, or callback.
 */
export function createNativeSavedCatalogView(options: NativeSavedCatalogViewOptions): OwnerSavedCatalogView {
  const host = options.host;
  const readCatalogOptions = options.readCatalogOptions;
  const listCatalog = options.listCatalog ?? listSavedSessions;
  /** This view's own freshness domain: other views and the local picker never supersede it. */
  const scope = createSavedCatalogFreshnessScope();

  let disposed = false;
  /** The exact owner run this view is bound to, captured on its first authorized operation. */
  let ownerRun: string | undefined;
  /** Read-slot generation: bumped by every read, a run change, and dispose. */
  let generation = 0;
  /** The one in-flight native listing's own abort controller, if any. */
  let inflight: AbortController | undefined;
  let current: CatalogState | undefined;
  /** The ONE prepared delete target (exact catalog/result/entry/row), if any. */
  let prepared: EntryTarget | undefined;
  /** Token of the one delete whose native mutation stages are in progress. */
  let activeDelete: object | undefined;

  function abortInflight(): void {
    const controller = inflight;
    inflight = undefined;
    if (controller === undefined) return;
    try {
      controller.abort();
    } catch {
      // Abort listener failures change nothing here.
    }
  }

  /** Forget the current catalog, its result, and any preparation. */
  function clearCatalog(): void {
    current = undefined;
    prepared = undefined;
  }

  /** Take the read slot: an older read can no longer commit. */
  function takeReadSlot(): number {
    generation += 1;
    const mine = generation;
    abortInflight();
    return mine;
  }

  function readStillCurrent(mine: number, signal: AbortSignal): boolean {
    return !disposed && generation === mine && signal?.aborted !== true;
  }

  /**
   * One fresh read of the owner service's current run, compared with the run
   * the request names and the run this view captured. A different service run
   * retires everything this view minted.
   */
  function checkRun(hostRunId: string): Proof {
    if (disposed) return "retired";
    let observedRun: unknown;
    try {
      observedRun = host.readInventorySnapshot()?.hostRunId;
    } catch {
      observedRun = undefined;
    }
    if (disposed) return "retired";
    if (typeof observedRun !== "string") return "unobservable";
    if (ownerRun !== undefined && observedRun !== ownerRun) {
      // The owner run this view was bound to is gone: nothing it minted is current.
      generation += 1;
      abortInflight();
      clearCatalog();
      return "stale";
    }
    if (observedRun !== hostRunId) return "stale";
    return "ok";
  }

  /** The injected guard, contained: `true` only for a literal true answer. */
  function callGuard(guard: OwnerSavedAuthorizationGuard): boolean {
    try {
      return guard() === true;
    } catch {
      return false;
    }
  }

  /**
   * Prove the exact owner run and the caller's authorization. The guard is
   * arbitrary owner code that can reenter, so the service run is read before it
   * AND again after it; only synchronous state checks follow that last read.
   */
  function prove(hostRunId: string, guard: OwnerSavedAuthorizationGuard): Proof {
    const before = checkRun(hostRunId);
    if (before !== "ok") return before;
    const authorized = callGuard(guard);
    if (disposed) return "retired";
    if (!authorized) return "unauthorized";
    const after = checkRun(hostRunId);
    if (after !== "ok") return after;
    if (ownerRun === undefined) ownerRun = hostRunId;
    return ownerRun === hostRunId ? "ok" : "stale";
  }

  function readProofFacts(proof: Exclude<Proof, "ok">): OwnerSavedWindowFacts {
    if (proof === "unobservable") return UNAVAILABLE;
    if (proof === "unauthorized") return windowRefused("admission");
    return windowRefused("stale");
  }

  function resumeProofFacts(proof: Exclude<Proof, "ok">): OwnerSavedResumeFacts {
    if (proof === "unobservable") return RESUME_UNKNOWN;
    if (proof === "unauthorized") return resumeRefused("admission");
    return resumeRefused("stale");
  }

  function deleteProofFacts(proof: Exclude<Proof, "ok">): OwnerSavedDeleteFacts {
    if (proof === "unobservable") return DELETE_UNKNOWN;
    if (proof === "unauthorized") return deleteRefused("policy");
    return deleteRefused("stale");
  }

  /** Re-prove a read after an injected callback; undefined means it may continue. */
  function reproveRead(
    mine: number,
    signal: AbortSignal,
    hostRunId: string,
    guard: OwnerSavedAuthorizationGuard,
  ): OwnerSavedWindowFacts | undefined {
    if (!readStillCurrent(mine, signal)) return windowRefused("stale");
    const proof = prove(hostRunId, guard);
    if (proof !== "ok") return readProofFacts(proof);
    if (!readStillCurrent(mine, signal)) return windowRefused("stale");
    return undefined;
  }

  function newResult(rows: readonly SavedSessionRow[]): ResultState {
    return {
      resultId: mintId(),
      rows,
      idsByIndex: new Map<number, string>(),
      rowsById: new Map<string, SavedSessionRow>(),
    };
  }

  /** The stable entry id of one result position, minted the first time it is exposed. */
  function entryIdFor(result: ResultState, index: number, row: SavedSessionRow): string {
    const existing = result.idsByIndex.get(index);
    if (existing !== undefined) return existing;
    const entryId = mintId();
    result.idsByIndex.set(index, entryId);
    result.rowsById.set(entryId, row);
    return entryId;
  }

  /**
   * One honest contiguous window of the SAME immutable result: exactly
   * `min(count, total - offset)` entries from `offset`, or a fixed refusal.
   * Nothing is allocated from the total, and no row is skipped.
   */
  function windowOf(state: CatalogState, result: ResultState, offset: number, count: number): OwnerSavedWindowFacts {
    const total = result.rows.length;
    if (offset > total) return windowRefused("range");
    const issueCount = state.catalog.issueCount;
    const run = ownerRun;
    if (run === undefined || !isOwnerSavedScalar(issueCount)) return UNAVAILABLE;
    const end = offset + Math.min(count, total - offset);
    // Validate every row of the window before minting anything: a row whose
    // native strings cannot cross the JSON wire refuses the whole window rather
    // than being clipped, hidden, or silently dropped.
    for (let index = offset; index < end; index += 1) {
      const row = result.rows[index];
      if (row === undefined
        || !isOwnerSavedText(row.id)
        || !isOwnerSavedText(row.file)
        || !isOwnerSavedText(row.caption)
        || !isOwnerSavedText(row.cwd)) {
        return windowRefused("unrepresentable");
      }
    }
    const entries: OwnerSavedEntry[] = [];
    for (let index = offset; index < end; index += 1) {
      const row = result.rows[index]!;
      entries.push(Object.freeze({
        entryId: entryIdFor(result, index, row),
        sessionId: row.id,
        file: row.file,
        caption: row.caption,
        cwd: row.cwd,
      }));
    }
    return Object.freeze({
      kind: "window" as const,
      hostRunId: run,
      catalogId: state.catalogId,
      resultId: result.resultId,
      total,
      issueCount,
      offset,
      entries: Object.freeze(entries),
    });
  }

  function lookup(catalogId: string, resultId: string, entryId: string): EntryTarget | undefined {
    const state = current;
    if (state === undefined || state.catalogId !== catalogId) return undefined;
    const result = state.result;
    if (result.resultId !== resultId) return undefined;
    const row = result.rowsById.get(entryId);
    if (row === undefined) return undefined;
    return { state, result, entryId, row };
  }

  /** The target is still exactly the view's current catalog/result/entry/row. */
  function sameTarget(target: EntryTarget): boolean {
    return !disposed
      && current === target.state
      && target.state.result === target.result
      && target.result.rowsById.get(target.entryId) === target.row;
  }

  async function listImpl(
    request: OwnerSavedListRequest,
    signal: AbortSignal,
    guard: OwnerSavedAuthorizationGuard,
  ): Promise<OwnerSavedWindowFacts> {
    const { hostRunId, query, offset, count } = request;
    if (disposed) return UNAVAILABLE;
    if (!isOwnerSavedIdentifier(hostRunId)) return windowRefused("stale");
    if (!isOwnerSavedQuery(query)) return windowRefused("unrepresentable");
    if (!isWindowRange(offset, count)) return windowRefused("range");
    const mine = takeReadSlot();
    const initial = reproveRead(mine, signal, hostRunId, guard);
    if (initial !== undefined) return initial;
    // A fresh listing replaces this view's catalog and result.
    clearCatalog();

    let catalogOptions: NativeSavedCatalogReadOptions | undefined;
    let optionsUnavailable = false;
    try {
      catalogOptions = readCatalogOptions();
    } catch {
      optionsUnavailable = true;
    }
    const afterOptions = reproveRead(mine, signal, hostRunId, guard);
    if (afterOptions !== undefined) return afterOptions;
    if (optionsUnavailable || catalogOptions === undefined
      || typeof catalogOptions !== "object" || catalogOptions === null) {
      return UNAVAILABLE;
    }

    const controller = new AbortController();
    inflight = controller;
    const onAbort = (): void => {
      try {
        controller.abort();
      } catch {
        // Abort listener failures change nothing here.
      }
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    let catalog: SavedSessionCatalog | undefined;
    try {
      if (signal?.aborted === true) controller.abort();
      // This view's own freshness scope and read signal always win over any
      // value the options callback happened to carry.
      catalog = await listCatalog({ ...catalogOptions, signal: controller.signal, freshnessScope: scope });
    } catch {
      catalog = undefined;
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
      if (inflight === controller) inflight = undefined;
    }
    const afterList = reproveRead(mine, signal, hostRunId, guard);
    if (afterList !== undefined) return afterList;
    if (catalog === undefined || !isSavedSessionCatalog(catalog)) return UNAVAILABLE;

    const rows = searchSavedSessions(catalog, query);
    if (offset > rows.length) return windowRefused("range");
    const state: CatalogState = { catalogId: mintId(), catalog, result: newResult(rows) };
    current = state;
    return windowOf(state, state.result, offset, count);
  }

  async function searchImpl(
    request: OwnerSavedSearchRequest,
    signal: AbortSignal,
    guard: OwnerSavedAuthorizationGuard,
  ): Promise<OwnerSavedWindowFacts> {
    const { hostRunId, catalogId, query, offset, count } = request;
    if (disposed) return UNAVAILABLE;
    if (!isOwnerSavedIdentifier(hostRunId) || !isOwnerSavedIdentifier(catalogId)) return windowRefused("stale");
    if (!isOwnerSavedQuery(query)) return windowRefused("unrepresentable");
    if (!isWindowRange(offset, count)) return windowRefused("range");
    const mine = takeReadSlot();
    const proof = reproveRead(mine, signal, hostRunId, guard);
    if (proof !== undefined) return proof;
    const state = current;
    if (state === undefined || state.catalogId !== catalogId) return windowRefused("stale");
    const rows = searchSavedSessions(state.catalog, query);
    if (offset > rows.length) return windowRefused("range");
    // The result is replaced; the catalog is kept, and a preparation over the
    // old result is no longer current.
    const result = newResult(rows);
    state.result = result;
    prepared = undefined;
    return windowOf(state, result, offset, count);
  }

  async function windowImpl(
    request: OwnerSavedWindowRequest,
    signal: AbortSignal,
    guard: OwnerSavedAuthorizationGuard,
  ): Promise<OwnerSavedWindowFacts> {
    const { hostRunId, catalogId, resultId, offset, count } = request;
    if (disposed) return UNAVAILABLE;
    if (!isOwnerSavedIdentifier(hostRunId)
      || !isOwnerSavedIdentifier(catalogId)
      || !isOwnerSavedIdentifier(resultId)) return windowRefused("stale");
    if (!isWindowRange(offset, count)) return windowRefused("range");
    const mine = takeReadSlot();
    const proof = reproveRead(mine, signal, hostRunId, guard);
    if (proof !== undefined) return proof;
    const state = current;
    if (state === undefined || state.catalogId !== catalogId || state.result.resultId !== resultId) {
      return windowRefused("stale");
    }
    // Never relists, never re-searches, never remints: a slice of the same result.
    return windowOf(state, state.result, offset, count);
  }

  async function resumeImpl(
    request: OwnerSavedResumeRequest,
    guard: OwnerSavedAuthorizationGuard,
  ): Promise<OwnerSavedResumeFacts> {
    const { hostRunId, catalogId, resultId, entryId } = request;
    if (disposed) return resumeRefused("stale");
    if (!isOwnerSavedIdentifier(hostRunId)
      || !isOwnerSavedIdentifier(catalogId)
      || !isOwnerSavedIdentifier(resultId)
      || !isOwnerSavedIdentifier(entryId)) return resumeRefused("stale");
    const first = prove(hostRunId, guard);
    if (first !== "ok") return resumeProofFacts(first);
    const target = lookup(catalogId, resultId, entryId);
    if (target === undefined) return resumeRefused("stale");

    const runAtHandoff = ownerRun;
    if (runAtHandoff === undefined || runAtHandoff !== hostRunId) return resumeRefused("stale");

    // ONE guarded native Resume. The service calls `authorize` as its final
    // caller check and then performs only its own native admission (header,
    // workspace, file dev/ino, canonical root, owned-live/reservation fences)
    // and the handoff, with nothing injected in between.
    const record: AuthorizationRecord = { calls: 0, lastRefusal: undefined };
    const authorize = guardedAuthorization(
      () => sameTarget(target) && ownerRun === runAtHandoff,
      record,
      guard,
    );
    let answer: NativeSavedResumeAnswer;
    try {
      answer = await host.startSavedConversation(target.state.catalog, target.row, authorize);
    } catch {
      return RESUME_UNKNOWN;
    }
    if (answer === null || typeof answer !== "object") return RESUME_UNKNOWN;
    switch (answer.status) {
      case "refused":
        // Decided by the primitive before any handoff: a positive refusal.
        if (answer.reason === "not-authorized") {
          return resumeRefused(record.lastRefusal === "memory" ? "stale" : "admission");
        }
        return resumeRefused(answer.reason === "unavailable" ? "admission" : resumeReasonFor(answer.reason));
      case "started":
        // The actual start, reported for the run this request was proved in,
        // even if the view, the guard, or the policy changed afterward.
        return isOwnerSavedIdentifier(answer.id)
          ? Object.freeze({ kind: "started" as const, hostRunId: runAtHandoff, rowId: answer.id })
          : RESUME_UNKNOWN;
      case "not-ready":
      case "failed":
      case "duplicate":
        // After the handoff: addressed, nothing usable came up. Never a refusal.
        return RESUME_UNCONFIRMED;
      default:
        return RESUME_UNKNOWN;
    }
  }

  /**
   * The ONE authorization closure handed to a guarded primitive: in-memory
   * checks of this view's exact target, active operation, and captured run,
   * exactly one guard call, then the in-memory checks again. It never reads the
   * inventory or calls a native validator, so the primitive's own native checks
   * and mutation follow it with nothing injected in between.
   */
  function guardedAuthorization(
    stillOurs: () => boolean,
    record: AuthorizationRecord,
    guard: OwnerSavedAuthorizationGuard,
  ): NativeSavedMutationAuthorization {
    return (): boolean => {
      record.calls += 1;
      if (!stillOurs()) {
        record.lastRefusal = "memory";
        return false;
      }
      const authorized = callGuard(guard);
      if (!stillOurs()) {
        record.lastRefusal = "memory";
        return false;
      }
      if (!authorized) {
        record.lastRefusal = "guard";
        return false;
      }
      record.lastRefusal = undefined;
      return true;
    };
  }

  /**
   * The owner's current native deletion validation of one exact target
   * (catalog revision, root/project/file, inode, header, owned-live and
   * unknown-live bindings, reservations). Undefined means it passed.
   */
  function nativeDeletionFacts(target: EntryTarget): OwnerSavedDeleteFacts | undefined {
    let reason: SavedSessionDeletionRefusalReason | undefined;
    try {
      reason = host.validateSavedConversationDeletion(target.state.catalog, target.row);
    } catch {
      return deleteRefused("active");
    }
    return reason === undefined ? undefined : deleteRefused(deleteReasonFor(reason));
  }

  async function removeImpl(
    request: OwnerSavedDeleteRequest,
    guard: OwnerSavedAuthorizationGuard,
  ): Promise<OwnerSavedDeleteFacts> {
    const { hostRunId, catalogId, resultId, entryId, confirmed } = request;
    if (typeof confirmed !== "boolean") return deleteRefused("admission");
    // Every delete request retires the one unsubmitted preparation up front: a
    // confirmation can spend it at most once whatever follows, and a new
    // preparation replaces it only on success.
    const preparation = confirmed ? prepared : undefined;
    prepared = undefined;
    if (disposed) return deleteRefused("stale");
    if (!isOwnerSavedIdentifier(hostRunId)
      || !isOwnerSavedIdentifier(catalogId)
      || !isOwnerSavedIdentifier(resultId)
      || !isOwnerSavedIdentifier(entryId)) return deleteRefused("stale");
    const first = prove(hostRunId, guard);
    if (first !== "ok") return deleteProofFacts(first);
    const target = lookup(catalogId, resultId, entryId);
    if (target === undefined) return deleteRefused("stale");

    if (!confirmed) {
      // Preparation only: the owner's current native deletion validation.
      // Nothing is mutated. The guard is re-proved after that callout, and the
      // native validation and run read are repeated after the guard, so a
      // reentrant callback can never prepare a replaced or newly live file.
      const early = nativeDeletionFacts(target);
      if (!sameTarget(target)) return deleteRefused("stale");
      if (early !== undefined) return early;
      const second = prove(hostRunId, guard);
      if (second !== "ok") return deleteProofFacts(second);
      if (!sameTarget(target)) return deleteRefused("stale");
      const native = nativeDeletionFacts(target);
      if (!sameTarget(target)) return deleteRefused("stale");
      if (native !== undefined) return native;
      const finalRun = checkRun(hostRunId);
      if (finalRun !== "ok") return deleteProofFacts(finalRun);
      if (!sameTarget(target)) return deleteRefused("stale");
      // Those native/run callouts can reenter and revoke authority, so the
      // passed guard is checked once more as the LAST callout, followed only by
      // in-memory checks: a preparation is never stored while policy is off.
      // (A file or binding change made by this guard is caught by the guarded
      // Delete primitive's own native checks at confirmation.)
      const authorizedAtStore = callGuard(guard);
      if (!sameTarget(target) || ownerRun !== hostRunId) return deleteRefused("stale");
      if (!authorizedAtStore) return deleteRefused("policy");
      prepared = target;
      return CONFIRMATION_REQUIRED;
    }

    if (preparation === undefined
      || preparation.state !== target.state
      || preparation.result !== target.result
      || preparation.entryId !== target.entryId
      || preparation.row !== target.row) {
      return deleteRefused("stale");
    }

    const runAtMutation = ownerRun;
    if (runAtMutation === undefined || runAtMutation !== hostRunId) return deleteRefused("stale");

    // ONE guarded native Delete. The service calls `authorize` as its final
    // caller check before EACH mutation stage (trash, then the unlink fallback)
    // and follows it only with its own native file/header/inode/root/live/
    // reservation validation and that stage's mutation. This view's own active
    // operation token keeps the consumed preparation's authority alive across
    // both stages and nowhere else.
    const operation = {};
    activeDelete = operation;
    const record: AuthorizationRecord = { calls: 0, lastRefusal: undefined };
    const authorize = guardedAuthorization(
      () => activeDelete === operation && sameTarget(target) && ownerRun === runAtMutation,
      record,
      guard,
    );
    let answer: NativeSavedDeletionAnswer | undefined;
    try {
      answer = host.deleteSavedConversation(target.state.catalog, target.row, authorize);
    } catch {
      answer = undefined;
    }
    if (activeDelete === operation) activeDelete = undefined;

    if (answer !== undefined && answer !== null && typeof answer === "object" && answer.status === "refused") {
      // Decided by the primitive before trash or unlink was invoked.
      if (answer.reason === "not-authorized") {
        return deleteRefused(record.lastRefusal === "memory" ? "stale" : "policy");
      }
      return deleteRefused(answer.reason === "unavailable" ? "admission" : deleteReasonFor(answer.reason));
    }
    // A mutation stage may have run: the old operation authority is retired,
    // and the owner's caller issues a fresh listing explicitly.
    if (current === target.state) clearCatalog();
    if (answer === undefined || answer === null || typeof answer !== "object") return DELETE_UNKNOWN;
    if (answer.status === "deleted" && (answer.method === "trash" || answer.method === "unlink")) {
      // The actual outcome, even if the policy turned off or the view retired afterward.
      return Object.freeze({ kind: "deleted" as const, method: answer.method });
    }
    // Trash (and possibly unlink) may have been invoked and could not be
    // confirmed: never reported as a refusal or as no change.
    if (answer.status === "unconfirmed") return DELETE_UNCONFIRMED;
    return DELETE_UNKNOWN;
  }

  return Object.freeze({
    async list(request: OwnerSavedListRequest, signal: AbortSignal, stillAuthorized: OwnerSavedAuthorizationGuard) {
      try {
        return await listImpl(request, signal, stillAuthorized);
      } catch {
        return WINDOW_UNKNOWN;
      }
    },
    async search(request: OwnerSavedSearchRequest, signal: AbortSignal, stillAuthorized: OwnerSavedAuthorizationGuard) {
      try {
        return await searchImpl(request, signal, stillAuthorized);
      } catch {
        return WINDOW_UNKNOWN;
      }
    },
    async window(request: OwnerSavedWindowRequest, signal: AbortSignal, stillAuthorized: OwnerSavedAuthorizationGuard) {
      try {
        return await windowImpl(request, signal, stillAuthorized);
      } catch {
        return WINDOW_UNKNOWN;
      }
    },
    async resume(request: OwnerSavedResumeRequest, stillAuthorized: OwnerSavedAuthorizationGuard) {
      try {
        return await resumeImpl(request, stillAuthorized);
      } catch {
        return RESUME_UNKNOWN;
      }
    },
    async remove(request: OwnerSavedDeleteRequest, stillAuthorized: OwnerSavedAuthorizationGuard) {
      try {
        return await removeImpl(request, stillAuthorized);
      } catch {
        return DELETE_UNKNOWN;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      abortInflight();
      clearCatalog();
    },
  });
}
