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
  NativeViewerClipboardSink,
  NativeViewerInputRequest,
  NativeViewerInputResult,
  NativeViewerInputSource,
  SessionGeometry,
  SessionViewerState,
  SessionViewerUpdate,
  SessionViewerUpdateResult,
  ViewerOpenOptions,
} from "./instances";
import type { NativePersistenceReceipt } from "./native-persistence";
import type {
  TerminalCellRun,
  TerminalFrame,
  TerminalInputModes,
  TerminalLineStyles,
  TerminalSurface,
} from "./terminal-surface";
import type {
  TerminalGraphicsFallback,
  TerminalGraphicsFrame,
  TerminalGraphicsImage,
  TerminalGraphicsPlacement,
} from "./kitty-graphics";
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
 * becomes a second store here. The strict viewer input seam (#481 interactive
 * path) is the same kind of forwarding boundary: the manager owns every input fact
 * and the single PTY write, this service adds only its own run fence (a source from
 * another host run is refused before the manager is consulted) and never keeps a
 * viewer, source, sink, queue, or timer of its own.
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
 *
 * The selected-session content watch (#389) observes one row's native content
 * through that same manager and the same change hook: its row tuple, canonical
 * geometry, and the exact typed frame (`surface.frame()`, including generated
 * SGR, structured styles, the cursor, and every bounded typed graphics image,
 * placement, and fallback) and input modes (`surface.inputModes()`). It adds no
 * content manager, roster, transcript, or cache, does not strip graphics or
 * styles, and grants no input, clipboard, resize, or process authority: input
 * modes are an observation only.
 */

/** The one manager shape this host speaks to (the production `InstanceManager`). */
export type OwningHostManager = Pick<InstanceManager,
  | "list" | "surface" | "write" | "resize" | "hasLiveProcesses" | "create" | "rename" | "closeExited" | "shutdown" | "dispose" | "ownedLiveSessions"
  | "openViewer" | "viewerState" | "sessionViewers" | "updateViewer" | "closeViewer" | "instanceGeometry" | "setInitialGeometry"
> & Partial<Pick<InstanceManager, "stop" | "closeError"
  // The strict viewer input seam is an optional manager capability: a manager that
  // does not offer it is simply not an input path, never an inferred one.
  | "readViewerInputSource" | "writeViewerInput">>;

export type {
  NativeViewerClipboardReceipt,
  NativeViewerClipboardSink,
  NativeViewerInputGeometry,
  NativeViewerInputRefusal,
  NativeViewerInputRequest,
  NativeViewerInputResult,
  NativeViewerInputSource,
  NativeViewerInputTuple,
  SessionGeometry,
  SessionViewerRefusal,
  SessionViewerState,
  SessionViewerUpdate,
  SessionViewerUpdateResult,
} from "./instances";

/**
 * Local-only options for registering one viewing surface on the host's one manager.
 * The caller can supply only its own surface's copy sink: the host run identity is
 * always this service's own run, never a caller's choice, so a consumer cannot
 * claim another host's scope.
 */
export interface OwningHostViewerOptions {
  readonly nativeClipboardSink?: NativeViewerClipboardSink;
}

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
 * One immutable observation of one row's native visible content (#389).
 *
 * Every fact is read from the ONE manager that owns the row: `sessionId` is the
 * manager row id, `nativeSession` is only the allowlisted native conversation
 * tuple (never a current-file, persistence, or agent-directory guard fact), and
 * `geometry`, `frame`, and `inputModes` are the canonical row geometry and that
 * row's own surface output. `hostRunId` reuses the inventory run identity, and
 * `sequence` is this run's capture ordinal for content: every snapshot a watch
 * receives carries a strictly greater sequence than the one it received before,
 * is never reused, and never wraps.
 *
 * A snapshot is a deep, frozen copy: mutating it cannot change the owner's
 * surface or another subscriber's snapshot. Graphics payloads are the canonical
 * base64 strings the surface already validated.
 */
export interface OwningHostSessionContentSnapshot {
  readonly hostRunId: string;
  /** The owning manager's row id this content belongs to. */
  readonly sessionId: string;
  /** Allowlisted native conversation tuple; null while unavailable/unknown. */
  readonly nativeSession: { readonly sessionId: string; readonly epoch: number } | null;
  readonly sequence: number;
  readonly geometry: SessionGeometry;
  readonly frame: TerminalFrame;
  readonly inputModes: TerminalInputModes;
}

/**
 * One content watch's notification sink. `undefined` means this row's content is
 * currently unobservable (missing row, missing surface or geometry, a throwing
 * read, or host teardown); it is never used for a fabricated empty frame or a
 * guessed size.
 */
export type OwningHostSessionContentListener = (snapshot: OwningHostSessionContentSnapshot | undefined) => void;

/**
 * One live content watch. `snapshot` is the content captured when the watch was
 * installed; `unsubscribe()` retires it idempotently, and a retired watch is
 * never notified again, including by a notification already in flight.
 */
export interface OwningHostSessionContentWatch {
  readonly snapshot: OwningHostSessionContentSnapshot;
  unsubscribe(): void;
}

/** One live content watch record, keyed by the row id it observes. */
interface SessionContentWatchRecord {
  readonly id: number;
  readonly sessionId: string;
  readonly listener: OwningHostSessionContentListener;
  active: boolean;
}

/** The watches already selected for one affected row in one delivery pass. */
interface SessionContentDelivery {
  readonly sessionId: string;
  readonly watches: readonly SessionContentWatchRecord[];
}

/**
 * One content capture attempt. `superseded` means a change to this same row
 * landed while the capture was reading, so the facts it could see may mix two
 * states; nothing is published and the retained change delivers a fresh capture.
 */
type SessionContentCapture =
  | { readonly status: "observed"; readonly snapshot: OwningHostSessionContentSnapshot }
  | { readonly status: "unavailable" }
  | { readonly status: "superseded" };

/**
 * Upper bound on consecutive re-delivery rounds after reentrant changes. A
 * watcher that mutates the manager from its own callback is a pathological
 * consumer; the bound keeps one such watcher from spinning the host inside a
 * single manager notification. Anything still retained when the bound is
 * exhausted gets one event-loop continuation, so a finite chain still lands.
 */
const MAX_INVENTORY_DELIVERY_ROUNDS = 8;

/**
 * Bounded synchronous re-capture attempts when an install's first capture is
 * superseded by a change to the same row. A fixture or manager that changes the
 * row on every read still refuses installation instead of looping.
 */
const MAX_CONTENT_CAPTURE_ATTEMPTS = 3;

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

/** Writable mirror of one readonly frame fact, used only while copying it. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Freeze a copied array while keeping the frame's declared mutable shape. The
 * runtime value really is frozen; only the declaration still says `string[]`.
 */
function frozenArray<T>(values: T[]): T[] {
  return Object.freeze(values) as unknown as T[];
}

/** Copy one style run, including its color records, so no surface state is shared. */
function copyCellRun(run: TerminalCellRun): TerminalCellRun {
  const copy: Mutable<TerminalCellRun> = { ...run };
  if (run.fg !== undefined) copy.fg = Object.freeze({ ...run.fg });
  if (run.bg !== undefined) copy.bg = Object.freeze({ ...run.bg });
  return Object.freeze(copy);
}

/** Copy one row's structured style runs. */
function copyLineStyles(line: TerminalLineStyles): TerminalLineStyles {
  return Object.freeze({ line: line.line, runs: Object.freeze(line.runs.map(copyCellRun)) });
}

/**
 * Copy every bounded typed graphics fact of one frame. The images, placements,
 * fallbacks, crops, and clips are all copied and frozen; base64 payloads are
 * canonical immutable strings, so they never need re-encoding or clipping.
 */
function copyGraphicsFrame(graphics: TerminalGraphicsFrame): TerminalGraphicsFrame {
  return Object.freeze({
    images: Object.freeze(graphics.images.map((image): TerminalGraphicsImage => Object.freeze({ ...image }))),
    placements: Object.freeze(graphics.placements.map((placement): TerminalGraphicsPlacement => Object.freeze({
      ...placement,
      crop: Object.freeze({ ...placement.crop }),
      clip: Object.freeze({ ...placement.clip }),
    }))),
    fallbacks: Object.freeze(graphics.fallbacks.map((fallback): TerminalGraphicsFallback => Object.freeze({
      ...fallback,
      clip: Object.freeze({ ...fallback.clip }),
    }))),
  });
}

/**
 * Deep-copy one surface frame into an immutable snapshot frame: lines, cursor,
 * styles with their runs and colors, and all graphics facts. A held synchronized
 * frame may share objects with other frames the surface returns; copying keeps a
 * subscriber's retained snapshot independent of the owner and of every other
 * subscriber.
 */
function copyTerminalFrame(frame: TerminalFrame): TerminalFrame {
  const lines = frozenArray([...frame.lines]);
  const cursor = Object.freeze({ ...frame.cursor });
  const styles = frame.styles === undefined
    ? undefined
    : frozenArray(frame.styles.map(copyLineStyles));
  const graphics = frame.graphics === undefined ? undefined : copyGraphicsFrame(frame.graphics);
  return Object.freeze({
    cols: frame.cols,
    rows: frame.rows,
    lines,
    cursor,
    ...(styles === undefined ? {} : { styles }),
    ...(graphics === undefined ? {} : { graphics }),
  });
}

/** Copy only the allowlisted native tuple; every private guard fact is dropped. */
function copyNativeSessionTuple(
  value: NativeInstanceView["nativeSession"],
): OwningHostSessionContentSnapshot["nativeSession"] {
  if (!value) return null;
  // The row's non-null tuple is the manager's own validated fact; this seam
  // copies exactly its two public fields and nothing else.
  return Object.freeze({ sessionId: value.sessionId, epoch: value.epoch });
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
   * Install one live content watch over the one manager that owns `sessionId`.
   * The returned watch carries the snapshot captured at installation, and the
   * watch is installed in that same synchronous operation, so no change can slip
   * between the capture and the subscription and no duplicate initial callback is
   * needed. Later manager changes for that row deliver a newer snapshot, or
   * `undefined` while the row's content is unobservable.
   *
   * Only the affected row is captured: a change to another row never reads this
   * row's surface, and with no content watch installed nothing calls
   * `surface.frame()` or `surface.inputModes()` at all. Every fact comes from the
   * same manager run: the row's allowlisted native tuple, its canonical
   * `instanceGeometry`, and its own surface frame and input modes. A frame whose
   * dimensions disagree with that canonical geometry is a mixed observation and
   * is reported as unavailable instead of being published.
   *
   * Returns undefined and installs nothing when no coherent snapshot can be
   * captured: no manager opened yet, host teardown, a missing or throwing row,
   * surface, geometry, frame, or input-mode read. This observation grants no
   * input, clipboard, resize, or process authority and never writes, spawns,
   * resizes, stops, or removes anything.
   *
   * `unsubscribe()` is idempotent, a retired watch is never notified again even
   * by a delivery already in flight, one watcher's failure never reaches the
   * host's own change hook or another watcher, and losing a watch never affects a
   * session. Delivery shares the inventory seam's ordering guarantees: a change
   * that lands during a capture or delivery is retained and delivered as a newer
   * capture once the in-flight work unwinds, and re-delivery is bounded with one
   * event-loop continuation for a still-retained change.
   *
   * Throws only on a non-callable listener, which is a programmer error.
   */
  watchSessionContent(
    sessionId: string,
    listener: OwningHostSessionContentListener,
  ): OwningHostSessionContentWatch | undefined;
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
   *
   * The only option a caller may supply is its own surface's native copy sink; this
   * service always records its OWN run identity with the surface, so no caller can
   * claim another host run's viewer scope. A surface registered with no options
   * behaves exactly as before and can never take viewer input.
   */
  openViewer(options?: OwningHostViewerOptions): SessionViewerState | undefined;
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
   * The manager's CURRENT immutable input scope for one surface (#481 interactive
   * path), or undefined when that surface cannot take viewer input right now: no
   * manager, host teardown, a manager without the seam, an unknown or retired
   * surface, a surface with no copy sink or no row, a row that is gone, finished,
   * stopping, or unregistered, a row whose input framing was not requested or whose
   * readiness was never verified, or an unknown native conversation.
   *
   * Reading is a pure fact read: nothing is written, queued, resized, spawned, or
   * armed, and the returned token describes those facts instead of granting
   * anything. Hand it back unchanged to {@linkcode writeViewerInput}.
   */
  readViewerInputSource(viewerId: string): NativeViewerInputSource | undefined;
  /**
   * Write viewer-origin input through the one manager, fenced on the CURRENT facts
   * the caller observed. This boundary first requires the expected source to carry
   * THIS run's identity — a foreign or replayed run is refused before the manager is
   * consulted — and the manager then re-checks every fact, the row's current input
   * modes, and its own live ownership immediately before the single PTY write.
   *
   * Every refusal happens before any possible write; `unknown` means the handoff was
   * invoked and its result is genuinely uncertain. Nothing here retries, queues,
   * replays, resizes, spawns, stops, or activates anything, and no copy is routed by
   * this call.
   */
  writeViewerInput(viewerId: string, request: NativeViewerInputRequest): NativeViewerInputResult;
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
  readonly #contentWatches = new Map<number, SessionContentWatchRecord>();
  #nextWatchId = 1;
  /** Highest content sequence this run has issued; strictly increasing, never reused. */
  #contentSequence = 0;
  /** Nesting depth of guarded inventory work; changes inside it are retained. */
  #inventoryGuardDepth = 0;
  /**
   * Row ids whose manager change arrived inside a guarded capture or delivery.
   * Retaining the ids (not just a flag) is what lets the drain capture only the
   * rows that actually changed, and only for rows someone watches.
   */
  readonly #pendingChangedIds = new Set<string>();
  /** True while the drain loop owns delivery, so nested rounds join it instead of recursing. */
  #inventoryDraining = false;
  /** True while one capture's listing is in flight; overlapping captures are refused. */
  #inventoryCapturing = false;
  /** True while one content capture is in flight; overlapping captures are refused. */
  #contentCapturing = false;
  /** The row whose content capture is reading right now, if any. */
  #contentCaptureSessionId: string | undefined;
  /** A change to that same row landed while its capture was reading. */
  #contentCaptureSuperseded = false;
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
    // The observation seams (inventory and selected-session content) observe this
    // manager's existing change hook and then forward the host's own hook, so the
    // host keeps the callback it passed in and no second notification path is
    // created.
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

  watchSessionContent(
    sessionId: string,
    listener: OwningHostSessionContentListener,
  ): OwningHostSessionContentWatch | undefined {
    if (typeof listener !== "function") {
      throw new TypeError("session-host: watchSessionContent requires a listener function");
    }
    // Capture and registration are one guarded operation over the one manager, so
    // nothing can change between them without being retained, no duplicate
    // initial callback is required, and a change that lands while the capture is
    // reading is delivered to this watch as its first notification.
    let record: SessionContentWatchRecord | undefined;
    let initial: OwningHostSessionContentSnapshot | undefined;
    const snapshot = this.#withInventoryGuard((): OwningHostSessionContentSnapshot | undefined => {
      for (let attempt = 0; attempt < MAX_CONTENT_CAPTURE_ATTEMPTS; attempt += 1) {
        const captured = this.#captureSessionContent(sessionId);
        // A superseded attempt consumed no sequence and published nothing: the
        // retained change delivers a fresh capture, so re-read once synchronously
        // rather than installing a snapshot that could mix two row states.
        if (captured.status === "superseded") continue;
        if (captured.status === "unavailable") return undefined;
        initial = captured.snapshot;
        break;
      }
      if (initial === undefined) return undefined;
      const created: SessionContentWatchRecord = {
        id: this.#nextWatchId++,
        sessionId,
        listener,
        active: true,
      };
      this.#contentWatches.set(created.id, created);
      record = created;
      return initial;
    });
    if (snapshot === undefined || record === undefined) return undefined;
    const watch = record;
    return Object.freeze({
      snapshot,
      unsubscribe: (): void => {
        // Idempotent, and a retired watch can never be re-added or re-notified.
        watch.active = false;
        if (this.#contentWatches.get(watch.id) === watch) this.#contentWatches.delete(watch.id);
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
   * Run one observation so a manager change arriving inside it is retained
   * rather than interleaved. Only the outermost frame drains, so nested work
   * joins one delivery loop instead of recursing into another delivery.
   */
  #withInventoryGuard<T>(operation: () => T): T {
    this.#inventoryGuardDepth += 1;
    try {
      return operation();
    } finally {
      this.#inventoryGuardDepth -= 1;
      if (this.#inventoryGuardDepth === 0) this.#drainWatches();
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
   * Capture one coherent content observation of one row from the one manager.
   *
   * The row listing is read first, then the row's canonical geometry, then its
   * own surface. The manager's change hook is the only synchronous reentrant
   * point in a capture, and it can only run from inside a manager call; a change
   * to this same row while the capture is reading is therefore reported as
   * superseded and never published, because the tuple, geometry, frame, and
   * input modes it could see may mix two states. A retained change delivers a
   * fresh capture once the guard unwinds.
   *
   * Every other failure is an honest unavailable observation: a missing or
   * throwing row, surface, or geometry read, a throwing frame or input-mode read,
   * host teardown, or an overlapping capture. A frame whose dimensions disagree
   * with the canonical geometry is a mixed observation too, so it is refused
   * rather than resized or padded. Nothing is fabricated, no fallback dimensions
   * are used, and no sequence is consumed by a refused attempt.
   */
  #captureSessionContent(sessionId: string): SessionContentCapture {
    if (this.#contentCapturing) return { status: "unavailable" };
    const manager = this.#manager;
    if (manager === undefined || this.dependencies.teardownRequested()) return { status: "unavailable" };
    this.#contentCapturing = true;
    this.#contentCaptureSessionId = sessionId;
    this.#contentCaptureSuperseded = false;
    try {
      let row: NativeInstanceView | undefined;
      try {
        row = manager.list().find((candidate) => candidate.id === sessionId);
      } catch {
        return { status: "unavailable" };
      }
      if (row === undefined) return { status: "unavailable" };
      if (this.#contentCaptureSuperseded) return { status: "superseded" };

      let geometry: SessionGeometry | undefined;
      try {
        geometry = manager.instanceGeometry(sessionId);
      } catch {
        return { status: "unavailable" };
      }
      if (geometry === undefined) return { status: "unavailable" };

      let surface: TerminalSurface | undefined;
      try {
        surface = manager.surface(sessionId);
      } catch {
        return { status: "unavailable" };
      }
      if (surface === undefined) return { status: "unavailable" };

      let observed: { readonly frame: TerminalFrame; readonly inputModes: TerminalInputModes } | undefined;
      try {
        observed = { frame: surface.frame(), inputModes: surface.inputModes() };
      } catch {
        return { status: "unavailable" };
      }
      if (observed === undefined) return { status: "unavailable" };
      const { frame, inputModes } = observed;
      if (this.#contentCaptureSuperseded) return { status: "superseded" };
      // A teardown that began during the read leaves the row unobservable: do not
      // publish a snapshot for a host that is already closing.
      if (this.dependencies.teardownRequested()) return { status: "unavailable" };
      if (frame.cols !== geometry.cols || frame.rows !== geometry.rows) {
        // A frame at any other size is not this row's canonical content.
        return { status: "unavailable" };
      }

      // The sequence is taken only after every fact was read, so a capture can
      // never publish or roll back a sequence underneath a running one. Past the
      // safe-integer ceiling this run stops reporting content rather than wrapping.
      const sequence = this.#contentSequence + 1;
      if (!Number.isSafeInteger(sequence)) return { status: "unavailable" };
      this.#contentSequence = sequence;
      return {
        status: "observed",
        snapshot: Object.freeze({
          hostRunId: this.#hostRunId,
          sessionId,
          nativeSession: copyNativeSessionTuple(row.nativeSession),
          sequence,
          geometry: Object.freeze({
            cols: geometry.cols,
            rows: geometry.rows,
            revision: geometry.revision,
          }),
          frame: copyTerminalFrame(frame),
          inputModes: Object.freeze({
            kittyFlags: inputModes.kittyFlags,
            applicationCursorKeys: inputModes.applicationCursorKeys,
            applicationKeypad: inputModes.applicationKeypad,
            bracketedPaste: inputModes.bracketedPaste,
            mouseTracking: inputModes.mouseTracking,
            modifyOtherKeys: inputModes.modifyOtherKeys,
            mouseEncoding: inputModes.mouseEncoding,
          }),
        }),
      };
    } finally {
      this.#contentCapturing = false;
      this.#contentCaptureSessionId = undefined;
    }
  }

  /** Select the live watches of each changed row before anything is notified. */
  #planContentDeliveries(changedIds: readonly string[]): SessionContentDelivery[] {
    const planned: SessionContentDelivery[] = [];
    for (const sessionId of changedIds) {
      const watches = [...this.#contentWatches.values()]
        .filter((watch) => watch.sessionId === sessionId);
      if (watches.length > 0) planned.push({ sessionId, watches });
    }
    return planned;
  }

  /**
   * Capture each affected row once and deliver it to the watches selected for
   * that row. A retired watch is skipped at call time, even when it was retired
   * by another listener in this same pass, and each listener's failure stays
   * contained. Nothing is captured for a row nobody watches.
   */
  #deliverSessionContent(planned: readonly SessionContentDelivery[]): void {
    for (const { sessionId, watches } of planned) {
      // Every watch selected for this row was retired by a callback before its
      // turn: capture nothing for a row nobody observes.
      if (!watches.some((watch) => watch.active)) continue;
      const captured = this.#captureSessionContent(sessionId);
      // A same-row change landed during this capture: it is retained, so a newer
      // capture follows. Publishing this one could mix two row states.
      if (captured.status === "superseded") continue;
      const snapshot = captured.status === "observed" ? captured.snapshot : undefined;
      for (const watch of watches) {
        if (!watch.active) continue;
        try {
          watch.listener(snapshot);
        } catch {
          // Contained: content observation is never load-bearing for a row, a
          // launch, the host's own refresh path, or another watcher.
        }
      }
    }
  }

  /**
   * Deliver one manager change to the inventory and the affected content rows.
   * The affected watch sets are selected before any listener runs, so a watch
   * installed by a callback — which already captured its own initial snapshot —
   * never receives this in-flight notification. With no watch at all this does
   * no capture: no listing, no frame, no input modes.
   */
  #deliverChangedRows(changedIds: readonly string[]): void {
    const inventoryWatched = this.#inventoryWatches.size > 0;
    const planned = this.#planContentDeliveries(changedIds);
    if (!inventoryWatched && planned.length === 0) return;
    if (inventoryWatched) this.#notifyInventory(this.#captureInventory());
    this.#deliverSessionContent(planned);
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
      // A change landed inside a capture or a delivery. Retain which row changed:
      // the outermost frame delivers a newer capture once the in-flight work
      // unwinds, so no watcher is handed older facts after newer ones and no
      // revision or sequence is issued from two places at once. A change to the
      // row a capture is reading also marks that capture superseded.
      this.#pendingChangedIds.add(instanceId);
      if (instanceId === this.#contentCaptureSessionId) this.#contentCaptureSuperseded = true;
    } else {
      this.#withInventoryGuard(() => this.#deliverChangedRows([instanceId]));
    }
    this.#hostOnChange?.(instanceId);
  }

  /** True while a retained change has at least one live observer to deliver it to. */
  #hasDeliverablePendingChange(): boolean {
    // A completed drain leaves nothing retained: never queue a continuation for
    // an empty pending set, whatever watches still exist.
    if (this.#pendingChangedIds.size === 0) return false;
    if (this.#inventoryWatches.size > 0) return true;
    for (const sessionId of this.#pendingChangedIds) {
      for (const watch of this.#contentWatches.values()) {
        if (watch.sessionId === sessionId) return true;
      }
    }
    return false;
  }

  /**
   * Deliver what a reentrant change retained, once the outermost guarded
   * operation unwound. Each round is one fresh capture per interested observer,
   * so a watcher only ever moves forward, and only rows that actually changed
   * are captured. Rounds are bounded so a watcher that mutates the manager from
   * its own callback cannot spin the host inside one manager notification. A
   * change still retained when that bound is exhausted gets exactly one
   * event-loop continuation, so a finite chain of callback-driven mutations
   * reaches its final state without depending on an unrelated change, read, or
   * subscription. The continuation is one-shot per outstanding retained change —
   * never a poll, never a retry of a read that already answered — and the same
   * live-and-active watch checks apply, so a retired watch is never resurrected.
   */
  #drainWatches(): void {
    if (this.#pendingChangedIds.size === 0 || this.#inventoryDraining) return;
    this.#inventoryDraining = true;
    try {
      for (let round = 0;
        round < MAX_INVENTORY_DELIVERY_ROUNDS && this.#pendingChangedIds.size > 0;
        round += 1) {
        const changedIds = [...this.#pendingChangedIds];
        this.#pendingChangedIds.clear();
        const inventoryWatched = this.#inventoryWatches.size > 0;
        const planned = this.#planContentDeliveries(changedIds);
        if (!inventoryWatched && planned.length === 0) continue;
        // Guarded inline rather than through #withInventoryGuard, so this loop and
        // not a nested guard exit owns every round.
        this.#inventoryGuardDepth += 1;
        try {
          if (inventoryWatched) this.#notifyInventory(this.#captureInventory());
          this.#deliverSessionContent(planned);
        } finally {
          this.#inventoryGuardDepth -= 1;
        }
      }
    } finally {
      this.#inventoryDraining = false;
      if (this.#hasDeliverablePendingChange() && !this.#inventoryDrainScheduled) {
        this.#inventoryDrainScheduled = true;
        setImmediate(() => {
          this.#inventoryDrainScheduled = false;
          this.#drainWatches();
        });
      }
    }
  }

  openViewer(options?: OwningHostViewerOptions): SessionViewerState | undefined {
    const manager = this.#manager;
    if (manager === undefined || this.dependencies.teardownRequested()) return undefined;
    const viewerOptions: ViewerOpenOptions | undefined = options === undefined
      ? undefined
      : {
        // This host's own run identity, never a caller-selected one.
        hostRunId: this.#hostRunId,
        nativeClipboardSink: options.nativeClipboardSink,
      };
    try {
      return manager.openViewer(viewerOptions);
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

  readViewerInputSource(viewerId: string): NativeViewerInputSource | undefined {
    const manager = this.#manager;
    // A manager without the seam, a throwing read, or a closing host is simply not
    // an input path; nothing is inferred and no provider is fabricated.
    if (manager === undefined || this.dependencies.teardownRequested()
      || typeof manager.readViewerInputSource !== "function") {
      return undefined;
    }
    try {
      return manager.readViewerInputSource(viewerId);
    } catch {
      return undefined;
    }
  }

  writeViewerInput(viewerId: string, request: NativeViewerInputRequest): NativeViewerInputResult {
    const manager = this.#manager;
    if (manager === undefined || this.dependencies.teardownRequested()) {
      return { status: "refused", reason: "unavailable" };
    }
    if (typeof manager.writeViewerInput !== "function") {
      return { status: "refused", reason: "unavailable" };
    }
    // The run fence belongs to this boundary: only the host run that minted the
    // source can spend it, and this service never accepts another run's identity.
    const candidate: unknown = request;
    if (typeof candidate !== "object" || candidate === null
      || !Object.hasOwn(candidate, "expectedSource")
      || !Object.hasOwn(candidate, "expectedInputModes")
      || !Object.hasOwn(candidate, "data")) {
      return { status: "refused", reason: "invalid-input" };
    }
    const expected = (candidate as { expectedSource: unknown }).expectedSource;
    const runId = typeof expected === "object" && expected !== null
      ? (expected as { hostRunId?: unknown }).hostRunId
      : undefined;
    if (runId !== this.#hostRunId) {
      return { status: "refused", reason: "stale-source" };
    }
    try {
      return manager.writeViewerInput(viewerId, request);
    } catch {
      // The manager threw somewhere inside an operation whose PTY handoff cannot be
      // observed from here: that is an unknown outcome, never a claimed refusal and
      // never a retry.
      return { status: "unknown" };
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
