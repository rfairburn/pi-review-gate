/**
 * Owned peer coordinator for the network sidebar (issue #482).
 *
 * This is the single backend authority behind the pure sidebar DTOs in
 * `peer-ui-protocol.ts`. It owns, for one host lifecycle:
 *
 * - the optional receiving listener and the roster metadata bridge attached to
 *   the SAME owning-host inventory service (never a second roster);
 * - every outgoing client, its one roster viewer, and its owned reconnect timers;
 * - the exact live consent handles (an incoming {@link PeerPairingRequest} or the
 *   first-use server-key approval) that an opaque DTO id maps onto;
 * - the protected preferences document (hosting intent, Auto, bell, saved
 *   destinations) and the trust store's remembered-key slots.
 *
 * Boundaries that shape the implementation:
 *
 * - Importing and constructing this module creates no key material, file,
 *   directory, socket, listener, or timer. A fresh, default-disabled start only
 *   READS existing protected state. Startup also restores roles the operator
 *   explicitly saved before: saved hosting intent can bind the saved listener,
 *   and eligible saved Auto reconnect attempts can open an outgoing connection.
 *   Startup never generates an identity, pairs, prompts for an unknown key, or
 *   replaces a changed pin; only explicit Enable/Connect does that.
 * - A saved, unavailable, changed, or unsafe trust document is reported as
 *   unavailable and never regenerated, defaulted, or overwritten.
 * - Consent decisions are re-checked against the exact live request/attempt
 *   epoch here even after Main's written-frame fence. A snapshot is display
 *   only: every protected metadata write is authorized by the current trust
 *   store and the exact channel key.
 * - Auto reconnect is off by default. When on, it attempts only destinations
 *   with successful connection history, a currently remembered pin, no explicit
 *   suppression, and no terminal authorization failure. It never pairs, never
 *   prompts for an unknown key, and never replaces a changed pin.
 * - Disconnect suppresses automatic reconnection until an explicit Connect;
 *   Remove forgets only this side's endpoint and remembered key; Revoke removes
 *   only this side's receiving permission. None of them stops a remote session,
 *   closes the owning-host manager, or changes the opposite direction.
 * - One owned attempt/timer per destination, fenced by an epoch, so a late
 *   completion can never resurrect a removed or suppressed destination.
 * - Every listener retirement (Disable, re-Enable, a superseded or failed
 *   start, shutdown) is owned and tracked work guarded by an explicit pending
 *   barrier, so no bind starts while one is undecided, and a detached retirement
 *   starts its own bounded settlement without waiting for a later command.
 *   Retirement is bounded by the existing ownership deadline; expiry or an
 *   unconfirmed close is sticky for the lifecycle: the snapshot never claims a
 *   settled "off", no later Enable may bind a second listener over the unknown
 *   port, and shutdown rejects with the fixed close error so the caller keeps
 *   ownership.
 *
 * The UI-facing consent windows are deliberate: a receiving human window of two
 * minutes, the same window for the local first-use server-key confirmation, and a
 * pairing-response deadline that allows the remote two-minute window plus finite
 * commit/reply overhead. Transport defaults themselves are unchanged.
 *
 * The native viewport content lane is wired through THIS coordinator and nothing
 * else (see `peer-content.ts` for the contracts). Incoming content channels arrive
 * on the SAME optional listener under the SAME current directional receiving grant,
 * attached to the SAME owning-host service the roster metadata bridge already uses;
 * without a content source the listener keeps refusing content upgrades. Outgoing
 * content is globally singular: at most ONE destination, owner run, and owner row is
 * selected at a time, over ONE dedicated content channel with ONE reconciler task
 * and ONE latest intent/viewport, while every other connected host keeps metadata
 * only. Selecting content never pairs, never creates an identity, never prompts for
 * or replaces a pin, never implicitly connects or retries, and never disposes the
 * borrowed destination client. Every new resource is registered through the existing
 * owned-work tracking and retired through the existing bounded settlement graph, so
 * an unconfirmed content or inbound-binding retirement stays the sticky, ownership-
 * retaining failure it already is instead of becoming a fabricated clean close.
 *
 * The one owner-routed Close controller (see `peer-close.ts`) rides that SAME
 * already-connected metadata viewer under the same verified pin and destination
 * epoch. It selects nothing, opens nothing, and removes nothing locally: the
 * owner's own Main provider decides and acts, and only the owner's next
 * authoritative snapshot can change the roster projection.
 *
 * The one ROWLESS owner-create controller (see `peer-create.ts`) rides that same
 * lane under the same verified pin, destination epoch, and owner run: it needs no
 * row, selection, native tuple, viewer, or display fact, creates no local row, and
 * selects and focuses nothing. The owner's own Main provider is the only thing
 * that can start a child, and only from the owner's exact current run.
 *
 * The one owner-rename controller (see `peer-rename.ts`) rides that same lane and
 * names one row's EXACT observed native conversation tuple (id plus epoch) in the
 * owner's exact current run, under the same verified pin and destination epoch. It
 * keeps no name of its own: there is no second name store, no optimistic caption,
 * and no alias — a confirmed rename becomes visible only through the owner's next
 * complete authoritative roster snapshot, exactly like every other roster fact.
 *
 * Native input and text copies for that selected stream exist only with explicit
 * `nativeIo` callbacks (the production Main supplies them by default). Without
 * them this coordinator is exactly the previous display-only one: no native
 * capability is offered, no input or copy callback exists, and both controller
 * primitives stay inert. With them, the owner-side endpoint's native support and
 * every outgoing endpoint's negotiation are fixed for the lifecycle, and each
 * protected write is gated by the current selection/peer/pin/run/row/source
 * fences, THIS viewer's current remote input/copy preference, AND the caller's own
 * dynamic written-source proof, with the preference, fences, and change
 * generations re-proved after that proof returns; copies reach only the current
 * initiating endpoint's callback while that preference is on, and this
 * coordinator still emits no OSC 52, reads no clipboard, and writes no terminal.
 *
 * The viewer preference changes only what THIS host forwards from its own
 * displayed remote pane. Applying it never restarts, disconnects, or reconnects
 * anything, never re-negotiates or revokes owner framing, never changes Hosting,
 * Auto, a grant, or another viewer, and never cancels owner work already accepted.
 * The separate owner policy for exposing remote saved-history deletion is a live
 * readable fact here ({@link PeerCoordinatorWithHistoryPolicy}).
 *
 * The optional Saved catalog exchange (see `peer-saved.ts`) rides the SAME
 * metadata lane in two independent halves. OWNER serving exists only when the
 * caller supplies its real Saved catalog view factory: the existing roster
 * bridge then acknowledges the capability, creates at most one view per channel
 * binding lazily after an authorized request, and reads this coordinator's live
 * delete policy at every decision; every actual policy change is pushed to the
 * existing bindings as a description, never as a roster refresh. REQUESTER use
 * exists only with the explicit `savedViewer` opt-in: the viewer then offers the
 * capability, the destination DTO describes support and the owner's (never this
 * host's) delete exposure, and the one {@link PeerSavedController} rides the
 * same verified pin, destination epoch, and exact owner run fences as Close and
 * Create. Neither half is gated by native input/copy, a content selection, or
 * the other half, and without either option nothing about the lane changes.
 */

import { createHash, randomUUID } from "node:crypto";

import type { OwningHostService } from "../owning-host-service";
import type { TerminalInputModes } from "../terminal-surface";
import type {
	PeerUiCommand,
	PeerUiConsent,
	PeerUiHost,
	PeerUiSettings,
	PeerUiSnapshot,
	PeerUiStorage,
	PeerUiStorageProblem,
	PeerUiStorageRepair,
	PeerUiStorageRepairAdmission,
	PeerUiTrustedPeer,
} from "../peer-ui-protocol";
import type { PeerByteChannel } from "./channel";
import type { PeerServerKeyDecision, PeerServerKeyPrompt } from "./gated-agent";
import { peerKeysEqual, peerKeyFromSpki, type OwnedPeerIdentity, type PeerKey } from "./identity";
import {
	createPeerClient,
	type PeerClient,
	type PeerPairResult,
} from "./peer-client";
import {
	createPeerHost,
	type PeerHost,
	type PeerPairingRequest,
} from "./peer-host";
import {
	DEFAULT_SESSION_CONTENT_BOUNDS,
	nativeIoSourceEquals,
	type NativeIoCompletedCopy,
	type NativeIoInputKind,
	type NativeIoInputSource,
	type NativeIoSource,
	type SessionContentSnapshot,
} from "./session-content-protocol";
import {
	attachSessionContentViewer,
	isSessionContentViewerError,
	type NativeInputNotSentReason,
	type NativeInputSendResult,
	type SessionContentViewer,
} from "./session-content-client";
import {
	createSessionContentHost,
	type SessionContentHost,
	type SessionContentSource,
} from "./session-content-host";
import type {
	PeerContentController,
	PeerContentObservation,
	PeerContentReason,
	PeerContentState,
	PeerContentTarget,
	PeerContentViewport,
	PeerCoordinatorWithContent,
	PeerNativeCopyReceipt,
	PeerNativeInputRequest,
	PeerNativeInputTarget,
	PeerNativeIoCallbacks,
	PeerSelectedContent,
	PeerViewerNativeInputPolicy,
} from "./peer-content";
import type { OwnerCloseHandler, PeerCloseController, PeerCloseResult, PeerCloseTarget, PeerCoordinatorWithClose } from "./peer-close";
import {
	isOwnerCreateRunStillCurrent,
	isOwnerCreateWorkspace,
	type OwnerCreateHandler,
	type PeerCreateController,
	type PeerCreateOptions,
	type PeerCreateResult,
	type PeerCreateTarget,
	type PeerCoordinatorWithCreate,
} from "./peer-create";
import {
	isOwnerRenameTupleStillCurrent,
	type OwnerRenameHandler,
	type PeerCoordinatorWithRename,
	type PeerRenameController,
	type PeerRenameOptions,
	type PeerRenameResult,
	type PeerRenameTarget,
} from "./peer-rename";
import {
	isOwnerSavedIdentifier,
	isOwnerSavedQuery,
	isOwnerSavedScalar,
	type OwnerSavedCatalogViewFactory,
	type OwnerSavedDeleteFacts,
	type OwnerSavedDeleteRequest,
	type OwnerSavedListRequest,
	type OwnerSavedResumeFacts,
	type OwnerSavedResumeRequest,
	type OwnerSavedSearchRequest,
	type OwnerSavedWindowFacts,
	type OwnerSavedWindowRequest,
	type PeerCoordinatorWithSaved,
	type PeerSavedController,
	type PeerSavedControllerOptions,
	type PeerSavedDeleteTarget,
	type PeerSavedListTarget,
	type PeerSavedResult,
	type PeerSavedResumeTarget,
	type PeerSavedSearchTarget,
	type PeerSavedWindowTarget,
} from "./peer-saved";
import {
	DEFAULT_PEER_PREFERENCES,
	MAX_PEER_DESTINATIONS,
	isValidPeerEndpointHost,
	openPeerPreferencesStoreWithPermissions,
	validatePeerPreferences,
	type PeerDestination,
	type PeerPreferences,
	type PeerPreferencesStore,
} from "./peer-preferences-store";
import { openPeerStateStore } from "./peer-state";
import { createPeerStatePermissionPolicy } from "./peer-state-permissions";
import { openPeerStateStoreWithPermissions, type PeerStateStore } from "./peer-state-store";
import type { PeerStatePermissionPolicy } from "./peer-state-permission-policy";
import { peerStorageDiagnostic } from "./peer-storage-diagnostics";
import {
	assessPeerStorageProtection,
	repairPeerStorageProtection,
	type PeerStorageAssessment,
	type PeerStorageRemediationOptions,
	type PeerStorageRepairReport,
} from "./peer-storage-remediation";
import {
	isPeerTransportError,
	isValidPeerLabel,
	peerError,
	type PeerTransportBounds,
	type PeerTransportErrorCode,
} from "./protocol";
import { isValidNativeSessionId, isValidRenameName } from "../protocol";
import {
	isRosterBridgeIdentifier,
	ROSTER_BRIDGE_CREATE_CAPABILITY,
	ROSTER_BRIDGE_RENAME_CAPABILITY,
	ROSTER_BRIDGE_SAVED_CAPABILITY,
} from "./roster-bridge-protocol";
import {
	attachRosterBridgeViewer,
	type RosterBridgeProjection,
	type RosterBridgeSavedViewer,
	type RosterBridgeViewer,
} from "./roster-bridge-client";
import {
	createRosterBridgeHost,
	type RosterBridgeHost,
} from "./roster-bridge-host";
import type { RemoteSessionMetadata } from "./roster-metadata";
import type { AcceptedPeerRecord, DirectionalGrantRecord } from "./trust";

/** Fixed label for an identity this host generates on explicit Enable/Connect. */
const HOST_IDENTITY_LABEL = "pi-session-host";

/** Display label for a receiving fact that has no accepted identity record. */
const UNKNOWN_PEER_LABEL = "Unknown peer";

/** The real human approval window in the sidebar; never a grant lifetime. */
export const PEER_UI_CONSENT_WINDOW_MS = 120_000;

/** Finite commit/reply overhead allowed after the remote human window elapses. */
export const PEER_UI_PAIRING_RESPONSE_OVERHEAD_MS = 30_000;

/** Outgoing pairing deadline: the remote human window plus finite overhead. */
export const PEER_UI_PAIRING_RESPONSE_TIMEOUT_MS =
	PEER_UI_CONSENT_WINDOW_MS + PEER_UI_PAIRING_RESPONSE_OVERHEAD_MS;

/** Bounded automatic reconnect schedule; the last value repeats. */
export const DEFAULT_AUTO_RECONNECT_DELAYS_MS: readonly number[] = Object.freeze([
	1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
]);

/** Bound on awaiting one explicit listener bind before reporting it. */
const LISTENER_START_TIMEOUT_MS = 10_000;

/**
 * Bound on waiting for accepted start/perform work to finish after shutdown
 * cancelled it. Exceeding it is unconfirmed cleanup, never a silent success.
 */
const SHUTDOWN_OPERATION_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Fixed shutdown failure: at least one owned local network resource could not be
 * confirmed settled. The caller must keep whatever ownership it holds; this is
 * never reported as a successful close.
 */
export class PeerCoordinatorCloseError extends Error {
	readonly code = "PEER_COORDINATOR_CLOSE_UNCONFIRMED";

	constructor() {
		super("peer coordinator shutdown could not be confirmed");
		this.name = "PeerCoordinatorCloseError";
	}
}

export function isPeerCoordinatorCloseError(value: unknown): value is PeerCoordinatorCloseError {
	return value instanceof PeerCoordinatorCloseError;
}

/**
 * The OWNER-side remote saved-history deletion exposure policy, read live.
 *
 * This is the one policy fact the owner-side Saved exchange consults on every
 * delete decision and policy publication (only when the caller supplied a Saved
 * catalog view factory); it is not a registry, lease, grant, or receiving
 * permission, it does not gate this host's own local Saved deletion, and it is
 * not a viewer-side toggle. Reading it enables nothing.
 */
export interface PeerCoordinatorWithHistoryPolicy {
	/**
	 * `true` only while this coordinator holds a loaded, valid settings document
	 * whose effective `remoteHistoryDeleteEnabled` is on (absent in the document is
	 * on; an explicit saved Off is off). Before start, after close, and while the
	 * protected settings are unavailable it is `false` (fail closed).
	 */
	readRemoteHistoryDeleteEnabled(): boolean;
}

/**
 * The explicit, human-confirmed storage permission repair (Refs #494). Present
 * on every production coordinator; Main reaches it only after its own written
 * confirmation fence.
 */
export interface PeerCoordinatorWithStorageRepair {
	repairStorageProtection(generation: number): Promise<PeerUiStorageRepairAdmission>;
}

const NOTICE = Object.freeze({
	preferencesUnavailable: "Network settings are unavailable; saved values could not be read.",
	preferencesUnsaved: "Network settings could not be saved.",
	trustUnavailable: "Network identity and trust state are unavailable.",
	identityUnavailable: "A network identity could not be created or loaded.",
	listenerBindFailed: "The listener could not bind the saved address and port.",
	listenerCloseUnconfirmed: "The listener could not be confirmed stopped; its port stays owned until Pi restarts.",
	listenerIdentityMissing: "Saved hosting needs an identity that is no longer present; enable hosting again.",
	invalidRequest: "The network request was ignored.",
	actionFailed: "The network action could not be completed.",
	invalidBind: "Enter an explicit bind address and port.",
	invalidDestination: "Enter a name, host, and port for the destination.",
	tooManyDestinations: "No more destinations can be saved.",
	unknownDestination: "That saved destination is no longer available.",
	unknownPeer: "That peer receiving permission is no longer available.",
	removeUnsaved: "Removal could not be saved.",
	pinNotCleared: "The saved host key could not be cleared.",
	revokeFailed: "The receiving permission could not be revoked.",
	storageRepairStale: "Network storage changed since the repair was shown; nothing was changed. Review it again.",
	storageRepairBusy: "Network work is active; disable hosting and disconnect before repairing. Nothing was changed.",
	storageRepairUnavailable: "The permission repair is not available now; nothing was changed.",
	storageRepairUnchanged: "No permission was changed; see the storage status above.",
	storageRestartRequired: "Restart Pi to reopen Network; no Network action runs before that.",
});

const HOST_MESSAGE = Object.freeze({
	connecting: "Connecting.",
	pairing: "Waiting for local and remote approval.",
	reconnecting: "Reconnecting automatically.",
	autoStopped: "Automatic reconnect stopped; connect manually.",
	connectionLost: "The connection was lost.",
	notConnected: "Not connected.",
	keyChanged: "The saved host key changed; connect explicitly to review it.",
	approvalDeclined: "Host approval was not given.",
	pairingDenied: "Pairing was denied on the other host.",
	pairingExpired: "Pairing approval expired on the other host.",
	notAuthorized: "The other host refused this connection.",
	identityUnavailable: "Network identity or key storage is unavailable.",
	metadataUnavailable: "Connected; the remote session list is unavailable.",
	savedKeyMissing: "The saved host key is missing; connect explicitly to confirm it again.",
});

/** Test-only fixture seams. Production callers pass nothing. */
export interface PeerCoordinatorTestHooks {
	/** Bounded positive automatic reconnect delays (fixture speed only). */
	readonly autoReconnectDelaysMs?: readonly number[];
	/** Bounded human consent window override (fixture speed only). */
	readonly consentWindowMs?: number;
	/** Injected protection policy for synthetic preferences fixtures. */
	readonly preferencesPermissions?: PeerStatePermissionPolicy;
	/** Injected protection policy for synthetic trust-store fixtures. */
	readonly peerStatePermissions?: PeerStatePermissionPolicy;
	/** Injected lower-level transport bounds for controlled coupling fixtures. */
	readonly hostBounds?: Partial<PeerTransportBounds>;
	readonly clientBounds?: Partial<PeerTransportBounds>;
	/**
	 * Fixture-only: wrap one already-authenticated outgoing channel so a test can
	 * control or fail its LOCAL closure. It is applied to the metadata channel of a
	 * destination client and, when one is opened, to that same client's dedicated
	 * content-lane channel — which is the only way a test can speak the content
	 * protocol directly at the selected-stream endpoint. Production callers never
	 * pass it.
	 */
	readonly wrapClientChannel?: (channel: PeerByteChannel) => PeerByteChannel;
	/**
	 * Fixture-only replacements for the explicit storage remediation backend, so a
	 * test can drive a partial, refused, or throwing outcome deterministically.
	 * Production uses the real read-only assessment and repair entry points.
	 */
	readonly storageRemediation?: {
		readonly assess?: (options: PeerStorageRemediationOptions) => PeerStorageAssessment;
		readonly repair?: (options: PeerStorageRemediationOptions) => PeerStorageRepairReport;
	};
}

export interface PeerCoordinatorOptions {
	/** Canonical Pi agent directory owned by the caller's host lifecycle. */
	readonly agentDir: string;
	/** The host's one authoritative inventory source (never a proxy roster). */
	readonly inventory: Pick<OwningHostService, "watchInventory">;
	/**
	 * The SAME owning-host service instance already supplied as `inventory`, narrowed
	 * to the read-only native viewport capabilities the owner side of the content
	 * lane needs. It is never a clone or a second roster/content source. Absent means
	 * this host never accepts an incoming content lane: the listener keeps refusing
	 * content upgrades exactly as it does today, and no content watch or viewer is
	 * ever registered. It grants nothing by itself — every protected content request
	 * is still authorized by the current directional receiving grant.
	 */
	readonly contentSource?: SessionContentSource;
	/**
	 * The host's ONE owner-side Close provider, supplied by Main, which already
	 * owns the only manager, the only roster, and the only row-removal path.
	 *
	 * The owner bridge offers the optional Close capability only when this provider
	 * is present, and every request is reauthorized against the current TLS-proved
	 * peer key and current directional receiving grant before it is reached. The
	 * coordinator never wraps it: Main's own row-stop lifecycle owns the operation,
	 * and a host that supplies nothing (or an old peer that never negotiated the
	 * capability) behaves exactly as it does today.
	 */
	readonly closeOwnedSession?: OwnerCloseHandler;
	/**
	 * The host's ONE rowless owner-create provider, supplied by Main, which already
	 * owns the only manager, the only run identity, and the only launch path.
	 *
	 * The owner bridge offers the optional create capability only when this provider
	 * is present, and every request is reauthorized against the current TLS-proved
	 * peer key and current directional receiving grant immediately before it is
	 * reached. The coordinator never wraps it and never emulates a create: Main's own
	 * launch lifecycle owns the operation, and a host that supplies nothing (or an
	 * old peer that never negotiated the capability) behaves exactly as it does
	 * today.
	 */
	readonly createOwnedSession?: OwnerCreateHandler;
	/**
	 * The host's ONE owner-side rename provider, supplied by Main, which already owns
	 * the only manager, the only verified native-name seam, and the only roster.
	 *
	 * The owner bridge offers the optional rename capability only when this provider
	 * is present AND the peer offered it, and every request is reauthorized against the
	 * current TLS-proved peer key and current directional receiving grant before it is
	 * reached. The coordinator never wraps it and never renames anything itself: Main's
	 * own verified rename operation owns the write, and a host that supplies nothing
	 * (or an old peer that never negotiated the capability) behaves exactly as it does
	 * today. This option grants no requester anything and stores no name here.
	 */
	readonly renameOwnedSession?: OwnerRenameHandler;
	/**
	 * OWNER side: the host's real Saved catalog view factory, supplied by Main.
	 *
	 * Present means the owner bridge acknowledges the optional Saved capability and
	 * pairs this factory with this coordinator's LIVE remote-history delete policy
	 * ({@link PeerCoordinatorWithHistoryPolicy.readRemoteHistoryDeleteEnabled}). The
	 * factory is never called here: the bridge creates at most one view per channel
	 * binding, lazily, only after an authorized request. Serving is independent of
	 * this host's own viewer preferences, `savedViewer`, and content selection.
	 * Absent keeps the bridge exactly the metadata/close/create host it was.
	 */
	readonly savedCatalogViewFactory?: OwnerSavedCatalogViewFactory;
	/**
	 * REQUESTER side: explicit opt-in to the Saved catalog exchange on this host's
	 * outgoing metadata viewers. `true` offers the capability, describes each
	 * destination's Saved support and owner delete exposure in its DTO, and arms
	 * {@link PeerCoordinatorWithSaved.ownerSaved}. Absent or `false` is exactly the
	 * legacy coordinator: nothing new is offered or described, and every controller
	 * request is `not-sent` with `capability-unsupported`.
	 */
	readonly savedViewer?: boolean;
	readonly onChange: (snapshot: PeerUiSnapshot) => void;
	/** Advisory, exactly-once-per-new-incoming-handle arrival signal. */
	readonly onIncomingConsentArrival: (consentId: string) => void;
	/**
	 * Advisory observation of the globally selected outgoing content stream. It is
	 * display only: it cannot steal focus or selection, it never means a frame was
	 * written or received, and a callback that throws is contained here.
	 */
	readonly onContentChange?: (observation: PeerContentObservation) => void;
	/**
	 * Optional native input / text-copy callbacks for the selected outgoing content
	 * stream. Omitted (the default) is exactly the legacy display-only coordinator:
	 * no native capability is offered by any endpoint it attaches, both controller
	 * primitives stay inert, and nothing new is created.
	 *
	 * Supplying BOTH functions is what makes the extension exist for this host. It
	 * is not a permission and not a grant: `authorizeInput` is the caller's dynamic
	 * written-source/focus/coverage proof, re-evaluated for every protected write
	 * alongside this coordinator's own current selection, peer, pin, run, row, and
	 * source fences, and `onCopy` only ever receives a copy whose source is still
	 * this coordinator's current stream. A partially or wrongly shaped value is
	 * refused at construction rather than silently enabling anything.
	 */
	readonly nativeIo?: PeerNativeIoCallbacks;
	/** Test-only seams; there is no insecure production fallback for them. */
	readonly testHooks?: PeerCoordinatorTestHooks;
}

type DestinationState = PeerUiHost["state"];

interface RosterObservation {
	readonly state: "never" | "current" | "stale";
	readonly rows: readonly RemoteSessionMetadata[] | null;
	/**
	 * Owner run identity of the last complete observation. A stale observation keeps
	 * the run it was observed on; `never` is null. The selected content stream is
	 * fenced against this exact value, so dropping it would let a new owner run be
	 * mistaken for the one the operator selected.
	 */
	readonly hostRunId: string | null;
}

/**
 * Structural retirement contract shared by every inbound lane binding this
 * coordinator owns. Both the roster metadata bridge and the native viewport
 * content endpoint retire the same way: a bounded local `stop()`, and a `closed`
 * that settles only once that retirement is positively confirmed (a content
 * binding rejects it with the endpoint's fixed close error when it is not).
 */
interface InboundBinding {
	/** Exact verified peer identity of the channel this binding serves. */
	readonly peerKey: PeerKey;
	/**
	 * Bounded LOCAL retirement. It resolves only once the endpoint's own resources
	 * are confirmed released and rejects with the endpoint's fixed close error when
	 * they are not; it never means the peer saw anything.
	 */
	stop(): Promise<void>;
	readonly closed: Promise<void>;
}

/**
 * One live outgoing content endpoint, plus EVERY borrowed fact the attempt was
 * authorized against. The authority facts are retained precisely so publication
 * can revalidate them after each await: an endpoint may only publish while the
 * destination runtime, metadata channel, borrowed client, destination epoch,
 * current pin, and current local identity are still the ones it started with.
 */
interface ContentEndpoint {
	/** The selection intent this endpoint was opened for. */
	readonly epoch: number;
	/** The exact tuple this endpoint may accept content for. */
	readonly target: PeerContentTarget;
	readonly channel: PeerByteChannel;
	readonly viewer: SessionContentViewer;
	/** The destination runtime this attempt borrowed, by identity. */
	readonly runtime: DestinationRuntime;
	/** The metadata channel whose verified key the content channel must match. */
	readonly metadata: PeerByteChannel;
	/** The borrowed destination client this endpoint must never dispose. */
	readonly client: PeerClient;
	/** Destination epoch at open time; any advance invalidates this endpoint. */
	readonly destinationEpoch: number;
}

/**
 * The owner-side content endpoint's options plus its own explicit native IO
 * enable. That flag is the sibling owner-endpoint option this coordinator is
 * allowed to forward (nothing else about that endpoint changes here), and it is
 * spelled as a local intersection so an absent flag stays a compile-time no-op.
 */
type OwnerContentHostOptions = Parameters<typeof createSessionContentHost>[0] & {
	readonly nativeIo?: boolean;
};

/**
 * One whole, descriptive native input target of an endpoint's own currently
 * published stream. Descriptive facts only: never a permission or a grant.
 */
interface NativeInputFacts {
	readonly target: PeerNativeInputTarget;
}

/** The single global content selection and its honest display state. */
interface ContentSelection {
	/** The deliberate target; kept while unavailable, null only when nothing is selected. */
	desired: PeerContentTarget | null;
	/** Bumped by every replacement so a superseded attempt can never publish. */
	epoch: number;
	/**
	 * The epoch whose real network attempt is SPENT and must not be silently
	 * retried. Cleared by a new selection and by any genuine reachability
	 * transition (connection loss or a roster that stopped holding the target),
	 * so an existing recovery may restore the same deliberate target once, while
	 * ordinary repeated roster updates never restart a failed stream.
	 */
	spentEpoch: number | null;
	state: PeerContentState;
	reason: PeerContentReason | null;
	view: PeerSelectedContent | undefined;
	endpoint: ContentEndpoint | null;
	/** Bounded retirement of the previous endpoint, still owned and undecided. */
	retirement: Promise<void> | null;
}

interface DestinationRuntime {
	readonly id: string;
	state: DestinationState;
	message: string | null;
	roster: RosterObservation;
	autoAttempts: number;
	retryTimer: NodeJS.Timeout | null;
	mode: "explicit" | "auto" | null;
	abort: AbortController | null;
	client: PeerClient | null;
	viewer: RosterBridgeViewer | null;
	channel: PeerByteChannel | null;
	epoch: number;
}

interface PendingConsent {
	readonly id: string;
	readonly kind: "incoming" | "server-key";
	readonly label: string;
	readonly fingerprint: string;
	readonly endpoint: string | null;
	readonly requestedAt: number;
	readonly expiresAt: number;
	/** Destination/attempt binding for a first-use key decision; null for incoming. */
	readonly destinationId: string | null;
	readonly attemptEpoch: number | null;
	/** True only while this handle can still affect its live request/attempt. */
	live(): boolean;
	/** Apply one decision; true only when it reached a live handle. */
	apply(decision: "approve" | "deny"): boolean;
	/** Abandon the handle without a decision; idempotent. */
	release(): void;
}

interface PeerFailure {
	readonly terminal: boolean;
	readonly message: string;
}

interface ListenerSnapshot {
	state: "off" | "starting" | "listening" | "error";
	host: string | null;
	port: number | null;
	message: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Opaque display/action handle for one receiving permission. It is derived from
 * the public key id only so the DTO never carries key material as an action
 * name, and it grants nothing by itself.
 */
function peerHandleFor(keyId: string): string {
	return createHash("sha256").update(keyId, "utf8").digest("base64url").slice(0, 22);
}

function displayEndpoint(host: string, port: number): string {
	return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function parsePeerPortText(value: string, allowZero: boolean): number | null {
	const text = value.trim();
	if (!/^[0-9]{1,5}$/.test(text)) return null;
	const port = Number(text);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) return null;
	if (port === 0 && !allowZero) return null;
	return port;
}

/**
 * Immutable display copy of one remote row. `onChange`/`read()` must hand out
 * state a consumer cannot mutate back into the coordinator's own projection.
 */
function copyRosterRow(row: RemoteSessionMetadata): RemoteSessionMetadata {
	return Object.freeze({
		...row,
		activity: Object.freeze([...row.activity]),
		nativeSession: row.nativeSession === null ? null : Object.freeze({ ...row.nativeSession }),
	});
}

function copyRoster(rows: readonly RemoteSessionMetadata[] | null): readonly RemoteSessionMetadata[] | null {
	if (rows === null) return null;
	return Object.freeze(rows.map(copyRosterRow));
}

/** A viewport dimension this endpoint can actually ask the owner for. */
function isContentDimension(value: unknown, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}

/**
 * Validate and copy one requested selection. Nothing is ever inferred here: a
 * target this contract cannot represent is refused as an invalid selection rather
 * than partially adopted, defaulted to a local row, or matched to a sibling.
 */
function normalizeContentTarget(value: unknown): PeerContentTarget | null {
	if (!isRecord(value)) return null;
	const { hostId, hostRunId, rowId, selectionGeneration, cols, rows } = value;
	if (typeof hostId !== "string" || hostId.length === 0) return null;
	if (typeof hostRunId !== "string" || hostRunId.length === 0) return null;
	if (typeof rowId !== "string" || rowId.length === 0) return null;
	if (
		typeof selectionGeneration !== "number"
		|| !Number.isSafeInteger(selectionGeneration)
		|| selectionGeneration < 0
	) return null;
	if (!isContentDimension(cols, DEFAULT_SESSION_CONTENT_BOUNDS.maxCols)) return null;
	if (!isContentDimension(rows, DEFAULT_SESSION_CONTENT_BOUNDS.maxRows)) return null;
	return Object.freeze({
		hostId,
		hostRunId,
		rowId,
		selectionGeneration,
		cols,
		rows,
	});
}

function copyContentTarget(target: PeerContentTarget): PeerContentTarget {
	return Object.freeze({
		hostId: target.hostId,
		hostRunId: target.hostRunId,
		rowId: target.rowId,
		selectionGeneration: target.selectionGeneration,
		cols: target.cols,
		rows: target.rows,
	});
}

function sameContentTarget(left: PeerContentTarget, right: PeerContentTarget): boolean {
	return left.hostId === right.hostId
		&& left.hostRunId === right.hostRunId
		&& left.rowId === right.rowId
		&& left.selectionGeneration === right.selectionGeneration
		&& left.cols === right.cols
		&& left.rows === right.rows;
}

/**
 * Validate and copy one Close request. Both owner identifiers must be carryable
 * as opaque protocol identifiers and the confirmation must be a real boolean; a
 * request this contract cannot represent is refused rather than repaired,
 * defaulted to another row, or matched to a sibling destination.
 */
function normalizeCloseTarget(value: unknown): PeerCloseTarget | null {
	if (!isRecord(value)) return null;
	const { hostId, hostRunId, rowId, confirmed } = value;
	if (typeof hostId !== "string" || hostId.length === 0) return null;
	if (!isRosterBridgeIdentifier(hostRunId)) return null;
	if (!isRosterBridgeIdentifier(rowId)) return null;
	if (typeof confirmed !== "boolean") return null;
	return Object.freeze({ hostId, hostRunId, rowId, confirmed });
}

/**
 * Validate and copy one rowless create request. The destination handle is a local
 * action handle, the owner run must be carryable as an opaque protocol identifier
 * and is REQUIRED input from the caller's last written form destination, and the
 * workspace must be the canonical single-line text the New form can hold. A
 * request this contract cannot represent is refused rather than repaired,
 * defaulted to another destination or run, or rewritten to a newer one.
 */
function normalizeCreateTarget(value: unknown): PeerCreateTarget | null {
	if (!isRecord(value)) return null;
	const { hostId, hostRunId, workspace } = value;
	if (typeof hostId !== "string" || hostId.length === 0) return null;
	if (!isRosterBridgeIdentifier(hostRunId)) return null;
	if (!isOwnerCreateWorkspace(workspace)) return null;
	return Object.freeze({ hostId, hostRunId, workspace });
}

/**
 * Validate and copy one rename request. The destination handle is a local action
 * handle that never reaches the wire; the owner run and row must be carryable as
 * opaque protocol identifiers; the native conversation id and epoch must satisfy
 * the SAME canonical native rules the roster row boundary and the lane codec
 * apply; and the name must be a canonical native rename name. Every field is read
 * exactly once, so a getter cannot hand one value to validation and another to the
 * transport. A request this contract cannot represent is refused rather than
 * repaired, trimmed, normalized, or retargeted to a sibling row or a newer tuple.
 */
function normalizeRenameTarget(value: unknown): PeerRenameTarget | null {
	if (!isRecord(value)) return null;
	const { hostId, hostRunId, rowId, expectedSessionId, expectedSessionEpoch, name } = value;
	if (typeof hostId !== "string" || hostId.length === 0) return null;
	if (!isRosterBridgeIdentifier(hostRunId)) return null;
	if (!isRosterBridgeIdentifier(rowId)) return null;
	if (!isValidNativeSessionId(expectedSessionId)) return null;
	if (typeof expectedSessionEpoch !== "number"
		|| !Number.isSafeInteger(expectedSessionEpoch)
		|| expectedSessionEpoch < 1) return null;
	if (!isValidRenameName(name)) return null;
	return Object.freeze({ hostId, hostRunId, rowId, expectedSessionId, expectedSessionEpoch, name });
}

/** The five requester Saved operations, matching the controller's methods. */
type SavedOperation = "list" | "search" | "window" | "resume" | "remove";

/**
 * One validated Saved request on its own closed, frozen copy. Only the fields the
 * owner request names are copied: a UI intent's picker/request ids, paths, or any
 * other extra field never reach the transport.
 */
type NormalizedSavedTarget =
	| { readonly kind: "list"; readonly hostId: string; readonly request: OwnerSavedListRequest }
	| { readonly kind: "search"; readonly hostId: string; readonly request: OwnerSavedSearchRequest }
	| { readonly kind: "window"; readonly hostId: string; readonly request: OwnerSavedWindowRequest }
	| { readonly kind: "resume"; readonly hostId: string; readonly request: OwnerSavedResumeRequest }
	| { readonly kind: "remove"; readonly hostId: string; readonly request: OwnerSavedDeleteRequest };

/** A positive, safe window size. The raw viewer applies the lane's own upper bound. */
function isSavedWindowCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Validate and copy one requester Saved request. Every field is read exactly once
 * (a getter cannot hand one value to validation and another to the wire), the
 * query is preserved verbatim (spaces, Unicode, regex/fuzzy syntax; never trimmed,
 * normalized, or capped here — the only size bound is the lane frame), and a
 * request this contract cannot represent is refused rather than repaired.
 */
function normalizeSavedTarget(kind: SavedOperation, value: unknown): NormalizedSavedTarget | null {
	if (!isRecord(value)) return null;
	const hostId = value.hostId;
	const hostRunId = value.hostRunId;
	if (typeof hostId !== "string" || hostId.length === 0) return null;
	if (!isOwnerSavedIdentifier(hostRunId)) return null;
	switch (kind) {
		case "list": {
			const query = value.query;
			const offset = value.offset;
			const count = value.count;
			if (!isOwnerSavedQuery(query) || !isOwnerSavedScalar(offset) || !isSavedWindowCount(count)) return null;
			return Object.freeze({ kind, hostId, request: Object.freeze({ hostRunId, query, offset, count }) });
		}
		case "search": {
			const catalogId = value.catalogId;
			const query = value.query;
			const offset = value.offset;
			const count = value.count;
			if (!isOwnerSavedIdentifier(catalogId)) return null;
			if (!isOwnerSavedQuery(query) || !isOwnerSavedScalar(offset) || !isSavedWindowCount(count)) return null;
			return Object.freeze({
				kind,
				hostId,
				request: Object.freeze({ hostRunId, catalogId, query, offset, count }),
			});
		}
		case "window": {
			const catalogId = value.catalogId;
			const resultId = value.resultId;
			const offset = value.offset;
			const count = value.count;
			if (!isOwnerSavedIdentifier(catalogId) || !isOwnerSavedIdentifier(resultId)) return null;
			if (!isOwnerSavedScalar(offset) || !isSavedWindowCount(count)) return null;
			return Object.freeze({
				kind,
				hostId,
				request: Object.freeze({ hostRunId, catalogId, resultId, offset, count }),
			});
		}
		case "resume": {
			const catalogId = value.catalogId;
			const resultId = value.resultId;
			const entryId = value.entryId;
			if (!isOwnerSavedIdentifier(catalogId) || !isOwnerSavedIdentifier(resultId)) return null;
			if (!isOwnerSavedIdentifier(entryId)) return null;
			return Object.freeze({
				kind,
				hostId,
				request: Object.freeze({ hostRunId, catalogId, resultId, entryId }),
			});
		}
		case "remove": {
			const catalogId = value.catalogId;
			const resultId = value.resultId;
			const entryId = value.entryId;
			const confirmed = value.confirmed;
			if (!isOwnerSavedIdentifier(catalogId) || !isOwnerSavedIdentifier(resultId)) return null;
			if (!isOwnerSavedIdentifier(entryId) || typeof confirmed !== "boolean") return null;
			return Object.freeze({
				kind,
				hostId,
				request: Object.freeze({ hostRunId, catalogId, resultId, entryId, confirmed }),
			});
		}
		default:
			return null;
	}
}

/**
 * Whether one owner outcome really answers THIS captured request: a window names
 * the exact requested owner run and offset (plus the same catalog for a search,
 * and the same catalog and result for a window) and never holds more entries than
 * were asked for; a `started` resume names the exact requested run. Anything else
 * establishes nothing about this request and is reported `unknown`, never
 * retargeted to another run or result.
 */
function savedOutcomeAnswers(target: NormalizedSavedTarget, outcome: unknown): boolean {
	if (!isRecord(outcome)) return false;
	const kind = outcome.kind;
	switch (target.kind) {
		case "list":
		case "search":
		case "window": {
			if (kind === "refused" || kind === "unavailable" || kind === "unknown") return true;
			if (kind !== "window") return false;
			const request = target.request;
			if (outcome.hostRunId !== request.hostRunId || outcome.offset !== request.offset) return false;
			if (target.kind !== "list" && outcome.catalogId !== target.request.catalogId) return false;
			if (target.kind === "window" && outcome.resultId !== target.request.resultId) return false;
			const entries = outcome.entries;
			return Array.isArray(entries) && entries.length <= request.count;
		}
		case "resume":
			if (kind === "started") return outcome.hostRunId === target.request.hostRunId;
			return kind === "refused" || kind === "unconfirmed" || kind === "unknown";
		case "remove":
			return kind === "confirmation-required"
				|| kind === "deleted"
				|| kind === "refused"
				|| kind === "unconfirmed"
				|| kind === "unknown";
		default:
			return false;
	}
}

/** A read only describes; a resume or delete is a mutation the owner may have performed. */
function isSavedRead(kind: SavedOperation): boolean {
	return kind === "list" || kind === "search" || kind === "window";
}

/**
 * Map one failed content-channel open onto a fixed code. A content open never
 * asks a human: its per-connection server-key approver rejects, so a missing or
 * changed key is reported as such and nothing is retried or re-prompted.
 */
function contentOpenReason(error: unknown): PeerContentReason {
	if (!isPeerTransportError(error)) return "open-failed";
	switch (error.code) {
		case "PEER_KEY_CHANGED":
		case "PEER_KEY_MISMATCH":
			return "key-changed";
		case "PEER_KEY_REJECTED":
		case "PEER_KEY_CANCELLED":
		case "PEER_KEY_APPROVER_FAILED":
			return "key-unavailable";
		case "APP_REFUSED":
			return error.statusCode === 403 ? "not-authorized" : "open-failed";
		default:
			return "open-failed";
	}
}

/** Map one retired content viewer failure onto a fixed code. */
function contentViewerReason(error: unknown): PeerContentReason {
	if (isSessionContentViewerError(error)) {
		switch (error.code) {
			case "refused":
				return "owner-refused";
			case "timeout":
				return "subscription-timeout";
			case "protocol-violation":
				return "protocol-violation";
			case "send-failed":
				return "send-failed";
			case "transfer-failed":
				return "transfer-failed";
			case "channel-closed":
			case "unavailable":
				return "content-lost";
			case "stopped":
				return "connection-lost";
		}
	}
	return contentOpenReason(error);
}

function pairFailure(result: PeerPairResult): PeerFailure {
	if (result.status === "denied") return { terminal: true, message: HOST_MESSAGE.pairingDenied };
	if (result.status === "timeout") return { terminal: true, message: HOST_MESSAGE.pairingExpired };
	if (result.status === "http_error" && result.httpStatus === 403) {
		return { terminal: true, message: HOST_MESSAGE.pairingDenied };
	}
	return { terminal: false, message: HOST_MESSAGE.notConnected };
}

const TERMINAL_ERROR_CODES: ReadonlySet<PeerTransportErrorCode> = new Set<PeerTransportErrorCode>([
	"CONSENT_LIMIT_REACHED",
	"IDENTITY_ENCODING_INVALID",
	"IDENTITY_KEY_MISMATCH",
	"INVALID_ARGUMENT",
	"PAIRING_DENIED",
	"PAIRING_HANDSHAKE_COUNT_MISMATCH",
	"PAIRING_KEY_ECHO_MISMATCH",
	"PAIRING_RESPONSE_INVALID",
	"PAIRING_RESPONSE_TOO_LARGE",
	"PEER_CERTIFICATE_INVALID",
	"PEER_CERTIFICATE_MISSING",
	"PEER_KEY_APPROVER_FAILED",
	"PEER_KEY_CANCELLED",
	"PEER_KEY_CHANGED",
	"PEER_KEY_DECISION_INVALID",
	"PEER_KEY_MISMATCH",
	"PEER_KEY_PROMPT_TIMEOUT",
	"PEER_KEY_REJECTED",
	"TRUST_STORE_FAILED",
	"UNSUPPORTED_KEY_TYPE",
]);

/**
 * Separate a terminal authorization/identity failure from a bounded network
 * loss. The distinction uses the transport's actual typed errors only; a
 * terminal failure never becomes an automatic retry loop.
 */
function describePeerFailure(error: unknown): PeerFailure {
	if (!isPeerTransportError(error)) return { terminal: false, message: HOST_MESSAGE.notConnected };
	const code = error.code;
	if (code === "APP_REFUSED") {
		return error.statusCode === 403
			? { terminal: true, message: HOST_MESSAGE.notAuthorized }
			: { terminal: false, message: HOST_MESSAGE.notConnected };
	}
	if (!TERMINAL_ERROR_CODES.has(code)) return { terminal: false, message: HOST_MESSAGE.notConnected };
	switch (code) {
		case "PEER_KEY_MISMATCH":
		case "PEER_KEY_CHANGED":
			return { terminal: true, message: HOST_MESSAGE.keyChanged };
		case "PEER_KEY_REJECTED":
		case "PEER_KEY_CANCELLED":
		case "PEER_KEY_PROMPT_TIMEOUT":
		case "PEER_KEY_DECISION_INVALID":
		case "PEER_KEY_APPROVER_FAILED":
			return { terminal: true, message: HOST_MESSAGE.approvalDeclined };
		case "TRUST_STORE_FAILED":
			return { terminal: true, message: HOST_MESSAGE.identityUnavailable };
		case "PAIRING_DENIED":
			return { terminal: true, message: HOST_MESSAGE.pairingDenied };
		default:
			return { terminal: true, message: HOST_MESSAGE.notConnected };
	}
}

function ownedTimer(operation: () => void, ms: number): NodeJS.Timeout {
	const timer = setTimeout(operation, ms);
	timer.unref?.();
	return timer;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = ownedTimer(() => reject(new Error("operation timed out")), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** One fixed, truthful pre-delegate refusal; never a claim that nothing happened later. */
function nativeInputNotSent(reason: NativeInputNotSentReason): NativeInputSendResult {
	return { status: "not-sent", reason };
}

/**
 * Exact structural equality of two observed input-mode sets. Geometry, text, and
 * viewport sequences are deliberately absent: ordinary output never invalidates
 * an otherwise identical written source, while a mode change does.
 */
function nativeInputModesEqual(left: TerminalInputModes, right: TerminalInputModes): boolean {
	return left.kittyFlags === right.kittyFlags
		&& left.applicationCursorKeys === right.applicationCursorKeys
		&& left.applicationKeypad === right.applicationKeypad
		&& left.bracketedPaste === right.bracketedPaste
		&& left.mouseTracking === right.mouseTracking
		&& left.modifyOtherKeys === right.modifyOtherKeys
		&& left.mouseEncoding === right.mouseEncoding;
}

/**
 * Whether two publications describe a DIFFERENT native input target: the written
 * source or the observed modes changed, including an A -> B -> A return. Text,
 * geometry, transfer, and sequence changes alone never count, so ordinary
 * output keeps typing eligible.
 */
function nativeInputTargetChanged(
	previous: SessionContentSnapshot["meta"],
	next: SessionContentSnapshot["meta"],
): boolean {
	const before = previous.inputSource;
	const after = next.inputSource;
	const sourceChanged = before === undefined || before === null || after === undefined || after === null
		? before !== after
		: !nativeIoSourceEquals(before, after);
	return sourceChanged || !nativeInputModesEqual(previous.inputModes, next.inputModes);
}

/**
 * Normalize one caller-supplied source into this process's own plain immutable
 * copy. The caller's object is arbitrary code: every field is read once, so a
 * getter cannot hand one value to a comparison and another to a write.
 */
function readNativeIoSourceValue(value: unknown): NativeIoInputSource | null {
	if (!isRecord(value)) return null;
	if (Object.prototype.hasOwnProperty.call(value, "phase")) {
		// The startup variant: one legal phase value and no tuple key at all.
		const phase = value.phase;
		const startupGeometry = value.geometry;
		if (phase !== "startup" || Object.prototype.hasOwnProperty.call(value, "nativeSession")) return null;
		if (!isRecord(startupGeometry)) return null;
		const startupRunId = value.hostRunId;
		const startupRowId = value.sessionId;
		const startupCols = startupGeometry.cols;
		const startupRows = startupGeometry.rows;
		const startupRevision = startupGeometry.revision;
		const startupViewerRevision = value.viewerRevision;
		const startupToken = value.sourceToken;
		if (typeof startupRunId !== "string" || typeof startupRowId !== "string") return null;
		if (typeof startupCols !== "number" || typeof startupRows !== "number"
			|| typeof startupRevision !== "number") return null;
		if (typeof startupViewerRevision !== "number" || typeof startupToken !== "string") return null;
		return Object.freeze({
			hostRunId: startupRunId,
			sessionId: startupRowId,
			phase: "startup" as const,
			geometry: Object.freeze({ cols: startupCols, rows: startupRows, revision: startupRevision }),
			viewerRevision: startupViewerRevision,
			sourceToken: startupToken,
		});
	}
	const native = value.nativeSession;
	const geometry = value.geometry;
	if (!isRecord(native) || !isRecord(geometry)) return null;
	const hostRunId = value.hostRunId;
	const sessionId = value.sessionId;
	const nativeSessionId = native.sessionId;
	const nativeEpoch = native.epoch;
	const cols = geometry.cols;
	const rows = geometry.rows;
	const geometryRevision = geometry.revision;
	const viewerRevision = value.viewerRevision;
	const sourceToken = value.sourceToken;
	if (typeof hostRunId !== "string" || typeof sessionId !== "string") return null;
	if (typeof nativeSessionId !== "string" || typeof nativeEpoch !== "number") return null;
	if (typeof cols !== "number" || typeof rows !== "number" || typeof geometryRevision !== "number") return null;
	if (typeof viewerRevision !== "number" || typeof sourceToken !== "string") return null;
	const conversation: NativeIoSource = Object.freeze({
		hostRunId,
		sessionId,
		nativeSession: Object.freeze({ sessionId: nativeSessionId, epoch: nativeEpoch }),
		geometry: Object.freeze({ cols, rows, revision: geometryRevision }),
		viewerRevision,
		sourceToken,
	});
	return conversation;
}

function isMouseTrackingModeValue(value: unknown): value is TerminalInputModes["mouseTracking"] {
	return value === "none" || value === "x10" || value === "vt200" || value === "drag" || value === "any";
}

function isModifyOtherKeysValue(value: unknown): value is TerminalInputModes["modifyOtherKeys"] {
	return value === 0 || value === 1 || value === 2;
}

function isMouseEncodingValue(value: unknown): value is TerminalInputModes["mouseEncoding"] {
	return value === "default" || value === "sgr" || value === "sgr-pixels";
}

function isNativeIoInputKindValue(value: unknown): value is NativeIoInputKind {
	return value === "keyboard" || value === "paste" || value === "mouse";
}

/** One validated input-mode set read exactly once from the caller's object. */
function readInputModesValue(value: unknown): TerminalInputModes | null {
	if (!isRecord(value)) return null;
	const kittyFlags = value.kittyFlags;
	const applicationCursorKeys = value.applicationCursorKeys;
	const applicationKeypad = value.applicationKeypad;
	const bracketedPaste = value.bracketedPaste;
	const mouseTracking = value.mouseTracking;
	const modifyOtherKeys = value.modifyOtherKeys;
	const mouseEncoding = value.mouseEncoding;
	if (typeof kittyFlags !== "number") return null;
	if (typeof applicationCursorKeys !== "boolean") return null;
	if (typeof applicationKeypad !== "boolean") return null;
	if (typeof bracketedPaste !== "boolean") return null;
	if (!isMouseTrackingModeValue(mouseTracking)) return null;
	if (!isModifyOtherKeysValue(modifyOtherKeys)) return null;
	if (!isMouseEncodingValue(mouseEncoding)) return null;
	return Object.freeze({
		kittyFlags,
		applicationCursorKeys,
		applicationKeypad,
		bracketedPaste,
		mouseTracking,
		modifyOtherKeys,
		mouseEncoding,
	});
}

/**
 * Normalize one caller request into plain immutable facts. A malformed value is
 * `null` and is a refusal, never a thrown or rejected call from this seam.
 */
function readNativeInputRequest(value: unknown): PeerNativeInputRequest | null {
	if (!isRecord(value)) return null;
	const hostId = value.hostId;
	const selectionGeneration = value.selectionGeneration;
	const subscriptionId = value.subscriptionId;
	const source = readNativeIoSourceValue(value.source);
	const inputModes = readInputModesValue(value.inputModes);
	const kind = value.kind;
	const text = value.text;
	if (typeof hostId !== "string" || typeof subscriptionId !== "string") return null;
	if (typeof selectionGeneration !== "number" || !Number.isSafeInteger(selectionGeneration)) return null;
	if (source === null || inputModes === null) return null;
	if (!isNativeIoInputKindValue(kind)) return null;
	if (typeof text !== "string") return null;
	return Object.freeze({ hostId, selectionGeneration, subscriptionId, source, inputModes, kind, text });
}

class OwnedPeerCoordinator implements
	PeerCoordinatorWithContent,
	PeerCoordinatorWithClose,
	PeerCoordinatorWithCreate,
	PeerCoordinatorWithRename,
	PeerCoordinatorWithSaved,
	PeerCoordinatorWithHistoryPolicy,
	PeerCoordinatorWithStorageRepair {
	readonly #options: PeerCoordinatorOptions;
	/**
	 * Explicit requester-side Saved opt-in, fixed for the lifecycle. False is the
	 * exact legacy viewer: no capability offer, no DTO description, inert controller.
	 */
	readonly #savedViewer: boolean;
	/**
	 * The owner's live remote-history delete exposure as last recorded, so only an
	 * ACTUAL change (including loss of the protected settings or close) is pushed to
	 * the existing owner bindings as a description.
	 */
	#remoteHistoryDeleteEffective = false;
	/**
	 * Sticky for the lifecycle: the protected preferences handle was poisoned by a
	 * publication failure at or after its commit point. The viewer native I/O and
	 * owner delete policies consult it (fail closed); unrelated preferences keep
	 * their existing persistence semantics.
	 */
	#preferencesHandleUnusable = false;
	/**
	 * Sanitized storage refusals observed in this lifecycle (Refs #494): which
	 * protected store refused, plus the fixed reason/object its original error
	 * carried. Closed vocabulary only; never a path, errno, SID, or native output.
	 */
	readonly #storageProblems: PeerUiStorageProblem[] = [];
	/**
	 * The last read-only eligibility assessment of the fixed storage targets, run
	 * only on a permission refusal or an explicit repair request (never at render
	 * time or on a timer). `#storageGeneration` advances with every assessment so
	 * a confirmation shown for one assessment can never authorize a later one.
	 */
	#storageAssessment: PeerStorageAssessment | null = null;
	#storageAssessmentFailed = false;
	#storageGeneration = 0;
	/** True only while the one synchronous repair call is running. */
	#storageRepairing = false;
	/**
	 * Every outgoing-destination or inbound-binding retirement that has started
	 * but not settled. It is registered synchronously, BEFORE the runtime or
	 * binding references are cleared, so a storage repair can never treat a
	 * connection that is still closing as inactive Network.
	 */
	readonly #pendingNetworkRetirements = new Set<Promise<void>>();
	/**
	 * Sticky for the lifecycle: a confirmed repair changed, or may have changed,
	 * protection. Network then stays unavailable until a deliberate host restart:
	 * no store is reopened, no saved intent is restored, and no command runs.
	 */
	#storageRestart: { readonly outcome: "repaired" | "partial"; readonly priorExposurePossible: boolean } | null = null;
	/** Set once `#start` has fully returned (not merely flagged started). */
	#startSettled = false;
	readonly #storageAssess: (options: PeerStorageRemediationOptions) => PeerStorageAssessment;
	readonly #storageRepair: (options: PeerStorageRemediationOptions) => PeerStorageRepairReport;
	readonly #consentWindowMs: number;
	readonly #autoReconnectDelaysMs: readonly number[];
	readonly #preferencesPermissions: PeerStatePermissionPolicy;
	readonly #peerStatePermissions: PeerStatePermissionPolicy | undefined;
	readonly #hostBounds: Partial<PeerTransportBounds>;
	readonly #clientBounds: Partial<PeerTransportBounds>;
	/**
	 * The caller's optional native IO proof/observation seam, or null for the exact
	 * legacy display-only coordinator. It is immutable for the whole lifecycle:
	 * there is no setter, registry, lease, or per-endpoint copy of it.
	 */
	readonly #nativeIo: PeerNativeIoCallbacks | null;
	/**
	 * Monotonic semantic invalidation of the native input target. It advances only
	 * when a publication changes the written source or the observed input modes, so
	 * an exact A -> B -> A change inside caller code is detectable by comparison and
	 * never revived by present equality. Ordinary output does not advance it. An
	 * actual change of this viewer's remote input/copy preference advances it too,
	 * so a preference Off -> On return inside caller code also never revives an
	 * admission.
	 */
	#nativeInputGeneration = 0;
	/**
	 * The effective viewer-side remote input/copy preference last applied, and its
	 * monotonic change generation. Both move ONLY together, synchronously, at the
	 * single place this coordinator's preferences or lifecycle change, so every
	 * actual change — including Off -> On — is a new generation.
	 */
	#viewerInputEffective = false;
	#viewerInputGeneration = 0;

	readonly #runtime = new Map<string, DestinationRuntime>();
	readonly #consents = new Map<string, PendingConsent>();
	readonly #inboundBindings = new Map<string, InboundBinding[]>();
	readonly #suppressionOverride = new Set<string>();
	/**
	 * Lifecycle-local receiving denials. A Revoke whose persistence fails must
	 * still be restrictive for this host lifetime, so the exact denied key is
	 * refused at every admission/metadata authorization until an explicit new
	 * inbound approval re-establishes it. This changes no persisted trust and no
	 * opposite direction.
	 */
	readonly #receiverDenials = new Set<string>();
	/** Every accepted start/perform and owned retirement; shutdown settles them. */
	readonly #activeOperations = new Set<Promise<void>>();
	/** Set when an owned retirement could not be confirmed; shutdown must reject. */
	#resourceCleanupFailed = false;
	/**
	 * Every listener retirement that has started but is not decided yet. It is an
	 * explicit barrier: no bind may start while one of these is still owned, and
	 * an undecided retirement must never be displayed as a settled stop.
	 */
	readonly #listenerRetirements = new Set<Promise<void>>();
	/**
	 * Sticky listener-retirement uncertainty. Set when an owned listener transport
	 * could not be confirmed stopped, so its port may still be bound by this
	 * process. It is never cleared inside this lifecycle: no later Enable may bind
	 * a second listener over that unknown state, the snapshot never claims a
	 * settled "off", and shutdown rejects instead of releasing ownership.
	 */
	#listenerRetirementUnconfirmed = false;

	#preferencesStore: PeerPreferencesStore | null = null;
	#trustStore: PeerStateStore | null = null;
	#bridge: RosterBridgeHost | null = null;
	/**
	 * Owner side of the native viewport content lane, created only when the caller
	 * supplied the same owning-host service as a content source. Creating it binds
	 * nothing and watches nothing: the transport only offers the content lane when
	 * this coordinator hands it a receiver, which happens only for an actual listener.
	 */
	#contentHost: SessionContentHost | null = null;
	/**
	 * Sticky content-retirement uncertainty. A content endpoint whose bounded local
	 * retirement could not be positively confirmed stays owned by this lifecycle:
	 * shutdown rejects instead of reporting a settled close, and a transport-level
	 * channel close is never taken as proof that the endpoint's own resources are gone.
	 */
	#contentCleanupUnconfirmed = false;
	/** Abort signal of the ONE pending content-channel open, if any. */
	#contentAbort: AbortController | null = null;
	readonly #content: ContentSelection = {
		desired: null,
		epoch: 0,
		spentEpoch: null,
		state: "none",
		reason: null,
		view: undefined,
		endpoint: null,
		retirement: null,
	};
	/** True while the ONE content reconciler task is running. */
	#contentPumping = false;
	/** True when the newest intent still needs a reconciler pass (latest-only work). */
	#contentDirty = false;
	readonly #contentController: PeerContentController = {
		selectContent: (target: PeerContentTarget | null): void => this.#selectContent(target),
		updateContentViewport: (viewport: PeerContentViewport): void => this.#updateContentViewport(viewport),
		readContent: (): PeerContentObservation => this.#readContent(),
		readNativeInputTarget: (): PeerNativeInputTarget | undefined => this.#readNativeInputTarget(),
		sendNativeInput: (request: PeerNativeInputRequest): Promise<NativeInputSendResult> => this.#sendNativeInput(request),
		readViewerNativeInputPolicy: (): PeerViewerNativeInputPolicy => this.#readViewerNativeInputPolicy(),
	};
	/**
	 * The ONE owner-routed Close controller: a property of this coordinator rather
	 * than a second manager, needing no selection, viewer, lease, or on-demand
	 * connection.
	 */
	readonly #ownerCloseController: PeerCloseController = {
		closeSession: (target: PeerCloseTarget): Promise<PeerCloseResult> => this.#closeSession(target),
	};
	/**
	 * The ONE rowless owner-create controller: a property of this coordinator rather
	 * than a second manager, needing no selection, row, viewer, lease, or on-demand
	 * connection. The caller's own written-form proof is REQUIRED for every request.
	 */
	readonly #ownerCreateController: PeerCreateController = {
		createSession: (target: PeerCreateTarget, options: PeerCreateOptions): Promise<PeerCreateResult> =>
			this.#createSession(target, options),
	};
	/**
	 * The ONE owner-routed rename controller: a property of this coordinator rather
	 * than a second manager, needing no selection, open form, controller lease, or
	 * on-demand connection. The caller's own written-editor/name proof is REQUIRED for
	 * every request, and this coordinator holds no copy of any name.
	 */
	readonly #ownerRenameController: PeerRenameController = {
		renameSession: (target: PeerRenameTarget, options: PeerRenameOptions): Promise<PeerRenameResult> =>
			this.#renameSession(target, options),
	};
	/**
	 * The ONE requester-side Saved controller: a property of this coordinator rather
	 * than a second manager, needing no selection, row, native tuple, focus, lease,
	 * or on-demand connection. The caller's own proof is REQUIRED for every request.
	 */
	readonly #ownerSavedController: PeerSavedController = Object.freeze({
		list: (target: PeerSavedListTarget, options: PeerSavedControllerOptions) =>
			this.#savedRequest("list", target, options) as Promise<PeerSavedResult<OwnerSavedWindowFacts>>,
		search: (target: PeerSavedSearchTarget, options: PeerSavedControllerOptions) =>
			this.#savedRequest("search", target, options) as Promise<PeerSavedResult<OwnerSavedWindowFacts>>,
		window: (target: PeerSavedWindowTarget, options: PeerSavedControllerOptions) =>
			this.#savedRequest("window", target, options) as Promise<PeerSavedResult<OwnerSavedWindowFacts>>,
		resume: (target: PeerSavedResumeTarget, options: PeerSavedControllerOptions) =>
			this.#savedRequest("resume", target, options) as Promise<PeerSavedResult<OwnerSavedResumeFacts>>,
		remove: (target: PeerSavedDeleteTarget, options: PeerSavedControllerOptions) =>
			this.#savedRequest("remove", target, options) as Promise<PeerSavedResult<OwnerSavedDeleteFacts>>,
	});
	#host: PeerHost | null = null;
	#preferences: PeerPreferences | null = null;
	#preferencesLoaded = false;
	#listener: ListenerSnapshot = { state: "off", host: null, port: null, message: null };
	#listenerEpoch = 0;
	/** Fences one listener command's intent across every await it performs. */
	#listenerIntentEpoch = 0;
	#transientNotice: string | null = null;
	#snapshot: PeerUiSnapshot;
	#revision = 0;
	#started = false;
	#startPromise: Promise<void> | null = null;
	#closed = false;
	#tearingDown = false;
	#closePromise: Promise<void> | null = null;
	#emitting = false;
	#emitAgain = false;

	constructor(options: PeerCoordinatorOptions) {
		this.#options = options;
		const hooks = options.testHooks ?? {};
		this.#consentWindowMs = hooks.consentWindowMs ?? PEER_UI_CONSENT_WINDOW_MS;
		this.#autoReconnectDelaysMs = hooks.autoReconnectDelaysMs ?? DEFAULT_AUTO_RECONNECT_DELAYS_MS;
		this.#preferencesPermissions = hooks.preferencesPermissions ?? createPeerStatePermissionPolicy();
		this.#peerStatePermissions = hooks.peerStatePermissions;
		this.#hostBounds = hooks.hostBounds ?? {};
		this.#clientBounds = hooks.clientBounds ?? {};
		this.#storageAssess = hooks.storageRemediation?.assess
			?? ((remediation) => assessPeerStorageProtection(remediation));
		this.#storageRepair = hooks.storageRemediation?.repair
			?? ((remediation) => repairPeerStorageProtection(remediation));
		// Both callbacks were validated together at construction admission; a missing
		// option keeps the exact legacy display-only coordinator.
		this.#nativeIo = options.nativeIo === undefined
			? null
			: Object.freeze({ authorizeInput: options.nativeIo.authorizeInput, onCopy: options.nativeIo.onCopy });
		// Validated at construction admission: only a real `true` opts in.
		this.#savedViewer = options.savedViewer === true;
		this.#snapshot = this.#buildSnapshot(0);
	}

	/**
	 * Open the coordinator's protected stores and restore the roles the operator
	 * saved before. A fresh/default-disabled document performs no network action;
	 * saved hosting intent may bind the saved listener and eligible saved Auto
	 * reconnect may connect, without creating an identity or pairing.
	 */
	start(): Promise<void> {
		// After close admission is latched: a later start is inert, not a restart.
		if (this.#closed) return Promise.resolve();
		if (this.#startPromise === null) this.#startPromise = this.#track(this.#start());
		return this.#startPromise;
	}

	/**
	 * The one selected-content controller. It exists from construction, before any
	 * selection and before startup, and using it creates no channel, watch, viewer,
	 * identity, file, or timer until an explicit selection targets an already
	 * connected destination whose current roster really holds that run and row.
	 */
	get content(): PeerContentController {
		return this.#contentController;
	}

	/**
	 * The one Close controller. It exists from construction and needs nothing
	 * selected or displayed: a request addresses one already connected destination
	 * by its own saved handle plus the exact owner run and row the last roster
	 * observation named.
	 */
	get ownerClose(): PeerCloseController {
		return this.#ownerCloseController;
	}

	/**
	 * The one rowless Create controller. It exists from construction and needs
	 * nothing selected or displayed: a request addresses one already connected
	 * destination by its own saved handle plus the exact owner run and workspace its
	 * last written form destination named, and needs no row to exist yet.
	 */
	get ownerCreate(): PeerCreateController {
		return this.#ownerCreateController;
	}

	/**
	 * The one owner-routed Rename controller. It exists from construction and needs
	 * nothing selected, displayed, or open: a request addresses one already connected
	 * destination by its own saved handle plus the exact owner run, row, and native
	 * conversation tuple its LAST observation named, and the new name the caller's own
	 * written editor holds. This coordinator keeps no name, no caption, and no
	 * per-destination rename state of its own.
	 */
	get ownerRename(): PeerRenameController {
		return this.#ownerRenameController;
	}

	/**
	 * The one requester-side Saved controller. It exists from construction and
	 * needs nothing selected, focused, or displayed: a request addresses one
	 * already connected destination by its own saved handle plus the exact owner
	 * run its last observation named (an empty owner roster is a valid target).
	 * Without the explicit `savedViewer` opt-in it is inert.
	 */
	get ownerSaved(): PeerSavedController {
		return this.#ownerSavedController;
	}

	read(): PeerUiSnapshot {
		return this.#snapshot;
	}

	readRemoteHistoryDeleteEnabled(): boolean {
		if (this.#closed || this.#tearingDown || this.#storageRestart !== null) return false;
		// Protected settings that became unavailable mid-lifecycle (a poisoned
		// handle) never keep exposing remote deletion from a cached value.
		if (this.#preferencesHandleUnusable) return false;
		const preferences = this.#preferences;
		return preferences !== null && preferences.remoteHistoryDeleteEnabled === true;
	}

	decideConsent(id: string, decision: "approve" | "deny"): boolean {
		if (this.#closed || typeof id !== "string") return false;
		if (decision !== "approve" && decision !== "deny") return false;
		const entry = this.#consents.get(id);
		if (entry === undefined) return false;
		if (!entry.live()) {
			this.#consents.delete(id);
			this.#emit();
			return false;
		}
		const applied = entry.apply(decision);
		if (this.#consents.get(id) === entry) {
			this.#consents.delete(id);
			this.#emit();
		}
		return applied;
	}

	perform(command: PeerUiCommand): Promise<void> {
		// Admission is latched synchronously by close(); a later action is inert.
		if (this.#closed) return Promise.resolve();
		return this.#track(this.#perform(command));
	}

	/**
	 * Register owned work so shutdown can settle it before resolving. The caller
	 * still observes the real outcome; the tracked view only never rejects.
	 */
	#track<T>(operation: Promise<T>): Promise<T> {
		const settled = operation.then(() => undefined, () => undefined);
		this.#activeOperations.add(settled);
		void settled.then(() => this.#activeOperations.delete(settled));
		return operation;
	}

	/**
	 * Expected action failures are reported through the snapshot, never as a
	 * rejection Main would have to interpret; only an unexpected implementation
	 * fault escapes.
	 */
	async #perform(command: PeerUiCommand): Promise<void> {
		if (this.#closed) return;
		if (!isRecord(command) || typeof command.type !== "string") {
			this.#transientNotice = NOTICE.invalidRequest;
			this.#emit();
			return;
		}
		this.#transientNotice = null;
		if (this.#storageRestart !== null) {
			// After a repair that changed (or may have changed) protection, nothing
			// runs before a deliberate restart: no store reopens and no intent applies.
			this.#transientNotice = NOTICE.storageRestartRequired;
			this.#emit();
			return;
		}
		try {
			switch (command.type) {
				case "peer-listener":
					await this.#commandListener(command);
					return;
				case "peer-auto-reconnect":
					this.#commandAutoReconnect(command);
					return;
				case "peer-bell":
					this.#commandBell(command);
					return;
				case "peer-viewer-native-input":
					this.#commandViewerNativeInput(command);
					return;
				case "peer-remote-history-delete":
					this.#commandRemoteHistoryDelete(command);
					return;
				case "peer-add":
					this.#commandAdd(command);
					return;
				case "peer-connect":
					await this.#commandConnect(command);
					return;
				case "peer-disconnect":
					this.#commandDisconnect(command);
					return;
				case "peer-remove":
					this.#commandRemove(command);
					return;
				case "peer-revoke":
					this.#commandRevoke(command);
					return;
				default:
					this.#transientNotice = NOTICE.invalidRequest;
					this.#emit();
			}
		} catch {
			// A closed/tearing-down coordinator owes nothing to this action.
			if (this.#closed || this.#tearingDown) return;
			this.#transientNotice = NOTICE.actionFailed;
			this.#emit();
		}
	}

	/**
	 * Latch admission synchronously, cancel every owned decision/timer/attempt,
	 * then resolve only once local network resources are confirmed settled. A
	 * rejection is the fixed {@link PeerCoordinatorCloseError}; it is never a
	 * fabricated success, and it never waits for remote work or receipt.
	 */
	close(): Promise<void> {
		if (this.#closePromise !== null) return this.#closePromise;
		this.#closed = true;
		// A closing coordinator forwards nothing: the viewer preference is now
		// effectively Off, which is an actual change for any in-flight admission.
		this.#noteViewerInputPolicy();
		// A closing owner exposes no remote deletion either: the existing bindings
		// are told before teardown retires them, so no delete proof spans the close.
		this.#noteRemoteHistoryPolicy();
		this.#transientNotice = null;
		this.#closePromise = this.#teardown();
		return this.#closePromise;
	}

	// ---------------------------------------------------------------- lifecycle

	async #start(): Promise<void> {
		if (this.#closed) return;
		this.#emit();

		try {
			const store = openPeerPreferencesStoreWithPermissions({
				agentDir: this.#options.agentDir,
				permissions: this.#preferencesPermissions,
			});
			this.#preferencesStore = store;
			// Only a genuinely absent document is the in-memory defaults (both
			// default-on flags on); an unreadable or invalid one throws below.
			this.#applyPreferences(store.read() ?? DEFAULT_PEER_PREFERENCES);
			this.#preferencesLoaded = true;
		} catch (error) {
			// The original refusal keeps its own sanitized diagnostic: why it was
			// refused and which fixed object, never a default.
			this.#noteStorageRefusal("settings", error, false);
			this.#preferencesStore = null;
			// Unavailable settings are never defaults: viewer forwarding and the
			// owner history policy both stay off.
			this.#applyPreferences(null);
			this.#preferencesLoaded = false;
		}

		try {
			// The product path uses the existing safe default entry point; the
			// injected policy exists only for synthetic failure fixtures.
			this.#trustStore = this.#peerStatePermissions === undefined
				? openPeerStateStore({ agentDir: this.#options.agentDir })
				: openPeerStateStoreWithPermissions({
					agentDir: this.#options.agentDir,
					permissions: this.#peerStatePermissions,
				});
		} catch (error) {
			this.#noteStorageRefusal("trust", error, false);
			this.#trustStore = null;
		}
		// One read-only eligibility assessment, only for a permission refusal.
		this.#assessStorageIfApplicable();

		try {
			this.#bridge = createRosterBridgeHost({
				inventory: this.#options.inventory,
				authorizePeer: (peerKey) => this.#authorizePeer(peerKey),
				...(this.#options.closeOwnedSession === undefined
					? {}
					: { closeOwnedSession: this.#options.closeOwnedSession }),
				...(this.#options.createOwnedSession === undefined
					? {}
					: { createOwnedSession: this.#options.createOwnedSession }),
				// The rename provider is handed over exactly like Close and Create: never
				// wrapped, never called here, and passed only when the caller really supplied
				// one, so an owner that holds no rename seam never acknowledges the capability.
				...(this.#options.renameOwnedSession === undefined
					? {}
					: { renameOwnedSession: this.#options.renameOwnedSession }),
				// The owner Saved pair exists only with the caller's REAL view factory:
				// the factory itself (never wrapped or called here; the bridge creates one
				// view per binding lazily after an authorized request) plus this
				// coordinator's live, fail-closed delete policy. There is no no-op provider
				// and no default permission.
				...(this.#options.savedCatalogViewFactory === undefined
					? {}
					: {
						savedCatalogView: this.#options.savedCatalogViewFactory,
						remoteHistoryDeleteExposed: (): boolean => this.readRemoteHistoryDeleteEnabled(),
					}),
			});
		} catch {
			this.#bridge = null;
		}

		// Constructing the owner-side content endpoint allocates no socket, watch,
		// viewer, or timer; it becomes reachable only through a listener this
		// coordinator actually starts, and only when the caller supplied its own
		// owning-host service as the content source. Without it the transport keeps
		// refusing content upgrades, exactly as a metadata-only host does today.
		if (this.#options.contentSource !== undefined) {
			// The owner endpoint's own native IO support is enabled ONLY for an explicit
			// callback binding. It grants nothing and authorizes nothing by itself: that
			// endpoint still proves its own current provider, receiving grant, and lower
			// source for every protected request, independently of this side's outgoing
			// written-source proof. Without explicit callbacks the options are byte-for-
			// byte the previous ones.
			const hostOptions: OwnerContentHostOptions = {
				source: this.#options.contentSource,
				authorizePeer: (peerKey) => this.#authorizeContentPeer(peerKey),
				...(this.#nativeIo === null ? {} : { nativeIo: true }),
			};
			try {
				this.#contentHost = createSessionContentHost(hostOptions);
			} catch {
				this.#contentHost = null;
			}
		}

		this.#started = true;
		this.#emit();

		try {
			const preferences = this.#preferences;
			if (preferences !== null && preferences.hosting.enabled) await this.#restoreListener();
			// Close may have latched while starting; owned roles are never applied then.
			if (this.#closed) return;
			if (preferences !== null && preferences.autoReconnect) this.#scheduleEligibleAutoAttempts();
			this.#emit();
		} finally {
			this.#startSettled = true;
		}
	}

	async #teardown(): Promise<void> {
		// `close()` already latched `#closed` synchronously before calling this.
		this.#tearingDown = true;
		let confirmed = true;

		// 1. Cancel owned human decisions (key approvals and pending incoming
		//    handles) and every automatic attempt/timer before any await.
		for (const entry of [...this.#consents.values()]) entry.release();
		this.#consents.clear();
		// The selected content stream is local state too: its display clears and its
		// endpoint is retired before the first await, so no continuation can publish a
		// view after close has latched admission.
		this.#clearContentForShutdown();
		for (const runtime of this.#runtime.values()) {
			runtime.epoch += 1;
			if (runtime.retryTimer !== null) {
				clearTimeout(runtime.retryTimer);
				runtime.retryTimer = null;
			}
			const abort = runtime.abort;
			runtime.abort = null;
			abort?.abort();
			runtime.mode = null;
			runtime.state = "disconnected";
			runtime.message = null;
			// The final display state is last-observed, never fabricated current.
			this.#markRosterStale(runtime);
		}

		// 2. Settle this side's local network resources. Listener teardown is bounded
		//    by the same owned-settlement deadline as every other retirement, so a
		//    close whose callback never arrives becomes a fixed rejection instead of
		//    an unbounded shutdown; the desired off intent is still persisted by the
		//    command that asked for it.
		this.#retireAllDestinations();
		if (!await this.#stopListener()) confirmed = false;
		const bridge = this.#bridge;
		this.#bridge = null;
		if (bridge !== null) {
			try {
				await bridge.stopAll();
			} catch {
				confirmed = false;
			}
		}
		// The content endpoint retires its own watch and viewer within its own bounded
		// API. A rejected `stopAll()` means at least one binding's local retirement is
		// NOT confirmed: the endpoint retains that evidence and refuses further
		// attaches, and this coordinator keeps the reference and rejects shutdown
		// instead of claiming a settled close. A fulfilled one is not treated as remote
		// receipt — nothing here ever waits for a peer.
		const contentHost = this.#contentHost;
		if (contentHost !== null) {
			let contentSettled = true;
			try {
				await contentHost.stopAll();
			} catch {
				contentSettled = false;
			}
			if (contentSettled) {
				this.#contentHost = null;
			} else {
				confirmed = false;
				this.#contentCleanupUnconfirmed = true;
			}
		}

		// 3. Wait for every accepted start/perform and every owned retirement to
		//    finish, so no continuation can create or retain a resource after close
		//    resolves. This waits for LOCAL settlement only; remote receipt and
		//    remote work are never awaited. A bounded wait turns an unconfirmed
		//    continuation into a fixed rejection instead of an unbounded shutdown.
		if (!await this.#settleInFlightOperations()) confirmed = false;
		// A continuation that raced the first sweep may have produced a resource;
		// retire it and barrier again before deciding the outcome.
		this.#retireAllDestinations();
		if (!await this.#stopListener()) confirmed = false;
		if (!await this.#settleInFlightOperations()) confirmed = false;

		// 4. Publish the settled local display state (listener off, no connected
		//    host) while the stores are still readable; close never claims a
		//    remote receipt or a remote session outcome.
		this.#emitFinal();

		// 5. Storage handles are ours and close synchronously.
		this.#trustStore?.close();
		this.#trustStore = null;
		this.#preferencesStore?.close();
		this.#preferencesStore = null;

		const resourcesSettled = [...this.#runtime.values()].every((runtime) => (
			runtime.viewer === null && runtime.channel === null && runtime.client === null
		));
		const settled =
			confirmed
			&& !this.#resourceCleanupFailed
			&& !this.#listenerRetirementUnconfirmed
			&& !this.#contentCleanupUnconfirmed
			&& this.#content.endpoint === null
			&& resourcesSettled
			&& this.#host === null
			&& this.#bridge === null
			&& this.#contentHost === null
			&& this.#consents.size === 0
			&& this.#listener.state !== "listening";
		if (!settled) throw new PeerCoordinatorCloseError();
	}

	/** Bounded barrier over every accepted start/perform and owned retirement. */
	async #settleInFlightOperations(): Promise<boolean> {
		const pending = [...this.#activeOperations];
		if (pending.length === 0) return true;
		return this.#settledWithinDeadline(Promise.all(pending));
	}

	/**
	 * Race owned work against the one existing ownership deadline. `true` means it
	 * settled; `false` is the deadline expiring, which is unconfirmed cleanup.
	 */
	async #settledWithinDeadline(work: Promise<unknown>): Promise<boolean> {
		let timer: NodeJS.Timeout | null = null;
		const timedOut = new Promise<boolean>((resolve) => {
			timer = ownedTimer(() => resolve(false), SHUTDOWN_OPERATION_SETTLE_TIMEOUT_MS);
		});
		const settled = work.then(() => true, () => true);
		const outcome = await Promise.race([settled, timedOut]);
		if (timer !== null) clearTimeout(timer);
		return outcome;
	}

	/**
	 * Bounded barrier over every listener retirement that is still undecided. A
	 * new bind must settle these first, so a Disable whose close is still pending
	 * can never be bypassed by a concurrent Enable. Deadline expiry decides the
	 * outcome as sticky unconfirmed cleanup and stops waiting for it; the
	 * transport stays owned until the process ends and is never reported settled.
	 */
	async #settleListenerRetirements(): Promise<boolean> {
		const pending = [...this.#listenerRetirements];
		if (pending.length === 0) return true;
		const settled = await this.#settledWithinDeadline(Promise.all(pending));
		if (settled) return true;
		this.#noteListenerRetirementUnconfirmed();
		this.#listenerRetirements.clear();
		return false;
	}

	/** True only while the newest listener command (or startup restore) owns intent. */
	#listenerIntentCurrent(intent: number): boolean {
		return !this.#closed && this.#listenerIntentEpoch === intent;
	}

	/** Report a listener failure only for the command/restore that still owns intent. */
	#setListenerError(intent: number, message: string): void {
		if (!this.#listenerIntentCurrent(intent)) return;
		this.#listener = { state: "error", host: null, port: null, message };
		this.#emit();
	}

	async #restoreListener(): Promise<void> {
		// Startup restore takes the current intent; any later listener command
		// invalidates it so a Disable that lands during startup still wins.
		const intent = this.#listenerIntentEpoch;
		const preferences = this.#preferences;
		if (preferences === null) return;
		const hosting = preferences.hosting;
		if (hosting.bindHost === null || hosting.bindPort === null) {
			this.#setListenerError(intent, NOTICE.listenerBindFailed);
			return;
		}
		const store = this.#trustStore;
		if (store === null) {
			this.#setListenerError(intent, NOTICE.trustUnavailable);
			return;
		}
		let identityMissing = false;
		try {
			identityMissing = store.identity === null;
		} catch {
			this.#setListenerError(intent, NOTICE.trustUnavailable);
			return;
		}
		if (identityMissing) {
			// Startup never generates an identity; only explicit Enable/Connect does.
			this.#setListenerError(intent, NOTICE.listenerIdentityMissing);
			return;
		}
		await this.#startListener(hosting.bindHost, hosting.bindPort, intent);
	}

	async #startListener(host: string, port: number, intent: number): Promise<void> {
		// An earlier listener whose retirement is still owned — or was never
		// confirmed — may still hold its port. Settling it first (bounded) keeps a
		// new bind from racing cleanup, and the sticky check is repeated after every
		// await so an outcome that lands meanwhile still blocks this bind.
		if (this.#listenerRetirementUnconfirmed) {
			if (this.#listenerIntentCurrent(intent)) this.#emit();
			return;
		}
		if (!await this.#stopListener()) {
			// The barrier already published the sticky failure; nothing may be
			// created or bound over the unknown port.
			if (this.#listenerIntentCurrent(intent)) this.#emit();
			return;
		}
		if (this.#listenerRetirementUnconfirmed || this.#listenerRetirements.size > 0) {
			if (this.#listenerIntentCurrent(intent)) this.#emit();
			return;
		}
		// A Disable (or any newer listener command) that landed during teardown
		// invalidates this Enable before it can create or bind anything.
		if (!this.#listenerIntentCurrent(intent)) return;
		const store = this.#trustStore;
		if (store === null) {
			this.#setListenerError(intent, NOTICE.trustUnavailable);
			return;
		}
		let identity: OwnedPeerIdentity;
		try {
			const current = store.identity;
			if (current === null) {
				this.#setListenerError(intent, NOTICE.listenerIdentityMissing);
				return;
			}
			identity = current;
		} catch {
			this.#setListenerError(intent, NOTICE.trustUnavailable);
			return;
		}
		if (!this.#listenerIntentCurrent(intent)) return;

		const epoch = ++this.#listenerEpoch;
		this.#listener = { state: "starting", host: null, port: null, message: null };
		this.#emit();

		let hostInstance: PeerHost;
		// The content lane is offered only while this coordinator owns an owner-side
		// content endpoint. Without one the transport keeps its existing
		// `unsupported_subprotocol` refusal, so an opt-out host stays metadata-only and
		// no content channel can ever reach a receiver.
		const contentHost = this.#contentHost;
		try {
			hostInstance = createPeerHost({
				identity,
				// The transport answers a receiving-side write failure with its own
				// fixed pairing failure, so the ORIGINAL refusal's sanitized diagnostic
				// is recorded at the write itself and the same error is rethrown.
				acceptedPeers: {
					get: (keyId: string) => store.acceptedPeers.get(keyId),
					set: (record: AcceptedPeerRecord) => {
						try {
							store.acceptedPeers.set(record);
						} catch (error) {
							this.#noteStorageRefusal("trust", error, true);
							throw error;
						}
					},
					delete: (keyId: string) => store.acceptedPeers.delete(keyId),
				},
				grants: {
					get: (peerKeyId: string) => store.grants.get(peerKeyId),
					set: (record: DirectionalGrantRecord) => {
						try {
							store.grants.set(record);
						} catch (error) {
							this.#noteStorageRefusal("trust", error, true);
							throw error;
						}
					},
					delete: (peerKeyId: string) => store.grants.delete(peerKeyId),
				},
				onPairingRequest: (request) => this.#onPairingRequest(request),
				onAppChannel: (channel) => this.#onAppChannel(channel),
				...(contentHost === null
					? {}
					: { onContentChannel: (channel: PeerByteChannel): void => this.#onContentChannel(contentHost, channel) }),
				bounds: {
					consentTimeoutMs: this.#consentWindowMs,
					// The first-use server-key decision happens BEFORE any HTTP byte is
					// written, so the server's own header/request timers must cover the
					// whole human window. These are finite and coordinator-specific;
					// global transport defaults are unchanged.
					httpHeadersTimeoutMs: this.#consentWindowMs + PEER_UI_PAIRING_RESPONSE_OVERHEAD_MS,
					requestTimeoutMs: this.#consentWindowMs + PEER_UI_PAIRING_RESPONSE_OVERHEAD_MS,
					...this.#hostBounds,
				},
			});
		} catch {
			this.#setListenerError(intent, NOTICE.listenerBindFailed);
			return;
		}
		this.#host = hostInstance;

		let bound: { host: string; port: number };
		try {
			bound = await withDeadline(hostInstance.listen({ host, port }), LISTENER_START_TIMEOUT_MS);
		} catch {
			if (this.#listenerEpoch === epoch) this.#setListenerError(intent, NOTICE.listenerBindFailed);
			if (this.#host === hostInstance) this.#host = null;
			this.#retireDetachedListener(hostInstance);
			return;
		}
		if (this.#listenerEpoch !== epoch || !this.#listenerIntentCurrent(intent)) {
			if (this.#host === hostInstance) this.#host = null;
			this.#retireDetachedListener(hostInstance);
			return;
		}
		this.#listener = { state: "listening", host: bound.host, port: bound.port, message: null };
		this.#emit();
	}

	/**
	 * Take every inbound binding currently owned by the listener transport — metadata
	 * and content lane alike. The caller retires them as part of the same owned,
	 * settled teardown, and re-registers any whose retirement was not confirmed.
	 */
	#takeInboundBindings(): InboundBinding[] {
		const bindings: InboundBinding[] = [];
		for (const list of this.#inboundBindings.values()) bindings.push(...list);
		this.#inboundBindings.clear();
		return bindings;
	}

	/**
	 * Re-register bindings whose bounded retirement could not be confirmed, so the
	 * next listener sweep or shutdown still owns them. Ownership is released only by a
	 * positively confirmed settlement, never by an error being noticed and dropped.
	 */
	#retainInboundBindings(bindings: readonly InboundBinding[]): void {
		for (const binding of bindings) {
			const keyId = binding.peerKey.keyId;
			const list = this.#inboundBindings.get(keyId) ?? [];
			if (!list.includes(binding)) list.push(binding);
			this.#inboundBindings.set(keyId, list);
		}
	}

	/**
	 * Register one admitted inbound binding under its exact verified key id. Its
	 * `closed` promise settles only after that endpoint's own bounded retirement, so a
	 * fulfillment is the only thing that releases local ownership here; a rejection is
	 * recorded as sticky unconfirmed cleanup — the binding stays registered, a later
	 * sweep still owns it, shutdown rejects, and no further listener bind is allowed
	 * over resources this process cannot prove it released.
	 */
	#trackInboundBinding(keyId: string, binding: InboundBinding): void {
		const list = this.#inboundBindings.get(keyId) ?? [];
		list.push(binding);
		this.#inboundBindings.set(keyId, list);
		void binding.closed.then(
			() => this.#releaseInboundBinding(keyId, binding),
			() => {
				this.#resourceCleanupFailed = true;
				this.#noteListenerRetirementUnconfirmed();
				this.#retainInboundBindings([binding]);
				this.#emit();
			},
		);
	}

	#releaseInboundBinding(keyId: string, binding: InboundBinding): void {
		const current = this.#inboundBindings.get(keyId);
		if (current === undefined) return;
		const index = current.indexOf(binding);
		if (index >= 0) current.splice(index, 1);
		if (current.length === 0) this.#inboundBindings.delete(keyId);
	}

	/**
	 * Start one listener retirement synchronously, so the pending state is visible
	 * to every barrier before any caller awaits it, and return whether it was
	 * positively confirmed.
	 */
	#startListenerRetirement(
		hostInstance: PeerHost | null,
		bindings: readonly InboundBinding[],
	): Promise<boolean> {
		const retirement = this.#retireListener(hostInstance, bindings);
		const pending = retirement.then(() => undefined, () => undefined);
		this.#listenerRetirements.add(pending);
		void pending.then(() => this.#listenerRetirements.delete(pending));
		return retirement;
	}

	/**
	 * Retire one listener transport and its bindings as owned work. `true` only
	 * when the transport is positively stopped; anything else is recorded as the
	 * sticky lifecycle uncertainty rather than discarded. The display is never
	 * touched here: only a settled barrier may publish a stop.
	 */
	async #retireListener(
		hostInstance: PeerHost | null,
		bindings: readonly InboundBinding[],
	): Promise<boolean> {
		let confirmed = true;
		if (hostInstance !== null) {
			try {
				await hostInstance.close();
			} catch {
				confirmed = false;
			}
			// `close()` caches its own outcome; a still-listening server is not a
			// confirmed teardown.
			if (hostInstance.listening) confirmed = false;
		}
		const results = await Promise.allSettled(bindings.map((binding) => binding.stop()));
		if (results.some((result) => result.status === "rejected")) confirmed = false;
		// A binding that refused to settle is still owned: put it back so a later sweep
		// or shutdown retires it again rather than forgetting it with the failure.
		const retained = bindings.filter((_binding, index) => results[index]?.status === "rejected");
		if (retained.length > 0) this.#retainInboundBindings(retained);
		if (!confirmed) this.#noteListenerRetirementUnconfirmed();
		return confirmed;
	}

	/**
	 * Retire a listener transport that never became (or no longer owns) the
	 * current listener, as tracked owned work. Its bounded settlement starts here
	 * too: a held close must reach the sticky deadline even when no later listener
	 * command or shutdown ever runs, so the snapshot can never keep reporting a
	 * settled "off" over a transport that is still bound.
	 */
	#retireDetachedListener(hostInstance: PeerHost): void {
		this.#startListenerRetirement(hostInstance, []);
		void this.#settleListenerRetirements().then(() => this.#emit());
	}

	/**
	 * Record — never soften — a listener retirement the transport did not confirm.
	 * The last positively observed binding is kept because that port may still be
	 * held; the state is an error, never a settled "off".
	 */
	#noteListenerRetirementUnconfirmed(): void {
		this.#listenerRetirementUnconfirmed = true;
		this.#listener = {
			state: "error",
			// The last positively observed binding is kept (a null one stays null):
			// that address/port may still be owned by this process.
			host: this.#listener.host,
			port: this.#listener.port,
			message: NOTICE.listenerCloseUnconfirmed,
		};
	}

	/**
	 * Detach the current listener transport and start its owned retirement. The
	 * display keeps its last confirmed state until a settled barrier decides the
	 * outcome, so no concurrent redraw can publish a stop that is still owned.
	 */
	#detachListener(): void {
		this.#listenerEpoch += 1;
		const hostInstance = this.#host;
		this.#host = null;
		const bindings = this.#takeInboundBindings();
		if (hostInstance === null && bindings.length === 0) return;
		this.#startListenerRetirement(hostInstance, bindings);
	}

	/**
	 * Stop the listener and retire its bindings; false means unconfirmed. Every
	 * owned listener retirement (this one and any detached earlier one) is settled
	 * under the existing deadline before a stop may be published or a bind allowed.
	 * The sweep repeats because a superseded start can still acquire its transport
	 * while the barrier is awaited; each detach re-fences that start's epoch, so the
	 * loop terminates once nothing owned remains.
	 */
	async #stopListener(): Promise<boolean> {
		do {
			this.#detachListener();
			if (!await this.#settleListenerRetirements()) return false;
			if (this.#listenerRetirementUnconfirmed) return false;
		} while (
			this.#host !== null
			|| this.#inboundBindings.size > 0
			|| this.#listenerRetirements.size > 0
		);
		// Every owned retirement is positively settled, so this stop is real.
		this.#listener = { state: "off", host: null, port: null, message: null };
		return true;
	}

	// ------------------------------------------------------------ receiving side

	/**
	 * Incoming content authority is the SAME current directional receiving grant as
	 * metadata, plus the lifecycle the grant read alone does not observe: a closing
	 * or tearing-down coordinator authorizes nothing new. It never reads the opposite
	 * direction, never consults a selected outgoing target, and creates no grant.
	 */
	#authorizeContentPeer(peerKey: PeerKey): boolean {
		if (this.#closed || this.#tearingDown) return false;
		return this.#authorizePeer(peerKey);
	}

	#authorizePeer(peerKey: PeerKey): boolean {
		if (this.#receiverDenials.has(peerKey.keyId)) return false;
		const store = this.#trustStore;
		if (store === null) return false;
		try {
			const identity = store.identity;
			if (identity === null) return false;
			const accepted = store.acceptedPeers.get(peerKey.keyId);
			const grant = store.grants.get(peerKey.keyId);
			return (
				accepted !== undefined
				&& accepted.receiverKeyId === identity.key.keyId
				&& peerKeysEqual(accepted.key, peerKey)
				&& grant !== undefined
				&& grant.receiverKeyId === identity.key.keyId
				&& grant.peerKeyId === peerKey.keyId
			);
		} catch {
			return false;
		}
	}

	#onPairingRequest(request: PeerPairingRequest): void {
		if (this.#closed || this.#tearingDown) {
			try {
				request.deny();
			} catch {
				// The request is already gone.
			}
			return;
		}
		const consentId = randomUUID();
		const entry: PendingConsent = {
			id: consentId,
			kind: "incoming",
			label: request.label,
			fingerprint: request.peerKey.fingerprint,
			endpoint: null,
			requestedAt: request.requestedAt,
			expiresAt: request.expiresAt,
			destinationId: null,
			attemptEpoch: null,
			live: () => !this.#closed && request.isPending(),
			apply: (decision) => {
				if (!entry.live()) return false;
				try {
					if (decision !== "approve") return request.deny();
					const applied = request.approve();
					// An explicit fresh approval re-establishes this exact key, so a
					// lifecycle-local denial from an earlier failed Revoke no longer
					// applies to it.
					if (applied) this.#receiverDenials.delete(request.peerKey.keyId);
					return applied;
				} catch {
					return false;
				}
			},
			release: () => this.#removeConsent(entry),
		};
		this.#consents.set(consentId, entry);
		this.#emit();
		// Exactly once per NEW incoming handle: never on redraw or snapshot replay.
		try {
			this.#options.onIncomingConsentArrival(consentId);
		} catch {
			// The arrival signal is advisory; the snapshot already carries the alert.
		}
		// Event-wise settlement, never polling: the host's own decision path ends
		// this alert whether it was approved, denied, expired, or lost.
		void request.settled.then(
			() => this.#removeConsent(entry),
			() => this.#removeConsent(entry),
		);
	}

	#onAppChannel(channel: PeerByteChannel): void {
		const bridge = this.#bridge;
		// The transport gate already checked its current store facts; re-check the
		// exact channel key here so a lifecycle-local receiving denial (for example
		// an unsaved Revoke) refuses metadata even when persistence failed.
		if (bridge === null || this.#closed || !this.#authorizePeer(channel.peerKey)) {
			void channel.close().catch(() => undefined);
			return;
		}
		try {
			const binding = bridge.attach(channel);
			this.#trackInboundBinding(channel.peerKey.keyId, binding);
		} catch {
			void channel.close().catch(() => undefined);
		}
	}

	/**
	 * Admit one inbound native viewport channel. It arrives on the SAME listener
	 * under the SAME directional receiving grant as metadata, is attached to the SAME
	 * owning-host service the roster bridge already uses, and is retired by the same
	 * listener teardown/Revoke graph. There is no second receiving authority, store,
	 * or listener here, and the endpoint itself re-checks authority before every
	 * protected write.
	 */
	#onContentChannel(contentHost: SessionContentHost, channel: PeerByteChannel): void {
		if (
			this.#contentHost !== contentHost
			|| this.#closed
			|| this.#tearingDown
			|| !this.#authorizeContentPeer(channel.peerKey)
		) {
			void channel.close().catch(() => undefined);
			return;
		}
		try {
			const binding = contentHost.attach(channel);
			this.#trackInboundBinding(channel.peerKey.keyId, binding);
		} catch {
			// The endpoint refuses a channel that is not on the content lane, and refuses
			// while its own retirement is unconfirmed. Either way nothing is installed and
			// only this channel is closed.
			void channel.close().catch(() => undefined);
		}
	}

	// --------------------------------------------------------------- consent UI

	#removeConsent(entry: PendingConsent): void {
		if (!this.#consents.delete(entry.id)) return;
		this.#emit();
	}

	#requestServerKeyApproval(
		destinationId: string,
		runtime: DestinationRuntime,
		epoch: number,
		prompt: PeerServerKeyPrompt,
	): Promise<PeerServerKeyDecision> {
		if (this.#closed || this.#tearingDown || runtime.epoch !== epoch) return Promise.resolve("cancel");
		const consentId = randomUUID();
		const requestedAt = Date.now();
		// The saved destination's alias is what the operator recognizes; the
		// certificate's common name is only a fallback display hint.
		const savedLabel = this.#destination(destinationId)?.label;
		const label = savedLabel !== undefined && isValidPeerLabel(savedLabel)
			? savedLabel
			: prompt.label !== null && isValidPeerLabel(prompt.label)
				? prompt.label
				: UNKNOWN_PEER_LABEL;
		return new Promise<PeerServerKeyDecision>((resolve) => {
			let settled = false;
			const finish = (decision: PeerServerKeyDecision): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.#consents.delete(consentId);
				resolve(decision);
				this.#emit();
			};
			const timer = ownedTimer(() => finish("cancel"), this.#consentWindowMs);
			const entry: PendingConsent = {
				id: consentId,
				kind: "server-key",
				label,
				fingerprint: prompt.key.fingerprint,
				endpoint: displayEndpoint(prompt.host, prompt.port),
				requestedAt,
				expiresAt: requestedAt + this.#consentWindowMs,
				destinationId,
				attemptEpoch: epoch,
				live: () => !settled
					&& !this.#closed
					&& runtime.epoch === epoch
					&& runtime.mode !== null,
				apply: (decision) => {
					if (!entry.live()) return false;
					finish(decision === "approve" ? "accept" : "reject");
					return true;
				},
				release: () => finish("cancel"),
			};
			this.#consents.set(consentId, entry);
			this.#emit();
		});
	}

	#releaseAttemptConsents(destinationId: string, epoch: number): void {
		for (const entry of [...this.#consents.values()]) {
			if (entry.destinationId === destinationId && entry.attemptEpoch === epoch) entry.release();
		}
	}

	// ------------------------------------------------------------- destinations

	#destination(id: string): PeerDestination | undefined {
		const preferences = this.#preferences;
		if (preferences === null) return undefined;
		return preferences.destinations.find((destination) => destination.id === id);
	}

	#destinations(): readonly PeerDestination[] {
		return this.#preferences?.destinations ?? [];
	}

	#runtimeFor(destination: PeerDestination): DestinationRuntime {
		const existing = this.#runtime.get(destination.id);
		if (existing !== undefined) return existing;
		const runtime: DestinationRuntime = {
			id: destination.id,
			state: "disconnected",
			message: null,
			roster: { state: "never", rows: null, hostRunId: null },
			autoAttempts: 0,
			retryTimer: null,
			mode: null,
			abort: null,
			client: null,
			viewer: null,
			channel: null,
			epoch: 0,
		};
		this.#runtime.set(destination.id, runtime);
		return runtime;
	}

	#readPin(id: string): PeerKey | null {
		const store = this.#trustStore;
		if (store === null) return null;
		try {
			return store.rememberedFor(id).read();
		} catch {
			return null;
		}
	}

	#currentIdentity() {
		const store = this.#trustStore;
		if (store === null) return null;
		try {
			return store.identity;
		} catch {
			return null;
		}
	}

	async #ensureIdentity() {
		const store = this.#trustStore;
		if (store === null) {
			this.#transientNotice = NOTICE.trustUnavailable;
			this.#emit();
			return null;
		}
		try {
			const existing = store.identity;
			if (existing !== null) return existing;
		} catch {
			this.#transientNotice = NOTICE.trustUnavailable;
			this.#emit();
			return null;
		}
		try {
			return await store.initializeIdentity(HOST_IDENTITY_LABEL);
		} catch (error) {
			this.#transientNotice = NOTICE.identityUnavailable;
			this.#noteStorageRefusal("trust", error, true);
			this.#emit();
			return null;
		}
	}

	#markPreviouslyConnected(id: string): void {
		const preferences = this.#preferences;
		if (preferences === null) return;
		const destination = preferences.destinations.find((entry) => entry.id === id);
		if (destination === undefined || destination.previouslyConnected) return;
		const next: PeerPreferences = {
			...preferences,
			destinations: preferences.destinations.map((entry) => (
				entry.id === id ? { ...entry, previouslyConnected: true } : entry
			)),
		};
		// Successful-connection history is real state even when the save fails, so
		// this session's Auto eligibility stays truthful; the notice reports it.
		this.#savePreferences(next, { applyOnFailure: true });
	}

	#autoEligible(id: string): boolean {
		if (this.#closed || this.#storageRestart !== null) return false;
		const preferences = this.#preferences;
		if (preferences === null || !preferences.autoReconnect) return false;
		const destination = preferences.destinations.find((entry) => entry.id === id);
		if (destination === undefined) return false;
		if (!destination.previouslyConnected) return false;
		if (destination.reconnectSuppressed || this.#suppressionOverride.has(id)) return false;
		const runtime = this.#runtime.get(id);
		if (runtime !== undefined) {
			// A terminal authorization/identity failure is never retried in the
			// background; only an explicit Connect may try it again.
			if (runtime.state === "connected" || runtime.state === "error") return false;
			if (runtime.retryTimer !== null) return false;
			if (runtime.mode !== null && runtime.mode === "explicit") return false;
		}
		const store = this.#trustStore;
		if (store === null) return false;
		try {
			if (store.identity === null) return false;
			return store.rememberedFor(id).read() !== null;
		} catch {
			return false;
		}
	}

	#scheduleEligibleAutoAttempts(): void {
		for (const destination of this.#destinations()) {
			// Startup has no runtime yet; automatic eligibility must still be
			// evaluated for a remembered, previously connected destination.
			this.#runtimeFor(destination);
			if (!this.#autoEligible(destination.id)) continue;
			this.#scheduleRetry(destination.id);
		}
	}

	#scheduleRetry(id: string): void {
		const runtime = this.#runtime.get(id);
		if (runtime === undefined || this.#closed) return;
		if (runtime.retryTimer !== null) return;
		if (!this.#autoEligible(id)) return;
		const delays = this.#autoReconnectDelaysMs;
		if (runtime.autoAttempts >= delays.length) {
			runtime.state = "disconnected";
			runtime.message = HOST_MESSAGE.autoStopped;
			this.#emit();
			return;
		}
		const delay = delays[Math.min(runtime.autoAttempts, delays.length - 1)] as number;
		runtime.autoAttempts += 1;
		runtime.state = "retrying";
		runtime.message = HOST_MESSAGE.reconnecting;
		runtime.retryTimer = ownedTimer(() => {
			runtime.retryTimer = null;
			void this.#runAutoAttempt(id).catch(() => undefined);
		}, delay);
		this.#emit();
	}

	async #runAutoAttempt(id: string): Promise<void> {
		if (this.#closed) return;
		const runtime = this.#runtime.get(id);
		if (runtime === undefined) return;
		if (!this.#autoEligible(id)) {
			if (runtime.state === "retrying") {
				runtime.state = "disconnected";
				runtime.message = null;
				this.#emit();
			}
			return;
		}
		await this.#connectDestination(id, "auto");
	}

	#cancelAutomaticAttempts(): void {
		for (const runtime of this.#runtime.values()) {
			if (runtime.retryTimer !== null) {
				clearTimeout(runtime.retryTimer);
				runtime.retryTimer = null;
			}
			if (runtime.mode === "auto" && runtime.state !== "connected") {
				runtime.epoch += 1;
				const abort = runtime.abort;
				runtime.abort = null;
				abort?.abort();
				const client = runtime.client;
				runtime.client = null;
				client?.dispose();
				runtime.mode = null;
				runtime.state = "disconnected";
				runtime.message = null;
			} else if (runtime.state === "retrying") {
				// A healthy connected session is never canceled by Auto off.
				runtime.state = "disconnected";
				runtime.message = null;
			}
		}
		this.#emit();
	}

	#cancelActivity(id: string, message: string | null): void {
		const runtime = this.#runtime.get(id);
		if (runtime === undefined) return;
		runtime.epoch += 1;
		if (runtime.retryTimer !== null) {
			clearTimeout(runtime.retryTimer);
			runtime.retryTimer = null;
		}
		const abort = runtime.abort;
		runtime.abort = null;
		abort?.abort();
		runtime.mode = null;
		runtime.state = "disconnected";
		runtime.message = message;
		this.#markRosterStale(runtime);
		// A destination that stopped carrying its connection cannot carry content
		// either: the authorized view is cleared and its endpoint retired immediately,
		// while the deliberate selection is kept as an honest `unavailable`.
		this.#contentLostHost(id, "connection-lost");
		// Register the retirement BEFORE publishing the disconnected snapshot, so
		// an immediate close() sees the still-owned connection.
		this.#retireDestinationResources(runtime);
		this.#emit();
	}

	/**
	 * Retire one destination's owned local network resources as tracked work:
	 * the viewer is stopped and the channel closed CONCURRENTLY (never waiting for
	 * a remote unsubscribe acknowledgement first), and any unconfirmed settlement
	 * is retained so shutdown rejects instead of fabricating success.
	 */
	#retireDestinationResources(runtime: DestinationRuntime): void {
		const viewer = runtime.viewer;
		const channel = runtime.channel;
		const client = runtime.client;
		runtime.viewer = null;
		runtime.channel = null;
		runtime.client = null;
		if (viewer === null && channel === null && client === null) return;
		const cleanup = (async () => {
			try {
				const results = await Promise.allSettled([
					...(viewer === null ? [] : [viewer.stop()]),
					...(channel === null ? [] : [channel.close()]),
				]);
				if (results.some((result) => result.status === "rejected")) {
					this.#resourceCleanupFailed = true;
				}
			} catch {
				this.#resourceCleanupFailed = true;
			} finally {
				try {
					client?.dispose();
				} catch {
					this.#resourceCleanupFailed = true;
				}
			}
		})();
		this.#trackNetworkRetirement(cleanup);
	}

	/**
	 * Track one owned retirement both for shutdown settlement and as a storage
	 * repair barrier. Its settlement re-publishes the snapshot so a repair that
	 * was busy only because of it can be offered again.
	 */
	#trackNetworkRetirement(retirement: Promise<void>): void {
		const settled = retirement.then(() => undefined, () => undefined);
		this.#pendingNetworkRetirements.add(settled);
		void settled.then(() => {
			this.#pendingNetworkRetirements.delete(settled);
			this.#emit();
		});
		void this.#track(retirement);
	}

	#retireAllDestinations(): void {
		for (const runtime of this.#runtime.values()) this.#retireDestinationResources(runtime);
	}

	async #connectDestination(id: string, mode: "explicit" | "auto"): Promise<void> {
		if (this.#closed || this.#storageRestart !== null) return;
		const destination = this.#destination(id);
		if (destination === undefined) return;
		if (this.#preferences === null) return;
		const runtime = this.#runtimeFor(destination);
		if (runtime.mode !== null || runtime.state === "connected") return;

		const epoch = ++runtime.epoch;
		const abort = new AbortController();
		runtime.abort = abort;
		runtime.mode = mode;
		runtime.state = "connecting";
		runtime.message = mode === "auto" ? HOST_MESSAGE.reconnecting : HOST_MESSAGE.connecting;
		this.#emit();

		let client: PeerClient | null = null;
		let connected = false;
		try {
			let identity = this.#currentIdentity();
			if (identity === null) {
				if (mode === "auto") {
					// Automatic recovery never creates an identity.
					runtime.mode = null;
					runtime.abort = null;
					runtime.state = "disconnected";
					runtime.message = null;
					this.#emit();
					return;
				}
				identity = await this.#ensureIdentity();
				if (identity === null) {
					this.#failAttempt(runtime, epoch, {
						terminal: true,
						message: HOST_MESSAGE.identityUnavailable,
					});
					return;
				}
				if (runtime.epoch !== epoch || this.#closed) return;
			}

			const trustStore = this.#trustStore;
			if (trustStore === null) {
				this.#failAttempt(runtime, epoch, {
					terminal: true,
					message: HOST_MESSAGE.identityUnavailable,
				});
				return;
			}
			// The transport replaces a pin-write failure with its own fixed error, so
			// the ORIGINAL refusal's sanitized diagnostic is recorded here, at the
			// write itself, before it is rethrown unchanged.
			const remembered = trustStore.rememberedFor(id);
			client = createPeerClient({
				identity,
				remembered: {
					read: () => remembered.read(),
					write: (key: PeerKey) => {
						try {
							remembered.write(key);
						} catch (error) {
							this.#noteStorageRefusal("trust", error, true);
							throw error;
						}
					},
					clear: () => remembered.clear(),
				},
				bounds: {
					consentTimeoutMs: this.#consentWindowMs,
					pairingResponseTimeoutMs: this.#consentWindowMs + PEER_UI_PAIRING_RESPONSE_OVERHEAD_MS,
					...this.#clientBounds,
				},
				onServerKey: mode === "auto"
					// Background recovery never prompts for an unknown key.
					? () => "reject" as const
					: (prompt) => this.#requestServerKeyApproval(id, runtime, epoch, prompt),
			});
			runtime.client = client;

			if (mode === "explicit") {
				runtime.state = "pairing";
				runtime.message = this.#readPin(id) === null ? HOST_MESSAGE.pairing : HOST_MESSAGE.connecting;
				this.#emit();
				const paired = await client.pair({
					host: destination.host,
					port: destination.port,
					signal: abort.signal,
				});
				if (runtime.epoch !== epoch || this.#closed) return;
				if (!paired.ok) {
					this.#failAttempt(runtime, epoch, pairFailure(paired));
					return;
				}
			}

			runtime.state = "connecting";
			runtime.message = HOST_MESSAGE.connecting;
			this.#emit();
			let channel = await client.connectApp({
				host: destination.host,
				port: destination.port,
				signal: abort.signal,
			});
			const wrapChannel = this.#options.testHooks?.wrapClientChannel;
			if (wrapChannel !== undefined) {
				try {
					channel = wrapChannel(channel);
				} catch {
					try {
						await channel.close();
					} catch {
						// Already gone.
					}
					throw peerError("APP_REFUSED");
				}
			}
			if (runtime.epoch !== epoch || this.#closed) {
				try {
					await channel.close();
				} catch {
					// Already gone.
				}
				return;
			}

			// Only an authenticated service connection counts as history.
			connected = true;
			runtime.channel = channel;
			runtime.client = client;
			runtime.abort = null;
			runtime.mode = null;
			runtime.state = "connected";
			runtime.message = null;
			runtime.autoAttempts = 0;
			runtime.roster = { state: "never", rows: null, hostRunId: null };
			this.#markPreviouslyConnected(id);
			this.#emit();
			this.#watchChannel(runtime, epoch, channel);
			await this.#startViewer(runtime, epoch, channel);
		} catch (error) {
			if (runtime.epoch !== epoch || this.#closed) return;
			// A trust-store refusal during pinning keeps its sanitized diagnostic;
			// any error without one records nothing here.
			this.#noteStorageRefusal("trust", error, true);
			this.#failAttempt(runtime, epoch, describePeerFailure(error));
		} finally {
			if (!connected && client !== null) {
				client.dispose();
				if (runtime.client === client) runtime.client = null;
			}
			if (runtime.epoch === epoch) {
				runtime.mode = null;
				if (!connected) runtime.abort = null;
			}
			this.#releaseAttemptConsents(id, epoch);
			// The attempt's client is released only here, after the failure was
			// published: re-publish so a recorded storage refusal's repair state
			// reflects the now-settled attempt instead of a stale "busy".
			if (!connected && this.#storageProblems.length > 0) this.#emit();
		}
	}

	/**
	 * Settle one failed attempt. A network loss is eligible for the owned Auto
	 * schedule (never for an unpaired or suppressed destination); a terminal
	 * authorization/identity failure is reported and never retried in the
	 * background.
	 */
	#failAttempt(runtime: DestinationRuntime, epoch: number, failure: PeerFailure): void {
		if (runtime.epoch !== epoch || this.#closed) return;
		runtime.mode = null;
		runtime.abort = null;
		runtime.state = failure.terminal ? "error" : "disconnected";
		runtime.message = failure.message;
		if (!failure.terminal) this.#scheduleRetry(runtime.id);
		this.#emit();
	}

	#watchChannel(runtime: DestinationRuntime, epoch: number, channel: PeerByteChannel): void {
		const lost = (): void => this.#handleUnexpectedLoss(runtime, epoch);
		void channel.closed.then(lost, lost);
	}

	#handleUnexpectedLoss(runtime: DestinationRuntime, epoch: number): void {
		if (runtime.epoch !== epoch || this.#closed) return;
		runtime.epoch += 1;
		if (runtime.retryTimer !== null) {
			clearTimeout(runtime.retryTimer);
			runtime.retryTimer = null;
		}
		runtime.abort = null;
		runtime.mode = null;
		runtime.state = "disconnected";
		runtime.message = HOST_MESSAGE.connectionLost;
		this.#markRosterStale(runtime);
		this.#contentLostHost(runtime.id, "connection-lost");
		this.#retireDestinationResources(runtime);
		this.#emit();
		this.#scheduleRetry(runtime.id);
	}

	async #startViewer(runtime: DestinationRuntime, epoch: number, channel: PeerByteChannel): Promise<void> {
		let viewer: RosterBridgeViewer;
		// The exact viewer a Saved policy description may come from; assigned right
		// after attach, before any frame can be handled.
		let boundViewer: RosterBridgeViewer | null = null;
		try {
			viewer = attachRosterBridgeViewer({
				channel,
				// This side knows the rowless create exchange and says so explicitly. It is
				// not part of the viewer's default offers, so nothing about the existing lane
				// changes for a caller that never asks, and the owner still acknowledges it
				// only when it really holds a create provider. Saved is offered after it
				// ONLY with the explicit requester opt-in. Rename is offered independently
				// because this implementation knows the exchange and holds the controller; the owner
				// still acknowledges it only when it really holds a rename provider, so an
				// owner without one keeps its exact previous capability set.
				capabilities: this.#savedViewer
					? [ROSTER_BRIDGE_CREATE_CAPABILITY, ROSTER_BRIDGE_SAVED_CAPABILITY, ROSTER_BRIDGE_RENAME_CAPABILITY]
					: [ROSTER_BRIDGE_CREATE_CAPABILITY, ROSTER_BRIDGE_RENAME_CAPABILITY],
				onProjection: (projection) => this.#onProjection(runtime, epoch, projection),
				...(this.#savedViewer
					? { onSavedPolicy: (): void => this.#onSavedPolicy(runtime, epoch, boundViewer) }
					: {}),
			});
			boundViewer = viewer;
		} catch {
			if (runtime.epoch === epoch) {
				runtime.message = HOST_MESSAGE.metadataUnavailable;
				this.#emit();
			}
			return;
		}
		if (runtime.epoch !== epoch || this.#closed) {
			void viewer.stop().catch(() => undefined);
			return;
		}
		runtime.viewer = viewer;
		try {
			await viewer.hello;
			if (runtime.epoch !== epoch || this.#closed) return;
			const projection = await viewer.subscribe();
			if (runtime.epoch !== epoch || this.#closed) return;
			this.#onProjection(runtime, epoch, projection);
		} catch {
			if (runtime.epoch !== epoch || this.#closed) return;
			// The authenticated connection still exists; only its metadata view is
			// not current, and it is never replaced by a fabricated empty roster.
			runtime.message = HOST_MESSAGE.metadataUnavailable;
			this.#emit();
		}
	}

	#onProjection(runtime: DestinationRuntime, epoch: number, projection: RosterBridgeProjection): void {
		if (runtime.epoch !== epoch || this.#closed) return;
		// A stale projection without a completed observation (a refused or timed
		// out handshake, a failed transfer before any snapshot) carries rows=[] and
		// no revision. That is "never observed", never a last-observed empty
		// roster; an empty [] only becomes a real observation after a validated
		// complete snapshot.
		const observed = projection.revision !== null && projection.hostRunId !== null;
		if (!observed) {
			runtime.roster = { state: "never", rows: null, hostRunId: null };
		} else {
			runtime.roster = {
				state: projection.state === "current" ? "current" : "stale",
				rows: copyRoster(projection.rows),
				// The owner run identity is a load-bearing fact, not decoration: the one
				// selected content stream is fenced against this exact value, so a new
				// owner run can never be mistaken for the run the operator selected.
				hostRunId: projection.hostRunId,
			};
		}
		this.#emit();
		// A projection is the only thing that can make a deliberate selection reachable
		// again: an existing Auto reconnect that brings the SAME exact owner run and row
		// back may restore that one selection, and a projection that no longer holds it
		// stops claiming content. Nothing here connects, retries, pairs, or retargets.
		this.#reconcileContentWithRoster(runtime.id);
	}

	/**
	 * The owner's described Saved delete policy changed on ONE exact viewer. Only
	 * that viewer, while it is still the current one of the same destination
	 * runtime and epoch, may publish: a callback from a retired viewer can never
	 * describe a replacement connection (A -> B -> A included), and nothing here
	 * refreshes the roster, resubscribes, rebinds, or reconnects. The DTO reads the
	 * description live, so this only republishes the snapshot.
	 */
	#onSavedPolicy(runtime: DestinationRuntime, epoch: number, viewer: RosterBridgeViewer | null): void {
		if (viewer === null || this.#closed || this.#tearingDown) return;
		if (runtime.epoch !== epoch || runtime.viewer !== viewer) return;
		if (this.#runtime.get(runtime.id) !== runtime) return;
		this.#emit();
	}

	// ------------------------------------------------------------- owner Close

	/**
	 * Send one owner-routed Close through the destination's EXISTING connected
	 * metadata viewer.
	 *
	 * No selection, published stream, native conversation tuple, controller lease,
	 * or on-demand connection is involved: the request names one local saved
	 * destination plus the exact owner run and row the last roster observation
	 * named, and the owner's own real preflight decides what to do with it.
	 *
	 * Everything this attempt borrows is captured and revalidated after the await:
	 * the destination runtime, its metadata channel, its borrowed client, its
	 * destination epoch, the remembered pin, and this side's current identity. A
	 * replacement or re-pin cannot inherit an older answer, so a completed result
	 * whose fences no longer hold is reported `unknown` rather than retargeted. The
	 * REVOKE that affects an OUTBOUND close is the owner's own receiving grant for
	 * this viewer; this side's local receiving direction never gates it.
	 */
	async #closeSession(target: PeerCloseTarget): Promise<PeerCloseResult> {
		if (this.#closed || this.#tearingDown) return { kind: "not-sent", reason: "not-ready" };
		const request = normalizeCloseTarget(target);
		if (request === null) return { kind: "not-sent", reason: "invalid-request" };
		const runtime = this.#runtime.get(request.hostId);
		if (runtime === undefined) return { kind: "not-sent", reason: "target-unavailable" };
		const viewer = runtime.viewer;
		const metadata = runtime.channel;
		const client = runtime.client;
		if (
			runtime.state !== "connected"
			|| viewer === null
			|| metadata === null
			|| client === null
		) return { kind: "not-sent", reason: "target-unavailable" };
		// The exact run and row must be present in the LAST observed roster of this
		// destination. A stale observation is allowed — the owner's preflight decides —
		// and the request is never rewritten to a newer run or a sibling row.
		const roster = runtime.roster;
		if (roster.rows === null || roster.hostRunId === null) {
			return { kind: "not-sent", reason: "target-unavailable" };
		}
		if (roster.hostRunId !== request.hostRunId) return { kind: "not-sent", reason: "target-unavailable" };
		if (!roster.rows.some((row) => row.id === request.rowId)) {
			return { kind: "not-sent", reason: "target-unavailable" };
		}
		// The verified destination facts the request is fenced against: the pin saved
		// for this destination is still the key the live metadata channel really
		// proved, and this side's current identity is still the one the borrowed
		// client proves. No new pin is written and no identity is created here.
		const pin = this.#readPin(runtime.id);
		if (pin === null || !peerKeysEqual(pin, metadata.peerKey)) {
			return { kind: "not-sent", reason: "target-unavailable" };
		}
		const identity = this.#currentIdentity();
		if (identity === null || !peerKeysEqual(identity.key, client.key)) {
			return { kind: "not-sent", reason: "target-unavailable" };
		}
		// The owner never acknowledged Close support for this channel: no frame exists.
		if (!viewer.supportsClose) return { kind: "not-sent", reason: "capability-unsupported" };
		const destinationEpoch = runtime.epoch;
		const result = await viewer.closeSession(
			{
				hostRunId: request.hostRunId,
				rowId: request.rowId,
				confirmed: request.confirmed,
			},
			{
				// The last-instant half of the SAME fence: the viewer evaluates this
				// synchronously immediately before it calls `channel.send`, so a request
				// whose destination, pin, identity, channel, or epoch was replaced while it
				// waited in the send queue is never submitted at all.
				stillCurrent: () => this.#protectedRequestFenceHolds(runtime, viewer, metadata, client, destinationEpoch),
			},
		);
		// A positively-not-sent answer stays true regardless of any later change.
		if (result.kind === "not-sent") return result;
		if (!this.#protectedRequestFenceHolds(runtime, viewer, metadata, client, destinationEpoch)) {
			// The request may already have been submitted, so nothing here can claim it
			// never happened; an answer from a replaced destination is not this one's.
			return { kind: "unknown" };
		}
		return result;
	}

	// ------------------------------------------------------- owner create (rowless)

	/**
	 * Create one blank child in ONE exact owner run through the destination's
	 * EXISTING connected metadata viewer.
	 *
	 * No row, selection, published stream, native conversation tuple, controller
	 * lease, or on-demand connection is involved, and an owner whose current roster
	 * is empty is a perfectly valid first target. The request names one local saved
	 * destination, the exact owner run its last WRITTEN form destination named, and
	 * the canonical workspace that form held; the owner's own provider decides and
	 * starts the child.
	 *
	 * Everything this attempt borrows is captured and revalidated after the await:
	 * the destination runtime, its metadata channel, its borrowed client, its
	 * destination epoch, the remembered pin, and this side's current identity. The
	 * caller's own written-form/run/workspace proof is REQUIRED and is combined with
	 * those independent owner facts inside the transport write boundary, with the
	 * owner facts re-proved AFTER the callback returns, so an admission-only proof
	 * can never submit a stale create. A completed result whose fences no longer hold
	 * is reported `unknown` rather than retargeted, and nothing is created, selected,
	 * or focused locally.
	 */
	async #createSession(target: PeerCreateTarget, options: PeerCreateOptions): Promise<PeerCreateResult> {
		if (this.#closed || this.#tearingDown) return { kind: "not-sent", reason: "not-ready" };
		const request = normalizeCreateTarget(target);
		if (request === null) return { kind: "not-sent", reason: "invalid-request" };
		// The caller's last-instant proof is required, not optional: without a real
		// written form/run/workspace fence nothing may be submitted at all.
		const proof: unknown = options;
		if (!isRecord(proof) || typeof proof.stillCurrent !== "function") {
			return { kind: "not-sent", reason: "invalid-request" };
		}
		const callerStillCurrent = proof.stillCurrent;
		const runtime = this.#runtime.get(request.hostId);
		if (runtime === undefined) return { kind: "not-sent", reason: "target-unavailable" };
		const viewer = runtime.viewer;
		const metadata = runtime.channel;
		const client = runtime.client;
		if (
			runtime.state !== "connected"
			|| viewer === null
			|| metadata === null
			|| client === null
		) return { kind: "not-sent", reason: "target-unavailable" };
		// The exact run the caller's written form destination named must still be the
		// run this side observed for that destination. A row is never required, and a
		// missing, newer, or unknown run is refused rather than rewritten.
		const roster = runtime.roster;
		if (!isOwnerCreateRunStillCurrent(roster.hostRunId, request.hostRunId)) {
			return { kind: "not-sent", reason: "target-unavailable" };
		}
		// The verified destination facts the request is fenced against: the pin saved
		// for this destination is still the key the live metadata channel really
		// proved, and this side's current identity is still the one the borrowed
		// client proves. No new pin is written and no identity is created here.
		const pin = this.#readPin(runtime.id);
		if (pin === null || !peerKeysEqual(pin, metadata.peerKey)) {
			return { kind: "not-sent", reason: "target-unavailable" };
		}
		const identity = this.#currentIdentity();
		if (identity === null || !peerKeysEqual(identity.key, client.key)) {
			return { kind: "not-sent", reason: "target-unavailable" };
		}
		// The owner never acknowledged create support for this channel: no frame exists.
		if (!viewer.supportsCreate) return { kind: "not-sent", reason: "capability-unsupported" };
		const destinationEpoch = runtime.epoch;
		const result = await viewer.createSession(
			{ hostRunId: request.hostRunId, workspace: request.workspace },
			{
				stillCurrent: () => {
					let callerOwns = false;
					try {
						callerOwns = callerStillCurrent() === true;
					} catch {
						// An unavailable caller proof is no proof at all.
						return false;
					}
					if (!callerOwns) return false;
					// The independent owner facts are re-proved AFTER the caller's proof
					// returns, so a callback cannot authorize a create on its own, and the
					// requested owner run is re-checked here at the transport boundary.
					return this.#createFenceHolds(runtime, viewer, metadata, client, destinationEpoch, request.hostRunId);
				},
			},
		);
		// A positively-not-sent answer stays true regardless of any later change.
		if (result.kind === "not-sent") return result;
		if (!this.#protectedRequestFenceHolds(runtime, viewer, metadata, client, destinationEpoch)) {
			// The request may already have been submitted, so nothing here can claim it
			// never happened; an answer from a replaced destination is not this one's.
			return { kind: "unknown" };
		}
		return result;
	}

	/** True only while every fact one protected owner request borrowed is still current. */
	#protectedRequestFenceHolds(
		runtime: DestinationRuntime,
		viewer: RosterBridgeViewer,
		metadata: PeerByteChannel,
		client: PeerClient,
		destinationEpoch: number,
	): boolean {
		if (this.#closed || this.#tearingDown) return false;
		if (runtime.viewer !== viewer) return false;
		if (runtime.state !== "connected") return false;
		if (runtime.channel !== metadata) return false;
		if (runtime.client !== client) return false;
		if (runtime.epoch !== destinationEpoch) return false;
		const pin = this.#readPin(runtime.id);
		if (pin === null || !peerKeysEqual(pin, metadata.peerKey)) return false;
		const identity = this.#currentIdentity();
		if (identity === null || !peerKeysEqual(identity.key, client.key)) return false;
		return true;
	}

	/**
	 * The create-specific last-instant fence: every borrowed owner fact is still
	 * current AND this side still observes the EXACT owner run the request was built
	 * for. It is re-proved after the caller's own proof inside the transport write
	 * boundary, so an over-permissive or stale caller callback can never submit a
	 * create for a run whose observation was replaced while the request waited.
	 *
	 * Close keeps its own fence unchanged: a close names an existing row, while a
	 * create names the run itself.
	 */
	#createFenceHolds(
		runtime: DestinationRuntime,
		viewer: RosterBridgeViewer,
		metadata: PeerByteChannel,
		client: PeerClient,
		destinationEpoch: number,
		hostRunId: string,
	): boolean {
		if (!this.#protectedRequestFenceHolds(runtime, viewer, metadata, client, destinationEpoch)) return false;
		return isOwnerCreateRunStillCurrent(runtime.roster.hostRunId, hostRunId);
	}

	// ------------------------------------------------------------ owner rename

	/**
	 * Send one owner-routed rename of ONE exact native conversation tuple through the
	 * destination's EXISTING connected metadata viewer, and never throw.
	 *
	 * No selection, open form, published stream, controller lease, or on-demand
	 * connection is involved: the request names one local saved destination, the exact
	 * owner run and row of this side's LAST COMPLETE CURRENT roster observation, that
	 * row's observed native conversation id and epoch, and the name the caller's own
	 * written editor holds. A stale or `never` observation, an absent row, a row with
	 * no native conversation, a different id, or a moved epoch is refused rather than
	 * quietly retargeted to a newer tuple or a sibling row, and nothing is ever
	 * renamed, replayed, cancelled, retried, or invented locally here.
	 *
	 * Every borrowed fact is captured BEFORE any callout and revalidated at admission,
	 * again inside the raw viewer's ordered write boundary, and again after the
	 * operation completes: the destination runtime, its metadata viewer and channel,
	 * the borrowed client, the destination epoch, the remembered pin equal to the key
	 * that channel really proved, this side's current identity equal to the key that
	 * client proves, and the current run/row/native tuple. The caller's REQUIRED
	 * written-editor proof is combined with those independent facts, which are then
	 * re-proved AFTER that arbitrary callback returns, so a reentrant proof can never
	 * authorize a rename on its own. A completed result whose fences no longer hold is
	 * reported `unknown`, never a success and never a fresh attempt.
	 */
	async #renameSession(target: PeerRenameTarget, options: PeerRenameOptions): Promise<PeerRenameResult> {
		let invoked = false;
		try {
			return await this.#renameSessionFenced(target, options, () => {
				invoked = true;
			});
		} catch {
			// A hostile input or an unavailable raw API never becomes a rejection, and a
			// fault after invocation is never a false claim that nothing was submitted.
			return invoked ? { kind: "unknown" } : { kind: "not-sent", reason: "not-ready" };
		}
	}

	async #renameSessionFenced(
		target: PeerRenameTarget,
		options: PeerRenameOptions,
		markInvoked: () => void,
	): Promise<PeerRenameResult> {
		if (this.#closed || this.#tearingDown) return { kind: "not-sent", reason: "not-ready" };
		const request = normalizeRenameTarget(target);
		if (request === null) return { kind: "not-sent", reason: "invalid-request" };
		// The caller's last-instant proof is REQUIRED, not optional, exactly as for
		// Create: the name comes from the caller's own written editor, and this
		// coordinator holds no written-name authority of its own to substitute for it.
		let proofValue: unknown;
		try {
			proofValue = isRecord(options) ? options.stillCurrent : undefined;
		} catch {
			proofValue = undefined;
		}
		if (typeof proofValue !== "function") return { kind: "not-sent", reason: "invalid-request" };
		const callerProof = proofValue as () => unknown;
		const callerHolds = (): boolean => {
			try {
				return callerProof() === true;
			} catch {
				// An unavailable caller proof is no proof at all.
				return false;
			}
		};
		const runtime = this.#runtime.get(request.hostId);
		if (runtime === undefined) return { kind: "not-sent", reason: "target-unavailable" };
		const viewer = runtime.viewer;
		const metadata = runtime.channel;
		const client = runtime.client;
		const destinationEpoch = runtime.epoch;
		if (
			runtime.state !== "connected"
			|| viewer === null
			|| metadata === null
			|| client === null
		) return { kind: "not-sent", reason: "target-unavailable" };
		// Admission: every independent fact, then the caller's proof, then the same
		// facts re-proved AFTER that arbitrary callback returns.
		if (!this.#renameFenceHolds(runtime, viewer, metadata, client, destinationEpoch, request)) {
			return { kind: "not-sent", reason: "target-unavailable" };
		}
		// The owner never acknowledged rename support for this channel: no frame exists
		// to send, and no local rename is attempted in its place.
		let supported = false;
		try {
			supported = viewer.supportsRename === true;
		} catch {
			supported = false;
		}
		if (!supported) return { kind: "not-sent", reason: "capability-unsupported" };
		if (!callerHolds()) return { kind: "not-sent", reason: "target-unavailable" };
		if (!this.#renameFenceHolds(runtime, viewer, metadata, client, destinationEpoch, request)) {
			return { kind: "not-sent", reason: "target-unavailable" };
		}
		markInvoked();
		const result = await viewer.renameSession(
			{
				hostRunId: request.hostRunId,
				rowId: request.rowId,
				expectedSessionId: request.expectedSessionId,
				expectedSessionEpoch: request.expectedSessionEpoch,
				name: request.name,
			},
			{
				// The last-instant half of the SAME fence, evaluated synchronously by the
				// raw viewer immediately before its queued write calls `channel.send`: the
				// caller's proof, then this side's independent facts re-proved after it, so
				// a request whose destination, pin, identity, run, row, or native tuple moved
				// while it waited in the send queue is never submitted at all.
				stillCurrent: () => {
					if (!callerHolds()) return false;
					return this.#renameFenceHolds(runtime, viewer, metadata, client, destinationEpoch, request);
				},
			},
		);
		// A positively-not-sent answer stays true regardless of any later change.
		if (result.kind === "not-sent") return result;
		if (!this.#renameFenceHolds(runtime, viewer, metadata, client, destinationEpoch, request)) {
			// The request may already have been submitted, so nothing here can claim it
			// never happened; an answer from a replaced destination, run, row, or native
			// tuple is not this request's and is never reported as this rename's success.
			return { kind: "unknown" };
		}
		return result;
	}

	/**
	 * True only while THIS side's current observation of one destination still names
	 * the exact owner run, row, and native conversation tuple one rename was built
	 * for. A `never` or stale observation, an absent row, no native conversation, a
	 * different id, or a moved epoch is never a match. This is a pure read, so it can
	 * be repeated at admission, inside the raw write boundary, and after completion.
	 */
	#renameRosterCurrent(
		runtime: DestinationRuntime,
		request: Pick<
			PeerRenameTarget,
			"hostRunId" | "rowId" | "expectedSessionId" | "expectedSessionEpoch"
		>,
	): boolean {
		const roster = runtime.roster;
		if (roster.state !== "current" || roster.rows === null) return false;
		if (roster.hostRunId !== request.hostRunId) return false;
		const row = roster.rows.find((candidate) => candidate.id === request.rowId);
		return isOwnerRenameTupleStillCurrent(row?.nativeSession, request);
	}

	/**
	 * The rename fence: every fact one protected owner request borrowed (runtime
	 * identity, viewer, metadata channel, borrowed client, destination epoch, pin,
	 * this side's identity) AND this side still observing the exact requested run,
	 * row, and native conversation tuple in a complete current roster observation.
	 */
	#renameFenceHolds(
		runtime: DestinationRuntime,
		viewer: RosterBridgeViewer,
		metadata: PeerByteChannel,
		client: PeerClient,
		destinationEpoch: number,
		request: Pick<
			PeerRenameTarget,
			"hostRunId" | "rowId" | "expectedSessionId" | "expectedSessionEpoch"
		>,
	): boolean {
		if (this.#runtime.get(runtime.id) !== runtime) return false;
		if (!this.#protectedRequestFenceHolds(runtime, viewer, metadata, client, destinationEpoch)) return false;
		return this.#renameRosterCurrent(runtime, request);
	}

	// ------------------------------------------------- owner Saved (requester side)

	/**
	 * Send one requester Saved request through the destination's EXISTING connected
	 * metadata viewer, and never throw.
	 *
	 * Until the raw Saved API is invoked, every refusal is positive proof that no
	 * bytes reached the transport (`not-sent`). Once it is invoked, the only honest
	 * answers are the raw API's own `not-sent` (its write boundary refused), the
	 * owner's correlated result, or `unknown`; an unexpected fault after invocation
	 * is `unknown`, never a false `not-sent`.
	 */
	async #savedRequest(kind: SavedOperation, target: unknown, options: unknown): Promise<PeerSavedResult<unknown>> {
		let invoked = false;
		try {
			return await this.#savedRequestFenced(kind, target, options, () => {
				invoked = true;
			});
		} catch {
			return invoked ? { kind: "unknown" } : { kind: "not-sent", reason: "not-ready" };
		}
	}

	/**
	 * The fenced Saved path. Nothing is selected, focused, or required to be
	 * displayed: no native tuple, content source, canonical geometry, or row is
	 * involved, and an owner whose current roster is empty is a valid target. The
	 * request names one local saved destination plus the EXACT owner run this side
	 * last observed for it, and is copied onto a closed frozen request first.
	 *
	 * Fences, all captured BEFORE any callout so an A -> B -> A change inside caller
	 * code cannot restore them: the destination runtime, its viewer, metadata
	 * channel, borrowed client, and destination epoch; the remembered pin equal to
	 * the key that channel proved; this side's current identity equal to the key
	 * that client proves; and the exact observed owner run. The caller's REQUIRED
	 * proof runs at admission and again inside the raw write boundary, and these
	 * fences are re-proved after it returns each time.
	 *
	 * This viewer's own native input/copy preference and its own (owner-side)
	 * remote-history delete setting never gate a Saved request. Delete/prepare
	 * requires the owner's current positive description at admission and send;
	 * the owner independently decides its policy once when admitting the request.
	 * Nothing is retried, replayed, reconnected,
	 * re-granted, or cancelled here, and an ordinary roster publication or revision
	 * never invalidates a catalog, a result, or an accepted mutation.
	 */
	async #savedRequestFenced(
		kind: SavedOperation,
		target: unknown,
		options: unknown,
		markInvoked: () => void,
	): Promise<PeerSavedResult<unknown>> {
		if (this.#closed || this.#tearingDown) return { kind: "not-sent", reason: "not-ready" };
		let request: NormalizedSavedTarget | null;
		try {
			request = normalizeSavedTarget(kind, target);
		} catch {
			// A hostile getter or revoked proxy is a malformed request, never a rejection.
			request = null;
		}
		if (request === null) return { kind: "not-sent", reason: "invalid-request" };
		// The caller's proof is required, not optional: without a real logical-read or
		// written-mutation fence nothing may be submitted at all.
		let proofValue: unknown;
		try {
			proofValue = isRecord(options) ? options.stillCurrent : undefined;
		} catch {
			proofValue = undefined;
		}
		if (typeof proofValue !== "function") return { kind: "not-sent", reason: "invalid-request" };
		const callerProof = proofValue as () => unknown;
		const callerHolds = (): boolean => {
			try {
				return callerProof() === true;
			} catch {
				// An unavailable caller proof is no proof at all.
				return false;
			}
		};
		// Without the explicit requester opt-in this side never offered Saved, so no
		// Saved frame exists to send at all.
		if (!this.#savedViewer) return { kind: "not-sent", reason: "capability-unsupported" };
		const runtime = this.#runtime.get(request.hostId);
		if (runtime === undefined) return { kind: "not-sent", reason: "target-unavailable" };
		const viewer = runtime.viewer;
		const metadata = runtime.channel;
		const client = runtime.client;
		const destinationEpoch = runtime.epoch;
		if (
			runtime.state !== "connected"
			|| viewer === null
			|| metadata === null
			|| client === null
		) return { kind: "not-sent", reason: "target-unavailable" };
		const hostRunId = request.request.hostRunId;
		if (!this.#savedFenceHolds(runtime, viewer, metadata, client, destinationEpoch, hostRunId)) {
			return { kind: "not-sent", reason: "target-unavailable" };
		}
		// The owner never acknowledged Saved for this channel: no frame exists.
		const saved = viewer.saved;
		if (saved === undefined || saved.supported !== true) {
			return { kind: "not-sent", reason: "capability-unsupported" };
		}
		// Admission: the caller's proof, then every borrowed fact re-proved AFTER it
		// returns, because it is arbitrary code that may reenter this coordinator.
		if (!callerHolds()) return { kind: "not-sent", reason: "target-unavailable" };
		if (!this.#savedFenceHolds(runtime, viewer, metadata, client, destinationEpoch, hostRunId)) {
			return { kind: "not-sent", reason: "target-unavailable" };
		}
		// Current last-advertised owner exposure only: no policy transition history.
		const deleteExposed = (): boolean =>
			this.#savedHostFacts(runtime, this.#readPin(runtime.id))?.deleteExposed === true;
		if (kind === "remove" && (!deleteExposed()
			|| !this.#savedFenceHolds(runtime, viewer, metadata, client, destinationEpoch, hostRunId))) {
			return { kind: "not-sent", reason: "target-unavailable" };
		}
		const sendOptions = Object.freeze({
			// The last-instant half of the same fence, evaluated synchronously by the
			// raw viewer immediately before its queued write calls `channel.send`.
			stillCurrent: (): boolean => {
				if (!callerHolds()) return false;
				if (kind === "remove") {
					if (!this.#savedFenceHolds(runtime, viewer, metadata, client, destinationEpoch, hostRunId)) return false;
					if (!deleteExposed()) return false;
				}
				return this.#savedFenceHolds(runtime, viewer, metadata, client, destinationEpoch, hostRunId);
			},
		});
		markInvoked();
		const result = await this.#dispatchSaved(saved, request, sendOptions);
		// The raw API's own positive not-sent stays true regardless of later changes.
		if (result.kind === "not-sent") return result;
		if (result.kind !== "owner-result") return { kind: "unknown" };
		// Correlated to the EXACT captured request: another run, catalog, result, or
		// offset establishes nothing about this one and is never retargeted.
		if (!savedOutcomeAnswers(request, result.outcome)) return { kind: "unknown" };
		// A read is description for the destination it was asked of: one that is no
		// longer the same live destination and run is not this request's. A resume or
		// delete the captured request saw completed stays reported exactly as
		// observed, even when the viewer, the owner policy, or a newer request moved
		// on afterwards: it is never turned into a refusal or a not-sent.
		if (
			isSavedRead(request.kind)
			&& !this.#savedFenceHolds(runtime, viewer, metadata, client, destinationEpoch, hostRunId)
		) {
			return { kind: "unknown" };
		}
		return result;
	}

	/** Hand one validated request to the matching raw Saved operation. */
	#dispatchSaved(
		saved: RosterBridgeSavedViewer,
		request: NormalizedSavedTarget,
		options: { readonly stillCurrent: () => boolean },
	): Promise<PeerSavedResult<unknown>> {
		switch (request.kind) {
			case "list":
				return saved.list(request.request, options);
			case "search":
				return saved.search(request.request, options);
			case "window":
				return saved.window(request.request, options);
			case "resume":
				return saved.resume(request.request, options);
			case "remove":
				return saved.remove(request.request, options);
			default:
				return Promise.resolve({ kind: "unknown" });
		}
	}

	/**
	 * The Saved fence: the requester opt-in, every fact one protected owner request
	 * borrowed (runtime identity, viewer, channel, client, destination epoch, pin,
	 * identity), and this side still observing the EXACT requested owner run. It is
	 * a pure read of current state, so it can be repeated at admission, inside the
	 * raw write boundary, and after a read completes.
	 */
	#savedFenceHolds(
		runtime: DestinationRuntime,
		viewer: RosterBridgeViewer,
		metadata: PeerByteChannel,
		client: PeerClient,
		destinationEpoch: number,
		hostRunId: string,
	): boolean {
		if (!this.#savedViewer) return false;
		if (this.#runtime.get(runtime.id) !== runtime) return false;
		if (!this.#protectedRequestFenceHolds(runtime, viewer, metadata, client, destinationEpoch)) return false;
		const observed = runtime.roster.hostRunId;
		return typeof observed === "string" && observed.length > 0 && observed === hostRunId;
	}

	// ------------------------------------------------------ selected content lane

	/**
	 * Immutable copy of the single global content observation. The published viewport
	 * itself is the endpoint's own deep-frozen object and is handed over unchanged.
	 */
	#readContent(): PeerContentObservation {
		const selection = this.#content;
		const view = selection.view;
		return Object.freeze({
			target: selection.desired === null ? null : copyContentTarget(selection.desired),
			state: selection.state,
			view: view === undefined
				? undefined
				: Object.freeze({
					hostId: view.hostId,
					selectionGeneration: view.selectionGeneration,
					snapshot: view.snapshot,
				}),
			reason: selection.reason,
		});
	}

	/**
	 * Hand the current observation to the advisory content callback. It is display
	 * only — it cannot steal focus or selection — and a callback that throws is
	 * contained here rather than allowed to gate content state.
	 */
	#publishContent(): void {
		const callback = this.#options.onContentChange;
		if (callback === undefined) return;
		try {
			callback(this.#readContent());
		} catch {
			// The observation is advisory; the state it describes already landed.
		}
	}

	#selectContent(target: PeerContentTarget | null): void {
		// Admission is latched by close(): a later selection is inert.
		if (this.#closed) return;
		const selection = this.#content;
		if (target === null) {
			// Local sessions and passive viewing select nothing. Clearing is immediate and
			// queues no remote notice beyond this endpoint's own bounded retirement.
			this.#replaceContentIntent({ desired: null, state: "none", reason: null });
			return;
		}
		const next = normalizeContentTarget(target);
		if (next === null) {
			// An unusable selection is reported, never guessed at: no local row, no
			// sibling destination, and no partial adoption of the fields that did look
			// representable.
			this.#replaceContentIntent({ desired: null, state: "unavailable", reason: "invalid-selection" });
			return;
		}
		const desired = selection.desired;
		if (desired !== null && next.selectionGeneration < desired.selectionGeneration) {
			// A stale generation from a superseded UI selection changes nothing at all.
			return;
		}
		if (desired !== null && sameContentTarget(desired, next)) {
			// Re-selecting the identical target is a no-op. It never tears down and
			// reopens a live stream, and it is never a disguised retry of a stream that
			// already failed or was lost: only a new selection or a fresh roster
			// observation of the already-selected target can start another attempt.
			return;
		}
		this.#replaceContentIntent({ desired: next, state: "connecting", reason: null });
	}

	/**
	 * Replace the intent synchronously: the current view is gone, a pending open is
	 * abandoned, and the previous endpoint's bounded retirement is registered before
	 * this call returns, so a late acknowledgement for the old target can never
	 * resurrect it and one click can never queue unbounded work.
	 */
	#replaceContentIntent(next: {
		desired: PeerContentTarget | null;
		state: PeerContentState;
		reason: PeerContentReason | null;
	}): void {
		const selection = this.#content;
		selection.epoch += 1;
		selection.spentEpoch = null;
		selection.desired = next.desired;
		selection.view = undefined;
		selection.state = next.state;
		selection.reason = next.reason;
		this.#retireContentEndpoint();
		this.#publishContent();
		if (next.desired !== null) this.#requestContentPump();
	}

	#updateContentViewport(viewport: PeerContentViewport): void {
		if (this.#closed) return;
		const selection = this.#content;
		const desired = selection.desired;
		if (desired === null) return;
		if (!isRecord(viewport)) return;
		if (viewport.selectionGeneration !== desired.selectionGeneration) return;
		if (
			!isContentDimension(viewport.cols, DEFAULT_SESSION_CONTENT_BOUNDS.maxCols)
			|| !isContentDimension(viewport.rows, DEFAULT_SESSION_CONTENT_BOUNDS.maxRows)
		) return;
		if (viewport.cols === desired.cols && viewport.rows === desired.rows) return;
		// Latest-only: the newest size replaces the pending one, and an endpoint that is
		// not attached yet picks these dimensions up when it attaches. No per-resize
		// promise, and no re-derivation of the owner's canonical geometry.
		selection.desired = Object.freeze({ ...desired, cols: viewport.cols, rows: viewport.rows });
		const endpoint = selection.endpoint;
		if (endpoint !== null && endpoint.epoch === selection.epoch) {
			try {
				endpoint.viewer.resize(viewport.cols, viewport.rows);
			} catch {
				// An endpoint that already retired ignores a resize; an invalid size was
				// refused above. Either way nothing accumulates and nothing restarts.
			}
		}
		this.#publishContent();
	}

	/**
	 * Ask the ONE content reconciler for a pass over the NEWEST intent.
	 *
	 * There is exactly one reconciler task per coordinator, independent of the
	 * selection epoch. Replacing a selection never starts a second task: it marks
	 * the work dirty, aborts the superseded open, and registers the superseded
	 * endpoint's bounded retirement, and the running task joins that retirement and
	 * then consumes only the newest intent. An arbitrary burst of selections
	 * therefore produces at most one outstanding reconciler and one outstanding
	 * open, never a promise per click waiting on the same retirement.
	 */
	#requestContentPump(): void {
		if (this.#closed || this.#tearingDown) return;
		this.#contentDirty = true;
		if (this.#contentPumping) return;
		this.#contentPumping = true;
		// The reconciler is owned tracked work that never rejects into the harness: an
		// unexpected fault can leave local resources whose release cannot be proven,
		// so it becomes sticky content-cleanup uncertainty instead of an unhandled
		// rejection or a claim of a settled close.
		const pass = this.#runContentPump().then(
			(): undefined => undefined,
			(): undefined => {
				this.#contentCleanupUnconfirmed = true;
				return undefined;
			},
		);
		void this.#track(pass);
	}

	/**
	 * The one tracked reconciler task. It stays the single owner of content work until
	 * nothing is dirty any more, so every pass it runs is inside the promise shutdown
	 * awaits, and a request that landed while a pass was unwinding still gets its pass.
	 */
	async #runContentPump(): Promise<void> {
		try {
			for (;;) {
				await this.#reconcileContent();
				if (!this.#contentDirty || this.#closed || this.#tearingDown) return;
			}
		} finally {
			this.#contentPumping = false;
		}
	}

	/**
	 * The single reconciler loop. Each pass works on the newest intent only, and a
	 * pass re-runs when a newer intent landed while it was awaiting, so supersession
	 * converges on the latest selection instead of stacking attempts.
	 */
	async #reconcileContent(): Promise<void> {
		while (this.#contentDirty) {
			this.#contentDirty = false;
			if (this.#closed || this.#tearingDown) return;
			const selection = this.#content;
			const epoch = selection.epoch;
			if (selection.desired === null) return;
			// Already streaming this exact intent, or its real attempt is spent: no
			// second stream and no silent retry until a new selection or a genuine
			// reachability transition re-arms the intent.
			if (selection.endpoint !== null && selection.endpoint.epoch === epoch) continue;
			if (selection.spentEpoch === epoch) continue;
			const retiring = selection.retirement;
			if (retiring !== null) {
				// One superseded endpoint retires (bounded by its own deadline) before
				// another subscription is installed, so replacements can never stack.
				try {
					await retiring;
				} catch {
					// The retirement recorded its own uncertainty; nothing is retried here.
				}
				if (this.#closed || this.#tearingDown) return;
				// Superseded while joining: loop and consume the newest intent instead.
				if (selection.epoch !== epoch) {
					this.#contentDirty = true;
					continue;
				}
				if (selection.desired === null) return;
				if (selection.spentEpoch === epoch) continue;
				if (selection.endpoint !== null && selection.endpoint.epoch === epoch) continue;
			}
			await this.#openContentAttempt(epoch);
			if (this.#closed || this.#tearingDown) return;
			// A replacement that landed during the attempt is handled by the next pass.
			if (selection.epoch !== epoch) this.#contentDirty = true;
		}
	}

	/** True only while this intent still owns the single content selection. */
	#contentIntentCurrent(epoch: number): boolean {
		return !this.#closed && !this.#tearingDown && this.#content.epoch === epoch;
	}

	/**
	 * Revalidate everything an ALREADY opened endpoint was authorized against. A
	 * live endpoint may publish only while its own borrowed destination runtime,
	 * metadata channel, client, and destination epoch are still current, the roster
	 * still holds the exact run and row, the remembered pin still matches the live
	 * metadata key, and this side still holds the identity that client proves. This
	 * is the after-await half of the same fence, not a second, weaker one.
	 */
	#contentEndpointFence(endpoint: ContentEndpoint): PeerContentReason | null {
		if (endpoint.runtime.state !== "connected") return "connection-lost";
		if (endpoint.runtime.channel !== endpoint.metadata) return "connection-lost";
		if (endpoint.runtime.client !== endpoint.client) return "connection-lost";
		if (endpoint.runtime.epoch !== endpoint.destinationEpoch) return "connection-lost";
		const refusal = this.#contentTargetFence(endpoint.runtime, endpoint.target);
		if (refusal !== null) return refusal;
		if (!peerKeysEqual(endpoint.channel.peerKey, endpoint.metadata.peerKey)) return "key-changed";
		return null;
	}

	/** Clear and retire the current endpoint because an authority fence failed. */
	#contentFenceFailed(epoch: number, refusal: PeerContentReason): void {
		this.#setContentUnavailable(epoch, refusal, false);
	}

	/**
	 * Everything that must hold before a content channel may be opened or used for a
	 * target: an actually connected destination, a complete CURRENT roster whose exact
	 * owner run contains the exact owner row, a remembered pin equal to the key the
	 * live metadata channel actually proved, and this side's current identity matching
	 * the borrowed client. Every failure is a fixed reason with no fallback selection.
	 */
	#contentTargetFence(runtime: DestinationRuntime, target: PeerContentTarget): PeerContentReason | null {
		if (runtime.state !== "connected" || runtime.channel === null || runtime.client === null) {
			return "destination-unavailable";
		}
		const roster = runtime.roster;
		if (roster.state !== "current" || roster.rows === null) return "roster-unavailable";
		if (roster.hostRunId === null) return "roster-unavailable";
		if (roster.hostRunId !== target.hostRunId) return "run-changed";
		if (!roster.rows.some((row) => row.id === target.rowId)) return "row-unavailable";
		const pin = this.#readPin(runtime.id);
		if (pin === null) return "key-unavailable";
		if (!peerKeysEqual(pin, runtime.channel.peerKey)) return "key-changed";
		const identity = this.#currentIdentity();
		if (identity === null) return "identity-unavailable";
		if (!peerKeysEqual(identity.key, runtime.client.key)) return "identity-unavailable";
		return null;
	}

	/**
	 * Open ONE content endpoint for one intent. Every fact the attempt depends on is
	 * checked before and re-checked after each await, so a superseded or falsified
	 * attempt attaches nothing, a late channel is closed instead, and a live endpoint
	 * keeps proving the same fences before it publishes anything.
	 *
	 * The bounded retirement of a superseded endpoint is joined by the reconciler
	 * loop, never here, so this function is the only outstanding open at a time.
	 */
	async #openContentAttempt(epoch: number): Promise<void> {
		const selection = this.#content;
		if (!this.#contentIntentCurrent(epoch)) return;
		let target = selection.desired;
		if (target === null) return;
		const runtime = this.#runtime.get(target.hostId);
		if (runtime === undefined) {
			this.#setContentUnavailable(epoch, "destination-unavailable", true);
			return;
		}
		const refusal = this.#contentTargetFence(runtime, target);
		if (refusal !== null) {
			this.#setContentUnavailable(epoch, refusal, true);
			return;
		}
		const destination = this.#destination(target.hostId);
		const metadata = runtime.channel;
		const client = runtime.client;
		if (destination === undefined || metadata === null || client === null) {
			this.#setContentUnavailable(epoch, "destination-unavailable", true);
			return;
		}
		// A genuinely reachable retained target is opening now. Do not publish a
		// stale missing-row refusal while its first viewport is still awaited.
		// This changes no authority, attempt ownership, or retry/rearm decision.
		selection.state = "connecting";
		selection.reason = null;
		const destinationEpoch = runtime.epoch;
		const abort = new AbortController();
		this.#contentAbort = abort;
		let channel: PeerByteChannel;
		try {
			// The borrowed destination client only. This per-connection approver rejects, so
			// a missing or changed key fails closed instead of prompting, pairing, creating
			// an identity, replacing a pin, or connecting anything new.
			channel = await client.connectApp({
				host: destination.host,
				port: destination.port,
				lane: "content",
				approveServerKey: () => "reject" as const,
				signal: abort.signal,
			});
		} catch (error) {
			if (this.#contentAbort === abort) this.#contentAbort = null;
			if (!this.#contentIntentCurrent(epoch)) return;
			this.#setContentUnavailable(epoch, contentOpenReason(error), false);
			return;
		}
		if (this.#contentAbort === abort) this.#contentAbort = null;
		const abandon = async (reason: PeerContentReason): Promise<void> => {
			// A late channel for a superseded intent is closed, never attached, and the
			// reconciler stays occupied until that bounded LOCAL close settles: an
			// abandoned channel is still owned work, so the pump must never consume a
			// replacement intent or subscribe elsewhere while it is outstanding. The close
			// is tracked, and an unconfirmed close stays a real failure.
			const closing = (async (): Promise<void> => {
				try {
					await channel.close();
				} catch {
					this.#contentCleanupUnconfirmed = true;
					this.#resourceCleanupFailed = true;
				}
			})();
			if (this.#contentIntentCurrent(epoch)) this.#setContentUnavailable(epoch, reason, false);
			await this.#track(closing);
		};
		const wrapChannel = this.#options.testHooks?.wrapClientChannel;
		if (wrapChannel !== undefined) {
			// Fixture-only: this content lane is one more already-authenticated outgoing
			// channel of the same borrowed client, so a controlled test peer can be
			// substituted for it. Production callers pass nothing and the verified
			// channel is used exactly as received; a refused substitution attaches
			// nothing and reports the same fixed open failure as a refused upgrade.
			try {
				channel = wrapChannel(channel);
			} catch {
				await abandon("open-failed");
				return;
			}
		}
		// Re-check every fence after the await, including the latest viewport intent, the
		// exact destination runtime/channel/client references this attempt borrowed, and
		// the exact TLS identity the content channel actually proved.
		target = selection.desired;
		const current = target === null ? undefined : this.#runtime.get(target.hostId);
		if (target === null || current === undefined) {
			await abandon("destination-unavailable");
			return;
		}
		// A reference or epoch mismatch is its own honest reason: the target fence can
		// still succeed while the borrowed references this attempt was authorized
		// against have already been replaced, and that attempt must never attach.
		if (
			current !== runtime
			|| metadata !== current.channel
			|| client !== current.client
			|| current.epoch !== destinationEpoch
		) {
			await abandon("connection-lost");
			return;
		}
		const refusalAfter = this.#contentTargetFence(current, target);
		if (refusalAfter !== null) {
			await abandon(refusalAfter);
			return;
		}
		if (!this.#contentIntentCurrent(epoch)) {
			await abandon("connection-lost");
			return;
		}
		if (channel.lane !== "content" || !peerKeysEqual(channel.peerKey, metadata.peerKey)) {
			await abandon("key-changed");
			return;
		}
		let live: ContentEndpoint | null = null;
		let viewer: SessionContentViewer;
		const nativeIo = this.#nativeIo;
		try {
			viewer = attachSessionContentViewer({
				channel,
				hostRunId: target.hostRunId,
				sessionId: target.rowId,
				cols: target.cols,
				rows: target.rows,
				onSnapshot: (snapshot): void => {
					if (live !== null) this.#onContentSnapshot(live, snapshot);
				},
				// The optional native IO capability is offered only for an explicit
				// callback binding, and each callback re-proves THIS endpoint before it
				// answers. `live` is assigned immediately after attach, so no input or
				// copy can be admitted against a half-built endpoint.
				...(nativeIo === null
					? {}
					: {
						nativeIo: {
							authorizeInput: (expected: NativeIoInputSource): boolean => (
								live !== null && this.#authorizeNativeInput(live, expected)
							),
							onCopy: (copy: NativeIoCompletedCopy): void => {
								if (live !== null) this.#routeNativeCopy(live, copy);
							},
						},
					}),
			});
		} catch {
			// Attaching refused before a handler was installed: only this channel is closed.
			await abandon("owner-refused");
			return;
		}
		// The endpoint carries every authority fact it was opened against, so every
		// later publication can re-prove them instead of trusting this await's
		// snapshot of the world.
		live = Object.freeze({
			epoch,
			target,
			channel,
			viewer,
			runtime,
			metadata,
			client,
			destinationEpoch,
		});
		selection.endpoint = live;
		const retired = (): void => {
			if (live !== null) this.#onContentEndpointClosed(live);
		};
		void viewer.closed.then(retired, retired);
		this.#publishContent();
		try {
			await viewer.ready;
		} catch (error) {
			if (!this.#contentIntentCurrent(epoch) || selection.endpoint !== live) return;
			this.#setContentUnavailable(epoch, contentViewerReason(error), false);
			return;
		}
		if (!this.#contentIntentCurrent(epoch) || selection.endpoint !== live) return;
		// Readiness is an await too: the pin, this side's identity, the destination
		// runtime/client/channel/epoch references, and the roster fence are all
		// re-proved before anything is announced as current.
		const staleAuthority = this.#contentEndpointFence(live);
		if (staleAuthority !== null) {
			this.#contentFenceFailed(epoch, staleAuthority);
			return;
		}
		// `ready` is this viewer's exact `subscribed` acknowledgement. It never means a
		// frame was written, observed, or rendered: `current` requires a complete view.
		if (selection.view !== undefined) selection.state = "current";
		selection.reason = null;
		this.#publishContent();
	}

	/**
	 * Record that the deliberate target cannot currently be streamed.
	 *
	 * `reachable` says whether the refusal happened BEFORE this endpoint ever touched
	 * the network (the target simply was not reachable yet, so a later roster
	 * observation of the SAME target may complete the one selection), or after a real
	 * channel/viewer attempt (which is never silently retried: the attempt stays
	 * spent until the operator selects again or the destination reconnects).
	 */
	#setContentUnavailable(epoch: number, reason: PeerContentReason, reachable: boolean): void {
		if (!this.#contentIntentCurrent(epoch)) return;
		const selection = this.#content;
		selection.spentEpoch = reachable ? null : epoch;
		selection.view = undefined;
		selection.state = "unavailable";
		selection.reason = reason;
		this.#retireContentEndpoint();
		this.#publishContent();
	}

	/**
	 * Publish, or refuse to publish, one viewport handed over by the live endpoint.
	 *
	 * A view becomes `current` only while the endpoint still proves every authority
	 * fact it was opened against: an identity or pin that went missing, a replaced
	 * destination channel or client, an advanced destination epoch, or a roster that
	 * no longer holds the exact run and row all stop publication immediately, with
	 * the endpoint retired and no stale frame kept up as a substitute.
	 */
	#onContentSnapshot(endpoint: ContentEndpoint, snapshot: SessionContentSnapshot | undefined): void {
		const selection = this.#content;
		// Only the endpoint this coordinator still owns can publish a view.
		if (selection.endpoint !== endpoint || selection.epoch !== endpoint.epoch) return;
		if (
			snapshot !== undefined
			&& (snapshot.meta.hostRunId !== endpoint.target.hostRunId
				|| snapshot.meta.sessionId !== endpoint.target.rowId)
		) {
			// The endpoint validates its own tuple; this is a second fence, not a filter:
			// content that is not the selected run and row is never displayed.
			selection.view = undefined;
			selection.state = "unavailable";
			selection.reason = "protocol-violation";
			selection.spentEpoch = endpoint.epoch;
			this.#retireContentEndpoint();
			this.#publishContent();
			return;
		}
		if (snapshot === undefined) {
			// The endpoint cleared its published view while still selected: content is no
			// longer current, and nothing older is kept up as a substitute.
			selection.view = undefined;
			selection.state = "unavailable";
			selection.reason = "content-lost";
			selection.spentEpoch = endpoint.epoch;
			this.#retireContentEndpoint();
			this.#publishContent();
			return;
		}
		const staleAuthority = this.#contentEndpointFence(endpoint);
		if (staleAuthority !== null) {
			// The stream can no longer prove the authority it was opened under, so this
			// viewport is not published even though it is well-formed: the view clears
			// synchronously and the endpoint retires with the fixed refusal reason.
			selection.view = undefined;
			selection.state = "unavailable";
			selection.reason = staleAuthority;
			selection.spentEpoch = endpoint.epoch;
			this.#retireContentEndpoint();
			this.#publishContent();
			return;
		}
		// A publication that changes the written source or the observed modes starts a
		// new input lifetime, EVEN when the change is restored (A -> B -> A) before the
		// next protected write. Caller code can do exactly that from inside its own
		// proof, so the generation — never a snapshot object, text, or present equality —
		// is what proves the request was admitted against the current lifetime.
		const previousMeta = selection.view?.snapshot.meta;
		if (this.#nativeIo !== null && previousMeta !== undefined
			&& nativeInputTargetChanged(previousMeta, snapshot.meta)) {
			this.#nativeInputGeneration += 1;
		}
		selection.view = Object.freeze({
			hostId: endpoint.target.hostId,
			selectionGeneration: endpoint.target.selectionGeneration,
			snapshot,
		});
		selection.state = "current";
		selection.reason = null;
		this.#publishContent();
	}

	/**
	 * The endpoint reported its own retirement. Its `closed` settles only after the
	 * local channel close settled, so this is confirmation of LOCAL cleanup and never a
	 * claim about the remote owner.
	 */
	#onContentEndpointClosed(endpoint: ContentEndpoint): void {
		const selection = this.#content;
		if (selection.endpoint !== endpoint) return;
		selection.endpoint = null;
		if (this.#closed || this.#tearingDown || selection.epoch !== endpoint.epoch) return;
		selection.view = undefined;
		selection.state = "unavailable";
		selection.reason = "connection-lost";
		// The attempt for this intent is spent: a content channel that died is never
		// silently reopened. Only a new selection, or the destination's existing
		// automatic reconnect producing a new run observation, restores the stream.
		selection.spentEpoch = endpoint.epoch;
		this.#publishContent();
	}

	/**
	 * Retire the current content endpoint as bounded, tracked, owned work. A
	 * content-only retirement never disposes the borrowed destination client, never
	 * touches the metadata channel, and never waits for a remote acknowledgement. An
	 * unconfirmed settlement is sticky: shutdown rejects instead of claiming a settled
	 * close, and a closed transport is never taken as proof the endpoint released its
	 * own resources.
	 */
	#retireContentEndpoint(): void {
		const selection = this.#content;
		const endpoint = selection.endpoint;
		const abort = this.#contentAbort;
		selection.endpoint = null;
		this.#contentAbort = null;
		if (abort !== null) {
			try {
				abort.abort();
			} catch {
				// The attempt already settled.
			}
		}
		if (endpoint === null) return;
		const previous = selection.retirement;
		const retirement = (async (): Promise<void> => {
			const results = await Promise.allSettled([
				...(previous === null ? [] : [previous]),
				endpoint.viewer.stop(),
			]);
			if (results.some((result) => result.status === "rejected")) {
				this.#contentCleanupUnconfirmed = true;
				this.#resourceCleanupFailed = true;
			}
		})();
		selection.retirement = retirement;
		void this.#track(retirement);
		const release = (): void => {
			if (selection.retirement === retirement) selection.retirement = null;
		};
		void retirement.then(release, release);
	}

	/* ------------------------------------------------------------------ *
	 * Native input / text copy (optional, bound to the ONE current endpoint)
	 * ------------------------------------------------------------------ */

	/**
	 * True only while this exact endpoint still owns the single current selection
	 * and every authority fact it was opened against still holds. This is the same
	 * fence the publishing path uses, never a second or weaker one, and it reads no
	 * metadata, token, or snapshot object identity.
	 */
	#nativeIoEndpointCurrent(endpoint: ContentEndpoint): boolean {
		const selection = this.#content;
		if (selection.endpoint !== endpoint) return false;
		if (selection.epoch !== endpoint.epoch) return false;
		if (!this.#contentIntentCurrent(endpoint.epoch)) return false;
		return this.#contentEndpointFence(endpoint) === null;
	}

	/**
	 * The endpoint's own complete, currently published native IO facts, described
	 * immutably: this selection's saved destination handle and generation, this
	 * endpoint's own subscription id, and the exact source and input modes the
	 * publisher wrote for the currently published view. Nothing is derived from a
	 * newer target and nothing here is authority.
	 */
	#nativeInputFacts(endpoint: ContentEndpoint): NativeInputFacts | null {
		const viewer = endpoint.viewer;
		// A legacy endpoint with no native IO primitives simply offers none: its
		// display behavior is untouched and no input or copy is ever described.
		if (typeof viewer.readNativeInputSource !== "function") return null;
		// The coordinator's own currently published view, carried unmodified: it is
		// the exact endpoint's complete viewport, and it is cleared the moment it stops
		// being current.
		const view = this.#content.view;
		if (view === undefined) return null;
		if (view.hostId !== endpoint.target.hostId) return null;
		if (view.selectionGeneration !== endpoint.target.selectionGeneration) return null;
		const meta = view.snapshot.meta;
		if (meta.subscriptionId !== viewer.subscriptionId) return null;
		if (meta.hostRunId !== endpoint.target.hostRunId || meta.sessionId !== endpoint.target.rowId) return null;
		const published = meta.inputSource;
		if (published === undefined || published === null) return null;
		// The endpoint's own negotiated, descriptive source must be the SAME semantic
		// source as the published view's; no text, object, or sequence identity is
		// involved, so ordinary output never blocks typing.
		const source = viewer.readNativeInputSource();
		if (source === undefined) return null;
		if (!nativeIoSourceEquals(source, published)) return null;
		return Object.freeze({
			target: Object.freeze({
				hostId: endpoint.target.hostId,
				selectionGeneration: endpoint.target.selectionGeneration,
				subscriptionId: viewer.subscriptionId,
				source: published,
				inputModes: meta.inputModes,
			}),
		});
	}

	/**
	 * The composed per-write input gate handed to the existing viewer endpoint. It
	 * runs for EVERY protected input write that endpoint makes, so it combines this
	 * coordinator's current selection/peer/pin/run/row/destination fences with the
	 * caller's dynamic written-source proof, and re-proves the fences AFTER that
	 * proof returns because it is arbitrary caller code that may reenter.
	 */
	#authorizeNativeInput(endpoint: ContentEndpoint, expected: NativeIoInputSource): boolean {
		const nativeIo = this.#nativeIo;
		if (nativeIo === null) return false;
		// THIS viewer's current remote input/copy preference, re-proved for every
		// protected write rather than read once at startup.
		if (!this.#viewerInputEnabledNow()) return false;
		if (!this.#nativeIoEndpointCurrent(endpoint)) return false;
		const before = this.#nativeInputFacts(endpoint);
		if (before === null) return false;
		// The endpoint hands over its own current published source; it must be the
		// exact source of this whole target, never a newer or older one.
		if (!nativeIoSourceEquals(expected, before.target.source)) return false;
		// Captured before caller code runs: a proof that publishes another source and
		// restores it (A -> B -> A), or turns the preference Off and On again, must
		// not leave this write looking admitted.
		const generation = this.#nativeInputGeneration;
		let allowed: boolean;
		try {
			allowed = nativeIo.authorizeInput(before.target) === true;
		} catch {
			return false;
		}
		if (!allowed) return false;
		// The proof may have resized, switched selection or focus, revoked a pin,
		// replaced the destination, changed the preference, or published a different
		// source and still returned `true`. Its answer is never trusted: re-prove
		// everything, including the semantic source and the observed modes, without
		// comparing snapshot objects or sequences (ordinary output must not block
		// typing).
		if (!this.#viewerInputEnabledNow()) return false;
		if (!this.#nativeIoEndpointCurrent(endpoint)) return false;
		if (generation !== this.#nativeInputGeneration) return false;
		const after = this.#nativeInputFacts(endpoint);
		if (after === null) return false;
		if (!nativeIoSourceEquals(expected, after.target.source)) return false;
		return nativeInputModesEqual(before.target.inputModes, after.target.inputModes);
	}

	/**
	 * Descriptive facts for the caller, never permission and never a proof: this is
	 * PURE description of the one current endpoint, so the caller's own dynamic
	 * proof may call it again from inside that proof without recursing.
	 */
	#readNativeInputTarget(): PeerNativeInputTarget | undefined {
		if (this.#nativeIo === null) return undefined;
		// While this viewer's remote input/copy is Off there is no target to describe.
		if (!this.#viewerInputEnabledNow()) return undefined;
		const endpoint = this.#content.endpoint;
		if (endpoint === null) return undefined;
		if (!this.#nativeIoEndpointCurrent(endpoint)) return undefined;
		const facts = this.#nativeInputFacts(endpoint);
		return facts === null ? undefined : facts.target;
	}

	/**
	 * Submit one caller-normalized input to the SAME viewer endpoint that published
	 * the target. The caller's own expected source and modes are what the wire
	 * carries: this method never substitutes the owner's current facts for them and
	 * never retargets one stream's input onto another. Everything that can be proven
	 * before a write is proven before the delegate is invoked; once it is invoked, an
	 * unknown outcome stays `unknown` instead of a false `not-sent`.
	 */
	async #sendNativeInput(request: PeerNativeInputRequest): Promise<NativeInputSendResult> {
		const nativeIo = this.#nativeIo;
		if (nativeIo === null) return nativeInputNotSent("not-negotiated");
		const expected = ((): PeerNativeInputRequest | null => {
			try {
				return readNativeInputRequest(request);
			} catch {
				// A hostile getter, revoked proxy, or otherwise throwing argument is a
				// refusal, never a rejected call from this seam.
				return null;
			}
		})();
		if (expected === null) return nativeInputNotSent("invalid-input");
		// This viewer's own remote input/copy preference: Off refuses before anything
		// is handed to the endpoint, without touching the connection or the owner.
		if (!this.#viewerInputEnabledNow()) return nativeInputNotSent("unauthorized");
		const endpoint = this.#content.endpoint;
		// Feature-detect the endpoint's own optional primitives: an older endpoint
		// keeps its exact display behavior and simply cannot accept input.
		if (endpoint === null
			|| typeof endpoint.viewer.sendInput !== "function"
			|| typeof endpoint.viewer.readNativeInputSource !== "function") {
			return nativeInputNotSent("not-negotiated");
		}
		if (!this.#nativeIoEndpointCurrent(endpoint)) return nativeInputNotSent("not-ready");
		const before = this.#nativeInputFacts(endpoint);
		if (before === null) return nativeInputNotSent("not-ready");
		// The caller's expectation must BE this endpoint's current target, field by
		// field. A different host handle, generation, subscription, source, or mode set
		// is a stale or foreign request, never something to reinterpret.
		if (expected.hostId !== before.target.hostId
			|| expected.selectionGeneration !== before.target.selectionGeneration
			|| expected.subscriptionId !== before.target.subscriptionId
			|| !nativeIoSourceEquals(expected.source, before.target.source)) {
			return nativeInputNotSent("stale-source");
		}
		if (!nativeInputModesEqual(expected.inputModes, before.target.inputModes)) {
			return nativeInputNotSent("stale-modes");
		}
		// Captured BEFORE the caller's proof runs: that callback is arbitrary code and
		// may publish another source and restore it again before returning.
		const generation = this.#nativeInputGeneration;
		let allowed: boolean;
		try {
			allowed = nativeIo.authorizeInput(before.target) === true;
		} catch {
			return nativeInputNotSent("unauthorized");
		}
		if (!allowed) return nativeInputNotSent("unauthorized");
		// Reentry may have turned this viewer's preference Off, or replaced the
		// selection, the source, or the modes while the caller's proof ran: nothing is
		// handed to the endpoint for facts that moved.
		if (!this.#viewerInputEnabledNow()) return nativeInputNotSent("unauthorized");
		if (!this.#nativeIoEndpointCurrent(endpoint)) return nativeInputNotSent("stale-source");
		// A source lifetime or preference that changed at all — including A -> B -> A
		// or Off -> On, which present equality cannot see — invalidates this admission
		// before anything is written.
		if (generation !== this.#nativeInputGeneration) return nativeInputNotSent("stale-source");
		const after = this.#nativeInputFacts(endpoint);
		if (after === null) return nativeInputNotSent("not-ready");
		if (!nativeIoSourceEquals(expected.source, after.target.source)) {
			return nativeInputNotSent("stale-source");
		}
		if (!nativeInputModesEqual(expected.inputModes, after.target.inputModes)) {
			return nativeInputNotSent("stale-modes");
		}
		try {
			// The endpoint re-proves its own state, this exact source/modes pair, and this
			// composed gate immediately before every protected write; the caller's own
			// expected source and modes are what it is asked to write.
			return await endpoint.viewer.sendInput({
				source: expected.source,
				inputModes: expected.inputModes,
				kind: expected.kind,
				text: expected.text,
			});
		} catch {
			// The delegate was invoked, so bytes may already exist: never report a false
			// "nothing happened", and never retry, replay, reconnect, or re-grant.
			return { status: "unknown" };
		}
	}

	/**
	 * Forward one atomically assembled copy to the caller's callback ONLY while it is
	 * still this coordinator's current endpoint, selection, subscription, and exact
	 * published source. There is no dispatch-order heuristic, broadcast, OSC 52
	 * emission, local clipboard write, or owner-local fallback: a copy that cannot
	 * prove all of that is dropped, and a throwing callback is contained.
	 */
	#routeNativeCopy(endpoint: ContentEndpoint, copy: NativeIoCompletedCopy): void {
		const nativeIo = this.#nativeIo;
		if (nativeIo === null) return;
		// While this viewer's remote input/copy is Off a completed copy is dropped
		// here: no clipboard write is requested. Nothing is cancelled on the owner.
		if (!this.#viewerInputEnabledNow()) return;
		if (!this.#nativeIoEndpointCurrent(endpoint)) return;
		if (copy.subscriptionId !== endpoint.viewer.subscriptionId) return;
		const facts = this.#nativeInputFacts(endpoint);
		if (facts === null) return;
		// Exact semantic equality of the WHOLE source, checked once more on the
		// completed data: a source change while the pages arrived never hands an
		// older copy to a newer view, and an A -> B -> A return never revives it.
		if (!nativeIoSourceEquals(copy.source, facts.target.source)) return;
		const receipt: PeerNativeCopyReceipt = Object.freeze({
			subscriptionId: copy.subscriptionId,
			copyId: copy.copyId,
			sequence: copy.sequence,
			source: copy.source,
			dispatchId: copy.dispatchId,
			event: copy.event,
			hostId: endpoint.target.hostId,
			selectionGeneration: endpoint.target.selectionGeneration,
		});
		try {
			nativeIo.onCopy(receipt);
		} catch {
			// The caller's own clipboard/focus proof and any OS write stay its business;
			// nothing is retried, replayed, or fallen back to here.
		}
	}

	/**
	 * A destination that lost its connection cannot carry content either. The
	 * authorized view is cleared and its endpoint retired immediately; the deliberate
	 * selection itself is kept as an honest `unavailable` so an existing automatic
	 * recovery may restore exactly that target. Removal preserves the old target too;
	 * a re-added destination has a different local id and cannot inherit it.
	 */
	#contentLostHost(hostId: string, reason: PeerContentReason, removed = false): void {
		const selection = this.#content;
		if (selection.desired === null || selection.desired.hostId !== hostId) return;
		// A genuine connection loss is a reachability transition, so it re-arms the
		// deliberate selection even when content was ALREADY unavailable because an
		// earlier attempt failed. Without the epoch bump here, a later current roster
		// for the same run and row would be rejected as "already attempted" and the
		// existing automatic reconnect could never restore the selected target.
		const rearm = selection.endpoint !== null
			|| selection.state !== "unavailable"
			|| selection.reason !== reason
			|| selection.spentEpoch !== null
			|| removed;
		selection.epoch += 1;
		selection.spentEpoch = null;
		selection.view = undefined;
		selection.state = "unavailable";
		selection.reason = reason;
		this.#retireContentEndpoint();
		if (rearm) this.#publishContent();
	}

	/** Close owns the selection too: it is cleared before the first await. */
	#clearContentForShutdown(): void {
		const selection = this.#content;
		selection.epoch += 1;
		selection.spentEpoch = null;
		selection.desired = null;
		selection.view = undefined;
		selection.state = "none";
		selection.reason = null;
		this.#contentDirty = false;
		this.#retireContentEndpoint();
		this.#publishContent();
	}

	/**
	 * Re-check the one deliberate selection against a fresh roster. Restoring content
	 * requires the SAME target on a connection that already exists; losing the exact
	 * run or row stops claiming content. Never a new connection, never a different row,
	 * and never a rewritten target.
	 *
	 * A reachable target hands the work to the single reconciler, which decides
	 * whether the newest intent still needs an attempt. A target that stopped being
	 * reachable is re-armed (epoch bumped, spent attempt cleared) even when content is
	 * already unavailable, so row-loss recovery does not depend on whether the content
	 * channel or the metadata roster noticed first, while an unchanged repeat
	 * projection never restarts a spent network attempt.
	 */
	#reconcileContentWithRoster(hostId: string): void {
		if (this.#closed || this.#tearingDown) return;
		const selection = this.#content;
		const desired = selection.desired;
		if (desired === null || desired.hostId !== hostId) return;
		const runtime = this.#runtime.get(hostId);
		const refusal = runtime === undefined
			? "destination-unavailable" as const
			: this.#contentTargetFence(runtime, desired);
		if (refusal === null) {
			this.#requestContentPump();
			return;
		}
		const streaming = selection.endpoint !== null || selection.state === "current";
		if (!streaming && selection.reason === refusal && selection.spentEpoch === null) return;
		selection.epoch += 1;
		selection.spentEpoch = null;
		selection.view = undefined;
		selection.state = "unavailable";
		selection.reason = refusal;
		this.#retireContentEndpoint();
		this.#publishContent();
	}

	/** Last-observed rows and owner run are kept as stale, never as current. */
	#markRosterStale(runtime: DestinationRuntime): void {
		runtime.roster = runtime.roster.rows === null
			? { state: "never", rows: null, hostRunId: null }
			: { state: "stale", rows: runtime.roster.rows, hostRunId: runtime.roster.hostRunId };
	}

	// --------------------------------------------------------------- commands

	async #commandListener(command: Record<string, unknown>): Promise<void> {
		const enabled = command.enabled;
		const hostText = command.host;
		const portText = command.port;
		if (typeof enabled !== "boolean" || typeof hostText !== "string" || typeof portText !== "string") {
			this.#transientNotice = NOTICE.invalidRequest;
			this.#emit();
			return;
		}
		const preferences = this.#preferences;
		if (preferences === null) {
			this.#transientNotice = NOTICE.preferencesUnavailable;
			this.#emit();
			return;
		}
		// Every listener command owns exactly one intent, and taking it invalidates
		// any earlier Enable that is still waiting on identity or teardown.
		const intent = ++this.#listenerIntentEpoch;
		const host = hostText.trim();
		const port = parsePeerPortText(portText, true);

		if (!enabled) {
			// Restrictive action: stop now, then save the DESIRED intent. The
			// teardown outcome is tracked and displayed separately (an unconfirmed
			// stop keeps an error state), so a saved "off" never claims a settled
			// release of the port.
			await this.#stopListener();
			if (!this.#listenerIntentCurrent(intent)) return;
			// Apply the hosting change to the LATEST document: teardown may have
			// overlapped a destination, suppression, history, or bell change that
			// must survive instead of being overwritten by this captured copy.
			const latest = this.#preferences;
			if (latest !== null) {
				const hosting = {
					enabled: false,
					bindHost: isValidPeerEndpointHost(host) ? host : latest.hosting.bindHost,
					bindPort: port !== null && port > 0 ? port : latest.hosting.bindPort,
				};
				this.#savePreferences({ ...latest, hosting }, { applyOnFailure: true });
			}
			this.#emit();
			return;
		}

		if (!isValidPeerEndpointHost(host) || port === null) {
			this.#transientNotice = NOTICE.invalidBind;
			this.#emit();
			return;
		}
		const hosting = { enabled: true, bindHost: host, bindPort: port };
		// The intent is saved before anything listens; a save failure reports and
		// starts nothing rather than leaving an unsaved background listener.
		if (!this.#savePreferences({ ...preferences, hosting }, { applyOnFailure: false })) return;
		const identity = await this.#ensureIdentity();
		if (!this.#listenerIntentCurrent(intent)) return;
		if (identity === null) {
			this.#setListenerError(intent, NOTICE.identityUnavailable);
			return;
		}
		await this.#startListener(host, port, intent);
	}

	#commandAutoReconnect(command: Record<string, unknown>): void {
		const enabled = command.enabled;
		if (typeof enabled !== "boolean") {
			this.#transientNotice = NOTICE.invalidRequest;
			this.#emit();
			return;
		}
		const preferences = this.#preferences;
		if (preferences === null) {
			this.#transientNotice = NOTICE.preferencesUnavailable;
			this.#emit();
			return;
		}
		this.#savePreferences({ ...preferences, autoReconnect: enabled }, { applyOnFailure: true });
		if (enabled) {
			for (const runtime of this.#runtime.values()) runtime.autoAttempts = 0;
			this.#scheduleEligibleAutoAttempts();
		} else {
			// Auto off cancels automatic attempts, not healthy connections.
			this.#cancelAutomaticAttempts();
		}
		this.#emit();
	}

	#commandBell(command: Record<string, unknown>): void {
		const enabled = command.enabled;
		if (typeof enabled !== "boolean") {
			this.#transientNotice = NOTICE.invalidRequest;
			this.#emit();
			return;
		}
		const preferences = this.#preferences;
		if (preferences === null) {
			this.#transientNotice = NOTICE.preferencesUnavailable;
			this.#emit();
			return;
		}
		// A display preference never requires an identity or the key directory.
		this.#savePreferences({ ...preferences, bellEnabled: enabled });
		this.#emit();
	}

	/**
	 * Viewer-side remote native input/copy for THIS host's displayed remote pane.
	 * Saved like every other display preference (write before publish, no identity,
	 * key, listener, or socket); it never disconnects, revokes, reconnects, changes
	 * Hosting/Auto, re-negotiates the content lane, or touches owner framing. The
	 * effective change is recorded synchronously by the one preferences apply path.
	 */
	#commandViewerNativeInput(command: Record<string, unknown>): void {
		const enabled = command.enabled;
		if (typeof enabled !== "boolean") {
			this.#transientNotice = NOTICE.invalidRequest;
			this.#emit();
			return;
		}
		const preferences = this.#preferences;
		if (preferences === null) {
			this.#transientNotice = NOTICE.preferencesUnavailable;
			this.#emit();
			return;
		}
		this.#savePreferences({ ...preferences, viewerNativeInputEnabled: enabled });
		this.#emit();
	}

	/**
	 * Owner-side policy for exposing remote saved-history deletion to paired
	 * viewers. Saved like every other preference; it changes no listener, grant,
	 * connection, local Saved deletion, or viewer input, and it exposes nothing by
	 * itself — it is the live fact the owner Saved exchange reads, and an actual
	 * change is described to existing bindings by the one preferences apply path.
	 */
	#commandRemoteHistoryDelete(command: Record<string, unknown>): void {
		const enabled = command.enabled;
		if (typeof enabled !== "boolean") {
			this.#transientNotice = NOTICE.invalidRequest;
			this.#emit();
			return;
		}
		const preferences = this.#preferences;
		if (preferences === null) {
			this.#transientNotice = NOTICE.preferencesUnavailable;
			this.#emit();
			return;
		}
		this.#savePreferences({ ...preferences, remoteHistoryDeleteEnabled: enabled });
		this.#emit();
	}

	#commandAdd(command: Record<string, unknown>): void {
		const labelText = command.label;
		const hostText = command.host;
		const portText = command.port;
		if (typeof labelText !== "string" || typeof hostText !== "string" || typeof portText !== "string") {
			this.#transientNotice = NOTICE.invalidRequest;
			this.#emit();
			return;
		}
		const preferences = this.#preferences;
		if (preferences === null) {
			this.#transientNotice = NOTICE.preferencesUnavailable;
			this.#emit();
			return;
		}
		const label = labelText.trim();
		const host = hostText.trim();
		const port = parsePeerPortText(portText, false);
		if (!isValidPeerLabel(label) || !isValidPeerEndpointHost(host) || port === null) {
			this.#transientNotice = NOTICE.invalidDestination;
			this.#emit();
			return;
		}
		if (preferences.destinations.length >= MAX_PEER_DESTINATIONS) {
			this.#transientNotice = NOTICE.tooManyDestinations;
			this.#emit();
			return;
		}
		const destination: PeerDestination = {
			id: randomUUID(),
			label,
			host,
			port,
			previouslyConnected: false,
			reconnectSuppressed: false,
		};
		// Saving a destination is configuration only: no identity, key, or socket.
		if (!this.#savePreferences({
			...preferences,
			destinations: [...preferences.destinations, destination],
		})) {
			return;
		}
		this.#runtimeFor(destination);
		this.#emit();
	}

	async #commandConnect(command: Record<string, unknown>): Promise<void> {
		const hostId = command.hostId;
		if (typeof hostId !== "string") {
			this.#transientNotice = NOTICE.invalidRequest;
			this.#emit();
			return;
		}
		const destination = this.#destination(hostId);
		if (destination === undefined) {
			this.#transientNotice = NOTICE.unknownDestination;
			this.#emit();
			return;
		}
		const runtime = this.#runtimeFor(destination);
		if (runtime.retryTimer !== null) {
			clearTimeout(runtime.retryTimer);
			runtime.retryTimer = null;
		}
		// An explicit Connect overrides an automatic attempt that is still in
		// flight; a second explicit attempt is ignored rather than interleaved.
		if (runtime.mode === "auto") {
			runtime.epoch += 1;
			const abort = runtime.abort;
			runtime.abort = null;
			abort?.abort();
			const client = runtime.client;
			runtime.client = null;
			client?.dispose();
			runtime.mode = null;
			runtime.state = "disconnected";
			runtime.message = null;
		}
		runtime.autoAttempts = 0;
		if (destination.reconnectSuppressed || this.#suppressionOverride.has(hostId)) {
			const preferences = this.#preferences;
			if (preferences !== null) {
				const next: PeerPreferences = {
					...preferences,
					destinations: preferences.destinations.map((entry) => (
						entry.id === hostId ? { ...entry, reconnectSuppressed: false } : entry
					)),
				};
				// Explicit Connect re-arms this destination even if the save fails; the
				// notice reports that the persisted suppression was not updated.
				this.#savePreferences(next, { applyOnFailure: true });
			}
			this.#suppressionOverride.delete(hostId);
			this.#emit();
		}
		await this.#connectDestination(hostId, "explicit");
	}

	#commandDisconnect(command: Record<string, unknown>): void {
		const hostId = command.hostId;
		if (typeof hostId !== "string") {
			this.#transientNotice = NOTICE.invalidRequest;
			this.#emit();
			return;
		}
		const destination = this.#destination(hostId);
		if (destination === undefined) {
			this.#transientNotice = NOTICE.unknownDestination;
			this.#emit();
			return;
		}
		// Association, trust, and history are preserved; only automatic attempts
		// are suppressed until an explicit Connect.
		this.#cancelActivity(hostId, null);
		this.#suppressionOverride.add(hostId);
		const preferences = this.#preferences;
		if (preferences !== null) {
			const next: PeerPreferences = {
				...preferences,
				destinations: preferences.destinations.map((entry) => (
					entry.id === hostId ? { ...entry, reconnectSuppressed: true } : entry
				)),
			};
			if (this.#savePreferences(next, { applyOnFailure: true })) this.#suppressionOverride.delete(hostId);
		}
		this.#emit();
	}

	#commandRemove(command: Record<string, unknown>): void {
		const hostId = command.hostId;
		if (typeof hostId !== "string") {
			this.#transientNotice = NOTICE.invalidRequest;
			this.#emit();
			return;
		}
		const destination = this.#destination(hostId);
		if (destination === undefined) {
			this.#transientNotice = NOTICE.unknownDestination;
			this.#emit();
			return;
		}
		this.#cancelActivity(hostId, null);
		// The unavailable selection is preserved under its old destination id. Re-adding
		// this endpoint creates a different id and must never retarget that selection.
		this.#contentLostHost(hostId, "connection-lost", true);
		// Forgetting this side's remembered server key is local only. It never
		// revokes the other host's receiving grant and never stops its sessions.
		const store = this.#trustStore;
		if (store !== null) {
			try {
				store.rememberedFor(hostId).clear();
			} catch (error) {
				this.#transientNotice = NOTICE.pinNotCleared;
				// The original refusal keeps its sanitized reason and fixed object.
				this.#noteStorageRefusal("trust", error, true);
			}
		}
		const preferences = this.#preferences;
		if (preferences !== null) {
			const next: PeerPreferences = {
				...preferences,
				destinations: preferences.destinations.filter((entry) => entry.id !== hostId),
			};
			if (this.#savePreferences(next)) {
				this.#runtime.delete(hostId);
				this.#suppressionOverride.delete(hostId);
			} else {
				this.#transientNotice = NOTICE.removeUnsaved;
			}
		}
		this.#emit();
	}

	#commandRevoke(command: Record<string, unknown>): void {
		const peerId = command.peerId;
		if (typeof peerId !== "string" || peerId.length === 0) {
			this.#transientNotice = NOTICE.invalidRequest;
			this.#emit();
			return;
		}
		const store = this.#trustStore;
		if (store === null) {
			this.#transientNotice = NOTICE.trustUnavailable;
			this.#emit();
			return;
		}
		let trust: ReturnType<PeerStateStore["readTrustSnapshot"]>;
		try {
			trust = store.readTrustSnapshot();
		} catch {
			this.#transientNotice = NOTICE.trustUnavailable;
			this.#emit();
			return;
		}
		if (trust === null) {
			this.#transientNotice = NOTICE.unknownPeer;
			this.#emit();
			return;
		}
		const keyIds = new Set<string>([
			...trust.acceptedPeers.map((record) => record.key.keyId),
			...trust.grants.map((record) => record.peerKeyId),
		]);
		let target: string | null = null;
		for (const keyId of keyIds) {
			let handle: string;
			try {
				handle = peerHandleFor(keyId);
			} catch {
				continue;
			}
			if (handle === peerId) {
				target = keyId;
				break;
			}
		}
		if (target === null) {
			this.#transientNotice = NOTICE.unknownPeer;
			this.#emit();
			return;
		}
		// This side's receiving permission only: no opposite-direction change, no
		// session stop, no manager shutdown. The lifecycle-local denial is recorded
		// BEFORE persistence so a failed save is still restrictive now; a fresh
		// explicit inbound approval is what lifts it again.
		this.#receiverDenials.add(target);
		let failed = false;
		try {
			store.grants.delete(target);
		} catch (error) {
			failed = true;
			this.#noteStorageRefusal("trust", error, true);
		}
		if (!failed) {
			try {
				store.acceptedPeers.delete(target);
			} catch (error) {
				failed = true;
				this.#noteStorageRefusal("trust", error, true);
			}
		}
		if (failed) this.#transientNotice = NOTICE.revokeFailed;
		this.#stopInboundBindings(target);
		this.#emit();
	}

	#stopInboundBindings(keyId: string): void {
		const bindings = this.#inboundBindings.get(keyId);
		if (bindings === undefined) return;
		// Ownership is released only by a confirmed settlement. A binding whose bounded
		// local stop could not be confirmed stays registered, marks this lifecycle's
		// cleanup unconfirmed so shutdown rejects rather than claiming a settled revoke,
		// and is retired again by the next listener sweep instead of having its failure
		// swallowed here.
		this.#inboundBindings.delete(keyId);
		const retirement = (async (): Promise<void> => {
			const results = await Promise.allSettled(bindings.map((binding) => binding.stop()));
			const retained = bindings.filter((_binding, index) => results[index]?.status === "rejected");
			if (retained.length === 0) return;
			this.#resourceCleanupFailed = true;
			this.#retainInboundBindings(retained);
			this.#emit();
		})();
		this.#trackNetworkRetirement(retirement);
	}

	// --------------------------------------------------------------- snapshots

	/**
	 * The ONE place the in-memory preferences change. Every caller keeps its own
	 * existing write-before-publish and apply-on-failure semantics; this only
	 * records an actual change of the effective viewer preference synchronously.
	 */
	#applyPreferences(next: PeerPreferences | null): void {
		this.#preferences = next;
		this.#noteViewerInputPolicy();
		this.#noteRemoteHistoryPolicy();
	}

	/**
	 * Record an actual effective change of the OWNER's remote-history delete
	 * exposure — On -> Off, Off -> On, protected settings becoming unavailable, or
	 * close — and push it to the existing owner bindings as a description through
	 * the bridge's own notification. This is never a roster refresh, resubscribe, or
	 * rebind, and it never cancels or rewrites a delete the owner already
	 * completed: the bridge re-reads the live policy itself at every decision. An
	 * unchanged value notifies nothing, so an unrelated settings save never
	 * disturbs an in-flight delete proof.
	 */
	#noteRemoteHistoryPolicy(): void {
		const exposed = this.readRemoteHistoryDeleteEnabled();
		if (exposed === this.#remoteHistoryDeleteEffective) return;
		this.#remoteHistoryDeleteEffective = exposed;
		const bridge = this.#bridge;
		if (bridge === null) return;
		try {
			bridge.notifySavedPolicy?.();
		} catch {
			// Description only: every delete is still re-checked against the live policy.
		}
	}

	/** Effective viewer-side remote input/copy preference right now (fail closed). */
	#viewerInputEnabledNow(): boolean {
		if (this.#closed || this.#tearingDown || this.#preferencesHandleUnusable) return false;
		if (this.#storageRestart !== null) return false;
		const preferences = this.#preferences;
		return preferences !== null && preferences.viewerNativeInputEnabled === true;
	}

	/**
	 * Record an actual effective change of the viewer preference. Each change —
	 * On -> Off and Off -> On alike — advances its own generation AND the native
	 * input generation, so an admission captured before it can never complete and
	 * a later return to the same value never revives it.
	 */
	#noteViewerInputPolicy(): void {
		const enabled = this.#viewerInputEnabledNow();
		if (enabled === this.#viewerInputEffective) return;
		this.#viewerInputEffective = enabled;
		this.#viewerInputGeneration += 1;
		this.#nativeInputGeneration += 1;
	}

	#readViewerNativeInputPolicy(): PeerViewerNativeInputPolicy {
		// Re-derived on every read: a lifecycle latch that has not been recorded yet
		// still reads Off, and never as a stale On.
		this.#noteViewerInputPolicy();
		return Object.freeze({
			enabled: this.#viewerInputEffective && this.#nativeIo !== null,
			generation: this.#viewerInputGeneration,
		});
	}

	#savePreferences(next: PeerPreferences, options: { applyOnFailure?: boolean } = {}): boolean {
		const store = this.#preferencesStore;
		if (store === null) {
			this.#transientNotice = this.#transientNotice ?? NOTICE.preferencesUnavailable;
			return false;
		}
		let value: PeerPreferences;
		try {
			value = validatePeerPreferences(next);
		} catch {
			this.#transientNotice = NOTICE.preferencesUnsaved;
			this.#emit();
			return false;
		}
		try {
			store.write(value);
			this.#applyPreferences(value);
			return true;
		} catch (error) {
			this.#noteStorageRefusal("settings", error, true);
			// A failure at or after the store's commit point poisons its handle: the
			// protected settings are then unavailable for this lifecycle, and both the
			// viewer native I/O and owner delete policies fail closed (recorded BEFORE
			// any apply, so the change-only notifications see the closed value). A pre-commit
			// failure leaves the handle usable and changes nothing here.
			if (!this.#preferencesHandleUsable(store)) this.#preferencesHandleUnusable = true;
			if (options.applyOnFailure === true) {
				// A restrictive or history change takes effect for this session even
				// when it could not be saved; the notice keeps that unsaved.
				this.#applyPreferences(value);
			}
			// Change-only: a usable handle with an unchanged policy notifies nothing.
			this.#noteViewerInputPolicy();
			this.#noteRemoteHistoryPolicy();
			this.#transientNotice = NOTICE.preferencesUnsaved;
			this.#emit();
			return false;
		}
	}

	/**
	 * Whether the protected preferences handle can still be used. The store's own
	 * `read()` is a pure in-memory check that throws once the handle was poisoned
	 * (a publication failure at or after its commit point) or closed; it performs
	 * no filesystem access.
	 */
	#preferencesHandleUsable(store: PeerPreferencesStore): boolean {
		try {
			store.read();
			return true;
		} catch {
			return false;
		}
	}
	// ------------------------------------------------- storage refusal/repair

	/**
	 * Record one protected-store refusal with the sanitized diagnostic its
	 * ORIGINAL error carried (Refs #494). The error itself is never displayed or
	 * kept; only the closed reason/object is. `assessNow` runs the one read-only
	 * eligibility assessment immediately for a refusal after startup.
	 */
	#noteStorageRefusal(store: PeerUiStorageProblem["store"], error: unknown, assessNow: boolean): void {
		const diagnostic = peerStorageDiagnostic(error);
		// A refusal without a sanitized storage diagnostic during an ordinary
		// command (for example an invalid argument) is not a storage problem.
		if (diagnostic === null && assessNow) return;
		const reason = diagnostic?.reason ?? null;
		const object = diagnostic?.object ?? null;
		if (!this.#storageProblems.some((problem) => problem.store === store
			&& problem.reason === reason && problem.object === object)) {
			this.#storageProblems.push(Object.freeze({ store, reason, object }));
		}
		if (assessNow) this.#assessStorageIfApplicable();
	}

	/**
	 * Run the read-only assessment only when a recorded refusal is a permission
	 * problem the explicit repair could address (broad mode/DACL bits or a
	 * supported granting extended ACL). Other reasons (malformed,
	 * missing-initialized, foreign owner, ...) are explained, never assessed or
	 * offered a repair. This never changes anything on disk.
	 */
	#assessStorageIfApplicable(): void {
		if (this.#storageRestart !== null) return;
		if (!this.#storageProblems.some((problem) => problem.reason === "unsafe-permissions"
			|| problem.reason === "extended-acl")) return;
		this.#assessStorage();
	}

	#assessStorage(): void {
		this.#storageGeneration += 1;
		try {
			this.#storageAssessment = this.#storageAssess({ agentDir: this.#options.agentDir });
			this.#storageAssessmentFailed = false;
		} catch {
			this.#storageAssessment = null;
			this.#storageAssessmentFailed = true;
		}
	}

	/**
	 * True only when no Network work owns state that a protection change could
	 * race: no listener (bound, starting, or retiring), no outgoing attempt,
	 * client, channel, or viewer, no content endpoint or retirement, and no
	 * unconfirmed teardown. Pending automatic retry TIMERS do not own state and
	 * may be cancelled; everything else refuses the repair instead.
	 */
	#networkQuiescent(): boolean {
		if (this.#host !== null || this.#listener.state === "listening" || this.#listener.state === "starting") return false;
		if (this.#listenerRetirements.size > 0 || this.#listenerRetirementUnconfirmed) return false;
		// A connection or inbound binding that is still closing owns state too.
		if (this.#pendingNetworkRetirements.size > 0) return false;
		if (this.#resourceCleanupFailed || this.#contentCleanupUnconfirmed) return false;
		if (this.#content.endpoint !== null || this.#content.retirement !== null || this.#contentAbort !== null) return false;
		for (const runtime of this.#runtime.values()) {
			if (runtime.abort !== null || runtime.client !== null || runtime.channel !== null || runtime.viewer !== null) {
				return false;
			}
			if (runtime.state === "connected" || runtime.state === "connecting" || runtime.state === "pairing") return false;
		}
		for (const bindings of this.#inboundBindings.values()) if (bindings.length > 0) return false;
		return true;
	}

	/**
	 * Cancel owned waits that hold no connection: automatic retry timers and any
	 * remaining consent handles. No suppression intent is written, no session is
	 * stopped, and saved preferences are untouched.
	 */
	#cancelOwnedNetworkWaits(): void {
		for (const entry of [...this.#consents.values()]) entry.release();
		this.#consents.clear();
		for (const runtime of this.#runtime.values()) {
			if (runtime.retryTimer !== null) {
				clearTimeout(runtime.retryTimer);
				runtime.retryTimer = null;
			}
			runtime.epoch += 1;
			runtime.mode = null;
			if (runtime.state === "retrying") {
				runtime.state = "disconnected";
				runtime.message = null;
			}
		}
	}

	#storageRepairState(): PeerUiStorageRepair {
		const restart = this.#storageRestart;
		if (restart !== null) {
			return Object.freeze({
				state: "restart-required",
				outcome: restart.outcome,
				priorExposurePossible: restart.priorExposurePossible,
			});
		}
		if (this.#storageAssessmentFailed) return Object.freeze({ state: "unchecked" });
		const assessment = this.#storageAssessment;
		if (assessment === null) return Object.freeze({ state: "none" });
		if (!assessment.supported) return Object.freeze({ state: "unsupported" });
		const blocked = assessment.blocked;
		if (blocked !== null) {
			return Object.freeze({ state: "blocked", target: blocked.target, reason: blocked.reason });
		}
		if (!assessment.repairable) return Object.freeze({ state: "nothing-to-repair" });
		if (!this.#networkQuiescent()) return Object.freeze({ state: "busy" });
		return Object.freeze({
			state: "offered",
			generation: this.#storageGeneration,
			targets: Object.freeze(assessment.targets.map((target) => Object.freeze({
				target: target.target,
				status: target.status,
				reason: target.reason,
			}))),
		});
	}

	#storageSnapshot(): PeerUiStorage | null {
		if (this.#storageProblems.length === 0 && this.#storageRestart === null) return null;
		return Object.freeze({
			platform: process.platform === "win32" ? "windows" : "posix",
			problems: Object.freeze([...this.#storageProblems]),
			repair: this.#storageRepairState(),
		});
	}

	/**
	 * The one explicit, human-confirmed permission repair (Refs #494). Main calls
	 * it only after proving its own written confirmation frame; this method still
	 * re-proves everything that frame could not: the frozen assessment
	 * generation, a fresh read-only eligibility assessment equal to the one shown,
	 * and an inactive Network that owns no listener, connection, or uncertain
	 * teardown. It never hosts, connects, creates keys, reopens stores, restores
	 * saved intent, or retries, and a changed or possibly changed result latches
	 * Network unavailable until a deliberate restart.
	 */
	repairStorageProtection(generation: number): Promise<PeerUiStorageRepairAdmission> {
		if (this.#closed) return Promise.resolve("not-run");
		return this.#track(this.#repairStorage(generation));
	}

	async #repairStorage(generation: number): Promise<PeerUiStorageRepairAdmission> {
		if (this.#closed || this.#tearingDown || !this.#startSettled || this.#storageRepairing
			|| this.#storageRestart !== null) {
			if (!this.#closed && !this.#tearingDown) {
				this.#transientNotice = this.#storageRestart !== null
					? NOTICE.storageRestartRequired
					: NOTICE.storageRepairUnavailable;
				this.#emit();
			}
			return "not-run";
		}
		const shown = this.#storageRepairState();
		if (!Number.isSafeInteger(generation) || shown.state !== "offered" || shown.generation !== generation) {
			this.#transientNotice = shown.state === "busy" ? NOTICE.storageRepairBusy : NOTICE.storageRepairStale;
			this.#emit();
			return shown.state === "busy" ? "busy" : "stale";
		}
		if (!this.#networkQuiescent()) {
			this.#transientNotice = NOTICE.storageRepairBusy;
			this.#emit();
			return "busy";
		}
		// Owned waits that hold no connection are settled first, without writing
		// any suppression intent or stopping a local or remote session.
		this.#cancelOwnedNetworkWaits();
		// Eligibility is re-proved at the actual mutation: a fresh read-only
		// assessment must still describe exactly the targets the operator saw.
		this.#assessStorage();
		const fresh = this.#storageRepairState();
		if (fresh.state !== "offered" || JSON.stringify(fresh.targets) !== JSON.stringify(shown.targets)) {
			this.#transientNotice = fresh.state === "busy" ? NOTICE.storageRepairBusy : NOTICE.storageRepairStale;
			this.#emit();
			return fresh.state === "busy" ? "busy" : "stale";
		}
		this.#storageRepairing = true;
		let report: PeerStorageRepairReport | null = null;
		try {
			report = this.#storageRepair({ agentDir: this.#options.agentDir });
		} catch {
			report = null;
		} finally {
			this.#storageRepairing = false;
		}
		if (report === null || report.changed || report.restartRequired) {
			// A thrown backend call cannot prove that nothing changed: fail closed.
			this.#storageRestart = Object.freeze({
				outcome: report !== null && report.outcome === "repaired" ? "repaired" : "partial",
				priorExposurePossible: report === null ? true : report.priorExposurePossible,
			});
			this.#storageAssessment = null;
			this.#storageAssessmentFailed = false;
			this.#transientNotice = null;
			// Network is unavailable from here on: both live policies fail closed.
			this.#noteViewerInputPolicy();
			this.#noteRemoteHistoryPolicy();
		} else {
			// Nothing was changed (refused or nothing to repair): show what is
			// true now, from one more read-only assessment.
			this.#assessStorage();
			this.#transientNotice = NOTICE.storageRepairUnchanged;
		}
		this.#emit();
		return "ran";
	}

	#status(): PeerUiSnapshot["status"] {
		if (!this.#started) return "loading";
		if (this.#storageRestart !== null) return "unavailable";
		if (!this.#preferencesLoaded || this.#preferencesStore === null) return "unavailable";
		const store = this.#trustStore;
		if (store === null) return "unavailable";
		try {
			store.identity;
		} catch {
			return "unavailable";
		}
		return "ready";
	}

	#persistentNotice(): string | null {
		// Before start the coordinator has not opened anything: it is loading, not
		// unavailable, so the inert constructor snapshot carries no error notice.
		if (!this.#started) return null;
		if (this.#storageRestart !== null) return NOTICE.storageRestartRequired;
		if (!this.#preferencesLoaded) return NOTICE.preferencesUnavailable;
		const store = this.#trustStore;
		if (store === null) return NOTICE.trustUnavailable;
		try {
			store.identity;
		} catch {
			return NOTICE.trustUnavailable;
		}
		return null;
	}

	#identityFingerprint(): string | null {
		const store = this.#trustStore;
		if (store === null) return null;
		try {
			return store.identity?.key.fingerprint ?? null;
		} catch {
			return null;
		}
	}

	#trustedPeers(): readonly PeerUiTrustedPeer[] | null {
		const store = this.#trustStore;
		if (store === null) return null;
		let trust: ReturnType<PeerStateStore["readTrustSnapshot"]>;
		try {
			trust = store.readTrustSnapshot();
		} catch {
			return null;
		}
		if (trust === null) return Object.freeze([]) as readonly PeerUiTrustedPeer[];
		const accepted = new Map(trust.acceptedPeers.map((record) => [record.key.keyId, record]));
		const granted = new Set(trust.grants.map((record) => record.peerKeyId));
		const ids = [...new Set([...accepted.keys(), ...granted])].sort();
		return Object.freeze(ids.map((keyId) => {
			const record = accepted.get(keyId);
			let fingerprint = record?.key.fingerprint ?? "";
			if (record === undefined) {
				try {
					// A grant without an accepted record is a valid partial fact; the
					// fingerprint is derived from the public key id for display only.
					fingerprint = peerKeyFromSpki(Buffer.from(keyId, "base64")).fingerprint;
				} catch {
					fingerprint = "";
				}
			}
			return Object.freeze({
				id: peerHandleFor(keyId),
				label: record?.label ?? UNKNOWN_PEER_LABEL,
				fingerprint,
				hasInboundGrant: granted.has(keyId),
			});
		}));
	}

	#hostSnapshot(destination: PeerDestination): PeerUiHost {
		const runtime = this.#runtime.get(destination.id);
		const pin = this.#readPin(destination.id);
		const suppressed = destination.reconnectSuppressed || this.#suppressionOverride.has(destination.id);
		let message = runtime?.message ?? null;
		if (message === null && destination.previouslyConnected && pin === null) {
			message = HOST_MESSAGE.savedKeyMissing;
		}
		const roster = runtime?.roster ?? { state: "never" as const, rows: null, hostRunId: null };
		return Object.freeze({
			id: destination.id,
			label: destination.label,
			host: destination.host,
			port: destination.port,
			state: runtime?.state ?? "disconnected",
			fingerprint: pin?.fingerprint ?? null,
			message,
			reconnectSuppressed: suppressed,
			previouslyConnected: destination.previouslyConnected,
			roster: Object.freeze({
				state: roster.state,
				rows: copyRoster(roster.rows),
				hostRunId: roster.hostRunId,
			}),
			// Only with the explicit requester opt-in; otherwise the DTO is exactly the
			// legacy one and the Saved picker never offers this destination.
			...(this.#savedViewer ? { saved: this.#savedHostFacts(runtime, pin) } : {}),
			// Read live from the ONE current metadata viewer: no stored mirror, cached
			// capability list, or per-destination rename state exists here.
			renameSupported: this.#renameHostSupport(runtime),
		});
	}

	/**
	 * Descriptive rename capability for one destination; never authority and never a
	 * name. True only while this destination is connected over a live metadata viewer
	 * whose owner acknowledged the optional rename capability, with a live channel and
	 * borrowed client. It deliberately does NOT require a current roster row or native
	 * tuple: capability description and per-request fencing are separate facts, and a
	 * destination that cannot currently be renamed is still honestly described.
	 */
	#renameHostSupport(runtime: DestinationRuntime | undefined): boolean {
		if (runtime === undefined || this.#closed || this.#tearingDown) return false;
		if (runtime.state !== "connected" || runtime.viewer === null || runtime.channel === null) return false;
		if (runtime.client === null) return false;
		try {
			return runtime.viewer.supportsRename === true;
		} catch {
			return false;
		}
	}

	/**
	 * Descriptive Saved facts for one destination; never authority. `supported`
	 * only while this destination is connected over a live viewer whose owner
	 * acknowledged Saved, with a CURRENT complete roster observation naming an owner
	 * run (an empty roster is fine) and a remembered pin equal to the key the live
	 * channel proved. `deleteExposed` is that OWNER's described live policy, and
	 * only when it names the run currently observed; anything else is `null`
	 * (unknown, so Delete stays hidden). This host's own viewer input/copy and
	 * owner-side history settings are never consulted.
	 */
	#savedHostFacts(runtime: DestinationRuntime | undefined, pin: PeerKey | null): PeerUiHost["saved"] {
		const unavailable = Object.freeze({ supported: false, deleteExposed: null });
		if (runtime === undefined || this.#closed || this.#tearingDown) return unavailable;
		const viewer = runtime.viewer;
		const channel = runtime.channel;
		if (runtime.state !== "connected" || viewer === null || channel === null || runtime.client === null) {
			return unavailable;
		}
		const roster = runtime.roster;
		const hostRunId = roster.hostRunId;
		if (roster.state !== "current" || roster.rows === null || hostRunId === null) return unavailable;
		if (pin === null || !peerKeysEqual(pin, channel.peerKey)) return unavailable;
		let saved: RosterBridgeSavedViewer | undefined;
		let supported = false;
		let policy: { readonly hostRunId: string; readonly deleteExposed: boolean } | undefined;
		try {
			saved = viewer.saved;
			supported = saved !== undefined && saved.supported === true;
			policy = supported && saved !== undefined ? saved.policy : undefined;
		} catch {
			return unavailable;
		}
		if (!supported) return unavailable;
		const deleteExposed = policy !== undefined
			&& policy.hostRunId === hostRunId
			&& typeof policy.deleteExposed === "boolean"
			? policy.deleteExposed
			: null;
		return Object.freeze({ supported: true, deleteExposed });
	}

	#consentSnapshot(entry: PendingConsent): PeerUiConsent {
		return Object.freeze({
			id: entry.id,
			kind: entry.kind,
			label: entry.label,
			fingerprint: entry.fingerprint,
			endpoint: entry.endpoint,
			requestedAt: entry.requestedAt,
			expiresAt: entry.expiresAt,
		});
	}

	#buildSnapshot(revision: number): PeerUiSnapshot {
		// After a repair changed (or may have changed) protection, the loaded
		// configuration is not authority until a restart: it is shown as unknown.
		const latched = this.#storageRestart !== null;
		const preferences = latched ? null : this.#preferences;
		const settings: PeerUiSettings | null = preferences === null ? null : Object.freeze({
			hostingEnabled: preferences.hosting.enabled,
			bindHost: preferences.hosting.bindHost ?? "",
			bindPort: preferences.hosting.bindPort,
			autoReconnect: preferences.autoReconnect,
			bellEnabled: preferences.bellEnabled,
			viewerNativeInputEnabled: preferences.viewerNativeInputEnabled,
			remoteHistoryDeleteEnabled: preferences.remoteHistoryDeleteEnabled,
		});
		const consents = [...this.#consents.values()].sort((left, right) => (
			left.requestedAt === right.requestedAt
				? left.id.localeCompare(right.id)
				: left.requestedAt - right.requestedAt
		));
		const storage = this.#storageSnapshot();
		return Object.freeze({
			revision,
			status: this.#status(),
			settings,
			identityFingerprint: latched ? null : this.#identityFingerprint(),
			listener: Object.freeze({ ...this.#listener }),
			hosts: preferences === null
				? null
				: Object.freeze(preferences.destinations.map((destination) => this.#hostSnapshot(destination))),
			trustedPeers: latched ? null : this.#trustedPeers(),
			consents: Object.freeze(consents.map((entry) => this.#consentSnapshot(entry))),
			notice: this.#transientNotice ?? this.#persistentNotice(),
			...(storage === null ? {} : { storage }),
		});
	}

	/** One final snapshot during shutdown; the only emit allowed while tearing down. */
	#emitFinal(): void {
		// A coordinator that never started has no configured role to report.
		if (!this.#started) return;
		const tearingDown = this.#tearingDown;
		this.#tearingDown = false;
		try {
			this.#emit();
		} finally {
			this.#tearingDown = tearingDown;
		}
	}

	#emit(): void {
		if (this.#tearingDown) return;
		if (this.#emitting) {
			this.#emitAgain = true;
			return;
		}
		this.#emitting = true;
		try {
			do {
				this.#emitAgain = false;
				this.#snapshot = this.#buildSnapshot(++this.#revision);
				try {
					this.#options.onChange(this.#snapshot);
				} catch {
					// The display callback is advisory; it never gates state.
				}
			} while (this.#emitAgain);
		} finally {
			this.#emitting = false;
		}
	}
}

function assertOptions(options: unknown): PeerCoordinatorOptions {
	if (!isRecord(options)) throw new TypeError("peer coordinator requires options");
	if (typeof options.agentDir !== "string" || options.agentDir === "") {
		throw new TypeError("peer coordinator requires an agent directory");
	}
	const inventory = options.inventory;
	if (!isRecord(inventory) || typeof inventory.watchInventory !== "function") {
		throw new TypeError("peer coordinator requires the owning-host inventory");
	}
	if (typeof options.onChange !== "function") {
		throw new TypeError("peer coordinator requires a snapshot callback");
	}
	if (typeof options.onIncomingConsentArrival !== "function") {
		throw new TypeError("peer coordinator requires an arrival callback");
	}
	const contentSource = options.contentSource;
	if (contentSource !== undefined) {
		// The content source is the caller's own owning-host service, narrowed. A
		// partial or cloned stand-in is refused rather than half-wired: without every
		// read-only capability the owner side cannot fence a request before a viewer
		// mutation, so the incoming content lane stays entirely unoffered instead.
		if (!isRecord(contentSource)) {
			throw new TypeError("peer coordinator requires the owning-host content source");
		}
		for (const method of [
			"watchSessionContent",
			"readInventorySnapshot",
			"openViewer",
			"readViewer",
			"updateViewer",
			"closeViewer",
		] as const) {
			if (typeof contentSource[method] !== "function") {
				throw new TypeError("peer coordinator requires the owning-host content source");
			}
		}
	}
	if (options.onContentChange !== undefined && typeof options.onContentChange !== "function") {
		throw new TypeError("peer coordinator content callback is invalid");
	}
	if (options.nativeIo !== undefined) {
		// Both callbacks or nothing: a partially shaped option must never look like
		// native IO support this coordinator cannot honour. Validation is pure — no
		// listener, channel, identity, file, or callback is created here.
		const nativeIo = options.nativeIo;
		if (!isRecord(nativeIo)
			|| typeof nativeIo.authorizeInput !== "function"
			|| typeof nativeIo.onCopy !== "function") {
			throw new TypeError("peer coordinator native IO callbacks are invalid");
		}
	}
	if (options.closeOwnedSession !== undefined && typeof options.closeOwnedSession !== "function") {
		// No implicit close provider: a non-callable value would otherwise look like
		// support this host cannot honour.
		throw new TypeError("peer coordinator close provider is invalid");
	}
	if (options.createOwnedSession !== undefined && typeof options.createOwnedSession !== "function") {
		// The same rule for the rowless create provider: no implicit support this host
		// cannot honour.
		throw new TypeError("peer coordinator create provider is invalid");
	}
	if (options.renameOwnedSession !== undefined && typeof options.renameOwnedSession !== "function") {
		// No implicit rename provider: a non-callable value would otherwise look like
		// owner rename support this host cannot honour. It is never called here.
		throw new TypeError("peer coordinator rename provider is invalid");
	}
	if (options.savedCatalogViewFactory !== undefined && typeof options.savedCatalogViewFactory !== "function") {
		// No implicit Saved provider: a non-callable value would otherwise look like
		// owner Saved support this host cannot honour. It is never called here.
		throw new TypeError("peer coordinator Saved catalog view factory is invalid");
	}
	if (options.savedViewer !== undefined && typeof options.savedViewer !== "boolean") {
		// The requester opt-in is a real boolean or absent; nothing else enables it.
		throw new TypeError("peer coordinator Saved viewer option is invalid");
	}
	if (options.testHooks !== undefined) {
		const hooks = options.testHooks;
		if (!isRecord(hooks)) throw new TypeError("peer coordinator test hooks are invalid");
		if (hooks.autoReconnectDelaysMs !== undefined) {
			const delays = hooks.autoReconnectDelaysMs;
			if (
				!Array.isArray(delays)
				|| delays.length === 0
				|| delays.some((value) => !Number.isSafeInteger(value) || value <= 0)
			) {
				throw new TypeError("peer coordinator test delays are invalid");
			}
		}
		if (hooks.wrapClientChannel !== undefined && typeof hooks.wrapClientChannel !== "function") {
			throw new TypeError("peer coordinator channel fixture seam is invalid");
		}
		if (hooks.consentWindowMs !== undefined) {
			const window = hooks.consentWindowMs;
			if (typeof window !== "number" || !Number.isSafeInteger(window) || window <= 0) {
				throw new TypeError("peer coordinator test consent window is invalid");
			}
		}
		if (hooks.storageRemediation !== undefined) {
			const remediation = hooks.storageRemediation;
			if (!isRecord(remediation)
				|| (remediation.assess !== undefined && typeof remediation.assess !== "function")
				|| (remediation.repair !== undefined && typeof remediation.repair !== "function")) {
				throw new TypeError("peer coordinator storage remediation fixture seam is invalid");
			}
		}
	}
	return options as unknown as PeerCoordinatorOptions;
}

/**
 * Create the one host-owned peer coordinator behind the network sidebar.
 *
 * Constructing it is inert. `start()` restores the roles the operator saved
 * before: saved hosting intent may bind the saved listener, and eligible saved
 * Auto reconnect attempts may connect. Startup never generates an identity,
 * pairs, prompts for an unknown key, or replaces a changed pin; a fresh,
 * default-disabled start only reads protected state. Only explicit commands
 * initialize an identity, pair a new key, or change saved intent/trust.
 *
 * The returned coordinator also owns the single selected native viewport content
 * stream: the same optional listener and the same directional authority carry an
 * incoming content lane when the caller supplied its own owning-host service as
 * the content source, and at most one destination/run/row is selected outgoing at
 * a time. A metadata-only caller passes neither and observes exactly the previous
 * behavior.
 *
 * It additionally exposes the one Close controller. Supplying an owner close
 * provider makes the owner side of the existing metadata lane acknowledge the
 * optional Close capability; supplying none changes nothing at all, and the
 * requester side still refuses with `not-sent` for an owner that never
 * acknowledged it.
 *
 * Optional `nativeIo` callbacks add the native input/copy seam for the selected
 * stream and nothing else: they are refused unless both are functions, they never
 * enable anything by themselves, and omitting them keeps every byte and every
 * behavior of the display-only coordinator. With them, this viewer's saved remote
 * input/copy preference (default on) is re-proved for every protected write and
 * completed copy.
 *
 * The owner-side remote history deletion policy is readable live through
 * {@link PeerCoordinatorWithHistoryPolicy.readRemoteHistoryDeleteEnabled}.
 *
 * An optional `savedCatalogViewFactory` makes this host SERVE the Saved catalog
 * exchange (paired with that live policy, every actual change of which is pushed
 * to the existing bindings as a description), and the independent `savedViewer`
 * opt-in makes it REQUEST it through {@link PeerCoordinatorWithSaved.ownerSaved}
 * and describe it in each destination DTO. Omitting both keeps every byte and
 * behavior of the previous coordinator.
 *
 * An optional `renameOwnedSession` makes this host ANSWER the optional owner rename
 * exchange on the existing metadata lane: the capability is acknowledged only for a
 * peer that offered it AND only while this host really holds that provider, and the
 * provider is handed to the bridge unwrapped and is never called here. The one
 * {@link PeerCoordinatorWithRename.ownerRename} controller routes a request naming
 * one exact observed native conversation tuple over the destination's existing
 * connected viewer, and each destination DTO describes the live negotiated support.
 * Omitting the option leaves owner-side rename unsupported; requester negotiation
 * remains independent and still requires the remote owner's acknowledged support.
 */
export function createPeerCoordinator(
	options: PeerCoordinatorOptions,
): PeerCoordinatorWithContent
	& PeerCoordinatorWithClose
	& PeerCoordinatorWithCreate
	& PeerCoordinatorWithRename
	& PeerCoordinatorWithSaved
	& PeerCoordinatorWithHistoryPolicy
	& PeerCoordinatorWithStorageRepair {
	return new OwnedPeerCoordinator(assertOptions(options));
}
