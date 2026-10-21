import { randomUUID } from "node:crypto";
import {
  isValidNativeSessionId,
  type SessionSpawnInput,
  type SessionSpawnOutcome,
} from "./protocol";
import type {
  CreateInstanceOptions,
  InstanceManager,
  InstanceManagerOptions,
  NativeInstanceView,
  SessionGeometry,
  SessionViewerState,
  SessionViewerUpdate,
  SessionViewerUpdateResult,
} from "./instances";
import type { NativePersistenceReceipt } from "./native-persistence";
import {
  admitSavedSession,
  validateSavedSessionDeletion,
  type OwnedLiveSession,
  type SavedSessionAdmissionResult,
  type SavedSessionCatalog,
  type SavedSessionDeletionRefusalReason,
  type SavedSessionRow,
} from "./saved-sessions";

/**
 * The local owning-host service boundary (issue #473).
 *
 * This module owns the UI-independent operations an owning session host performs
 * on its authoritative rows: opening the ONE session manager, starting a session
 * and truthfully classifying what actually came up, admitting an authenticated
 * background `SessionSpawn` request, reading the exact row/ownership facts that
 * saved-conversation deletion and exited-row restart depend on, and reporting
 * owned-child settlement evidence at teardown.
 *
 * It is deliberately NOT a second manager, session store, roster, or status
 * mirror. It holds one manager reference and reads every fact through it, so the
 * same manager owns the same session facts before and after this extraction. All
 * presentation stays in the sidebar host: focus, selection, drawn-frame mouse and
 * clipboard authorization, request generations, composition, roster slots, and
 * notices. Nothing here opens a listener, socket, or process of its own, and no
 * input lease or exclusive-controller policy is expressed: local displayed-owner
 * and copy provenance fences remain exactly where they are. Per-session viewer
 * facts (#474) are recorded once — on the manager — and this boundary only forwards
 * the addressed registration, update, and removal, so per-session geometry never
 * becomes a second store here.
 *
 * The inventory snapshot and watch (#478) are a read-only observation of that
 * same manager: a snapshot is one copied read of `list()`, and a watch observes
 * changes through the manager's existing change hook. This module holds no rows
 * of its own, keeps no shadow inventory between reads, adds no polling, no
 * repeating timer, no second listing path, and no network behavior, and never
 * starts, stops, writes, or resizes anything. The only deferred work it performs
 * is a single event-loop continuation that delivers a change it already
 * observed, after a bounded synchronous delivery pass. What crosses a network
 * boundary is decided by that boundary, not here.
 */

/** The one manager shape this host speaks to (the production `InstanceManager`). */
export type OwningHostManager = Pick<InstanceManager,
  | "list" | "surface" | "write" | "resize" | "hasLiveProcesses" | "create" | "rename" | "closeExited" | "shutdown" | "dispose" | "ownedLiveSessions"
  | "openViewer" | "viewerState" | "sessionViewers" | "updateViewer" | "closeViewer" | "instanceGeometry" | "setInitialGeometry"
> & Partial<Pick<InstanceManager, "stop" | "closeError">>;

export type {
  SessionGeometry,
  SessionViewerRefusal,
  SessionViewerState,
  SessionViewerUpdate,
  SessionViewerUpdateResult,
} from "./instances";

/** The manager launch fence's refusal text for an already-owned conversation. */
const DUPLICATE_OWNED_MARKER = "already open in this host";

/** True only for the manager's own known-owned duplicate refusal. */
export function isDuplicateOwnedLaunchFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DUPLICATE_OWNED_MARKER);
}

/**
 * The host's owned live children plus pending saved-session reservations, as
 * deletion-safety data. Historical duplicate evidence does not establish the
 * current binding of a live child whose reporter disconnected or became
 * unavailable, so that case is represented by an entry with no binding at all.
 */
export function savedDeletionOwnedSessions(manager: OwningHostManager): readonly OwnedLiveSession[] {
  const owned = manager.ownedLiveSessions();
  // Historical duplicate evidence does not establish the current binding of
  // a live child whose reporter disconnected or became unavailable.
  return manager.list().some((view) => view.hasLiveProcess && !view.nativeSession)
    ? [...owned, {}]
    : owned;
}

/** Exact deletion preflight for one catalog row, including owned binding data. */
export function validateOwnedSavedSessionDeletion(
  manager: OwningHostManager,
  catalog: SavedSessionCatalog,
  row: SavedSessionRow,
): SavedSessionDeletionRefusalReason | undefined {
  return validateSavedSessionDeletion(catalog, row, { ownedLiveSessions: savedDeletionOwnedSessions(manager) });
}

/**
 * Outcome of one host-initiated start. Every branch is what the host could
 * actually observe; none of them is a retry instruction.
 *
 * - `started`: the manager created a row that is genuinely launch-settled.
 * - `not-ready`: the create call resolved but its row is missing, errored, or
 *   still starting, so nothing usable came up.
 * - `failed`: the manager threw (or the row could not be observed at all).
 * - `duplicate`: the manager refused because the conversation is already open.
 * - `unavailable`: teardown began, or the manager this call started against is
 *   no longer the host's manager. A child may exist; no result is claimed.
 */
export type StartedSessionOutcome =
  | { readonly status: "started"; readonly id: string }
  | { readonly status: "not-ready" }
  | { readonly status: "failed" }
  | { readonly status: "duplicate" }
  | { readonly status: "unavailable" };

/**
 * Owned-child settlement evidence gathered after the manager's own shutdown and
 * disposal. `settled: true` requires a query that actually answered; unknown
 * child state never authorizes releasing exclusive host ownership.
 */
export type OwnedChildSettlement =
  | { readonly settled: true; readonly remaining: number }
  | { readonly settled: false; readonly remaining: number };

/** The exact retained binding of one confirmed-exited row, plus its workspace. */
export interface ExitedResumeTarget {
  readonly workspace: string;
  readonly binding: NativePersistenceReceipt;
  readonly epoch: number;
}

/**
 * One immutable observation of the host's authoritative rows (#478).
 *
 * A snapshot is one copied read of the one manager's own listing, stamped with
 * the identity of the manager run it came from. `hostRunId` is minted once per
 * service/manager run and is never reused or reissued, so a consumer can tell a
 * finished run's rows from the current run's. `revision` is that run's capture
 * ordinal: every snapshot the run produces — read or watched — carries a
 * strictly greater revision than any earlier one from the same run, so an
 * out-of-order delivery is recognizable and can be rejected instead of silently
 * replacing newer facts. A revision is not a row count, a content digest, or a
 * cross-run sequence, and it never wraps: once the safe-integer ceiling is
 * reached the run reports no inventory rather than reusing a revision.
 */
export interface OwningHostInventorySnapshot {
  readonly hostRunId: string;
  readonly revision: number;
  readonly rows: readonly NativeInstanceView[];
}

/**
 * One live inventory watch. `snapshot` is the state captured when the watch was
 * installed; `unsubscribe()` retires it idempotently, and a retired watch is
 * never notified again, including by a notification already in flight.
 */
export interface OwningHostInventoryWatch {
  readonly snapshot: OwningHostInventorySnapshot;
  unsubscribe(): void;
}

/**
 * One watch's notification sink. `undefined` means the inventory is currently
 * unobservable (the host is closing, or the manager's listing threw); it is
 * never used for a host that genuinely has no rows.
 */
export type OwningHostInventoryListener = (snapshot: OwningHostInventorySnapshot | undefined) => void;

/** One live watch record; `active` gates delivery against reentrant retirement. */
interface InventoryWatchRecord {
  readonly id: number;
  readonly listener: OwningHostInventoryListener;
  active: boolean;
}

/**
 * Upper bound on consecutive re-delivery rounds after reentrant changes. A
 * watcher that mutates the manager from its own callback is a pathological
 * consumer; the bound keeps one such watcher from spinning the host inside a
 * single manager notification. Anything still retained when the bound is
 * exhausted gets one event-loop continuation, so a finite chain still lands.
 */
const MAX_INVENTORY_DELIVERY_ROUNDS = 8;

/**
 * Copy one manager listing into immutable snapshot rows. The manager's own
 * listing is already copied and frozen; copying again here keeps a snapshot
 * immune to a later in-place mutation of whatever the manager handed back,
 * without retaining anything after the snapshot is released.
 */
function copyInventoryRows(rows: readonly NativeInstanceView[]): readonly NativeInstanceView[] {
  return Object.freeze(rows.map((row) => Object.freeze({
    ...row,
    activity: Array.isArray(row.activity) ? Object.freeze([...row.activity]) : row.activity,
  })));
}

export interface OwningHostServiceDependencies {
  /** Constructs the host's single manager (the production `InstanceManager`). */
  readonly createManager: (options: InstanceManagerOptions) => OwningHostManager;
  /**
   * The host's live teardown latch, read on demand and never copied here: this
   * module has no lifecycle state of its own to fall out of sync with Main.
   */
  readonly teardownRequested: () => boolean;
}

export interface OwningHostService {
  /** The one manager this service opened, or undefined before it opened one. */
  readonly manager: OwningHostManager | undefined;
  /**
   * Open the host's only manager. A second open is refused fail closed: one
   * host, one authoritative manager, one set of session facts.
   */
  openManager(options: InstanceManagerOptions): OwningHostManager;
  /**
   * Current row for one id, or undefined. A throwing listing is an unknown row,
   * never a guess and never a poll.
   */
  readRow(id: string): NativeInstanceView | undefined;
  /**
   * The current authoritative inventory as one immutable snapshot (#478), or
   * undefined when no inventory can be observed: no manager opened yet, the host
   * is closing, the manager's listing threw, or another capture's listing is
   * still in flight for this run. An unreadable inventory is never reported as
   * an empty or idle one; a host with genuinely zero rows is a valid snapshot.
   * This is a fresh read of the one manager, never a cached mirror, and it is
   * never retried on the caller's behalf.
   */
  readInventorySnapshot(): OwningHostInventorySnapshot | undefined;
  /**
   * Install one live inventory watch over the same authoritative manager used by
   * `readInventorySnapshot`. The returned watch carries the snapshot captured at
   * installation and the watch is installed in that same synchronous operation,
   * so no change can slip between the read and the subscription and no duplicate
   * initial callback is needed. Every later manager change delivers a newer
   * snapshot, or `undefined` while the listing is unavailable. Returns undefined
   * and installs nothing when no snapshot can be captured, including when another
   * capture's listing is still in flight: no watch is installed on an observation
   * that cannot be ordered. `unsubscribe()` is
   * idempotent, one watcher's failure never reaches the host's own change hook
   * or another watcher, and losing a watch never affects a session.
   *
   * Delivery is serialized: a manager change that lands while a capture or a
   * delivery is in flight never overtakes it. It is retained and delivered as a
   * newer capture once the in-flight work unwinds, so a watcher is never handed
   * older rows after newer ones, and a change that lands during this install is
   * delivered to the new watch as its first notification.
   *
   * Throws only on a non-callable listener, which is a programmer error.
   */
  watchInventory(listener: OwningHostInventoryListener): OwningHostInventoryWatch | undefined;
  /**
   * Start one session through the manager and classify the row that actually
   * came up. Never activates, focuses, or notifies anything: presentation reads
   * the outcome.
   */
  startSession(createOptions: CreateInstanceOptions): Promise<StartedSessionOutcome>;
  /**
   * Admit and create one background sibling for an authenticated child request.
   * The parent identity comes from the manager's own registration, never from
   * model input; the requested workspace, title, and prompt are forwarded
   * verbatim with no defaults and no retry.
   */
  spawnRequestedChild(parentInstanceId: string, request: SessionSpawnInput): Promise<SessionSpawnOutcome>;
  /**
   * Mint one branded saved-conversation admission against the host's known-owned
   * live sessions. A throwing ownership read refuses; it never admits.
   */
  admitSavedConversation(catalog: SavedSessionCatalog, row: SavedSessionRow): SavedSessionAdmissionResult;
  /** Deletion preflight for one catalog row against the host's owned children. */
  validateSavedConversationDeletion(
    catalog: SavedSessionCatalog,
    row: SavedSessionRow,
  ): SavedSessionDeletionRefusalReason | undefined;
  /**
   * The exact current exited binding of one row, read fresh from the manager:
   * only an actual confirmed exit with no owned process qualifies. The retained
   * last-observed native binding is the restart target; a missing persistence
   * observation is unknown, never assumed unsaved.
   */
  readExitedResumeTarget(id: string): ExitedResumeTarget | undefined;
  /**
   * Positive settlement evidence for the host's owned children after teardown.
   * `fallbackRemaining` is the manager's own shutdown result when it answered.
   */
  observeOwnedChildSettlement(fallbackRemaining: number | undefined): OwnedChildSettlement;
  /**
   * Register one viewing surface on the one manager (#474). The surface is only a
   * display participant: it takes no input lease and excludes nobody. Returns
   * undefined when no manager is open or the host is already closing.
   */
  openViewer(): SessionViewerState | undefined;
  /** Current facts of one registered surface, or undefined once it is gone. */
  readViewer(viewerId: string): SessionViewerState | undefined;
  /** Every surface currently displaying one row, as copied facts. */
  readSessionViewers(sessionId: string): readonly SessionViewerState[];
  /**
   * Change one surface's content target and/or pane size. Only the sessions that
   * change could affect are recomputed, and only the manager's own rows are ever
   * resized. A refusal is truthful: `stale` means a newer change already won.
   */
  updateViewer(viewerId: string, update?: SessionViewerUpdate): SessionViewerUpdateResult;
  /** Retire one surface; the row it displayed keeps its last canonical size. */
  closeViewer(viewerId: string): boolean;
  /**
   * The manager's canonical content geometry for one row, or undefined for a row
   * this manager does not have. This is the manager's own fact, never a copy.
   */
  readSessionGeometry(id: string): SessionGeometry | undefined;
  /**
   * Adopt one host pane size as the initial-sizing rule for rows created later.
   * Resizes nothing that already exists.
   */
  setInitialGeometry(cols: number, rows: number): void;
}

class LocalOwningHostService implements OwningHostService {
  #manager: OwningHostManager | undefined;
  /** Opaque identity of this host's one manager run; minted once, never reused. */
  readonly #hostRunId: string = randomUUID();
  /** Highest revision this run has issued; strictly increasing, never reused. */
  #inventoryRevision = 0;
  readonly #inventoryWatches = new Map<number, InventoryWatchRecord>();
  #nextWatchId = 1;
  /** Nesting depth of guarded inventory work; changes inside it are retained. */
  #inventoryGuardDepth = 0;
  /** A manager change arrived inside a guarded capture or delivery. */
  #inventoryPending = false;
  /** True while the drain loop owns delivery, so nested rounds join it instead of recursing. */
  #inventoryDraining = false;
  /** True while one capture's listing is in flight; overlapping captures are refused. */
  #inventoryCapturing = false;
  /** True while the post-bound continuation for a retained change is queued. */
  #inventoryDrainScheduled = false;
  /** The host's own manager change hook, forwarded exactly once per change. */
  #hostOnChange: ((instanceId: string) => void) | undefined;

  constructor(readonly dependencies: OwningHostServiceDependencies) {}

  get manager(): OwningHostManager | undefined {
    return this.#manager;
  }

  openManager(options: InstanceManagerOptions): OwningHostManager {
    if (this.#manager !== undefined) {
      // One owning host owns one manager. A second one would mean two
      // authoritative sets of session facts, so refuse instead of adapting.
      throw new Error("this session host already owns a session manager");
    }
    // The inventory seam observes this manager's existing change hook and then
    // forwards the host's own hook, so the host keeps the callback it passed in
    // and no second notification path is created.
    this.#hostOnChange = options.onChange;
    const manager = this.dependencies.createManager({
      ...options,
      onChange: (instanceId: string) => this.#observeManagerChange(instanceId),
    });
    this.#manager = manager;
    return manager;
  }

  readRow(id: string): NativeInstanceView | undefined {
    const manager = this.#manager;
    if (manager === undefined) return undefined;
    try {
      return manager.list().find((candidate) => candidate.id === id);
    } catch {
      return undefined;
    }
  }

  readInventorySnapshot(): OwningHostInventorySnapshot | undefined {
    // Guarded so a change landing during this listing is retained for delivery
    // rather than interleaved, and so this capture cannot be overtaken.
    return this.#withInventoryGuard(() => this.#captureInventory());
  }

  watchInventory(listener: OwningHostInventoryListener): OwningHostInventoryWatch | undefined {
    if (typeof listener !== "function") {
      throw new TypeError("session-host: watchInventory requires a listener function");
    }
    // Capture and registration are one guarded operation. Nothing can change
    // between them without being retained, so no observation is lost, no
    // duplicate initial callback is required, and a change that lands while the
    // manager is still listing is delivered to this watch as its first
    // notification the moment it is registered.
    let record: InventoryWatchRecord | undefined;
    const snapshot = this.#withInventoryGuard((): OwningHostInventorySnapshot | undefined => {
      const captured = this.#captureInventory();
      if (captured === undefined) return undefined;
      const created: InventoryWatchRecord = { id: this.#nextWatchId++, listener, active: true };
      this.#inventoryWatches.set(created.id, created);
      record = created;
      return captured;
    });
    if (snapshot === undefined || record === undefined) return undefined;
    const watch = record;
    return Object.freeze({
      snapshot,
      unsubscribe: (): void => {
        // Idempotent, and a retired watch can never be re-added or re-notified.
        watch.active = false;
        if (this.#inventoryWatches.get(watch.id) === watch) this.#inventoryWatches.delete(watch.id);
      },
    });
  }

  async startSession(createOptions: CreateInstanceOptions): Promise<StartedSessionOutcome> {
    const manager = this.#manager;
    if (manager === undefined || this.dependencies.teardownRequested()) return { status: "unavailable" };
    let id: string;
    try {
      id = await manager.create(createOptions);
    } catch (error) {
      return isDuplicateOwnedLaunchFailure(error) ? { status: "duplicate" } : { status: "failed" };
    }
    // A create interrupted by host teardown may have launched a child that is
    // no longer observable here. Never claim a result for that case.
    if (this.#manager !== manager || this.dependencies.teardownRequested()) return { status: "unavailable" };
    let row: NativeInstanceView | undefined;
    try {
      row = manager.list().find((candidate) => candidate.id === id);
    } catch {
      // A deliberate New session has no requester to acknowledge: an unreadable
      // listing simply means no usable session came up for the operator.
      return { status: "failed" };
    }
    if (row === undefined || row.lifecycle === "error" || row.lifecycle === "starting") {
      return { status: "not-ready" };
    }
    return { status: "started", id };
  }

  async spawnRequestedChild(parentInstanceId: string, request: SessionSpawnInput): Promise<SessionSpawnOutcome> {
    const manager = this.#manager;
    if (manager === undefined || this.dependencies.teardownRequested()) return "failed";
    let parent: NativeInstanceView | undefined;
    try {
      parent = manager.list().find((view) => view.id === parentInstanceId);
    } catch {
      return "failed";
    }
    if (!parent || parent.lifecycle !== "alive" || parent.hasLiveProcess !== true) return "failed";

    let childId: string;
    try {
      childId = await manager.create({
        workspace: request.workspace,
        initialRequest: { title: request.title, prompt: request.prompt },
      });
    } catch {
      return "failed";
    }
    // A create interrupted by host teardown may have launched a child that is
    // no longer observable here. Never report that case as a definite failure.
    if (this.#manager !== manager || this.dependencies.teardownRequested()) return "unknown";
    let child: NativeInstanceView | undefined;
    try {
      child = manager.list().find((view) => view.id === childId);
    } catch {
      return "unknown";
    }
    if (!child) return "unknown";
    return child.hasLiveProcess === true || child.exitCode !== undefined ? "started" : "failed";
  }

  admitSavedConversation(catalog: SavedSessionCatalog, row: SavedSessionRow): SavedSessionAdmissionResult {
    const manager = this.#manager;
    if (manager === undefined) return { status: "refused", reason: "unknown-row" };
    try {
      return admitSavedSession(catalog, row, { ownedLiveSessions: manager.ownedLiveSessions() });
    } catch {
      return { status: "refused", reason: "unknown-row" };
    }
  }

  validateSavedConversationDeletion(
    catalog: SavedSessionCatalog,
    row: SavedSessionRow,
  ): SavedSessionDeletionRefusalReason | undefined {
    const manager = this.#manager;
    if (manager === undefined) return "unknown-live-binding";
    try {
      return validateOwnedSavedSessionDeletion(manager, catalog, row);
    } catch {
      return "unknown-live-binding";
    }
  }

  readExitedResumeTarget(id: string): ExitedResumeTarget | undefined {
    const view = this.readRow(id);
    if (!view || view.lifecycle !== "exited" || view.hasLiveProcess !== false) return undefined;
    const retained = view.lastNativeSession;
    if (!retained || !isValidNativeSessionId(retained.sessionId)
      || !Number.isSafeInteger(retained.epoch) || retained.epoch < 1) return undefined;
    const persistence = retained.persistence === "saved" || retained.persistence === "unsaved"
      ? retained.persistence
      : "unknown";
    return { workspace: view.workspace, binding: { sessionId: retained.sessionId, persistence }, epoch: retained.epoch };
  }

  observeOwnedChildSettlement(fallbackRemaining: number | undefined): OwnedChildSettlement {
    const manager = this.#manager;
    if (manager === undefined) {
      // No manager was ever constructed: this host owns no child at all.
      return { settled: true, remaining: fallbackRemaining ?? 0 };
    }
    try {
      const liveViews = manager.list().filter((view) => view.hasLiveProcess);
      return { settled: true, remaining: liveViews.length };
    } catch {
      const remaining = fallbackRemaining ?? 0;
      try {
        const live = manager.hasLiveProcesses();
        return { settled: true, remaining: remaining === 0 && live ? 1 : remaining };
      } catch {
        // Both owned-child queries are unavailable: no positive settlement
        // evidence exists, so exclusive ownership is retained fail closed.
        return { settled: false, remaining };
      }
    }
  }

  /**
   * Run one inventory operation so a manager change arriving inside it is
   * retained rather than interleaved. Only the outermost frame drains, so nested
   * work joins one delivery loop instead of recursing into another delivery.
   */
  #withInventoryGuard<T>(operation: () => T): T {
    this.#inventoryGuardDepth += 1;
    try {
      return operation();
    } finally {
      this.#inventoryGuardDepth -= 1;
      if (this.#inventoryGuardDepth === 0) this.#drainInventory();
    }
  }

  /**
   * Capture one immutable inventory observation from the one manager.
   *
   * A capture attempted while another capture's listing is still in flight for
   * this run is transiently unavailable. Two overlapping listings cannot be
   * ordered against each other — the older listing would otherwise be stamped
   * with a newer revision and delivered as fresher facts — so the attempt
   * reports no inventory instead of publishing an observation it cannot order.
   * Nothing is retried and no revision is consumed; the caller reads again once
   * the listing in flight has returned. A missing manager, a closing host, or a
   * throwing listing likewise yields undefined and consumes no revision.
   */
  #captureInventory(): OwningHostInventorySnapshot | undefined {
    if (this.#inventoryCapturing) return undefined;
    this.#inventoryCapturing = true;
    try {
      return this.#captureInventoryOnce();
    } finally {
      this.#inventoryCapturing = false;
    }
  }

  #captureInventoryOnce(): OwningHostInventorySnapshot | undefined {
    const manager = this.#manager;
    if (manager === undefined || this.dependencies.teardownRequested()) return undefined;
    let rows: readonly NativeInstanceView[];
    try {
      rows = copyInventoryRows(manager.list());
    } catch {
      // An unreadable listing is an unavailable inventory, never an empty one.
      return undefined;
    }
    // The revision is taken from the counter only after this listing returned, so
    // a capture can never publish or roll back a revision underneath a running
    // one. Past the safe-integer ceiling this run stops reporting inventory
    // rather than wrapping.
    const revision = this.#inventoryRevision + 1;
    if (!Number.isSafeInteger(revision)) return undefined;
    this.#inventoryRevision = revision;
    return Object.freeze({ hostRunId: this.#hostRunId, revision, rows });
  }

  /**
   * Deliver one capture to every live watch. The live set is copied first, so a
   * watch installed by a callback — which already received its own initial
   * snapshot — never gets this in-flight notification, and a watch retired
   * mid-delivery is skipped rather than resurrected. Each listener is isolated:
   * one failure never reaches the manager, the host's own hook, or another
   * watcher, and never touches a session.
   */
  #notifyInventory(snapshot: OwningHostInventorySnapshot | undefined): void {
    for (const watch of [...this.#inventoryWatches.values()]) {
      if (!watch.active) continue;
      try {
        watch.listener(snapshot);
      } catch {
        // Contained: watch delivery is observation only and is never load-bearing
        // for a row, a launch, or the host's own refresh path.
      }
    }
  }

  /**
   * The manager's single change hook. With no watchers this allocates no
   * snapshot at all — ordinary per-row change notifications stay as cheap as
   * they were before this seam existed — and the host's original hook runs
   * exactly once with its own exception behavior unchanged, still contained by
   * the manager itself, including for a retained change.
   */
  #observeManagerChange(instanceId: string): void {
    if (this.#inventoryGuardDepth > 0) {
      // A change landed inside a capture or a delivery. Retain it: the outermost
      // frame delivers a newer capture once the in-flight work unwinds, so no
      // watcher can be handed older rows after newer ones and no revision is
      // issued from two places at once.
      this.#inventoryPending = true;
    } else {
      this.#withInventoryGuard(() => {
        if (this.#inventoryWatches.size > 0) this.#notifyInventory(this.#captureInventory());
      });
    }
    this.#hostOnChange?.(instanceId);
  }

  /**
   * Deliver what a reentrant change retained, once the outermost guarded
   * operation unwound. Each round is one fresh capture delivered to every live
   * watch, so a watcher only ever moves forward. Rounds are bounded so a watcher
   * that mutates the manager from its own callback cannot spin the host inside
   * one manager notification. A change still retained when that bound is
   * exhausted gets exactly one event-loop continuation, so a finite chain of
   * callback-driven mutations reaches its final state without depending on an
   * unrelated change, read, or subscription. The continuation is one-shot per
   * outstanding retained change — never a poll, never a retry of a listing that
   * already answered — and the same live-and-active watch checks apply, so a
   * retired watch is never resurrected.
   */
  #drainInventory(): void {
    if (!this.#inventoryPending || this.#inventoryDraining) return;
    this.#inventoryDraining = true;
    try {
      for (let round = 0; round < MAX_INVENTORY_DELIVERY_ROUNDS && this.#inventoryPending; round += 1) {
        this.#inventoryPending = false;
        if (this.#inventoryWatches.size === 0) continue;
        // Guarded inline rather than through #withInventoryGuard, so this loop and
        // not a nested guard exit owns every round.
        this.#inventoryGuardDepth += 1;
        try {
          this.#notifyInventory(this.#captureInventory());
        } finally {
          this.#inventoryGuardDepth -= 1;
        }
      }
    } finally {
      this.#inventoryDraining = false;
      if (this.#inventoryPending && this.#inventoryWatches.size > 0 && !this.#inventoryDrainScheduled) {
        this.#inventoryDrainScheduled = true;
        setImmediate(() => {
          this.#inventoryDrainScheduled = false;
          this.#drainInventory();
        });
      }
    }
  }

  openViewer(): SessionViewerState | undefined {
    const manager = this.#manager;
    if (manager === undefined || this.dependencies.teardownRequested()) return undefined;
    try {
      return manager.openViewer();
    } catch {
      return undefined;
    }
  }

  readViewer(viewerId: string): SessionViewerState | undefined {
    const manager = this.#manager;
    if (manager === undefined) return undefined;
    try {
      return manager.viewerState(viewerId);
    } catch {
      return undefined;
    }
  }

  readSessionViewers(sessionId: string): readonly SessionViewerState[] {
    const manager = this.#manager;
    if (manager === undefined) return [];
    try {
      return manager.sessionViewers(sessionId);
    } catch {
      return [];
    }
  }

  updateViewer(viewerId: string, update: SessionViewerUpdate = {}): SessionViewerUpdateResult {
    const manager = this.#manager;
    if (manager === undefined) return { applied: false, reason: "unknown-viewer" };
    try {
      return manager.updateViewer(viewerId, update);
    } catch {
      // A manager that cannot record a viewer fact cannot size a session either:
      // report the refusal instead of resizing anything on a guess.
      return { applied: false, reason: "unknown-viewer" };
    }
  }

  closeViewer(viewerId: string): boolean {
    const manager = this.#manager;
    if (manager === undefined) return false;
    try {
      return manager.closeViewer(viewerId);
    } catch {
      return false;
    }
  }

  readSessionGeometry(id: string): SessionGeometry | undefined {
    const manager = this.#manager;
    if (manager === undefined) return undefined;
    try {
      return manager.instanceGeometry(id);
    } catch {
      return undefined;
    }
  }

  setInitialGeometry(cols: number, rows: number): void {
    const manager = this.#manager;
    if (manager === undefined) return;
    try {
      manager.setInitialGeometry(cols, rows);
    } catch {
      // Teardown already closed the manager; nothing further is adopted.
    }
  }
}

/** Create the local owning-host service for one session host run. */
export function createLocalOwningHostService(
  dependencies: OwningHostServiceDependencies,
): OwningHostService {
  return new LocalOwningHostService(dependencies);
}
