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
 */

import { createHash, randomUUID } from "node:crypto";

import type { OwningHostService } from "../owning-host-service";
import type {
	PeerCoordinator,
	PeerUiCommand,
	PeerUiConsent,
	PeerUiHost,
	PeerUiSettings,
	PeerUiSnapshot,
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
import {
	isPeerTransportError,
	isValidPeerLabel,
	peerError,
	type PeerTransportBounds,
	type PeerTransportErrorCode,
} from "./protocol";
import { attachRosterBridgeViewer, type RosterBridgeProjection, type RosterBridgeViewer } from "./roster-bridge-client";
import {
	createRosterBridgeHost,
	type RosterBridgeChannelBinding,
	type RosterBridgeHost,
} from "./roster-bridge-host";
import type { RemoteSessionMetadata } from "./roster-metadata";

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
	 * control or fail its LOCAL closure. Production callers never pass it.
	 */
	readonly wrapClientChannel?: (channel: PeerByteChannel) => PeerByteChannel;
}

export interface PeerCoordinatorOptions {
	/** Canonical Pi agent directory owned by the caller's host lifecycle. */
	readonly agentDir: string;
	/** The host's one authoritative inventory source (never a proxy roster). */
	readonly inventory: Pick<OwningHostService, "watchInventory">;
	readonly onChange: (snapshot: PeerUiSnapshot) => void;
	/** Advisory, exactly-once-per-new-incoming-handle arrival signal. */
	readonly onIncomingConsentArrival: (consentId: string) => void;
	/** Test-only seams; there is no insecure production fallback for them. */
	readonly testHooks?: PeerCoordinatorTestHooks;
}

type DestinationState = PeerUiHost["state"];

interface RosterObservation {
	readonly state: "never" | "current" | "stale";
	readonly rows: readonly RemoteSessionMetadata[] | null;
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

class OwnedPeerCoordinator implements PeerCoordinator {
	readonly #options: PeerCoordinatorOptions;
	readonly #consentWindowMs: number;
	readonly #autoReconnectDelaysMs: readonly number[];
	readonly #preferencesPermissions: PeerStatePermissionPolicy;
	readonly #peerStatePermissions: PeerStatePermissionPolicy | undefined;
	readonly #hostBounds: Partial<PeerTransportBounds>;
	readonly #clientBounds: Partial<PeerTransportBounds>;

	readonly #runtime = new Map<string, DestinationRuntime>();
	readonly #consents = new Map<string, PendingConsent>();
	readonly #inboundBindings = new Map<string, RosterBridgeChannelBinding[]>();
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

	read(): PeerUiSnapshot {
		return this.#snapshot;
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
			this.#preferences = store.read() ?? DEFAULT_PEER_PREFERENCES;
			this.#preferencesLoaded = true;
		} catch {
			this.#preferencesStore = null;
			this.#preferences = null;
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
		} catch {
			this.#trustStore = null;
		}

		try {
			this.#bridge = createRosterBridgeHost({
				inventory: this.#options.inventory,
				authorizePeer: (peerKey) => this.#authorizePeer(peerKey),
			});
		} catch {
			this.#bridge = null;
		}

		this.#started = true;
		this.#emit();

		const preferences = this.#preferences;
		if (preferences !== null && preferences.hosting.enabled) await this.#restoreListener();
		// Close may have latched while starting; owned roles are never applied then.
		if (this.#closed) return;
		if (preferences !== null && preferences.autoReconnect) this.#scheduleEligibleAutoAttempts();
		this.#emit();
	}

	async #teardown(): Promise<void> {
		// `close()` already latched `#closed` synchronously before calling this.
		this.#tearingDown = true;
		let confirmed = true;

		// 1. Cancel owned human decisions (key approvals and pending incoming
		//    handles) and every automatic attempt/timer before any await.
		for (const entry of [...this.#consents.values()]) entry.release();
		this.#consents.clear();
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
			runtime.roster = runtime.roster.rows === null
				? { state: "never", rows: null }
				: { state: "stale", rows: runtime.roster.rows };
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
			&& resourcesSettled
			&& this.#host === null
			&& this.#bridge === null
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
		try {
			hostInstance = createPeerHost({
				identity,
				acceptedPeers: store.acceptedPeers,
				grants: store.grants,
				onPairingRequest: (request) => this.#onPairingRequest(request),
				onAppChannel: (channel) => this.#onAppChannel(channel),
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
	 * Take every inbound binding currently owned by the listener transport. The
	 * caller retires them as part of the same owned, settled teardown.
	 */
	#takeInboundBindings(): RosterBridgeChannelBinding[] {
		const bindings: RosterBridgeChannelBinding[] = [];
		for (const list of this.#inboundBindings.values()) bindings.push(...list);
		this.#inboundBindings.clear();
		return bindings;
	}

	/**
	 * Start one listener retirement synchronously, so the pending state is visible
	 * to every barrier before any caller awaits it, and return whether it was
	 * positively confirmed.
	 */
	#startListenerRetirement(
		hostInstance: PeerHost | null,
		bindings: readonly RosterBridgeChannelBinding[],
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
		bindings: readonly RosterBridgeChannelBinding[],
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
			const keyId = channel.peerKey.keyId;
			const list = this.#inboundBindings.get(keyId) ?? [];
			list.push(binding);
			this.#inboundBindings.set(keyId, list);
			void binding.closed.then(() => {
				const current = this.#inboundBindings.get(keyId);
				if (current === undefined) return;
				const index = current.indexOf(binding);
				if (index >= 0) current.splice(index, 1);
				if (current.length === 0) this.#inboundBindings.delete(keyId);
			}, () => undefined);
		} catch {
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
			roster: { state: "never", rows: null },
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
		} catch {
			this.#transientNotice = NOTICE.identityUnavailable;
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
		if (this.#closed) return false;
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
		runtime.roster = runtime.roster.rows === null
			? { state: "never", rows: null }
			: { state: "stale", rows: runtime.roster.rows };
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
		void this.#track(cleanup);
	}

	#retireAllDestinations(): void {
		for (const runtime of this.#runtime.values()) this.#retireDestinationResources(runtime);
	}

	async #connectDestination(id: string, mode: "explicit" | "auto"): Promise<void> {
		if (this.#closed) return;
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
			client = createPeerClient({
				identity,
				remembered: trustStore.rememberedFor(id),
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
			runtime.roster = { state: "never", rows: null };
			this.#markPreviouslyConnected(id);
			this.#emit();
			this.#watchChannel(runtime, epoch, channel);
			await this.#startViewer(runtime, epoch, channel);
		} catch (error) {
			if (runtime.epoch !== epoch || this.#closed) return;
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
		runtime.roster = runtime.roster.rows === null
			? { state: "never", rows: null }
			: { state: "stale", rows: runtime.roster.rows };
		this.#retireDestinationResources(runtime);
		this.#emit();
		this.#scheduleRetry(runtime.id);
	}

	async #startViewer(runtime: DestinationRuntime, epoch: number, channel: PeerByteChannel): Promise<void> {
		let viewer: RosterBridgeViewer;
		try {
			viewer = attachRosterBridgeViewer({
				channel,
				onProjection: (projection) => this.#onProjection(runtime, epoch, projection),
			});
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
			runtime.roster = { state: "never", rows: null };
		} else {
			runtime.roster = {
				state: projection.state === "current" ? "current" : "stale",
				rows: copyRoster(projection.rows),
			};
		}
		this.#emit();
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
		// Forgetting this side's remembered server key is local only. It never
		// revokes the other host's receiving grant and never stops its sessions.
		const store = this.#trustStore;
		if (store !== null) {
			try {
				store.rememberedFor(hostId).clear();
			} catch {
				this.#transientNotice = NOTICE.pinNotCleared;
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
		} catch {
			failed = true;
		}
		if (!failed) {
			try {
				store.acceptedPeers.delete(target);
			} catch {
				failed = true;
			}
		}
		if (failed) this.#transientNotice = NOTICE.revokeFailed;
		this.#stopInboundBindings(target);
		this.#emit();
	}

	#stopInboundBindings(keyId: string): void {
		const bindings = this.#inboundBindings.get(keyId);
		if (bindings === undefined) return;
		this.#inboundBindings.delete(keyId);
		for (const binding of bindings) {
			void binding.stop().catch(() => undefined);
		}
	}

	// --------------------------------------------------------------- snapshots

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
			this.#preferences = value;
			return true;
		} catch {
			if (options.applyOnFailure === true) {
				// A restrictive or history change takes effect for this session even
				// when it could not be saved; the notice keeps that unsaved.
				this.#preferences = value;
			}
			this.#transientNotice = NOTICE.preferencesUnsaved;
			this.#emit();
			return false;
		}
	}

	#status(): PeerUiSnapshot["status"] {
		if (!this.#started) return "loading";
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
		const roster = runtime?.roster ?? { state: "never" as const, rows: null };
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
			}),
		});
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
		const preferences = this.#preferences;
		const settings: PeerUiSettings | null = preferences === null ? null : Object.freeze({
			hostingEnabled: preferences.hosting.enabled,
			bindHost: preferences.hosting.bindHost ?? "",
			bindPort: preferences.hosting.bindPort,
			autoReconnect: preferences.autoReconnect,
			bellEnabled: preferences.bellEnabled,
		});
		const consents = [...this.#consents.values()].sort((left, right) => (
			left.requestedAt === right.requestedAt
				? left.id.localeCompare(right.id)
				: left.requestedAt - right.requestedAt
		));
		return Object.freeze({
			revision,
			status: this.#status(),
			settings,
			identityFingerprint: this.#identityFingerprint(),
			listener: Object.freeze({ ...this.#listener }),
			hosts: preferences === null
				? null
				: Object.freeze(preferences.destinations.map((destination) => this.#hostSnapshot(destination))),
			trustedPeers: this.#trustedPeers(),
			consents: Object.freeze(consents.map((entry) => this.#consentSnapshot(entry))),
			notice: this.#transientNotice ?? this.#persistentNotice(),
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
 */
export function createPeerCoordinator(options: PeerCoordinatorOptions): PeerCoordinator {
	return new OwnedPeerCoordinator(assertOptions(options));
}
