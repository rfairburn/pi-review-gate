import { Buffer } from "node:buffer";
import { spawnSync as nodeSpawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync, unlinkSync } from "node:fs";
import { lstat as lstatAsync, realpath as realpathAsync } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import type { IPty } from "@lydell/node-pty";

import { NativeAgentRegistry, PreparedProfile, ProfilePreparer, resolveWorkspaceDirectory } from "./profiles";
import {
  NODE_OPTIONS_RESTORE_ENV,
  SESSION_HOST_BOOTSTRAP_ENV,
  NativeLaunchDescriptor,
  composeFreshSessionSpawnArgs,
  prepareNativeLaunch,
} from "./launch";
import {
  isNativeCliBackend,
  isNativeCliTargetId,
  isNativeDisplayName,
  resolveSessionBackend,
  sessionBackendDisplayLabel,
  type NativeCliBackend,
  type SessionBackend,
} from "./session-backend";
import { createTerminalGraphicsBudget, type TerminalGraphicsBudget } from "./kitty-graphics";
import { TerminalSurface, type TerminalInputModes } from "./terminal-surface";
import type { TerminalDiagnosticEvent } from "./terminal-diagnostics";
import { createNativeClipboardReceiver, isNativeCliCopyEncoded, type NativeClipboardEvent, type NativeClipboardOriginEvent } from "./native-clipboard";
import {
	isNativeCategoryUnsupported,
	mergeNativeStatusSupport,
	nativeStatusAccepted,
	nativeStatusRejected,
	readNativeStatusObservation,
	readNativeStatusSupport,
	type NativeStatusObservation,
	type NativeStatusSubmitResult,
	type NativeStatusSupportMap,
} from "./native-status";
import {
	createNativeInputEncoder,
	mintNativeViewerScopeToken,
	mintNativeViewerStartupScopeToken,
	mintNativeViewerNativeCliScopeToken,
	parseNativeViewerScopeToken,
	verifyNativeViewerScopeToken,
	verifyNativeViewerNativeCliScopeToken,
	NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES,
	type NativeInputEncoder,
	type NativeInputExpectedFence,
	type NativeInputOrigin,
	type NativeViewerScopeFacts,
	type NativeViewerStartupScopeFacts,
	type NativeViewerNativeCliScopeFacts,
} from "./native-input-origin";
import {
	hasCompleteSessionIdle,
	MAX_SESSION_SPAWN_TITLE_BYTES,
	isValidNativeSessionId,
	isValidNativeDisplayName,
	isValidNativeSessionFile,
	isValidRenameName,
	parseSessionHostsSnapshot,
	type SessionHostNativeSession,
	type SessionHostsInspection,
	type SessionHostsSnapshot,
	type SessionSpawnInput,
	type SessionSpawnOutcome,
} from "./protocol";
import {
	admitSavedSession,
	isSavedSessionAdmission,
	isSavedSessionCatalog,
	validateSavedSessionDeletion,
	type OwnedLiveSession,
	type SavedSessionAdmission,
	type SavedSessionAdmissionResult,
	type SavedSessionCatalog,
	type SavedSessionDeletionRefusalReason,
	type SavedSessionRefusalReason,
	type SavedSessionRow,
} from "./saved-sessions";
import { deleteSavedSessionFile, type SavedSessionDeletionResult } from "./saved-deletion";
import {
	captureOwnedConptyReader,
	ownedConptyReaderRecord,
	type OwnedConptyReaderSettlement,
} from "./windows-conpty-reader";
import type {
	NativeHookRegistration,
	NativeHookSourceHandlers,
	NativeMcpRegistration,
	SessionHostsRequestContext,
	StatusActivityRefreshResult,
	StatusRenameRequest,
	StatusRenameResult,
	StatusShutdownResult,
} from "./broker";
import type {
	NativeHookArtifactLease,
	NativeHookLaunchOutcome,
} from "./native-hook-launch-prep";
import type {
	NativeHookBootstrap,
	NativeHookEvent,
	NativeHookFailure,
} from "./native-hook-protocol";
import {
	NATIVE_CLI_DEFAULT_TARGET_IDS,
	NATIVE_CODEX_OWNED_PROFILE_UNSUPPORTED_CODE,
	type NativeCliNativeMcpOption,
	type NativeCodexOwnedLaunchPlan,
} from "./native-cli-launch";
import {
	isValidNativeMcpServerName,
	type NativeMcpArtifactLease,
	type NativeMcpLaunchOutcome,
} from "./native-mcp-launch-prep";
import { encodeNativeMcpServerFrame, parseNativeMcpBootstrap } from "./native-mcp-protocol";
import {
	CLAUDE_INBOX_SUPPORTED_CLI_VERSIONS,
	CLAUDE_INBOX_SUPPORTED_PLATFORMS,
	createClaudeInboxSendCapability,
	type ClaudeInboxEndpointIdentity,
	type ClaudeInboxSendCapability,
} from "./native-claude-inbox-delivery";
import { readClaudeInboxAnnouncement, type ClaudeInboxAnnouncementCandidate } from "./native-claude-inbox-announcement";
import type { NativeClaudeInboxCompatibilityOutcome } from "./native-claude-version-probe";
import type { NativeSessionToolScope } from "./native-session-tool-delegate";
import type { SessionHostSpawnCapability } from "./spawn-capability";
import { parseSessionSpawnInput } from "./spawn-tool";
import {
	DEFAULT_NATIVE_MCP_STDIO_LIMITS,
	NATIVE_MCP_MAX_REQUEST_ID_BYTES,
	NATIVE_MCP_MAX_TOOL_NAME_LENGTH,
	isValidNativeMcpToolUseId,
	type NativeMcpCallToolResult,
	type NativeMcpToolDescriptor,
	type NativeMcpToolEndpoint,
} from "./native-mcp-stdio";
import { isNativeConversationId } from "./native-conversation";
import { isNativeCaption, projectNativeCaptionLabel } from "./native-caption";
import { prepareNativeInitialPrompt, type NativeInitialPromptLease } from "./native-initial-prompt";
import type {
	OwnedCodexBackendLaunchIdentity,
	OwnedCodexBackendLease,
	OwnedCodexBackendReady,
	OwnedCodexBackendStatus,
} from "./native-codex-backend";
import type { NativeCodexTuiRootCallbackFactsReader, NativeCodexTuiRootFactsSource } from "./native-codex-tui-root-facts";
import { deliverNativeCodexManagedCallback, type NativeCodexManagedDeliveryResult } from "./native-codex-managed-delivery";
import { readCodexCallbackCompatibilityVersion } from "./native-codex-version-probe";
import type { StagedSessionHostPayload } from "./payload";
import {
	SESSION_HOST_STARTUP_REQUEST_ENV,
	SESSION_HOST_TITLE_COLUMNS_ENV,
	stageSessionHostStartupRequest,
} from "./startup-request";

/**
 * Independent owned-PTY process lifecycle for the optional per-instance
 * custom terminal host (#323 alpha, POSIX and source-level Windows ConPTY path).
 *
 * `InstanceManager` owns the full native lifecycle of one or more independent
 * native Pi session-host processes. By default every row uses one shared
 * native Pi agent directory; only explicit legacy test mode uses private
 * profiles. Each row owns, exclusively:
 *
 * - one explicitly selected workspace (canonical cwd of the child);
 * - one prepared native launch descriptor (`prepareNativeLaunch`) applied
 *   verbatim: file/argv/env/cwd are never rewritten by the manager;
 * - one status registration created BEFORE the child is spawned, whose
 *   JSON bootstrap ({@linkcode SESSION_HOST_BOOTSTRAP_ENV}) is injected only
 *   into a fresh clone of the descriptor env at the actual PTY spawn —
 *   never during setup work and never into the caller's
 *   environment, which is never mutated;
 * - one `InstancePty` (real @lydell/node-pty 1.2.0-beta.15, lazy-loaded only
 *   when the default factory actually spawns; never imported eagerly so a
 *   standalone embed can never load the native addon accidentally);
 * - one `TerminalSurface` parsing that PTY's raw output into sanitized
 *   frames, with the surface's query replies written back ONLY to that
 *   same instance's PTY (no raw child bytes ever escape to a real tty) and
 *   with the surface's queued-bytes/count backpressure pausing and resuming
 *   that same PTY;
 * - one bounded, copied, immutable view row (later SidebarItem shape).
 *
 * Safety semantics (fail closed):
 *
 * - Input is written only to the explicitly addressed instance id whose
 *   child is still known alive. There is no implicit selected-instance
 *   fallback and no input translation, no sidebar focus logic, and no
 *   frontend concerns in this module. Stale callbacks (exit/data/status
 *   events from older, released, or disposed records and registrations) are
 *   guarded per instance and can never affect another row.
 * - Every byte this host writes to a child PTY goes through ONE private
 *   per-record seam used by exactly its two existing sources (local user input
 *   and the surface's terminal query replies). A row whose registration
 *   recorded the closed input-framing mode encodes every such write with that
 *   registration's single encoder (user input `local`, protocol replies `none`)
 *   and refuses ALL of them until that same registration's authenticated
 *   readiness arrives — no raw fallback, no fabricated reply, no queue or
 *   replay, and no framing text typed into a legacy child. Rows without the
 *   mode keep forwarding bytes unchanged. Viewer input travels only through the
 *   strict same-manager viewer seam and stays refused by default: an opaque origin
 *   is a classification, never a grant, and every viewer write is fenced on the
 *   manager's own current row, registration, native tuple, geometry, revision, and
 *   input-mode facts. A viewer copy is returned only to that viewer's own bound
 *   sink, never to the owner's local clipboard route.
 * - Exit and disconnect are truthful: the lifecycle badge is the actual
 *   owned child state, the exit code comes only from the owned exit event,
 *   and `busy`/`pendingInput`/owned-work counts collapse to null on exit or
 *   reporter disconnect (never inferred, never "Idle"/zero), keeping the
 *   retained last frame (queued bytes are flushed before the surface freezes).
 * - Shutdown and dispose are bounded and owned-scoped: request graceful exit
 *   through the active authenticated public status registration when
 *   available; on POSIX, fall back to SIGTERM and escalate with SIGKILL on the
 *   same owned PTY handle only. On Windows, force through that handle's
 *   no-argument kill() API; it is never treated as graceful. There are no
 *   global process scans, arbitrary group kills, or daemon/adopted-descendant
 *   cleanup (remaining handles are reported honestly and are released only
 *   when their own exit event fires).
 *   Setup admission is released only after a known child exit or a
 *   failed spawn before any child exists; a kill that never settles never
 *   frees an admission as if it were safely gone.
 * - Resource ownership is recorded before any spawned-child callback can
 *   fire; parser/spawn/read/resize failures are contained per instance with
 *   a truthful bounded public error, never silently losing ownership and
 *   never stopping siblings.
 * - Diagnostics carry at most bounded, single-line public error text: no
 *   arguments, no config contents, no tokens, and no provider environment
 *   values; the bootstrap token is redacted even if it somehow surfaced in
 *   an upstream message.
 * - The native clipboard capsule route (#466) is per row and strictly fenced:
 *   each row's receiver is created only from that row's own authenticated
 *   registration bootstrap, and a verified event is forwarded to the host only
 *   for the exact current row whose registration, owned live process, and
 *   current native conversation tuple still match. A released registration, an
 *   exited or stopped row, a replaced row, a sibling's capsule, and every
 *   capsule payload itself never reach the host callback, a log, or a frame.
 * - Per-session viewing geometry (issue 474): each row owns its canonical content
 *   geometry, and one or more registered viewers of that row decide it together as
 *   the independent minimum columns and minimum rows across the viewers that
 *   contribute dimensions. A geometry change is always addressed to exactly one
 *   row: siblings and rows nobody is viewing are never resized, a row whose viewer
 *   set becomes empty keeps its last canonical size, and a row never viewed keeps
 *   the initial-sizing rule. Viewer records hold only a viewer's own target and
 *   pane size — never a process, frame, status, or input-lease mirror — and every
 *   viewer's participation in a row ends when that row's child exits, the row is
 *   removed, or the manager is disposed. Viewer ids are never reused and each
 *   accepted change bumps that viewer's revision, so a stale asynchronous writer
 *   can neither resurrect a detached surface nor overwrite a later selection.
 *   Nothing here grants or withholds input: input remains addressed-only and every
 *   existing displayed-owner fence stays where it is.
 *
 * - Per-row backend identity (issue 277 core slice): every row belongs to one
 *   closed backend (src/session-host/session-backend.ts), and an absent backend
 *   means Pi. A native CLI row (Claude or Codex) is an ordinary provider PTY
 *   child: its launch descriptor comes only from the host-injected
 *   {@linkcode InstanceManagerOptions.nativeCliLaunch} provider, it gets NO
 *   status registration, no Pi bootstrap/preload/startup-payload/title
 *   environment, no input framing, and no native clipboard receiver, so every
 *   provider field stays truthfully unknown and only the owned PTY's own exit
 *   settles the row. Its workspace is validated and canonicalized here without
 *   any Pi agent-directory setup. Local input is forwarded raw, exactly as for
 *   a legacy unframed row; the viewer input seam refuses it because that row has
 *   no registration to fence a scope against. A known native CLI row owns no Pi
 *   conversation, so it contributes nothing to the saved-conversation censuses,
 *   while an unknown Pi row keeps refusing exactly as before.
 *
 * - Deliberate saved-conversation creation (issue 323) accepts a branded
 *   SavedSessionAdmission, reserves its session id/exact file synchronously
 *   before any await so concurrent deliberate opens cannot spawn duplicates,
 *   and passes the receipt verbatim to prepareNativeLaunch. The reservation
 *   is released only when creation definitively failed before a child exists
 *   or the exact owned PTY actually exited — never on an acknowledgement,
 *   unknown state, or reporter disconnect. Each row also keeps its
 *   last-observed current native conversation id privately (replaced by a
 *   newer observed binding on native /new or /resume) so duplicate fencing
 *   survives status disconnects; exited and removed rows never block
 *   reopening their saved conversation.
 * - Guarded saved-conversation Resume and Delete ({@linkcode InstanceManager.startSavedSession},
 *   {@linkcode InstanceManager.deleteSavedSession}) put the caller's final authorization
 *   immediately before this manager's OWN facts and the protected invocation: the
 *   caller's guard runs, then — with no await and no foreign callback in between —
 *   the manager's private stop/dispose latches, its private census of current
 *   bindings, exact reservations, and historical ids, and the native saved-session
 *   file/header/identity/workspace checks, then the existing native create path
 *   (Resume) or one trash/unlink stage (Delete). No public, overridable, or injected
 *   listing, ownership read, or validation callback runs after that guard. Once a
 *   protected invocation began its effect is reported truthfully (started, deleted,
 *   or unconfirmed), never as a refusal, and nothing is stopped, cancelled, or rolled
 *   back if the caller's authorization is lost afterwards.
 */

export interface StopInstanceResult {
	readonly status: "exited" | "confirmation-required" | "unavailable" | "unconfirmed";
	/** Owned force escalation was attempted on this row's PTY or its owned backend; never exit proof. */
	readonly forced: boolean;
}

/**
 * The caller's final authorization for one guarded saved-conversation mutation.
 * Only an exact `true` return authorizes; `false`, any other value, or a throw
 * refuses before anything is invoked. It may run more than once for one Delete
 * (immediately before each mutation stage), and the manager re-reads its own
 * current facts after every call, so a guard that changes files or bindings is
 * caught rather than trusted.
 */
export type SavedMutationAuthorization = () => boolean;

/**
 * Why a guarded Resume was refused. Every refusal happens strictly BEFORE the
 * native create path was invoked: no row, reservation, registration, or child
 * exists because of the call. Native reasons are the fixed admission reasons.
 */
export type GuardedSavedResumeRefusalReason =
	| SavedSessionRefusalReason
	/** The caller's final guard returned anything but `true`, or threw. */
	| "not-authorized"
	/** No manager/seam, host teardown, or this manager is stopping or disposed. */
	| "unavailable";

/**
 * Outcome of one guarded Resume. Only `refused` precedes the create invocation;
 * every other status means the native create path WAS invoked and owner work may
 * have started, so none of them may be presented as a refusal:
 *
 * - `started`: the exact created row is launch-settled and not errored/starting.
 * - `not-ready`: create resolved but its row is missing, errored, or still starting.
 * - `failed`: the create invocation threw (no claim that a child exists).
 * - `duplicate`: the create path's own synchronous duplicate fence refused it.
 * - `unknown`: the result cannot be observed (teardown, or an unreadable seam);
 *   a child may exist.
 */
export type GuardedSavedResumeResult =
	| { readonly status: "refused"; readonly reason: GuardedSavedResumeRefusalReason }
	| { readonly status: "started"; readonly id: string }
	| { readonly status: "not-ready" }
	| { readonly status: "failed" }
	| { readonly status: "duplicate" }
	| { readonly status: "unknown" };

/** Why a guarded Delete was refused; always before any trash or unlink invocation. */
export type GuardedSavedDeletionRefusalReason =
	| SavedSessionDeletionRefusalReason
	| "not-authorized"
	| "unavailable";

/**
 * Outcome of one guarded Delete.
 *
 * - `refused`: no trash and no unlink handoff was ever invoked.
 * - `deleted`: native success, reported regardless of any later authorization
 *   loss — trash status zero or a gone file (`method: "trash"`), or a returned
 *   permanent unlink fallback (`method: "unlink"`).
 * - `unconfirmed`: at least one mutation handoff MAY have run but success was not
 *   established. `trashInvoked`/`unlinkInvoked` say exactly which handoffs were
 *   invoked. `fallbackRefusal` is the pre-unlink revalidation refusal (for example
 *   a replaced file or lost authorization after trash): the fallback was then never
 *   invoked, but the trash attempt still was, so this is never a no-op claim.
 * - `unknown`: the boundary itself could not be observed (service seam only).
 */
export type GuardedSavedDeletionResult =
	| { readonly status: "refused"; readonly reason: GuardedSavedDeletionRefusalReason }
	| { readonly status: "deleted"; readonly method: "trash" | "unlink" }
	| {
		readonly status: "unconfirmed";
		readonly trashInvoked: boolean;
		readonly unlinkInvoked: boolean;
		readonly fallbackRefusal?: GuardedSavedDeletionRefusalReason;
	}
	| { readonly status: "unknown" };

/**
 * Narrow test-only replacements for the two actual deletion mutation handoffs.
 * Production always uses the native `spawnSync("trash", [file])` and `unlinkSync`.
 * They replace only the protected invocation itself; the manager's guard and
 * revalidation before each stage are never replaceable.
 */
export interface SavedDeletionMutationAdapters {
	readonly spawnSync?: typeof nodeSpawnSync;
	readonly unlink?: (path: string) => void;
}

/** Default terminal geometry for newly created instances. */
export const DEFAULT_INSTANCE_COLS = 80;
export const DEFAULT_INSTANCE_ROWS = 24;

/** Default bounded windows for graceful owned shutdown escalation. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 8000;
export const DEFAULT_SHUTDOWN_KILL_MS = 2000;

/** Internal policy seam for synthetic manager tests; production defaults to the actual host platform. */
let shutdownPlatformForTests: NodeJS.Platform | undefined;

/** Internal mutation-handoff seam for guarded deletion tests; production uses the native imports. */
let savedDeletionAdaptersForTests: SavedDeletionMutationAdapters | undefined;

/** Upper bound for a single-line instance label (UTF-16 code units). */
export const MAX_LABEL_CHARS = 80;

/** Bounds for the copied activity snapshot: two lines, each at most 120 Unicode code points. */
export const MAX_ACTIVITY_ENTRIES = 2;
export const MAX_ACTIVITY_ENTRY_CHARS = 120;
/**
 * Bounded automatic fresh-census attempts per unknown activity episode. A
 * known status or a reconnect starts a new episode; an exhausted episode
 * stops requesting until one of those genuine events, never by polling.
 */
export const MAX_ACTIVITY_REFRESH_ATTEMPTS = 4;

/** Upper bound for the bounded public error text of an errored row. */
export const MAX_INSTANCE_ERROR_CHARS = 240;

/** Lifecycle of one owned instance row; always the process's actual state. */
export type InstanceLifecycle = "starting" | "alive" | "exited" | "error";

/**
 * What one viewing surface contributes to the sessions it displays (#474).
 *
 * A viewer is a display surface, not a controller: registering one takes no
 * input lease, and several viewers of the same row may all provide input.
 * `cols`/`rows` are that surface's own content-pane size; a metadata-only
 * surface reports neither and contributes no dimensions. `revision` increases
 * with every accepted change to this viewer, so a writer holding an older
 * revision is refused instead of overwriting a newer selection.
 */
export interface SessionViewerState {
	readonly viewerId: string;
	/** The live row this viewer displays, or undefined while it displays none. */
	readonly sessionId: string | undefined;
	readonly cols: number | undefined;
	readonly rows: number | undefined;
	readonly revision: number;
}

/**
 * One viewer change. Omitted fields keep their current value; `sessionId: null`
 * is the explicit "displays no session" state (the surface stays registered but
 * contributes neither a target nor a geometry contribution to any row).
 */
export interface SessionViewerUpdate {
	readonly sessionId?: string | null;
	readonly cols?: number;
	readonly rows?: number;
	/** Apply only while this viewer still has exactly this revision. */
	readonly expectedRevision?: number;
}

/** Why one viewer change was refused. None of them is a retry instruction. */
export type SessionViewerRefusal =
	| "disposed"
	| "unknown-viewer"
	| "stale"
	| "unknown-session"
	| "invalid-geometry";

export type SessionViewerUpdateResult =
	| { readonly applied: true; readonly state: SessionViewerState }
	| { readonly applied: false; readonly reason: SessionViewerRefusal };

/** One row's canonical content geometry and the count of applied changes to it. */
export interface SessionGeometry {
	readonly cols: number;
	readonly rows: number;
	readonly revision: number;
}

/** The current native conversation a viewer input scope is admitted against. */
export interface NativeViewerInputTuple {
	readonly sessionId: string;
	readonly epoch: number;
}

/** The row's canonical geometry as recorded in one viewer input source. */
export interface NativeViewerInputGeometry {
	readonly cols: number;
	readonly rows: number;
	readonly revision: number;
}

/**
 * The host's own immutable description of one viewer's input scope at one instant
 * (#481 interactive path). Every field is a fact this manager already owns — the
 * host run that registered the surface, the viewer's identity and revision, the row
 * it displays, the exact registration and generation, the current native
 * conversation tuple, and the row's canonical geometry and its revision — plus the
 * host-minted scope token committing to them.
 *
 * It is an expected-value fence, never an authority: a caller reads it, hands it
 * back unchanged, and the manager compares EVERY field against the current record
 * immediately before writing. Nothing in it selects a row, a viewer, a child, or a
 * copy destination, and terminal TEXT changes are deliberately absent — new output
 * on an unchanged conversation never moves the input owner.
 */
export interface NativeViewerInputSource {
	readonly hostRunId: string;
	readonly viewerId: string;
	readonly viewerRevision: number;
	readonly rowId: string;
	readonly nativeSession: NativeViewerInputTuple;
	readonly geometry: NativeViewerInputGeometry;
	readonly registrationIdentity: string;
	readonly registrationGeneration: string;
	/** Descriptive, echoable host-minted token; never a grant by itself. */
	readonly sourceToken: string;
}

/**
 * The host's own immutable description of one viewer's input scope while its row
 * is in the explicit native STARTUP phase (issue 389): the row's own registration
 * is framed, ready, and still before its first accepted status, and the manager
 * has never observed a conversation tuple for it.
 *
 * It carries the same run, viewer, row, registration, geometry, and token facts as
 * {@link NativeViewerInputSource}, an explicit `phase: "startup"`, and NO
 * `nativeSession` key at all — never a null, empty, or fabricated tuple, and never
 * a claim that no native conversation exists. Its token lives in a separate
 * commitment domain, so it can never be read or verified as a conversation-copy
 * scope. Input-only: no copy receipt ever carries it.
 */
export interface NativeViewerStartupInputSource {
	readonly hostRunId: string;
	readonly viewerId: string;
	readonly viewerRevision: number;
	readonly rowId: string;
	readonly phase: "startup";
	readonly geometry: NativeViewerInputGeometry;
	readonly registrationIdentity: string;
	readonly registrationGeneration: string;
	/** Descriptive, echoable host-minted `nvst1` token; never a grant by itself. */
	readonly sourceToken: string;
}

/**
 * The host's own immutable description of one viewer's input scope on a NATIVE
 * CLI row (issue 277 native remote-input slice): a hosted provider child this
 * manager owns only as a PTY process, with no Pi status registration, no bootstrap
 * token, no input framing, and no Pi native conversation.
 *
 * It carries the host run, viewer identity and revision, row, the row's positively
 * recorded provider backend, and the canonical geometry and its revision — and NO
 * `nativeSession`, `registrationIdentity`, or `registrationGeneration` key at all,
 * because inventing any of them would claim a fact the row does not have. The
 * process this scope is bound to is deliberately NOT a public fact: it is carried by
 * an owner-private per-incarnation secret the manager minted when it took ownership
 * of this child's PTY, which appears nowhere here and never crosses a wire.
 *
 * Its token lives in the separate `nvcli1` commitment domain, so it can never be
 * read or verified as a Pi conversation-copy scope or a Pi startup scope. Input
 * only: no copy receipt ever carries it, and a native CLI row has no copy producer.
 * The scope describes terminal-process control and nothing more — it is never a
 * claim about what the provider conversation is doing, and none of its facts are
 * derived from child output or process liveness beyond the manager's own ownership.
 */
export interface NativeViewerNativeCliInputSource {
	readonly hostRunId: string;
	readonly viewerId: string;
	readonly viewerRevision: number;
	readonly rowId: string;
	readonly phase: "native-cli";
	readonly backend: NativeCliBackend;
	readonly geometry: NativeViewerInputGeometry;
	/** Descriptive, echoable host-minted `nvcli1` token; never a grant by itself. */
	readonly sourceToken: string;
}

/** The closed phase marker of a native CLI input source. */
const NATIVE_CLI_INPUT_PHASE = "native-cli" as const;

/**
 * The input-path union: an unchanged Pi conversation source, a Pi startup source,
 * or a hosted native CLI process source.
 */
export type NativeViewerAnyInputSource =
	| NativeViewerInputSource
	| NativeViewerStartupInputSource
	| NativeViewerNativeCliInputSource;

/** True for the startup variant of an input-path source. */
export function isNativeViewerStartupInputSource(
	source: NativeViewerAnyInputSource,
): source is NativeViewerStartupInputSource {
	return (source as { readonly phase?: unknown }).phase === "startup";
}

/** True for the hosted native CLI variant of an input-path source. */
export function isNativeViewerNativeCliInputSource(
	source: NativeViewerAnyInputSource,
): source is NativeViewerNativeCliInputSource {
	return (source as { readonly phase?: unknown }).phase === NATIVE_CLI_INPUT_PHASE;
}

/**
 * Why one viewer input was refused. Every refusal happens strictly BEFORE any PTY
 * write, and none of them is a retry instruction.
 */
export type NativeViewerInputRefusal =
	/** No manager, this host is closing, or the manager offers no viewer input seam. */
	| "unavailable"
	/** This manager is stopping or disposed. */
	| "disposed"
	/** Never registered, retired by closeViewer, or an unknown id. */
	| "unknown-viewer"
	/** Registered without this host's run identity or without a copy sink. */
	| "no-input-source"
	/** Displays no row, or its row is gone, finished, stopping, or unregistered. */
	| "row-unavailable"
	/** Framing not requested for this registration, or its readiness unverified. */
	| "input-unready"
	/** The row's current native conversation is unknown. */
	| "unknown-native-tuple"
	/** Any expected fact differs from the current one, including an ABA change. */
	| "stale-source"
	/** The row's current input modes differ from the modes the bytes were made for. */
	| "stale-input-modes"
	/** The row's input modes cannot be read, so the fence cannot be evaluated. */
	| "modes-unavailable"
	/** Malformed request or no bytes to send. */
	| "invalid-input";

/**
 * Viewer input outcome. `submitted` means the write was invoked and returned; it is
 * never an acknowledgement that the child processed anything. `unknown` means the
 * handoff is genuinely uncertain after the write was invoked. There is no retry,
 * queue, replay, resize, spawn, or stop on any path.
 */
export type NativeViewerInputResult =
	| { readonly status: "submitted" }
	| { readonly status: "refused"; readonly reason: NativeViewerInputRefusal }
	| { readonly status: "unknown" };

/** One strict viewer input request: current facts, current modes, and the bytes. */
export interface NativeViewerInputRequest {
	/**
	 * The exact current source: a Pi conversation source, a Pi startup source, or a
	 * hosted provider CLI process source.
	 */
	readonly expectedSource: NativeViewerAnyInputSource;
	readonly expectedInputModes: TerminalInputModes;
	/**
	 * Native translated bytes; legacy X10 mouse packets must remain byte-oriented.
	 * One dispatch is bounded, in raw bytes (UTF-8 for a string, `length` for a
	 * Buffer), by the child's technical whole-dispatch assembly bound — the agreed
	 * 1 MiB paste body plus its two markers. Larger input is refused as
	 * `invalid-input` before the PTY, never truncated and never sent unframed.
	 */
	readonly data: string | Buffer;
}

/**
 * One native copy this exact viewer's own input caused. It travels to that viewer's
 * bound sink and to nobody else: never the owner's local clipboard callback, never
 * another viewer, never a broadcast.
 */
export interface NativeViewerClipboardReceipt {
	readonly source: NativeViewerInputSource;
	readonly event: NativeClipboardEvent;
	readonly dispatchId: number;
}

/**
 * One captured TEXT copy from one owned hosted provider child (issue 277 native
 * text-copy slice).
 *
 * It states only what the owner actually observed: a normalized canonical-base64
 * UTF-8 text payload captured inside this row's own PTY, and the row's own
 * positively recorded provider backend. There is deliberately NO `sessionId`,
 * `sessionEpoch`, registration, PID, path, or command field: a hosted provider
 * child has no Pi conversation, and inventing a tuple here would be a fabricated
 * attribution. The child process the copy rode in on is bound only through this
 * row's owner-private per-incarnation key.
 */
export interface NativeCliClipboardEvent {
	readonly kind: "copy";
	readonly encoded: string;
	readonly backend: NativeCliBackend;
}

/**
 * One hosted provider copy routed to the ONE viewer surface this manager last
 * accepted input from on that exact child incarnation. `dispatchId` is the owner's
 * own ordinal of that accepted input: a routing convention frozen when the copy was
 * accepted, never causal proof that the input produced the copy.
 */
export interface NativeViewerNativeCliClipboardReceipt {
	readonly source: NativeViewerNativeCliInputSource;
	readonly event: NativeCliClipboardEvent;
	readonly dispatchId: number;
}

/** True only for the hosted provider variant of a viewer copy receipt. */
export function isNativeViewerNativeCliClipboardReceipt(
	receipt: NativeViewerClipboardReceipt | NativeViewerNativeCliClipboardReceipt,
): receipt is NativeViewerNativeCliClipboardReceipt {
	return (receipt.source as { readonly phase?: unknown }).phase === NATIVE_CLI_INPUT_PHASE;
}

/**
 * One viewer's own copy destination, supplied by the host that owns that surface.
 * It receives either an unchanged Pi conversation copy or a hosted provider TEXT
 * copy; the variant is the surface's own business and is never merged.
 */
export type NativeViewerClipboardSink =
	(receipt: NativeViewerClipboardReceipt | NativeViewerNativeCliClipboardReceipt) => void;

/**
 * Local-only registration options for one viewing surface. Both are immutable for
 * the life of the viewer and stay in the manager's own viewer record: they never
 * enter the public viewer state, a roster, or any second store, and neither grants
 * input. A viewer registered without them keeps every existing behavior and can
 * never be an input source.
 */
export interface ViewerOpenOptions {
	/** The host run that owns this surface, minted by that host, never by a caller. */
	readonly hostRunId?: string;
	/** This surface's own native copy sink; required before it may take input. */
	readonly nativeClipboardSink?: NativeViewerClipboardSink;
}

/**
 * The small structural PTY surface the manager needs — the exact public
 * subset of the pinned `@lydell/node-pty` `IPty` (data/exit events, write,
 * resize, kill, pause/resume), injectable so focused tests never load the
 * native addon. The default factory casts the real pinned implementation to
 * this interface; Windows ConPTY uses node-pty's normal public spawn API,
 * not private bindings or emulated callbacks. Actual Windows behavior still
 * requires the parent-owned native validation harness.
 */
export interface InstancePty {
	readonly pid: number;
	readonly cols: number;
	readonly rows: number;
	onData(listener: (data: string) => void): { dispose(): void };
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
	/** Runtime node-pty EventEmitter hooks; the pinned declaration omits these inherited methods. */
	on?(eventName: "error", listener: (error: Error) => void): unknown;
	removeListener?(eventName: "error", listener: (error: Error) => void): unknown;
	write(data: string | Buffer): void;
	resize(columns: number, rows: number): void;
	kill(signal?: string): void;
	pause(): void;
	resume(): void;
}

/** The exact spawn descriptor handed to the PTY factory. */
export interface InstanceSpawnDescriptor {
	file: string;
	args: string[];
	/**
	 * Windows only, for a batch (`.cmd`/`.bat`) child: the invocation in the
	 * pinned implementation's public pre-escaped `CommandLine` form, delivered
	 * verbatim after `file` instead of as an argv array the pinned spawn would
	 * re-escape. Absent for every direct executable child.
	 */
	commandLine?: string;
	env: NodeJS.ProcessEnv;
	cwd: string;
	cols: number;
	rows: number;
}

export type PtyFactory = (descriptor: InstanceSpawnDescriptor) => InstancePty;

/** Status update published by the per-instance status reporter. */
export interface InstanceStatusUpdate {
	busy: boolean | null;
	pendingInput: boolean | null;
	inputSurface: boolean;
	activity: readonly string[];
	/** Optional canonical native conversation metadata; never transcript or status detail. */
	nativeSession?: SessionHostNativeSession | null;
	/**
	 * Optional bounded owned background-work counts. Omitted by an older
	 * registrar; absence, null, or any invalid value normalizes to null
	 * (unknown), never zero. Never a PID/process count.
	 */
	backgroundTasks?: number | null;
	backgroundShells?: number | null;
	/**
	 * Optional bounded ACTIVITY-INTENT counts, independent of ownership. Absent
	 * or invalid normalizes to null (unknown), never zero. Display reads these;
	 * the stop/idle gate keeps reading the ownership pair above.
	 */
	activeTasks?: number | null;
	activeShells?: number | null;
}

export interface InstanceStatusHandlers {
	onStatus(update: InstanceStatusUpdate): void;
	onDisconnect(): void;
	/** A valid hello superseded/reconnected this live registration (never the first connection). */
	onReconnect?(): void;
	/** An authenticated model request routed through this exact child registration. */
	onSpawnRequest?(request: SessionSpawnInput): Promise<SessionSpawnOutcome>;
	/**
	 * An authenticated ROUTED request (`host` and/or `kind` present) on this exact
	 * child registration. Supplied only when the manager was given a routed
	 * handler, so a registration advertises routed support only when it is real.
	 */
	onRoutedSpawnRequest?(request: SessionSpawnInput): Promise<SessionSpawnOutcome>;
	/**
	 * Present (only as `true`, and only beside {@link onRoutedSpawnRequest}) when
	 * that routed handler honors SessionSpawn `createWorkspace`. It is the
	 * registration's declared implementation support behind the bootstrap's
	 * `spawnCreateWorkspace` marker, never a permission.
	 */
	routedSpawnCreateWorkspace?: boolean;
	/**
	 * An authenticated read-only SessionHosts inspection on this exact child
	 * registration. Supplied only together with {@link onRoutedSpawnRequest} and
	 * only when the manager was given a discovery handler, so a registration
	 * advertises discovery only when it is real. A rejection is an unavailable
	 * inspection, never an empty listing.
	 */
	onSessionHostsRequest?(context: SessionHostsRequestContext): Promise<SessionHostsSnapshot>;
}

export interface InstanceStatusBootstrap {
	readonly version: 1;
	readonly socketPath: string;
	readonly token: string;
	readonly instanceId: string;
	readonly generation: string;
	/** Private host-owned startup payload namespace; absent withholds long-prompt delivery. */
	readonly payloadDir?: string;
	/**
	 * Closed input-framing mode marker actually recorded in THIS registration's
	 * bootstrap. Absence means legacy; the manager never frames a byte unless the
	 * bootstrap it received carries exactly mode version 1.
	 */
	readonly inputOriginFraming?: 1;
	/** Routed SessionSpawn support marker actually recorded in THIS registration's bootstrap. */
	readonly spawnRouting?: 1;
	/** Read-only SessionHosts discovery marker actually recorded in THIS registration's bootstrap. */
	readonly sessionHosts?: 1;
}

export interface InstanceStatusRegistration {
	readonly bootstrap: InstanceStatusBootstrap;
	/** Authenticated persisted rename when supported by the current registrar. */
	rename?(request: StatusRenameRequest): Promise<StatusRenameResult>;
	/** Authenticated public native shutdown when supported; acceptance is not PTY exit. */
	shutdown?(options?: { readonly requireIdle?: boolean }): Promise<StatusShutdownResult>;
	/** Authenticated fresh activity census from this exact live client. */
	requestActivity?(): Promise<StatusActivityRefreshResult>;
	release(): void;
}

/** Host-visible outcome of an explicit fresh activity-census request. */
export type InstanceActivityRefreshStatus = StatusActivityRefreshResult["status"] | "unsupported";

/**
 * Structural status registrar contract. The broker owns all authentication,
 * generation, request-fence, and wire checks; this module never duplicates
 * any wire parser.
 */
export interface StatusRegistrar {
	/**
	 * Registers one row before its child is spawned. The closed
	 * {@link InstanceStatusRegistrationOptions} input-framing request is passed
	 * through to the ACTUAL bootstrap the registrar issues; a registrar that does
	 * not record the request in that bootstrap makes the opted-in row fail closed
	 * rather than frame against a legacy child.
	 */
	register(
		instanceId: string,
		handlers: InstanceStatusHandlers,
		options?: InstanceStatusRegistrationOptions,
	): InstanceStatusRegistration;
}

/** Closed per-registration request the manager may pass to its registrar. */
export interface InstanceStatusRegistrationOptions {
	/**
	 * Request the closed child-side input-framing bootstrap mode (version 1) for
	 * this registration only. Sent only when the manager was constructed with the
	 * internal opt-in; absent keeps the legacy bootstrap byte-for-byte.
	 */
	readonly inputOriginFraming?: boolean;
}

/** Immutable, copied view row for one instance (later SidebarItem shape). */
export interface NativeInstanceView {
	readonly id: string;
	/**
	 * The row's display label, in the shape every presentation of this host (and
	 * the roster projection built from it) already transmits. For a native CLI row
	 * this is its EFFECTIVE caption: the operator's caption when they gave one, else
	 * the provider's own actual conversation title when this row's source positively
	 * proved one, else the stable provider label. For a Pi row it is the observed
	 * native conversation name. It is never a provider conversation identity, never
	 * observed child output, and never something the provider was told.
	 */
	readonly label: string;
	readonly workspace: string;
	readonly agentDir: string;
	/**
	 * The backend this row was created with, present only when the creation was
	 * explicit. Absence means Pi, exactly as for every row written before native
	 * CLI hosting. A native CLI row never reports a Pi native conversation.
	 */
	readonly backend?: SessionBackend;
	readonly lifecycle: InstanceLifecycle;
	readonly busy: boolean | null;
	readonly pendingInput: boolean | null;
	readonly inputSurface: boolean;
	/** Last validated native conversation tuple; null means unavailable/unknown. */
	readonly nativeSession: SessionHostNativeSession | null;
	/** Retained current binding for exited-row restart only; never revives live command availability. */
	readonly lastNativeSession?: SessionHostNativeSession;
	/** Observed owned logical background work (tasks + automatic review); null means unknown, never 0. */
	readonly backgroundTasks?: number | null;
	/** Observed owned background shell jobs not yet confirmed settled; null means unknown, never 0. */
	readonly backgroundShells?: number | null;
	/** Observed admitted/running logical work intent; null means unknown, never 0. */
	readonly activeTasks?: number | null;
	/** Observed starting/running background shell intent; null means unknown, never 0. */
	readonly activeShells?: number | null;
	/**
	 * The row's own declared per-category applicability (native status slice), present
	 * only once that row's observer declared something. A Pi row never carries it, so a
	 * Pi view renders exactly as before; on a hosted provider row it is what lets a
	 * category that backend cannot report render as not-applicable instead of unknown,
	 * while a supported-but-unobserved category stays unknown and never becomes 0.
	 */
	readonly statusSupport?: NativeStatusSupportMap;
	/** True only while this manager still owns a PTY without a confirmed exit. */
	readonly hasLiveProcess: boolean;
	readonly activity: readonly string[];
	readonly exitCode?: number;
	/** Bounded single-line public failure text; set only on `error` rows. */
	readonly error?: string;
}

/** Closed outcome of one {@linkcode InstanceManager.setNativeDisplayName} call. */
export type NativeDisplayNameResult =
	| "set"
	| "unchanged"
	/** No such row (or the manager is shutting down): nothing changed. */
	| "no-row"
	/** The row is not a native CLI row: its name belongs to the Pi rename path. */
	| "not-native"
	/** The value failed the shared native display-name bound: nothing changed. */
	| "invalid-name";

export interface CreateInstanceOptions {
	/** Legacy/test-only initial display label; production creation omits it and waits for native metadata. */
	label?: string;
	/** Explicit workspace directory for the instance's child process. */
	workspace: string;
	/** Legacy-test-only explicit profile directory; native setup rejects it. */
	profile?: string;
	/**
	 * Deliberate per-child saved-conversation selection: a branded receipt
	 * minted by admitSavedSession (src/session-host/saved-sessions.ts) from the
	 * read-only native saved-conversation catalog. The exact saved header cwd
	 * (`admission.workspace`) determines the child workspace and must equal
	 * `workspace` — the host cwd is never substituted. The receipt is reserved
	 * synchronously before any await for known-owned duplicate fencing and
	 * passed verbatim to prepareNativeLaunch.
	 */
	savedSession?: SavedSessionAdmission;
	/**
	 * Fresh model-request child only: the exact title and prompt to deliver at
	 * session start. A Pi row receives them through its existing staged startup
	 * request. A native CLI row (issue #493) receives the prompt through one owned
	 * file-backed startup instruction (see ./native-initial-prompt) and the title
	 * through its provider's own native title option where one exists (Claude), or
	 * otherwise as this row's stored caption (Codex). Neither ever travels through
	 * argv or the environment verbatim except the Claude title option itself.
	 */
	initialRequest?: { readonly title: string; readonly prompt: string };
	/**
	 * Which backend this row belongs to. Absence means `pi` (every existing caller
	 * and every older row). A native CLI backend (`claude`, `codex`) launches the
	 * provider's own interactive CLI through the host-injected
	 * {@linkcode InstanceManagerOptions.nativeCliLaunch} provider instead of the
	 * Pi launch composition, and therefore never receives a status registration,
	 * Pi bootstrap, preload, startup payload, title token, or input framing.
	 */
	backend?: SessionBackend;
	/**
	 * Native CLI rows only: the operator's explicit configured launch-target
	 * selection, forwarded unchanged to the launch provider as
	 * {@linkcode NativeCliLaunchRequest.targetId}. This manager never persists,
	 * resolves, or interprets it, and never selects a target itself. Combining it
	 * with a Pi backend is refused before anything is posted.
	 */
	nativeCliTarget?: string;
	/**
	 * INTERNAL owner-only restart restoration intent (issue #277): the exact
	 * provider-issued conversation UUID this native CLI row is asked to resume.
	 * It is validated before any row exists (a native backend only, and an exact
	 * UUID — never a name, alias, or path), and forwarded only through the private
	 * launch request, owned-backend request, and observer context. It is never a Pi
	 * `sessionId`, never a status value, and never part of a public, peer, or
	 * network view. Combining it with a Pi backend is refused before anything is
	 * posted.
	 */
	nativeResumeConversationId?: string;
	/**
	 * Opt-in destination workspace creation (issue #493). Only an exact `true`
	 * makes this row's own launch preparation ensure its workspace exists with one
	 * ordinary recursive directory creation (the shared workspace resolver's
	 * `createWorkspace`), on this host, after every existing admission, and before
	 * the same canonical resolution and launch any row gets. The same option means
	 * the same thing for a Pi row and a native CLI row. An existing directory is
	 * reused unchanged; a creation failure is an ordinary launch preparation
	 * failure; created directories remain if a later step fails (no cleanup,
	 * rollback, retry, or permission change). Absent or `false` is exactly the
	 * noncreating launch. It is refused beside a saved conversation or a native
	 * resume, whose workspace is already recorded.
	 */
	createWorkspace?: boolean;
}

/**
 * The OPTIONAL native status hook arming for exactly one launch
 * (issue #277 native status owner slice). It carries ONLY the fresh bootstrap
 * the owner's broker-issued native hook registration handed back for this row
 * before the provider child existed — nothing else. With no such option (every
 * existing call site, and every manager constructed without the optional
 * registrar/observer pair) the provider composes exactly the descriptor it
 * composed before status observation existed: no added argument, no added
 * environment entry, no artifact.
 */
export interface NativeCliNativeHookLaunchOption {
	readonly bootstrap: NativeHookBootstrap;
}

/**
 * One native CLI launch request from this manager to the host's launch provider.
 * `workspace` is the row's already-validated canonical workspace (the child cwd
 * the manager will spawn with), and `env` is a fresh copy of the manager's
 * environment snapshot that neither the provider nor the manager mutates.
 * `targetId` is the unchanged operator selection when one was given.
 * `nativeHook` is present ONLY for a row this host armed a native status source
 * for, and carries ONLY that registration's bootstrap.
 */
export interface NativeCliLaunchRequest {
	readonly workspace: string;
	readonly env: NodeJS.ProcessEnv;
	readonly targetId?: string;
	readonly nativeHook?: NativeCliNativeHookLaunchOption;
	/**
	 * OPTIONAL native MCP relay arming for exactly this launch (#682): present ONLY
	 * for a row this host armed a native MCP lane for through
	 * {@linkcode InstanceManagerOptions.nativeMcpLane}, carrying ONLY that lane's
	 * fresh broker bootstrap and the owner-injected stable host server name. Absence
	 * is every existing launch, exactly as before.
	 */
	readonly nativeMcp?: NativeCliNativeMcpOption;
	/**
	 * Owner-private restart restoration intent: the exact admitted conversation
	 * UUID, present only when the row was created with
	 * {@linkcode CreateInstanceOptions.nativeResumeConversationId}. Absence is every
	 * fresh launch, exactly as before.
	 */
	readonly resumeConversationId?: string;
	/**
	 * Fresh SessionSpawn launch only (issue #493): the generated one-line startup
	 * instruction that points at this manager's owned staged prompt file, plus the
	 * exact requested title for a provider with a native title option. The original
	 * prompt is never part of this request. Absence is every other launch, exactly
	 * as before.
	 */
	readonly initialPrompt?: NativeCliInitialPrompt;
	/**
	 * #682: present (and only ever `true`) for a Claude row whose run this manager
	 * armed a native Claude inbox slot for through
	 * {@linkcode InstanceManagerOptions.nativeClaudeInbox}, asking the provider for
	 * its bounded compatibility receipt of THIS launch's exact executable. It never
	 * changes argv or environment. Absence is every other launch, exactly as before.
	 */
	readonly claudeInboxCompatibility?: boolean;
	/**
	 * #682: present (and only ever `true`) beside `claudeInboxCompatibility` for a
	 * manager built with {@linkcode InstanceManagerOptions.nativeClaudeInboxRequiresMcpLane}:
	 * the provider must decline the compatibility receipt, without probing, unless
	 * THIS launch's native MCP option was actually prepared. Absence keeps the
	 * standalone request exactly as before.
	 */
	readonly claudeInboxRequiresNativeMcp?: boolean;
	/**
	 * #682 (Codex callback): present (and only ever `true`) for a Codex row of a
	 * manager built with {@linkcode InstanceManagerOptions.nativeCodexCallback}
	 * whose own native MCP lane registered, asking the provider for its bounded
	 * version receipt of THIS launch's owned backend executable. It never changes
	 * argv or environment. Absence is every other launch, exactly as before.
	 */
	readonly codexCallbackCompatibility?: boolean;
}

/** The provider-facing half of one native startup request; never the prompt text. */
export interface NativeCliInitialPrompt {
	readonly instruction: string;
	/** Present only for a backend whose provider takes a native title option (Claude). */
	readonly title?: string;
}

/**
 * What a launch provider hands back: the ordinary interactive descriptor, plus
 * (when the request armed them) the closed outcome of this launch's native status
 * hook preparation. `prepared` transfers ownership of `lease` to this manager,
 * which releases it only after this row's own settlement; `unavailable` means this
 * launch armed nothing, so the run's source and observer are released and its
 * provider status stays unknown. Absence is the legacy shape: nothing was staged,
 * so there is no lease, and the row simply stays unknown until real observations
 * arrive.
 */
export interface NativeCliLaunchDescriptor extends NativeLaunchDescriptor {
	readonly nativeHook?: NativeHookLaunchOutcome;
	/**
	 * Present only when the request armed the native MCP relay. `prepared` transfers
	 * ownership of `lease` to this manager, which releases it under the same
	 * settlement rule as the hook artifacts; anything else (including absence) means
	 * this launch's MCP lane is revoked and its interactive launch is unchanged.
	 */
	readonly nativeMcp?: NativeMcpLaunchOutcome;
	/**
	 * Present only for a Codex launch a provider prepared in owned backend mode:
	 * the pure rendering plan of THIS launch's one owned app-server backend and the
	 * interactive TUI that attaches to it. It is a plan, not a child and not an
	 * ownership claim — the manager only consumes it (create the backend, render the
	 * TUI from the fulfilled lease) and never reinterprets what it renders.
	 *
	 * Its absence is every existing launch: the ordinary `file`/`args`/`env`/`cwd`
	 * descriptor is spawned exactly as it always was, with no backend, no endpoint,
	 * and no bearer anywhere.
	 */
	readonly ownedCodex?: NativeCodexOwnedLaunchPlan;
	/**
	 * #682: the provider's Claude inbox compatibility receipt, present only when the
	 * request asked for it. Only `verified` with a supported version keeps this run's
	 * inbox slot; anything else (including absence) revokes it, and the interactive
	 * launch is unaffected either way.
	 */
	readonly claudeInboxCompatibility?: NativeClaudeInboxCompatibilityOutcome;
}

/**
 * The host-injected provider that turns one native CLI backend selection into a
 * complete interactive launch descriptor. Provider discovery, argv composition,
 * configured-target resolution, and provider-side environment sanitization all
 * belong to the provider; the manager only validates the returned descriptor,
 * requires its cwd to be this row's selected canonical workspace, and spawns it
 * verbatim. It may be asynchronous. It runs BEFORE the synchronous spawn stretch,
 * and the manager races it against its own shutdown/disposal notification: a
 * provider that never answers can never hold the host away from stopping its
 * existing children, and an answer that arrives later is discarded rather than
 * spawned. A provider must therefore tolerate being abandoned.
 */
export type NativeCliLaunch = (
	backend: NativeCliBackend,
	request: NativeCliLaunchRequest,
) => NativeCliLaunchDescriptor | Promise<NativeCliLaunchDescriptor>;

/**
 * What this manager asks its injected owned-Codex-backend factory for, once per
 * owned run, synchronously, before it awaits anything.
 *
 * The factory owns the process: it must start the one backend child from
 * `plan.renderBackend(…)` (the plan re-renders the SAME resolved target the TUI
 * uses, and the lease hands it the closed control argv), return the exact lease
 * synchronously, and terminate only that captured child. It never selects an
 * endpoint, never adopts another server, and never scans a port.
 */
export interface OwnedCodexBackendLaunchRequest {
	/** The identity this manager minted for exactly this run; the lease must echo it. */
	readonly identity: OwnedCodexBackendLaunchIdentity;
	/** This launch's rendering plan; the factory may only call `renderBackend` on it. */
	readonly plan: NativeCodexOwnedLaunchPlan;
	/**
	 * Aborted when this run is retired (stop, removal, disposal, launch failure).
	 * The manager also calls `requestStop()` on the returned lease, so honoring the
	 * signal is an additional path and never the only one.
	 */
	readonly signal: AbortSignal;
	/**
	 * Owner-private metadata: this row's canonical workspace (the TUI's cwd). It is
	 * descriptive for the factory and changes nothing the plan renders.
	 */
	readonly workspace?: string;
	/**
	 * Owner-private metadata: the exact admitted restart restoration conversation
	 * UUID, present only for a row created with a resume intent. It changes nothing
	 * the plan renders.
	 */
	readonly resumeConversationId?: string;
}

/**
 * The host-injected owner of one owned Codex backend process. It is called
 * synchronously, and its answer is validated against the identity this manager
 * minted BEFORE anything is awaited; a factory that throws, or that answers with
 * anything that is not a usable lease for that identity, fails the row before any
 * TUI child exists.
 */
export type OwnedCodexBackendFactory = (
	request: OwnedCodexBackendLaunchRequest,
) => OwnedCodexBackendLease;

/**
 * The owner-only, run-private view of one fulfilled owned Codex backend, handed
 * to THIS run's own status observer exactly once.
 *
 * It is the settled next-phase seam for a fresh-session status reader: it carries
 * the identity and endpoint of THIS lease and one private accessor for the
 * observer bearer, and nothing else — no command line, no environment, no
 * provider arguments, no root or conversation selection, and no wire or roster
 * shape. It is never stored on a view, serialized, or logged; a consumer that
 * needs a status registration builds it elsewhere from these facts.
 */
export interface NativeOwnedCodexBackendObservationSource {
	readonly leaseId: string;
	readonly generation: number;
	readonly endpoint: string;
	/** Sensitive: the observer bearer of THIS lease. Never log, store, or publish it. */
	readonly readObserverBearer: () => string;
	/**
	 * Present only when this lease's factory also fronts the backend with the
	 * private native TUI relay: the exact retained fresh-root facts source of
	 * THIS run, forwarded verbatim from the lease's own fulfilled readiness value
	 * (never re-minted, never re-read). Like the rest of this source it is
	 * owner-private: it is not a wire, roster, status, or control shape, it is
	 * never stored on a view, serialized, or logged. The manager reads only whether
	 * it was withdrawn, for the optional native MCP lane fence (#682). A consumer that attaches gets only the current closed state
	 * and an unsubscribe that detaches itself.
	 */
	readonly tuiRootFacts?: NativeCodexTuiRootFactsSource;
}

/**
 * The owner-supplied native hook source registrar: structurally exactly
 * `NativeHookStatusBroker.registerNativeHookSource`, so the production broker is
 * passed through without an adapter and this module never becomes a second
 * listener, socket, or token authority. The manager calls it for one hosted
 * provider row, BEFORE that row's child is spawned, and releases the returned
 * registration when that row's run is retired. A registrar that throws, or that
 * hands back a bootstrap for another backend or another row, leaves this row
 * unobserved with its interactive launch unchanged.
 */
export interface NativeHookSourceRegistrar {
	registerNativeHookSource(
		instanceId: string,
		backend: NativeCliBackend,
		handlers: NativeHookSourceHandlers,
	): NativeHookRegistration;
}

/**
 * The broker's own `registerNativeMcpSource` shape (#682), so the production broker
 * is passed through without an adapter and this module never becomes a second
 * listener, socket, or token authority.
 */
export interface NativeMcpSourceRegistrar {
	registerNativeMcpSource(
		instanceId: string,
		backend: NativeCliBackend,
		endpoint: NativeMcpToolEndpoint,
	): NativeMcpRegistration;
}

/**
 * The host-proved facts one native MCP lane call is bound to (#682). Every value
 * comes from this manager's own record of the exact run — never from the model,
 * the relay, the provider, or any request field — and the context is frozen.
 */
export interface NativeMcpLaneContext {
	/** The owner row id of the exact run this lane belongs to. */
	readonly rowId: string;
	/** The row's own recorded backend. */
	readonly backend: NativeCliBackend;
	/** The row's canonical workspace (the child's cwd), captured when the lane was armed. */
	readonly workspace: string;
	/**
	 * The ONE provider conversation this call's lane scope is bound to: the first
	 * identity this run's own observer positively proved and this manager accepted. A
	 * scope never rebinds; a later identity change, an identity loss, or a lost
	 * observation generation revokes the lane instead. Only a proved Claude `/clear`
	 * ends the scope without revoking the transport, and its successor is a NEW scope
	 * (new conversation, new `run`, one-use per-call correlation); see #682.
	 */
	readonly conversationId: string;
	/**
	 * Aborted when the broker or client cancels this call, when the lane is revoked
	 * (identity change or loss, replacement, failed launch, stop, exit, removal, or
	 * disposal), or when a proved Claude `/clear` ends this call's scope.
	 */
	readonly signal: AbortSignal;
	/**
	 * Re-proves, at call time, every fence this context was admitted under: the same
	 * current record, run, lane, live PTY handle, process incarnation, observer
	 * generation, backend, canonical workspace, and live bound conversation. A
	 * delegate must re-check it immediately before any effect; a result produced
	 * after it turned false is discarded by this manager regardless.
	 */
	readonly isCurrent: () => boolean;
	/**
	 * The exact native run this lane belongs to, as a lifetime separate from this one
	 * request (#682). It is the SAME frozen object for every call on the same lane, and
	 * a different one for any other launch — even a replacement on the same row or one
	 * that proves the same conversation string — and for the successor scope of a
	 * proved Claude `/clear` on the same launch, so a trusted owner may key run-scoped
	 * state to its identity. It is never derived from, nor aborted by, a broker
	 * request's cancellation; it ends only when this exact lane is revoked or its scope
	 * is ended by a proved `/clear`. Optional so an existing context shape stays valid;
	 * this manager always supplies it.
	 */
	readonly run?: NativeMcpLaneRunScope;
}

/**
 * The host-proved lifetime of one exact native MCP lane run (#682), shared by every
 * call on that lane. It is a trusted in-process object: it never travels in MCP
 * arguments or results.
 */
export interface NativeMcpLaneRunScope {
	/**
	 * Aborted once and terminally when this exact lane is revoked (identity change or
	 * loss, replacement, failed launch, stop, exit, removal, or disposal) or its scope
	 * is ended by a proved Claude `/clear` (#682) — never by an individual request's
	 * cancellation.
	 */
	readonly signal: AbortSignal;
	/**
	 * Synchronous, side-effect-free re-proof of the same exact record, run, lane, live
	 * PTY handle, process incarnation, observer generation, backend, canonical
	 * workspace, and bound conversation that every call's own `isCurrent` checks, minus
	 * any request's cancellation. False once the lane is revoked, for good.
	 */
	readonly isCurrent: () => boolean;
}

/** One `tools/call` as the lane forwards it: the tool name and freshly decoded arguments only. */
export interface NativeMcpLaneToolCall {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

/**
 * The trusted owner delegate behind one manager's native MCP lanes (#682). It is
 * explicitly injected — this manager implements no tool, no authorization, and no
 * persistence — and it is reached ONLY after the manager proved the call's
 * {@linkcode NativeMcpLaneContext}. It follows {@linkcode NativeMcpToolEndpoint}
 * semantics: `listTools` is side-effect free, and `callTool` answers `undefined`
 * for a name it does not expose.
 */
export interface NativeMcpLaneDelegate {
	listTools(context: NativeMcpLaneContext): Promise<readonly NativeMcpToolDescriptor[]>;
	callTool(context: NativeMcpLaneContext, call: NativeMcpLaneToolCall): Promise<NativeMcpCallToolResult | undefined>;
}

/**
 * The OPTIONAL trusted owner dependency that turns on this manager's native MCP
 * lane (#682). Absence is every existing manager: no MCP registration, no
 * `nativeMcp` launch option, no artifact, and no change to any launch.
 */
export interface NativeMcpLaneOwner {
	/** The broker registrar; structurally `NativeMcpStatusBroker.registerNativeMcpSource`. */
	readonly registrar: NativeMcpSourceRegistrar;
	/**
	 * The trusted owning host's stable, persisted MCP server name. This manager
	 * neither generates nor stores it; it only validates it once at construction and
	 * forwards it verbatim in each armed launch request.
	 */
	readonly serverName: string;
	/** The trusted tool delegate every proved lane call reaches. */
	readonly delegate: NativeMcpLaneDelegate;
	/**
	 * OPTIONAL fixed discovery catalog (#682): the canonical metadata (name,
	 * description, input schema) of the tools the trusted host genuinely configured
	 * for this manager's launches, precomputed by the host. It is validated and copied
	 * at construction and answered verbatim by `tools/list` while a current lane has
	 * not yet bound a conversation. It is metadata only: it never reaches the
	 * delegate, creates no authority, and admits no call — every `tools/call` still
	 * requires the lane's current conversation proof, and a revoked or replaced lane
	 * answers neither path. Once the lane binds, `tools/list` goes to the delegate
	 * exactly as without it. Absence keeps the pre-proof refusal.
	 */
	readonly preProofTools?: readonly NativeMcpToolDescriptor[];
	/**
	 * OPTIONAL second fixed discovery catalog (#682): the canonical metadata of the
	 * managed-outcome delivery tools the trusted host configured, precomputed by the
	 * host. It requires {@linkcode preProofTools}, shares no name with it, and is
	 * validated and copied at construction by the same rules. Its entries are appended
	 * to the metadata-only answers {@linkcode preProofTools} already gives — pre-proof
	 * discovery and a proved Claude `/clear` successor's discovery — ONLY while this
	 * exact run kept its lane and still holds its own verified delivery receipt (a
	 * kept Claude inbox compatibility receipt, or the exact owned Codex callback
	 * receipt). It is metadata only: it never reaches the delegate, creates no
	 * authority, and admits no call; every `tools/call` is authorized exactly as
	 * without it. Absence leaves discovery exactly as without it.
	 */
	readonly deliveryTools?: readonly NativeMcpToolDescriptor[];
	/**
	 * OPTIONAL managed activity projection (#682): the trusted owner's view of the
	 * canonical managed activity census of each exact lane run it holds. Absence
	 * keeps every row exactly as without it. See
	 * {@linkcode NativeMcpLaneActivity}.
	 */
	readonly activity?: NativeMcpLaneActivity;
}

/**
 * One exact lane run's managed task contribution (#682), as the trusted owner
 * currently knows it from its controller's canonical census.
 *
 * - `none`: this run holds no managed work the owner could still account for
 *   (never held, or every handoff completed cleanly); the row stays native-only.
 * - `unknown`: managed work may exist but its count is not proved right now
 *   (restore pending, census incomplete, or a handoff unresolved or failed). The
 *   row's combined task count is unknown, never zero.
 * - `known`: a verified census count for this exact run.
 */
export type NativeMcpLaneActivityContribution =
	| { readonly status: "none" }
	| { readonly status: "unknown" }
	| { readonly status: "known"; readonly count: number };

/**
 * The trusted owner's managed activity view (#682). It keeps no counter of its
 * own: every value is the last fresh read of the owning controller's census.
 */
export interface NativeMcpLaneActivity {
	/** Synchronous and side-effect free: the contribution of exactly this run object. */
	contributionFor(run: NativeMcpLaneRunScope): NativeMcpLaneActivityContribution;
	/**
	 * Observe contribution transitions; the listener receives the exact run whose
	 * contribution may have changed and re-reads it. Returns the unsubscribe.
	 */
	subscribe(listener: (run: NativeMcpLaneRunScope) => void): () => void;
}

/**
 * One host-supplied native status OBSERVER for exactly one owned provider run.
 *
 * It is the only shape through which provider knowledge can reach a row: the
 * manager forwards the broker's already-authenticated, already-sanitized hook
 * events and closed failures to it, and reads back only complete
 * {@linkcode NativeStatusObservation} values through the run's own status
 * capture. It is not a status registration and it never becomes one — no Pi
 * bootstrap, broker reporter namespace, native conversation tuple, input
 * framing, startup payload, or ownership count exists on this path — and nothing
 * here can mark a process settled, synthesize an exit, or change a stop decision.
 *
 * The OBSERVER (not the manager) owns its own session/prompt/read-generation
 * fences: a recoverable data gap is reported as a fresh all-unknown snapshot, and
 * stale internal callbacks are refused inside the source. The manager only retires
 * the whole run, which invalidates the run's capture for good.
 */
export interface NativeStatusObserver {
	/**
	 * This actual source's own static applicability declaration. It is a statement
	 * about what THIS observer can report, never a value the manager may guess: an
	 * observer that declares nothing leaves the row on the legacy unknown path.
	 */
	readonly support?: NativeStatusSupportMap;
	/** One authenticated, sanitized hook event for this run's own backend. */
	acceptHook(event: NativeHookEvent): void;
	/** One closed failure report from this run's own authenticated relay. */
	acceptFailure(failure: NativeHookFailure): void;
	/**
	 * Optional: retire THIS observer's own internal callbacks and generations. It is
	 * called before {@linkcode NativeStatusObserver.dispose} when present. The
	 * manager's authoritative retirement stays what it always was — invalidating the
	 * run's status capture — so an observer without this hook behaves identically.
	 */
	invalidate?(): void;
	/**
	 * Optional: state the baseline this source can state for a native run the HOST
	 * itself launched. It is called once, synchronously, when this run's status
	 * capture is already bound to the exact live PTY handle and incarnation and no
	 * input has been sent to the child — the source therefore does not have to wait
	 * for a provider hook to know the run started idle with nothing pending. A
	 * source that cannot state a launch-time baseline omits this hook and keeps
	 * today's all-unknown-until-first-observation behaviour, and a source that can
	 * still refuses the claim if it has already observed work.
	 */
	observeOwnedStartup?(): void;
	/**
	 * Optional (issue #277 owning-manager slice): the ONE private statement that this
	 * run's backend is a genuinely OWNED Codex backend, carrying the identity and
	 * endpoint of THIS lease plus the private observer-bearer accessor
	 * ({@linkcode NativeOwnedCodexBackendObservationSource}).
	 *
	 * It is called at most once for a run, synchronously, after this run's status
	 * capture is already bound to the exact live TUI PTY handle and incarnation and
	 * BEFORE {@linkcode NativeStatusObserver.observeOwnedStartup} is offered, so a
	 * source can qualify its ownership claim before it states any baseline. An
	 * observer that omits this hook keeps today's behavior unchanged, and a source
	 * that arrives after activation is offered the same one delivery if the run, its
	 * backend, and its capture are still the current ones.
	 *
	 * The manager draws no conclusion from it: this callback creates no registration,
	 * no connection, no status value, and no ownership. A throw retires this run's
	 * observation path only — never the backend, its child, or its artifacts — and it
	 * never reports the observer's message anywhere.
	 */
	observeOwnedCodexBackend?(source: NativeOwnedCodexBackendObservationSource): void;
	/** Retire this observer. Idempotent; it never signals or waits on the child. */
	dispose(): void;
}

/** Everything the owner's observer factory is allowed to know about one run. */
export interface NativeStatusObserverContext {
	/** The owner row id this observer belongs to; descriptive, never a lookup key. */
	readonly rowId: string;
	/** The row's own recorded backend. */
	readonly backend: NativeCliBackend;
	/**
	 * Deliver one COMPLETE observation of what this observer knows right now.
	 * Before this run's status capture exists — and after the run is retired — this
	 * claims nothing: it returns a rejection, never queues, retries, or replays.
	 */
	emit(observation: NativeStatusObservation): NativeStatusSubmitResult;
	/**
	 * Owner-private: this row's canonical workspace. The production manager always
	 * supplies it; it is optional only for direct callers of an observer factory.
	 */
	readonly workspace?: string;
	/**
	 * Owner-private: the exact admitted restart restoration conversation UUID,
	 * present only for a row created with a resume intent. It is an expectation to
	 * prove, never a proof.
	 */
	readonly resumeConversationId?: string;
	/**
	 * Owner-private IDENTITY channel (issue #277 restart restoration), separate from
	 * {@linkcode NativeStatusObserverContext.emit}: report the exact provider
	 * conversation UUID this source has positively proved is the run's CURRENT
	 * conversation, or an EXPLICIT `null` when a previously proved identity was
	 * lost while the run is live. A source must not report `null` merely because it
	 * has no proof yet, and an unknown busy/input/count status is never an identity
	 * loss. It is not a status value and proves nothing about persistence, idleness,
	 * input, or counts.
	 *
	 * The manager accepts it only through the same exact run fences as `emit`
	 * (current record and run, activated capture, same live PTY handle, process
	 * incarnation, and observer generation); before activation and after retirement
	 * it returns `false` and never queues, retries, or replays. A malformed id is
	 * refused. For a restoring row, until the expected id itself is proved, any other
	 * id is refused and an explicit `null` changes nothing. `true` means the identity
	 * was accepted.
	 */
	readonly emitConversationIdentity?: (conversationId: string | null) => boolean;
	/**
	 * Owner-private TITLE channel (issue #690), separate from
	 * {@linkcode NativeStatusObserverContext.emit} and from
	 * {@linkcode NativeStatusObserverContext.emitConversationIdentity}: report one
	 * actual provider conversation title the source positively read for one exact
	 * conversation it already proved and this owner accepted, or an explicit `null`
	 * when that conversation positively has no title any more. It is never a prompt,
	 * a summary, a first line, terminal text, or anything the host invented.
	 *
	 * The manager accepts it only under the same exact run fences as
	 * {@linkcode NativeStatusObserverContext.emitConversationIdentity}, and only for
	 * the conversation this row currently has proved and live: a title for another,
	 * unproved, or superseded conversation is refused. It is refused outright once the
	 * operator captioned the row, because their caption outranks any provider title.
	 * The accepted value is EPHEMERAL: it is never persisted, never becomes the
	 * roster's remembered display name, and is withdrawn when the conversation it was
	 * proved for is rebound or lost. `true` means the title was accepted.
	 */
	readonly emitConversationTitle?: (conversationId: string, title: string | null) => boolean;
	/**
	 * #682 owner-private, per-dispatch verdict channel: report, SYNCHRONOUSLY during
	 * the `acceptHook` dispatch of that very event, that one authenticated root
	 * `PreToolUse` of the conversation this row has proved and live was accepted as
	 * current root tool work (not refused as stale). It names that event's own
	 * `tool_use_id` and `tool_name`. The manager honors it only inside the matching
	 * dispatch, as evidence for its own one-use MCP correlation after a proved Claude
	 * `/clear`; outside one it changes nothing. `true` means it matched that dispatch.
	 */
	readonly emitRootToolRequest?: (conversationId: string, toolUseId: string, toolName: string) => boolean;
	/**
	 * #682 owner-private, NEGATIVE-only notification: the source admitted a
	 * same-session root boundary that reset its transcript scope without a new
	 * identity or `SessionStart`. The manager only discards the current post-clear
	 * successor's unconsumed correlations for that conversation; it never binds a
	 * scope or admits a call.
	 */
	readonly emitRootTranscriptRebound?: (conversationId: string) => void;
}

/**
 * The owner-supplied factory of one status observer per owned hosted run. It is
 * called only for a native CLI row this host armed, before that row's child
 * spawns, with the exact row id and backend and the run's own `emit` seam. It may
 * resolve asynchronously; an observer that arrives after its run was retired is
 * disposed and never bound, and can never write anything.
 */
export type NativeStatusObserverFactory = (
	context: NativeStatusObserverContext,
) => NativeStatusObserver | Promise<NativeStatusObserver>;

/**
 * #682: the trusted, owner-only view of ONE bound native Claude inbox for later wake
 * composition. It is never a view, wire, roster, status, or log shape. The
 * capability is the sender module's opaque branded handle (its hook token lives in a
 * private store and never serializes); it re-proves `isCurrent` on every send. The
 * same frozen object is returned for the life of one binding, and a fresh one for any
 * later binding, so an owner may key binding-scoped state to its identity.
 */
export interface NativeClaudeInboxSender {
	/** The exact conversation (Claude `session_id`) this inbox was proved for. */
	readonly conversationId: string;
	/** Opaque send capability for the sender module's `sendClaudeInboxMessage`; holds no readable secret. */
	readonly capability: ClaudeInboxSendCapability;
	/**
	 * Synchronous, side-effect-free re-proof of the same record, run, live PTY handle,
	 * process incarnation, observer generation, backend, canonical workspace, binding,
	 * and live accepted conversation. False once the binding is invalidated, for good.
	 */
	readonly isCurrent: () => boolean;
}

export interface InstanceManagerOptions {
	/** Already-built gate package root (owning dist/src/index.js). */
	packageRoot: string;
	/** Pi executable (already resolved and version-probed by resolveNativePi). */
	piExecutable: string;
	/** Per-instance status registrar (the future broker); rows are registered before spawn. */
	statusRegistrar: StatusRegistrar;
  /** Native setup is the production/default mode; false requires explicit test injection. */
  nativeSetup?: boolean;
  /** Structural setup preparer (legacy option name retained for compatibility). */
  profileRegistry?: ProfilePreparer;
	/** Native pi arguments snapshotted at construction and forwarded verbatim to each launch. */
	args?: readonly string[];
	/** Environment snapshotted at construction (or from process.env); caller originals are never mutated. */
	env?: NodeJS.ProcessEnv;
	/** Initial geometry shared by instances (default 80x24). */
	cols?: number;
	/** Initial geometry shared by instances (default 80x24). */
	rows?: number;
	/** Kitty keyboard flags support passed through to each terminal surface. */
	getSupportedKeyboardFlags?: () => number;
	/** Optional manager-wide graphics budget shared by every owned terminal surface. */
	graphicsBudget?: TerminalGraphicsBudget;
	/** Called with an instance id whenever that row changed (frontend hook). */
	onChange?: (instanceId: string) => void;
	/**
	 * Bounded xterm diagnostics from one row's terminal surface (#428), after
	 * its parse step. Payload-free of child bytes; exceptions are contained.
	 */
	onTerminalDiagnostic?: (instanceId: string, event: TerminalDiagnosticEvent) => void;
	/**
	 * Host routing for one verified native clipboard request observed on a row
	 * (#466). The manager forwards only the exact current row's live, unstopped
	 * request whose native conversation tuple still matches; the capsule and its
	 * encoded payload are never logged, rendered, or retained by this module.
	 */
	onNativeClipboard?: (instanceId: string, event: NativeClipboardEvent) => void;
	/**
	 * The owner-local route of one captured hosted provider TEXT copy, reached only
	 * when this manager's own last accepted input on that exact child incarnation was
	 * owner-local input. It carries no Pi conversation tuple, so it is deliberately a
	 * separate callback: the existing native Pi route stays exactly as it was and can
	 * never be fed a provider copy, and this route can never be fed a Pi copy. The
	 * host still owes its own live row, focus, display, and coverage proof before any
	 * clipboard request leaves it.
	 */
	onNativeCliClipboard?: (instanceId: string, event: NativeCliClipboardEvent) => void;
	/** Host-owned routing for reporter requests; the parent id is supplied by the manager, never by model input. */
	onSpawnRequest?: (parentInstanceId: string, request: SessionSpawnInput) => Promise<SessionSpawnOutcome>;
	/**
	 * Host-owned routing for ROUTED reporter requests (`host`/`kind` selectors).
	 * Supplying it is what makes each new registration advertise routed support.
	 * The parent id comes from the manager, and `parentStillCurrent` re-proves on
	 * every call that this exact parent registration is still live and current,
	 * so a host can fence a submission it is about to send.
	 */
	onRoutedSpawnRequest?: (
		parentInstanceId: string,
		request: SessionSpawnInput,
		parentStillCurrent: () => boolean,
	) => Promise<SessionSpawnOutcome>;
	/**
	 * The host's explicit declaration that {@link onRoutedSpawnRequest} honors the
	 * SessionSpawn `createWorkspace` option (issue #493). Only `true`, and only
	 * beside a routed handler, makes each registration declare it, so a child's
	 * bootstrap advertises creation support only when it is real. Absent or
	 * `false`: a creation request is refused before anything is staged or sent.
	 */
	routedSpawnCreateWorkspace?: boolean;
	/**
	 * The host's explicit declaration (#682) that {@link onRoutedSpawnRequest}
	 * re-reads its `parentStillCurrent` at the last admission of its OWN-HOST
	 * create (a request with no `host`), after any awaited eligibility wait and in
	 * the same synchronous stretch as the row the create posts. Only `true`, and
	 * only beside a routed handler, opens own-host SessionSpawn and own-host
	 * SessionHosts kinds to a native MCP lane. Absent or `false` (fail closed): a
	 * native lane's host-omitted request is refused before the handler runs and
	 * its inspection reports no own-host kind, while paired routing and discovery
	 * are unchanged. Pi registrations are unaffected either way.
	 */
	routedSpawnOwnHostParentProof?: boolean;
	/**
	 * Host-owned read-only SessionHosts discovery for one child registration.
	 * Forwarded to a registration ONLY together with
	 * {@link onRoutedSpawnRequest} (discovery without routed spawn would describe
	 * choices the child could never use), which is what makes that registration's
	 * bootstrap advertise discovery. The parent id comes from the manager, and
	 * `parentStillCurrent` re-proves on every call that this exact parent
	 * registration is still live and current; a parent that is not is refused
	 * before the handler runs. The handler only observes: it must not connect,
	 * pair, regrant, spawn, select, or focus anything.
	 */
	onSessionHostsRequest?: (
		parentInstanceId: string,
		context: SessionHostsRequestContext,
		parentStillCurrent: () => boolean,
	) => Promise<SessionHostsSnapshot>;
	/** Current hypothetical-visible sidebar title width; captured per row as advisory presentation metadata. */
	getSidebarTitleColumns?: () => number;
	/** PTY factory; defaults to the pinned real @lydell/node-pty (lazily loaded). */
	ptyFactory?: PtyFactory;
	/**
	 * Internal opt-in (default false) for the closed native input-framing mode.
	 * When true, every row's registration requests the closed bootstrap mode, the
	 * host frames EVERY byte it writes to that child's PTY with one encoder per
	 * registration, and it refuses to write anything until that exact
	 * registration's authenticated readiness arrives. Absent/false keeps the
	 * legacy behavior byte-for-byte: raw bytes forwarded, v1 capsules only, no
	 * readiness observed. This is not a user setting, a permission, or remote
	 * input: viewer input is admitted only through {@linkcode writeViewerInput} on a
	 * surface this host registered with its own run identity and its own copy sink,
	 * and an opaque origin alone is never a grant. Only native setup may request it
	 * — legacy private profiles and injected non-native preparers cannot frame by
	 * accident.
	 */
	nativeInputOriginFraming?: boolean;
	/**
	 * Host-injected launch provider for the native CLI backends (issue 277). It is
	 * required only when a row is created with a native backend; a manager without
	 * it keeps every existing Pi behavior and refuses a native creation before it
	 * posts a row. The manager never composes, repairs, or extends what the
	 * provider returns beyond validating it, and it never injects its own
	 * bootstrap, preload, startup-payload, or title environment into a native
	 * child.
	 */
	nativeCliLaunch?: NativeCliLaunch;
	/**
	 * OPTIONAL owner-supplied native status hook registrar
	 * (issue #277 native status owner slice). It is the broker's own
	 * `registerNativeHookSource` shape, and it is used for one thing only: issuing
	 * one launch's fresh native hook bootstrap BEFORE that launch's provider child
	 * exists, so the bootstrap can be handed to {@linkcode NativeCliLaunchRequest}
	 * and the row's own authenticated events can come back. It is never called for a
	 * Pi row, never called after a spawn, and never called when no observer factory
	 * was supplied. Absence (with no factory) is every existing manager and every
	 * existing launch: no registration, no hook option, no artifact, and every
	 * provider field on the row stays truthfully unknown.
	 */
	nativeHookRegistrar?: NativeHookSourceRegistrar;
	/**
	 * OPTIONAL owner-supplied factory of the per-run native status OBSERVER. It
	 * supplies the only reader of the row's hook events and the only writer of
	 * native status observations, and it is called only together with
	 * {@linkcode InstanceManagerOptions.nativeHookRegistrar}. Absence means no
	 * observer, no registration, and no observation path at all.
	 */
	nativeStatusObserverFactory?: NativeStatusObserverFactory;
	/**
	 * OPTIONAL trusted native MCP lane owner (#682). It requires the
	 * {@linkcode InstanceManagerOptions.nativeHookRegistrar}/{@linkcode
	 * InstanceManagerOptions.nativeStatusObserverFactory} pair, because a lane call
	 * is admitted only for the conversation that run's own observer proved. When
	 * present, each observed local native launch registers one broker MCP source
	 * BEFORE its child exists and forwards its bootstrap and the injected server name
	 * as {@linkcode NativeCliLaunchRequest.nativeMcp}. A registrar that throws or
	 * answers unusably, and a provider that declines or ignores the option, leave the
	 * launch exactly as it would otherwise be, with the lane revoked.
	 */
	nativeMcpLane?: NativeMcpLaneOwner;
	/**
	 * OPTIONAL explicit trusted-host opt-in (#682, default false) that binds a native
	 * Claude inbox send capability to a verified local Claude run. It is a
	 * construction-time property of this manager, never a user setting, wire field, or
	 * peer claim, and it requires the {@linkcode InstanceManagerOptions.nativeHookRegistrar}/
	 * {@linkcode InstanceManagerOptions.nativeStatusObserverFactory} pair.
	 *
	 * When true, each observed Claude launch asks its provider for the
	 * `claudeInboxCompatibility` receipt and registers the broker's existing
	 * `onClaudeInboxAnnouncement` owner callback. A capability exists only after ALL
	 * of: a `verified` receipt with a supported version; an authenticated root
	 * `SessionStart` of this exact run whose identity its current observer positively
	 * emitted, and this manager accepted, during that same dispatch (a silent return
	 * is never acceptance), whose provider `cwd` is the row's canonical workspace; the
	 * announcement of that same
	 * session; and a canonical, current-user-owned Unix socket endpoint. It is read
	 * only through {@linkcode InstanceManager.nativeClaudeInboxSender}; nothing is
	 * sent, routed, persisted, logged, or published by this manager. Absent or false
	 * is every existing manager and launch, byte for byte.
	 */
	nativeClaudeInbox?: boolean;
	/**
	 * #682: OPTIONAL scope of {@linkcode nativeClaudeInbox} to managed runs. When
	 * `true` (it requires `nativeClaudeInbox: true` and a `nativeMcpLane`), a Claude
	 * run asks for its compatibility receipt only when its own MCP lane registered,
	 * the provider is told to decline it without probing unless that launch's MCP
	 * option was prepared, and the run's inbox slot is revoked whenever its lane was
	 * not kept after the launch outcome. Absent or false keeps the standalone opt-in
	 * exactly as before.
	 */
	nativeClaudeInboxRequiresMcpLane?: boolean;
	/**
	 * OPTIONAL owner-supplied factory of one owned Codex backend process per owned
	 * Codex run (issue #277 owning-manager slice). It is consulted ONLY for a launch
	 * whose descriptor carries a {@linkcode NativeCliLaunchDescriptor.ownedCodex}
	 * plan, which only a provider constructed in owned mode produces; with that plan
	 * present and no factory here, the row is refused before any child of any kind
	 * exists, because a half-honored owned launch (a TUI attached to nothing owned)
	 * is exactly the substitution this path refuses.
	 *
	 * Absence is every existing host and every existing launch: no backend, no
	 * endpoint, no bearer, and no change to a Pi, Claude, or ordinary Codex row.
	 */
	ownedCodexBackendFactory?: OwnedCodexBackendFactory;
	/**
	 * #682 (Codex callback): OPTIONAL trusted-host opt-in to canonical managed
	 * outcome delivery into each owned Codex run's own root thread. It requires a
	 * `nativeMcpLane` and an `ownedCodexBackendFactory`. A Codex row whose MCP lane
	 * registered asks its provider for a version receipt; only a `verified`
	 * supported receipt, beside a kept lane and an owned plan, lets
	 * {@linkcode InstanceManager.nativeCodexCallbackSender} answer for that run.
	 * Absent or false keeps every launch and row exactly as before.
	 */
	nativeCodexCallback?: boolean;
}

/**
 * #682 (Codex callback): the trusted, owner-only sender of ONE owned Codex run's
 * canonical managed outcomes to its exact bound root thread. It is never a view,
 * wire, roster, status, or log shape and carries no lease, endpoint, or bearer.
 * The same frozen object is returned for the life of one lane, so an owner may
 * key run-scoped state to its identity.
 */
export interface NativeCodexCallbackSender {
	/** The bound provider conversation (the owned root thread id). */
	readonly conversationId: string;
	/** The exact owned backend lease this sender writes to; never reused by a successor. */
	readonly leaseId: string;
	readonly generation: number;
	/** The verified supported Codex CLI version of this launch's own receipt. */
	readonly version: string;
	/**
	 * Synchronous, side-effect-free re-proof of the same record, run, lane, live PTY
	 * incarnation, bound conversation, exact ready owned backend (not stopping or
	 * ended, root facts not withdrawn), receipt, and callback facts naming the same
	 * root thread. False for good once any of them falls.
	 */
	readonly isCurrent: () => boolean;
	/**
	 * One attempt through the landed transport and composer, re-proved at the write
	 * edge. Never rejects, never retries; `signal` adds the caller's cancellation to
	 * the lane's own revocation.
	 */
	readonly deliver: (request: {
		readonly clientUserMessageId: string;
		readonly text: string;
		readonly signal?: AbortSignal;
	}) => Promise<NativeCodexManagedDeliveryResult>;
}

export interface ShutdownOptions {
	/** Shared grace window for public shutdown request and POSIX SIGTERM fallback (default 8000 ms). */
	graceMs?: number;
	/** Confirmation window after forced owned-handle escalation (default 2000 ms). */
	killMs?: number;
}

/** Truthful outcome: forced = owned-handle force escalation was attempted; remaining = never confirmed exit. */
export interface ShutdownResult {
	readonly forcedIds: readonly string[];
	readonly remainingIds: readonly string[];
}

interface ManagedInstance {
	id: string;
	/**
	 * True only once THIS row's own asynchronous launch has positively
	 * finished. Initialized before any await and finalized in create()'s
	 * finally, so it distinguishes a completed, already-released failed launch
	 * from a row whose preparation or spawn is still in flight. It is never
	 * inferred from a missing PTY handle, a sibling's state, a status count, or
	 * the global create set.
	 */
	launchSettled: boolean;
	/**
	 * The row's display label. A Pi row's label is the last authenticated native
	 * conversation name (or a placeholder until one is observed). A native CLI
	 * row's label is the EFFECTIVE caption of that row: the operator's caption when
	 * they gave one, else the one actual provider conversation title this row's own
	 * source positively proved, else the stable provider label. The two contributing
	 * values are kept apart privately (see {@linkcode ManagedInstance.nativeCaption}
	 * and {@linkcode ManagedInstance.nativeConversationTitle}); this stays the ONE
	 * published field, so every surface that already transmits `label` carries the
	 * caption, a provider title, or the default without any new field or identity.
	 */
	label: string;
	nativeSession: SessionHostNativeSession | null;
	lastNativeSession?: SessionHostNativeSession;
	workspace: string;
	agentDir: string;
	lifecycle: InstanceLifecycle;
	/**
	 * The creation's explicit backend, or undefined for an unrecorded (Pi) row.
	 * Only ever `claude`/`codex` here: a Pi row keeps the unchanged launch path and
	 * needs no second marker.
	 */
	backend?: SessionBackend;
	/**
	 * Native CLI rows only: the exact launch-target id this row was launched with —
	 * the explicit operator target, or the backend's default target id. Owner-private
	 * restart identity; never in a view, wire frame, status value, or log.
	 */
	nativeCliTarget?: string;
	/**
	 * Native CLI rows only: the admitted restart restoration intent this row was
	 * created with. Immutable for the row; owner-private.
	 */
	nativeResumeConversationId?: string;
	/**
	 * Native CLI rows only: the last exact provider conversation UUID this host may
	 * durably remember for the row — the admitted resume intent until proof, then the
	 * last positively proved identity. It survives the child's exit, a stop, and an
	 * observer's retirement; only an accepted explicit live withdrawal clears it.
	 * Owner-private: never a Pi `sessionId`, status value, view field, or log line.
	 */
	nativeConversationId?: string;
	/**
	 * True once the restoring row's expected conversation was positively proved by
	 * its own live run (or, for a fresh row, once any identity was proved). Until
	 * then a restoring row accepts only its expected id.
	 */
	nativeConversationConfirmed?: boolean;
	/**
	 * True while a positively proved identity is active in the current live run; only
	 * then can an explicit `null` withdraw it.
	 */
	nativeConversationLive?: boolean;
	/**
	 * Native CLI rows only: the operator's own caption for this row, present from the
	 * moment one is EXPLICITLY accepted — before any comparison with the text the row
	 * already shows, so manual intent is a stored fact and never something inferred
	 * from a string match. While it is present it outranks any provider title and no
	 * automatic title can be accepted for the row.
	 *
	 * This is the durable half of the row's name: the host core remembers it as the
	 * slot's display name. It is never written to a provider, never a conversation
	 * rename, and never derived from provider text.
	 *
	 * A Codex SessionSpawn startup title (issue #493) is stored here too, exactly as
	 * requested and under the SessionSpawn title bound; the row's published `label`
	 * is then its bounded display projection, never a second stored copy.
	 */
	nativeCaption?: string;
	/**
	 * Native CLI rows only: this launch's owned file-backed startup prompt (issue
	 * #493). Created synchronously by this manager before the provider runs, so it
	 * is never hidden inside a pending provider promise. Its files stay until no
	 * child of this launch can still read them: the launch was abandoned before any
	 * child existed, or the child actually exited (and any required owned reader
	 * positively settled) and no owned Codex backend of this launch is unsettled.
	 */
	nativeInitialPrompt?: OwnedNativeInitialPrompt;
	/**
	 * Native CLI rows only: the one actual provider conversation title this row's own
	 * live source positively proved for its CURRENT proved conversation. EPHEMERAL by
	 * contract: never persisted, never the roster's remembered display name, never
	 * sent back to the provider, and withdrawn the moment the conversation it
	 * describes is rebound or lost. Absent means nothing was observed, which is not a
	 * claim that the provider has no title.
	 */
	nativeConversationTitle?: string;
	busy: boolean | null;
	pendingInput: boolean | null;
	inputSurface: boolean;
	backgroundTasks: number | null;
	backgroundShells: number | null;
	activeTasks: number | null;
	activeShells: number | null;
	/** Automatic fresh-census attempt budget for the CURRENT unknown episode. */
	activityRefreshAttempts: number;
	activityRefreshEpisodeOpen: boolean;
	/** Bumped on every accepted status, fencing out-of-date refresh failures. */
	statusRevision: number;
	activity: string[];
	exitCode?: number;
	error?: string;
	profile?: PreparedProfile;
	profileReleased: boolean;
	/**
	 * True only once this row's profile admission release positively returned
	 * (or there was none to release). Distinct from profileReleased, which is
	 * only an idempotency latch set before the external call: a throwing release
	 * leaves this false so removal stays fail closed.
	 */
	profileReleaseSettled: boolean;
	/**
	 * Synchronous saved-session creation reservation (issue 323): set before
	 * any await in create() and released only when creation definitively failed
	 * before a child exists or the exact owned PTY actually exited — never on
	 * an acknowledgement, unknown state, or reporter disconnect.
	 */
	savedReservation?: { readonly sessionId: string; readonly file: string };
	/**
	 * Last-observed CURRENT native conversation id, kept privately for
	 * duplicate fencing across status disconnects. Replaced only by a newer
	 * observed binding (native /new or /resume); never a UI badge.
	 */
	knownNativeSessionId?: string;
	/** Fresh current-file observation only; revoked on every unavailable binding/disconnect. */
	currentNativeSessionFile?: string;
	registration?: InstanceStatusRegistration;
	registrationReleased: boolean;
	/**
	 * Identity-checked ownership of the child's staged startup request. Retained
	 * until this row's registration settles (confirmed exit or definite
	 * pre-spawn failure), then discarded before the broker namespace release.
	 */
	startupPayload?: StagedSessionHostPayload;
	/**
	 * True only once this row's registration release positively returned (or
	 * there was none to release). Distinct from registrationReleased, which is
	 * only an idempotency latch set before the external call: a throwing release
	 * leaves this false so removal stays fail closed.
	 */
	registrationReleaseSettled: boolean;
	surface?: TerminalSurface;
	pty?: InstancePty;
	ptyExited: boolean;
	/**
	 * Canonical content geometry of this row (#474): the size its PTY and terminal
	 * surface actually have (or will have at spawn). Only the manager changes it,
	 * through an addressed per-row change or a host-wide resize.
	 */
	cols: number;
	rows: number;
	/** Bumped on every accepted geometry change; stale interaction is fenced on it. */
	geometryRevision: number;
	/**
	 * True only when THIS registration's own bootstrap carries the closed
	 * input-framing mode. Set once at registration and never again.
	 */
	inputFramingRequested: boolean;
	/**
	 * Set once, and only by this registration's own verified readiness capsule
	 * while this exact record still owns a live, unreleased, un-stopping child.
	 * Never inherited across a restart, release, exit, or another row.
	 */
	inputFramingReady: boolean;
	/**
	 * Sticky per-registration startup-phase fact (issue 389). Set once, only when a
	 * correctly framed registration is recorded, and cleared for good at this
	 * registration's first ACCEPTED status (even one with a null tuple), a reporter
	 * disconnect or reconnect, registration release, a stop that closes admission,
	 * the child's exit, and manager stop/disposal. It never reopens within one
	 * process incarnation, and it is never inferred from a missing tuple.
	 */
	startupInputOpen: boolean;
	/**
	 * One encoder per registration, created from this registration's own
	 * bootstrap before the child spawned. Never reset on reporter reconnect or
	 * extension reload; a new child/registration gets a new encoder.
	 */
	inputEncoder?: NativeInputEncoder;
	/**
	 * Owner-private secret of THIS row's current provider-child process incarnation
	 * (issue 277 native remote-input slice). Minted once, right before the owned PTY
	 * is spawned, and never exposed: it appears in no view, no wire frame, no token,
	 * and no log. It is the key material of the `nvcli1` viewer input scope
	 * commitment, so a replacement child — even one with the same row id, workspace,
	 * backend, geometry, and PID after reuse — yields a different token and every
	 * source minted for the old incarnation becomes stale. Cleared at the child's
	 * confirmed exit, which is also when the row stops being an input target.
	 */
	nativeCliIncarnation?: Buffer;
	/**
	 * What THIS hosted provider row's own observer has positively declared about the
	 * sidebar categories it can and cannot report (native status slice). Absence means
	 * no declaration at all, which is the legacy unknown path — never not-applicable.
	 *
	 * It is a capability statement, not an observation: an invalidation, an observer
	 * failure, and the child's own exit all clear the OBSERVED values to unknown while
	 * this declaration stays, because "this backend cannot report background shells"
	 * does not stop being true when the observer loses its footing. It is never
	 * inferred from a missing value, a quiet PTY, or this host's own configuration, and
	 * it carries no observed value of its own.
	 */
	nativeStatusSupport?: NativeStatusSupportMap;
	/**
	 * Private status-observer generation, independent of the input/clipboard run
	 * incarnation. A capture is minted against the value current at mint time, and an
	 * accepted invalidation advances it, which retires every capture of the failed
	 * generation: a callback that was queued before the failure can never write again,
	 * while recovery acquires a fresh capture. Nothing else reads or advances it, and
	 * it never becomes a status registration or a second ownership source.
	 */
	nativeStatusObserverGeneration: number;
	/**
	 * Owner-private routing convention of THIS row's current provider-child incarnation
	 * (issue 277 native text-copy slice): the most recent ACTUAL accepted nonempty
	 * input forwarded to that PTY, either owner-local or one viewer's verified input.
	 *
	 * It is set only when bytes really left this manager for that child — never by a
	 * selected form, a refused or rejected request, a received copy request, or a
	 * terminal protocol query/reply — and it is dropped with the incarnation itself.
	 * It states who this manager last typed for, which is a routing choice and NOT
	 * proof of which action caused a later copy; nothing in a child's output can
	 * confirm or change it. Absent means no origin is known, which is a refusal, never
	 * a fallback to some other viewer or the owner.
	 */
	nativeCliController?: NativeCliCopyController;
	/**
	 * Monotonic owner ordinal of accepted nonempty input on this incarnation, starting
	 * at 0. Each accepted input takes the next value, and a copy frozen at acceptance
	 * carries the ordinal of the input that established its recipient.
	 */
	nativeCliInputOrdinal: number;
	/**
	 * The owner-side OPTIONAL native status source of THIS row's current provider
	 * child (issue #277 native status owner slice): the broker registration issued
	 * before the child existed, the host's per-run observer, the one status capture
	 * minted after the spawn, and the private artifacts the launch preparation staged
	 * for them. Absence means this host armed no status source (or this launch
	 * declined to arm one): the row keeps every existing native behavior, and its
	 * provider fields stay truthfully unknown. It is replaced only together with the
	 * row's process incarnation, and retired by stop, removal, exit, spawn failure,
	 * or manager disposal.
	 */
	nativeStatusRun?: OwnedNativeStatusRun;
	/**
	 * The ONE owned Codex backend resource of THIS row's current provider child
	 * (issue #277 owning-manager slice): the lease this manager retains from the
	 * moment its factory answers until that backend's own positive settlement.
	 *
	 * It is ownership of a second process, not a second observation: the row's
	 * `hasLiveProcess`, its removability, and this run's staged private files all
	 * stay closed while it is unsettled, and no other row can reach it. Absence means
	 * this launch carried no owned plan, which is every existing row.
	 */
	nativeCodexBackend?: OwnedNativeCodexBackendResource;
	/**
	 * Per-row owned-backend generation: the value minted for this row's next owned
	 * backend, consumed once per backend. A row owns one backend per process
	 * incarnation, so today this advances at most once per row; it exists so an
	 * identity never depends on a row id alone.
	 */
	nativeCodexBackendGeneration?: number;
	/**
	 * True from the instant a native CLI row exists until its launch settles, i.e. while
	 * no process of this launch can have been created yet. It is what makes that window
	 * stoppable for an owned-capable Codex row, and it is cleared on every launch path so
	 * a settled row is never "cancellable" again.
	 */
	nativeCliLaunchPending?: boolean;
	/**
	 * The row-level cancellation notification a confirmed Stop publishes while this row's
	 * launch is still awaiting its provider. The launch races it, exactly as it races the
	 * manager's shutdown notice, so a stopped row is answered immediately and a provider
	 * that answers later can create nothing.
	 */
	launchCancel?: Promise<void>;
	resolveLaunchCancel?: () => void;
	/** Spawn admission closes while an idle preflight or confirmed Stop is unresolved. */
	stopAdmissionClosed: boolean;
	sigtermSent: boolean;
	sigkillSent: boolean;
	stopPromise?: Promise<boolean>;
	exitWaiters: (() => void)[];
	dataDisposable?: { dispose(): void };
	exitDisposable?: { dispose(): void };
	readErrorDisposable?: { dispose(): void };
}

/**
 * The manager's own ownership record of one optional native status source for one
 * owned hosted provider run (issue #277 native status owner slice).
 *
 * It is minted BEFORE the provider child exists (so the broker registration can
 * precede the spawn and its bootstrap can travel to the launch provider), bound to
 * the exact live run only after the synchronous spawn stretch, and retired exactly
 * once by the first of: the child's own exit, a stop, the row's removal, a failed
 * spawn, or manager disposal.
 *
 * The owner lifecycle token is this record's own object identity: the row's
 * `nativeStatusRun` slot is the one authority on whether it is current, so every
 * callback, factory answer, and asynchronous continuation re-checks
 * `record.nativeStatusRun === run` (and `retired`). A replacement child, a re-armed
 * row, or a detached row therefore makes anything carrying an older run claim
 * nothing — it is never queued, retried, or replayed, and it can never touch
 * another row.
 */
interface OwnedNativeStatusRun {
	readonly rowId: string;
	readonly backend: NativeCliBackend;
	/** The broker registration issued for THIS launch, or absent if it never armed. */
	registration?: NativeHookRegistration;
	/**
	 * The fresh bootstrap issued for exactly this launch and this backend. It is the
	 * ONLY thing this manager hands to the launch provider through
	 * {@linkcode NativeCliLaunchRequest.nativeHook}; a row with no bootstrap was never
	 * armed, and its provider receives no hook option at all.
	 */
	bootstrap?: NativeHookBootstrap;
	/** The host's observer for this run, once its factory has answered. */
	observer?: NativeStatusObserver;
	/**
	 * The ONE status capture of this run, minted after the spawn from the exact live
	 * PTY handle and process incarnation, and never reminted for this run. Absent
	 * means the run never activated, so nothing it reports can land.
	 */
	capture?: NativeStatusCapture;
	/**
	 * The exact facts the ONE capture above was minted against: this row's live PTY handle
	 * at activation, that incarnation's private key, and the observer generation the
	 * capture closed over. An accepted invalidation retires that generation while leaving
	 * the handle in place, so remembering the three is what lets a later delivery prove its
	 * capture is still the current one instead of merely non-undefined.
	 */
	capturePty?: InstancePty;
	captureIncarnation?: Buffer;
	captureGeneration?: number;
	/**
	 * The private artifacts this launch's hook preparation staged, retained until this
	 * run's own settlement. Absent means nothing was staged (or it was already
	 * released), which is also the case for every declined or unprepared launch.
	 */
	lease?: NativeHookArtifactLease;
	/**
	 * This run's OPTIONAL native MCP lane (#682), armed with the run before the spawn.
	 * Its callbacks retire with the run; it never outlives it.
	 */
	mcpLane?: OwnedNativeMcpLane;
	/**
	 * The private artifacts this launch's MCP preparation staged. Same ownership and
	 * release rule as {@linkcode OwnedNativeStatusRun.lease}: retained until this run's
	 * own settlement (or abandonment), released at most once with it.
	 */
	mcpLease?: NativeMcpArtifactLease;
	/**
	 * This run's OPTIONAL native Claude inbox slot (#682), armed with the run before
	 * the spawn. It is revoked with the run's callbacks and never outlives them.
	 */
	claudeInbox?: OwnedNativeClaudeInbox;
	/**
	 * The required reader settlement of this run's exact PTY handle, when that handle
	 * is a real Windows ConPTY child whose reader this manager owns. A staged artifact
	 * the child was told to read stays while such a reader is still draining, and a
	 * confirmation that never arrives preserves it rather than pretending.
	 */
	readerSettlement?: OwnedConptyReaderSettlement;
	/**
	 * True once this launch is known to be abandoned: NO child of it can ever exist,
	 * which is the only condition under which staged private files may be released
	 * without waiting for a settlement. Retirement of the OBSERVATION SOURCE is not
	 * abandonment — a run whose observer or registration was released can still own a
	 * child that is reading those files.
	 */
	abandoned: boolean;
	/** True once this run's static applicability declaration has been published. */
	supportPublished: boolean;
	/** True once this run is retired: no callback, observer, or capture may act. */
	retired: boolean;
	/** True once this run's status capture has been minted. */
	activated: boolean;
	/** True once this run's staged artifacts were released (or none existed). */
	artifactsReleased: boolean;
}

/**
 * The manager's record of one run's native MCP lane (#682). The lane's object
 * identity is its lifecycle token: the run's `mcpLane` slot, the run's own fences,
 * and `revoked` decide whether a call may reach the owner delegate. Revocation is
 * terminal — the broker registration is released, in-flight calls are aborted, and
 * no rebinding, retry, or replay exists.
 *
 * The lane is the ONE authenticated transport of its launch; the conversation it
 * serves is a separate {@linkcode OwnedNativeMcpLaneScope}. Exactly one transition
 * replaces that scope without revoking the transport: a proved Claude `/clear`
 * (see {@linkcode NativeMcpClearTransition}). Every other conversation change, loss,
 * or unproved transition revokes the whole lane as before.
 */
interface OwnedNativeMcpLane {
	/** The row's canonical workspace when the lane was armed; re-proved on every call. */
	readonly workspace: string;
	/** Aborted once at revocation. */
	readonly controller: AbortController;
	/** The broker registration of THIS launch, until revocation. */
	registration?: NativeMcpRegistration;
	/**
	 * True for a Codex lane: its relay and conversation live in the run's OWNED
	 * app-server backend, so a live TUI alone proves nothing and the exact ready
	 * backend that was current at binding must still be running.
	 */
	readonly requiresOwnedBackend: boolean;
	/** The exact owned backend captured when the lane bound; re-proved on every call. */
	ownedBackend?: OwnedNativeCodexBackendResource;
	/**
	 * The lane's current conversation scope: set once from the first accepted proof,
	 * and replaced only by the successor of a proved Claude `/clear`.
	 */
	scope?: OwnedNativeMcpLaneScope;
	/** True once any scope was opened; the pre-proof catalog never answers after that. */
	everBound: boolean;
	/**
	 * Every conversation any scope of this lane ever served, for the transport's whole
	 * lifetime: a clear may never reopen one of them. Bounded; a clear that would
	 * exceed the bound is not recovered.
	 */
	readonly retiredConversations: Set<string>;
	/**
	 * Every tool-use id a post-clear correlation of this lane ever recorded, consumed,
	 * or invalidated, for the transport's whole lifetime: none is ever admitted again.
	 * Bounded; reaching the bound revokes the lane rather than forgetting any.
	 */
	readonly spentToolUseIds: Set<string>;
	/** The root `PreToolUse` being dispatched to the observer right now, if any. */
	toolDispatch?: NativeMcpToolDispatch;
	/**
	 * Present only between an accepted root `SessionEnd(reason=clear)` of the current
	 * scope and the exact successor `SessionStart(source=clear)` that opens the next.
	 * While present the lane has NO current scope, so every request is refused.
	 */
	clear?: NativeMcpClearTransition;
	revoked: boolean;
}

/**
 * One conversation scope of a native MCP lane (#682). Its object identity is the
 * scope's lifecycle token: a call admitted under it stays current only while it is
 * still the lane's scope and has not ended. Ending is terminal for the scope.
 */
interface OwnedNativeMcpLaneScope {
	/** The one provider conversation this scope serves. */
	readonly conversationId: string;
	/** Aborted once when this scope ends (a proved clear, or the lane's revocation). */
	readonly controller: AbortController;
	/**
	 * The scope's one exact-run object, created at its first proved call and handed to
	 * every later call of this scope unchanged; a successor scope gets a new one.
	 */
	runScope?: NativeMcpLaneRunScope;
	/**
	 * Present only for a scope opened by a proved Claude `/clear`: every `tools/call`
	 * must consume one exact correlation recorded from this conversation's own
	 * authenticated root `PreToolUse`, and discovery is metadata-only.
	 */
	readonly successor?: NativeMcpClearSuccessor;
	/**
	 * For a successor scope: the broker's opaque identity of the ONE authenticated
	 * relay connection that was live across the clear. The scope is current only
	 * while that exact connection still is.
	 */
	readonly connection?: object;
	ended: boolean;
}

/** The one-use correlation ledger of a post-clear successor scope (#682). */
interface NativeMcpClearSuccessor {
	/** Unconsumed correlations by provider tool-use id, in insertion order. */
	readonly pending: Map<string, NativeMcpClearCorrelation>;
}

interface NativeMcpClearCorrelation {
	/** The exact bare MCP tool name the authenticated `PreToolUse` named for this server. */
	readonly toolName: string;
	/** The `PreToolUse` event's own `prompt_id`, when it carried one. */
	readonly promptId: string | undefined;
	/** Monotonic deadline after which the correlation is stale. */
	readonly expiresAt: number;
}

/** One root `PreToolUse` in dispatch, and whether the observer positively accepted it. */
interface NativeMcpToolDispatch {
	readonly sessionId: string;
	readonly toolUseId: string;
	readonly toolName: string;
	accepted: boolean;
}

/**
 * The accepted first half of a Claude `/clear` on one lane (#682): the root
 * `SessionEnd(reason=clear)` of the current scope's own conversation was
 * authenticated and the old scope already ended. Only the exact root
 * `SessionStart(source=clear)` that the run's observer accepts may open the next
 * scope; anything else revokes the lane.
 */
interface NativeMcpClearTransition {
	readonly endedConversationId: string;
	/** The broker's identity of the authenticated relay connection live at the end. */
	readonly connection: object;
	/** True only during the `SessionEnd(clear)` dispatch itself. */
	endDispatch: boolean;
	/** True once the observer positively withdrew the ended identity in that dispatch. */
	endAccepted: boolean;
	/** The successor session id, only during its exact `SessionStart(clear)` dispatch. */
	startSessionId?: string;
}

/**
 * The manager's record of one Claude run's native inbox slot (#682). The slot's
 * object identity is its lifecycle token: the run's `claudeInbox` slot, the run's own
 * fences, and `revoked` decide whether a binding may exist. Revocation is terminal.
 * It never stores the hook token: that stays inside the broker's opaque candidate
 * until the sender module's opaque capability takes it.
 */
interface OwnedNativeClaudeInbox {
	/** The row's canonical workspace when the slot was armed; re-proved on every use. */
	readonly workspace: string;
	/** The exact supported CLI version from this launch's own `verified` receipt. */
	version?: string;
	/**
	 * The root `SessionStart` this run's current observer accepted in the SAME
	 * authenticated dispatch that may carry an announcement. Every routed event or
	 * failure replaces or clears it, and an announcement consumes it.
	 */
	pendingRootStart?: PendingClaudeInboxRootStart;
	/**
	 * Present only while one root `SessionStart` is being dispatched to the observer:
	 * the identity channel records here the conversation it ACCEPTED during that exact
	 * dispatch. That positive emission is the only per-event verdict the observer
	 * gives; a silent return (for example a deduplicated repeat) is never acceptance,
	 * and an identity cached from an earlier event never stands in for it.
	 */
	dispatch?: ClaudeInboxStartDispatch;
	/** The current binding attempt or bound sender, if any. */
	binding?: OwnedNativeClaudeInboxBinding;
	revoked: boolean;
}

interface ClaudeInboxStartDispatch {
	acceptedConversationId?: string;
}

interface PendingClaudeInboxRootStart {
	readonly sessionId: string;
	readonly cwd: string;
	readonly generation: number;
}

interface OwnedNativeClaudeInboxBinding {
	readonly sessionId: string;
	/** Fresh opaque correlation id for this binding; never the row id. */
	readonly launchId: string;
	/** Present once the endpoint was captured and the capability minted. */
	sender?: NativeClaudeInboxSender;
	/** True once dropped; never false again. */
	dropped: boolean;
}

/**
 * This manager's private record of ONE in-flight proved lane call (#682): the
 * exact record, run, lane, and bound conversation the frozen context was issued
 * for, and that call's own fence. It is keyed by the exact context object this
 * manager issued, so a structurally identical context — copied, forged, or
 * issued by another manager — never finds it, and it is dropped when the call
 * settles, so a retained context can never acquire authority later.
 */
interface NativeMcpLaneCallBinding {
	readonly record: ManagedInstance;
	readonly run: OwnedNativeStatusRun;
	readonly lane: OwnedNativeMcpLane;
	/** The exact conversation scope this call was admitted under. */
	readonly scope: OwnedNativeMcpLaneScope;
	readonly conversationId: string;
	/** The exact-run scope handed to this call; the owner identity echoes it. */
	readonly runScope: NativeMcpLaneRunScope;
	/** This call's combined request/lane signal. */
	readonly signal: AbortSignal;
	/** The same re-proof as the issued context's `isCurrent`. */
	readonly isCurrent: () => boolean;
	/** False once the call settled; never true again. */
	active: boolean;
}

/**
 * The manager's ownership record of one owned Codex backend process (issue #277
 * owning-manager slice).
 *
 * The owner lifecycle token is this record's own object identity: the row's
 * `nativeCodexBackend` slot says whether it is current, and `retired` says whether
 * this manager still expects the run to reach a TUI. Every asynchronous
 * continuation — a readiness answer, a settlement answer, an observer that arrived
 * late — re-checks both, so a retired, replaced, stopped, or disposed run can never
 * spawn or adopt a child.
 *
 * Retirement is a stop INTENT and never a settlement: `settled` is set only by the
 * lease's own positive settlement, which requires that exact child's genuine exit
 * and both captured readers' natural end. An unsettled resource keeps the row live
 * for every authority that asks, however long it takes.
 */
interface OwnedNativeCodexBackendResource {
	readonly rowId: string;
	readonly identity: OwnedCodexBackendLaunchIdentity;
	readonly lease: OwnedCodexBackendLease;
	/** Aborted once at retirement, so a factory that honors it cancels startup too. */
	readonly controller: AbortController;
	/**
	 * Fulfilled once at retirement, for the SAME reason {@linkcode
	 * OwnedNativeCodexBackendResource.controller} exists but for a different consumer:
	 * a stop, removal, or disposal that lands while this backend's readiness is pending
	 * must unblock the launch that is waiting on it. A lease whose banner never arrives
	 * cannot make a stopped row unanswerable, and racing this promise is what turns
	 * "the row was stopped" into a finished launch instead of a hung one.
	 */
	readonly cancel: Promise<void>;
	readonly resolveCancel: () => void;
	/**
	 * The one observation source of this backend, minted from the fulfilled readiness
	 * value and handed to this run's observer as-is. Never published anywhere else.
	 */
	observationSource?: NativeOwnedCodexBackendObservationSource;
	/** True only after THIS lease's readiness fulfilled. */
	ready: boolean;
	/** True only after THIS lease's own positive settlement. */
	settled: boolean;
	/** True once the single observer delivery happened (or was refused as stale). */
	observationDelivered: boolean;
	/** True once retirement was requested: no TUI of this launch may exist. */
	retired: boolean;
}

/**
 * Reads the native hook preparation outcome a launch provider attached to its own
 * descriptor. Anything unrecognized is `undefined`, which the manager treats as
 * "this launch said nothing": the row keeps its unchanged interactive launch and
 * its truthfully-unknown provider status. A `prepared` outcome is only honored
 * when it carries a usable artifact lease, since that lease is the manager's only
 * route to the private files the child was told to read.
 */
function readNativeHookLaunchOutcome(value: unknown): NativeHookLaunchOutcome | undefined {
	if (!isPlainRecord(value)) {
		return undefined;
	}
	const outcome = value as { readonly nativeHook?: unknown };
	const hook = outcome.nativeHook;
	if (!isPlainRecord(hook) || typeof hook.observation !== "string") {
		return undefined;
	}
	if (hook.observation === "prepared") {
		const lease = hook.lease;
		if (!isPlainRecord(lease) || typeof lease.cleanup !== "function") {
			return undefined;
		}
		return hook as unknown as NativeHookLaunchOutcome;
	}
	if (hook.observation === "unavailable") {
		return hook as unknown as NativeHookLaunchOutcome;
	}
	return undefined;
}

/**
 * Reads the native MCP preparation outcome a launch provider attached to its own
 * descriptor. Anything unrecognized is `undefined`. A `prepared` outcome is only
 * honored when it carries a usable artifact lease.
 */
function readNativeMcpLaunchOutcome(value: unknown): NativeMcpLaunchOutcome | undefined {
	if (!isPlainRecord(value)) {
		return undefined;
	}
	const mcp = (value as { readonly nativeMcp?: unknown }).nativeMcp;
	if (!isPlainRecord(mcp)) {
		return undefined;
	}
	if (mcp.mcp === "prepared") {
		const lease = mcp.lease;
		return isPlainRecord(lease) && typeof lease.cleanup === "function"
			? mcp as unknown as NativeMcpLaunchOutcome
			: undefined;
	}
	return mcp.mcp === "unavailable" ? mcp as unknown as NativeMcpLaunchOutcome : undefined;
}

/**
 * #682: the Claude CLI versions on which the `/clear` MCP recovery sequence was
 * proved end to end (same MCP stdio connection across `/clear`; authenticated root
 * `SessionEnd(reason=clear, old id)` then root `SessionStart(source=clear, new id)`;
 * `_meta["claudecode/toolUseId"]` equal to the root `PreToolUse` `tool_use_id`
 * before and after the clear). A run whose own verified launch receipt names any
 * other version — or carries none — keeps terminal revocation at `/clear`.
 */
export const NATIVE_MCP_CLAUDE_CLEAR_RECOVERY_CLI_VERSIONS: readonly string[] = Object.freeze(["2.1.330"]);

/** How long one post-clear `PreToolUse` correlation stays usable (covers a provider approval prompt). */
export const NATIVE_MCP_CLEAR_CORRELATION_TTL_MS = 10 * 60_000;

/** Unconsumed post-clear correlations one scope holds; the oldest is dropped beyond it. */
export const NATIVE_MCP_CLEAR_MAX_PENDING_CORRELATIONS = 16;

/**
 * Spent tool-use ids one lane remembers against replay for its whole transport
 * lifetime. Nothing is ever forgotten: reaching the bound revokes the lane.
 */
export const NATIVE_MCP_CLEAR_MAX_SPENT_CORRELATIONS = 4096;

/**
 * Conversations one lane may have served across clears. A clear that would exceed
 * it is not recovered (the lane is revoked), so no retired id is ever forgotten.
 */
export const NATIVE_MCP_CLEAR_MAX_CONVERSATIONS = 64;

function nativeMcpClearNow(): number {
	return nativeMcpClearClockForTests?.() ?? performance.now();
}

/**
 * #682: the exact supported CLI version from one descriptor's `verified` Claude inbox
 * compatibility receipt, or `undefined` for anything else (absent, declined,
 * malformed, or a version the sender does not support).
 */
function readClaudeInboxCompatibilityVersion(value: unknown): string | undefined {
	if (!isPlainRecord(value)) {
		return undefined;
	}
	const outcome = (value as { readonly claudeInboxCompatibility?: unknown }).claudeInboxCompatibility;
	if (!isPlainRecord(outcome) || outcome.compatibility !== "verified") {
		return undefined;
	}
	const version = outcome.version;
	return typeof version === "string" && CLAUDE_INBOX_SUPPORTED_CLI_VERSIONS.includes(version) ? version : undefined;
}

/**
 * #682: capture the identity of one announced Claude inbox endpoint, or `undefined`.
 * The path must already be canonical (its realpath is itself), name a Unix socket
 * owned by the current user on a supported platform, and keep the same device/inode
 * across the canonicality check. The sender re-proves this identity and its protected
 * namespace before every send; this capture only pins which endpoint that is. It
 * never connects, never logs, and never throws.
 */
async function captureClaudeInboxEndpoint(socketPath: string): Promise<ClaudeInboxEndpointIdentity | undefined> {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid === undefined || !CLAUDE_INBOX_SUPPORTED_PLATFORMS.includes(process.platform)) {
		return undefined;
	}
	try {
		const before = await lstatAsync(socketPath, { bigint: true });
		if (!before.isSocket() || before.uid !== BigInt(uid)) {
			return undefined;
		}
		if (await realpathAsync(socketPath) !== socketPath) {
			return undefined;
		}
		const after = await lstatAsync(socketPath, { bigint: true });
		if (!after.isSocket() || after.uid !== before.uid || after.dev !== before.dev || after.ino !== before.ino) {
			return undefined;
		}
		return { dev: after.dev, ino: after.ino, uid };
	} catch {
		return undefined;
	}
}

/** One launch's owned startup prompt lease and the facts its release depends on. */
interface OwnedNativeInitialPrompt {
	readonly lease: NativeInitialPromptLease;
	/** True once no child of this launch can ever exist. */
	abandoned: boolean;
	/** True once release was decided; the lease's own cleanup runs at most once. */
	released: boolean;
	/** The spawned handle's required owned reader, recorded in the spawn stretch. */
	readerSettlement?: OwnedConptyReaderSettlement;
}

/**
 * Whether this row still owns an owned Codex backend whose settlement is not yet
 * proven. It is the one authority on that question, and it is deliberately not
 * inferred from the row's PTY: the TUI client exiting says nothing about the
 * backend process this manager started, and vice versa.
 */
function ownsUnsettledCodexBackend(record: ManagedInstance): boolean {
	const backend = record.nativeCodexBackend;
	return backend !== undefined && !backend.settled;
}

/**
 * The three answers this manager can have about a descriptor's owned Codex plan, and the
 * distinction is the whole point: **absence** is every ordinary launch (spawn exactly what
 * the provider composed, with no backend, endpoint, or bearer anywhere), while a **present
 * value this manager cannot consume** is a provider that claimed an owned launch and
 * attached something broken to it. Treating the second like the first would spawn the
 * standalone descriptor behind an owned request — the substitution this path exists to
 * refuse — so a malformed plan is refused instead, before either factory is called.
 */
type OwnedCodexPlanReading
	= { readonly state: "absent" }
	| { readonly state: "malformed" }
	| { readonly state: "plan"; readonly plan: NativeCodexOwnedLaunchPlan };

/**
 * Read the owned Codex backend plan a launch provider attached to its own descriptor.
 *
 * Only a plan this module can actually consume counts as one: the two renderers and the
 * backend base environment are what the owned path needs. A field that is not there at all
 * is `absent`; anything else that is present — `null`, a non-object, a partial object, a
 * non-function renderer, or a non-object base environment — is `malformed`. The value is
 * never read further, echoed, or carried anywhere.
 */
function readNativeCodexOwnedPlan(value: unknown): OwnedCodexPlanReading {
	if (!isPlainRecord(value)) {
		return { state: "absent" };
	}
	const plan = (value as { readonly ownedCodex?: unknown }).ownedCodex;
	if (plan === undefined) {
		return { state: "absent" };
	}
	if (!isPlainRecord(plan)
		|| typeof plan.renderBackend !== "function"
		|| typeof plan.renderTui !== "function"
		|| !isPlainRecord(plan.backendEnv)) {
		return { state: "malformed" };
	}
	return { state: "plan", plan: plan as unknown as NativeCodexOwnedLaunchPlan };
}

/**
 * Whether one launch-provider rejection is the provider's OWN typed owned-profile
 * refusal, recognized by its published closed code alone. The exception object is
 * never read further and never carried: this is a routing decision, not a message.
 */
function isOwnedCodexProfileRefusal(error: unknown): boolean {
	return isPlainRecord(error)
		&& (error as { readonly code?: unknown }).code === NATIVE_CODEX_OWNED_PROFILE_UNSUPPORTED_CODE;
}

/**
 * Whether one factory answer is the lease this manager can actually own: the four
 * members this module depends on, and the identity it minted for THIS launch. A
 * lease for another id or generation is a foreign object and is refused before any
 * continuation is attached, so a stale or mis-built answer can never be adopted.
 */
function isUsableOwnedCodexBackendLease(value: unknown, identity: OwnedCodexBackendLaunchIdentity): value is OwnedCodexBackendLease {
	if (!isPlainRecord(value)) {
		return false;
	}
	const lease = value as {
		readonly identity?: unknown;
		readonly readiness?: unknown;
		readonly settlement?: unknown;
		readonly status?: unknown;
		readonly requestStop?: unknown;
	};
	const leaseIdentity = lease.identity;
	return isPlainRecord(leaseIdentity)
		&& leaseIdentity.leaseId === identity.leaseId
		&& leaseIdentity.generation === identity.generation
		&& isThenable(lease.readiness)
		&& isThenable(lease.settlement)
		&& typeof lease.status === "function"
		&& typeof lease.requestStop === "function";
}

/** Whether a value is a promise-like this manager can attach handlers to. */
function isThenable(value: unknown): boolean {
	return (typeof value === "object" && value !== null || typeof value === "function")
		&& typeof (value as { readonly then?: unknown }).then === "function";
}

/**
 * Whether this exact row's owned force escalation was attempted, for the existing
 * `stop().forced` and `shutdown().forcedIds` reports only.
 *
 * Two independent owned handles can be escalated: the row's PTY (`sigkillSent`, whose
 * PTY-only meaning the stop ladder relies on and which this never sets) and the row's
 * own retained backend resource, whose lease reports a sticky force bit immediately
 * before its owned SIGKILL attempt. The resource is this record's one backend slot,
 * so another row's or another incarnation's lease can never contribute. This is
 * historical evidence only — never exit, reader, settlement, or liveness proof.
 */
function ownedForceEscalationAttempted(record: ManagedInstance): boolean {
	return record.sigkillSent || ownedCodexBackendForceEscalationAttempted(record.nativeCodexBackend);
}

/** The backend half of {@linkcode ownedForceEscalationAttempted}: this exact resource's lease bit. */
function ownedCodexBackendForceEscalationAttempted(backend: OwnedNativeCodexBackendResource | undefined): boolean {
	if (backend === undefined) return false;
	let status: unknown;
	try {
		status = backend.lease.status();
	} catch {
		return false;
	}
	return isPlainRecord(status)
		&& (status as { readonly forceEscalationAttempted?: unknown }).forceEscalationAttempted === true;
}

/**
 * Whether one owned backend's OWN lease reports that its process is already stopped,
 * exited, or settled.
 *
 * This is a read of the lease's own observation of its child — never an inference from
 * the row's PTY, which knows nothing about this second process, and never an inference
 * from a stop acknowledgement, a stream close, or a timeout. A lease that cannot answer
 * the question is treated as ended: this manager builds a TUI on, and hands out the
 * private capability of, a backend it can positively see is still there.
 */
function ownedCodexBackendKnownEnded(resource: OwnedNativeCodexBackendResource): boolean {
	let status: OwnedCodexBackendStatus;
	try {
		status = resource.lease.status();
	} catch {
		return true;
	}
	if (!isPlainRecord(status)) {
		return true;
	}
	const facts = status as {
		readonly phase?: unknown;
		readonly settled?: unknown;
		readonly stopRequested?: unknown;
		readonly exitObserved?: unknown;
	};
	return facts.settled === true
		|| facts.exitObserved === true
		|| facts.stopRequested === true
		|| facts.phase === "stopping"
		|| facts.phase === "exited"
		|| facts.phase === "settled";
}

/**
 * Whether one owned Codex backend can still carry a native MCP lane: ready, not
 * retired or settled, and not known by its own lease to be stopping or ended.
 */
function nativeMcpOwnedBackendLive(resource: OwnedNativeCodexBackendResource): boolean {
	return resource.ready && !resource.retired && !resource.settled && !ownedCodexBackendKnownEnded(resource);
}

/**
 * Whether the owned TUI relay withdrew its live root facts. The app-server (and the
 * TUI) can outlive the adopted connection; a withdrawal deliberately preserves the
 * saved restart identity, but it ends any native MCP authority (#682). An
 * unreadable source fails closed.
 */
function nativeMcpCodexRootWithdrawn(resource: OwnedNativeCodexBackendResource): boolean {
	try {
		return resource.observationSource?.tuiRootFacts?.current().phase === "withdrawn";
	} catch {
		return true;
	}
}

/**
 * #682: one owner contribution read, validated. A throw or any malformed value is
 * `unknown` (the run had a lane the owner may hold work for), never `none` or zero.
 */
function readNativeMcpLaneContribution(
	activity: NativeMcpLaneActivity,
	run: NativeMcpLaneRunScope,
): NativeMcpLaneActivityContribution {
	let value: unknown;
	try {
		value = activity.contributionFor(run);
	} catch {
		return { status: "unknown" };
	}
	if (typeof value !== "object" || value === null) return { status: "unknown" };
	const { status, count } = value as { status?: unknown; count?: unknown };
	if (status === "none") return { status: "none" };
	if (status === "known" && typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
		return { status: "known", count: count === 0 ? 0 : count };
	}
	return { status: "unknown" };
}

/**
 * Validate and privately copy the owner's fixed pre-proof discovery catalog once,
 * at construction (#682), against the same tool shape the native MCP stdio server
 * accepts from `tools/list`: a dense array of duplicate-free entries of exactly a
 * nonempty `name` of at most {@linkcode NATIVE_MCP_MAX_TOOL_NAME_LENGTH}
 * characters, a JSON-encodable `inputSchema` whose `type` is `"object"`, and an
 * optional string `description`. The schema is copied through JSON, so what is
 * stored is exactly what the broker can encode. Anything else refuses the whole
 * owner, so a catalog that would fail the first `tools/list` never starts.
 */
function copyNativeMcpPreProofTools(
	value: unknown,
	field: "preProofTools" | "deliveryTools" = "preProofTools",
): readonly NativeMcpToolDescriptor[] {
	const invalid = (): Error => new Error(
		`session-host: nativeMcpLane.${field} must be distinct { name, description?, inputSchema } MCP tool descriptors`);
	if (!Array.isArray(value)) {
		throw invalid();
	}
	const names = new Set<string>();
	const tools: NativeMcpToolDescriptor[] = [];
	// An indexed walk, so a sparse hole reads as `undefined` and is refused, never skipped.
	for (let index = 0; index < value.length; index += 1) {
		const entry: unknown = value[index];
		if (!isPlainRecord(entry) || Object.keys(entry).some((key) => key !== "name" && key !== "description" && key !== "inputSchema")
			|| typeof entry.name !== "string" || entry.name.length === 0
			|| entry.name.length > NATIVE_MCP_MAX_TOOL_NAME_LENGTH || names.has(entry.name)
			|| !isPlainRecord(entry.inputSchema)
			|| (entry.description !== undefined && typeof entry.description !== "string")) {
			throw invalid();
		}
		let inputSchema: unknown;
		try {
			// Throws for a cyclic or BigInt-bearing schema the broker could never encode.
			inputSchema = JSON.parse(JSON.stringify(entry.inputSchema));
		} catch {
			throw invalid();
		}
		if (!isPlainRecord(inputSchema) || inputSchema.type !== "object") {
			throw invalid();
		}
		names.add(entry.name);
		tools.push({
			name: entry.name,
			...(entry.description === undefined ? {} : { description: entry.description }),
			inputSchema,
		});
	}
	return Object.freeze(tools);
}

/**
 * Whether one discovery answer fits every native MCP transport leg it crosses
 * (#682), at the worst-case framing of each: the broker -> relay response frame
 * with the largest correlation number, and the relay's stdio `tools/list` result
 * (forwarded under the default stdio limits) with the largest accepted request id.
 * Either leg refuses an oversized list as a whole, so a catalog that fails here
 * would make every receipt-bearing run's discovery fail, baseline included.
 */
function nativeMcpCatalogFitsTransport(tools: readonly NativeMcpToolDescriptor[]): boolean {
	try {
		encodeNativeMcpServerFrame({
			version: 1,
			type: "native_mcp_response",
			seq: Number.MAX_SAFE_INTEGER,
			outcome: "result",
			result: { tools },
		});
	} catch {
		return false;
	}
	// `null` serializes to 4 bytes; the largest accepted id serializes to the id bound.
	const stdioFrameBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: null, result: { tools } }))
		- 4 + NATIVE_MCP_MAX_REQUEST_ID_BYTES + 1;
	return stdioFrameBytes <= DEFAULT_NATIVE_MCP_STDIO_LIMITS.maxOutboundFrameBytes;
}

/** The lazy loader for the pinned real native PTY implementation. */
interface LoadedNodePty {
	spawn(file: string, args: string[] | string, options: {
		name: string;
		cols: number;
		rows: number;
		cwd: string;
		env: NodeJS.ProcessEnv;
		/**
		 * Windows-only public option of the pinned node-pty: prefer the ConPTY
		 * DLL bundled with the platform package over the host's system ConPTY.
		 */
		useConptyDll?: boolean;
	}): IPty;
}

const nodePtyRequire = createRequire(__filename);
let cachedNodePty: LoadedNodePty | undefined;
let nodePtyLoaderForTests: (() => LoadedNodePty) | undefined;
/** #682 test seam: observes Claude inbox bind attempts; carries no token, path, or row data. */
type ClaudeInboxBindEventForTests = "started" | "bound" | "dropped";
let claudeInboxBindListenerForTests: ((event: ClaudeInboxBindEventForTests) => void) | undefined;
/** #682 test seam: the monotonic clock of post-clear MCP correlations. */
let nativeMcpClearClockForTests: (() => number) | undefined;
function noteClaudeInboxBindForTests(event: ClaudeInboxBindEventForTests): void {
	try {
		claudeInboxBindListenerForTests?.(event);
	} catch {
		// A test listener can never affect the binding.
	}
}

export const __test = Object.freeze({
	setClaudeInboxBindListenerForTests(listener: ((event: ClaudeInboxBindEventForTests) => void) | undefined): void {
		claudeInboxBindListenerForTests = listener;
	},
	setNativeMcpClearClockForTests(now: (() => number) | undefined): void {
		nativeMcpClearClockForTests = now;
	},
	setShutdownPlatform(platform: NodeJS.Platform | undefined): void {
		shutdownPlatformForTests = platform;
	},
	setNodePtyLoaderForTests(loader: (() => LoadedNodePty) | undefined): void {
		nodePtyLoaderForTests = loader;
		cachedNodePty = undefined;
	},
	setSavedDeletionAdaptersForTests(adapters: SavedDeletionMutationAdapters | undefined): void {
		savedDeletionAdaptersForTests = adapters === undefined ? undefined : Object.freeze({ ...adapters });
	},
});

/**
 * The default PTY factory. Loads the pinned `@lydell/node-pty` module only
 * when an instance actually spawns (never at import time), so a standalone
 * embed can never load the native addon accidentally.
 */
export function createDefaultPtyFactory(): PtyFactory {
	return (descriptor: InstanceSpawnDescriptor): InstancePty => {
		let nodePty = cachedNodePty;
		if (!nodePty) {
			nodePty = nodePtyLoaderForTests?.() ?? nodePtyRequire("@lydell/node-pty") as LoadedNodePty;
			cachedNodePty = nodePty;
		}
		// The pinned implementation satisfies the InstancePty subset
		// structurally (data/exit events, write, resize, kill, pause/resume).
		// A batch child carries the public pre-escaped `CommandLine` string, so
		// the pinned Windows spawn appends it verbatim instead of MSDN-escaping
		// the quotes cmd.exe needs out of an argv array. Every other child keeps
		// the argv form, and POSIX never sees a command line.
		const pty = nodePty.spawn(descriptor.file, descriptor.commandLine ?? descriptor.args, {
			name: "xterm-256color",
			cols: descriptor.cols,
			rows: descriptor.rows,
			cwd: descriptor.cwd,
			env: descriptor.env,
			// Windows-only: explicitly select the ConPTY DLL bundled with the
			// pinned public @lydell/node-pty instead of the host's system ConPTY,
			// so the shipped source path matches the acceptance transport.
			// POSIX options are unchanged, and the deprecated ignored
			// `useConpty` hint is never set.
			...(process.platform === "win32" ? { useConptyDll: true } : {}),
		});
		// #666: on that bundled-ConPTY request the pinned addon leaves its owned
		// conout reader Worker alive after a natural exit, which keeps this host
		// process from settling. Capture the exact reader now, while this factory
		// still holds the handle it just created; the release is triggered only by
		// that same handle's own exit event, and its one confirmation deadline is
		// anchored at that exit inside the existing confirmation window. POSIX
		// spawns never reach this, and the public handle returned below is never
		// wrapped or replaced.
		if (process.platform === "win32") {
			captureOwnedConptyReader(pty, { confirmationWindowMs: DEFAULT_SHUTDOWN_KILL_MS });
		}
		return pty;
	};
}

function validateDimension(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
		throw new Error(`session-host: instance ${label} must be a safe integer between 1 and 1000, got ${value}`);
	}
}

function validateShutdownMs(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`session-host: shutdown ${label} must be a non-negative safe integer, got ${value}`);
	}
}

/**
 * Owner-private record of the most recent actual accepted input on one hosted
 * provider child incarnation. `viewer` carries that viewer's id and the exact scope
 * token its input was verified under, so a later copy re-proves the CURRENT viewer
 * facts instead of trusting a cached destination.
 */
type NativeCliCopyController =
	| { readonly kind: "local"; readonly ordinal: number }
	| { readonly kind: "viewer"; readonly viewerId: string; readonly sourceToken: string; readonly ordinal: number };

/**
 * The owner-private capture/submit seam of ONE live hosted provider run (issue 277
 * native text-copy slice), handed to host code that already owns the manager.
 *
 * It is bound to one exact row AND one exact child-process incarnation: the
 * incarnation's private key is captured when the seam is created and re-checked on
 * EVERY submit, so a replaced child, an exited row, a stop, a removed row, or a
 * disposed manager submits nothing, and this object can never address another row.
 * It is not a public clipboard endpoint: it accepts only an already-normalized
 * canonical-base64 UTF-8 text payload, performs no clipboard write itself, chooses
 * no destination beyond this row's own last accepted input, and is never reachable
 * from a peer, a wire frame, or a child.
 */
export interface NativeCliCopyCapture {
	/** Owner row id this seam is bound to; descriptive, never a lookup key. */
	readonly rowId: string;
	/** The row's own recorded backend at binding time. */
	readonly backend: NativeCliBackend;
	/**
	 * Submit one captured TEXT copy through this row's own fences. True means the
	 * copy was handed to exactly one eligible recipient route; false means nothing
	 * was delivered and nothing is queued, retried, or fallen back.
	 */
	submit(encoded: string): boolean;
}

/**
 * The owner-private capture/submit/invalidate seam of ONE live hosted provider
 * run's STATUS (native status slice), handed to host code that already owns the
 * manager — the dependent provider observer adapter that will attach later.
 *
 * It is bound to one exact row AND one exact child-process incarnation, exactly
 * like the row's text-copy seam: the incarnation's private key is captured when
 * the seam is created and re-checked on EVERY call, so a replaced child, an exited
 * or erroring row, a stop in progress, a removed row, or a disposed manager accepts
 * nothing, and this object can never address another row. It is not a status
 * registration: it never mints or impersonates a Pi bootstrap, token, broker
 * namespace, native conversation tuple, or input framing, and it changes no Pi
 * bridge, input, or clipboard provenance path. It is never reachable from a peer,
 * a wire frame, or a child.
 *
 * `submit` applies a complete, validated observation of the categories this
 * observer reports; `invalidate` is that observer's honest failure statement — the
 * row's observed values become unknown, never zero, never a stale Ready, while the
 * row's declared capabilities stay truthful. Neither call is queued or retried, and
 * neither ever touches the conservative ownership counts that gate a stop.
 */
export interface NativeStatusCapture {
	/** Owner row id this seam is bound to; descriptive, never a lookup key. */
	readonly rowId: string;
	/** The row's own recorded backend at binding time. */
	readonly backend: NativeCliBackend;
	/**
	 * Submit one complete observation through this row's own fences. A malformed
	 * observation changes nothing; an accepted one replaces the row's observed values
	 * for the categories this contract carries and merges any applicability it declares.
	 * A capture whose observer generation was retired by an accepted invalidation is
	 * refused for good, so a callback the observer queued before its own failure can
	 * never restore anything.
	 */
	submit(observation: NativeStatusObservation): NativeStatusSubmitResult;
	/**
	 * Report that this observer can no longer vouch for what it last submitted. Every
	 * observed value on the row collapses to unknown; the applicability declaration
	 * stays, because a backend's inability to report a category is not a new fact. This
	 * retires the capture's whole generation: recovery acquires a NEW capture from the
	 * manager, and the row itself stays live throughout.
	 */
	invalidate(): NativeStatusSubmitResult;
}

/** Internal viewer record: one surface's facts, its host run identity, and its own sink. */
interface ManagedViewer {
	id: string;
	sessionId: string | undefined;
	cols: number | undefined;
	rows: number | undefined;
	revision: number;
	/**
	 * Immutable identity of the host run that registered this surface, supplied by
	 * that host at registration. Local-only: never published, never chosen by a
	 * caller of a write, and absent for a surface that took part in no input scope.
	 */
	hostRunId?: string;
	/**
	 * Immutable copy destination for copies this surface's own input caused. Required
	 * before the viewer may take input, because this path has no intentional
	 * permanent copy drop. Retired with the record by closeViewer or disposal.
	 */
	nativeClipboardSink?: NativeViewerClipboardSink;
}

function viewerState(viewer: ManagedViewer): SessionViewerState {
	return {
		viewerId: viewer.id,
		sessionId: viewer.sessionId,
		cols: viewer.cols,
		rows: viewer.rows,
		revision: viewer.revision,
	};
}

/** True only for a row a viewer may display: present, launched or launching, and not finished. */
function isViewableRow(record: ManagedInstance | undefined): boolean {
	return record !== undefined && !record.ptyExited && record.lifecycle !== "error";
}

/** Only a well-shaped accepted public response suppresses the POSIX SIGTERM fallback. */
function validShutdownRequest(value: unknown): boolean {
	try {
		if (typeof value !== "object" || value === null) return false;
		const result = value as Partial<StatusShutdownResult>;
		return typeof result.requestId === "string"
			&& result.requestId.length > 0
			&& ["requested", "rejected", "unavailable", "busy", "timeout", "disconnected"].includes(result.status as string)
			&& result.status === "requested";
	} catch {
		// Malformed foreign objects (including throwing getters) fail closed.
		return false;
	}
}

/** Fixed public diagnostics never copy upstream arguments, env, config, or token material. */
const PUBLIC_INSTANCE_ERRORS = {
	launchPreparation: "session-host: instance launch preparation failed",
	ptySetup: "session-host: instance PTY setup failed",
	outputParsing: "session-host: instance output parsing failed",
	queryReply: "session-host: instance query reply write failed",
	ptyRead: "session-host: instance PTY read failed",
	ptyResize: "session-host: instance PTY resize failed",
	surfaceResize: "session-host: instance terminal surface resize failed",
	ptyPause: "session-host: instance PTY pause failed",
	ptyResume: "session-host: instance PTY resume failed",
} as const;

type InstanceErrorCode = keyof typeof PUBLIC_INSTANCE_ERRORS;

/**
 * Size of the owner-private per-incarnation secret of one hosted provider child.
 * It matches the native CLI scope family's minimum key material and is never
 * exported, published, or derived from anything observable about the child.
 */
const NATIVE_CLI_INCARNATION_BYTES = 32;

/**
 * The host's own local-user input origin. It is a closed classification of
 * where an already-admitted dispatch came from, never a permission, a trust
 * claim, or a viewer grant.
 */
const LOCAL_INPUT_ORIGIN: NativeInputOrigin = Object.freeze({ kind: "local" } as const);

/**
 * TerminalSurface protocol replies (DA/DSR/kitty keyboard) and any other
 * host-generated child input carry no user origin, so they can never authorize
 * or label a clipboard copy.
 */
const PROTOCOL_INPUT_ORIGIN: NativeInputOrigin = Object.freeze({ kind: "none" } as const);

/**
 * The closed child-side fence of a startup-phase viewer dispatch. It names the
 * child's own explicit startup phase and nothing else: no tuple, id, or epoch.
 */
const STARTUP_INPUT_FENCE: NativeInputExpectedFence = Object.freeze({ phase: "startup" } as const);

/** Printable-ASCII bounded identity field shared by every viewer input source fact. */
const VIEWER_FACT_FIELD = /^[\x21-\x7e]{1,128}$/;
const VIEWER_MOUSE_TRACKING_MODES = new Set<string>(["none", "x10", "vt200", "drag", "any"]);
const VIEWER_MOUSE_ENCODINGS = new Set<string>(["default", "sgr", "sgr-pixels"]);
const VIEWER_INPUT_MODE_KEYS = ["kittyFlags", "applicationCursorKeys", "applicationKeypad",
  "bracketedPaste", "mouseTracking", "modifyOtherKeys", "mouseEncoding"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isOrdinal(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Bounded printable-ASCII fact field of an unknown value (never a regex on unknown). */
function isBoundedFactField(value: unknown): boolean {
	return typeof value === "string" && VIEWER_FACT_FIELD.test(value);
}

/** The closed modifyOtherKeys level set, checked without assuming a type. */
function isModifyOtherKeysLevel(value: unknown): boolean {
	return typeof value === "number" && (value === 0 || value === 1 || value === 2);
}

/**
 * Shape check for an expected source handed back by a caller. It validates the
 * closed fact shape only — the manager still compares every field against the
 * current record, so a well-formed forged source is simply stale.
 */
function isViewerInputSource(value: unknown): value is NativeViewerInputSource {
	if (!isPlainRecord(value)
		|| !hasExactKeys(value, [
			"hostRunId", "viewerId", "viewerRevision", "rowId", "nativeSession", "geometry",
			"registrationIdentity", "registrationGeneration", "sourceToken",
		])) {
		return false;
	}
	if (!isBoundedFactField(value.hostRunId)
		|| !isBoundedFactField(value.sourceToken)
		|| !isBoundedFactField(value.rowId)
		|| !isBoundedFactField(value.registrationIdentity)
		|| !isBoundedFactField(value.registrationGeneration)
		|| !isOrdinal(value.viewerRevision)) {
		return false;
	}
	const native = value.nativeSession;
	const geometry = value.geometry;
	if (!isPlainRecord(native) || !hasExactKeys(native, ["sessionId", "epoch"])
		// The conversation identity keeps the protocol's own domain (opaque, bounded in
		// UTF-8 bytes, path-free, control-free, possibly non-ASCII), so a valid
		// conversation is never refused an input source by an extra ASCII-only rule.
		|| !isValidNativeSessionId(native.sessionId)
		|| typeof native.epoch !== "number" || !Number.isSafeInteger(native.epoch) || native.epoch < 1) {
		return false;
	}
	return isViewerInputGeometry(geometry);
}

function isViewerInputGeometry(geometry: unknown): boolean {
	return isPlainRecord(geometry) && hasExactKeys(geometry, ["cols", "rows", "revision"])
		&& typeof geometry.cols === "number" && Number.isSafeInteger(geometry.cols)
		&& geometry.cols >= 1 && geometry.cols <= 1000
		&& typeof geometry.rows === "number" && Number.isSafeInteger(geometry.rows)
		&& geometry.rows >= 1 && geometry.rows <= 1000
		&& isOrdinal(geometry.revision);
}

/**
 * Closed shape check for a startup source: exactly its own keys, an explicit
 * `phase: "startup"`, and no `nativeSession` key at all (a null or fake one fails).
 */
function isViewerStartupInputSource(value: unknown): value is NativeViewerStartupInputSource {
	if (!isPlainRecord(value)
		|| !hasExactKeys(value, [
			"hostRunId", "viewerId", "viewerRevision", "rowId", "phase", "geometry",
			"registrationIdentity", "registrationGeneration", "sourceToken",
		])) {
		return false;
	}
	return value.phase === "startup"
		&& isBoundedFactField(value.hostRunId)
		&& isBoundedFactField(value.sourceToken)
		&& isBoundedFactField(value.rowId)
		&& isBoundedFactField(value.registrationIdentity)
		&& isBoundedFactField(value.registrationGeneration)
		&& isOrdinal(value.viewerRevision)
		&& isViewerInputGeometry(value.geometry);
}

/** Variant-aware shape check for an expected input source handed back by a caller. */
function isAnyViewerInputSource(value: unknown): value is NativeViewerAnyInputSource {
	if (isPlainRecord(value) && Object.hasOwn(value, "phase")) {
		return value.phase === NATIVE_CLI_INPUT_PHASE
			? isViewerNativeCliInputSource(value)
			: isViewerStartupInputSource(value);
	}
	return isViewerInputSource(value);
}

/**
 * Closed shape check for a hosted native CLI source: exactly its own keys, an
 * explicit `phase: "native-cli"`, one of the two closed backends, and no
 * `nativeSession`, `registrationIdentity`, or `registrationGeneration` key at all
 * (a null or fabricated one fails).
 */
function isViewerNativeCliInputSource(value: unknown): value is NativeViewerNativeCliInputSource {
	if (!isPlainRecord(value)
		|| !hasExactKeys(value, [
			"hostRunId", "viewerId", "viewerRevision", "rowId", "phase", "backend", "geometry", "sourceToken",
		])) {
		return false;
	}
	return value.phase === NATIVE_CLI_INPUT_PHASE
		&& isNativeCliBackend(value.backend)
		&& isBoundedFactField(value.hostRunId)
		&& isBoundedFactField(value.sourceToken)
		&& isBoundedFactField(value.rowId)
		&& isOrdinal(value.viewerRevision)
		&& isViewerInputGeometry(value.geometry);
}

/** The closed variant of one input-path source, for the variant-aware comparisons. */
type InputSourceVariant = "startup" | "native-cli" | "conversation";

function sourceVariant(source: NativeViewerAnyInputSource): InputSourceVariant {
	if (isNativeViewerStartupInputSource(source)) return "startup";
	return isNativeViewerNativeCliInputSource(source) ? "native-cli" : "conversation";
}

/**
 * Variant-aware exact equality of two input-path sources. A startup source never
 * equals a conversation source or a hosted native CLI source, and a native CLI
 * source never equals either of the others whatever its other facts say.
 */
function sameAnyViewerInputSource(left: NativeViewerAnyInputSource, right: NativeViewerAnyInputSource): boolean {
	const variant = sourceVariant(left);
	if (variant !== sourceVariant(right)) return false;
	if (variant === "native-cli") {
		const a = left as NativeViewerNativeCliInputSource;
		const b = right as NativeViewerNativeCliInputSource;
		return a.hostRunId === b.hostRunId
			&& a.viewerId === b.viewerId
			&& a.viewerRevision === b.viewerRevision
			&& a.rowId === b.rowId
			&& a.backend === b.backend
			&& a.geometry.cols === b.geometry.cols
			&& a.geometry.rows === b.geometry.rows
			&& a.geometry.revision === b.geometry.revision
			// The token commits to the current process incarnation as well as every
			// fact above, so a source rebuilt from older facts is caught here too.
			&& a.sourceToken === b.sourceToken;
	}
	if (variant === "startup") {
		const a = left as NativeViewerStartupInputSource;
		const b = right as NativeViewerStartupInputSource;
		return a.hostRunId === b.hostRunId
			&& a.viewerId === b.viewerId
			&& a.viewerRevision === b.viewerRevision
			&& a.rowId === b.rowId
			&& a.geometry.cols === b.geometry.cols
			&& a.geometry.rows === b.geometry.rows
			&& a.geometry.revision === b.geometry.revision
			&& a.registrationIdentity === b.registrationIdentity
			&& a.registrationGeneration === b.registrationGeneration
			&& a.sourceToken === b.sourceToken;
	}
	return sameViewerInputSource(left as NativeViewerInputSource, right as NativeViewerInputSource);
}

function sameViewerInputSource(left: NativeViewerInputSource, right: NativeViewerInputSource): boolean {
	return left.hostRunId === right.hostRunId
		&& left.viewerId === right.viewerId
		&& left.viewerRevision === right.viewerRevision
		&& left.rowId === right.rowId
		&& left.nativeSession.sessionId === right.nativeSession.sessionId
		&& left.nativeSession.epoch === right.nativeSession.epoch
		&& left.geometry.cols === right.geometry.cols
		&& left.geometry.rows === right.geometry.rows
		&& left.geometry.revision === right.geometry.revision
		&& left.registrationIdentity === right.registrationIdentity
		&& left.registrationGeneration === right.registrationGeneration
		// The token commits to every fact above; comparing it catches a source that
		// was rebuilt from older facts the individual fields no longer describe.
		&& left.sourceToken === right.sourceToken;
}

/** Shape check for the input modes a caller observed (an observation, never authority). */
function isViewerInputModes(value: unknown): value is TerminalInputModes {
	if (!isPlainRecord(value) || !hasExactKeys(value, VIEWER_INPUT_MODE_KEYS)) return false;
	if (!isOrdinal(value.kittyFlags) || value.kittyFlags > 7) return false;
	for (const key of ["applicationCursorKeys", "applicationKeypad", "bracketedPaste"] as const) {
		if (typeof value[key] !== "boolean") return false;
	}
	if (typeof value.mouseTracking !== "string" || !VIEWER_MOUSE_TRACKING_MODES.has(value.mouseTracking)) return false;
	if (!isModifyOtherKeysLevel(value.modifyOtherKeys)) return false;
	return typeof value.mouseEncoding === "string" && VIEWER_MOUSE_ENCODINGS.has(value.mouseEncoding);
}

function sameViewerInputModes(left: TerminalInputModes, right: TerminalInputModes): boolean {
	return left.kittyFlags === right.kittyFlags
		&& left.applicationCursorKeys === right.applicationCursorKeys
		&& left.applicationKeypad === right.applicationKeypad
		&& left.bracketedPaste === right.bracketedPaste
		&& left.mouseTracking === right.mouseTracking
		&& left.modifyOtherKeys === right.modifyOtherKeys
		&& left.mouseEncoding === right.mouseEncoding;
}

/** One strict viewer input request; anything else is refused before any state is read. */
function invalidViewerInputRequest(request: NativeViewerInputRequest): boolean {
	if (!isPlainRecord(request)
		|| !hasExactKeys(request, ["expectedSource", "expectedInputModes", "data"])) return true;
	if (!isAnyViewerInputSource(request.expectedSource)) return true;
	if (!isViewerInputModes(request.expectedInputModes)) return true;
	if ((typeof request.data !== "string" && !Buffer.isBuffer(request.data)) || request.data.length === 0) return true;
	// The child assembles ONE viewer dispatch whole before any native input listener
	// sees it, so this seam admits it against the same technical assembly bound the
	// child enforces, counted in raw native bytes exactly as they will be written.
	// This is a refusal before the PTY (the existing `invalid-input` reason, no new
	// wire error), never a paste policy: the 1 MiB wire body bound, the per-fragment
	// transport bound, and every local or protocol-reply write stay unchanged.
	const bytes = typeof request.data === "string"
		? Buffer.byteLength(request.data, "utf8")
		: request.data.length;
	return bytes > NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES;
}

function publicInstanceError(code: InstanceErrorCode): string {
	const message = PUBLIC_INSTANCE_ERRORS[code];
	return message.length <= MAX_INSTANCE_ERROR_CHARS
		? message
		: "session-host: instance operation failed";
}

/**
 * Subscribe to the pinned PTY's inherited EventEmitter error channel. The
 * pinned UnixTerminal attaches one internal socket error handler and throws
 * unexpected errors if there is no second listener; `on`/`removeListener`
 * forward to that same socket in the installed 1.2.0-beta.15 runtime.
 */
function subscribePtyReadErrors(pty: InstancePty, listener: (error: Error) => void): { dispose(): void } {
	if (typeof pty.on !== "function" || typeof pty.removeListener !== "function") {
		throw new Error("PTY error event subscription is unavailable");
	}
	let disposed = false;
	const onError = (error: Error): void => {
		const code = (error as NodeJS.ErrnoException).code;
		if (disposed || (typeof code === "string" && (
			code.includes("EAGAIN") || code.includes("EIO") || code.includes("errno 5")
		))) {
			return;
		}
		listener(error);
	};
	pty.on("error", onError);
	return {
		dispose: () => {
			if (disposed) return;
			disposed = true;
			// Keep the second listener throughout native error dispatch.
			setImmediate(() => {
				try {
					pty.removeListener?.("error", onError);
				} catch {
					// Listener cleanup remains best-effort after confirmed exit.
				}
			});
		},
	};
}

/** Bounded, copied activity snapshot (count- and length-capped). */
function boundedActivity(activity: readonly string[] | undefined): string[] {
	if (!Array.isArray(activity)) {
		return [];
	}
	return activity.slice(-MAX_ACTIVITY_ENTRIES).map((entry) => {
		if (typeof entry !== "string") {
			return "";
		}
		// Registrar lines are structural text, not terminal output: remove
		// controls rather than allowing CR/LF or C1 bytes into the sidebar.
		let line = "";
		let codePoints = 0;
		for (const character of entry) {
			const code = character.codePointAt(0)!;
			if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
				continue;
			}
			line += character;
			if (++codePoints === MAX_ACTIVITY_ENTRY_CHARS) {
				break;
			}
		}
		return line;
	});
}

/**
 * Normalizes an observed owned-work count: only a nonnegative safe integer is
 * real. Absence, null, fractions, negatives, and non-numbers are unknown
 * (null) — a cleared or unavailable tracker is never reported as zero.
 */
function normalizedOwnedCount(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		return null;
	}
	return value === 0 ? 0 : value; // normalize -0
}

function validatedNativeSession(value: unknown): SessionHostNativeSession | null | undefined {
	if (value === null) return null;
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Partial<SessionHostNativeSession>;
	if (!isValidNativeSessionId(candidate.sessionId)
		|| !Number.isSafeInteger(candidate.epoch) || (candidate.epoch as number) < 1
		|| typeof candidate.name !== "string"
		|| candidate.name.trim().length === 0 || candidate.name.trim() !== candidate.name
		|| [...candidate.name].length > 256 || Buffer.byteLength(candidate.name, "utf8") > 1024
		|| /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(candidate.name)) return undefined;
	const session: SessionHostNativeSession = {
		sessionId: candidate.sessionId, epoch: candidate.epoch as number, name: candidate.name,
		...(candidate.persistence === "saved" || candidate.persistence === "unsaved" || candidate.persistence === "unknown"
			? { persistence: candidate.persistence } : {}),
	};
	const currentFile = candidate.currentFile;
	return {
		...session,
		...(isValidNativeSessionFile(currentFile) ? { currentFile } : {}),
	};
}

/** Presentation/roster copy: private current-file authority never leaves the manager's deletion guard. */
function nativeSessionForPresentation(value: SessionHostNativeSession): SessionHostNativeSession {
	return {
		sessionId: value.sessionId,
		epoch: value.epoch,
		name: value.name,
		...(value.persistence === undefined ? {} : { persistence: value.persistence }),
	};
}

function validateLabel(label: unknown): string {
	if (typeof label !== "string") {
		throw new Error("session-host: instance label must be a string");
	}
	if (label.length > MAX_LABEL_CHARS) {
		throw new Error(`session-host: instance label exceeds the ${MAX_LABEL_CHARS}-character bound`);
	}
	if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(label)) {
		throw new Error("session-host: instance label must be a single line (control characters and line breaks are rejected)");
	}
	return label;
}

/** A native row's explicit caption: admitted whole by the shared caption rule, never clipped. */
function validateNativeCaption(caption: unknown): string {
	if (!isNativeCaption(caption)) {
		throw new Error("session-host: a native row caption must be a bounded single-line name");
	}
	return caption;
}

function validateInitialRequest(value: unknown): { title: string; prompt: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("session-host: initial request requires exact title and prompt strings");
	}
	const request = value as Record<string, unknown>;
	const keys = Object.keys(request);
	if (keys.length !== 2 || !keys.includes("title") || !keys.includes("prompt")
		|| !isValidRenameName(request.title) || Buffer.byteLength(request.title, "utf8") > MAX_SESSION_SPAWN_TITLE_BYTES
		|| typeof request.prompt !== "string" || request.prompt.length === 0 || request.prompt.includes("\0")) {
		throw new Error("session-host: initial request title must be bounded and its prompt nonempty without NUL characters");
	}
	return { title: request.title, prompt: request.prompt };
}

/**
 * Bounds for one operator's opaque native CLI launch-target selection. The
 * target-id bound itself is owned by `session-backend.ts`, where the sidebar's
 * ingestion reads the same value; this re-export only keeps the manager's own
 * historical import path working.
 */
export { MAX_NATIVE_CLI_TARGET_CHARS } from "./session-backend";
/** Upper bound for one native CLI launch descriptor's argument array. */
export const MAX_NATIVE_CLI_ARGS = 256;

/**
 * The host's own capability environment keys. They are never injected into a
 * native CLI child and never forwarded to one: provider-side sanitization stays
 * with the launch provider, while these host-owned tokens never leak past this
 * module's own spawn seam.
 */
const HOST_CAPABILITY_ENV_KEYS: readonly string[] = Object.freeze([
	SESSION_HOST_BOOTSTRAP_ENV,
	SESSION_HOST_STARTUP_REQUEST_ENV,
	SESSION_HOST_TITLE_COLUMNS_ENV,
	NODE_OPTIONS_RESTORE_ENV,
]);

function validateNativeCliTarget(value: unknown): string {
	if (!isNativeCliTargetId(value)) {
		throw new Error(`session-host: the native CLI launch target must be bounded single-line text`);
	}
	return value;
}

/**
 * Validate and canonicalize the workspace one native CLI row was explicitly
 * given. This is the whole setup an ordinary provider child needs: an existing
 * directory, canonically resolved so the descriptor cwd is
 * cwd-independent. No Pi agent directory, config, profile, or skill work happens
 * here or anywhere else on this path.
 *
 * The resolution IS the host's shared Pi workspace resolution
 * ({@linkcode resolveWorkspaceDirectory}): a leading bare `~`/`~/` expands
 * against the home directory, a relative spelling resolves against this
 * process's working directory, and the result is the canonical real path. A
 * native row therefore accepts exactly the spellings a Pi row accepts, because
 * both rows go through the one resolver — this adds no second rule, and it
 * never asks a shell to expand anything. No environment-variable or
 * `~otheruser` form is expanded here any more than it is for Pi.
 */
function canonicalNativeWorkspace(workspace: string, createWorkspace = false): string {
	return resolveWorkspaceDirectory(workspace, "the native CLI workspace", { createWorkspace });
}

/**
 * Validate one native CLI launch descriptor the provider composed, against this
 * row's own selected canonical workspace, and return a private copy. The
 * descriptor is the full interactive launch: one executable plus its argv and
 * environment, applied verbatim at spawn. Requiring the cwd to be exactly the
 * selected workspace is what keeps one row = one workspace true for a child the
 * manager did not compose; anything else about the provider's argv or environment
 * is the provider's own decision.
 */
function validatedNativeCliDescriptor(value: unknown, workspace: string): NativeLaunchDescriptor {
	if (!isPlainRecord(value)) {
		throw new Error("session-host: the native CLI launch provider returned no launch descriptor");
	}
	const file = value.file;
	if (typeof file !== "string" || file.length === 0 || /[\u0000-\u001f\u007f-\u009f]/.test(file)) {
		throw new Error("session-host: the native CLI launch descriptor must name exactly one executable file");
	}
	const args = value.args;
	if (!Array.isArray(args) || args.length > MAX_NATIVE_CLI_ARGS
		|| args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
		throw new Error(`session-host: the native CLI launch descriptor requires at most ${MAX_NATIVE_CLI_ARGS} string arguments`);
	}
	// A batch child's Windows command line reaches the pinned public spawn
	// verbatim, so it is validated as one printable non-empty string and never
	// silently dropped: a descriptor that carries an unusable one is refused
	// rather than spawned as a bare interpreter with no command.
	const commandLine = value.commandLine;
	if (commandLine !== undefined
		&& (typeof commandLine !== "string" || commandLine.length === 0 || /[\u0000-\u001f\u007f]/.test(commandLine))) {
		throw new Error("session-host: the native CLI launch descriptor's Windows command line must be one printable non-empty string");
	}
	const env = value.env;
	if (!isPlainRecord(env)
		|| Object.values(env).some((entry) => entry !== undefined && typeof entry !== "string")) {
		throw new Error("session-host: the native CLI launch descriptor requires an environment of string values");
	}
	const cwd = value.cwd;
	if (typeof cwd !== "string" || !isAbsolute(cwd) || realpathSync(cwd) !== workspace) {
		throw new Error("session-host: the native CLI launch descriptor does not target this row's selected workspace");
	}
	return { file, args: [...args], ...(commandLine === undefined ? {} : { commandLine }), env: { ...env } as NodeJS.ProcessEnv, cwd };
}

/** A fresh child environment with this host's own capability tokens removed. */
function nativeCliChildEnv(descriptorEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...descriptorEnv };
	for (const key of HOST_CAPABILITY_ENV_KEYS) delete env[key];
	return env;
}

/** True only for a row whose recorded backend is a native CLI backend. */
function isNativeCliRow(record: ManagedInstance): boolean {
	return isNativeCliBackend(record.backend);
}

/** The caller's final guard: only an exact `true` authorizes; a throw refuses. */
function callerAuthorized(authorize: SavedMutationAuthorization): boolean {
	try {
		return authorize() === true;
	} catch {
		return false;
	}
}

/** True only for this manager's own synchronous known-owned duplicate refusal. */
function isOwnedDuplicateLaunchError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("already open in this host");
}

/**
 * Manager of independently owned native session-host instances. See the
 * module documentation for the ownership, isolation, and shutdown rules.
 */
export class InstanceManager {
	readonly #packageRoot: string;
	readonly #piExecutable: string;
	readonly #statusRegistrar: StatusRegistrar;
	readonly #profilePreparer: ProfilePreparer;
	readonly #nativeSetup: boolean;
	readonly #inputOriginFraming: boolean;
	readonly #args: readonly string[];
	readonly #env: NodeJS.ProcessEnv;
	#cols: number;
	#rows: number;
	readonly #getSupportedKeyboardFlags?: () => number;
	readonly #graphicsBudget: TerminalGraphicsBudget;
	readonly #onChange?: (instanceId: string) => void;
	readonly #onTerminalDiagnostic?: (instanceId: string, event: TerminalDiagnosticEvent) => void;
	readonly #onNativeClipboard?: (instanceId: string, event: NativeClipboardEvent) => void;
	readonly #onNativeCliClipboard?: (instanceId: string, event: NativeCliClipboardEvent) => void;
	readonly #onSpawnRequest?: (parentInstanceId: string, request: SessionSpawnInput) => Promise<SessionSpawnOutcome>;
	readonly #onRoutedSpawnRequest?: InstanceManagerOptions["onRoutedSpawnRequest"];
	readonly #routedSpawnCreateWorkspace: boolean;
	readonly #routedSpawnOwnHostParentProof: boolean;
	readonly #onSessionHostsRequest?: InstanceManagerOptions["onSessionHostsRequest"];
	readonly #getSidebarTitleColumns?: () => number;
	readonly #ptyFactory: PtyFactory;
	readonly #nativeCliLaunch?: NativeCliLaunch;
	/** The OPTIONAL owner-side native hook registrar, or absent for every existing host. */
	readonly #nativeHookRegistrar?: NativeHookSourceRegistrar;
	/** The OPTIONAL owner-side per-run status observer factory, paired with the registrar. */
	readonly #nativeStatusObserverFactory?: NativeStatusObserverFactory;
	/** The OPTIONAL trusted native MCP lane owner (#682); requires the status pair. */
	readonly #nativeMcpLane?: NativeMcpLaneOwner;
	/** #682: the lane owner's managed activity projection, or absent (rows stay native-only). */
	readonly #nativeMcpLaneActivity?: NativeMcpLaneActivity;
	#nativeMcpLaneActivityUnsubscribe?: () => void;
	/** #682: the owner's private copy of the pre-proof discovery catalog, or absent (pre-proof list refused). */
	readonly #nativeMcpPreProofTools?: readonly NativeMcpToolDescriptor[];
	/** #682: the owner's private copy of the delivery discovery catalog, or absent (never advertised). */
	readonly #nativeMcpDeliveryTools?: readonly NativeMcpToolDescriptor[];
	/** #682: the binding of each in-flight proved lane call, keyed by the exact context issued. */
	readonly #nativeMcpLaneCalls = new WeakMap<NativeMcpLaneContext, NativeMcpLaneCallBinding>();
	/** #682: the trusted host's explicit native Claude inbox opt-in; requires the status pair. */
	readonly #nativeClaudeInbox: boolean;
	/** #682: the inbox opt-in is scoped to runs whose own MCP lane is kept. */
	readonly #nativeClaudeInboxRequiresMcpLane: boolean;
	readonly #ownedCodexBackendFactory?: OwnedCodexBackendFactory;
	/** #682 (Codex callback): the trusted host's opt-in; requires the lane and the owned factory. */
	readonly #nativeCodexCallback: boolean;
	/** #682 (Codex callback): the verified receipt version of each run whose lane was kept. */
	readonly #codexCallbackVersions = new WeakMap<OwnedNativeStatusRun, string>();
	/** #682 (Codex callback): each ready owned backend's own callback facts reader. */
	readonly #codexCallbackFacts = new WeakMap<OwnedNativeCodexBackendResource, NativeCodexTuiRootCallbackFactsReader>();
	/** #682 (Codex callback): the one sender of each lane, minted at its first current read. */
	readonly #codexCallbackSenders = new WeakMap<OwnedNativeMcpLane, NativeCodexCallbackSender>();
	readonly #shutdownPlatform: NodeJS.Platform;
	readonly #records = new Map<string, ManagedInstance>();
	/**
	 * #666: every owned Windows ConPTY reader settlement this manager's default PTY
	 * factory created. Tracked here rather than only through the rows, so closing a
	 * row can never make an unconfirmed required release disappear.
	 */
	readonly #ownedConptyReaders = new Set<OwnedConptyReaderSettlement>();
	/** Registered viewing surfaces (#474): the only store of viewer facts. */
	readonly #viewers = new Map<string, ManagedViewer>();
	#nextViewerId = 1;
	readonly #inflightCreates = new Set<Promise<void>>();
	#stopping = false;
	#disposed = false;
	#disposePromise?: Promise<void>;
	/**
	 * One-shot notification that this manager began shutting down or being disposed.
	 * It exists so an unbounded pre-spawn wait — the native CLI launch provider —
	 * can settle without holding `shutdown()`/`dispose()` away from the owned stop
	 * ladder. It releases no resource, signals no process, and is never a claim that
	 * anything settled: it only lets an unspawned creation stop waiting.
	 */
	#shutdownNotice?: Promise<void>;
	#shutdownNoticeResolve?: () => void;

	constructor(options: InstanceManagerOptions) {
		if (!options || typeof options !== "object") {
			throw new Error("session-host: InstanceManager requires constructor options");
		}
		if (typeof options.packageRoot !== "string" || options.packageRoot === "") {
			throw new Error("session-host: InstanceManager requires a packageRoot");
		}
		if (typeof options.piExecutable !== "string" || options.piExecutable === "") {
			throw new Error("session-host: InstanceManager requires a piExecutable");
		}
		if (!options.statusRegistrar || typeof options.statusRegistrar.register !== "function") {
			throw new Error("session-host: InstanceManager requires a statusRegistrar with register()");
		}
		this.#packageRoot = options.packageRoot;
		this.#piExecutable = options.piExecutable;
		this.#statusRegistrar = options.statusRegistrar;
		this.#args = [...(options.args ?? [])];
		this.#env = { ...(options.env ?? process.env) };
		this.#cols = options.cols ?? DEFAULT_INSTANCE_COLS;
		this.#rows = options.rows ?? DEFAULT_INSTANCE_ROWS;
		validateDimension(this.#cols, "cols");
		validateDimension(this.#rows, "rows");
		if (options.profileRegistry !== undefined && options.nativeSetup === undefined) {
			throw new Error("session-host: nativeSetup must be explicit when a setup preparer is injected");
		}
		if (options.nativeSetup === false && options.profileRegistry === undefined) {
			throw new Error("session-host: nativeSetup:false requires an explicitly injected legacy setup preparer");
		}
		this.#nativeSetup = options.nativeSetup ?? true;
		if (options.nativeInputOriginFraming !== undefined && typeof options.nativeInputOriginFraming !== "boolean") {
			throw new Error("session-host: nativeInputOriginFraming must be a boolean or absent");
		}
		this.#inputOriginFraming = options.nativeInputOriginFraming === true;
		// The capture mode is a property of the native launch composition only.
		// Legacy private profiles and injected preparers can never frame, so a
		// request there fails at construction instead of being silently ignored.
		if (this.#inputOriginFraming && !this.#nativeSetup) {
			throw new Error("session-host: native input framing is available only for native setup launches");
		}
		this.#profilePreparer = options.profileRegistry ?? new NativeAgentRegistry({ env: this.#env });
		this.#getSupportedKeyboardFlags = options.getSupportedKeyboardFlags;
		this.#graphicsBudget = options.graphicsBudget ?? createTerminalGraphicsBudget();
		this.#onChange = options.onChange;
		this.#onTerminalDiagnostic = options.onTerminalDiagnostic;
		this.#onNativeClipboard = options.onNativeClipboard;
		this.#onNativeCliClipboard = options.onNativeCliClipboard;
		this.#onSpawnRequest = options.onSpawnRequest;
		if (options.onRoutedSpawnRequest !== undefined && typeof options.onRoutedSpawnRequest !== "function") {
			throw new Error("session-host: onRoutedSpawnRequest must be a function or absent");
		}
		this.#onRoutedSpawnRequest = options.onRoutedSpawnRequest;
		if (options.routedSpawnCreateWorkspace !== undefined && typeof options.routedSpawnCreateWorkspace !== "boolean") {
			throw new Error("session-host: routedSpawnCreateWorkspace must be a boolean or absent");
		}
		this.#routedSpawnCreateWorkspace = options.routedSpawnCreateWorkspace === true
			&& options.onRoutedSpawnRequest !== undefined;
		if (options.routedSpawnOwnHostParentProof !== undefined && typeof options.routedSpawnOwnHostParentProof !== "boolean") {
			throw new Error("session-host: routedSpawnOwnHostParentProof must be a boolean or absent");
		}
		this.#routedSpawnOwnHostParentProof = options.routedSpawnOwnHostParentProof === true
			&& options.onRoutedSpawnRequest !== undefined;
		if (options.onSessionHostsRequest !== undefined && typeof options.onSessionHostsRequest !== "function") {
			throw new Error("session-host: onSessionHostsRequest must be a function or absent");
		}
		this.#onSessionHostsRequest = options.onSessionHostsRequest;
		this.#getSidebarTitleColumns = options.getSidebarTitleColumns;
		this.#ptyFactory = options.ptyFactory ?? createDefaultPtyFactory();
		if (options.nativeCliLaunch !== undefined && typeof options.nativeCliLaunch !== "function") {
			throw new Error("session-host: nativeCliLaunch must be a function or absent");
		}
		this.#nativeCliLaunch = options.nativeCliLaunch;
		// The optional native status source is ONE feature with two halves: a
		// registrar with no reader, or a reader with no source, is a wiring mistake
		// that would either stage private artifacts for nothing or leave a hosted row
		// silently unobserved. Fail at construction instead.
		if ((options.nativeHookRegistrar === undefined)
			!== (options.nativeStatusObserverFactory === undefined)) {
			throw new Error("session-host: nativeHookRegistrar and nativeStatusObserverFactory are supplied together or not at all");
		}
		if (options.nativeHookRegistrar !== undefined
			&& typeof options.nativeHookRegistrar.registerNativeHookSource !== "function") {
			throw new Error("session-host: nativeHookRegistrar must provide registerNativeHookSource()");
		}
		if (options.nativeStatusObserverFactory !== undefined
			&& typeof options.nativeStatusObserverFactory !== "function") {
			throw new Error("session-host: nativeStatusObserverFactory must be a function");
		}
		this.#nativeHookRegistrar = options.nativeHookRegistrar;
		this.#nativeStatusObserverFactory = options.nativeStatusObserverFactory;
		// The OPTIONAL native MCP lane (#682) admits calls only for a conversation the
		// run's own observer proved, so it is meaningless without the status pair; a
		// half-wired lane fails at construction rather than registering sources that
		// could never be admitted. The server name is validated, never chosen, here.
		const mcpLane = options.nativeMcpLane;
		if (mcpLane !== undefined) {
			if (options.nativeHookRegistrar === undefined) {
				throw new Error("session-host: nativeMcpLane requires the nativeHookRegistrar/nativeStatusObserverFactory pair");
			}
			if (typeof mcpLane?.registrar?.registerNativeMcpSource !== "function") {
				throw new Error("session-host: nativeMcpLane.registrar must provide registerNativeMcpSource()");
			}
			if (typeof mcpLane.delegate?.listTools !== "function" || typeof mcpLane.delegate?.callTool !== "function") {
				throw new Error("session-host: nativeMcpLane.delegate must provide listTools() and callTool()");
			}
			if (!isValidNativeMcpServerName(mcpLane.serverName)) {
				throw new Error("session-host: nativeMcpLane.serverName must be the stable host MCP server name");
			}
			if (mcpLane.preProofTools !== undefined) {
				this.#nativeMcpPreProofTools = copyNativeMcpPreProofTools(mcpLane.preProofTools);
			}
			if (mcpLane.deliveryTools !== undefined) {
				// A second catalog only extends the first: it needs the baseline and may
				// never shadow or duplicate one of its names.
				const baseline = this.#nativeMcpPreProofTools;
				const delivery = copyNativeMcpPreProofTools(mcpLane.deliveryTools, "deliveryTools");
				if (baseline === undefined) {
					throw new Error("session-host: nativeMcpLane.deliveryTools requires nativeMcpLane.preProofTools");
				}
				const baselineNames = new Set(baseline.map((tool) => tool.name));
				if (delivery.some((tool) => baselineNames.has(tool.name))) {
					throw new Error("session-host: nativeMcpLane.deliveryTools must not repeat a preProofTools name");
				}
				// The combined answer is what a receipt-bearing run lists; it must fit
				// the transport, or that run would lose its baseline discovery too.
				if (!nativeMcpCatalogFitsTransport([...baseline, ...delivery])) {
					throw new Error("session-host: nativeMcpLane.preProofTools and deliveryTools together must fit one native MCP tools/list response");
				}
				this.#nativeMcpDeliveryTools = delivery;
			}
			const activity: unknown = mcpLane.activity;
			if (activity !== undefined) {
				const candidate = activity as Partial<NativeMcpLaneActivity> | null;
				if (typeof candidate?.contributionFor !== "function" || typeof candidate.subscribe !== "function") {
					throw new Error("session-host: nativeMcpLane.activity must provide contributionFor() and subscribe()");
				}
				this.#nativeMcpLaneActivity = candidate as NativeMcpLaneActivity;
			}
			this.#nativeMcpLane = mcpLane;
		}
		// The OPTIONAL native Claude inbox binding (#682) needs the run's own observer
		// proof and the broker's authenticated announcement callback, so it is
		// meaningless without the status pair and fails at construction instead.
		const claudeInbox: unknown = options.nativeClaudeInbox;
		if (claudeInbox !== undefined && typeof claudeInbox !== "boolean") {
			throw new Error("session-host: nativeClaudeInbox must be a boolean or absent");
		}
		if (claudeInbox === true && options.nativeHookRegistrar === undefined) {
			throw new Error("session-host: nativeClaudeInbox requires the nativeHookRegistrar/nativeStatusObserverFactory pair");
		}
		this.#nativeClaudeInbox = claudeInbox === true;
		const requiresMcpLane: unknown = options.nativeClaudeInboxRequiresMcpLane;
		if (requiresMcpLane !== undefined && typeof requiresMcpLane !== "boolean") {
			throw new Error("session-host: nativeClaudeInboxRequiresMcpLane must be a boolean or absent");
		}
		if (requiresMcpLane === true && (claudeInbox !== true || mcpLane === undefined)) {
			throw new Error("session-host: nativeClaudeInboxRequiresMcpLane requires nativeClaudeInbox and nativeMcpLane");
		}
		this.#nativeClaudeInboxRequiresMcpLane = requiresMcpLane === true;
		// The owned Codex backend factory is a third, independent seam: it is neither
		// implied by the optional status pair nor required by it, and it is consulted
		// only for a launch whose descriptor actually carries an owned plan.
		if (options.ownedCodexBackendFactory !== undefined
			&& typeof options.ownedCodexBackendFactory !== "function") {
			throw new Error("session-host: ownedCodexBackendFactory must be a function or absent");
		}
		this.#ownedCodexBackendFactory = options.ownedCodexBackendFactory;
		// #682 (Codex callback): an explicit opt-in that needs the lane (the only way
		// managed work exists for a native row) and the owned backend it writes to.
		const codexCallback: unknown = options.nativeCodexCallback;
		if (codexCallback !== undefined && typeof codexCallback !== "boolean") {
			throw new Error("session-host: nativeCodexCallback must be a boolean or absent");
		}
		if (codexCallback === true && (this.#nativeMcpLane === undefined || this.#ownedCodexBackendFactory === undefined)) {
			throw new Error("session-host: nativeCodexCallback requires nativeMcpLane and ownedCodexBackendFactory");
		}
		this.#nativeCodexCallback = codexCallback === true;
		this.#shutdownPlatform = shutdownPlatformForTests ?? process.platform;
		// #682: subscribed last, so a constructor that refused its options never
		// leaves a live subscription behind. A transition only redraws the exact
		// row whose CURRENT run it names; the value is re-read by list().
		const laneActivity = this.#nativeMcpLaneActivity;
		if (laneActivity !== undefined) {
			const unsubscribe: unknown = laneActivity.subscribe((run) => this.#nativeMcpLaneActivityChanged(run));
			if (typeof unsubscribe === "function") this.#nativeMcpLaneActivityUnsubscribe = unsubscribe as () => void;
		}
	}

	/** Current rows, copied and immutable per call (later SidebarItem shape). */
	list(): NativeInstanceView[] {
		const views: NativeInstanceView[] = [];
		for (const record of this.#records.values()) {
			const view: NativeInstanceView & { exitCode?: number; error?: string } = {
				id: record.id,
				label: record.label,
				...(record.backend === undefined ? {} : { backend: record.backend }),
				nativeSession: record.nativeSession ? Object.freeze(nativeSessionForPresentation(record.nativeSession)) : null,
				...(record.lastNativeSession ? { lastNativeSession: Object.freeze(nativeSessionForPresentation(record.lastNativeSession)) } : {}),
				workspace: record.workspace,
				agentDir: record.agentDir,
				lifecycle: record.lifecycle,
				// One component's exit never makes this row "gone": the row stays live while
				// either its TUI handle or its owned backend remains unsettled.
				hasLiveProcess: Boolean((record.pty && !record.ptyExited) || ownsUnsettledCodexBackend(record)),
				busy: record.busy,
				pendingInput: record.pendingInput,
				inputSurface: record.inputSurface,
				backgroundTasks: record.backgroundTasks,
				backgroundShells: record.backgroundShells,
				activeTasks: this.#projectedActiveTasks(record),
				activeShells: record.activeShells,
				activity: Object.freeze([...record.activity]),
				...(record.nativeStatusSupport === undefined
					? {}
					: { statusSupport: record.nativeStatusSupport }),
			};
			if (record.exitCode !== undefined) {
				view.exitCode = record.exitCode;
			}
			if (record.error !== undefined) {
				view.error = record.error;
			}
			views.push(Object.freeze(view));
		}
		return views;
	}

	/**
	 * Caption exactly one native CLI row by replacing the ONE display label field
	 * this host already transmits for it.
	 *
	 * The name is a caption on THIS host's row presentation and nothing else. It
	 * is never written to the child, never typed into its input, never sent to a
	 * provider, and never a Pi conversation rename: {@linkcode rename} through the
	 * authenticated registration stays the only conversation-name path, and a row
	 * that is not a native CLI row is refused here so no call can be mistaken for
	 * one. The value is validated against the shared native display-name rule
	 * before anything changes, so an empty, oversized, or control-bearing value
	 * updates nothing. A settled row is captioned too — the caption belongs to the
	 * row, not to the live process.
	 *
	 * Precedence is data, never arrival order or a string comparison: this caption,
	 * then a provider title this row's own source proved, then the stable provider
	 * label. Capturing a caption therefore also ends any automatic provider title on
	 * that row: nothing the provider supplied can move the row's text again. The
	 * closed result stays `set | unchanged | no-row | not-native | invalid-name`, and
	 * `unchanged` means only that the TEXT was already equal — the caption is still
	 * established, which is what makes captioning a row with its own provider label a
	 * real, durable opt-out.
	 */
	setNativeDisplayName(id: string, name: string): NativeDisplayNameResult {
		if (this.#disposed || this.#stopping) return "no-row";
		const record = this.#records.get(id);
		if (record === undefined) return "no-row";
		if (!isNativeCliBackend(record.backend)) return "not-native";
		if (!isNativeDisplayName(name)) return "invalid-name";
		// Manual intent is recorded FIRST, before any comparison with the text the row
		// currently shows. The equality shortcut may then skip only the text write and
		// the publish — never the caption: a caption that happens to equal the provider
		// default, or an automatic provider title the row had acquired, is still the
		// operator taking the row over, and it still latches.
		record.nativeCaption = name;
		if (record.label === name) return "unchanged";
		record.label = name;
		this.#safeChanged(record.id);
		return "set";
	}

	/**
	 * Deliberately discard this row's cached ephemeral understanding and ask
	 * the exact owning live client for a complete freshly observed status,
	 * even when the cached values currently look known. Only the correlated
	 * complete result reaches `onStatus`; failures leave the ephemeral state
	 * truthfully unknown without inventing zero. This is an internal host
	 * recovery action, not a user prompt/task/manual-refresh control.
	 */
	async refreshActivity(id: string): Promise<InstanceActivityRefreshStatus> {
		const record = this.#records.get(id);
		if (!record || this.#disposed || this.#stopping || record.ptyExited) return "disconnected";
		const registration = record.registration;
		if (!registration || record.registrationReleased) return "disconnected";
		const requestActivity = registration.requestActivity;
		if (typeof requestActivity !== "function") return "unsupported";
		record.activityRefreshAttempts = 0;
		record.activityRefreshEpisodeOpen = true;
		const revision = record.statusRevision;
		try {
			const result = await requestActivity.call(registration);
			this.#applyActivityRefreshFailure(record, { current: registration }, revision, result, false);
			return result.status;
		} catch {
			this.#applyActivityRefreshFailure(record, { current: registration }, revision, undefined, false);
			return "unavailable";
		}
	}

	/**
	 * The terminal surface of one instance (the retained last frame stays
	 * readable after the child exited, until the manager is disposed) or
	 * undefined for unknown ids and rows that never got a parse pipeline.
	 */
	surface(id: string): TerminalSurface | undefined {
		if (this.#disposed) {
			return undefined;
		}
		return this.#records.get(id)?.surface;
	}

	/**
	 * Remove one row whose owned PTY has confirmed exit. This never signals a
	 * process: unknown rows, rows without an observed PTY exit, and every
	 * still-owned live process are left untouched. Persistent workspace/native
	 * data is outside the manager's cleanup ownership and is never removed.
	 * Returns true only when the row was removed; otherwise returns false.
	 */
	closeExited(id: string): boolean {
		const record = this.#records.get(id);
		if (!record || !record.pty || !record.ptyExited) {
			return false;
		}
		// The TUI's exit is not this backend's exit: a row whose owned Codex backend has
		// not settled still owns that process, and removing the row would strand it.
		if (ownsUnsettledCodexBackend(record)) {
			return false;
		}
		this.#detachRow(record);
		return true;
	}

	/**
	 * Remove one terminal `error` row that owns no live or unsettled child.
	 *
	 * This is the deliberate error-row cleanup for a failed launch: it never
	 * signals a process, never touches workspace/native files, and never
	 * affects a sibling. It refuses unless the exact record is still in the
	 * map, its own asynchronous launch has positively finished, and the row is
	 * terminally errored. A row that still owns its original PTY refuses while
	 * that child has no confirmed exit; once the exact owned exit is observed
	 * the removal is delegated to {@linkcode closeExited}, preserving that
	 * strict actual-exit-only path and its cleanup exactly. A row that never
	 * created a child is removable only when the failed launch has positively
	 * completed cleanup — its registration and profile admission releases
	 * actually returned (or there was nothing to release) and any saved-session
	 * reservation was cleared. A missing handle, an idempotency latch set before
	 * a throwing release, stale status, an unknown PID, or a false busy/zero
	 * count is never evidence of that. Returns true only when the row was
	 * removed.
	 */
	closeError(id: string): boolean {
		const record = this.#records.get(id);
		if (!record || this.#disposed || record.lifecycle !== "error" || !record.launchSettled) {
			return false;
		}
		if (record.pty) {
			// The original owned child exists: only its own confirmed exit may
			// release it, through the strict exited-row path.
			return record.ptyExited ? this.closeExited(id) : false;
		}
		// No TUI was ever created, but an owned backend child of this very launch may
		// still be live: an unsettled one keeps this row, exactly as an unsettled PTY does.
		if (ownsUnsettledCodexBackend(record)) {
			return false;
		}
		// No child was ever created. Require positively completed cleanup of the
		// failed launch (registration and profile release actually returned, and
		// any saved-session reservation was cleared) instead of an idempotency
		// latch, a missing handle, or UI flags.
		if (!record.registrationReleaseSettled || !record.profileReleaseSettled || record.savedReservation !== undefined) {
			return false;
		}
		this.#detachRow(record);
		return true;
	}

	/**
	 * Detach one already-removable row (no live/unsettled owned child) from the
	 * live map, then dispose only its manager-owned in-memory bookkeeping with
	 * the scoped, idempotent cleanup helpers. Nothing on disk is touched and no
	 * process is signaled. Callers must have established removability.
	 */
	#detachRow(record: ManagedInstance): void {
		// Detach first so even synchronous callbacks caused by cleanup (or
		// callbacks already queued by the PTY/status source) are stale before
		// any retained resource is disposed, and cannot resurrect or retarget
		// this row.
		this.#records.delete(record.id);
		// No surface may keep displaying (or sizing) a row that is gone.
		this.#retireViewerTargets(record.id);
		// A removed row retires its OPTIONAL native status source too: its broker
		// callbacks stop now, and its staged private files are released at the end of this
		// teardown, once this row's own settlement gate below can be evaluated.
		const statusRun = record.nativeStatusRun;
		this.#retireNativeStatusRun(statusRun);
		this.#releaseRegistration(record);
		this.#disposeDataListener(record);
		this.#disposeExitListener(record);
		this.#disposeReadErrorListener(record);
		try {
			record.surface?.dispose();
		} catch {
			// Teardown is scoped to this already-detached row; still notify removal.
		}
		record.surface = undefined;
		record.registration = undefined;
		record.profile = undefined;
		record.pty = undefined;
		record.stopPromise = undefined;
		// Removability already required a settled owned backend; this is the idempotent
		// latch, so a resource can never outlive the row that owns it.
		this.#retireOwnedCodexBackend(record.nativeCodexBackend);
		this.#releaseNativeStatusArtifacts(record, statusRun);
		this.#releaseNativeInitialPrompt(record);
		this.#safeChanged(record.id);
	}

	/** Stop ONLY this exact owned row; removal is a separate actual-exit-only operation. */
	async stop(id: string, options: { readonly confirmed: boolean }): Promise<StopInstanceResult> {
		const record = this.#records.get(id);
		if (!record || this.#disposed || this.#stopping) return { status: "unavailable", forced: false };
		// A row can own live work with no TUI at all: an owned Codex backend retained while
		// its launch is still awaiting readiness is exactly that. Such a row stays stoppable
		// — its operator's stop retires the backend and finishes the pending launch — and it
		// is never reported as "exited" while either of its two processes is unsettled.
		const ownsBackendWork = ownsUnsettledCodexBackend(record);
		if (!record.pty && !ownsBackendWork) {
			// The third shape of owned work is a launch that has produced NOTHING yet: its
			// provider is still preparing, so there is no PTY and no backend to retire. For
			// an owned-capable Codex row that window is still this manager's own row and
			// still its own responsibility, so a confirmed Stop closes admission, retires
			// this run's observation path, and publishes the row-level cancellation the
			// launch races — which is what makes a later provider answer create neither a
			// backend nor a TUI. Without that intent retained here, a stopped row would
			// simply launch when its provider finally returned.
			if (this.#pendingOwnedCodexPreparation(record)) {
				if (options?.confirmed !== true) return { status: "confirmation-required", forced: false };
				record.stopAdmissionClosed = true;
				this.#closeStartupInput(record, true);
				this.#retireNativeStatusRun(record.nativeStatusRun);
				this.#cancelNativeLaunch(record);
				return { status: "unconfirmed", forced: ownedForceEscalationAttempted(record) };
			}
			return { status: "unavailable", forced: ownedForceEscalationAttempted(record) };
		}
		const outcome = (): StopInstanceResult => ({
			status: (!record.pty || record.ptyExited) && !ownsUnsettledCodexBackend(record) ? "exited" : "unconfirmed",
			forced: ownedForceEscalationAttempted(record),
		});
		if (record.ptyExited && !ownsBackendWork) return outcome();
		if (record.stopPromise) { await record.stopPromise; return outcome(); }
		let alreadyRequested = false;
		if (options?.confirmed !== true) {
			// With no TUI yet there are no session facts to prove an idle child, so an
			// unconfirmed stop is refused; a CONFIRMED stop below still closes admission,
			// retires this row's owned backend, and unblocks its launch.
			if (!record.pty || !hasCompleteSessionIdle(record)) return { status: "confirmation-required", forced: false };
			const registration = record.registration;
			if (!registration || record.registrationReleased) return { status: "confirmation-required", forced: false };
			let shutdown: InstanceStatusRegistration["shutdown"];
			try {
				shutdown = registration.shutdown;
			} catch {
				return { status: "confirmation-required", forced: false };
			}
			if (typeof shutdown !== "function") return { status: "confirmation-required", forced: false };
			// Fence child-originated spawn requests before the authenticated
			// shutdown preflight can yield. A positive idle-only rejection below
			// reopens admission because no stop was actually accepted.
			record.stopAdmissionClosed = true;
			// The startup input phase does NOT reopen with admission: it is sticky.
			this.#closeStartupInput(record, true);
			// Register before the public request, because it may synchronously exit.
			// This bounded preflight never sends a fallback signal or force attempt.
			const exit = this.#waitForExit(record, DEFAULT_SHUTDOWN_GRACE_MS);
			let request: Promise<StatusShutdownResult | undefined>;
			try {
				request = Promise.resolve(shutdown.call(registration, { requireIdle: true })).catch(() => undefined);
			} catch {
				return { status: "confirmation-required", forced: false };
			}
			const first = await Promise.race([
				request.then((result) => ({ kind: "request" as const, result })),
				exit.then((exited) => ({ kind: "exit" as const, exited })),
			]);
			if (record.ptyExited) return outcome();
			if (this.#records.get(id) !== record || this.#disposed) return { status: "unavailable", forced: ownedForceEscalationAttempted(record) };
			if (first.kind !== "request" || !validShutdownRequest(first.result)) {
				if (first.kind === "request" && first.result?.status === "not-idle") {
					record.stopAdmissionClosed = false;
				}
				return { status: "confirmation-required", forced: ownedForceEscalationAttempted(record) };
			}
			alreadyRequested = true;
		} else {
			// Explicit confirmation starts this exact row's terminal stop path.
			record.stopAdmissionClosed = true;
			this.#closeStartupInput(record, true);
		}
		await this.#gracefulStop(record, DEFAULT_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_KILL_MS, alreadyRequested);
		return outcome();
	}

	/** Launch one independently owned instance and resolve with its row id. */
	create(options: CreateInstanceOptions): Promise<string> {
		return this.#createInstance(options);
	}

	/**
	 * The one native create path, shared verbatim by the public {@linkcode create}
	 * and the guarded saved Resume handoff. Private so a guarded handoff can never be
	 * redirected through an overridden or injected method.
	 */
	async #createInstance(options: CreateInstanceOptions): Promise<string> {
		if (this.#disposed || this.#stopping) {
			throw new Error("session-host: the instance manager is shut down; no new instances can be created");
		}
		const backend = resolveSessionBackend(options?.backend);
		const nativeCliTarget = options?.nativeCliTarget === undefined
			? undefined
			: validateNativeCliTarget(options.nativeCliTarget);
		// A native CLI row starts from its stable provider label: a provider's own
		// conversation title, like an operator's caption, is only ever known once the
		// row exists, so nothing here waits for a name or invents one. An explicit
		// label on a native row is its stored CAPTION (a remembered slot restores
		// exactly this way): it is admitted whole by the caption rule and published
		// through the bounded label projection, never clipped in storage.
		const explicitCaption = options?.label !== undefined && isNativeCliBackend(backend)
			? validateNativeCaption(options.label)
			: undefined;
		let label = options?.label === undefined
			? (isNativeCliBackend(backend) ? sessionBackendDisplayLabel(backend) : "(session starting)")
			: (explicitCaption !== undefined ? projectNativeCaptionLabel(explicitCaption) : validateLabel(options.label));
		if (typeof options?.workspace !== "string" || options.workspace === "") {
			throw new Error("session-host: create requires an explicit workspace directory");
		}
		const profile = options.profile;
		if (profile !== undefined && typeof profile !== "string") {
			throw new Error("session-host: the instance profile directory must be a string");
		}
		const savedSession = options.savedSession;
		if (savedSession !== undefined && !isSavedSessionAdmission(savedSession)) {
			throw new Error("session-host: the saved-session selection is not a valid admission receipt; select from the current saved-conversation catalog");
		}
		// The exact saved header cwd determines the child workspace; a
		// conflicting explicit workspace is refused, never silently substituted.
		if (savedSession !== undefined && options.workspace !== savedSession.workspace) {
			throw new Error("session-host: a saved-session selection uses the conversation's recorded workspace");
		}
		const initialRequest = options.initialRequest === undefined ? undefined : validateInitialRequest(options.initialRequest);
		// Opt-in workspace creation is an exact boolean; only `true` creates anything.
		// A recorded workspace (saved conversation or native resume) is never created.
		const createWorkspaceOption: unknown = options.createWorkspace;
		if (createWorkspaceOption !== undefined && typeof createWorkspaceOption !== "boolean") {
			throw new Error("session-host: the create-workspace option must be a boolean");
		}
		const createWorkspace = createWorkspaceOption === true;
		if (createWorkspace && savedSession !== undefined) {
			throw new Error("session-host: a saved conversation uses its recorded workspace; it cannot be combined with workspace creation");
		}
		if (createWorkspace && options.nativeResumeConversationId !== undefined) {
			throw new Error("session-host: a native conversation resume cannot be combined with workspace creation");
		}
		if (initialRequest !== undefined && savedSession !== undefined) {
			throw new Error("session-host: a fresh initial request cannot be combined with a saved conversation");
		}
		// A native CLI row is an ordinary provider child, so every Pi-specific launch
		// input is refused here — before any row, reservation, or callback exists —
		// and a native request is never quietly served as a Pi launch. A Pi row never
		// gets a configured native launch target either: an explicit operator choice
		// that cannot apply is refused rather than silently ignored.
		if (isNativeCliBackend(backend)) {
			if (this.#nativeCliLaunch === undefined) {
				throw new Error("session-host: this host has no native CLI launch provider, so the requested backend cannot start");
			}
			if (profile !== undefined) {
				throw new Error("session-host: a native CLI row never uses a Pi profile directory");
			}
			if (savedSession !== undefined) {
				throw new Error("session-host: a native CLI row never opens a Pi saved conversation");
			}
			// A native startup request (issue #493) is a FRESH conversation with its own
			// exact title: it can never be combined with a restoration, which resumes an
			// existing conversation, or with a configured caption, which would leave two
			// competing names for one row.
			if (initialRequest !== undefined && options.nativeResumeConversationId !== undefined) {
				throw new Error("session-host: a native startup request cannot be combined with a conversation resume");
			}
			if (initialRequest !== undefined && options.label !== undefined) {
				throw new Error("session-host: a native startup request carries its own title; no separate label is accepted");
			}
		} else if (nativeCliTarget !== undefined) {
			throw new Error("session-host: a native CLI launch target is only valid for a native CLI backend");
		}
		// The owner-only restoration intent is admitted only as one exact provider UUID
		// for a native CLI row, before any row, reservation, or callback exists.
		const nativeResumeConversationId = options.nativeResumeConversationId;
		if (nativeResumeConversationId !== undefined) {
			if (!isNativeCliBackend(backend)) {
				throw new Error("session-host: a native conversation resume is only valid for a native CLI backend");
			}
			if (!isNativeConversationId(nativeResumeConversationId)) {
				throw new Error("session-host: the native conversation resume id must be an exact provider conversation id");
			}
		}
		// A Codex startup title has no native provider option, so it is honored as this
		// row's stored caption, exactly as requested (issue #493). The published label is
		// that caption's bounded display projection; the stored caption stays whole.
		const startupCaption = backend === "codex" && initialRequest !== undefined ? initialRequest.title : undefined;
		const nativeCaption = explicitCaption ?? startupCaption;
		if (startupCaption !== undefined) label = projectNativeCaptionLabel(startupCaption);
		// Synchronous known-owned duplicate fence and reservation BEFORE any
		// await: concurrent deliberate opens of the same saved conversation
		// cannot both spawn, including pending creations of siblings.
		if (savedSession !== undefined) {
			this.#assertSavedSessionAvailable(savedSession);
		}
		const id = randomUUID();
		// Row posted (resource ownership starts here) before any async step.
		const record: ManagedInstance = {
			id,
			label,
			nativeSession: null,
			workspace: options.workspace,
			agentDir: "",
			lifecycle: "starting",
			...(options.backend === undefined ? {} : { backend }),
			...(isNativeCliBackend(backend)
				? {
					nativeCliTarget: nativeCliTarget ?? NATIVE_CLI_DEFAULT_TARGET_IDS[backend],
					...(nativeResumeConversationId === undefined
						? {}
						: { nativeResumeConversationId, nativeConversationId: nativeResumeConversationId }),
					nativeConversationConfirmed: false,
					nativeConversationLive: false,
					// An explicit initial label on a native row is a CONFIGURED caption
					// (a remembered slot restores exactly this way), and a Codex startup
					// title is the caption the requester asked for, so either latches from
					// the start and no automatic provider title can displace it.
					...(nativeCaption === undefined ? {} : { nativeCaption }),
				}
				: {}),
			busy: null,
			pendingInput: null,
			inputSurface: false,
			backgroundTasks: null,
			backgroundShells: null,
			activeTasks: null,
			activeShells: null,
			activityRefreshAttempts: 0,
			activityRefreshEpisodeOpen: false,
			statusRevision: 0,
			nativeStatusObserverGeneration: 0,
			// A native CLI row's launch is in preparation from the moment this row exists,
			// so a confirmed Stop can cancel it before any child of it is created.
			nativeCliLaunchPending: isNativeCliBackend(options.backend),
			activity: [],
			cols: this.#cols,
			rows: this.#rows,
			geometryRevision: 0,
			inputFramingRequested: false,
			inputFramingReady: false,
			nativeCliInputOrdinal: 0,
			startupInputOpen: false,
			savedReservation: savedSession !== undefined
				? { sessionId: savedSession.sessionId, file: savedSession.file }
				: undefined,
			launchSettled: false,
			profileReleased: false,
			profileReleaseSettled: false,
			registrationReleased: false,
			registrationReleaseSettled: false,
			ptyExited: false,
			stopAdmissionClosed: false,
			sigtermSent: false,
			sigkillSent: false,
			exitWaiters: [],
		};
		this.#records.set(id, record);
		this.#safeChanged(id);
		const launch = this.#launchInstance(record, {
			workspace: options.workspace,
			profile,
			savedSession,
			initialRequest,
			...(nativeCliTarget === undefined ? {} : { nativeCliTarget }),
			...(createWorkspace ? { createWorkspace: true } : {}),
		});
		this.#inflightCreates.add(launch);
		try {
			await launch;
		} finally {
			this.#inflightCreates.delete(launch);
			// This exact row's launch has positively finished: no later spawn can
			// occur for it, whatever the launch settled as. The flag is per record,
			// so a sibling's pending or failing launch can never qualify this row.
			record.launchSettled = true;
		}
		return id;
	}

	/**
	 * Refuse a saved-session admission that a known-owned row already holds:
	 * an active reservation (pending or live creation) with the same session id
	 * or exact file, or a live row whose last-observed current native binding
	 * is the same conversation. Exited and removed rows never block reopening.
	 */
	#assertSavedSessionAvailable(admission: SavedSessionAdmission): void {
		for (const record of this.#records.values()) {
			const live = Boolean(record.pty && !record.ptyExited);
			if (!live && record.savedReservation === undefined) continue;
			if (record.savedReservation !== undefined
				&& (record.savedReservation.sessionId === admission.sessionId
					|| record.savedReservation.file === admission.file)) {
				throw new Error("session-host: the saved conversation is already open in this host");
			}
			if (live && record.knownNativeSessionId === admission.sessionId) {
				throw new Error("session-host: the saved conversation is already open in this host");
			}
		}
	}

	/**
	 * Known-owned bindings for saved-conversation admission and deletion
	 * fencing: separately tagged current ID/file observations, exact admitted
	 * reservations (including pending creations), and historical ID-only
	 * launch fences. Data only — no process discovery, scan, daemon, or lock.
	 * Exited and removed rows contribute nothing, and so does every row this
	 * manager knows to be a native CLI child: a Claude or Codex row never loads,
	 * reserves, or rebinds a Pi conversation, so it is not evidence about one.
	 */
	ownedLiveSessions(): readonly OwnedLiveSession[] {
		return this.#ownedSessionCensus();
	}

	/**
	 * Private, side-effect-free census behind {@linkcode ownedLiveSessions}: read
	 * only from this manager's own records, never through a public or overridable
	 * method, so the guarded saved primitives can consult it after a caller's final
	 * authorization with no foreign code in between.
	 */
	#ownedSessionCensus(): OwnedLiveSession[] {
		const sessions: OwnedLiveSession[] = [];
		for (const record of this.#records.values()) {
			// A known native CLI row owns no Pi conversation at all: it contributes
			// neither a current binding nor an unknown-binding placeholder, so a
			// provider child never blocks a Pi saved conversation. An unknown Pi row
			// still contributes exactly what it did before.
			if (isNativeCliRow(record)) continue;
			const live = Boolean(record.pty && !record.ptyExited);
			if (!live && record.savedReservation === undefined) continue;
			if (record.savedReservation !== undefined) {
				// Keep the initial exact admission as its own paired binding. It is
				// never reused as the current native file after /new or /resume.
				sessions.push({
					kind: "reservation",
					id: record.savedReservation.sessionId,
					file: record.savedReservation.file,
				});
			}
			if (live) {
				// Emit a current binding even when no native metadata/path is
				// available: deletion then refuses instead of treating absence as
				// evidence that this child is unrelated.
				sessions.push({
					kind: "current",
					...(record.nativeSession ? { id: record.nativeSession.sessionId } : {}),
					...(record.currentNativeSessionFile === undefined ? {} : { file: record.currentNativeSessionFile }),
				});
				// Preserve the historical ID duplicate fence for launch admission,
				// but never present that retained ID as deletion evidence.
				if (record.knownNativeSessionId !== undefined
					&& record.knownNativeSessionId !== record.nativeSession?.sessionId) {
					sessions.push({ kind: "known-id", id: record.knownNativeSessionId });
				}
			}
		}
		return sessions;
	}

	/**
	 * Deletion-safety census from this manager's own records: the private census
	 * plus one explicit binding-less entry whenever a live child has no current
	 * native tuple. This is the same rule as the service's
	 * `savedDeletionOwnedSessions`, read privately instead of through the public
	 * `list()`/`ownedLiveSessions()` callouts.
	 */
	#savedDeletionCensus(): OwnedLiveSession[] {
		const sessions = this.#ownedSessionCensus();
		for (const record of this.#records.values()) {
			if (isNativeCliRow(record)) continue;
			if (record.pty && !record.ptyExited && !record.nativeSession) {
				sessions.push({});
				break;
			}
		}
		return sessions;
	}

	/**
	 * Guarded native saved-conversation Resume (the primitive a later remote
	 * provider calls). The existing local admit/create path is unchanged.
	 *
	 * Fail-closed order, every step before the create invocation synchronous:
	 * 1. pure pre-authorization gates — this manager's stop/dispose latches, a
	 *    callable guard, and membership of the exact row in a branded catalog;
	 * 2. the caller's final guard, exactly once (only `true` authorizes);
	 * 3. with no await and no foreign callback from here to the handoff: the
	 *    stop/dispose latches again, this manager's private census, and the actual
	 *    native admission (catalog revision, sessions root/project, file type, inode,
	 *    header id/cwd, existing workspace, known-owned duplicates);
	 * 4. the protected invocation — the same private native create path `create`
	 *    uses, with the branded admission and its recorded workspace, so its
	 *    synchronous reservation and duplicate fence and the launch-time admission
	 *    revalidation all still apply.
	 *
	 * Only step 1–3 can yield `refused`. Once step 4 is invoked the work is accepted
	 * owner work: it is classified from this manager's own record like
	 * `startSession` does and is never stopped, cancelled, retried, or reported as
	 * refused because authorization was lost later.
	 */
	async startSavedSession(
		catalog: SavedSessionCatalog,
		row: SavedSessionRow,
		authorize: SavedMutationAuthorization,
	): Promise<GuardedSavedResumeResult> {
		if (this.#disposed || this.#stopping) return { status: "refused", reason: "unavailable" };
		if (typeof authorize !== "function") return { status: "refused", reason: "not-authorized" };
		if (!isSavedSessionCatalog(catalog) || !catalog.rows.includes(row)) {
			return { status: "refused", reason: "unknown-row" };
		}
		if (!callerAuthorized(authorize)) return { status: "refused", reason: "not-authorized" };
		// From the guard's return to the handoff: own facts and native checks only.
		if (this.#disposed || this.#stopping) return { status: "refused", reason: "unavailable" };
		let admitted: SavedSessionAdmissionResult;
		try {
			admitted = admitSavedSession(catalog, row, { ownedLiveSessions: this.#ownedSessionCensus() });
		} catch {
			return { status: "refused", reason: "unknown-row" };
		}
		if (admitted.status !== "admitted") return { status: "refused", reason: admitted.reason };
		const admission = admitted.admission;
		// The protected invocation. Its synchronous prefix posts the row and the
		// reservation before anything can yield.
		const launch = this.#createInstance({ workspace: admission.workspace, savedSession: admission });
		let id: string;
		try {
			id = await launch;
		} catch (error) {
			return isOwnedDuplicateLaunchError(error) ? { status: "duplicate" } : { status: "failed" };
		}
		// A create that settled while this manager began stopping may own a child
		// that is no longer observable as usable: claim no result.
		if (this.#disposed || this.#stopping) return { status: "unknown" };
		const record = this.#records.get(id);
		if (record === undefined || record.lifecycle === "error" || record.lifecycle === "starting") {
			return { status: "not-ready" };
		}
		return { status: "started", id };
	}

	/**
	 * Guarded native saved-conversation Delete (the primitive a later remote
	 * provider calls). The existing local deletion path is unchanged.
	 *
	 * Pure pre-authorization gates (stop/dispose latches, a callable guard, exact
	 * row membership in a branded catalog) run first. The existing native
	 * trash-first `deleteSavedSessionFile` then runs with this manager's OWN
	 * validation, which it calls immediately before EACH mutation stage: the
	 * caller's guard, then — synchronously, with no foreign callback — the
	 * stop/dispose latches, this manager's private deletion census (current files,
	 * exact reservations, historical ids, and an explicit unknown binding for a live
	 * child without a tuple), and the actual native deletion validation (revision,
	 * root/project, file type, inode, header). A missing workspace stays deletable
	 * exactly as locally. A replacement or authorization loss observed after trash
	 * therefore prevents the unlink fallback.
	 *
	 * The manager tracks whether the trash or unlink handoff was ever invoked:
	 * `refused` only before either, `deleted` for native success whatever happens to
	 * authorization afterwards, and `unconfirmed` once a handoff may have run.
	 */
	deleteSavedSession(
		catalog: SavedSessionCatalog,
		row: SavedSessionRow,
		authorize: SavedMutationAuthorization,
	): GuardedSavedDeletionResult {
		if (this.#disposed || this.#stopping) return { status: "refused", reason: "unavailable" };
		if (typeof authorize !== "function") return { status: "refused", reason: "not-authorized" };
		if (!isSavedSessionCatalog(catalog) || !catalog.rows.includes(row)) {
			return { status: "refused", reason: "unknown-row" };
		}
		// A minted row is frozen catalog data: reading its path runs no foreign code.
		const file = row.file;
		const adapters = savedDeletionAdaptersForTests;
		const trashHandoff = adapters?.spawnSync ?? nodeSpawnSync;
		const unlinkHandoff = adapters?.unlink ?? unlinkSync;
		let trashInvoked = false;
		let unlinkInvoked = false;
		let stageRefusal: GuardedSavedDeletionRefusalReason | undefined;
		const validate = (): string | undefined => {
			stageRefusal = this.#guardedSavedDeletionRefusal(catalog, row, authorize);
			return stageRefusal;
		};
		// Each wrapper records the handoff BEFORE invoking it: whatever the handoff
		// then does (including reentering this manager), it may have run.
		const trash = ((command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
			trashInvoked = true;
			return trashHandoff(command, args, options);
		}) as unknown as typeof nodeSpawnSync;
		const unlink = (path: string): void => {
			unlinkInvoked = true;
			unlinkHandoff(path);
		};
		let result: SavedSessionDeletionResult;
		try {
			result = deleteSavedSessionFile(file, { validate, spawnSync: trash, unlink });
		} catch {
			return trashInvoked || unlinkInvoked
				? { status: "unconfirmed", trashInvoked, unlinkInvoked }
				: { status: "refused", reason: "unavailable" };
		}
		if (result.ok === true) return { status: "deleted", method: result.method };
		if (!trashInvoked && !unlinkInvoked) {
			return { status: "refused", reason: stageRefusal ?? "unavailable" };
		}
		return {
			status: "unconfirmed",
			trashInvoked,
			unlinkInvoked,
			...(!unlinkInvoked && stageRefusal !== undefined ? { fallbackRefusal: stageRefusal } : {}),
		};
	}

	/**
	 * One guarded deletion stage check: the caller's guard, then only this
	 * manager's own facts and the native validation, with nothing foreign after the
	 * guard. Never throws.
	 */
	#guardedSavedDeletionRefusal(
		catalog: SavedSessionCatalog,
		row: SavedSessionRow,
		authorize: SavedMutationAuthorization,
	): GuardedSavedDeletionRefusalReason | undefined {
		if (!callerAuthorized(authorize)) return "not-authorized";
		if (this.#disposed || this.#stopping) return "unavailable";
		try {
			return validateSavedSessionDeletion(catalog, row, { ownedLiveSessions: this.#savedDeletionCensus() });
		} catch {
			return "unknown-live-binding";
		}
	}

	/**
	 * Rename only the currently observed native conversation through its
	 * authenticated registration. The expected tuple is checked before and
	 * after the broker call; stale/released owners never receive an optimistic
	 * caption update.
	 */
	async rename(id: string, request: StatusRenameRequest): Promise<StatusRenameResult> {
		const record = this.#records.get(id);
		const requestId = randomUUID();
		const expectedSessionId = request?.expectedSessionId;
		const expectedSessionEpoch = request?.expectedSessionEpoch;
		const name = request?.name;
		const observed = (): { observedSessionId: string | null; observedSessionEpoch: number | null } => ({
			observedSessionId: record?.nativeSession?.sessionId ?? null,
			observedSessionEpoch: record?.nativeSession?.epoch ?? null,
		});
		const result = (status: StatusRenameResult["status"], resultId: string = requestId): StatusRenameResult => ({
			requestId: resultId,
			status,
			...(typeof expectedSessionId === "string" ? { expectedSessionId } : {}),
			...(Number.isSafeInteger(expectedSessionEpoch) ? { expectedSessionEpoch } : {}),
			...observed(),
		});
		if (!isValidNativeSessionId(expectedSessionId)
			|| !Number.isSafeInteger(expectedSessionEpoch) || expectedSessionEpoch <= 0) {
			return result("invalid-request");
		}
		if (!isValidRenameName(name)) return result("invalid-name");
		if (!record || this.#disposed || !record.registration || record.registrationReleased) {
			return result(record ? "disconnected" : "unavailable");
		}
		if (!record.nativeSession) return result("unavailable");
		if (record.nativeSession.sessionId !== expectedSessionId || record.nativeSession.epoch !== expectedSessionEpoch) {
			return result("stale-session");
		}
		const registration = record.registration;
		if (typeof registration.rename !== "function") return result("unavailable");
		let brokerResult: StatusRenameResult;
		try {
			brokerResult = await registration.rename({ expectedSessionId, expectedSessionEpoch, name });
		} catch {
			return result("disconnected");
		}
		if (this.#records.get(id) !== record || record.registration !== registration || record.registrationReleased) {
			return result("disconnected", brokerResult.requestId);
		}
		if (!record.nativeSession
			|| record.nativeSession.sessionId !== expectedSessionId
			|| record.nativeSession.epoch !== expectedSessionEpoch) {
			return result("stale-session", brokerResult.requestId);
		}
		const statuses: readonly StatusRenameResult["status"][] = [
			"renamed", "stale-session", "unavailable", "invalid-name", "setter-failed",
			"verification-failed", "busy", "timeout", "disconnected", "invalid-request",
		];
		if (!brokerResult || typeof brokerResult.requestId !== "string" || !statuses.includes(brokerResult.status)
			|| brokerResult.expectedSessionId !== expectedSessionId
			|| brokerResult.expectedSessionEpoch !== expectedSessionEpoch) {
			return result("verification-failed", typeof brokerResult?.requestId === "string" ? brokerResult.requestId : requestId);
		}
		return result(brokerResult.status, brokerResult.requestId);
	}

	/** Write input to the explicitly addressed known-alive child. Never a fallback. */
	write(id: string, data: string | Buffer): void {
		this.#assertUsable("write");
		if (typeof data !== "string" && !Buffer.isBuffer(data)) {
			throw new Error("session-host: instance input must be a string or Buffer");
		}
		const record = this.#records.get(id);
		if (!record) {
			throw new Error("session-host: unknown instance id; input is routed to explicit ids only");
		}
		const pty = record.pty;
		if (!pty || record.ptyExited || record.lifecycle !== "alive") {
			throw new Error(`session-host: instance ${id} is not accepting input (lifecycle ${record.lifecycle})`);
		}
		// Local user input only. There is deliberately no origin parameter: a
		// viewer cannot route input through this seam in this phase, and an opaque
		// viewer token alone would be no grant.
		if (data.length > 0 && isNativeCliBackend(record.backend)) {
			// Nonempty owner-local user input is about to be handed to a hosted provider
			// child, so the previous controller stops being the copy recipient NOW: a
			// write that partially reaches the child and then throws leaves nobody
			// attributed until a later input write actually returns. Empty writes,
			// protocol replies, and Pi rows never reach here and change nothing.
			record.nativeCliController = undefined;
		}
		this.#writeChildInput(record, pty, data, LOCAL_INPUT_ORIGIN);
		// Only bytes that actually left for this child count. On a hosted provider row
		// this makes the owner the current copy recipient; on a Pi row it changes
		// nothing, because Pi copies carry their own per-dispatch origin.
		this.#noteNativeCliLocalInput(record, data);
	}

	/**
	 * Update the geometry of every live instance: both instances the
	 * frontend shows and hidden ones (hiding or switching is a frontend
	 * concern; the manager never stops a child for selection or hiding). This is
	 * the host-wide operation for a host that gives every child one shared
	 * geometry; a host that sizes each session by its own viewers uses
	 * {@linkcode resizeInstance} through the viewer seam instead, and rows with no
	 * viewers of their own keep their last size.
	 */
	resize(cols: number, rows: number): void {
		this.#assertUsable("resize");
		validateDimension(cols, "cols");
		validateDimension(rows, "rows");
		this.#cols = cols;
		this.#rows = rows;
		for (const record of this.#records.values()) {
			// A finished child keeps its frozen frame; only rows that can still
			// run (or have not spawned yet) take the new geometry.
			if (record.ptyExited) {
				continue;
			}
			this.#applyGeometry(record, cols, rows);
		}
	}

	/**
	 * Adopt one host pane size as the initial-sizing rule for rows created from
	 * now on (#474). Resizes nothing: a row nobody is viewing keeps its last
	 * canonical size, while a new row that has never been viewed starts at the
	 * host's current geometry, exactly as before per-session sizing.
	 */
	setInitialGeometry(cols: number, rows: number): void {
		this.#assertUsable("setInitialGeometry");
		validateDimension(cols, "cols");
		validateDimension(rows, "rows");
		this.#cols = cols;
		this.#rows = rows;
	}

	/**
	 * Resize exactly one addressed row (#474). Never touches a sibling: per-row
	 * geometry is deliberate and addressed, and an unknown, finished, or errored
	 * row is reported as not resized rather than guessed at. A row that has not
	 * spawned yet records the geometry its spawn will use.
	 */
	resizeInstance(id: string, cols: number, rows: number): boolean {
		this.#assertUsable("resizeInstance");
		validateDimension(cols, "cols");
		validateDimension(rows, "rows");
		const record = this.#records.get(id);
		if (!isViewableRow(record)) {
			return false;
		}
		return this.#applyGeometry(record as ManagedInstance, cols, rows);
	}

	/**
	 * The canonical content geometry of one row, or undefined for an unknown row.
	 * This is the manager's own fact (the size its PTY and surface have), so a
	 * frontend can fence stale hit targets on it without a second geometry store.
	 */
	instanceGeometry(id: string): SessionGeometry | undefined {
		const record = this.#records.get(id);
		if (record === undefined) {
			return undefined;
		}
		return { cols: record.cols, rows: record.rows, revision: record.geometryRevision };
	}

	/**
	 * Register one viewing surface (#474). The registration carries no authority
	 * over input, lifecycle, or another row; ids are never reused, so a stale
	 * callback can never address a newer surface. Returns undefined once this
	 * manager is stopping or disposed.
	 *
	 * The optional local-only options bind this surface to its owning host run and
	 * give it its own native copy sink. Both are stored in this viewer's own record
	 * and are immutable for its life; the published {@linkcode viewerState} facts and
	 * the no-argument call are unchanged, and no second viewer store exists. Binding
	 * them is what makes the surface eligible for {@linkcode readViewerInputSource}
	 * and {@linkcode writeViewerInput} later — it grants nothing by itself, and a
	 * callback is never an input authority.
	 */
	openViewer(options?: ViewerOpenOptions): SessionViewerState | undefined {
		if (this.#disposed || this.#stopping) {
			return undefined;
		}
		const viewer: ManagedViewer = {
			id: `viewer-${this.#nextViewerId++}`,
			sessionId: undefined,
			cols: undefined,
			rows: undefined,
			revision: 1,
		};
		if (options !== undefined) {
			// A closed, optional options object: only these two facts exist, and both are
			// immutable for the life of this viewer record.
			if (!isPlainRecord(options)
				|| !Object.keys(options).every((key) => key === "hostRunId" || key === "nativeClipboardSink")) {
				throw new Error("session-host: viewer registration options must be an absent or closed options object");
			}
			const hostRunId = options.hostRunId;
			if (hostRunId !== undefined) {
				if (typeof hostRunId !== "string" || !VIEWER_FACT_FIELD.test(hostRunId)) {
					throw new Error("session-host: viewer host run identity must be bounded printable text");
				}
				viewer.hostRunId = hostRunId;
			}
			const sink = options.nativeClipboardSink;
			if (sink !== undefined) {
				if (typeof sink !== "function") {
					throw new Error("session-host: viewer native clipboard sink must be a function");
				}
				viewer.nativeClipboardSink = (receipt) => { sink(receipt); };
			}
		}
		this.#viewers.set(viewer.id, viewer);
		return viewerState(viewer);
	}

	/** Current facts of one registered surface, or undefined once it is gone. */
	viewerState(viewerId: string): SessionViewerState | undefined {
		const viewer = this.#viewers.get(viewerId);
		return viewer === undefined ? undefined : viewerState(viewer);
	}

	/** Every registered surface currently displaying one row (copied facts). */
	sessionViewers(sessionId: string): SessionViewerState[] {
		const states: SessionViewerState[] = [];
		for (const viewer of this.#viewers.values()) {
			if (viewer.sessionId === sessionId) states.push(viewerState(viewer));
		}
		return states;
	}

	/**
	 * Change one surface's content target and/or pane size, then recompute only
	 * the sessions its change could affect: its previous target and its new one.
	 * A row's canonical geometry becomes the independent minimum columns and
	 * minimum rows over the surfaces that display it and contribute dimensions;
	 * with no contributing surface the row keeps its last size. No other row is
	 * ever resized, and no viewer gets exclusive control of anything.
	 */
	updateViewer(viewerId: string, update: SessionViewerUpdate = {}): SessionViewerUpdateResult {
		if (this.#disposed) {
			return { applied: false, reason: "disposed" };
		}
		const viewer = this.#viewers.get(viewerId);
		if (viewer === undefined) {
			return { applied: false, reason: "unknown-viewer" };
		}
		if (update.expectedRevision !== undefined && update.expectedRevision !== viewer.revision) {
			return { applied: false, reason: "stale" };
		}
		const target = update.sessionId === null ? undefined : update.sessionId ?? viewer.sessionId;
		const cols = update.cols === undefined ? viewer.cols : update.cols;
		const rows = update.rows === undefined ? viewer.rows : update.rows;
		if ((cols === undefined) !== (rows === undefined)) {
			return { applied: false, reason: "invalid-geometry" };
		}
		if (cols !== undefined) {
			try {
				validateDimension(cols, "cols");
				validateDimension(rows as number, "rows");
			} catch {
				return { applied: false, reason: "invalid-geometry" };
			}
		}
		if (target !== undefined && !isViewableRow(this.#records.get(target))) {
			// An unknown, exited, or errored row is never a content target, so a
			// late completion cannot resurrect a finished view or hold geometry for it.
			return { applied: false, reason: "unknown-session" };
		}
		const previous = viewer.sessionId;
		viewer.sessionId = target;
		viewer.cols = cols;
		viewer.rows = rows;
		viewer.revision += 1;
		if (previous !== undefined) this.#recomputeViewerGeometry(previous);
		if (target !== undefined && target !== previous) this.#recomputeViewerGeometry(target);
		return { applied: true, state: viewerState(viewer) };
	}

	/** Retire one surface. Its previous session keeps its last size for any viewer left. */
	closeViewer(viewerId: string): boolean {
		const viewer = this.#viewers.get(viewerId);
		if (viewer === undefined) {
			return false;
		}
		this.#viewers.delete(viewerId);
		if (viewer.sessionId !== undefined) this.#recomputeViewerGeometry(viewer.sessionId);
		return true;
	}

	/**
	 * The CURRENT immutable input scope of one registered surface, or undefined when
	 * this surface cannot take viewer input right now: it is unknown or retired, was
	 * registered without this host's run identity (or, for a Pi row, without its own
	 * copy sink), shows no row or a row that is gone/finished/stopping, is a Pi row
	 * whose framing was not requested or whose readiness was never verified, or has no
	 * current native conversation outside its explicit startup phase. A hosted
	 * provider CLI row yields its process-incarnation source only while this manager
	 * still owns its live PTY and surface. Resolving never writes, resizes, queues,
	 * spawns, or changes any state, and the returned token describes the facts rather
	 * than granting anything.
	 *
	 * There is no terminal-text field on purpose: the input owner is the surface and
	 * its conversation, not the newest line on screen.
	 */
	readViewerInputSource(viewerId: string): NativeViewerAnyInputSource | undefined {
		const scope = this.#viewerInputScope(viewerId);
		return scope.ok ? scope.source : undefined;
	}

	/**
	 * Write viewer-origin input to exactly the row this viewer displays.
	 *
	 * Fail-closed order, all of it before any possible PTY write and with no await
	 * anywhere:
	 * 1. the request shape (a malformed request, empty bytes, or a dispatch larger
	 *    than the child's technical whole-dispatch assembly bound is refused);
	 * 2. the CURRENT scope — same manager, live row, exact unreleased registration,
	 *    framed and ready, known native tuple, and a mintable scope token; or, for a
	 *    hosted provider CLI row, this manager's live ownership of its PTY and surface
	 *    and that process incarnation's current private scope key;
	 * 3. EVERY expected source fact against the current one, including the canonical
	 *    geometry revision, this viewer's revision, the native tuple (or the native
	 *    CLI backend), the registration identity/generation, and the host run — an ABA
	 *    change (resized away and back, reselected, new run, new registration, new
	 *    epoch, a replaced child process, row exit, stop, release) is a refusal, and
	 *    nothing is ever inferred from the bytes;
	 * 4. the CURRENT input modes against the modes the bytes were made for, because
	 *    the same bytes mean something else in another mode (modes, descriptors, and
	 *    tokens are freshness evidence, never authority);
	 * 5. one more core-scope recheck after the modes read, in case a reentrant
	 *    observer changed the facts in between.
	 *
	 * A Pi row's input is then framed with this registration's own encoder under the
	 * viewer origin, carrying the current native tuple as the child-side fence. A
	 * hosted provider CLI row's input is written RAW to its own PTY, because no Pi
	 * registration, encoder, or child-side decoder exists for it.
	 * A refusal never touches the child. Once the write seam was invoked, a throw is
	 * reported as `unknown` — never retried, queued, replayed, or re-routed.
	 */
	writeViewerInput(viewerId: string, request: NativeViewerInputRequest): NativeViewerInputResult {
		if (invalidViewerInputRequest(request)) {
			return { status: "refused", reason: "invalid-input" };
		}
		const scope = this.#viewerInputScope(viewerId);
		if (!scope.ok) {
			return { status: "refused", reason: scope.reason };
		}
		if (!sameAnyViewerInputSource(scope.source, request.expectedSource)) {
			return { status: "refused", reason: "stale-source" };
		}
		const modes = this.#readViewerInputModes(scope.record);
		if (modes === undefined) {
			return { status: "refused", reason: "modes-unavailable" };
		}
		if (!sameViewerInputModes(modes, request.expectedInputModes)) {
			return { status: "refused", reason: "stale-input-modes" };
		}
		const current = this.#viewerInputScope(viewerId);
		if (!current.ok) {
			return { status: "refused", reason: current.reason };
		}
		if (!sameAnyViewerInputSource(current.source, scope.source)
			|| current.source.sourceToken !== request.expectedSource.sourceToken) {
			return { status: "refused", reason: "stale-source" };
		}
		const pty = current.record.pty;
		if (pty === undefined) {
			return { status: "refused", reason: "row-unavailable" };
		}
		if (isNativeViewerNativeCliInputSource(current.source)) {
			// A hosted provider child takes its bytes RAW: there is no Pi registration,
			// no per-registration encoder, no framed origin, and no child-side fence for
			// it. The remaining fences are the owner's own: the current incarnation key,
			// live ownership of this exact handle, and a non-stopping row.
			return this.#writeNativeCliViewerInput(current.viewer, current.record, pty, current.source, request.data);
		}
		let fence: NativeInputExpectedFence;
		if (isNativeViewerStartupInputSource(current.source)) {
			// The startup fence is the child's own explicit phase, never a tuple. The
			// row must STILL be before its first accepted status with no observed
			// tuple at this exact instant; a once-known or lost tuple never qualifies.
			if (!current.record.startupInputOpen || current.record.nativeSession !== null) {
				return { status: "refused", reason: "stale-source" };
			}
			fence = STARTUP_INPUT_FENCE;
		} else {
			const native = current.record.nativeSession;
			if (native === null) {
				return { status: "refused", reason: "row-unavailable" };
			}
			fence = Object.freeze({ sessionId: native.sessionId, epoch: native.epoch });
		}
		const origin: NativeInputOrigin = Object.freeze({ kind: "viewer" as const, token: current.source.sourceToken });
		try {
			this.#writeChildInput(current.record, pty, request.data, origin, fence);
		} catch {
			// The seam was open when it was last checked and the write was invoked, so
			// whether the child received the bytes is genuinely unknown.
			return { status: "unknown" };
		}
		return { status: "submitted" };
	}

	/**
	 * One read of the row's own current input modes, or undefined when they cannot be
	 * observed (no surface, or a throwing read). A refused modes read is never a
	 * guess: the caller writes nothing rather than send bytes whose meaning it cannot
	 * check.
	 */
	#readViewerInputModes(record: ManagedInstance): TerminalInputModes | undefined {
		const surface = record.surface;
		if (surface === undefined) {
			return undefined;
		}
		try {
			const modes = surface.inputModes();
			return isViewerInputModes(modes) ? modes : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Resolve one viewer's current input scope and mint its scope token from the
	 * exact registration this row holds. Every unresolvable case is a truthful
	 * refusal reason; nothing here mutates a row, a viewer, a surface, or a queue.
	 */
	#viewerInputScope(viewerId: string):
		| { readonly ok: true; readonly viewer: ManagedViewer; readonly record: ManagedInstance; readonly source: NativeViewerAnyInputSource }
		| { readonly ok: false; readonly reason: NativeViewerInputRefusal } {
		if (this.#disposed || this.#stopping) {
			return { ok: false, reason: "disposed" };
		}
		const viewer = this.#viewers.get(viewerId);
		if (viewer === undefined) {
			return { ok: false, reason: "unknown-viewer" };
		}
		// The row is read first only to learn whether this is a hosted provider row:
		// a hosted child has no copy producer, so requiring a copy destination of it
		// would be a rule about a thing that cannot exist. For every Pi row the
		// verifiable-scope requirement below is exactly what it always was.
		const rowId = viewer.sessionId;
		const record = rowId === undefined ? undefined : this.#records.get(rowId);
		const hostedCli = record !== undefined && isNativeCliBackend(record.backend);
		if (viewer.hostRunId === undefined || (!hostedCli && viewer.nativeClipboardSink === undefined)) {
			// Without this host's own run identity (and, for a Pi row, its own copy
			// destination) there is no verifiable scope at all.
			return { ok: false, reason: "no-input-source" };
		}
		if (rowId === undefined) {
			return { ok: false, reason: "row-unavailable" };
		}
		if (record === undefined) {
			return { ok: false, reason: "row-unavailable" };
		}
		if (hostedCli) {
			// A hosted provider child has no Pi registration, no bootstrap, no input
			// framing, and no copy producer, so every registration-based check below is
			// meaningless for it. Its scope is proven against this manager's own
			// ownership of the live PTY and the private key of that process incarnation.
			return this.#nativeCliViewerScope(viewer, record);
		}
		const registration = record.registration;
		if (registration === undefined || record.registrationReleased) {
			return { ok: false, reason: "row-unavailable" };
		}
		if (record.pty === undefined || record.ptyExited || record.lifecycle !== "alive" || record.stopAdmissionClosed) {
			return { ok: false, reason: "row-unavailable" };
		}
		if (!record.inputFramingRequested || !record.inputFramingReady || record.inputEncoder === undefined) {
			return { ok: false, reason: "input-unready" };
		}
		if (record.nativeSession === null) {
			// The ONLY tuple-less source: this exact framed, ready, live registration is
			// still in its sticky startup phase (before its first accepted status) and
			// the manager has never observed a conversation for this row. A missing,
			// cleared, or lost tuple is never reinterpreted as startup.
			if (!record.startupInputOpen
				|| record.knownNativeSessionId !== undefined
				|| record.lastNativeSession !== undefined) {
				return { ok: false, reason: "unknown-native-tuple" };
			}
			const startup = this.#viewerStartupInputSource(viewer, record, registration);
			if (startup === undefined) {
				return { ok: false, reason: "no-input-source" };
			}
			return { ok: true, viewer, record, source: startup };
		}
		const source = this.#viewerInputSource(viewer, record, registration);
		if (source === undefined) {
			// The current facts could not be described at all (for example a viewer
			// identity outside the bounded scope shape): no scope, no input.
			return { ok: false, reason: "no-input-source" };
		}
		return { ok: true, viewer, record, source };
	}

	/**
	 * Resolve one viewer's current input scope on a hosted provider CLI row and mint
	 * its `nvcli1` scope token (issue 277 native remote-input slice).
	 *
	 * A source exists only while every one of these is true of THIS record: the row's
	 * own recorded backend is a native CLI backend (never inferred from output or
	 * from a missing Pi tuple), the manager still holds its live, unexited PTY, the
	 * row has a surface whose modes can be read, the row is running and not inside a
	 * stop, the viewer has this host's run identity, and this incarnation's private
	 * scope key exists. A replacement child, an exit, a stop, a removed row, or a
	 * retired viewer yields no source. Nothing here writes, resizes, queues, spawns,
	 * or changes any state, and the returned token describes these facts instead of
	 * granting anything.
	 */
	#nativeCliViewerScope(
		viewer: ManagedViewer,
		record: ManagedInstance,
	):
		| { readonly ok: true; readonly viewer: ManagedViewer; readonly record: ManagedInstance; readonly source: NativeViewerNativeCliInputSource }
		| { readonly ok: false; readonly reason: NativeViewerInputRefusal } {
		if (this.#disposed || this.#stopping) {
			return { ok: false, reason: "disposed" };
		}
		if (record.pty === undefined || record.ptyExited || record.lifecycle !== "alive"
			|| record.stopAdmissionClosed || record.surface === undefined) {
			return { ok: false, reason: "row-unavailable" };
		}
		const incarnation = record.nativeCliIncarnation;
		if (incarnation === undefined) {
			// No private key for the current process incarnation means no describable
			// scope: this is a refusal, never a source with a placeholder identity.
			return { ok: false, reason: "row-unavailable" };
		}
		const facts = this.#viewerNativeCliScopeFacts(viewer, record);
		if (facts === undefined) {
			return { ok: false, reason: "no-input-source" };
		}
		const sourceToken = mintNativeViewerNativeCliScopeToken(incarnation, facts);
		if (sourceToken === undefined) {
			return { ok: false, reason: "no-input-source" };
		}
		const source: NativeViewerNativeCliInputSource = Object.freeze({
			hostRunId: facts.hostRunId,
			viewerId: facts.viewerId,
			viewerRevision: facts.viewerRevision,
			rowId: facts.rowId,
			phase: NATIVE_CLI_INPUT_PHASE,
			backend: facts.backend,
			geometry: Object.freeze({
				cols: facts.cols,
				rows: facts.rows,
				revision: facts.geometryRevision,
			}),
			sourceToken,
		});
		return { ok: true, viewer, record, source };
	}

	/**
	 * The immutable facts one viewer's native CLI scope commits to, read from the
	 * CURRENT record: run, viewer and revision, row, the row's own recorded backend,
	 * and canonical geometry and revision. Undefined when the row is not positively a
	 * native CLI row or the viewer carries no run identity. There is deliberately no
	 * conversation, registration, or PID field: a hosted provider child has none of
	 * those as public facts, and the process itself is bound only through the
	 * owner-private incarnation key these facts are committed under.
	 */
	#viewerNativeCliScopeFacts(
		viewer: ManagedViewer,
		record: ManagedInstance,
	): NativeViewerNativeCliScopeFacts | undefined {
		const hostRunId = viewer.hostRunId;
		const backend = record.backend;
		if (hostRunId === undefined || !isNativeCliBackend(backend)) {
			return undefined;
		}
		return Object.freeze({
			hostRunId,
			viewerId: viewer.id,
			viewerRevision: viewer.revision,
			rowId: record.id,
			backend,
			cols: record.cols,
			rows: record.rows,
			geometryRevision: record.geometryRevision,
		});
	}

	/**
	 * The one raw handoff of viewer input to a hosted provider child, reached only
	 * after the shared scope, source-equality, and mode fences have passed.
	 *
	 * The token is re-proved under the CURRENT incarnation key immediately before the
	 * write, so a source minted for an earlier child — or carrying a backend the row
	 * never recorded — verifies to false even when every public fact still matches.
	 * Ownership is then re-proved against the live record and this exact handle.
	 * Bytes go to the PTY exactly as the caller's translator produced them: no Pi
	 * framing, no encoder, and no child-side fence exists for this child. A throw
	 * after the write was invoked is `unknown`, never a retry.
	 */
	#writeNativeCliViewerInput(
		viewer: ManagedViewer,
		record: ManagedInstance,
		pty: InstancePty,
		source: NativeViewerNativeCliInputSource,
		data: string | Buffer,
	): NativeViewerInputResult {
		const incarnation = record.nativeCliIncarnation;
		const facts = this.#viewerNativeCliScopeFacts(viewer, record);
		if (incarnation === undefined || facts === undefined
			|| !verifyNativeViewerNativeCliScopeToken(incarnation, source.sourceToken, facts)) {
			return { status: "refused", reason: "stale-source" };
		}
		if (!this.#nativeCliInputAdmissible(record, pty)) {
			return { status: "refused", reason: "row-unavailable" };
		}
		// Every refusal is behind us and this nonempty user input is about to be handed
		// to the child, so the previous controller stops being the copy recipient NOW:
		// a write that partially reaches the child and then throws must not leave a
		// stale surface attributed for whatever the child copies next. A recipient is
		// established again only once a write actually returns.
		record.nativeCliController = undefined;
		try {
			pty.write(data);
		} catch {
			// The seam was open when it was last checked and the write was invoked, so
			// whether the child received the bytes is genuinely unknown, and no surface
			// is attributed until a later input write succeeds.
			return { status: "unknown" };
		}
		// The bytes were handed to THIS child, so this surface is now the recipient of
		// any later copy capture on this incarnation. A refusal above never reaches here.
		this.#noteNativeCliViewerInput(record, viewer.id, source.sourceToken);
		return { status: "submitted" };
	}

	/**
	 * Ownership admission evaluated immediately before one raw native CLI write, and
	 * re-evaluated on every native status submit and invalidation: still the current
	 * record for its id, still holding this exact live PTY, not
	 * exited, not inside a stop, still a positively recorded native CLI row, and with
	 * this incarnation's private key still in hand. `false` means no byte leaves now and
	 * no observation is recorded; nothing is queued, retried, or retargeted.
	 */
	#nativeCliInputAdmissible(record: ManagedInstance, pty: InstancePty): boolean {
		return !this.#disposed && !this.#stopping
			&& this.#records.get(record.id) === record
			&& record.pty === pty && !record.ptyExited
			&& !record.stopAdmissionClosed
			&& record.lifecycle === "alive"
			&& isNativeCliBackend(record.backend)
			&& record.nativeCliIncarnation !== undefined;
	}

	/**
	 * Record that nonempty bytes actually left for one hosted provider child as
	 * owner-local input, making the owner the recipient of any later copy capture on
	 * THIS incarnation. Called only after the write seam was invoked; an empty write,
	 * a refused write, a terminal protocol reply, or a Pi row never reaches it, and a
	 * prior viewer recipient is replaced rather than kept as a fallback.
	 */
	#noteNativeCliLocalInput(record: ManagedInstance, data: string | Buffer): void {
		if (data.length === 0 || !isNativeCliBackend(record.backend)) {
			return;
		}
		const pty = record.pty;
		if (pty === undefined || !this.#nativeCliInputAdmissible(record, pty)) {
			return;
		}
		record.nativeCliInputOrdinal += 1;
		record.nativeCliController = Object.freeze({ kind: "local" as const, ordinal: record.nativeCliInputOrdinal });
	}

	/**
	 * Record that one viewer's verified nonempty input actually left for this hosted
	 * provider child, making that surface the recipient of any later copy capture on
	 * THIS incarnation. The viewer id and the exact scope token its input verified
	 * under are kept so a later copy re-proves the CURRENT facts instead of trusting
	 * this cached destination.
	 */
	#noteNativeCliViewerInput(record: ManagedInstance, viewerId: string, sourceToken: string): void {
		if (!isNativeCliBackend(record.backend)) {
			return;
		}
		const pty = record.pty;
		if (pty === undefined || !this.#nativeCliInputAdmissible(record, pty)) {
			return;
		}
		record.nativeCliInputOrdinal += 1;
		record.nativeCliController = Object.freeze({
			kind: "viewer" as const,
			viewerId,
			sourceToken,
			ordinal: record.nativeCliInputOrdinal,
		});
	}

	/**
	 * This row's own CLOSED OSC 52 TEXT capture sink, attached to a hosted provider
	 * surface only. The incarnation whose private key a captured copy is bound to is
	 * captured here, once, beside the exact PTY handle this surface parses.
	 */
	#nativeCliOsc52Sink(record: ManagedInstance, pty: InstancePty): (encoded: string) => void {
		const incarnation = record.nativeCliIncarnation;
		return (encoded) => {
			try {
				this.#submitNativeCliCopy(record, pty, incarnation, encoded);
			} catch {
				// Containment: a capture or routing failure never escapes into xterm's
				// parser, and nothing here ever becomes a clipboard action by accident.
			}
		};
	}

	/**
	 * Mint the capture/submit seam of ONE live hosted provider run for the host code
	 * that already owns this manager (the dependent provider copy-path adapter).
	 *
	 * The returned object is bound to this exact record, this exact PTY handle, and
	 * this exact process-incarnation key: every submit re-proves all three plus the
	 * row's live ownership, so a replaced child, an exited or stopping row, a removed
	 * row, or a disposed manager submits nothing. It cannot address any other row, it
	 * is never reachable from a peer or a wire frame, and it performs no clipboard
	 * write and no destination choice beyond this row's own last accepted input.
	 * `undefined` means no live run to bind to — never a late-binding handle.
	 */
	nativeCliCopyCapture(instanceId: string): NativeCliCopyCapture | undefined {
		const record = this.#records.get(instanceId);
		if (record === undefined || !isNativeCliBackend(record.backend)) {
			return undefined;
		}
		const pty = record.pty;
		const incarnation = record.nativeCliIncarnation;
		if (pty === undefined || incarnation === undefined) {
			return undefined;
		}
		const backend = record.backend;
		return Object.freeze({
			rowId: record.id,
			backend,
			submit: (encoded: string): boolean => this.#submitNativeCliCopy(record, pty, incarnation, encoded),
		});
	}

	/**
	 * Mint the STATUS capture/submit/invalidate seam of ONE live hosted provider run
	 * for the host code that already owns this manager (the dependent provider status
	 * observer adapter).
	 *
	 * The returned object is bound to this exact record, this exact PTY handle, and
	 * this exact process-incarnation key: every call re-proves all three plus the
	 * row's live ownership through the SAME provider-run ownership fence the row's
	 * input and copy paths use, so a replaced child, an exited or erroring row, a
	 * stop in progress, a removed row, or a disposed manager accepts nothing. It
	 * cannot address another row, it is never reachable from a peer or a wire frame,
	 * and it never becomes a status registration: no Pi bootstrap, token, broker
	 * namespace, native conversation tuple, startup payload, or input framing is
	 * created, consulted, or changed by anything here. `undefined` means there is no
	 * live hosted run to bind to — never a late-binding handle.
	 */
	nativeStatusCapture(instanceId: string): NativeStatusCapture | undefined {
		const record = this.#records.get(instanceId);
		if (record === undefined || !isNativeCliBackend(record.backend)) {
			return undefined;
		}
		const pty = record.pty;
		const incarnation = record.nativeCliIncarnation;
		if (pty === undefined || incarnation === undefined) {
			return undefined;
		}
		const backend = record.backend;
		const observerGeneration = record.nativeStatusObserverGeneration;
		return Object.freeze({
			rowId: record.id,
			backend,
			submit: (observation: NativeStatusObservation): NativeStatusSubmitResult =>
				this.#submitNativeCliStatus(record, pty, incarnation, observerGeneration, observation),
			invalidate: (): NativeStatusSubmitResult =>
				this.#invalidateNativeCliStatus(record, pty, incarnation, observerGeneration),
		});
	}

	/**
	 * Apply one hosted provider observation, or nothing at all.
	 *
	 * Everything is re-proved here, at delivery time: the row is still the current
	 * record holding this exact live, unexited, un-stopping PTY under this exact
	 * incarnation key AND under the observer generation this capture was minted against,
	 * and the observation itself is well-shaped. A malformed
	 * observation (a wrongly typed field, an unknown field such as an ownership count
	 * or a native conversation tuple, or a malformed applicability declaration) is
	 * refused as a whole and leaves the row exactly as it was — it never becomes zero,
	 * idle, or a partial update. A value for a category this row declared
	 * unreportable is not a value: the declaration wins, so that one category stays
	 * unknown (and renders N/A) while the rest of the snapshot still lands.
	 *
	 * An accepted observation replaces the row's observed agent state, pending input,
	 * activity lines, and this provider harness's own task and shell counts, through
	 * the SAME normalization and sanitization the Pi status path uses, so a category
	 * the observer omitted or reported as unknown is unknown rather than stale. The
	 * conservative OWNERSHIP pair is never written from here: a hosted provider child
	 * owns no Pi background work, so it stays unknown and a stop keeps requiring its
	 * explicit confirmation no matter what a provider reports about its own jobs.
	 */
	#submitNativeCliStatus(
		record: ManagedInstance,
		pty: InstancePty,
		incarnation: Buffer,
		observerGeneration: number,
		observation: NativeStatusObservation,
	): NativeStatusSubmitResult {
		if (record.nativeCliIncarnation !== incarnation
			|| !this.#nativeCliInputAdmissible(record, pty)) {
			return nativeStatusRejected("no-live-run");
		}
		// The observer-generation fence is separate from the run fence on purpose: the
		// row can be perfectly live while THIS capture's generation is already retired by
		// an invalidation, which is exactly when a queued pre-failure callback arrives.
		if (record.nativeStatusObserverGeneration !== observerGeneration) {
			return nativeStatusRejected("retired-capture");
		}
		const read = readNativeStatusObservation(observation, record.nativeStatusSupport);
		if (read.status !== "valid") {
			return nativeStatusRejected("malformed-observation");
		}
		const snapshot = read.snapshot;
		record.busy = snapshot.busy;
		record.pendingInput = snapshot.pendingInput;
		record.activeTasks = snapshot.activeTasks;
		record.activeShells = snapshot.activeShells;
		record.activity = boundedActivity(snapshot.activity);
		if (snapshot.support !== undefined) {
			record.nativeStatusSupport = mergeNativeStatusSupport(record.nativeStatusSupport, snapshot.support);
		}
		// The same revision fence the Pi status path uses: an observation this row
		// accepted is never reinterpreted by an older one's later failure.
		record.statusRevision += 1;
		this.#safeChanged(record.id);
		return nativeStatusAccepted();
	}

	/**
	 * One hosted provider observer's honest failure statement about the run it just
	 * lost track of. The row's observed values collapse to unknown — never a kept-over
	 * "Ready", never a zero, never not-applicable — while the row's declared
	 * applicability stays, because a backend's inability to report a category is a
	 * fact about the backend, not about this lost observation. A replaced, exited,
	 * stopping, removed, or disposed run changes nothing at all.
	 */
	#invalidateNativeCliStatus(
		record: ManagedInstance,
		pty: InstancePty,
		incarnation: Buffer,
		observerGeneration: number,
	): NativeStatusSubmitResult {
		if (record.nativeCliIncarnation !== incarnation
			|| !this.#nativeCliInputAdmissible(record, pty)) {
			return nativeStatusRejected("no-live-run");
		}
		if (record.nativeStatusObserverGeneration !== observerGeneration) {
			return nativeStatusRejected("retired-capture");
		}
		record.busy = null;
		record.pendingInput = null;
		record.activeTasks = null;
		record.activeShells = null;
		record.activity = [];
		// This is loss of the live observation generation, not an ordinary unknown
		// status snapshot. Once it can no longer track conversation switches, its
		// last proved identity cannot remain a current restart target. A run that
		// never confirmed its restore keeps the admitted id for retry instead.
		if (record.nativeConversationLive === true) {
			record.nativeConversationLive = false;
			// The proved conversation is no longer something this generation can
			// attribute a title to, so its automatic title goes with it.
			this.#withdrawNativeConversationTitle(record);
			delete record.nativeConversationId;
		}
		// Retiring the generation is part of the accepted invalidation, not a later step:
		// no callback of this generation — submit or invalidate — can land after it.
		record.nativeStatusObserverGeneration += 1;
		// That generation was the MCP lane's only proof source (#682), and the Claude
		// inbox slot's too.
		this.#revokeNativeMcpLane(record.nativeStatusRun?.mcpLane);
		this.#revokeClaudeInbox(record.nativeStatusRun?.claudeInbox);
		record.statusRevision += 1;
		this.#safeChanged(record.id);
		return nativeStatusAccepted();
	}

	/* --------------------------------------------------------------------- *
	 * The OPTIONAL owner-side native status source (issue #277 owner slice)   *
	 *                                                                         *
	 * Everything in this block is inert for a manager built without the       *
	 * optional registrar/observer pair — which is every existing host, every   *
	 * Pi row, and every existing native test. Where it IS active it adds one   *
	 * thing and only one thing: this manager becomes the owner of one broker   *
	 * registration, one host-supplied observer, and one status capture per     *
	 * hosted provider run. It adds no listener, socket, token, registry,       *
	 * retry, resume, or adoption path, and it never touches what the child is  *
	 * actually spawned with.                                                  *
	 * --------------------------------------------------------------------- */

	/**
	 * Arm this row's optional native status source, BEFORE its provider child exists.
	 *
	 * The order is the whole point: the broker registration must be issued before the
	 * spawn so its fresh bootstrap can travel to the launch provider in the launch
	 * request, and so no child can ever exist whose hook source is not already bound
	 * to this exact record. The observer is created in the same stretch, so the
	 * broker's later dispatch reaches `acceptHook`/`acceptFailure` DIRECTLY — no
	 * promise, queue, or microtask stands between an authenticated hook callback and
	 * the observer's own synchronous read barrier.
	 *
	 * Every failure here is contained and leaves the interactive launch untouched: a
	 * registrar that throws, a registration without a usable bootstrap, a bootstrap for
	 * another backend or another row, and a factory that throws all mean "this row is
	 * unobserved", never "this row failed".
	 */
	#armNativeStatusRun(
		record: ManagedInstance,
		backend: NativeCliBackend,
	): OwnedNativeStatusRun | undefined {
		const registrar = this.#nativeHookRegistrar;
		const observerFactory = this.#nativeStatusObserverFactory;
		if (registrar === undefined || observerFactory === undefined) {
			// No optional source was configured: no registration, no launch option, no
			// artifact, and no observation path.
			return undefined;
		}
		const run: OwnedNativeStatusRun = {
			rowId: record.id,
			backend,
			retired: false,
			activated: false,
			supportPublished: false,
			artifactsReleased: false,
			abandoned: false,
		};
		// Published before the source exists so every routing guard below has one
		// authority for "this run is still this row's current one".
		record.nativeStatusRun = run;
		// The OPTIONAL native Claude inbox slot (#682) of this same run: armed only on
		// the trusted host's explicit opt-in and only for Claude, before the
		// registration so the broker's existing owner callback is stored with it.
		const inbox: OwnedNativeClaudeInbox | undefined = this.#nativeClaudeInbox && backend === "claude"
			? { workspace: record.workspace, revoked: false }
			: undefined;
		if (inbox !== undefined) {
			run.claudeInbox = inbox;
		}
		let registration: NativeHookRegistration;
		try {
			registration = registrar.registerNativeHookSource(record.id, backend, {
				onEvent: (event) => this.#routeNativeHookEvent(record, run, event),
				onFailure: (failure) => this.#routeNativeHookFailure(record, run, failure),
				...(inbox === undefined
					? {}
					: {
						onClaudeInboxAnnouncement: (candidate: ClaudeInboxAnnouncementCandidate) =>
							this.#acceptClaudeInboxAnnouncement(record, run, inbox, candidate),
					}),
			});
		} catch {
			this.#retireNativeStatusRun(run);
			return undefined;
		}
		const bootstrap = registration?.bootstrap;
		if (typeof registration?.release !== "function"
			|| bootstrap === undefined
			|| bootstrap.backend !== backend
			|| bootstrap.instanceId !== record.id) {
			// A half-built, foreign, or cross-backend registration can never route here, so
			// it is released rather than trusted, and this provider receives no hook option.
			// The release is direct: this run never adopted that registration.
			try {
				registration?.release();
			} catch {
				// The broker owns its own refusal to release.
			}
			this.#retireNativeStatusRun(run);
			return undefined;
		}
		run.registration = registration;
		run.bootstrap = bootstrap;
		let created: NativeStatusObserver | Promise<NativeStatusObserver>;
		try {
			created = observerFactory({
				rowId: record.id,
				backend,
				emit: (observation) => this.#emitNativeStatus(record, run, observation),
				workspace: record.workspace,
				...(record.nativeResumeConversationId === undefined
					? {}
					: { resumeConversationId: record.nativeResumeConversationId }),
				emitConversationIdentity: (conversationId) =>
					this.#emitNativeConversationIdentity(record, run, conversationId),
				emitConversationTitle: (conversationId, title) =>
					this.#emitNativeConversationTitle(record, run, conversationId, title),
				emitRootToolRequest: (conversationId, toolUseId, toolName) =>
					this.#emitNativeRootToolRequest(record, run, conversationId, toolUseId, toolName),
				emitRootTranscriptRebound: (conversationId) =>
					this.#noteNativeRootTranscriptRebound(record, run, conversationId),
			});
		} catch {
			this.#retireNativeStatusRun(run);
			return undefined;
		}
		if (typeof (created as PromiseLike<NativeStatusObserver> | undefined)?.then === "function") {
			// An asynchronous observer may answer after its row was stopped, removed, or
			// replaced; the binding fence below disposes it rather than adopting it.
			void Promise.resolve(created).then(
				(observer) => {
					this.#bindNativeStatusObserver(record, run, observer);
				},
				() => {
					this.#retireNativeStatusRun(run);
				},
			);
			return run;
		}
		this.#bindNativeStatusObserver(record, run, created as NativeStatusObserver);
		if (run.observer === undefined) {
			// A factory that answered with nothing usable leaves this row unobserved, so
			// the provider is not asked to stage artifacts nobody will read.
			this.#retireNativeStatusRun(run);
			return undefined;
		}
		return run;
	}

	/**
	 * Adopt one factory answer. A malformed observer leaves the row unobserved; an
	 * answer for a run that was retired, replaced, or removed in the meantime is
	 * disposed and never bound, so it can neither receive nor write anything.
	 */
	#bindNativeStatusObserver(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		observer: NativeStatusObserver,
	): void {
		const usable = observer !== null
			&& typeof observer === "object"
			&& typeof observer.acceptHook === "function"
			&& typeof observer.acceptFailure === "function"
			&& typeof observer.dispose === "function";
		if (!usable) {
			return;
		}
		if (run.retired || record.nativeStatusRun !== run || this.#records.get(record.id) !== record) {
			try {
				observer.dispose();
			} catch {
				// A stale observer's own teardown cannot affect anything.
			}
			return;
		}
		run.observer = observer;
		// A run that activated while the factory was still answering publishes its static
		// declaration now; otherwise activation does it.
		this.#publishNativeStatusSupport(run);
		// And it is offered this run's owned-backend facts now, once, only while the run,
		// its backend, and its capture are all still the current ones.
		this.#deliverOwnedCodexBackendObservation(record, run, record.nativeCodexBackend);
	}

	/**
	 * The broker's authenticated event callback for this run: verify the owner
	 * lifecycle token and the run's own backend, then dispatch DIRECTLY into the
	 * observer. Nothing is queued, retried, or replayed for a row that was not
	 * observable at this instant, and a throwing observer cannot disturb the row.
	 */
	#routeNativeHookEvent(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		event: NativeHookEvent,
	): void {
		// Every delivery ends any earlier root-start fact of the Claude inbox slot
		// (#682), whatever path it takes below: it never backs a later announcement.
		const inbox = run.claudeInbox;
		if (inbox !== undefined) {
			inbox.pendingRootStart = undefined;
		}
		if (run.retired || record.nativeStatusRun !== run || this.#records.get(record.id) !== record) {
			return;
		}
		if (event === null || typeof event !== "object" || event.backend !== run.backend) {
			return;
		}
		// Before the initial proof, an authenticated root PreToolUse for this server
		// reserves its key as a veto (#682) — even while an asynchronous observer is
		// still pending. It grants nothing, opens nothing, and holds no event.
		this.#reserveNativeMcpPreProofKey(run.mcpLane, event);
		const observer = run.observer;
		if (observer === undefined) {
			// Before the observer exists: claim nothing, and never hold the event.
			return;
		}
		// An authenticated root Claude SessionEnd for the bound conversation ends the
		// live session even though the observer keeps its id for restart: it ends MCP
		// authority (#682), and changes nothing else about delivery or identity. The
		// one exception is a proved `/clear`: the old conversation scope ends here at
		// once, and only the exact successor start may open a fresh scope on the same
		// transport (see #beforeNativeMcpClaudeHook).
		const lane = run.mcpLane;
		const clearPhase = lane !== undefined && event.backend === "claude"
			? this.#beforeNativeMcpClaudeHook(record, run, lane, event)
			: undefined;
		// A root PreToolUse a successor scope could correlate: the observer's positive
		// per-dispatch verdict is collected here (#682).
		const toolDispatch = lane !== undefined && event.backend === "claude"
			? this.#nativeMcpToolDispatchFor(lane, event)
			: undefined;
		if (lane !== undefined && toolDispatch !== undefined) {
			lane.toolDispatch = toolDispatch;
		}
		// The OPTIONAL Claude inbox slot (#682). A root SessionEnd ends the binding of
		// ITS OWN session only (a late end of an earlier conversation never touches a
		// successor's binding, even while its endpoint capture is pending). A root
		// SessionStart's facts are read HERE, before the observer can touch the event
		// object, and a per-dispatch record collects the observer's verdict.
		let rootStart: PendingClaudeInboxRootStart | undefined;
		let dispatch: ClaudeInboxStartDispatch | undefined;
		if (inbox !== undefined) {
			const root = event.backend === "claude" && event.agent_id === undefined;
			if (root && event.hook_event_name === "SessionEnd"
				&& inbox.binding !== undefined && event.session_id === inbox.binding.sessionId) {
				this.#dropClaudeInboxBinding(inbox);
			}
			if (!inbox.revoked && root && event.hook_event_name === "SessionStart"
				&& typeof event.session_id === "string" && typeof event.cwd === "string") {
				rootStart = Object.freeze({
					sessionId: event.session_id,
					cwd: event.cwd,
					generation: record.nativeStatusObserverGeneration,
				});
				dispatch = {};
				inbox.dispatch = dispatch;
			}
		}
		try {
			observer.acceptHook(event);
		} catch {
			// A status source can never break the row it reports on — but it also cannot
			// leave that row displaying facts it just failed to produce.
			this.#retireNativeStatusObserver(record, run);
			return;
		} finally {
			if (inbox !== undefined && dispatch !== undefined && inbox.dispatch === dispatch) {
				inbox.dispatch = undefined;
			}
			if (lane !== undefined && toolDispatch !== undefined && lane.toolDispatch === toolDispatch) {
				lane.toolDispatch = undefined;
			}
			if (lane !== undefined && clearPhase !== undefined) {
				this.#afterNativeMcpClaudeClearDispatch(lane, clearPhase);
			}
		}
		// A post-clear successor scope's one-use correlations (#682) come only from
		// hooks the observer just accepted without failing, and a PreToolUse only with
		// the observer's positive verdict from that same dispatch.
		if (lane !== undefined && event.backend === "claude") {
			this.#noteNativeMcpClearCorrelationEvent(record, run, lane, event, toolDispatch);
		}
		// Only a root SessionStart whose identity the CURRENT observer positively
		// emitted, and this manager accepted, DURING this exact dispatch may replace
		// the binding and back the announcement the broker hands over next. A silent
		// return (a duplicate the observer deduplicated or refused) changes nothing:
		// an existing binding stays exactly as it was.
		if (rootStart !== undefined && inbox !== undefined && dispatch?.acceptedConversationId === rootStart.sessionId
			&& !inbox.revoked && run.claudeInbox === inbox && run.observer === observer && !run.retired) {
			this.#dropClaudeInboxBinding(inbox);
			inbox.pendingRootStart = rootStart;
		}
	}

	/** The same direct dispatch for the relay's closed failure reports. */
	#routeNativeHookFailure(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		failure: NativeHookFailure,
	): void {
		if (run.claudeInbox !== undefined) {
			// A failure is never a root SessionStart: nothing it carries backs an announcement.
			run.claudeInbox.pendingRootStart = undefined;
		}
		if (run.retired || record.nativeStatusRun !== run || this.#records.get(record.id) !== record) {
			return;
		}
		if (failure === null || typeof failure !== "object" || failure.backend !== run.backend) {
			return;
		}
		if (run.mcpLane?.clear !== undefined) {
			// A lost delivery while a clear is pending leaves its ordering unproved (#682).
			this.#revokeNativeMcpLane(run.mcpLane);
		}
		const observer = run.observer;
		if (observer === undefined) {
			return;
		}
		try {
			observer.acceptFailure(failure);
		} catch {
			this.#retireNativeStatusObserver(record, run);
		}
	}

	/**
	 * Retire a throwing observer's lifetime even before its capture exists.
	 * Callback retirement preserves static support, child ownership, and artifacts.
	 */
	#retireNativeStatusObserver(record: ManagedInstance, run: OwnedNativeStatusRun): void {
		if (run.retired || record.nativeStatusRun !== run) {
			return;
		}
		this.#retireNativeStatusRun(run);
	}

	/**
	 * The ONLY write path this run's observer has: one COMPLETE observation through
	 * this run's own capture. Before the capture exists — and after the run is retired
	 * — it claims nothing and never queues, so a source can neither pre-load a row nor
	 * resurrect one. The capture re-proves the record, the exact live PTY, the process
	 * incarnation, and the observation generation on every call; this adds nothing to
	 * those fences and weakens none of them.
	 */
	#emitNativeStatus(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		observation: NativeStatusObservation,
	): NativeStatusSubmitResult {
		if (run.retired || record.nativeStatusRun !== run || this.#records.get(record.id) !== record) {
			return nativeStatusRejected("no-live-run");
		}
		const capture = run.capture;
		if (capture === undefined) {
			return nativeStatusRejected("no-live-run");
		}
		// A Codex root withdrawal keeps the observer's saved identity (no identity loss
		// is emitted), but its MCP lane ends here (#682) when the observer publishes.
		const lane = run.mcpLane;
		const resource = lane?.ownedBackend;
		if (lane !== undefined && resource !== undefined && record.nativeCodexBackend === resource
			&& nativeMcpCodexRootWithdrawn(resource)) {
			this.#revokeNativeMcpLane(lane);
		}
		return capture.submit(observation);
	}

	/**
	 * The ONLY write path for this run's provider conversation IDENTITY (issue #277
	 * restart restoration). It is fenced exactly like {@linkcode #emitNativeStatus}
	 * and its capture: the current record and run, an activated capture, and that
	 * capture's own live PTY handle, process incarnation, and observer generation, on
	 * an unexited, un-stopping, undisposed row. Anything else claims nothing and is
	 * never queued, retried, or replayed.
	 *
	 * A string must be one exact provider UUID. A restoring row whose expected id is
	 * not yet proved accepts only that id (which confirms it); once confirmed, a
	 * later positively proved id follows the provider's own current conversation. An
	 * explicit `null` clears the remembered identity only while a proved identity is
	 * active in this live run; before any proof it changes nothing, so a restoring
	 * row keeps its admitted id for a durable retry. Normal retirement never clears.
	 */
	#emitNativeConversationIdentity(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		conversationId: string | null,
	): boolean {
		if (run.retired || !run.activated || record.nativeStatusRun !== run
			|| this.#records.get(record.id) !== record) {
			return false;
		}
		const pty = run.capturePty;
		if (run.capture === undefined || pty === undefined
			|| record.nativeCliIncarnation !== run.captureIncarnation
			|| record.nativeStatusObserverGeneration !== run.captureGeneration
			|| !this.#nativeCliInputAdmissible(record, pty)) {
			return false;
		}
		if (conversationId === null) {
			if (record.nativeConversationLive !== true) {
				return false;
			}
			record.nativeConversationLive = false;
			// An observed identity loss ends this run's MCP lane for good (#682), except
			// the observer's own withdrawal inside an accepted `/clear` end dispatch.
			this.#noteNativeMcpConversationLoss(run);
			// And it ends this run's current Claude inbox binding (#682).
			this.#dropClaudeInboxBinding(run.claudeInbox);
			if (record.nativeConversationId === undefined) {
				return true;
			}
			// The conversation this title was proved for is gone, so the title goes
			// with it; the publish below carries the row's new effective text.
			this.#withdrawNativeConversationTitle(record);
			delete record.nativeConversationId;
			this.#safeChanged(record.id);
			return true;
		}
		if (!isNativeConversationId(conversationId)) {
			return false;
		}
		const expected = record.nativeResumeConversationId;
		if (expected !== undefined && record.nativeConversationConfirmed !== true && conversationId !== expected) {
			return false;
		}
		record.nativeConversationConfirmed = true;
		record.nativeConversationLive = true;
		// The MCP lane binds once to this run's first accepted proof and is revoked by
		// any different one (#682); it never follows a conversation change, except the
		// exact successor of a proved Claude `/clear`, which opens a fresh scope.
		this.#noteNativeMcpConversation(record, run, conversationId);
		// A Claude inbox binding belongs to exactly one conversation (#682), and an
		// accepted identity during a root SessionStart dispatch is that event's verdict.
		const inbox = run.claudeInbox;
		if (inbox?.binding !== undefined && inbox.binding.sessionId !== conversationId) {
			this.#dropClaudeInboxBinding(inbox);
		}
		if (inbox?.dispatch !== undefined) {
			inbox.dispatch.acceptedConversationId = conversationId;
		}
		if (record.nativeConversationId === conversationId) {
			return true;
		}
		// A genuine rebind to another conversation: whatever title the previous one
		// carried describes a conversation this row no longer runs, and carrying it
		// over would name this row after a foreign conversation.
		this.#withdrawNativeConversationTitle(record);
		record.nativeConversationId = conversationId;
		this.#safeChanged(record.id);
		return true;
	}

	/**
	 * Drop this row's automatic provider title, if it holds one, and let the row's
	 * effective text fall back to what it was before the provider spoke. An operator
	 * caption owns the label outright, so only the stored title is dropped there.
	 * Returns whether the row's published label changed.
	 */
	#withdrawNativeConversationTitle(record: ManagedInstance): boolean {
		if (record.nativeConversationTitle === undefined) return false;
		delete record.nativeConversationTitle;
		if (record.nativeCaption !== undefined) return false;
		const provider = sessionBackendDisplayLabel(record.backend ?? "pi");
		if (record.label === provider) return false;
		record.label = provider;
		return true;
	}

	/**
	 * The ONLY write path for one row's automatic provider conversation TITLE
	 * (issue #690). It is fenced exactly like
	 * {@linkcode #emitNativeConversationIdentity} — the current record and run, an
	 * activated capture, that capture's own live PTY handle, process incarnation, and
	 * observer generation, on an unexited, un-stopping, undisposed row — and never
	 * queues, retries, or replays.
	 *
	 * On top of those fences a title belongs to ONE conversation: it is accepted only
	 * for the exact id this row currently has proved and holds live, so a late,
	 * stale-generation, cross-row, or foreign-conversation title can never name this
	 * row. Once the operator captioned the row, every automatic title is refused: a
	 * caption outranks the provider, and no provider string moves a captioned row.
	 *
	 * A title must satisfy the host's canonical PUBLISHED-LABEL bound — the one a Pi
	 * row's observed native name and a peer's roster label already satisfy, so an
	 * accepted title always travels out unchanged — and never the narrower manual-caption
	 * input bound, which is an operator-typed limit with no claim on text the host merely
	 * displays. An unusable title is refused whole, never clipped, so nothing silently
	 * rewrites provider text. `null` withdraws a title
	 * that is currently held and changes nothing otherwise. The accepted value is
	 * ephemeral: it lands only in the row's effective label, never in the roster's
	 * remembered display name, and never travels to a provider.
	 */
	#emitNativeConversationTitle(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		conversationId: string,
		title: string | null,
	): boolean {
		if (run.retired || !run.activated || record.nativeStatusRun !== run
			|| this.#records.get(record.id) !== record) {
			return false;
		}
		const pty = run.capturePty;
		if (run.capture === undefined || pty === undefined
			|| record.nativeCliIncarnation !== run.captureIncarnation
			|| record.nativeStatusObserverGeneration !== run.captureGeneration
			|| !this.#nativeCliInputAdmissible(record, pty)) {
			return false;
		}
		// Attribution first: a title is only ever about the conversation this row has
		// positively proved and still holds live.
		if (!isNativeConversationId(conversationId)
			|| record.nativeConversationId !== conversationId
			|| record.nativeConversationLive !== true) {
			return false;
		}
		// The operator's caption outranks any provider title, for as long as it stands.
		if (record.nativeCaption !== undefined) return false;
		if (title === null) {
			if (record.nativeConversationTitle === undefined) return false;
			const changed = this.#withdrawNativeConversationTitle(record);
			if (changed) this.#safeChanged(record.id);
			return true;
		}
		if (!isValidNativeDisplayName(title)) return false;
		if (record.nativeConversationTitle === title) return true;
		record.nativeConversationTitle = title;
		if (record.label !== title) {
			record.label = title;
			this.#safeChanged(record.id);
		}
		return true;
	}

	/**
	 * Owner-only restart identity of one local native CLI row (issue #277): the exact
	 * launch-target id and, when known, the last exact provider conversation UUID this
	 * host may durably remember for it (including a restoring row's admitted id while
	 * its proof is still pending — a retry fact, never a live status claim). Exited
	 * rows still answer; a Pi row or an absent row answers `undefined`. It is for the
	 * owner's own roster projection only and is never part of a public, peer, or
	 * network view.
	 */
	readNativeConversationIdentity(instanceId: string): {
		readonly targetId: string;
		readonly conversationId?: string;
		/** The row's own stored caption (operator caption or Codex startup title), when it has one. */
		readonly caption?: string;
	} | undefined {
		const record = this.#records.get(instanceId);
		if (record === undefined || !isNativeCliBackend(record.backend) || record.nativeCliTarget === undefined) {
			return undefined;
		}
		return Object.freeze({
			targetId: record.nativeCliTarget,
			...(record.nativeConversationId === undefined ? {} : { conversationId: record.nativeConversationId }),
			...(record.nativeCaption === undefined ? {} : { caption: record.nativeCaption }),
		});
	}

	/**
	 * Owner-only proof fact of one local native CLI row (issue #277): `true` once
	 * this row's own live run positively proved a conversation identity (for a
	 * restoring row, its exact admitted id), `false` while that proof is still
	 * pending or never arrived, and `false` for a Pi or absent row. It distinguishes
	 * a restoring row's still-unproved retry intent from a proved identity for the
	 * owner's own presentation only; it is never persisted, never a status value,
	 * and never part of a public, peer, or network view.
	 */
	hasProvedNativeConversation(instanceId: string): boolean {
		const record = this.#records.get(instanceId);
		return record !== undefined && isNativeCliBackend(record.backend) && record.nativeConversationConfirmed === true;
	}

	/**
	 * #682: the trusted owner-only accessor of one local Claude row's bound native
	 * inbox sender, for later wake composition — or `undefined` when there is none
	 * right now. A sender exists only on a manager built with
	 * {@linkcode InstanceManagerOptions.nativeClaudeInbox}, and only while every fence
	 * of its binding holds (see {@linkcode NativeClaudeInboxSender.isCurrent}). It
	 * sends nothing, is never part of a view, status, wire, or log, and a run or
	 * conversation loss ends it for good; a successor run must prove its own.
	 */
	nativeClaudeInboxSender(instanceId: string): NativeClaudeInboxSender | undefined {
		const record = this.#records.get(instanceId);
		const run = record?.nativeStatusRun;
		const inbox = run?.claudeInbox;
		const binding = inbox?.binding;
		const sender = binding?.sender;
		if (record === undefined || run === undefined || inbox === undefined || binding === undefined
			|| sender === undefined || !this.#claudeInboxBindingCurrent(record, run, inbox, binding)) {
			return undefined;
		}
		return sender;
	}

	/**
	 * #682: the session-tool scope for ONE proved native MCP lane call, built from
	 * this manager's own records, or `undefined` when neither SessionHosts nor
	 * SessionSpawn is available for it. It is the host resolver the native
	 * session-tool delegate consumes; it activates nothing by itself.
	 *
	 * Authority. The context must be the exact frozen object THIS manager issued
	 * for a call that is still in flight and whose every lane fence still holds.
	 * Field values are never trusted: a copied, forged, or foreign-manager context,
	 * a settled call's retained context, and a stale or revoked lane all answer
	 * `undefined`. The owner identity is this manager's recorded row, backend,
	 * canonical workspace, bound conversation, and the lane's one exact-run scope.
	 *
	 * Capability. Only the existing ROUTED reporter authority is reused, with the
	 * same callbacks Pi registrations use: `onRoutedSpawnRequest` for SessionSpawn
	 * and `onSessionHostsRequest` for inspection, each with this row's id as the
	 * parent and a per-call `parentStillCurrent` that re-proves this exact lane call
	 * plus the request signal. Without a routed handler there is no scope at all:
	 * the legacy Pi-only `onSpawnRequest` is never a fallback. Inspection exists only
	 * beside routed spawn, exactly as for Pi; `createWorkspace` is declared only from
	 * the host's existing declaration, and the title-space snapshot is the manager's
	 * existing sidebar snapshot (0, which withholds SessionSpawn, when there is none).
	 *
	 * A request naming a paired `host` reaches that route's submission fence with
	 * `parentStillCurrent`. An omitted `host` (this host's ordinary own-host
	 * SessionSpawn: Pi, or a native kind after the host's fresh launch probe) is
	 * dispatched ONLY when the host declared `routedSpawnOwnHostParentProof`, i.e.
	 * that its routed handler re-reads the same proof as the last admission of
	 * its local create (Main passes it into `OwningHostService.spawnRequestedChild`,
	 * after any awaited probe and in the same synchronous stretch as the manager
	 * create that posts the row), so a fallen lane or a cancelled request before
	 * that moment admits no row, workspace, or process. With that declaration,
	 * inspection reports the host's own `ownKinds` unchanged; without it, a
	 * host-omitted request is refused with `failed` before the handler runs and
	 * inspection reports no own-host kind, since nothing proves the handler's
	 * local branch honors this lane's proof.
	 *
	 * Outcomes follow the broker's Pi semantics: a refusal before the handler runs
	 * is a definite `failed`; a handler that throws or answers anything but a closed
	 * outcome is `unknown`. Cancellation is a request to stop, never a rollback.
	 */
	nativeSessionToolScope(context: NativeMcpLaneContext): NativeSessionToolScope | undefined {
		const binding = typeof context === "object" && context !== null
			? this.#nativeMcpLaneCalls.get(context)
			: undefined;
		const routed = this.#onRoutedSpawnRequest;
		if (binding === undefined || routed === undefined) {
			return undefined;
		}
		const callCurrent = (): boolean => {
			try {
				return binding.active && this.#nativeMcpLaneCalls.get(context) === binding
					&& binding.lane.scope === binding.scope
					&& binding.scope.runScope === binding.runScope && binding.isCurrent();
			} catch {
				return false;
			}
		};
		if (!callCurrent()) {
			return undefined;
		}
		const { record, run, lane, conversationId, runScope } = binding;
		const parentId = record.id;
		const proofFor = (signal: AbortSignal | undefined): (() => boolean) =>
			(): boolean => callCurrent() && signal?.aborted !== true;
		const requestSignal = (signal: unknown): AbortSignal | undefined =>
			signal instanceof AbortSignal ? signal : undefined;

		const spawn = async (input: SessionSpawnInput, signal?: AbortSignal): Promise<SessionSpawnOutcome> => {
			const parentStillCurrent = proofFor(requestSignal(signal));
			let request: SessionSpawnInput;
			try {
				// The owner's own exact copy, under the canonical contract.
				request = parseSessionSpawnInput(input);
			} catch {
				return "failed";
			}
			if (request.host === undefined && !this.#routedSpawnOwnHostParentProof) {
				// Without the host's declaration, nothing proves the own-host branch
				// re-reads this lane's proof at its create: refused, never dispatched.
				return "failed";
			}
			if (request.createWorkspace === true && !this.#routedSpawnCreateWorkspace) {
				// Undeclared creation is refused before anything is sent, never dropped.
				return "failed";
			}
			if (!parentStillCurrent()) {
				return "failed";
			}
			let outcome: unknown;
			try {
				outcome = await routed(parentId, request, parentStillCurrent);
			} catch {
				return "unknown";
			}
			return outcome === "started" || outcome === "failed" || outcome === "unknown" ? outcome : "unknown";
		};

		const inspect = this.#onSessionHostsRequest;
		const inspectHosts = inspect === undefined ? undefined : async (signal?: AbortSignal): Promise<SessionHostsInspection> => {
			const unavailable = (reason: "cancelled" | "host-unavailable"): SessionHostsInspection =>
				Object.freeze({ outcome: "unavailable", reason });
			const external = requestSignal(signal);
			// Read live each time: the request or the lane call may end while waiting.
			const cancelled = (): boolean => external?.aborted === true || binding.signal.aborted;
			if (external?.aborted === true) {
				return unavailable("cancelled");
			}
			// Aborted when this inspection stops waiting, the request is cancelled, or
			// the lane call falls — the broker's own "stopped waiting" contract.
			const controller = new AbortController();
			const handlerSignal = AbortSignal.any(external === undefined
				? [controller.signal, binding.signal]
				: [controller.signal, binding.signal, external]);
			const parentStillCurrent = proofFor(handlerSignal);
			if (!parentStillCurrent()) {
				return unavailable("host-unavailable");
			}
			let raw: unknown;
			try {
				raw = await inspect(parentId, { signal: handlerSignal }, parentStillCurrent);
			} catch {
				raw = undefined;
			} finally {
				controller.abort();
			}
			if (cancelled()) {
				return unavailable("cancelled");
			}
			// A missing or malformed snapshot is unavailable, never an empty listing.
			const snapshot = parseSessionHostsSnapshot(raw);
			if (snapshot === undefined) {
				return unavailable("host-unavailable");
			}
			// The host's own kinds are offered only when own-host spawn carries this
			// lane's proof to its create; otherwise they name a capability it lacks.
			return Object.freeze({
				outcome: "complete",
				snapshot: this.#routedSpawnOwnHostParentProof
					? snapshot
					: Object.freeze({ ownKinds: Object.freeze([]), hosts: snapshot.hosts }),
			});
		};

		const capability: SessionHostSpawnCapability = Object.freeze({
			titleColumns: this.#sidebarTitleColumnsSnapshot() ?? 0,
			routing: true,
			...(this.#routedSpawnCreateWorkspace ? { createWorkspace: true } : {}),
			spawn,
			...(inspectHosts === undefined ? {} : { inspectHosts }),
		});
		return Object.freeze({
			owner: Object.freeze({
				rowId: parentId,
				backend: run.backend,
				workspace: lane.workspace,
				conversationId,
				run: runScope,
			}),
			capability,
		});
	}

	/**
	 * Bind this run to the live child, in the same synchronous stretch as the spawn:
	 * mint the ONE status capture of this run from the exact record, the actual raw
	 * PTY handle, and this incarnation, and record this handle's required reader (if
	 * any) for the single artifact-release decision this run may later make. A run
	 * whose child never became live is simply never activated.
	 */
	#activateNativeStatusRun(
		record: ManagedInstance,
		run: OwnedNativeStatusRun | undefined,
		ownedBackend?: OwnedNativeCodexBackendResource,
	): void {
		if (run === undefined || run.retired || record.nativeStatusRun !== run) {
			return;
		}
		if (this.#records.get(record.id) !== record || record.pty === undefined || record.ptyExited) {
			return;
		}
		const capture = this.nativeStatusCapture(record.id);
		if (capture === undefined) {
			return;
		}
		run.capture = capture;
		// Remembered alongside it, so every later use of this capture can re-prove that
		// THIS generation of THIS handle is still what the row is running.
		run.capturePty = record.pty;
		run.captureIncarnation = record.nativeCliIncarnation;
		run.captureGeneration = record.nativeStatusObserverGeneration;
		run.activated = true;
		this.#publishNativeStatusSupport(run);
		// The capture is bound to this exact live handle and incarnation, so this is the
		// first moment an owned backend's facts can be qualified, and it comes before any
		// baseline claim: a source that can state "started idle" must first know whether the
		// backend behind this row is genuinely this host's own.
		this.#deliverOwnedCodexBackendObservation(record, run, ownedBackend ?? record.nativeCodexBackend);
		// The child exists, this run's capture is bound to this exact handle and
		// incarnation, and nothing has been typed into the row: that is the only
		// moment a source may state its launch-time baseline, and the only fact the
		// manager contributes to it — that it owns this spawn. A source without the
		// hook, and a source that refuses because it already observed work, change
		// nothing, and a throw here can never disturb the live run.
		try {
			run.observer?.observeOwnedStartup?.();
		} catch {
			// An observer's own baseline claim is contained: the run stays live.
		}
	}

	/**
	 * Publish THIS actual source's static applicability declaration, once, as the
	 * run's first observation: the declared categories are stated and every observed
	 * value stays unknown. A source that declares nothing publishes nothing, which
	 * keeps the row on exactly the legacy unknown path.
	 */
	#publishNativeStatusSupport(run: OwnedNativeStatusRun): void {
		if (run.retired || !run.activated || run.supportPublished) {
			return;
		}
		const capture = run.capture;
		const observer = run.observer;
		if (capture === undefined || observer === undefined) {
			return;
		}
		const declared = readNativeStatusSupport(observer.support);
		if (declared.status !== "declared" || Object.keys(declared.support).length === 0) {
			return;
		}
		run.supportPublished = true;
		capture.submit({ support: declared.support });
	}

	/**
	 * Account for the private files THIS launch's hook preparation staged, on EVERY
	 * provider fulfillment — including a fulfillment this launch never waited for.
	 *
	 * A provider may stage files long before it answers, and this launch may be
	 * abandoned, or its descriptor refused, in between. Those files are this manager's
	 * ownership from the moment the provider hands them over, so this handler is
	 * attached to the provider promise itself and adopts them exactly once. It releases
	 * them only when this launch is already known to be abandoned (no child of it can
	 * ever exist); otherwise ownership passes to the run, which follows that child's
	 * actual settlement. A run whose OBSERVATION SOURCE was retired still owns them:
	 * the child it is about to spawn may have been told to read them.
	 */
	#adoptNativeHookLease(
		record: ManagedInstance,
		run: OwnedNativeStatusRun | undefined,
		descriptor: unknown,
	): void {
		if (run === undefined || run.artifactsReleased) {
			// No source was armed for this launch, so nothing here was staged by us and
			// nothing here is ours to delete.
			return;
		}
		let adopted = false;
		const outcome = readNativeHookLaunchOutcome(descriptor);
		if (outcome !== undefined && outcome.observation === "prepared" && run.lease === undefined) {
			run.lease = outcome.lease;
			adopted = true;
		}
		// The MCP preparation's staged files (#682) are adopted by the same decision,
		// but only for a run this manager actually armed a lane for: a lease nobody
		// asked for is not ours to delete.
		const mcp = run.mcpLane === undefined ? undefined : readNativeMcpLaunchOutcome(descriptor);
		if (mcp !== undefined && mcp.mcp === "prepared" && run.mcpLease === undefined) {
			run.mcpLease = mcp.lease;
			adopted = true;
		}
		if (adopted && run.abandoned) {
			this.#releaseNativeStatusArtifacts(record, run);
		}
	}

	/**
	 * Record what this launch's provider made of the bootstrap it was handed, for the
	 * OBSERVATION SOURCE only (the staged files are adopted separately, on every
	 * fulfillment).
	 *
	 * `prepared` says the child was given its own instruction to invoke the relay, and
	 * nothing else changes here. An explicit `unavailable` means this launch armed
	 * nothing: the source and observer are released, this row's provider status stays
	 * truthfully unknown, and its interactive launch (argv, environment, cwd) is exactly
	 * what the provider composed without status.
	 *
	 * Saying NOTHING is the legacy descriptor shape rather than a refusal: this run
	 * keeps its source and its observer and stays unknown until and unless actual
	 * observations arrive. Only an explicit refusal retires a run this early.
	 *
	 * That is also the load-bearing rule for an OWNED Codex launch, which composes no
	 * status hook of this host's own at all (the provider declines it, because the
	 * approved relay and its read-only RPC are that row's metadata channel): its
	 * descriptor says NOTHING by design, so the run, its capture, and its one private
	 * backend capability stay live exactly as they would for a hook-bearing run. An
	 * explicit `unavailable` or `failed` outcome keeps its existing fail-closed meaning
	 * even there, and in no case does any of this touch the row's two processes.
	 */
	#applyNativeHookOutcome(run: OwnedNativeStatusRun | undefined, descriptor: unknown): void {
		if (run === undefined || run.retired) {
			return;
		}
		const outcome = readNativeHookLaunchOutcome(descriptor);
		if (outcome === undefined || outcome.observation === "prepared") {
			return;
		}
		this.#retireNativeStatusRun(run);
	}

	/* --------------------------------------------------------------------- *
	 * The OPTIONAL native MCP lane of one observed run (#682)                *
	 *                                                                        *
	 * Inert for a manager built without `nativeMcpLane`. Where it IS active  *
	 * it adds one broker MCP source per observed local native launch, issued *
	 * before the child exists, whose endpoint reaches the injected owner     *
	 * delegate ONLY for the exact current run and the one conversation that  *
	 * run's own observer proved. It adds no listener, socket, token store,   *
	 * tool, authorization rule, persistence, or status/callback change.      *
	 * --------------------------------------------------------------------- */

	/**
	 * Arm this run's MCP lane BEFORE its provider child exists, and answer the launch
	 * option to hand the provider — or `undefined`, which leaves the request exactly
	 * as it would be without a lane. Every failure is contained: a registrar that
	 * throws, or a registration without a usable bootstrap for this exact row and
	 * backend, means "no lane", never "this row failed".
	 */
	#armNativeMcpLane(
		record: ManagedInstance,
		run: OwnedNativeStatusRun | undefined,
		backend: NativeCliBackend,
		workspace: string,
	): NativeCliNativeMcpOption | undefined {
		const owner = this.#nativeMcpLane;
		if (owner === undefined || run === undefined || run.retired || record.nativeStatusRun !== run
			|| run.mcpLane !== undefined) {
			return undefined;
		}
		const lane: OwnedNativeMcpLane = {
			workspace,
			controller: new AbortController(),
			revoked: false,
			everBound: false,
			retiredConversations: new Set(),
			spentToolUseIds: new Set(),
			requiresOwnedBackend: backend === "codex",
		};
		const delegate = owner.delegate;
		const endpoint: NativeMcpToolEndpoint = {
			listTools: (request) => {
				// Pre-proof discovery only (#682): never the delegate, never a call.
				const early = this.#nativeMcpPreProofCatalog(record, run, lane, request?.signal);
				if (early !== undefined) {
					return Promise.resolve(early);
				}
				// Post-clear discovery is metadata-only and never reaches the delegate.
				const successor = this.#nativeMcpSuccessorDiscovery(record, run, lane, request?.signal);
				return successor !== undefined
					? successor
					: this.#dispatchNativeMcpLane(
						record, run, lane, request?.signal,
						(context) => delegate.listTools(context),
					);
			},
			callTool: (request) => this.#dispatchNativeMcpLane(
				record, run, lane, request?.signal,
				(context) => delegate.callTool(context, { name: request.name, arguments: request.arguments }),
				// Only a post-clear successor scope reads these, as a matching key.
				{ name: request?.name, toolUseId: request?.toolUseId },
			),
		};
		let registration: NativeMcpRegistration;
		try {
			registration = owner.registrar.registerNativeMcpSource(record.id, backend, endpoint);
		} catch {
			return undefined;
		}
		// The same strict parser the launch adapter applies: a bootstrap it would refuse
		// (bad version, token, socket path, or extra field) must never reach it, because
		// that refusal would fail the whole interactive launch instead of omitting MCP.
		const bootstrap = parseNativeMcpBootstrap(registration?.bootstrap);
		if (typeof registration?.release !== "function"
			|| bootstrap === undefined
			|| bootstrap.backend !== backend
			|| bootstrap.instanceId !== record.id) {
			// Never adopted, so released directly; the provider receives no MCP option.
			try {
				registration?.release();
			} catch {
				// The broker owns its own refusal to release.
			}
			return undefined;
		}
		lane.registration = registration;
		run.mcpLane = lane;
		return { bootstrap, serverName: owner.serverName };
	}

	/**
	 * Record what this launch's provider made of its MCP option. Only an explicit,
	 * usable `prepared` outcome for this run's backend keeps the lane; `unavailable`,
	 * a malformed outcome, or silence revokes it. The spawn descriptor is unaffected
	 * either way, and staged files were already adopted on fulfillment.
	 */
	#applyNativeMcpOutcome(run: OwnedNativeStatusRun | undefined, descriptor: unknown): void {
		const lane = run?.mcpLane;
		if (run === undefined || lane === undefined || lane.revoked) {
			return;
		}
		const outcome = readNativeMcpLaunchOutcome(descriptor);
		if (outcome === undefined || outcome.mcp !== "prepared" || outcome.backend !== run.backend) {
			this.#revokeNativeMcpLane(lane);
		}
	}

	/**
	 * Bind this run's lane to its first accepted conversation proof, once; any later
	 * accepted proof of a DIFFERENT conversation revokes it. The single exception is
	 * the successor of a proved Claude `/clear` (#682): accepted during its exact root
	 * `SessionStart(source=clear)` dispatch, on the same live launch and the same live
	 * authenticated relay connection, naming a conversation this lane never served, it
	 * opens a fresh scope on the SAME transport. Called only from the fenced identity
	 * channel, after acceptance.
	 */
	#noteNativeMcpConversation(record: ManagedInstance, run: OwnedNativeStatusRun, conversationId: string): void {
		const lane = run.mcpLane;
		if (lane === undefined || lane.revoked) {
			return;
		}
		const clear = lane.clear;
		if (clear !== undefined) {
			if (clear.startSessionId === conversationId && clear.endAccepted
				&& !lane.retiredConversations.has(conversationId)
				&& lane.retiredConversations.size < NATIVE_MCP_CLEAR_MAX_CONVERSATIONS
				&& this.#nativeMcpLaneRunFencesHold(record, run, lane)
				&& this.#nativeMcpLiveConnection(lane) === clear.connection) {
				lane.clear = undefined;
				lane.retiredConversations.add(conversationId);
				lane.scope = {
					conversationId,
					controller: new AbortController(),
					successor: { pending: new Map() },
					connection: clear.connection,
					ended: false,
				};
				return;
			}
			// Any other proof while a clear is pending is an unproved transition.
			this.#revokeNativeMcpLane(lane);
			return;
		}
		const scope = lane.scope;
		if (scope === undefined) {
			if (lane.requiresOwnedBackend) {
				// A Codex conversation is carried by this run's owned backend: bind only
				// while that exact backend is ready and running, and pin it.
				const resource = record.nativeCodexBackend;
				if (resource === undefined || !nativeMcpOwnedBackendLive(resource) || nativeMcpCodexRootWithdrawn(resource)) {
					this.#revokeNativeMcpLane(lane);
					return;
				}
				lane.ownedBackend = resource;
			}
			lane.scope = { conversationId, controller: new AbortController(), ended: false };
			lane.everBound = true;
			lane.retiredConversations.add(conversationId);
			return;
		}
		if (scope.conversationId !== conversationId) {
			this.#revokeNativeMcpLane(lane);
		}
	}

	/**
	 * An observed identity loss (#682). It revokes the lane — unless it is the
	 * observer's own withdrawal inside the very `SessionEnd(reason=clear)` dispatch
	 * this lane already accepted as the first half of a proved clear, which is the
	 * positive evidence that half requires.
	 */
	#noteNativeMcpConversationLoss(run: OwnedNativeStatusRun): void {
		const lane = run.mcpLane;
		const clear = lane?.clear;
		if (clear !== undefined && clear.endDispatch && !clear.endAccepted) {
			clear.endAccepted = true;
			return;
		}
		this.#revokeNativeMcpLane(lane);
	}

	/** The broker's opaque identity of this lane's live authenticated relay connection, if any. */
	#nativeMcpLiveConnection(lane: OwnedNativeMcpLane): object | undefined {
		const read = lane.registration?.liveConnection;
		if (typeof read !== "function") {
			return undefined;
		}
		try {
			const connection = read();
			return typeof connection === "object" && connection !== null ? connection : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Every run fence of one lane, right now, without any conversation: the same
	 * current record, run, and lane; an activated capture whose live PTY handle,
	 * process incarnation, and observer generation are still the row's; an admissible
	 * (alive, unstopped, undisposed) row of the run's backend in the lane's canonical
	 * workspace; and, for Codex, the exact pinned owned backend still live.
	 */
	#nativeMcpLaneRunFencesHold(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		lane: OwnedNativeMcpLane,
	): boolean {
		if (lane.revoked || run.mcpLane !== lane || run.retired || !run.activated
			|| record.nativeStatusRun !== run || this.#records.get(record.id) !== record) {
			return false;
		}
		const pty = run.capturePty;
		if (run.capture === undefined || pty === undefined
			|| record.nativeCliIncarnation !== run.captureIncarnation
			|| record.nativeStatusObserverGeneration !== run.captureGeneration
			|| !this.#nativeCliInputAdmissible(record, pty)) {
			return false;
		}
		if (record.backend !== run.backend || record.workspace !== lane.workspace) {
			return false;
		}
		if (lane.requiresOwnedBackend) {
			const resource = lane.ownedBackend;
			if (resource === undefined || record.nativeCodexBackend !== resource
				|| !nativeMcpOwnedBackendLive(resource) || nativeMcpCodexRootWithdrawn(resource)) {
				return false;
			}
		}
		return true;
	}

	/**
	 * The lane's current conversation scope, when — and only when — every run fence
	 * holds right now, no clear transition is pending, the scope's conversation is
	 * still the row's proved, live one, and (for a post-clear successor) the exact
	 * relay connection that spanned the clear is still the live one.
	 */
	#nativeMcpLaneCurrentScope(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		lane: OwnedNativeMcpLane,
	): OwnedNativeMcpLaneScope | undefined {
		if (!this.#nativeMcpLaneRunFencesHold(record, run, lane)) {
			return undefined;
		}
		const scope = lane.scope;
		if (lane.clear !== undefined || scope === undefined || scope.ended
			|| record.nativeConversationLive !== true || record.nativeConversationId !== scope.conversationId) {
			return undefined;
		}
		if (scope.connection !== undefined && this.#nativeMcpLiveConnection(lane) !== scope.connection) {
			return undefined;
		}
		return scope;
	}

	/**
	 * The owner's fixed discovery catalog, as fresh copies, for a `tools/list` that
	 * arrives while this exact lane is still current but has not bound a conversation;
	 * otherwise `undefined`, which leaves the request on the proved path unchanged (so
	 * a bound lane lists through the delegate, and a revoked, replaced, or retired lane
	 * is refused there). It reads no settings, reaches no delegate or owner code, and
	 * grants nothing: calls never come here.
	 */
	#nativeMcpPreProofCatalog(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		lane: OwnedNativeMcpLane,
		signal: AbortSignal | undefined,
	): NativeMcpToolDescriptor[] | undefined {
		const catalog = this.#nativeMcpPreProofTools;
		if (catalog === undefined || signal?.aborted === true || lane.everBound
			|| lane.revoked || run.mcpLane !== lane || run.retired || record.nativeStatusRun !== run
			|| this.#disposed || this.#stopping || this.#records.get(record.id) !== record
			|| record.stopAdmissionClosed || record.ptyExited
			|| record.backend !== run.backend || record.workspace !== lane.workspace) {
			return undefined;
		}
		return this.#nativeMcpDiscoveryCopy(catalog, run, lane);
	}

	/**
	 * Fresh copies of one metadata-only discovery answer (#682): the fixed baseline
	 * catalog, then — only while {@link #nativeMcpDeliveryReceiptHeld} holds for this
	 * exact run and lane — the fixed delivery catalog. Neither copy grants anything.
	 */
	#nativeMcpDiscoveryCopy(
		catalog: readonly NativeMcpToolDescriptor[],
		run: OwnedNativeStatusRun,
		lane: OwnedNativeMcpLane,
	): NativeMcpToolDescriptor[] {
		const delivery = this.#nativeMcpDeliveryTools;
		const tools = delivery !== undefined && this.#nativeMcpDeliveryReceiptHeld(run, lane)
			? [...catalog, ...delivery]
			: catalog;
		return structuredClone(tools) as NativeMcpToolDescriptor[];
	}

	/**
	 * Whether this exact run still holds the verified delivery receipt its own launch
	 * kept beside this exact kept lane (#682): for Claude, its unrevoked inbox slot's
	 * verified supported version (recorded only after the MCP outcome kept the lane);
	 * for Codex, the owned callback receipt recorded only beside a kept owned lane and
	 * an owned plan. Synchronous, in-memory, and authority-free: it gates discovery
	 * metadata only, never a call or a sender.
	 */
	#nativeMcpDeliveryReceiptHeld(run: OwnedNativeStatusRun, lane: OwnedNativeMcpLane): boolean {
		if (lane.revoked || run.mcpLane !== lane || run.retired) {
			return false;
		}
		if (run.backend === "claude") {
			const inbox = run.claudeInbox;
			return !lane.requiresOwnedBackend && inbox !== undefined && !inbox.revoked && inbox.version !== undefined;
		}
		return run.backend === "codex" && this.#nativeCodexCallback && lane.requiresOwnedBackend
			&& this.#codexCallbackVersions.get(run) !== undefined;
	}

	/**
	 * Discovery in a post-clear successor scope (#682) is METADATA ONLY: an uncorrelated
	 * `tools/list` (which may be a request buffered from before the clear) never reaches
	 * the delegate, so it can never acquire or prepare the successor's owner. It answers
	 * fresh copies of the fixed catalog when the host configured one, and is refused
	 * otherwise. `undefined` means this is not a current successor scope, leaving the
	 * request on the ordinary path.
	 */
	#nativeMcpSuccessorDiscovery(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		lane: OwnedNativeMcpLane,
		signal: AbortSignal | undefined,
	): Promise<NativeMcpToolDescriptor[]> | undefined {
		const scope = this.#nativeMcpLaneCurrentScope(record, run, lane);
		if (scope?.successor === undefined) {
			return undefined;
		}
		const catalog = this.#nativeMcpPreProofTools;
		if (catalog === undefined || signal?.aborted === true) {
			return Promise.reject(new Error("session-host: the native MCP lane serves post-clear discovery as metadata only"));
		}
		return Promise.resolve(this.#nativeMcpDiscoveryCopy(catalog, run, lane));
	}

	/**
	 * One lane call: refused before the delegate is reached unless every fence holds,
	 * handed a frozen host-proved context, and its result discarded (as a rejection,
	 * which the broker answers with a fixed error) if any fence fell while it ran.
	 *
	 * In a post-clear successor scope (#682) a `tools/call` must additionally consume
	 * one exact, unexpired correlation recorded from that conversation's own
	 * authenticated root `PreToolUse` — one the observer positively accepted — for this
	 * server and this tool name. The MCP tool-use id is only the key that selects it; a
	 * missing, unknown, mismatched, stale, superseded, or already used key is refused
	 * before the delegate.
	 */
	async #dispatchNativeMcpLane<T>(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		lane: OwnedNativeMcpLane,
		signal: AbortSignal | undefined,
		invoke: (context: NativeMcpLaneContext) => Promise<T>,
		call?: { readonly name: unknown; readonly toolUseId: unknown },
	): Promise<T> {
		const scope = this.#nativeMcpLaneCurrentScope(record, run, lane);
		// Every tool-use key a Claude call presents before any successor scope (before
		// the first proof, in the first conversation, or in the gap of any pending
		// clear) is reserved as a VETO for
		// the lane's whole lifetime (#682): it never gates an ordinary pre-clear call,
		// never creates a correlation, and can never later admit a successor call.
		// That includes a call refused before the first conversation was even proved.
		const observedKey = call?.toolUseId;
		if (run.backend === "claude" && !lane.revoked && isValidNativeMcpToolUseId(observedKey)
			&& (lane.scope?.successor === undefined || lane.clear !== undefined)) {
			this.#spendNativeMcpClearCorrelation(lane, observedKey, lane.clear !== undefined);
		}
		if (scope === undefined) {
			throw new Error("session-host: the native MCP lane has no current proved conversation");
		}
		if (scope.successor !== undefined
			&& (call === undefined || !this.#consumeNativeMcpClearCorrelation(lane, scope.successor, call))) {
			// A successor never reaches the delegate without its exact correlation; its
			// discovery is served metadata-only before this point.
			throw new Error("session-host: the native MCP lane refused a call without its exact post-clear correlation");
		}
		const conversationId = scope.conversationId;
		// The request, the lane's transport, and this exact conversation scope: any of
		// them ending ends the call.
		const combined = AbortSignal.any(signal instanceof AbortSignal
			? [signal, lane.controller.signal, scope.controller.signal]
			: [lane.controller.signal, scope.controller.signal]);
		const isCurrent = (): boolean =>
			!combined.aborted && this.#nativeMcpLaneCurrentScope(record, run, lane) === scope;
		const runScope = this.#nativeMcpLaneRunScope(record, run, lane, scope);
		const context: NativeMcpLaneContext = Object.freeze({
			rowId: record.id,
			backend: run.backend,
			workspace: lane.workspace,
			conversationId,
			signal: combined,
			isCurrent,
			run: runScope,
		});
		const binding: NativeMcpLaneCallBinding = {
			record, run, lane, scope, conversationId, runScope, signal: combined, isCurrent, active: true,
		};
		this.#nativeMcpLaneCalls.set(context, binding);
		let result: T;
		try {
			result = await invoke(context);
		} finally {
			binding.active = false;
			this.#nativeMcpLaneCalls.delete(context);
		}
		if (!isCurrent()) {
			throw new Error("session-host: the native MCP lane was revoked before its result was returned");
		}
		return result;
	}

	/**
	 * #682: one row's displayed task count — its native harness count combined with
	 * the managed census contribution of exactly the row's CURRENT lane run (the run
	 * object, never the row id or slot string). Only the activity-intent display
	 * value is combined; the conservative ownership pair, shells, and the stop gate
	 * never read this. A row without a lane run, a lane owner without a projection,
	 * and a run contributing `none` stay exactly native. A tasks category the row's
	 * observer declared unsupported keeps its not-applicable reading unchanged. An
	 * unknown on either side is unknown, never zero; a sum outside the count domain
	 * is unknown too.
	 */
	#projectedActiveTasks(record: ManagedInstance): number | null {
		const native = record.activeTasks;
		const activity = this.#nativeMcpLaneActivity;
		const scope = record.nativeStatusRun?.mcpLane?.scope?.runScope;
		if (activity === undefined || scope === undefined || !isNativeCliBackend(record.backend)) return native;
		const contribution = readNativeMcpLaneContribution(activity, scope);
		if (contribution.status === "none") return native;
		if (isNativeCategoryUnsupported(record.nativeStatusSupport, "tasks")) return native;
		if (contribution.status !== "known" || native === null) return null;
		const combined = native + contribution.count;
		return Number.isSafeInteger(combined) ? combined : null;
	}

	/** #682: redraw the one row whose current lane run is `run`; nothing else changes. */
	#nativeMcpLaneActivityChanged(run: NativeMcpLaneRunScope): void {
		if (this.#disposed) return;
		for (const record of this.#records.values()) {
			if (record.nativeStatusRun?.mcpLane?.scope?.runScope === run) {
				this.#safeChanged(record.id);
				return;
			}
		}
	}

	#releaseNativeMcpLaneActivity(): void {
		const unsubscribe = this.#nativeMcpLaneActivityUnsubscribe;
		this.#nativeMcpLaneActivityUnsubscribe = undefined;
		try {
			unsubscribe?.();
		} catch {
			// Contained: the owner's subscription bookkeeping is never load-bearing here.
		}
	}

	/**
	 * The scope's one exact-run object, created once at its first proved call. It
	 * carries only the scope's own controller signal — never a request's — and
	 * re-proves the same fence as each call. A scope never rebinds, so every later
	 * call of the same scope shares this object unchanged; a post-clear successor
	 * scope gets a different one, and the predecessor's is aborted for good.
	 */
	#nativeMcpLaneRunScope(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		lane: OwnedNativeMcpLane,
		scope: OwnedNativeMcpLaneScope,
	): NativeMcpLaneRunScope {
		const existing = scope.runScope;
		if (existing !== undefined) {
			return existing;
		}
		const signal = scope.controller.signal;
		const runScope: NativeMcpLaneRunScope = Object.freeze({
			signal,
			isCurrent: (): boolean =>
				!signal.aborted && this.#nativeMcpLaneCurrentScope(record, run, lane) === scope,
		});
		scope.runScope = runScope;
		return runScope;
	}

	/** End one conversation scope, once: its calls and its run object are aborted for good. */
	#endNativeMcpLaneScope(lane: OwnedNativeMcpLane, scope: OwnedNativeMcpLaneScope | undefined): void {
		if (scope === undefined || scope.ended) {
			return;
		}
		scope.ended = true;
		const successor = scope.successor;
		if (successor !== undefined) {
			const unconsumed = [...successor.pending.keys()];
			successor.pending.clear();
			for (const toolUseId of unconsumed) {
				this.#spendNativeMcpClearCorrelation(lane, toolUseId);
			}
		}
		scope.controller.abort();
	}

	/**
	 * Whether this run may recover its lane across a Claude `/clear` (#682): a Claude
	 * lane (never an owned Codex one) whose run carries this launch's own verified CLI
	 * version receipt for a version the clear sequence was proved on, whose given
	 * scope is still exactly current, whose broker registration has ONE authenticated
	 * relay connection live right now (so the transport demonstrably predates the
	 * clear), and whose bounded conversation history still has room.
	 */
	#nativeMcpClearRecoverable(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		lane: OwnedNativeMcpLane,
		scope: OwnedNativeMcpLaneScope,
	): object | undefined {
		if (lane.requiresOwnedBackend || run.backend !== "claude" || record.backend !== "claude") {
			return undefined;
		}
		const version = run.claudeInbox?.version;
		if (version === undefined || !NATIVE_MCP_CLAUDE_CLEAR_RECOVERY_CLI_VERSIONS.includes(version)) {
			return undefined;
		}
		if (lane.retiredConversations.size >= NATIVE_MCP_CLEAR_MAX_CONVERSATIONS
			|| lane.spentToolUseIds.size >= NATIVE_MCP_CLEAR_MAX_SPENT_CORRELATIONS
			|| this.#nativeMcpLaneCurrentScope(record, run, lane) !== scope) {
			// A full history is never forgotten to make room: recovery is refused.
			return undefined;
		}
		const connection = this.#nativeMcpLiveConnection(lane);
		if (connection === undefined || (scope.connection !== undefined && scope.connection !== connection)) {
			return undefined;
		}
		return connection;
	}

	/**
	 * The lane's view of one authenticated Claude hook BEFORE the observer sees it
	 * (#682). A root `SessionEnd` of the current scope's conversation either begins a
	 * proved clear (reason `clear` on a recoverable run: the old scope ends at once,
	 * the transport stays) or revokes the lane, as before. While a clear is pending,
	 * only the exact root `SessionStart(source=clear)` naming a conversation this lane
	 * never served, in its canonical workspace, over the same live relay connection,
	 * may proceed; a late delivery of the ended conversation changes nothing, and
	 * anything else revokes. A root `SessionStart(source=clear)` WITHOUT an accepted
	 * pending clear — including on a lane that never bound, whose earlier proof was
	 * missed — is terminal, as is a root `SessionEnd(reason=clear)` on such a lane.
	 * Answers which clear dispatch, if any, this event is.
	 */
	#beforeNativeMcpClaudeHook(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		lane: OwnedNativeMcpLane,
		event: NativeHookEvent,
	): "end" | "start" | undefined {
		if (lane.revoked) {
			return undefined;
		}
		const root = event.agent_id === undefined;
		const clear = lane.clear;
		if (clear !== undefined) {
			const sessionId = event.session_id;
			if (root && event.hook_event_name === "SessionStart" && event.source === "clear"
				&& isNativeConversationId(sessionId) && !lane.retiredConversations.has(sessionId)
				&& event.cwd === lane.workspace
				&& this.#nativeMcpLaneRunFencesHold(record, run, lane)
				&& this.#nativeMcpLiveConnection(lane) === clear.connection) {
				clear.startSessionId = sessionId;
				return "start";
			}
			if (sessionId !== undefined && sessionId === clear.endedConversationId
				&& event.hook_event_name !== "SessionStart" && !(root && event.hook_event_name === "SessionEnd")) {
				// A late NON-lifecycle delivery of the conversation that already ended (a
				// delayed tool or turn hook): it authorizes nothing and is not the
				// successor, so the transition just waits. Any intervening root
				// `SessionEnd` — even a logout of that same old id — is terminal below.
				return undefined;
			}
			this.#revokeNativeMcpLane(lane);
			return undefined;
		}
		const scope = lane.scope;
		if (root && ((event.hook_event_name === "SessionStart" && event.source === "clear")
			|| (scope === undefined && event.hook_event_name === "SessionEnd" && event.reason === "clear"))) {
			// A clear this lane did not accept end to end: never a first (ungated) bind.
			this.#revokeNativeMcpLane(lane);
			return undefined;
		}
		if (scope === undefined || scope.ended || !root || event.hook_event_name !== "SessionEnd"
			|| event.session_id !== scope.conversationId) {
			return undefined;
		}
		const connection = event.reason === "clear"
			? this.#nativeMcpClearRecoverable(record, run, lane, scope)
			: undefined;
		if (connection !== undefined) {
			this.#endNativeMcpLaneScope(lane, scope);
			lane.clear = {
				endedConversationId: scope.conversationId,
				connection,
				endDispatch: true,
				endAccepted: false,
			};
			return "end";
		}
		this.#revokeNativeMcpLane(lane);
		return undefined;
	}

	/**
	 * Close one clear dispatch (#682), whatever the observer did. The end half stands
	 * only if the observer positively withdrew the ended identity DURING that dispatch;
	 * after it, that withdrawal is no longer excused. The start half must have opened
	 * the successor during that exact dispatch. Anything else revokes the lane.
	 */
	#afterNativeMcpClaudeClearDispatch(lane: OwnedNativeMcpLane, phase: "end" | "start"): void {
		const clear = lane.clear;
		if (clear === undefined) {
			return;
		}
		if (phase === "end" && clear.endAccepted) {
			clear.endDispatch = false;
			return;
		}
		this.#revokeNativeMcpLane(lane);
	}

	/**
	 * The observer's per-dispatch verdict for one root `PreToolUse` (#682). It counts
	 * only inside the matching dispatch of that exact event, under the run fences; it
	 * records nothing by itself.
	 */
	#emitNativeRootToolRequest(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		conversationId: string,
		toolUseId: string,
		toolName: string,
	): boolean {
		const lane = run.mcpLane;
		const dispatch = lane?.toolDispatch;
		if (lane === undefined || dispatch === undefined || run.retired || record.nativeStatusRun !== run
			|| this.#records.get(record.id) !== record
			|| dispatch.sessionId !== conversationId || dispatch.toolUseId !== toolUseId || dispatch.toolName !== toolName) {
			return false;
		}
		dispatch.accepted = true;
		return true;
	}

	/**
	 * Reserve, as a veto only, the key of one authenticated root Claude `PreToolUse`
	 * for this server that arrives while the lane has no conversation and no pending
	 * clear (#682). It never creates a correlation, opens a scope, queues the hook, or
	 * revokes the lane, and it changes no ordinary pre-clear admission.
	 */
	#reserveNativeMcpPreProofKey(lane: OwnedNativeMcpLane | undefined, event: NativeHookEvent): void {
		if (lane === undefined || lane.revoked || lane.scope !== undefined || lane.clear !== undefined
			|| event.backend !== "claude" || event.agent_id !== undefined || event.hook_event_name !== "PreToolUse"
			|| !isValidNativeMcpToolUseId(event.tool_use_id) || this.#nativeMcpClearToolName(event.tool_name) === undefined) {
			return;
		}
		this.#spendNativeMcpClearCorrelation(lane, event.tool_use_id, false);
	}

	/**
	 * The observer reset this conversation's transcript scope in place (#682): every
	 * unconsumed correlation of the current successor scope for it is spent. It only
	 * removes permission.
	 */
	#noteNativeRootTranscriptRebound(record: ManagedInstance, run: OwnedNativeStatusRun, conversationId: string): void {
		const lane = run.mcpLane;
		if (lane === undefined || run.backend !== "claude") {
			return;
		}
		const scope = this.#nativeMcpLaneCurrentScope(record, run, lane);
		const successor = scope?.successor;
		if (scope === undefined || successor === undefined || scope.conversationId !== conversationId) {
			return;
		}
		const unconsumed = [...successor.pending.keys()];
		successor.pending.clear();
		for (const toolUseId of unconsumed) {
			this.#spendNativeMcpClearCorrelation(lane, toolUseId);
		}
	}

	/**
	 * The root `PreToolUse` about to be dispatched to the observer, when it is one this
	 * lane could correlate after a proved clear (#682); `undefined` otherwise.
	 */
	#nativeMcpToolDispatchFor(lane: OwnedNativeMcpLane, event: NativeHookEvent): NativeMcpToolDispatch | undefined {
		if (lane.revoked || lane.scope?.successor === undefined || event.agent_id !== undefined
			|| event.hook_event_name !== "PreToolUse"
			|| typeof event.session_id !== "string" || typeof event.tool_use_id !== "string" || typeof event.tool_name !== "string") {
			return undefined;
		}
		return { sessionId: event.session_id, toolUseId: event.tool_use_id, toolName: event.tool_name, accepted: false };
	}

	/**
	 * Record or invalidate post-clear correlations from one authenticated Claude hook
	 * (#682). Only a successor scope keeps any, and only root events of its own
	 * conversation count:
	 * - a `PreToolUse` the observer POSITIVELY accepted during this very dispatch,
	 *   naming this server's tool with a well-formed `tool_use_id` never seen on this
	 *   lane, records one one-use correlation (a repeated id invalidates instead);
	 * - that request's own `PostToolUse`/`PostToolUseFailure` invalidates it;
	 * - a root `UserPromptSubmit` supersedes every correlation of another (or no)
	 *   prompt, and a root `Stop`/`StopFailure` ends the turn and every unconsumed
	 *   correlation with it.
	 * Nothing here admits a call.
	 */
	#noteNativeMcpClearCorrelationEvent(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		lane: OwnedNativeMcpLane,
		event: NativeHookEvent,
		dispatch: NativeMcpToolDispatch | undefined,
	): void {
		const scope = this.#nativeMcpLaneCurrentScope(record, run, lane);
		const successor = scope?.successor;
		// A root tool edge for this server in any conversation this lane served OTHER
		// than the current successor — the first conversation included — reserves its
		// key as a veto for the lane's lifetime (#682). It never creates a correlation
		// and never gates an ordinary pre-clear call; a successor can never be reached
		// by that key afterwards, even if the successor reports the same id.
		// Before the initial proof (no scope and no pending clear), an authenticated root
		// PreToolUse for this server reserves its key the same way: a veto only.
		const seenId = event.tool_use_id;
		const unbound = lane.scope === undefined && lane.clear === undefined;
		if (!lane.revoked && event.agent_id === undefined
			&& (event.hook_event_name === "PreToolUse" || event.hook_event_name === "PostToolUse"
				|| event.hook_event_name === "PostToolUseFailure")
			&& typeof event.session_id === "string"
			&& (lane.retiredConversations.has(event.session_id) || (unbound && event.hook_event_name === "PreToolUse"))
			&& (successor === undefined || event.session_id !== scope?.conversationId)
			&& isValidNativeMcpToolUseId(seenId) && this.#nativeMcpClearToolName(event.tool_name) !== undefined) {
			successor?.pending.delete(seenId);
			this.#spendNativeMcpClearCorrelation(lane, seenId, lane.scope?.successor !== undefined || lane.clear !== undefined);
			return;
		}
		if (scope === undefined || successor === undefined
			|| event.agent_id !== undefined || event.session_id !== scope.conversationId) {
			return;
		}
		switch (event.hook_event_name) {
			case "PreToolUse": {
				const toolUseId = event.tool_use_id;
				const toolName = this.#nativeMcpClearToolName(event.tool_name);
				if (toolName === undefined || !isValidNativeMcpToolUseId(toolUseId)) {
					return;
				}
				if (lane.spentToolUseIds.has(toolUseId) || successor.pending.has(toolUseId)) {
					successor.pending.delete(toolUseId);
					this.#spendNativeMcpClearCorrelation(lane, toolUseId);
					return;
				}
				if (dispatch === undefined || !dispatch.accepted || dispatch.toolUseId !== toolUseId
					|| dispatch.sessionId !== scope.conversationId || dispatch.toolName !== event.tool_name) {
					// No positive acceptance (for example a stale-prompt edge): never recorded,
					// and its id is spent, so a later copy of it is a replay, not a request.
					this.#spendNativeMcpClearCorrelation(lane, toolUseId);
					return;
				}
				successor.pending.set(toolUseId, Object.freeze({
					toolName,
					promptId: typeof event.prompt_id === "string" ? event.prompt_id : undefined,
					expiresAt: nativeMcpClearNow() + NATIVE_MCP_CLEAR_CORRELATION_TTL_MS,
				}));
				while (successor.pending.size > NATIVE_MCP_CLEAR_MAX_PENDING_CORRELATIONS) {
					const oldest = successor.pending.keys().next().value as string;
					successor.pending.delete(oldest);
					this.#spendNativeMcpClearCorrelation(lane, oldest);
				}
				return;
			}
			case "PostToolUse":
			case "PostToolUseFailure": {
				// The request's own closure retires its key — and tombstones it for this
				// server even when no opening edge was recorded, so a late opening edge
				// can never arm a request that already completed.
				const toolUseId = event.tool_use_id;
				if (isValidNativeMcpToolUseId(toolUseId)
					&& (successor.pending.delete(toolUseId) || this.#nativeMcpClearToolName(event.tool_name) !== undefined)) {
					this.#spendNativeMcpClearCorrelation(lane, toolUseId);
				}
				return;
			}
			case "UserPromptSubmit": {
				const promptId = typeof event.prompt_id === "string" ? event.prompt_id : undefined;
				for (const [toolUseId, entry] of [...successor.pending]) {
					if (promptId === undefined || entry.promptId !== promptId) {
						successor.pending.delete(toolUseId);
						this.#spendNativeMcpClearCorrelation(lane, toolUseId);
					}
				}
				return;
			}
			case "SessionStart":
			case "Stop":
			case "StopFailure": {
				// A same-conversation root start (for example a resume of this id) resets
				// the observer's scope without an identity change; like the end of a turn,
				// it retires every unconsumed correlation.
				const unconsumed = [...successor.pending.keys()];
				successor.pending.clear();
				for (const toolUseId of unconsumed) {
					this.#spendNativeMcpClearCorrelation(lane, toolUseId);
				}
				return;
			}
			default:
				return;
		}
	}

	/**
	 * The bare MCP tool name a Claude `PreToolUse` `tool_name` names for THIS host's
	 * server (`mcp__<serverName>__<tool>`), or `undefined` for any other tool.
	 */
	#nativeMcpClearToolName(toolName: unknown): string | undefined {
		const serverName = this.#nativeMcpLane?.serverName;
		if (serverName === undefined || typeof toolName !== "string") {
			return undefined;
		}
		const prefix = `mcp__${serverName}__`;
		if (!toolName.startsWith(prefix)) {
			return undefined;
		}
		const bare = toolName.slice(prefix.length);
		return bare.length > 0 && bare.length <= NATIVE_MCP_MAX_TOOL_NAME_LENGTH ? bare : undefined;
	}

	/**
	 * Take one post-clear correlation for a `tools/call`: the key must select an
	 * unconsumed correlation, which is spent at once whatever follows; it admits the
	 * call only for the exact same tool name before its deadline.
	 */
	#consumeNativeMcpClearCorrelation(
		lane: OwnedNativeMcpLane,
		successor: NativeMcpClearSuccessor,
		call: { readonly name: unknown; readonly toolUseId: unknown },
	): boolean {
		const { name, toolUseId } = call;
		if (!isValidNativeMcpToolUseId(toolUseId)) {
			return false;
		}
		const entry = successor.pending.get(toolUseId);
		if (entry === undefined) {
			// A refused key is spent, so the same request can never become admissible
			// on replay once a matching hook arrives.
			this.#spendNativeMcpClearCorrelation(lane, toolUseId);
			return false;
		}
		successor.pending.delete(toolUseId);
		this.#spendNativeMcpClearCorrelation(lane, toolUseId);
		return !lane.revoked && typeof name === "string" && entry.toolName === name && nativeMcpClearNow() < entry.expiresAt;
	}

	/**
	 * Remember one tool-use id as spent for the lane's whole transport lifetime. The
	 * ledger never forgets or evicts. At its bound, a lane that already relies on it
	 * (a successor scope or a pending clear) is revoked; before the first clear
	 * (`revokeOnFull` false) ordinary calls keep working, and recovery is refused.
	 */
	#spendNativeMcpClearCorrelation(lane: OwnedNativeMcpLane, toolUseId: string, revokeOnFull = true): void {
		if (lane.spentToolUseIds.size < NATIVE_MCP_CLEAR_MAX_SPENT_CORRELATIONS) {
			lane.spentToolUseIds.add(toolUseId);
		}
		if (revokeOnFull && lane.spentToolUseIds.size >= NATIVE_MCP_CLEAR_MAX_SPENT_CORRELATIONS) {
			this.#revokeNativeMcpLane(lane);
		}
	}

	/* --------------------------------------------------------------------- *
	 * The OPTIONAL native Claude inbox binding of one observed run (#682)    *
	 *                                                                        *
	 * Inert for a manager built without `nativeClaudeInbox`. Where it IS     *
	 * active it consumes only the broker's existing authenticated owner      *
	 * callback and the provider's compatibility receipt, and mints at most   *
	 * one opaque send capability per proved root session. It adds no         *
	 * listener, socket, hook, send, routing, persistence, or status change.  *
	 * --------------------------------------------------------------------- */

	/**
	 * Record what this launch's provider answered for the Claude inbox compatibility
	 * request. Only a `verified` receipt with a supported version keeps the slot;
	 * anything else — declined, malformed, or silent — revokes it before any child
	 * exists. The spawn descriptor is unaffected either way.
	 */
	#applyClaudeInboxOutcome(run: OwnedNativeStatusRun | undefined, descriptor: unknown): void {
		const inbox = run?.claudeInbox;
		if (run === undefined || inbox === undefined || inbox.revoked) {
			return;
		}
		const version = run.retired ? undefined : readClaudeInboxCompatibilityVersion(descriptor);
		// A lane-scoped opt-in keeps the slot only beside the lane this same outcome
		// kept (the MCP outcome is applied first): no prepared lane, no inbox.
		const laneKept = !this.#nativeClaudeInboxRequiresMcpLane
			|| (run.mcpLane !== undefined && !run.mcpLane.revoked);
		if (version === undefined || !laneKept) {
			this.#revokeClaudeInbox(inbox);
			return;
		}
		inbox.version = version;
	}

	/**
	 * Every run fence of one Claude inbox slot, right now: the same current record,
	 * run, and slot; an activated capture whose live PTY handle, process incarnation,
	 * and observer generation are still the row's; an admissible (alive, unstopped,
	 * undisposed) Claude row in the slot's canonical workspace; and a verified version.
	 * Synchronous and in-memory only.
	 */
	#claudeInboxRunCurrent(record: ManagedInstance, run: OwnedNativeStatusRun, inbox: OwnedNativeClaudeInbox): boolean {
		if (inbox.revoked || inbox.version === undefined || run.claudeInbox !== inbox || run.retired || !run.activated
			|| record.nativeStatusRun !== run || this.#records.get(record.id) !== record) {
			return false;
		}
		const pty = run.capturePty;
		if (run.capture === undefined || pty === undefined
			|| record.nativeCliIncarnation !== run.captureIncarnation
			|| record.nativeStatusObserverGeneration !== run.captureGeneration
			|| !this.#nativeCliInputAdmissible(record, pty)) {
			return false;
		}
		return record.backend === "claude" && run.backend === "claude" && record.workspace === inbox.workspace;
	}

	/** The run fences plus this exact binding and its live accepted conversation. */
	#claudeInboxBindingCurrent(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		inbox: OwnedNativeClaudeInbox,
		binding: OwnedNativeClaudeInboxBinding,
	): boolean {
		return !binding.dropped && inbox.binding === binding
			&& this.#claudeInboxRunCurrent(record, run, inbox)
			&& record.nativeConversationLive === true
			&& record.nativeConversationId === binding.sessionId;
	}

	/**
	 * The broker's authenticated announcement callback for this run. It is invoked
	 * synchronously right after `onEvent` delivered the same authenticated root
	 * `SessionStart`, so the slot's pending root start is exactly that event's — read
	 * before the observer saw it, and recorded only because the current observer
	 * positively emitted, and this manager accepted, that session's identity during
	 * that dispatch. The announcement must name that session, the event's `cwd` must be
	 * the row's canonical workspace, and this manager must already hold that session
	 * as the run's live accepted conversation. Anything else is ignored silently.
	 */
	#acceptClaudeInboxAnnouncement(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		inbox: OwnedNativeClaudeInbox,
		candidate: ClaudeInboxAnnouncementCandidate,
	): void {
		const pending = inbox.pendingRootStart;
		inbox.pendingRootStart = undefined;
		if (pending === undefined || !this.#claudeInboxRunCurrent(record, run, inbox)
			|| pending.generation !== record.nativeStatusObserverGeneration) {
			return;
		}
		const announced = readClaudeInboxAnnouncement(candidate);
		if (announced === undefined || announced.sessionId !== pending.sessionId || pending.cwd !== inbox.workspace) {
			return;
		}
		if (record.nativeConversationLive !== true || record.nativeConversationId !== announced.sessionId) {
			return;
		}
		this.#dropClaudeInboxBinding(inbox);
		const binding: OwnedNativeClaudeInboxBinding = {
			sessionId: announced.sessionId,
			launchId: `claude-inbox-${randomBytes(12).toString("hex")}`,
			dropped: false,
		};
		inbox.binding = binding;
		noteClaudeInboxBindForTests("started");
		void this.#bindClaudeInbox(record, run, inbox, binding, candidate);
	}

	/**
	 * Capture the announced endpoint's identity and mint the capability, or drop the
	 * attempt. Every fence is re-proved after the asynchronous capture, so a binding
	 * whose run, conversation, or slot changed meanwhile never becomes a sender — and
	 * can never affect a successor run. The hook token is read from the opaque
	 * candidate only at minting and passes straight into the opaque capability.
	 */
	async #bindClaudeInbox(
		record: ManagedInstance,
		run: OwnedNativeStatusRun,
		inbox: OwnedNativeClaudeInbox,
		binding: OwnedNativeClaudeInboxBinding,
		candidate: ClaudeInboxAnnouncementCandidate,
	): Promise<void> {
		const socketPath = readClaudeInboxAnnouncement(candidate)?.socketPath;
		const endpoint = socketPath === undefined ? undefined : await captureClaudeInboxEndpoint(socketPath);
		const version = inbox.version;
		if (endpoint === undefined || version === undefined || !this.#claudeInboxBindingCurrent(record, run, inbox, binding)) {
			if (inbox.binding === binding) {
				this.#dropClaudeInboxBinding(inbox);
			}
			noteClaudeInboxBindForTests("dropped");
			return;
		}
		const announced = readClaudeInboxAnnouncement(candidate);
		const isCurrent = (): boolean => this.#claudeInboxBindingCurrent(record, run, inbox, binding);
		const created = announced === undefined || announced.socketPath !== socketPath
			? undefined
			: createClaudeInboxSendCapability({
				launchId: binding.launchId,
				sessionId: binding.sessionId,
				socketPath: announced.socketPath,
				endpoint,
				hookToken: announced.hookToken,
				claudeVersion: version,
				isCurrent,
			});
		if (created === undefined || !created.ok) {
			this.#dropClaudeInboxBinding(inbox);
			noteClaudeInboxBindForTests("dropped");
			return;
		}
		binding.sender = Object.freeze({
			conversationId: binding.sessionId,
			capability: created.capability,
			isCurrent,
		});
		noteClaudeInboxBindForTests("bound");
	}

	/** End the slot's current binding (if any); its sender's `isCurrent` turns false for good. */
	#dropClaudeInboxBinding(inbox: OwnedNativeClaudeInbox | undefined): void {
		const binding = inbox?.binding;
		if (inbox === undefined || binding === undefined) {
			return;
		}
		binding.dropped = true;
		inbox.binding = undefined;
	}

	/** Revoke one slot, once and terminally: no pending proof, no binding, no rebinding. */
	#revokeClaudeInbox(inbox: OwnedNativeClaudeInbox | undefined): void {
		if (inbox === undefined || inbox.revoked) {
			return;
		}
		inbox.revoked = true;
		inbox.pendingRootStart = undefined;
		inbox.dispatch = undefined;
		this.#dropClaudeInboxBinding(inbox);
	}

	/**
	 * Revoke one lane, once and terminally: release its broker registration (which
	 * invalidates the bootstrap and aborts the broker's in-flight calls) and abort
	 * every delegate signal. Staged files are NOT touched here; they follow the run's
	 * own settlement.
	 */
	#revokeNativeMcpLane(lane: OwnedNativeMcpLane | undefined): void {
		if (lane === undefined || lane.revoked) {
			return;
		}
		lane.revoked = true;
		lane.clear = undefined;
		// The current conversation scope ends with its transport: its calls and its
		// exact-run object are aborted for good.
		this.#endNativeMcpLaneScope(lane, lane.scope);
		const registration = lane.registration;
		lane.registration = undefined;
		if (registration !== undefined) {
			try {
				registration.release();
			} catch {
				// The broker owns its own refusal to release; the lane is revoked either way.
			}
		}
		lane.controller.abort();
	}

	/**
	 * Retire this run's CALLBACKS, once and immediately: the broker registration is
	 * released so no further delivery can arrive, the run's capture is invalidated so
	 * its observation generation is retired for good, and the observer is disposed so
	 * it stops its own internal work.
	 *
	 * It deliberately does NOT touch the child, its shutdown ladder, its reader, this
	 * run's staged files, or the row's reference to this run. Those are RESOURCE
	 * ownership, and they outlive the callbacks: a row stopped, disposed, or wired
	 * incorrectly still has a child that may be reading the files this launch staged,
	 * and only that child's actual settlement (below) may release them. Every callback
	 * path is fenced by `retired`, so keeping the reference open cannot resurrect the
	 * observation path.
	 */
	#retireNativeStatusRun(run: OwnedNativeStatusRun | undefined): void {
		if (run === undefined || run.retired) {
			return;
		}
		run.retired = true;
		// The MCP lane's proof source is this run's observer, so its callbacks retire
		// with the run's (#682); its staged files stay with the run's settlement.
		this.#revokeNativeMcpLane(run.mcpLane);
		// So does the Claude inbox slot's (#682): no binding outlives the run.
		this.#revokeClaudeInbox(run.claudeInbox);
		const registration = run.registration;
		run.registration = undefined;
		run.bootstrap = undefined;
		if (registration !== undefined) {
			try {
				registration.release();
			} catch {
				// The broker owns its own refusal to release; the token is gone either way.
			}
		}
		const capture = run.capture;
		run.capture = undefined;
		if (capture !== undefined) {
			try {
				capture.invalidate();
			} catch {
				// Contained: the run fence and the incarnation fence already refuse it.
			}
		}
		const observer = run.observer;
		run.observer = undefined;
		if (observer !== undefined) {
			try {
				observer.invalidate?.();
			} catch {
				// The observer's own fence is best-effort; the capture is already retired.
			}
			try {
				observer.dispose();
			} catch {
				// Contained.
			}
		}
	}

	/**
	 * Release this run's staged private artifacts — at most once, and only when this
	 * run's own settlement makes the cleanup safe.
	 *
	 * A run whose child never existed, or whose child has genuinely exited, may clean
	 * them. A run whose child is still live, or whose required owned reader has not
	 * positively settled, preserves them: an uncertain ownership chain is never treated
	 * as if it had finished, and the existing shortening-only confirmation deadline is
	 * awaited rather than replaced with a fresher window. The lease itself refuses to
	 * remove anything it did not stage; this manager never guesses at a path.
	 */
	#releaseNativeStatusArtifacts(
		record: ManagedInstance,
		run: OwnedNativeStatusRun | undefined,
	): void {
		if (run === undefined || run.artifactsReleased) {
			return;
		}
		const lease = run.lease;
		const mcpLease = run.mcpLease;
		if (lease === undefined && mcpLease === undefined) {
			return;
		}
		if (!run.retired) {
			// The source is still armed and its child may still be reading.
			return;
		}
		if (record.pty !== undefined && !record.ptyExited) {
			// A live or unsettled child may still need the files it was told to read.
			return;
		}
		if (ownsUnsettledCodexBackend(record)) {
			// The owned backend is a SECOND child of this same launch, and it was given the
			// same hook channel: the TUI's exit never says that child stopped reading, so an
			// unsettled record preserves the files until that backend's own settlement.
			return;
		}
		run.artifactsReleased = true;
		run.lease = undefined;
		run.mcpLease = undefined;
		const cleanup = (): void => {
			if (lease !== undefined) this.#cleanupNativeStatusLease(lease);
			if (mcpLease !== undefined) this.#cleanupNativeStatusLease(mcpLease);
		};
		const settlement = run.readerSettlement;
		if (settlement !== undefined && !settlement.settled) {
			void settlement.confirmSettlement().then(
				(confirmed) => {
					if (confirmed) {
						cleanup();
					}
					// An unconfirmed settlement preserves the artifacts instead of pretending.
				},
				() => undefined,
			);
			return;
		}
		cleanup();
	}

	/**
	 * Declare that NO child of this launch can ever exist, and release what its hook
	 * preparation staged. This is the only place that decision is made, and it is made
	 * exactly twice in this module: a spawn that failed before any child, and a
	 * pre-spawn or stop-aborted launch.
	 *
	 * Marking the run abandoned is what makes the accounting complete for a provider
	 * that answers after the launch was given up on: its late fulfillment adopts its
	 * own staged files and releases them on the spot, while shutdown never waits for
	 * it. Retirement of an OBSERVATION SOURCE never implies abandonment — a retired
	 * run can still own a live child that is reading those files.
	 */
	#abandonNativeStatusLaunch(
		record: ManagedInstance,
		run: OwnedNativeStatusRun | undefined,
	): void {
		if (run === undefined) {
			return;
		}
		run.abandoned = true;
		this.#retireNativeStatusRun(run);
		this.#releaseNativeStatusArtifacts(record, run);
	}

	/**
	 * Declare that no child of this launch can ever exist, and release its owned
	 * startup prompt file under the same settlement rule as every other release.
	 */
	#abandonNativeInitialPrompt(record: ManagedInstance): void {
		const owned = record.nativeInitialPrompt;
		if (owned === undefined) return;
		owned.abandoned = true;
		this.#releaseNativeInitialPrompt(record);
	}

	/**
	 * Release this row's owned startup prompt file — at most once, and only when no
	 * child of its launch can still read it. It follows the same settlement facts as
	 * the hook artifacts: an abandoned launch (no child ever existed) or an actually
	 * exited child, never an unsettled owned Codex backend (the TUI's exit says
	 * nothing about the backend that carries the conversation), and never before a
	 * required owned reader positively settled. A child still starting or waiting on
	 * its provider's own trust prompt keeps the file. The lease itself removes only
	 * the exact file and root it staged, so nothing foreign is ever deleted.
	 */
	#releaseNativeInitialPrompt(record: ManagedInstance): void {
		const owned = record.nativeInitialPrompt;
		if (owned === undefined || owned.released) return;
		if (!owned.abandoned && (record.pty === undefined || !record.ptyExited)) return;
		if (ownsUnsettledCodexBackend(record)) return;
		owned.released = true;
		const settlement = owned.readerSettlement;
		const cleanup = (): void => {
			try {
				void Promise.resolve(owned.lease.cleanup()).catch(() => undefined);
			} catch {
				// The lease reports its own refusals; a cleanup failure is never a row failure.
			}
		};
		if (settlement !== undefined && !settlement.settled) {
			void settlement.confirmSettlement().then(
				(confirmed) => {
					if (confirmed) cleanup();
					// An unconfirmed settlement preserves the file instead of pretending.
				},
				() => undefined,
			);
			return;
		}
		cleanup();
	}

	/** The one call that actually removes this run's own staged files. */
	#cleanupNativeStatusLease(lease: NativeHookArtifactLease | NativeMcpArtifactLease): void {
		try {
			void Promise.resolve(lease.cleanup()).catch(() => undefined);
		} catch {
			// The lease reports its own refusals; a cleanup failure is never a row failure.
		}
	}

	/* --------------------------------------------------------------------- *
	 * The OWNED Codex backend of one hosted run (issue #277 owning-manager)  *
	 *                                                                        *
	 * Everything in this block is inert for a launch whose provider attached  *
	 * no owned plan — which is every Pi row, every Claude row, and every     *
	 * ordinary Codex row. Where it IS active it adds exactly one thing: this *
	 * manager becomes the owner of one backend process beside the row's TUI, *
	 * and it adds no provider patching, no replacement UI, no headless      *
	 * conversation, no shared-server adoption, no port scan, and no status   *
	 * claim of its own.                                                      *
	 * --------------------------------------------------------------------- */

	/**
	 * Create this row's owned Codex backend and RETAIN its lease on the record
	 * SYNCHRONOUSLY, before anything is awaited.
	 *
	 * That ordering is the contract: the backend child exists the moment the factory
	 * returns, so a lease kept only inside a pending promise would be a process this
	 * manager cannot stop. The factory's answer is validated against the identity this
	 * manager minted — same lease id, same generation, and the four lease members this
	 * module actually depends on — before any continuation is attached.
	 *
	 * A throw here happens before any backend of this run exists, so it is an ordinary
	 * preparation failure. It never falls back to the standalone descriptor: a TUI
	 * attached to nothing owned is the substitution this path refuses.
	 */
	#createOwnedCodexBackend(
		record: ManagedInstance,
		plan: NativeCodexOwnedLaunchPlan,
	): OwnedNativeCodexBackendResource {
		const factory = this.#ownedCodexBackendFactory;
		if (factory === undefined) {
			// The provider prepared an owned launch this host cannot honor. Refusing is
			// the only honest answer: no backend, no TUI, and no Pi or standalone fallback.
			throw new Error("session-host: this host has no owned Codex backend factory");
		}
		if (record.nativeCodexBackend !== undefined) {
			// One backend per row incarnation, always. A second one would be a process whose
			// endpoint this row's TUI is not attached to.
			throw new Error("session-host: this row already owns a Codex backend");
		}
		const generation = record.nativeCodexBackendGeneration ?? 0;
		record.nativeCodexBackendGeneration = generation + 1;
		const identity: OwnedCodexBackendLaunchIdentity = Object.freeze({ leaseId: randomUUID(), generation });
		const controller = new AbortController();
		let resolveCancel: () => void = () => undefined;
		const cancel = new Promise<void>((fulfill) => {
			resolveCancel = fulfill;
		});
		let created: unknown;
		try {
			created = factory({
				identity,
				plan,
				signal: controller.signal,
				workspace: record.workspace,
				...(record.nativeResumeConversationId === undefined
					? {}
					: { resumeConversationId: record.nativeResumeConversationId }),
			});
		} catch {
			// The factory reports its own failure; no message, argument, or path of theirs
			// is ever carried into this row's state.
			throw new Error("session-host: the owned Codex backend factory produced no lease");
		}
		if (!isUsableOwnedCodexBackendLease(created, identity)) {
			throw new Error("session-host: the owned Codex backend factory produced an unusable lease");
		}
		const lease = created;
		const resource: OwnedNativeCodexBackendResource = {
			rowId: record.id,
			identity,
			lease,
			controller,
			cancel,
			resolveCancel,
			ready: false,
			settled: false,
			observationDelivered: false,
			retired: false,
		};
		// THE synchronous retention. From this statement until its settlement, this
		// backend is this row's resource, and every stop, removal, disposal, and failure
		// path below reaches it — including one whose readiness never arrives.
		record.nativeCodexBackend = resource;
		// Settlement is observed, never awaited: it is the only thing that may retire the
		// row's ownership claim, release this run's staged private files, and let the row
		// stop reporting a live process. A stop acknowledgement, a stream destroy, a
		// close, or a timeout can never take its place.
		void Promise.resolve(lease.settlement).then(
			() => this.#onOwnedCodexBackendSettled(record, resource),
			() => undefined,
		);
		return resource;
	}

	/**
	 * Await this row's owned backend's readiness, bounded by this manager's own
	 * shutdown notification exactly the way the launch provider is, and by this
	 * resource's own retirement.
	 *
	 * A backend that never prints its banner can therefore never hold the host away
	 * from stopping its existing children, and a row whose operator stopped it is answered
	 * now rather than whenever its backend happens to speak. When either wins, this
	 * resource is retired (which requests its exact owned termination) and the launch
	 * aborts; the readiness answer, whenever it comes, can then spawn nothing.
	 *
	 * A rejected readiness value is NOT settlement and never treated as abandonment: the
	 * backend child may outlive it, and the retained resource keeps the row's resources
	 * and liveness until the lease itself settles.
	 */
	async #awaitOwnedCodexBackendReady(
		record: ManagedInstance,
		resource: OwnedNativeCodexBackendResource,
	): Promise<OwnedCodexBackendReady> {
		const outcome = await Promise.race([
			Promise.resolve(resource.lease.readiness).then(
				(ready) => ({ kind: "ready" as const, ready }),
				() => ({ kind: "failed" as const }),
			),
			this.#awaitShutdownNotice().then(() => ({ kind: "aborted" as const })),
			resource.cancel.then(() => ({ kind: "stopped" as const })),
		]);
		if (outcome.kind === "aborted" || this.#stopping || this.#disposed) {
			this.#retireOwnedCodexBackend(resource);
			throw new Error("shutting down; native CLI launch aborted before any child existed");
		}
		if (outcome.kind === "stopped") {
			// A confirmed Stop of this row retired the resource while its readiness was still
			// pending. The retirement already asked for the exact owned termination; this
			// launch is over, and its row keeps the backend as unsettled owned work.
			this.#retireOwnedCodexBackend(resource);
			throw new Error("session-host: the row was stopped before its native CLI child existed");
		}
		if (outcome.kind !== "ready") {
			this.#retireOwnedCodexBackend(resource);
			throw new Error("session-host: the owned Codex backend did not become ready");
		}
		if (resource.retired || record.nativeCodexBackend !== resource || this.#records.get(record.id) !== record) {
			// A stop, removal, or replacement landed while readiness was pending. The
			// retirement that caused it already asked for the exact owned termination; this
			// late answer adopts nothing and reveals nothing.
			this.#retireOwnedCodexBackend(resource);
			throw new Error("session-host: the owned Codex backend is no longer this row's run");
		}
		if (resource.settled || ownedCodexBackendKnownEnded(resource)) {
			// The backend ended between its banner and this continuation: its own status now
			// reports a stop request, a witnessed exit, or a positive settlement. A TUI that
			// attaches to an endpoint that is already gone is the substitution this path
			// refuses, and an unsettled one stays retained and owned either way.
			this.#retireOwnedCodexBackend(resource);
			throw new Error("session-host: the owned Codex backend ended before its TUI could start");
		}
		resource.ready = true;
		const identity = resource.identity;
		// The one observation source of this backend, minted once from this fulfilled
		// lease: its endpoint comes from this lease's own banner, and the bearer stays
		// reachable only through the accessor. Nothing here is stored on a view or a log.
		resource.observationSource = Object.freeze({
			leaseId: identity.leaseId,
			generation: identity.generation,
			endpoint: outcome.ready.endpoint,
			readObserverBearer: (): string => outcome.ready.readObserverBearer(),
			// Forwarded once, as the exact value this lease's readiness carried: a
			// bare backend lease simply has none, and the manager never invents one.
			...(outcome.ready.tuiRootFacts === undefined
				? {}
				: { tuiRootFacts: outcome.ready.tuiRootFacts }),
		});
		this.#captureCodexCallbackFacts(resource, outcome.ready);
		return outcome.ready;
	}

	/* --------------------------------------------------------------------- *
	 * The OPTIONAL owned Codex callback sender of one run (#682)             *
	 *                                                                        *
	 * Inert for a manager built without `nativeCodexCallback`. It composes   *
	 * only the landed transport and composer over this run's exact retained  *
	 * lease and that lease's own callback root facts; it adds no listener,   *
	 * socket of its own, PTY write, approval reply, or retry.                *
	 * --------------------------------------------------------------------- */

	/**
	 * #682 (Codex callback): the trusted owner-only sender of one owned Codex row's
	 * canonical managed outcomes, or `undefined` when there is none right now. It
	 * exists only on a manager built with {@linkcode InstanceManagerOptions.nativeCodexCallback},
	 * only for the row's CURRENT run whose launch returned a verified supported
	 * version receipt and whose native MCP lane is kept and bound to a conversation
	 * on the exact ready owned backend, and only while that backend's callback facts
	 * name the same bound root thread. A successor run, lane, or lease must prove
	 * its own; a sender is never retargeted.
	 */
	nativeCodexCallbackSender(instanceId: string): NativeCodexCallbackSender | undefined {
		if (!this.#nativeCodexCallback) return undefined;
		const record = this.#records.get(instanceId);
		const run = record?.nativeStatusRun;
		const lane = run?.mcpLane;
		if (record === undefined || run === undefined || lane === undefined || record.backend !== "codex"
			|| !lane.requiresOwnedBackend) {
			return undefined;
		}
		const existing = this.#codexCallbackSenders.get(lane);
		if (existing !== undefined) {
			return existing.isCurrent() ? existing : undefined;
		}
		const version = this.#codexCallbackVersions.get(run);
		const resource = lane.ownedBackend;
		const scope = this.#nativeMcpLaneCurrentScope(record, run, lane);
		if (version === undefined || resource === undefined || scope === undefined) {
			return undefined;
		}
		const { conversationId } = scope;
		const reader = this.#codexCallbackFacts.get(resource);
		if (reader === undefined) return undefined;
		const readFacts = () => {
			try {
				return reader.callbackFacts();
			} catch {
				return null;
			}
		};
		const isCurrent = (): boolean => {
			if (lane.revoked || lane.ownedBackend !== resource || this.#codexCallbackVersions.get(run) !== version
				|| this.#nativeMcpLaneCurrentScope(record, run, lane) !== scope) {
				return false;
			}
			const facts = readFacts();
			return facts !== null && facts.threadId === conversationId;
		};
		if (!isCurrent()) return undefined;
		const identity = resource.identity;
		const sender: NativeCodexCallbackSender = Object.freeze({
			conversationId,
			leaseId: identity.leaseId,
			generation: identity.generation,
			version,
			isCurrent,
			deliver: async (request: { readonly clientUserMessageId: string; readonly text: string; readonly signal?: AbortSignal }) => {
				const signal = request?.signal instanceof AbortSignal
					? AbortSignal.any([request.signal, lane.controller.signal])
					: lane.controller.signal;
				// The relay generation is read now and pinned for this attempt: the
				// binder never rebinds, so a later generation can only withdraw.
				const facts = isCurrent() ? readFacts() : null;
				if (facts === null) {
					return Object.freeze({ route: "precheck-declined" as const, reason: "not-current" as const, delivery: "not-delivered" as const });
				}
				const owned = Object.freeze({ threadId: conversationId, runId: facts.runId });
				return deliverNativeCodexManagedCallback({
					lease: resource.lease,
					owned,
					readFacts,
					// The final write fence: this exact lane, run, record, live PTY
					// incarnation, ready owned backend, receipt, and facts generation.
					isOwnedRunCurrent: () => {
						if (signal.aborted || !isCurrent()) return false;
						const now = readFacts();
						return now !== null && now.runId === owned.runId;
					},
					attestation: Object.freeze({ expectedTurnSteer: true as const }),
					signal,
					clientUserMessageId: request?.clientUserMessageId,
					text: request?.text,
				});
			},
		});
		this.#codexCallbackSenders.set(lane, sender);
		return sender;
	}

	/**
	 * #682 (Codex callback): keep this run's verified receipt only beside the MCP lane
	 * the same outcome kept (applied first) and an owned plan; anything else keeps
	 * nothing, so no sender can exist for the run.
	 */
	#applyCodexCallbackOutcome(run: OwnedNativeStatusRun | undefined, descriptor: unknown): void {
		if (!this.#nativeCodexCallback || run === undefined || run.retired || run.backend !== "codex") return;
		const version = readCodexCallbackCompatibilityVersion(descriptor);
		const lane = run.mcpLane;
		if (version === undefined || lane === undefined || lane.revoked || !lane.requiresOwnedBackend
			|| readNativeCodexOwnedPlan(descriptor).state !== "plan") {
			return;
		}
		this.#codexCallbackVersions.set(run, version);
	}

	/** #682 (Codex callback): the ready lease's own callback facts reader, once, when it carries one. */
	#captureCodexCallbackFacts(resource: OwnedNativeCodexBackendResource, ready: OwnedCodexBackendReady): void {
		if (!this.#nativeCodexCallback || ready.tuiRootFacts === undefined) return;
		try {
			const reader: unknown = ready.tuiRootCallbackFacts;
			if (typeof reader === "object" && reader !== null
				&& typeof (reader as Partial<NativeCodexTuiRootCallbackFactsReader>).callbackFacts === "function") {
				this.#codexCallbackFacts.set(resource, reader as NativeCodexTuiRootCallbackFactsReader);
			}
		} catch {
			// No reader, no sender.
		}
	}

	/**
	 * Request this row's owned backend's exact owned termination, once.
	 *
	 * Retirement is a stop INTENT, never a settlement: the record stays on the row with
	 * `settled` false until the lease's own positive settlement arrives, so the row keeps
	 * reporting a live process, keeps refusing removal, and keeps its staged private
	 * files. Both routes below are idempotent by contract, and neither ever signals a
	 * pid, scans a process name, or touches another row's child.
	 */
	#retireOwnedCodexBackend(resource: OwnedNativeCodexBackendResource | undefined): void {
		if (resource === undefined || resource.retired) {
			return;
		}
		resource.retired = true;
		// A launch waiting on this backend's banner stops waiting here, so a stopped row is
		// answered even if its backend never prints anything and never settles.
		try {
			resource.resolveCancel();
		} catch {
			// A resolver failure cannot leave the lease unrequested; the calls below are the
			// authoritative stop either way.
		}
		try {
			resource.controller.abort();
		} catch {
			// An accessor failure cannot leave the lease unrequested; the call below is the
			// authoritative stop and the record stays unsettled either way.
		}
		try {
			resource.lease.requestStop();
		} catch {
			// A failed stop request is not a gone process: ownership and barriers stay held.
		}
	}

	/**
	 * This row's owned backend positively settled. It is the only place `settled` is
	 * ever set, and it never claims anything about the TUI: a backend that settled while
	 * its row's PTY is still live leaves that row live, and the row's own exit stays the
	 * only witness of the TUI's end.
	 *
	 * Settlement also retires the resource: a lease that has finished is not a capability
	 * this manager may still build a TUI on, so a readiness answer that arrives afterwards
	 * is refused by the same fence every other stale continuation is.
	 */
	#onOwnedCodexBackendSettled(record: ManagedInstance, resource: OwnedNativeCodexBackendResource): void {
		if (resource.settled) {
			return;
		}
		resource.settled = true;
		this.#retireOwnedCodexBackend(resource);
		// A Codex MCP lane carried by this backend ends with it (#682). The row's
		// retained status identity is untouched; only the lane is revoked.
		const lane = record.nativeStatusRun?.mcpLane;
		if (lane !== undefined && lane.requiresOwnedBackend
			&& (lane.ownedBackend ?? record.nativeCodexBackend) === resource) {
			this.#revokeNativeMcpLane(lane);
		}
		// The backend is one of the children this launch was told to give its hook files
		// to, so its settlement is what can finally make that release safe.
		this.#releaseNativeStatusArtifacts(record, record.nativeStatusRun);
		this.#releaseNativeInitialPrompt(record);
		if (this.#records.get(record.id) === record) {
			if (this.#disposed && record.nativeCodexBackend === resource
				&& (record.pty === undefined || record.ptyExited)) {
				// Disposal deliberately preserved this row's registration and terminal surface
				// while either of its two processes was unsettled. A TUI that already exited can
				// never come back to finish that teardown, so this settlement — the last
				// outstanding proof — completes the deferred per-row cleanup instead of retaining
				// a terminal surface, its buffers, and its subscriptions for the rest of the
				// process. A still-live TUI is left entirely alone: its own exit owns that.
				this.#releaseRegistration(record);
				try {
					record.surface?.dispose();
				} catch {
					// Contained, exactly as on the late PTY-exit path.
				}
				record.surface = undefined;
			}
			this.#safeChanged(record.id);
		}
	}

	/**
	 * Offer this run's backend facts to this run's own observer, once.
	 *
	 * Every fence is re-proved at delivery: the run is this row's current, unretired,
	 * activated run with its capture bound to the live handle; the backend is this row's
	 * current, unretired, ready resource; and the delivery has not happened before. A
	 * source that arrives late is offered the same single delivery only while all of that
	 * is still true, so an old callback can never adopt a lease it did not run with.
	 *
	 * A throw retires the OBSERVATION path only — never the backend, its child, or its
	 * artifacts — and the observer's own message is never read or reported.
	 */
	#deliverOwnedCodexBackendObservation(
		record: ManagedInstance,
		run: OwnedNativeStatusRun | undefined,
		resource: OwnedNativeCodexBackendResource | undefined,
	): void {
		if (resource === undefined || resource.observationDelivered) {
			return;
		}
		if (run === undefined || run.retired || record.nativeStatusRun !== run) {
			return;
		}
		if (!run.activated || run.capture === undefined) {
			// Before the capture is bound to the exact live PTY and incarnation, a source has
			// nothing to qualify, so it is offered nothing.
			return;
		}
		if (run.capturePty === undefined
			|| run.captureIncarnation === undefined
			|| run.captureGeneration === undefined
			|| run.captureGeneration !== record.nativeStatusObserverGeneration
			|| run.captureIncarnation !== record.nativeCliIncarnation
			|| !this.#nativeCliInputAdmissible(record, run.capturePty)) {
			// The capture this run was activated against is no longer CURRENT, which is a
			// weaker claim than "a capture object exists". An accepted invalidation retires
			// this capture's observer generation and leaves the handle in place, and a
			// replaced incarnation, a stopping row, or a closed admission retires it the same
			// way. A retired capture is never a reason to hand a source a live private
			// capability, and nothing is submitted here to find out — the same fences
			// #submitNativeCliStatus applies to real observations, applied without one.
			return;
		}
		if (resource.retired || !resource.ready || record.nativeCodexBackend !== resource) {
			return;
		}
		if (resource.settled || ownedCodexBackendKnownEnded(resource)) {
			// A backend that was stopped, exited, or settled is not a live capability, however
			// long this row's TUI keeps running. A source that arrives that late is offered
			// nothing rather than the credentials of an endpoint that is already gone.
			return;
		}
		if (this.#records.get(record.id) !== record) {
			return;
		}
		const observer = run.observer;
		if (observer === undefined || typeof observer.observeOwnedCodexBackend !== "function") {
			return;
		}
		const source = resource.observationSource;
		if (source === undefined) {
			return;
		}
		resource.observationDelivered = true;
		try {
			observer.observeOwnedCodexBackend(source);
		} catch {
			// The observer's own failure retires its callbacks, exactly as a throwing hook
			// callback does; the backend resource and its ownership are untouched.
			this.#retireNativeStatusObserver(record, run);
		}
	}

	/**
	 * The ONE route a captured hosted provider TEXT copy can take, shared by the
	 * surface's OSC 52 sink and this run's capture seam.
	 *
	 * Everything is re-proved here, at delivery time: the payload is re-validated as
	 * normalized text; the row is still the current record holding this exact live,
	 * unexited, un-stopping PTY under this exact incarnation key; and a recipient
	 * exists at all. The recipient is frozen from the row's last accepted input, so
	 * input that arrives after this copy was accepted never retargets it — and a
	 * recipient that is no longer eligible delivers nothing. There is never a
	 * broadcast, never an owner-local fallback for a viewer-routed copy, never a
	 * sibling viewer, and never a queue or retry.
	 */
	#submitNativeCliCopy(
		record: ManagedInstance,
		pty: InstancePty,
		incarnation: Buffer | undefined,
		encoded: string,
	): boolean {
		if (!isNativeCliCopyEncoded(encoded)) {
			return false;
		}
		const backend = record.backend;
		if (!isNativeCliBackend(backend)
			|| incarnation === undefined
			|| record.nativeCliIncarnation !== incarnation
			|| !this.#nativeCliInputAdmissible(record, pty)) {
			return false;
		}
		// Frozen at acceptance: this snapshot is the whole recipient decision.
		const controller = record.nativeCliController;
		if (controller === undefined) {
			// No known origin on this incarnation: nothing is forwarded, and nothing
			// falls back to the owner or to another surface.
			return false;
		}
		const event: NativeCliClipboardEvent = Object.freeze({ kind: "copy" as const, encoded, backend });
		if (controller.kind === "local") {
			return this.#forwardNativeCliLocalCopy(record, event);
		}
		return this.#forwardNativeCliViewerCopy(record, controller, event);
	}

	/**
	 * Owner-local hosted provider copy route. The manager holds no terminal and makes
	 * no display claim: it hands the copy to the host's separate owner-local route,
	 * which owes its own live-row, focus, and actual-coverage proof. Absent that route
	 * there is no delivery and no substitute.
	 */
	#forwardNativeCliLocalCopy(record: ManagedInstance, event: NativeCliClipboardEvent): boolean {
		const forward = this.#onNativeCliClipboard;
		if (forward === undefined) {
			return false;
		}
		try {
			forward(record.id, event);
		} catch {
			// The host's own route contains its failures; a refusal cannot break a row.
		}
		return true;
	}

	/**
	 * Route one captured copy to the ONE viewer this manager last accepted input from
	 * on this incarnation, and to nobody else.
	 *
	 * The stored token is only a lookup commitment: delivery happens only after the
	 * viewer record is re-read and its CURRENT facts re-verify that exact token under
	 * this incarnation's private key, the viewer still displays this exact row, and it
	 * still carries its own copy sink. A retired viewer, a viewer now showing another
	 * row, a viewer revision, a geometry or backend change, a replacement child, a
	 * released row, or a missing sink delivers nothing — quietly, with no sibling,
	 * owner-local, broadcast, or retry.
	 */
	#forwardNativeCliViewerCopy(
		record: ManagedInstance,
		controller: {
			readonly kind: "viewer";
			readonly viewerId: string;
			readonly sourceToken: string;
			readonly ordinal: number;
		},
		event: NativeCliClipboardEvent,
	): boolean {
		const viewer = this.#viewers.get(controller.viewerId);
		if (viewer === undefined || viewer.sessionId !== record.id) {
			return false;
		}
		const sink = viewer.nativeClipboardSink;
		if (sink === undefined) {
			return false;
		}
		const incarnation = record.nativeCliIncarnation;
		const facts = this.#viewerNativeCliScopeFacts(viewer, record);
		if (incarnation === undefined || facts === undefined
			|| !verifyNativeViewerNativeCliScopeToken(incarnation, controller.sourceToken, facts)) {
			return false;
		}
		const receipt: NativeViewerNativeCliClipboardReceipt = Object.freeze({
			source: Object.freeze({
				hostRunId: facts.hostRunId,
				viewerId: facts.viewerId,
				viewerRevision: facts.viewerRevision,
				rowId: facts.rowId,
				phase: NATIVE_CLI_INPUT_PHASE,
				backend: facts.backend,
				geometry: Object.freeze({
					cols: facts.cols,
					rows: facts.rows,
					revision: facts.geometryRevision,
				}),
				sourceToken: controller.sourceToken,
			}),
			event,
			dispatchId: controller.ordinal,
		});
		try {
			sink(receipt);
		} catch {
			// A viewer's own refusal cannot break a row or escape into the parser.
		}
		return true;
	}

	/**
	 * The immutable facts one viewer's scope commits to, read from the CURRENT
	 * record. Undefined when a fact is missing (no run identity, no sink, no
	 * registration, or no current native conversation).
	 */
	#viewerScopeFacts(
		viewer: ManagedViewer,
		record: ManagedInstance,
		registration: InstanceStatusRegistration,
	): NativeViewerScopeFacts | undefined {
		const hostRunId = viewer.hostRunId;
		const native = record.nativeSession;
		if (hostRunId === undefined || viewer.nativeClipboardSink === undefined || native === null) {
			return undefined;
		}
		return Object.freeze({
			hostRunId,
			viewerId: viewer.id,
			viewerRevision: viewer.revision,
			rowId: record.id,
			registrationIdentity: registration.bootstrap.instanceId,
			registrationGeneration: registration.bootstrap.generation,
			nativeSessionId: native.sessionId,
			nativeSessionEpoch: native.epoch,
			cols: record.cols,
			rows: record.rows,
			geometryRevision: record.geometryRevision,
		});
	}

	/**
	 * Mint one viewer's current input source with its scope token, or undefined when
	 * the current facts cannot be described. The token is derived from this
	 * registration's own existing bootstrap key — no new secret, no new state.
	 */
	#viewerInputSource(
		viewer: ManagedViewer,
		record: ManagedInstance,
		registration: InstanceStatusRegistration,
	): NativeViewerInputSource | undefined {
		const facts = this.#viewerScopeFacts(viewer, record, registration);
		if (facts === undefined) {
			return undefined;
		}
		const sourceToken = mintNativeViewerScopeToken(registration.bootstrap, facts);
		if (sourceToken === undefined) {
			return undefined;
		}
		return this.#viewerInputSourceFromFacts(facts, sourceToken);
	}

	/** Owned, frozen description of already-verified scope facts. */
	#viewerInputSourceFromFacts(facts: NativeViewerScopeFacts, sourceToken: string): NativeViewerInputSource {
		return Object.freeze({
			hostRunId: facts.hostRunId,
			viewerId: facts.viewerId,
			viewerRevision: facts.viewerRevision,
			rowId: facts.rowId,
			nativeSession: Object.freeze({
				sessionId: facts.nativeSessionId,
				epoch: facts.nativeSessionEpoch,
			}),
			geometry: Object.freeze({
				cols: facts.cols,
				rows: facts.rows,
				revision: facts.geometryRevision,
			}),
			registrationIdentity: facts.registrationIdentity,
			registrationGeneration: facts.registrationGeneration,
			sourceToken,
		});
	}

	/**
	 * Mint one viewer's current STARTUP input source, or undefined when the facts
	 * cannot be described. Its token is minted in the separate `nvst1` startup
	 * domain from this registration's own existing bootstrap key and commits to the
	 * same run, viewer and revision, row, registration and generation, and canonical
	 * geometry and revision — with no conversation field at all.
	 */
	#viewerStartupInputSource(
		viewer: ManagedViewer,
		record: ManagedInstance,
		registration: InstanceStatusRegistration,
	): NativeViewerStartupInputSource | undefined {
		const hostRunId = viewer.hostRunId;
		if (hostRunId === undefined || viewer.nativeClipboardSink === undefined) {
			return undefined;
		}
		const facts: NativeViewerStartupScopeFacts = Object.freeze({
			hostRunId,
			viewerId: viewer.id,
			viewerRevision: viewer.revision,
			rowId: record.id,
			registrationIdentity: registration.bootstrap.instanceId,
			registrationGeneration: registration.bootstrap.generation,
			cols: record.cols,
			rows: record.rows,
			geometryRevision: record.geometryRevision,
		});
		const sourceToken = mintNativeViewerStartupScopeToken(registration.bootstrap, facts);
		if (sourceToken === undefined) {
			return undefined;
		}
		return Object.freeze({
			hostRunId: facts.hostRunId,
			viewerId: facts.viewerId,
			viewerRevision: facts.viewerRevision,
			rowId: facts.rowId,
			phase: "startup" as const,
			geometry: Object.freeze({
				cols: facts.cols,
				rows: facts.rows,
				revision: facts.geometryRevision,
			}),
			registrationIdentity: facts.registrationIdentity,
			registrationGeneration: facts.registrationGeneration,
			sourceToken,
		});
	}

	/**
	 * End this registration's startup phase for good. `notify` publishes a change so
	 * a published startup source is replaced at a genuine boundary even when no
	 * other row fact moved; callers that already publish a change pass `false`.
	 */
	#closeStartupInput(record: ManagedInstance, notify: boolean): void {
		if (!record.startupInputOpen) return;
		record.startupInputOpen = false;
		if (notify && this.#records.get(record.id) === record) this.#safeChanged(record.id);
	}

	/**
	 * Recompute one row's canonical geometry from its viewers. Columns and rows
	 * take their own minimum (100x40 and 80x50 give 80x40), and a row with no
	 * contributing viewer is left exactly as it is.
	 */
	#recomputeViewerGeometry(sessionId: string): void {
		const record = this.#records.get(sessionId);
		if (!isViewableRow(record)) {
			return;
		}
		let cols: number | undefined;
		let rows: number | undefined;
		for (const viewer of this.#viewers.values()) {
			if (viewer.sessionId !== sessionId || viewer.cols === undefined || viewer.rows === undefined) {
				continue;
			}
			if (cols === undefined || viewer.cols < cols) cols = viewer.cols;
			if (rows === undefined || viewer.rows < rows) rows = viewer.rows;
		}
		if (cols === undefined || rows === undefined) {
			return;
		}
		this.#applyGeometry(record as ManagedInstance, cols, rows);
	}

	/**
	 * Apply one row's canonical geometry to its own PTY and surface. Failures are
	 * contained on this row exactly as a host-wide resize contains them.
	 */
	#applyGeometry(record: ManagedInstance, cols: number, rows: number): boolean {
		if (record.cols === cols && record.rows === rows) {
			return false;
		}
		const pty = record.pty;
		if (pty && !record.ptyExited) {
			try {
				pty.resize(cols, rows);
			} catch {
				this.#failRunningInstance(record, "ptyResize");
				return false;
			}
		}
		record.cols = cols;
		record.rows = rows;
		record.geometryRevision += 1;
		if (record.surface) {
			try {
				record.surface.resize(cols, rows);
			} catch {
				this.#failRunningInstance(record, "surfaceResize");
			}
		}
		return true;
	}

	/**
	 * End every surface's participation in one row that can no longer be
	 * displayed (its child exited, the row was removed, or the manager disposed).
	 * The revision bump makes an in-flight writer for the old view stale, and
	 * viewer ids are never reused, so nothing can resurrect the finished view.
	 */
	#retireViewerTargets(sessionId: string): void {
		for (const viewer of this.#viewers.values()) {
			if (viewer.sessionId !== sessionId) continue;
			viewer.sessionId = undefined;
			viewer.revision += 1;
		}
	}

	/** True when the manager still owns at least one child handle not known exited. */
	hasLiveProcesses(): boolean {
		for (const record of this.#records.values()) {
			if (record.pty && !record.ptyExited) {
				return true;
			}
			// An owned backend this manager started is its own process: a row whose TUI has
			// exited but whose backend has not settled is still owned work, never "gone".
			if (ownsUnsettledCodexBackend(record)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Bounded graceful shutdown of every owned child: authenticated public
	 * native shutdown when available, POSIX SIGTERM fallback, and bounded
	 * forced escalation on the same owned handle only, honest
	 * forced/remaining tracking. No global process scans, no arbitrary group
	 * kills, no adopted-descendant cleanup: remaining handles keep their
	 * admission and are released only by their own confirmed exit event.
	 */
	async shutdown(options?: ShutdownOptions): Promise<ShutdownResult> {
		if (this.#disposed) {
			return {
				forcedIds: [...this.#records.values()]
					.filter((record) => (record.pty && record.sigkillSent) || ownedCodexBackendForceEscalationAttempted(record.nativeCodexBackend))
					.map((record) => record.id),
				// Same truth as the live pass below: a row whose owned backend has not
				// settled still owns that process, whether or not its TUI ever existed.
				remainingIds: [...this.#records.values()]
					.filter((record) => (record.pty && !record.ptyExited) || ownsUnsettledCodexBackend(record))
					.map((record) => record.id),
			};
		}
		const graceMs = options?.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
		const killMs = options?.killMs ?? DEFAULT_SHUTDOWN_KILL_MS;
		validateShutdownMs(graceMs, "graceMs");
		validateShutdownMs(killMs, "killMs");
		this.#stopping = true;
		// An in-flight pre-spawn wait (a native CLI launch provider) stops waiting
		// here, so a provider that never answers cannot postpone this stop ladder.
		this.#publishShutdownNotice();
		// A stopping manager admits no startup input again, in any row.
		for (const record of this.#records.values()) this.#closeStartupInput(record, false);
		// Late async creates settle or abort here; none can spawn after stop.
		await Promise.allSettled([...this.#inflightCreates]);
		return this.#stopOwnedProcesses(graceMs, killMs);
	}

	/**
	 * Idempotent graceful cleanup then owned resource disposal: stops any
	 * owned child never signaled before (default windows). Exited rows release
	 * their status registrations and terminal surfaces; rows whose child never
	 * confirmed exit retain both, keep lifecycle 'alive', and hold their setup
	 * admission until their own exit event fires. Native/session files and
	 * unknown files are never touched by this module.
	 */
	async dispose(): Promise<void> {
		// The tracked promise is always checked first: disposal may already be
		// running past its owned-resource cleanup and into the #666 reader
		// confirmation, and a concurrent or later caller must observe that same
		// outcome — including its rejection — rather than an early "already
		// disposed" success while the required cleanup is unconfirmed.
		if (this.#disposePromise) {
			await this.#disposePromise;
			return;
		}
		if (this.#disposed) {
			return;
		}
		this.#disposePromise = this.#runDispose();
		await this.#disposePromise;
	}

	async #runDispose(): Promise<void> {
		this.#stopping = true;
		// Same abort as shutdown(): disposal never waits on an unresolved provider.
		this.#publishShutdownNotice();
		for (const record of this.#records.values()) this.#closeStartupInput(record, false);
		await Promise.allSettled([...this.#inflightCreates]);
		try {
			await this.#stopOwnedProcesses(DEFAULT_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_KILL_MS);
		} catch {
			// Contained: disposal proceeds with owned resource cleanup below.
		}
		this.#disposed = true;
		this.#releaseNativeMcpLaneActivity();
		// No surface survives this host's manager: every viewer fact is dropped.
		this.#viewers.clear();
		for (const record of this.#records.values()) {
			// Every OPTIONAL native status source this host armed is retired here, live
			// child or not: no observer, registration, or capture outlives the manager that
			// created it. Files staged for a child that has NOT settled are deliberately
			// preserved — an uncertain ownership chain is never cleaned as if it had
			// finished — and the retained exit listener releases them if it ever does.
			this.#retireNativeStatusRun(record.nativeStatusRun);
			// An owned backend process goes the same way: its exact owned termination is
			// requested now, and an unsettled one keeps its record, its files, and this row's
			// liveness until it settles on its own.
			this.#retireOwnedCodexBackend(record.nativeCodexBackend);
			record.busy = null;
			record.pendingInput = null;
			record.inputSurface = false;
			record.backgroundTasks = null;
			record.backgroundShells = null;
			record.activeTasks = null;
			record.activeShells = null;
			record.activity = [];
			this.#disposeDataListener(record);
			if ((record.pty && !record.ptyExited) || ownsUnsettledCodexBackend(record)) {
				// Preserve the authenticated owner and terminal surface until actual
				// PTY exit — and until an owned backend of this same launch settles, which
				// the TUI's own exit never proves. The retained exit/error listeners
				// complete this teardown.
				continue;
			}
			this.#releaseRegistration(record);
			try {
				record.surface?.dispose();
			} catch {
				// Each surface is independently owned; keep disposing siblings.
			}
			record.surface = undefined;
		}
		// Exit and read-error listeners of never-settled children stay attached:
		// they release registration, surface, and admission on a late exit and
		// keep the pinned native stream's unexpected errors contained.
		// #666: finally, every owned Windows ConPTY reader whose handle exited must
		// have positively settled. An unconfirmed release rejects disposal, which the
		// host reports as a cleanup failure.
		await this.#confirmOwnedConptyReaders();
	}

	/**
	 * Require positive settlement of every owned Windows ConPTY reader released by
	 * the default PTY factory's adapter (#666) once that exact handle's own exit
	 * event made the release due. Cleanup follows the exit only: a pending handle
	 * that never exited owes no release here, but adapter failures remain failures.
	 * A POSIX row or an injected custom/fake PTY has no owned addon reader and is
	 * never registered. A capture that
	 * never identified the owned reader, and a disposal whose Worker never settled,
	 * both stay explicit failures rather than synthesized success.
	 *
	 * No wait is granted here. Each record carries the one absolute confirmation
	 * deadline anchored at the exit that triggered its release, inside the existing
	 * {@linkcode DEFAULT_SHUTDOWN_KILL_MS} window and never later than the stop
	 * budget of the ladder that ended that child; an already-expired deadline fails
	 * immediately instead of restarting the clock.
	 */
	async #confirmOwnedConptyReaders(): Promise<void> {
		// A failed exit subscription cannot erase a required cleanup failure merely
		// because the adapter could not observe the manager's genuine exit event.
		const due = [...this.#ownedConptyReaders].filter((settlement) => settlement.state === "failed"
			|| (settlement.exitObserved && !settlement.settled));
		if (due.length === 0) return;
		const outcomes = await Promise.all(due.map((settlement) => settlement.confirmSettlement()));
		const unsettled = outcomes.filter((settled) => !settled).length;
		if (unsettled > 0) {
			throw new Error(
				`session-host: owned Windows ConPTY reader settlement was not confirmed for ${unsettled} cleanup record(s)`,
			);
		}
	}

	#assertUsable(operation: string): void {
		if (this.#disposed) {
			throw new Error(`session-host: the instance manager is disposed; ${operation} is no longer available`);
		}
	}

	/**
	 * The current shutdown/disposal notification, resolved as soon as this manager
	 * has begun either. A creation that starts after that point is already aborted.
	 */
	#awaitShutdownNotice(): Promise<void> {
		if (this.#shutdownNotice === undefined) {
			let resolve: () => void = () => undefined;
			this.#shutdownNotice = new Promise<void>((fulfill) => { resolve = fulfill; });
			this.#shutdownNoticeResolve = resolve;
		}
		if (this.#stopping) this.#shutdownNoticeResolve?.();
		return this.#shutdownNotice;
	}

	/** Publish the notification once, immediately after the stopping latch is set. */
	#publishShutdownNotice(): void {
		this.#awaitShutdownNotice();
		this.#shutdownNoticeResolve?.();
	}

	/**
	 * Whether this row is an owned-capable Codex launch still in preparation: neither its
	 * TUI nor its backend exists yet, so the only thing a Stop can act on is the launch
	 * itself. "Owned-capable" is entirely this manager's own fact — it can honor an owned
	 * plan, and this row's recorded backend is Codex — so no Pi, Claude, or ordinary
	 * non-owned Codex row's answers change here, and no provider is consulted or asked
	 * what it intends to return.
	 */
	#pendingOwnedCodexPreparation(record: ManagedInstance): boolean {
		return record.nativeCliLaunchPending === true
			&& this.#ownedCodexBackendFactory !== undefined
			&& record.backend === "codex";
	}

	/**
	 * This row's cancellation notification, created on first need. It is the row-level
	 * counterpart of {@linkcode InstanceManager.#awaitShutdownNotice}: a native CLI launch
	 * races it against its provider, so a confirmed Stop of a row whose provider has not
	 * answered is answered immediately instead of whenever that provider happens to return,
	 * and a provider that answers later can create neither a backend nor a TUI.
	 */
	#awaitNativeLaunchCancellation(record: ManagedInstance): Promise<void> {
		if (record.launchCancel === undefined) {
			let resolve: () => void = () => undefined;
			record.launchCancel = new Promise<void>((fulfill) => { resolve = fulfill; });
			record.resolveLaunchCancel = resolve;
		}
		return record.launchCancel;
	}

	/** Publish that notification once. Idempotent, and it never signals a process. */
	#cancelNativeLaunch(record: ManagedInstance): void {
		// Created before it is resolved, so a launch that reaches the race afterwards still
		// sees an already-cancelled row rather than a fresh, unresolved notification.
		this.#awaitNativeLaunchCancellation(record);
		try {
			record.resolveLaunchCancel?.();
		} catch {
			// A resolver failure cannot un-stop the row: the launch also rechecks this row's
			// closed admission immediately before it would create anything.
		}
	}

	#sidebarTitleColumnsSnapshot(): number | undefined {
		try {
			const columns = this.#getSidebarTitleColumns?.();
			return Number.isSafeInteger(columns) && (columns as number) >= 1 && (columns as number) <= 1000
				? columns as number
				: undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * The manager's own shared native Pi root, read only for native-row ownership
	 * bookkeeping. It comes from the injected setup preparer's canonical root when
	 * that preparer publishes one (production's native registry). Nothing is
	 * admitted, prepared, initialized, or released here, and the recorded value
	 * never says where the provider keeps its own configuration: a native row's
	 * provider state stays entirely the provider's own.
	 */
	#hostAgentDir(): string {
		const preparer = this.#profilePreparer as { readonly agentDir?: unknown };
		const agentDir = preparer?.agentDir;
		return typeof agentDir === "string" ? agentDir : "";
	}

	/**
	 * Launch one native CLI row (issue 277 core slice): an ordinary interactive
	 * provider child running in this row's explicitly selected workspace.
	 *
	 * What this path deliberately never does is the point of it: no setup admission
	 * and no Pi agent-directory initialization, no Pi launch composition, no status
	 * registration (so no bootstrap token exists for this child anywhere), no
	 * startup payload, no preload/NODE_OPTIONS or title-columns environment, no
	 * input framing, and no native clipboard receiver. The injected provider owns
	 * the executable, argv, and provider-side environment sanitization; the manager
	 * contributes nothing to the child's environment except the removal of its own
	 * host capability tokens.
	 *
	 * Everything else is the same ownership machinery as a Pi row: the row is
	 * already posted, the provider is resolved BEFORE the synchronous spawn stretch
	 * and this manager's shutdown latch is rechecked after that await so a
	 * concurrent stop never spawns, ownership of the exact PTY handle is recorded
	 * before any child callback can fire, and that handle's own exit event remains
	 * the only settlement witness.
	 */
	async #launchNativeCliInstance(
			record: ManagedInstance,
			options: { workspace: string; backend: NativeCliBackend; targetId?: string; initialRequest?: { title: string; prompt: string }; createWorkspace?: boolean },
		): Promise<void> {
		// The OPTIONAL native status source of this launch, armed below before the provider
		// runs. Declared outside the try so every failure path can retire it.
		let statusRun: OwnedNativeStatusRun | undefined;
		// The owned Codex backend of this launch, when its provider attached a plan. Also
		// declared outside the try: a backend created before a later failure stays this
		// manager's ownership until its own settlement, and every path below must request
		// its exact owned termination rather than forget it.
		let ownedBackend: OwnedNativeCodexBackendResource | undefined;
		try {
			// 1. The selected workspace is the only setup fact this row needs: an
			// existing absolute directory, canonicalized. No provider configuration,
			// agent directory, profile, or skill work happens on this path. An opted-in
			// row first ensures the directory exists through the same shared resolver.
			const workspace = canonicalNativeWorkspace(options.workspace, options.createWorkspace === true);
			record.workspace = workspace;
			record.agentDir = this.#hostAgentDir();
			this.#safeChanged(record.id);
			// 1b. A fresh SessionSpawn startup request (issue #493): the exact prompt is
			// staged in this manager's own private file BEFORE the provider runs, and the
			// row owns the lease from this instant. The provider only ever sees the short
			// generated instruction (and, for Claude, the exact title). A staging refusal
			// is an ordinary preparation failure: no child of this launch can exist.
			let initialPrompt: NativeCliInitialPrompt | undefined;
			if (options.initialRequest !== undefined) {
				const lease = prepareNativeInitialPrompt(options.initialRequest.prompt);
				record.nativeInitialPrompt = { lease, abandoned: false, released: false };
				initialPrompt = {
					instruction: lease.instruction,
					...(options.backend === "claude" ? { title: options.initialRequest.title } : {}),
				};
			}

			await yieldCheckpoint();
			if (this.#stopping) {
				throw new Error("shutting down; native CLI launch aborted before any child existed");
			}

			// 2. Resolve the provider's full interactive descriptor before the spawn
			// stretch. The provider receives a fresh copy of this manager's environment
			// snapshot (never mutated) plus the unchanged operator target selection.
			//
			// The provider lives outside this module and may take arbitrarily long, so
			// its resolution is raced against this manager's shutdown notification:
			// `shutdown()`/`dispose()` must reach the owned stop ladder for the
			// manager's other children even when a provider never answers. Both outcome
			// handlers are attached to the provider promise itself, so a late
			// fulfillment is simply discarded and a late rejection can never surface as
			// an unhandled rejection. Nothing below the race can spawn before #stopping
			// is rechecked, and the spawn stretch itself never yields.
			const launch = this.#nativeCliLaunch;
			if (launch === undefined) {
				// create() refused this combination already; a manager reconfigured after
				// posting the row still never falls back to a Pi launch.
				throw new Error("session-host: this host has no native CLI launch provider");
			}
			// The OPTIONAL owner-side native status source (issue #277 owner slice). It is
			// armed HERE — before the provider runs, and therefore before any child of this
			// launch can exist — so the broker bootstrap it issues is genuinely this
			// launch's own and can be handed to the provider. A manager without the
			// optional pair returns undefined and this request is exactly the request it
			// always sent.
			statusRun = this.#armNativeStatusRun(record, options.backend);
			const nativeHook = statusRun?.bootstrap === undefined
				? undefined
				: { bootstrap: statusRun.bootstrap };
			// The OPTIONAL native MCP lane (#682) of this same run, armed in the same
			// pre-spawn stretch. Without a lane owner (or without an armed status run) it
			// is undefined and the request is exactly what it always was.
			const nativeMcp = this.#armNativeMcpLane(record, statusRun, options.backend, workspace);
			// The OPTIONAL Claude inbox compatibility request (#682): only for a run whose
			// inbox slot was armed beside a usable hook bootstrap; otherwise absent.
			// A lane-scoped opt-in also needs this run's own MCP registration; without it
			// nothing is requested, so the slot is revoked at the launch outcome.
			const claudeInboxCompatibility = statusRun?.claudeInbox !== undefined
				&& !statusRun.claudeInbox.revoked
				&& statusRun.bootstrap !== undefined
				&& (!this.#nativeClaudeInboxRequiresMcpLane || nativeMcp !== undefined);
			const pendingProvider = Promise.resolve().then(() => launch(options.backend, {
				workspace,
				env: { ...this.#env },
				...(options.targetId === undefined ? {} : { targetId: options.targetId }),
				...(nativeHook === undefined ? {} : { nativeHook }),
				...(nativeMcp === undefined ? {} : { nativeMcp }),
				...(record.nativeResumeConversationId === undefined
					? {}
					: { resumeConversationId: record.nativeResumeConversationId }),
				...(initialPrompt === undefined ? {} : { initialPrompt }),
				...(claudeInboxCompatibility ? { claudeInboxCompatibility: true } : {}),
				...(claudeInboxCompatibility && this.#nativeClaudeInboxRequiresMcpLane
					? { claudeInboxRequiresNativeMcp: true }
					: {}),
				// #682 (Codex callback): only beside this run's own registered MCP lane.
				...(this.#nativeCodexCallback && options.backend === "codex" && nativeMcp !== undefined
					? { codexCallbackCompatibility: true }
					: {}),
			}));
			// The provider is raced against three notifications, never against a timeout of
			// its own: this manager shutting down, and THIS row being stopped by its operator
			// (a confirmed Stop of a row that has produced no process yet has nothing else to
			// act on, so the launch itself is what it cancels).
			const outcome = await Promise.race([
				pendingProvider.then(
					(descriptor) => {
						// EVERY provider fulfillment is accounted for here, including one that
						// arrives after this launch was already abandoned: whatever that
						// preparation staged becomes this manager's ownership at once, so a late
						// or discarded descriptor can never strand it. Nothing here waits for an
						// unresolved provider — shutdown keeps its existing bound.
						this.#adoptNativeHookLease(record, statusRun, descriptor);
						return { kind: "provided" as const, descriptor };
					},
					(error: unknown) => ({ kind: "failed" as const, refusedOwnedProfile: isOwnedCodexProfileRefusal(error) }),
				),
				this.#awaitShutdownNotice().then(() => ({ kind: "aborted" as const })),
				this.#awaitNativeLaunchCancellation(record).then(() => ({ kind: "cancelled" as const })),
			]);
			// The provider ran across an await: a stop that began meanwhile takes this
			// launch, so no child is ever created after the host began shutting down,
			// and a provider that answers later can never resurrect this creation.
			if (this.#stopping || this.#disposed) {
				throw new Error("shutting down; native CLI launch aborted before any child existed");
			}
			if (outcome.kind === "cancelled") {
				// The operator stopped this row while its provider was still preparing. The
				// Stop already closed admission and retired this run's observation path; here
				// the launch simply ends, so a provider fulfillment that arrives afterwards —
				// or one that won this race by a microtask — creates no backend and no TUI.
				throw new Error("session-host: the row was stopped before its native CLI child existed");
			}
			if (outcome.kind !== "provided") {
				// The typed owned-profile refusal is mapped HERE, to one fixed existing row
				// error and nothing else: the provider's exception object, its message, the
				// configured profile spelling, its path, and its arguments never reach the row,
				// a view, or a log. Every other provider failure keeps the same fixed text, so
				// no lane can tell a caller anything about what the operator configured.
				throw new Error(outcome.kind === "aborted"
					? "shutting down; native CLI launch aborted before any child existed"
					: outcome.refusedOwnedProfile === true
						? "session-host: the native CLI launch provider refused an owned Codex backend launch"
						: "session-host: the native CLI launch provider did not produce a descriptor");
			}
			const descriptor = validatedNativeCliDescriptor(outcome.descriptor, workspace);
			// What the provider made of the bootstrap it was handed, for the OBSERVATION
			// SOURCE only. The spawn descriptor above is unaffected either way, and the
			// staged files this fulfillment carried were already adopted above.
			this.#applyNativeHookOutcome(statusRun, outcome.descriptor);
			this.#applyNativeMcpOutcome(statusRun, outcome.descriptor);
			this.#applyClaudeInboxOutcome(statusRun, outcome.descriptor);
			this.#applyCodexCallbackOutcome(statusRun, outcome.descriptor);

			// 2b. The OWNED Codex backend (issue #277 owning-manager slice). Only a provider
			// constructed in owned mode attaches a plan, and only such a launch enters here:
			// the lease is created and RETAINED ON THE RECORD SYNCHRONOUSLY before anything
			// is awaited, so a backend child that exists is a child this manager owns from
			// its first instruction — never one hidden inside an unresolved promise. The TUI
			// is then rendered from THAT lease's connection, so the interactive client and
			// the backend are the same resolved target and endpoint, and a launch that never
			// became ready never spawns a TUI at all.
			const ownedPlanReading = readNativeCodexOwnedPlan(outcome.descriptor);
			if (ownedPlanReading.state === "malformed") {
				// A provider that attached an owned Codex plan this manager cannot consume is
				// refused HERE, before the backend factory and before the pinned spawn. The
				// alternative is the one outcome this path exists to prevent: quietly spawning
				// the standalone descriptor as if the caller had never asked for an owned
				// backend. The malformed value is never inspected further, echoed, or stored,
				// and the fixed lane below carries no field, path, or message of theirs; no
				// capability, endpoint, or observation source can exist for this row.
				throw new Error("session-host: the owned Codex backend plan is unusable");
			}
			const ownedPlan = ownedPlanReading.state === "plan" ? ownedPlanReading.plan : undefined;
			let ownedConnection: { readonly args: readonly string[]; readonly env: Readonly<Record<string, string | undefined>> } | undefined;
			if (ownedPlan !== undefined) {
				// The last look before a process of this launch can exist. The race above
				// already answers a Stop that arrived during preparation; this re-checks the
				// row's own admission, because a Stop that wins by a microtask must still not
				// end up with a backend and a TUI behind it.
				if (record.stopAdmissionClosed) {
					throw new Error("session-host: the row was stopped before its native CLI child existed");
				}
				ownedBackend = this.#createOwnedCodexBackend(record, ownedPlan);
				const ready = await this.#awaitOwnedCodexBackendReady(record, ownedBackend);
				// THE final fence, re-proved on THIS caller's continuation and not on the
				// helper's: returning from an await is itself a gap in which a confirmed row
				// Stop, a removal, a manager shutdown, or this backend's own exit can land — and
				// a row Stop sets none of the manager-wide flags. Everything below is a
				// synchronous stretch, so re-reading the exact resource here is what guarantees
				// that no TUI, and no read of its private connection material, follows a backend
				// this manager no longer owns.
				if (this.#stopping || this.#disposed || record.stopAdmissionClosed
					|| ownedBackend.retired || ownedBackend.settled
					|| record.nativeCodexBackend !== ownedBackend
					|| this.#records.get(record.id) !== record
					|| ownedCodexBackendKnownEnded(ownedBackend)) {
					// Retirement (if anything about this row is still outstanding) was requested
					// by whoever changed the answer, and an unsettled backend stays owned by this
					// row's record until its own settlement proves it gone.
					this.#retireOwnedCodexBackend(ownedBackend);
					throw new Error("session-host: the owned Codex backend is no longer available for TUI startup");
				}
				// Read the private connection material once, in the same synchronous stretch
				// that spawns from it: a fresh child-only environment carrying the bearer, and
				// nothing that ever enters a view, a log, or the row's stored state.
				ownedConnection = ready.createTuiConnection();
			}

			// 3. Synchronous spawn stretch: nothing yields until the handlers and the
			// terminal surface are attached, so ownership is recorded before any child
			// callback can fire. The descriptor is applied verbatim.
			let pty: InstancePty | undefined;
			try {
				// An owned launch spawns what its OWN lease renders, never the standalone
				// descriptor: same canonical executable, same workspace, the lease's private
				// connection arguments in real option position, and the lease's fresh child
				// environment. A plan that renders anything unusable is refused here, before
				// the pinned spawn, exactly as a provider descriptor would be.
				const launchTarget = ownedPlan === undefined || ownedConnection === undefined
					? descriptor
					: validatedNativeCliDescriptor(ownedPlan.renderTui(ownedConnection), workspace);
				// The private fact of the process about to exist, minted in the same
				// synchronous stretch as the spawn: a row never owns a live provider child
				// whose input scope key does not exist yet, and a replacement child never
				// inherits its predecessor's. Nothing derived from it is ever published.
				record.nativeCliIncarnation = randomBytes(NATIVE_CLI_INCARNATION_BYTES);
				pty = this.#ptyFactory({
					file: launchTarget.file,
					args: launchTarget.args,
					...(launchTarget.commandLine === undefined ? {} : { commandLine: launchTarget.commandLine }),
					env: nativeCliChildEnv(launchTarget.env),
					cwd: launchTarget.cwd,
					cols: record.cols,
					rows: record.rows,
				});
				record.pty = pty;
				// #666: the same owned-reader contract as a Pi row. A native CLI child
				// spawned by the default factory on Windows leaks the same addon reader,
				// so its settlement is recorded here for the disposal-time confirmation;
				// the release itself is still triggered only by that handle's own exit.
				// Settled readers are already history, so they are dropped here instead of
				// retaining a finished handle graph for the manager's whole lifetime.
				for (const settled of this.#ownedConptyReaders) {
					if (settled.settled) this.#ownedConptyReaders.delete(settled);
				}
				const ownedReader = ownedConptyReaderRecord(pty);
				if (ownedReader !== undefined) this.#ownedConptyReaders.add(ownedReader.settlement);
				// This run's required reader is recorded HERE, before ANY callback that can
				// report an exit is attached. A handle that reports an exit synchronously
				// while its listener is being registered must reach the artifact-release
				// decision with this run's settlement already known, never as though no
				// reader were required at all.
				if (statusRun !== undefined) {
					statusRun.readerSettlement = ownedReader?.settlement;
				}
				if (record.nativeInitialPrompt !== undefined) {
					record.nativeInitialPrompt.readerSettlement = ownedReader?.settlement;
				}
				record.exitDisposable = pty.onExit((event) => this.#onPtyExit(record, event));
				if (record.ptyExited) {
					this.#disposeExitListener(record);
					if (this.#records.get(record.id) !== record) {
						// An exit observer may synchronously close the row while onExit()
						// registers its listener: allocate nothing else for a detached record.
						return;
					}
				}
				record.surface = new TerminalSurface(record.cols, record.rows, {
					onReply: (data) => this.#onQueryReply(record, undefined, data),
					onChange: () => this.#safeChanged(record.id),
					onBackpressure: (paused) => this.#onBackpressure(record, paused),
					onDiagnostic: (event) => this.#safeTerminalDiagnostic(record.id, event),
					// The closed TEXT copy capture of THIS child: bound to this exact
					// handle and incarnation, and installed on no other surface.
					onNativeCliOsc52Copy: this.#nativeCliOsc52Sink(record, pty),
					getSupportedKeyboardFlags: this.#getSupportedKeyboardFlags,
					graphicsBudget: this.#graphicsBudget,
				});
				if (!record.ptyExited) {
					record.readErrorDisposable = subscribePtyReadErrors(pty, () => this.#onPtyReadError(record));
					if (record.ptyExited) {
						this.#disposeReadErrorListener(record);
					}
				}
				if (!record.ptyExited) {
					record.dataDisposable = pty.onData((data) => this.#onPtyData(record, data));
					if (record.ptyExited) {
						// An injected/fake event source may emit synchronously while listener
						// registration is returning; never revive its row.
						this.#disposeDataListener(record);
					} else if (record.lifecycle === "starting") {
						record.lifecycle = "alive";
					}
				}
			} catch {
				// Whatever happened in this stretch, no TUI of this launch is running: an owned
				// backend created by it gets its exact owned termination requested now, and its
				// record stays until that backend's own settlement proves it gone.
				this.#retireOwnedCodexBackend(ownedBackend);
				if (pty) {
					// A child of this launch exists, so its staged files stay: the owned stop
					// below reaches the real exit, and that exit is what releases them.
					this.#retireNativeStatusRun(statusRun);
					// The child exists but could not be wired: keep ownership and initiate a
					// bounded graceful owned stop rather than leaving an untracked process.
					record.error = publicInstanceError("ptySetup");
					record.lifecycle = "error";
					if (!record.exitDisposable && !record.ptyExited) {
						try {
							record.exitDisposable = pty.onExit((event) => this.#onPtyExit(record, event));
						} catch {
							// Without an exit event, ownership remains held fail-closed.
						}
					}
					if (record.ptyExited) {
						this.#disposeExitListener(record);
					}
					try {
						record.dataDisposable?.dispose();
					} catch {
						// Continue toward an owned stop even if listener cleanup fails.
					}
					record.dataDisposable = undefined;
					if (record.ptyExited) {
						this.#disposeReadErrorListener(record);
					}
					this.#safeChanged(record.id);
					if (record.ptyExited) {
						this.#releaseRegistration(record);
						this.#releaseProfile(record);
					} else {
						void this.#gracefulStop(record, DEFAULT_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_KILL_MS).catch(() => {});
					}
					return;
				}
				// Failed spawn before any child exists: nothing was ever acquired. Any
				// file this launch staged has no child that could ever read it, so it goes now
				// — and the launch is marked abandoned so a provider that answers LATER has
				// its own staged files released by the same decision. An owned backend child of
				// THIS launch is outside that decision: its unsettled record keeps those files,
				// and only its own settlement releases them.
				this.#abandonNativeStatusLaunch(record, statusRun);
				this.#abandonNativeInitialPrompt(record);
				record.error = publicInstanceError("ptySetup");
				record.lifecycle = "error";
				this.#releaseRegistration(record);
				this.#releaseProfile(record);
				this.#safeChanged(record.id);
				return;
			}
			// The child exists and is fully wired: bind this run's optional status source
			// to the exact live handle and incarnation now, in the same synchronous stretch
			// as the spawn, so no observation can ever land on a row this run is not it.
			this.#activateNativeStatusRun(record, statusRun, ownedBackend);
			if (this.#records.get(record.id) === record) {
				this.#safeChanged(record.id);
			}
		} catch {
			// Pre-spawn failure or a stop-aborted launch: no child ever existed, and a
			// native row owns no registration, profile admission, startup payload, or
			// saved-session reservation, so the row simply reports the bounded error.
			// Marking this launch abandoned also covers a provider that fulfills after we
			// stopped waiting for it: its staged files are released on arrival rather than
			// stranded, and shutdown still never waits on it.
			//
			// A backend this launch already created is not covered by that decision: it is
			// asked for its exact owned termination here, and its unsettled record keeps the
			// row's resources and its liveness until that backend's own settlement arrives.
			this.#retireOwnedCodexBackend(ownedBackend);
			this.#abandonNativeStatusLaunch(record, statusRun);
			this.#abandonNativeInitialPrompt(record);
			record.error = publicInstanceError("launchPreparation");
			record.lifecycle = "error";
			this.#releaseRegistration(record);
			this.#releaseProfile(record);
			this.#safeChanged(record.id);
		} finally {
			// Every path ends this row's preparation window, so a row that has settled — as a
			// live child or as an error row — can never be "cancelled" again by a later Stop;
			// those rows are answered by the process truth they actually hold.
			record.nativeCliLaunchPending = false;
		}
	}

	/**
	 * The whole launch is guarded at every async boundary; the spawn itself
	 * (factory call through handler wiring) is one synchronous stretch, so a
	 * concurrent shutdown either saw #stopping false and the child exists, or
	 * the launch aborts before any spawn. Every failure is contained on this
	 * row with truthful state and owned-resource cleanup, and create()
	 * resolves with the row id (an error row) instead of orphaning callers.
	 */
	async #launchInstance(
			record: ManagedInstance,
			options: { workspace: string; profile?: string; savedSession?: SavedSessionAdmission; initialRequest?: { title: string; prompt: string }; nativeCliTarget?: string; createWorkspace?: boolean },
		): Promise<void> {
		const nativeBackend = isNativeCliBackend(record.backend) ? record.backend : undefined;
		if (nativeBackend !== undefined) {
			// One dispatch point, chosen from the row's own recorded backend: a native
			// CLI row never reaches the Pi setup, descriptor, registration, or framing
			// path below, and a Pi row's launch is unchanged.
			await this.#launchNativeCliInstance(record, {
				workspace: options.workspace,
				backend: nativeBackend,
				...(options.nativeCliTarget === undefined ? {} : { targetId: options.nativeCliTarget }),
				...(options.initialRequest === undefined ? {} : { initialRequest: options.initialRequest }),
				...(options.createWorkspace === true ? { createWorkspace: true } : {}),
			});
			return;
		}
		let stagedStartup: ReturnType<typeof stageSessionHostStartupRequest> | undefined;
		try {
			// 1. Setup admission. Native mode shares the fixed Pi root; legacy
			// mode is available only through explicit test injection. No tokens
			// exist yet anywhere.
			const profile = this.#profilePreparer.prepare({
				workspace: options.workspace,
				profile: options.profile === "" ? undefined : options.profile,
				// Workspace-only: the preparer never creates a profile or config directory for it.
				...(options.createWorkspace === true ? { createWorkspace: true } : {}),
			});
			record.profile = profile;
			record.agentDir = profile.agentDir;
			record.workspace = profile.workspace;
			this.#safeChanged(record.id);

			await yieldCheckpoint();
			if (this.#stopping) {
				throw new Error("shutting down; native launch preparation aborted before any token or child existed");
			}

			// 2. Native launch preparation (verbatim; the launch module owns
			// its helper responsibilities; skills publication happens here).
			// The branded saved-session receipt is revalidated by the launch
			// module against the accepted agent directory and live file identity
			// before spawn, then composed as the exact per-child --session pair.
			// This stretch through registration and spawn never yields, so a
			// file/header/root replacement landing at the checkpoint above is
			// caught by the revalidation instead of reaching the child.
			const descriptor: NativeLaunchDescriptor = prepareNativeLaunch({
				nativeSetup: this.#nativeSetup,
				packageRoot: this.#packageRoot,
				agentDir: profile.agentDir,
				workspace: profile.workspace,
				piExecutable: this.#piExecutable,
				args: options.initialRequest === undefined
					? this.#args
					: composeFreshSessionSpawnArgs(this.#args, options.initialRequest.title),
				env: this.#env,
				...(options.savedSession !== undefined ? { savedSession: options.savedSession } : {}),
				// Only an opted-in native launch asks for the supported static capture
				// flag; the descriptor is composed once, before the child exists, and the
				// manager never mutates its own or the caller's environment.
				...(this.#inputOriginFraming ? { nativeInputOriginFraming: true } : {}),
			});
			record.workspace = descriptor.cwd;

			// 3. Status registration immediately before the spawn; its JSON
			// bootstrap is injected only into a fresh env clone below, at the
			// actual PTY spawn — never during setup work above and
			// never into the caller's or user's environment.
			const registration: { current?: InstanceStatusRegistration } = {};
			const handle = this.#statusRegistrar.register(record.id, {
				onStatus: (update) => this.#onStatus(record, registration, update),
				onDisconnect: () => this.#onDisconnect(record, registration),
				onReconnect: () => this.#onReconnect(record, registration),
				onSpawnRequest: (request) => {
					if (this.#records.get(record.id) !== record || record.ptyExited || record.stopAdmissionClosed || this.#stopping || this.#disposed) {
						return Promise.resolve("failed");
					}
					return this.#onSpawnRequest?.(record.id, request) ?? Promise.resolve("failed");
				},
				// Routed support is advertised only when this host actually routes. The
				// parent proof is re-evaluated on every call: this exact record, its exact
				// current registration, a live unexited child, and no stop or shutdown.
				...(this.#onRoutedSpawnRequest === undefined ? {} : {
					onRoutedSpawnRequest: (request: SessionSpawnInput): Promise<SessionSpawnOutcome> => {
						const routed = this.#onRoutedSpawnRequest;
						const parentStillCurrent = this.#parentRegistrationProof(record, registration);
						if (routed === undefined || !parentStillCurrent()) return Promise.resolve("failed");
						return routed(record.id, request, parentStillCurrent);
					},
					// Declared only when this host's routed handler really honors it.
					...(this.#routedSpawnCreateWorkspace ? { routedSpawnCreateWorkspace: true } : {}),
				}),
				// Read-only discovery is forwarded only beside routed spawn, with the SAME
				// per-call parent proof. A parent that is no longer current is an
				// unavailable inspection (a rejection), never an empty listing.
				...(this.#onRoutedSpawnRequest === undefined || this.#onSessionHostsRequest === undefined ? {} : {
					onSessionHostsRequest: (context: SessionHostsRequestContext): Promise<SessionHostsSnapshot> => {
						const inspect = this.#onSessionHostsRequest;
						const parentStillCurrent = this.#parentRegistrationProof(record, registration);
						if (inspect === undefined || !parentStillCurrent()) {
							return Promise.reject(new Error("session-host: the requesting session is no longer current"));
						}
						return inspect(record.id, context, parentStillCurrent);
					},
				}),
			}, this.#inputOriginFraming ? { inputOriginFraming: true } : undefined);
			registration.current = handle;
			record.registration = handle;
			record.registrationReleased = false;
			// An opted-in row frames only against a bootstrap that ACTUALLY carries
			// the closed mode, composed before the child exists. A registrar that
			// ignored the request fails this launch closed (no child, no raw bytes)
			// instead of typing framed headers into a legacy Pi. The encoder is
			// created once here, from this registration's own bootstrap, and is
			// never rebuilt or reset for this registration.
			if (this.#inputOriginFraming) {
				if (handle.bootstrap.inputOriginFraming !== 1) {
					throw new Error("session-host: the status registrar did not record the requested native input framing mode");
				}
				record.inputFramingRequested = true;
				record.inputEncoder = createNativeInputEncoder(handle.bootstrap);
				// The startup phase can begin only on this correctly framed
				// registration; readiness, liveness, and every other fact are still
				// required separately before any startup input is admitted.
				record.startupInputOpen = true;
			}
			// The native clipboard receiver (#466) exists only after this row's own
			// registration actually exists, is built from that registration's own
			// bootstrap, and is bound to this exact row/registration pair. A row
			// never receives another row's receiver or capsule.
			const nativeClipboardCapsule = this.#nativeClipboardCapsuleHandler(record, handle);

			// 4. Synchronous spawn stretch: nothing yields until handlers and
			// the terminal surface are attached, so ownership is recorded
			// before any child callback can fire.
			let pty: InstancePty | undefined;
			try {
				const spawnEnv = { ...descriptor.env };
				const titleColumns = this.#sidebarTitleColumnsSnapshot();
				if (titleColumns !== undefined) spawnEnv[SESSION_HOST_TITLE_COLUMNS_ENV] = String(titleColumns);
				if (options.initialRequest !== undefined) {
					const payloadDir = handle.bootstrap.payloadDir;
					if (typeof payloadDir !== "string" || payloadDir.length === 0) {
						// No host-owned namespace: fail closed before any child exists
						// instead of falling back to an inline prompt handoff.
						throw new Error("session-host: startup payload namespace unavailable");
					}
					// The exact JSON text lives only in the registration's private
					// namespace; the one-shot env carries only its bounded reference.
					stagedStartup = stageSessionHostStartupRequest(payloadDir, options.initialRequest);
					record.startupPayload = stagedStartup;
					spawnEnv[SESSION_HOST_STARTUP_REQUEST_ENV] = JSON.stringify(stagedStartup.descriptor);
				}
				spawnEnv[SESSION_HOST_BOOTSTRAP_ENV] = JSON.stringify(handle.bootstrap);
				pty = this.#ptyFactory({
					file: descriptor.file,
					args: descriptor.args,
					env: spawnEnv,
					cwd: descriptor.cwd,
					cols: record.cols,
					rows: record.rows,
				});
				record.pty = pty;
				// #666: record this row's owned-reader settlement for the disposal-time
				// confirmation; the release itself is triggered by the handle's own exit.
				// Settled readers are already history, so they are dropped here instead of
				// retaining a finished handle graph for the manager's whole lifetime.
				for (const settled of this.#ownedConptyReaders) {
					if (settled.settled) this.#ownedConptyReaders.delete(settled);
				}
				const ownedReader = ownedConptyReaderRecord(pty);
				if (ownedReader !== undefined) this.#ownedConptyReaders.add(ownedReader.settlement);
				record.exitDisposable = pty.onExit((event) => this.#onPtyExit(record, event));
				if (record.ptyExited) {
					this.#disposeExitListener(record);
					if (this.#records.get(record.id) !== record) {
						// An exit observer may synchronously close the row while
						// onExit() is registering its listener. Do not allocate a
						// surface or any other resources for a detached record.
						return;
					}
				}
				record.surface = new TerminalSurface(record.cols, record.rows, {
					onReply: (data) => this.#onQueryReply(record, handle, data),
					onChange: () => this.#safeChanged(record.id),
					onBackpressure: (paused) => this.#onBackpressure(record, paused),
					onDiagnostic: (event) => this.#safeTerminalDiagnostic(record.id, event),
					onNativeClipboardCapsule: nativeClipboardCapsule,
					getSupportedKeyboardFlags: this.#getSupportedKeyboardFlags,
					graphicsBudget: this.#graphicsBudget,
				});
				if (!record.ptyExited) {
					record.readErrorDisposable = subscribePtyReadErrors(pty, () => this.#onPtyReadError(record));
					if (record.ptyExited) {
						this.#disposeReadErrorListener(record);
					}
				}
				if (!record.ptyExited) {
					record.dataDisposable = pty.onData((data) => this.#onPtyData(record, data));
					if (record.ptyExited) {
						// An injected/fake event source may emit synchronously while
						// listener registration is returning; dispose the now-known
						// handle and never revive its row.
						this.#disposeDataListener(record);
					} else if (record.lifecycle === "starting") {
						record.lifecycle = "alive";
					}
				}
			} catch {
				if (pty) {
					// The child exists but could not be wired: keep ownership and
					// initiate a bounded graceful owned stop rather than leaving
					// an untracked running process behind an error row.
					record.error = publicInstanceError("ptySetup");
					record.lifecycle = "error";
					if (!record.exitDisposable && !record.ptyExited) {
						try {
							record.exitDisposable = pty.onExit((event) => this.#onPtyExit(record, event));
						} catch {
							// Without an exit event, ownership remains held fail-closed.
						}
					}
					if (record.ptyExited) {
						this.#disposeExitListener(record);
					}
					try {
						record.dataDisposable?.dispose();
					} catch {
						// Continue toward an owned stop even if listener cleanup fails.
					}
					record.dataDisposable = undefined;
					if (record.ptyExited) {
						this.#disposeReadErrorListener(record);
					}
					this.#safeChanged(record.id);
					if (record.ptyExited) {
						this.#releaseRegistration(record);
						this.#releaseProfile(record);
					} else {
						void this.#gracefulStop(record, DEFAULT_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_KILL_MS).catch(() => {});
					}
					return;
				}
				// Failed spawn before any child exists: release everything,
				// including the saved-session reservation (no child ever existed).
				record.error = publicInstanceError("ptySetup");
				record.lifecycle = "error";
				stagedStartup?.discard();
				this.#releaseRegistration(record);
				this.#releaseProfile(record);
				record.savedReservation = undefined;
				this.#safeChanged(record.id);
				return;
			}
			if (this.#records.get(record.id) === record) {
				this.#safeChanged(record.id);
			}
		} catch {
			// Pre-spawn failure or a stop-aborted launch: release everything
			// acquired so far; no child ever existed to wait for, so the
			// saved-session reservation (if any) is released with it.
			record.error = publicInstanceError("launchPreparation");
			record.lifecycle = "error";
			if (record.pty === undefined) stagedStartup?.discard();
			this.#releaseRegistration(record);
			this.#releaseProfile(record);
			record.savedReservation = undefined;
			this.#safeChanged(record.id);
		}
	}

	#onPtyData(record: ManagedInstance, data: string): void {
		if (this.#disposed) {
			return; // the parse pipeline is closed by design after dispose
		}
		if (this.#records.get(record.id) !== record || record.ptyExited) {
			return; // stale: unknown/disposed/already-exited child
		}
		const surface = record.surface;
		if (!surface) {
			return;
		}
		try {
			surface.write(data);
		} catch {
			// Parser/queue failure is fatal for this row only: contained,
			// truthful, and its owned child gets a graceful stop; siblings
			// are untouched and ownership is never silently lost.
			this.#failRunningInstance(record, "outputParsing");
		}
	}

	#onPtyReadError(record: ManagedInstance): void {
		if (this.#records.get(record.id) !== record || record.ptyExited) {
			return;
		}
		// Never expose the native error object: it may contain process, path,
		// environment, or other upstream details. The owned row gets one safe
		// operation-specific diagnostic and an owned graceful stop.
		this.#failRunningInstance(record, "ptyRead");
	}

	#onQueryReply(record: ManagedInstance, registration: InstanceStatusRegistration | undefined, data: string): void {
		if (this.#records.get(record.id) !== record || this.#disposed) {
			return;
		}
		const pty = record.pty;
		if (!pty || record.ptyExited) {
			return;
		}
		try {
			// Discard only a never-sent automatic reply for an otherwise-admissible
			// framing child awaiting its OWN readiness. Read only manager-owned facts:
			// no callback may reenter between these fences and the discard. The mode
			// and encoder were fixed from this exact registration before spawn.
			if (!this.#disposed && !this.#stopping
				&& this.#records.get(record.id) === record
				&& record.registration === registration && !record.registrationReleased
				&& record.pty === pty && !record.ptyExited
				&& !record.stopAdmissionClosed && record.lifecycle === "alive"
				&& record.inputFramingRequested && record.inputEncoder !== undefined
				&& !record.inputFramingReady) {
				return; // No write, encoding, queue, or replay when readiness arrives.
			}
			// TerminalSurface replies (DA/DSR/kitty) are host protocol, never user
			// input, so future replies after readiness carry the closed `none`
			// origin and can never authorize a copy. All other refusals and genuine
			// encoding/write failures keep the existing owned-row failure path.
			this.#writeChildInput(record, pty, data, PROTOCOL_INPUT_ORIGIN);
		} catch {
			this.#failRunningInstance(record, "queryReply");
		}
	}

	#onBackpressure(record: ManagedInstance, paused: boolean): void {
		if (this.#disposed || this.#records.get(record.id) !== record || record.ptyExited) {
			return;
		}
		const pty = record.pty;
		if (!pty) {
			return;
		}
		try {
			if (paused) {
				pty.pause();
			} else {
				pty.resume();
			}
		} catch {
			// TerminalSurface has already committed its pause state. If native
			// flow control failed, fail this owner closed instead of leaving a
			// permanently paused child behind an apparently healthy row.
			this.#failRunningInstance(record, paused ? "ptyPause" : "ptyResume");
		}
	}

	#onPtyExit(record: ManagedInstance, event: { exitCode: number; signal?: number }): void {
		if (this.#records.get(record.id) !== record || record.ptyExited) {
			return; // stale or already-final exit
		}
		record.ptyExited = true;
		// This process incarnation is over. Its private scope key goes with it, so no
		// source minted for it can be re-proven even by a caller holding every public
		// fact unchanged.
		record.nativeCliIncarnation = undefined;
		// The OPTIONAL native status source of this run goes with the process it observed:
		// its broker callbacks are released, its capture generation is retired, and its
		// observer is disposed. Its staged private files are released further below, because
		// THIS genuine exit — not this bookkeeping — is what makes that cleanup safe.
		const statusRun = record.nativeStatusRun;
		this.#retireNativeStatusRun(statusRun);
		// The TUI client is gone, so nothing will talk to this row's owned backend again:
		// its exact owned termination is requested now. This exit is NOT that backend's
		// proof — the unsettled record keeps the row live, keeps it unremovable, and keeps
		// its staged files until the lease itself settles.
		this.#retireOwnedCodexBackend(record.nativeCodexBackend);
		// The routing convention belonged to that process incarnation and goes with it:
		// a replacement child starts with no known recipient at all.
		record.nativeCliController = undefined;
		// The process incarnation is over, so its startup phase is over for good.
		this.#closeStartupInput(record, false);
		// A finished child displays nothing: every surface's participation in this
		// row ends here, and its retained last frame stays readable until removal.
		this.#retireViewerTargets(record.id);
		record.busy = null;
		record.pendingInput = null;
		record.inputSurface = false;
		record.backgroundTasks = null;
		record.backgroundShells = null;
		record.activeTasks = null;
		record.activeShells = null;
		record.activityRefreshAttempts = 0;
		record.activityRefreshEpisodeOpen = false;
		record.activity = [];
		if (typeof event?.exitCode === "number" && Number.isFinite(event.exitCode)) {
			record.exitCode = event.exitCode;
		}
		if (record.lifecycle === "starting" || record.lifecycle === "alive") {
			record.lifecycle = "exited";
		}
		// A known exit is the only condition (besides a failed spawn before
		// any child exists) under which the admission — and the saved-session
		// reservation — is released; an exited row never blocks reopening.
		this.#releaseRegistration(record);
		this.#disposeDataListener(record);
		this.#disposeExitListener(record);
		this.#disposeReadErrorListener(record);
		this.#releaseProfile(record);
		// The exact child that was told to read this run's staged private files is now
		// known to have exited, so they may be released — still only once a required owned
		// reader has positively settled, and never under an unsettled one.
		this.#releaseNativeStatusArtifacts(record, statusRun);
		this.#releaseNativeInitialPrompt(record);
		record.savedReservation = undefined;
		this.#resolveExitWaiters(record);
		this.#safeChanged(record.id);
		// Flush the queued child bytes so the retained last frame is the
		// complete final one before the row freezes.
		const surface = record.surface;
		if (this.#disposed) {
			try {
				surface?.dispose();
			} catch {
				// A late exit after manager disposal still completes per-row cleanup.
			}
			record.surface = undefined;
			return;
		}
		void (async () => {
			try {
				await surface?.flush();
			} catch {
				// Contained: the freeze outcome does not depend on this flush.
			}
			if (this.#records.get(record.id) === record) {
				this.#safeChanged(record.id);
			}
		})();
	}

	#onStatus(
		record: ManagedInstance,
		registration: { current?: InstanceStatusRegistration },
		update: InstanceStatusUpdate,
	): void {
		if (!this.#currentRegistration(record, registration)) {
			return; // stale/released/disposed status event, never cross-row
		}
		// The first ACCEPTED status of this registration (even one reporting a null
		// tuple) ends its startup phase for good; the change published below is the
		// boundary that retires a stated startup source.
		this.#closeStartupInput(record, false);
		record.statusRevision += 1;
		const previousKnownSessionId = record.knownNativeSessionId;
		record.busy = update && typeof update.busy === "boolean" ? update.busy : null;
		record.pendingInput = update && typeof update.pendingInput === "boolean" ? update.pendingInput : null;
		record.inputSurface = update?.inputSurface === true;
		record.backgroundTasks = normalizedOwnedCount(update?.backgroundTasks);
		record.backgroundShells = normalizedOwnedCount(update?.backgroundShells);
		record.activeTasks = normalizedOwnedCount(update?.activeTasks);
		record.activeShells = normalizedOwnedCount(update?.activeShells);
		record.activity = boundedActivity(update?.activity);
		if (Object.prototype.hasOwnProperty.call(update ?? {}, "nativeSession")) {
			const next = validatedNativeSession(update?.nativeSession);
			const previous = record.lastNativeSession ?? record.nativeSession;
			if (next === null) {
				record.nativeSession = null;
				record.currentNativeSessionFile = undefined;
				record.label = "(session name unavailable)";
			} else if (next !== undefined) {
				const { currentFile, ...nextSession } = next;
				if (previous && (nextSession.epoch < previous.epoch
					|| (nextSession.sessionId !== previous.sessionId && nextSession.epoch <= previous.epoch))) {
					record.nativeSession = null;
					record.currentNativeSessionFile = undefined;
					record.label = "(session name unavailable)";
				} else {
					// Never forget positive saved evidence for the SAME current binding.
					if (previous?.sessionId === nextSession.sessionId && previous.persistence === "saved") nextSession.persistence = "saved";
					record.nativeSession = nextSession;
					record.lastNativeSession = { ...nextSession };
					record.currentNativeSessionFile = currentFile;
					record.label = nextSession.name;
					// Private duplicate-fencing binding: the CURRENT observed
					// conversation replaces any older one (native /new or
					// /resume) and is retained across later disconnects.
					record.knownNativeSessionId = nextSession.sessionId;
					// A valid newer binding that supersedes the initial saved
					// conversation releases its reservation: this row no longer
					// represents that saved file, so the conversation can be
					// opened again while the new binding stays fenced. Pending
					// (unobserved) reservations are untouched.
					if (record.savedReservation !== undefined
						&& record.savedReservation.sessionId !== nextSession.sessionId) {
						record.savedReservation = undefined;
					}
				}
			} else {
				record.nativeSession = null;
				record.currentNativeSessionFile = undefined;
				record.label = "(session name unavailable)";
			}
		} else {
			// An older reporter cannot refresh current-file authority. Keep prior
			// display/duplicate metadata, but revoke its path observation.
			record.currentNativeSessionFile = undefined;
		}
		if (record.knownNativeSessionId !== previousKnownSessionId) {
			// A native /new or /resume is a new observation episode, not a
			// continuation of an exhausted unknown budget.
			record.activityRefreshAttempts = 0;
			record.activityRefreshEpisodeOpen = false;
		}
		this.#noteActivityObservation(record);
		this.#safeChanged(record.id);
		this.#maybeRequestFreshActivity(record, registration);
	}

	/**
	 * Reset the bounded automatic refresh budget when the ephemeral row state
	 * becomes fully known, and open a fresh episode on a new unknown state.
	 */
	#noteActivityObservation(record: ManagedInstance): void {
		const known = record.busy !== null
			&& record.activeTasks !== null && record.activeShells !== null;
		if (known) {
			record.activityRefreshAttempts = 0;
			record.activityRefreshEpisodeOpen = false;
		}
	}

	/**
	 * Host-side independent recovery: a relevant unknown/lost ephemeral state
	 * asks the exact owning live client for one complete freshly observed
	 * status. Requests are coalesced by the registration/broker and bounded to
	 * MAX_ACTIVITY_REFRESH_ATTEMPTS per unknown episode; there is no timer or
	 * polling. A known observation or a reconnect starts a new episode.
	 */
	#maybeRequestFreshActivity(
		record: ManagedInstance,
		registration: { current?: InstanceStatusRegistration },
	): void {
		if (!this.#currentRegistration(record, registration) || record.ptyExited) return;
		const unknown = record.busy === null
			|| record.activeTasks === null || record.activeShells === null;
		if (!unknown) return;
		if (!record.activityRefreshEpisodeOpen) {
			record.activityRefreshEpisodeOpen = true;
			record.activityRefreshAttempts = 0;
		}
		if (record.activityRefreshAttempts >= MAX_ACTIVITY_REFRESH_ATTEMPTS) return;
		const registrationHandle = record.registration;
		const requestActivity = registrationHandle?.requestActivity;
		if (typeof requestActivity !== "function") return;
		record.activityRefreshAttempts += 1;
		const revision = record.statusRevision;
		void Promise.resolve().then(() => requestActivity.call(registrationHandle)).then(
			(result) => this.#applyActivityRefreshFailure(record, registration, revision, result, true),
			() => this.#applyActivityRefreshFailure(record, registration, revision, undefined, true),
		);
	}

	/**
	 * A read that could not produce a complete fresh snapshot leaves the
	 * ephemeral row state truthfully unknown. It never preserves a stale known
	 * value and never fabricates zero. A stale reply means a newer accepted
	 * status already replaced it, so nothing is changed.
	 */
	#applyActivityRefreshFailure(
		record: ManagedInstance,
		registration: { current?: InstanceStatusRegistration },
		revision: number,
		result: StatusActivityRefreshResult | undefined,
		retryEligible: boolean,
	): void {
		if (!this.#currentRegistration(record, registration)) return;
		// A newer accepted status (including one that arrived while this
		// read-only request was in flight or after it timed out) always wins
		// over an older request's failure. Only the exact observation that
		// motivated this request may be cleared to unknown.
		if (record.statusRevision !== revision) return;
		if (result?.status !== "unavailable" && result?.status !== "timeout" && result?.status !== "disconnected") return;
		record.busy = null;
		record.backgroundTasks = null;
		record.backgroundShells = null;
		record.activeTasks = null;
		record.activeShells = null;
		record.activity = [];
		this.#safeChanged(record.id);
		// A dropped/timed-out automatic reply is a bounded recovery event: retry
		// within the same per-episode attempt budget instead of waiting for a
		// lifecycle transition that may never come. Unsupported peers, stale
		// replies, complete results, and disconnected transports are never
		// retried through this path; a reconnect starts a fresh episode.
		if (retryEligible && (result?.status === "unavailable" || result?.status === "timeout")) {
			this.#maybeRequestFreshActivity(record, registration);
		}
	}

	/** A valid reconnect is a new episode: discard the exhausted budget and request once. */
	/**
	 * The per-call proof that one reporter request still comes from this exact
	 * parent: this record, its exact current registration, a live unexited child,
	 * and no stop or shutdown. Re-evaluated on every call, never cached.
	 */
	#parentRegistrationProof(
		record: ManagedInstance,
		registration: { current?: InstanceStatusRegistration },
	): () => boolean {
		return (): boolean => this.#records.get(record.id) === record
			&& registration.current !== undefined && record.registration === registration.current
			&& record.pty !== undefined && !record.ptyExited && !record.stopAdmissionClosed
			&& !this.#stopping && !this.#disposed;
	}

	#onReconnect(record: ManagedInstance, registration: { current?: InstanceStatusRegistration }): void {
		if (!this.#currentRegistration(record, registration) || record.ptyExited) return;
		// A reconnect means the child's reporter already installed a session, so the
		// startup phase is over; it never reopens.
		this.#closeStartupInput(record, false);
		// Independently discard cached ephemeral row understanding on transport
		// replacement: the live client is reachable but its prior observation
		// may be stale. This is truthfully unknown, never a fabricated zero, and
		// durable identities/ownership are untouched.
		record.busy = null;
		record.pendingInput = null;
		record.inputSurface = false;
		record.backgroundTasks = null;
		record.backgroundShells = null;
		record.activeTasks = null;
		record.activeShells = null;
		record.activity = [];
		record.statusRevision += 1;
		this.#safeChanged(record.id);
		record.activityRefreshAttempts = 0;
		record.activityRefreshEpisodeOpen = true;
		this.#maybeRequestFreshActivity(record, registration);
	}

	#onDisconnect(record: ManagedInstance, registration: { current?: InstanceStatusRegistration }): void {
		if (!this.#currentRegistration(record, registration)) {
			return; // stale/released/disposed disconnect event
		}
		this.#closeStartupInput(record, false);
		// Truthful process telemetry: the reporter is gone, the child may very
		// well still run. Never an exit, never an inferred "Idle" state; busy
		// and pending input collapse to null until a fresh reporter reports.
		record.busy = null;
		record.pendingInput = null;
		record.inputSurface = false;
		record.backgroundTasks = null;
		record.backgroundShells = null;
		record.activeTasks = null;
		record.activeShells = null;
		record.activityRefreshAttempts = 0;
		record.activityRefreshEpisodeOpen = false;
		record.activity = [];
		record.nativeSession = null;
		record.currentNativeSessionFile = undefined;
		record.label = "(session name unavailable)";
		this.#safeChanged(record.id);
	}

	/** Guard: the record is live and the event belongs to its active registration. */
	#currentRegistration(record: ManagedInstance, registration: { current?: InstanceStatusRegistration }): boolean {
		return this.#records.get(record.id) === record
			&& !this.#disposed
			&& record.registration !== undefined
			&& registration.current === record.registration
			&& !record.registrationReleased;
	}

	#failRunningInstance(record: ManagedInstance, errorCode: InstanceErrorCode): void {
		if (this.#records.get(record.id) !== record) {
			return;
		}
		if (record.ptyExited) {
			// Already-final exit: keep the truthful exited row.
			return;
		}
		record.error = publicInstanceError(errorCode);
		record.lifecycle = "error";
		if (record.pty && !this.#stopping) {
			// A fatal display error while the PTY is alive must not leave an
			// untracked running process behind an error row: initiate a
			// bounded, owned graceful stop.
			void this.#gracefulStop(record, DEFAULT_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_KILL_MS).catch(() => {});
		}
		this.#safeChanged(record.id);
	}

	#releaseRegistration(record: ManagedInstance): void {
		// A released (or never-completed) registration has no startup phase left.
		this.#closeStartupInput(record, false);
		// The child may have exited before consuming its initial request. Ownership
		// is discarded through the exact staged inode before the broker removes
		// its empty namespace; a foreign replacement is preserved.
		const startupPayload = record.startupPayload;
		record.startupPayload = undefined;
		startupPayload?.discard();
		if (record.registrationReleased) {
			return;
		}
		// Mark released before calling external code: release may synchronously
		// report a disconnect, which must already be stale at this point.
		record.registrationReleased = true;
		try {
			record.registration?.release();
		} catch {
			// The attempt is recorded but not confirmed; no-child removal stays
			// fail closed and never retries the external release.
			return;
		}
		// Positively settled: either there was no registration owned yet, or the
		// external release returned. Only this authorizes no-child removal.
		record.registrationReleaseSettled = true;
	}

	#disposeDataListener(record: ManagedInstance): void {
		try {
			record.dataDisposable?.dispose();
		} catch {
			// Listener disposal is best-effort during per-instance cleanup.
		}
		record.dataDisposable = undefined;
	}

	#disposeExitListener(record: ManagedInstance): void {
		try {
			record.exitDisposable?.dispose();
		} catch {
			// Listener disposal is best-effort once the child is known exited.
		}
		record.exitDisposable = undefined;
	}

	#disposeReadErrorListener(record: ManagedInstance): void {
		try {
			record.readErrorDisposable?.dispose();
		} catch {
			// The owned child exit remains the source of truth if disposal fails.
		}
		record.readErrorDisposable = undefined;
	}

	#releaseProfile(record: ManagedInstance): void {
		if (record.profileReleased) {
			return;
		}
		record.profileReleased = true;
		// A throwing admission release keeps the confirmed flag false (the
		// caller's existing propagation semantics are preserved); a later
		// idempotent call cannot silently claim success for it.
		record.profile?.release();
		record.profileReleaseSettled = true;
	}

	#resolveExitWaiters(record: ManagedInstance): void {
		const waiters = record.exitWaiters.splice(0);
		for (const waiter of waiters) {
			waiter();
		}
	}

	#waitForExit(record: ManagedInstance, ms: number): Promise<boolean> {
		if (record.ptyExited) {
			return Promise.resolve(true);
		}
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				const index = record.exitWaiters.indexOf(waiter);
				if (index >= 0) {
					record.exitWaiters.splice(index, 1);
				}
				resolve(false);
			}, ms);
			const waiter = () => {
				clearTimeout(timer);
				resolve(true);
			};
			record.exitWaiters.push(waiter);
		});
	}

	/**
	 * Owned graceful stop of one child: ask the active authenticated public
	 * status registration to request native shutdown, bounded by the same grace
	 * deadline as the owned PTY exit wait. On POSIX, unavailable or failed
	 * control falls back to SIGTERM; Windows never treats a PTY signal as
	 * graceful and forces only through the owned handle's no-argument kill().
	 * Forced escalation remains bounded and owned-handle-only.
	 * Releases happen only in the exit handler (confirmed exit) — this routine
	 * never frees an admission for a child that never settled.
	 */
	#gracefulStop(record: ManagedInstance, graceMs: number, killMs: number, alreadyRequested = false): Promise<boolean> {
		const pty = record.pty;
		const hasPty = pty !== undefined && !record.ptyExited;
		const backend = record.nativeCodexBackend;
		const hasBackend = backend !== undefined && !backend.settled;
		if (!hasPty && !hasBackend) {
			return Promise.resolve(true);
		}
		if (record.stopPromise) {
			return record.stopPromise;
		}
		if (hasPty && pty !== undefined) {
			// #666: this ladder's forced escalation is one of the paths that can end the
			// child and so trigger the owned reader's release. That release must fit
			// inside this same stop budget: the cap is shortening-only, so a natural exit
			// well inside the window keeps its existing confirmation time, while a late
			// exit after an exhausted ladder can never renew time this stop already spent.
			ownedConptyReaderRecord(pty)?.settlement.limitConfirmationDeadline(Date.now() + graceMs + killMs);
		}
		// This row has begun its owned stop ladder, so its OPTIONAL native status source
		// is retired now: its callbacks stop immediately rather than reporting for a child
		// that is on its way out. Its staged private files are NOT released here — a child
		// that is stopping has not settled, and only its actual exit (or a required
		// reader's positive settlement) may say otherwise.
		this.#retireNativeStatusRun(record.nativeStatusRun);
		// The same stop reaches a second owned process: an owned backend of this row is
		// asked for its exact owned termination alongside the PTY ladder, and its record
		// stays unsettled — and this row stays live — until that backend settles itself.
		this.#retireOwnedCodexBackend(backend);
		// That request then gets its own settlement window INSIDE this same stop budget,
		// observed in parallel with the PTY ladder below so it never lengthens the stop.
		const backendSettled = this.#awaitOwnedCodexBackendSettled(backend, graceMs + killMs);
		const stopPromise = this.#runOwnedStop(record, hasPty ? pty : undefined, graceMs, killMs, alreadyRequested, backendSettled);
		record.stopPromise = stopPromise;
		return stopPromise;
	}

	/**
	 * One row's complete owned stop: its PTY ladder and its owned backend's settlement
	 * window, both bounded, both required. The result is this row's honest answer — true
	 * only when every process this row owns positively settled — and a false here never
	 * releases ownership: the unsettled record, its barriers, and its private files stay.
	 */
	async #runOwnedStop(
		record: ManagedInstance,
		pty: InstancePty | undefined,
		graceMs: number,
		killMs: number,
		alreadyRequested: boolean,
		backendSettled: Promise<boolean>,
	): Promise<boolean> {
		const ptySettled = pty === undefined
			? true
			: await this.#runGracefulStop(record, pty, graceMs, killMs, alreadyRequested);
		return ptySettled && await backendSettled;
	}

	/**
	 * Bounded observation of one owned backend's OWN settlement, as part of a stop.
	 *
	 * Retirement asks for the exact owned termination; this gives that request a window
	 * inside the stop budget that already exists, so a backend that does exit is honestly
	 * reported as settled, while one whose child or readers never finish is reported as
	 * remaining — with this manager still owning it, still refusing removal, and still
	 * keeping its files. Nothing here ever claims a settlement a timeout produced.
	 */
	async #awaitOwnedCodexBackendSettled(
		resource: OwnedNativeCodexBackendResource | undefined,
		budgetMs: number,
	): Promise<boolean> {
		if (resource === undefined || resource.settled) {
			return true;
		}
		let timer: NodeJS.Timeout | undefined;
		const window = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), budgetMs);
		});
		await Promise.race([
			// Settlement is already observed for its own sake; this second, bounded view of
			// the same promise exists only so a stop can report the truth it produced.
			Promise.resolve(resource.lease.settlement).then(() => undefined, () => undefined),
			window,
		]);
		if (timer) clearTimeout(timer);
		return resource.settled;
	}

	async #runGracefulStop(record: ManagedInstance, pty: InstancePty, graceMs: number, killMs: number, alreadyRequested = false): Promise<boolean> {
		// Register the actual-exit waiter before making any public request: a
		// synchronous PTY exit inside shutdown() must win over its acknowledgement.
		const graceExit = this.#waitForExit(record, graceMs);
		const registration = record.registration;
		let requestShutdown: InstanceStatusRegistration["shutdown"] = undefined;
		try {
			if (registration && !record.registrationReleased) {
				requestShutdown = registration.shutdown;
			}
		} catch {
			// A broken optional adapter is equivalent to unavailable control.
		}

		let requested = alreadyRequested;
		if (!alreadyRequested && registration && requestShutdown) {
			let requestTimer: NodeJS.Timeout | undefined;
			const requestTimeout = this.#shutdownPlatform === "win32" ? undefined : new Promise<{ kind: "request-timeout" }>((resolve) => {
				// Reserve half of the single grace window for POSIX SIGTERM to
				// produce an exit. A hung public request must not postpone its
				// fallback until immediately before forced SIGKILL.
				requestTimer = setTimeout(() => resolve({ kind: "request-timeout" }), Math.floor(graceMs / 2));
			});
			let request: Promise<boolean>;
			try {
				// Attach both fulfillment and rejection handlers immediately. A
				// hung or late public response can never outlive the grace wait as
				// an unhandled rejection or change owned-process truth.
				request = Promise.resolve(requestShutdown.call(registration)).then(
					(result) => validShutdownRequest(result),
					() => false,
				);
			} catch {
				request = Promise.resolve(false);
			}
			const first = await Promise.race([
				request.then((accepted) => ({ kind: "request" as const, accepted })),
				graceExit.then((exited) => ({ kind: "exit" as const, exited })),
				...(requestTimeout ? [requestTimeout] : []),
			]);
			if (requestTimer) clearTimeout(requestTimer);
			if (first.kind === "exit" && first.exited) {
				return true;
			}
			if (first.kind === "request") {
				requested = first.accepted;
			}
		}
		if (record.ptyExited) {
			return true;
		}

		// `requested` acknowledges only the public native request. It never
		// substitutes for the owned PTY's actual exit event.
		if (!requested && this.#shutdownPlatform !== "win32") {
			record.sigtermSent = true;
			try {
				pty.kill("SIGTERM");
			} catch {
				// Contained: the escalation still runs against the owned handle.
			}
			if (record.ptyExited) {
				return true;
			}
		}

		// This is the remainder of the original grace window, not a second
		// post-request grace period. On Windows-like injected policy, no PTY
		// signal is sent until the forced owned-handle escalation below.
		const settled = await graceExit;
		if (settled || record.ptyExited) {
			return true;
		}
		// Record the force attempt before invoking a native API that may throw or
		// partially complete; it is never evidence that the PTY actually exited.
		record.sigkillSent = true;
		try {
			// Public node-pty's Windows signal argument is unsupported; its
			// no-argument kill is the forced owned-handle operation there.
			if (this.#shutdownPlatform === "win32") {
				pty.kill();
			} else {
				pty.kill("SIGKILL");
			}
		} catch {
			// Contained: truthfully reported below if the child never settles.
		}
		return this.#waitForExit(record, killMs);
	}

	/** Bounded stopping pass over owned children, sharing any existing stop ladder. */
	async #stopOwnedProcesses(graceMs: number, killMs: number): Promise<ShutdownResult> {
		const ownsWork = (record: ManagedInstance): boolean =>
			(record.pty !== undefined && !record.ptyExited) || ownsUnsettledCodexBackend(record);
		const targets = [...this.#records.values()].filter(ownsWork);
		const outcomes = await Promise.all(targets.map(async (record) => {
			await this.#gracefulStop(record, graceMs, killMs);
			return { id: record.id, forced: ownedForceEscalationAttempted(record) };
		}));
		// Escalation is historical, but remaining is current truth after every
		// targeted ladder has completed: a late confirmed exit is not remaining. A row
		// counts as remaining while EITHER process it owns is unsettled, because an owned
		// backend whose child or readers never finished is a live process this manager
		// still owns even when its row's TUI already exited.
		// An owned backend's force attempt is historical too, so a retained row whose own
		// settled backend was force-escalated earlier is still reported, even though it is
		// no longer a stop target. Reporting only: targets and remaining are unchanged.
		const forcedIds = outcomes.filter((outcome) => outcome.forced).map((outcome) => outcome.id);
		for (const record of this.#records.values()) {
			if (!forcedIds.includes(record.id) && ownedCodexBackendForceEscalationAttempted(record.nativeCodexBackend)) {
				forcedIds.push(record.id);
			}
		}
		return {
			forcedIds,
			remainingIds: [...this.#records.values()].filter(ownsWork).map((record) => record.id),
		};
	}

	/**
	 * Build this row's capsule handler from this row's own registration
	 * bootstrap (#466). Absent a host callback AND absent input framing no
	 * receiver exists at all, so a row keeps its previous behavior of swallowing
	 * the capsule OSC entirely.
	 *
	 * A framing row always has a receiver, because its readiness signal and its
	 * v2 copy receipts both arrive on this same ordered stdout stream. Readiness
	 * is independent of the native conversation tuple (it can and must be
	 * observed before any session metadata exists), while copy callbacks keep the
	 * unchanged tuple/live-record fences. A strict row delivers a typed v2 `local`
	 * receipt on the owner's local route only: its own strict bridge emits v2
	 * capsules only, so an authenticated v1 capsule on such a row is NOT a
	 * downgrade path and is dropped (its sequence is still consumed, so the same
	 * authenticated request can never be replayed as v2). A viewer-origin capsule is
	 * routed ONLY to the viewer its token names, and only after that viewer's current
	 * facts re-commit to exactly that token; anything else about it is dropped
	 * quietly — no owner-terminal fallback, no local delivery, no sibling viewer, no
	 * broadcast, and no copy diagnostic — and it is never downgraded to a v1 event.
	 * Legacy rows observe neither v2 nor readiness at all and keep the v1 route
	 * exactly as before.
	 */
	#nativeClipboardCapsuleHandler(
		record: ManagedInstance,
		registration: InstanceStatusRegistration,
	): ((capsule: string) => void) | undefined {
		const framing = record.inputFramingRequested;
		if (this.#onNativeClipboard === undefined && !framing) {
			return undefined;
		}
		let receiver: (capsule: string) => void;
		try {
			const onCopyEvent = (event: NativeClipboardEvent): void => {
				this.#forwardNativeClipboard(record, registration, event);
			};
			receiver = framing
				? createNativeClipboardReceiver(
					registration.bootstrap,
					// Strict mode has no v1 local route: this child's own bridge emits v2
					// capsules only, so an authenticated v1 capsule is a shape this row must
					// never deliver locally. It is consumed (sequence-consuming inside the
					// receiver, so it cannot be replayed) and otherwise dropped.
					() => undefined,
					(receipt) => {
						if (receipt.origin.kind === "local") {
							onCopyEvent(receipt.event);
							return;
						}
						// A viewer-origin copy belongs to the one viewer whose input caused it,
						// and to nobody else: never the owner's local clipboard route, never a
						// sibling viewer, never a broadcast, and never a diagnostic.
						this.#forwardViewerNativeClipboard(record, registration, receipt);
					},
					() => this.#markInputFramingReady(record, registration),
				)
				: createNativeClipboardReceiver(registration.bootstrap, onCopyEvent);
		} catch {
			// No receiver means no clipboard route for this row; the row itself is
			// untouched and its capsule OSCs stay denied.
			return undefined;
		}
		return (capsule) => {
			try {
				receiver(capsule);
			} catch {
				// Verification stays contained: nothing escapes into xterm's parser,
				// and an unverified capsule never becomes an event.
			}
		};
	}

	/**
	 * Strict source fence for one verified event: only the row still living in
	 * the map under this id, still holding this exact unreleased registration,
	 * still owning a live unstopped child, and still reporting the same current
	 * native conversation tuple may route a clipboard request. Everything else
	 * is dropped silently — never retried on a sibling, never logged, and never
	 * turned into a host-side result by this module.
	 */
	#forwardNativeClipboard(
		record: ManagedInstance,
		registration: InstanceStatusRegistration,
		event: NativeClipboardEvent,
	): void {
		const forward = this.#onNativeClipboard;
		if (forward === undefined) {
			return;
		}
		if (!this.#clipboardEventLive(record, registration, event)) {
			return;
		}
		try {
			forward(record.id, event);
		} catch {
			// The host's clipboard route is best effort; a refusal cannot break a
			// row or escape into the parser.
		}
	}

	/**
	 * The shared live-source fence for one verified capsule on this row: only the
	 * row still living in the map under this id, still holding this exact unreleased
	 * registration, still owning a live unstopped child, and still reporting the
	 * same current native conversation tuple may route anything. It is the unchanged
	 * local-route fence, reused for a viewer copy so neither route can weaken the
	 * other.
	 */
	#clipboardEventLive(
		record: ManagedInstance,
		registration: InstanceStatusRegistration,
		event: NativeClipboardEvent,
	): boolean {
		if (this.#disposed || this.#stopping
			|| this.#records.get(record.id) !== record
			|| record.registration !== registration || record.registrationReleased
			|| record.pty === undefined || record.ptyExited
			|| record.lifecycle !== "alive" || record.stopAdmissionClosed) {
			return false;
		}
		const nativeSession = record.nativeSession;
		return nativeSession !== null
			&& nativeSession.sessionId === event.sessionId
			&& nativeSession.epoch === event.sessionEpoch;
	}

	/**
	 * Route one authenticated viewer-origin copy to the ONE viewer that caused it.
	 *
	 * A hosted provider CLI row is refused here first: it has no copy producer, no
	 * Pi conversation to attribute a copy to, and its `nvcli1` input scope is
	 * input-only, so a native CLI row can never reach a clipboard sink.
	 *
	 * The token is only a lookup aid: its handle names the viewer record to consult,
	 * and the copy is delivered only after that record is re-read and its CURRENT
	 * facts re-commit to exactly the received token under THIS registration's key.
	 * So a retired or closed viewer, a viewer now showing another row, a replaced row,
	 * a released registration, a new run, a new native epoch, an ABA geometry change,
	 * or a newer viewer revision delivers nothing. Nothing is scanned, broadcast, or
	 * fallen back to the owner's local callback, no copy is attributed to the newest
	 * input or the highest dispatch id, and a throwing sink is contained: an async
	 * copy for an earlier dispatch still arrives with that dispatch's own origin.
	 */
	#forwardViewerNativeClipboard(
		record: ManagedInstance,
		registration: InstanceStatusRegistration,
		receipt: NativeClipboardOriginEvent,
	): void {
		if (!this.#clipboardEventLive(record, registration, receipt.event)) {
			return;
		}
		if (isNativeCliBackend(record.backend)) {
			// Input-only by construction: a native CLI input source can never carry a
			// copy receipt, and nothing on this row is a copy producer.
			return;
		}
		const origin = receipt.origin;
		if (origin.kind !== "viewer") {
			return; // A closed origin shape: only a viewer dispatch routes to a viewer.
		}
		const handle = parseNativeViewerScopeToken(origin.token);
		if (handle === undefined) {
			return;
		}
		const viewer = this.#viewers.get(handle.viewerId);
		const sink = viewer?.nativeClipboardSink;
		if (viewer === undefined || sink === undefined || viewer.sessionId !== record.id) {
			return;
		}
		const facts = this.#viewerScopeFacts(viewer, record, registration);
		if (facts === undefined
			|| !verifyNativeViewerScopeToken(registration.bootstrap, origin.token, facts)) {
			return;
		}
		const delivered: NativeViewerClipboardReceipt = Object.freeze({
			source: this.#viewerInputSourceFromFacts(facts, origin.token),
			event: Object.freeze({ ...receipt.event }),
			dispatchId: receipt.dispatchId,
		});
		try {
			sink(delivered);
		} catch {
			// A viewer's own refusal cannot break a row or escape into the parser.
		}
	}

	/**
	 * The ONE seam through which every byte the host writes to a hosted child's
	 * PTY passes, for exactly the three admitted sources: local user input
	 * ({@linkcode write}), TerminalSurface protocol replies
	 * ({@linkcode #onQueryReply}), and strict viewer-origin input
	 * ({@linkcode writeViewerInput}) on a Pi row. There is no raw unframed bypass of
	 * a Pi row's framing and no fourth caller here. A hosted provider CLI row never
	 * enters this seam: it has no registration and no encoder, and its viewer input is
	 * handed to its own PTY by {@linkcode #writeNativeCliViewerInput}, which carries
	 * its own ownership and process-incarnation fences.
	 *
	 * - Legacy rows (mode absent) forward the bytes exactly as before.
	 * - Framing rows encode EVERY write with this registration's single encoder:
	 *   local user input as `local`, protocol replies as `none`. The complete
	 *   framing string goes out as one write so two dispatches can never
	 *   interleave.
	 * - Before this registration's own verified readiness, a framing write is
	 *   refused: no raw fallback, no fabricated acknowledgement, no queue, no
	 *   replay, and nothing is ever typed into a legacy child. User input still
	 *   gets a thrown refusal. Only an otherwise-admissible row's never-sent early
	 *   automatic protocol reply is discarded by #onQueryReply before this seam;
	 *   all other protocol-reply failures still fail the owned row truthfully.
	 * - Readiness is re-checked against CURRENT ownership on EVERY framed write,
	 *   not only when it was first armed: an in-flight or unconfirmed Stop (and a
	 *   manager-wide stop or disposal) closes the seam immediately even though the
	 *   row stays `alive` until its child's actual exit event, and ownership of the
	 *   still-running child is retained rather than silently dropped.
	 *
	 * `expectedFence` accompanies a viewer dispatch only: either the native
	 * conversation the child must still be in, or the closed startup phase the child
	 * must still be in, before it delivers any of these bytes. It is authenticated
	 * inside the frame. Local and protocol-reply dispatches keep their unchanged
	 * shape and semantics.
	 */
	#writeChildInput(
		record: ManagedInstance,
		pty: InstancePty,
		data: string | Buffer,
		origin: NativeInputOrigin,
		expectedFence?: NativeInputExpectedFence,
	): void {
		if (!record.inputFramingRequested) {
			pty.write(data);
			return;
		}
		const encoder = this.#admittedInputEncoder(record, pty);
		if (encoder === undefined) {
			throw new Error(
				`session-host: instance ${record.id} has no admitted native input framing; refusing unframed input`,
			);
		}
		pty.write(encoder.encode(
			typeof data === "string" ? Buffer.from(data, "utf8") : data,
			origin,
			expectedFence,
		));
	}

	/**
	 * The framing admission check evaluated immediately before EACH encoded write.
	 * Arming readiness once is never a standing grant: the row must still be the
	 * current record for its id, still hold this exact unreleased registration and
	 * this exact live PTY, must not have exited, must not be inside a stop (an
	 * idle-preflight or confirmed Stop closes admission while the child is still
	 * running and unconfirmed), and the manager must not be stopping or disposed.
	 * `undefined` means "no framed byte may leave now"; the caller never falls back
	 * to raw input, and the owned child and its registration stay untouched so the
	 * stop path still settles on the real exit event.
	 */
	#admittedInputEncoder(record: ManagedInstance, pty: InstancePty): NativeInputEncoder | undefined {
		if (this.#disposed || this.#stopping
			|| this.#records.get(record.id) !== record
			|| record.registration === undefined || record.registrationReleased
			|| record.pty !== pty || record.ptyExited
			|| record.stopAdmissionClosed
			|| record.lifecycle !== "alive"
			|| !record.inputFramingRequested || !record.inputFramingReady) {
			return undefined;
		}
		return record.inputEncoder;
	}

	/**
	 * Arm one framing row from its own verified readiness capsule only. The
	 * capsule's identity/HMAC was already verified by this registration's
	 * receiver; these fences additionally require that the receiver still belongs
	 * to the current record, its exact unreleased registration, and an owned,
	 * live, not-stopping child. A foreign or stale bootstrap can never activate
	 * another row, and readiness never survives an exit, release, stop, or
	 * disposal.
	 */
	#markInputFramingReady(record: ManagedInstance, registration: InstanceStatusRegistration): void {
		if (this.#disposed || this.#stopping
			|| this.#records.get(record.id) !== record
			|| record.registration !== registration || record.registrationReleased
			|| record.pty === undefined || record.ptyExited || record.stopAdmissionClosed
			|| !record.inputFramingRequested) {
			return;
		}
		record.inputFramingReady = true;
	}

	/** Forward one surface's bounded diagnostics; delivery failures stay contained. */
	#safeTerminalDiagnostic(id: string, event: TerminalDiagnosticEvent): void {
		try {
			this.#onTerminalDiagnostic?.(id, event);
		} catch {
			// The frontend sink owns its own failures; parsing continues.
		}
	}

	/** Contains host callback failures; lifecycle callbacks of the manager never break rows. */
	#safeChanged(id: string | undefined): void {
		if (this.#disposed || !this.#onChange) {
			return;
		}
		try {
			if (id !== undefined) {
				this.#onChange(id);
			}
		} catch {
			// Contained: frontend change hooks are never load-bearing here.
		}
	}
}

/** One macrotask yield so concurrent create/shutdown interleavings are real. */
function yieldCheckpoint(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}
