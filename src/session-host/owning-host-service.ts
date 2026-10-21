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
    const manager = this.dependencies.createManager(options);
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
