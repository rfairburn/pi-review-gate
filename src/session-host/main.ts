import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Writable } from "node:stream";
import { ProcessTerminal, matchesKey } from "pi-session-host-tui";

import { createStatusBroker, type StatusBroker } from "./broker";
import { composeHostFrame, computeHostLayout, type HostFocus, type HostLayout, type HostPaneRect, type RenderedSidebar } from "./compositor";
import { chooseExitedRestart } from "./exited-restart";
import {
  createSessionHostFrameWriter,
  type SessionHostFrameDisposition,
  type SessionHostFrameWriter,
} from "./frame-writer";
import { createSessionHostTextField, type SessionHostFieldKeybindings } from "./field-editor";
import { createNativeSavedQueryInput, loadNativeFieldKeybindings, runNativeExternalEditor } from "./form-support";
import { normalizeNativeSourceInput, parseMouseInput, translateInput, KeyboardCapabilityObserver, type ParsedMouseInput } from "./input";
import {
  InstanceManager,
  type CreateInstanceOptions,
  type InstanceManagerOptions,
  type InstanceStatusRegistration,
  type InstanceStatusUpdate,
  type NativeInstanceView,
  type ShutdownResult,
  type StatusRegistrar,
} from "./instances";
import type { SessionGeometry } from "./instances";
import { resolveNativePi, RUNTIME_ROLE_ENV, EXECUTOR_TOOL_CATALOG_ENV, snapshotNativeEnvironment, supportsSessionHostKittyGraphics } from "./launch";
import { NativeAgentRegistry, type ProfilePreparer } from "./profiles";
import { createPeerCoordinator, type PeerCoordinatorOptions } from "./network/peer-coordinator";
import type {
  PeerContentController,
  PeerContentObservation,
  PeerCoordinatorWithContent,
  PeerNativeCopyReceipt,
  PeerNativeInputRequest,
  PeerNativeInputTarget,
  PeerSelectedContent,
} from "./network/peer-content";
import type { NativeInputSendResult } from "./network/session-content-client";
import {
  DEFAULT_SESSION_CONTENT_BOUNDS,
  NATIVE_COPY_MAX_ENCODED_CHARS,
  NATIVE_IO_MAX_SOURCE_TOKEN_BYTES,
  NATIVE_TEXT_PASTE_MAX_BYTES,
  nativeIoSourceEquals,
  type NativeIoInputKind,
  type NativeIoSource,
} from "./network/session-content-protocol";
import {
  isOwnerCloseFacts,
  type OwnerCloseFacts,
  type OwnerCloseRequest,
  type PeerCloseController,
  type PeerCloseResult,
  type PeerCoordinatorWithClose,
} from "./network/peer-close";
import {
  isOwnerCreateFacts,
  type OwnerCreateFacts,
  type OwnerCreateRequest,
  type PeerCoordinatorWithCreate,
  type PeerCreateController,
  type PeerCreateResult,
} from "./network/peer-create";
import type { PeerCoordinator, PeerConsentPresentation, PeerUiCommand, PeerUiSnapshot } from "./peer-ui-protocol";
import { isValidNativeSessionId } from "./protocol";
import {
  createLocalOwningHostService,
  isDuplicateOwnedLaunchFailure,
  savedDeletionOwnedSessions,
  validateOwnedSavedSessionDeletion,
  type OwningHostInventorySnapshot,
  type OwningHostManager,
  type OwningHostService,
  type OwningHostServiceDependencies,
  type StartedSessionOutcome,
} from "./owning-host-service";
import {
  assertHostShortcutsDistinct,
  DEFAULT_HOST_SHORTCUTS,
  normalizeHostShortcutBindings,
  normalizeHostShortcutKey,
  type HostShortcutBindings,
} from "./host-shortcuts";
import {
  readHostShortcutConfig,
  writeHostShortcutConfig,
  type HostShortcutConfigReadResult,
} from "./host-shortcuts-store";
import {
  MAX_ROSTER_ENTRIES,
  ROSTER_STORE_VERSION,
  isValidRosterName,
  isValidRosterWorkspace,
  openHostState as openProductionHostState,
  type HostStateHandle,
  type HostStateOpenResult,
  type RosterEntry,
  type StoredRoster,
} from "./roster-store";
import {
  isSavedSessionCatalog,
  listSavedSessions,
  searchSavedSessions,
  type SavedSessionCatalog,
  type SavedSessionDeletionRefusalReason,
  type SavedSessionRefusalReason,
} from "./saved-sessions";
import { deleteSavedSessionFile, type SavedSessionDeletionResult } from "./saved-deletion";
import {
  SidebarController,
  createPlainOwnerWorkspaceField,
  CREATE_ON_PEER_OTHER_RUN_NOTICE,
  CREATE_ON_PEER_UNCERTAIN_NOTICE,
  CREATE_ON_PEER_UNWRITTEN_NOTICE,
  type SidebarAction,
  type SidebarCreateFormPresentation,
  type SidebarFieldFactoryOptions,
  type SidebarItem,
  type SidebarMainOwnerKey,
  type SidebarMousePresentation,
  type SidebarRemoteCloseRow,
} from "./sidebar";
import type { TerminalFrame, TerminalInputModes, TerminalMouseReportingRequest } from "./terminal-surface";
import type { NativeClipboardEvent } from "./native-clipboard";
import {
  HostClipboardDiagnosticCollector,
  TerminalDiagnosticsWarning,
  terminalDiagnosticsHeaderNotice,
  type TerminalDiagnosticEvent,
} from "./terminal-diagnostics";
import {
  TerminalDiagnosticsLog,
  collectTerminalDiagnosticsIdentity,
  type TerminalDiagnosticsLogLike,
  type TerminalDiagnosticsLogOptions,
} from "./terminal-diagnostics-log";

const STARTUP_OPTIONS_HELPER = join("scripts", "session-host-startup-options.cjs");
const GENERIC_FAILURE_MESSAGE = "Session host could not complete startup or cleanup.";
const GENERIC_CREATE_FAILURE = "Session could not be started. Check the workspace, then try again.";
const ROW_RESUME_FAILURE = "This session could not be restarted; the previous row was kept.";
const ROW_RESUME_DUPLICATE = "This conversation is already restarting";
const SAVED_UNAVAILABLE = "Saved conversations are unavailable in this host";
const REMOVE_REFUSED_MESSAGE = "Session not removed; it may be live, unconfirmed, or no longer available.";
const REMOVE_FAILURE_MESSAGE = "Session was not removed; its state could not be confirmed.";
/** The existing notice for a stop this host will not perform without a deliberate confirmation. */
const ROW_STOP_CONFIRMATION_MESSAGE = "Activity changed or is unknown. Press d again to confirm stopping this session.";
const ROSTER_UNAVAILABLE_MESSAGE = "That remembered conversation is unavailable; remove it or open a saved conversation";
const LOCAL_VIEW_DETACHED_MESSAGE = "No session is displayed. Every session keeps running; press enter on a row to display it.";
const NO_LOCAL_VIEW_MESSAGE = "No session is displayed already; press enter on a row to display it";
const ROSTER_SAVE_FAILURE_MESSAGE = "The session roster could not be saved; these rows will not be restored after a restart";
const ROSTER_OVERFLOW_MESSAGE = "The session roster is larger than this host can save; the saved roster was left unchanged";
const ROSTER_OWNERSHIP_MESSAGE = "Session host ownership was not confirmed released; a later host will refuse to start until it is resolved.";
const ROSTER_RETAINED_MESSAGE = "Session host ownership is retained because shutdown did not settle.";
/** Fixed, bounded display status while a deliberately selected remote viewport is awaited. */
const REMOTE_CONTENT_WAITING_MESSAGE = "Waiting for the selected remote session's display";
const REMOTE_CONTENT_UNAVAILABLE_MESSAGE = "The selected remote session's display is unavailable; its session keeps running on its host";
const REMOTE_CONTENT_UNOBSERVED_MESSAGE = "That remote session's owner run was not observed; nothing is displayed";
/**
 * Truthful status while an owner-reported `started` row has not yet appeared in
 * the requester's own roster observation. The coordinator's existing selection
 * intent is retained and served by the next roster event, so this is pending —
 * never an "unavailable" claim about a row the owner just created.
 */
const REMOTE_CONTENT_CREATED_WAITING_MESSAGE =
  "Waiting for the new remote session in its host's roster";
const REMOTE_CONTENT_UNSUPPORTED_MESSAGE = "Remote display is unavailable in this host; local sessions are unchanged";
const REMOTE_CONTENT_INVALID_MESSAGE = "That remote row is no longer displayed; select it again from the roster";
/**
 * Fixed, bounded, non-modal notices for refused remote native input. They say only
 * what this side actually knows: a refusal before any submission sent nothing; a
 * refusal the owner may already have received is labelled UNCERTAIN. The
 * uncertainty label leads the message because the composed notice surface keeps
 * one bounded row and clips its tail, so the essential classification survives on
 * a narrow terminal. No dialog, retry, truncation of input, focus change, payload,
 * or exception text is involved.
 */
const REMOTE_INPUT_NOT_SENT_MESSAGE = "Remote input was refused; nothing was sent to the remote session";
const REMOTE_INPUT_PASTE_TOO_LARGE_MESSAGE = "That paste is larger than a remote session accepts; nothing was sent";
const REMOTE_INPUT_UNCERTAIN_MESSAGE =
  "UNCERTAIN: remote input may have been handed off; outcome unknown";
/** Exact outer brackets of one complete host-delivered bracketed paste packet. */
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
/**
 * Fixed, bounded notices for one remote Close attempt. They describe only what
 * this side knows: a close that was never drawn, never addressable, never sent,
 * or whose owner outcome is a fixed fact. Nothing here claims a local removal,
 * a saved-conversation change, or a retry, and no path or raw error is shown.
 */
const REMOTE_CLOSE_NOT_DRAWN_MESSAGE =
  "That remote session is not the displayed highlight; nothing was requested";
const REMOTE_CLOSE_NO_RUN_MESSAGE =
  "That remote session's owner run was not observed; no close was requested";
const REMOTE_CLOSE_NO_PROCESS_MESSAGE =
  "That remote session has no owned process to stop; no close was requested";
const REMOTE_CLOSE_UNSUPPORTED_MESSAGE =
  "This host cannot ask another host to close a session";
const REMOTE_CLOSE_BUSY_MESSAGE =
  "That remote session already has a close in progress";
const REMOTE_CLOSE_DIALOG_CHANGED_MESSAGE =
  "The remote close confirmation changed or is not displayed; review it again";
const REMOTE_CLOSE_TARGET_GONE_MESSAGE =
  "That remote session is no longer in its owner's roster; no close was requested";
/** The content protocol's own viewport bound; a larger owner frame is never claimed. */
const MAX_CONTENT_DIMENSION = 1000;
/**
 * Fixed, bounded notices for one requester-side remote New submission. Each says
 * only what this side positively knows: a form that was never drawn, a target
 * that is no longer addressable, a reply-before-observation selection, an owner
 * fact, or an outcome this side can no longer observe. Nothing here claims a
 * local creation, a retry, a reconnect, a regrant, or a cancellation, and no
 * path, error payload, or exception text is ever shown.
 */
const CREATE_ON_PEER_UNSUPPORTED_MESSAGE =
  "This host cannot ask another host to create a session";
const CREATE_ON_PEER_BUSY_MESSAGE =
  "Another remote create is already in progress; nothing was sent";
const CREATE_ON_PEER_GONE_MESSAGE =
  "That destination or its owner run is no longer observed; nothing was sent";
const CREATE_ON_PEER_FORM_CHANGED_MESSAGE =
  "The New session form changed before it was sent; nothing was sent";
const CREATE_ON_PEER_UNCONFIRMED_MESSAGE =
  "The remote host could not confirm that the session started; nothing was selected";
const CREATE_ON_PEER_REFUSED_MESSAGE =
  "The remote host did not accept that create; nothing was started";
/** One wording source for uncertainty: the sidebar's own fixed notice. */
const CREATE_ON_PEER_UNKNOWN_MESSAGE = CREATE_ON_PEER_UNCERTAIN_NOTICE;
const INPUT_DRAIN_MAX_MS = 250;
const INPUT_DRAIN_IDLE_MS = 50;
// One bounded readiness deadline for a just-spawned exited-row replacement:
// PTY spawn is not native readiness, and startup/disconnect uncertainty must
// fail closed rather than hang the restart forever.
const ROW_RESUME_READY_DEADLINE_MS = 60_000;

/** Public options for the optional standalone native session host. */
export interface SessionHostOptions {
  packageRoot: string;
  piExecutable?: string;
  /** Existing private directory for transient broker transport; never a Pi agent/profile root. */
  stateRoot?: string;
  toggleKey?: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

type MainTerminal = Pick<ProcessTerminal,
  "start" | "stop" | "drainInput" | "write" | "columns" | "rows" | "kittyProtocolActive" | "modifyOtherKeysActive"
>;
type MainObserver = Pick<KeyboardCapabilityObserver, "flags" | "wait" | "dispose" | "feed">;
type MainWriter = Pick<SessionHostFrameWriter, "start" | "submit" | "close">
  & Partial<Pick<SessionHostFrameWriter, "invalidate">>;
/** The canonical session size and revision a native frame was drawn from (#474). */
interface CanonicalSessionGeometry {
  readonly cols: number;
  readonly rows: number;
  readonly revision: number;
}

/**
 * Immutable receipt of the ONE remote native IO source a frame ACTUALLY drew.
 *
 * Every fact is captured with the candidate the writer was handed and becomes a
 * receipt only when that exact candidate is reported `written`; a queued, held,
 * or superseded candidate never becomes one. The receipt is what later input and
 * copy attempts are measured against, so an old written source can never be
 * retargeted onto a newer owner source (or the reverse).
 *
 * It carries no permission by itself: every attempt re-proves the current Main
 * focus, actual coverage, drawn content rectangle, canonical geometry, the
 * coordinator's own current selection/endpoint, and (for input) the exact
 * observed modes before anything is submitted.
 */
interface WrittenRemoteNativeInput {
  readonly hostId: string;
  readonly hostRunId: string;
  readonly rowId: string;
  readonly selectionGeneration: number;
  readonly subscriptionId: string;
  /** Exact host-written source of the drawn viewport. */
  readonly source: NativeIoSource;
  /** Exact observed input modes of that same drawn publish. */
  readonly inputModes: TerminalInputModes;
  /** Canonical size/revision the drawn content came from. */
  readonly geometry: CanonicalSessionGeometry;
  /** The rectangle inside the native pane the written frame actually filled. */
  readonly nativeContent: HostPaneRect;
  /**
   * Remote native IO geometry epoch of the frame that was actually written. An
   * outer resize can reflow the physical screen and return to the same dimensions
   * before any replacement frame is written, so rectangle equality alone cannot
   * prove this receipt still belongs to what the operator sees; the current epoch
   * must equal this one. It gates remote input/copy only — never Close or any
   * other host UI.
   */
  readonly resizeEpoch: number;
}

interface MouseFramePresentation {
  readonly layout: HostLayout;
  readonly focus: SidebarController["focus"];
  readonly sidebar: SidebarMousePresentation;
  /** Current active LOCAL owner only when its complete native frame matched this layout. */
  readonly nativeOwnerId: string | undefined;
  /**
   * The rectangle the owner's frame actually filled inside the native pane (#474).
   * A session smaller than this pane is drawn at the pane's top-left corner and
   * padded, so positional authority ends where this rectangle ends.
   */
  readonly nativeContent: HostPaneRect | undefined;
  /** Canonical size/revision the drawn content came from, when the manager reported one. */
  readonly nativeGeometry: CanonicalSessionGeometry | undefined;
  /**
   * Generalized identity of the ONE source this frame actually drew: `local|<row>`
   * for a live local owner, or the exact remote kind/host/run/row/generation and
   * native conversation epoch for a selected remote viewport. Undefined when
   * nothing defensible was drawn. `nativeOwnerId` stays local-only for the
   * existing positional/clipboard validators; this key is what makes a source
   * replacement (a different host, row, run, selection, or conversation) a
   * semantic boundary even when the composed bytes are identical.
   */
  readonly contentKey: string | undefined;
  /**
   * The full drawn-source receipt descriptor: the content key plus the exact
   * subscription, publish sequence, canonical geometry revision, and the actual
   * uncovered rectangle. Only the copy carried by the presentation the writer
   * reported as `written` is a receipt; a queued, held, or superseded candidate
   * never becomes one.
   */
  readonly contentSource: string | undefined;
  /**
   * Geometry epoch of the remote-close highlight receipt. A resize advances the
   * live epoch, so a presentation written before it can never authorize a Close
   * after the terminal reflowed — even when the reflow returns to the same size
   * before anything is repainted, and even if an older in-flight write settles.
   */
  readonly remoteCloseEpoch: number;
  /**
   * Actual-written remote native IO receipt of THIS frame, only while the frame
   * drew the selected remote viewport uncovered inside Main. Absent for local
   * rows, covered panes, and for legacy display-only streams that publish no
   * host-written source. Never authority: the input and copy paths re-prove every
   * current fact on each protected attempt.
   */
  readonly nativeInput: WrittenRemoteNativeInput | undefined;
}

/**
 * The ONE content source Main displays: one local manager row, or one exact
 * remote owner run/row observed in a connected destination's roster. A remote
 * opaque id is never a local row id: every local mutator goes through
 * `localActiveId()`, so a remote selection can never reach a local manager
 * method even when the ids collide.
 */
type MainContentTarget = SidebarMainOwnerKey;

/**
 * One remote native viewport Main accepted for display. Every fact came from the
 * coordinator's own complete current view: the tuple it was published on, the
 * native conversation tuple the owner reported with it, the canonical geometry it
 * was drawn at, and the frame itself, carried unchanged.
 */
interface AcceptedRemoteContent {
  readonly hostId: string;
  readonly hostRunId: string;
  readonly rowId: string;
  readonly selectionGeneration: number;
  readonly subscriptionId: string;
  readonly sequence: number;
  readonly nativeSession: { readonly sessionId: string; readonly epoch: number } | null;
  readonly geometry: CanonicalSessionGeometry;
  readonly frame: TerminalFrame;
  /** Stable across frames of one stream; distinct per host/run/row/selection/epoch. */
  readonly contentKey: string;
  /** Per-publish receipt descriptor (content key, subscription, sequence, geometry, rect). */
  readonly sourceKey: string;
  /** Bounded graphics owner key: never another host's image-id cache. */
  readonly graphicsOwnerId: string;
  /**
   * Immutable host-written native IO source carried by this exact complete
   * publish, or `undefined` when the owner offered none (or it was not coherent
   * with this view). Descriptive only: it is never authority, and it is never
   * re-read from a newer publish on an older viewport's behalf.
   */
  readonly inputSource: NativeIoSource | undefined;
  /**
   * Exact observed input modes of that same publish, or `undefined` when absent or
   * malformed. Both this and {@link inputSource} must be present before any input
   * may be attempted, so a missing or invalid fact removes the capability rather
   * than being guessed.
   */
  readonly inputModes: TerminalInputModes | undefined;
}

/** A graphics owner key the writer accepts (nonempty, control-free, <= 256 chars). */
function boundedOwnerKey(prefix: string, raw: string): string {
  const key = `${prefix}|${raw}`;
  if (!/[\x00-\x1f\x7f-\x9f]/.test(key) && key.length <= 200) return key;
  return `${prefix}|${createHash("sha256").update(raw).digest("hex")}`;
}

/**
 * Main's view of the ONE coordinator: everything {@link PeerCoordinator} already
 * promised, plus the content controller the production factory actually returns
 * and the rowless create controller the production factory now exposes. These are
 * typed as optional so a metadata-only or older coordinator keeps satisfying this
 * view without inventing frames, controllers, or capabilities it does not have.
 */
type MainPeerCoordinator = PeerCoordinator
  & Partial<Pick<PeerCoordinatorWithContent, "content">>
  & Partial<Pick<PeerCoordinatorWithCreate, "ownerCreate">>;

interface SavedDeleteConfirmationFrame {
  readonly renderToken: number;
  readonly cols: number;
  readonly rows: number;
  settled: boolean;
}

interface PeerConsentConfirmationFrame extends PeerConsentPresentation {
  readonly cols: number;
  readonly rows: number;
  settled: boolean;
}

/**
 * One frozen remote-close confirmation candidate: the minimal owner target and
 * the monotonic generation the dialog was opened with, plus the token the
 * sidebar minted for this exact drawn frame and the terminal geometry it was
 * composed at. Only a frame the actual writer reported as written (or as an
 * unchanged repaint of a frame this same candidate already settled) is proof.
 */
interface RemoteCloseConfirmationFrame {
  readonly target: {
    readonly hostId: string;
    readonly hostRunId: string;
    readonly rowId: string;
  };
  /** Bounded display title of the frozen target. Never part of any identity. */
  readonly title: string;
  readonly generation: number;
  readonly renderToken: number;
  readonly cols: number;
  readonly rows: number;
  settled: boolean;
}

/**
 * One frozen New-form frame: exactly what the sidebar drew (host identity, the
 * DTO's observed owner run, and the canonical workspace the field held), the
 * OUTER terminal geometry it was composed at, the form PANE rectangle the
 * sidebar actually rendered into, the geometry epoch it belongs to, and the
 * monotonic token that names it. Only a frame the actual writer reported as
 * written (or an unchanged repaint of a candidate this same frame already
 * settled) is proof that the operator sees this exact form.
 *
 * Terminal and pane geometry are deliberately separate facts: the pane is the
 * layout's form rect (wide) or its overlay rect (narrow), never the terminal
 * size, and a comparison across the two can never settle.
 */
interface CreateFormFrame extends SidebarCreateFormPresentation {
  /** Outer terminal columns/rows this composition was made at. */
  readonly terminalCols: number;
  readonly terminalRows: number;
  /** Geometry epoch; a resize retires every frame composed before it. */
  readonly epoch: number;
  settled: boolean;
}

/**
 * One bounded remote New attempt: the exact submitted destination, owner run,
 * workspace, form generation, and written receipt, plus the terminal AND form
 * pane geometry and the geometry epoch that receipt belonged to. Every fact was
 * captured at submission and is never re-derived from a later roster index,
 * label, selection, or layout; the owner host revalidates its own run.
 */
interface CreateOnPeerAttempt {
  readonly requestId: number;
  readonly hostId: string;
  readonly hostRunId: string;
  readonly workspace: string;
  readonly formGeneration: number;
  readonly renderToken: number;
  readonly terminalCols: number;
  readonly terminalRows: number;
  readonly paneCols: number;
  readonly paneRows: number;
  readonly epoch: number;
}

/** One bounded remote Close attempt, frozen for its notices and its marker. */
interface RemoteCloseAttempt {
  readonly hostId: string;
  readonly hostRunId: string;
  readonly rowId: string;
  /** Bounded display title of the row this attempt was about. */
  readonly title: string;
  /** True only for a deliberately confirmed request. */
  readonly confirmed: boolean;
  /** True only when this side's drawn facts positively showed complete idleness. */
  readonly cachedIdle: boolean;
}

/**
 * A bounded, ephemeral per-target reminder that the owner reported it was not
 * idle after an unconfirmed request this side believed was idle. It never
 * authorizes anything and never sets `confirmed` by itself: the next deliberate
 * request for the same owner run/row must be confirmed on a WRITTEN dialog.
 */
interface RemoteCloseConfirmationMarker {
  readonly hostId: string;
  readonly hostRunId: string;
  readonly rowId: string;
}

function sameMouseAuthorization(a: MouseFramePresentation, b: MouseFramePresentation): boolean {
  // Focus and owner are part of native click authorization even when a
  // too-small fallback and a hidden native cursor make the composed bytes
  // identical. Keep their transitions behind the writer's written boundary.
  if (a.focus !== b.focus || a.nativeOwnerId !== b.nativeOwnerId) return false;
  const pane = (rect: HostPaneRect | undefined): readonly number[] | null => rect === undefined
    ? null
    : [rect.column, rect.row, rect.cols, rect.rows];
  if (a.layout.sidebarOverlay !== b.layout.sidebarOverlay
    || pane(a.layout.sidebar)?.join(",") !== pane(b.layout.sidebar)?.join(",")
    || pane(a.layout.form)?.join(",") !== pane(b.layout.form)?.join(",")) return false;
  // The drawn content rectangle and the canonical size it was drawn from are part
  // of positional authority (#474). A session that grew or shrank behind a queued
  // replacement frame crosses the writer's written boundary before newly exposed
  // padding, or a new size, authorizes anything at all.
  const rect = (value: HostPaneRect | undefined): string => value === undefined
    ? ""
    : `${value.column}:${value.row}:${value.cols}:${value.rows}`;
  const geometry = (value: CanonicalSessionGeometry | undefined): string => value === undefined
    ? ""
    : `${value.cols}x${value.rows}@${value.revision}`;
  if (rect(a.nativeContent) !== rect(b.nativeContent)
    || geometry(a.nativeGeometry) !== geometry(b.nativeGeometry)) return false;
  // The drawn source itself is part of authorization: a different local row, a
  // different remote host/run/row/selection, or a new native conversation epoch
  // needs its own written frame before anything is authorized against it, even
  // when the composed bytes happen to match.
  if (a.contentKey !== b.contentKey) return false;
  if (a.layout.sidebar === undefined && a.layout.form === undefined) return true;
  return a.sidebar.authorizationKey === b.sidebar.authorizationKey;
}

/**
 * Value equality for one written remote-close highlight. Only the minimal owner
 * target, the drawn row/height, the pane geometry, the focus domain, and the
 * condensed preflight facts matter: never object identity, never the sidebar's
 * mouse-authorization key, and never the native conversation tuple, labels, or
 * content stream. A moved highlight, a reordered/reflowed row, or a changed
 * idleness/progress observation is a different written frame.
 */
function sameRemoteCloseRow(a: SidebarRemoteCloseRow | undefined, b: SidebarRemoteCloseRow | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.hostId === b.hostId
    && a.hostRunId === b.hostRunId
    && a.rowId === b.rowId
    && a.row === b.row
    && a.height === b.height
    && a.cols === b.cols
    && a.rows === b.rows
    && a.focus === b.focus
    && a.lifecycle === b.lifecycle
    && a.hasLiveProcess === b.hasLiveProcess
    && a.idle === b.idle;
}

function sameRemoteCloseTarget(
  a: { readonly hostId: string; readonly hostRunId: string; readonly rowId: string },
  b: { readonly hostId: string; readonly hostRunId: string; readonly rowId: string },
): boolean {
  return a.hostId === b.hostId && a.hostRunId === b.hostRunId && a.rowId === b.rowId;
}

function samePaneGeometry(a: HostPaneRect | undefined, b: HostPaneRect | undefined): boolean {
  return a === undefined
    ? b === undefined
    : b !== undefined && a.column === b.column && a.row === b.row && a.cols === b.cols && a.rows === b.rows;
}

function sameNativePaneGeometry(a: HostLayout, b: HostLayout): boolean {
  return a.cols === b.cols && a.rows === b.rows
    && a.sidebarOverlay === b.sidebarOverlay
    && !a.sidebarOverlay && a.sidebar !== undefined && b.sidebar !== undefined
    && a.form === undefined && b.form === undefined
    && samePaneGeometry(a.native, b.native)
    && samePaneGeometry(a.sidebar, b.sidebar);
}

function sameNativeMouseTarget(a: MouseFramePresentation, b: MouseFramePresentation): boolean {
  return a.focus === "sidebar" && b.focus === "sidebar"
    && a.nativeOwnerId !== undefined && a.nativeOwnerId === b.nativeOwnerId
    && samePaneGeometry(a.nativeContent, b.nativeContent)
    && sameNativePaneGeometry(a.layout, b.layout);
}

type MainStdin = EventEmitter & { isTTY?: boolean; readableEnded?: boolean };
type MainStdout = Writable & EventEmitter & { isTTY?: boolean; columns?: number; rows?: number };
type MainSignals = EventEmitter;

interface HostSnapshot {
  readonly packageRoot: string;
  readonly piExecutable?: string;
  readonly stateRoot?: string;
  readonly toggleKey?: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly startupCwd: string;
}

interface MainDependencies {
  readonly platform: NodeJS.Platform;
  readonly nodeVersion: string;
  readonly stdin: MainStdin;
  readonly stdout: MainStdout;
  readonly signals: MainSignals;
  readonly resolvePi: (options: { executable?: string; env: NodeJS.ProcessEnv }) => { file: string; version: string };
  readonly createBroker: (options?: { socketRoot?: string }) => Promise<StatusBroker>;
  readonly createSessionSetup: (options: { env: NodeJS.ProcessEnv }) => {
    nativeSetup: boolean;
    profileRegistry: ProfilePreparer;
    nativeAgentDir?: string;
  };
  readonly createManager: (options: InstanceManagerOptions) => OwningHostManager;
  /**
   * The presentation-independent owning-session operation boundary (#473): it
   * opens the host's one authoritative manager and owns the UI-independent row
   * operations. Focused tests may wrap the production factory to observe the
   * exact wiring without changing any behavior.
   */
  readonly createOwningHostService: (
    dependencies: OwningHostServiceDependencies,
  ) => OwningHostService;
  readonly createSidebar: (options: ConstructorParameters<typeof SidebarController>[0]) => SidebarController;
  /**
   * Main-owned networking; pure sidebar actions never construct transport or mutate trust.
   * The production factory returns the composed {@link PeerCoordinatorWithContent};
   * a metadata-only coordinator (an older fake, or a coordinator built without a
   * content source) stays valid here and simply has no content controller.
   */
  readonly createPeerCoordinator: (options: PeerCoordinatorOptions) => MainPeerCoordinator;
  /** Read-only listing of the shared native agent root's saved conversations. */
  readonly listSavedCatalog: (options: {
    agentDir: string;
    piExecutable: string;
    expectedPiVersion: string;
    signal: AbortSignal;
  }) => Promise<SavedSessionCatalog>;
  readonly deleteSavedFile: typeof deleteSavedSessionFile;
  /**
   * Acquire exclusive ownership of the canonical Pi agent directory and read
   * its globally persisted roster. Production resolves the real store; focused
   * tests inject a hermetic implementation so no real user agent data or lock
   * is ever touched.
   */
  readonly openHostState: (options: { agentDir: string; hostId: string }) => HostStateOpenResult;
  readonly readHostShortcutConfig: (agentDir: string) => HostShortcutConfigReadResult;
  readonly writeHostShortcutConfig: (
    agentDir: string,
    bindings: HostShortcutBindings,
    legacyToggleOverride?: string,
  ) => HostShortcutBindings;
  readonly createTerminal: () => MainTerminal;
  readonly createObserver: (options: ConstructorParameters<typeof KeyboardCapabilityObserver>[0]) => MainObserver;
  readonly createWriter: (output: Writable, options: Parameters<typeof createSessionHostFrameWriter>[1]) => MainWriter;
  /**
   * Internal, default-off opt-in for the closed native input-framing mode of this
   * host's owned children, plus the remote native input/text-copy integration for
   * the ONE selected remote viewport. Only an explicit `true` supplies the
   * coordinator's dynamic callbacks and forwards the existing manager option to
   * children created later by this host; the legacy call shape, the display-only
   * remote path, local input, and the local clipboard route are byte-for-byte
   * unchanged otherwise. It is not a CLI flag, setting, public option, permission,
   * grant, lease, or activation.
   */
  readonly nativeInputOriginFraming?: boolean;
  readonly runExternalEditor: typeof runNativeExternalEditor;
  /**
   * Private bounded terminal diagnostics log under the canonical native agent
   * directory (#428). Focused tests may inject small rotation limits.
   */
  readonly createTerminalDiagnosticsLog: (options: TerminalDiagnosticsLogOptions) => TerminalDiagnosticsLogLike;
  readonly reportError: (message: string) => void;
}

/**
 * One remembered sidebar roster slot tracked by Main. `slotId` is stable for
 * the slot across native /new and /resume identity changes; `rowId` is the
 * current manager row id when this slot owns a live manager row, and is absent
 * for a remembered conversation that could not be restored (visible as a
 * bounded error row instead of a silently started fresh session). Identity
 * fields stay optional: a row that never reported native metadata, or a
 * conversation that could not be restarted, is still a remembered slot.
 */
interface RosterRecord {
  readonly slotId: string;
  rowId?: string;
  sessionId?: string;
  workspace?: string;
  name?: string;
  persistence?: "saved" | "unsaved" | "unknown";
  /** Bounded truthful reason this remembered conversation is not restorable. */
  unavailableReason?: string;
}

class MainFailure extends Error {
  constructor(readonly phase: "startup-options" | "preflight" | "runtime") {
    super(phase);
  }
}

class HostShortcutStartupFailure extends Error {}

type RowResumeReadiness = "ready" | "pending" | "failed";

function containsHostPoint(rect: HostPaneRect, column: number, row: number): boolean {
  return column >= rect.column && column < rect.column + rect.cols
    && row >= rect.row && row < rect.row + rect.rows;
}

/**
 * The rectangle a native frame actually filled inside the native pane (#474).
 *
 * A session smaller than the pane is drawn at the pane's top-left corner and
 * padded, so its content rectangle is smaller than the pane. `undefined` means
 * nothing defensible was drawn: a missing or malformed frame, or a frame larger
 * than the pane, which the compositor clips rather than displays whole.
 */
function nativeContentRect(pane: HostPaneRect, frame: { cols: number, rows: number } | undefined): HostPaneRect | undefined {
  if (frame === undefined) return undefined;
  if (!Number.isSafeInteger(frame.cols) || !Number.isSafeInteger(frame.rows)
    || frame.cols < 1 || frame.rows < 1
    || frame.cols > pane.cols || frame.rows > pane.rows) return undefined;
  if (frame.cols === pane.cols && frame.rows === pane.rows) return pane;
  return { column: pane.column, row: pane.row, cols: frame.cols, rows: frame.rows };
}

function sameCanonicalGeometry(a: CanonicalSessionGeometry | undefined, b: CanonicalSessionGeometry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.cols === b.cols && a.rows === b.rows && a.revision === b.revision;
}

/**
 * Outer terminal mouse-reporting mode number for one observed tracking mode; the
 * same mapping the local child path already uses. `none` requests no capture, and
 * `sgr-pixels` is never requested because positional input is expressed in cells.
 */
function mouseTrackingNumber(tracking: TerminalInputModes["mouseTracking"]): number | undefined {
  return tracking === "x10" ? 9
    : tracking === "vt200" ? 1000
      : tracking === "drag" ? 1002
        : tracking === "any" ? 1003
          : undefined;
}

const NATIVE_IO_MOUSE_TRACKING: ReadonlySet<string> = new Set(["none", "x10", "vt200", "drag", "any"]);
const NATIVE_IO_MOUSE_ENCODING: ReadonlySet<string> = new Set(["default", "sgr", "sgr-pixels"]);
const NATIVE_IO_SOURCE_TOKEN = /^[\x21-\x7e]+$/;

/**
 * Validate and take an immutable copy of the input modes carried by one complete
 * publish. Only the closed shape the protocol reader admits is accepted; a
 * missing or malformed fact yields `undefined` (no input capability) instead of a
 * guess or an inferred default.
 */
function readRemoteInputModes(value: unknown): TerminalInputModes | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const modes = value as Record<string, unknown>;
  const kittyFlags = modes.kittyFlags;
  if (typeof kittyFlags !== "number" || !Number.isSafeInteger(kittyFlags) || kittyFlags < 0 || kittyFlags > 7) {
    return undefined;
  }
  const modifyOtherKeys = modes.modifyOtherKeys;
  if (modifyOtherKeys !== 0 && modifyOtherKeys !== 1 && modifyOtherKeys !== 2) return undefined;
  const applicationCursorKeys = modes.applicationCursorKeys;
  const applicationKeypad = modes.applicationKeypad;
  const bracketedPaste = modes.bracketedPaste;
  if (typeof applicationCursorKeys !== "boolean"
    || typeof applicationKeypad !== "boolean"
    || typeof bracketedPaste !== "boolean") return undefined;
  const mouseTracking = modes.mouseTracking;
  if (typeof mouseTracking !== "string" || !NATIVE_IO_MOUSE_TRACKING.has(mouseTracking)) return undefined;
  const mouseEncoding = modes.mouseEncoding;
  if (typeof mouseEncoding !== "string" || !NATIVE_IO_MOUSE_ENCODING.has(mouseEncoding)) return undefined;
  return Object.freeze({
    kittyFlags,
    applicationCursorKeys,
    applicationKeypad,
    bracketedPaste,
    mouseTracking: mouseTracking as TerminalInputModes["mouseTracking"],
    modifyOtherKeys,
    mouseEncoding: mouseEncoding as TerminalInputModes["mouseEncoding"],
  });
}

/** Exact semantic equality of one observed mode set. */
function sameTerminalInputModes(a: TerminalInputModes | undefined, b: TerminalInputModes | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.kittyFlags === b.kittyFlags
    && a.applicationCursorKeys === b.applicationCursorKeys
    && a.applicationKeypad === b.applicationKeypad
    && a.bracketedPaste === b.bracketedPaste
    && a.mouseTracking === b.mouseTracking
    && a.modifyOtherKeys === b.modifyOtherKeys
    && a.mouseEncoding === b.mouseEncoding;
}

/**
 * Validate and take an immutable copy of the host-written native IO source of one
 * complete accepted publish. It must be coherent with that publish's own owner
 * run, row, native conversation tuple, and canonical geometry; anything else is
 * not an input source. Every source field is copied, never retained by reference.
 */
function readRemoteNativeIoSource(
  value: unknown,
  expected: {
    readonly hostRunId: string;
    readonly sessionId: string;
    readonly nativeSession: { readonly sessionId: string; readonly epoch: number } | null;
    readonly geometry: CanonicalSessionGeometry;
  },
): NativeIoSource | undefined {
  if (value === null || typeof value !== "object" || expected.nativeSession === null) return undefined;
  const record = value as Record<string, unknown>;
  const hostRunId = record.hostRunId;
  const sessionId = record.sessionId;
  const maxIdentifier = DEFAULT_SESSION_CONTENT_BOUNDS.maxIdentifierBytes;
  if (typeof hostRunId !== "string" || hostRunId.length === 0 || hostRunId.length > maxIdentifier) return undefined;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > maxIdentifier) return undefined;
  if (hostRunId !== expected.hostRunId || sessionId !== expected.sessionId) return undefined;
  const native = record.nativeSession;
  if (native === null || typeof native !== "object") return undefined;
  const nativeRecord = native as Record<string, unknown>;
  const nativeSessionId = nativeRecord.sessionId;
  const epoch = nativeRecord.epoch;
  if (typeof nativeSessionId !== "string" || nativeSessionId.length === 0 || nativeSessionId.length > maxIdentifier) {
    return undefined;
  }
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) return undefined;
  if (nativeSessionId !== expected.nativeSession.sessionId || epoch !== expected.nativeSession.epoch) return undefined;
  const geometry = record.geometry;
  if (geometry === null || typeof geometry !== "object") return undefined;
  const geometryRecord = geometry as Record<string, unknown>;
  const cols = geometryRecord.cols;
  const rows = geometryRecord.rows;
  const revision = geometryRecord.revision;
  if (typeof cols !== "number" || !Number.isSafeInteger(cols) || cols < 1
    || typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 1
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return undefined;
  if (cols !== expected.geometry.cols || rows !== expected.geometry.rows
    || revision !== expected.geometry.revision) return undefined;
  const viewerRevision = record.viewerRevision;
  if (typeof viewerRevision !== "number" || !Number.isSafeInteger(viewerRevision) || viewerRevision < 1) {
    return undefined;
  }
  const sourceToken = record.sourceToken;
  if (typeof sourceToken !== "string" || sourceToken.length === 0
    || sourceToken.length > NATIVE_IO_MAX_SOURCE_TOKEN_BYTES || !NATIVE_IO_SOURCE_TOKEN.test(sourceToken)) {
    return undefined;
  }
  return Object.freeze({
    hostRunId,
    sessionId,
    nativeSession: Object.freeze({ sessionId: nativeSessionId, epoch }),
    geometry: Object.freeze({ cols, rows, revision }),
    viewerRevision,
    sourceToken,
  });
}

/**
 * Semantic identity of one actual-written remote native IO receipt.
 *
 * Two equal keys mean the same written source, native tuple and epoch, canonical
 * geometric revision, viewer revision, host commitment, observed modes, and drawn
 * content rectangle — so ordinary terminal text output (which mints fresh
 * snapshots, frames, and sequences without changing any of these) never forces a
 * writer boundary or stalls typing. Object identity and publish sequence are
 * deliberately absent. This key only decides writer-invalidation and the remote IO
 * proof; it is never part of the shared UI/mouse/Close authorization identity.
 */
function nativeIoReceiptKey(receipt: WrittenRemoteNativeInput | undefined): string {
  if (receipt === undefined) return "";
  const source = receipt.source;
  const modes = receipt.inputModes;
  const rect = receipt.nativeContent;
  return JSON.stringify([
    receipt.hostId, receipt.hostRunId, receipt.rowId, receipt.selectionGeneration, receipt.subscriptionId,
    source.hostRunId, source.sessionId, source.nativeSession.sessionId, source.nativeSession.epoch,
    source.geometry.cols, source.geometry.rows, source.geometry.revision,
    source.viewerRevision, source.sourceToken,
    modes.kittyFlags, modes.applicationCursorKeys, modes.applicationKeypad, modes.bracketedPaste,
    modes.mouseTracking, modes.modifyOtherKeys, modes.mouseEncoding,
    rect.column, rect.row, rect.cols, rect.rows,
    receipt.resizeEpoch,
  ]);
}

function sameNativeIoReceipt(
  a: WrittenRemoteNativeInput | undefined,
  b: WrittenRemoteNativeInput | undefined,
): boolean {
  return a === b || nativeIoReceiptKey(a) === nativeIoReceiptKey(b);
}

function mouseButtonId(mouse: ParsedMouseInput): number | undefined {
  if (mouse.wheel) return undefined;
  const id = mouse.button & 3;
  return id === 3 ? undefined : id;
}

function isMouseButtonPress(mouse: ParsedMouseInput): boolean {
  return !mouse.release && !mouse.motion && !mouse.wheel && mouseButtonId(mouse) !== undefined;
}

function isLeftMousePress(mouse: ParsedMouseInput): boolean {
  return isMouseButtonPress(mouse) && mouse.button === 0;
}

/**
 * Readiness of an exited-row replacement child: an owned live process AND a
 * genuine authenticated CURRENT conversation observed on the manager's live
 * field. PTY spawn, the retained `lastNativeSession`, an original reservation,
 * or a launch/name guess are never readiness. `expectedSessionId` is the exact
 * branded saved admission for a saved restart; a fresh restart leaves it
 * undefined and accepts any safe new current id. A row with no live process or
 * a confirmed error/exit can never become ready.
 */
function rowResumeReadiness(
  view: NativeInstanceView | undefined,
  expectedSessionId: string | undefined,
): RowResumeReadiness {
  if (!view) return "failed";
  if (view.lifecycle === "error") return "failed";
  // Only a positively dead replacement child is an actual exit; missing or
  // unknown liveness is never accepted as one.
  if (view.lifecycle === "exited" && view.hasLiveProcess === false) return "failed";
  if (view.lifecycle !== "alive" || view.hasLiveProcess !== true) return "pending";
  const current = view.nativeSession;
  if (!current || !isValidNativeSessionId(current.sessionId)
    || !Number.isSafeInteger(current.epoch) || current.epoch < 1) {
    return "pending";
  }
  if (expectedSessionId !== undefined && current.sessionId !== expectedSessionId) return "failed";
  return "ready";
}

function snapshotOptions(options: SessionHostOptions): HostSnapshot {
  // Snapshot both mutable inputs before validation, startup admission, probing,
  // or any await. All per-row launches use these detached copies.
  const args = Object.freeze([...(options?.args ?? [])]);
  const env = { ...(options?.env ?? {}) };
  return {
    packageRoot: options?.packageRoot,
    piExecutable: options?.piExecutable,
    stateRoot: options?.stateRoot,
    toggleKey: options?.toggleKey,
    args,
    env,
    startupCwd: process.cwd(),
  };
}

function assertStartupOptions(snapshot: HostSnapshot): string {
  if (typeof snapshot.packageRoot !== "string" || !isAbsolute(snapshot.packageRoot)) {
    throw new MainFailure("startup-options");
  }
  let packageRoot: string;
  let helper: unknown;
  try {
    packageRoot = realpathSync(snapshot.packageRoot);
    // Do not search ancestor directories: the helper is part of this exact,
    // canonical package root and is shared with the parent launcher.
    helper = require(join(packageRoot, STARTUP_OPTIONS_HELPER));
  } catch {
    throw new MainFailure("startup-options");
  }
  const assertOptions = (helper as { assertSessionHostStartupOptions?: unknown } | null)?.assertSessionHostStartupOptions;
  if (typeof assertOptions !== "function") {
    throw new MainFailure("startup-options");
  }
  try {
    (assertOptions as (args: readonly string[], env: NodeJS.ProcessEnv) => void)(snapshot.args, snapshot.env);
    if (snapshot.toggleKey !== undefined) normalizeHostShortcutKey(snapshot.toggleKey, "toggle");
  } catch {
    // The shared helper's message is already bounded, but keep Main's
    // diagnostics fixed as a defense against unexpected helper failures.
    throw new MainFailure("startup-options");
  }
  return packageRoot;
}

function assertPreflight(snapshot: HostSnapshot, dependencies: MainDependencies): void {
  if (dependencies.platform !== "darwin" && dependencies.platform !== "linux" && dependencies.platform !== "win32") {
    throw new MainFailure("preflight");
  }
  if (!stableNodeVersion(dependencies.nodeVersion)) {
    throw new MainFailure("preflight");
  }
  if (!dependencies.stdin.isTTY || !dependencies.stdout.isTTY) {
    throw new MainFailure("preflight");
  }
  if (snapshot.env[RUNTIME_ROLE_ENV] || snapshot.env[EXECUTOR_TOOL_CATALOG_ENV]) {
    throw new MainFailure("preflight");
  }
  if (!Array.isArray(snapshot.args) || snapshot.args.some((arg) => typeof arg !== "string")) {
    throw new MainFailure("preflight");
  }
}

function safeReport(dependencies: MainDependencies, message: string): void {
  try {
    dependencies.reportError(message);
  } catch {
    // Diagnostics never override ownership cleanup or caller streams.
  }
}

function clampDimension(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

function nativeKeyHint(
  manager: SessionHostFieldKeybindings,
  action: string,
  fallback: string,
  excludedActions: readonly string[] = [],
): string {
  try {
    const source = manager as SessionHostFieldKeybindings & { getKeys?: (keybinding: string) => string[] };
    const keys = source.getKeys?.(action);
    if (!Array.isArray(keys)) return fallback;
    const excluded = new Set(excludedActions.flatMap((binding) => source.getKeys?.(binding) ?? []));
    const effective = keys.filter((key) => !excluded.has(key));
    return effective.length === 0 ? "unbound" : effective.join("/");
  } catch {
    return fallback;
  }
}

/**
 * Canonical real path of an existing workspace directory, or undefined. Used to
 * require that an automatically restored conversation is restarted in exactly
 * the workspace that was remembered, never in a newly recorded one.
 */
function canonicalExistingDirectory(path: string | undefined): string | undefined {
  if (typeof path !== "string" || path === "") return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Per-release-line Node security minimums (issue 489), mirroring meetsNodeFloor
 * in scripts/pi-review-sessions.cjs. Any other major inherits the floor of the
 * nearest listed lower line, so newer unlisted majors keep the existing policy
 * and releases below Node 22 are refused. Main admits stable versions only.
 */
const NODE_LINE_FLOORS: readonly (readonly [number, number, number])[] = [[22, 23, 4], [24, 22, 1], [26, 12, 1]];

function stableNodeVersion(version: string): boolean {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parsed) return false;
  const actual = parsed.slice(1).map(Number);
  const major = actual[0]!;
  const floor = [...NODE_LINE_FLOORS].reverse().find(([floorMajor]) => floorMajor <= major) ?? NODE_LINE_FLOORS[0]!;
  for (let index = 0; index < floor.length; index += 1) {
    if (actual[index]! > floor[index]!) return true;
    if (actual[index]! < floor[index]!) return false;
  }
  return true;
}

function sidebarFocus(focus: SidebarController["focus"]): HostFocus {
  return focus;
}

/** Truthful, bounded picker notices for each admission refusal reason. */
function savedRefusalNotice(reason: SavedSessionRefusalReason): string {
  switch (reason) {
    case "stale-catalog":
      return "The saved list is stale; reopen Saved conversations";
    case "unknown-row":
      return "That saved conversation is no longer available; reopen the list";
    case "missing-file":
    case "not-a-regular-file":
    case "symlink-file":
    case "outside-sessions-root":
      return "That saved conversation file is unavailable; reopen the list";
    case "replaced-file":
    case "malformed-header":
      return "That saved conversation changed since it was listed; reopen the list";
    case "workspace-unavailable":
      return "The saved conversation's workspace is no longer available";
    case "known-owned-duplicate":
      return "That saved conversation is already open in this host";
  }
}

function savedDeletionRefusalNotice(reason: SavedSessionDeletionRefusalReason): string {
  if (reason === "known-owned-duplicate" || reason === "unknown-live-binding") {
    return "Close the Pi session using this conversation before deleting its saved file";
  }
  if (reason === "stale-catalog" || reason === "unknown-row") {
    return "The saved list changed; reopen Saved conversations before deleting";
  }
  if (reason === "replaced-file" || reason === "malformed-header") {
    return "The saved file changed since it was listed; no file was deleted";
  }
  return "The saved file is unavailable or unsafe; no file was deleted";
}

function savedDeletionFailureMessage(result: SavedSessionDeletionResult): string {
  if (result.refusal !== undefined) {
    const reason = result.refusal as SavedSessionDeletionRefusalReason;
    const notice = savedDeletionRefusalNotice(reason);
    return result.error === undefined ? notice : `${notice} (${result.error})`;
  }
  return result.error === undefined
    ? "The saved conversation was not deleted"
    : `The saved conversation was not deleted: ${result.error}`;
}

function statusRegistrar(broker: StatusBroker): StatusRegistrar {
  return {
    register(instanceId, handlers, options) {
      // The manager's closed per-registration options are not this adapter's to
      // interpret: forward the exact object so the ACTUAL broker records the
      // requested mode in the one-shot bootstrap before any child exists. An
      // absent request stays absent, preserving the legacy bootstrap.
      const registration = broker.register(instanceId, {
        onStatus: (status) => {
          const update: InstanceStatusUpdate = {
            busy: status.busy,
            pendingInput: status.pendingInput,
            inputSurface: status.inputSurface,
            backgroundTasks: status.backgroundTasks ?? null,
            backgroundShells: status.backgroundShells ?? null,
            activeTasks: status.activeTasks ?? null,
            activeShells: status.activeShells ?? null,
            activity: status.activity,
            ...(status.nativeSession === undefined ? {} : { nativeSession: status.nativeSession }),
          };
          handlers.onStatus(update);
        },
        onDisconnect: handlers.onDisconnect,
        ...(handlers.onReconnect ? { onReconnect: handlers.onReconnect } : {}),
        ...(handlers.onSpawnRequest ? { onSpawnRequest: handlers.onSpawnRequest } : {}),
      }, options);
      // Keep the broker's exact registration closures and their auth/tuple fences.
      return registration satisfies InstanceStatusRegistration;
    },
  };
}

function toSidebarItem(view: NativeInstanceView): SidebarItem {
  const current = view.nativeSession;
  // The authenticated current-file observation is private guard data. Never
  // let it cross into the sidebar DTO even if a manager implementation passes
  // the protocol object through unchanged.
  const nativeSession = current === null ? null : {
    sessionId: current.sessionId,
    epoch: current.epoch,
    name: current.name,
    ...(current.persistence === undefined ? {} : { persistence: current.persistence }),
  };
  const item: SidebarItem = {
    id: view.id,
    label: view.label,
    workspace: view.workspace,
    agentDir: view.agentDir,
    lifecycle: view.lifecycle,
    hasLiveProcess: view.hasLiveProcess,
    busy: view.busy,
    pendingInput: view.pendingInput,
    inputSurface: view.inputSurface,
    backgroundTasks: view.backgroundTasks ?? null,
    backgroundShells: view.backgroundShells ?? null,
    activeTasks: view.activeTasks ?? null,
    activeShells: view.activeShells ?? null,
    activity: view.activity,
    nativeSession,
  };
  if (view.exitCode !== undefined) {
    return { ...item, exitCode: view.exitCode };
  }
  return item;
}

function productionDependencies(): MainDependencies {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    stdin: process.stdin as unknown as MainStdin,
    stdout: process.stdout as unknown as MainStdout,
    signals: process as unknown as MainSignals,
    resolvePi: resolveNativePi,
    createBroker: (options) => createStatusBroker(options),
    createSessionSetup: ({ env }) => {
      const registry = new NativeAgentRegistry({ env });
      return { nativeSetup: true, profileRegistry: registry, nativeAgentDir: registry.agentDir };
    },
    createManager: (options) => new InstanceManager(options),
    createOwningHostService: (serviceDependencies) => createLocalOwningHostService(serviceDependencies),
    createSidebar: (options) => new SidebarController(options),
    createPeerCoordinator,
    listSavedCatalog: listSavedSessions,
    deleteSavedFile: deleteSavedSessionFile,
    openHostState: openProductionHostState,
    readHostShortcutConfig,
    writeHostShortcutConfig,
    createTerminal: () => new ProcessTerminal(),
    createObserver: (options) => new KeyboardCapabilityObserver(options),
    createWriter: (output, options) => createSessionHostFrameWriter(output, options),
    runExternalEditor: runNativeExternalEditor,
    createTerminalDiagnosticsLog: (logOptions) => new TerminalDiagnosticsLog(logOptions),
    reportError: (message) => { process.stderr.write(`${message}\n`); },
  };
}

/**
 * Run an opt-in native session host. The module is inert until this function is
 * called; it does not construct a terminal, broker, setup registry, timer, listener,
 * or PTY as an import side effect.
 */
export async function runSessionHost(options: SessionHostOptions): Promise<number> {
  let snapshot: HostSnapshot;
  try {
    snapshot = snapshotOptions(options);
  } catch {
    safeReport(productionDependencies(), GENERIC_FAILURE_MESSAGE);
    return 1;
  }
  return runSessionHostController(snapshot, productionDependencies());
}

async function runSessionHostController(snapshot: HostSnapshot, dependencies: MainDependencies): Promise<number> {
  let packageRoot: string;
  try {
    // Windows environment names are case-insensitive. Normalize and reject
    // ambiguous ordinary aliases before startup storage/role checks, resolver
    // probes, or any resource construction. POSIX remains case-sensitive.
    snapshot = {
      ...snapshot,
      env: snapshotNativeEnvironment(snapshot.env, dependencies.platform),
    };
    packageRoot = assertStartupOptions(snapshot);
    assertPreflight(snapshot, dependencies);
  } catch (error) {
    safeReport(dependencies, error instanceof MainFailure && error.phase === "startup-options"
      ? "Session host startup options were rejected."
      : "Session host preflight failed.");
    return 1;
  }

  let pi: { file: string; version: string } | undefined;
  let sessionSetup: {
    nativeSetup: boolean;
    profileRegistry: ProfilePreparer;
    nativeAgentDir?: string;
  } | undefined;
  let broker: StatusBroker | undefined;
  let manager: OwningHostManager | undefined;
  let terminal: MainTerminal | undefined;
  let observer: MainObserver | undefined;
  let writer: MainWriter | undefined;
  let sidebar: SidebarController | undefined;
  let peerCoordinator: MainPeerCoordinator | undefined;
  let peerUiSnapshot: PeerUiSnapshot | undefined;
  let peerNetworkSettled = true;
  const peerBellAttempts = new Set<string>();
  let peerConsentConfirmationFrame: PeerConsentConfirmationFrame | undefined;
  let terminalStartAttempted = false;
  let terminalStarted = false;
  let observerListenerAttached = false;
  let startupComplete = false;
  let shutdownRequested = false;
  let runtimeFailure = false;
  let cleanupFailure = false;
  let shortcutStartupDiagnosticReported = false;
  let configuredHostShortcuts: HostShortcutBindings = DEFAULT_HOST_SHORTCUTS;
  let effectiveHostShortcuts: HostShortcutBindings = DEFAULT_HOST_SHORTCUTS;
  let hostShortcutAgentDir: string | undefined;
  const legacyToggleOverride = snapshot.toggleKey !== undefined;
  // The ONE content source this host displays (issue #389 display phase): a
  // local manager row, or one exact remote owner run/row. Every deliberate
  // selection — local or remote — advances `contentSelectionGeneration`, so a
  // superseded selection, callback, or late completion never retargets the pane.
  let contentTarget: MainContentTarget | undefined;
  let contentSelectionGeneration = 0;
  /** The accepted remote viewport, dropped the moment it stops being current. */
  let remoteContentView: AcceptedRemoteContent | undefined;
  /**
   * Internal, default-off opt-in for remote native input and text copies. Read once
   * from the injected dependencies; nothing in this host turns it on, and an
   * absent/false value keeps the exact legacy display-only path.
   */
  const remoteNativeInputEnabled = dependencies.nativeInputOriginFraming === true;
  /**
   * Monotonic remote native IO geometry epoch, advanced by every outer resize.
   *
   * An outer resize can reflow the physical screen and then return to its original
   * dimensions before any replacement frame is written (80 -> 70 -> 80). Pane
   * rectangle equality alone would then let a pre-resize receipt authorize input
   * and copies again, even though the screen may have been physically reflowed and
   * the replacement frame was never written. A written receipt carries the epoch
   * it was composed under; authority additionally requires the current epoch to
   * match, so a late pre-resize settlement can never revive it. This is a
   * remote-IO-only fact and adds nothing to Close or ordinary sidebar authority.
   */
  let remoteInputEpoch = 0;
  /**
   * The ONE brief remote-input notice shown when no sidebar pane is drawn to
   * carry the sidebar's own notice slot. Set and replaced by the same fixed
   * messages; no per-input history, and no focus or overlay change.
   */
  let remoteInputNotice: string | undefined;
  /** Truthful display status of the deliberately selected remote stream. */
  let remoteContentStatus: { state: "waiting" | "unavailable"; message: string } | undefined;
  /** The one viewport this viewer last asked the selected stream for (deduped). */
  let lastContentViewport: { generation: number; cols: number; rows: number } | undefined;
  /** True while Main holds an outstanding selection with the one coordinator. */
  let contentStreamRequested = false;
  let views: NativeInstanceView[] = [];
  // Successful removals are terminal for this host id. A delayed roster
  // notification must not resurrect a detached row.
  const removedExitedIds = new Set<string>();
  // Globally persisted roster (issue 331): exclusive agent-directory ownership,
  // the remembered ordered slots, and the mapping from this run's manager rows
  // back to their slots. The store is mutated ONLY by roster changes (row
  // create/remove/rename/activate) and never by Quit or teardown, so a normal
  // host shutdown stops owned children without forgetting the roster.
  let hostState: HostStateHandle | undefined;
  const rosterRecords = new Map<string, RosterRecord>();
  const rowSlots = new Map<string, string>();
  // Set for exactly the synchronous stretch of one `manager.create(...)` call
  // that continues an existing slot (startup restore or exited-row restart),
  // so the row inserted by that call is adopted into the reserved slot instead
  // of appending a new one. Nothing can interleave inside that stretch.
  let adoptingSlot: string | undefined;
  let rememberedActiveSlot: string | undefined;
  let lastPersistedRoster = "";
  let rosterSaveFailureNoted = false;
  let rosterOverflowNoted = false;
  let rosterProblemNoted = false;
  let restoreAbort: AbortController | undefined;
  // Every deliberate sidebar action (activation, removal, stop, navigation
  // that reaches Main, typing) advances this generation. A delayed startup
  // restore applies the remembered active entry only while the generation is
  // unchanged, so a later user action is never overridden even when it left
  // `contentTarget` undefined or moved it to a remote owner.
  let deliberateActionGeneration = 0;
  // Positive evidence that this host's owned-child state settled: a successful
  // manager shutdown result, or a live-state query that actually answered.
  // Unknown/absent evidence never authorizes releasing exclusive ownership.
  let ownedStateSettled = false;
  let layout: HostLayout | undefined;
  let displayedMousePresentation: MouseFramePresentation | undefined;
  let latestMousePresentation: MouseFramePresentation | undefined;
  let savedDeleteConfirmationFrame: SavedDeleteConfirmationFrame | undefined;
  /** The one frozen remote-close confirmation candidate of the last composition. */
  let remoteCloseConfirmationFrame: RemoteCloseConfirmationFrame | undefined;
  /**
   * The one New-form frame the last composition actually handed the writer, and
   * the ONLY proof a remote New submission may rely on: it becomes authority
   * only when that exact candidate is reported written.
   */
  let createFormFrame: CreateFormFrame | undefined;
  /**
   * Advances on every terminal reflow/geometry retirement. A remote-New receipt
   * carries the epoch it was composed under, so a resize that returns to the same
   * dimensions before anything is repainted can never revive a stale receipt.
   * Ordinary renders, roster updates, and the pending-status repaint of an
   * already submitted form deliberately do NOT advance it.
   */
  let createFormEpoch = 0;
  /**
   * The ONE remote New request in flight on this host. It is deliberately not a
   * queue: a second submission while it is outstanding is refused truthfully
   * rather than queued, batched, or retargeted, and nothing about it is
   * re-derived from a later roster observation.
   */
  let createOnPeerAttempt: CreateOnPeerAttempt | undefined;
  /**
   * One owner-reported `started` row whose requester roster observation has not
   * arrived yet. It exists only to keep this side truthful while the coordinator's
   * own selection intent waits for the row: a `roster-unavailable`/`row-unavailable`
   * fence is then reported as pending, never as "unavailable". The ordinary roster
   * event (or any later deliberate selection) ends it; it never selects, polls,
   * replays, or retries anything by itself.
   */
  let pendingCreatedRemote:
    | { readonly hostId: string; readonly hostRunId: string; readonly rowId: string }
    | undefined;
  /** Remote targets with a close request already on its way to the owner. */
  const remoteCloseAttempts = new Set<string>();
  /**
   * Per-target owner-confirmation reminders (never authority). The observed
   * roster/run/host identity bounds this set; there is deliberately no fixed
   * cap that could evict a still-valid target's reminder.
   */
  const remoteCloseMarkers = new Map<string, RemoteCloseConfirmationMarker>();
  /**
   * Advances on every terminal geometry change. A remote-close highlight receipt
   * carries the epoch it was written in, so a reflow (even one that returns to
   * the previous size) never leaves stale highlight authority behind.
   */
  let remoteCloseHighlightEpoch = 0;
  let lastNativeCols: number | undefined;
  let lastNativeRows: number | undefined;
  let resizeInProgress = false;
  // This host's own local viewing surface (#474). Its content target follows the
  // local Main owner and its size follows the native pane; the one manager stores
  // both facts and performs the only resize. `localViewerState` is what this host
  // last registered — the row it displays and the pane it offered — so a created
  // row, a new selection, a detach, and any pane change all re-state the fact at
  // the one owner of geometry, while plain input and unrelated redraws do not.
  // `localViewerDirty` forces a re-state after a local action that must reach the
  // manager even when these recorded facts did not visibly move.
  let localViewerId: string | undefined;
  let localViewerState: { target: string | undefined; cols: number; rows: number } | undefined;
  let localViewerDirty = true;
  let rosterSyncInProgress = false;
  let rosterSyncQueued = false;
  let redrawQueued = false;
  let hostGraphicsEnabled = false;
  let negotiationReady = false;
  let observedFlags = 0;
  let passiveInputListener: ((data: string | Buffer) => void) | undefined;
  let mouseTrackingMode: number | undefined;
  let mouseSgrEnabled = false;
  // Buttons pressed over a host pane remain host-owned through drag/motion and
  // release, even if the pointer crosses into Main after activation.
  const hostMouseButtons = new Set<number>();
  let forcedCount = 0;
  let remainingCount = 0;
  let shutdownPromise: Promise<void> | undefined;
  let externalEditorActive = false;
  let externalEditorAbort: AbortController | undefined;
  let externalEditorTask: Promise<string | undefined> | undefined;
  const createTasks = new Set<Promise<void>>();
  // One close per row: the shared fence for BOTH the local `d`/Delete route and
  // the owner-side Close provider, and the existing shutdown barrier that awaits
  // every accepted close.
  const rowStopTasks = new Map<string, Promise<OwnerCloseFacts>>();
  // Exited-row restart (deliberate Enter): one attempt per old row id, a
  // per-request mapping for cancellation, and every task promise retained for
  // shutdown awaiting. The task map is the duplicate fence; the set is not.
  const rowResumeTasks = new Map<string, { readonly controller: AbortController; spawned: boolean }>();
  const rowResumeTaskSet = new Set<Promise<void>>();
  const rowResumeRequests = new Map<number, { readonly oldId: string; readonly controller: AbortController }>();
  // Exited-row restart native readiness is event-driven only: the manager's
  // existing onChange callback wakes these waiters (there is no polling, timer
  // loop, PID scan, or additional terminal owner). Each waiter is registered
  // for exactly one replacement child id and removed on settlement.
  const rowReadinessWaiters = new Map<string, Set<(forced: RowResumeReadiness | undefined) => void>>();
  const deferredRowResumes = new Map<number, { readonly requestId: number; readonly id: string }>();
  const deferredCreates = new Map<number, Extract<SidebarAction, { type: "create" }>>();
  // Deliberate saved-conversation picker (issue 323): the last accepted
  // catalog mints admissions; listing controllers are aborted on dismiss and
  // shutdown so late completions never contribute.
  let savedCatalog: SavedSessionCatalog | undefined;
  let savedCatalogPickerId: number | undefined;
  let savedCatalogRequestId: number | undefined;
  const savedListControllers = new Map<number, AbortController>();
  const savedOpenTasks = new Set<Promise<void>>();
  const deferredSavedOpens = new Map<number, { readonly file: string; readonly sessionId: string }>();
  // Terminal parser diagnostics (#428): a host-owned clearable warning plus a
  // private bounded log. Clearing the warning never touches the log.
  const diagnosticsWarning = new TerminalDiagnosticsWarning();
  let diagnosticsLog: TerminalDiagnosticsLogLike | undefined;
  // Actual native clipboard routing failures (#466) share that sink with
  // fixed codes only. Native Pi's own Copied feedback is the per-copy status;
  // the host adds none.
  const clipboardDiagnostics = new HostClipboardDiagnosticCollector({
    deliver: (instanceId, event) => handleTerminalDiagnostic(instanceId, event),
  });
  // The one presentation-independent owning-session boundary (#473). It is
  // constructed before any listener or teardown path can run, opens the only
  // manager this host will ever have, and owns the row operations that need no
  // presentation state. It keeps no session facts of its own: the teardown
  // latch is read live from this controller, never copied.
  const hostService = dependencies.createOwningHostService({
    createManager: dependencies.createManager,
    teardownRequested: () => shutdownRequested,
  });
  let finishRun!: (status: number) => void;
  const runFinished = new Promise<number>((resolve) => { finishRun = resolve; });

  const onSignal = (): void => requestShutdown(false);
  const onInputEnd = (): void => requestShutdown(false);
  const onOutputError = (): void => requestShutdown(true);
  const removeOuterListeners = (): void => {
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
      try {
        dependencies.signals.removeListener(signal, onSignal);
      } catch {
        cleanupFailure = true;
      }
    }
    try {
      dependencies.stdin.removeListener("end", onInputEnd);
    } catch {
      cleanupFailure = true;
    }
    try {
      dependencies.stdout.removeListener("error", onOutputError);
    } catch {
      cleanupFailure = true;
    }
  };

  function requestShutdown(failed: boolean): void {
    shutdownRequested = true;
    if (failed) runtimeFailure = true;
    try { externalEditorAbort?.abort(); } catch { /* exact child ownership is contained by the helper */ }
    if (startupComplete) beginShutdown();
  }

  function addOuterListeners(): void {
    dependencies.signals.on("SIGTERM", onSignal);
    dependencies.signals.on("SIGHUP", onSignal);
    dependencies.signals.on("SIGINT", onSignal);
    dependencies.stdin.on("end", onInputEnd);
    dependencies.stdout.on("error", onOutputError);
  }

  function findActiveView(): NativeInstanceView | undefined {
    const id = localActiveId();
    return id === undefined ? undefined : views.find((view) => view.id === id);
  }

  /**
   * The local row Main displays, or undefined while a remote owner (or nothing)
   * is selected. This is the ONLY path from the content target into local row
   * authority — `manager.surface/write/rename/stop/resume/remove`, the native
   * clipboard route, and the local viewing surface — so a remote opaque id can
   * never reach a local manager method, even on an id collision.
   */
  function localActiveId(): string | undefined {
    return contentTarget?.kind === "local" ? contentTarget.id : undefined;
  }

  /** The one content controller, or undefined for a metadata-only coordinator. */
  function contentController(): PeerContentController | undefined {
    const content = peerCoordinator?.content;
    if (content === undefined) return undefined;
    return typeof content.selectContent === "function"
      && typeof content.updateContentViewport === "function"
      && typeof content.readContent === "function"
      ? content
      : undefined;
  }

  /** The accepted remote viewport, only while it still matches the deliberate target. */
  function currentRemoteContentView(): AcceptedRemoteContent | undefined {
    const view = remoteContentView;
    const target = contentTarget;
    if (view === undefined || target === undefined || target.kind !== "remote") return undefined;
    if (view.selectionGeneration !== contentSelectionGeneration) return undefined;
    return view.hostId === target.hostId && view.rowId === target.rowId && view.hostRunId === target.hostRunId
      ? view
      : undefined;
  }

  /**
   * True only when the frame the writer ACTUALLY committed drew a remote source.
   * A queued, held, or superseded candidate is never a receipt, so an
   * identical-bytes replacement of a different source cannot inherit authority.
   */
  function writtenSourceIsRemote(): boolean {
    return displayedMousePresentation?.contentSource?.startsWith("remote|") === true;
  }

  /** Release the single global stream; never a remote stop, retry, or notice. */
  function releaseSelectedContent(): void {
    if (!contentStreamRequested) return;
    contentStreamRequested = false;
    const content = contentController();
    if (content === undefined) return;
    try {
      content.selectContent(null);
    } catch {
      // The coordinator owns its own bounded failure reporting; Main displays
      // only what its observation says and never retries here.
    }
  }

  /** Drop Main's remote display facts (the deliberate target is cleared by the caller). */
  function clearRemoteContentSelection(): void {
    remoteContentView = undefined;
    remoteContentStatus = undefined;
    lastContentViewport = undefined;
    remoteInputNotice = undefined;
    // A later local selection or an explicit detach supersedes any create-awaiting
    // fact; it never re-selects, retries, or polls on its own.
    pendingCreatedRemote = undefined;
    releaseSelectedContent();
    // Releasing the remote source returns pointer capture to the ordinary host
    // path; nothing is submitted without a written remote source.
    if (remoteNativeInputEnabled) syncOuterMouseModes();
  }

  /**
   * Deliberate display of one exact remote owner row. The roster DTO is the only
   * source of the tuple: `hostRunId === null` honestly means no owner run was
   * observed, and Main never guesses one, never connects, never prompts for a
   * key, and never falls back to a local row or another host. Keys, grants, run,
   * row, generation, and stream retirement stay with the one coordinator.
   */
  function selectRemoteContent(hostId: string, hostRunId: string | null, rowId: string): void {
    const usable = typeof hostId === "string" && hostId.length > 0
      && typeof rowId === "string" && rowId.length > 0
      && (hostRunId === null || (typeof hostRunId === "string" && hostRunId.length > 0));
    if (!usable) {
      sidebar?.showError(REMOTE_CONTENT_INVALID_MESSAGE);
      scheduleRedraw();
      return;
    }
    contentSelectionGeneration += 1;
    contentTarget = { kind: "remote", hostId, hostRunId, rowId };
    remoteContentView = undefined;
    lastContentViewport = undefined;
    // A new deliberate selection is a new context: the one brief notice belongs
    // to the previous target and is not carried over.
    remoteInputNotice = undefined;
    // Any LATER selection supersedes the freshly created row's awaiting fact. The
    // selection the create completion itself emits names that exact row, so it is
    // recognized here by identity — never by a label, index, or ordering.
    if (pendingCreatedRemote !== undefined
      && (pendingCreatedRemote.hostId !== hostId
        || pendingCreatedRemote.hostRunId !== hostRunId
        || pendingCreatedRemote.rowId !== rowId)) {
      pendingCreatedRemote = undefined;
    }
    const content = contentController();
    if (hostRunId === null || content === undefined) {
      // Nothing exact can be named to the coordinator, so nothing is requested.
      // The deliberate target is retained and reported truthfully as unavailable.
      releaseSelectedContent();
      remoteContentStatus = {
        state: "unavailable",
        message: hostRunId === null ? REMOTE_CONTENT_UNOBSERVED_MESSAGE : REMOTE_CONTENT_UNSUPPORTED_MESSAGE,
      };
      sidebar?.showError(remoteContentStatus.message);
    } else {
      const pane = currentHostLayout(clampDimension(terminal?.columns, 80), clampDimension(terminal?.rows, 24)).native;
      const cols = clampDimension(pane.cols, 80);
      const rows = clampDimension(pane.rows, 24);
      const selectionGeneration = contentSelectionGeneration;
      remoteContentStatus = { state: "waiting", message: REMOTE_CONTENT_WAITING_MESSAGE };
      lastContentViewport = { generation: selectionGeneration, cols, rows };
      try {
        content.selectContent({ hostId, hostRunId, rowId, selectionGeneration, cols, rows });
        contentStreamRequested = true;
      } catch {
        remoteContentStatus = { state: "unavailable", message: REMOTE_CONTENT_UNAVAILABLE_MESSAGE };
        sidebar?.showError(remoteContentStatus.message);
      }
    }
    // The local viewing surface displays nothing while a remote owner is shown.
    // Its siblings keep their last canonical size and their children keep
    // parsing and running; only the previously displayed row stops being shown.
    localViewerDirty = true;
    syncRosterAndSchedule();
    reconcileLayout(true);
  }

  /**
   * The one advisory content callback. It contributes display facts only: it
   * never selects, focuses, connects, retries, or writes, and it is fenced after
   * teardown. A frame is accepted only against Main's own current deliberate
   * target and the coordinator's own complete current view, so a superseded
   * callback, stale generation, different run/row, mixed frame/geometry pair, or
   * regressed sequence cannot paint another owner or resurrect a retired stream.
   */
  function handleContentChange(observation: PeerContentObservation): void {
    if (shutdownRequested || sidebar === undefined) return;
    const target = contentTarget;
    if (target === undefined || target.kind !== "remote") return;
    const generation = contentSelectionGeneration;
    const desired = observation.target;
    if (desired !== null && (desired.selectionGeneration !== generation
      || desired.hostId !== target.hostId
      || desired.rowId !== target.rowId
      || desired.hostRunId !== target.hostRunId)) {
      // A stale or foreign selection never touches this pane.
      return;
    }
    const view = observation.view;
    if (observation.state === "current" && view !== undefined && target.hostRunId !== null) {
      if (acceptRemoteView(view, { hostId: target.hostId, hostRunId: target.hostRunId, rowId: target.rowId }, generation)) {
        return;
      }
      // A published view that fails the tuple/geometry/sequence fences changes
      // nothing on screen; the current honest status stays as reported.
      scheduleRedraw();
      return;
    }
    const wasUnavailable = remoteContentStatus?.state === "unavailable";
    remoteContentView = undefined;
    // A retired or not-yet-current view stops defining pointer capture, so the
    // ordinary host path resumes until this owner publishes again.
    if (remoteNativeInputEnabled) syncOuterMouseModes();
    if (observation.state === "connecting" || observation.state === "current") {
      remoteContentStatus = { state: "waiting", message: REMOTE_CONTENT_WAITING_MESSAGE };
      scheduleRedraw();
      return;
    }
    // An owner-reported `started` row this side has not observed yet is NOT an
    // unavailable display: the coordinator's retained selection intent is served
    // by the next roster event. Only the two availability reasons are treated this
    // way; a lost connection, changed run, or missing pin stays a real refusal.
    const awaitingCreatedRow = pendingCreatedRemote !== undefined
      && pendingCreatedRemote.hostId === target.hostId
      && pendingCreatedRemote.hostRunId === target.hostRunId
      && pendingCreatedRemote.rowId === target.rowId
      && (observation.reason === "roster-unavailable" || observation.reason === "row-unavailable");
    if (awaitingCreatedRow) {
      remoteContentStatus = { state: "waiting", message: REMOTE_CONTENT_CREATED_WAITING_MESSAGE };
      scheduleRedraw();
      return;
    }
    remoteContentStatus = { state: "unavailable", message: REMOTE_CONTENT_UNAVAILABLE_MESSAGE };
    if (!wasUnavailable) sidebar?.showError(remoteContentStatus.message);
    scheduleRedraw();
  }

  /**
   * Accept one published viewport for display. Every tuple fact comes from the
   * owner's own transfer metadata — the native conversation tuple is captured
   * with its source and never derived from screen text — and the coordinator's
   * current view must still be this exact snapshot. The monotonic sequence fence
   * runs on a new accept only; the frame already on screen may be repainted.
   */
  function acceptRemoteView(
    view: PeerSelectedContent,
    target: { readonly hostId: string; readonly hostRunId: string; readonly rowId: string },
    generation: number,
  ): boolean {
    if (view.hostId !== target.hostId || view.selectionGeneration !== generation) return false;
    const snapshot = view.snapshot;
    const meta = snapshot.meta;
    const frame = snapshot.frame;
    if (!meta || !frame) return false;
    if (meta.hostRunId !== target.hostRunId || meta.sessionId !== target.rowId) return false;
    if (typeof meta.subscriptionId !== "string" || meta.subscriptionId.length === 0) return false;
    if (!Number.isSafeInteger(meta.sequence) || meta.sequence < 1) return false;
    const geometry = meta.geometry;
    if (!geometry
      || !Number.isSafeInteger(geometry.cols) || !Number.isSafeInteger(geometry.rows)
      || !Number.isSafeInteger(geometry.revision) || geometry.revision < 0
      || geometry.cols < 1 || geometry.rows < 1
      || geometry.cols > MAX_CONTENT_DIMENSION || geometry.rows > MAX_CONTENT_DIMENSION) {
      return false;
    }
    // The frame and the canonical geometry it claims must be one observation.
    if (frame.cols !== geometry.cols || frame.rows !== geometry.rows) return false;
    const nativeSession = meta.nativeSession === null || typeof meta.nativeSession !== "object"
      ? null
      : (typeof meta.nativeSession.sessionId === "string" && meta.nativeSession.sessionId.length > 0
        && Number.isSafeInteger(meta.nativeSession.epoch) && meta.nativeSession.epoch >= 1
        ? { sessionId: meta.nativeSession.sessionId, epoch: meta.nativeSession.epoch }
        : null);
    const previous = remoteContentView;
    if (previous !== undefined
      && previous.selectionGeneration === generation
      && previous.subscriptionId === meta.subscriptionId
      && meta.sequence <= previous.sequence) {
      // A repeated or regressed publish of one stream never replaces the frame
      // already on screen; the accepted frame may still be repainted.
      scheduleRedraw();
      return true;
    }
    // Only the coordinator's own complete current view may be painted.
    let current: PeerContentObservation | undefined;
    try {
      current = contentController()?.readContent();
    } catch {
      current = undefined;
    }
    if (current === undefined || current.view === undefined || current.view.snapshot !== snapshot) {
      scheduleRedraw();
      return true;
    }
    const epoch = nativeSession === null ? "none" : String(nativeSession.epoch);
    const contentKey = boundedOwnerKey("remote", [
      target.hostId, target.hostRunId, target.rowId, String(generation),
      nativeSession === null ? "none" : nativeSession.sessionId, epoch,
    ].join("|"));
    // The host-written native IO source and observed modes are retained from THIS
    // exact complete publish (never re-read from a newer one on its behalf). Both
    // are validated, copied, and frozen; a missing, unknown, or incoherent fact
    // leaves no input capability at all rather than an inferred one.
    const inputModes = readRemoteInputModes(meta.inputModes);
    const inputSource = inputModes === undefined ? undefined : readRemoteNativeIoSource(meta.inputSource, {
      hostRunId: target.hostRunId,
      sessionId: target.rowId,
      nativeSession,
      geometry: { cols: geometry.cols, rows: geometry.rows, revision: geometry.revision },
    });
    remoteContentView = {
      hostId: target.hostId,
      hostRunId: target.hostRunId,
      rowId: target.rowId,
      selectionGeneration: generation,
      subscriptionId: meta.subscriptionId,
      sequence: meta.sequence,
      nativeSession,
      geometry: { cols: geometry.cols, rows: geometry.rows, revision: geometry.revision },
      frame,
      contentKey,
      sourceKey: contentKey,
      graphicsOwnerId: contentKey,
      inputSource,
      inputModes,
    };
    // A positively accepted viewport for this exact row ends any awaiting fact: the
    // ordinary content path owns it from here, so a later loss is reported honestly.
    if (pendingCreatedRemote !== undefined
      && pendingCreatedRemote.hostId === target.hostId
      && pendingCreatedRemote.hostRunId === target.hostRunId
      && pendingCreatedRemote.rowId === target.rowId) {
      pendingCreatedRemote = undefined;
    }
    remoteContentStatus = undefined;
    // A freshly published view's own retained reporting mode (including a
    // mode-only change) is what the outer capture must follow.
    if (remoteNativeInputEnabled) syncOuterMouseModes();
    // A published viewport is the only reason this frame appears: an arriving
    // frame repaints on its own, with no keyboard, roster, or resize event.
    scheduleRedraw();
    return true;
  }

  /** The owner's own sanitized roster labels, used only for the title line. */
  function remoteContentHeader(hostId: string, rowId: string): string {
    const host = peerUiSnapshot?.hosts?.find((candidate) => candidate.id === hostId);
    const row = host?.roster.rows?.find((candidate) => candidate.id === rowId);
    const hostLabel = displayLabel(host?.label);
    const rowLabel = displayLabel(row?.label);
    if (hostLabel !== "" && rowLabel !== "") return `${hostLabel} \u00b7 ${rowLabel}`;
    return hostLabel !== "" ? hostLabel : "Remote session";
  }

  /** Bounded, control-free display text from an owner-supplied label. */
  function displayLabel(value: string | undefined): string {
    if (typeof value !== "string") return "";
    const clean = value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, "").trim();
    return clean.length <= 80 ? clean : clean.slice(0, 80);
  }

  /**
   * The host-owned truth shown in the native pane while a remote target is
   * deliberately selected and no authorized viewport is currently available. It
   * renders no remote content: the pane is the host's until the owner's own
   * frame is accepted, and it must not claim no session was selected.
   */
  function remoteStatusFrame(pane: HostPaneRect): TerminalFrame {
    const message = remoteContentStatus?.message ?? REMOTE_CONTENT_WAITING_MESSAGE;
    return {
      cols: pane.cols,
      rows: pane.rows,
      lines: Array.from({ length: pane.rows }, (_unused, index) => index === 0 ? message : ""),
      cursor: { column: 0, row: 0, visible: false },
    };
  }

  /**
   * Forward ONE deduped newest viewport for the current selection generation.
   * The pane size is only this viewer's request; the canonical geometry of what
   * is displayed always comes from the owner's own frame metadata.
   */
  function syncRemoteContentViewport(pane: HostPaneRect): void {
    const target = contentTarget;
    if (target === undefined || target.kind !== "remote" || target.hostRunId === null) return;
    const content = contentController();
    if (content === undefined) return;
    const cols = clampDimension(pane.cols, 80);
    const rows = clampDimension(pane.rows, 24);
    const generation = contentSelectionGeneration;
    if (lastContentViewport !== undefined
      && lastContentViewport.generation === generation
      && lastContentViewport.cols === cols
      && lastContentViewport.rows === rows) return;
    lastContentViewport = { generation, cols, rows };
    try {
      content.updateContentViewport({ selectionGeneration: generation, cols, rows });
    } catch {
      // Latest-only advisory sizing; the coordinator keeps its own one pending
      // request and its own bounded failure reporting.
    }
  }

  function updatePeerUi(snapshot: PeerUiSnapshot): void {
    if (shutdownRequested) return;
    try {
      sidebar?.setPeerUiSnapshot(snapshot);
    } catch {
      sidebar?.showError("Network display is unavailable; local sessions are unchanged");
      scheduleRedraw();
      return;
    }
    peerUiSnapshot = snapshot;
    // A reminder this host can positively see no longer applies is dropped here;
    // nothing is opened, retried, or confirmed by this reconciliation.
    reconcileRemoteCloseMarkers(snapshot);
    // The freshly created row's own roster event ends its awaiting fact: from here
    // the coordinator's ordinary roster reconciliation owns the retained
    // selection. A complete observation without that host/run/row is positive
    // loss, and an unobserved projection is no evidence either way.
    const created = pendingCreatedRemote;
    if (created !== undefined) {
      const host = snapshot.hosts?.find((candidate) => candidate.id === created.hostId);
      if (host === undefined) {
        pendingCreatedRemote = undefined;
      } else if ((host.roster.hostRunId ?? null) !== created.hostRunId) {
        pendingCreatedRemote = undefined;
      } else if (host.roster.rows !== null
        && host.roster.rows.some((row) => row.id === created.rowId)) {
        pendingCreatedRemote = undefined;
      }
    }
    // A written dialog for a target the owner no longer lists loses its
    // authority immediately instead of staying confirmable until a redraw.
    abandonVanishedRemoteCloseTarget();
    for (const id of peerBellAttempts) {
      if (!snapshot.consents.some((consent) => consent.id === id)) peerBellAttempts.delete(id);
    }
    const shown = peerConsentConfirmationFrame;
    if (shown && !isCurrentPeerConsentFrame(shown)) invalidatePeerConsentDisplay();
    // A hidden/narrow sidebar may need a visible non-focusing alert band. Only
    // the compositor/one viewer owner changes geometry; this never selects a row.
    if (!externalEditorActive) reconcileLayout(true);
    scheduleRedraw();
  }

  function attemptIncomingPeerBell(id: string): void {
    if (shutdownRequested || peerBellAttempts.has(id)) return;
    let current: PeerUiSnapshot | undefined;
    try { current = peerCoordinator?.read() ?? peerUiSnapshot; } catch { return; }
    if (!current?.consents.some((consent) => consent.id === id && consent.kind === "incoming")) return;
    peerBellAttempts.add(id);
    if (!current.settings?.bellEnabled || !terminalStarted || !terminal) return;
    try { terminal.write("\x07"); } catch { /* Best-effort attempt only; no retries, fallback, or shutdown. */ }
  }

  function startPeerNetworking(): void {
    const agentDir = sessionSetup?.nativeAgentDir;
    if (shutdownRequested || !hostState || sessionSetup?.nativeSetup !== true
      || typeof agentDir !== "string" || agentDir === "") return;
    try {
      const coordinator = dependencies.createPeerCoordinator({
        agentDir,
        inventory: hostService,
        // The SAME already-acquired owning-host service is the content source:
        // one manager, one inventory, one viewer registry. This adds no manager,
        // listener, store, grant, lease, or permission type; the owner-side
        // endpoint stays unreachable without a listener this coordinator starts.
        contentSource: hostService,
        // The owner-side Close provider is handed over at construction only.
        // This phase enables no remote Close: the coordinator never advertises,
        // sends, receives, or calls anything with it, so every existing lane,
        // fake, and frame behaves exactly as before. Main keeps the one close
        // core; no service, manager, store, registry, or global close API is
        // added, and `closeViewer` remains a display-surface retirement, never a
        // session close.
        closeOwnedSession,
        // The owner-side rowless Create provider is handed over at construction
        // only, exactly like Close. It is the same seam the local New action uses
        // (`hostService.startSession`), so it needs no second manager, no selected
        // row, no native conversation tuple, no viewer, and no launch/activate
        // path: the owner's own provider decides, and only a peer that negotiated
        // the optional capability can ever reach it.
        createOwnedSession,
        onChange: updatePeerUi,
        onIncomingConsentArrival: attemptIncomingPeerBell,
        onContentChange: handleContentChange,
        // Only an explicit internal opt-in supplies these callbacks. Each one is a
        // DYNAMIC re-proof of Main's current written/uncovered/focused source on
        // every protected write or completed copy; supplying them is not a
        // permission, and omitting them keeps the exact legacy display-only
        // coordinator with no native capability offered anywhere.
        ...(remoteNativeInputEnabled ? {
          nativeIo: {
            authorizeInput: authorizeRemoteNativeInput,
            onCopy: handleRemoteNativeCopy,
          },
        } : {}),
      });
      peerCoordinator = coordinator;
      peerNetworkSettled = false;
      updatePeerUi(coordinator.read());
      void Promise.resolve().then(async () => {
        if (!shutdownRequested) await coordinator.start();
      }).catch(() => {
        if (!shutdownRequested) {
          sidebar?.showError("Network setup could not be completed; local sessions are unchanged");
          scheduleRedraw();
        }
      });
    } catch {
      sidebar?.showError("Network controls are unavailable; local sessions are unchanged");
      scheduleRedraw();
    }
  }

  function performPeerCommand(command: PeerUiCommand): void {
    const coordinator = peerCoordinator;
    if (!coordinator) {
      sidebar?.showError("Network controls are unavailable in this host");
      scheduleRedraw();
      return;
    }
    void Promise.resolve().then(async () => {
      if (!shutdownRequested) await coordinator.perform(command);
    }).catch(() => {
      if (!shutdownRequested) sidebar?.showError("The network action could not be completed; check the host status");
    }).finally(() => {
      if (!shutdownRequested) { reconcileLayout(true); scheduleRedraw(); }
    });
  }

  function currentHostLayout(cols: number, rows: number): HostLayout {
    const options = {
      sidebarVisible: sidebar?.visible ?? false,
      focus: sidebar ? sidebarFocus(sidebar.focus) : "main" as HostFocus,
      savedDeleteConfirmation: sidebar?.savedDeleteConfirmationActive ?? false,
      hostConfirmation: sidebar?.peerConsentConfirmationActive ?? false,
    };
    const basic = computeHostLayout(cols, rows, options);
    // Match the redraw routes: forms and ordinary confirmations can replace
    // the roster even when a sidebar rectangle exists. Reserve real rows
    // whenever its notification is obscured; never probe by rendering or
    // trade the alert away to preserve a form's minimum height.
    const rosterShowsNotice = basic.sidebar !== undefined
      && (basic.form !== undefined || (options.focus !== "form" && options.focus !== "confirm"));
    return peerUiSnapshot?.consents.length && !rosterShowsNotice
      ? computeHostLayout(cols, rows, { ...options, bannerRows: 6 })
      : basic;
  }

  function invalidatePeerConsentDisplay(): void {
    peerConsentConfirmationFrame = undefined;
    sidebar?.invalidatePeerConsentDisplay();
  }

  function isCurrentPeerConsentFrame(frame: PeerConsentConfirmationFrame): boolean {
    return !shutdownRequested && terminal !== undefined && terminalStarted && sidebar !== undefined
      && sidebar.visible && sidebar.peerConsentConfirmationActive
      && clampDimension(terminal.columns, 80) === frame.cols
      && clampDimension(terminal.rows, 24) === frame.rows
      && sidebar.isPeerConsentRenderCurrent(frame.renderToken)
      && sidebar.capturePeerConsentPresentation()?.consentId === frame.consentId;
  }

  function hasWrittenPeerConsentFrame(consentId: string, renderToken: number, decision: "approve" | "deny"): boolean {
    const frame = peerConsentConfirmationFrame;
    if (!frame || !frame.settled || frame.consentId !== consentId
      || frame.renderToken !== renderToken || frame.decision !== decision) return false;
    if (isCurrentPeerConsentFrame(frame)) return true;
    invalidatePeerConsentDisplay();
    return false;
  }

  function writeOwnedMouseSequence(sequence: string): boolean {
    if (!terminal || !terminalStarted) return false;
    try {
      terminal.write(sequence);
      return true;
    } catch {
      runtimeFailure = true;
      shutdownRequested = true;
      if (startupComplete) beginShutdown();
      return false;
    }
  }

  function syncOuterMouseModes(): void {
    if (!terminal || !terminalStarted || !sidebar || shutdownRequested) return;
    const view = findActiveView();
    const surface = view?.hasLiveProcess && view.lifecycle === "alive" ? manager?.surface(view.id) : undefined;
    const hostPaneVisible = layout?.sidebar !== undefined || layout?.form !== undefined;
    let desiredTracking: number | undefined;
    let useSgr = false;
    if (sidebar.focus === "main" && surface) {
      // Outer capture follows the child's requested reporting, which stays at
      // the committed frame's request while a synchronized frame is held, so
      // a sibling or roster sync mid-frame cannot drop or downgrade capture.
      // Packet forwarding remains gated per packet by inputModes(), which
      // withholds mouse reporting until the frame commits.
      let modes: TerminalMouseReportingRequest | undefined;
      try {
        modes = surface.requestedMouseReporting();
      } catch {
        modes = undefined;
      }
      if (modes && modes.mouseTracking !== "none" && modes.mouseEncoding !== "sgr-pixels") {
        desiredTracking = modes.mouseTracking === "x10" ? 9
          : modes.mouseTracking === "vt200" ? 1000
            : modes.mouseTracking === "drag" ? 1002
              : modes.mouseTracking === "any" ? 1003 : undefined;
        useSgr = desiredTracking !== undefined;
      }
    }
    // The host needs cell-coordinate button reports for every visible pane,
    // including a wide sidebar beside Main and an empty session roster. Use
    // the least permissive mode that still reports presses; retain a child's
    // stronger drag/any mode when Main owns the native viewport.
    if (hostPaneVisible) {
      if (desiredTracking === undefined || desiredTracking === 9) desiredTracking = 1000;
      useSgr = true;
    } else if (desiredTracking === undefined || desiredTracking === 9) {
      // With no host pane and no release-capable native mode, a retained
      // press cannot receive its matching release; discard that stale owner.
      hostMouseButtons.clear();
    }
    // A remote-enabled Main displaying a selected remote owner must capture the
    // pointer for THAT owner's own retained reporting mode: a drag/any gesture,
    // and every gesture in a narrow or hidden-sidebar Main pane, has to reach the
    // written-source gate instead of being limited to (or losing) the host's
    // press-only capture. Only an explicit opt-in with a current remote view
    // changes anything; local rows and the legacy display-only path keep their
    // exact capture, and packet forwarding stays gated per attempt.
    if (remoteNativeInputEnabled && sidebar.focus === "main") {
      const remoteModes = currentRemoteContentView()?.inputModes;
      if (remoteModes !== undefined
        && remoteModes.mouseTracking !== "none"
        && remoteModes.mouseEncoding !== "sgr-pixels") {
        const remoteTracking = mouseTrackingNumber(remoteModes.mouseTracking);
        if (remoteTracking !== undefined) {
          desiredTracking = remoteTracking;
          useSgr = true;
        }
      }
    }

    if (mouseTrackingMode !== desiredTracking) {
      if (mouseTrackingMode !== undefined) {
        if (!writeOwnedMouseSequence(`\x1b[?${mouseTrackingMode}l`)) return;
        mouseTrackingMode = undefined;
      }
      if (desiredTracking !== undefined) {
        if (!writeOwnedMouseSequence(`\x1b[?${desiredTracking}h`)) return;
        mouseTrackingMode = desiredTracking;
      }
    }
    if (mouseSgrEnabled !== useSgr) {
      if (!writeOwnedMouseSequence(useSgr ? "\x1b[?1006h" : "\x1b[?1006l")) return;
      mouseSgrEnabled = useSgr;
    }
  }

  function scheduleRedraw(): void {
    if (redrawQueued || shutdownRequested || externalEditorActive || !writer || !sidebar || !terminal) return;
    redrawQueued = true;
    queueMicrotask(() => {
      redrawQueued = false;
      if (shutdownRequested || externalEditorActive || !writer || !sidebar || !terminal) return;
      try {
        const cols = clampDimension(terminal.columns, 80);
        const rows = clampDimension(terminal.rows, 24);
        const currentLayout = currentHostLayout(cols, rows);
        savedDeleteConfirmationFrame = undefined;
        sidebar.invalidateSavedDeleteConfirmationDisplay();
        layout = currentLayout;
        const view = findActiveView();
        const surface = view ? manager?.surface(view.id) : undefined;
        // Exactly ONE selected source is displayed: the local owner's own surface
        // frame, or the one accepted remote native viewport carried unchanged. No
        // scraping, transcript rendering, filtering, or raw bytes are involved —
        // both go through the same compositor, graphics fallback, and frame writer.
        const remoteView = currentRemoteContentView();
        let mainFrame = remoteView !== undefined ? remoteView.frame : surface?.frame();
        if (mainFrame === undefined && contentTarget?.kind === "remote") {
          // A deliberate remote target with nothing currently authorized: the host
          // owns the pane and says what is actually happening.
          mainFrame = remoteStatusFrame(currentLayout.native);
        }
        if (mainFrame && view && (!view.hasLiveProcess || view.lifecycle !== "alive")) {
          mainFrame = {
            ...mainFrame,
            cursor: { ...mainFrame.cursor, visible: false },
          };
        }
        // Wide layout with the form or Saved-delete warning open: the roster
        // stays left while that content temporarily replaces the native
        // right pane. Narrow overlays and every other focus render a single
        // sidebar-owned pane.
        const focus = sidebarFocus(sidebar.focus);
        let sidebarFrame: RenderedSidebar = { lines: [] };
        let formFrame: RenderedSidebar | undefined;
        if (currentLayout.sidebar) {
          if (focus === "form" && currentLayout.form !== undefined) {
            sidebarFrame = sidebar.renderRoster(currentLayout.sidebar.cols, currentLayout.sidebar.rows);
            formFrame = sidebar.renderForm(currentLayout.form.cols, currentLayout.form.rows);
          } else if (focus === "confirm" && sidebar.peerConsentConfirmationActive
            && currentLayout.form !== undefined) {
            sidebarFrame = sidebar.renderRoster(currentLayout.sidebar.cols, currentLayout.sidebar.rows);
            formFrame = sidebar.renderForm(currentLayout.form.cols, currentLayout.form.rows);
          } else if (focus === "confirm" && sidebar.savedDeleteConfirmationActive
            && currentLayout.form !== undefined) {
            sidebarFrame = sidebar.renderRoster(currentLayout.sidebar.cols, currentLayout.sidebar.rows);
            formFrame = sidebar.renderSavedDeleteConfirmation(currentLayout.form.cols, currentLayout.form.rows);
          } else {
            sidebarFrame = sidebar.render(currentLayout.sidebar.cols, currentLayout.sidebar.rows);
          }
        }
        // A session can legitimately be smaller than this pane when another viewer
        // holds a smaller minimum (#474). Its frame is drawn at the pane's top-left
        // corner and padded, so the content rectangle — not the containing pane —
        // is what this row actually displayed, and that rectangle is what image
        // placement and positional authority are bounded by.
        const nativeContent = nativeContentRect(currentLayout.native, mainFrame);
        const nativeGeometry = view?.hasLiveProcess === true && view.lifecycle === "alive"
          ? canonicalGeometryStamp(view.id)
          : undefined;
        const nativeOwnerId = view?.hasLiveProcess === true && view.lifecycle === "alive"
          && surface !== undefined
          && nativeContent !== undefined
          ? view.id
          : undefined;
        // What the compositor ACTUALLY drew in the native pane. A wide form or
        // Saved-delete confirmation replaces that pane and a narrow sidebar
        // overlay covers it, so neither can establish a remote drawn-source
        // receipt: the deliberate selection stays, its receipt does not.
        const remoteDrawn = remoteView !== undefined
          && currentLayout.form === undefined
          && !(currentLayout.sidebarOverlay === true
            && currentLayout.sidebar !== undefined
            && focus !== "main")
          && nativeContent !== undefined
          ? { view: remoteView, rect: nativeContent }
          : undefined;
        // The accepted publish's own retained native IO facts, if it carried any.
        // Copied into the candidate receipt below; never re-read from a newer view.
        const drawnInputSource = remoteDrawn?.view.inputSource;
        const drawnInputModes = remoteDrawn?.view.inputModes;
        const nativeIoReceipt: WrittenRemoteNativeInput | undefined = remoteNativeInputEnabled
          && remoteDrawn !== undefined && drawnInputSource !== undefined && drawnInputModes !== undefined
          ? Object.freeze({
            hostId: remoteDrawn.view.hostId,
            hostRunId: remoteDrawn.view.hostRunId,
            rowId: remoteDrawn.view.rowId,
            selectionGeneration: remoteDrawn.view.selectionGeneration,
            subscriptionId: remoteDrawn.view.subscriptionId,
            source: drawnInputSource,
            inputModes: drawnInputModes,
            geometry: remoteDrawn.view.geometry,
            nativeContent: Object.freeze({
              column: remoteDrawn.rect.column,
              row: remoteDrawn.rect.row,
              cols: remoteDrawn.rect.cols,
              rows: remoteDrawn.rect.rows,
            }),
            resizeEpoch: remoteInputEpoch,
          })
          : undefined;
        // The graphics layer's owner key distinguishes the actual source. A local
        // row keeps its exact manager id (unchanged image-id cache); a remote
        // viewport gets a key carrying its host, run, row, selection, and native
        // conversation epoch, so another host's image cache is never reused for
        // these placements.
        const nativeGraphicsOwnerId = remoteDrawn !== undefined
          ? remoteDrawn.view.graphicsOwnerId
          : nativeOwnerId;
        // Graphics follow the real active view/surface pair, never the
        // sidebar's highlighted row, and are projected only into the validated
        // content rectangle so a padded session keeps its images and their text
        // fallback. The compositor removes this layer when an overlay or form
        // actually covers the native pane.
        const nativeGraphics = nativeGraphicsOwnerId !== undefined && mainFrame?.graphics !== undefined
          && nativeContent !== undefined
          ? { ownerId: nativeGraphicsOwnerId, pane: nativeContent, frame: mainFrame.graphics }
          : undefined;
        const savedDeleteRenderToken = sidebar.savedDeleteConfirmationRenderTokenNumber;
        // The remote-close dialog replaces the left roster, so its candidate is
        // captured AFTER that render and before the writer sees this frame.
        const remoteClosePresentation = sidebar.captureRemoteCloseConfirmationPresentation();
        // The New form's own drawn candidate (host line + live workspace body)
        // is captured the same way, so a remote submission can require the
        // writer's receipt for THIS frame rather than a later render.
        const createFormPresentation = sidebar.captureCreateFormPresentation();
        // Title only. Lifecycle, activity and input ownership belong below
        // session-card titles, never on the active conversation's title line. A
        // remote owner is identified by its own sanitized roster labels.
        const header = contentTarget?.kind === "remote"
          ? remoteContentHeader(contentTarget.hostId, contentTarget.rowId)
          : view ? view.label : "Session host";
        // The existing host notice surface. The diagnostics warning keeps its
        // ordinary priority; the one brief remote-input notice uses the same
        // header only while no sidebar pane is drawn to carry it, so an ordinary
        // wide layout still shows it in the roster exactly like every other
        // sidebar notice.
        const diagnosticsHeaderNotice = terminalDiagnosticsHeaderNotice(diagnosticsWarning.view());
        const headerNotice = remoteInputNotice !== undefined && currentLayout.sidebar === undefined
          ? remoteInputNotice
          : diagnosticsHeaderNotice;
        const composed = composeHostFrame(currentLayout, {
          main: mainFrame,
          sidebar: sidebarFrame,
          form: formFrame,
          ...(currentLayout.banner === undefined ? {} : {
            banner: sidebar.renderPeerAlert(currentLayout.banner.cols, currentLayout.banner.rows),
          }),
          ...(nativeGraphics ? { nativeGraphics } : {}),
          header,
          ...(headerNotice === undefined ? {} : { headerNotice }),
          focus,
        });
        const mousePresentation: MouseFramePresentation = {
          layout: currentLayout,
          focus,
          sidebar: sidebar.captureMousePresentation(),
          nativeOwnerId,
          nativeContent: nativeOwnerId === undefined ? undefined : nativeContent,
          nativeGeometry: nativeOwnerId === undefined ? undefined : nativeGeometry,
          contentKey: remoteView !== undefined
            ? remoteDrawn?.view.contentKey
            : nativeOwnerId === undefined ? undefined : `local|${nativeOwnerId}`,
          contentSource: remoteView === undefined
            ? (nativeOwnerId === undefined ? undefined : `local|${nativeOwnerId}`)
            : remoteDrawn === undefined
              ? undefined
              : `${remoteDrawn.view.sourceKey}|sub=${remoteDrawn.view.subscriptionId}`
                + `|seq=${remoteDrawn.view.sequence}`
                + `|geom=${remoteDrawn.view.geometry.cols}x${remoteDrawn.view.geometry.rows}`
                + `@${remoteDrawn.view.geometry.revision}`
                + `|rect=${remoteDrawn.rect.column}:${remoteDrawn.rect.row}`
                + `:${remoteDrawn.rect.cols}:${remoteDrawn.rect.rows}`,
          remoteCloseEpoch: remoteCloseHighlightEpoch,
          // The candidate receipt of the remote native source this frame draws. It
          // becomes authority only when the writer reports THIS candidate written.
          nativeInput: nativeIoReceipt,
        };
        // Distinct targets can render identical bytes (for example Saved
        // conversations with matching captions and workspaces). Their maps
        // still need a written boundary before mouse authorization changes.
        //
        // The remote-close highlight is its own written value: an ownership
        // count can take a card from "not idle" to "idle" without changing a
        // single rendered byte or the mouse authorization identity, so it is
        // compared separately and invalidates the writer on its own.
        if ((displayedMousePresentation !== undefined
          && (!sameMouseAuthorization(displayedMousePresentation, mousePresentation)
            || !sameRemoteCloseRow(
              displayedMousePresentation.sidebar.remoteClose, mousePresentation.sidebar.remoteClose,
            )
            || displayedMousePresentation.remoteCloseEpoch !== mousePresentation.remoteCloseEpoch
            // A mode- or source-only change can render identical bytes. It is still
            // a new native IO boundary, so the next frame must be actually written
            // before it authorizes any input or copy. This is separate from the
            // shared UI identity above and never becomes a Close prerequisite.
            || !sameNativeIoReceipt(displayedMousePresentation.nativeInput, mousePresentation.nativeInput)))
          || (latestMousePresentation !== undefined
            && (!sameMouseAuthorization(latestMousePresentation, mousePresentation)
              || !sameRemoteCloseRow(
                latestMousePresentation.sidebar.remoteClose, mousePresentation.sidebar.remoteClose,
              )
              || latestMousePresentation.remoteCloseEpoch !== mousePresentation.remoteCloseEpoch
              || !sameNativeIoReceipt(latestMousePresentation.nativeInput, mousePresentation.nativeInput)))) {
          writer.invalidate?.();
        }
        latestMousePresentation = mousePresentation;
        const activeSidebar = sidebar;
        const confirmationFrame: SavedDeleteConfirmationFrame | undefined = savedDeleteRenderToken === undefined
          ? undefined
          : { renderToken: savedDeleteRenderToken, cols, rows, settled: false };
        savedDeleteConfirmationFrame = confirmationFrame;
        const peerPresentation = sidebar.capturePeerConsentPresentation();
        let peerFrame: PeerConsentConfirmationFrame | undefined;
        if (peerPresentation !== undefined) {
          const previous = peerConsentConfirmationFrame;
          if (previous?.consentId === peerPresentation.consentId && previous.decision === peerPresentation.decision
            && previous.renderToken === peerPresentation.renderToken && previous.cols === cols && previous.rows === rows) {
            peerFrame = previous;
          } else {
            peerFrame = { ...peerPresentation, cols, rows, settled: false };
            // Identical rendered text is not proof that a different request or
            // confirmation choice was written. Force that new semantic boundary.
            writer.invalidate?.();
          }
        }
        peerConsentConfirmationFrame = peerFrame;
        let remoteCloseFrame: RemoteCloseConfirmationFrame | undefined;
        if (remoteClosePresentation !== undefined) {
          const previous = remoteCloseConfirmationFrame;
          if (previous !== undefined
            && previous.generation === remoteClosePresentation.generation
            && previous.renderToken === remoteClosePresentation.renderToken
            && sameRemoteCloseTarget(previous.target, remoteClosePresentation.target)
            && previous.title === remoteClosePresentation.title
            && previous.cols === cols && previous.rows === rows) {
            // The identical semantic dialog is being redrawn: keep the receipt
            // this exact candidate already earned instead of revoking it.
            remoteCloseFrame = previous;
          } else {
            remoteCloseFrame = {
              target: remoteClosePresentation.target,
              title: remoteClosePresentation.title,
              generation: remoteClosePresentation.generation,
              renderToken: remoteClosePresentation.renderToken,
              cols,
              rows,
              settled: false,
            };
            // Identical drawn bytes are not proof that a different frozen target
            // or a new confirmation generation was written: force the boundary.
            writer.invalidate?.();
          }
        }
        remoteCloseConfirmationFrame = remoteCloseFrame;
        let nextCreateFormFrame: CreateFormFrame | undefined;
        if (createFormPresentation !== undefined) {
          const previous = createFormFrame;
          if (previous !== undefined
            // The identical drawn form, at the same outer geometry, in the same
            // geometry epoch: keep the receipt this candidate already earned
            // instead of revoking it. The pane rectangle is part of the drawn
            // presentation itself.
            && previous.renderToken === createFormPresentation.renderToken
            && previous.formGeneration === createFormPresentation.formGeneration
            && previous.hostKind === createFormPresentation.hostKind
            && previous.hostId === createFormPresentation.hostId
            && previous.hostRunId === createFormPresentation.hostRunId
            && previous.workspace === createFormPresentation.workspace
            && previous.cols === createFormPresentation.cols
            && previous.rows === createFormPresentation.rows
            && previous.terminalCols === cols
            && previous.terminalRows === rows
            && previous.epoch === createFormEpoch) {
            nextCreateFormFrame = previous;
          } else {
            nextCreateFormFrame = {
              ...createFormPresentation,
              terminalCols: cols,
              terminalRows: rows,
              epoch: createFormEpoch,
              settled: false,
            };
            // Identical drawn bytes are not proof that a different host line,
            // owner run, workspace, or form generation was written: force the
            // writer's own boundary before anything may be submitted.
            writer.invalidate?.();
          }
        }
        createFormFrame = nextCreateFormFrame;
        writer.submit(composed, cols, rows, (disposition: SessionHostFrameDisposition) => {
          // Retain what ACTUALLY completed writing, even when a newer identical
          // candidate is already queued: discarding the only real write would
          // close the pointer/clipboard paths over a screen the operator sees.
          // Consumers re-read it against the latest candidate by value, and the
          // remote-close receipt additionally checks its geometry epoch, so a
          // stale or reflowed write never authorizes anything.
          if (disposition === "written") {
            displayedMousePresentation = mousePresentation;
          }
          if (peerFrame !== undefined && peerConsentConfirmationFrame === peerFrame
            && isCurrentPeerConsentFrame(peerFrame)
            && (disposition === "written" || (disposition === "unchanged" && peerFrame.settled))) {
            if (activeSidebar.settlePeerConsentRender(peerFrame.renderToken)) peerFrame.settled = true;
          }
          if (remoteCloseFrame !== undefined && remoteCloseConfirmationFrame === remoteCloseFrame
            && isCurrentRemoteCloseConfirmationFrame(remoteCloseFrame)
            && (disposition === "written" || (disposition === "unchanged" && remoteCloseFrame.settled))) {
            if (activeSidebar.settleRemoteCloseConfirmationRender(
              remoteCloseFrame.generation, remoteCloseFrame.renderToken,
            )) remoteCloseFrame.settled = true;
          }
          if (createFormFrame !== undefined && nextCreateFormFrame === createFormFrame
            && isCurrentCreateFormFrame(createFormFrame)
            && (disposition === "written" || (disposition === "unchanged" && createFormFrame.settled))) {
            if (activeSidebar.settleCreateFormRender(createFormFrame.renderToken)) createFormFrame.settled = true;
          }
          if (confirmationFrame === undefined || savedDeleteConfirmationFrame !== confirmationFrame) return;
          if (!isCurrentSavedDeleteConfirmationFrame(confirmationFrame)) {
            invalidateSavedDeleteConfirmationDisplay();
            return;
          }
          if (activeSidebar.settleSavedDeleteConfirmationRender(confirmationFrame.renderToken)) {
            confirmationFrame.settled = true;
          }
        });
      } catch {
        requestShutdown(true);
      }
    });
  }

  /** Revoke confirmation authority synchronously before any Saved target or geometry invalidation. */
  function invalidateSavedDeleteConfirmationDisplay(): void {
    savedDeleteConfirmationFrame = undefined;
    sidebar?.invalidateSavedDeleteConfirmationDisplay();
  }

  function isCurrentSavedDeleteConfirmationFrame(frame: SavedDeleteConfirmationFrame): boolean {
    return terminal !== undefined && sidebar !== undefined && sidebar.visible && sidebar.focus === "confirm"
      && clampDimension(terminal.columns, 80) === frame.cols
      && clampDimension(terminal.rows, 24) === frame.rows
      && sidebar.isSavedDeleteConfirmationRenderCurrent(frame.renderToken);
  }

  function hasSettledSavedDeleteConfirmationFrame(): boolean {
    const frame = savedDeleteConfirmationFrame;
    if (!frame) return false;
    if (!isCurrentSavedDeleteConfirmationFrame(frame)) {
      if (savedDeleteConfirmationFrame === frame) invalidateSavedDeleteConfirmationDisplay();
      return false;
    }
    return frame.settled;
  }

  /** Revoke old draw-derived mouse authority before picker rows/query change. */
  function invalidateMouseAuthorization(): void {
    displayedMousePresentation = undefined;
    latestMousePresentation = undefined;
    writer?.invalidate?.();
  }

  function publishDiagnosticsWarning(): void {
    try {
      sidebar?.setTerminalDiagnosticsWarning(diagnosticsWarning.view());
    } catch {
      // The warning is advisory UI; it must never stop ongoing work.
    }
    scheduleRedraw();
  }

  /**
   * One surface's post-parse diagnostics: persist bounded records (when the
   * private log is available) and update the clearable composed warning. The
   * child, its input route, focus, and the active owner are untouched.
   */
  function handleTerminalDiagnostic(instanceId: string, event: TerminalDiagnosticEvent): void {
    try {
      for (const record of event.records) diagnosticsLog?.appendDiagnostic(instanceId, record);
      diagnosticsLog?.noteSuppressed(event.suppressed);
      if (diagnosticsWarning.note(event.warningCount)) publishDiagnosticsWarning();
    } catch {
      // Diagnostics are best effort; parsing and rendering continue.
    }
  }

  function createFrameWriter(): MainWriter {
    return dependencies.createWriter(dependencies.stdout, {
      graphicsEnabled: hostGraphicsEnabled,
      onError: () => requestShutdown(true),
    });
  }

  const rosterErrorIdPrefix = "roster-error:";

  function rosterErrorItemId(slotId: string): string {
    return `${rosterErrorIdPrefix}${slotId}`;
  }

  function slotIdFromRosterErrorItemId(id: string): string | undefined {
    if (!id.startsWith(rosterErrorIdPrefix)) return undefined;
    const slotId = id.slice(rosterErrorIdPrefix.length);
    return slotId.length > 0 ? slotId : undefined;
  }

  function toRosterErrorItem(record: RosterRecord): SidebarItem {
    const name = record.name;
    return {
      id: rosterErrorItemId(record.slotId),
      label: name !== undefined && name.trim().length > 0 ? name : "(unavailable conversation)",
      workspace: record.workspace ?? "",
      agentDir: "",
      lifecycle: "error",
      hasLiveProcess: false,
      unavailable: true,
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [record.unavailableReason ?? "This conversation is unavailable"],
    };
  }

  /**
   * Adopt every current manager row into its remembered slot and refresh that
   * slot's last-observed CURRENT conversation identity from the LATEST row in
   * manager order. A slot whose current row left the roster was deliberately
   * removed and is forgotten; a slot with no row stays remembered and renders
   * as a bounded error row at its own remembered position.
   */
  function adoptRosterViews(currentViews: NativeInstanceView[]): void {
    const byRow = new Map(currentViews.map((view) => [view.id, view]));
    const assigned = new Map<string, NativeInstanceView>();
    for (const view of currentViews) {
      const slotId = rowSlots.get(view.id) ?? adoptingSlot;
      const record = slotId === undefined ? undefined : rosterRecords.get(slotId);
      if (record === undefined) {
        const created: RosterRecord = { slotId: view.id };
        rosterRecords.set(created.slotId, created);
        rowSlots.set(view.id, created.slotId);
        assigned.set(created.slotId, view);
      } else {
        rowSlots.set(view.id, record.slotId);
        assigned.set(record.slotId, view);
      }
    }
    for (const [slotId, view] of assigned) {
      const record = rosterRecords.get(slotId);
      if (record === undefined) continue;
      record.rowId = view.id;
      record.unavailableReason = undefined;
      if (view.workspace.length > 0) record.workspace = view.workspace;
      const observed = view.nativeSession ?? view.lastNativeSession;
      if (observed !== undefined && observed !== null && isValidNativeSessionId(observed.sessionId)) {
        record.sessionId = observed.sessionId;
        record.persistence = observed.persistence ?? "unknown";
        // A name outside the native display bound is dropped instead of making
        // the whole roster unpublishable.
        if (isValidRosterName(observed.name)) record.name = observed.name;
        else delete record.name;
      }
    }
    for (const [slotId, record] of [...rosterRecords]) {
      if (record.rowId === undefined || byRow.has(record.rowId)) continue;
      rosterRecords.delete(slotId);
    }
    // Row mappings only exist for current rows; a replaced or removed row's
    // mapping is dropped so a stale id can never claim a slot again.
    for (const rowId of [...rowSlots.keys()]) {
      if (!byRow.has(rowId)) rowSlots.delete(rowId);
    }
  }

  /**
   * Roster DTOs at their stable remembered positions: each remembered slot
   * contributes either its current manager row or, when it has none, its
   * bounded unavailable error row. A slot still awaiting its restore attempt is
   * simply not drawn yet; a live manager row is never hidden.
   */
  function currentRosterItems(): SidebarItem[] {
    const byRow = new Map(views.map((view) => [view.id, view]));
    const emitted = new Set<string>();
    const items: SidebarItem[] = [];
    for (const record of rosterRecords.values()) {
      const view = record.rowId === undefined ? undefined : byRow.get(record.rowId);
      if (view !== undefined) {
        if (emitted.has(view.id)) continue;
        emitted.add(view.id);
        items.push(toSidebarItem(view));
        continue;
      }
      if (record.rowId !== undefined || record.unavailableReason === undefined) continue;
      items.push(toRosterErrorItem(record));
    }
    // Safety net: a manager row without a remembered slot is still drawn.
    for (const view of views) {
      if (!emitted.has(view.id)) items.push(toSidebarItem(view));
    }
    return items;
  }

  /**
   * The persisted projection of the in-memory roster: every remembered slot, in
   * its stable remembered order, with whatever identity it actually observed.
   * A slot with no authenticated conversation id or no known workspace is still
   * persisted (it can only ever restore as an unavailable error entry), and a
   * display-only name outside the native bound is dropped rather than making the
   * whole roster unpublishable. Undefined when the roster exceeds the publishable
   * bound, in which case the published roster is left exactly as it was.
   */
  function buildRosterProjection(): StoredRoster | undefined {
    const entries: RosterEntry[] = [];
    for (const record of rosterRecords.values()) {
      if (entries.length >= MAX_ROSTER_ENTRIES) return undefined;
      entries.push({
        slotId: record.slotId,
        ...(record.sessionId !== undefined && isValidNativeSessionId(record.sessionId)
          ? { sessionId: record.sessionId } : {}),
        ...(record.workspace !== undefined && isValidRosterWorkspace(record.workspace) ? { workspace: record.workspace } : {}),
        ...(record.name !== undefined && isValidRosterName(record.name) ? { name: record.name } : {}),
        ...(record.persistence !== undefined ? { persistence: record.persistence } : {}),
      });
    }
    const localId = localActiveId();
    const activeSlotId = localId !== undefined ? rowSlots.get(localId) : rememberedActiveSlot;
    const active = activeSlotId !== undefined && entries.some((entry) => entry.slotId === activeSlotId)
      ? { activeSlotId }
      : {};
    return { version: ROSTER_STORE_VERSION, entries, ...active };
  }

  /**
   * Publish the roster only when it actually changed. A malformed or unwritable
   * store is never overwritten: persistence stays disabled and the bounded
   * problem is surfaced once instead.
   */
  function persistRoster(): void {
    const handle = hostState;
    if (handle === undefined) return;
    if (handle.problem !== undefined) {
      if (!rosterProblemNoted && sidebar) {
        rosterProblemNoted = true;
        sidebar.showError(handle.problem);
        scheduleRedraw();
      }
      return;
    }
    const projection = buildRosterProjection();
    if (projection === undefined) {
      if (!rosterOverflowNoted && sidebar) {
        rosterOverflowNoted = true;
        sidebar.showError(ROSTER_OVERFLOW_MESSAGE);
        scheduleRedraw();
      }
      return;
    }
    const serialized = JSON.stringify(projection);
    if (serialized === lastPersistedRoster) return;
    if (!handle.persist(projection)) {
      if (!rosterSaveFailureNoted && sidebar) {
        rosterSaveFailureNoted = true;
        sidebar.showError(ROSTER_SAVE_FAILURE_MESSAGE);
        scheduleRedraw();
      }
      return;
    }
    lastPersistedRoster = serialized;
  }

  /** Seed the remembered slots from the persisted roster observed at open. */
  function initializeRosterRecords(stored: StoredRoster | undefined): void {
    if (stored !== undefined) {
      for (const entry of stored.entries) {
        if (rosterRecords.has(entry.slotId)) continue;
        rosterRecords.set(entry.slotId, {
          slotId: entry.slotId,
          ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
          ...(entry.workspace !== undefined ? { workspace: entry.workspace } : {}),
          ...(entry.name !== undefined ? { name: entry.name } : {}),
          ...(entry.persistence !== undefined ? { persistence: entry.persistence } : {}),
        });
      }
    }
    rememberedActiveSlot = stored?.activeSlotId;
    // Baseline the published projection so an unchanged roster is never rewritten.
    const baseline = buildRosterProjection();
    lastPersistedRoster = baseline === undefined ? "" : JSON.stringify(baseline);
  }

  /**
   * Deliberate removal of one remembered-but-unavailable entry. Only a slot
   * that owns no manager row can be removed here; a live/exited row is removed
   * through its own manager-owned path.
   */
  function removeRosterEntry(slotId: string): void {
    const record = rosterRecords.get(slotId);
    if (record === undefined || record.rowId !== undefined) {
      sidebar?.showError(REMOVE_REFUSED_MESSAGE);
      scheduleRedraw();
      return;
    }
    rosterRecords.delete(slotId);
    if (rememberedActiveSlot === slotId) rememberedActiveSlot = undefined;
    syncRosterAndSchedule();
    reconcileLayout(true);
  }

  /**
   * Automatic global roster restoration (issue 331). Every remembered entry is
   * revalidated against a FRESH saved-conversation catalog and restarted only
   * through a new exact branded admission as a NEW independently owned child in
   * the conversation's recorded workspace. Nothing is adopted, guessed, or
   * substituted; an entry that cannot be freshly admitted stays visible as a
   * bounded error row and never starts a fresh session.
   */
  async function restorePersistedRoster(): Promise<void> {
    const handle = hostState;
    const activeManager = manager;
    const activeSidebar = sidebar;
    const stored = handle?.roster;
    if (handle === undefined || activeManager === undefined || activeSidebar === undefined) return;
    if (handle.problem !== undefined) return; // surfaced truthfully by persistRoster
    if (stored === undefined || stored.entries.length === 0) return;
    // Automatic activation is fenced by the deliberate-action generation, not by
    // the current content target alone: a user who activates and then clears/removes a
    // row during a slow restore must not have the remembered sibling activated
    // afterwards. The startup fence is absolute — any deliberate action at all,
    // including one received while keyboard negotiation is still settling,
    // invalidates the automatic activation.
    const generationAtStart = 0;
    const agentDir = sessionSetup?.nativeAgentDir;
    const activePi = pi;
    const controller = new AbortController();
    restoreAbort = controller;
    let catalog: SavedSessionCatalog | undefined;
    if (typeof agentDir === "string" && agentDir !== "" && activePi !== undefined && activePi.file && activePi.version) {
      try {
        catalog = await dependencies.listSavedCatalog({
          agentDir,
          piExecutable: activePi.file,
          expectedPiVersion: activePi.version,
          signal: controller.signal,
        });
      } catch {
        catalog = undefined;
      }
    }
    if (controller.signal.aborted || shutdownRequested || manager !== activeManager) return;
    // Decide every entry synchronously from this one catalog snapshot, minting
    // each branded admission BEFORE any row is created: a later listing, a
    // catalog revision bump, or a concurrent user action can never invalidate an
    // admission half-way through restoration.
    const decisions = stored.entries.map((entry) => {
      let createOptions: CreateInstanceOptions | undefined;
      let reason = "This conversation is unavailable";
      const entrySessionId = entry.sessionId;
      // The remembered workspace is part of the contract: a conversation whose
      // current header resolves elsewhere is never silently launched there.
      const rememberedWorkspace = canonicalExistingDirectory(entry.workspace);
      const matching = entrySessionId === undefined
        ? []
        : (catalog?.rows.filter((row) => row.id === entrySessionId) ?? []);
      const row = matching[0];
      if (entrySessionId === undefined) {
        reason = "This remembered session never reported a conversation; it was not restarted";
      } else if (catalog === undefined) {
        reason = "The saved conversation list is unavailable; this conversation was not restarted";
      } else if (matching.length > 1) {
        reason = "More than one saved conversation matches this session; it was not restarted";
      } else if (row === undefined) {
        reason = catalog.issueCount !== 0
          ? "The saved conversation list is incomplete; this conversation was not restarted"
          : entry.persistence === "unsaved"
            ? "This conversation was never saved to disk; it was not restarted"
            : "This conversation is no longer saved to disk; it was not restarted";
      } else {
        const admitted = hostService.admitSavedConversation(catalog, row);
        if (admitted.status === "refused") {
          reason = `This conversation could not be revalidated: ${savedRefusalNotice(admitted.reason)}`;
        } else if (rememberedWorkspace === undefined || rememberedWorkspace !== admitted.admission.workspace) {
          reason = "This conversation's recorded workspace changed; it was not restarted";
        } else {
          createOptions = { workspace: admitted.admission.workspace, savedSession: admitted.admission };
        }
      }
      return { entry, createOptions, reason };
    });
    for (const decision of decisions) {
      if (shutdownRequested || manager !== activeManager) return;
      const record = rosterRecords.get(decision.entry.slotId);
      if (record === undefined) continue;
      if (decision.createOptions === undefined) {
        record.rowId = undefined;
        record.unavailableReason = decision.reason;
        continue;
      }
      adoptingSlot = decision.entry.slotId;
      let created: Promise<string>;
      try {
        // Restoration creates on the same single manager the owning-host service
        // opened: the slot-adoption window has to wrap the synchronous stretch of
        // the create call itself, so this path cannot use the async start path.
        created = activeManager.create(decision.createOptions);
      } finally {
        adoptingSlot = undefined;
      }
      try {
        await created;
      } catch {
        const live = rosterRecords.get(decision.entry.slotId);
        if (live !== undefined && live.rowId === undefined) {
          live.unavailableReason = "This conversation could not be started; it was not replaced";
        }
      }
    }
    if (shutdownRequested || manager !== activeManager) return;
    // The remembered active entry is applied only after every restore attempt
    // and only while no deliberate user action occurred since restoration began,
    // so a slow restore can never override a user's own focus or action.
    if (deliberateActionGeneration === generationAtStart) {
      const activeSlot = stored.activeSlotId;
      const activeRecord = activeSlot === undefined ? undefined : rosterRecords.get(activeSlot);
      if (activeRecord?.rowId !== undefined) {
        contentTarget = { kind: "local", id: activeRecord.rowId };
        rememberedActiveSlot = activeRecord.slotId;
        reconcileLayout(true);
      }
    }
    syncRosterAndSchedule();
  }

  function syncRosterAndSchedule(): void {
    if (!manager || !sidebar || shutdownRequested) return;
    if (rosterSyncInProgress) {
      if (!rosterSyncQueued) {
        rosterSyncQueued = true;
        queueMicrotask(() => {
          rosterSyncQueued = false;
          syncRosterAndSchedule();
        });
      }
      return;
    }
    rosterSyncInProgress = true;
    try {
      views = manager.list().filter((view) => !removedExitedIds.has(view.id));
      adoptRosterViews(views);
      const localId = localActiveId();
      if (localId !== undefined && !views.some((view) => view.id === localId)) {
        contentTarget = undefined;
        contentSelectionGeneration += 1;
        rememberedActiveSlot = undefined;
        // The manager already retired every surface on that row; re-state the
        // local view so it displays nothing rather than a vanished row. A remote
        // target is never cleared by local roster activity.
        localViewerDirty = true;
      }
      // View-only observer: the sidebar's white title highlight follows the
      // actual content owner — a local row or one exact remote owner — and is
      // cleared here when that local owner row is gone, so a sibling is never
      // falsely highlighted. It never changes activation or ownership.
      sidebar.setActiveMainOwnerKey(contentTarget);
      sidebar.updateItems(currentRosterItems());
      persistRoster();
      syncOuterMouseModes();
      scheduleRedraw();
    } catch {
      requestShutdown(true);
    } finally {
      rosterSyncInProgress = false;
    }
  }

  /**
   * Restate this host's local viewing surface on the one manager (#474): which
   * session it displays (possibly none) and how wide its native pane is. Only
   * the addressed session can be resized by this; a background session nobody
   * displays keeps its last size, and `adoptAsInitialGeometry` alone changes the
   * initial-sizing rule for sessions created later.
   */
  function localViewerNeedsSync(pane: HostPaneRect): boolean {
    if (localViewerDirty) return true;
    const localId = localActiveId();
    if (localViewerState === undefined) return localId !== undefined;
    return localViewerState.target !== localId
      || localViewerState.cols !== pane.cols
      || localViewerState.rows !== pane.rows;
  }

  function syncLocalViewerGeometry(pane: HostPaneRect, adoptAsInitialGeometry: boolean): void {
    if (!manager) return;
    if (adoptAsInitialGeometry) hostService.setInitialGeometry(pane.cols, pane.rows);
    if (localViewerId === undefined) {
      const opened = hostService.openViewer();
      if (opened === undefined) return;
      localViewerId = opened.viewerId;
    }
    const result = hostService.updateViewer(localViewerId, {
      sessionId: localActiveId() ?? null,
      cols: pane.cols,
      rows: pane.rows,
    });
    // What this host asked for, whether or not the manager accepted it: an
    // exited or errored row stays refused rather than retried on every redraw.
    localViewerState = { target: localActiveId(), cols: pane.cols, rows: pane.rows };
    if (result.applied) {
      localViewerDirty = false;
      return;
    }
    if (result.reason === "unknown-viewer") {
      // The manager no longer has this surface (its row finished or teardown
      // began). Nothing is retried blindly; a later deliberate selection or
      // layout change registers a fresh surface.
      localViewerId = undefined;
      localViewerState = undefined;
      localViewerDirty = false;
      return;
    }
    // `unknown-session` is the truthful current answer (the displayed row
    // exited or errored), and `invalid-geometry` cannot come from a computed
    // pane. Either way the manager's own facts stand.
    localViewerDirty = false;
  }

  /**
   * The manager's canonical size for one row, or nothing when the row, the
   * dimensions, or the read itself is unusable (#474). A missing fact is never
   * replaced with a guessed size.
   */
  function canonicalGeometryStamp(id: string): CanonicalSessionGeometry | undefined {
    const geometry: SessionGeometry | undefined = hostService.readSessionGeometry(id);
    if (geometry === undefined) return undefined;
    if (!Number.isSafeInteger(geometry.cols) || !Number.isSafeInteger(geometry.rows)
      || !Number.isSafeInteger(geometry.revision)
      || geometry.cols < 1 || geometry.rows < 1) return undefined;
    return { cols: geometry.cols, rows: geometry.rows, revision: geometry.revision };
  }

  /**
   * Positional native input and native clipboard requests are authorized only
   * against the content the display actually committed for that row (#474):
   *
   * - the written frame and the latest render agree on one owner, one native pane,
   *   and one drawn content rectangle, so nothing is authorized against a frame
   *   that was never written;
   * - the manager's current canonical size and revision still match the ones that
   *   drawn content came from, so a resize queued behind writer backpressure
   *   authorizes neither its newly exposed padding nor its not-yet-drawn size;
   * - no form or actually drawn sidebar overlay covers the native pane. An
   *   overlay-capable layout with Main focused draws no sidebar rectangle, so it
   *   covers nothing and native input keeps its ordinary path.
   *
   * The returned rectangle is the drawn content, never the containing pane: cells
   * of a padded pane belong to the host, not the child. `undefined` refuses
   * positional work outright; keyboard and paste input claims no cell and is
   * unaffected.
   */
  function nativeInputAuthority(id: string): HostPaneRect | undefined {
    const shown = displayedMousePresentation;
    const latest = latestMousePresentation;
    if (layout === undefined || shown === undefined || latest === undefined) return undefined;
    // Coverage, not overlay capability: a narrow layout keeps `sidebarOverlay`
    // set while Main is focused, but draws no sidebar rectangle there, and Main
    // owns the whole content pane. Only a layout that actually paints something
    // over the native pane refuses positional authority — and the written and
    // latest layouts both count, so uncovering Main cannot authorize input before
    // its uncovered frame has been written.
    const covered = (value: HostLayout): boolean => value.form !== undefined
      || (value.sidebarOverlay && value.sidebar !== undefined);
    if (covered(layout) || covered(shown.layout) || covered(latest.layout)) return undefined;
    if (shown.nativeOwnerId !== id || latest.nativeOwnerId !== id) return undefined;
    if (!samePaneGeometry(shown.layout.native, layout.native)
      || !samePaneGeometry(latest.layout.native, layout.native)) return undefined;
    const drawn = shown.nativeContent;
    if (drawn === undefined || !samePaneGeometry(drawn, latest.nativeContent)) return undefined;
    const current = canonicalGeometryStamp(id);
    if (current === undefined
      || shown.nativeGeometry === undefined || latest.nativeGeometry === undefined
      || !sameCanonicalGeometry(shown.nativeGeometry, current)
      || !sameCanonicalGeometry(latest.nativeGeometry, current)) return undefined;
    return drawn;
  }

  /**
   * The ONE actual-written remote native IO receipt, but only while every
   * independent current fact still proves it.
   *
   * Called synchronously for EVERY protected input write (and re-checked by the
   * coordinator/client after each caller callback), so nothing cached, queued, or
   * descriptor-shaped can authorize a write. It deliberately re-reads:
   *
   * - the started/not-shutting-down/not-handed-off terminal state;
   * - CURRENT, WRITTEN, and latest-candidate Main focus, and whether each of those
   *   layouts actually paints a form or sidebar rectangle over the native pane;
   *   the same native pane geometry and drawn content rectangle must agree, so a
   *   pending resize, an undrawn layout, or an uncovering frame refuses input until
   *   its own frame is written;
   * - the deliberate remote target, which must still be the written receipt's own
   *   host, owner run, row, and selection generation;
   * - the caller's expected source (the whole tuple, epoch, geometry revision,
   *   viewer revision, and host commitment), which must BE the written one;
   * - the CURRENT accepted viewport, whose retained source must still be that
   *   exact source (ordinary text output with fresh snapshots and sequences is
   *   fine), plus the requested input modes when this is an input proof;
   * - the coordinator's own descriptive target, compared field by field as an
   *   independent second opinion; it never selects or rewrites anything.
   *
   * No manager, owner-local row, `localActiveId`, local clipboard route, native
   * input authority, last-input/dispatch counter, or history participates.
   */
  function currentWrittenRemoteNativeInput(expected: {
    readonly hostId: string;
    readonly selectionGeneration: number;
    readonly subscriptionId: string;
    readonly source: NativeIoSource;
    readonly inputModes?: TerminalInputModes;
  }): WrittenRemoteNativeInput | undefined {
    if (!remoteNativeInputEnabled || shutdownRequested || externalEditorActive) return undefined;
    if (terminal === undefined || !terminalStarted || sidebar === undefined) return undefined;
    if (sidebar.focus !== "main") return undefined;
    const shown = displayedMousePresentation;
    const latest = latestMousePresentation;
    const currentLayout = layout;
    if (shown === undefined || latest === undefined || currentLayout === undefined) return undefined;
    const receipt = shown.nativeInput;
    if (receipt === undefined) return undefined;
    // A resize (even one that returns to the original dimensions before anything
    // is repainted) revokes the written receipt until a post-resize frame is
    // actually written.
    if (receipt.resizeEpoch !== remoteInputEpoch) return undefined;
    // Physical Main focus on the actually written frame AND on the latest candidate.
    if (shown.focus !== "main" || latest.focus !== "main") return undefined;
    // Actual coverage, not overlay capability: an overlay-capable layout with Main
    // focused paints no sidebar rectangle and covers nothing.
    const covered = (value: HostLayout): boolean => value.form !== undefined
      || (value.sidebarOverlay && value.sidebar !== undefined);
    if (covered(currentLayout) || covered(shown.layout) || covered(latest.layout)) return undefined;
    if (!samePaneGeometry(shown.layout.native, currentLayout.native)
      || !samePaneGeometry(latest.layout.native, currentLayout.native)) return undefined;
    // The written receipt's rectangle is exactly what THIS pane draws for that same
    // canonical geometry, so a moved/resized pane or a new frame size cannot reuse
    // an old rectangle's coordinates.
    if (!samePaneGeometry(receipt.nativeContent, {
      column: currentLayout.native.column,
      row: currentLayout.native.row,
      cols: receipt.geometry.cols,
      rows: receipt.geometry.rows,
    })) return undefined;
    // The deliberate target is the written receipt's own target, exactly.
    const target = contentTarget;
    if (target === undefined || target.kind !== "remote" || target.hostRunId === null) return undefined;
    if (target.hostId !== receipt.hostId || target.hostRunId !== receipt.hostRunId
      || target.rowId !== receipt.rowId) return undefined;
    if (receipt.selectionGeneration !== contentSelectionGeneration) return undefined;
    if (shown.contentSource?.startsWith("remote|") !== true) return undefined;
    // The caller's expected target must BE the written receipt.
    if (expected.hostId !== receipt.hostId
      || expected.selectionGeneration !== receipt.selectionGeneration
      || expected.subscriptionId !== receipt.subscriptionId
      || !nativeIoSourceEquals(expected.source, receipt.source)) return undefined;
    if (expected.inputModes !== undefined && !sameTerminalInputModes(expected.inputModes, receipt.inputModes)) {
      return undefined;
    }
    // The currently published view must still carry this exact written source (and
    // the same modes for input). Its publish sequence and snapshot object are never
    // compared, so ordinary output never stalls typing or held input.
    const view = currentRemoteContentView();
    if (view === undefined || view.inputSource === undefined || view.inputModes === undefined) return undefined;
    if (view.subscriptionId !== receipt.subscriptionId) return undefined;
    if (!nativeIoSourceEquals(view.inputSource, receipt.source)) return undefined;
    if (expected.inputModes !== undefined && !sameTerminalInputModes(view.inputModes, receipt.inputModes)) {
      return undefined;
    }
    // The coordinator's own description is an independent comparison only.
    const content = contentController();
    if (content === undefined || typeof content.readNativeInputTarget !== "function") return undefined;
    const described = content.readNativeInputTarget();
    if (described === undefined) return undefined;
    if (described.hostId !== receipt.hostId
      || described.selectionGeneration !== receipt.selectionGeneration
      || described.subscriptionId !== receipt.subscriptionId
      || !nativeIoSourceEquals(described.source, receipt.source)) return undefined;
    // Modes are freshness evidence for INPUT only; a copy is text, so it never
    // gains a per-input-mode history or dispatch counter of its own.
    if (expected.inputModes !== undefined && !sameTerminalInputModes(described.inputModes, receipt.inputModes)) {
      return undefined;
    }
    return receipt;
  }

  /** The existing sidebar's brief, sanitized, non-modal notice slot. */
  function showRemoteInputNotice(message: string): void {
    // One fixed slot, no per-input history, no dialog, no retry, no focus change.
    // The sidebar carries it whenever its pane is drawn; the composed header
    // carries the same slot whenever no sidebar pane is drawn (hidden sidebar or
    // narrow Main), so a refusal is never invisible.
    remoteInputNotice = message;
    sidebar?.showError(message);
    scheduleRedraw();
  }

  /**
   * Submit ONE caller-normalized remote input against the actual-written receipt.
   *
   * Only a local refusal (before any submission) may say nothing was sent. Once
   * the delegate was invoked, a rejection, a malformed result, or an explicit
   * `unknown` is reported as UNCERTAIN — never as nothing sent, success, or an
   * executed command. Nothing is retried, replayed, reconnected, re-granted,
   * queued for a later frame, or handed to a local row.
   */
  function submitRemoteNativeInput(kind: NativeIoInputKind, text: string): void {
    try {
      if (!remoteNativeInputEnabled) return;
      const written = displayedMousePresentation?.nativeInput;
      if (written === undefined) {
        showRemoteInputNotice(REMOTE_INPUT_NOT_SENT_MESSAGE);
        return;
      }
      const expected = {
        hostId: written.hostId,
        selectionGeneration: written.selectionGeneration,
        subscriptionId: written.subscriptionId,
        source: written.source,
        inputModes: written.inputModes,
      };
      if (currentWrittenRemoteNativeInput(expected) === undefined) {
        showRemoteInputNotice(REMOTE_INPUT_NOT_SENT_MESSAGE);
        return;
      }
      const content = contentController();
      if (content === undefined || typeof content.sendNativeInput !== "function") {
        // An older/display-only controller offers no native capability: a fixed
        // refusal, never a local fallback.
        showRemoteInputNotice(REMOTE_INPUT_NOT_SENT_MESSAGE);
        return;
      }
      const request: PeerNativeInputRequest = { ...expected, kind, text };
      let pending: Promise<NativeInputSendResult> | undefined;
      try {
        pending = content.sendNativeInput(request);
      } catch {
        // The delegate was invoked and its outcome is unknowable.
        showRemoteInputNotice(REMOTE_INPUT_UNCERTAIN_MESSAGE);
        return;
      }
      if (pending === undefined) {
        // A controller that produced no outcome told us nothing about the wire.
        showRemoteInputNotice(REMOTE_INPUT_UNCERTAIN_MESSAGE);
        return;
      }
      // One truthful settlement: only a fixed `not-sent` may say nothing was sent;
      // `unknown`, a rejection, or no recognizable outcome stays UNCERTAIN.
      const settle = (result: NativeInputSendResult | undefined): void => {
        try {
          if (result === undefined) {
            showRemoteInputNotice(REMOTE_INPUT_UNCERTAIN_MESSAGE);
          } else if (result.status === "submitted") {
            // Local transport return only: never claimed as processed or executed.
          } else if (result.status === "not-sent") {
            showRemoteInputNotice(result.reason === "too-large"
              ? REMOTE_INPUT_PASTE_TOO_LARGE_MESSAGE
              : REMOTE_INPUT_NOT_SENT_MESSAGE);
          } else {
            showRemoteInputNotice(REMOTE_INPUT_UNCERTAIN_MESSAGE);
          }
        } catch {
          // A notice failure never becomes an unhandled rejection.
        }
      };
      void Promise.resolve(pending).then((result) => settle(result), () => settle(undefined));
    } catch {
      // Containment only: routing must never take down the host.
      showRemoteInputNotice(REMOTE_INPUT_NOT_SENT_MESSAGE);
    }
  }

  /**
   * ONE keyboard or paste packet for the selected remote owner.
   *
   * Keyboard text is the existing source normalization under the ACTUAL public
   * `ProcessTerminal.kittyProtocolActive` value; the owner translates once for its
   * own native modes. A complete bracketed paste contributes only its exact outer
   * brackets' TEXTBODY, refused whole above the decoded 1 MiB text bound (never
   * truncated, and never an image or clipboard payload). An incomplete packet is
   * never handed to the owner.
   */
  function routeRemoteForward(data: string): void {
    try {
      if (!remoteNativeInputEnabled || terminal === undefined) return;
      if (data.startsWith(BRACKETED_PASTE_START)) {
        if (!data.endsWith(BRACKETED_PASTE_END)
          || data.length < BRACKETED_PASTE_START.length + BRACKETED_PASTE_END.length) return;
        const body = data.slice(BRACKETED_PASTE_START.length, data.length - BRACKETED_PASTE_END.length);
        if (Buffer.byteLength(body, "utf8") > NATIVE_TEXT_PASTE_MAX_BYTES) {
          showRemoteInputNotice(REMOTE_INPUT_PASTE_TOO_LARGE_MESSAGE);
          return;
        }
        submitRemoteNativeInput("paste", body);
        return;
      }
      submitRemoteNativeInput("keyboard", normalizeNativeSourceInput(data, terminal.kittyProtocolActive));
    } catch {
      showRemoteInputNotice(REMOTE_INPUT_NOT_SENT_MESSAGE);
    }
  }

  /**
   * ONE native pointer packet for the selected remote owner, mapped from the
   * screen cell into the written content rectangle's own content coordinates.
   *
   * A packet in the pane's padding claims no content cell and is dropped without
   * a submission. The emitted form is one canonical SGR report with the observed
   * button/modifiers/release preserved; raw terminal coordinates, raw X10 bytes,
   * and image payloads are never forwarded. The owner maps this SGR report to its
   * own actual mouse modes (including legacy X10).
   */
  function routeRemoteMouseInput(mouse: ParsedMouseInput): void {
    try {
      if (!remoteNativeInputEnabled) return;
      const written = displayedMousePresentation?.nativeInput;
      if (written === undefined) {
        showRemoteInputNotice(REMOTE_INPUT_NOT_SENT_MESSAGE);
        return;
      }
      const drawn = written.nativeContent;
      if (mouse.x < drawn.column || mouse.x >= drawn.column + drawn.cols
        || mouse.y < drawn.row || mouse.y >= drawn.row + drawn.rows) {
        // Padding belongs to the host: no content cell was claimed, so nothing is
        // submitted and no input notice is raised for a mere pointer position.
        return;
      }
      const localX = mouse.x - drawn.column;
      const localY = mouse.y - drawn.row;
      submitRemoteNativeInput("mouse",
        `\x1b[<${mouse.button};${localX + 1};${localY + 1}${mouse.release ? "m" : "M"}`);
    } catch {
      showRemoteInputNotice(REMOTE_INPUT_NOT_SENT_MESSAGE);
    }
  }

  /**
   * The coordinator's dynamic per-write proof. It is deliberately stateless: every
   * call re-evaluates the current written receipt, focus, coverage, geometry,
   * source, modes, and the coordinator's own description. Anything but an
   * independent `true` (including a throw) refuses the write.
   */
  function authorizeRemoteNativeInput(target: PeerNativeInputTarget): boolean {
    try {
      return currentWrittenRemoteNativeInput({
        hostId: target.hostId,
        selectionGeneration: target.selectionGeneration,
        subscriptionId: target.subscriptionId,
        source: target.source,
        inputModes: target.inputModes,
      }) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * The coordinator's copy callback: emit the EXISTING outer OSC 52 form for this
   * initiating viewer's own written, uncovered, Main-focused remote source only.
   *
   * The copy arrives after the coordinator has already proved its current selected
   * endpoint and exact source; Main independently re-proves the same facts here.
   * Copies are not input: no input modes, dispatch order, per-input history, or
   * last-input counter participates, so an asynchronously later copy from an
   * earlier input is still delivered when it belongs to the same current scope.
   * Nothing is broadcast, relayed raw, written to the owner/local clipboard route,
   * or replayed after the source moves.
   */
  function handleRemoteNativeCopy(receipt: PeerNativeCopyReceipt): void {
    try {
      if (!remoteNativeInputEnabled || terminal === undefined) return;
      const source = receipt.source;
      const event = receipt.event;
      // Validate the producer's own native tuple against the source it rode with.
      if (source === null || typeof source !== "object" || event === null || typeof event !== "object") return;
      if (event.sessionId !== source.nativeSession.sessionId
        || event.sessionEpoch !== source.nativeSession.epoch) return;
      if (currentWrittenRemoteNativeInput({
        hostId: receipt.hostId,
        selectionGeneration: receipt.selectionGeneration,
        subscriptionId: receipt.subscriptionId,
        source,
      }) === undefined) return;
      if (event.kind === "unavailable") {
        // The eligible owner's own authenticated producer could not forward a
        // copy. Only a fixed diagnostic code is recorded; no success is claimed.
        clipboardDiagnostics.note(source.sessionId, event.reason === "unsupported-runtime"
          ? "clipboard-unsupported-runtime"
          : "clipboard-provenance-unavailable");
        return;
      }
      const encoded = event.encoded;
      // The client already validated and assembled the whole encoded payload under
      // this unchanged producer bound; it is carried here in full, never shrunk.
      if (typeof encoded !== "string" || encoded.length === 0
        || encoded.length > NATIVE_COPY_MAX_ENCODED_CHARS) return;
      try {
        terminal.write(`\x1b]52;c;${encoded}\x07`);
      } catch {
        // Never the exception text, payload, or stack: a fixed code only.
        clipboardDiagnostics.note(source.sessionId, "clipboard-terminal-write-failed");
      }
    } catch {
      // Containment only; a copy failure never escapes into the coordinator.
    }
  }

  function reconcileLayout(resizeChildren: boolean): void {
    if (!terminal || !sidebar || shutdownRequested) return;
    try {
      const cols = clampDimension(terminal.columns, 80);
      const rows = clampDimension(terminal.rows, 24);
      const next = currentHostLayout(cols, rows);
      layout = next;
      const changed = next.native.cols !== lastNativeCols || next.native.rows !== lastNativeRows;
      if (manager && !resizeInProgress && (resizeChildren || localViewerNeedsSync(next.native))) {
        resizeInProgress = true;
        try {
          syncLocalViewerGeometry(next.native, resizeChildren && changed);
          if (resizeChildren) {
            lastNativeCols = next.native.cols;
            lastNativeRows = next.native.rows;
          }
        } finally {
          resizeInProgress = false;
        }
      } else if (lastNativeCols === undefined || lastNativeRows === undefined) {
        lastNativeCols = next.native.cols;
        lastNativeRows = next.native.rows;
      }
      // One deduped newest viewport for the selected remote stream. The pane is
      // only this viewer's request; what is displayed stays the owner's own
      // canonical frame geometry.
      syncRemoteContentViewport(next.native);
      syncOuterMouseModes();
      scheduleRedraw();
    } catch {
      requestShutdown(true);
    }
  }

  function routeNativeClipboard(id: string, event: NativeClipboardEvent): void {
    const view = views.find((row) => row.id === id);
    if (!view?.hasLiveProcess || view.lifecycle !== "alive"
      || view.nativeSession?.sessionId !== event.sessionId || view.nativeSession.epoch !== event.sessionEpoch) return;
    const shown = displayedMousePresentation;
    const latest = latestMousePresentation;
    const ownsVisibleMain = terminal !== undefined && terminalStarted && !shutdownRequested && !externalEditorActive
      && sidebar?.focus === "main" && localActiveId() === id && layout !== undefined
      && layout.form === undefined
      && shown?.focus === "main" && latest?.focus === "main"
      && shown.nativeOwnerId === id && latest.nativeOwnerId === id
      && shown.layout.form === undefined
      && shown.layout.cols === layout.cols && shown.layout.rows === layout.rows
      && latest.layout.cols === layout.cols && latest.layout.rows === layout.rows
      && samePaneGeometry(shown.layout.native, layout.native) && samePaneGeometry(latest.layout.native, layout.native)
      // Use the same actual-coverage and written-owner/geometry authority as
      // positional input. Overlay capability alone does not cover Main: the gate
      // checks current, shown, and latest layouts so an actual overlay or an
      // undrawn uncovering/geometry transition cannot authorize a copy (#474).
      // Padding stays host-owned; valid fully drawn child content stays eligible.
      && nativeInputAuthority(id) !== undefined;
    // Stale, sibling, hidden, unfocused, covered, form, changed-geometry, and
    // shutting-down requests are ordinary safety refusals: quiet, fail closed.
    if (!ownsVisibleMain) return;
    if (event.kind === "unavailable") {
      // The eligible owner's authenticated child reported a native copy it
      // could not forward. Native Pi still shows its own feedback; the host
      // records only a fixed diagnostic code.
      clipboardDiagnostics.note(id, event.reason === "unsupported-runtime"
        ? "clipboard-unsupported-runtime"
        : "clipboard-provenance-unavailable");
      return;
    }
    // TERM's label is not evidence of OSC 52 capability, and native Pi has
    // already produced this user copy request (and its own Copied feedback).
    // The started Main owner that cleared every source, session, focus,
    // display, and geometry check submits the generated request; a successful
    // write only proves the request left the host, never that the client
    // clipboard changed, so success adds no host status or diagnostic.
    try {
      terminal!.write(`\x1b]52;c;${event.encoded}\x07`);
    } catch {
      // Never the exception text, payload, or stack: a fixed code only.
      clipboardDiagnostics.note(id, "clipboard-terminal-write-failed");
    }
  }

  function routeForward(data: string): void {
    if (!terminal || !sidebar || sidebar.focus !== "main" || shutdownRequested || externalEditorActive) return;
    // A deliberately selected remote viewport never falls back to a local row.
    // With the internal opt-in it routes one caller-normalized native submission to
    // that exact selected stream; without it the legacy display-only drop stands.
    if (contentTarget?.kind === "remote") {
      routeRemoteForward(data);
      return;
    }
    const view = findActiveView();
    if (!view || !view.hasLiveProcess || view.lifecycle !== "alive" || !layout || !manager) return;
    const surface = manager.surface(view.id);
    if (!surface) return;
    try {
      const sourceNormalized = normalizeNativeSourceInput(data, terminal.kittyProtocolActive);
      const viewport = nativeInputAuthority(view.id);
      // A mouse packet claims a cell of the displayed content. With no written,
      // current snapshot for that row there is no defensible viewport, so the
      // packet is dropped; keyboard and paste packets make no positional claim
      // (the translator never consults a viewport for them) and keep their
      // ordinary path.
      if (viewport === undefined && parseMouseInput(sourceNormalized) !== undefined) return;
      const translated = translateInput(sourceNormalized, surface.inputModes(), viewport ?? layout.native);
      if (translated !== undefined) manager.write(view.id, translated);
    } catch {
      // The process may have exited between the snapshot and write. Never
      // retry against a sibling or expose the underlying native diagnostic.
    }
  }

  function canFocusMainFromNativeClick(
    mouse: ParsedMouseInput,
    presentation: MouseFramePresentation | undefined,
  ): boolean {
    const latest = latestMousePresentation;
    if (!sidebar || !manager || !presentation || !latest || !layout
      || !sidebar.visible || sidebar.focus !== "sidebar"
      || !sameNativeMouseTarget(presentation, latest)
      || !sameNativePaneGeometry(presentation.layout, layout)
      || localActiveId() !== presentation.nativeOwnerId) return false;
    // A padded cell belongs to the host, not the child: only a click on content
    // this row actually drew is a focus gesture (#474).
    const drawn = presentation.nativeContent;
    if (drawn === undefined || !containsHostPoint(drawn, mouse.x, mouse.y)) return false;
    const view = findActiveView();
    if (!view || view.id !== presentation.nativeOwnerId || !view.hasLiveProcess || view.lifecycle !== "alive") return false;
    try {
      return manager.surface(view.id) !== undefined;
    } catch {
      return false;
    }
  }

  function handleMouseInput(data: string, mouse: ParsedMouseInput): void {
    if (shutdownRequested || externalEditorActive || !sidebar || !layout) return;
    const presentation = displayedMousePresentation;
    const hitLayout = presentation?.layout ?? layout;
    const hitMapPending = presentation === undefined || latestMousePresentation === undefined
      || !sameMouseAuthorization(presentation, latestMousePresentation);
    const buttonId = mouseButtonId(mouse);
    if (mouse.release) {
      if (buttonId !== undefined && hostMouseButtons.delete(buttonId)) return;
      // Legacy X10 release reports button 3 without identifying which button
      // ended; the host can only own this ambiguous release if it owns a press.
      if (buttonId === undefined && hostMouseButtons.size > 0) {
        hostMouseButtons.clear();
        return;
      }
    }
    if (mouse.motion && buttonId !== undefined && hostMouseButtons.has(buttonId)) return;

    const formPane = hitLayout.form !== undefined && containsHostPoint(hitLayout.form, mouse.x, mouse.y)
      ? hitLayout.form
      : undefined;
    const sidebarPane = hitLayout.sidebar !== undefined && containsHostPoint(hitLayout.sidebar, mouse.x, mouse.y)
      ? hitLayout.sidebar
      : undefined;
    const pane = formPane ?? sidebarPane;
    if (pane !== undefined) {
      if (isMouseButtonPress(mouse) && buttonId !== undefined) hostMouseButtons.add(buttonId);
      if (isLeftMousePress(mouse) && presentation !== undefined && !hitMapPending) {
        const previousFocus = sidebar.focus;
        const previousSelection = sidebar.selectedId;
        const previousVisibility = sidebar.visible;
        // A host confirmation owns the pointer inside its own pane: while
        // confirm focus the right-hand slot belongs to the dialog, so only the
        // actually written left roster may act on a press. The Sidebar still
        // refuses any click whose written frame drew no visible roster.
        const confirmationOwnsRightPane = presentation.focus === "confirm";
        // Keep the emitted frame's source pane identity and its render-derived
        // maps: a newer coalesced render must never retarget this coordinate.
        // Inside the form slot the Sidebar dispatches to whichever pane that
        // captured render actually drew — the Saved picker or the Network menu —
        // and a Network row's press performs that row's ordinary Enter action
        // once through the pane's own activation routine.
        const activated = formPane !== undefined
          ? !confirmationOwnsRightPane
            && presentation.sidebar.activateFormRowAt(mouse.x - pane.column, mouse.y - pane.row, pane.cols, pane.rows)
          : hitLayout.sidebarOverlay && presentation.focus === "form"
            ? presentation.sidebar.activateFormRowAt(mouse.x - pane.column, mouse.y - pane.row, pane.cols, pane.rows)
            : presentation.sidebar.activateRosterAt(mouse.x - pane.column, mouse.y - pane.row, pane.cols, pane.rows);
        if (activated) {
          if (sidebar.focus !== previousFocus || sidebar.selectedId !== previousSelection
            || sidebar.visible !== previousVisibility) {
            deliberateActionGeneration += 1;
          }
          reconcileLayout(false);
          scheduleRedraw();
        }
      }
      // The visible host pane owns every mouse gesture, including releases,
      // motion and wheel input; only an initial left-button press above can
      // activate a draw-derived row.
      return;
    }
    // A written remote viewport is display-only unless the internal native IO
    // opt-in supplied its dynamic callbacks: then a Main-focused pointer packet is
    // submitted as one canonical content-space SGR report for the exact written
    // source. A deliberately selected remote target whose new viewport is not
    // written yet has no pointer authority either — its packet is refused rather
    // than reinterpreted as keyboard input or forwarded to a local row. A
    // roster-focused packet keeps the existing non-activating drop.
    if (writtenSourceIsRemote() || contentTarget?.kind === "remote") {
      if (sidebar.focus === "main") routeRemoteMouseInput(mouse);
      return;
    }
    // With the roster focused, a left click in the actually displayed, current
    // native pane is a focus gesture only. The activation press and its matching
    // release/motion stay host-owned; no part of that first click reaches Pi.
    if (isLeftMousePress(mouse) && buttonId !== undefined
      && canFocusMainFromNativeClick(mouse, presentation)) {
      const focused = sidebar.focusMainFromNativeClick();
      hostMouseButtons.add(buttonId);
      if (focused) {
        deliberateActionGeneration += 1;
        reconcileLayout(false);
        scheduleRedraw();
      }
      // Even if the focus recheck refuses a raced state change, never replay
      // the click that was evaluated as a host-owned focus gesture.
      return;
    }
    // Native mouse packets never reach Pi while a host form, dialog, or roster
    // owns focus; the roster's eligible Main-pane click above is focus-only.
    // Main-focused packets keep the existing translator and viewport clipping.
    if (sidebar.focus === "main") routeForward(data);
  }

  function handleTerminalInput(data: string): void {
    if (shutdownRequested || externalEditorActive || !sidebar) return;
    try {
      const mouse = parseMouseInput(data);
      if (mouse !== undefined) {
        if (mouse !== null) handleMouseInput(data, mouse);
        return;
      }
      // Focus-only and selection-only host actions (for example the roster-only
      // Alt+Right return to Main) emit no SidebarAction, so the deliberate-action
      // generation is advanced from the sidebar's own observable state as well.
      const previousFocus = sidebar.focus;
      const previousSelection = sidebar.selectedId;
      const previousVisibility = sidebar.visible;
      sidebar.handleInput(data);
      if (sidebar.focus !== previousFocus || sidebar.selectedId !== previousSelection
        || sidebar.visible !== previousVisibility) {
        deliberateActionGeneration += 1;
      }
      // Main-owned native input does not change host presentation unless the
      // focus/selection/visibility snapshot changed (for example, the reserved
      // toggle). Keep all non-Main input on the normal redraw path: roster
      // navigation and form input can change presentation without changing the
      // pane geometry. Child surface onChange remains responsible for drawing
      // native output changes.
      const unchangedMainPresentation = previousFocus === "main"
        && sidebar.focus === "main"
        && sidebar.selectedId === previousSelection
        && sidebar.visible === previousVisibility;
      if (!unchangedMainPresentation) {
        reconcileLayout(false);
        scheduleRedraw();
      }
    } catch {
      requestShutdown(true);
    }
  }

  function handleTerminalResize(): void {
    invalidatePeerConsentDisplay();
    invalidateSavedDeleteConfirmationDisplay();
    // A resize can reflow the terminal before the next coalesced redraw: no
    // pending remote close may keep a confirmable token at the old geometry,
    // and no highlight written at the old geometry may authorize a request.
    invalidateRemoteCloseConfirmationDisplay();
    remoteCloseHighlightEpoch += 1;
    // A remote New submission's written form receipt belongs to the geometry it
    // was written at. Physical reflow retires it (and any in-flight request's
    // last-instant proof) until a replacement frame in this new epoch is written,
    // including a resize that returns to the previous size before repainting.
    createFormEpoch += 1;
    // Physical reflow revokes every remote native IO receipt until a post-resize
    // frame is actually written, including a resize that returns to the previous
    // size before anything is repainted. Remote input/copy only; Close and
    // ordinary host UI keep their own independent written proofs.
    remoteInputEpoch += 1;
    // A real outer resize can reflow the physical screen and then return to
    // the same final geometry before the next coalesced redraw (for example
    // 80 -> 40 -> 80). Invalidate the known baseline before recomputing so the
    // next frame is a complete repaint even when content and geometry did not
    // change. The injected writer seam may omit invalidation; the real writer
    // always implements it.
    writer?.invalidate?.();
    reconcileLayout(true);
  }

  async function handoffExternalEditor(text: string): Promise<string | undefined> {
    if (externalEditorActive || shutdownRequested || !terminal || !terminalStarted) {
      throw new Error("external editor handoff is unavailable");
    }
    externalEditorActive = true;
    // The handoff retires every geometry-bound receipt: the terminal is handed to
    // the editor and repainted, so a remote New receipt composed before it is dead.
    createFormEpoch += 1;
    hostMouseButtons.clear(); // no terminal gesture ownership survives a tty handoff
    const controller = new AbortController();
    externalEditorAbort = controller;
    let terminalPaused = false;
    try {
      await terminal.drainInput(INPUT_DRAIN_MAX_MS, INPUT_DRAIN_IDLE_MS);
      if (shutdownRequested || controller.signal.aborted) return undefined;
      const activeWriter = writer;
      writer = undefined;
      displayedMousePresentation = undefined;
      latestMousePresentation = undefined;
      if (!activeWriter) {
        requestShutdown(true);
        throw new Error("external editor handoff is unavailable");
      }
      let writerSettled = false;
      try {
        writerSettled = await activeWriter.close();
      } catch {
        writerSettled = false;
      }
      if (!writerSettled) {
        requestShutdown(true);
        throw new Error("external editor handoff could not settle terminal output");
      }
      if (shutdownRequested || controller.signal.aborted) return undefined;
      if (mouseTrackingMode !== undefined) {
        if (!writeOwnedMouseSequence(`\x1b[?${mouseTrackingMode}l`)) {
          requestShutdown(true);
          throw new Error("terminal handoff failed");
        }
        mouseTrackingMode = undefined;
      }
      if (mouseSgrEnabled) {
        if (!writeOwnedMouseSequence("\x1b[?1006l")) {
          requestShutdown(true);
          throw new Error("terminal handoff failed");
        }
        mouseSgrEnabled = false;
      }
      try {
        terminal.stop();
      } catch {
        requestShutdown(true);
        throw new Error("terminal handoff failed");
      }
      terminalStarted = false;
      terminalPaused = true;
      const result = await dependencies.runExternalEditor(text, {
        env: snapshot.env,
        cwd: snapshot.startupCwd,
        signal: controller.signal,
      });
      if (shutdownRequested || controller.signal.aborted) return undefined;
      return result;
    } finally {
      if (externalEditorAbort === controller) externalEditorAbort = undefined;
      if (!shutdownRequested && terminalPaused && terminal) {
        try {
          const resumedWriter = createFrameWriter();
          writer = resumedWriter;
          resumedWriter.start();
          if (shutdownRequested) throw new Error("terminal output could not be restored");
          terminal.start(handleTerminalInput, handleTerminalResize);
          terminalStarted = true;
          syncOuterMouseModes();
        } catch {
          requestShutdown(true);
        }
      }
      externalEditorActive = false;
      if (!shutdownRequested) {
        reconcileLayout(false);
        scheduleRedraw();
      }
    }
  }

  function startExternalEditor(text: string): Promise<string | undefined> {
    const task = handoffExternalEditor(text);
    externalEditorTask = task;
    void task.then(
      () => { if (externalEditorTask === task) externalEditorTask = undefined; },
      () => { if (externalEditorTask === task) externalEditorTask = undefined; },
    );
    return task;
  }

  function launchCreate(action: Extract<SidebarAction, { type: "create" }>): void {
    if (!manager || shutdownRequested || !negotiationReady) return;
    const createOptions: CreateInstanceOptions = { workspace: action.workspace };
    let task!: Promise<void>;
    task = (async () => {
      try {
        const outcome = await hostService.startSession(createOptions);
        if (outcome.status === "unavailable" || shutdownRequested || !sidebar) return;
        if (outcome.status === "failed") {
          sidebar.failCreate(action.requestId, GENERIC_CREATE_FAILURE);
          scheduleRedraw();
        } else {
          if (outcome.status === "started") {
            // A successful New submission activates the created child as the
            // Main input owner (the sidebar emits select); launch-error rows
            // never reach this success path.
            sidebar.completeCreate(action.requestId, outcome.id);
          } else {
            sidebar.failCreate(action.requestId, GENERIC_CREATE_FAILURE);
          }
          syncRosterAndSchedule();
          reconcileLayout(true);
        }
      } catch {
        if (!shutdownRequested && sidebar) {
          sidebar.failCreate(action.requestId, GENERIC_CREATE_FAILURE);
          scheduleRedraw();
        }
      } finally {
        createTasks.delete(task);
      }
    })();
    createTasks.add(task);
  }

  /** Snapshot actual title-line columns for the layout with the sidebar shown. */
  function sidebarTitleColumnsSnapshot(): number {
    const cols = clampDimension(terminal?.columns, 80);
    const rows = clampDimension(terminal?.rows, 24);
    const visibleLayout = computeHostLayout(cols, rows, { sidebarVisible: true, focus: "sidebar" });
    return visibleLayout.sidebar?.cols ?? cols;
  }

  /**
   * Deliberate saved-conversation open (issue 323): revalidate the exact
   * catalog row against the live file and known-owned duplicates, then start
   * a NEW independently owned child with the exact branded per-child
   * --session admission. The active session is never touched; a successful
   * open activates the restored child as the Main input owner (the sidebar
   * emits select), with the pane's visibility unchanged.
   */
  function launchSavedOpen(requestId: number, file: string, sessionId: string): void {
    if (!manager || !sidebar || shutdownRequested) return;
    const pickerId = sidebar.savedPickerRequestId;
    const catalog = savedCatalog;
    const row = catalog === undefined || pickerId === undefined || savedCatalogPickerId !== pickerId
      ? undefined
      : catalog.rows.find(
      (candidate) => candidate.file === file && candidate.id === sessionId,
    );
    if (catalog === undefined || row === undefined || savedCatalogRequestId === undefined
      || !searchSavedSessions(catalog, sidebar.savedQuery).includes(row)) {
      sidebar.failSavedOpen(requestId, "That saved conversation is no longer available; reopen the list");
      scheduleRedraw();
      return;
    }
    const admission = hostService.admitSavedConversation(catalog, row);
    if (admission.status === "refused") {
      sidebar.failSavedOpen(requestId, savedRefusalNotice(admission.reason));
      scheduleRedraw();
      return;
    }
    const receipt = admission.admission;
    let task!: Promise<void>;
    task = (async () => {
      try {
        // The exact saved header cwd determines the workspace; the manager
        // refuses any conflicting explicit workspace and fences duplicates.
        const outcome = await hostService.startSession({ workspace: receipt.workspace, savedSession: receipt });
        if (outcome.status === "unavailable" || shutdownRequested || !sidebar) return;
        if (outcome.status === "failed" || outcome.status === "duplicate") {
          sidebar.failSavedOpen(requestId,
            outcome.status === "duplicate"
              ? "That saved conversation is already open in this host"
              : GENERIC_CREATE_FAILURE);
          scheduleRedraw();
        } else {
          if (outcome.status === "started") {
            // A successful Saved open activates the restored child as the Main
            // input owner; launch-error rows never reach this success path.
            sidebar.completeSavedOpen(requestId, outcome.id);
          } else {
            sidebar.failSavedOpen(requestId, GENERIC_CREATE_FAILURE);
          }
          syncRosterAndSchedule();
          reconcileLayout(true);
        }
      } catch (error) {
        if (!shutdownRequested && sidebar) {
          sidebar.failSavedOpen(requestId,
            isDuplicateOwnedLaunchFailure(error)
              ? "That saved conversation is already open in this host"
              : GENERIC_CREATE_FAILURE);
          scheduleRedraw();
        }
      } finally {
        savedOpenTasks.delete(task);
      }
    })();
    savedOpenTasks.add(task);
  }

  /** List or refresh one active picker, retaining only its newest branded catalog. */
  function startSavedCatalogList(requestId: number, pickerId: number): void {
    const owner = manager;
    const activeSidebar = sidebar;
    const activePi = pi;
    const agentDir = sessionSetup?.nativeAgentDir;
    if (!activeSidebar || shutdownRequested) return;
    invalidateSavedDeleteConfirmationDisplay();
    if (!owner || !activePi || !agentDir) {
      activeSidebar.failSavedList(requestId, SAVED_UNAVAILABLE);
      scheduleRedraw();
      return;
    }

    for (const controller of savedListControllers.values()) {
      try { controller.abort(); } catch { /* best-effort cancellation of the exact old listing */ }
    }
    savedListControllers.clear();
    savedCatalog = undefined;
    savedCatalogPickerId = undefined;
    savedCatalogRequestId = requestId;
    invalidateMouseAuthorization();

    const controller = new AbortController();
    savedListControllers.set(requestId, controller);
    let listing: Promise<SavedSessionCatalog>;
    try {
      listing = dependencies.listSavedCatalog({
        agentDir,
        piExecutable: activePi.file,
        expectedPiVersion: activePi.version,
        signal: controller.signal,
      });
    } catch (error) {
      listing = Promise.reject(error);
    }
    void Promise.resolve(listing).then(
      (catalog) => {
        savedListControllers.delete(requestId);
        if (controller.signal.aborted || shutdownRequested || manager !== owner || sidebar !== activeSidebar
          || activeSidebar.savedPickerRequestId !== pickerId) return;
        const filtered = searchSavedSessions(catalog, activeSidebar.savedQuery);
        const accepted = activeSidebar.completeSavedList(
          requestId,
          filtered.map((row) => ({ id: row.id, file: row.file, caption: row.caption, cwd: row.cwd })),
          catalog.issueCount,
          pickerId,
        );
        if (accepted) {
          savedCatalog = catalog;
          savedCatalogPickerId = pickerId;
          savedCatalogRequestId = requestId;
          invalidateMouseAuthorization();
        }
        scheduleRedraw();
      },
      () => {
        savedListControllers.delete(requestId);
        if (controller.signal.aborted || shutdownRequested || manager !== owner || sidebar !== activeSidebar
          || activeSidebar.savedPickerRequestId !== pickerId) return;
        activeSidebar.failSavedList(requestId, SAVED_UNAVAILABLE);
        invalidateMouseAuthorization();
        scheduleRedraw();
      },
    );
  }

  /**
   * Manager onChange fan-out: wake only the readiness waiters for the changed
   * row (each re-reads current state), then run the ordinary roster
   * synchronization. A wake only resolves a promise, so it cannot reenter
   * this path or the manager callback.
   */
  function noteManagerChanged(id: string | undefined): void {
    if (id !== undefined) {
      const waiters = rowReadinessWaiters.get(id);
      if (waiters !== undefined) {
        for (const notify of [...waiters]) {
          try { notify(undefined); } catch { /* one readiness waiter never disturbs the roster */ }
        }
      }
    }
    syncRosterAndSchedule();
  }

  /** Forced settlement of every outstanding readiness wait (shutdown only). */
  function settleRowReadinessWaiters(outcome: RowResumeReadiness): void {
    for (const waiters of [...rowReadinessWaiters.values()]) {
      for (const notify of [...waiters]) {
        try { notify(outcome); } catch { /* per-waiter shutdown settlement is best-effort */ }
      }
    }
  }

  /**
   * Event-driven readiness wait for one just-created replacement child. The
   * waiter is published BEFORE the current-state check so a readiness change
   * (even a synchronous one that lands before create() returns) is never lost,
   * and it is woken by the manager's existing onChange callback. Exactly one
   * 60s deadline bounds unknown startup; a UI/listing cancellation never
   * settles it (an already-started child still completes), while shutdown does.
   * The listener and timer are always removed on settlement.
   */
  function awaitRowReadiness(id: string, expectedSessionId: string | undefined): Promise<RowResumeReadiness> {
    return new Promise<RowResumeReadiness>((resolve) => {
      let finished = false;
      let timer: NodeJS.Timeout | undefined;
      const waiters = rowReadinessWaiters.get(id) ?? new Set<(forced: RowResumeReadiness | undefined) => void>();
      rowReadinessWaiters.set(id, waiters);
      function finish(outcome: RowResumeReadiness): void {
        if (finished) return;
        finished = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        waiters.delete(notify);
        if (waiters.size === 0) rowReadinessWaiters.delete(id);
        resolve(outcome);
      }
      function notify(forced: RowResumeReadiness | undefined): void {
        if (finished) return;
        if (forced !== undefined) {
          finish(forced);
          return;
        }
        let outcome: RowResumeReadiness;
        try {
          outcome = rowResumeReadiness(hostService.readRow(id), expectedSessionId);
        } catch {
          // A throwing metadata read is a readiness failure, never a leak: the
          // listener and deadline timer settle through the same path, so no
          // waiter outlives a failed/aborted evaluation.
          outcome = "failed";
        }
        if (outcome !== "pending") finish(outcome);
      }
      waiters.add(notify);
      if (shutdownRequested) {
        finish("failed");
        return;
      }
      timer = setTimeout(() => finish("failed"), ROW_RESUME_READY_DEADLINE_MS);
      notify(undefined);
    });
  }

  /**
   * Deliberate Enter on an exited row (resume-row): restart the EXACT current
   * retained conversation of that one exited row, never the launch arguments,
   * the original conversation, or the newest saved file. The old placeholder is
   * replaced only when a new independently owned child actually became ready;
   * cancellation never kills a child that already started.
   */
  function launchRowResume(requestId: number, id: string): void {
    if (!manager || !sidebar || shutdownRequested) return;
    const existing = rowResumeTasks.get(id);
    if (existing !== undefined) {
      if (existing.spawned) {
        // An already-started replacement child is never canceled or duplicated.
        sidebar.failRowResume(requestId, ROW_RESUME_DUPLICATE);
        scheduleRedraw();
        return;
      }
      // Pre-spawn duplicate: cancel the earlier read-only attempt; this newer
      // deliberate request takes over the same old row.
      try { existing.controller.abort(); } catch { /* abort is best-effort */ }
    }
    const controller = new AbortController();
    const record: { readonly controller: AbortController; spawned: boolean } = { controller, spawned: false };
    // Register the duplicate fence and the cancellation mapping BEFORE the
    // task body can call any dependency, so even a synchronously throwing
    // adapter cannot start a second attempt.
    rowResumeTasks.set(id, record);
    rowResumeRequests.set(requestId, { oldId: id, controller });
    let task!: Promise<void>;
    task = (async () => {
      await Promise.resolve();
      try {
        await runRowResume(record, requestId, id);
      } finally {
        if (rowResumeTasks.get(id) === record) rowResumeTasks.delete(id);
        if (rowResumeRequests.get(requestId)?.controller === controller) rowResumeRequests.delete(requestId);
        rowResumeTaskSet.delete(task);
      }
    })();
    rowResumeTaskSet.add(task);
  }

  async function runRowResume(
    record: { readonly controller: AbortController; spawned: boolean },
    requestId: number,
    oldId: string,
  ): Promise<void> {
    const owner = manager;
    const activeSidebar = sidebar;
    const activePi = pi;
    if (!owner || !activeSidebar || shutdownRequested) return;
    const fail = (message: string): void => {
      if (shutdownRequested || !sidebar) return;
      sidebar.failRowResume(requestId, message);
      scheduleRedraw();
    };
    const controller = record.controller;
    // Capture the exact current exited binding before the read-only listing.
    const before = hostService.readExitedResumeTarget(oldId);
    if (!before) {
      fail(ROW_RESUME_FAILURE);
      return;
    }
    const agentDir = sessionSetup?.nativeAgentDir;
    if (typeof agentDir !== "string" || agentDir === ""
      || !activePi || !activePi.file || !activePi.version) {
      fail(ROW_RESUME_FAILURE);
      return;
    }
    let catalog: SavedSessionCatalog;
    try {
      catalog = await dependencies.listSavedCatalog({
        agentDir,
        piExecutable: activePi.file,
        expectedPiVersion: activePi.version,
        signal: controller.signal,
      });
    } catch {
      // A canceled listing (navigation, hide, or shutdown) never renders a notice.
      if (controller.signal.aborted || shutdownRequested || !sidebar) return;
      sidebar.failRowResume(requestId, ROW_RESUME_FAILURE);
      scheduleRedraw();
      return;
    }
    if (controller.signal.aborted || shutdownRequested || manager !== owner) return;
    // Re-read the exited/current binding immediately before any spawn: a row
    // that rebound or was replaced refuses instead of restarting something else.
    const after = hostService.readExitedResumeTarget(oldId);
    if (!after || after.binding.sessionId !== before.binding.sessionId || after.epoch !== before.epoch) {
      fail(ROW_RESUME_FAILURE);
      return;
    }
    const choice = chooseExitedRestart(after.binding, after.workspace, catalog);
    if (choice.kind === "refused") {
      fail(ROW_RESUME_FAILURE);
      return;
    }
    let createOptions: CreateInstanceOptions;
    let expectedSessionId: string | undefined;
    if (choice.kind === "saved") {
      const admitted = hostService.admitSavedConversation(catalog, choice.row);
      if (admitted.status === "refused") {
        fail(savedRefusalNotice(admitted.reason));
        return;
      }
      // The exact branded admission is passed verbatim; the manager owns the
      // launch-time file revalidation and known-owned duplicate fence. The
      // replacement must report exactly this saved conversation to qualify.
      expectedSessionId = admitted.admission.sessionId;
      createOptions = { workspace: admitted.admission.workspace, savedSession: admitted.admission };
    } else {
      // Positive known-unsaved binding plus an issue-free, safely absent
      // catalog: a fresh child in the SAME exited owned workspace.
      createOptions = { workspace: choice.cwd };
    }
    if (controller.signal.aborted || shutdownRequested || manager !== owner) return;
    // The spawn starts here: the per-row map now fences duplicates, and any
    // later UI/listing cancel must never discard this already-started child.
    record.spawned = true;
    let createdId: string;
    // The replacement is a NEW, independently remembered slot until it actually
    // replaces the old placeholder: adopting it into the old slot before
    // readiness succeeds would collapse two visible rows into one persisted
    // entry and lose a retained row without any explicit removal. The stable
    // slot moves only when the old placeholder is removed below.
    try {
      createdId = await owner.create(createOptions);
    } catch (error) {
      if (shutdownRequested || !sidebar) return;
      sidebar.failRowResume(requestId,
        isDuplicateOwnedLaunchFailure(error)
          ? "That saved conversation is already open in this host"
          : ROW_RESUME_FAILURE);
      syncRosterAndSchedule();
      return;
    }
    // PTY spawn alone is not readiness: the replacement must independently own
    // a live process AND report a genuine authenticated CURRENT conversation
    // (exactly the requested saved id for a saved restart) before the old
    // exited placeholder may be replaced. This wait is event-driven through the
    // manager's existing onChange callback, bounded by one deadline, and is not
    // settled by a UI/listing cancellation.
    const readiness = await awaitRowReadiness(createdId, expectedSessionId);
    if (readiness !== "ready") {
      if (shutdownRequested || !sidebar) return;
      sidebar.failRowResume(requestId, ROW_RESUME_FAILURE);
      syncRosterAndSchedule();
      return;
    }
    // Only the actual ready success replaces the old exited placeholder. The
    // replacement completes independently of any UI/listing abort, but the
    // FULL readiness predicate is revalidated at this final fence: synchronous
    // status frames can clear or change the current binding (or the saved id)
    // after the waiter resolved but before this continuation ran.
    if (shutdownRequested || !sidebar) return;
    let createdView: NativeInstanceView | undefined;
    try {
      createdView = owner.list().find((candidate) => candidate.id === createdId);
    } catch {
      createdView = undefined;
    }
    let finalReadiness: RowResumeReadiness;
    try {
      finalReadiness = rowResumeReadiness(createdView, expectedSessionId);
    } catch {
      finalReadiness = "failed";
    }
    if (finalReadiness !== "ready") {
      sidebar.failRowResume(requestId, ROW_RESUME_FAILURE);
      syncRosterAndSchedule();
      return;
    }
    // Complete the UI before the old placeholder is removed so the synchronous
    // roster notification cannot invalidate a still-current deliberate intent.
    syncRosterAndSchedule();
    // Roster synchronization can synchronously initiate shutdown on a listing
    // or metadata failure; that fail-closed path must retain the recovery
    // placeholder instead of completing the restart mid-shutdown.
    if (shutdownRequested || !sidebar) return;
    sidebar.completeRowResume(requestId, oldId, createdId);
    removeExitedRow(oldId, { replaced: true, replacementId: createdId });
    reconcileLayout(true);
  }

  /**
   * What one {@link removeExitedRow} call established about THIS host's removal
   * authority. Only `"removed"` claims anything: `"retained"` is the manager
   * refusing to settle the row (so the row and whatever it still owns, possibly
   * a live PTY, stand untouched), and `"failed"` is a manager authority that
   * threw, leaving its effect unobservable.
   */
  type RowRemovalOutcome = "removed" | "retained" | "failed";

  /**
   * Remove one row, optionally completing a confirmed deliberate replacement.
   *
   * A successful replacement transfers its stable roster slot into the old
   * placeholder's position: the slot id, its remembered position, and its
   * active-slot mapping all follow the replaced row, so restarting A in an A,B
   * roster never reorders it to B,A. The transfer happens only after the old
   * row's removal is confirmed, and synchronous roster synchronization is
   * suppressed across that confirmation so the old slot cannot be dropped
   * before the transfer runs.
   *
   * Returns what this host's removal authority established, so the shared close
   * core can report truthful facts instead of a notice: only `"removed"` is a
   * positive claim, `"retained"` is an authority refusal (nothing was settled),
   * and `"failed"` is a thrown authority whose effect is unobservable.
   * `notify: false` is for the owner-side Close provider: it holds back only
   * this host's own removal notices. Every other effect — the ghost set, the
   * roster slot and remembered record, the replacement slot transfer, the
   * remembered active row, the displayed local content target, the roster
   * redraw, the roster persist, and the layout reconcile — is unchanged for
   * every caller.
   */
  function removeExitedRow(
    id: string,
    options?: { readonly replaced?: boolean; readonly replacementId?: string; readonly notify?: boolean },
  ): RowRemovalOutcome {
    if (!manager || !sidebar) return "retained";
    const replacing = options?.replaced === true;
    const notify = options?.notify !== false;
    const replacementId = options?.replacementId;
    const oldSlot = rowSlots.get(id);
    const replacementSlot = replacementId === undefined ? undefined : rowSlots.get(replacementId);
    const replacementRecord = replacementSlot === undefined ? undefined : rosterRecords.get(replacementSlot);
    const wasSyncing = rosterSyncInProgress;
    if (replacing) sidebar.noteRowReplacement(id);
    let removed: boolean;
    try {
      if (replacing) rosterSyncInProgress = true;
      removed = manager.closeExited(id);
    }
    catch {
      if (replacing) sidebar.clearRowReplacement(id);
      else if (notify) { sidebar.showError(REMOVE_FAILURE_MESSAGE); scheduleRedraw(); }
      return "failed";
    } finally {
      rosterSyncInProgress = wasSyncing;
    }
    if (!removed && !replacing) {
      // A settled error row without an owned PTY exit is closed only through
      // the manager's own closeError authority. Resume replacements never get
      // this fallback: they remain closeExited-only.
      const outcome = tryCloseError(manager, id, notify);
      if (outcome === "closed") removed = true;
      else if (outcome === "failure") return "failed"; // generic failure already shown
    }
    if (!removed) {
      // An already-removed placeholder is tolerated; nothing else is touched.
      if (replacing) sidebar.clearRowReplacement(id);
      else if (notify) { sidebar.showError(REMOVE_REFUSED_MESSAGE); scheduleRedraw(); }
      return "retained";
    }
    removedExitedIds.add(id);
    if (replacing && replacementId !== undefined && oldSlot !== undefined
      && replacementSlot !== undefined && replacementSlot !== oldSlot
      && replacementRecord !== undefined && rosterRecords.has(oldSlot)) {
      // Updating an existing Map key preserves its original remembered position;
      // the replacement's own appended slot is dropped at the same moment.
      rosterRecords.set(oldSlot, { ...replacementRecord, slotId: oldSlot, rowId: replacementId });
      rosterRecords.delete(replacementSlot);
      rowSlots.delete(id);
      rowSlots.set(replacementId, oldSlot);
      if (rememberedActiveSlot === replacementSlot) rememberedActiveSlot = oldSlot;
    }
    if (contentTarget?.kind === "local" && contentTarget.id === id) {
      contentTarget = undefined;
      contentSelectionGeneration += 1;
    }
    // Authoritatively settled removal never activates a sibling or loses its owner.
    syncRosterAndSchedule();
    reconcileLayout(true);
    return "removed";
  }

  /**
   * Deliberate-removal fallback for an error row whose closeExited refused:
   * call the optional manager closeError only when the exact current manager
   * row is still in "error" lifecycle. A missing method or a refusal leaves
   * the decision to the caller; a thrown closeError reports the generic
   * failure and keeps the row. No signal, sibling, or other fallback.
   */
  function tryCloseError(owner: OwningHostManager, id: string, notify: boolean): "closed" | "not-applicable" | "failure" {
    const closeError = owner.closeError;
    if (typeof closeError !== "function") return "not-applicable";
    if (hostService.readRow(id)?.lifecycle !== "error") return "not-applicable";
    try {
      return closeError.call(owner, id) === true ? "closed" : "not-applicable";
    } catch {
      if (notify) { sidebar?.showError(REMOVE_FAILURE_MESSAGE); scheduleRedraw(); }
      return "failure";
    }
  }

  /**
   * The host's ONE row close: stop one owned row, then remove its row only
   * after the manager POSITIVELY reports the exit.
   *
   * The local `d`/Delete route drives this with `notify: true` and gets exactly
   * the notices it always got; the owner-side Close provider drives it with
   * `notify: false` and reads the returned facts instead of writing anything to
   * this host's screen. Both routes share one per-row `rowStopTasks` fence (so
   * one row has one stop ladder and a duplicate request never re-signals or
   * queues a second one), the same authority re-check before the manager is
   * addressed and after its await, the same {@link removeExitedRow} bookkeeping
   * (ghost set, roster slot and remembered record, remembered active row,
   * displayed local content target, roster redraw, roster persist, layout
   * reconcile), and the same shutdown barrier: teardown already awaits every task
   * in `rowStopTasks`, so a close accepted here joins it with no second registry
   * and no new unbounded await.
   *
   * The facts say only what this host observed. `confirmed` runs the manager's
   * existing bounded ladder (graceful request, then TERM, then the owned-handle
   * kill) and adds no force of its own; nothing here signals a sibling, cancels
   * an in-flight restart or resume, reports a sent signal or an acknowledgement as
   * an exit, or deletes a saved conversation. An outcome this host did not
   * positively settle stays `unknown` instead of becoming a claim that nothing was
   * submitted.
   */
  function startRowClose(
    owner: OwningHostManager,
    id: string,
    confirmed: boolean,
    notify: boolean,
  ): Promise<OwnerCloseFacts> {
    const task = (async (): Promise<OwnerCloseFacts> => {
      // Publish duplicate fencing before even a synchronously throwing adapter.
      await Promise.resolve();
      try {
        // That yield is the only window in which this row's close is registered and
        // the adapter has not been addressed. Teardown may have begun or the run
        // replaced inside it, and the captured manager must not be written to
        // afterwards, so the host's authority is re-read here rather than after a
        // stop this host no longer owns. This close signalled nothing, and the row's
        // fate from here is unobservable, so the same conservative fact as the
        // post-stop fence applies.
        if (shutdownRequested || manager !== owner) return { kind: "unknown" };
        const stop = owner.stop;
        if (typeof stop !== "function") {
          // A manager that cannot stop refuses honestly: no signal, no startup
          // failure, and the local route keeps its existing bounded notice. This is
          // a positive pre-call proof that nothing was submitted.
          if (notify && !shutdownRequested && sidebar) { sidebar.showError(REMOVE_FAILURE_MESSAGE); scheduleRedraw(); }
          return { kind: "refused" };
        }
        const result = await stop.call(owner, id, { confirmed: confirmed === true });
        // Teardown began, or this is no longer the host's manager run: what
        // happened to the child is unknown, and nothing may be re-sent or
        // re-signalled on its behalf, so no exit or removal is claimed.
        if (shutdownRequested || manager !== owner) return { kind: "unknown" };
        if (result.status === "exited") {
          // Removal follows a positive exit and nothing else, through the one
          // path that owns this host's roster bookkeeping. The exit itself was
          // observed, so a clean refusal to remove truthfully reports a stopped row
          // this host kept; a removal authority that threw leaves even the row's
          // presence unobservable.
          const removal = removeExitedRow(id, { notify });
          return removal === "removed" ? { kind: "removed" }
            : removal === "failed" ? { kind: "unknown" }
              : { kind: "stopped-retained" };
        }
        // Every non-exited outcome keeps the row, its registration, this host's
        // surface, and its ownership exactly as they were; the local route keeps
        // the notice and the roster restatement it always produced.
        if (notify && sidebar) {
          sidebar.showError(result.status === "confirmation-required"
            ? ROW_STOP_CONFIRMATION_MESSAGE
            : REMOVE_REFUSED_MESSAGE);
          syncRosterAndSchedule();
        }
        // `unconfirmed` is this manager's own report that its bounded ladder ended
        // without an exit. `unavailable` is ambiguous: the manager can report it
        // AFTER accepting the shutdown request, when its record or the manager
        // itself went away during the await, and another adapter build can report a
        // status this host does not recognize. Neither proves that nothing was
        // submitted, so both stay unknown instead of becoming a refusal.
        return result.status === "confirmation-required"
          ? { kind: "confirmation-required" }
          : result.status === "unconfirmed"
            ? { kind: "unconfirmed" }
            : { kind: "unknown" };
      } catch {
        // The manager threw, so whether it signalled anything is unknown. The
        // local route keeps its existing bounded failure notice; no exit,
        // removal, or cleanup is ever claimed for either route.
        if (notify && !shutdownRequested && sidebar) { sidebar.showError(REMOVE_FAILURE_MESSAGE); scheduleRedraw(); }
        return { kind: "unknown" };
      } finally {
        rowStopTasks.delete(id);
      }
    })();
    rowStopTasks.set(id, task);
    return task;
  }

  /**
   * The local `d`/Delete route: the shared close core with this host's notices.
   * Its preconditions and duplicate handling are exactly what they were before
   * the core existed — a row with an in-flight close is simply ignored.
   */
  function launchRowStop(id: string, confirmed: boolean): void {
    if (!manager || !sidebar || rowStopTasks.has(id)) return;
    void startRowClose(manager, id, confirmed, true);
  }

  /**
   * The ONE owner-side Close provider. It closes one row of THIS host by reusing
   * {@link startRowClose} — the exact stop-and-exit-only-removal core the local
   * route uses, with the same per-row fence and roster bookkeeping — and answers
   * with fixed facts only.
   *
   * Nothing is enabled by this phase: no capability is advertised, no frame
   * carries a close, and no coordinator code calls this handler. Only a future
   * owner endpoint behind the current TLS-proved peer key and the current
   * directional receiving grant can reach it, and that endpoint must reauthorize
   * before writing any reply.
   *
   * The request is resolved ONLY against this owner's authoritative inventory,
   * never against a viewer's local manager, and it needs no native conversation
   * tuple, no displayed or selected row, no viewer, no controller lease, and no
   * local popup or setting. It is notice-free toward this host's operator (the
   * requester gets the facts instead) while the shared core still performs its
   * normal roster redraw, status, and persistence-warning paths.
   *
   * The facts never overstate what this host saw. `removed` is the manager's own
   * confirmed removal — after an exit this host actually observed (a row already in
   * `exited` lifecycle, or a stop that reported one) or under its settled
   * launch-error removal authority — while `stopped-retained` requires an exit this
   * host actually observed. An `error` row takes the same route the local
   * `d`/Delete route takes for that same row: the manager's real stop when it
   * reports the child live, its own settled-removal authority when it reports the
   * child settled. A refusal is reserved for authority this host positively
   * established before any call; an ambiguous result after a stop was addressed,
   * and any thrown authority, reports `unknown`, which claims neither removal nor
   * retention.
   */
  async function closeOwnedSession(request: OwnerCloseRequest): Promise<OwnerCloseFacts> {
    // Fence teardown and the one manager run before anything is read or written.
    const owner = manager;
    if (owner === undefined || shutdownRequested) return { kind: "refused" };
    // An inventory that cannot be observed is unknown; a different owner run or
    // a row this run does not have is refused. None of these reads writes,
    // signals, stops, or removes anything.
    let inventory: OwningHostInventorySnapshot | undefined;
    try {
      inventory = hostService.readInventorySnapshot();
    } catch {
      inventory = undefined;
    }
    if (inventory === undefined) return { kind: "unknown" };
    if (inventory.hostRunId !== request.hostRunId) return { kind: "refused" };
    const row = inventory.rows.find((candidate) => candidate.id === request.rowId);
    if (row === undefined) return { kind: "refused" };
    // One close per row: an in-flight close already owns this row's stop ladder,
    // and a second request never re-signals or queues behind it.
    if (rowStopTasks.has(request.rowId)) return { kind: "busy" };
    // An already exited row is REMOVED, never blindly stopped: it may own no
    // PTY at all, and only the manager's own removal authority may settle it.
    // This is the same route local d/Delete takes, and it takes no await, so no
    // stale authority is possible here. Its lifecycle IS a positive exit, so a
    // clean refusal still reports the observed stop honestly; a thrown authority
    // leaves even the row's presence unobservable.
    if (row.lifecycle === "exited") {
      const outcome = removeExitedRow(request.rowId, { notify: false });
      if (outcome === "removed") return { kind: "removed" };
      return outcome === "failed" ? { kind: "unknown" } : { kind: "stopped-retained" };
    }
    // An error lifecycle is NOT a settlement: the manager can keep a live PTY
    // behind a fatal display or setup error, so the error badge alone is neither
    // exit nor removal authority. The owner close follows the manager's own read of
    // the child, exactly like the local `d`/Delete route for that row: a child the
    // manager reports LIVE goes through the shared core's real idle preflight and
    // existing bounded ladder (`confirmed` authorizes that ladder only), and only
    // an exit it then reports may lead to removal. A child the manager reports
    // SETTLED is removed by the manager's own authorities (`closeExited`, then the
    // lifecycle-gated `closeError`) and never blindly stopped; a refusal settled
    // nothing and a thrown authority is unobservable, and neither claims an exit.
    // Anything else — a live state this host cannot read — is refused without
    // signalling anything, because no inference from a badge is authority.
    if (row.lifecycle === "error") {
      if (row.hasLiveProcess === true) return startRowClose(owner, request.rowId, request.confirmed, false);
      if (row.hasLiveProcess !== false) return { kind: "refused" };
      const outcome = removeExitedRow(request.rowId, { notify: false });
      if (outcome === "removed") return { kind: "removed" };
      return outcome === "failed" ? { kind: "unknown" } : { kind: "refused" };
    }
    // A live row goes through the shared core with the manager's real idle
    // preflight. `confirmed` authorizes only the existing bounded ladder, never
    // a force, and the core re-checks teardown and manager identity before the
    // stop and after its await before removing anything.
    return startRowClose(owner, request.rowId, request.confirmed, false);
  }

  /**
   * The ONE owner-side rowless Create provider. It creates one blank child in THIS
   * host's exact current run by reusing the very seam the local New action uses —
   * {@link OwningHostService.startSession} with only the canonical workspace — and
   * answers with fixed facts only.
   *
   * Nothing else about the local New route happens here: no duplicate fence, no
   * workspace deduplication, no path resolution or cwd substitution, no trimming,
   * no form bookkeeping, no row selection, and no activation or focus change. The
   * request is resolved ONLY against this owner's authoritative inventory, which is
   * read before the create for the exact run and after it for the row that actually
   * came up, and it needs no native conversation tuple, displayed or selected row,
   * viewer, controller lease, or local popup or setting. It is notice-free toward
   * this host's operator (the requester gets the facts instead) while the service's
   * normal roster redraw and persistence-warning paths still run.
   *
   * The facts never overstate what this host saw. `started` requires the row to be
   * alive with a live process in THIS run's own post-create inventory. `unconfirmed`
   * is an addressed create that produced nothing usable (a not-ready or failed
   * create may have left an error row, which this fact neither removes nor
   * describes). `refused` is reserved for authority or identity this host
   * positively established before any create was invoked, including the minimal
   * re-proof checked immediately before that invocation. A throwing manager, an
   * interrupted run, an unexpected duplicate, or an unrecognized status is
   * `unknown` and claims neither a child nor its absence.
   */
  async function createOwnedSession(
    request: OwnerCreateRequest,
    stillAuthorized: () => boolean,
  ): Promise<OwnerCreateFacts> {
    // Fence teardown and the one manager run before anything is read or written.
    if (manager === undefined || shutdownRequested) return { kind: "refused" };
    // An inventory that cannot be observed is unknown, and another owner run is
    // refused. Neither read starts, writes, selects, activates, or focuses anything.
    let before: OwningHostInventorySnapshot | undefined;
    try {
      before = hostService.readInventorySnapshot();
    } catch {
      before = undefined;
    }
    if (before === undefined) return { kind: "unknown" };
    if (before.hostRunId !== request.hostRunId) return { kind: "refused" };
    // The owner's minimal re-proof is checked IMMEDIATELY before the create is
    // invoked — after every callout above — so a Revoke, a replaced grant, or a
    // retired channel that landed after admission never starts a child.
    let authorized = false;
    try {
      authorized = stillAuthorized() === true;
    } catch {
      authorized = false;
    }
    if (!authorized || shutdownRequested) return { kind: "refused" };
    // A blank create has no saved-conversation duplicate fence: the canonical form
    // text is forwarded verbatim and the manager applies its own existing launch
    // semantics.
    let outcome: StartedSessionOutcome;
    try {
      outcome = await hostService.startSession({ workspace: request.workspace });
    } catch {
      return { kind: "unknown" };
    }
    // Not-ready and failed are addressed operations that produced nothing usable.
    if (outcome.status === "not-ready" || outcome.status === "failed") {
      return { kind: "unconfirmed" };
    }
    // `duplicate` is never a saved-duplicate refusal here, because a blank create
    // has no duplicate fence at all; an interrupted run and any unrecognized status
    // are equally unobservable.
    if (outcome.status !== "started") return { kind: "unknown" };
    // `started` requires this exact run's own post-create inventory to report the
    // row alive with a live process. An unreadable inventory, or one belonging to a
    // different run, cannot establish that nothing usable came up: a live child may
    // already exist and merely be unobservable, so both stay `unknown`. Only an
    // observable row that is absent, starting, errored, or exited is `unconfirmed`.
    let after: OwningHostInventorySnapshot | undefined;
    try {
      after = hostService.readInventorySnapshot();
    } catch {
      after = undefined;
    }
    if (after === undefined) return { kind: "unknown" };
    if (after.hostRunId !== request.hostRunId) return { kind: "unknown" };
    const row = after.rows.find((candidate) => candidate.id === outcome.id);
    if (row === undefined || row.lifecycle !== "alive" || row.hasLiveProcess !== true) {
      return { kind: "unconfirmed" };
    }
    return { kind: "started", hostRunId: after.hostRunId, rowId: outcome.id };
  }

  // --- Requester-side remote Close (the owner's row, asked over roster metadata) ---

  /**
   * The optional Close controller of the ONE existing coordinator. It is read
   * only here, feature-detected every time, and never used to connect, pair,
   * grant, pin, or advertise anything: an older coordinator or fake simply has
   * no `ownerClose`, and this host then reports a truthful unsupported notice.
   */
  function ownerCloseController(): PeerCloseController | undefined {
    const coordinator = peerCoordinator as (Partial<PeerCoordinatorWithClose> | undefined);
    if (coordinator === undefined) return undefined;
    try {
      const candidate = coordinator.ownerClose;
      if (candidate === undefined || typeof candidate.closeSession !== "function") return undefined;
      return candidate;
    } catch {
      return undefined;
    }
  }

  function remoteCloseTargetKey(target: {
    readonly hostId: string;
    readonly hostRunId: string;
    readonly rowId: string;
  }): string {
    return JSON.stringify([target.hostId, target.hostRunId, target.rowId]);
  }

  /**
   * The ONE written-highlight gate for a remote Close. It proves, by value, that
   * the frame the writer actually committed drew this exact owner row as its
   * complete left-roster highlight, that no newer composition has moved or
   * changed that highlight, and that the terminal is still at the written
   * geometry. A held/queued write, a moved highlight, a reordered or clipped
   * row, a replaced run, or a resize therefore requests nothing at all.
   */
  function writtenRemoteCloseRow(
    target: { readonly hostId: string; readonly hostRunId: string | null; readonly rowId: string },
  ): SidebarRemoteCloseRow | undefined {
    if (shutdownRequested || externalEditorActive || !terminal || !terminalStarted || !sidebar) return undefined;
    if (target.hostRunId === null || target.hostRunId.length === 0) return undefined;
    if (sidebar.focus !== "sidebar" || !sidebar.visible) return undefined;
    if (layout === undefined) return undefined;
    const shown = displayedMousePresentation;
    const latest = latestMousePresentation;
    if (shown === undefined || latest === undefined) return undefined;
    // The written receipt must belong to the CURRENT geometry epoch: a reflow
    // revokes highlight authority until a replacement frame is actually written.
    if (shown.remoteCloseEpoch !== remoteCloseHighlightEpoch
      || latest.remoteCloseEpoch !== remoteCloseHighlightEpoch) return undefined;
    const drawn = shown.sidebar.remoteClose;
    if (drawn === undefined || !sameRemoteCloseRow(drawn, latest.sidebar.remoteClose)) return undefined;
    if (drawn.focus !== "sidebar" || drawn.hostRunId === null) return undefined;
    // The terminal geometry must still be the geometry that was written.
    const cols = clampDimension(terminal.columns, 80);
    const rows = clampDimension(terminal.rows, 24);
    if (shown.layout.cols !== cols || shown.layout.rows !== rows) return undefined;
    if (shown.layout.sidebar === undefined
      || shown.layout.sidebar.cols !== drawn.cols || shown.layout.sidebar.rows !== drawn.rows) return undefined;
    // The request names exactly the written row: no retarget, no local id
    // collision, no selection-driven substitution.
    if (drawn.hostId !== target.hostId || drawn.hostRunId !== target.hostRunId
      || drawn.rowId !== target.rowId) return undefined;
    return drawn;
  }

  /**
   * Revalidate ONLY the minimal frozen target against the coordinator's current
   * roster observation: the same destination, the same owner run, and a row that
   * is still present. Nothing else is read — no native conversation tuple, no
   * epoch, no viewer, no selection, and no display facts — so a stale-but-present
   * row is still eligible and a same-target native-epoch change is not a denial.
   *
   * `absent` is reserved for positive observations (a complete roster without
   * that destination, run, or row). `unknown` is no complete observation at all
   * and is never treated as disappearance; the owner host revalidates anyway.
   */
  function remoteCloseTargetPresence(
    target: { readonly hostId: string; readonly hostRunId: string; readonly rowId: string },
  ): "present" | "absent" | "unknown" {
    const hosts = peerUiSnapshot?.hosts;
    if (hosts === null || hosts === undefined) return "unknown";
    const host = hosts.find((candidate) => candidate.id === target.hostId);
    if (host === undefined) return "absent";
    // The owner-run fence comes FIRST: a reconnect resets the production roster
    // to `rows: null, hostRunId: null`, and an unavailable row observation must
    // never carry an obsolete run past this check. A CLEARED run is therefore
    // `absent` (not "no observation"), while a same-run unavailable row stays
    // `unknown` and is left to the owner's own revalidation.
    if ((host.roster.hostRunId ?? null) !== target.hostRunId) return "absent";
    const rows = host.roster.rows;
    if (rows === null) return "unknown";
    return rows.some((row) => row.id === target.rowId) ? "present" : "absent";
  }

  /**
   * Drop a pending remote-close dialog whose frozen target this host can
   * positively see is gone (row removed or owner run replaced). It sends
   * nothing, confirms nothing, and leaves every other surface untouched.
   */
  function abandonVanishedRemoteCloseTarget(): void {
    const frame = remoteCloseConfirmationFrame;
    if (frame === undefined) return;
    if (remoteCloseTargetPresence(frame.target) !== "absent") return;
    invalidateRemoteCloseConfirmationDisplay();
    sidebar?.abandonRemoteCloseConfirmation();
    sidebar?.showError(REMOTE_CLOSE_TARGET_GONE_MESSAGE);
    reconcileLayout(true);
    scheduleRedraw();
  }

  /**
   * This side's condensed preflight over the SAME drawn card, matching the local
   * `d`/Delete route: a confirmed exit or a settled error row is an owner
   * removal, a row without an owned process is refused, and a live row is
   * requested directly only when complete idleness was positively drawn. The
   * owner host always revalidates its own row; this only decides whether the
   * operator must confirm first.
   */
  function remoteClosePreflight(
    drawn: SidebarRemoteCloseRow,
  ): "direct" | "confirmation" | "refuse" {
    if (drawn.hostRunId === null || drawn.hostRunId.length === 0) return "refuse";
    if (drawn.lifecycle === "exited") return "direct";
    if (drawn.lifecycle === "error" && drawn.hasLiveProcess === false) return "direct";
    if (drawn.hasLiveProcess !== true) return "refuse";
    if (!drawn.idle) return "confirmation";
    // The owner already told this host that this exact row was not idle after an
    // unconfirmed request this host believed idle, so the cached idle projection
    // is not enough: the next deliberate request is confirmed on a written dialog.
    if (remoteCloseMarkers.has(remoteCloseTargetKey({
      hostId: drawn.hostId,
      hostRunId: drawn.hostRunId,
      rowId: drawn.rowId,
    }))) return "confirmation";
    return "direct";
  }

  /** Fixed, truthful notice for one settled owner result (never a retry claim). */
  function remoteCloseResultNotice(attempt: RemoteCloseAttempt, result: PeerCloseResult): string | undefined {
    if (result.kind === "owner-result") {
      const facts: OwnerCloseFacts | undefined = isOwnerCloseFacts(result.facts) ? result.facts : undefined;
      if (facts === undefined) return remoteCloseUnknownNotice(attempt);
      switch (facts.kind) {
        case "removed":
          return `Remote session removed by its host: ${attempt.title}`;
        case "stopped-retained":
          return `Remote session stopped but its host kept the row: ${attempt.title}`;
        case "confirmation-required":
          return `The remote host needs confirmation before stopping that session: ${attempt.title}`;
        case "unconfirmed":
          return `The remote host could not confirm stopping that session; the row is retained: ${attempt.title}`;
        case "refused":
          return `The remote host did not accept that close; nothing was stopped: ${attempt.title}`;
        case "busy":
          return `${REMOTE_CLOSE_BUSY_MESSAGE}: ${attempt.title}`;
        case "unknown":
          return remoteCloseUnknownNotice(attempt);
      }
    }
    if (result.kind === "not-sent") {
      switch (result.reason) {
        case "capability-unsupported":
          return REMOTE_CLOSE_UNSUPPORTED_MESSAGE;
        case "not-ready":
          return `That destination is not ready; no close was sent: ${attempt.title}`;
        case "invalid-request":
          return `The close request could not be represented; nothing was sent: ${attempt.title}`;
        case "target-unavailable":
          return `That remote session is no longer addressable; no close was sent: ${attempt.title}`;
        case "busy":
          return `${REMOTE_CLOSE_BUSY_MESSAGE}: ${attempt.title}`;
        case "row-limit":
          return `Too many remote closes are already in progress; no close was sent: ${attempt.title}`;
      }
    }
    return remoteCloseUnknownNotice(attempt);
  }

  function remoteCloseUnknownNotice(attempt: RemoteCloseAttempt): string {
    return `The remote close result is unknown; nothing was re-sent: ${attempt.title}`;
  }

  /**
   * Records one settled owner fact without touching any local row, manager,
   * slot, task, or saved conversation. The owner's own roster projection is the
   * only thing that can remove or retain a remote row, so this only reports and
   * maintains the bounded confirmation reminder.
   */
  function applyRemoteCloseResult(attempt: RemoteCloseAttempt, result: PeerCloseResult): void {
    const target = { hostId: attempt.hostId, hostRunId: attempt.hostRunId, rowId: attempt.rowId };
    const facts = result.kind === "owner-result" && isOwnerCloseFacts(result.facts)
      ? result.facts
      : undefined;
    if (facts?.kind === "confirmation-required") {
      // Only this explicit owner fact, and only after an unconfirmed request this
      // side believed was idle, arms the next deliberate confirmation. The marker
      // never confirms anything by itself and never opens a dialog on its own.
      if (!attempt.confirmed && attempt.cachedIdle) markRemoteCloseConfirmationRequired(target);
    } else if (facts !== undefined) {
      clearRemoteCloseMarker(target);
    }
    const notice = remoteCloseResultNotice(attempt, result);
    if (notice !== undefined) sidebar?.showError(notice);
  }

  function markRemoteCloseConfirmationRequired(target: RemoteCloseConfirmationMarker): void {
    const key = remoteCloseTargetKey(target);
    if (remoteCloseMarkers.has(key)) return;
    remoteCloseMarkers.set(key, {
      hostId: target.hostId,
      hostRunId: target.hostRunId,
      rowId: target.rowId,
    });
  }

  function clearRemoteCloseMarker(target: {
    readonly hostId: string;
    readonly hostRunId: string;
    readonly rowId: string;
  }): void {
    remoteCloseMarkers.delete(remoteCloseTargetKey(target));
  }

  /**
   * Drops reminders this host can positively see no longer apply: its owner
   * host is gone from a complete observation, its owner run was replaced (even
   * while that run's rows are unavailable), its row is gone from that run, or
   * the row settled. Positive absence and settlement are the ONLY reasons to
   * prune; the observed hosts/runs/rows themselves bound the set, so an older
   * target's still-valid reminder is never silently discarded to make room. An
   * unobserved roster (null rows) on the SAME run is not evidence either way
   * and leaves its reminder alone.
   */
  function reconcileRemoteCloseMarkers(snapshot: PeerUiSnapshot): void {
    if (remoteCloseMarkers.size === 0) return;
    const hosts = snapshot.hosts;
    if (hosts === null) return;
    for (const [key, marker] of [...remoteCloseMarkers]) {
      const host = hosts.find((candidate) => candidate.id === marker.hostId);
      if (host === undefined) {
        // A complete observation without this destination: positively gone.
        remoteCloseMarkers.delete(key);
        continue;
      }
      // The owner-run fence applies even while the rows are unavailable: a
      // reconnect's `rows: null, hostRunId: null` or a replaced run can never
      // inherit the previous run's reminder.
      if ((host.roster.hostRunId ?? null) !== marker.hostRunId) {
        remoteCloseMarkers.delete(key);
        continue;
      }
      const rows = host.roster.rows;
      if (rows === null) continue;
      const row = rows.find((candidate) => candidate.id === marker.rowId);
      if (row === undefined || row.lifecycle === "exited"
        || (row.lifecycle === "error" && row.hasLiveProcess === false)) {
        remoteCloseMarkers.delete(key);
      }
    }
  }

  /**
   * Sends exactly one request to the owner's existing Close controller for one
   * frozen attempt, then reports the one fixed result. Nothing is retried,
   * replayed, cancelled, or retargeted, and a throw after the handoff is an
   * unknown outcome rather than a not-sent or cancelled claim.
   */
  function startRemoteClose(attempt: RemoteCloseAttempt, controller: PeerCloseController): void {
    const key = remoteCloseTargetKey(attempt);
    if (remoteCloseAttempts.has(key)) {
      sidebar?.showError(REMOTE_CLOSE_BUSY_MESSAGE);
      scheduleRedraw();
      return;
    }
    remoteCloseAttempts.add(key);
    void (async () => {
      let result: PeerCloseResult;
      try {
        result = await controller.closeSession({
          hostId: attempt.hostId,
          hostRunId: attempt.hostRunId,
          rowId: attempt.rowId,
          confirmed: attempt.confirmed,
        });
        if (typeof result !== "object" || result === null
          || (result.kind !== "owner-result" && result.kind !== "not-sent" && result.kind !== "unknown")) {
          result = { kind: "unknown" };
        }
      } catch {
        result = { kind: "unknown" };
      }
      remoteCloseAttempts.delete(key);
      if (shutdownRequested) return;
      applyRemoteCloseResult(attempt, result);
      reconcileLayout(true);
      scheduleRedraw();
    })();
  }

  /** True only while this exact written dialog frame is still the current one. */
  function isCurrentRemoteCloseConfirmationFrame(frame: RemoteCloseConfirmationFrame): boolean {
    return terminal !== undefined && sidebar !== undefined && sidebar.visible && sidebar.focus === "confirm"
      && sidebar.remoteCloseConfirmationActive
      && clampDimension(terminal.columns, 80) === frame.cols
      && clampDimension(terminal.rows, 24) === frame.rows
      && sidebar.isRemoteCloseConfirmationRenderCurrent(frame.generation, frame.renderToken);
  }

  /** Revoke remote-close confirmation authority before any target/focus invalidation. */
  function invalidateRemoteCloseConfirmationDisplay(): void {
    remoteCloseConfirmationFrame = undefined;
    sidebar?.invalidateRemoteCloseConfirmationDisplay();
  }

  /** The one deliberately confirmed remote Close, rechecked synchronously. */
  function confirmRemoteClose(action: {
    readonly hostId: string;
    readonly hostRunId: string;
    readonly rowId: string;
    readonly generation: number;
    readonly renderToken: number;
  }): void {
    const activeSidebar = sidebar;
    const frame = remoteCloseConfirmationFrame;
    if (!activeSidebar || frame === undefined) {
      sidebar?.showError(REMOTE_CLOSE_DIALOG_CHANGED_MESSAGE);
      scheduleRedraw();
      return;
    }
    if (!frame.settled
      || frame.generation !== action.generation
      || frame.renderToken !== action.renderToken
      || !sameRemoteCloseTarget(frame.target, action)
      || !isCurrentRemoteCloseConfirmationFrame(frame)) {
      // A forged, stale, superseded, resized, queued, held, or unwritten DTO can
      // never confirm anything: the exact written frame is the only authority.
      invalidateRemoteCloseConfirmationDisplay();
      activeSidebar.showError(REMOTE_CLOSE_DIALOG_CHANGED_MESSAGE);
      reconcileLayout(true);
      scheduleRedraw();
      return;
    }
    const target = frame.target;
    if (remoteCloseTargetPresence(target) === "absent") {
      // The written dialog can outlive its row or its owner run. Submission
      // revalidates that minimal target, so an obsolete one is never sent.
      invalidateRemoteCloseConfirmationDisplay();
      activeSidebar.showError(REMOTE_CLOSE_TARGET_GONE_MESSAGE);
      reconcileLayout(true);
      scheduleRedraw();
      return;
    }
    // Consume the one-shot receipt BEFORE dispatch so this same generation can
    // never be confirmed twice, while a duplicate that arrives later has no
    // current frame to match.
    remoteCloseConfirmationFrame = undefined;
    const controller = ownerCloseController();
    if (controller === undefined) {
      activeSidebar.showError(REMOTE_CLOSE_UNSUPPORTED_MESSAGE);
      reconcileLayout(true);
      scheduleRedraw();
      return;
    }
    clearRemoteCloseMarker(target);
    startRemoteClose({
      hostId: target.hostId,
      hostRunId: target.hostRunId,
      rowId: target.rowId,
      title: frame.title,
      confirmed: true,
      cachedIdle: false,
    }, controller);
    reconcileLayout(true);
    scheduleRedraw();
  }

  /** The one deliberate `d`/Delete on a written remote highlight. */
  function requestRemoteClose(action: {
    readonly hostId: string;
    readonly hostRunId: string | null;
    readonly rowId: string;
  }): void {
    const activeSidebar = sidebar;
    if (!activeSidebar) return;
    if (action.hostRunId === null || action.hostRunId.length === 0) {
      activeSidebar.showError(REMOTE_CLOSE_NO_RUN_MESSAGE);
      scheduleRedraw();
      return;
    }
    if (remoteCloseTargetPresence({ hostId: action.hostId, hostRunId: action.hostRunId, rowId: action.rowId })
      === "absent") {
      // Positively gone or replaced, even if the last drawn frame still shows it:
      // nothing is requested for a target the owner no longer lists.
      activeSidebar.showError(REMOTE_CLOSE_TARGET_GONE_MESSAGE);
      scheduleRedraw();
      return;
    }
    const drawn = writtenRemoteCloseRow(action);
    if (drawn === undefined) {
      // Not the actually written highlight: request nothing, open nothing.
      activeSidebar.showError(REMOTE_CLOSE_NOT_DRAWN_MESSAGE);
      scheduleRedraw();
      return;
    }
    const plan = remoteClosePreflight(drawn);
    if (plan === "refuse") {
      activeSidebar.showError(REMOTE_CLOSE_NO_PROCESS_MESSAGE);
      scheduleRedraw();
      return;
    }
    const controller = ownerCloseController();
    if (controller === undefined) {
      activeSidebar.showError(REMOTE_CLOSE_UNSUPPORTED_MESSAGE);
      scheduleRedraw();
      return;
    }
    const target = { hostId: drawn.hostId, hostRunId: action.hostRunId, rowId: drawn.rowId };
    if (remoteCloseAttempts.has(remoteCloseTargetKey(target))) {
      activeSidebar.showError(REMOTE_CLOSE_BUSY_MESSAGE);
      scheduleRedraw();
      return;
    }
    const prepared = activeSidebar.prepareRemoteClose(target, { direct: plan === "direct" });
    if (prepared === "refused") {
      activeSidebar.showError(REMOTE_CLOSE_NOT_DRAWN_MESSAGE);
      scheduleRedraw();
      return;
    }
    if (prepared === "confirmation-opened") {
      // Busy or unknown: a written dialog decides. No request is sent yet.
      reconcileLayout(true);
      scheduleRedraw();
      return;
    }
    startRemoteClose({
      hostId: drawn.hostId,
      hostRunId: action.hostRunId,
      rowId: drawn.rowId,
      title: drawn.title,
      confirmed: false,
      cachedIdle: drawn.idle,
    }, controller);
  }

  // --- Requester-side remote New (`create-on-peer`). ---

  /**
   * The optional Create controller of the ONE existing coordinator. It is read
   * only here, feature-detected every time exactly like Close, and never used to
   * connect, pair, grant, pin, or advertise anything: an older coordinator or
   * fake simply has no `ownerCreate`, and this host then reports a truthful
   * unsupported notice without falling back to a local create.
   */
  function ownerCreateController(): PeerCreateController | undefined {
    const coordinator = peerCoordinator as (Partial<PeerCoordinatorWithCreate> | undefined);
    if (coordinator === undefined) return undefined;
    try {
      const candidate = coordinator.ownerCreate;
      if (candidate === undefined || typeof candidate.createSession !== "function") return undefined;
      return candidate;
    } catch {
      return undefined;
    }
  }

  /**
   * The form PANE the New form would occupy right now, or `undefined` when that
   * pane is not drawn at all (hidden sidebar, a covering dialog, or focus away
   * from the form). It is the layout's form rect on a wide layout and the
   * overlay rect on a narrow one — never the outer terminal size.
   */
  function currentCreateFormPane(
    terminalCols: number,
    terminalRows: number,
  ): { readonly cols: number; readonly rows: number } | undefined {
    const currentLayout = currentHostLayout(terminalCols, terminalRows);
    const rect = currentLayout.form
      ?? (currentLayout.sidebarOverlay ? currentLayout.sidebar : undefined);
    return rect === undefined ? undefined : { cols: rect.cols, rows: rect.rows };
  }

  /** True only while this exact drawn New-form frame is still the current one. */
  function isCurrentCreateFormFrame(frame: CreateFormFrame): boolean {
    if (shutdownRequested || externalEditorActive || terminal === undefined || !terminalStarted) return false;
    const activeSidebar = sidebar;
    if (activeSidebar === undefined || !activeSidebar.visible) return false;
    if (activeSidebar.focus !== "form") return false;
    if (clampDimension(terminal.columns, 80) !== frame.terminalCols
      || clampDimension(terminal.rows, 24) !== frame.terminalRows) return false;
    // A pre-reflow frame never authorizes anything until a replacement frame in
    // the current epoch is actually written, even when the terminal returned to
    // the same dimensions before anything was repainted.
    if (frame.epoch !== createFormEpoch) return false;
    // The pane must be drawn now, at the same pane rectangle it was drawn at.
    const pane = currentCreateFormPane(frame.terminalCols, frame.terminalRows);
    if (pane === undefined) return false;
    if (pane.cols !== frame.cols || pane.rows !== frame.rows) return false;
    return activeSidebar.isCreateFormRenderCurrent(frame.renderToken);
  }

  /** The fixed notice for one settled owner/not-sent Create result. */
  function createOnPeerResultNotice(result: PeerCreateResult): string {
    if (result.kind === "owner-result") {
      const facts: OwnerCreateFacts | undefined = isOwnerCreateFacts(result.facts) ? result.facts : undefined;
      if (facts === undefined) return CREATE_ON_PEER_UNKNOWN_MESSAGE;
      switch (facts.kind) {
        case "started":
          // Handled by the caller; a started fact without an exact run never
          // reaches this notice.
          return CREATE_ON_PEER_OTHER_RUN_NOTICE;
        case "unconfirmed":
          return CREATE_ON_PEER_UNCONFIRMED_MESSAGE;
        case "refused":
          return CREATE_ON_PEER_REFUSED_MESSAGE;
        case "unknown":
          return CREATE_ON_PEER_UNKNOWN_MESSAGE;
      }
    }
    if (result.kind === "not-sent") {
      switch (result.reason) {
        case "capability-unsupported":
          return CREATE_ON_PEER_UNSUPPORTED_MESSAGE;
        case "not-ready":
        case "target-unavailable":
          return CREATE_ON_PEER_GONE_MESSAGE;
        case "invalid-request":
          return CREATE_ON_PEER_FORM_CHANGED_MESSAGE;
        case "busy":
        case "limit":
          return CREATE_ON_PEER_BUSY_MESSAGE;
      }
    }
    return CREATE_ON_PEER_UNKNOWN_MESSAGE;
  }

  /**
   * Record one settled requester-side Create result. The owner's own roster
   * projection is the only thing that can list the new remote row, so nothing
   * local is created, selected, activated, or focused here: an exact `started`
   * fact hands the sidebar the returned run and row (which emits the ordinary
   * remote display selection only while that exact request still owns the form),
   * and every other fact is a bounded notice on the same request.
   */
  function applyCreateOnPeerResult(attempt: CreateOnPeerAttempt, result: PeerCreateResult): void {
    const activeSidebar = sidebar;
    if (activeSidebar === undefined) return;
    const facts = result.kind === "owner-result" && isOwnerCreateFacts(result.facts)
      ? result.facts
      : undefined;
    if (facts !== undefined && facts.kind === "started") {
      // This side's own last-instant ownership proof, re-evaluated at the reply:
      // a request this host already retired (a destination run/connection/identity
      // transition, a newer form, or a dismissal) never selects anything and never
      // installs an awaiting fact — whatever the owner did with the bytes.
      if (!activeSidebar.createOnPeerStillCurrent(attempt)) return;
      // The `started` reply can legitimately arrive before this side's own roster
      // observation of the new row, and an ALREADY observed row must never later be
      // described as awaiting its first observation. Record the exact row only for
      // the submitted run and only while it is genuinely unobserved.
      const rowObserved = peerUiSnapshot?.hosts?.some((host) =>
        host.id === attempt.hostId
        && (host.roster.hostRunId ?? null) === facts.hostRunId
        && host.roster.rows?.some((row) => row.id === facts.rowId) === true) === true;
      pendingCreatedRemote = facts.hostRunId === attempt.hostRunId && !rowObserved
        ? { hostId: attempt.hostId, hostRunId: facts.hostRunId, rowId: facts.rowId }
        : undefined;
      activeSidebar.completeCreateOnPeer(attempt.requestId, {
        hostRunId: facts.hostRunId,
        rowId: facts.rowId,
      });
      return;
    }
    activeSidebar.failCreateOnPeer(attempt.requestId, createOnPeerResultNotice(result));
  }

  /**
   * Submit ONE frozen remote New attempt to the coordinator's existing Create
   * controller. Nothing is retried, replayed, cancelled, or retargeted: the
   * caller's `stillCurrent` proof is handed to the backend so it is evaluated
   * again inside the ordered write that actually calls the transport, and a
   * throw after that handoff is an unknown outcome rather than a not-sent claim.
   */
  function startCreateOnPeer(
    attempt: CreateOnPeerAttempt,
    controller: PeerCreateController,
  ): void {
    createOnPeerAttempt = attempt;
    const stillCurrent = (): boolean => {
      if (shutdownRequested || externalEditorActive) return false;
      if (createOnPeerAttempt !== attempt) return false;
      const activeSidebar = sidebar;
      if (activeSidebar === undefined || terminal === undefined) return false;
      if (clampDimension(terminal.columns, 80) !== attempt.terminalCols
        || clampDimension(terminal.rows, 24) !== attempt.terminalRows) return false;
      // The geometry epoch, not the dimensions alone: a resize that returned to
      // the submitted size before anything was repainted retires this attempt.
      if (attempt.epoch !== createFormEpoch) return false;
      const pane = currentCreateFormPane(attempt.terminalCols, attempt.terminalRows);
      if (pane === undefined || pane.cols !== attempt.paneCols || pane.rows !== attempt.paneRows) return false;
      return activeSidebar.createOnPeerStillCurrent({
        requestId: attempt.requestId,
        formGeneration: attempt.formGeneration,
        hostId: attempt.hostId,
        hostRunId: attempt.hostRunId,
        workspace: attempt.workspace,
      });
    };
    void (async () => {
      let result: PeerCreateResult;
      try {
        result = await controller.createSession({
          hostId: attempt.hostId,
          hostRunId: attempt.hostRunId,
          workspace: attempt.workspace,
        }, { stillCurrent });
        if (typeof result !== "object" || result === null
          || (result.kind !== "owner-result" && result.kind !== "not-sent" && result.kind !== "unknown")) {
          result = { kind: "unknown" };
        }
      } catch {
        result = { kind: "unknown" };
      }
      if (createOnPeerAttempt === attempt) createOnPeerAttempt = undefined;
      if (shutdownRequested) return;
      applyCreateOnPeerResult(attempt, result);
      reconcileLayout(true);
      scheduleRedraw();
    })();
  }

  /**
   * One deliberate remote New submission. The sidebar's action DTO carries the
   * host, the exact owner run, the canonical workspace, the form generation, and
   * the drawn-frame token it captured; this side proves that exact frame was the
   * one the writer actually committed, and then freezes it. Nothing is re-derived
   * from a later list, index, label, or selection, and a local `create` takes the
   * completely unchanged path above.
   */
  function launchCreateOnPeer(action: Extract<SidebarAction, { type: "create-on-peer" }>): void {
    const activeSidebar = sidebar;
    if (activeSidebar === undefined || shutdownRequested || terminal === undefined) return;
    const frame = createFormFrame;
    if (frame === undefined || !frame.settled
      || frame.renderToken !== action.renderToken
      || frame.formGeneration !== action.formGeneration
      || frame.hostKind !== "remote"
      || frame.hostId !== action.hostId
      || frame.hostRunId !== action.hostRunId
      || frame.workspace !== action.workspace
      || !isCurrentCreateFormFrame(frame)) {
      // A forged, stale, superseded, resized, queued, held, or unwritten DTO can
      // never send anything: the exact written form is the only authority.
      activeSidebar.failCreateOnPeer(action.requestId, CREATE_ON_PEER_UNWRITTEN_NOTICE);
      reconcileLayout(true);
      scheduleRedraw();
      return;
    }
    // Consume the one-shot receipt BEFORE dispatch so this same submission can
    // never be sent twice, while a duplicate that arrives later has no current
    // frame to match.
    createFormFrame = undefined;
    if (createOnPeerAttempt !== undefined) {
      activeSidebar.failCreateOnPeer(action.requestId, CREATE_ON_PEER_BUSY_MESSAGE);
      reconcileLayout(true);
      scheduleRedraw();
      return;
    }
    const controller = ownerCreateController();
    if (controller === undefined) {
      activeSidebar.failCreateOnPeer(action.requestId, CREATE_ON_PEER_UNSUPPORTED_MESSAGE);
      reconcileLayout(true);
      scheduleRedraw();
      return;
    }
    startCreateOnPeer({
      requestId: action.requestId,
      hostId: action.hostId,
      hostRunId: action.hostRunId,
      workspace: action.workspace,
      formGeneration: action.formGeneration,
      renderToken: action.renderToken,
      terminalCols: frame.terminalCols,
      terminalRows: frame.terminalRows,
      paneCols: frame.cols,
      paneRows: frame.rows,
      epoch: frame.epoch,
    }, controller);
  }

  function handleSidebarAction(action: SidebarAction): void {
    if (shutdownRequested) return;
    // Any deliberate user action invalidates a pending automatic activation.
    deliberateActionGeneration += 1;
    switch (action.type) {
      case "peer-open":
        sidebar?.openPeerMenu();
        reconcileLayout(true);
        scheduleRedraw();
        return;
      case "peer-consent": {
        if (!hasWrittenPeerConsentFrame(action.consentId, action.renderToken, action.decision)) {
          sidebar?.showError("Pairing confirmation changed or is not yet displayed; review it again");
          scheduleRedraw();
          return;
        }
        let confirmed = false;
        try { confirmed = peerCoordinator?.decideConsent(action.consentId, action.decision) === true; } catch { /* fixed UI status below */ }
        if (!confirmed) {
          sidebar?.showError("The pairing decision was not confirmed; check the host status");
          scheduleRedraw();
        }
        return;
      }
      case "peer-listener":
      case "peer-auto-reconnect":
      case "peer-bell":
      case "peer-add":
      case "peer-connect":
      case "peer-disconnect":
      case "peer-remove":
      case "peer-revoke":
        performPeerCommand(action);
        return;
      case "forward":
        routeForward(action.data);
        return;
      case "select": {
        // This action is emitted only by an explicit roster activation. A
        // remembered-but-unavailable entry has no process to own, so it never
        // becomes the input owner; the refusal is surfaced instead.
        const unavailableSlot = slotIdFromRosterErrorItemId(action.id);
        if (unavailableSlot !== undefined) {
          sidebar?.showError(ROSTER_UNAVAILABLE_MESSAGE);
          scheduleRedraw();
          return;
        }
        // Metadata-only remote rows and stale/malformed UI targets never become
        // a local input owner. The sidebar's local/remote kinds stay separate;
        // this independently refuses a target absent from the local inventory.
        if (!views.some((view) => view.id === action.id) || removedExitedIds.has(action.id)) {
          sidebar?.showError("That local session is no longer available");
          scheduleRedraw();
          return;
        }
        contentTarget = { kind: "local", id: action.id };
        contentSelectionGeneration += 1;
        rememberedActiveSlot = rowSlots.get(action.id);
        // A local (or passive) selection releases the single global remote
        // stream: the one content controller is told nothing is selected, the
        // accepted remote frame and its status are dropped, and the ordinary
        // local view resumes. No remote row is stopped, retried, or notified.
        clearRemoteContentSelection();
        // Selecting is how a session starts being displayed and sized by this
        // terminal; the manager recomputes only this row's geometry (#474).
        localViewerDirty = true;
        syncRosterAndSchedule();
        reconcileLayout(true);
        return;
      }
      case "remote-close-request":
        // A deliberate d/Delete on a remote card. Nothing is sent until this
        // side's own written-highlight gate, the local preflight, and (when the
        // owner row is busy or unknown) a written confirmation all agree.
        requestRemoteClose(action);
        return;
      case "remote-close-confirmed":
        // The one deliberate confirmation of a written dialog frame. It is
        // rechecked and consumed synchronously, before any await.
        confirmRemoteClose(action);
        return;
      case "select-remote": {
        // An ordinary Enter/left press on one projected remote roster card. It
        // selects only the DISPLAYED source: never a local select, resume,
        // create, stop, remove, rename, quit, consent, connect, or trust change.
        selectRemoteContent(action.hostId, action.hostRunId, action.rowId);
        return;
      }
      case "detach-view": {
        // Explicit "display nothing" (#474): this sidebar stops displaying,
        // feeding, and sizing one session. Owned processes and their work,
        // status, the roster's remembered entries, saved conversations, and this
        // host's lifetime are untouched; no child (local or remote) is stopped,
        // closed, or replaced, and a later Enter on a row displays it again.
        if (contentTarget === undefined) {
          sidebar?.showError(NO_LOCAL_VIEW_MESSAGE);
          scheduleRedraw();
          return;
        }
        const detachingRemote = contentTarget.kind === "remote";
        contentTarget = undefined;
        contentSelectionGeneration += 1;
        if (detachingRemote) {
          // Releasing a remote display never rewrites the local roster's
          // remembered active entry.
          clearRemoteContentSelection();
        } else {
          rememberedActiveSlot = undefined;
        }
        localViewerDirty = true;
        syncRosterAndSchedule();
        reconcileLayout(true);
        sidebar?.showError(LOCAL_VIEW_DETACHED_MESSAGE);
        scheduleRedraw();
        return;
      }
      case "create":
        if (negotiationReady) launchCreate(action);
        else deferredCreates.set(action.requestId, action);
        reconcileLayout(true);
        scheduleRedraw();
        return;
      case "create-on-peer":
        // A deliberate REMOTE New submission. It is never folded into the local
        // `create` path: this side proves the exact written form first, and the
        // owner host performs the one create in its own run.
        launchCreateOnPeer(action);
        reconcileLayout(true);
        scheduleRedraw();
        return;
      case "edit": {
        if (!sidebar) return;
        const row = views.find((candidate) => candidate.id === action.id);
        const observed = row?.nativeSession;
        if (!observed || observed.sessionId !== action.nativeSession.sessionId
          || observed.epoch !== action.nativeSession.epoch) {
          sidebar.showError("Session name changed or is unavailable; reopen Edit from the current row");
          scheduleRedraw();
          return;
        }
        const opened = sidebar.openEdit({
          id: row.id,
          nativeSession: action.nativeSession,
          currentName: observed.name,
        });
        if (!opened) sidebar.showError("Session name could not be edited while this row is changing");
        reconcileLayout(true);
        scheduleRedraw();
        return;
      }
      case "rename": {
        if (!manager || !sidebar) return;
        const request = {
          expectedSessionId: action.expectedSessionId,
          expectedSessionEpoch: action.expectedSessionEpoch,
          name: action.name,
        };
        void manager.rename(action.id, request).then(
          (result) => {
            if (shutdownRequested || !sidebar) return;
            sidebar.completeRename(action.requestId, result.status);
            syncRosterAndSchedule();
            reconcileLayout(true);
          },
          () => {
            if (shutdownRequested || !sidebar) return;
            sidebar.failRename(action.requestId, "Pi could not set or verify the new session name; the active session was not changed");
            scheduleRedraw();
          },
        );
        return;
      }
      case "remove": {
        const unavailableSlot = slotIdFromRosterErrorItemId(action.id);
        if (unavailableSlot !== undefined) {
          removeRosterEntry(unavailableSlot);
          return;
        }
        removeExitedRow(action.id);
        return;
      }
      case "resume-row":
        if (negotiationReady) launchRowResume(action.requestId, action.id);
        else deferredRowResumes.set(action.requestId, { requestId: action.requestId, id: action.id });
        scheduleRedraw();
        return;
      case "resume-row-cancel": {
        deferredRowResumes.delete(action.requestId);
        const pending = rowResumeRequests.get(action.requestId);
        if (pending === undefined) return;
        rowResumeRequests.delete(action.requestId);
        try { pending.controller.abort(); } catch { /* abort is best-effort */ }
        const record = rowResumeTasks.get(pending.oldId);
        if (record !== undefined && record.controller === pending.controller && !record.spawned) {
          // Pre-spawn cancellation releases the duplicate fence so a later
          // deliberate retry can start; an already-started child is never canceled.
          rowResumeTasks.delete(pending.oldId);
        }
        return;
      }
      case "stop-remove":
        launchRowStop(action.id, action.confirmed);
        return;
      case "saved-list": {
        if (!sidebar || sidebar.savedPickerRequestId !== action.requestId) return;
        startSavedCatalogList(action.requestId, action.requestId);
        reconcileLayout(true);
        scheduleRedraw();
        return;
      }
      case "saved-refresh":
        if (!sidebar || sidebar.savedPickerRequestId !== action.pickerId) return;
        startSavedCatalogList(action.requestId, action.pickerId);
        scheduleRedraw();
        return;
      case "saved-search": {
        const activeSidebar = sidebar;
        const catalog = savedCatalog;
        if (!activeSidebar || activeSidebar.savedPickerRequestId !== action.pickerId
          || action.revision !== activeSidebar.savedQueryRevisionNumber
          || action.query !== activeSidebar.savedQuery
          || !isSavedSessionCatalog(catalog) || savedCatalogPickerId !== action.pickerId
          || savedCatalogRequestId === undefined) return;
        invalidateSavedDeleteConfirmationDisplay();
        const filtered = searchSavedSessions(catalog, action.query);
        invalidateMouseAuthorization();
        activeSidebar.completeSavedSearch(
          action.pickerId,
          action.revision,
          filtered.map((row) => ({ id: row.id, file: row.file, caption: row.caption, cwd: row.cwd })),
        );
        scheduleRedraw();
        return;
      }
      case "saved-dismiss": {
        if (sidebar?.savedPickerRequestId !== action.pickerId) return;
        invalidateSavedDeleteConfirmationDisplay();
        if (savedCatalogPickerId === action.pickerId) {
          savedCatalog = undefined;
          savedCatalogPickerId = undefined;
          savedCatalogRequestId = undefined;
        }
        for (const [requestId, controller] of savedListControllers) {
          try { controller.abort(); } catch { /* exact picker listings are best-effort canceled */ }
          savedListControllers.delete(requestId);
        }
        invalidateMouseAuthorization();
        return;
      }
      case "saved-delete-prepare": {
        invalidateSavedDeleteConfirmationDisplay();
        invalidateMouseAuthorization();
        const activeSidebar = sidebar;
        const owner = manager;
        const catalog = savedCatalog;
        let allowed = false;
        let message = "The saved conversation is no longer available; reopen the picker";
        const currentRequest = activeSidebar?.isSavedDeletePreparationCurrent(
          action.requestId, action.pickerId, action.id, action.file, action.revision,
        ) === true && activeSidebar?.savedPickerRequestId === action.pickerId;
        if (activeSidebar && currentRequest) {
          if (owner && isSavedSessionCatalog(catalog) && savedCatalogPickerId === action.pickerId
            && savedCatalogRequestId !== undefined) {
            const row = catalog.rows.find((candidate) => candidate.id === action.id && candidate.file === action.file);
            if (row !== undefined && searchSavedSessions(catalog, activeSidebar.savedQuery).includes(row)) {
              const refusal = hostService.validateSavedConversationDeletion(catalog, row);
              if (refusal === undefined) {
                allowed = true;
                message = "";
              } else {
                message = savedDeletionRefusalNotice(refusal);
              }
            }
          }
          activeSidebar.completeSavedDeleteCheck(action.requestId, allowed, message);
        }
        scheduleRedraw();
        return;
      }
      case "saved-delete": {
        const activeSidebar = sidebar;
        const owner = manager;
        const catalog = savedCatalog;
        if (!activeSidebar || !owner || !activeSidebar.isSavedDeleteConfirmationCurrent(
          action.requestId, action.pickerId, action.id, action.file, action.revision,
        ) || !hasSettledSavedDeleteConfirmationFrame()) return;
        if (!isSavedSessionCatalog(catalog) || savedCatalogPickerId !== action.pickerId
          || savedCatalogRequestId === undefined) {
          activeSidebar.completeSavedDelete(action.requestId, "The saved list changed; no file was deleted", false);
          scheduleRedraw();
          return;
        }
        const row = catalog.rows.find((candidate) => candidate.id === action.id && candidate.file === action.file);
        if (row === undefined || !searchSavedSessions(catalog, activeSidebar.savedQuery).includes(row)) {
          activeSidebar.completeSavedDelete(action.requestId, "The selected saved conversation is no longer in this query; no file was deleted", false);
          scheduleRedraw();
          return;
        }
        const expectedCatalogRequestId = savedCatalogRequestId;
        const validate = (): string | undefined => {
          if (shutdownRequested || manager !== owner || sidebar !== activeSidebar
            || activeSidebar.savedPickerRequestId !== action.pickerId
            || !activeSidebar.isSavedDeleteConfirmationCurrent(
              action.requestId, action.pickerId, action.id, action.file, action.revision,
            ) || !hasSettledSavedDeleteConfirmationFrame()
            || savedCatalog !== catalog || savedCatalogPickerId !== action.pickerId
            || savedCatalogRequestId !== expectedCatalogRequestId
            || !searchSavedSessions(catalog, activeSidebar.savedQuery).includes(row)) {
            return "stale-catalog";
          }
          return hostService.validateSavedConversationDeletion(catalog, row);
        };
        let result: SavedSessionDeletionResult;
        try {
          result = dependencies.deleteSavedFile(row.file, { validate });
        } catch {
          result = { ok: false, method: "unlink", error: "saved conversation could not be deleted" };
        }
        const message = result.ok
          ? result.method === "trash" ? "Saved conversation moved to trash" : "Saved conversation permanently deleted"
          : savedDeletionFailureMessage(result);
        activeSidebar.completeSavedDelete(action.requestId, message, result.ok);
        scheduleRedraw();
        return;
      }
      case "saved-cancel": {
        const controller = savedListControllers.get(action.requestId);
        if (controller !== undefined) {
          savedListControllers.delete(action.requestId);
          try {
            controller.abort();
          } catch { /* abort is best-effort */ }
        }
        return;
      }
      case "host-shortcuts-save": {
        if (!sidebar) return;
        if (hostShortcutAgentDir === undefined) {
          sidebar.failHostShortcutSave(action.requestId, "The native Pi agent directory is unavailable; settings were not saved");
          scheduleRedraw();
          return;
        }
        try {
          const proposed = normalizeHostShortcutBindings(action.bindings);
          const effectiveToggle = legacyToggleOverride ? effectiveHostShortcuts.toggle : proposed.toggle;
          assertHostShortcutsDistinct(effectiveToggle, proposed.returnToMain);
          const saved = dependencies.writeHostShortcutConfig(
            hostShortcutAgentDir,
            proposed,
            legacyToggleOverride ? effectiveToggle : undefined,
          );
          const effective = {
            toggle: legacyToggleOverride ? effectiveToggle : saved.toggle,
            returnToMain: saved.returnToMain,
          };
          assertHostShortcutsDistinct(effective.toggle, effective.returnToMain);
          configuredHostShortcuts = saved;
          effectiveHostShortcuts = effective;
          sidebar.completeHostShortcutSave(action.requestId, saved);
          reconcileLayout(true);
          scheduleRedraw();
        } catch (error) {
          sidebar.failHostShortcutSave(action.requestId, error instanceof Error
            ? error.message
            : "Host shortcut settings could not be saved; previous bindings remain active");
          scheduleRedraw();
        }
        return;
      }
      case "saved-open": {
        if (!manager || !sidebar) return;
        if (negotiationReady) launchSavedOpen(action.requestId, action.file, action.sessionId);
        else deferredSavedOpens.set(action.requestId, { file: action.file, sessionId: action.sessionId });
        scheduleRedraw();
        return;
      }
      case "visibility":
        invalidateSavedDeleteConfirmationDisplay();
        reconcileLayout(true);
        syncOuterMouseModes();
        scheduleRedraw();
        return;
      case "terminal-diagnostics-clear":
        // Clears only the warning the user saw; the private log is never
        // deleted, rotated, or reset, and focus/ownership are unchanged.
        if (diagnosticsWarning.clear(action.throughCount, action.failureShown)) publishDiagnosticsWarning();
        else scheduleRedraw();
        return;
      case "quit":
        // SidebarController emits this only after its required confirmation.
        requestShutdown(false);
        return;
    }
  }

  function beginShutdown(): void {
    if (shutdownPromise) return;
    // Reserve teardown before invoking any owned component; shutdown() marks
    // manager admission closed synchronously, before a pending create can
    // advance through its next native-launch checkpoint.
    shutdownPromise = Promise.resolve();
    shutdownRequested = true;
    hostMouseButtons.clear();
    savedCatalog = undefined;
    savedCatalogPickerId = undefined;
    savedCatalogRequestId = undefined;
    invalidateSavedDeleteConfirmationDisplay();
    invalidatePeerConsentDisplay();
    invalidateRemoteCloseConfirmationDisplay();
    // A drawn New form's receipt and Host line map never survive teardown; an
    // already-handed remote create is not cancelled or re-sent here.
    createFormFrame = undefined;
    pendingCreatedRemote = undefined;
    sidebar?.invalidateCreateFormPresentation();
    // Ephemeral per-target reminders never outlive this host run. An in-flight
    // close already handed to the owner is never re-sent or cancelled here.
    remoteCloseMarkers.clear();
    remoteCloseAttempts.clear();
    sidebar?.disposeSavedPicker();
    invalidateMouseAuthorization();
    // Display facts only. The coordinator's own bounded close stays the single
    // resource barrier (no extra Main await), and its content callback is fenced
    // above, so no observation can paint or resurrect anything after teardown.
    remoteContentView = undefined;
    remoteContentStatus = undefined;
    contentStreamRequested = false;
    deferredCreates.clear();
    deferredSavedOpens.clear();
    deferredRowResumes.clear();
    // Abort an in-flight startup roster restoration; nothing it has not already
    // started is spawned, and an already-started child stays owned.
    try { restoreAbort?.abort(); } catch { /* abort is best-effort */ }
    // Abort every outstanding restart listing; a started child is never killed.
    for (const record of rowResumeTasks.values()) {
      try { record.controller.abort(); } catch { /* abort is best-effort */ }
    }
    for (const pending of rowResumeRequests.values()) {
      try { pending.controller.abort(); } catch { /* abort is best-effort */ }
    }
    // Abort every outstanding saved-conversation listing; late completions of
    // an aborted query never contribute to the UI.
    for (const controller of savedListControllers.values()) {
      try {
        controller.abort();
      } catch { /* abort is best-effort */ }
    }
    savedListControllers.clear();
    let peerShutdownTask: Promise<boolean> | undefined;
    if (peerCoordinator) {
      try {
        // Close latches network admission synchronously, independently of the
        // one local manager's child settlement. Neither path stops remote work.
        peerShutdownTask = Promise.resolve(peerCoordinator.close()).then(() => true, () => false);
      } catch {
        cleanupFailure = true;
        peerNetworkSettled = false;
      }
    }
    let shutdownTask: Promise<{ result?: ShutdownResult; failed: boolean }> | undefined;
    if (manager) {
      try {
        shutdownTask = Promise.resolve(manager.shutdown()).then(
          (result) => ({ result, failed: false }),
          () => ({ failed: true }),
        );
      } catch {
        cleanupFailure = true;
      }
    }

    shutdownPromise = Promise.resolve().then(async () => {
      let shutdownResult: ShutdownResult | undefined;

      const editorTask = externalEditorTask;
      if (editorTask) await Promise.allSettled([editorTask]);

      // Stop only mouse modes this host enabled. Unknown pre-existing modes
      // and foreign listeners are never guessed at or reset.
      if (terminalStarted) {
        if (mouseTrackingMode !== undefined) {
          if (writeOwnedMouseSequence(`\x1b[?${mouseTrackingMode}l`)) mouseTrackingMode = undefined;
          else cleanupFailure = true;
        }
        if (mouseSgrEnabled) {
          if (writeOwnedMouseSequence("\x1b[?1006l")) mouseSgrEnabled = false;
          else cleanupFailure = true;
        }
      }

      if (observerListenerAttached && passiveInputListener) {
        try {
          dependencies.stdin.removeListener("data", passiveInputListener);
        } catch {
          cleanupFailure = true;
        }
        observerListenerAttached = false;
      }
      try {
        observer?.dispose();
      } catch {
        cleanupFailure = true;
      }
      if (terminalStartAttempted && terminal && !externalEditorActive) {
        try {
          await terminal.drainInput(INPUT_DRAIN_MAX_MS, INPUT_DRAIN_IDLE_MS);
        } catch {
          cleanupFailure = true;
        }
        try {
          terminal.stop();
        } catch {
          cleanupFailure = true;
        }
        terminalStarted = false;
      }

      try {
        const flushed = await writer?.close();
        if (flushed === false) cleanupFailure = true;
      } catch {
        cleanupFailure = true;
      }

      if (manager) {
        if (shutdownTask) {
          try {
            const outcome = await shutdownTask;
            if (outcome.failed) cleanupFailure = true;
            else if (outcome.result) {
              shutdownResult = outcome.result;
              forcedCount = shutdownResult.forcedIds.length;
              // The manager's own settled shutdown result is positive evidence.
              ownedStateSettled = true;
            }
          } catch {
            // The startup-time rejection handler above keeps this defensive.
            cleanupFailure = true;
          }
        }
        // Native readiness waits are settled before the restart tasks are
        // awaited: shutdown must never hang for the readiness deadline, and a
        // pending replacement child is left owned and untouched.
        settleRowReadinessWaiters("failed");
        await Promise.allSettled([...createTasks, ...savedOpenTasks, ...rowStopTasks.values(), ...rowResumeTaskSet]);
      }

      if (manager) {
        try {
          await manager.dispose();
        } catch {
          cleanupFailure = true;
        }
      }
      if (peerShutdownTask) {
        peerNetworkSettled = await peerShutdownTask;
        if (!peerNetworkSettled) cleanupFailure = true;
      }
      // The one coordinator owns accepted network operations and its bounded
      // close is their settlement barrier. UI/start wrappers already handle
      // rejection and ignore shutdown callbacks; they own no other resources.
      // Never turn an unconfirmed barrier into an unbounded second wait for
      // abandoned work. Retain ownership and report the failed barrier below.
      if (!peerNetworkSettled) {
        safeReport(dependencies, "Network cleanup did not settle; agent-directory ownership is retained.");
      }
      // Owned-child settlement evidence comes from the one authoritative
      // manager through the owning-host service: a query that actually answered
      // is positive evidence, and unknown child state keeps exclusive ownership
      // held fail closed instead of releasing it.
      const settlement = hostService.observeOwnedChildSettlement(shutdownResult?.remainingIds.length);
      remainingCount = settlement.remaining;
      if (settlement.settled) ownedStateSettled = true;
      else cleanupFailure = true;
      // Settled rows' surfaces were disposed above (each flushes its pending
      // diagnostics first). Settle the private log's owned IO before
      // reporting; anything an unsettled child emits after this is not
      // persisted (the log no longer accepts records once closing). Pending
      // host clipboard routing diagnostics are handed over first, the same way.
      clipboardDiagnostics.flushNow();
      clipboardDiagnostics.dispose();
      if (diagnosticsLog) {
        try {
          const closed = await diagnosticsLog.close();
          // An unsettled close or a failed final flush (including a rejected
          // data sync) is a cleanup failure, never reported as success.
          if (!closed.settled || !closed.flushed) cleanupFailure = true;
        } catch {
          cleanupFailure = true;
        }
      }
      if (broker) {
        try {
          await broker.dispose();
        } catch {
          cleanupFailure = true;
        }
      }

      removeOuterListeners();
      let failed = runtimeFailure || cleanupFailure || forcedCount > 0 || remainingCount > 0;
      // Exclusive agent-directory ownership is released only when owned shutdown
      // settled: a positively settled manager result or live-state answer, and no
      // owned process still unconfirmed. Unknown or absent child state (every
      // query unavailable) keeps ownership held (fail closed) so a later host
      // refuses instead of racing children that may still be running.
      if (hostState !== undefined) {
        if (remainingCount === 0 && ownedStateSettled && peerNetworkSettled) {
          let released = false;
          try {
            released = hostState.release();
          } catch {
            released = false;
          }
          if (!released) {
            cleanupFailure = true;
            failed = true;
            safeReport(dependencies, ROSTER_OWNERSHIP_MESSAGE);
          }
        } else {
          safeReport(dependencies, ROSTER_RETAINED_MESSAGE);
        }
      }
      if (failed && !shortcutStartupDiagnosticReported) {
        const details = forcedCount > 0 || remainingCount > 0
          ? `Session host shutdown: ${forcedCount} owned process(es) required forced termination; ${remainingCount} remain unconfirmed.`
          : GENERIC_FAILURE_MESSAGE;
        safeReport(dependencies, details);
      }
      finishRun(failed ? 1 : 0);
    }).catch(() => {
      // A final controller-level guard: no rejected teardown promise escapes.
      cleanupFailure = true;
      removeOuterListeners();
      if (!shortcutStartupDiagnosticReported) safeReport(dependencies, GENERIC_FAILURE_MESSAGE);
      finishRun(1);
    });
  }

  try {
    addOuterListeners();
    if (dependencies.stdin.readableEnded) {
      requestShutdown(false);
      startupComplete = true;
      beginShutdown();
      return await runFinished;
    }

    let probeFailed = false;
    try {
      pi = dependencies.resolvePi({ executable: snapshot.piExecutable, env: snapshot.env });
    } catch {
      probeFailed = true;
    }
    // Let queued external signals run after the synchronous, bounded probe
    // before opening the broker or constructing any interactive resource.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (shutdownRequested) {
      startupComplete = true;
      beginShutdown();
      return await runFinished;
    }
    if (probeFailed || !pi || !pi.file || !pi.version) {
      throw new MainFailure("preflight");
    }

    broker = await dependencies.createBroker(snapshot.stateRoot === undefined
      ? undefined
      : { socketRoot: snapshot.stateRoot });
    if (shutdownRequested) {
      startupComplete = true;
      beginShutdown();
      return await runFinished;
    }

    observer = dependencies.createObserver({
      onChange: (flags) => {
        observedFlags = flags & 7;
        syncOuterMouseModes();
        scheduleRedraw();
      },
    });
    terminal = dependencies.createTerminal();
    const initialCols = clampDimension(terminal.columns, 80);
    const initialRows = clampDimension(terminal.rows, 24);
    sessionSetup = dependencies.createSessionSetup({ env: snapshot.env });
    hostGraphicsEnabled = sessionSetup.nativeSetup && supportsSessionHostKittyGraphics(snapshot.env);
    if (typeof sessionSetup.nativeAgentDir === "string" && sessionSetup.nativeAgentDir !== "") {
      hostShortcutAgentDir = sessionSetup.nativeAgentDir;
      let readResult: HostShortcutConfigReadResult;
      try {
        readResult = dependencies.readHostShortcutConfig(hostShortcutAgentDir);
      } catch {
        throw new HostShortcutStartupFailure(
          "Session host refused: host shortcut settings could not be safely read. Fix or move the file before restarting.",
        );
      }
      if (readResult.status === "unavailable") throw new HostShortcutStartupFailure(readResult.message);
      configuredHostShortcuts = normalizeHostShortcutBindings(readResult.bindings);
    }
    if (typeof sessionSetup.nativeAgentDir === "string" && sessionSetup.nativeAgentDir !== "") {
      // Created lazily on disk: no file exists until a diagnostic is recorded.
      try {
        diagnosticsLog = dependencies.createTerminalDiagnosticsLog({
          agentDir: sessionSetup.nativeAgentDir,
          identity: collectTerminalDiagnosticsIdentity({ packageRoot, piVersion: pi.version }),
          onStatus: (status, failure) => {
            if (diagnosticsWarning.setLogStatus(status, failure)) publishDiagnosticsWarning();
          },
        });
      } catch {
        // Shown with the warning only if a diagnostic actually occurs.
        diagnosticsLog = undefined;
        diagnosticsWarning.setLogStatus("unavailable", "open-failed");
      }
    } else {
      diagnosticsWarning.setLogStatus("unavailable", "agent-dir-unavailable");
    }
    try {
      const effectiveToggle = normalizeHostShortcutKey(
        snapshot.toggleKey ?? configuredHostShortcuts.toggle,
        "toggle",
      );
      const returnToMain = normalizeHostShortcutKey(configuredHostShortcuts.returnToMain, "returnToMain");
      assertHostShortcutsDistinct(effectiveToggle, returnToMain);
      effectiveHostShortcuts = { toggle: effectiveToggle, returnToMain };
    } catch {
      throw new HostShortcutStartupFailure(
        "Session host refused: the effective toggle and return-to-Main shortcuts conflict or are unsupported. Fix the host settings or --sidebar-key value before restarting.",
      );
    }
    // Global roster and single-host ownership (issue 331): acquire exclusive
    // ownership of the canonical Pi agent directory and read the persisted
    // roster BEFORE any roster entry, manager row, or child exists. A host that
    // shares the same agent directory refuses here with an actionable message
    // and starts nothing. Ownership is claimed inside the same per-agent
    // coordination entry that destructive cache cleanup takes (and, for the
    // launcher's coordinated handoff, inside the hold that already protected the
    // prepared selection), so no reclamation can delete this host's runtime while
    // it becomes the owner.
    if (sessionSetup.nativeSetup === true
      && typeof sessionSetup.nativeAgentDir === "string" && sessionSetup.nativeAgentDir !== "") {
      const opened = dependencies.openHostState({ agentDir: sessionSetup.nativeAgentDir, hostId: randomUUID() });
      if (opened.status === "refused") {
        safeReport(dependencies, opened.message);
        runtimeFailure = true;
        shutdownRequested = true;
        startupComplete = true;
        beginShutdown();
        return await runFinished;
      }
      hostState = opened.state;
      initializeRosterRecords(opened.state.roster);
    }
    const activeSessionSetup = sessionSetup;
    const createTextField = (options: SidebarFieldFactoryOptions) => {
      if (!activeSessionSetup.nativeAgentDir) {
        throw new Error("native Pi agent directory is unavailable for session-host fields");
      }
      const keybindings = loadNativeFieldKeybindings(activeSessionSetup.nativeAgentDir);
      const common = {
        initialText: options.initialText,
        keybindings: keybindings.manager,
        actionBindings: {
          clear: "app.clear",
          submit: "tui.input.submit",
          cancel: "app.interrupt",
          externalEditor: "app.editor.external",
        },
        onInvalidate: options.onInvalidate,
        onSubmit: options.onSubmit,
        onCancel: options.onCancel,
        onReject: options.onReject,
        onExternalEditor: startExternalEditor,
      };
      // `plain` is a REMOTE New form's workspace: canonical owner text with the
      // ordinary workspace bound and NO local filesystem completion at all.
      const field = options.kind === "path"
        ? createSessionHostTextField({
          ...common,
          kind: "path",
          workspaceBasePath: snapshot.startupCwd,
        })
        : options.kind === "plain"
          ? createPlainOwnerWorkspaceField({
            ...common,
            workspaceBasePath: snapshot.startupCwd,
          })
          : createSessionHostTextField({ ...common, kind: "name" });
      return {
        field,
        matchesCancel: (data: string) =>
          !keybindings.manager.matches(data, "app.clear")
          && !keybindings.manager.matches(data, "app.editor.external")
          && keybindings.manager.matches(data, "app.interrupt"),
        // Mirror the field's own effective submit resolution: the configured
        // `tui.input.submit` binding when it is defined, otherwise Enter. The
        // submission provenance fence uses this to consume the held key.
        matchesSubmit: (data: string) => {
          try {
            const defined = typeof keybindings.manager.getDefinition === "function"
              ? keybindings.manager.getDefinition("tui.input.submit") !== undefined
              : true;
            return defined
              ? keybindings.manager.matches(data, "tui.input.submit")
              : matchesKey(data, "enter");
          } catch {
            return matchesKey(data, "enter");
          }
        },
        ...(keybindings.notice ? { notice: keybindings.notice } : {}),
        hints: {
          submit: nativeKeyHint(keybindings.manager, "tui.input.submit", "enter", ["app.clear", "app.editor.external", "app.interrupt"]),
          cancel: nativeKeyHint(keybindings.manager, "app.interrupt", "esc", ["app.clear", "app.editor.external"]),
          complete: nativeKeyHint(keybindings.manager, "tui.input.tab", "tab", ["app.clear", "app.editor.external", "app.interrupt", "tui.input.submit"]),
          clear: nativeKeyHint(keybindings.manager, "app.clear", "ctrl+c"),
          externalEditor: nativeKeyHint(keybindings.manager, "app.editor.external", "ctrl+g", ["app.clear"]),
        },
      };
    };
    sidebar = dependencies.createSidebar({
      toggleKey: effectiveHostShortcuts.toggle,
      returnToMainKey: effectiveHostShortcuts.returnToMain,
      configuredShortcuts: configuredHostShortcuts,
      legacyToggleOverride,
      settingsAvailable: hostShortcutAgentDir !== undefined,
      workspaceBasePath: snapshot.startupCwd,
      createTextField,
      createSavedQueryInput: () => {
        if (!activeSessionSetup.nativeAgentDir) throw new Error("native Pi agent directory is unavailable");
        return createNativeSavedQueryInput(activeSessionSetup.nativeAgentDir);
      },
      initialVisible: true,
      onAction: handleSidebarAction,
      onInvalidate: () => {
        invalidateSavedDeleteConfirmationDisplay();
        invalidateRemoteCloseConfirmationDisplay();
        scheduleRedraw();
      },
    });
    layout = currentHostLayout(initialCols, initialRows);
    lastNativeCols = layout.native.cols;
    lastNativeRows = layout.native.rows;

    manager = hostService.openManager({
      packageRoot,
      piExecutable: pi.file,
      statusRegistrar: statusRegistrar(broker),
      nativeSetup: sessionSetup.nativeSetup,
      profileRegistry: sessionSetup.profileRegistry,
      args: snapshot.args,
      env: snapshot.env,
      cols: layout.native.cols,
      rows: layout.native.rows,
      getSupportedKeyboardFlags: () => terminal?.kittyProtocolActive ? observedFlags & 7 : 0,
      onChange: (id) => noteManagerChanged(id),
      onTerminalDiagnostic: (id, event) => handleTerminalDiagnostic(id, event),
      onNativeClipboard: routeNativeClipboard,
      // Authenticated background child requests are admitted by the owning-host
      // service. This path never completes a sidebar form and never activates
      // the created row; manager onChange only refreshes the roster.
      onSpawnRequest: (parentInstanceId, request) => hostService.spawnRequestedChild(parentInstanceId, request),
      getSidebarTitleColumns: sidebarTitleColumnsSnapshot,
      // Explicit internal opt-in only; the legacy manager call shape (and every
      // existing child it creates) is unchanged when the option is absent.
      ...(remoteNativeInputEnabled ? { nativeInputOriginFraming: true } : {}),
    });
    writer = createFrameWriter();

    passiveInputListener = (data): void => {
      if (!externalEditorActive) observer?.feed(data);
    };
    dependencies.stdin.on("data", passiveInputListener);
    observerListenerAttached = true;
    if (shutdownRequested) {
      startupComplete = true;
      beginShutdown();
      return await runFinished;
    }

    writer.start();
    if (shutdownRequested) {
      startupComplete = true;
      beginShutdown();
      return await runFinished;
    }
    terminalStartAttempted = true;
    terminal.start(handleTerminalInput, handleTerminalResize);
    terminalStarted = true;
    syncRosterAndSchedule();
    reconcileLayout(false);
    startupComplete = true;
    if (!shutdownRequested) startPeerNetworking();
    if (shutdownRequested) beginShutdown();
    else {
      await observer.wait();
      observedFlags = observer.flags & 7;
      // Restore the globally persisted roster before any deliberate user action
      // is admitted: restored rows keep their remembered order and the
      // remembered active entry is applied only while no later deliberate
      // activation exists.
      if (!shutdownRequested) await restorePersistedRoster();
      negotiationReady = true;
      if (!shutdownRequested) {
        for (const action of deferredCreates.values()) launchCreate(action);
        deferredCreates.clear();
        for (const [requestId, pending] of deferredSavedOpens) {
          launchSavedOpen(requestId, pending.file, pending.sessionId);
        }
        deferredSavedOpens.clear();
        for (const deferred of deferredRowResumes.values()) {
          launchRowResume(deferred.requestId, deferred.id);
        }
        deferredRowResumes.clear();
        syncOuterMouseModes();
        scheduleRedraw();
      }
    }
  } catch (error) {
    if (error instanceof HostShortcutStartupFailure) {
      shortcutStartupDiagnosticReported = true;
      safeReport(dependencies, error.message);
    }
    runtimeFailure = true;
    shutdownRequested = true;
    startupComplete = true;
    beginShutdown();
  }

  if (shutdownRequested && !shutdownPromise) beginShutdown();
  return runFinished;
}

/** Internal-only injection seam for focused controller tests; not an option on the public API or CLI. */
export const __test = Object.freeze({
  /** Production broker-to-manager adapter, exposed only for wiring regressions. */
  statusRegistrar,
  /** Exact production deletion-ownership snapshot wrapper, for wiring regressions. */
  savedDeletionOwnedSessions,
  /** Exact production deletion preflight, including owned binding data. */
  validateOwnedSavedSessionDeletion,
  /** Exact production manager-view to sidebar-item mapping, for wiring regressions. */
  toSidebarItem,
  /** Pure readiness decision exposed for source regressions (no runtime effect). */
  rowResumeReadiness: (
    view: NativeInstanceView | undefined,
    expectedSessionId: string | undefined,
  ): "ready" | "pending" | "failed" => rowResumeReadiness(view, expectedSessionId),
  runWithDependencies(options: SessionHostOptions, overrides: Partial<MainDependencies>): Promise<number> {
    let snapshot: HostSnapshot;
    try {
      snapshot = snapshotOptions(options);
    } catch {
      return Promise.resolve(1);
    }
    return runSessionHostController(snapshot, { ...productionDependencies(), ...overrides });
  },
});
